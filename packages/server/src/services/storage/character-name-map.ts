// packages/server/src/services/storage/character-name-map.ts
// Character id -> display name resolution for owner context. Lives here rather
// than in routes/ so the dossier write path can resolve owner context without
// importing a route module; routes/generate/generate-route-utils.ts re-exports
// it for its existing callers.

export interface CharacterIdentity {
  name: string;
  nameAliases: string[];
}

function readCharacterIdentity(data: unknown): CharacterIdentity | null {
  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const name = (parsed as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return null;
    const aliases = (parsed as { extensions?: { nameAliases?: unknown } | null }).extensions?.nameAliases;
    return {
      name: name.trim(),
      nameAliases: Array.isArray(aliases)
        ? aliases
            .filter((alias): alias is string => typeof alias === "string" && !!alias.trim())
            .map((alias) => alias.trim())
        : [],
    };
  } catch {
    return null;
  }
}

/** Supply the chat's full character list to include disabled members without reading unrelated cards. */
export async function resolveCharacterIdentityMap(
  characterIds: string[],
  getCharacterById: (id: string) => Promise<{ data?: unknown } | null | undefined>,
): Promise<Map<string, CharacterIdentity>> {
  const entries = await Promise.all(
    characterIds.map(async (id) => {
      const row = await getCharacterById(id);
      const identity = readCharacterIdentity(row?.data);
      return identity ? ([id, identity] as const) : null;
    }),
  );

  return new Map(entries.filter((entry): entry is readonly [string, CharacterIdentity] => !!entry));
}

export async function resolveCharacterNameMap(
  characterIds: string[],
  getCharacterById: (id: string) => Promise<{ data?: unknown } | null | undefined>,
): Promise<Map<string, string>> {
  const identities = await resolveCharacterIdentityMap(characterIds, getCharacterById);
  return new Map([...identities].map(([id, identity]) => [id, identity.name]));
}
