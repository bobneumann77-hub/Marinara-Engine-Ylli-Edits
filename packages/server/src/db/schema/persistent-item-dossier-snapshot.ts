// ──────────────────────────────────────────────
// Schema: Persistent Item Dossier Snapshots
// ──────────────────────────────────────────────
// Per-message snapshots of the persistent item dossier, keyed like
// `game_state_snapshots`: (chatId, messageId, swipeIndex), written only on turns
// that changed it.
//
// Snapshots carry definitions alongside stacks on purpose, so a stack whose
// definition the live dossier has since dropped still renders after a rewind.
import { fileTable, text, integer } from "../file-schema.js";

export const itemDossierSnapshots = fileTable("persistent_item_dossier_snapshots", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  /** FK to messages.id — cascade handled at application level. */
  messageId: text("message_id").notNull(),
  swipeIndex: integer("swipe_index").notNull().default(0),
  /** Full `PersistentItemDossier` (definitions + stacks) as JSON. */
  data: text("data").notNull(),
  createdAt: text("created_at").notNull(),
});
