// Schema: Engine-owned per-chat persistent item dossier
import { fileTable, text } from "../file-schema.js";

export const persistentItemDossier = fileTable("persistent_item_dossier", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  data: text("data").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
