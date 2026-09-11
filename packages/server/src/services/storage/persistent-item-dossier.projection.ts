// packages/server/src/services/storage/persistent-item-dossier.projection.ts
// Engine-owned projection. The dossier is the source of truth for the persona's
// carried items; `playerStats.inventoryTracker*` is a VIEW of it.
//
// Why this exists: the inventory agent now emits DELTAS, while
// `buildLockedInventoryTrackerPatch` replaces a whole group whenever that group
// is emitted. One changed potion therefore shows the main model a one-item
// inventory while the dossier still holds thirty. Projecting the dossier back
// into those three arrays after every reconcile keeps the model, the tracker
// panel and the dossier reading one state instead of three that can drift.
//
// The projection writes EXACTLY the three `inventoryTracker*` keys and
// shallow-merges everything else untouched: `playerStats` is a shared blob
// (`status`, `activeQuests`, `stats`, `customTrackerFields`), and a wholesale
// overwrite would destroy the other trackers.
import { isDeepStrictEqual } from "node:util";
import {
  INVENTORY_TRACKER_STATS_FIELDS,
  isPlayerOwnedStack,
  reconcileItemDossier,
  type DossierAgentRow,
  type ItemDossierReconcileContext,
} from "./persistent-item-dossier.reconciler.js";
import type {
  DossierDefinition,
  DossierStack,
  PersistentItemDossier,
  PersistentItemDossierStorage,
} from "./persistent-item-dossier.storage.js";

/** The three stack types that project, in render order. `world` never does. */
const PROJECTED_TYPES = ["currency", "equipped", "inventory"] as const;
type ProjectedType = (typeof PROJECTED_TYPES)[number];

export interface ProjectDossierToPlayerStatsArgs {
  /** Straight off `reconcileItemDossier`'s return value. */
  dossier: PersistentItemDossier | null | undefined;
  /** Current state; every non-inventory-tracker key is preserved unchanged. */
  playerStats: Record<string, unknown> | null | undefined;
  /** Host context, used only for the player-ownership test. */
  context: ItemDossierReconcileContext;
  /**
   * Per-field lock test, injected so the projector never has to know the lock
   * key format. A locked array keeps the value it already had.
   */
  isFieldLocked?: (fieldKey: string) => boolean;
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

/**
 * One projected row. `class`/`rarity`/`description` are stack OVERRIDES that
 * fall back to the shared definition, so they resolve through `definitionId`
 * instead of being read off the stack alone.
 */
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
  if (stack.isUnique) row.isUnique = true;
  return row;
}

/** Creation order, tie-broken by stack id, so the injected block never churns. */
function byCreationOrder(a: DossierStack, b: DossierStack): number {
  const byCreatedAt = String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
}

/**
 * Re-derive the persona's three tracker arrays from the dossier.
 *
 * `world` stacks are skipped even when the persona still owns them: dropping an
 * item is a move to the floor, not a move into the player's pockets. NPC-owned
 * carried stacks are skipped by the ownership test, which is also what keeps
 * their gear out of the panel.
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
    if (args.isFieldLocked?.(field)) continue;
    const rows = [...buckets[type]]
      .sort(byCreationOrder)
      .map((stack) => projectStack(stack, definitions.get(stack.definitionId)));
    if (!isDeepStrictEqual(rows, base[field] ?? [])) changed = true;
    next[field] = rows;
  }

  return { playerStats: next, changed };
}

/**
 * Reconcile incoming agent rows, then project the dossier back into `playerStats`.
 *
 * The wrapper exists so EVERY dossier writer -- the inventory agent today, a
 * shop or NPC-inventory agent tomorrow, the tracker panel later -- inherits the
 * projection instead of each call site having to remember to run it.
 */
export async function reconcileAndProjectItemDossier(
  storage: PersistentItemDossierStorage,
  chatId: string,
  rows: DossierAgentRow[],
  context: ItemDossierReconcileContext,
  projection: {
    playerStats: Record<string, unknown> | null | undefined;
    isFieldLocked?: (fieldKey: string) => boolean;
  },
): Promise<ProjectDossierToPlayerStatsResult & { dossier: PersistentItemDossier }> {
  const dossier = await reconcileItemDossier(storage, chatId, rows, context);
  return { dossier, ...projectDossierToPlayerStats({ dossier, context, ...projection }) };
}
