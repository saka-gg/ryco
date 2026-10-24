import { describe, expect, it } from "vite-plus/test";

import type {
  HostedCapabilityKind,
  HostedRpcCapability,
} from "../../authorization/capabilities.ts";
import type { SavedEnvironmentRuntimeState } from "../../connection/catalog.ts";
import { hostedDailyRecapReadiness, savedDailyRecapReadiness } from "./readiness.ts";

function capability(allowed: boolean, kind: HostedCapabilityKind): HostedRpcCapability {
  return { hosted: true, allowed, reason: allowed ? null : "Unavailable.", kind };
}

function runtime(patch: Partial<SavedEnvironmentRuntimeState>): SavedEnvironmentRuntimeState {
  return {
    connectionState: "connected",
    authState: "authenticated",
    lastError: null,
    lastErrorAt: null,
    role: "owner",
    descriptor: null,
    serverConfig: null,
    connectedAt: null,
    disconnectedAt: null,
    ...patch,
  };
}

describe("hosted daily recap readiness", () => {
  it("asks a node whose session allows the recap", () => {
    expect(hostedDailyRecapReadiness(capability(true, "ready"))).toBe("ask");
  });

  it("waits for a session that is still being set up", () => {
    expect(hostedDailyRecapReadiness(capability(false, "establishing"))).toBe("pending");
  });

  it("reports a role that is refused the recap without asking", () => {
    expect(hostedDailyRecapReadiness(capability(false, "role"))).toBe("forbidden");
  });

  it("reports a session that is down as offline", () => {
    expect(hostedDailyRecapReadiness(capability(false, "stale"))).toBe("offline");
    expect(hostedDailyRecapReadiness(capability(false, "delivery-unknown"))).toBe("offline");
  });
});

describe("saved daily recap readiness", () => {
  it("asks a connected node", () => {
    expect(savedDailyRecapReadiness(runtime({}))).toBe("ask");
  });

  it("waits for a node that is connecting or has not reported yet", () => {
    expect(savedDailyRecapReadiness(runtime({ connectionState: "connecting" }))).toBe("pending");
    expect(savedDailyRecapReadiness(undefined)).toBe("pending");
  });

  it("reports a disconnected or failed node as offline", () => {
    expect(savedDailyRecapReadiness(runtime({ connectionState: "disconnected" }))).toBe("offline");
    expect(savedDailyRecapReadiness(runtime({ connectionState: "error" }))).toBe("offline");
  });

  it("keeps a node that dropped offline while it tries to reconnect", () => {
    expect(
      savedDailyRecapReadiness(
        runtime({ connectionState: "connecting", disconnectedAt: "2026-10-24T09:00:00.000Z" }),
      ),
    ).toBe("offline");
  });

  it("reports a client pairing as refused, connected or not", () => {
    expect(savedDailyRecapReadiness(runtime({ role: "client" }))).toBe("forbidden");
    expect(
      savedDailyRecapReadiness(runtime({ role: "client", connectionState: "connecting" })),
    ).toBe("forbidden");
  });
});
