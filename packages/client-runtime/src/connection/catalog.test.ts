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

describe("Hub-linked direct access in the saved catalog", () => {
  const LINKED: SavedEnvironmentRecord = {
    environmentId: "env-direct" as EnvironmentId,
    label: "Studio Mac",
    wsBaseUrl: "ws://100.64.1.2:3773",
    httpBaseUrl: "http://100.64.1.2:3773",
    createdAt: "2026-10-24T00:00:00.000Z",
    lastConnectedAt: null,
    hubLink: { hubEnvironmentId: "env_hub", linkedAt: "2026-10-29T00:00:00.000Z" },
  };

  function catalogKeeping(stored: ReadonlyArray<SavedEnvironmentRecord>) {
    const writes: Array<ReadonlyArray<SavedEnvironmentRecord>> = [];
    const catalog = createSavedEnvironmentCatalog({
      kv: {
        getRegistry: async () => stored,
        setRegistry: async (records) => {
          writes.push(records);
        },
      },
      secretKV: { get: async () => null, set: async () => true, remove: async () => {} },
    });
    return { catalog, writes };
  }

  // A linked record is a route of its Hub machine: listing or connecting
  // environments must never see it, or the machine shows twice.
  it("keeps linked records out of the environments and stores both lists together", async () => {
    const { catalog, writes } = catalogKeeping([RECORD, LINKED]);
    await catalog.waitForHydration();

    expect(Object.keys(catalog.registryStore.getState().byId)).toEqual([RECORD.environmentId]);
    expect(catalog.list().map((record) => record.environmentId)).toEqual([RECORD.environmentId]);
    expect(catalog.get(LINKED.environmentId)).toBeNull();
    expect(catalog.listLinked()).toEqual([LINKED]);
    expect(catalog.getLinked(LINKED.environmentId)).toEqual(LINKED);

    catalog.registryStore.getState().rename(RECORD.environmentId, "Renamed");
    expect(
      writes
        .at(-1)
        ?.map((record) => record.environmentId)
        .toSorted(),
    ).toEqual([RECORD.environmentId, LINKED.environmentId].toSorted());
    await catalog.persistRecord({ ...LINKED, label: "Relinked" });
    expect(
      writes.at(-1)?.find((record) => record.environmentId === LINKED.environmentId)?.label,
    ).toBe("Relinked");
  });

  it("moves a direct id between the lists when it is linked or paired by hand", () => {
    const { catalog } = catalogKeeping([]);
    catalog.registryStore.getState().upsert({ ...LINKED, hubLink: undefined });
    expect(catalog.get(LINKED.environmentId)).not.toBeNull();

    catalog.registryStore.getState().upsert(LINKED);
    expect(catalog.get(LINKED.environmentId)).toBeNull();
    expect(catalog.getLinked(LINKED.environmentId)).toEqual(LINKED);

    catalog.registryStore.getState().remove(LINKED.environmentId);
    expect(catalog.listLinked()).toEqual([]);
  });

  it("lets a record written this session win over its stored copy, in either list", async () => {
    const { catalog } = catalogKeeping([{ ...LINKED, label: "Stored" }]);
    catalog.registryStore.getState().upsert({ ...LINKED, label: "Fresh" });
    await catalog.waitForHydration();
    expect(catalog.getLinked(LINKED.environmentId)?.label).toBe("Fresh");
  });
});
