import type {
  HostedHubNode,
  HostedRelayFailure,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
} from "@ryco/client-runtime/authorization";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import { getHostedDispatchReplay } from "@ryco/client-runtime/relay";
import { UNIFIED_WORKSPACE_MAX_CONNECTIONS } from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId, RelayEffectiveRole } from "@ryco/contracts";

import type { MobileHostedScopeLeaseStore } from "./hostedConnectionScopes";

/**
 * docs/relay-capacity-assessment-3b.md discharges Wave 3b for at most three
 * simultaneous client connections/channels (0.59% of the 512-slot limits and
 * 15% of one peer's 20-token upgrade burst per client), with scope leases,
 * background release, staggered wake-up, and a five-node bound assertion.
 */
export const MAX_MOBILE_HOSTED_CONNECTIONS = UNIFIED_WORKSPACE_MAX_CONNECTIONS;
export const MOBILE_HOSTED_WAKE_STAGGER_MS = 750;

export interface MobileHostedConnectionState {
  readonly environmentId: EnvironmentId;
  readonly nodeId: string;
  readonly label: string;
  readonly generation: number;
  readonly lastAccessedAt: number;
  readonly transportStatus: HostedRelayTransportStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly attemptPrepared: boolean;
  readonly sessionEstablished: boolean;
  readonly sessionRecoveredAfterUnknown: boolean;
  readonly errorMessage: string | null;
}

interface MobileHostedConnectionsSnapshot {
  readonly selectedNodes: ReadonlyArray<MobileHostedConnectionState>;
  readonly deliveryUnknownEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

function createConnectionStore() {
  let state: MobileHostedConnectionsSnapshot = {
    selectedNodes: [],
    deliveryUnknownEnvironmentIds: [],
  };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(
      selectedNodes: ReadonlyArray<MobileHostedConnectionState>,
      deliveryUnknownEnvironmentIds: ReadonlyArray<EnvironmentId>,
    ) {
      state = { selectedNodes, deliveryUnknownEnvironmentIds };
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

export const mobileHostedConnectionsStore = createConnectionStore();

export interface MobileHostedConnectionCoordinatorDeps {
  readonly scopes: MobileHostedScopeLeaseStore;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly nodeForId: (nodeId: string) => HostedHubNode | null;
  readonly selectedEnvironmentId: () => EnvironmentId | null;
  readonly selectNode: (nodeId: string) => Promise<void>;
  readonly connectSelectedEnvironment: () => void;
  readonly markSelectedDeliveryUnknown: () => void;
  /** Mirror an acknowledgement into the shared selection cursor's session state. */
  readonly acknowledgeSelectedDeliveryUnknown: () => void;
  readonly listConnections: () => ReadonlyArray<EnvironmentConnection>;
  readonly readConnection: (environmentId: EnvironmentId) => EnvironmentConnection | null;
  readonly removeConnection: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly demoteEnvironment: (environmentId: EnvironmentId) => void;
  readonly restoreActiveEnvironment: (environmentId: EnvironmentId) => void;
}

export interface MobileHostedConnectionCoordinator {
  readonly acquireNode: (nodeId: string) => Promise<void>;
  readonly retainPairingScope: (
    nodeId: string,
    environmentId: EnvironmentId,
  ) => (() => void) | null;
  readonly reconnectNode: (nodeId: string, environmentId: EnvironmentId) => Promise<boolean>;
  readonly releaseEnvironment: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly shouldActivate: (environmentId: EnvironmentId) => boolean;
  readonly ensureRecord: (node: HostedHubNode) => MobileHostedConnectionState;
  readonly read: (environmentId: EnvironmentId) => MobileHostedConnectionState | null;
  readonly isCurrentGeneration: (environmentId: EnvironmentId, generation: number) => boolean;
  readonly registerPendingRequestReader: (
    environmentId: EnvironmentId,
    generation: number,
    hasPendingRequests: () => boolean,
  ) => void;
  readonly markAttemptPrepared: (environmentId: EnvironmentId, generation: number) => void;
  readonly transportStatus: (
    environmentId: EnvironmentId,
    generation: number,
    status: HostedRelayTransportStatus,
  ) => void;
  readonly sessionStatus: (
    environmentId: EnvironmentId,
    generation: number,
    status: HostedRycoSessionStatus,
  ) => void;
  readonly role: (
    environmentId: EnvironmentId,
    generation: number,
    role: RelayEffectiveRole | null,
  ) => void;
  readonly failure: (
    environmentId: EnvironmentId,
    generation: number,
    failure: HostedRelayFailure,
  ) => void;
  readonly markDeliveryUnknown: (environmentId: EnvironmentId, generation: number) => void;
  /** A replayed orchestration command could not be confirmed, whatever the generation. */
  readonly markEnvironmentDeliveryUnknown: (environmentId: EnvironmentId) => void;
  readonly acknowledgeDeliveryUnknown: (environmentId: EnvironmentId) => void;
  readonly connectionClosed: (environmentId: EnvironmentId, generation: number) => void;
  readonly markSessionReady: (environmentId: EnvironmentId, generation: number) => void;
  readonly markSessionReplaying: (environmentId: EnvironmentId, generation: number) => void;
  readonly reportShellSnapshotFailure: (environmentId: EnvironmentId, generation: number) => void;
  readonly releaseNonRetainedForBackground: () => Promise<void>;
  readonly cancelPendingRecovery: () => void;
  readonly reconnectRetainedAfterForeground: () => void;
  readonly releaseAll: () => Promise<void>;
  readonly dispose: () => void;
}

function relayFailureMessage(failure: HostedRelayFailure): string {
  switch (failure.kind) {
    case "offline":
      return "This machine is offline.";
    case "draining":
      return "Hub is temporarily draining relay connections.";
    case "rate-limited":
      return "Hub is temporarily busy.";
    case "incompatible":
      return "This machine or Hub version is incompatible.";
    case "authorization-removed":
      return "Your access to this machine was removed.";
    case "revoked":
      return "This machine was revoked.";
    case "network":
      return "Hub is temporarily unavailable.";
    default:
      return "Hub is temporarily unavailable.";
  }
}

export function createMobileHostedConnectionCoordinator(
  deps: MobileHostedConnectionCoordinatorDeps,
): MobileHostedConnectionCoordinator {
  const records = new Map<EnvironmentId, MobileHostedConnectionState>();
  const deliveryUnknownEnvironmentIds = new Set<EnvironmentId>();
  const attemptWaiters = new Map<
    EnvironmentId,
    Set<{ readonly resolve: () => void; readonly timer: unknown }>
  >();
  const pendingRequestReaders = new Map<
    EnvironmentId,
    { readonly generation: number; readonly read: () => boolean }
  >();
  const wakeTimers = new Set<unknown>();
  let nextGeneration = 1;
  let acquisition: Promise<void> = Promise.resolve();
  let acquiringEnvironmentId: EnvironmentId | null = null;
  let disposed = false;
  let lifecycleRevision = 0;
  let wakeRevision = 0;
  const pendingAcquisitions = new Map<string, { promise: Promise<void>; current: () => boolean }>();
  const pendingReleases = new Map<EnvironmentId, Promise<boolean>>();
  const cancelWake = () => {
    wakeRevision += 1;
    for (const timer of wakeTimers) deps.clearTimeout(timer);
    wakeTimers.clear();
  };
  const cancelAcquisitions = () => {
    lifecycleRevision += 1;
    pendingAcquisitions.clear();
    cancelWake();
    for (const environmentId of attemptWaiters.keys()) resolveAttemptWaiters(environmentId);
  };

  const publish = () =>
    mobileHostedConnectionsStore.publish(
      Array.from(records.values()).toSorted(
        (left, right) => right.lastAccessedAt - left.lastAccessedAt,
      ),
      Array.from(deliveryUnknownEnvironmentIds),
    );

  const patch = (
    environmentId: EnvironmentId,
    generation: number,
    update: (current: MobileHostedConnectionState) => MobileHostedConnectionState,
  ) => {
    const current = records.get(environmentId);
    if (!current || current.generation !== generation) return;
    const next = update(current);
    if (next === current) return;
    records.set(environmentId, next);
    publish();
  };

  const resolveAttemptWaiters = (environmentId: EnvironmentId) => {
    const waiters = attemptWaiters.get(environmentId);
    if (!waiters) return;
    attemptWaiters.delete(environmentId);
    for (const waiter of waiters) {
      deps.clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const forget = (environmentId: EnvironmentId) => {
    if (!records.delete(environmentId)) return;
    pendingRequestReaders.delete(environmentId);
    resolveAttemptWaiters(environmentId);
    publish();
  };

  const releaseOnce = async (environmentId: EnvironmentId): Promise<boolean> => {
    const current = records.get(environmentId);
    const pending = pendingRequestReaders.get(environmentId);
    if (current && pending?.generation === current.generation && pending.read()) {
      deliveryUnknownEnvironmentIds.add(environmentId);
    }
    const removed = await deps.removeConnection(environmentId).catch(() => false);
    if (deps.readConnection(environmentId) !== null) return false;
    if (records.get(environmentId)?.generation !== current?.generation) return removed;
    forget(environmentId);
    deps.demoteEnvironment(environmentId);
    return true;
  };

  const release = (environmentId: EnvironmentId): Promise<boolean> => {
    const pending = pendingReleases.get(environmentId);
    if (pending) return pending;
    const next = releaseOnce(environmentId).finally(() => {
      if (pendingReleases.get(environmentId) === next) pendingReleases.delete(environmentId);
    });
    pendingReleases.set(environmentId, next);
    return next;
  };

  const hostedConnections = () =>
    deps.listConnections().filter((connection) => connection.kind === "primary");

  const evictFor = async (
    environmentId: EnvironmentId,
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    while (
      isCurrent() &&
      hostedConnections().filter((connection) => connection.environmentId !== environmentId)
        .length >= MAX_MOBILE_HOSTED_CONNECTIONS
    ) {
      const candidates = Array.from(records.values())
        .filter((record) => record.environmentId !== environmentId)
        .toSorted((left, right) => {
          const leftRetained = deps.scopes.isEnvironmentRetained(left.environmentId) ? 1 : 0;
          const rightRetained = deps.scopes.isEnvironmentRetained(right.environmentId) ? 1 : 0;
          return leftRetained - rightRetained || left.lastAccessedAt - right.lastAccessedAt;
        });
      const victim = candidates[0];
      if (!victim || !(await release(victim.environmentId))) return false;
    }
    return isCurrent();
  };

  const waitForAttempt = (environmentId: EnvironmentId) => {
    const current = records.get(environmentId);
    if (!current || current.attemptPrepared || current.transportStatus === "online") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters =
        attemptWaiters.get(environmentId) ??
        new Set<{ readonly resolve: () => void; readonly timer: unknown }>();
      const waiter = {
        resolve,
        timer: deps.setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) attemptWaiters.delete(environmentId);
          resolve();
        }, 10_000),
      };
      waiters.add(waiter);
      attemptWaiters.set(environmentId, waiters);
    });
  };

  const enqueueAcquire = (nodeId: string, allowed: () => boolean = () => true) => {
    const pending = pendingAcquisitions.get(nodeId);
    if (pending?.current()) return pending.promise;
    const revision = lifecycleRevision;
    const current = () => !disposed && revision === lifecycleRevision && allowed();
    const next = acquisition
      .catch(() => undefined)
      .then(() => acquire(nodeId, current))
      .finally(() => {
        if (pendingAcquisitions.get(nodeId)?.promise === next) pendingAcquisitions.delete(nodeId);
      });
    pendingAcquisitions.set(nodeId, { promise: next, current });
    acquisition = next.catch(() => undefined);
    return next;
  };

  const acquire = async (nodeId: string, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    const node = deps.nodeForId(nodeId);
    if (!node) return;
    const releasing = pendingReleases.get(node.environmentId);
    if (releasing) await releasing;
    if (!isCurrent()) return;
    const current = records.get(node.environmentId);
    const deliveryUnknown = deliveryUnknownEnvironmentIds.has(node.environmentId);
    if (current) {
      records.set(node.environmentId, { ...current, lastAccessedAt: deps.now() });
      publish();
    } else {
      if (!(await evictFor(node.environmentId, isCurrent))) return;
    }
    if (!isCurrent()) return;
    acquiringEnvironmentId = node.environmentId;
    try {
      if (
        deps.selectedEnvironmentId() === node.environmentId &&
        deps.readConnection(node.environmentId) === null
      ) {
        const record = coordinatorRecord(node);
        deps.connectSelectedEnvironment();
        await waitForAttempt(record.environmentId);
        return;
      }
      await deps.selectNode(nodeId);
      if (!isCurrent()) return;
      if (deliveryUnknown) deps.markSelectedDeliveryUnknown();
      await waitForAttempt(node.environmentId);
    } finally {
      if (acquiringEnvironmentId === node.environmentId) acquiringEnvironmentId = null;
    }
  };

  const coordinatorRecord = (node: HostedHubNode): MobileHostedConnectionState => {
    const existing = records.get(node.environmentId);
    if (existing) return existing;
    const created: MobileHostedConnectionState = {
      environmentId: node.environmentId,
      nodeId: node.id,
      label: node.label,
      generation: nextGeneration++,
      lastAccessedAt: deps.now(),
      transportStatus: "idle",
      sessionStatus: deliveryUnknownEnvironmentIds.has(node.environmentId)
        ? "delivery-unknown"
        : "synchronizing",
      effectiveRole: node.effectiveRole,
      attemptPrepared: false,
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      errorMessage: null,
    };
    records.set(node.environmentId, created);
    publish();
    return created;
  };

  const unsubscribeScopes = deps.scopes.subscribe(publish);

  return {
    acquireNode(nodeId) {
      cancelWake();
      return enqueueAcquire(nodeId);
    },
    retainPairingScope(nodeId, environmentId) {
      const node = deps.nodeForId(nodeId);
      if (!node || node.environmentId !== environmentId) return null;
      return deps.scopes.retain(environmentId, { type: "node-pairing", nodeId });
    },
    async reconnectNode(nodeId, environmentId) {
      cancelWake();
      const revision = lifecycleRevision;
      const node = deps.nodeForId(nodeId);
      if (!node || node.environmentId !== environmentId) return false;
      if (!(await release(environmentId))) return false;
      if (disposed || revision !== lifecycleRevision) return false;
      await enqueueAcquire(nodeId);
      return records.has(environmentId);
    },
    releaseEnvironment: release,
    shouldActivate: (environmentId) =>
      acquiringEnvironmentId === environmentId ||
      (records.has(environmentId) &&
        (deps.selectedEnvironmentId() === environmentId ||
          deps.scopes.isEnvironmentRetained(environmentId))),
    ensureRecord(node) {
      const existing = records.get(node.environmentId);
      if (existing) {
        const refreshed = {
          ...existing,
          nodeId: node.id,
          label: node.label,
          effectiveRole: node.effectiveRole,
          lastAccessedAt: deps.now(),
        };
        records.set(node.environmentId, refreshed);
        publish();
        return refreshed;
      }
      return coordinatorRecord(node);
    },
    read: (environmentId) => records.get(environmentId) ?? null,
    isCurrentGeneration: (environmentId, generation) =>
      records.get(environmentId)?.generation === generation,
    registerPendingRequestReader(environmentId, generation, hasPendingRequests) {
      if (records.get(environmentId)?.generation !== generation) return;
      pendingRequestReaders.set(environmentId, { generation, read: hasPendingRequests });
    },
    markAttemptPrepared(environmentId, generation) {
      patch(environmentId, generation, (current) => ({ ...current, attemptPrepared: true }));
      resolveAttemptWaiters(environmentId);
    },
    transportStatus(environmentId, generation, status) {
      patch(environmentId, generation, (current) => ({
        ...current,
        transportStatus: status,
        attemptPrepared: status === "online" ? true : current.attemptPrepared,
      }));
      if (status === "online") resolveAttemptWaiters(environmentId);
    },
    sessionStatus: (environmentId, generation, status) =>
      patch(environmentId, generation, (current) => {
        if (current.sessionStatus === "delivery-unknown" && status !== "closed") return current;
        return { ...current, sessionStatus: status, sessionRecoveredAfterUnknown: false };
      }),
    role: (environmentId, generation, role) =>
      patch(environmentId, generation, (current) => ({ ...current, effectiveRole: role })),
    failure(environmentId, generation, failure) {
      patch(environmentId, generation, (current) => ({
        ...current,
        effectiveRole: failure.retryable ? current.effectiveRole : null,
        transportStatus: failure.retryable ? "reconnecting" : "terminal-failure",
        sessionStatus: current.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale",
        errorMessage: relayFailureMessage(failure),
      }));
      resolveAttemptWaiters(environmentId);
    },
    markDeliveryUnknown(environmentId, generation) {
      if (records.get(environmentId)?.generation !== generation) return;
      deliveryUnknownEnvironmentIds.add(environmentId);
      patch(environmentId, generation, (current) => ({
        ...current,
        sessionStatus: "delivery-unknown",
        sessionRecoveredAfterUnknown: false,
      }));
    },
    markEnvironmentDeliveryUnknown(environmentId) {
      deliveryUnknownEnvironmentIds.add(environmentId);
      const current = records.get(environmentId);
      if (current && current.sessionStatus !== "delivery-unknown") {
        records.set(environmentId, {
          ...current,
          sessionStatus: "delivery-unknown",
          // A current session only needs the acknowledgement; any other still
          // waits for its snapshot.
          sessionRecoveredAfterUnknown: current.sessionStatus === "ready",
        });
      }
      publish();
    },
    acknowledgeDeliveryUnknown(environmentId) {
      const current = records.get(environmentId);
      if (
        !current ||
        current.sessionStatus !== "delivery-unknown" ||
        !current.sessionRecoveredAfterUnknown
      ) {
        return;
      }
      records.set(environmentId, {
        ...current,
        sessionStatus: "ready",
        sessionRecoveredAfterUnknown: false,
      });
      deliveryUnknownEnvironmentIds.delete(environmentId);
      publish();
      // Any environment can be acknowledged from its own thread, not only the
      // selected one; the shared cursor follows when it points here.
      if (deps.selectedEnvironmentId() === environmentId) deps.acknowledgeSelectedDeliveryUnknown();
      getHostedDispatchReplay().markReady(environmentId);
    },
    connectionClosed: (environmentId, generation) =>
      patch(environmentId, generation, (current) => ({
        ...current,
        // Keep the validated role for read-only session-sync subscriptions.
        // Stale transport/session state still blocks mutations; terminal
        // failures and directory authorization independently revoke access.
        transportStatus:
          current.transportStatus === "terminal-failure" ? current.transportStatus : "reconnecting",
        sessionStatus: current.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale",
        sessionRecoveredAfterUnknown: false,
        attemptPrepared: false,
      })),
    markSessionReady(environmentId, generation) {
      patch(environmentId, generation, (current) =>
        current.sessionStatus === "delivery-unknown"
          ? { ...current, sessionEstablished: true, sessionRecoveredAfterUnknown: true }
          : {
              ...current,
              sessionStatus: "ready",
              sessionEstablished: true,
              sessionRecoveredAfterUnknown: false,
            },
      );
      resolveAttemptWaiters(environmentId);
      const ready = records.get(environmentId);
      if (ready?.generation === generation && ready.sessionStatus === "ready") {
        getHostedDispatchReplay().markReady(environmentId);
      }
    },
    markSessionReplaying: (environmentId, generation) =>
      patch(environmentId, generation, (current) =>
        current.sessionStatus === "delivery-unknown"
          ? { ...current, sessionRecoveredAfterUnknown: false }
          : { ...current, sessionStatus: "replaying" },
      ),
    reportShellSnapshotFailure(environmentId, generation) {
      patch(environmentId, generation, (current) =>
        current.sessionEstablished
          ? current
          : {
              ...current,
              transportStatus: "terminal-failure",
              sessionStatus: "stale",
              errorMessage: "Ryco state could not be synchronized.",
            },
      );
      resolveAttemptWaiters(environmentId);
    },
    cancelPendingRecovery: cancelAcquisitions,
    async releaseNonRetainedForBackground() {
      cancelAcquisitions();
      const revision = lifecycleRevision;
      const selectedEnvironmentId = deps.selectedEnvironmentId();
      const selectedRecord = selectedEnvironmentId ? records.get(selectedEnvironmentId) : null;
      const releasedEnvironmentIds = Array.from(records.values())
        .filter((record) => !deps.scopes.isEnvironmentRetained(record.environmentId))
        .map((record) => record.environmentId);
      const released = await Promise.all(
        releasedEnvironmentIds.map(async (environmentId) => ({
          environmentId,
          removed: await release(environmentId),
        })),
      );
      if (
        !disposed &&
        revision === lifecycleRevision &&
        selectedRecord &&
        deps.selectedEnvironmentId() === selectedEnvironmentId &&
        released.some((result) => result.removed && result.environmentId === selectedEnvironmentId)
      ) {
        // Suspending a socket does not deselect the user's node. Keep only a
        // fresh metadata generation so the shared foreground lifecycle can
        // revalidate access and recreate the selected connection. No socket or
        // mutation authority is retained by this record.
        const node = deps.nodeForId(selectedRecord.nodeId);
        if (node && node.environmentId === selectedEnvironmentId && node.revokedAt === null) {
          coordinatorRecord(node);
        }
      }
    },
    reconnectRetainedAfterForeground() {
      cancelWake();
      const revision = wakeRevision;
      const current = () => !disposed && revision === wakeRevision;
      const originalEnvironmentId = deps.selectedEnvironmentId();
      const retained = Array.from(records.values())
        .filter(
          (record) =>
            deps.scopes.isEnvironmentRetained(record.environmentId) &&
            record.environmentId !== originalEnvironmentId &&
            record.transportStatus !== "online",
        )
        .toSorted((left, right) => right.lastAccessedAt - left.lastAccessedAt);
      retained.forEach((record, index) => {
        const timer = deps.setTimeout(
          () => {
            wakeTimers.delete(timer);
            if (!current()) return;
            void enqueueAcquire(record.nodeId, current)
              .catch(() => undefined)
              .then(() => {
                if (!current() || index !== retained.length - 1 || !originalEnvironmentId) return;
                const original = records.get(originalEnvironmentId);
                if (!original) return;
                void enqueueAcquire(original.nodeId, current)
                  .then(() => {
                    if (current()) deps.restoreActiveEnvironment(originalEnvironmentId);
                  })
                  .catch(() => undefined);
              });
          },
          (index + 1) * MOBILE_HOSTED_WAKE_STAGGER_MS,
        );
        wakeTimers.add(timer);
      });
    },
    async releaseAll() {
      cancelAcquisitions();
      // Sign-out: no command may replay into the next account session.
      for (const environmentId of records.keys()) getHostedDispatchReplay().end(environmentId);
      await Promise.all(Array.from(records.keys(), (environmentId) => release(environmentId)));
      deliveryUnknownEnvironmentIds.clear();
      publish();
    },
    dispose() {
      disposed = true;
      cancelAcquisitions();
      unsubscribeScopes();
      for (const timer of wakeTimers) deps.clearTimeout(timer);
      wakeTimers.clear();
      for (const environmentId of attemptWaiters.keys()) resolveAttemptWaiters(environmentId);
      records.clear();
      pendingRequestReaders.clear();
      deliveryUnknownEnvironmentIds.clear();
      publish();
    },
  };
}

let mobileCoordinator: MobileHostedConnectionCoordinator | null = null;

export function configureMobileHostedConnectionCoordinator(
  deps: MobileHostedConnectionCoordinatorDeps,
): MobileHostedConnectionCoordinator {
  mobileCoordinator?.dispose();
  mobileCoordinator = createMobileHostedConnectionCoordinator(deps);
  return mobileCoordinator;
}

export function getMobileHostedConnectionCoordinator(): MobileHostedConnectionCoordinator {
  if (!mobileCoordinator)
    throw new Error("Mobile hosted connection coordinator is not configured.");
  return mobileCoordinator;
}

export function resetMobileHostedConnectionCoordinatorForTests(): void {
  mobileCoordinator?.dispose();
  mobileCoordinator = null;
}
