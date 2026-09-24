// ──────────────────────────────────────────────
// Inventory Tracker manual-edit invariant
// ──────────────────────────────────────────────
// The agent apply path normalizes rows and keeps equipped/currency items out of
// carried inventory. Hand edits from the tracker panel and the HUD popover used to
// skip all of it, so a value the agent could never emit could still be typed in.
//
// Editing one group can change two: equipping a carried item removes it from the
// backpack. That is why this returns a whole patch instead of one array — the caller
// must persist every field it produces, in one write.
//
// Two builders live here. The normalized one serves the game-state PATCH path. The
// rich one keeps the rows exactly as the panel holds them, because that path now
// writes through the item dossier, where uuid/class/rarity/flair are the point.
import {
  compareInventoryTrackerRows,
  excludeInventoryTrackerCarriedDuplicates,
  normalizeInventoryTrackerRows,
  type InventoryTrackerGroup,
  type InventoryTrackerRow,
  type PlayerStats,
} from "@marinara-engine/shared";

const FIELD_BY_GROUP = {
  currencies: "inventoryTrackerCurrencies",
  equipped: "inventoryTrackerEquipped",
  inventory: "inventoryTrackerInventory",
} as const satisfies Record<InventoryTrackerGroup, keyof PlayerStats>;

export type InventoryTrackerPatch = Pick<
  PlayerStats,
  "inventoryTrackerCurrencies" | "inventoryTrackerEquipped" | "inventoryTrackerInventory"
>;

/**
 * Alphabetical order, through the shared comparator the projection also uses.
 *
 * The projection sorted by `createdAt`, which the client never receives, so a moved row
 * landed at the bottom of its new group and then jumped to its creation slot when the
 * save response arrived. Sorting here means the optimistic view already shows the order
 * the server will return, so nothing moves a beat later. A different order (rarity,
 * class, grouping) belongs to the client view alone.
 */
function sortInventoryTrackerRows(rows: InventoryTrackerRow[]): InventoryTrackerRow[] {
  return [...rows].sort(compareInventoryTrackerRows);
}

/**
 * Build the `playerStats` patch for one edited group.
 *
 * Rows merge by name here exactly as they do on the server, so the optimistic store
 * cannot drift from what was persisted. Adding a row stays safe because the panel
 * gives each new placeholder a name no existing row has.
 */
export function buildInventoryTrackerEditPatch(
  currentPlayerStats: PlayerStats | null | undefined,
  group: InventoryTrackerGroup,
  rows: InventoryTrackerRow[],
): Partial<InventoryTrackerPatch> {
  const normalized = normalizeInventoryTrackerRows(rows);

  const currencies = group === "currencies" ? normalized : (currentPlayerStats?.inventoryTrackerCurrencies ?? []);
  const equipped = group === "equipped" ? normalized : (currentPlayerStats?.inventoryTrackerEquipped ?? []);
  const carried = group === "inventory" ? normalized : (currentPlayerStats?.inventoryTrackerInventory ?? []);

  const patch: Partial<InventoryTrackerPatch> = { [FIELD_BY_GROUP[group]]: sortInventoryTrackerRows(normalized) };

  const deduped = excludeInventoryTrackerCarriedDuplicates(carried, currencies, equipped);
  if (deduped.length !== carried.length) patch.inventoryTrackerInventory = sortInventoryTrackerRows(deduped);

  return patch;
}

/**
 * The dossier-backed variant of {@link buildInventoryTrackerEditPatch}.
 *
 * The tracker panel and the HUD popover persist through the item dossier now, so
 * their rows have to reach the server untouched: uuid, class, rarity and flair
 * belong to the stack, and the shared normalizer drops all four. Everything else —
 * the whole-patch shape and the carried-duplicate trim — stays identical, so the
 * optimistic store still matches what the caller is about to persist.
 *
 * `InventoryTrackerRow` declares name/qty/description/location only, but the rows
 * the panel edits are projected rows and carry the richer fields at runtime. They
 * are passed through as received; that is the point of this variant.
 */
export function buildInventoryTrackerRichEditPatch(
  currentPlayerStats: PlayerStats | null | undefined,
  group: InventoryTrackerGroup,
  rows: InventoryTrackerRow[],
): Partial<InventoryTrackerPatch> {
  const currencies = group === "currencies" ? rows : (currentPlayerStats?.inventoryTrackerCurrencies ?? []);
  const equipped = group === "equipped" ? rows : (currentPlayerStats?.inventoryTrackerEquipped ?? []);
  const carried = group === "inventory" ? rows : (currentPlayerStats?.inventoryTrackerInventory ?? []);

  const patch: Partial<InventoryTrackerPatch> = { [FIELD_BY_GROUP[group]]: sortInventoryTrackerRows(rows) };

  const deduped = excludeInventoryTrackerCarriedDuplicates(carried, currencies, equipped);
  if (deduped.length !== carried.length) patch.inventoryTrackerInventory = sortInventoryTrackerRows(deduped);

  return patch;
}
