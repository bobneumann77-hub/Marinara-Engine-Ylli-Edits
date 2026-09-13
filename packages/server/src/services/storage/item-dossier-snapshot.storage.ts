// ──────────────────────────────────────────────
// Storage: Item Dossier Snapshots
// ──────────────────────────────────────────────
// Per-message history of the persistent item dossier. Mirrors
// `game-state.storage.ts` so rewind, swipe, and regeneration reuse the same
// messageId-anchored read: the newest snapshot among the messages that come
// before the anchor.
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
   * Newest snapshot among the given message ids — the messageId-anchored walk.
   *
   * Mirrors `game-state.storage.ts#getLatestForMessages`. The chat's message
   * array already carries order, so the caller walks it backwards from the
   * anchor and hands the candidate ids here; the table only has to pick the
   * newest row among them. A timestamp comparison cannot do this job, because
   * a snapshot's `createdAt` is when the AGENT wrote it, which can be weeks
   * after the message it belongs to.
   *
   * Returns `null` when none of the candidates has a snapshot, so the caller
   * can fall back to the live dossier.
   */
  getLatestForMessages(chatId: string, messageIds: string[]): Promise<ItemDossierSnapshotRow | null>;
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

    async getLatestForMessages(chatId, messageIds) {
      if (messageIds.length === 0) return null;
      const rows = await db
        .select()
        .from(itemDossierSnapshots)
        .where(and(eq(itemDossierSnapshots.chatId, chatId), inArray(itemDossierSnapshots.messageId, messageIds)))
        .orderBy(desc(itemDossierSnapshots.createdAt))
        .limit(1);
      return rows[0] ? parseRow(rows[0]) : null;
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
