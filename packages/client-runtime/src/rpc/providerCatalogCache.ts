import type {
  ServerConfigStreamSnapshotEvent,
  ServerProvider,
  ServerProviderCatalogDigest,
} from "@ryco/contracts";

/** A provider's catalogs: by far the largest, and the least changing, part of its status. */
export interface ProviderCatalog {
  readonly models: ServerProvider["models"];
  readonly skills: ServerProvider["skills"];
  readonly slashCommands: ServerProvider["slashCommands"];
}

/** Optional persistence for the cache, so catalogs survive a reload. */
export interface ProviderCatalogStore {
  readonly load: () => Promise<ReadonlyArray<readonly [string, ProviderCatalog]>>;
  readonly save: (entries: ReadonlyArray<readonly [string, ProviderCatalog]>) => Promise<void>;
}

export const PROVIDER_CATALOG_CACHE_MAX_ENTRIES = 32;

/**
 * Provider catalogs a client was sent, by content digest, shared by every
 * connection of the page. A config subscription names the digests it holds
 * (`knownProviderCatalogs`) and the server leaves those catalogs out of its
 * snapshot; `restoreSnapshotCatalogs` puts them back before anyone sees it.
 */
export interface ProviderCatalogCache {
  /** What a subscription about to start can claim, kept for that subscription alone. */
  readonly pin: () => ReadonlyMap<string, ProviderCatalog>;
  readonly put: (digest: string, catalog: ProviderCatalog) => void;
  /** Loads persisted catalogs (entries already in memory win) and saves later changes. */
  readonly attachStore: (store: ProviderCatalogStore) => Promise<void>;
  readonly clear: () => void;
}

export function createProviderCatalogCache(
  maxEntries: number = PROVIDER_CATALOG_CACHE_MAX_ENTRIES,
): ProviderCatalogCache {
  const entries = new Map<string, ProviderCatalog>();
  let store: ProviderCatalogStore | null = null;
  let saveScheduled = false;
  const scheduleSave = () => {
    if (store === null || saveScheduled) return;
    saveScheduled = true;
    void Promise.resolve().then(() => {
      saveScheduled = false;
      void store?.save([...entries]).catch(() => undefined);
    });
  };
  const insert = (digest: string, catalog: ProviderCatalog) => {
    entries.delete(digest);
    entries.set(digest, catalog);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    pin: () => new Map(entries),
    put: (digest, catalog) => {
      const existing = entries.get(digest);
      insert(digest, catalog);
      if (existing === undefined) scheduleSave();
    },
    attachStore: async (next) => {
      store = next;
      const persisted = await next.load().catch(() => []);
      // Oldest first, then what this page already holds on top.
      const current = [...entries];
      entries.clear();
      for (const [digest, catalog] of persisted) {
        if (isProviderCatalog(catalog)) insert(digest, catalog);
      }
      for (const [digest, catalog] of current) insert(digest, catalog);
    },
    clear: () => {
      entries.clear();
      scheduleSave();
    },
  };
}

function isProviderCatalog(value: unknown): value is ProviderCatalog {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProviderCatalog>;
  return (
    Array.isArray(candidate.models) &&
    Array.isArray(candidate.skills) &&
    Array.isArray(candidate.slashCommands)
  );
}

/** The page's catalog cache. */
export const providerCatalogCache = createProviderCatalogCache();

/**
 * The snapshot with every catalog the server left out restored from `pinned`
 * (what the subscription claimed to hold), after keeping each catalog it did
 * send. `null` when the server left out a catalog the subscription never
 * claimed: that snapshot cannot be completed.
 */
export function restoreSnapshotCatalogs(
  event: ServerConfigStreamSnapshotEvent,
  pinned: ReadonlyMap<string, ProviderCatalog>,
  cache: ProviderCatalogCache,
): ServerConfigStreamSnapshotEvent | null {
  const catalogs = event.providerCatalogs;
  if (catalogs === undefined) return event;
  const omitted = new Set<string>(catalogs.omitted);
  const providers: ServerProvider[] = [];
  for (const provider of event.config.providers) {
    const digest: ServerProviderCatalogDigest | undefined = catalogs.digests[provider.instanceId];
    if (!omitted.has(provider.instanceId)) {
      if (digest !== undefined) {
        cache.put(digest, {
          models: provider.models,
          skills: provider.skills,
          slashCommands: provider.slashCommands,
        });
      }
      providers.push(provider);
      continue;
    }
    const catalog = digest === undefined ? undefined : pinned.get(digest);
    if (catalog === undefined) return null;
    if (digest !== undefined) cache.put(digest, catalog);
    providers.push({ ...provider, ...catalog });
  }
  const { providerCatalogs: _providerCatalogs, ...rest } = event;
  return { ...rest, config: { ...event.config, providers } };
}
