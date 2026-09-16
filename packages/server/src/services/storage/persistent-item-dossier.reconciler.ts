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
  /**
   * Engine-internal: set by the inventory adapter for an entry in a group's
   * `removed` list. Match-only -- an unmatched removal is dropped, never minted.
   */
  removal?: boolean;
  flair?: string;
  /**
   * Content override. `null` drops it so the shared definition shows again; an
   * empty string keeps an empty override so the definition stays suppressed;
   * omitting the field changes nothing.
   */
  description?: string | null;
  class?: string | null;
  rarity?: string | null;
  /** Free-text descriptor from the agent's `location`; stored as `DossierStack.locationText`. */
  location?: string;
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

/**
 * Canonical key for name matching: trim, lowercase, collapse whitespace.
 * Exported for the editor adapter's move rule, which must compare the same keys
 * the matcher does instead of keeping a second, drifting copy.
 */
export function canonicalName(value: unknown): string {
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
 *   2. omitted, or an alias         -> the persona identity, EXCEPT on a world
 *      row, where omitted means DISCARDED and resolves to "world": dropping
 *      something should not keep it owned by the player forever
 *   3. the persona, by id then name -> the persona identity
 *   4. a chat character, by id then name, then its card aliases
 *   5. a present character (ids that only echo the name are rejected)
 *   6. anything else                -> the agent's own spelling, with no id
 *
 * Chat characters outrank `presentCharacters` on purpose: the cards are
 * engine-derived, while the tracker writes `presentCharacters` itself and may
 * call Storm "Ororo Munroe".
 */
function resolveOwner(
  rawOwner: string | undefined,
  context: ItemDossierReconcileContext,
  statedType?: string | null,
): ResolvedOwner {
  const player = playerIdentity(context);
  const key = canonicalName(rawOwner);

  if (key === "world") return { name: "world", id: null, isPlayer: false };
  if (!key) {
    // An omitted owner is the persona, but a world row with no owner is an
    // ABANDONED item, not a carried one. Explicit aliases below still mean
    // the player everywhere.
    if (statedType === "world") return { name: "world", id: null, isPlayer: false };
    return { name: player.name, id: player.id, isPlayer: true };
  }
  if (PLAYER_OWNER_ALIASES.has(key)) return { name: player.name, id: player.id, isPlayer: true };
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

  // Small models write "None" for "nobody holds it". It resolves to the world
  // sentinel only after every real name tier above had its chance, so a card,
  // alias or present character genuinely called None still wins.
  if (key === "none") return { name: "world", id: null, isPlayer: false };

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
  // Destroyed stacks are invisible to name matching: re-creating a destroyed
  // item must mint a fresh pile, not resurrect the corpse's provenance. A cited
  // uuid still matches above on purpose -- that is a deliberate resurrection.
  const scoped = (s: DossierStack) =>
    !s.isDestroyed &&
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

/**
 * Match-only destroy for a `removed` entry: uuid first, then the scoped name
 * tiers. Destroyed stacks are never re-matched, and an unmatched entry is
 * dropped silently -- a removal must never mint.
 */
function destroyRemovedStack(dossier: PersistentItemDossier, row: DossierAgentRow, ownerId: string | null): void {
  let target: DossierStack | undefined;
  if (row.uuid) target = dossier.stacks.find((s) => s.id === row.uuid && !s.isDestroyed);
  if (!target && canonicalName(row.name)) target = findStack(dossier, row, ownerId);
  if (target && !target.isDestroyed) {
    target.isDestroyed = true;
    target.updatedAt = now();
  }
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
    locationText: row.location ?? null,
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
    locationText: stack.locationText,
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
  if (row.location !== undefined) stack.locationText = row.location || null;
  if (row.description !== undefined) stack.description = row.description;
  if (row.class !== undefined) stack.class = row.class;
  if (row.rarity !== undefined) stack.rarity = row.rarity;
  if (row.equipmentSlot !== undefined) stack.equipmentSlot = row.equipmentSlot;
  if (row.isUnique !== undefined) {
    stack.isUnique = row.isUnique;
    if (row.isUnique) stack.qty = 1;
  }
  if (row.isDestroyed === true) {
    stack.isDestroyed = true;
  } else if (stack.isDestroyed) {
    // Only a uuid match can reach a destroyed stack (name tiers skip them), so
    // an update landing here is an explicit re-creation: revive the pile.
    stack.isDestroyed = false;
    if (stack.qty <= 0) stack.qty = 1;
  }
  if (row.isStolen !== undefined) stack.isStolen = row.isStolen;
  if (row.isGifted !== undefined) stack.isGifted = row.isGifted;
  if (row.customFields !== undefined) {
    stack.customFields = { ...(stack.customFields ?? {}), ...row.customFields };
  }

  stack.locationRef = stampLocation(stack.locationRef ?? {}, row, context);
  if (context.currentTurn != null) stack.lastSeenTurn = context.currentTurn;
  promoteToDefinition(dossier, stack);
  if (!isDeepStrictEqual(contentBefore, stackContentFields(stack))) {
    stack.updatedAt = ts;
  }
}

/**
 * Promote-while-null: the first value a stack writes into a definition-backed
 * field becomes the type's default, so a rushed first creation fills itself in
 * organically instead of staying bare forever (and every later stack of that
 * type inherits the wording).
 *
 * Only `null` is promotable -- a value someone already decided is out of reach,
 * so a curated definition can never be clobbered and first-writer-wins stays
 * deterministic. The promotable set is exactly the trio with a definition
 * counterpart: `description`, `class`, `rarity`. `name` is identity, not a
 * field (a definition is minted FROM a row, so it always arrives named), and the
 * instance-only fields (`flair`, `location`, `equipmentSlot`, `isStolen`,
 * `isGifted`) are flavour about THIS pile -- promoting one would make an
 * afternoon in the rain the world's default. `isNamedArtifact` stays mint-only.
 *
 * An empty string is a deliberate "present but empty override" that suppresses
 * the definition for this stack, so it is never promoted: doing so would blank
 * the whole item type. It stays an override.
 *
 * Ride-along: a stack whose value now equals the definition's drops its own
 * override, so promotion cannot leave a redundant copy behind -- and a value
 * typed in that merely matches the type reads the same either way.
 */
function promoteToDefinition(dossier: PersistentItemDossier, stack: DossierStack): void {
  const definition = dossier.definitions.find((d) => d.id === stack.definitionId);
  if (!definition) return;
  for (const field of ["description", "class", "rarity"] as const) {
    const value = stack[field];
    if (value === undefined || value === null || value === "") continue;
    if (definition[field] === null || definition[field] === undefined) {
      definition[field] = value;
      definition.updatedAt = now();
    }
    if (definition[field] === value) stack[field] = null;
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

/**
 * A uuid cited into a DIFFERENT group with a strictly smaller qty is a partial
 * move: take that much off the source and mint it in the target group. Each
 * exclusion protects an ordinary case -- a smaller qty in the pile's own group
 * is a plain total (drinking one of three potions), a qty at or above the pile
 * moves it whole (full take, gift, equip), and a qty-less row is an equip that
 * must stay one action. Uniques never split: a one-of-a-kind is a whole thing.
 *
 * `statedType` is the group the agent WROTE the row in, which for a hand-off is
 * not what the row ends up carried as. Without it a partial gift would read as a
 * same-group total and shrink the giver's pile.
 */
function isPartialMove(
  stack: DossierStack,
  row: DossierAgentRow,
  statedType: DossierStack["type"] | undefined,
): boolean {
  if (!row.uuid || row.qty === undefined || !Number.isFinite(row.qty)) return false;
  if (row.isDestroyed === true) return false;
  if (statedType === undefined || statedType === stack.type) return false;
  if (stack.isUnique || stack.isDestroyed) return false;
  const taken = Math.floor(row.qty);
  return taken >= 1 && taken < stack.qty;
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
  // is a projection, so re-applying would resurrect moved or dropped items. The
  // caller also withholds them on a rewind, where an empty base is a branch, not
  // a chat that never had a dossier.
  const isFirstRun = dossier.definitions.length === 0 && dossier.stacks.length === 0;

  adoptPersonaIdentity(dossier, context);

  // How often each uuid is stated this turn. More than once means the agent
  // wrote the source's own new total as well, so a split must not subtract from
  // it a second time.
  const qtyStatements = new Map<string, number>();
  for (const raw of rows) {
    if (!raw.uuid || raw.qty === undefined || raw.removal) continue;
    qtyStatements.set(raw.uuid, (qtyStatements.get(raw.uuid) ?? 0) + 1);
  }

  for (const raw of rows) {
    if (raw.seededFromPlayerStats && !isFirstRun) continue;
    // Removals are match-only and never mint, so they run before the name gate:
    // a `removed` entry may carry only a uuid.
    //
    // Every way something dies lands on the same flag: an explicit
    // `isDestroyed: true` row, a qty of 0 on an existing stack, or a `removed`
    // entry (agent envelope or editor save) turned into a removal row here.
    // The post-reconcile sweep then physically deletes a destroyed commodity
    // and archives a destroyed unique at qty 0.
    if (raw.removal) {
      destroyRemovedStack(dossier, raw, resolveOwner(raw.owner, context).id);
      continue;
    }
    // A uuid-only row (a partial move, per the prompt's chest example) is legal:
    // findStack resolves it by id, so it must not die at the name gate.
    if (!canonicalName(raw.name) && !raw.uuid) continue;

    const owner = resolveOwner(raw.owner, context, raw.type);
    const row: DossierAgentRow = { ...raw, owner: owner.name };
    // The group the agent WROTE it in, captured before the hand-off flip below.
    // The partial-move test needs that intent, not the group the item is
    // carried in afterwards.
    const statedType = row.type;
    // A `world` row owned by someone other than the persona means that person is
    // HOLDING it, not that it lies on the floor, so it travels with them.
    if (row.type === "world" && !owner.isPlayer && canonicalName(owner.name) !== "world") {
      row.type = "inventory";
    }

    const existing = findStack(dossier, row, owner.id);
    if (existing) {
      if (isPartialMove(existing, row, statedType)) {
        const taken = Math.max(1, Math.floor(row.qty as number));
        // The split-off pile is a NEW pile: fresh identity, no inherited
        // provenance, and no inherited descriptor. applyRowUpdate fills it from
        // the row, owner and location included.
        const split: DossierStack = {
          ...structuredClone(existing),
          id: newId(),
          lastOwners: [],
          locationRef: {},
          locationText: null,
          createdAt: now(),
          updatedAt: now(),
        };
        applyRowUpdate(dossier, split, row, context, owner);
        dossier.stacks.push(split);
        // The source keeps its own total when the agent already stated it.
        if ((qtyStatements.get(existing.id) ?? 0) < 2) {
          existing.qty = Math.max(1, existing.qty - taken);
          existing.updatedAt = now();
        }
        if (context.currentTurn != null) existing.lastSeenTurn = context.currentTurn;
        continue;
      }
      applyRowUpdate(dossier, existing, row, context, owner);
      continue;
    }

    // A qty of 0 destroys an EXISTING stack, but it is not a total: an
    // unmatched row would mint a fresh pile (at qty 1, per the floor below),
    // resurrecting an item the agent just killed from out of context. Deletion
    // goes through `removed`, never through minting.
    if (row.qty !== undefined && row.qty <= 0) continue;

    const matchedDefinition = findDefinition(dossier, row);
    const definition = matchedDefinition ?? mintDefinition(dossier, row);
    const stack = mintStack(definition, row, context, owner);
    if (matchedDefinition) {
      // A matched definition is shared vocabulary: the row's metadata is an
      // instance claim, a stack override -- not a rewrite of the template. The
      // exception is a template that never had a value: promoting below lets the
      // first row that states one fill it in (and drop its own override).
      if (row.class !== undefined && row.class !== matchedDefinition.class) stack.class = row.class;
      if (row.rarity !== undefined && row.rarity !== matchedDefinition.rarity) stack.rarity = row.rarity;
      if (row.description !== undefined && row.description !== matchedDefinition.description) {
        stack.description = row.description;
      }
    }
    dossier.stacks.push(stack);
    promoteToDefinition(dossier, stack);
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
 * the agent has since moved or dropped. Reads only the legacy row vocabulary
 * (name, qty, description, location): a seed is allowed only while no dossier
 * exists, which means the projection has never written this state, so richer
 * fields cannot be present to read.
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
        description: readOptionalString(row.description),
        location: readOptionalString(row.location),
        seededFromPlayerStats: true,
      });
    }
  }
  return rows;
}

/**
 * A group is either a legacy full array or the incremental envelope the host
 * advertises via `tracker_incremental_updates: supported`. Envelope rows are the
 * same shape; `removed` is consumed by the adapter's removal pass below.
 */
function readGroupRows(group: unknown): Record<string, unknown>[] {
  if (Array.isArray(group)) return group as Record<string, unknown>[];
  if (group && typeof group === "object" && !Array.isArray(group)) {
    const updates = (group as { updates?: unknown }).updates;
    if (Array.isArray(updates)) return updates as Record<string, unknown>[];
  }
  return [];
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
    for (const raw of readGroupRows(rawData?.[field])) {
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
        location: readOptionalString(row.location),
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

  // `removed` entries become match-only removal rows, appended after every
  // group's update rows. A removal whose identity was ALSO updated this turn
  // is a move (the default prompt removes on move), not a deletion.
  const updatedUuids = new Set<string>();
  const updatedNames = new Set<string>();
  for (const row of rows.values()) {
    if (row.uuid) updatedUuids.add(row.uuid);
    updatedNames.add(canonicalName(row.name));
  }
  for (const [field, type] of Object.entries(INVENTORY_TRACKER_GROUP_TYPES)) {
    if (field === "world") continue; // world is a full snapshot; nothing deletes through it
    const group = rawData?.[field];
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const removed = (group as { removed?: unknown }).removed;
    if (!Array.isArray(removed)) continue;
    for (const entry of removed) {
      // A bare string is a uuid when the agent has one and a name otherwise, and
      // this pass cannot tell the two apart: the dossier is not in scope here.
      // Carry it as BOTH so each tier gets its shot downstream -- the uuid tier,
      // the scoped name tiers, and the move-guard. The uuid field is only ever
      // compared against stack ids, so a name sitting there is inert.
      const reference =
        typeof entry === "string"
          ? { uuid: entry, name: entry }
          : entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)
            : undefined;
      if (!reference) continue;
      const removedUuid = readOptionalString(reference.uuid);
      const removedName = readOptionalString(reference.name);
      if (!removedUuid && !removedName) continue;
      if ((removedUuid && updatedUuids.has(removedUuid)) || updatedNames.has(canonicalName(removedName))) {
        continue;
      }
      rows.set(`removed:${field}:${removedUuid ?? canonicalName(removedName)}`, {
        uuid: removedUuid,
        name: removedName ?? "",
        type,
        removal: true,
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
