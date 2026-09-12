// ──────────────────────────────────────────────
// Schema: Item Dossier Snapshots
// ──────────────────────────────────────────────
// Per-message snapshots of the persistent item dossier, mirroring
// `game_state_snapshots` keying: (chatId, messageId, swipeIndex). A row is
// written only on turns where the reconciler reports a change, so a chat
// that never touches items costs nothing.
//
// Rewind and swipe resolve an anchor with the same helpers game state already
// uses (`resolveVisibleGameStateAnchor` / `resolveRegenerationGameStateAnchor`),
// then read the nearest snapshot at or before it — no separate rewind model.
//
// The snapshot carries definitions alongside stacks on purpose: a stack that
// references a definition the live dossier no longer holds still renders
// correctly after a rewind, so definitions never dangle.
import { fileTable, text, integer } from "../file-schema.js";

export const itemDossierSnapshots = fileTable("item_dossier_snapshots", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  /** FK to messages.id — cascade handled at application level. */
  messageId: text("message_id").notNull(),
  swipeIndex: integer("swipe_index").notNull().default(0),
  /** Full `PersistentItemDossier` (definitions + stacks) as JSON. */
  data: text("data").notNull(),
  createdAt: text("created_at").notNull(),
});
