import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canAdoptHostedEnvironmentSession,
  configureHostedEnvironmentSessions,
  createHostedEnvironmentSessions,
  getHostedEnvironmentSessions,
  HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS,
  hostedBrowserRevalidated,
  hostedNodeEntryKey,
  isHostedEnvironmentConnectBlocked,
  isHostedEnvironmentSessionLive,
  isJoinableHostedEnvironmentSession,
  resetHostedEnvironmentSessionsForTests,
  selectedProjectionFields,
  type HostedEnvironmentSessionRecord,
  type HostedEnvironmentSessions,
} from "./hostedEnvironmentSessions.ts";
import type { HostedHubNode } from "./types.ts";

const ENV_A = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const ENV_B = EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb");

function hubNode(environmentId: EnvironmentId, overrides: Partial<HostedHubNode> = {}) {
  const suffix = environmentId.slice(4);
  return {
    id: `node_${suffix}`,
    environmentId,
    label: `Node ${suffix.slice(0, 1)}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
    ...overrides,
  } satisfies HostedHubNode;
}

function createSessions(syncDeadlineMs?: number): HostedEnvironmentSessions {
  return createHostedEnvironmentSessions({
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    ...(syncDeadlineMs === undefined ? {} : { syncDeadlineMs }),
  });
}

/** One full fresh attempt: requested, online, and its own snapshot accepted. */
function establish(sessions: HostedEnvironmentSessions, environmentId: EnvironmentId): number {
  const { generation } = sessions.ensureRecord(hubNode(environmentId));
  sessions.markConnectRequested(environmentId, generation);
  sessions.transportStatus(environmentId, generation, "online");
  sessions.sessionStatus(environmentId, generation, "synchronizing");
  sessions.markSessionReady(environmentId, generation);
  return generation;
}

function record(
  sessions: HostedEnvironmentSessions,
  environmentId: EnvironmentId,
): HostedEnvironmentSessionRecord {
  const current = sessions.read(environmentId);
  if (current === undefined) throw new Error("missing record");
  return current;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetHostedEnvironmentSessionsForTests();
  vi.useRealTimers();
});

describe("hosted environment sessions", () => {
  it("draws every generation from one counter across environments", () => {
    const sessions = createSessions();
    expect(sessions.ensureRecord(hubNode(ENV_A)).generation).toBe(1);
    expect(sessions.ensureRecord(hubNode(ENV_B)).generation).toBe(2);
    // An existing record keeps its generation.
    expect(sessions.ensureRecord(hubNode(ENV_A)).generation).toBe(1);
    sessions.release(ENV_A);
    expect(sessions.read(ENV_A)).toBeUndefined();
    expect(sessions.ensureRecord(hubNode(ENV_A)).generation).toBe(3);
    expect(sessions.renew(ENV_B)?.generation).toBe(4);
    expect(sessions.isCurrentGeneration(ENV_A, 3)).toBe(true);
    expect(sessions.isCurrentGeneration(ENV_A, 1)).toBe(false);
  });

  it("ignores a stale callback after A, B, A again and never touches B", () => {
    const sessions = createSessions();
    const first = sessions.ensureRecord(hubNode(ENV_A)).generation;
    sessions.markConnectRequested(ENV_A, first);
    sessions.release(ENV_A);
    const other = establish(sessions, ENV_B);
    const again = sessions.ensureRecord(hubNode(ENV_A)).generation;
    expect(again).not.toBe(first);
    const before = sessions.getSnapshot();
    const otherBefore = record(sessions, ENV_B);

    sessions.transportStatus(ENV_A, first, "online");
    sessions.sessionStatus(ENV_A, first, "ready");
    sessions.role(ENV_A, first, "owner");
    sessions.markSessionReady(ENV_A, first);
    sessions.failure(ENV_A, first, { kind: "revoked", retryable: false });
    sessions.connectionClosed(ENV_A, first);
    sessions.markDeliveryUnknown(ENV_A, first);

    expect(sessions.getSnapshot()).toBe(before);
    expect(record(sessions, ENV_A)).toMatchObject({
      generation: again,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      effectiveRole: "operator",
      sessionEstablished: false,
    });
    expect(record(sessions, ENV_B)).toBe(otherBefore);
    expect(record(sessions, ENV_B).generation).toBe(other);
    expect(sessions.getSnapshot().deliveryUnknown.size).toBe(0);
  });

  it("suspends every record: none stays adoptable and in-flight callbacks are fenced", () => {
    const sessions = createSessions();
    const a = establish(sessions, ENV_A);
    const b = establish(sessions, ENV_B);
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(true);
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_B))).toBe(true);

    const suspended = sessions.suspendAll();

    expect(suspended).toEqual([
      { environmentId: ENV_A, previousGeneration: a },
      { environmentId: ENV_B, previousGeneration: b },
    ]);
    for (const environmentId of [ENV_A, ENV_B]) {
      const current = record(sessions, environmentId);
      expect(current).toMatchObject({
        suspended: true,
        connectRequested: false,
        transportStatus: "idle",
        transportReachedOnline: false,
        sessionStatus: "stale",
        sessionEstablished: false,
        effectiveRole: "operator",
      });
      expect(canAdoptHostedEnvironmentSession(current)).toBe(false);
      expect(isJoinableHostedEnvironmentSession(current)).toBe(false);
      expect(isHostedEnvironmentSessionLive(current)).toBe(false);
    }
    // A snapshot of the old generation lands after the suspension.
    sessions.transportStatus(ENV_A, a, "online");
    sessions.markSessionReady(ENV_A, a);
    expect(record(sessions, ENV_A)).toMatchObject({ transportStatus: "idle", suspended: true });
    expect(record(sessions, ENV_A).generation).toBeGreaterThan(b);
  });

  it("can leave records that are suspended already as they are", () => {
    const sessions = createSessions();
    establish(sessions, ENV_A);
    sessions.suspendAll();
    const suspendedA = record(sessions, ENV_A);
    const b = establish(sessions, ENV_B);
    const published = vi.fn();
    sessions.subscribe(published);

    const suspended = sessions.suspendAll({ exceptSuspended: true });

    expect(suspended).toEqual([{ environmentId: ENV_B, previousGeneration: b }]);
    expect(record(sessions, ENV_A)).toBe(suspendedA);
    expect(record(sessions, ENV_B)).toMatchObject({ suspended: true });
    expect(published).toHaveBeenCalledOnce();

    expect(sessions.suspendAll({ exceptSuspended: true })).toEqual([]);
    expect(published).toHaveBeenCalledOnce();
  });

  it("withdraws every record's role and session in the same tick", () => {
    const sessions = createSessions();
    const a = establish(sessions, ENV_A);
    establish(sessions, ENV_B);
    sessions.markEnvironmentDeliveryUnknown(ENV_B);
    const published = vi.fn();
    sessions.subscribe(published);

    const withdrawn = sessions.withdrawAll();

    expect(withdrawn.map((entry) => entry.environmentId)).toEqual([ENV_A, ENV_B]);
    expect(published).toHaveBeenCalledOnce();
    for (const environmentId of [ENV_A, ENV_B]) {
      expect(record(sessions, environmentId)).toMatchObject({
        effectiveRole: null,
        sessionStatus: "closed",
        transportStatus: "reconnecting",
        suspended: true,
        sessionEstablished: false,
      });
      expect(canAdoptHostedEnvironmentSession(record(sessions, environmentId))).toBe(false);
    }
    sessions.role(ENV_A, a, "owner");
    expect(record(sessions, ENV_A).effectiveRole).toBeNull();
  });

  it("starts the next session delivery-unknown when a release cut off a pending request", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.registerPendingRequestReader(ENV_A, generation, () => true);
    // A reader for a replaced generation is never registered.
    sessions.registerPendingRequestReader(ENV_B, 99, () => true);

    sessions.release(ENV_A);

    expect(sessions.getSnapshot().deliveryUnknown.has(ENV_A)).toBe(true);
    const next = sessions.ensureRecord(hubNode(ENV_A));
    expect(next.sessionStatus).toBe("delivery-unknown");

    // A release with nothing in flight leaves the environment certain.
    const other = establish(sessions, ENV_B);
    sessions.registerPendingRequestReader(ENV_B, other, () => false);
    sessions.release(ENV_B);
    expect(sessions.getSnapshot().deliveryUnknown.has(ENV_B)).toBe(false);
    expect(sessions.ensureRecord(hubNode(ENV_B)).sessionStatus).toBe("synchronizing");
  });

  it("carries a pending request across a renew", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.registerPendingRequestReader(ENV_A, generation, () => true);
    expect(sessions.renew(ENV_A)?.sessionStatus).toBe("delivery-unknown");
  });

  it("carries a pending request across a suspension", () => {
    const sessions = createSessions();
    const a = establish(sessions, ENV_A);
    const b = establish(sessions, ENV_B);
    sessions.registerPendingRequestReader(ENV_A, a, () => true);
    sessions.registerPendingRequestReader(ENV_B, b, () => false);

    // The caller suspends the old connections next, which drops their requests.
    sessions.suspendAll();

    expect(sessions.getSnapshot().deliveryUnknown).toEqual(new Set([ENV_A]));
    expect(record(sessions, ENV_A)).toMatchObject({
      suspended: true,
      sessionStatus: "delivery-unknown",
    });
    expect(record(sessions, ENV_B).sessionStatus).toBe("stale");
    expect(sessions.renew(ENV_A)?.sessionStatus).toBe("delivery-unknown");
    expect(sessions.renew(ENV_B)?.sessionStatus).toBe("synchronizing");
    sessions.release(ENV_A);
    expect(sessions.ensureRecord(hubNode(ENV_A)).sessionStatus).toBe("delivery-unknown");
  });

  it("carries a pending request across a withdrawal", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.registerPendingRequestReader(ENV_A, generation, () => true);

    sessions.withdrawAll();

    expect(sessions.getSnapshot().deliveryUnknown.has(ENV_A)).toBe(true);
    expect(record(sessions, ENV_A).sessionStatus).toBe("closed");
    // The platform's teardown releases the record afterwards.
    sessions.release(ENV_A);
    expect(sessions.ensureRecord(hubNode(ENV_A)).sessionStatus).toBe("delivery-unknown");
  });

  it("clears the session-sync deadline on release", async () => {
    const sessions = createSessions();
    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    sessions.markConnectRequested(ENV_A, generation);
    expect(vi.getTimerCount()).toBe(1);
    sessions.release(ENV_A);
    expect(vi.getTimerCount()).toBe(0);
    const next = sessions.ensureRecord(hubNode(ENV_A));
    await vi.advanceTimersByTimeAsync(HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS * 2);
    expect(record(sessions, ENV_A)).toEqual(next);
  });

  it("ignores a snapshot inside a relay gap and adopts the replacement only after its own", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    const acceptedAt = record(sessions, ENV_A).snapshotAcceptedAt;

    sessions.connectionClosed(ENV_A, generation);
    expect(record(sessions, ENV_A)).toMatchObject({
      relayGap: true,
      transportStatus: "reconnecting",
      sessionStatus: "stale",
      effectiveRole: "operator",
    });
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(false);

    // A snapshot that lands before the replacement channel came from the lost one.
    vi.advanceTimersByTime(10);
    sessions.markSessionReady(ENV_A, generation);
    expect(record(sessions, ENV_A)).toMatchObject({
      relayGap: true,
      sessionStatus: "stale",
      snapshotAcceptedAt: acceptedAt,
    });

    sessions.transportStatus(ENV_A, generation, "online");
    sessions.connectionRecovered(ENV_A, generation);
    expect(record(sessions, ENV_A)).toMatchObject({
      relayGap: false,
      sessionEstablished: false,
    });
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(false);
    sessions.markSessionReady(ENV_A, generation);
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(true);
  });

  it("fails a recovered channel whose replacement snapshot never arrives", async () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.connectionClosed(ENV_A, generation);
    // Recovery outside a relay gap, or of another generation, changes nothing.
    sessions.connectionRecovered(ENV_A, generation + 1);
    expect(vi.getTimerCount()).toBe(0);
    sessions.connectionRecovered(ENV_A, generation);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS);
    expect(record(sessions, ENV_A)).toMatchObject({
      transportStatus: "terminal-failure",
      syncFailed: true,
    });
  });

  it("fails a session that misses its deadline and blocks it until the entry changes or a renew", async () => {
    const sessions = createSessions(5_000);
    const node = hubNode(ENV_A);
    const { generation, nodeKey } = sessions.ensureRecord(node);
    sessions.markConnectRequested(ENV_A, generation);
    sessions.transportStatus(ENV_A, generation, "online");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(record(sessions, ENV_A).transportStatus).toBe("online");
    await vi.advanceTimersByTimeAsync(1);

    expect(record(sessions, ENV_A)).toMatchObject({
      transportStatus: "terminal-failure",
      sessionStatus: "stale",
      syncFailed: true,
      terminalNodeKey: nodeKey,
    });
    expect(isHostedEnvironmentConnectBlocked(record(sessions, ENV_A))).toBe(true);
    expect(isJoinableHostedEnvironmentSession(record(sessions, ENV_A))).toBe(false);
    expect(isHostedEnvironmentSessionLive(record(sessions, ENV_A))).toBe(false);

    // Touching it with the same directory entry keeps it blocked.
    sessions.ensureRecord(node);
    expect(isHostedEnvironmentConnectBlocked(record(sessions, ENV_A))).toBe(true);
    // A changed entry (the node came back with another version) lifts the block.
    sessions.ensureRecord({ ...node, clientVersion: "0.9.1" });
    expect(record(sessions, ENV_A).terminalNodeKey).toBeNull();
    expect(isHostedEnvironmentConnectBlocked(record(sessions, ENV_A))).toBe(false);

    // So does an explicit retry.
    const second = sessions.renew(ENV_A)!.generation;
    sessions.markConnectRequested(ENV_A, second);
    sessions.reportShellSnapshotFailure(ENV_A, second);
    expect(isHostedEnvironmentConnectBlocked(record(sessions, ENV_A))).toBe(true);
    const renewed = sessions.renew(ENV_A)!;
    expect(renewed).toMatchObject({
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      failure: null,
      terminalNodeKey: null,
      syncFailed: false,
      connectRequested: false,
    });
    expect(isHostedEnvironmentConnectBlocked(renewed)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the first deadline when a connection is requested again", async () => {
    const sessions = createSessions(5_000);
    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    sessions.markConnectRequested(ENV_A, generation);
    await vi.advanceTimersByTimeAsync(4_000);
    const requested = sessions.getSnapshot();

    sessions.markConnectRequested(ENV_A, generation);

    expect(sessions.getSnapshot()).toBe(requested);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(record(sessions, ENV_A)).toMatchObject({
      transportStatus: "terminal-failure",
      syncFailed: true,
    });
  });

  it("does not fail an established session at its deadline", async () => {
    const sessions = createSessions();
    establish(sessions, ENV_A);
    await vi.advanceTimersByTimeAsync(HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS * 2);
    expect(record(sessions, ENV_A)).toMatchObject({
      transportStatus: "online",
      sessionStatus: "ready",
      syncFailed: false,
    });
    // An established session keeps its snapshot when a later one fails.
    sessions.reportShellSnapshotFailure(ENV_A, record(sessions, ENV_A).generation);
    expect(record(sessions, ENV_A).transportStatus).toBe("online");
  });

  it("keeps the role on a retryable failure and blocks on a terminal one", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    const retryable = { kind: "offline", retryable: true } as const;
    sessions.failure(ENV_A, generation, retryable);
    expect(record(sessions, ENV_A)).toMatchObject({
      failure: retryable,
      transportStatus: "reconnecting",
      sessionStatus: "stale",
      effectiveRole: "operator",
      terminalNodeKey: null,
    });
    const terminal = { kind: "authorization-removed", retryable: false } as const;
    sessions.failure(ENV_A, generation, terminal);
    expect(record(sessions, ENV_A)).toMatchObject({
      failure: terminal,
      transportStatus: "terminal-failure",
      effectiveRole: null,
      terminalNodeKey: record(sessions, ENV_A).nodeKey,
    });
    expect(isHostedEnvironmentConnectBlocked(record(sessions, ENV_A))).toBe(true);
  });

  it("opens no relay gap once a terminal failure ended the channel", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.failure(ENV_A, generation, { kind: "incompatible", retryable: false });
    const failed = sessions.getSnapshot();

    sessions.connectionClosed(ENV_A, generation);

    expect(sessions.getSnapshot()).toBe(failed);
    expect(record(sessions, ENV_A)).toMatchObject({
      transportStatus: "terminal-failure",
      relayGap: false,
    });
    // A snapshot of the ended channel cannot revive it.
    sessions.markSessionReady(ENV_A, generation);
    expect(sessions.getSnapshot()).toBe(failed);

    // Once the entry changes, the same generation can connect and become ready again.
    sessions.ensureRecord(hubNode(ENV_A, { clientVersion: "0.9.1" }));
    expect(isHostedEnvironmentConnectBlocked(record(sessions, ENV_A))).toBe(false);
    sessions.transportStatus(ENV_A, generation, "requesting-ticket");
    sessions.transportStatus(ENV_A, generation, "online");
    sessions.markSessionReady(ENV_A, generation);
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(true);
  });

  it("leaves no relay gap behind when a changed entry lifts a failure that followed a close", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.connectionClosed(ENV_A, generation);
    sessions.failure(ENV_A, generation, { kind: "authorization-removed", retryable: false });
    expect(record(sessions, ENV_A)).toMatchObject({
      transportStatus: "terminal-failure",
      relayGap: true,
    });

    // The same entry keeps both the block and the gap.
    sessions.ensureRecord(hubNode(ENV_A));
    expect(record(sessions, ENV_A).relayGap).toBe(true);
    sessions.ensureRecord(hubNode(ENV_A, { effectiveRole: "owner" }));
    expect(record(sessions, ENV_A)).toMatchObject({ relayGap: false, terminalNodeKey: null });

    sessions.transportStatus(ENV_A, generation, "online");
    sessions.markSessionReady(ENV_A, generation);
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(true);
  });

  it("settles a missed deadline once a late snapshot establishes the generation", async () => {
    const sessions = createSessions(5_000);
    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    sessions.markConnectRequested(ENV_A, generation);
    sessions.transportStatus(ENV_A, generation, "authenticating");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(record(sessions, ENV_A)).toMatchObject({
      transportStatus: "terminal-failure",
      syncFailed: true,
    });
    const failed = sessions.getSnapshot();

    // While the record stands failed, a snapshot changes nothing.
    sessions.markSessionReady(ENV_A, generation);
    expect(sessions.getSnapshot()).toBe(failed);

    // The generation's transport comes back, and its own snapshot lands.
    sessions.transportStatus(ENV_A, generation, "online");
    sessions.markSessionReady(ENV_A, generation);
    const settled = record(sessions, ENV_A);
    expect(settled).toMatchObject({
      sessionStatus: "ready",
      sessionEstablished: true,
      syncFailed: false,
      terminalNodeKey: null,
    });
    expect(canAdoptHostedEnvironmentSession(settled)).toBe(true);
    expect(isHostedEnvironmentConnectBlocked(settled)).toBe(false);
  });

  it("only refreshes the record when another node serves the environment", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.failure(ENV_A, generation, { kind: "revoked", retryable: false });
    expect(isHostedEnvironmentConnectBlocked(record(sessions, ENV_A))).toBe(true);

    const reenrolled = sessions.ensureRecord(hubNode(ENV_A, { id: "node_reenrolled" }));

    // The caller decides whether to renew; the changed entry lifts the block.
    expect(reenrolled).toMatchObject({
      generation,
      nodeId: "node_reenrolled",
      connectRequested: true,
      transportStatus: "terminal-failure",
      terminalNodeKey: null,
    });
    expect(isHostedEnvironmentConnectBlocked(reenrolled)).toBe(false);
  });

  it("refreshes a directory entry without counting it as an access", () => {
    const sessions = createSessions();
    const created = sessions.ensureRecord(hubNode(ENV_A));
    const listener = vi.fn();
    sessions.subscribe(listener);
    vi.advanceTimersByTime(1_000);

    // An unchanged entry neither reorders the records nor publishes.
    expect(sessions.ensureRecord(hubNode(ENV_A), { access: false })).toBe(created);
    expect(listener).not.toHaveBeenCalled();

    const renamed = sessions.ensureRecord(hubNode(ENV_A, { label: "Renamed" }), { access: false });
    expect(renamed).toMatchObject({ label: "Renamed", lastAccessedAt: created.lastAccessedAt });
    expect(listener).toHaveBeenCalledOnce();

    // An access moves the record to the front.
    expect(sessions.ensureRecord(hubNode(ENV_A)).lastAccessedAt).toBe(
      created.lastAccessedAt + 1_000,
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("counts each time the directory reports a known node online again", () => {
    const sessions = createSessions();
    const offline = { presence: { online: false, lastHeartbeatAt: 1 } };
    // A record created for a node that is online or offline has no edge yet.
    sessions.ensureRecord(hubNode(ENV_A, offline));
    sessions.ensureRecord(hubNode(ENV_B));
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(0);
    expect(sessions.presenceOnlineEdges(ENV_B)).toBe(0);

    sessions.ensureRecord(hubNode(ENV_A), { access: false });
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(1);
    // Online again, or a node that never went offline, is no edge.
    sessions.ensureRecord(hubNode(ENV_A));
    sessions.ensureRecord(hubNode(ENV_B), { access: false });
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(1);
    expect(sessions.presenceOnlineEdges(ENV_B)).toBe(0);

    sessions.ensureRecord(hubNode(ENV_A, offline), { access: false });
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(1);
    sessions.ensureRecord(hubNode(ENV_A));
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(2);
    expect(sessions.presenceOnlineEdges(ENV_B)).toBe(0);
  });

  it("shows an online edge to the listeners of the publish that carries it", () => {
    const sessions = createSessions();
    sessions.ensureRecord(hubNode(ENV_A, { presence: { online: false, lastHeartbeatAt: 1 } }));
    const seen: number[] = [];
    sessions.subscribe(() => seen.push(sessions.presenceOnlineEdges(ENV_A)));

    sessions.ensureRecord(hubNode(ENV_A), { access: false });

    expect(seen).toEqual([1]);
  });

  it("keeps online edges across a renew and drops them on release and clear", () => {
    const sessions = createSessions();
    const offline = { presence: { online: false, lastHeartbeatAt: 1 } };
    const flap = (environmentId: EnvironmentId) => {
      sessions.ensureRecord(hubNode(environmentId, offline), { access: false });
      sessions.ensureRecord(hubNode(environmentId), { access: false });
    };
    sessions.ensureRecord(hubNode(ENV_A));
    sessions.ensureRecord(hubNode(ENV_B));
    flap(ENV_A);
    flap(ENV_B);

    sessions.renew(ENV_A);
    sessions.suspendAll();
    sessions.withdrawAll();
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(1);
    flap(ENV_A);
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(2);

    sessions.release(ENV_A);
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(0);
    sessions.ensureRecord(hubNode(ENV_A));
    expect(sessions.presenceOnlineEdges(ENV_A)).toBe(0);
    expect(sessions.presenceOnlineEdges(ENV_B)).toBe(1);

    sessions.clear();
    expect(sessions.presenceOnlineEdges(ENV_B)).toBe(0);
    sessions.ensureRecord(hubNode(ENV_B, offline));
    expect(sessions.presenceOnlineEdges(ENV_B)).toBe(0);
  });

  it("answers the adoption, join and live rules", () => {
    const sessions = createSessions();
    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    const fresh = record(sessions, ENV_A);
    expect(canAdoptHostedEnvironmentSession(fresh)).toBe(false);
    expect(isJoinableHostedEnvironmentSession(fresh)).toBe(false);
    expect(isHostedEnvironmentSessionLive(fresh)).toBe(false);
    expect(isHostedEnvironmentSessionLive(undefined)).toBe(false);

    // Requested but still idle: a second request joins it.
    sessions.markConnectRequested(ENV_A, generation);
    const requested = record(sessions, ENV_A);
    expect(requested.transportStatus).toBe("idle");
    expect(isJoinableHostedEnvironmentSession(requested)).toBe(true);
    expect(isHostedEnvironmentSessionLive(requested)).toBe(true);

    for (const status of ["requesting-ticket", "connecting", "online"] as const) {
      sessions.transportStatus(ENV_A, generation, status);
      expect(isJoinableHostedEnvironmentSession(record(sessions, ENV_A))).toBe(true);
      expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(false);
    }
    sessions.markSessionReady(ENV_A, generation);
    const ready = record(sessions, ENV_A);
    expect(canAdoptHostedEnvironmentSession(ready)).toBe(true);
    expect(isJoinableHostedEnvironmentSession(ready)).toBe(false);
    expect(isHostedEnvironmentSessionLive(ready)).toBe(true);

    // Each condition alone withdraws adoption.
    const variants: ReadonlyArray<Partial<HostedEnvironmentSessionRecord>> = [
      { transportStatus: "reconnecting" },
      { sessionEstablished: false },
      { suspended: true },
      { relayGap: true },
      { snapshotAcceptedAt: null },
      { sessionStatus: "replaying" },
      { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false },
    ];
    for (const variant of variants) {
      expect(canAdoptHostedEnvironmentSession({ ...ready, ...variant })).toBe(false);
    }
    expect(
      canAdoptHostedEnvironmentSession({
        ...ready,
        sessionStatus: "delivery-unknown",
        sessionRecoveredAfterUnknown: true,
      }),
    ).toBe(true);
    // Running without a request of its own (a reconnecting transport) still counts as live.
    expect(
      isHostedEnvironmentSessionLive({
        ...ready,
        connectRequested: false,
        transportStatus: "reconnecting",
      }),
    ).toBe(true);
    expect(isHostedEnvironmentSessionLive({ ...ready, transportStatus: "terminal-failure" })).toBe(
      false,
    );
  });

  it("tracks whether the transport reached online since the connection last opened", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    expect(record(sessions, ENV_A).transportReachedOnline).toBe(true);
    sessions.connectionClosed(ENV_A, generation);
    expect(record(sessions, ENV_A).transportReachedOnline).toBe(false);
    sessions.transportStatus(ENV_A, generation, "connecting");
    expect(record(sessions, ENV_A).transportReachedOnline).toBe(false);
    sessions.transportStatus(ENV_A, generation, "online");
    expect(record(sessions, ENV_A).transportReachedOnline).toBe(true);

    const renewed = sessions.renew(ENV_A)!.generation;
    expect(record(sessions, ENV_A).transportReachedOnline).toBe(false);
    sessions.transportStatus(ENV_A, renewed, "online");
    expect(record(sessions, ENV_A).transportReachedOnline).toBe(true);
    sessions.suspendAll();
    expect(record(sessions, ENV_A).transportReachedOnline).toBe(false);
  });

  it("publishes only real changes", () => {
    const sessions = createSessions();
    const listener = vi.fn();
    const unsubscribe = sessions.subscribe(listener);
    const initial = sessions.getSnapshot();
    expect(Object.isFrozen(initial)).toBe(true);
    expect(initial.revision).toBe(0);

    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    expect(listener).toHaveBeenCalledTimes(1);
    const created = sessions.getSnapshot();
    expect(created.revision).toBe(1);
    expect(created.records.get(ENV_A)?.generation).toBe(generation);

    // Same directory entry at the same instant: nothing changes.
    sessions.ensureRecord(hubNode(ENV_A));
    sessions.transportStatus(ENV_A, generation, "idle");
    sessions.role(ENV_A, generation, "operator");
    sessions.sessionStatus(ENV_A, generation, "synchronizing");
    sessions.connectionRecovered(ENV_A, generation);
    sessions.acknowledgeDeliveryUnknown(ENV_A);
    sessions.release(ENV_B);
    expect(sessions.suspendAll()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(2);
    const suspended = sessions.getSnapshot();
    expect(suspended).not.toBe(created);
    expect(created.records.get(ENV_A)?.suspended).toBe(false);

    sessions.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    sessions.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    sessions.ensureRecord(hubNode(ENV_A));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("lists records most recently accessed first", () => {
    const sessions = createSessions();
    sessions.ensureRecord(hubNode(ENV_A));
    vi.advanceTimersByTime(1);
    sessions.ensureRecord(hubNode(ENV_B));
    expect(sessions.list().map((entry) => entry.environmentId)).toEqual([ENV_B, ENV_A]);
    expect(sessions.list()).toBe(sessions.list());
    vi.advanceTimersByTime(1);
    sessions.ensureRecord(hubNode(ENV_A));
    expect(sessions.list().map((entry) => entry.environmentId)).toEqual([ENV_A, ENV_B]);
  });

  it("keeps an unconfirmed action visible until the user acknowledges it", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);

    sessions.markEnvironmentDeliveryUnknown(ENV_A);
    // A current session only needs the acknowledgement.
    expect(record(sessions, ENV_A)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(true);

    // Sticky across every status but a close.
    sessions.sessionStatus(ENV_A, generation, "synchronizing");
    expect(record(sessions, ENV_A)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });
    sessions.markSessionReplaying(ENV_A, generation);
    expect(record(sessions, ENV_A).sessionStatus).toBe("delivery-unknown");
    sessions.acknowledgeDeliveryUnknown(ENV_A);
    expect(record(sessions, ENV_A).sessionStatus).toBe("delivery-unknown");

    // Its own snapshot recovers it; the acknowledgement makes it ready.
    sessions.markSessionReady(ENV_A, generation);
    expect(record(sessions, ENV_A)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
      sessionEstablished: true,
    });
    sessions.acknowledgeDeliveryUnknown(ENV_A);
    expect(record(sessions, ENV_A)).toMatchObject({
      sessionStatus: "ready",
      sessionRecoveredAfterUnknown: false,
    });
    expect(sessions.getSnapshot().deliveryUnknown.has(ENV_A)).toBe(false);

    // A drop with a mutation in flight is fenced like every other callback.
    sessions.markDeliveryUnknown(ENV_A, generation + 1);
    expect(record(sessions, ENV_A).sessionStatus).toBe("ready");
    sessions.markDeliveryUnknown(ENV_A, generation);
    expect(record(sessions, ENV_A)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });
    sessions.sessionStatus(ENV_A, generation, "closed");
    expect(record(sessions, ENV_A).sessionStatus).toBe("closed");
    // The environment stays uncertain for its next session.
    expect(sessions.renew(ENV_A)?.sessionStatus).toBe("delivery-unknown");
  });

  it("marks an environment without a record uncertain for its next session", () => {
    const sessions = createSessions();
    sessions.markEnvironmentDeliveryUnknown(ENV_B);
    expect(sessions.getSnapshot().deliveryUnknown.has(ENV_B)).toBe(true);
    expect(sessions.ensureRecord(hubNode(ENV_B)).sessionStatus).toBe("delivery-unknown");
    sessions.clear();
    expect(sessions.getSnapshot().deliveryUnknown.size).toBe(0);
    expect(sessions.ensureRecord(hubNode(ENV_B)).sessionStatus).toBe("synchronizing");
  });

  it("moves to replaying and back to ready on its own snapshot", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.markSessionReplaying(ENV_A, generation);
    expect(record(sessions, ENV_A).sessionStatus).toBe("replaying");
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(false);
    sessions.markSessionReady(ENV_A, generation);
    expect(canAdoptHostedEnvironmentSession(record(sessions, ENV_A))).toBe(true);
  });

  it("clears every timer, record and uncertain delivery on clear", () => {
    const sessions = createSessions();
    const a = sessions.ensureRecord(hubNode(ENV_A)).generation;
    const b = sessions.ensureRecord(hubNode(ENV_B)).generation;
    sessions.markConnectRequested(ENV_A, a);
    sessions.markConnectRequested(ENV_B, b);
    sessions.markEnvironmentDeliveryUnknown(ENV_A);
    expect(vi.getTimerCount()).toBe(2);
    sessions.clear();
    expect(vi.getTimerCount()).toBe(0);
    expect(sessions.list()).toEqual([]);
    expect(sessions.getSnapshot().deliveryUnknown.size).toBe(0);
  });

  it("keys a directory entry by the fields that can lift a terminal failure", () => {
    const node = hubNode(ENV_A);
    const key = hostedNodeEntryKey(node);
    expect(hostedNodeEntryKey({ ...node, label: "Renamed", updatedAt: 9 })).toBe(key);
    for (const changed of [
      { ...node, id: "node_reenrolled" },
      { ...node, presence: { online: false, lastHeartbeatAt: 1 } },
      { ...node, clientVersion: "1.0.0" },
      { ...node, effectiveRole: "owner" as const },
      { ...node, revokedAt: 5 },
      {
        ...node,
        capabilities: { repositoryIdentity: true, nativeClientRequired: true },
      },
    ]) {
      expect(hostedNodeEntryKey(changed)).not.toBe(key);
    }
  });

  it("treats a synchronizing browser as revalidated", () => {
    expect(hostedBrowserRevalidated("current")).toBe(true);
    expect(hostedBrowserRevalidated("synchronizing")).toBe(true);
    for (const status of ["suspended", "offline", "checking-access", "stale"] as const) {
      expect(hostedBrowserRevalidated(status)).toBe(false);
    }
  });
});

describe("the selected environment's projection", () => {
  const ready = { directoryReady: true, deliveryUnknown: false } as const;

  it("shows a fresh session for an environment without a record", () => {
    const node = hubNode(ENV_A);
    expect(selectedProjectionFields(undefined, node, ready)).toEqual({
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      effectiveRole: "operator",
      selectionStatus: "online",
      error: null,
      establishing: true,
    });
    expect(
      selectedProjectionFields(
        undefined,
        hubNode(ENV_A, { presence: { online: false, lastHeartbeatAt: 1 } }),
        { directoryReady: false, deliveryUnknown: true },
      ),
    ).toMatchObject({
      sessionStatus: "delivery-unknown",
      effectiveRole: null,
      selectionStatus: "offline",
    });
  });

  it("reports an established session with the role its own connection reported", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.role(ENV_A, generation, "viewer");

    expect(selectedProjectionFields(record(sessions, ENV_A), hubNode(ENV_A), ready)).toEqual({
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      sessionRecoveredAfterUnknown: false,
      effectiveRole: "viewer",
      selectionStatus: "online",
      error: null,
      establishing: false,
    });
    expect(
      selectedProjectionFields(record(sessions, ENV_A), hubNode(ENV_A), {
        directoryReady: false,
        deliveryUnknown: false,
      }).effectiveRole,
    ).toBeNull();
  });

  it("keeps a suspended or reconnecting session establishing, and a spent budget quiet", () => {
    const sessions = createSessions();
    const generation = establish(sessions, ENV_A);
    sessions.failure(ENV_A, generation, { kind: "budget", retryable: true });
    expect(selectedProjectionFields(record(sessions, ENV_A), hubNode(ENV_A), ready)).toMatchObject({
      transportStatus: "reconnecting",
      error: null,
      establishing: false,
    });

    sessions.failure(ENV_A, generation, { kind: "offline", retryable: true });
    expect(selectedProjectionFields(record(sessions, ENV_A), hubNode(ENV_A), ready).error).toEqual({
      kind: "relay",
      failure: { kind: "offline", retryable: true },
    });

    sessions.suspendAll();
    expect(selectedProjectionFields(record(sessions, ENV_A), hubNode(ENV_A), ready)).toMatchObject({
      transportStatus: "idle",
      sessionStatus: "stale",
      establishing: true,
    });
  });

  it.each([
    ["revoked", "revoked"],
    ["authorization-removed", "authorization-removed"],
    ["incompatible", "incompatible"],
    ["authentication", "online"],
  ] as const)("reports a terminal %s failure as %s", (kind, selectionStatus) => {
    const sessions = createSessions();
    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    sessions.markConnectRequested(ENV_A, generation);
    sessions.failure(ENV_A, generation, { kind, retryable: false });

    expect(selectedProjectionFields(record(sessions, ENV_A), hubNode(ENV_A), ready)).toMatchObject({
      transportStatus: "terminal-failure",
      effectiveRole: null,
      selectionStatus,
      error: { kind: "relay", failure: { kind, retryable: false } },
      establishing: false,
    });
  });

  it("reports a missed synchronization deadline as its own error", async () => {
    const sessions = createSessions();
    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    sessions.markConnectRequested(ENV_A, generation);
    await vi.advanceTimersByTimeAsync(HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS);

    expect(selectedProjectionFields(record(sessions, ENV_A), hubNode(ENV_A), ready)).toMatchObject({
      transportStatus: "terminal-failure",
      error: { kind: "session-sync" },
      establishing: false,
    });
  });
});

describe("the application's registry", () => {
  it("is created once and takes the platform's timers without losing records", () => {
    const sessions = getHostedEnvironmentSessions();
    expect(getHostedEnvironmentSessions()).toBe(sessions);
    const { generation } = sessions.ensureRecord(hubNode(ENV_A));
    const armed: Array<() => void> = [];
    const cleared: unknown[] = [];
    const platform = {
      now: () => 42,
      setTimeout: (callback: () => void) => {
        armed.push(callback);
        return armed.length;
      },
      clearTimeout: (timer: unknown) => {
        cleared.push(timer);
      },
      syncDeadlineMs: 1_000,
    };
    expect(configureHostedEnvironmentSessions(platform)).toBe(sessions);
    expect(sessions.read(ENV_A)?.generation).toBe(generation);

    sessions.markConnectRequested(ENV_A, generation);
    expect(armed).toHaveLength(1);
    // A timer armed through one set of ports is cleared through the same ports.
    configureHostedEnvironmentSessions({
      now: () => 0,
      setTimeout: () => {
        throw new Error("not armed through these ports");
      },
      clearTimeout: () => {
        throw new Error("not armed through these ports");
      },
    });
    sessions.release(ENV_A);
    expect(cleared).toEqual([1]);
  });

  it("fires its deadline through the configured timers", () => {
    const armed: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
    const sessions = configureHostedEnvironmentSessions({
      now: () => 7,
      setTimeout: (callback, delayMs) => armed.push({ callback, delayMs }),
      clearTimeout: () => undefined,
      syncDeadlineMs: 1_000,
    });
    const { generation } = sessions.ensureRecord(hubNode(ENV_B));
    expect(sessions.read(ENV_B)?.lastAccessedAt).toBe(7);
    sessions.markConnectRequested(ENV_B, generation);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.delayMs).toBe(1_000);
    armed[0]?.callback();
    expect(sessions.read(ENV_B)).toMatchObject({
      transportStatus: "terminal-failure",
      syncFailed: true,
    });
  });
});
