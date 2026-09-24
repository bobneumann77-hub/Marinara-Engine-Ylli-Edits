// ──────────────────────────────────────────────
// Inventory Tracker → dossier save queue
// ──────────────────────────────────────────────
// The tracker panel and the HUD popover edit the store optimistically so typing
// stays instant, then land the edit in the item dossier on an idle debounce. The
// dossier is the model here: playerStats.inventoryTracker* is projection-only
// output, and the game-state PATCH these surfaces used to ride normalizes rows,
// which drops uuid/class/rarity/flair.
//
// One burst, one POST. The baseline is captured from the store BEFORE the burst's
// first optimistic write, because the save helper derives `removed` by diffing
// that baseline against the rows it is handed — diffing against the optimistic
// state would read the edit itself as a deletion.
//
// Known limits, both self-healing because the response overwrites the store with
// server truth: an edit made while a POST is in flight starts a fresh burst whose
// baseline already contains the previous burst's optimistic rows, and a store
// refresh mid-burst (new turn, swipe) leaves the baseline behind it. The endpoint's
// duplicate check and the helper's uuid pairing are the net in between.
import type { GameState } from "@marinara-engine/shared";
import { useGameStateStore } from "../../../stores/game-state.store";
import { saveInventoryTrackerToDossier } from "../../../lib/inventory-tracker-dossier-save";

/** Same idle cadence the panels already debounce their game-state patches on. */
const SAVE_DEBOUNCE_MS = 500;

type PendingSave = {
  /** Store state from before the burst's first optimistic write. */
  baseline: GameState;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingSave>();

/**
 * Arm a dossier save for this chat. Call this BEFORE the optimistic store write:
 * the pre-edit state is what the removal diff needs. Repeated calls inside one
 * burst keep the original baseline and only push the debounce back.
 */
export function queueDossierSave(chatId: string | null | undefined): void {
  if (!chatId) return;
  const existing = pending.get(chatId);
  const baseline = existing?.baseline ?? useGameStateStore.getState().current;
  if (!baseline || baseline.chatId !== chatId) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    void flushDossierSave(chatId);
  }, SAVE_DEBOUNCE_MS);
  pending.set(chatId, { baseline, timer });
}

async function flushDossierSave(chatId: string): Promise<void> {
  const entry = pending.get(chatId);
  if (!entry) return;
  // Drop the entry before awaiting: an edit during the flight arms its own burst
  // instead of reusing a baseline that is already spent.
  pending.delete(chatId);
  const state = useGameStateStore.getState().current;
  if (!state || state.chatId !== chatId || !state.playerStats) return;
  try {
    const playerStats = await saveInventoryTrackerToDossier(chatId, entry.baseline, {
      currencies: state.playerStats.inventoryTrackerCurrencies ?? [],
      equipped: state.playerStats.inventoryTrackerEquipped ?? [],
      inventory: state.playerStats.inventoryTrackerInventory ?? [],
    });
    // Adopt the server's projection instead of keeping the optimistic guess, so
    // the panel renders dossier truth and picks up fields it cannot edit.
    const latest = useGameStateStore.getState().current;
    if (!latest || latest.chatId !== chatId) return;
    useGameStateStore.getState().setGameState({ ...latest, playerStats });
  } catch (err) {
    // The optimistic write stays in the store; the next save or refresh corrects it.
    console.warn("[inventory-tracker] dossier save failed", err);
  }
}
