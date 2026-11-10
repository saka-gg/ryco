import type { EnvironmentId } from "@ryco/contracts";

import type { SavedQueryStore } from "./savedQueries";

/**
 * An in-memory saved query store for tests: saves are queued like the real
 * store's and written by `flush` (or right away with `immediate`).
 */
export function createMemorySavedQueryStore(options: { readonly now?: () => number } = {}) {
  const now = options.now ?? (() => 1);
  const rows = new Map<string, { version: number; payload: string; savedAt: number }>();
  const pending = new Map<string, { version: number; encode: () => string }>();
  const id = (environmentId: EnvironmentId, key: string) => `${environmentId}|${key}`;
  const flush = async () => {
    for (const [rowId, save] of pending) {
      rows.set(rowId, { version: save.version, payload: save.encode(), savedAt: now() });
    }
    pending.clear();
  };
  const store: SavedQueryStore & {
    readonly rows: typeof rows;
    readonly flush: () => Promise<void>;
  } = {
    rows,
    flush,
    load: async (environmentId, key, version) => {
      await flush();
      const row = rows.get(id(environmentId, key));
      return row && row.version === version ? { payload: row.payload, savedAt: row.savedAt } : null;
    },
    save: (environmentId, key, version, encode) => {
      pending.set(id(environmentId, key), { version, encode });
    },
  };
  return store;
}
