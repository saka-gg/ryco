import type { AdvertisedEndpoint } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  endpointReachabilityHint,
  endpointShareHint,
  isQrShareableEndpoint,
  selectPairingEndpoint,
  selectQrEndpoint,
} from "./advertisedEndpoints.ts";

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

describe("endpoint hints", () => {
  it("names the hosted app only for an HTTPS endpoint it can open", () => {
    const https = endpoint({
      httpBaseUrl: "https://studio.tail.ts.net/",
      compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
      reachability: "private-network",
    });
    expect(endpointShareHint(https)).toBe("Opens the hosted app, no install needed");
    expect(endpointReachabilityHint(https)).toBe("Devices on your private network");
    expect(endpointShareHint(lan)).toBe("Devices on the same network");
  });

  it("names the machine a loopback endpoint stays on", () => {
    expect(endpointReachabilityHint(loopback)).toBe("Clients on this computer");
    expect(endpointReachabilityHint(loopback, "that machine")).toBe("Clients on that machine");
  });
});
