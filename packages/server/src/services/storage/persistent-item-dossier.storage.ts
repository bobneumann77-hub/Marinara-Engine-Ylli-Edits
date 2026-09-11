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
 * Where a stack physically is. Observations NEVER overwrite or clear each other:
 * each source refreshes only its own field, and recency (`at`) alone decides
 * which one wins. This keeps the World Maps pointer alive across World State
 * renames ("Fel's room" -> "Fel's quarters" -> "Room of Fel") while still letting
 * a newer World State sighting supersede a stale map id after the item genuinely
 * moves to an unmapped room.
 *
 * Matching against the current scene, in order:
 *   1. map.id === current map id AND map.at >= world.at  -> confirmed
 *   2. world.name or map.name normalized-equals current  -> name match
 *   3. no observations, or no current location info       -> fail open (thin rows)
 *   4. otherwise a known, different place                 -> hidden
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
 * The item TEMPLATE. No quantity, no owner, no location.
 * `isNamedArtifact` marks canonical one-of-a-kind items (Frostmourne):
 * the engine refuses to mint a second stack for this definition.
 * Ordinary items that the story upgrades (iron sword → enchanted) get
 * `isUnique: true` on the STACK, not here.
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
 * The item PILE. One per owner + type + location + flair.
 * 10 arrows on you, 200 in your room, 15 in a shop = three stacks, one definition.
 *
 * `isUnique` lives here: a generic iron-sword definition can have a unique,
 * story-upgraded stack without affecting other iron-sword stacks. Only truly
 * one-of-a-kind types (Frostmourne) also set `definition.isNamedArtifact`.
 *
 * `name`/`displayName` are OVERRIDES: a stack renamed by the story ("Hero Sword"
 * -> "Broken Hero Sword") sets them here and leaves the shared definition alone.
 * Resolve as `stack.displayName ?? definition.displayName`.
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
  /**
   * Display name of the holder: the persona's name for the player's own items,
   * a present character's name, or "world" for nobody.
   */
  owner: string;
  /**
   * Stable id when `owner` resolved at write time -- the persona id, or a
   * present character's card id -- so matching, cleanup, and provenance work on
   * an id instead of the agent's free-text spelling ("Gwenpool" / "gwen" /
   * "Gwen Poole"). Null when the owner was "world" or did not resolve.
   */
  ownerId?: string | null;
  /**
   * CK3-style provenance, uniques only. Appended when the owner CHANGES (the
   * first mint counts as the "created" event), never once per turn, so a
   * long-held artifact does not accumulate hundreds of identical entries.
   * Commodities and never-transferred stacks keep this empty.
   */
  lastOwners?: DossierOwnerEvent[];
  locationRef: DossierLocationRef; // where it physically is
  qty: number;
  flair?: string | null; // "poisoned", "wrapped in oilcloth"
  isUnique: boolean;
  isDestroyed: boolean;
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
