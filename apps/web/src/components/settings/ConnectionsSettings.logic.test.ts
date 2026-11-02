import { type AdvertisedEndpoint, EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "~/environments/runtime/catalog";
import {
  isQrShareableEndpoint,
  savedBackendConnectionActionLabel,
  savedBackendNeedsRepair,
  savedBackendRepairHost,
  savedPairingLifetimeNote,
  selectPairingEndpoint,
  selectQrEndpoint,
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

function endpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:3773",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:3773/",
    wsBaseUrl: "ws://192.168.1.42:3773/",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

const loopback = endpoint({
  id: "desktop-loopback:3773",
  label: "This machine",
  httpBaseUrl: "http://127.0.0.1:3773/",
  wsBaseUrl: "ws://127.0.0.1:3773/",
  reachability: "loopback",
  isDefault: true,
});
const lan = endpoint({});
const tailscaleIp = endpoint({
  id: "tailscale-ip:http://100.84.12.7:3773",
  label: "Tailscale IP",
  provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
  httpBaseUrl: "http://100.84.12.7:3773/",
  wsBaseUrl: "ws://100.84.12.7:3773/",
  reachability: "private-network",
  source: "desktop-addon",
});
const LOOPBACK_DEFAULT_KEY = "desktop-core:loopback:http";

describe("isQrShareableEndpoint", () => {
  it("never offers loopback, by reachability or by address", () => {
    expect(isQrShareableEndpoint(loopback)).toBe(false);
    // A custom endpoint that calls itself LAN but points at this machine.
    expect(isQrShareableEndpoint(endpoint({ httpBaseUrl: "http://localhost:3773/" }))).toBe(false);
    expect(isQrShareableEndpoint(endpoint({ httpBaseUrl: "http://[::1]:3773/" }))).toBe(false);
    expect(isQrShareableEndpoint(endpoint({ httpBaseUrl: "http://0.0.0.0:3773/" }))).toBe(false);
  });

  it("keeps reachable endpoints and drops unavailable ones", () => {
    expect(isQrShareableEndpoint(lan)).toBe(true);
    expect(isQrShareableEndpoint(tailscaleIp)).toBe(true);
    expect(isQrShareableEndpoint(endpoint({ status: "unavailable" }))).toBe(false);
  });
});

describe("selectQrEndpoint", () => {
  it("skips a saved loopback default and picks the LAN endpoint for the QR", () => {
    // The row's link keeps the owner's default; only the QR code moves off loopback.
    expect(selectPairingEndpoint([loopback, lan], LOOPBACK_DEFAULT_KEY)?.id).toBe(loopback.id);
    expect(
      selectQrEndpoint([loopback, lan, tailscaleIp], { defaultEndpointKey: LOOPBACK_DEFAULT_KEY }),
    ).toEqual({ endpoint: lan, qrShareable: true });
  });

  it("returns null when only loopback endpoints exist", () => {
    expect(selectQrEndpoint([loopback], { defaultEndpointKey: LOOPBACK_DEFAULT_KEY })).toBeNull();
    expect(selectQrEndpoint([], {})).toBeNull();
  });

  it("marks an explicit loopback pick as not shareable", () => {
    expect(selectQrEndpoint([loopback, lan], { selectedId: loopback.id })).toEqual({
      endpoint: loopback,
      qrShareable: false,
    });
  });

  it("honours an explicit pick, then a shareable saved default, and drops a stale pick", () => {
    expect(selectQrEndpoint([lan, tailscaleIp], { selectedId: tailscaleIp.id })?.endpoint).toBe(
      tailscaleIp,
    );
    expect(
      selectQrEndpoint([lan, tailscaleIp], { defaultEndpointKey: "tailscale:ip:http" })?.endpoint,
    ).toBe(tailscaleIp);
    expect(selectQrEndpoint([lan, tailscaleIp], { selectedId: "gone" })?.endpoint).toBe(lan);
  });
});
