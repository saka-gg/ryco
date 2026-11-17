import type { SavedEnvironmentRuntimeState } from "@ryco/client-runtime/connection";
import {
  getReportedThreadCapabilitiesSnapshot,
  getShellSettlementRulesSnapshot,
} from "@ryco/client-runtime/rpc";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildInboxSidebarEnvironments } from "./inboxSidebarModel";
import {
  createSavedEnvironmentReconnectGrace,
  SAVED_ENVIRONMENT_RECONNECT_GRACE_MS,
} from "./savedEnvironmentReconnectGrace";

const ENV_A = EnvironmentId.make("machine-a");
const ENV_B = EnvironmentId.make("machine-b");

describe("createSavedEnvironmentReconnectGrace", () => {
  const T0 = Date.parse("2026-11-17T10:00:00.000Z");
  const GRACE = SAVED_ENVIRONMENT_RECONNECT_GRACE_MS;
  const state = (
    overrides: Partial<SavedEnvironmentRuntimeState>,
  ): SavedEnvironmentRuntimeState => ({
    connectionState: "connected",
    authState: "authenticated",
    lastError: null,
    lastErrorAt: null,
    role: "owner",
    descriptor: null,
    serverConfig: null,
    connectedAt: "2026-11-17T08:00:00.000Z",
    disconnectedAt: null,
    ...overrides,
  });
  const iso = (ms: number) => new Date(ms).toISOString();
  const SOCKET_ERROR = "Unable to connect to the Ryco server WebSocket.";

  it("starts a grace when it sees a live connection drop, and ends it in time", () => {
    const grace = createSavedEnvironmentReconnectGrace();
    expect(grace({ [ENV_A]: state({}) }, T0).size).toBe(0);
    // The drop's own socket error came before the sidebar saw the drop.
    const dropped = {
      [ENV_A]: state({
        connectionState: "disconnected",
        lastError: SOCKET_ERROR,
        lastErrorAt: iso(T0 + 900),
        disconnectedAt: iso(T0 + 900),
      }),
    };
    expect(grace(dropped, T0 + 1_000).get(ENV_A)).toBe(T0 + 1_000 + GRACE);
    // Rebuilding with the same states keeps the drop's time.
    expect(grace(dropped, T0 + 1_500).get(ENV_A)).toBe(T0 + 1_000 + GRACE);
    const retrying = { [ENV_A]: state({ connectionState: "connecting" }) };
    expect(grace(retrying, T0 + 2_000).get(ENV_A)).toBe(T0 + 1_000 + GRACE);
    expect(grace(retrying, T0 + 1_000 + GRACE).has(ENV_A)).toBe(false);
  });

  it("gives no grace to a machine it never saw connected", () => {
    const grace = createSavedEnvironmentReconnectGrace();
    expect(grace({ [ENV_A]: state({ connectionState: "connecting" }) }, T0).size).toBe(0);
    expect(grace({ [ENV_A]: state({ connectionState: "error" }) }, T0 + 500).size).toBe(0);
  });

  it("ends the grace at the first retry failure not known to be anything but unreachable", () => {
    const grace = createSavedEnvironmentReconnectGrace();
    grace({ [ENV_A]: state({}) }, T0);
    expect(grace({ [ENV_A]: state({ connectionState: "connecting" }) }, T0 + 100).size).toBe(1);
    const failed = state({
      connectionState: "disconnected",
      lastError: SOCKET_ERROR,
      lastErrorAt: iso(T0 + 1_100),
    });
    expect(grace({ [ENV_A]: failed }, T0 + 1_200).size).toBe(0);
    // Connecting cleared the error: the next attempt still reads offline.
    expect(grace({ [ENV_A]: state({ connectionState: "connecting" }) }, T0 + 3_000).size).toBe(0);
    // A live connection again starts over.
    grace({ [ENV_A]: state({}) }, T0 + 4_000);
    expect(grace({ [ENV_A]: state({ connectionState: "error" }) }, T0 + 5_000).get(ENV_A)).toBe(
      T0 + 5_000 + GRACE,
    );
  });

  it("keeps the grace through a failure known not to be unreachable", () => {
    const grace = createSavedEnvironmentReconnectGrace();
    grace({ [ENV_A]: state({}), [ENV_B]: state({}) }, T0);
    const failedAt = iso(T0 + 1_100);
    const until = grace(
      {
        [ENV_A]: state({
          connectionState: "error",
          lastErrorAt: failedAt,
          lastErrorKind: "timed-out",
        }),
        [ENV_B]: state({
          connectionState: "error",
          lastErrorAt: failedAt,
          lastErrorKind: "unreachable",
        }),
      },
      T0 + 1_000,
    );
    expect(until.get(ENV_A)).toBe(T0 + 1_000 + GRACE);
    expect(until.has(ENV_B)).toBe(false);
  });

  it("feeds the saved machines' environments", () => {
    const grace = createSavedEnvironmentReconnectGrace();
    const sources = (runtime: SavedEnvironmentRuntimeState, nowMs: number) =>
      buildInboxSidebarEnvironments({
        knownEnvironmentIds: [ENV_A],
        primary: {
          environmentId: ENV_B,
          label: "This Mac",
          connectionState: "connected",
          descriptor: null,
          serverConfig: null,
        },
        hosted: null,
        desktopWorkspace: null,
        savedEnvironmentRegistry: { [ENV_A]: { label: "Studio Mac" } },
        savedEnvironmentRuntimeById: { [ENV_A]: runtime },
        savedEnvironmentReconnectingUntilMs: grace({ [ENV_A]: runtime }, nowMs),
        cacheHydratedEnvironmentIds: new Set(),
        reportedThreadCapabilities: getReportedThreadCapabilitiesSnapshot(),
        shellSettlementRules: getShellSettlementRulesSnapshot(),
      }).find((environment) => environment.environmentId === ENV_A);
    expect(sources(state({}), T0)?.reconnectingUntilMs).toBeUndefined();
    expect(sources(state({ connectionState: "error" }), T0 + 1_000)).toMatchObject({
      connectionState: "reconnecting",
      reconnectingUntilMs: T0 + 1_000 + GRACE,
    });
  });
});
