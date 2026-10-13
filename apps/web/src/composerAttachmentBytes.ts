/**
 * Composer draft attachment bytes, kept in IndexedDB by attachment id.
 *
 * Drafts used to keep each image as a base64 data URL inside their
 * localStorage entry: every write re-serialized megabytes, reading it back
 * decoded them on the main thread at boot, and a few large images exhausted
 * the origin's localStorage quota, after which every draft write failed. Here
 * the bytes are stored once as a Blob and the draft entry records only
 * `bytes: "local"`. Blobs read back are backed by the browser's storage, so
 * restoring a draft copies nothing into the JS heap.
 *
 * Not used in hosted mode: hosted drafts are memory-only by design.
 */

const DATABASE_NAME = "ryco-composer-attachments";
const DATABASE_VERSION = 1;
const STORE_NAME = "bytes";

interface StoredAttachmentBytes {
  readonly blob: Blob;
  readonly storedAt: number;
}

export interface ComposerAttachmentBytesStore {
  readonly put: (attachmentId: string, blob: Blob) => Promise<void>;
  /** The stored bytes of each requested id that has any. */
  readonly getMany: (attachmentIds: ReadonlyArray<string>) => Promise<Map<string, Blob>>;
  readonly deleteMany: (attachmentIds: ReadonlyArray<string>) => Promise<void>;
  /** Deletes every entry stored before `storedBefore` whose id `keep` does not contain. */
  readonly deleteUnreferenced: (keep: ReadonlySet<string>, storedBefore: number) => Promise<number>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed.")),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
    );
  });
}

export function createComposerAttachmentBytesStore(
  factory: IDBFactory,
  now: () => number = Date.now,
  databaseName: string = DATABASE_NAME,
): ComposerAttachmentBytesStore {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      });
      request.addEventListener("success", () => {
        const opened = request.result;
        // Another tab upgrading the schema: step aside and reopen on next use.
        opened.addEventListener("versionchange", () => {
          opened.close();
          database = null;
        });
        resolve(opened);
      });
      request.addEventListener("error", () => {
        database = null;
        reject(request.error ?? new Error("IndexedDB is unavailable."));
      });
      request.addEventListener("blocked", () => {
        database = null;
        reject(new Error("IndexedDB open was blocked."));
      });
    });
    return database;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> => {
    const transaction = (await open()).transaction(STORE_NAME, mode);
    const done = transactionDone(transaction);
    const result = await body(transaction.objectStore(STORE_NAME));
    await done;
    return result;
  };

  return {
    put: (attachmentId, blob) =>
      run("readwrite", (store) => {
        store.put({ blob, storedAt: now() } satisfies StoredAttachmentBytes, attachmentId);
      }),
    getMany: (attachmentIds) =>
      attachmentIds.length === 0
        ? Promise.resolve(new Map())
        : run("readonly", async (store) => {
            const entries = await Promise.all(
              attachmentIds.map(
                async (id) =>
                  [
                    id,
                    (await requestResult(store.get(id))) as StoredAttachmentBytes | undefined,
                  ] as const,
              ),
            );
            const blobs = new Map<string, Blob>();
            for (const [id, entry] of entries) {
              if (entry?.blob instanceof Blob) blobs.set(id, entry.blob);
            }
            return blobs;
          }),
    deleteMany: (attachmentIds) =>
      attachmentIds.length === 0
        ? Promise.resolve()
        : run("readwrite", (store) => {
            for (const id of attachmentIds) store.delete(id);
          }),
    deleteUnreferenced: (keep, storedBefore) =>
      run("readwrite", async (store) => {
        let deleted = 0;
        await new Promise<void>((resolve, reject) => {
          const cursorRequest = store.openCursor();
          cursorRequest.addEventListener("error", () =>
            reject(cursorRequest.error ?? new Error("IndexedDB cursor failed.")),
          );
          cursorRequest.addEventListener("success", () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              resolve();
              return;
            }
            const entry = cursor.value as StoredAttachmentBytes | undefined;
            if (
              typeof cursor.key === "string" &&
              !keep.has(cursor.key) &&
              (entry?.storedAt ?? 0) < storedBefore
            ) {
              cursor.delete();
              deleted += 1;
            }
            cursor.continue();
          });
        });
        return deleted;
      }),
  };
}
