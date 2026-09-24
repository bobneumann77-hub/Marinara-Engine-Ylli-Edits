// packages/client/src/features/tracker-panel/lib/inventory-tracker-display.ts
// Display-only helpers for the inventory tracker. Nothing here may feed identity: a
// stack's stored name is the matcher's first tier, the save key and the sort key, so
// a value produced in this file is for the eye, never for a write.

/**
 * The plural a pile over one item reads as in the pill: "Dollars", "Arrow" ->
 * "Arrows", "Health Potion" -> "Health Potions".
 *
 * Deliberately bounded to the same s / es / ies allowance the dossier matcher
 * accepts, rather than an English plural engine, so the displayed form never
 * invents a word the matcher would not recognize. A last word that already ends in
 * `s` comes back untouched: "Boots" is plural already and "Bootses" helps nobody.
 */
export function pluralizeInventoryName(name: string, quantity: number): string {
  if (quantity <= 1) return name;
  const trimmed = name.trim();
  if (!trimmed) return name;
  const words = trimmed.split(" ");
  const last = words[words.length - 1] ?? "";
  const lower = last.toLocaleLowerCase("en-US");
  if (!last || lower.endsWith("s")) return trimmed;
  let plural = `${last}s`;
  if (lower.endsWith("y") && !/[aeiou]y$/.test(lower)) {
    plural = `${last.slice(0, -1)}ies`;
  } else if (/(?:ch|sh|x|z)$/.test(lower)) {
    plural = `${last}es`;
  }
  words[words.length - 1] = plural;
  return words.join(" ");
}
