import type { ProviderCatalog, ProviderCatalogStore } from "@ryco/client-runtime/rpc";

import { openIndexedDbRecords, type IndexedDbRecords } from "./indexedDbRecords";

/**
 * Persists the client runtime's provider catalog cache for this page's
 * origin, so a reload names the catalogs it already holds and the server
 * leaves them out of the config snapshot (~95% of its bytes). The same pages
 * keep it as keep the primary shell cache (see primaryShellCacheEligibility),
 * and it is dropped with it.
 */
const DATABASE_NAME = "ryco-provider-catalogs-v1";

interface ProviderCatalogRecord {
  readonly origin: string;
  readonly entries: ReadonlyArray<readonly [string, ProviderCatalog]>;
}

export function createIndexedDbProviderCatalogStore(input: {
  readonly factory: IDBFactory;
  readonly origin: string;
  readonly databaseName?: string;
}): ProviderCatalogStore & { readonly clear: () => Promise<void> } {
  const records: IndexedDbRecords<ProviderCatalogRecord> = openIndexedDbRecords({
    factory: input.factory,
    databaseName: input.databaseName ?? DATABASE_NAME,
    storeName: "catalogs",
    keyPath: "origin",
  });
  return {
    load: async () => {
      const value = (await records.get(input.origin)) as Partial<ProviderCatalogRecord> | undefined;
      if (value?.origin !== input.origin || !Array.isArray(value.entries)) return [];
      return value.entries.filter(
        (entry): entry is readonly [string, ProviderCatalog] =>
          Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "object",
      );
    },
    save: (entries) => records.put({ origin: input.origin, entries }),
    clear: () => records.delete(input.origin),
  };
}
