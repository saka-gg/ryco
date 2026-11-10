// The on-device layer of the mobile query caches (mobileQueryCache.ts): a read
// that opts in (`persist`) is saved after each live answer and read back the
// first time a screen watches it, so the screen shows its last answer at once
// and refreshes behind it. The store itself (SQLite, bounds, the device
// setting, purges) lives in persistence/savedQueryStore.ts and is installed at
// startup; this module is only the seam, so the query modules stay light on
// the launch graph.
import type { EnvironmentId } from "@ryco/contracts";

/** How one query's answers are kept: a versioned string form of the data. */
export interface SavedQueryCodec<TData> {
  /** Bump when the stored shape changes: rows of another version are never decoded. */
  readonly version: number;
  readonly encode: (data: TData) => string;
  /** Null (or a throw) when the payload does not decode as this version's shape. */
  readonly decode: (payload: string) => TData | null;
}

export interface SavedQueryRead {
  readonly payload: string;
  /** When the saved answer was read from the node (epoch ms). */
  readonly savedAt: number;
}

export interface SavedQueryStore {
  readonly load: (
    environmentId: EnvironmentId,
    key: string,
    version: number,
  ) => Promise<SavedQueryRead | null>;
  /**
   * Keeps a live answer. `encode` runs later, off the publishing path, and a
   * newer answer for the same key replaces one still waiting.
   */
  readonly save: (
    environmentId: EnvironmentId,
    key: string,
    version: number,
    encode: () => string,
  ) => void;
}

let installed: SavedQueryStore | null = null;
let waiters: Array<(store: SavedQueryStore | null) => void> = [];

/** Installed by the persistence layer at startup; null uninstalls it. */
export function setSavedQueryStore(store: SavedQueryStore | null): void {
  installed = store;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(store);
}

/**
 * The store once installed. A cold start's first screens can watch before the
 * persistence layer is ready; they wait for it instead of missing the copy.
 * Resolves null when the store is uninstalled meanwhile (tests, teardown).
 */
export function awaitSavedQueryStore(): Promise<SavedQueryStore | null> {
  if (installed !== null) return Promise.resolve(installed);
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function resetSavedQueryStoreForTests(): void {
  setSavedQueryStore(null);
}
