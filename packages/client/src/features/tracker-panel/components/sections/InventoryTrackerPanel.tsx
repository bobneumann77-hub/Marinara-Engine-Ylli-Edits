import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Backpack, Lock, Star, X } from "lucide-react";
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
  addMode: boolean;
};

function InventoryGroup({ group, label, rows, onUpdate, onMoveTo, deleteMode, addMode }: InventoryGroupProps) {
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

  const cancelDraft = () => {
    draftRef.current = null;
    setDraftName(null);
  };

  const commitDraft = () => {
    if (draftRef.current === null) return;
    const name = draftRef.current.trim();
    draftRef.current = null;
    setDraftName(null);
    if (!name) return;
    // The definition is minted from THIS row, so it carries the name actually
    // typed -- which is the whole point of holding it back until now.
    onUpdate([...rows, { name }]);
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
    onUpdate(rows.filter((_, rowIndex) => rowIndex !== index));
  };

  return (
    <div className="min-w-0 border-b border-[var(--border)]/25 p-1.5 last:border-0">
      <div className="mb-1 flex min-h-6 items-center justify-between gap-1 px-0.5">
        <span className="truncate text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
          {label}
        </span>
        {addMode && (
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
          const showQuantity = quantity > 1 || addMode || lockMode;
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
          const detailFields = (["description", "location"] as const).filter(
            (field) => addMode || lockMode || !!row[field],
          );
          const showDetails = detailFields.length > 0 || !!flair;
          return (
            <div
              key={`${row.name}-${index}`}
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
                {/* The one stack trait that changes what the item IS, marked where the
                    eye already is. Static for now -- favouriting is a later interaction. */}
                {richRow.isUnique === true && (
                  <span className="shrink-0" title={localizeUi("ui.trackerPanel.inventoryTracker.uniqueItem")}>
                    <Star size="0.5rem" className="mari-rgb-static-icon block text-current" aria-hidden="true" />
                  </span>
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
              </div>
              {showDetails && (
                <div className="space-y-1 border-t border-[var(--tracker-profile-slot-rule)]/40 pt-1">
                  {/* Flair has no lock key in the shared lock vocabulary, so it renders
                      without the padlock affordance rather than pretending to support it. */}
                  {(!!flair || addMode || lockMode) && (
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
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {draftName !== null && (
          <div className="mari-chrome-tag flex min-h-6 min-w-0 max-w-full items-center gap-1 border border-[var(--tracker-profile-slot-rule)] bg-[image:var(--tracker-profile-slot-surface)] px-1.5 py-1 text-[color:var(--tracker-profile-text)] shadow-[inset_0_1px_2px_var(--tracker-profile-slot-shadow)] [@media(pointer:coarse)]:min-h-7">
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
              onBlur={commitDraft}
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
  addMode,
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
  addMode: boolean;
  header?: ReactNode;
  plain?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t: localizeUi } = useUiTranslation();
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
            />
            <InventoryGroup
              group="equipped"
              label={localizeUi("ui.trackerPanel.inventoryTracker.equipped")}
              rows={equipped}
              onUpdate={onUpdateEquipped}
              onMoveTo={(index, to) => moveRow("equipped", index, to)}
              deleteMode={deleteMode}
              addMode={addMode}
            />
            <InventoryGroup
              group="inventory"
              label={localizeUi("ui.trackerPanel.inventoryTracker.inventory")}
              rows={inventory}
              onUpdate={onUpdateInventory}
              onMoveTo={(index, to) => moveRow("inventory", index, to)}
              deleteMode={deleteMode}
              addMode={addMode}
            />
          </div>
        )}
      </div>
    </section>
  );
}
