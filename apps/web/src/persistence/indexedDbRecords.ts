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
  let database: Promise<IDBDatabase> | undefined;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const operation = input.factory.open(input.databaseName, 1);
      operation.addEventListener(
        "upgradeneeded",
        () => operation.result.createObjectStore(input.storeName, { keyPath: input.keyPath }),
        { once: true },
      );
      operation.addEventListener(
        "success",
        () => {
          operation.result.addEventListener("versionchange", () => operation.result.close(), {
            once: true,
          });
          resolve(operation.result);
        },
        { once: true },
      );
      operation.addEventListener("error", () => reject(operation.error), { once: true });
      operation.addEventListener(
        "blocked",
        () => reject(new Error(`${input.databaseName} is unavailable.`)),
        { once: true },
      );
    }).catch((error: unknown) => {
      database = undefined;
      throw error;
    }));
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
