import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "~/environments/runtime/catalog";
import { savedBackendNeedsRepair, savedBackendRepairHost } from "./ConnectionsSettings.logic";

const record: SavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Studio Mac",
  httpBaseUrl: "http://192.168.1.20:3773/",
  wsBaseUrl: "ws://192.168.1.20:3773/",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastConnectedAt: "2026-09-30T00:00:00.000Z",
};

function runtime(overrides: Partial<SavedEnvironmentRuntimeState>): SavedEnvironmentRuntimeState {
  return {
    connectionState: "disconnected",
    authState: "unknown",
    lastError: null,
    lastErrorAt: null,
    role: null,
    descriptor: null,
    serverConfig: null,
    connectedAt: null,
    disconnectedAt: null,
    ...overrides,
  };
}

describe("savedBackendNeedsRepair", () => {
  it("offers pairing again once the node rejected the saved pairing", () => {
    expect(savedBackendNeedsRepair(runtime({ authState: "requires-auth" }), record)).toBe(true);
  });

  it("keeps Connect for outages and for SSH environments that mint their own credential", () => {
    expect(savedBackendNeedsRepair(runtime({ connectionState: "error" }), record)).toBe(false);
    expect(savedBackendNeedsRepair(null, record)).toBe(false);
    expect(
      savedBackendNeedsRepair(runtime({ authState: "requires-auth" }), {
        ...record,
        desktopSsh: { alias: "devbox", hostname: "devbox", username: null, port: null },
      }),
    ).toBe(false);
  });
});

describe("savedBackendRepairHost", () => {
  it("prefills the saved origin so only a pairing code is missing", () => {
    expect(savedBackendRepairHost(record)).toBe("http://192.168.1.20:3773");
    expect(
      savedBackendRepairHost({ ...record, httpBaseUrl: "https://studio.tail1234.ts.net/" }),
    ).toBe("https://studio.tail1234.ts.net");
  });
});
