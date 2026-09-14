// packages/server/src/services/storage/character-name-map.ts
// Character id -> display name for owner context. Lives below routes/ so the
// storage layer never imports a route module; generate-route-utils.ts re-exports
// it for its existing callers.

function readCharacterName(data: unknown): string | null {
  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Map character ids to their card display names. Pure: the caller supplies the
 * lookup. Ids whose card is gone, unreadable, or nameless are absent.
 */
export async function resolveCharacterNameMap(
  characterIds: string[],
  getCharacterById: (id: string) => Promise<{ data?: unknown } | null | undefined>,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    characterIds.map(async (id) => {
      const row = await getCharacterById(id);
      const name = readCharacterName(row?.data);
      return name ? ([id, name] as const) : null;
    }),
  );

  return new Map(entries.filter((entry): entry is readonly [string, string] => !!entry));
}
