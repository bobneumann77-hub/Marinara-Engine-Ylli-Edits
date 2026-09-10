// packages/server/src/services/storage/persistent-item-dossier.reconciler.ts
// Shared reconciler core. Producing agents supply rows; this file owns identity,
// per-field deltas, owner history, and the type/status transitions.
// The dossier itself never cares which agent wrote a row — only the shape.
import {
  type DossierEntry,
  type DossierLocation,
  type PersistentItemDossier,
  type PersistentItemDossierStorage,
} from "./persistent-item-dossier.storage.js";
import { newId, now } from "../../utils/id-generator.js";

// A single row as emitted by a producing agent (inventory tracker today;
// a future shop / equipment / relationship agent can reuse the same shape).
export interface DossierAgentRow {
  uuid?: string;
  name: string;
  type?: "currency" | "equipped" | "inventory";
  qty?: number;
  isUnique?: boolean;
  isDestroyed?: boolean;
  description?: string;
  class?: string;
  rarity?: string;
  owner?: string;
  isStolen?: boolean;
  isGifted?: boolean;
  equipmentSlot?: string;
  customFields?: Record<string, unknown>;
}

// Canonical key for name matching: trim, lowercase, collapse whitespace.
// Kept local so the reconciler has no dependency on any package's normalizer.
function canonicalName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ") : "";
}

// Owner history is host-owned and capped so a hot-swapped item cannot grow
// the entry without bound. Newest first.
function pushLastOwner(entry: DossierEntry, owner: string, reason: "changed" | "stolen" | "gifted"): void {
  entry.lastOwners ??= [];
  entry.lastOwners.unshift({ owner, at: now(), reason });
  entry.lastOwners = entry.lastOwners.slice(0, 5);
}

/**
 * Reconcile one agent's rows against the per-chat dossier.
 *
 * Identity rules (in order):
 *   1. exact `uuid` match       -> update that entry (survives renames)
 *   2. canonical `name` match   -> update that entry, keep its uuid
 *   3. no match                 -> create a new entry with a fresh uuid
 *
 * Field rules:
 *   - omitted fields are left unchanged (per-field delta)
 *   - host-owned fields (uuid, location, createdAt, lastOwners order) are
 *     never overwritten by model output
 *   - an entry omitted from the active output is kept forever, only its
 *     `type` flips to "none" — no hard deletes
 */
export async function reconcileItemDossier(
  storage: PersistentItemDossierStorage,
  chatId: string,
  rows: DossierAgentRow[],
  currentLocation?: DossierLocation | null,
): Promise<PersistentItemDossier> {
  const loaded = await storage.getForChat(chatId);
  const dossier: PersistentItemDossier = loaded ?? { schemaVersion: 1, entries: [] };
  const seen = new Set<string>();

  for (const row of rows) {
    // Phase A: find the entry — exact uuid first, then canonical name.
    let entry: DossierEntry | undefined;
    if (row.uuid) {
      entry = dossier.entries.find((e) => e.uuid === row.uuid && e.status !== "destroyed");
    }
    if (!entry) {
      const key = canonicalName(row.name);
      entry = dossier.entries.find((e) => canonicalName(e.name) === key && e.status !== "destroyed");
    }

    // Phase B: create a fresh entry from everything the agent supplied.
    if (!entry) {
      const ts = now();
      const isUnique = row.isUnique === true;
      const created: DossierEntry = {
        uuid: newId(),
        name: canonicalName(row.name),
        displayName: row.name,
        type: row.type ?? "inventory",
        qty: isUnique ? 1 : (row.qty ?? 1),
        status: row.isDestroyed === true ? "destroyed" : "active",
        isUnique: row.isUnique ?? null,
        isDestroyed: row.isDestroyed ?? null,
        isStackable: !isUnique && row.type !== "equipped",
        description: row.description ?? null,
        class: row.class ?? null,
        rarity: row.rarity ?? null,
        owner: row.owner ?? "player",
        isStolen: row.isStolen ?? null,
        isGifted: row.isGifted ?? null,
        equipmentSlot: row.equipmentSlot ?? null,
        customFields: row.customFields ?? {},
        lastOwners: [{ owner: row.owner ?? "player", at: ts, reason: "created" }],
        location: currentLocation ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
      dossier.entries.push(created);
      seen.add(created.uuid);
      continue;
    }

    // Phase C: update — omitted fields stay unchanged.
    const previousOwner = entry.owner ?? "player";
    if (row.owner && canonicalName(row.owner) !== canonicalName(previousOwner)) {
      pushLastOwner(entry, previousOwner, "changed");
      entry.owner = row.owner;
    }
    if (row.isStolen === true && entry.isStolen !== true) {
      pushLastOwner(entry, previousOwner, "stolen");
      entry.isStolen = true;
    }
    if (row.isGifted === true && entry.isGifted !== true) {
      pushLastOwner(entry, previousOwner, "gifted");
      entry.isGifted = true;
    }

    if (row.type !== undefined) entry.type = row.type;
    if (row.name !== undefined) {
      entry.name = canonicalName(row.name);
      entry.displayName = row.name;
    }
    if (row.qty !== undefined) entry.qty = row.isUnique ? 1 : row.qty;
    if (row.description !== undefined) entry.description = row.description;
    if (row.class !== undefined) entry.class = row.class;
    if (row.rarity !== undefined) entry.rarity = row.rarity;
    if (row.equipmentSlot !== undefined) entry.equipmentSlot = row.equipmentSlot;
    if (row.isUnique !== undefined) {
      entry.isUnique = row.isUnique;
      entry.qty = row.isUnique ? 1 : entry.qty;
    }
    if (row.customFields !== undefined) {
      entry.customFields = { ...(entry.customFields ?? {}), ...row.customFields };
    }

    entry.isStackable = entry.isUnique !== true && entry.type !== "equipped";
    entry.status = row.isDestroyed === true ? "destroyed" : "active";
    entry.updatedAt = now();
    seen.add(entry.uuid);
  }

  // Items omitted from the active output leave the player's possession:
  // keep the entry forever, just flip the type to "none". No hard deletes.
  for (const entry of dossier.entries) {
    if (entry.status === "destroyed") continue;
    if (!seen.has(entry.uuid)) {
      entry.type = "none";
      entry.updatedAt = now();
    }
  }

  // Host-owned location. Keeps the Maps uuid even if Maps is briefly removed;
  // the location name is the fallback identity for later matching.
  if (currentLocation) {
    for (const entry of dossier.entries) {
      if (entry.status === "destroyed") continue;
      entry.location = {
        mapLocationId: currentLocation.mapLocationId ?? entry.location?.mapLocationId ?? null,
        locationName: currentLocation.locationName ?? entry.location?.locationName ?? null,
        source: currentLocation.source ?? entry.location?.source ?? "none",
        lastSeenAt: now(),
      };
    }
  }

  await storage.saveForChat(chatId, dossier);
  return dossier;
}
