// packages/server/src/services/storage/persistent-item-dossier.projection.ts
// The dossier is the source of truth for the persona's carried items;
// `playerStats.inventoryTracker*` is a VIEW of it.
//
// The agent emits DELTAS, but `buildLockedInventoryTrackerPatch` replaces a whole
// group whenever that group is emitted, so one changed potion would show the main
// model a one-item inventory while the dossier still holds thirty. Projecting
// after every reconcile keeps the model, the panel and the dossier on one state.
//
// Only the three `inventoryTracker*` keys are written: `playerStats` is a shared
// blob, so it is shallow-merged and the other trackers survive.
import { isDeepStrictEqual } from "node:util";
import {
  INVENTORY_TRACKER_STATS_FIELDS,
  isPlayerOwnedStack,
  reconcileItemDossier,
  type DossierAgentRow,
  type ItemDossierReconcileContext,
} from "./persistent-item-dossier.reconciler.js";
import type { ItemDossierSnapshotStorage } from "./persistent-item-dossier-snapshot.storage.js";
import type {
  DossierDefinition,
  DossierStack,
  PersistentItemDossier,
  PersistentItemDossierStorage,
} from "./persistent-item-dossier.storage.js";

/** The three stack types that project, in render order. `world` never does. */
const PROJECTED_TYPES = ["currency", "equipped", "inventory"] as const;
type ProjectedType = (typeof PROJECTED_TYPES)[number];

/**
 * Stack type -> the tracker lock group it renders into. Locks live under
 * `player.inventoryTracker.<group>`, not the `playerStats` field name: asking
 * with the field name silently never matched, so pinned arrays were overwritten.
 */
const LOCK_GROUP_BY_TYPE: Record<ProjectedType, string> = {
  currency: "currencies",
  equipped: "equipped",
  inventory: "inventory",
};

function inventoryTrackerGroupLockPrefix(type: ProjectedType): string {
  return `player.inventoryTracker.${LOCK_GROUP_BY_TYPE[type]}`;
}

export interface ProjectDossierToPlayerStatsArgs {
  /** Straight off `reconcileItemDossier`'s return value. */
  dossier: PersistentItemDossier | null | undefined;
  /** Current state; every non-inventory-tracker key is preserved unchanged. */
  playerStats: Record<string, unknown> | null | undefined;
  /** Host context, used only for the player-ownership test. */
  context: ItemDossierReconcileContext;
  /**
   * Per-field lock test, injected so the projector never knows the lock key
   * format. Receives a GROUP PREFIX; a row lock beneath it also pins the group.
   */
  isFieldLocked?: (groupKeyPrefix: string) => boolean;
}

export interface ProjectDossierToPlayerStatsResult {
  playerStats: Record<string, unknown>;
  /** True when at least one of the three projected arrays actually changed. */
  changed: boolean;
}

/** Trimmed non-empty text, or undefined. Empty fields are omitted, never `null`. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** One projected row: stack overrides fall back to the shared definition. */
function projectStack(stack: DossierStack, definition: DossierDefinition | undefined): Record<string, unknown> {
  const row: Record<string, unknown> = {
    uuid: stack.id,
    name: stack.displayName ?? stack.name ?? definition?.displayName ?? definition?.name ?? "",
    qty: typeof stack.qty === "number" ? stack.qty : 1,
  };
  const className = optionalText(stack.class ?? definition?.class);
  const rarity = optionalText(stack.rarity ?? definition?.rarity);
  const description = optionalText(stack.description ?? definition?.description);
  const flair = optionalText(stack.flair);
  if (className) row.class = className;
  if (rarity) row.rarity = rarity;
  if (description) row.description = description;
  if (flair) row.flair = flair;
  const location = optionalText(stack.locationText);
  if (location) row.location = location;
  if (stack.isUnique) row.isUnique = true;
  return row;
}

/** Creation order, tie-broken by stack id, so the injected block never churns. */
function byCreationOrder(a: DossierStack, b: DossierStack): number {
  const byCreatedAt = String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
}

/**
 * Re-derive the persona's three tracker arrays. `world` stacks are skipped even
 * when the persona owns them: dropping an item is a move to the floor, not into
 * the player's pockets. NPC-owned stacks are skipped by the ownership test.
 */
export function projectDossierToPlayerStats(args: ProjectDossierToPlayerStatsArgs): ProjectDossierToPlayerStatsResult {
  const base = args.playerStats && typeof args.playerStats === "object" ? args.playerStats : {};
  const next: Record<string, unknown> = { ...base };
  let changed = false;

  const definitions = new Map<string, DossierDefinition>();
  for (const definition of args.dossier?.definitions ?? []) definitions.set(definition.id, definition);

  const buckets: Record<ProjectedType, DossierStack[]> = { currency: [], equipped: [], inventory: [] };
  for (const stack of args.dossier?.stacks ?? []) {
    if (stack.type === "world") continue;
    if (!PROJECTED_TYPES.includes(stack.type as ProjectedType)) continue;
    if (stack.isDestroyed) continue;
    if (typeof stack.qty === "number" && stack.qty <= 0) continue;
    if (!isPlayerOwnedStack(stack, args.context)) continue;
    buckets[stack.type as ProjectedType].push(stack);
  }

  for (const type of PROJECTED_TYPES) {
    const field = INVENTORY_TRACKER_STATS_FIELDS[type];
    // Ask with the group prefix the panel actually writes, not the field name.
    if (args.isFieldLocked?.(inventoryTrackerGroupLockPrefix(type))) continue;
    const rows = [...buckets[type]]
      .sort(byCreationOrder)
      .map((stack) => projectStack(stack, definitions.get(stack.definitionId)));
    if (!isDeepStrictEqual(rows, base[field] ?? [])) changed = true;
    next[field] = rows;
  }

  return { playerStats: next, changed };
}

/** Reconcile agent rows, then project: every dossier writer inherits the projection this way. */
export interface ReconcileAndProjectOptions {
  playerStats: Record<string, unknown> | null | undefined;
  isFieldLocked?: (groupKeyPrefix: string) => boolean;
  /** Enables rewind/swipe history: snapshot `anchor` on turns that changed the dossier. */
  snapshot?: {
    storage: ItemDossierSnapshotStorage;
    anchor: { messageId: string; swipeIndex: number };
  };
  /**
   * Rewind/swipe merge base. `null` starts empty; `undefined` keeps the live
   * row, reachable only by chats with no snapshot history.
   */
  base?: PersistentItemDossier | null;
}

/** Structured comparison so the snapshot write is gated on a real change. */
function dossierChanged(before: PersistentItemDossier | null, after: PersistentItemDossier): boolean {
  if (!before) return after.stacks.length > 0 || after.definitions.length > 0;
  return !isDeepStrictEqual(before, after);
}

export async function reconcileAndProjectItemDossier(
  storage: PersistentItemDossierStorage,
  chatId: string,
  rows: DossierAgentRow[],
  context: ItemDossierReconcileContext,
  projection: ReconcileAndProjectOptions,
): Promise<ProjectDossierToPlayerStatsResult & { dossier: PersistentItemDossier }> {
  // Change-detection baseline: diff against the same state the reconcile merged
  // onto, since the live row belongs to a different branch on a rewind and would
  // read as a spurious change. The clone matters -- the reconciler mutates a
  // supplied base in place, so an uncloned baseline compares equal to itself and
  // every turn after the first would report "unchanged".
  const dossierBefore =
    projection.base !== undefined
      ? projection.base
        ? structuredClone(projection.base)
        : null
      : projection.snapshot
        ? await storage.getForChat(chatId)
        : null;
  const dossier = await reconcileItemDossier(storage, chatId, rows, context, projection.base);
  if (projection.snapshot && dossierChanged(dossierBefore, dossier)) {
    await projection.snapshot.storage.saveSnapshot(
      chatId,
      projection.snapshot.anchor.messageId,
      projection.snapshot.anchor.swipeIndex,
      dossier,
    );
  }
  return { dossier, ...projectDossierToPlayerStats({ dossier, context, ...projection }) };
}
