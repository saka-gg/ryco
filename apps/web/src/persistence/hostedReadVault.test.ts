import { describe, expect, it } from "vite-plus/test";

import { createHostedReadVault } from "./hostedReadVault";

// A failed first open must not disable the remembered-browser vault for the session. The real
// IndexedDB round trips are in browser/hostedReadVault.browser.tsx; these drive the open
// outcomes a real browser rarely produces on demand.

class FakeRequest extends EventTarget {
  result: unknown = undefined;
  error: unknown = null;
  succeed(result: unknown): void {
    this.result = result;
    this.dispatchEvent(new Event("success"));
  }
}

function fakeDatabase() {
  const database = {
    closed: false,
    close() {
      database.closed = true;
    },
    addEventListener() {},
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const read = new FakeRequest();
          queueMicrotask(() => read.succeed(undefined));
          return read;
        },
      }),
    }),
  };
  return database;
}

type OpenOutcome = (request: FakeRequest) => void;

function fakeFactory(outcomes: OpenOutcome[]) {
  const requests: FakeRequest[] = [];
  const factory = {
    open: () => {
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("No open expected.");
      const request = new FakeRequest();
      requests.push(request);
      queueMicrotask(() => outcome(request));
      return request;
    },
  };
  return { factory: factory as unknown as IDBFactory, requests };
}

const fail: OpenOutcome = (request) => {
  request.error = new Error("Open failed.");
  request.dispatchEvent(new Event("error"));
};
const block: OpenOutcome = (request) => request.dispatchEvent(new Event("blocked"));
const openWith =
  (database: ReturnType<typeof fakeDatabase>): OpenOutcome =>
  (request) =>
    request.succeed(database);

const vaultOver = (factory: IDBFactory) =>
  createHostedReadVault(factory, globalThis.crypto, "https://app.example.test", "vault-test");

describe("hosted read vault open", () => {
  it("opens again after a failed first open", async () => {
    const database = fakeDatabase();
    const { factory, requests } = fakeFactory([fail, openWith(database)]);
    const vault = vaultOver(factory);

    await expect(vault.account("account-a", false)).rejects.toThrow("Open failed.");
    await expect(vault.account("account-a", false)).resolves.toBeNull();
    expect(requests).toHaveLength(2);
    // The opened connection is kept: no third open.
    await expect(vault.account("account-a", false)).resolves.toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("opens again after a blocked open, closing the blocked one if it opens late", async () => {
    const late = fakeDatabase();
    const current = fakeDatabase();
    const { factory, requests } = fakeFactory([block, openWith(current)]);
    const vault = vaultOver(factory);

    await expect(vault.account("account-a", false)).rejects.toThrow("Read cache is unavailable.");
    requests[0]!.succeed(late);
    expect(late.closed).toBe(true);
    await expect(vault.account("account-a", false)).resolves.toBeNull();
    expect(current.closed).toBe(false);
  });

  it("opens again after the factory throws", async () => {
    const database = fakeDatabase();
    let first = true;
    const { factory: inner } = fakeFactory([openWith(database)]);
    const factory = {
      open: (...args: Parameters<IDBFactory["open"]>) => {
        if (first) {
          first = false;
          throw new Error("Storage is disabled.");
        }
        return inner.open(...args);
      },
    } as unknown as IDBFactory;
    const vault = vaultOver(factory);

    await expect(vault.account("account-a", false)).rejects.toThrow("Storage is disabled.");
    await expect(vault.account("account-a", false)).resolves.toBeNull();
  });
});
