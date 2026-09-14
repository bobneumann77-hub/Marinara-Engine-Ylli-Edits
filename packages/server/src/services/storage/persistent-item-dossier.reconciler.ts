// packages/server/src/services/storage/persistent-item-dossier.reconciler.ts
// Shared reconciler core. Producing agents supply rows; this file owns identity,
// definition minting, per-field stack deltas, owner resolution, turn stamps, and
// the cleanup tail. The dossier never cares which agent wrote a row -- only the
// shape.
import {
  type DossierDefinition,
  type DossierLocationRef,
  type DossierOwnerEvent,
  type DossierStack,
  type PersistentItemDossier,
  type PersistentItemDossierStorage,
} from "./persistent-item-dossier.storage.js";
import { isDeepStrictEqual } from "node:util";
import { newId, now } from "../../utils/id-generator.js";

// ---------------------------------------------------------------------------
// Agent-facing row shape
// ---------------------------------------------------------------------------

/**
 * A row as emitted by a producing agent (inventory tracker today; a shop or
 * equipment agent reuses the shape).
 *
 * DELTA CONTRACT:
 *   - `qty` is the pile's post-turn TOTAL, never a delta
 *   - a `uuid` targets that stack; otherwise the row matches canonical name +
 *     owner + type, and mints only when nothing matches
 *   - omitted fields are unchanged; omission never deletes a stack
 *   - `isDestroyed` is valid on any row: the item is emitted where it sits and
 *     the engine deletes it (commodity) or archives it (unique)
 */
export interface DossierAgentRow {
  uuid?: string;
  name: string;
  type?: DossierStack["type"];
  qty?: number;
  isUnique?: boolean;
  isDestroyed?: boolean;
  flair?: string;
  description?: string;
  class?: string;
  rarity?: string;
  /** Omit for the persona's own items. On a `world` row, a non-persona owner means that character carries it. */
  owner?: string;
  isStolen?: boolean;
  isGifted?: boolean;
  equipmentSlot?: string;
  customFields?: Record<string, unknown>;
  /**
   * Engine-internal: set by the inventory adapter on rows derived from
   * `playerStats`. Such rows only seed an empty dossier -- afterwards
   * `playerStats` is a projection, so re-reading it resurrects dropped items.
   */
  seededFromPlayerStats?: boolean;
}

/** Host-supplied context. Never read from model output. */
export interface ItemDossierReconcileContext {
  /** Turn number = count of assistant/narrator messages (see storyboardTurnNumberForMessage). */
  currentTurn?: number | null;
  /** Written by the Character Tracker: its id is a hint, not a stable key, so the chat's own cards win. */
  presentCharacters?: Array<{ characterId?: string | null; name?: string | null }> | null;
  /**
   * The chat's own cards, engine-derived from `chats.characterIds`: the id
   * belongs to the card, not a model's spelling, so they are consulted before
   * `presentCharacters`.
   */
  chatCharacters?: Array<{
    characterId?: string | null;
    name?: string | null;
    /** Reserved: nobody fills this yet, so `resolveOwner`'s alias branch is inert. */
    nameAliases?: string[] | null;
  }> | null;
  /** Current scene location observations, when a tracker/world-maps agent supplied them. */
  currentLocation?: DossierLocationRef | null;
  /** Active persona's display name; falls back to "player". */
  personaName?: string | null;
  /** The active persona's stable id; wins over the name when both sides have one. */
  personaId?: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Canonical key for name matching: trim, lowercase, collapse whitespace. */
function canonicalName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ") : "";
}

/**
 * Bounded plural variants for definition matching -- deliberately not a stemmer,
 * which turns "glass" into "glas". Only the forms the inventory model emits.
 */
function pluralKeyVariants(key: string): string[] {
  const out = new Set<string>([key]);
  if (key.endsWith("ies")) out.add(key.slice(0, -3) + "y");
  if (key.endsWith("es")) out.add(key.slice(0, -2));
  if (key.endsWith("s")) out.add(key.slice(0, -1));
  if (key.endsWith("y")) out.add(key.slice(0, -1) + "ies");
  if (key.endsWith("ch") || key.endsWith("sh") || key.endsWith("x") || key.endsWith("z")) {
    out.add(key + "es");
  }
  out.add(key + "s");
  return [...out];
}

/** Stack override wins; the shared definition is the fallback. */
function resolvedStackName(stack: DossierStack, dossier: PersistentItemDossier): string {
  if (stack.name) return stack.name;
  const definition = dossier.definitions.find((d) => d.id === stack.definitionId);
  return definition?.name ?? "";
}

/** Owner spellings that always mean "the player persona". */
const PLAYER_OWNER_ALIASES = new Set(["player", "user", "you", "persona", "self", "the player"]);

/** The player persona's canonical owner identity. */
function playerIdentity(context: ItemDossierReconcileContext): { name: string; id: string | null } {
  const name = typeof context.personaName === "string" ? context.personaName.trim() : "";
  return { name: name || "player", id: context.personaId ?? null };
}

/**
 * True when a stack belongs to the active persona. Shared with the projection so
 * ownership is decided in one place: an id on both sides wins, since that
 * survives a rename; the name and legacy spellings are the fallback.
 */
export function isPlayerOwnedStack(stack: DossierStack, context: ItemDossierReconcileContext): boolean {
  const player = playerIdentity(context);
  if (player.id !== null && typeof stack.ownerId === "string" && stack.ownerId !== "") {
    return stack.ownerId === player.id;
  }
  const key = canonicalName(stack.owner);
  return key === canonicalName(player.name) || PLAYER_OWNER_ALIASES.has(key);
}

/** A row's owner after canonicalization. */
interface ResolvedOwner {
  /** Canonical display name stored on the stack ("Fel", "Gwenpool", "world"). */
  name: string;
  /** Stable id when the owner resolved to the persona or a present character. */
  id: string | null;
  /** True when the owner is the player persona. */
  isPlayer: boolean;
}

/**
 * A `presentCharacters` id is usable only when ID-SHAPED: a cardless NPC arrives
 * as `{ characterId: "Ethan", name: "Ethan" }`, an echo of the name. Rejecting
 * one costs nothing -- the name still matches, and adoption refreshes the id
 * once a real card appears.
 */
const MIN_CARD_ID_LENGTH = 16;

function isIdShaped(characterId: string | null | undefined, name: string | null | undefined): boolean {
  const idKey = canonicalName(characterId);
  return idKey.length >= MIN_CARD_ID_LENGTH && idKey !== canonicalName(name);
}

/**
 * Canonicalize an agent-supplied owner string:
 *   1. "world"                      -> nobody holds it
 *   2. omitted, or an alias         -> the persona identity
 *   3. the persona, by id then name -> the persona identity
 *   4. a chat character, by id then name, then its card aliases
 *   5. a present character (ids that only echo the name are rejected)
 *   6. anything else                -> the agent's own spelling, with no id
 *
 * Chat characters outrank `presentCharacters` on purpose: the cards are
 * engine-derived, while the tracker writes `presentCharacters` itself and may
 * call Storm "Ororo Munroe".
 */
function resolveOwner(rawOwner: string | undefined, context: ItemDossierReconcileContext): ResolvedOwner {
  const player = playerIdentity(context);
  const key = canonicalName(rawOwner);

  if (key === "world") return { name: "world", id: null, isPlayer: false };
  if (!key || PLAYER_OWNER_ALIASES.has(key)) return { name: player.name, id: player.id, isPlayer: true };
  if (key === canonicalName(player.name) || (player.id !== null && key === canonicalName(player.id))) {
    return { name: player.name, id: player.id, isPlayer: true };
  }

  const cards = context.chatCharacters ?? [];
  const present = context.presentCharacters ?? [];

  const cardById = cards.find((c) => c.characterId && canonicalName(c.characterId) === key);
  if (cardById) {
    return { name: (cardById.name ?? rawOwner ?? "").trim(), id: cardById.characterId ?? null, isPlayer: false };
  }

  const presentById = present.find((p) => isIdShaped(p.characterId, p.name) && canonicalName(p.characterId) === key);
  if (presentById) {
    return {
      name: (presentById.name ?? rawOwner ?? "").trim(),
      id: presentById.characterId ?? null,
      isPlayer: false,
    };
  }

  const cardByName = cards.find((c) => canonicalName(c.name) === key);
  if (cardByName) {
    return { name: (cardByName.name ?? rawOwner ?? "").trim(), id: cardByName.characterId ?? null, isPlayer: false };
  }

  const cardByAlias = cards.find((c) => (c.nameAliases ?? []).some((alias) => canonicalName(alias) === key));
  if (cardByAlias) {
    return {
      name: (cardByAlias.name ?? rawOwner ?? "").trim(),
      id: cardByAlias.characterId ?? null,
      isPlayer: false,
    };
  }

  const presentByName = present.find((p) => isIdShaped(p.characterId, p.name) && canonicalName(p.name) === key);
  if (presentByName) {
    return {
      name: (presentByName.name ?? rawOwner ?? "").trim(),
      id: presentByName.characterId ?? null,
      isPlayer: false,
    };
  }

  // No card anywhere: the name carries the match until a real card appears.
  return { name: (rawOwner ?? "").trim(), id: null, isPlayer: false };
}

/** Adopt the persona's identity for stacks it owns; runs before matching, so a rename keeps its items. */
function adoptPersonaIdentity(dossier: PersistentItemDossier, context: ItemDossierReconcileContext): void {
  const player = playerIdentity(context);
  const nameKey = canonicalName(player.name);
  for (const stack of dossier.stacks) {
    const stackKey = canonicalName(stack.owner);
    const matchesId = player.id !== null && stack.ownerId === player.id;
    if (stackKey !== nameKey && !matchesId && !PLAYER_OWNER_ALIASES.has(stackKey)) continue;
    stack.owner = player.name;
    if (player.id !== null) stack.ownerId = player.id;
  }
}

/** Find the stack a row refers to: exact uuid first, then a SCOPED name match. */
function findStack(
  dossier: PersistentItemDossier,
  row: DossierAgentRow,
  ownerId: string | null,
): DossierStack | undefined {
  if (row.uuid) {
    const byId = dossier.stacks.find((s) => s.id === row.uuid);
    if (byId) return byId;
  }
  // Scoped to the same owner and type, so a hallucinated uuid on a carried potion
  // cannot grab the bedroom pile.
  const key = canonicalName(row.name);
  const ownerKey = canonicalName(row.owner);
  const type = row.type ?? "inventory";
  const scoped = (s: DossierStack) =>
    canonicalName(resolvedStackName(s, dossier)) === key &&
    s.type === type &&
    ((ownerId !== null && s.ownerId === ownerId) || canonicalName(s.owner) === ownerKey);

  // A stated flair identifies ONE instance, so two "potion" piles (one poisoned)
  // stop collapsing onto the first. Rows with no flair fall through to the
  // name-only match.
  const flairKey = canonicalName(row.flair ?? "");
  if (flairKey) {
    const byFlair = dossier.stacks.find((s) => scoped(s) && canonicalName(s.flair ?? "") === flairKey);
    if (byFlair) return byFlair;
  }
  return dossier.stacks.find(scoped);
}

/** Find the definition a row's name belongs to, with a bounded plural allowance. */
function findDefinition(dossier: PersistentItemDossier, row: DossierAgentRow): DossierDefinition | undefined {
  const variants = new Set(pluralKeyVariants(canonicalName(row.name)));
  return dossier.definitions.find((d) => variants.has(canonicalName(d.name)));
}

/**
 * Mint a definition. `isNamedArtifact` is set only here, and only for a row with
 * no uuid and `isUnique: true`: an update can never mint a definition, so a
 * rename never creates a new template.
 */
function mintDefinition(dossier: PersistentItemDossier, row: DossierAgentRow): DossierDefinition {
  const ts = now();
  const definition: DossierDefinition = {
    id: newId(),
    name: canonicalName(row.name),
    displayName: row.name,
    class: row.class ?? null,
    rarity: row.rarity ?? null,
    description: row.description ?? null,
    isNamedArtifact: row.uuid === undefined && row.isUnique === true,
    aliases: [],
    createdAt: ts,
    updatedAt: ts,
  };
  dossier.definitions.push(definition);
  return definition;
}

/** Carried groups become `on_person`; `world` rows take the scene's observations. */
function stampLocation(
  target: DossierLocationRef,
  row: DossierAgentRow,
  context: ItemDossierReconcileContext,
): DossierLocationRef {
  const type = row.type ?? "inventory";
  if (type !== "world") return { ...target, on_person: true };
  const next: DossierLocationRef = { ...target, on_person: false };
  const incoming = context.currentLocation;
  const at = context.currentTurn ?? 0;
  if (incoming?.map) next.map = { ...incoming.map, at };
  if (incoming?.world) next.world = { ...incoming.world, at };
  return next;
}

/** Mint a fresh stack for a definition. Definition metadata is the template's. */
function mintStack(
  definition: DossierDefinition,
  row: DossierAgentRow,
  context: ItemDossierReconcileContext,
  owner: ResolvedOwner,
): DossierStack {
  const ts = now();
  const isUnique = row.isUnique === true || definition.isNamedArtifact;
  const rowKey = canonicalName(row.name);
  const definitionKey = canonicalName(definition.name);
  return {
    id: newId(),
    definitionId: definition.id,
    name: rowKey !== definitionKey ? rowKey : null,
    displayName: rowKey !== definitionKey ? row.name : null,
    type: row.type ?? "inventory",
    owner: owner.name,
    ownerId: owner.id,
    lastOwners: [],
    locationRef: stampLocation({}, row, context),
    qty: isUnique ? 1 : Math.max(1, Math.floor(row.qty ?? 1)),
    flair: row.flair ?? null,
    isUnique,
    isDestroyed: row.isDestroyed === true,
    isStolen: row.isStolen === true,
    isGifted: row.isGifted === true,
    isStored: false, // not yet settable; see DossierStack.isStored
    lastSeenTurn: context.currentTurn ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Fields a row can actually move, compared to decide whether `updatedAt`
 * advances. `updatedAt`, `lastSeenTurn` and `lastOwners` are omitted on purpose:
 * they track the turn, not the item.
 */
function stackContentFields(stack: DossierStack): Record<string, unknown> {
  return {
    owner: stack.owner,
    ownerId: stack.ownerId,
    name: stack.name,
    displayName: stack.displayName,
    type: stack.type,
    qty: stack.qty,
    flair: stack.flair,
    description: stack.description,
    class: stack.class,
    rarity: stack.rarity,
    equipmentSlot: stack.equipmentSlot,
    isUnique: stack.isUnique,
    isDestroyed: stack.isDestroyed,
    isStolen: stack.isStolen ?? false,
    isGifted: stack.isGifted ?? false,
    customFields: stack.customFields ?? null,
    locationRef: stack.locationRef ?? null,
  };
}

/** Apply a row to an existing stack. Omitted fields stay unchanged. */
function applyRowUpdate(
  dossier: PersistentItemDossier,
  stack: DossierStack,
  row: DossierAgentRow,
  context: ItemDossierReconcileContext,
  owner: ResolvedOwner,
): void {
  const ts = now();
  // Captured before mutating, so `updatedAt` only advances on a real change.
  const contentBefore = stackContentFields(stack);

  // Owner change -> provenance. Only uniques keep a history worth reading.
  if (canonicalName(owner.name) !== canonicalName(stack.owner)) {
    if (stack.isUnique) {
      stack.lastOwners ??= [];
      const event: DossierOwnerEvent = {
        owner: stack.owner,
        at: context.currentTurn ?? 0,
        reason: "transferred",
      };
      stack.lastOwners.unshift(event);
      stack.lastOwners = stack.lastOwners.slice(0, 5);
    }
    stack.owner = owner.name;
    stack.ownerId = owner.id;
  } else if (owner.id !== null) {
    // Same holder, freshly resolved id (a name-only match converging on the id).
    stack.ownerId = owner.id;
  }

  // A name differing from the definition is a STACK OVERRIDE, never a new
  // definition.
  const definition = dossier.definitions.find((d) => d.id === stack.definitionId);
  const rowKey = canonicalName(row.name);
  if (rowKey && rowKey !== canonicalName(definition?.name)) {
    stack.name = rowKey;
    stack.displayName = row.name;
  }

  if (row.type !== undefined) stack.type = row.type;
  if (row.qty !== undefined) {
    // Post-turn TOTAL, never a delta. Uniques clamp to 1 and need isDestroyed.
    stack.qty = stack.isUnique ? 1 : Math.max(0, Math.floor(row.qty));
  }
  if (row.flair !== undefined) stack.flair = row.flair || null;
  if (row.description !== undefined) stack.description = row.description;
  if (row.class !== undefined) stack.class = row.class;
  if (row.rarity !== undefined) stack.rarity = row.rarity;
  if (row.equipmentSlot !== undefined) stack.equipmentSlot = row.equipmentSlot;
  if (row.isUnique !== undefined) {
    stack.isUnique = row.isUnique;
    if (row.isUnique) stack.qty = 1;
  }
  if (row.isDestroyed === true) stack.isDestroyed = true;
  if (row.isStolen !== undefined) stack.isStolen = row.isStolen;
  if (row.isGifted !== undefined) stack.isGifted = row.isGifted;
  if (row.customFields !== undefined) {
    stack.customFields = { ...(stack.customFields ?? {}), ...row.customFields };
  }

  stack.locationRef = stampLocation(stack.locationRef ?? {}, row, context);
  if (context.currentTurn != null) stack.lastSeenTurn = context.currentTurn;
  if (!isDeepStrictEqual(contentBefore, stackContentFields(stack))) {
    stack.updatedAt = ts;
  }
}

/**
 * Merge identity for a stack's location: `on_person`, else the World Maps id,
 * else the World State name. `at` is excluded -- it moves every turn, so a pile
 * would split the moment a turn passed.
 */
function stackLocationKey(stack: DossierStack): string {
  const ref = stack.locationRef ?? {};
  if (ref.on_person) return "on_person";
  if (ref.map?.id) return `map:${ref.map.id}`;
  const worldName = canonicalName(ref.world?.name ?? "");
  return worldName ? `world:${worldName}` : "";
}

/**
 * Collapse duplicates the model split by accident. Definition, owner, type,
 * flair and LOCATION must all match and neither side may be unique: 10 arrows on
 * you and 200 in your room are two piles, and summing them invents 210 on you.
 */
function mergeDuplicateStacks(dossier: PersistentItemDossier): void {
  const kept: DossierStack[] = [];
  for (const stack of dossier.stacks) {
    if (stack.isUnique) {
      kept.push(stack);
      continue;
    }
    const locationKey = stackLocationKey(stack);
    const twin = kept.find(
      (k) =>
        !k.isUnique &&
        k.definitionId === stack.definitionId &&
        canonicalName(k.owner) === canonicalName(stack.owner) &&
        k.type === stack.type &&
        canonicalName(k.flair ?? "") === canonicalName(stack.flair ?? "") &&
        stackLocationKey(k) === locationKey,
    );
    if (twin) {
      // The true total was split by a bug, so reconstruct it.
      twin.qty += stack.qty;
      twin.updatedAt = stack.updatedAt;
      if ((stack.lastSeenTurn ?? 0) > (twin.lastSeenTurn ?? 0)) {
        twin.lastSeenTurn = stack.lastSeenTurn;
      }
      continue;
    }
    kept.push(stack);
  }
  dossier.stacks = kept;
}

/**
 * A destroyed commodity is deleted outright; a destroyed unique is kept at
 * `qty: 0`, because the shattering of *that* sword is a story fact. `qty: 0` on
 * a commodity also counts as emptied, for a model that forgets the flag.
 */
function deleteDestroyedCommodities(dossier: PersistentItemDossier): void {
  dossier.stacks = dossier.stacks.filter((stack) => {
    if (stack.isUnique) {
      if (stack.isDestroyed) stack.qty = 0;
      return true;
    }
    if (stack.isDestroyed) return false;
    if (stack.qty <= 0) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reconcile one agent's rows against the per-chat dossier: exact `uuid` match,
 * else canonical name + owner + type, else mint definition + stack. Host-owned
 * fields (id, definitionId, locationRef, createdAt, lastSeenTurn, ownerId,
 * lastOwners) never come from model output.
 */
export async function reconcileItemDossier(
  storage: PersistentItemDossierStorage,
  chatId: string,
  rows: DossierAgentRow[],
  context: ItemDossierReconcileContext = {},
  /** `null` starts empty; `undefined` keeps the live row (chats with no snapshot history). */
  base?: PersistentItemDossier | null,
): Promise<PersistentItemDossier> {
  const loaded = base !== undefined ? base : await storage.getForChat(chatId);
  const dossier: PersistentItemDossier = loaded ?? {
    schemaVersion: 2,
    definitions: [],
    stacks: [],
  };
  // Seed rows only matter while the dossier is empty; afterwards `playerStats`
  // is a projection, so re-applying would resurrect moved or dropped items.
  const isFirstRun = dossier.definitions.length === 0 && dossier.stacks.length === 0;

  adoptPersonaIdentity(dossier, context);

  for (const raw of rows) {
    if (!canonicalName(raw.name)) continue;
    if (raw.seededFromPlayerStats && !isFirstRun) continue;

    const owner = resolveOwner(raw.owner, context);
    const row: DossierAgentRow = { ...raw, owner: owner.name };
    // A `world` row owned by someone other than the persona means that person is
    // HOLDING it, not that it lies on the floor, so it travels with them.
    if (row.type === "world" && !owner.isPlayer && canonicalName(owner.name) !== "world") {
      row.type = "inventory";
    }

    const existing = findStack(dossier, row, owner.id);
    if (existing) {
      applyRowUpdate(dossier, existing, row, context, owner);
      continue;
    }

    const matchedDefinition = findDefinition(dossier, row);
    const definition = matchedDefinition ?? mintDefinition(dossier, row);
    const stack = mintStack(definition, row, context, owner);
    if (matchedDefinition) {
      // A matched definition is shared vocabulary: the row's metadata is an
      // instance claim, a stack override, not a rewrite of the template.
      if (row.class !== undefined && row.class !== matchedDefinition.class) stack.class = row.class;
      if (row.rarity !== undefined && row.rarity !== matchedDefinition.rarity) stack.rarity = row.rarity;
      if (row.description !== undefined && row.description !== matchedDefinition.description) {
        stack.description = row.description;
      }
    }
    dossier.stacks.push(stack);
  }

  mergeDuplicateStacks(dossier);
  deleteDestroyedCommodities(dossier);

  await storage.saveForChat(chatId, dossier);
  return dossier;
}

// ---------------------------------------------------------------------------
// Inventory-tracker adapter
// ---------------------------------------------------------------------------

const INVENTORY_TRACKER_GROUP_TYPES: Record<string, DossierStack["type"]> = {
  currencies: "currency",
  equipped: "equipped",
  inventory: "inventory",
  world: "world",
};

export const INVENTORY_TRACKER_STATS_FIELDS: Record<
  "currency" | "equipped" | "inventory",
  "inventoryTrackerCurrencies" | "inventoryTrackerEquipped" | "inventoryTrackerInventory"
> = {
  currency: "inventoryTrackerCurrencies",
  equipped: "inventoryTrackerEquipped",
  inventory: "inventoryTrackerInventory",
};

/** Empty strings are treated as absent so a blank field never overwrites a real one. */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * De-dup key for adapter rows: the same name held by different characters, or
 * in different condition, must survive as two stacks.
 */
function dossierRowKey(type: string, name: string, owner: string | undefined, flair: string | undefined): string {
  return `${type}:${canonicalName(owner)}:${canonicalName(name)}:${canonicalName(flair)}`;
}

/**
 * Seed rows from an existing `playerStats`, used once when a chat gains a
 * dossier it never had. Marked so the reconciler ignores them afterwards:
 * `playerStats` becomes a projection, so re-reading it would resurrect items
 * the agent has since moved or dropped.
 */
export function buildSeedRowsFromPlayerStats(
  mergedPlayerStats: Record<string, unknown> | null | undefined,
): DossierAgentRow[] {
  const rows: DossierAgentRow[] = [];
  for (const type of ["currency", "equipped", "inventory"] as const) {
    const group = mergedPlayerStats?.[INVENTORY_TRACKER_STATS_FIELDS[type]];
    if (!Array.isArray(group)) continue;
    for (const raw of group) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const name = readOptionalString(row.name);
      if (!name) continue;
      rows.push({
        name,
        type,
        qty: typeof row.qty === "number" ? row.qty : undefined,
        seededFromPlayerStats: true,
      });
    }
  }
  return rows;
}

/**
 * Adapter: the inventory tracker's shape -> shared dossier rows. `rawData` is
 * the agent's own JSON BEFORE normalization, so its rich fields survive;
 * `mergedPlayerStats` contributes seed rows only, for items no agent row already
 * describes. The `world` bucket is delta-only and never carried forward.
 */
export function buildDossierRowsFromInventoryTracker({
  rawData,
  mergedPlayerStats,
}: {
  rawData: Record<string, unknown> | null | undefined;
  mergedPlayerStats: Record<string, unknown> | null | undefined;
}): DossierAgentRow[] {
  const rows = new Map<string, DossierAgentRow>();

  // Agent rows: the only source of live changes.
  for (const [field, type] of Object.entries(INVENTORY_TRACKER_GROUP_TYPES)) {
    const group = rawData?.[field];
    if (!Array.isArray(group)) continue;
    for (const raw of group) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const name = readOptionalString(row.name);
      if (!name) continue;
      const owner = readOptionalString(row.owner);
      const flair = readOptionalString(row.flair);
      rows.set(dossierRowKey(type, name, owner, flair), {
        uuid: readOptionalString(row.uuid),
        name,
        type,
        qty: typeof row.qty === "number" ? row.qty : undefined,
        isUnique: typeof row.isUnique === "boolean" ? row.isUnique : undefined,
        isDestroyed: row.isDestroyed === true ? true : undefined,
        flair,
        description: readOptionalString(row.description),
        class: readOptionalString(row.class),
        rarity: readOptionalString(row.rarity),
        owner,
        isStolen: typeof row.isStolen === "boolean" ? row.isStolen : undefined,
        isGifted: typeof row.isGifted === "boolean" ? row.isGifted : undefined,
        equipmentSlot: readOptionalString(row.equipmentSlot),
        customFields:
          row.customFields && typeof row.customFields === "object" && !Array.isArray(row.customFields)
            ? (row.customFields as Record<string, unknown>)
            : undefined,
      });
    }
  }

  // Seed rows fill in only what no agent row already covers.
  for (const seed of buildSeedRowsFromPlayerStats(mergedPlayerStats)) {
    const key = dossierRowKey(seed.type ?? "inventory", seed.name, seed.owner, seed.flair);
    if (!rows.has(key)) rows.set(key, seed);
  }

  return [...rows.values()];
}
