import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createSavedEnvironmentCatalog, type SavedEnvironmentRecord } from "./catalog.ts";

const RECORD: SavedEnvironmentRecord = {
  environmentId: "env-saved" as EnvironmentId,
  label: "Studio Mac",
  wsBaseUrl: "ws://studio.local:3773",
  httpBaseUrl: "http://studio.local:3773",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastConnectedAt: null,
};

function catalogWith(getRegistry: () => Promise<ReadonlyArray<SavedEnvironmentRecord>>) {
  return createSavedEnvironmentCatalog({
    kv: { getRegistry, setRegistry: async () => {} },
    secretKV: { get: async () => null, set: async () => true, remove: async () => {} },
  });
}

/** What `hasHydrated` answered at each notification of either channel. */
function watch(catalog: ReturnType<typeof catalogWith>) {
  const registry: boolean[] = [];
  const hydration: Array<{ hydrated: boolean; records: number }> = [];
  catalog.registryStore.subscribe(() => registry.push(catalog.hasHydrated()));
  catalog.subscribeHydration(() =>
    hydration.push({
      hydrated: catalog.hasHydrated(),
      records: Object.keys(catalog.registryStore.getState().byId).length,
    }),
  );
  return { registry, hydration };
}

describe("saved environment catalog hydration", () => {
  // Views read `hasHydrated` as a `useSyncExternalStore` snapshot, so they need
  // a notification when it flips: without one, a view that only re-reads on a
  // notification (a compiled one) kept showing its loading state. The registry
  // channel must not carry it: the connection supervisor starts a saved sync on
  // every hydrated registry notification and already starts one when
  // hydration resolves, so a second one would queue a back-to-back sync.
  it("notifies hydration subscribers after the records landed, not registry subscribers", async () => {
    const catalog = catalogWith(async () => [RECORD]);
    const seen = watch(catalog);

    await catalog.waitForHydration();

    expect(catalog.registryStore.getState().byId[RECORD.environmentId]).toEqual(RECORD);
    expect(seen.registry).toEqual([false]);
    expect(seen.hydration).toEqual([{ hydrated: true, records: 1 }]);
  });

  it("notifies them when reading the registry failed too", async () => {
    const catalog = catalogWith(async () => {
      throw new Error("keychain locked");
    });
    const seen = watch(catalog);
    const consoleError = console.error;
    console.error = () => {};
    try {
      await catalog.waitForHydration();
    } finally {
      console.error = consoleError;
    }

    expect(seen.registry).toEqual([]);
    expect(seen.hydration).toEqual([{ hydrated: true, records: 0 }]);
  });
});
