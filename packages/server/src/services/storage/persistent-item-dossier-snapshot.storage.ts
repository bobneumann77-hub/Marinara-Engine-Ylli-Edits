// ──────────────────────────────────────────────
// Storage: Item Dossier Snapshots
// ──────────────────────────────────────────────
// Per-message history of the persistent item dossier. Mirrors
// `game-state.storage.ts` so rewind, swipe, and regeneration reuse the same
// anchor walk: the snapshot of the nearest ancestor message, read at that
// message's own active swipe.
//
// Design notes:
// - Written only on turns where the reconciler reports a change, so chats that
//   never touch items cost nothing.
// - Definitions ride along with the stacks, so a rewound stack whose definition
//   the live dossier has since dropped still renders correctly.
// - Destroyed commodities are physically removed from the live dossier; only
//   destroyed uniques are kept (at `qty: 0`), matching the reconciler's cleanup
//   tail. Rewind restores either kind because every snapshot is a full copy of
//   the dossier at that turn, not a delta.
import { and, desc, eq, inArray } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { itemDossierSnapshots } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import type { PersistentItemDossier } from "./persistent-item-dossier.storage.js";

export interface ItemDossierSnapshotRow {
  id: string;
  chatId: string;
  messageId: string;
  swipeIndex: number;
  dossier: PersistentItemDossier;
  createdAt: string;
}

export interface ItemDossierSnapshotStorage {
  /** Most recent snapshot for a chat, in any branch. Panel / UI reads. */
  getLatest(chatId: string): Promise<ItemDossierSnapshotRow | null>;
  /** Snapshot stored for this exact message + swipe, if any. */
  getExact(chatId: string, messageId: string, swipeIndex: number): Promise<ItemDossierSnapshotRow | null>;
  /**
   * The merge base for a turn: the snapshot of the NEAREST ancestor message, at
   * that message's own active swipe.
   *
   * `anchors` is the chat's message array up to the turn being generated, in
   * chat order with the newest last. Message ORDER decides, not `createdAt`: a
   * snapshot's clock is when the AGENT wrote it, so it can be weeks after the
   * message it belongs to. Inactive swipes are skipped -- every swipe of one
   * message shares a `messageId`, so without that filter the newest-written
   * swipe would win even after the user swiped away from it, and the branch
   * would merge onto a state it never had.
   *
   * Returns `null` when no ancestor has a snapshot. Callers treat that as an
   * empty branch rather than falling back to the live dossier: the live row
   * belongs to whichever branch ran last, so merging it in would leak items
   * into a branch that never had them.
   */
  getLatestForAnchors(
    chatId: string,
    anchors: Array<{ messageId: string; swipeIndex: number }>,
  ): Promise<ItemDossierSnapshotRow | null>;
  /** Upsert the snapshot for one message + swipe. */
  saveSnapshot(chatId: string, messageId: string, swipeIndex: number, dossier: PersistentItemDossier): Promise<void>;
  /** Cascade hook: drop every snapshot attached to the given messages. */
  deleteByMessageIds(chatId: string, messageIds: string[]): Promise<void>;
  /** Cascade hook: drop every snapshot for a chat. */
  deleteByChatId(chatId: string): Promise<void>;
}

function parseRow(row: {
  id: string;
  chatId: string;
  messageId: string;
  swipeIndex: number;
  data: string;
  createdAt: string;
}): ItemDossierSnapshotRow {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    swipeIndex: row.swipeIndex,
    dossier: JSON.parse(row.data) as PersistentItemDossier,
    createdAt: row.createdAt,
  };
}

export function createItemDossierSnapshotStorage(db: DB): ItemDossierSnapshotStorage {
  return {
    async getLatest(chatId) {
      const rows = await db
        .select()
        .from(itemDossierSnapshots)
        .where(eq(itemDossierSnapshots.chatId, chatId))
        .orderBy(desc(itemDossierSnapshots.createdAt))
        .limit(1);
      return rows[0] ? parseRow(rows[0]) : null;
    },

    async getExact(chatId, messageId, swipeIndex) {
      const rows = await db
        .select()
        .from(itemDossierSnapshots)
        .where(
          and(
            eq(itemDossierSnapshots.chatId, chatId),
            eq(itemDossierSnapshots.messageId, messageId),
            eq(itemDossierSnapshots.swipeIndex, swipeIndex),
          ),
        )
        .limit(1);
      return rows[0] ? parseRow(rows[0]) : null;
    },

    async getLatestForAnchors(chatId, anchors) {
      if (anchors.length === 0) return null;
      const activeSwipeByMessage = new Map(anchors.map((anchor) => [anchor.messageId, anchor.swipeIndex]));
      const rows = await db
        .select()
        .from(itemDossierSnapshots)
        .where(
          and(
            eq(itemDossierSnapshots.chatId, chatId),
            inArray(
              itemDossierSnapshots.messageId,
              anchors.map((anchor) => anchor.messageId),
            ),
          ),
        );
      // Keep only the ACTIVE swipe of each ancestor. `saveSnapshot` upserts on
      // (messageId, swipeIndex), so at most one row survives per message.
      const byMessage = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (activeSwipeByMessage.get(row.messageId) !== row.swipeIndex) continue;
        const current = byMessage.get(row.messageId);
        if (!current || row.createdAt > current.createdAt) byMessage.set(row.messageId, row);
      }
      // Nearest ancestor wins: walk the caller's own message order backwards.
      for (let index = anchors.length - 1; index >= 0; index -= 1) {
        // `anchors[index]` reads as possibly-undefined under
        // noUncheckedIndexedAccess because the index is a variable; the loop
        // bound already keeps it in range, so the guard is only for the type.
        const anchor = anchors[index];
        if (!anchor) continue;
        const row = byMessage.get(anchor.messageId);
        if (row) return parseRow(row);
      }
      return null;
    },

    async saveSnapshot(chatId, messageId, swipeIndex, dossier) {
      const existing = await db
        .select({ id: itemDossierSnapshots.id })
        .from(itemDossierSnapshots)
        .where(
          and(
            eq(itemDossierSnapshots.chatId, chatId),
            eq(itemDossierSnapshots.messageId, messageId),
            eq(itemDossierSnapshots.swipeIndex, swipeIndex),
          ),
        );
      const data = JSON.stringify(dossier);
      if (existing[0]) {
        await db.update(itemDossierSnapshots).set({ data }).where(eq(itemDossierSnapshots.id, existing[0].id));
        return;
      }
      await db.insert(itemDossierSnapshots).values({
        id: newId(),
        chatId,
        messageId,
        swipeIndex,
        data,
        createdAt: now(),
      });
    },

    async deleteByMessageIds(chatId, messageIds) {
      if (messageIds.length === 0) return;
      await db
        .delete(itemDossierSnapshots)
        .where(and(eq(itemDossierSnapshots.chatId, chatId), inArray(itemDossierSnapshots.messageId, messageIds)));
    },

    async deleteByChatId(chatId) {
      await db.delete(itemDossierSnapshots).where(eq(itemDossierSnapshots.chatId, chatId));
    },
  };
}
