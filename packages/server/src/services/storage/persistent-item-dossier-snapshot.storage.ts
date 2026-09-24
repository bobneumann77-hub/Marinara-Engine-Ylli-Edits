// ──────────────────────────────────────────────
// Storage: Item Dossier Snapshots
// ──────────────────────────────────────────────
// Per-message history of the persistent item dossier, keyed like
// `game_state_snapshots`: (chatId, messageId, swipeIndex), written only on turns
// that changed it. Each row is a FULL dossier rather than a delta, so a rewind
// restores destroyed items and keeps definitions the live dossier has dropped.
//
// The `data` payload is gzipped behind a marker (see encodeDossier); rows written
// before that change hold plain JSON and still parse.
import { gunzipSync, gzipSync } from "node:zlib";
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
   * The merge base for a turn: the NEAREST ancestor message that has a snapshot,
   * at that message's own ACTIVE swipe.
   *
   * `anchors` is the chat's message array up to the turn, newest last. Message
   * ORDER decides -- a snapshot's `createdAt` is when the AGENT wrote it, and all
   * swipes of one message share an id, so the newest-written swipe would
   * otherwise win after the user swiped away from it.
   *
   * `null` means no ancestor has one: an empty branch, never a fallback to the
   * live row, which belongs to whichever branch ran last.
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

/** Marks a gzip+base64 snapshot payload. Anything without this prefix is plain JSON. */
const COMPRESSED_SNAPSHOT_PREFIX = "gzip:";

/**
 * Snapshots scale with the dossier -- five writes a turn on a swipe-heavy chat --
 * so the payload is gzipped. The marker keeps rows written before this change
 * readable, and a payload that does not actually shrink stays plain, because
 * base64 costs a third again and can outweigh gzip on a small dossier.
 *
 * Only snapshots are compressed: the live dossier is a single row and is worth
 * keeping readable in dumps.
 */
function encodeDossier(dossier: PersistentItemDossier): string {
  const plain = JSON.stringify(dossier);
  const compressed = `${COMPRESSED_SNAPSHOT_PREFIX}${gzipSync(plain).toString("base64")}`;
  return compressed.length < plain.length ? compressed : plain;
}

function decodeDossier(data: string): PersistentItemDossier {
  if (!data.startsWith(COMPRESSED_SNAPSHOT_PREFIX)) return JSON.parse(data) as PersistentItemDossier;
  const body = Buffer.from(data.slice(COMPRESSED_SNAPSHOT_PREFIX.length), "base64");
  return JSON.parse(gunzipSync(body).toString("utf8")) as PersistentItemDossier;
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
    dossier: decodeDossier(row.data),
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
      // Keep only each ancestor's ACTIVE swipe (saveSnapshot upserts per message+swipe).
      const byMessage = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (activeSwipeByMessage.get(row.messageId) !== row.swipeIndex) continue;
        const current = byMessage.get(row.messageId);
        if (!current || row.createdAt > current.createdAt) byMessage.set(row.messageId, row);
      }
      // Nearest ancestor wins: walk the caller's own message order backwards.
      for (let index = anchors.length - 1; index >= 0; index -= 1) {
        // Guard is for noUncheckedIndexedAccess; the loop bound keeps it in range.
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
      const data = encodeDossier(dossier);
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
