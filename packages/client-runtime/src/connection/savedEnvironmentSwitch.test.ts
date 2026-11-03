import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createSavedEnvironmentCatalog,
  isSavedEnvironmentSwitchedOff,
  type SavedEnvironmentRecord,
} from "./catalog.ts";
import { switchSavedEnvironment } from "./savedEnvironmentSwitch.ts";

const RECORD: SavedEnvironmentRecord = {
  environmentId: "env-saved" as EnvironmentId,
  label: "Studio Mac",
  wsBaseUrl: "ws://studio.local:3773",
  httpBaseUrl: "http://studio.local:3773",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastConnectedAt: null,
};

describe("switching a saved machine off", () => {
  const LINKED: SavedEnvironmentRecord = {
    ...RECORD,
    environmentId: "env-linked" as EnvironmentId,
    hubLink: { hubEnvironmentId: "env_hub", linkedAt: "2026-10-29T00:00:00.000Z" },
  };
  const OFF_AT = "2026-10-31T09:00:00.000Z";

  function catalogKeeping(stored: ReadonlyArray<SavedEnvironmentRecord>) {
    const writes: Array<ReadonlyArray<SavedEnvironmentRecord>> = [];
    const secrets = new Map<string, string>([[RECORD.environmentId, "bearer-token"]]);
    const catalog = createSavedEnvironmentCatalog({
      kv: {
        getRegistry: async () => stored,
        setRegistry: async (records) => {
          writes.push(records);
        },
      },
      secretKV: {
        get: async (key) => secrets.get(key) ?? null,
        set: async (key, value) => {
          secrets.set(key, value);
          return true;
        },
        remove: async (key) => {
          secrets.delete(key);
        },
      },
    });
    return { catalog, writes };
  }

  it("stores when it went off and keeps the machine listed with its credential", async () => {
    const { catalog, writes } = catalogKeeping([RECORD]);
    await catalog.waitForHydration();

    switchSavedEnvironment(catalog.registryStore, RECORD.environmentId, false, OFF_AT);

    const off = catalog.get(RECORD.environmentId);
    expect(off).toEqual({ ...RECORD, disabledAt: OFF_AT });
    expect(isSavedEnvironmentSwitchedOff(off)).toBe(true);
    expect(catalog.list()).toEqual([off]);
    expect(writes.at(-1)).toEqual([off]);
    expect(await catalog.readBearerToken(RECORD.environmentId)).toBe("bearer-token");

    switchSavedEnvironment(catalog.registryStore, RECORD.environmentId, true);
    expect(catalog.get(RECORD.environmentId)).toEqual(RECORD);
    expect(writes.at(-1)).toEqual([RECORD]);
  });

  it("stays off across a rename, a connect stamp and the next launch", async () => {
    const { catalog } = catalogKeeping([{ ...RECORD, disabledAt: OFF_AT }]);
    await catalog.waitForHydration();
    expect(isSavedEnvironmentSwitchedOff(catalog.get(RECORD.environmentId))).toBe(true);

    catalog.registryStore.getState().rename(RECORD.environmentId, "Renamed");
    catalog.registryStore.getState().markConnected(RECORD.environmentId, OFF_AT);
    // Switching off again keeps the first time.
    switchSavedEnvironment(catalog.registryStore, RECORD.environmentId, false);
    expect(catalog.get(RECORD.environmentId)).toMatchObject({
      label: "Renamed",
      disabledAt: OFF_AT,
    });
  });

  it("is switched on by pairing the machine again", async () => {
    const { catalog } = catalogKeeping([{ ...RECORD, disabledAt: OFF_AT }]);
    await catalog.waitForHydration();

    catalog.registryStore.getState().upsert({ ...RECORD, lastConnectedAt: OFF_AT });
    expect(isSavedEnvironmentSwitchedOff(catalog.get(RECORD.environmentId))).toBe(false);
  });

  it("gives a Hub-linked route no switch", async () => {
    const { catalog, writes } = catalogKeeping([RECORD, LINKED]);
    await catalog.waitForHydration();

    switchSavedEnvironment(catalog.registryStore, LINKED.environmentId, false, OFF_AT);
    expect(catalog.getLinked(LINKED.environmentId)).toEqual(LINKED);
    expect(writes).toEqual([]);
  });
});
