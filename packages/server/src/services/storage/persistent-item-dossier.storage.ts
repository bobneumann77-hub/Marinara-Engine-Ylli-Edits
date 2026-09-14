// packages/server/src/services/storage/persistent-item-dossier.storage.ts
// Engine-owned per-chat persistent item dossier. No package dependency.
// Future agents (shop, relationship, equipment) read/write this by key.
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { persistentItemDossier } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

export interface DossierOwnerEvent {
  owner: string; // "player", a presentCharacters id, a name, or "world"
  at: number; // turn number the transfer happened on
  reason: "created" | "acquired" | "transferred" | "stolen" | "gifted" | "dropped";
}

/** A single location observation, stamped with the turn it was taken. */
export interface DossierLocationObservation {
  name: string;
  /** Turn number the observation was taken on; drives recency priority. */
  at: number;
}

/** World Maps observation: the hard pointer id plus the name it resolved to. */
export interface DossierMapObservation extends DossierLocationObservation {
  id: string;
}

/**
 * Where a stack physically is. Each source refreshes only its own field and
 * recency (`at`) decides at read time, so a World Maps pointer survives World
 * State renames while a newer sighting can supersede a stale map id.
 */
export interface DossierLocationRef {
  /** Carried or worn by `DossierStack.owner`. */
  on_person?: boolean;
  /** Strongest source: World Maps pointer when that agent is active. */
  map?: DossierMapObservation | null;
  /** Fallback source: narrative location name from World State. */
  world?: DossierLocationObservation | null;
}

/**
 * The item TEMPLATE: no quantity, owner, or location. `isNamedArtifact` marks
 * canonical one-of-a-kind items (Frostmourne), which can never mint a second
 * stack; ordinary story upgrades set `isUnique` on the STACK instead.
 */
export interface DossierDefinition {
  id: string;
  name: string; // canonical, normalized
  displayName: string;
  class?: string | null;
  rarity?: string | null;
  description?: string | null;
  isNamedArtifact: boolean;
  aliases?: string[]; // stubbed for future flair-name mapping; do not use yet
  createdAt: string;
  updatedAt: string;
  // Escape hatch: future agents may attach extra fields without a schema bump.
  [key: string]: unknown;
}

/**
 * The item PILE. One per owner + type + location + flair: 10 arrows on you and
 * 200 in your room are two stacks of one definition, and only one-of-a-kind
 * types also set `definition.isNamedArtifact`.
 *
 * `name`/`displayName` are overrides set by the story on this pile only; resolve
 * with `stack.displayName ?? definition.displayName`.
 */
export interface DossierStack {
  id: string;
  definitionId: string;
  name?: string | null; // canonical, normalized override
  displayName?: string | null; // user-visible override
  class?: string | null; // override; falls back to definition.class
  rarity?: string | null; // override; falls back to definition.rarity
  description?: string | null; // override; falls back to definition.description
  type: "currency" | "equipped" | "inventory" | "world"; // how it is held
  /** Holder's display name: the persona, a present character, or "world". */
  owner: string;
  /** Persona or card id when the owner resolved, so matching survives the agent's spelling. */
  ownerId?: string | null;
  /** Provenance, uniques only: appended on an owner change, never per turn. */
  lastOwners?: DossierOwnerEvent[];
  locationRef: DossierLocationRef; // where it physically is
  qty: number;
  flair?: string | null; // "poisoned", "wrapped in oilcloth"
  /**
   * Free-text descriptor from the tracker agent ("backpack side pocket", "Fel's
   * room"). Display only: `stackLocationKey` never reads it, so rewording a
   * descriptor cannot split one pile into two.
   */
  locationText?: string | null;
  isUnique: boolean;
  isDestroyed: boolean;
  /** Acquisition flavour for the panel and journal. Never affects matching. */
  isStolen?: boolean;
  isGifted?: boolean;
  /**
   * Stowed in a container rather than dropped in the world, so the lastSeenTurn
   * cleanup spares it. Always false until currentTurn wiring and the agent's flag
   * land; add it to stackContentFields then, or a change will not register.
   */
  isStored?: boolean;
  /** Free-form per-instance metadata (an escape hatch for future agents). */
  customFields?: Record<string, unknown> | null;
  /** Equipped slot, when a future equipment agent assigns one. */
  equipmentSlot?: string | null;
  lastSeenTurn: number | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface PersistentItemDossier {
  schemaVersion: 2;
  definitions: DossierDefinition[];
  stacks: DossierStack[];
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
