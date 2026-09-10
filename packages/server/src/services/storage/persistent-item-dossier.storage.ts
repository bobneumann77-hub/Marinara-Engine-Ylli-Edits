// packages/server/src/services/storage/persistent-item-dossier.storage.ts
// Engine-owned per-chat persistent item dossier. No package dependency.
// Future agents (shop, relationship, equipment) read/write this by key.
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { persistentItemDossier } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

export interface DossierOwnerEvent {
  owner: string;
  at: string;
  reason: "created" | "changed" | "stolen" | "gifted";
}

export interface DossierLocation {
  mapLocationId?: string | null;
  locationName?: string | null;
  source?: "spatial-context" | "world-state" | "none";
  lastSeenAt?: string | null;
}

export interface DossierEntry {
  uuid: string;
  name: string;
  displayName: string;
  type: "currency" | "equipped" | "inventory" | "none";
  qty: number;
  status?: "active" | "destroyed";
  isUnique?: boolean | null;
  isDestroyed?: boolean | null;
  isStackable?: boolean;
  description?: string | null;
  class?: string | null;
  rarity?: string | null;
  owner?: string | null;
  isStolen?: boolean | null;
  isGifted?: boolean | null;
  equipmentSlot?: string | null;
  customFields?: Record<string, unknown>;
  lastOwners?: DossierOwnerEvent[];
  location?: DossierLocation | null;
  createdAt?: string;
  updatedAt?: string;
  // Escape hatch: future agents may attach extra fields without a schema bump.
  [key: string]: unknown;
}

export interface PersistentItemDossier {
  schemaVersion: 1;
  entries: DossierEntry[];
}

export interface PersistentItemDossierStorage {
  getForChat(chatId: string): Promise<PersistentItemDossier | null>;
  saveForChat(chatId: string, dossier: PersistentItemDossier): Promise<void>;
}

export function createPersistentItemDossierStorage(db: DB): PersistentItemDossierStorage {
  return {
    async getForChat(chatId: string) {
      const rows = await db.select().from(persistentItemDossier).where(eq(persistentItemDossier.chatId, chatId));
      return rows[0] ? (JSON.parse(rows[0].data) as PersistentItemDossier) : null;
    },

    async saveForChat(chatId: string, dossier: PersistentItemDossier): Promise<void> {
      const existing = await db.select().from(persistentItemDossier).where(eq(persistentItemDossier.chatId, chatId));
      const id = existing[0]?.id ?? newId();
      const ts = now();
      if (existing[0]) {
        await db
          .update(persistentItemDossier)
          .set({ data: JSON.stringify(dossier), updatedAt: ts })
          .where(eq(persistentItemDossier.id, id));
      } else {
        await db.insert(persistentItemDossier).values({
          id,
          chatId,
          data: JSON.stringify(dossier),
          createdAt: ts,
          updatedAt: ts,
        });
      }
    },
  };
}
