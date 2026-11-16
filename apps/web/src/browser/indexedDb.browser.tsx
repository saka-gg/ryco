import { describe, expect, it, vi } from "vitest";
import { createIndexedDbOpener, transactionDone } from "../persistence/indexedDb";

const deleteDatabase = (name: string) =>
  new Promise<void>((resolve, reject) => {
    const operation = indexedDB.deleteDatabase(name);
    operation.addEventListener("success", () => resolve(), { once: true });
    operation.addEventListener("error", () => reject(operation.error), { once: true });
  });

const opener = (name: string) =>
  createIndexedDbOpener({
    factory: indexedDB,
    name,
    version: 1,
    upgrade: (database) => database.createObjectStore("s"),
    unavailableMessage: "x",
  });

describe("shared IndexedDB helpers", () => {
  it("opens again after another context deletes the database", async () => {
    const name = `idb-test-${crypto.randomUUID()}`;
    const open = opener(name);
    const first = await open();
    await deleteDatabase(name);
    const second = await open();
    expect(second).not.toBe(first);
    const write = second.transaction("s", "readwrite");
    const done = transactionDone(write);
    write.objectStore("s").put("value", "k");
    await done;
    const read = second.transaction("s").objectStore("s").get("k");
    const value = await new Promise((resolve) =>
      read.addEventListener("success", () => resolve(read.result), { once: true }),
    );
    expect(value).toBe("value");
    second.close();
    await deleteDatabase(name);
  });

  it("a failed transaction left unawaited raises no unhandled rejection", async () => {
    const name = `idb-test-${crypto.randomUUID()}`;
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    try {
      const database = await opener(name)();
      const tx = database.transaction("s", "readwrite");
      const done = transactionDone(tx);
      const store = tx.objectStore("s");
      store.add(1, "k");
      const duplicate = store.add(2, "k");
      await new Promise<void>((resolve) =>
        duplicate.addEventListener(
          "error",
          () => {
            resolve();
          },
          { once: true },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(done).rejects.toBeDefined();
      database.close();
      await deleteDatabase(name);
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });
});
