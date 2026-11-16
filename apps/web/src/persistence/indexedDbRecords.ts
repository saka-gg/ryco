import { createIndexedDbOpener } from "./indexedDb";

/**
 * A single IndexedDB object store of records keyed by one field, opened
 * lazily and reopened after a failed open. Page-owned: the service worker
 * never reads or writes these databases.
 */
export interface IndexedDbRecords<Record> {
  readonly get: (key: string) => Promise<unknown>;
  readonly put: (record: Record) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

const request = <T>(operation: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    operation.addEventListener("success", () => resolve(operation.result), { once: true });
    operation.addEventListener("error", () => reject(operation.error), { once: true });
  });

export function openIndexedDbRecords<Record>(input: {
  readonly factory: IDBFactory;
  readonly databaseName: string;
  readonly storeName: string;
  readonly keyPath: string;
}): IndexedDbRecords<Record> {
  const open = createIndexedDbOpener({
    factory: input.factory,
    name: input.databaseName,
    version: 1,
    upgrade: (database) => database.createObjectStore(input.storeName, { keyPath: input.keyPath }),
    unavailableMessage: `${input.databaseName} is unavailable.`,
  });
  const store = async (mode: IDBTransactionMode) =>
    (await open()).transaction(input.storeName, mode).objectStore(input.storeName);
  return {
    get: async (key) => request((await store("readonly")).get(key)),
    put: async (record) => {
      await request((await store("readwrite")).put(record));
    },
    delete: async (key) => {
      await request((await store("readwrite")).delete(key));
    },
  };
}
