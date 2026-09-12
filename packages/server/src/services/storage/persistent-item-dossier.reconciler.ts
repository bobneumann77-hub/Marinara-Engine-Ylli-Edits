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
import { newId, now } from "../../utils/id-generator.js";

// ---------------------------------------------------------------------------
// Agent-facing row shape
// ---------------------------------------------------------------------------

/**
 * A single row as emitted by a producing agent (inventory tracker today; a
 * future shop / equipment / relationship agent reuses the same shape).
 *
 * DELTA CONTRACT:
 *   - EVERY row SETS: `qty` is the pile's post-turn TOTAL, never a delta
 *   - a row with a `uuid` targets that stack; a row without one matches by
 *     canonical name + same owner + same type, and mints only when nothing matches
 *   - omitted fields are left unchanged; omission never deletes a stack
 *   - `isDestroyed` is valid on ANY row. The item is emitted wherever it
 *     currently sits; the engine then deletes it (commodity) or archives it
 *     (unique). There is no separate "destroyed" row.
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
  /**
   * Who holds it. Omit for the persona's own items (the engine fills in the
   * persona), or name whoever receives it. On a `world` row, an owner other
   * than the persona means that character is carrying it, not the floor.
   */
  owner?: string;
  isStolen?: boolean;
  isGifted?: boolean;
  equipmentSlot?: string;
  customFields?: Record<string, unknown>;
  /**
   * Engine-internal. Set by the inventory adapter on rows derived from an
   * existing `playerStats` array instead of this turn's agent output. Such rows
   * only seed a dossier that has no stacks yet; afterwards `playerStats` is a
   * projection of the dossier, so re-reading it would resurrect items the agent
   * has since moved or dropped. Agents never set this field.
   */
  seededFromPlayerStats?: boolean;
}

/** Host-supplied context. Never read from model output. */
export interface ItemDossierReconcileContext {
  /** Turn number = count of assistant/narrator messages (see storyboardTurnNumberForMessage). */
  currentTurn?: number | null;
  /**
   * Current `presentCharacters`. Written by the Character Tracker agent, whose
   * own schema says `"characterId": "string - ID or name"`, so its id is a hint
   * rather than a stable key. Consulted after the chat's own cards below.
   */
  presentCharacters?: Array<{ characterId?: string | null; name?: string | null }> | null;
  /**
   * The chat's own character cards, engine-derived from `chats.characterIds`.
   * The most stable identity source available: the id belongs to the card, not
   * to a small model's spelling, so it is consulted BEFORE `presentCharacters`.
   */
  chatCharacters?: Array<{
    characterId?: string | null;
    name?: string | null;
    /**
     * Reserved: the card's `extensions.nameAliases`. No caller populates this
     * yet, so the alias branch in `resolveOwner` is inert -- the opening only.
     * Filling it is what lets "Ororo" resolve to Storm's card.
     */
    nameAliases?: string[] | null;
  }> | null;
  /** Current scene location observations, when a tracker/world-maps agent supplied them. */
  currentLocation?: DossierLocationRef | null;
  /**
   * The active persona's display name. Player-owned stacks are keyed on it, so
   * changing personas scopes carried items correctly. Falls back to "player".
   */
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
 * Bounded singular/plural variants for definition matching. Deliberately NOT a
 * stemmer: a real stemmer turns "glass" -> "glas" and corrupts the definition
 * table. Only the handful of English forms the inventory model actually emits.
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
 * True when a stack belongs to the active persona.
 *
 * Shared with the projection so ownership is decided in exactly one place. An
 * id on both sides wins, because that is what survives a persona rename; the
 * name (and the legacy spellings) is the fallback that lets a recreated persona
 * reclaim what it used to own, and what keeps un-migrated "player" stacks legible.
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
 * A `presentCharacters` id is usable only when it is ID-SHAPED. The Character
 * Tracker's own schema says `"characterId": "string - ID or name"`, so a
 * cardless NPC arrives as `{ characterId: "Ethan", name: "Ethan" }` -- an echo
 * of the name, not a key -- and a hallucinated short token can slip in too.
 * Real card ids are long opaque strings, so accept a value only when it differs
 * from the name and clears this floor. A rejected id costs nothing: the name
 * still matches, and adoption refreshes the id once a real card appears.
 */
const MIN_CARD_ID_LENGTH = 16;

function isIdShaped(characterId: string | null | undefined, name: string | null | undefined): boolean {
  const idKey = canonicalName(characterId);
  return idKey.length >= MIN_CARD_ID_LENGTH && idKey !== canonicalName(name);
}

/**
 * Canonicalize an agent-supplied owner string.
 *   1. "world"                     -> the world itself; nobody holds it
 *   2. omitted, or an alias        -> the persona identity
 *   3. the persona, id then name   -> the persona identity
 *   4. a chat character, id then name, then its card aliases
 *   5. a present character, id then name (ids that only echo the name rejected)
 *   6. anything else               -> the agent's own spelling, with no id
 *
 * Chat characters outrank `presentCharacters` on purpose. The cards are
 * engine-derived from the chat config, while the tracker agent writes the
 * `presentCharacters` array itself and may call "Storm" by the name "Ororo
 * Munroe". Stability wins, and the name fallback below still rescues a holder
 * with no card at all. Id wins when both sides have one, so renaming a persona
 * or a character keeps their stacks attached; the name is the fallback that
 * lets a recreated persona with the same name adopt what it used to own.
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

  // Opening only: nothing fills `nameAliases` yet, so this branch is inert until
  // a caller does. Once it is filled, "Ororo" resolves to Storm's card.
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

  // No card anywhere: the name carries the match, and the id stays null until a
  // real card appears for that name (adoption refreshes it then).
  return { name: (rawOwner ?? "").trim(), id: null, isPlayer: false };
}

/**
 * Adopt the current persona's identity for stacks it already owns.
 *
 * Runs before rows are matched, so renaming a persona keeps its items, and so a
 * persona recreated under the same name reclaims the stacks an older id left
 * behind. Legacy "player" spellings migrate here too.
 */
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
  // The fallback is scoped to the SAME owner and type, so a hallucinated uuid on
  // a carried potion can never grab the bedroom pile. The owner matches on the
  // stable id when both sides have one, and on the canonical name otherwise --
  // which is what lets a recreated persona reclaim its stacks.
  const key = canonicalName(row.name);
  const ownerKey = canonicalName(row.owner);
  const type = row.type ?? "inventory";
  return dossier.stacks.find(
    (s) =>
      canonicalName(resolvedStackName(s, dossier)) === key &&
      s.type === type &&
      ((ownerId !== null && s.ownerId === ownerId) || canonicalName(s.owner) === ownerKey),
  );
}

/** Find the definition a row's name belongs to, with a bounded plural allowance. */
function findDefinition(dossier: PersistentItemDossier, row: DossierAgentRow): DossierDefinition | undefined {
  const variants = new Set(pluralKeyVariants(canonicalName(row.name)));
  return dossier.definitions.find((d) => variants.has(canonicalName(d.name)));
}

/**
 * Mint a definition from a row. `isNamedArtifact` is set ONLY here, and ONLY
 * when a row arrives with no uuid AND `isUnique: true` -- the item is *born*
 * one-of-a-kind. An update can never mint a definition, so a rename can never
 * create a new template.
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

/**
 * Where a row's stack physically is.
 *   - carried groups (currency / equipped / inventory) -> `on_person`
 *   - `world` -> the current scene's observations, when the caller supplied them
 * Observations merge per source and never clear each other; recency (`at`)
 * alone decides which one wins at read time.
 */
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
    isStored: false,
    lastSeenTurn: context.currentTurn ?? null,
    createdAt: ts,
    updatedAt: ts,
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

  // A name that differs from the definition is a STACK OVERRIDE, never a new
  // definition. "Hero Sword" -> "Broken Hero Sword" updates this pile only.
  const definition = dossier.definitions.find((d) => d.id === stack.definitionId);
  const rowKey = canonicalName(row.name);
  if (rowKey && rowKey !== canonicalName(definition?.name)) {
    stack.name = rowKey;
    stack.displayName = row.name;
  }

  if (row.type !== undefined) stack.type = row.type;
  if (row.qty !== undefined) {
    // Every row states the pile's post-turn TOTAL (never a delta). Uniques are
    // clamped to 1 and are only ever destroyed by an explicit isDestroyed flag.
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
  if (row.customFields !== undefined) {
    stack.customFields = { ...(stack.customFields ?? {}), ...row.customFields };
  }

  stack.locationRef = stampLocation(stack.locationRef ?? {}, row, context);
  if (context.currentTurn != null) stack.lastSeenTurn = context.currentTurn;
  stack.updatedAt = ts;
}

/**
 * Collapse same-scope duplicate stacks the model split by accident.
 * Two stacks merge only when definition + owner + type + normalized flair all
 * match AND neither is unique (a unique is a singleton by definition).
 */
function mergeDuplicateStacks(dossier: PersistentItemDossier): void {
  const kept: DossierStack[] = [];
  for (const stack of dossier.stacks) {
    if (stack.isUnique) {
      kept.push(stack);
      continue;
    }
    const twin = kept.find(
      (k) =>
        !k.isUnique &&
        k.definitionId === stack.definitionId &&
        canonicalName(k.owner) === canonicalName(stack.owner) &&
        k.type === stack.type &&
        canonicalName(k.flair ?? "") === canonicalName(stack.flair ?? ""),
    );
    if (twin) {
      // Not row math: these stacks are already separate in the dossier and
      // indistinguishable, so the true total was split by a bug -- reconstruct it.
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
 * Cleanup tail.
 *   - destroyed COMMODITY -> deleted outright; nothing about a potion is worth
 *     provenance
 *   - destroyed UNIQUE -> kept, flagged, qty 0; the shattering of *that* sword
 *     is a story fact
 *   - `qty: 0` on a commodity counts as emptied (belt and braces for a model
 *     that forgets the flag)
 *   - definitions are NEVER deleted; they are permanent vocabulary
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
 * Reconcile one agent's rows against the per-chat dossier.
 *
 * Identity rules (in order):
 *   1. exact `uuid` match                      -> update that stack
 *   2. canonical name + same owner + same type -> update that stack
 *   3. no match                                -> mint definition (by name) + stack
 *
 * Owner rules:
 *   - the persona's own items carry the persona's name and id, never "player"
 *   - owners resolve against the chat's own cards first, then `presentCharacters`
 *     (the tracker agent writes that array itself, so its id is a hint)
 *   - a `world` row owned by anyone but the persona is retyped to `inventory`,
 *     because that means the character is holding it, not the floor
 *   - rows derived from existing `playerStats` seed an EMPTY dossier only
 *
 * Field rules:
 *   - every row SETS: `qty` is the pile's post-turn TOTAL, never a delta
 *   - omitted fields are left unchanged; omission never deletes a stack
 *   - an update can never mint a definition, so a rename only sets the stack's
 *     name/displayName override
 *   - host-owned fields (id, definitionId, locationRef, createdAt, lastSeenTurn,
 *     ownerId, lastOwners) are never taken from model output
 */
export async function reconcileItemDossier(
  storage: PersistentItemDossierStorage,
  chatId: string,
  rows: DossierAgentRow[],
  context: ItemDossierReconcileContext = {},
  /**
   * Optional merge base for rewind and swipe. When provided, the reconciler
   * merges onto this dossier instead of reading the live row, so an agent
   * turn after a rewind continues from the state at the anchor message rather
   * than from the newest branch. Pass `undefined` (or omit) to keep the live
   * row as the base -- the pre-snapshot behaviour, retained so pre-upgrade
   * chats that never accumulated snapshot history keep working.
   */
  base?: PersistentItemDossier | null,
): Promise<PersistentItemDossier> {
  const loaded = base !== undefined ? base : await storage.getForChat(chatId);
  const dossier: PersistentItemDossier = loaded ?? {
    schemaVersion: 2,
    definitions: [],
    stacks: [],
  };
  // Seed rows are only meaningful while the dossier is empty: after that,
  // `playerStats` is a projection of the dossier and re-applying it would
  // resurrect items the agent has since moved or dropped.
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
      // A matched definition is shared vocabulary, so the row's metadata is an
      // INSTANCE claim and becomes a stack override instead of rewriting the
      // template every other item of that kind reads from.
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
 * De-duplication key for rows on their way out of the adapter. Owner and flair
 * belong in it: two daggers of the same name held by different characters, or
 * in different conditions, are different stacks and must both survive.
 */
function dossierRowKey(type: string, name: string, owner: string | undefined, flair: string | undefined): string {
  return `${type}:${canonicalName(owner)}:${canonicalName(name)}:${canonicalName(flair)}`;
}

/**
 * Seed rows from an existing `playerStats`.
 *
 * Used once, when a chat gains a dossier it never had: every item the persona
 * already carries gets a stack and a stable identity. Marked so the reconciler
 * ignores them afterwards, because `playerStats` becomes a projection of the
 * dossier and re-reading it would resurrect items the agent has since moved or
 * dropped.
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
 * Adapter: the inventory tracker's shape -> shared dossier rows.
 *
 * `rawData` is the agent's own JSON, BEFORE normalization, so rich fields
 * (uuid, description, class, rarity, owner, isUnique, isDestroyed, flair)
 * survive. `mergedPlayerStats` contributes SEED rows only, and only for items no
 * agent row already describes; the reconciler applies them exactly once.
 * The `world` bucket is delta-only and is never carried forward.
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
