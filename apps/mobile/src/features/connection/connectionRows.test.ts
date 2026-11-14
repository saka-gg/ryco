import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
import type { WsConnectionStatus } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The device-offline overlay reads the app lifecycle adapter's module, which
// pulls in React Native; the rows only need its pure status mapping.
vi.mock("../../platform", () => ({ mobileAppLifecycle: {} }));

import { deriveConnectionRows } from "./connectionRows";

const STUDIO = "env-studio" as EnvironmentId;
const LAPTOP = "env-laptop" as EnvironmentId;

function record(environmentId: EnvironmentId, label: string): SavedEnvironmentRecord {
  return {
    environmentId,
    label,
    wsBaseUrl: `ws://${environmentId}:3773`,
    httpBaseUrl: `http://${environmentId}:3773`,
    createdAt: "2026-10-24T00:00:00.000Z",
    lastConnectedAt: null,
  };
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

function status(phase: WsConnectionStatus["phase"]): WsConnectionStatus {
  return {
    attemptCount: 1,
    closeCode: null,
    closeReason: null,
    connectionLabel: null,
    connectedAt: null,
    disconnectedAt: phase === "disconnected" ? "2026-10-24T00:01:00.000Z" : null,
    hasConnected: true,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase,
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
  };
}

const records = { [STUDIO]: record(STUDIO, "Studio"), [LAPTOP]: record(LAPTOP, "laptop") };

function labels(input: Parameters<typeof deriveConnectionRows>[0]) {
  return deriveConnectionRows(input).map((row) => [row.record.label, row.statusLabel]);
}

describe("deriveConnectionRows", () => {
  // Every input is a subscribed snapshot, so each transition below arrives as
  // a new input. The hook used to read the runtime and socket status straight
  // from the stores, which React Compiler cached on the registry alone.
  it("follows a node through dropping, reconnecting and needing re-pair", () => {
    const connected = { [STUDIO]: runtime({}), [LAPTOP]: runtime({}) };
    const live = new Map([
      [STUDIO, status("connected")],
      [LAPTOP, status("connected")],
    ]);
    expect(labels({ records, runtimeById: connected, statuses: live })).toEqual([
      ["laptop", "Connected"],
      ["Studio", "Connected"],
    ]);

    // The studio's socket drops while its runtime still says connected.
    const dropped = new Map(live).set(STUDIO, status("disconnected"));
    expect(labels({ records, runtimeById: connected, statuses: dropped })).toEqual([
      ["laptop", "Connected"],
      ["Studio", "Offline"],
    ]);

    const connecting = { ...connected, [STUDIO]: runtime({ connectionState: "connecting" }) };
    expect(
      labels({
        records,
        runtimeById: connecting,
        statuses: new Map(live).set(STUDIO, status("connecting")),
      }),
    ).toEqual([
      ["laptop", "Connected"],
      ["Studio", "Connecting"],
    ]);

    const revoked = {
      ...connected,
      [STUDIO]: runtime({ connectionState: "error", authState: "requires-auth" }),
    };
    expect(labels({ records, runtimeById: revoked, statuses: dropped })).toEqual([
      ["laptop", "Connected"],
      ["Studio", "Needs re-pair"],
    ]);
  });

  it("lists a switched-off node as switched off, whatever it last reported", () => {
    const rows = deriveConnectionRows({
      records: {
        ...records,
        [STUDIO]: { ...records[STUDIO]!, disabledAt: "2026-10-31T09:00:00.000Z" },
      },
      runtimeById: {
        [STUDIO]: runtime({ connectionState: "error", authState: "requires-auth" }),
        [LAPTOP]: runtime({}),
      },
      statuses: new Map([
        [STUDIO, status("connected")],
        [LAPTOP, status("connected")],
      ]),
    });

    expect(
      rows.map((row) => [
        row.record.label,
        row.statusLabel,
        row.switchedOff,
        row.runtime.connectionState,
      ]),
    ).toEqual([
      ["laptop", "Connected", false, "connected"],
      ["Studio", "Switched off", true, "disconnected"],
    ]);
  });

  it("reads a node the runtime store has not seen as disconnected", () => {
    const rows = deriveConnectionRows({
      records: { [STUDIO]: records[STUDIO]! },
      runtimeById: {},
      statuses: new Map(),
    });

    expect(rows.map((row) => [row.runtime.connectionState, row.statusLabel])).toEqual([
      ["disconnected", "Disconnected"],
    ]);
  });

  it("shows a machine out of reach as offline with a plain sentence, also while it is retried", () => {
    const sentence = "Can't reach this machine. It may be off, asleep or on another network.";
    const unreachable = runtime({
      connectionState: "error",
      lastError: sentence,
      lastErrorKind: "unreachable",
    });
    const statuses = new Map([
      [STUDIO, status("connecting")],
      [LAPTOP, status("connected")],
    ]);
    const failed = deriveConnectionRows({
      records,
      runtimeById: { [STUDIO]: unreachable, [LAPTOP]: runtime({}) },
      statuses,
    });
    expect(failed.map((row) => [row.record.label, row.statusLabel, row.statusDetail])).toEqual([
      ["laptop", "Connected", null],
      ["Studio", "Offline", sentence],
    ]);

    // The backoff tries again: the row stays offline instead of flashing.
    const retrying = deriveConnectionRows({
      records,
      runtimeById: {
        [STUDIO]: { ...unreachable, connectionState: "connecting" },
        [LAPTOP]: runtime({}),
      },
      statuses,
    });
    expect(retrying.map((row) => [row.statusLabel, row.statusDetail])).toEqual([
      ["Connected", null],
      ["Offline", sentence],
    ]);
  });

  it("keeps a socket close reason and unsorted errors out of the row", () => {
    const rows = deriveConnectionRows({
      records,
      runtimeById: {
        [STUDIO]: runtime({ connectionState: "disconnected", lastError: "1006 abnormal" }),
        [LAPTOP]: runtime({ connectionState: "error", lastError: "raw", lastErrorKind: "failed" }),
      },
      statuses: new Map([
        [STUDIO, status("disconnected")],
        [LAPTOP, status("disconnected")],
      ]),
    });
    expect(rows.map((row) => [row.record.label, row.statusLabel, row.statusDetail])).toEqual([
      ["laptop", "Connection failed", "raw"],
      ["Studio", "Disconnected", null],
    ]);
  });
});
