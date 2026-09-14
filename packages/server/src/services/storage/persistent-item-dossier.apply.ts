// packages/server/src/services/storage/persistent-item-dossier.apply.ts
// Shared write path for the persistent item dossier.
//
// Why this exists: every dossier writer -- the inventory agent today, a shop
// or NPC-inventory agent tomorrow, the tracker panel later -- needs the same
// four steps: resolve the rewind/swipe merge base from snapshot history, hand
// the agent's DELTAS to the reconciler, project the dossier back into
// `playerStats.inventoryTracker*`, and snapshot the result when it changed.
// Before this helper that plumbing lived inline inside the inventory tracker's
// `if (result.type === "inventory_tracker_update")` block in each route, and
// any future writer would have had to duplicate all of it just to write one
// row. The helper exists so one shape serves every writer.
//
// The helper owns three things that are easy to get wrong per call site:
//   1. The rewind base is resolved by MESSAGE ID, not timestamp. A snapshot's
//      `createdAt` is when the AGENT wrote it, which can be weeks after the
//      message it belongs to, so a clock comparison rewinds to the wrong state.
//      When no snapshot precedes the turn, the base is an EMPTY dossier rather
//      than the live row, so a rewound or swiped branch never inherits items
//      from the branch it left.
//   2. The tracker lock predicate is PREFIX-AWARE. The panel writes group locks
//      as `player.inventoryTracker.currencies` and row locks beneath that same
//      prefix, so a plain field-name lookup never matches and the projection
//      silently overwrites arrays the user pinned.
//   3. The snapshot is written only when the dossier actually changed, so a
//      turn that only moves a world row does not churn history.
//
// Callers pass `baseAnchors` (the ancestor messages strictly BEFORE this turn,
// each with its ACTIVE swipe) rather than a resolved base, because the cut that
// produces them is route-specific: the generate route slices its loaded message
// array on the target message, while the retry route slices on the retry
// target. Everything after the cut is shared.
import type { DB } from "../../db/connection.js";
import { reconcileAndProjectItemDossier } from "./persistent-item-dossier.projection.js";
import { createPersistentItemDossierStorage } from "./persistent-item-dossier.storage.js";
import { createItemDossierSnapshotStorage } from "./persistent-item-dossier-snapshot.storage.js";
import type { DossierAgentRow, ItemDossierReconcileContext } from "./persistent-item-dossier.reconciler.js";

export interface ApplyDossierUpdateArgs {
  db: DB;
  chatId: string;
  /** The agent's DELTAS retyped into dossier rows. */
  rows: DossierAgentRow[];
  /**
   * Engine-side owner resolution context (persona identity, the chat's own
   * cards, the tracker's presentCharacters). This is never injected into an
   * agent prompt; it exists so `resolveOwner` can turn a name into a stable id.
   */
  context: ItemDossierReconcileContext;
  /** Raw `fieldLocks` map from the game-state snapshot, or null. */
  fieldLocks?: Record<string, boolean> | null;
  /** The `playerStats` the tracker deltas merge onto. */
  playerStats: Record<string, unknown> | null | undefined;
  /**
   * Ancestor messages strictly BEFORE this turn, in chat order with the newest
   * last. Each carries its active swipe so the walk can skip a branch the user
   * has swiped away from.
   */
  baseAnchors: Array<{ messageId: string; swipeIndex: number }>;
  /** The message + swipe this turn's snapshot is keyed to. */
  snapshotAnchor: { messageId: string; swipeIndex: number };
}

/**
 * Reconcile the agent's rows onto the rewind-resolved base, project the
 * dossier back into `playerStats`, and snapshot the result when it changed.
 *
 * Returns the projected `playerStats` plus the reconciled dossier, so callers
 * can gate their own writes on `changed` and read the dossier for follow-ups.
 */
export async function applyDossierUpdate(
  args: ApplyDossierUpdateArgs,
): Promise<Awaited<ReturnType<typeof reconcileAndProjectItemDossier>>> {
  const storage = createPersistentItemDossierStorage(args.db);
  const snapshotStorage = createItemDossierSnapshotStorage(args.db);
  // Merge base: the snapshot of the NEAREST ancestor message, read at that
  // message's own active swipe. Message order decides the walk, not `createdAt`
  // -- a snapshot's clock is when the AGENT wrote it, so it can be weeks after
  // the message it belongs to -- and inactive swipes are skipped, so a branch
  // never merges onto a swipe the user moved away from. When no ancestor has a
  // snapshot, this branch has no prior state -- a swipe of its first turn, or a
  // rewind past the point the dossier was created -- so the base is an EMPTY
  // dossier (`null`), never the live row: the live row belongs to whichever
  // branch ran last and would leak its items into a branch that never had them.
  // Older chats keep their one-time seed from `playerStats`, which runs while
  // the dossier is still empty.
  const baseSnapshot = await snapshotStorage.getLatestForAnchors(args.chatId, args.baseAnchors);
  const fieldLocks = args.fieldLocks ?? null;
  return reconcileAndProjectItemDossier(storage, args.chatId, args.rows, args.context, {
    playerStats: args.playerStats,
    base: baseSnapshot ? baseSnapshot.dossier : null,
    // Prefix-aware: a group lock OR any row-level lock beneath it pins the
    // array. This is the same rule the shared tracker-lock merge uses, so a
    // partial row lock cannot be silently dropped by the projection.
    isFieldLocked: (prefix) =>
      Object.entries(fieldLocks ?? {}).some(
        ([key, locked]) => locked === true && (key === prefix || key.startsWith(`${prefix}.`)),
      ),
    snapshot: {
      storage: snapshotStorage,
      anchor: args.snapshotAnchor,
    },
  });
}
