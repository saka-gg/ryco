/** Shared IndexedDB open and transaction helpers; page-owned, never used by the service worker. */

/**
 * Opens one database lazily and memoises the connection. A failed or blocked
 * open is forgotten so the next call tries again, an open that succeeds after
 * its attempt was given up as blocked is closed, and a connection that is
 * closed (another context deleting or upgrading the database, or the browser
 * closing it) is dropped so the next call opens a fresh one.
 */
export function createIndexedDbOpener(input: {
  readonly factory: IDBFactory;
  readonly name: string;
  readonly version: number;
  readonly upgrade: (database: IDBDatabase) => void;
  readonly unavailableMessage: string;
}): () => Promise<IDBDatabase> {
  let database: Promise<IDBDatabase> | undefined;
  return () => {
    if (database) return database;
    let settled = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const fail = (error: unknown) => {
        settled = true;
        reject(error);
      };
      const operation = input.factory.open(input.name, input.version);
      operation.addEventListener("upgradeneeded", () => input.upgrade(operation.result), {
        once: true,
      });
      operation.addEventListener(
        "success",
        () => {
          const opened = operation.result;
          // Opened after this attempt was given up as blocked: a retry owns the database now.
          if (settled) {
            opened.close();
            return;
          }
          settled = true;
          const forget = () => {
            opened.close();
            if (database === opening) database = undefined;
          };
          opened.addEventListener("versionchange", forget, { once: true });
          opened.addEventListener("close", forget, { once: true });
          resolve(opened);
        },
        { once: true },
      );
      operation.addEventListener(
        "error",
        () => fail(operation.error ?? new Error(input.unavailableMessage)),
        { once: true },
      );
      operation.addEventListener("blocked", () => fail(new Error(input.unavailableMessage)), {
        once: true,
      });
    });
    database = opening;
    opening.catch(() => {
      if (database === opening) database = undefined;
    });
    return opening;
  };
}

/**
 * Resolves when the transaction completes and rejects when it aborts or fails.
 * Observed at creation, so a caller that throws before awaiting it never leaves
 * an unhandled rejection; awaiting it still rejects.
 */
export function transactionDone(
  transaction: IDBTransaction,
  failureMessage = "IndexedDB transaction failed.",
): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    const fail = () => reject(transaction.error ?? new Error(failureMessage));
    transaction.addEventListener("abort", fail, { once: true });
    transaction.addEventListener("error", fail, { once: true });
  });
  done.catch(() => undefined);
  return done;
}
