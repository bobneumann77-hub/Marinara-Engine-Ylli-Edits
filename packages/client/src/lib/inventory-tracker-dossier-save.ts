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

/**
 * Deletions are explicit: a row the editor dropped is reported by uuid, falling
 * back to the exact name when the displayed row had none. Matching a uuid first
 * keeps the tombstone type-agnostic, like the agent path.
 */
function buildRemoved(before: unknown[], after: unknown[]): (string | { uuid: string; name?: string })[] {
  const afterKeys = new Set(after.map(rowUuid).filter((uuid): uuid is string => !!uuid));
  const afterNames = new Set(
    after
      .map(rowName)
      .filter((name): name is string => !!name)
      .map((name) => name.toLowerCase()),
  );
  const removed: (string | { uuid: string; name?: string })[] = [];
  for (const row of before) {
    const uuid = rowUuid(row);
    if (uuid) {
      if (!afterKeys.has(uuid)) removed.push({ uuid, name: rowName(row) });
      continue;
    }
    const name = rowName(row);
    if (name && !afterNames.has(name.toLowerCase())) removed.push(name);
  }
  return removed;
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
  const body = {
    messageId: snapshot.messageId,
    swipeIndex: snapshot.swipeIndex,
    rows: groups,
    removed: {
      currencies: buildRemoved(before.currencies, groups.currencies),
      equipped: buildRemoved(before.equipped, groups.equipped),
      inventory: buildRemoved(before.inventory, groups.inventory),
    },
  };
  if (!body.messageId || !Number.isInteger(body.swipeIndex) || (body.swipeIndex ?? -1) < 0) {
    throw new Error("No message anchor is available to save this inventory against");
  }
  const result = await api.post<{ playerStats: PlayerStats }>(`/chats/${chatId}/item-dossier`, body);
  return result.playerStats;
}
