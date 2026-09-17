import { useRef, useState, type FocusEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Backpack, Lock, RotateCcw, Star, X } from "lucide-react";
import {
  isTrackerFieldLocked,
  normalizeInventoryTrackerName,
  removeTrackerFieldLockPrefix,
  renameTrackerFieldLockPrefix,
  roleplayInventoryTrackerLockKey,
  roleplayInventoryTrackerRowLockPrefix,
  type InventoryTrackerGroup,
  type InventoryTrackerRow,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../../../lib/utils";
import { InlineEdit, InlineNumber } from "../controls/InlineControls";
import { TrackerReadabilityVeil } from "../controls/TrackerProfileChrome";
import { AddRowButton, EmptySection, SectionHeader, TRACKER_SECTION_SHELL_CLASS } from "../controls/SectionControls";
import { useTrackerLockContext } from "../TrackerLockContext";

/**
 * Give a new row a name no existing row already has.
 *
 * Rows are deduplicated by name on the way to storage, so two untouched "New item"
 * placeholders would collapse into one row with `qty: 2` instead of giving the user a
 * second row to name.
 */
function nextPlaceholderName(rows: InventoryTrackerRow[], base: string): string {
  const taken = new Set(rows.map((row) => normalizeInventoryTrackerName(row.name).toLocaleLowerCase("en-US")));
  if (!taken.has(base.toLocaleLowerCase("en-US"))) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
  return base;
}

/**
 * Cancels the fill and ring InlineEdit/InlineNumber paint when a field is locked.
 *
 * Those were designed for bare rows on a panel. Inside a chip that already has its own
 * border they draw a second surface within the first, so a pinned entry stopped looking
 * like its neighbours. A padlock marks the lock instead, which leaves every chip the
 * same colour and shape — the alternative, restyling the chip, means guessing at the
 * tracker panel's scoped colour tokens, which do not resolve to the same values as the
 * app-level ones.
 *
 * The hover fill is deliberately kept: it is transient, and it is the only cue that an
 * individual field is clickable in lock mode. `rounded-full` makes it nest cleanly.
 * `cn` merges by Tailwind group and this is passed last, so it wins over the control's
 * own classes without touching the shared component.
 */
const LOCK_SURFACE_RESET = "rounded-sm bg-transparent ring-0";

const LOCK_GLYPH = <Lock size="0.5rem" className="shrink-0 opacity-70" aria-hidden="true" />;

type InventoryGroupProps = {
  group: InventoryTrackerGroup;
  label: string;
  rows: InventoryTrackerRow[];
  onUpdate: (rows: InventoryTrackerRow[]) => void;
  /** Present on the two carried groups: hands the row to the other one, uuid intact. */
  onMoveTo?: (index: number, to: InventoryTrackerGroup) => void;
  deleteMode: boolean;
  /**
   * Draws empty detail fields -- "I am editing structure right now". A single row can
   * also reveal its own empty fields by being clicked, without the panel entering a mode.
   */
  addMode: boolean;
  /**
   * Draws the group's + button. Split from `addMode` because they answer different
   * questions: "may I add a row" versus "am I editing structure". The HUD popover always
   * allows adding but should never open in a structural mode, and one shared prop used to
   * force both.
   */
  allowAdd: boolean;
};

function InventoryGroup({
  group,
  label,
  rows,
  onUpdate,
  onMoveTo,
  deleteMode,
  addMode,
  allowAdd,
}: InventoryGroupProps) {
  const { t: localizeUi } = useUiTranslation();
  const { fieldLocks, lockMode, onToggleFieldLock, onUpdateFieldLocks } = useTrackerLockContext();
  // A row being created is a DRAFT: it lives here, not in the store, so the save
  // queue can never post an unnamed placeholder and mint a permanent "New item"
  // definition out of one click (the debounce fires long before a name is typed).
  // It becomes a real row the moment it has a name; unnamed when the panel
  // unmounts, it is discarded and nothing ever happened. The ref mirrors the state
  // so a blur racing an Enter cannot commit the same row twice.
  const [draftName, setDraftName] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  // Flair is identity's second half (the save matcher's flair tier), so the draft
  // carries it too -- otherwise a flavored pile could never be created beside a
  // bare one, because the flair was always empty at commit time.
  const [draftFlair, setDraftFlair] = useState("");
  const draftFlairRef = useRef("");
  // Qty is the third bare field -- the most an item needs at birth. A number the
  // user never touched reads as 1, so the input can stay empty while typing.
  const [draftQty, setDraftQty] = useState("");
  const draftQtyRef = useRef("");
  // A row reveals its own empty fields when its chrome is clicked. Component state, one
  // row at a time, and deliberately not stored: a reveal is a view concern, so nothing
  // about it can reach a payload.
  const [revealedIndex, setRevealedIndex] = useState<number | null>(null);

  const openDraft = () => {
    if (draftRef.current !== null) return;
    draftRef.current = "";
    setDraftName("");
  };

  const updateDraft = (value: string) => {
    if (draftRef.current === null) return;
    draftRef.current = value;
    setDraftName(value);
  };

  const updateDraftFlair = (value: string) => {
    draftFlairRef.current = value;
    setDraftFlair(value);
  };

  const updateDraftQty = (value: string) => {
    // Digits only -- the qty input is a count, not an expression.
    const digits = value.replace(/[^0-9]/g, "");
    draftQtyRef.current = digits;
    setDraftQty(digits);
  };

  const cancelDraft = () => {
    draftRef.current = null;
    draftFlairRef.current = "";
    draftQtyRef.current = "";
    setDraftName(null);
    setDraftFlair("");
    setDraftQty("");
  };

  const commitDraft = () => {
    if (draftRef.current === null) return;
    const name = draftRef.current.trim();
    const flair = draftFlairRef.current.trim();
    const qtyValue = draftQtyRef.current.trim();
    // An untouched or non-numeric qty is 1; a typed one is the item's stated total.
    const parsedQty = Number.parseInt(qtyValue, 10);
    const qty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
    draftRef.current = null;
    draftFlairRef.current = "";
    draftQtyRef.current = "";
    setDraftName(null);
    setDraftFlair("");
    setDraftQty("");
    setRevealedIndex(null);
    if (!name) return;
    // Merge-on-commit: a draft whose name AND flair match exactly one pile in
    // this group adds to that pile instead of posting a qty-less row the server
    // silently absorbs (the new stack used to just vanish). The posted value is
    // a stated TOTAL, never a delta -- same contract the agent path uses.
    // Guards: never merge into a unique (a second one is a new pile, not a +1),
    // and never on ambiguity -- two candidates pair nothing, so the draft posts
    // as its own row and the server decides. A different flair is never merged:
    // flair divides identity, and the server mints it as its own pile.
    const draftNameKey = normalizeInventoryTrackerName(name);
    const draftFlairKey = normalizeInventoryTrackerName(flair);
    const matches = rows.filter((candidate) => {
      const rich = candidate as InventoryTrackerRow & { flair?: string; isUnique: boolean };
      return (
        rich.isUnique !== true &&
        normalizeInventoryTrackerName(candidate.name) === draftNameKey &&
        normalizeInventoryTrackerName(rich.flair ?? "") === draftFlairKey
      );
    });
    if (matches.length === 1) {
      const index = rows.indexOf(matches[0]!);
      const next = [...rows];
      next[index] = { ...matches[0]!, qty: (matches[0]!.qty ?? 1) + qty };
      onUpdate(next);
      return;
    }
    // The definition is minted from THIS row, so it carries the name (and flair)
    // actually typed -- which is the whole point of holding it back until now.
    onUpdate([...rows, { name, qty, ...(flair ? { flair } : {}) }]);
  };
  // A blur inside the chip is focus MOVING, not leaving: tabbing from the name
  // to the flair must not commit a half-typed draft. The container is focusable
  // (tabIndex -1) so a click on the pill itself also lands inside it. Commit
  // only when focus left the chip entirely.
  const commitDraftOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
    commitDraft();
  };
  const updateRow = (index: number, row: InventoryTrackerRow) => {
    const previous = rows[index];
    if (previous && previous.name !== row.name) {
      onUpdateFieldLocks?.((locks) =>
        renameTrackerFieldLockPrefix(
          locks,
          roleplayInventoryTrackerRowLockPrefix(group, previous, index),
          // Remap from the stored form of the name, not the raw keystrokes — storage
          // trims and collapses whitespace, so an un-normalized key would orphan the lock.
          roleplayInventoryTrackerRowLockPrefix(
            group,
            { ...row, name: normalizeInventoryTrackerName(row.name) },
            index,
          ),
        ),
      );
    }
    const next = [...rows];
    next[index] = row;
    onUpdate(next);
  };
  const removeRow = (index: number) => {
    onUpdateFieldLocks?.((locks) =>
      removeTrackerFieldLockPrefix(locks, roleplayInventoryTrackerRowLockPrefix(group, rows[index]!, index)),
    );
    setRevealedIndex(null);
    onUpdate(rows.filter((_, rowIndex) => rowIndex !== index));
  };

  return (
    <div className="min-w-0 border-b border-[var(--border)]/25 p-1.5 last:border-0">
      <div className="mb-1 flex min-h-6 items-center justify-between gap-1 px-0.5">
        <span className="truncate text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
          {label}
        </span>
        {allowAdd && (
          <AddRowButton
            title={localizeUi("ui.trackerPanel.inventoryTracker.addToGroup", { group: label })}
            onClick={openDraft}
            className="h-5 min-h-5 w-5 min-w-5"
          />
        )}
      </div>
      {/* Chips wrap at every width. A narrow panel does get a ragged right edge, but the
          stacked fallback stretched each chip to the full row, which read as a list of
          buttons rather than as the item pills the wide layout shows. */}
      <div className="flex flex-wrap gap-1">
        {rows.length === 0 && (
          <EmptySection className="w-full">{localizeUi("ui.trackerPanel.inventoryTracker.emptyGroup")}</EmptySection>
        )}
        {rows.map((row, index) => {
          const nameKey = roleplayInventoryTrackerLockKey(group, row, "name", index);
          const qtyKey = roleplayInventoryTrackerLockKey(group, row, "qty", index);
          const quantity = row.qty ?? 1;
          // A quantity of 1 is the overwhelmingly common case and the number carries no
          // information, so it is hidden — but it still has to be reachable when the user
          // is deliberately editing structure or pinning values, or a qty-1 row could
          // never be raised or locked.
          const revealed = revealedIndex === index;
          const editingFields = addMode || lockMode || revealed;
          const showQuantity = quantity > 1 || editingFields;
          const nameLocked = isTrackerFieldLocked(fieldLocks, nameKey);
          const qtyLocked = isTrackerFieldLocked(fieldLocks, qtyKey);
          // A detail field with nothing in it is not drawn at all. The old layout
          // rendered both lines whenever either had a value and used the label itself
          // as the empty placeholder, so an untouched Location read like one ("Location:
          // Location"). They stay reachable in the panel's editing modes, where an empty
          // field is the point.
          // flair and isUnique are projection output the shared row type does not declare
          // (it keeps name/qty/description/location), but the panel edits the row it was
          // handed, so they ride along on every write.
          const richRow = row as InventoryTrackerRow & { flair?: string; isUnique?: boolean };
          const flair = richRow.flair ?? "";
          // Currencies have nowhere to be worn, so only the carried groups move.
          const moveTarget: InventoryTrackerGroup | null =
            group === "inventory" ? "equipped" : group === "equipped" ? "inventory" : null;
          const moveLabel = moveTarget
            ? localizeUi(
                moveTarget === "equipped"
                  ? "ui.trackerPanel.inventoryTracker.equipItem"
                  : "ui.trackerPanel.inventoryTracker.unequipItem",
                { item: row.name },
              )
            : "";
          const detailFields = (["description", "location"] as const).filter((field) => editingFields || !!row[field]);
          const showDetails = detailFields.length > 0 || !!flair;
          return (
            <div
              key={`${row.name}-${index}`}
              onClick={(event) => {
                // The whole pill is the reveal trigger, not just the header line: a
                // collapsed bare pill is almost entirely the name's InlineEdit button,
                // so a header-only target left nothing to click. Buttons and inputs
                // own their clicks -- equip, delete and field editing stay one click --
                // and the reveal only decides whether empty fields are drawn.
                if ((event.target as HTMLElement).closest("button, input, textarea")) return;
                setRevealedIndex((current) => (current === index ? null : index));
              }}
              className={cn(
                "mari-chrome-tag flex min-h-6 min-w-0 max-w-full flex-col justify-center gap-1 border border-[var(--tracker-profile-slot-rule)] bg-[image:var(--tracker-profile-slot-surface)] px-1.5 text-[color:var(--tracker-profile-text)] shadow-[inset_0_1px_2px_var(--tracker-profile-slot-shadow)] [@media(pointer:coarse)]:min-h-7",
                showDetails && "w-full py-1",
                // Secondary cue only: on a dark chip a brighter rule reads as a rumor, so
                // the star beside the name is the visible tell.
                richRow.isUnique === true && "border-[color-mix(in_srgb,var(--tracker-profile-text)_60%,transparent)]",
              )}
            >
              <div className="flex min-w-0 items-center gap-1">
                {nameLocked && LOCK_GLYPH}
                <InlineEdit
                  value={row.name}
                  onSave={(name) =>
                    updateRow(index, { ...row, name: name || localizeUi("ui.trackerPanel.inventoryTracker.item") })
                  }
                  placeholder={localizeUi("ui.trackerPanel.inventoryTracker.item")}
                  className={cn("min-w-0 px-0.5 text-[0.625rem] font-medium", LOCK_SURFACE_RESET)}
                  title={row.name}
                  showEditHint={false}
                  scrollOnHover
                  locked={nameLocked}
                  lockMode={lockMode}
                  onToggleLock={() => onToggleFieldLock?.(nameKey)}
                />
                {/* The name flexes on the left; everything else collects at the right edge
                    in one cluster, so a long name cannot push the buttons around. The star
                    is the visible tell that this pile is one of a kind (the brighter border
                    is only a secondary cue). A unique always shows it filled; a row whose
                    fields are revealed shows the outline on everything else, so the toggle
                    is reachable without the panel entering a mode. */}
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {(richRow.isUnique === true || editingFields) && (
                    <button
                      type="button"
                      onClick={() => {
                        // Stating isUnique on also states qty 1, because a unique is one
                        // instance -- the same thing the server writes for a stated
                        // isUnique. The optimistic row then matches the response instead of
                        // showing a quantity that changes a beat later.
                        const makingUnique = richRow.isUnique !== true;
                        updateRow(index, {
                          ...row,
                          isUnique: makingUnique,
                          ...(makingUnique ? { qty: 1 } : {}),
                        } as InventoryTrackerRow);
                      }}
                      className="mari-chrome-tag grid h-3.5 w-3.5 shrink-0 place-items-center p-0 leading-none text-current transition-colors hover:bg-[color-mix(in_srgb,var(--tracker-profile-text)_8%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--tracker-profile-text)_48%,transparent)]"
                      title={localizeUi(
                        richRow.isUnique === true
                          ? "ui.trackerPanel.inventoryTracker.unmarkUniqueItem"
                          : "ui.trackerPanel.inventoryTracker.markUniqueItem",
                        { item: row.name },
                      )}
                      aria-label={localizeUi(
                        richRow.isUnique === true
                          ? "ui.trackerPanel.inventoryTracker.unmarkUniqueItem"
                          : "ui.trackerPanel.inventoryTracker.markUniqueItem",
                        { item: row.name },
                      )}
                    >
                      <Star
                        size="0.5rem"
                        fill={richRow.isUnique === true ? "currentColor" : "none"}
                        className="mari-rgb-static-icon block text-current"
                        aria-hidden="true"
                      />
                    </button>
                  )}
                  {showQuantity && (
                    <span className="flex shrink-0 items-center gap-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                      {qtyLocked && LOCK_GLYPH}
                      <span aria-hidden="true">×</span>
                      <InlineNumber
                        value={quantity}
                        min={1}
                        onChange={(qty) => updateRow(index, { ...row, qty: qty > 1 ? qty : undefined })}
                        className={cn("px-0 text-right text-[0.625rem] tabular-nums", LOCK_SURFACE_RESET)}
                        title={localizeUi("ui.trackerPanel.inventoryTracker.quantityFor", { item: row.name })}
                        locked={qtyLocked}
                        lockMode={lockMode}
                        onToggleLock={() => onToggleFieldLock?.(qtyKey)}
                      />
                    </span>
                  )}
                  {moveTarget && onMoveTo && (
                    <button
                      type="button"
                      onClick={() => onMoveTo(index, moveTarget)}
                      className="mari-chrome-tag grid h-4 w-4 shrink-0 place-items-center p-0 leading-none text-current ring-1 ring-[color-mix(in_srgb,var(--tracker-profile-text)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--tracker-profile-text)_8%,transparent)] focus-visible:outline-none focus-visible:ring-[color-mix(in_srgb,var(--tracker-profile-text)_48%,transparent)]"
                      title={moveLabel}
                      aria-label={moveLabel}
                    >
                      {moveTarget === "equipped" ? (
                        <ArrowUp size="0.5625rem" className="mari-rgb-static-icon block text-current" />
                      ) : (
                        <ArrowDown size="0.5625rem" className="mari-rgb-static-icon block text-current" />
                      )}
                    </button>
                  )}
                  {deleteMode && (
                    <button
                      type="button"
                      onClick={() => removeRow(index)}
                      className="mari-chrome-tag grid h-4 w-4 shrink-0 place-items-center p-0 leading-none text-current ring-1 ring-[color-mix(in_srgb,var(--tracker-profile-text)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--tracker-profile-text)_8%,transparent)] focus-visible:outline-none focus-visible:ring-[color-mix(in_srgb,var(--tracker-profile-text)_48%,transparent)]"
                      title={localizeUi("ui.trackerPanel.inventoryTracker.removeItem", { item: row.name })}
                      aria-label={localizeUi("ui.trackerPanel.inventoryTracker.removeItem", { item: row.name })}
                    >
                      <X size="0.5625rem" className="mari-rgb-static-icon block text-current" />
                    </button>
                  )}
                </span>
              </div>
              {showDetails && (
                <div className="space-y-1 border-t border-[var(--tracker-profile-slot-rule)]/40 pt-1">
                  {/* Flair has no lock key in the shared lock vocabulary, so it renders
                      without the padlock affordance rather than pretending to support it. */}
                  {(!!flair || editingFields) && (
                    <div className="flex min-w-0 items-start gap-1 text-[0.625rem]">
                      <span className="shrink-0 py-0.5 text-[var(--muted-foreground)]">
                        {localizeUi("ui.trackerPanel.inventoryTracker.flair")}:
                      </span>
                      <InlineEdit
                        value={flair}
                        onSave={(value) => updateRow(index, { ...richRow, flair: value } as InventoryTrackerRow)}
                        placeholder={localizeUi("ui.trackerPanel.inventoryTracker.flair")}
                        ariaLabel={localizeUi("ui.trackerPanel.inventoryTracker.flairFor", { item: row.name })}
                        className={cn("min-w-0 flex-1 px-0.5", LOCK_SURFACE_RESET)}
                        previewLineCount={2}
                        showEditHint={false}
                      />
                    </div>
                  )}
                  {detailFields.map((field) => {
                    const key = roleplayInventoryTrackerLockKey(group, row, field, index);
                    const locked = isTrackerFieldLocked(fieldLocks, key);
                    const label = localizeUi(`ui.trackerPanel.inventoryTracker.${field}`);
                    return (
                      <div key={field} className="flex min-w-0 items-start gap-1 text-[0.625rem]">
                        <span className="shrink-0 py-0.5 text-[var(--muted-foreground)]">{label}:</span>
                        {locked && LOCK_GLYPH}
                        <InlineEdit
                          value={row[field] ?? ""}
                          onSave={(value) => updateRow(index, { ...row, [field]: value })}
                          placeholder={label}
                          ariaLabel={localizeUi(`ui.trackerPanel.inventoryTracker.${field}For`, { item: row.name })}
                          className={cn("min-w-0 flex-1 px-0.5", LOCK_SURFACE_RESET)}
                          previewLineCount={2}
                          showEditHint={false}
                          locked={locked}
                          lockMode={lockMode}
                          onToggleLock={() => onToggleFieldLock?.(key)}
                        />
                        {field === "description" && editingFields && (
                          // Description resolves as override ?? item type, and the projection hands
                          // the panel the already-resolved value -- so this control cannot tell an
                          // override from the item type's own line, and it appears with the row's
                          // other editing affordances. Clicking it on an inherited value is a
                          // harmless no-op. null is the one value that drops the override so the
                          // item type shows again; "" would instead keep an empty override and
                          // suppress it. The cast below is needed because
                          // InventoryTrackerRow declares the four display fields only; null here is the
                          // runtime revert signal, not a widened shared type.
                          <button
                            type="button"
                            onClick={() =>
                              updateRow(index, { ...row, description: null } as unknown as InventoryTrackerRow)
                            }
                            className="mari-chrome-tag grid h-3.5 w-3.5 shrink-0 place-items-center p-0 leading-none text-current ring-1 ring-[color-mix(in_srgb,var(--tracker-profile-text)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--tracker-profile-text)_8%,transparent)] focus-visible:outline-none focus-visible:ring-[color-mix(in_srgb,var(--tracker-profile-text)_48%,transparent)]"
                            title={localizeUi("ui.trackerPanel.inventoryTracker.revertToItemType", { item: row.name })}
                            aria-label={localizeUi("ui.trackerPanel.inventoryTracker.revertToItemType", {
                              item: row.name,
                            })}
                          >
                            <RotateCcw size="0.5rem" className="mari-rgb-static-icon block text-current" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {draftName !== null && (
          <div
            tabIndex={-1}
            className="mari-chrome-tag flex min-h-6 min-w-0 max-w-full items-center gap-1 border border-[var(--tracker-profile-slot-rule)] bg-[image:var(--tracker-profile-slot-surface)] px-1.5 py-1 text-[color:var(--tracker-profile-text)] shadow-[inset_0_1px_2px_var(--tracker-profile-slot-shadow)] [@media(pointer:coarse)]:min-h-7"
            onBlur={commitDraftOnBlur}
          >
            <input
              autoFocus
              value={draftName}
              placeholder={nextPlaceholderName(rows, localizeUi("ui.trackerPanel.inventoryTracker.newItem"))}
              aria-label={localizeUi("ui.trackerPanel.inventoryTracker.addToGroup", { group: label })}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitDraft();
                if (event.key === "Escape") cancelDraft();
              }}
              className="min-w-0 flex-1 rounded-sm border border-[var(--tracker-inline-rule,var(--border))] bg-[var(--background)]/50 px-1 py-0.5 text-[0.625rem] text-[color:var(--tracker-inline-foreground,var(--foreground))] outline-none transition-colors focus:border-[var(--foreground)]/30"
            />
            <input
              value={draftQty}
              placeholder="1"
              inputMode="numeric"
              aria-label={localizeUi("ui.trackerPanel.inventoryTracker.qty")}
              onChange={(event) => updateDraftQty(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitDraft();
                if (event.key === "Escape") cancelDraft();
              }}
              className="w-10 shrink-0 rounded-sm border border-[var(--tracker-inline-rule,var(--border))] bg-[var(--background)]/50 px-1 py-0.5 text-center text-[0.625rem] text-[color:var(--tracker-inline-foreground,var(--foreground))] outline-none transition-colors focus:border-[var(--foreground)]/30"
            />
            <input
              value={draftFlair}
              placeholder={localizeUi("ui.trackerPanel.inventoryTracker.flair")}
              aria-label={localizeUi("ui.trackerPanel.inventoryTracker.flair")}
              onChange={(event) => updateDraftFlair(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitDraft();
                if (event.key === "Escape") cancelDraft();
              }}
              className="min-w-0 flex-1 rounded-sm border border-[var(--tracker-inline-rule,var(--border))] bg-[var(--background)]/50 px-1 py-0.5 text-[0.625rem] text-[color:var(--tracker-inline-foreground,var(--foreground))] outline-none transition-colors focus:border-[var(--foreground)]/30"
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function InventoryTrackerPanel({
  currencies,
  equipped,
  inventory,
  action,
  onUpdateCurrencies,
  onUpdateEquipped,
  onUpdateInventory,
  deleteMode,
  addMode = false,
  allowAdd,
  header,
  plain = false,
  collapsed = false,
  onToggleCollapsed,
}: {
  currencies: InventoryTrackerRow[];
  equipped: InventoryTrackerRow[];
  inventory: InventoryTrackerRow[];
  action?: ReactNode;
  onUpdateCurrencies: (rows: InventoryTrackerRow[]) => void;
  onUpdateEquipped: (rows: InventoryTrackerRow[]) => void;
  onUpdateInventory: (rows: InventoryTrackerRow[]) => void;
  deleteMode: boolean;
  addMode?: boolean;
  /** Draws + without forcing the panel into a structural editing mode. Falls back to `addMode`. */
  allowAdd?: boolean;
  header?: ReactNode;
  plain?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  // Adding and editing structure are separate affordances: a surface that only wants the +
  // button (the HUD popover) passes `allowAdd` and leaves `addMode` off, so its rows stop
  // drawing every empty field. Callers that pass only `addMode` behave exactly as before.
  const canAdd = allowAdd ?? addMode;
  // A move is two writes, and the dossier's editor adapter is what makes them one
  // move: the destination row carries the same uuid, so the source group's
  // disappearance is an updated identity rather than a deletion. Both writes share
  // one save burst (the queue keeps its first baseline), so the POST sees the
  // finished state and never a half-moved row.
  const moveRow = (from: InventoryTrackerGroup, index: number, to: InventoryTrackerGroup) => {
    const fromRows = from === "equipped" ? equipped : inventory;
    const toRows = to === "equipped" ? equipped : inventory;
    const row = fromRows[index];
    if (!row) return;
    const setFrom = from === "equipped" ? onUpdateEquipped : onUpdateInventory;
    const setTo = to === "equipped" ? onUpdateEquipped : onUpdateInventory;
    setFrom(fromRows.filter((_, rowIndex) => rowIndex !== index));
    setTo([...toRows, row]);
  };
  return (
    // Own the query container rather than inheriting one. The docked sidebar provides
    // `@container`, but the HUD popover is portaled to document.body and has none — so
    // the same component used to lay itself out differently in its two hosts.
    <section className={cn("@container relative z-10 overflow-hidden", !plain && TRACKER_SECTION_SHELL_CLASS)}>
      {!plain && <TrackerReadabilityVeil strength="strong" />}
      <div className="relative z-10">
        {header ?? (
          <SectionHeader
            icon={<Backpack size="0.6875rem" />}
            title={localizeUi("ui.trackerPanel.inventoryTracker.title")}
            badge={currencies.length + equipped.length + inventory.length}
            action={action}
            collapsed={collapsed}
            onToggle={onToggleCollapsed}
          />
        )}
        {!collapsed && (
          // Groups stack full-width. Splitting the panel into three columns gave the
          // longest group a third of the width and truncated its names, while a group
          // with two rows sat mostly empty.
          <div className="flex flex-col">
            <InventoryGroup
              group="currencies"
              label={localizeUi("ui.trackerPanel.inventoryTracker.currencies")}
              rows={currencies}
              onUpdate={onUpdateCurrencies}
              deleteMode={deleteMode}
              addMode={addMode}
              allowAdd={canAdd}
            />
            <InventoryGroup
              group="equipped"
              label={localizeUi("ui.trackerPanel.inventoryTracker.equipped")}
              rows={equipped}
              onUpdate={onUpdateEquipped}
              onMoveTo={(index, to) => moveRow("equipped", index, to)}
              deleteMode={deleteMode}
              addMode={addMode}
              allowAdd={canAdd}
            />
            <InventoryGroup
              group="inventory"
              label={localizeUi("ui.trackerPanel.inventoryTracker.inventory")}
              rows={inventory}
              onUpdate={onUpdateInventory}
              onMoveTo={(index, to) => moveRow("inventory", index, to)}
              deleteMode={deleteMode}
              addMode={addMode}
              allowAdd={canAdd}
            />
          </div>
        )}
      </div>
    </section>
  );
}
