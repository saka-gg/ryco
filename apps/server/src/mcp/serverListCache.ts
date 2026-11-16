/**
 * A short-lived per-workspace cache of MCP server listings.
 *
 * A listing that began before a mutation must not replace the mutation's fresh listing: every
 * invalidation bumps the workspace's generation, and `remember` drops a result read under an
 * older generation (the caller still gets it, it just is not stored).
 */
export interface ServerListCache<A> {
  /** The workspace's current generation; read it before starting a listing. */
  readonly generation: (workspaceId: string) => number;
  readonly get: (workspaceId: string, detail: string | undefined) => A | undefined;
  /** Drops every entry of the workspace and invalidates listings already in flight. */
  readonly invalidate: (workspaceId: string) => void;
  /** Stores the result unless the workspace was invalidated since `readGeneration`. */
  readonly remember: (
    workspaceId: string,
    detail: string | undefined,
    result: A,
    readGeneration: number,
  ) => A;
}

export const makeServerListCache = <A>(options: {
  readonly ttlMs: number;
  readonly now?: () => number;
}): ServerListCache<A> => {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { readonly expiresAtMs: number; readonly result: A }>();
  const generations = new Map<string, number>();
  const prefix = (workspaceId: string) => `${workspaceId}\u0000`;
  const key = (workspaceId: string, detail: string | undefined) =>
    `${prefix(workspaceId)}${detail ?? "full"}`;
  const generation = (workspaceId: string) => generations.get(workspaceId) ?? 0;
  const deleteWorkspaceEntries = (workspaceId: string) => {
    for (const entryKey of entries.keys()) {
      if (entryKey.startsWith(prefix(workspaceId))) entries.delete(entryKey);
    }
  };

  return {
    generation,
    get: (workspaceId, detail) => {
      const entryKey = key(workspaceId, detail);
      const entry = entries.get(entryKey);
      if (entry === undefined) return undefined;
      if (entry.expiresAtMs <= now()) {
        entries.delete(entryKey);
        return undefined;
      }
      return entry.result;
    },
    invalidate: (workspaceId) => {
      generations.set(workspaceId, generation(workspaceId) + 1);
      deleteWorkspaceEntries(workspaceId);
    },
    remember: (workspaceId, detail, result, readGeneration) => {
      if (generation(workspaceId) !== readGeneration) return result;
      deleteWorkspaceEntries(workspaceId);
      entries.set(key(workspaceId, detail), { expiresAtMs: now() + options.ttlMs, result });
      return result;
    },
  };
};
