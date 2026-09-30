import type { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atomRegistry.ts";
import {
  clearWsConnectionStatusForEnvironment,
  getWsConnectionStatus,
  getWsConnectionStatusForEnvironment,
  getPersistentWsReconnectDelayMs,
  getWsReconnectDelayMsForRetry,
  getWsConnectionUiState,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
  WS_RECONNECT_MAX_ATTEMPTS,
  wsConnectionOpenedCountAtom,
} from "./wsConnectionState.ts";

describe("wsConnectionState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a disconnected browser as offline once the websocket drops", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed({ code: 1006, reason: "offline" });
    setBrowserOnlineStatus(false);

    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("offline");
  });

  it("stays in the initial connecting state until the first disconnect", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");

    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      hasConnected: false,
      phase: "connecting",
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("connecting");
  });

  it("schedules the next retry after a failed websocket attempt", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the Ryco server WebSocket.");

    const firstRetryDelayMs = getWsReconnectDelayMsForRetry(0);
    if (firstRetryDelayMs === null) {
      throw new Error("Expected an initial retry delay.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Remote Mac",
      nextRetryAt: new Date(Date.now() + firstRetryDelayMs).toISOString(),
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
  });

  it("adds a version mismatch hint to websocket errors when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the Ryco server WebSocket.", {
      versionMismatchHint: "Version mismatch. Try syncing the client and server.",
    });

    expect(getWsConnectionStatus()).toMatchObject({
      lastError:
        "Unable to connect to the Ryco server WebSocket. Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("adds a version mismatch hint to websocket close reasons when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed(
      { code: 1006, reason: "socket closed" },
      {
        versionMismatchHint: "Version mismatch. Try syncing the client and server.",
      },
    );

    expect(getWsConnectionStatus()).toMatchObject({
      closeReason: "socket closed Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("marks the reconnect cycle as exhausted after the final attempt fails", () => {
    for (let attempt = 0; attempt < WS_RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionErrored("Unable to connect to the Ryco server WebSocket.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      nextRetryAt: null,
      reconnectAttemptCount: WS_RECONNECT_MAX_ATTEMPTS,
      reconnectPhase: "exhausted",
    });
  });
});

describe("per-environment wsConnectionState", () => {
  const ENV_A = "environment-a" as EnvironmentId;
  const ENV_B = "environment-b" as EnvironmentId;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps two environments' statuses independent — neither clobbers the other", () => {
    recordWsConnectionAttempt("ws://node-a:13773/ws", { environmentId: ENV_A });
    recordWsConnectionOpened({ environmentId: ENV_A });
    recordWsConnectionAttempt("ws://node-b:13774/ws", { environmentId: ENV_B });
    recordWsConnectionOpened({ environmentId: ENV_B });
    recordWsConnectionClosed({ code: 1006, reason: "server stopped" }, { environmentId: ENV_B });

    expect(getWsConnectionStatusForEnvironment(ENV_A)).toMatchObject({
      phase: "connected",
      socketUrl: "ws://node-a:13773/ws",
    });
    expect(getWsConnectionStatusForEnvironment(ENV_B)).toMatchObject({
      phase: "disconnected",
      closeCode: 1006,
    });
  });

  it("keeps the global status writing exactly as before (last writer wins)", () => {
    recordWsConnectionAttempt("ws://node-a:13773/ws", { environmentId: ENV_A });
    recordWsConnectionOpened({ environmentId: ENV_A });
    recordWsConnectionAttempt("ws://node-b:13774/ws", { environmentId: ENV_B });

    expect(getWsConnectionStatus()).toMatchObject({
      phase: "connecting",
      socketUrl: "ws://node-b:13774/ws",
    });
  });

  it("treats an environment that never recorded as not connected", () => {
    recordWsConnectionAttempt("ws://node-b:13774/ws", { environmentId: ENV_B });
    recordWsConnectionOpened({ environmentId: ENV_B });

    expect(getWsConnectionStatusForEnvironment(ENV_A).phase).toBe("idle");
    expect(getWsConnectionUiState(getWsConnectionStatusForEnvironment(ENV_A))).not.toBe(
      "connected",
    );
  });

  it("clears a disposed environment's slot so it cannot linger connected", () => {
    recordWsConnectionAttempt("ws://node-a:13773/ws", { environmentId: ENV_A });
    recordWsConnectionOpened({ environmentId: ENV_A });
    expect(getWsConnectionStatusForEnvironment(ENV_A).phase).toBe("connected");

    clearWsConnectionStatusForEnvironment(ENV_A);

    expect(getWsConnectionStatusForEnvironment(ENV_A).phase).toBe("idle");
  });

  it("bumps the opened counter on every open, from any environment", () => {
    recordWsConnectionAttempt("ws://node-a:13773/ws", { environmentId: ENV_A });
    recordWsConnectionOpened({ environmentId: ENV_A });
    recordWsConnectionAttempt("ws://node-b:13774/ws", { environmentId: ENV_B });
    recordWsConnectionOpened({ environmentId: ENV_B });

    expect(appAtomRegistry.get(wsConnectionOpenedCountAtom)).toBe(2);
  });

  it("propagates device-level online status into every environment slot", () => {
    recordWsConnectionAttempt("ws://node-a:13773/ws", { environmentId: ENV_A });
    recordWsConnectionOpened({ environmentId: ENV_A });
    recordWsConnectionClosed({ code: 1006, reason: "offline" }, { environmentId: ENV_A });
    setBrowserOnlineStatus(false);

    expect(getWsConnectionStatusForEnvironment(ENV_A).online).toBe(false);
    expect(getWsConnectionUiState(getWsConnectionStatusForEnvironment(ENV_A))).toBe("offline");
  });

  it("records without an environmentId leave keyed slots untouched", () => {
    recordWsConnectionAttempt("ws://node-a:13773/ws", { environmentId: ENV_A });
    recordWsConnectionOpened({ environmentId: ENV_A });
    // A legacy single-connection socket (web/desktop) records globally only.
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionClosed({ code: 1006, reason: "gone" });

    expect(getWsConnectionStatusForEnvironment(ENV_A).phase).toBe("connected");
  });

  it("never exhausts a persistently reconnecting environment", () => {
    const environmentId = "env-persistent" as EnvironmentId;
    const metadata = { environmentId, recordGlobal: false, persistentReconnect: true } as const;
    for (let attempt = 0; attempt < WS_RECONNECT_MAX_ATTEMPTS + 4; attempt += 1) {
      recordWsConnectionAttempt("ws://remote:3773/ws", metadata);
      recordWsConnectionErrored("Unable to connect to the Ryco server WebSocket.", metadata);
      recordWsConnectionClosed({ code: 1006, reason: "" }, metadata);
    }

    expect(getWsConnectionStatusForEnvironment(environmentId).reconnectPhase).toBe("waiting");
    expect(getPersistentWsReconnectDelayMs(20)).toBe(60_000);
  });

  it("keeps a secondary environment out of the global status", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    const environmentId = "env-secondary" as EnvironmentId;
    const metadata = { environmentId, recordGlobal: false } as const;

    recordWsConnectionAttempt("ws://remote:3773/ws", metadata);
    recordWsConnectionErrored("Unable to connect to the Ryco server WebSocket.", metadata);

    expect(getWsConnectionStatus().phase).toBe("connected");
    expect(getWsConnectionStatusForEnvironment(environmentId).phase).toBe("disconnected");
  });
});
