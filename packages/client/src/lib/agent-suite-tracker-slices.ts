import type { GameState, InventoryTrackerGroup, PlayerStats } from "@marinara-engine/shared";
import {
  excludeInventoryTrackerCarriedDuplicates,
  findInvalidInventoryTrackerRow,
  normalizeInventoryTrackerRows,
} from "@marinara-engine/shared";
import { saveInventoryTrackerToDossier } from "./inventory-tracker-dossier-save";

export type AgentSuiteTrackerSlice = {
  label: string;
  description: string;
  getValue: (gameState: GameState) => unknown;
  buildPatch: (gameState: GameState, parsed: unknown) => Record<string, unknown> | { error: string };
  /**
   * Present on slices whose tracker persists through its own endpoint instead of
   * the shared game-state PATCH, whose normalizer strips dossier-only fields
   * (uuid, class, rarity, flair). Saves the draft server-side and returns the
   * server's projected playerStats, which the caller adopts as-is.
   */
  save?: (args: { chatId: string; snapshot: GameState; parsed: unknown }) => Promise<PlayerStats>;
};

function createEmptyPlayerStats(): PlayerStats {
  return {
    stats: [],
    attributes: null,
    skills: {},
    inventory: [],
    activeQuests: [],
    status: "",
  };
}

/**
 * Shape-check a tracker draft without normalizing it: reports the first bad row
 * instead of silently dropping it. The shared normalizer drops rows it cannot
 * read, so `[{ "foo": 1 }]` would become `[]` and look to the author like the
 * editor had eaten a group they just typed.
 */
function validateInventoryTrackerDraft(
  parsed: unknown,
): { error: string } | { groups: Record<InventoryTrackerGroup, unknown[]> } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Inventory Tracker data must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.currencies) || !Array.isArray(record.equipped) || !Array.isArray(record.inventory)) {
    return { error: "Inventory Tracker data must include currencies, equipped, and inventory arrays" };
  }
  for (const [group, rows] of [
    ["currencies", record.currencies],
    ["equipped", record.equipped],
    ["inventory", record.inventory],
  ] as const) {
    const problem = findInvalidInventoryTrackerRow(rows);
    if (problem) return { error: `Inventory Tracker "${group}": ${problem}` };
  }
  return { groups: { currencies: record.currencies, equipped: record.equipped, inventory: record.inventory } };
}

/** Per-tracker-agent slice of the latest game-state snapshot. */
export const AGENT_SUITE_TRACKER_SLICES: Record<string, AgentSuiteTrackerSlice> = {
  "world-state": {
    label: "Scene",
    description: "Date, time, location, weather, and temperature of the current scene.",
    getValue: (gameState) => ({
      date: gameState.date,
      time: gameState.time,
      location: gameState.location,
      weather: gameState.weather,
      temperature: gameState.temperature,
      worldCustomFields: gameState.worldCustomFields ?? [],
    }),
    buildPatch: (_gameState, parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "Scene data must be a JSON object" };
      }
      const record = parsed as Record<string, unknown>;
      // Only send keys present in the edited JSON: a dropped key (e.g. from an
      // AI rewrite) means "leave unchanged" — an explicit null still clears.
      const patch: Record<string, unknown> = {};
      for (const key of ["date", "time", "location", "weather", "temperature"] as const) {
        if (key in record) patch[key] = record[key] ?? null;
      }
      if ("worldCustomFields" in record) {
        if (!Array.isArray(record.worldCustomFields)) {
          return { error: "World custom fields must be a JSON array" };
        }
        patch.worldCustomFields = record.worldCustomFields;
      }
      return patch;
    },
  },
  "character-tracker": {
    label: "Present Characters",
    description: "Characters in the current scene with mood, appearance, outfit, and thoughts.",
    getValue: (gameState) => gameState.presentCharacters ?? [],
    buildPatch: (_gameState, parsed) =>
      Array.isArray(parsed) ? { presentCharacters: parsed } : { error: "Present characters must be a JSON array" },
  },
  "persona-stats": {
    label: "Persona Stats",
    description: "Your persona's status bars and inventory.",
    getValue: (gameState) => ({
      personaStats: gameState.personaStats ?? [],
      inventory: gameState.playerStats?.inventory ?? [],
    }),
    buildPatch: (gameState, parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "Persona stats data must be a JSON object" };
      }
      const record = parsed as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if ("personaStats" in record) {
        if (!Array.isArray(record.personaStats)) return { error: "Persona stats must be a JSON array" };
        patch.personaStats = record.personaStats;
      }
      if ("inventory" in record) {
        if (!Array.isArray(record.inventory)) return { error: "Inventory must be a JSON array" };
        patch.playerStats = {
          ...(gameState.playerStats ?? createEmptyPlayerStats()),
          inventory: record.inventory,
        };
      }
      return patch;
    },
  },
  "custom-tracker": {
    label: "Custom Tracker Fields",
    description: "User-defined tracker fields maintained by the Custom Tracker agent.",
    getValue: (gameState) => gameState.playerStats?.customTrackerFields ?? [],
    buildPatch: (gameState, parsed) =>
      Array.isArray(parsed)
        ? {
            playerStats: {
              ...(gameState.playerStats ?? createEmptyPlayerStats()),
              customTrackerFields: parsed,
            },
          }
        : { error: "Custom tracker fields must be a JSON array" },
  },
  "inventory-tracker": {
    label: "Inventory Tracker",
    description: "Currencies, equipped items, and carried inventory maintained by the Inventory Tracker agent.",
    getValue: (gameState) => ({
      currencies: gameState.playerStats?.inventoryTrackerCurrencies ?? [],
      equipped: gameState.playerStats?.inventoryTrackerEquipped ?? [],
      inventory: gameState.playerStats?.inventoryTrackerInventory ?? [],
    }),
    buildPatch: (gameState, parsed) => {
      const checked = validateInventoryTrackerDraft(parsed);
      if ("error" in checked) return checked;

      const currencies = normalizeInventoryTrackerRows(checked.groups.currencies);
      const equipped = normalizeInventoryTrackerRows(checked.groups.equipped);
      const carried = normalizeInventoryTrackerRows(checked.groups.inventory);
      return {
        playerStats: {
          ...(gameState.playerStats ?? createEmptyPlayerStats()),
          inventoryTrackerCurrencies: currencies,
          inventoryTrackerEquipped: equipped,
          inventoryTrackerInventory: excludeInventoryTrackerCarriedDuplicates(carried, currencies, equipped),
        },
      };
    },
    save: async ({ chatId, snapshot, parsed }) => {
      const checked = validateInventoryTrackerDraft(parsed);
      if ("error" in checked) throw new Error(checked.error);
      return saveInventoryTrackerToDossier(chatId, snapshot, checked.groups);
    },
  },
  quest: {
    label: "Active Quests",
    description: "Quest progress tracked for this chat.",
    getValue: (gameState) => gameState.playerStats?.activeQuests ?? [],
    buildPatch: (gameState, parsed) =>
      Array.isArray(parsed)
        ? {
            playerStats: {
              ...(gameState.playerStats ?? createEmptyPlayerStats()),
              activeQuests: parsed,
            },
          }
        : { error: "Active quests must be a JSON array" },
  },
};
