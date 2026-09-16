// ──────────────────────────────────────────────
// Inventory Tracker → dossier save
// ──────────────────────────────────────────────
// Editor writes go to the dossier, not playerStats: playerStats.inventoryTracker*
// is projection-only output, and the game-state PATCH normalizer strips dossier
// fields (uuid, class, rarity, flair). Rows are sent UNNORMALIZED — the endpoint
// applies SET semantics server-side, where present = set, absent = untouched.
import type { GameState, InventoryTrackerGroup, PlayerStats } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

type EditorGroups = Record<InventoryTrackerGroup, unknown[]>;

/** Uuid of a projected row, if the server emitted one. */
function rowUuid(row: unknown): string | undefined {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    const uuid = (row as Record<string, unknown>).uuid;
    if (typeof uuid === "string" && uuid.length > 0) return uuid;
  }
  return undefined;
}

/** Display name of a projected row, for name-keyed removals. */
function rowName(row: unknown): string | undefined {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    const name = (row as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  return undefined;
}

type RemovedEntry = string | { uuid: string; name?: string };

/**
 * A before/after diff cannot tell a deletion from a uuid edit: editing a uuid
 * drops the old value out of the after-list while the row is still on screen,
 * so the diff would tombstone an item that never left. Pair each after-row
 * whose uuid the server never emitted with the one before-row of the same name
 * that nothing else claims, restore that uuid on the posted row (uuid is a
 * selector, so the mangled value never travels), and keep that before-row out
 * of `removed`.
 *
 * Ambiguity pairs nothing -- a name matching several before-rows, or several
 * after-rows claiming one -- and the removal stands: a stray delete is visible
 * and recoverable on a rewind, a wrong resurrection is not.
 *
 * A before-row nothing paired with is reported by uuid, falling back to the
 * exact name when the displayed row had none.
 */
function reconcileGroupEdits(before: unknown[], after: unknown[]): { rows: unknown[]; removed: RemovedEntry[] } {
  const beforeUuids = new Set<string>();
  const beforeByName = new Map<string, unknown[]>();
  for (const row of before) {
    const uuid = rowUuid(row);
    if (uuid) beforeUuids.add(uuid);
    const name = rowName(row)?.toLowerCase();
    if (name) beforeByName.set(name, [...(beforeByName.get(name) ?? []), row]);
  }

  const afterUuids = new Set<string>();
  const afterNames = new Set<string>();
  const claimedUuids = new Set<string>();
  for (const row of after) {
    const uuid = rowUuid(row);
    if (uuid) {
      afterUuids.add(uuid);
      if (beforeUuids.has(uuid)) claimedUuids.add(uuid);
    }
    const name = rowName(row)?.toLowerCase();
    if (name) afterNames.add(name);
  }

  const repairs = new Map<number, string>();
  const keptAlive = new Set<string>();
  const unpaired = new Map<string, number[]>();
  after.forEach((row, index) => {
    const uuid = rowUuid(row);
    if (uuid && beforeUuids.has(uuid)) return;
    const name = rowName(row)?.toLowerCase();
    if (!name || !beforeByName.has(name)) return;
    unpaired.set(name, [...(unpaired.get(name) ?? []), index]);
  });
  for (const [name, indices] of unpaired) {
    const candidates = (beforeByName.get(name) ?? []).filter((row) => {
      const uuid = rowUuid(row);
      return !!uuid && !claimedUuids.has(uuid);
    });
    const restored = candidates.length === 1 ? rowUuid(candidates[0]) : undefined;
    if (!restored || indices.length !== 1) continue;
    repairs.set(indices[0], restored);
    claimedUuids.add(restored);
    keptAlive.add(restored);
  }

  const rows = after.map((row, index) => {
    const restored = repairs.get(index);
    if (!restored || !row || typeof row !== "object" || Array.isArray(row)) return row;
    return { ...(row as Record<string, unknown>), uuid: restored };
  });

  const removed: RemovedEntry[] = [];
  for (const row of before) {
    const uuid = rowUuid(row);
    if (uuid) {
      if (!afterUuids.has(uuid) && !keptAlive.has(uuid)) removed.push({ uuid, name: rowName(row) });
      continue;
    }
    const name = rowName(row);
    if (name && !afterNames.has(name.toLowerCase())) removed.push(name);
  }
  return { rows, removed };
}

/**
 * POST the editor's rows to the chat's dossier Save endpoint and return the
 * server's projected playerStats — the caller adopts it as-is instead of
 * patching optimistically, so the view can never drift from the dossier.
 */
export async function saveInventoryTrackerToDossier(
  chatId: string,
  snapshot: GameState,
  groups: EditorGroups,
): Promise<PlayerStats> {
  // Read the three projected arrays by field name rather than indexing by group
  // string: the arrays are optional and typed, so a direct read stays honest.
  const before: Record<InventoryTrackerGroup, unknown[]> = {
    currencies: snapshot.playerStats?.inventoryTrackerCurrencies ?? [],
    equipped: snapshot.playerStats?.inventoryTrackerEquipped ?? [],
    inventory: snapshot.playerStats?.inventoryTrackerInventory ?? [],
  };
  const rows: EditorGroups = { currencies: [], equipped: [], inventory: [] };
  const removed: Record<InventoryTrackerGroup, RemovedEntry[]> = { currencies: [], equipped: [], inventory: [] };
  for (const group of ["currencies", "equipped", "inventory"] as const) {
    const reconciled = reconcileGroupEdits(before[group], groups[group]);
    rows[group] = reconciled.rows;
    removed[group] = reconciled.removed;
  }
  const body = {
    messageId: snapshot.messageId,
    swipeIndex: snapshot.swipeIndex,
    rows,
    removed,
  };
  if (!body.messageId || !Number.isInteger(body.swipeIndex) || (body.swipeIndex ?? -1) < 0) {
    throw new Error("No message anchor is available to save this inventory against");
  }
  const result = await api.post<{ playerStats: PlayerStats }>(`/chats/${chatId}/item-dossier`, body);
  return result.playerStats;
}
