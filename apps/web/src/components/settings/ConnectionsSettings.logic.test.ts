import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "~/environments/runtime/catalog";
import {
  savedBackendConnectionActionLabel,
  savedBackendNeedsRepair,
  savedBackendRepairHost,
  savedPairingLifetimeNote,
} from "./ConnectionsSettings.logic";

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

describe("savedBackendConnectionActionLabel", () => {
  const idle = { isConnected: false, isConnecting: false, isDisconnecting: false };

  it("keeps a retry beside Re-pair for a rejection that was only a passing fault", () => {
    expect(savedBackendConnectionActionLabel({ ...idle, needsRepair: true })).toBe("Retry");
    expect(
      savedBackendConnectionActionLabel({ ...idle, isConnecting: true, needsRepair: false }),
    ).toBe("Connecting…");
  });

  it("connects and disconnects an environment whose pairing still holds", () => {
    expect(savedBackendConnectionActionLabel({ ...idle, needsRepair: false })).toBe("Connect");
    expect(
      savedBackendConnectionActionLabel({ ...idle, isConnected: true, needsRepair: false }),
    ).toBe("Disconnect");
    expect(
      savedBackendConnectionActionLabel({
        ...idle,
        isConnected: true,
        isDisconnecting: true,
        needsRepair: false,
      }),
    ).toBe("Disconnecting…");
  });
});

describe("savedPairingLifetimeNote", () => {
  it("states the lifetime of the store the credential lives in", () => {
    // The desktop app keeps the token in the OS store: the node's own limits.
    expect(savedPairingLifetimeNote("desktop")).toContain(
      "Pair again after 30 days without use, or one year after pairing.",
    );
    // A browser's local storage drops it a week after it was last written.
    expect(savedPairingLifetimeNote("browser")).toContain(
      "Pair again after 7 days without use, or one year after pairing.",
    );
  });
});
