// packages/server/src/services/storage/persistent-item-dossier.apply.ts
// Shared write path for the persistent item dossier: resolve the rewind/swipe
// base, hand the agent's DELTAS to the reconciler, project back into
// `playerStats.inventoryTracker*`, snapshot on a real change. One shape for
// every dossier writer.
//
//   - The base is found by MESSAGE ID at its ACTIVE swipe, never by timestamp:
//     a snapshot's `createdAt` is when the AGENT wrote it. No snapshot before
//     the turn means an EMPTY dossier, not the live row, so a rewound branch
//     never inherits items from the branch it left.
//   - The lock predicate is PREFIX-AWARE, matching what the panel writes.
//   - Owner context is completed here, so a writer cannot forget it.
import type { DB } from "../../db/connection.js";
import { createCharactersStorage } from "./characters.storage.js";
import { createChatsStorage } from "./chats.storage.js";
import { resolveCharacterNameMap } from "./character-name-map.js";
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
   * Owner resolution context, never injected into a prompt. `chatCharacters`
   * may be omitted -- the helper resolves the chat's own cards itself.
   */
  context: ItemDossierReconcileContext;
  /** Raw `fieldLocks` map from the game-state snapshot, or null. */
  fieldLocks?: Record<string, boolean> | null;
  /** The `playerStats` the tracker deltas merge onto. */
  playerStats: Record<string, unknown> | null | undefined;
  /** Ancestor messages strictly BEFORE this turn, newest last, each at its active swipe. */
  baseAnchors: Array<{ messageId: string; swipeIndex: number }>;
  /** The message + swipe this turn's snapshot is keyed to. */
  snapshotAnchor: { messageId: string; swipeIndex: number };
}

function readCharacterIds(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  } catch {
    return [];
  }
}

/** The chat's own cards as `{ characterId, name }`, skipping nameless rows. */
async function resolveChatCharacters(db: DB, chatId: string): Promise<Array<{ characterId: string; name: string }>> {
  const chat = await createChatsStorage(db).getById(chatId);
  const characterIds = readCharacterIds(chat?.characterIds);
  if (characterIds.length === 0) return [];
  const characters = createCharactersStorage(db);
  const nameById = await resolveCharacterNameMap(characterIds, (id) => characters.getById(id));
  return [...nameById].map(([characterId, name]) => ({ characterId, name }));
}

/** Fill in the chat's own cards unless the caller supplied some: the stable half of owner resolution. */
async function resolveReconcileContext(args: ApplyDossierUpdateArgs): Promise<ItemDossierReconcileContext> {
  const provided = args.context.chatCharacters;
  if (provided && provided.length > 0) return args.context;
  return { ...args.context, chatCharacters: await resolveChatCharacters(args.db, args.chatId) };
}

/**
 * Ancestor anchors for the rewind walk: every message strictly BEFORE the
 * target, each at its ACTIVE swipe (all swipes of one message share an id). A
 * normal turn's in-flight message is absent, so the previous turn stays in as
 * the base; a regeneration or swipe excludes the target's own. A missing target
 * keeps every message -- an empty list would resolve to an empty dossier.
 */
export function buildDossierBaseAnchors(
  messages: ReadonlyArray<{ id: string; activeSwipeIndex?: number | null }>,
  targetMessageId: string,
): Array<{ messageId: string; swipeIndex: number }> {
  const targetIndex = messages.findIndex((message) => message.id === targetMessageId);
  const ancestors = targetIndex >= 0 ? messages.slice(0, targetIndex) : messages;
  return ancestors.map((message) => ({ messageId: message.id, swipeIndex: message.activeSwipeIndex ?? 0 }));
}

/** Reconcile onto the rewind-resolved base, project, and snapshot when changed. */
export async function applyDossierUpdate(
  args: ApplyDossierUpdateArgs,
): Promise<Awaited<ReturnType<typeof reconcileAndProjectItemDossier>>> {
  const storage = createPersistentItemDossierStorage(args.db);
  const snapshotStorage = createItemDossierSnapshotStorage(args.db);
  // Nearest ancestor's snapshot. No ancestor with one means this branch has no
  // prior state: an EMPTY dossier, never the live row, which belongs to
  // whichever branch ran last and would leak its items in here.
  const baseSnapshot = await snapshotStorage.getLatestForAnchors(args.chatId, args.baseAnchors);
  // A seed row bootstraps a chat that never had a dossier. A swipe or rewind also
  // resolves to an empty base, and `playerStats` there belongs to the branch being
  // left, so the seed may only run while the chat has no dossier at all.
  const rows =
    (await storage.getForChat(args.chatId)) === null
      ? args.rows
      : args.rows.filter((row) => !row.seededFromPlayerStats);
  const fieldLocks = args.fieldLocks ?? null;
  const context = await resolveReconcileContext(args);
  return reconcileAndProjectItemDossier(storage, args.chatId, rows, context, {
    playerStats: args.playerStats,
    base: baseSnapshot ? baseSnapshot.dossier : null,
    // Prefix-aware: a group lock OR any row-level lock beneath it pins the array.
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

const DOSSIER_SAVE_GROUP_TYPES: Record<string, DossierAgentRow["type"]> = {
  currencies: "currency",
  equipped: "equipped",
  inventory: "inventory",
};

function editorString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Presence-preserving text for the fields that fall back to the shared
 * definition: `null` drops the override so the definition shows again, `""`
 * keeps an empty override so the definition stays suppressed, and an absent key
 * still means "untouched". Folding either value into `undefined` is what made
 * an emptied box save nothing.
 */
function editorText(value: unknown): string | null | undefined {
  if (typeof value === "string") return value;
  return value === null ? null : undefined;
}

/**
 * Presence-preserving text for fields with no definition fallback, where an
 * empty value and an explicit `null` mean the same thing: clear it.
 */
function editorClearableText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return value === null ? "" : undefined;
}

function editorBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Retype the save endpoint's editor rows into dossier rows. Editor rows are FULL
 * STATE per group -- both surfaces always send all three arrays -- so each row
 * is forwarded verbatim and the reconciler's SET semantics decide the rest: a
 * present field is written -- `null` reverts it to the definition, an empty
 * string blanks it -- and an absent field is untouched. A row may carry only a
 * uuid; the reconciler's gate lets it through
 * and findStack resolves it by id, falling back to the name tiers on a typo.
 *
 * `isDestroyed` and the engine-internal flags are dropped: deletion here is
 * explicit via the `removed` lists, never a stale row flag, and a save must
 * never mint or seed.
 */
export function buildDossierRowsFromEditorRows(
  groups: Record<string, unknown> | null | undefined,
  removed: Record<string, unknown> | null | undefined,
): DossierAgentRow[] {
  const rows: DossierAgentRow[] = [];
  for (const [group, type] of Object.entries(DOSSIER_SAVE_GROUP_TYPES)) {
    const list = groups?.[group];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const uuid = editorString(row.uuid);
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!uuid && !name) continue;
      rows.push({
        name,
        type,
        ...(uuid ? { uuid } : {}),
        ...(typeof row.qty === "number" && Number.isFinite(row.qty) ? { qty: Math.max(0, Math.floor(row.qty)) } : {}),
        flair: editorClearableText(row.flair),
        description: editorText(row.description),
        location: editorClearableText(row.location),
        class: editorText(row.class),
        rarity: editorText(row.rarity),
        equipmentSlot: editorClearableText(row.equipmentSlot),
        isUnique: editorBool(row.isUnique),
        isStolen: editorBool(row.isStolen),
        isGifted: editorBool(row.isGifted),
        ...(row.customFields && typeof row.customFields === "object" && !Array.isArray(row.customFields)
          ? { customFields: row.customFields as Record<string, unknown> }
          : {}),
      });
    }
    // Removals are per-group so a name-only entry cannot cross groups.
    const removals = removed?.[group];
    if (!Array.isArray(removals)) continue;
    for (const raw of removals) {
      if (typeof raw === "string") {
        if (raw.trim()) rows.push({ name: raw.trim(), type, removal: true });
        continue;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const uuid = editorString(entry.uuid);
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!uuid && !name) continue;
      rows.push({ name, type, ...(uuid ? { uuid } : {}), removal: true });
    }
  }
  return rows;
}
