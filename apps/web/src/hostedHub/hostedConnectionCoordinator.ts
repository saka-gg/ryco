import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import {
  createNodeMutationLeaseAuthority,
  type NodeMutationLease,
} from "@ryco/client-runtime/authorization";
import {
  buildUnifiedWorkspaceIndex,
  createWorkspaceConnectionDemandState,
  planWorkspaceConnectionDemand,
  reconcileWorkspaceMachineCatalog,
  releaseWorkspaceConnectionScope,
  renewWorkspaceConnectionScope,
  retainWorkspaceConnectionScope,
  setWorkspaceConnectionBackgrounded,
  setWorkspaceEnvironmentConnected,
  workspaceMetadataPayloadBytes,
  type UnifiedWorkspaceIndex,
  type WorkspaceConnectionDemandState,
  type WorkspaceMachineCatalogEntry,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { useStore } from "../store";
import { getBrowserWorkspaceMetadataCache } from "../persistence/workspaceMetadataCache";
import {
  readWorkspaceMetadataSnapshot,
  workspaceMetadataToCachedShellSnapshot,
} from "../workspaceMetadataProjection";
import { hostedHubController, hostedHubStore } from "./state";
import { clearWebHostedAccountScopedState } from "./environment";
import {
  canShowHostedReadPreview,
  readHostedReadCache,
  subscribeHostedReadCache,
} from "./readCache";
import {
  getInstalledHostedNodeHistory,
  getRoutedHostedNode,
  setHostedNodeRouteEnvironmentResolver,
  subscribeRoutedHostedNode,
} from "./nodeRoutes";
import {
  HOSTED_WEB_SCOPE_LEASE_TTL_MS,
  HOSTED_WEB_SCOPE_REPORT_INTERVAL_MS,
  hostedWebConnectionScopes,
  type HostedWebScopeStore,
} from "./hostedConnectionScopes";

/**
 * Hosted Web remains at one connection. The native ceiling of three from
 * docs/relay-capacity-assessment-3b.md is not assumed safe for concurrent
 * full-PNG browser streams; raising this constant requires measurements in the
 * same change.
 */
export const MAX_HOSTED_WEB_CONNECTIONS = 1;
export const HOSTED_WEB_WAKE_STAGGER_MS = 750;

export interface HostedConnectionCoordinatorDeps {
  readonly scopes: HostedWebScopeStore;
  readonly now: () => number;
  readonly connect: (environmentId: EnvironmentId, delayMs: number) => Promise<void>;
  readonly release: (environmentId: EnvironmentId) => Promise<void>;
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (timer: unknown) => void;
}

export interface HostedConnectionCoordinatorSnapshot {
  readonly demand: WorkspaceConnectionDemandState;
  readonly queuedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly activeConnectionCount: number;
}

export interface HostedConnectionCoordinator {
  readonly snapshot: () => HostedConnectionCoordinatorSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reportConnected: (environmentId: EnvironmentId, connected: boolean) => void;
  readonly setBackgrounded: (backgrounded: boolean) => Promise<void>;
  readonly reconcile: () => Promise<void>;
  readonly dispose: () => void;
}

export function createHostedConnectionCoordinator(
  deps: HostedConnectionCoordinatorDeps,
): HostedConnectionCoordinator {
  let demand = createWorkspaceConnectionDemandState(MAX_HOSTED_WEB_CONNECTIONS);
  let queued: ReadonlyArray<EnvironmentId> = [];
  let operation: Promise<void> = Promise.resolve();
  let disposed = false;
  let leaseSequence = 0;
  const leaseIdByScopeKey = new Map<string, string>();
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const reconcileScopes = () => {
    const active = new Map(deps.scopes.list().map((entry) => [entry.key, entry] as const));
    for (const [key, leaseId] of Array.from(leaseIdByScopeKey)) {
      if (active.has(key)) continue;
      leaseIdByScopeKey.delete(key);
      demand = releaseWorkspaceConnectionScope(demand, leaseId);
    }
    for (const [key, entry] of active) {
      const existing = leaseIdByScopeKey.get(key);
      if (existing) {
        demand = renewWorkspaceConnectionScope(
          demand,
          existing,
          deps.now(),
          HOSTED_WEB_SCOPE_LEASE_TTL_MS,
        );
        continue;
      }
      const leaseId = `hosted-web-${++leaseSequence}`;
      leaseIdByScopeKey.set(key, leaseId);
      demand = retainWorkspaceConnectionScope(demand, {
        leaseId,
        environmentId: entry.environmentId,
        scope: entry.scope,
        now: deps.now(),
        ttlMs: HOSTED_WEB_SCOPE_LEASE_TTL_MS,
      });
    }
  };

  const apply = async () => {
    if (disposed) return;
    reconcileScopes();
    const plan = planWorkspaceConnectionDemand(demand, {
      now: deps.now(),
      wakeStaggerMs: HOSTED_WEB_WAKE_STAGGER_MS,
    });
    demand = plan.state;
    queued = plan.queued;
    publish();
    for (const environmentId of plan.release) {
      await deps.release(environmentId).catch(() => undefined);
      demand = setWorkspaceEnvironmentConnected(demand, environmentId, false, deps.now());
    }
    for (const command of plan.connect) {
      try {
        await deps.connect(command.environmentId, command.delayMs);
        demand = setWorkspaceEnvironmentConnected(demand, command.environmentId, true, deps.now());
      } catch {
        demand = setWorkspaceEnvironmentConnected(demand, command.environmentId, false, deps.now());
      }
    }
    const settled = planWorkspaceConnectionDemand(demand, {
      now: deps.now(),
      wakeStaggerMs: HOSTED_WEB_WAKE_STAGGER_MS,
    });
    queued = settled.queued;
    publish();
  };

  const enqueue = () => {
    const next = operation.catch(() => undefined).then(apply);
    operation = next.catch(() => undefined);
    return next;
  };

  const unsubscribeScopes = deps.scopes.subscribe(() => void enqueue());
  const renewalTimer = deps.setInterval(() => void enqueue(), HOSTED_WEB_SCOPE_REPORT_INTERVAL_MS);

  return {
    snapshot: () => ({
      demand,
      queuedEnvironmentIds: queued,
      activeConnectionCount: demand.connections.filter((entry) => entry.connected).length,
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportConnected(environmentId, connected) {
      demand = setWorkspaceEnvironmentConnected(demand, environmentId, connected, deps.now());
      publish();
    },
    setBackgrounded(backgrounded) {
      demand = setWorkspaceConnectionBackgrounded(demand, backgrounded);
      return enqueue();
    },
    reconcile: enqueue,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeScopes();
      deps.clearInterval(renewalTimer);
      listeners.clear();
    },
  };
}

export interface HostedWorkspaceSnapshot {
  readonly status: "signed-out" | "loading" | "ready" | "stale";
  readonly accountId: string | null;
  readonly machines: ReadonlyArray<WorkspaceMachineCatalogEntry>;
  readonly workspace: UnifiedWorkspaceIndex;
  readonly demand: HostedConnectionCoordinatorSnapshot;
  readonly homeDiscovery: {
    readonly environmentId: EnvironmentId | null;
    readonly failedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  };
}

const EMPTY_WORKSPACE: UnifiedWorkspaceIndex = {
  machines: [],
  snapshots: [],
  projects: [],
  worktrees: [],
  threads: [],
  logicalProjects: [],
};

let hostedWorkspaceSnapshot: HostedWorkspaceSnapshot = {
  status: "signed-out",
  accountId: null,
  machines: [],
  workspace: EMPTY_WORKSPACE,
  homeDiscovery: { environmentId: null, failedEnvironmentIds: [] },
  demand: {
    demand: createWorkspaceConnectionDemandState(MAX_HOSTED_WEB_CONNECTIONS),
    queuedEnvironmentIds: [],
    activeConnectionCount: 0,
  },
};
const hostedWorkspaceListeners = new Set<() => void>();
let activeCoordinator: HostedConnectionCoordinator | null = null;
let retryHomeDiscovery: (() => void) | null = null;
const hostedMutationLeaseAuthority = createNodeMutationLeaseAuthority();

export function readHostedNodeMutationLease(
  environmentId: EnvironmentId,
): NodeMutationLease | null {
  return hostedMutationLeaseAuthority.lease(environmentId);
}

export function waitForHostedNodeMutationLease(
  environmentId: EnvironmentId,
  timeoutMs = 30_000,
): Promise<NodeMutationLease | null> {
  const current = readHostedNodeMutationLease(environmentId);
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (lease: NodeMutationLease | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(lease);
    };
    const unsubscribe = hostedMutationLeaseAuthority.subscribe(() => {
      const lease = readHostedNodeMutationLease(environmentId);
      if (lease) finish(lease);
    });
    const timer = globalThis.setTimeout(() => finish(null), timeoutMs);
  });
}

function publishHostedWorkspace(next: HostedWorkspaceSnapshot): void {
  hostedWorkspaceSnapshot = next;
  for (const listener of Array.from(hostedWorkspaceListeners)) listener();
}

export function readHostedWorkspaceState(): HostedWorkspaceSnapshot {
  return hostedWorkspaceSnapshot;
}

export function useHostedWorkspaceState(): HostedWorkspaceSnapshot {
  return useSyncExternalStore(
    (listener) => {
      hostedWorkspaceListeners.add(listener);
      return () => hostedWorkspaceListeners.delete(listener);
    },
    readHostedWorkspaceState,
    readHostedWorkspaceState,
  );
}

export function retryHostedHomeDiscovery(): void {
  retryHomeDiscovery?.();
}

export function hostedNodeRequiresNativeClient(node: HostedHubNode): boolean {
  return node.capabilities?.nativeClientRequired === true;
}

function machineCatalog(
  nodes: ReadonlyArray<HostedHubNode>,
  selectedEnvironmentId: EnvironmentId | null,
  connected: boolean,
  deliveryUnknown: boolean,
  now: number,
): ReadonlyArray<WorkspaceMachineCatalogEntry> {
  return reconcileWorkspaceMachineCatalog(
    nodes.map((node) => ({
      environmentId: node.environmentId,
      nodeId: node.id,
      label: node.label,
      platform: { os: node.platformOs, arch: node.platformArch },
      serverVersion: node.clientVersion,
      capabilities: {
        repositoryIdentity: node.capabilities?.repositoryIdentity ?? true,
        threadSettlement: node.capabilities?.threadSettlement ?? false,
        nativeClientRequired: node.capabilities?.nativeClientRequired ?? false,
      },
      clientTier: "hosted-web" as const,
      nativeTrust: "not-required" as const,
      requiresNativeVerification: false,
      effectiveRole: node.effectiveRole,
      online: node.presence.online,
      lastSeenAt: node.presence.lastHeartbeatAt,
      observedAt: now,
      connectionState:
        node.environmentId === selectedEnvironmentId && connected
          ? ("connected" as const)
          : ("disconnected" as const),
      deliveryUnknown: node.environmentId === selectedEnvironmentId && deliveryUnknown,
      revokedAt: node.revokedAt,
    })),
  );
}

export function startHostedWorkspaceCoordinator(input?: {
  readonly cache?: WorkspaceMetadataCache;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  readonly setInterval?: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
  readonly hubOrigin?: string;
  /** The root can show a route-error directory at `/` instead of the workspace. */
  readonly canDiscoverHome?: () => boolean;
}): () => void {
  const cache = input?.cache ?? getBrowserWorkspaceMetadataCache();
  const now = input?.now ?? Date.now;
  const schedule =
    input?.setTimeout ??
    ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const cancel =
    input?.clearTimeout ??
    ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const repeat =
    input?.setInterval ??
    ((callback: () => void, delayMs: number) => globalThis.setInterval(callback, delayMs));
  const cancelRepeat =
    input?.clearInterval ??
    ((timer: unknown) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>));
  const hubOrigin = input?.hubOrigin ?? window.location.origin;
  const snapshots = new Map<EnvironmentId, WorkspaceMetadataSnapshot>();
  let accountKey: string | null = null;
  let activeAccountId: string | null = null;
  let publishTimer: unknown = null;
  let disposed = false;
  let syncGeneration = 0;
  let lastSelectedEnvironmentId: EnvironmentId | null = null;
  let discoveryEnvironmentId: EnvironmentId | null = null;
  let releaseDiscoveryScope: (() => void) | null = null;
  let discoveryPending = false;
  const failedDiscoveryEnvironments = new Set<EnvironmentId>();

  const coordinator = createHostedConnectionCoordinator({
    scopes: hostedWebConnectionScopes,
    now,
    setInterval: repeat,
    clearInterval: cancelRepeat,
    connect: async (environmentId, delayMs) => {
      if (delayMs > 0) await new Promise<void>((resolve) => schedule(resolve, delayMs));
      const state = hostedHubStore.getState();
      if (
        disposed ||
        state.accountStatus !== "authenticated" ||
        state.directoryStatus !== "ready" ||
        state.browserStatus !== "current" ||
        !hostedWebConnectionScopes.list().some((scope) => scope.environmentId === environmentId)
      ) {
        throw new Error("Hosted Web directory is not current.");
      }
      const node = state.nodes.find(
        (candidate) =>
          candidate.environmentId === environmentId &&
          candidate.revokedAt === null &&
          candidate.presence.online &&
          !hostedNodeRequiresNativeClient(candidate),
      );
      if (!node) throw new Error("Hosted Web environment is not eligible.");
      if (state.selectedNode?.id === node.id && state.transportStatus === "terminal-failure") {
        await hostedHubController.retrySelectedNode();
      } else {
        await hostedHubController.selectNode(node.id);
      }
      if (disposed || hostedHubStore.getState().selectedNode?.id !== node.id) {
        throw new Error("Hosted Web connection demand was superseded.");
      }
    },
    release: async (environmentId) => {
      if (hostedHubStore.getState().selectedNode?.environmentId === environmentId) {
        await hostedHubController.returnToDirectory();
      }
    },
  });
  activeCoordinator = coordinator;

  const publish = (machines: ReadonlyArray<WorkspaceMachineCatalogEntry>) => {
    const state = hostedHubStore.getState();
    const cached = readHostedReadCache();
    if (state.accountStatus !== "authenticated" && canShowHostedReadPreview()) {
      hostedMutationLeaseAuthority.update({
        environmentId: null,
        snapshotGeneration: 0,
        effectiveRole: null,
        directoryReady: false,
        relayReady: false,
        shellReady: false,
      });
      const cachedMachines = reconcileWorkspaceMachineCatalog(
        cached.nodes.map((node) => ({
          environmentId: node.environmentId,
          nodeId: node.nodeId,
          label: node.label,
          platform: { os: "unknown" as const, arch: "other" as const },
          serverVersion: null,
          capabilities: {
            repositoryIdentity: true,
            threadSettlement: false,
            nativeClientRequired: false,
          },
          clientTier: "hosted-web" as const,
          nativeTrust: "not-required" as const,
          requiresNativeVerification: false,
          effectiveRole: "viewer" as const,
          online: false,
          lastSeenAt: null,
          observedAt: now(),
          connectionState: "disconnected" as const,
          deliveryUnknown: false,
          revokedAt: null,
        })),
      ).map((machine) => ({ ...machine, canConnect: false, canMutate: false }));
      publishHostedWorkspace({
        status: "stale",
        accountId: cached.accountId,
        machines: cachedMachines,
        workspace: buildUnifiedWorkspaceIndex({
          machines: cachedMachines,
          snapshots: cached.snapshots,
        }),
        demand: coordinator.snapshot(),
        homeDiscovery: { environmentId: null, failedEnvironmentIds: [] },
      });
      return;
    }
    const status =
      state.accountStatus !== "authenticated"
        ? "signed-out"
        : state.directoryStatus === "ready"
          ? "ready"
          : state.directoryStatus === "stale"
            ? "stale"
            : "loading";
    const selectedEnvironmentId = state.selectedNode?.environmentId ?? null;
    const selectedSnapshot =
      selectedEnvironmentId === null ? undefined : snapshots.get(selectedEnvironmentId);
    hostedMutationLeaseAuthority.update({
      environmentId: selectedEnvironmentId,
      snapshotGeneration: selectedSnapshot?.capturedAt ?? 0,
      effectiveRole: state.effectiveRole,
      directoryReady: state.directoryStatus === "ready" && state.browserStatus === "current",
      relayReady:
        state.transportStatus === "online" &&
        state.sessionEstablished &&
        selectedEnvironmentId !== null,
      shellReady:
        selectedSnapshot !== undefined &&
        machines.some(
          (machine) =>
            machine.environmentId === selectedEnvironmentId &&
            machine.connectionState === "connected" &&
            machine.canMutate,
        ),
    });
    publishHostedWorkspace({
      status,
      accountId: state.account?.id ?? null,
      machines,
      workspace: buildUnifiedWorkspaceIndex({
        machines,
        snapshots: Array.from(snapshots.values()),
      }),
      demand: coordinator.snapshot(),
      homeDiscovery: {
        environmentId: discoveryEnvironmentId,
        failedEnvironmentIds: [...failedDiscoveryEnvironments],
      },
    });
  };

  const releaseDiscovery = () => {
    const release = releaseDiscoveryScope;
    releaseDiscoveryScope = null;
    discoveryEnvironmentId = null;
    release?.();
  };

  // Home contributes only one disposable demand lease at a time. Connection,
  // authorization and shell synchronization still belong to the normal owner.
  // A routed thread or any other interactive scope always takes precedence.
  const reconcileHomeDiscovery = () => {
    const state = hostedHubStore.getState();
    const route = getRoutedHostedNode();
    const foregroundDemand = hostedWebConnectionScopes
      .list()
      .some(
        (entry) =>
          entry.environmentId !== discoveryEnvironmentId ||
          entry.scope.type !== "interactive" ||
          entry.refCount > 1,
      );
    const canDiscover =
      getInstalledHostedNodeHistory() !== null &&
      route.nodeId === null &&
      route.logicalPathname === "/" &&
      !route.malformed &&
      input?.canDiscoverHome?.() !== false &&
      state.accountStatus === "authenticated" &&
      state.account?.id === activeAccountId &&
      accountKey === JSON.stringify([hubOrigin, activeAccountId]) &&
      state.directoryStatus === "ready" &&
      state.browserStatus === "current" &&
      !coordinator.snapshot().demand.backgrounded &&
      !foregroundDemand;
    const eligible = state.nodes.filter(
      (node) =>
        node.revokedAt === null && node.presence.online && !hostedNodeRequiresNativeClient(node),
    );
    if (!canDiscover) {
      releaseDiscovery();
    } else {
      if (discoveryEnvironmentId !== null) {
        const failed =
          state.selectedNode?.environmentId === discoveryEnvironmentId &&
          state.transportStatus === "terminal-failure";
        if (failed) failedDiscoveryEnvironments.add(discoveryEnvironmentId);
        if (
          failed ||
          snapshots.has(discoveryEnvironmentId) ||
          !eligible.some((node) => node.environmentId === discoveryEnvironmentId)
        )
          releaseDiscovery();
      }
      if (discoveryEnvironmentId === null) {
        const next = eligible.find(
          (node) =>
            !snapshots.has(node.environmentId) &&
            !failedDiscoveryEnvironments.has(node.environmentId),
        );
        if (next) {
          discoveryEnvironmentId = next.environmentId;
          releaseDiscoveryScope = hostedWebConnectionScopes.retain(next.environmentId, {
            type: "interactive",
          });
        }
      }
    }
    publish(hostedWorkspaceSnapshot.machines);
  };
  const scheduleHomeDiscovery = () => {
    if (discoveryPending || disposed) return;
    discoveryPending = true;
    queueMicrotask(() => {
      discoveryPending = false;
      if (!disposed) reconcileHomeDiscovery();
    });
  };
  const retryDiscovery = () => {
    failedDiscoveryEnvironments.clear();
    scheduleHomeDiscovery();
  };
  retryHomeDiscovery = retryDiscovery;

  const synchronize = async () => {
    const generation = ++syncGeneration;
    const state = hostedHubStore.getState();
    // A failed session check does not prove sign-out. Retain the remembered
    // account's read model while the single lifecycle owner retries access.
    if (state.accountStatus === "unavailable" && canShowHostedReadPreview()) {
      releaseDiscovery();
      publish([]);
      return;
    }
    const accountId = state.accountStatus === "authenticated" ? (state.account?.id ?? null) : null;
    const nextAccountKey = accountId ? JSON.stringify([hubOrigin, accountId]) : null;
    const previousAccountId = activeAccountId;
    activeAccountId = accountId;
    if (previousAccountId && accountId !== previousAccountId) {
      releaseDiscovery();
      failedDiscoveryEnvironments.clear();
      await cache.purgeAccount({ hubOrigin, accountId: previousAccountId }).catch(() => undefined);
      snapshots.clear();
      hostedWebConnectionScopes.reset();
      clearWebHostedAccountScopedState();
    }
    if (!accountId) {
      accountKey = null;
      releaseDiscovery();
      publish([]);
      return;
    }
    const preview = readHostedReadCache();
    if (preview.accountId === accountId) {
      for (const cached of preview.snapshots)
        if (!snapshots.has(cached.environmentId)) snapshots.set(cached.environmentId, cached);
    }
    if (nextAccountKey !== accountKey && state.directoryStatus === "ready") {
      const cached = await cache.list({ hubOrigin, accountId });
      if (disposed || generation !== syncGeneration) return;
      accountKey = nextAccountKey;
      const eligibleEnvironmentIds = new Set(
        state.nodes
          .filter((node) => node.revokedAt === null && !hostedNodeRequiresNativeClient(node))
          .map((node) => node.environmentId),
      );
      for (const record of cached) {
        if (!eligibleEnvironmentIds.has(record.namespace.environmentId)) {
          await cache.purgeEnvironment(record.namespace).catch(() => undefined);
          continue;
        }
        snapshots.set(record.namespace.environmentId, record.snapshot);
        useStore
          .getState()
          .hydrateEnvironmentStateFromCache(
            workspaceMetadataToCachedShellSnapshot(record.snapshot),
            record.namespace.environmentId,
          );
      }
    }

    const selectedEnvironmentId = state.selectedNode?.environmentId ?? null;
    const activeAttempt =
      selectedEnvironmentId !== null &&
      state.transportStatus !== "idle" &&
      state.transportStatus !== "terminal-failure";
    const connected = state.transportStatus === "online" && state.sessionEstablished;
    if (lastSelectedEnvironmentId && lastSelectedEnvironmentId !== selectedEnvironmentId) {
      coordinator.reportConnected(lastSelectedEnvironmentId, false);
    }
    if (selectedEnvironmentId) coordinator.reportConnected(selectedEnvironmentId, activeAttempt);
    lastSelectedEnvironmentId = selectedEnvironmentId;
    const machines = machineCatalog(
      state.nodes,
      selectedEnvironmentId,
      connected,
      state.sessionStatus === "delivery-unknown",
      now(),
    );
    const machineByEnvironment = new Map(
      machines.map((machine) => [machine.environmentId, machine] as const),
    );
    if (state.directoryStatus === "ready") {
      for (const [environmentId] of Array.from(snapshots)) {
        const machine = machineByEnvironment.get(environmentId);
        if (machine?.cacheDisposition === "available") continue;
        snapshots.delete(environmentId);
        useStore.getState().removeEnvironmentState(environmentId);
        await cache
          .purgeEnvironment({ hubOrigin, accountId, environmentId })
          .catch(() => undefined);
      }
    }
    if (disposed || generation !== syncGeneration) return;
    publish(machines);
    scheduleHomeDiscovery();
  };

  const scheduleLiveSnapshotPublish = () => {
    if (publishTimer !== null) cancel(publishTimer);
    publishTimer = schedule(() => {
      publishTimer = null;
      if (disposed || !activeAccountId) return;
      const machines = hostedWorkspaceSnapshot.machines;
      for (const machine of machines) {
        if (!machine.canReadMetadata) continue;
        const snapshot = readWorkspaceMetadataSnapshot(
          machine.environmentId,
          now(),
          machine.deliveryUnknown,
        );
        if (!snapshot) continue;
        snapshots.set(machine.environmentId, snapshot);
        void cache
          .replace({
            namespace: {
              hubOrigin,
              accountId: activeAccountId,
              environmentId: machine.environmentId,
            },
            snapshot,
            payloadBytes: workspaceMetadataPayloadBytes(snapshot),
            updatedAt: now(),
          })
          .catch(() => undefined);
      }
      publish(machines);
      scheduleHomeDiscovery();
    }, 100);
  };

  const unsubscribeHub = hostedHubStore.subscribe(() => void synchronize());
  const unsubscribeReadCache = subscribeHostedReadCache(() => void synchronize());
  const unsubscribeRoute = subscribeRoutedHostedNode(scheduleHomeDiscovery);
  const unsubscribeScopes = hostedWebConnectionScopes.subscribe(scheduleHomeDiscovery);
  const unsubscribeStore = useStore.subscribe(scheduleLiveSnapshotPublish);
  const unsubscribeCoordinator = coordinator.subscribe(() => {
    publish(hostedWorkspaceSnapshot.machines);
    scheduleHomeDiscovery();
  });
  const resetRouteResolver = setHostedNodeRouteEnvironmentResolver(nodeIdForHostedEnvironment);
  void coordinator.reconcile();
  void synchronize();
  return () => {
    disposed = true;
    syncGeneration += 1;
    if (publishTimer !== null) cancel(publishTimer);
    unsubscribeHub();
    unsubscribeReadCache();
    unsubscribeRoute();
    unsubscribeScopes();
    releaseDiscovery();
    if (retryHomeDiscovery === retryDiscovery) retryHomeDiscovery = null;
    unsubscribeStore();
    unsubscribeCoordinator();
    resetRouteResolver();
    coordinator.dispose();
    if (activeCoordinator === coordinator) {
      activeCoordinator = null;
      hostedMutationLeaseAuthority.update({
        environmentId: null,
        snapshotGeneration: 0,
        effectiveRole: null,
        directoryReady: false,
        relayReady: false,
        shellReady: false,
      });
      publishHostedWorkspace({
        status: "signed-out",
        accountId: null,
        machines: [],
        workspace: EMPTY_WORKSPACE,
        homeDiscovery: { environmentId: null, failedEnvironmentIds: [] },
        demand: coordinator.snapshot(),
      });
    }
  };
}

export function setHostedWorkspaceBackgrounded(backgrounded: boolean): Promise<void> {
  return activeCoordinator?.setBackgrounded(backgrounded) ?? Promise.resolve();
}

export function hasActiveHostedWorkspaceCoordinator(): boolean {
  return activeCoordinator !== null;
}

export function nodeIdForHostedEnvironment(environmentId: EnvironmentId): string | null {
  return (
    hostedHubStore
      .getState()
      .nodes.find(
        (node) =>
          node.environmentId === environmentId &&
          node.revokedAt === null &&
          !hostedNodeRequiresNativeClient(node),
      )?.id ?? null
  );
}
