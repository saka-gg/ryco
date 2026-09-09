import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";
import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
import { authorizeHostedRequestForState } from "@ryco/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createMobileHostedConnectionCoordinator,
  MAX_MOBILE_HOSTED_CONNECTIONS,
  MOBILE_HOSTED_WAKE_STAGGER_MS,
  type MobileHostedConnectionCoordinator,
} from "./hostedConnectionCoordinator";
import { createMobileHostedScopeLeaseStore } from "./hostedConnectionScopes";

function node(index: number): HostedHubNode {
  return {
    id: `node-${index}`,
    environmentId: `env-${index}` as EnvironmentId,
    label: `Node ${index}`,
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1",
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: null,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant-${index}`, role: "owner" },
    effectiveRole: "owner",
    presence: { online: true, lastHeartbeatAt: null },
  };
}

function connection(environmentId: EnvironmentId): EnvironmentConnection {
  return {
    kind: "primary",
    environmentId,
    knownEnvironment: {} as never,
    client: {} as never,
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };
}

function fixture() {
  const nodes = Array.from({ length: 5 }, (_, index) => node(index + 1));
  const scopes = createMobileHostedScopeLeaseStore();
  const active = new Map<EnvironmentId, EnvironmentConnection>();
  const observedCounts: number[] = [];
  const selections: Array<{ readonly nodeId: string; readonly at: number }> = [];
  let selectedEnvironmentId: EnvironmentId | null = null;
  let coordinator: MobileHostedConnectionCoordinator;

  coordinator = createMobileHostedConnectionCoordinator({
    scopes,
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    nodeForId: (nodeId) => nodes.find((candidate) => candidate.id === nodeId) ?? null,
    selectedEnvironmentId: () => selectedEnvironmentId,
    selectNode: async (nodeId) => {
      const target = nodes.find((candidate) => candidate.id === nodeId);
      if (!target) return;
      selections.push({ nodeId, at: Date.now() });
      selectedEnvironmentId = target.environmentId;
      const record = coordinator.ensureRecord(target);
      active.set(target.environmentId, connection(target.environmentId));
      observedCounts.push(active.size);
      coordinator.markAttemptPrepared(target.environmentId, record.generation);
    },
    connectSelectedEnvironment: () => {
      const target = nodes.find((candidate) => candidate.environmentId === selectedEnvironmentId);
      if (!target) return;
      const record = coordinator.ensureRecord(target);
      active.set(target.environmentId, connection(target.environmentId));
      observedCounts.push(active.size);
      coordinator.markAttemptPrepared(target.environmentId, record.generation);
    },
    markSelectedDeliveryUnknown: () => undefined,
    listConnections: () => Array.from(active.values()),
    readConnection: (environmentId) => active.get(environmentId) ?? null,
    removeConnection: async (environmentId) => active.delete(environmentId),
    demoteEnvironment: () => undefined,
    restoreActiveEnvironment: () => undefined,
  });
  return { active, coordinator, nodes, observedCounts, scopes, selections };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mobile hosted connection coordinator", () => {
  it("allows the explicitly selected connection to recover without a thread scope", async () => {
    const { active, coordinator, nodes } = fixture();
    await coordinator.acquireNode(nodes[0]!.id);
    expect(coordinator.shouldActivate(nodes[0]!.environmentId)).toBe(true);
    await coordinator.acquireNode(nodes[1]!.id);
    expect(coordinator.shouldActivate(nodes[0]!.environmentId)).toBe(false);
    expect(coordinator.shouldActivate(nodes[1]!.environmentId)).toBe(true);
    await coordinator.releaseNonRetainedForBackground();
    expect(active.size).toBe(0);
    expect(coordinator.read(nodes[1]!.environmentId)).toMatchObject({
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
    });
    // Selection is remembered, but reopening requires the shared lifecycle to
    // validate the account/directory and establish a new channel and snapshot.
    expect(coordinator.shouldActivate(nodes[1]!.environmentId)).toBe(true);
  });

  it("retains only session-sync access during a retryable channel gap", () => {
    const { coordinator, nodes } = fixture();
    const record = coordinator.ensureRecord(nodes[0]!);
    coordinator.transportStatus(record.environmentId, record.generation, "online");
    coordinator.markSessionReady(record.environmentId, record.generation);
    coordinator.connectionClosed(record.environmentId, record.generation);

    const current = coordinator.read(record.environmentId)!;
    const state = { ...current, directoryStatus: "ready", browserStatus: "current" } as const;
    expect(current).toMatchObject({ transportStatus: "reconnecting", sessionStatus: "stale" });
    expect(
      authorizeHostedRequestForState(state, {
        tag: ORCHESTRATION_WS_METHODS.subscribeShell,
        stream: true,
      }),
    ).toBe(true);
    expect(
      authorizeHostedRequestForState(state, {
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).toBe(false);
    expect(
      authorizeHostedRequestForState(
        { ...state, directoryStatus: "stale" },
        {
          tag: ORCHESTRATION_WS_METHODS.subscribeShell,
          stream: true,
        },
      ),
    ).toBe(false);

    coordinator.failure(record.environmentId, record.generation, {
      kind: "authorization-removed",
      retryable: false,
    });
    coordinator.connectionClosed(record.environmentId, record.generation);
    expect(coordinator.read(record.environmentId)).toMatchObject({
      effectiveRole: null,
      transportStatus: "terminal-failure",
      sessionStatus: "stale",
    });
  });

  it("holds the named concurrency bound under a five-node fixture", async () => {
    const { active, coordinator, nodes, observedCounts } = fixture();
    for (const target of nodes) await coordinator.acquireNode(target.id);

    expect(MAX_MOBILE_HOSTED_CONNECTIONS).toBe(3);
    expect(Math.max(...observedCounts)).toBe(MAX_MOBILE_HOSTED_CONNECTIONS);
    expect(Array.from(active.keys())).toEqual(["env-3", "env-4", "env-5"]);
  });

  it("releases only non-retained LRU connections when backgrounded", async () => {
    const { active, coordinator, nodes, scopes } = fixture();
    for (const target of nodes.slice(0, 3)) await coordinator.acquireNode(target.id);
    const release = scopes.retain("env-2" as EnvironmentId, { type: "provider-status" });

    await coordinator.releaseNonRetainedForBackground();
    expect(Array.from(active.keys())).toEqual(["env-2"]);

    release();
    await coordinator.releaseNonRetainedForBackground();
    expect(active.size).toBe(0);
  });

  it("reconnects an evicted current selection when its thread is opened again", async () => {
    const { active, coordinator, nodes } = fixture();
    await coordinator.acquireNode(nodes[0]!.id);
    await coordinator.releaseNonRetainedForBackground();
    expect(active.size).toBe(0);

    await coordinator.acquireNode(nodes[0]!.id);
    expect(Array.from(active.keys())).toEqual(["env-1"]);
  });

  it("pairs and retries node B without changing node A's live connection", async () => {
    const { active, coordinator, nodes, scopes } = fixture();
    await coordinator.acquireNode(nodes[0]!.id);
    await coordinator.acquireNode(nodes[1]!.id);
    const releasePairing = coordinator.retainPairingScope(nodes[1]!.id, nodes[1]!.environmentId);
    expect(releasePairing).not.toBeNull();
    expect(scopes.list(nodes[1]!.environmentId)).toMatchObject([
      { scope: { type: "node-pairing", nodeId: "node-2" }, refCount: 1 },
    ]);

    expect(await coordinator.reconnectNode(nodes[1]!.id, nodes[1]!.environmentId)).toBe(true);
    expect(Array.from(active.keys()).toSorted()).toEqual(["env-1", "env-2"]);
    expect(coordinator.read(nodes[0]!.environmentId)?.nodeId).toBe("node-1");
    releasePairing?.();
  });

  it("fails closed for a pairing route whose node and environment do not match", () => {
    const { coordinator, nodes } = fixture();
    expect(coordinator.retainPairingScope(nodes[0]!.id, nodes[1]!.environmentId)).toBeNull();
  });

  it("identity-conflict release removes only the affected environment", async () => {
    const { active, coordinator, nodes } = fixture();
    await coordinator.acquireNode(nodes[0]!.id);
    await coordinator.acquireNode(nodes[1]!.id);
    await coordinator.releaseEnvironment(nodes[1]!.environmentId);
    expect(Array.from(active.keys())).toEqual(["env-1"]);
    expect(coordinator.read(nodes[0]!.environmentId)).not.toBeNull();
    expect(coordinator.read(nodes[1]!.environmentId)).toBeNull();
  });

  it("keeps delivery uncertainty on the environment whose request was interrupted", () => {
    const { coordinator, nodes } = fixture();
    const first = coordinator.ensureRecord(nodes[0]!);
    const second = coordinator.ensureRecord(nodes[1]!);

    coordinator.markDeliveryUnknown(first.environmentId, first.generation);
    expect(coordinator.read(first.environmentId)?.sessionStatus).toBe("delivery-unknown");
    expect(coordinator.read(second.environmentId)?.sessionStatus).toBe("synchronizing");
  });

  it("preserves delivery uncertainty and rejects old callbacks across selected-node suspension", async () => {
    const { active, coordinator, nodes } = fixture();
    const target = nodes[0]!;
    await coordinator.acquireNode(target.id);
    const previous = coordinator.read(target.environmentId)!;
    coordinator.markSessionReady(target.environmentId, previous.generation);
    coordinator.registerPendingRequestReader(target.environmentId, previous.generation, () => true);

    await coordinator.releaseNonRetainedForBackground();
    const suspended = coordinator.read(target.environmentId)!;
    expect(active.size).toBe(0);
    expect(suspended.generation).not.toBe(previous.generation);
    expect(suspended.sessionStatus).toBe("delivery-unknown");
    coordinator.markSessionReady(target.environmentId, previous.generation);
    expect(coordinator.read(target.environmentId)?.sessionRecoveredAfterUnknown).toBe(false);

    await coordinator.acquireNode(target.id);
    expect(active.has(target.environmentId)).toBe(true);
    coordinator.markSessionReady(target.environmentId, suspended.generation);
    expect(coordinator.read(target.environmentId)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
  });

  it("preserves an in-flight request as delivery unknown across background release", async () => {
    const { coordinator, nodes } = fixture();
    const first = coordinator.ensureRecord(nodes[0]!);
    coordinator.registerPendingRequestReader(first.environmentId, first.generation, () => true);

    await coordinator.releaseNonRetainedForBackground();
    expect(coordinator.read(first.environmentId)).toBeNull();

    const restored = coordinator.ensureRecord(nodes[0]!);
    expect(restored.sessionStatus).toBe("delivery-unknown");
  });

  it("stagger-reconnects retained environments instead of issuing one wake burst", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { coordinator, nodes, scopes, selections } = fixture();
    for (const target of nodes.slice(0, 3)) {
      await coordinator.acquireNode(target.id);
      scopes.retain(target.environmentId, { type: "provider-status" });
    }
    selections.length = 0;

    coordinator.reconnectRetainedAfterForeground();
    expect(selections).toEqual([]);
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS - 1);
    expect(selections).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(selections[0]).toEqual({ nodeId: "node-1", at: MOBILE_HOSTED_WAKE_STAGGER_MS });
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(selections[1]).toEqual({ nodeId: "node-2", at: 2 * MOBILE_HOSTED_WAKE_STAGGER_MS });
    // Restoring the original current environment is queued after the staggered
    // reconnect, not emitted in the foreground tick's burst.
    await vi.runAllTimersAsync();
    expect(selections.at(-1)?.nodeId).toBe("node-3");
  });
});
