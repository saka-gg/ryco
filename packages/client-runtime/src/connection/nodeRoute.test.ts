import { describe, expect, it } from "vite-plus/test";

import type { HostedConnectionStatusInput } from "../authorization/connectionStatus.ts";
import { hostedOutageFailure } from "../authorization/hostedEnvironmentSessions.ts";
import { describeOfflineSince, diagnoseNodeRoute, type NodeRouteInput } from "./nodeRoute.ts";

const NOW = new Date(2026, 9, 31, 15, 30).getTime();
const at = (hours: number, minutes: number, dayOffset = 0) =>
  new Date(2026, 9, 31 + dayOffset, hours, minutes).getTime();

const online: HostedConnectionStatusInput = {
  browserStatus: "current",
  sessionStatus: "ready",
  selectionStatus: "online",
  transportStatus: "online",
};
const reconnecting: HostedConnectionStatusInput = {
  ...online,
  sessionStatus: "closed",
  transportStatus: "reconnecting",
};

const hub = (overrides: Partial<NodeRouteInput>): NodeRouteInput => ({
  nodeLabel: "Studio",
  via: "hub",
  status: online,
  presence: { online: true, lastHeartbeatAt: NOW - 10_000 },
  nowMs: NOW,
  ...overrides,
});

const results = (input: NodeRouteInput) =>
  diagnoseNodeRoute(input).hops.map(({ hop, result }) => `${hop}:${result}`);

describe("diagnoseNodeRoute", () => {
  it("fails the device hop when this device is offline", () => {
    const input = hub({ status: { ...reconnecting, browserStatus: "offline" } });
    expect(diagnoseNodeRoute(input).headline).toBe("This device is offline");
    expect(results(input)).toEqual([
      "device:failed",
      "hub:unchecked",
      "node:unchecked",
      "access:unchecked",
    ]);
  });

  it("fails the Hub hop on a DNS outage and says so", () => {
    const input = hub({ status: reconnecting, outageFailure: "dns" });
    expect(diagnoseNodeRoute(input).headline).toBe("Can't reach the Hub (DNS)");
    expect(results(input)).toEqual([
      "device:ok",
      "hub:failed",
      "node:unchecked",
      "access:unchecked",
    ]);
  });

  it("fails the node hop since its last heartbeat when the directory has it offline", () => {
    const lastHeartbeatAt = at(14, 2);
    const diagnosis = diagnoseNodeRoute(
      hub({ status: reconnecting, presence: { online: false, lastHeartbeatAt } }),
    );
    expect(diagnosis.headline).toBe("Studio is offline since 14:02");
    expect(diagnosis.since).toBe(lastHeartbeatAt);
    expect(diagnosis.hops.map((hop) => hop.result)).toEqual(["ok", "ok", "failed", "unchecked"]);
  });

  it("names a draining node as restarting", () => {
    expect(
      diagnoseNodeRoute(hub({ status: reconnecting, outageFailure: "draining" })).headline,
    ).toBe("Studio is restarting");
  });

  it("fails the access hop when the node no longer accepts this device", () => {
    for (const input of [
      hub({ status: { ...reconnecting, selectionStatus: "revoked" } }),
      hub({ status: reconnecting, outageFailure: "authorization-removed" }),
      hub({ revoked: true }),
    ]) {
      expect(diagnoseNodeRoute(input).headline).toBe("Studio did not accept this device");
      expect(results(input).at(-1)).toBe("access:failed");
    }
    expect(
      diagnoseNodeRoute(hub({ status: { ...online, selectionStatus: "incompatible" } })).headline,
    ).toBe("Studio and this device run Ryco versions that can't connect");
  });

  it("reports no failure when everything answers, and keeps a freeze as a second sentence", () => {
    const diagnosis = diagnoseNodeRoute(
      hub({
        lastEventLoopStall: {
          startedAt: new Date(at(15, 28)).toISOString(),
          durationMs: 12_000,
        },
      }),
    );
    expect(diagnosis.headline).toBeNull();
    expect(diagnosis.hops.every((hop) => hop.result === "ok")).toBe(true);
    expect(diagnosis.freezeNotice).toBe("Froze for 12 s at 15:28");
  });

  it("leaves hops unchecked while a connection is still on its way", () => {
    expect(results(hub({ status: { ...reconnecting, browserStatus: "checking-access" } }))).toEqual(
      ["device:ok", "hub:unchecked", "node:unchecked", "access:unchecked"],
    );
  });

  it("never reports a Hub hop on a direct route", () => {
    const direct: NodeRouteInput = {
      nodeLabel: "Studio",
      via: "direct",
      status: null,
      outageFailure: "dns",
      nowMs: NOW,
    };
    expect(results(direct)).toEqual(["device:ok", "node:unchecked", "access:unchecked"]);
    expect(diagnoseNodeRoute(direct).headline).toBeNull();
    expect(results({ ...direct, directConnected: true })).toEqual([
      "device:ok",
      "node:ok",
      "access:ok",
    ]);
    expect(diagnoseNodeRoute({ ...direct, deviceOffline: true }).headline).toBe(
      "This device is offline",
    );
  });
});

describe("diagnoseNodeRoute while the connection is up", () => {
  it("trusts the connection over a directory that has not caught up", () => {
    expect(
      diagnoseNodeRoute(hub({ presence: { online: false, lastHeartbeatAt: NOW - 60_000 } }))
        .headline,
    ).toBeNull();
  });

  it("reads a hidden page or app as nothing wrong", () => {
    expect(
      diagnoseNodeRoute(hub({ status: { ...reconnecting, browserStatus: "suspended" } })).headline,
    ).toBeNull();
  });
});

describe("describeOfflineSince", () => {
  it("says since when, then yesterday, then for how many days", () => {
    expect(describeOfflineSince(at(9, 5), { nowMs: NOW })).toBe("since 09:05");
    expect(describeOfflineSince(at(22, 40, -1), { nowMs: NOW })).toBe("since yesterday 22:40");
    expect(describeOfflineSince(at(12, 0, -3), { nowMs: NOW })).toBe("for 3 days");
    expect(describeOfflineSince(null, { nowMs: NOW })).toBeNull();
    expect(describeOfflineSince(NOW + 60_000, { nowMs: NOW })).toBeNull();
  });

  it("counts calendar days, so the night of a clock change is still yesterday", () => {
    // Whatever the machine's zone, 00:30 after a 22:40 heartbeat is the next calendar day.
    const evening = new Date(2026, 2, 29, 22, 40).getTime();
    const afterMidnight = new Date(2026, 2, 30, 0, 30).getTime();
    expect(describeOfflineSince(evening, { nowMs: afterMidnight })).toBe("since yesterday 22:40");
  });
});

describe("hostedOutageFailure", () => {
  it("is the failure being waited out only while the transport is not online", () => {
    expect(hostedOutageFailure({ transportStatus: "reconnecting", outageFailure: "tls" })).toBe(
      "tls",
    );
    expect(hostedOutageFailure({ transportStatus: "online", outageFailure: "tls" })).toBeNull();
    expect(
      hostedOutageFailure({ transportStatus: "reconnecting", outageFailure: null }),
    ).toBeNull();
  });
});
