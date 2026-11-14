import { describe, expect, it, vi } from "vite-plus/test";

// The device stores are native modules; these tests hand the adapter their own KV.
vi.mock("../platform", () => ({ mobileKV: {}, mobileSecretKV: {} }));

const { createMobileSavedEnvironmentKV } = await import("./catalog");

const RECORD = {
  environmentId: "env-studio",
  label: "Studio Mac",
  wsBaseUrl: "ws://studio.local:3773",
  httpBaseUrl: "http://studio.local:3773",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastConnectedAt: null,
};

function registryKV(raw: string | null) {
  return createMobileSavedEnvironmentKV({
    getItem: async () => raw,
    setItem: async () => undefined,
  });
}

describe("the phone's saved environment registry", () => {
  it("reads every record an earlier build wrote", async () => {
    const linked = {
      ...RECORD,
      environmentId: "env-linked",
      hubLink: { hubEnvironmentId: "hub-1", linkedAt: "2026-10-31T09:00:00.000Z" },
      disabledAt: "2026-11-01T09:00:00.000Z",
    };
    expect(await registryKV(JSON.stringify([RECORD, linked])).getRegistry()).toEqual([
      RECORD,
      linked,
    ]);
  });

  it("leaves out a record it cannot read instead of handing it to the catalog", async () => {
    const stored = [RECORD, { ...RECORD, environmentId: "env-no-url", wsBaseUrl: null }, 7];
    expect(await registryKV(JSON.stringify(stored)).getRegistry()).toEqual([RECORD]);
  });

  it("reads a missing, corrupt or non-list registry as empty", async () => {
    for (const raw of [null, "", "{", JSON.stringify({ records: [RECORD] })]) {
      expect(await registryKV(raw).getRegistry()).toEqual([]);
    }
  });
});
