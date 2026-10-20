import {
  canAdoptHostedEnvironmentSession,
  createNodeMutationLeaseAuthority,
  hostedBrowserRevalidated,
  isHostedEnvironmentConnectBlocked,
  isHostedEnvironmentSessionLive,
  isJoinableHostedEnvironmentSession,
  type HostedEnvironmentReconcileRequest,
  type HostedEnvironmentSessionRecord,
  type HostedHubNode,
  type HostedHubState,
  type NodeMutationLease,
  type NodeMutationLeaseAuthority,
} from "@ryco/client-runtime/authorization";
import {
  buildUnifiedWorkspaceIndex,
  cachedHubNodeCatalogInput,
  createConnectionDemandExecutor,
  createWorkspaceConnectionDemandState,
  hostedNodeCatalogInput,
  hostedSessionConnectionState,
  reconcileWorkspaceMachineCatalog,
  workspaceMetadataPayloadBytes,
  type ConnectionDemandConnectResult,
  type ConnectionDemandExecutorSnapshot,
  type UnifiedWorkspaceIndex,
  type WorkspaceConnectionDemandState,
  type WorkspaceMachineCatalogEntry,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { selectThreadExistsByRef } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { useMessageQueueStore } from "../messageQueueStore";
import { useStore, type EnvironmentState } from "../store";
import { getBrowserWorkspaceMetadataCache } from "../persistence/workspaceMetadataCache";
import {
  readWorkspaceMetadataSnapshot,
  workspaceMetadataToCachedShellSnapshot,
} from "../workspaceMetadataProjection";
import { getHostedEnvironmentSessions, hostedHubController, hostedHubStore } from "./state";
import { clearWebHostedAccountScopedState } from "./environment";
import { startBrowserHostedThreadReadCache } from "./threadReadCache";
import {
  canShowHostedReadPreview,
  readHostedReadCache,
  purgeHostedReadCacheAuthority,
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
  startQueuedSendScopeRetention,
  type HostedWebScopeStore,
  type RetainedHostedWebScope,
} from "./hostedConnectionScopes";

/**
 * Hosted Web keeps a warm set of up to three environments per tab, the unified
 * ceiling, as qualified in the "Hosted Web warm set qualification (measured)"
 * section of docs/relay-capacity-assessment-3b.md. Concurrent full-PNG browser
 * streams stay bounded by the one sampling preview a tab may hold at a time
 * (`hostedPreviewLease.ts`). Raising this constant beyond the unified ceiling
 * is refused by the demand state; lowering it needs no new measurement.
 */
export const MAX_HOSTED_WEB_CONNECTIONS = 3;
export const HOSTED_WEB_WAKE_STAGGER_MS = 750;
/**
 * How long home discovery passes over a node whose Hub cache shell is still
 * being read before waking it over the relay anyway.
 */
export const HOME_DISCOVERY_CACHE_WAIT_MS = 1_500;

export interface HostedConnectionCoordinatorDeps {
  readonly scopes: HostedWebScopeStore;
  /**
   * The routed environment: it connects first and may displace background
   * demand.
   */
  readonly foregroundEnvironmentId?: () => EnvironmentId | null;
  readonly now: () => number;
  /**
   * Starts, or joins, the connection to one environment. `"refused"` holds the
   * environment back until it is unparked or demanded anew; a rejection is a
   * transient failure a later reconcile retries.
   */
  readonly connect: (
    environmentId: EnvironmentId,
    signal: AbortSignal,
  ) => Promise<ConnectionDemandConnectResult>;
  /** Local teardown of one environment's connection. */
  readonly release: (environmentId: EnvironmentId) => Promise<void>;
  /** Timers for staggered wakes; the global ones by default. */
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (timer: unknown) => void;
  /** Defaults to {@link MAX_HOSTED_WEB_CONNECTIONS}. */
  readonly maxConnections?: number;
  /**
   * A scope whose demand stands down for now, so it holds no lease. The routed
   * environment's scopes never do.
   */
  readonly withholds?: (entry: RetainedHostedWebScope) => boolean;
}

export interface HostedConnectionCoordinatorSnapshot {
  readonly demand: WorkspaceConnectionDemandState;
  readonly queuedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly activeConnectionCount: number;
}

export interface HostedConnectionCoordinator {
  readonly snapshot: () => HostedConnectionCoordinatorSnapshot;
  /** The shared executor's own view, connects, releases and wakes included. */
  readonly executorSnapshot: () => ConnectionDemandExecutorSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reportConnected: (environmentId: EnvironmentId, connected: boolean) => void;
  /** A live environment's relay dropped: one nothing demands is released instead of reconnecting. */
  readonly reportInterrupted: (environmentId: EnvironmentId) => void;
  readonly isDemanded: (environmentId: EnvironmentId) => boolean;
  readonly unpark: (environmentId: EnvironmentId) => void;
  /** The lifecycle owner asks for a re-plan (a resume, a retry, a directory change). */
  readonly handleReconcileRequest: (request: HostedEnvironmentReconcileRequest) => void;
  /** Resolves once the resulting connects and releases have settled. */
  readonly setBackgrounded: (backgrounded: boolean) => Promise<void>;
  /** Resolves once the resulting connects and releases have settled. */
  readonly reconcile: () => Promise<void>;
  readonly dispose: () => void;
}

/**
 * Decides when hosted Web connects and releases environments, on the shared
 * demand executor. It holds no authority: connects and releases go through the
 * ports, which call the hosted lifecycle owner, and the executor keeps the
 * connected set within the cap — strictly, through every swap.
 *
 * Mounted scopes become leases, synced before every plan (so a hidden tab's
 * throttled renewal timer never lets a live scope's lease expire). Interactive
 * scopes — drafts, home discovery, a routed node without a thread, queued
 * sends, a press on a row — are background demand a routed environment may
 * displace, though never while their own environment is routed; views never
 * are. The routed environment is the executor's foreground.
 */
export function createHostedConnectionCoordinator(
  deps: HostedConnectionCoordinatorDeps,
): HostedConnectionCoordinator {
  const leaseIdByScopeKey = new Map<string, string>();
  const listeners = new Set<() => void>();
  const changeWaiters = new Set<() => void>();
  let disposed = false;
  let published: {
    readonly source: ConnectionDemandExecutorSnapshot;
    readonly snapshot: HostedConnectionCoordinatorSnapshot;
  } | null = null;

  const syncLeases = () => {
    const foregroundEnvironmentId = deps.foregroundEnvironmentId?.() ?? null;
    executor.setForeground(foregroundEnvironmentId);
    const active = new Map<string, RetainedHostedWebScope>();
    for (const entry of deps.scopes.list()) {
      if (entry.environmentId === foregroundEnvironmentId || deps.withholds?.(entry) !== true) {
        active.set(entry.key, entry);
      }
    }
    for (const [key, leaseId] of Array.from(leaseIdByScopeKey)) {
      if (active.has(key)) continue;
      leaseIdByScopeKey.delete(key);
      executor.releaseLease(leaseId);
    }
    for (const [key, entry] of active) {
      const existing = leaseIdByScopeKey.get(key);
      if (existing !== undefined && executor.renew(existing)) continue;
      leaseIdByScopeKey.set(
        key,
        executor.retain({
          environmentId: entry.environmentId,
          scope: entry.scope,
          preemptible: entry.scope.type === "interactive",
        }),
      );
    }
  };

  const isIdle = () => {
    const current = executor.snapshot();
    return (
      current.connectingEnvironmentIds.length === 0 && current.releasingEnvironmentIds.length === 0
    );
  };

  const nextChange = () =>
    new Promise<void>((resolve) => {
      changeWaiters.add(resolve);
    });

  /**
   * Resolves once no connect or release is in flight. A connect or release
   * that settles may schedule the plan it freed a slot for, which runs a few
   * microtasks later, so each look waits for that first.
   */
  const settled = async () => {
    for (;;) {
      for (let hop = 0; hop < 4; hop += 1) await Promise.resolve();
      if (disposed || isIdle()) return;
      await nextChange();
    }
  };

  const executor = createConnectionDemandExecutor({
    maxConnections: deps.maxConnections ?? MAX_HOSTED_WEB_CONNECTIONS,
    wakeStaggerMs: HOSTED_WEB_WAKE_STAGGER_MS,
    leaseTtlMs: HOSTED_WEB_SCOPE_LEASE_TTL_MS,
    ports: {
      now: deps.now,
      setTimeout:
        deps.setTimeout ??
        ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs)),
      clearTimeout:
        deps.clearTimeout ??
        ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)),
      connect: (environmentId, signal) => deps.connect(environmentId, signal),
      release: (environmentId) => deps.release(environmentId),
      beforePlan: syncLeases,
      onChange: () => {
        for (const listener of Array.from(listeners)) listener();
        const waiters = Array.from(changeWaiters);
        changeWaiters.clear();
        for (const resolve of waiters) resolve();
      },
    },
  });

  const unsubscribeScopes = deps.scopes.subscribe(() => executor.reconcile());
  const renewalTimer = deps.setInterval(
    () => executor.reconcile(),
    HOSTED_WEB_SCOPE_REPORT_INTERVAL_MS,
  );

  return {
    snapshot() {
      const source = executor.snapshot();
      if (published?.source !== source) {
        published = {
          source,
          snapshot: {
            demand: source.demand,
            queuedEnvironmentIds: source.queuedEnvironmentIds,
            activeConnectionCount: source.activeConnectionCount,
          },
        };
      }
      return published.snapshot;
    },
    executorSnapshot: () => executor.snapshot(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportConnected: (environmentId, connected) =>
      executor.reportConnected(environmentId, connected),
    reportInterrupted: (environmentId) => executor.reportInterrupted(environmentId),
    isDemanded: (environmentId) => executor.isDemanded(environmentId),
    unpark: (environmentId) => executor.unpark(environmentId),
    handleReconcileRequest(request) {
      // A retry or a directory change lifts what held the environment back.
      if (request.environmentId !== undefined && request.reason !== "resume") {
        executor.unpark(request.environmentId);
        return;
      }
      executor.reconcile();
    },
    setBackgrounded(backgrounded) {
      executor.setBackgrounded(backgrounded);
      return settled();
    },
    reconcile() {
      executor.reconcile();
      return settled();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeScopes();
      deps.clearInterval(renewalTimer);
      executor.dispose();
      listeners.clear();
      const waiters = Array.from(changeWaiters);
      changeWaiters.clear();
      for (const resolve of waiters) resolve();
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

const NO_MACHINES: ReadonlyArray<WorkspaceMachineCatalogEntry> = [];

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
  machines: NO_MACHINES,
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
/** Each environment session's own mutation readiness. */
const recordMutationLeaseAuthorities = new Map<EnvironmentId, NodeMutationLeaseAuthority>();
const mutationLeaseListeners = new Set<() => void>();

function notifyMutationLeaseListeners(): void {
  for (const listener of Array.from(mutationLeaseListeners)) listener();
}

const NO_MUTATION_READINESS = {
  environmentId: null,
  snapshotGeneration: 0,
  effectiveRole: null,
  directoryReady: false,
  relayReady: false,
  shellReady: false,
} as const;

function recordMutationLeaseAuthority(environmentId: EnvironmentId): NodeMutationLeaseAuthority {
  const existing = recordMutationLeaseAuthorities.get(environmentId);
  if (existing) return existing;
  const authority = createNodeMutationLeaseAuthority();
  authority.subscribe(notifyMutationLeaseListeners);
  recordMutationLeaseAuthorities.set(environmentId, authority);
  return authority;
}

/** Invalidate every environment session's lease, except for the environments kept. */
function clearRecordMutationLeases(keep?: ReadonlySet<EnvironmentId>): void {
  for (const [environmentId, authority] of Array.from(recordMutationLeaseAuthorities)) {
    if (keep?.has(environmentId)) continue;
    recordMutationLeaseAuthorities.delete(environmentId);
    authority.update(NO_MUTATION_READINESS);
  }
}

export function readHostedNodeMutationLease(
  environmentId: EnvironmentId,
): NodeMutationLease | null {
  return recordMutationLeaseAuthorities.get(environmentId)?.lease(environmentId) ?? null;
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
      mutationLeaseListeners.delete(onChange);
      resolve(lease);
    };
    const onChange = () => {
      const lease = readHostedNodeMutationLease(environmentId);
      if (lease) finish(lease);
    };
    mutationLeaseListeners.add(onChange);
    const timer = globalThis.setTimeout(() => finish(null), timeoutMs);
  });
}

function sameEnvironmentIds(
  left: ReadonlyArray<EnvironmentId>,
  right: ReadonlyArray<EnvironmentId>,
): boolean {
  return (
    left.length === right.length &&
    left.every((environmentId, index) => environmentId === right[index])
  );
}

/**
 * Publish the hosted workspace when something it shows changed: its status,
 * account, machines, workspace index, demand or home discovery. An unchanged
 * snapshot notifies nobody, so a busy stream does not re-render every
 * workspace consumer on each tick.
 */
function publishHostedWorkspace(next: HostedWorkspaceSnapshot): void {
  const current = hostedWorkspaceSnapshot;
  const sameDiscovery =
    current.homeDiscovery.environmentId === next.homeDiscovery.environmentId &&
    sameEnvironmentIds(
      current.homeDiscovery.failedEnvironmentIds,
      next.homeDiscovery.failedEnvironmentIds,
    );
  if (
    sameDiscovery &&
    current.status === next.status &&
    current.accountId === next.accountId &&
    current.machines === next.machines &&
    current.workspace === next.workspace &&
    current.demand === next.demand
  ) {
    return;
  }
  hostedWorkspaceSnapshot = sameDiscovery
    ? { ...next, homeDiscovery: current.homeDiscovery }
    : next;
  for (const listener of Array.from(hostedWorkspaceListeners)) listener();
}

/**
 * Catalog data compared field by field. `observedAt` is when an entry was
 * read, not something that changed, so it never makes two entries differ.
 */
function sameCatalogValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every(
    (key) =>
      key === "observedAt" ||
      (key in rightRecord && sameCatalogValue(leftRecord[key], rightRecord[key])),
  );
}

/** The published machines when `next` shows the same, so their identity holds. */
function stableMachines(
  next: ReadonlyArray<WorkspaceMachineCatalogEntry>,
): ReadonlyArray<WorkspaceMachineCatalogEntry> {
  const current = hostedWorkspaceSnapshot.machines;
  return current.length === next.length &&
    next.every((machine, index) => sameCatalogValue(current[index], machine))
    ? current
    : next;
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

/** A directory node Hosted Web may open a connection to right now. */
function isHostedWebConnectableNode(node: HostedHubNode): boolean {
  return node.revokedAt === null && node.presence.online && !hostedNodeRequiresNativeClient(node);
}

/**
 * The parts of the hosted state that decide whether held connection demand can
 * be served: the coordinator's `connect` refuses anything while the directory
 * is not authorized, and refuses a node that is not connectable. Synchronizing
 * has already passed the account and directory checks; another node's shell
 * snapshot does not need to finish before a navigation can replace it.
 */
export interface HostedDemandReadiness {
  readonly connectable: boolean;
  /**
   * The selected node's relay attempt ended in a terminal failure. A terminal
   * failure (and the session-sync deadline) hands a `synchronizing` browser
   * back as `current` in the same patch, so a readiness edge that arrives with
   * one is the failure itself, not a reason the node could now be served.
   */
  readonly relayFailed: boolean;
  readonly eligible: ReadonlySet<EnvironmentId>;
}

export function readHostedDemandReadiness(state: HostedHubState): HostedDemandReadiness {
  return {
    connectable:
      state.accountStatus === "authenticated" &&
      state.directoryStatus === "ready" &&
      (state.browserStatus === "current" || state.browserStatus === "synchronizing"),
    relayFailed: state.selectedNode !== null && state.transportStatus === "terminal-failure",
    eligible: new Set(
      state.nodes.filter(isHostedWebConnectableNode).map((node) => node.environmentId),
    ),
  };
}

/**
 * Whether a hosted state change may unblock demand the coordinator already
 * holds: a demanded node's directory presence came online, or the directory
 * and browser became current while a demanded node is connectable.
 *
 * Without this the coordinator re-planned only on scope changes and its 25s
 * renewal tick, so demand whose connect had been refused waited for the next
 * tick after the directory poll saw the node, about 45s at worst. A presence
 * edge is a new answer from the directory and always counts. A readiness edge
 * never counts while the selected relay is terminally failed: the failure is
 * what turned the browser `current`, and re-planning then would open a fresh
 * ticket and handshake at once — after an E2EE FATAL-PRE, which must never be
 * hot-retried, or for a grant that was just revoked. Such a node is retried
 * by the renewal tick, or by its presence coming back.
 */
export function hostedDemandUnblocked(
  previous: HostedDemandReadiness,
  next: HostedDemandReadiness,
  demanded: Iterable<EnvironmentId>,
): boolean {
  if (!next.connectable) return false;
  for (const environmentId of demanded) {
    if (!next.eligible.has(environmentId)) continue;
    if (!previous.eligible.has(environmentId)) return true;
    if (!previous.connectable && !next.relayFailed) return true;
  }
  return false;
}

/** Whether held demand is waiting on a node the current directory reports offline. */
export function hostedDemandAwaitsPresence(
  state: HostedHubState,
  demanded: Iterable<EnvironmentId>,
): boolean {
  if (state.accountStatus !== "authenticated" || state.directoryStatus !== "ready") return false;
  const offline = new Set(
    state.nodes
      .filter(
        (node) =>
          node.revokedAt === null && !node.presence.online && !hostedNodeRequiresNativeClient(node),
      )
      .map((node) => node.environmentId),
  );
  for (const environmentId of demanded) {
    if (offline.has(environmentId)) return true;
  }
  return false;
}

const HOSTED_WEB_CATALOG_CLIENT = {
  clientTier: "hosted-web",
  nativeTrust: "not-required",
  requiresNativeVerification: false,
} as const;

/**
 * Each directory node as a machine: its connection state, role and delivery
 * come from the node's own environment session.
 */
function machineCatalogFor(
  nodes: ReadonlyArray<HostedHubNode>,
  recordFor: (environmentId: EnvironmentId) => HostedEnvironmentSessionRecord | undefined,
  now: number,
): ReadonlyArray<WorkspaceMachineCatalogEntry> {
  return reconcileWorkspaceMachineCatalog(
    nodes.map((node) => {
      const record = recordFor(node.environmentId);
      return hostedNodeCatalogInput(node, {
        ...HOSTED_WEB_CATALOG_CLIENT,
        session: record
          ? {
              transportStatus: record.transportStatus,
              sessionStatus: record.sessionStatus,
              effectiveRole: record.effectiveRole,
            }
          : null,
        deliveryUnknown: record?.sessionStatus === "delivery-unknown",
        observedAt: now,
      });
    }),
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
  readonly startReadCache?: typeof startBrowserHostedThreadReadCache;
  /** Defaults to {@link MAX_HOSTED_WEB_CONNECTIONS}. */
  readonly maxConnections?: number;
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
  /** Bumped with every change to {@link snapshots}; the workspace index is rebuilt only then. */
  let snapshotsRevision = 0;
  const setSnapshot = (environmentId: EnvironmentId, snapshot: WorkspaceMetadataSnapshot) => {
    snapshots.set(environmentId, snapshot);
    snapshotsRevision += 1;
  };
  const deleteSnapshot = (environmentId: EnvironmentId) => {
    if (snapshots.delete(environmentId)) snapshotsRevision += 1;
  };
  const clearSnapshots = () => {
    if (snapshots.size === 0) return;
    snapshots.clear();
    snapshotsRevision += 1;
  };
  /**
   * The store slices each environment's live snapshot was last read from, and
   * that snapshot. An environment whose slices kept their identity is not read,
   * written to the cache or published again.
   */
  const liveSnapshotSources = new Map<
    EnvironmentId,
    { readonly slices: ReadonlyArray<unknown>; readonly snapshot: WorkspaceMetadataSnapshot }
  >();
  let workspaceIndex: {
    readonly machines: ReadonlyArray<WorkspaceMachineCatalogEntry>;
    readonly revision: number;
    readonly index: UnifiedWorkspaceIndex;
  } | null = null;
  const workspaceIndexFor = (machines: ReadonlyArray<WorkspaceMachineCatalogEntry>) => {
    if (workspaceIndex?.machines === machines && workspaceIndex.revision === snapshotsRevision) {
      return workspaceIndex.index;
    }
    const index = buildUnifiedWorkspaceIndex({
      machines,
      snapshots: Array.from(snapshots.values()),
    });
    workspaceIndex = { machines, revision: snapshotsRevision, index };
    return index;
  };
  let accountKey: string | null = null;
  let activeAccountId: string | null = null;
  let activeAuthority: string | null = null;
  let authorityResetPending = false;
  let authorityResetSequence = 0;
  let authorityCleanup: Promise<void> = Promise.resolve();
  let publishTimer: unknown = null;
  let disposed = false;
  let syncGeneration = 0;
  let discoveryEnvironmentId: EnvironmentId | null = null;
  let releaseDiscoveryScope: (() => void) | null = null;
  let discoveryPending = false;
  const failedDiscoveryEnvironments = new Set<EnvironmentId>();
  /**
   * Nodes whose Hub cache shell read is in flight, with when discovery first
   * saw it pending. A shell about to land makes a relay wake-up unnecessary, so
   * discovery passes over such a node for at most
   * {@link HOME_DISCOVERY_CACHE_WAIT_MS}.
   */
  const pendingCacheShells = new Map<string, number>();
  let cacheWaitTimer: unknown = null;
  const sessions = getHostedEnvironmentSessions();
  /**
   * Scopes of background demand that yielded to a rate limit. They hold no
   * lease until they are released or their environment is routed, so a
   * rate-limited relay is not retried by every tick.
   */
  const rateLimitedScopeKeys = new Set<string>();

  // An offline routed node still gets its bounded attempt from the lifecycle
  // owner.
  const routedEnvironmentId = (): EnvironmentId | null => {
    const route = getRoutedHostedNode();
    if (route.malformed || route.nodeId === null) return null;
    return (
      hostedHubStore
        .getState()
        .nodes.find(
          (node) =>
            node.id === route.nodeId &&
            node.revokedAt === null &&
            !hostedNodeRequiresNativeClient(node),
        )?.environmentId ?? null
    );
  };

  /** The routed and the selected environment keep their transport's own backoff. */
  const keepsBackoff = (environmentId: EnvironmentId) =>
    environmentId === routedEnvironmentId() ||
    environmentId === hostedHubStore.getState().selectedNode?.environmentId;

  /** The current directory reports the environment's node offline. */
  const awaitsPresence = (environmentId: EnvironmentId) =>
    hostedDemandAwaitsPresence(hostedHubStore.getState(), [environmentId]);

  // The lifecycle owner's acquire is the only way any connection is created,
  // and it never moves the selection.
  const connect = async (environmentId: EnvironmentId): Promise<ConnectionDemandConnectResult> => {
    const nodeId = disposed ? null : nodeIdForHostedEnvironment(environmentId);
    if (nodeId === null) throw new Error("Hosted Web environment is not eligible.");
    const acquisition = await hostedHubController.acquireEnvironment(nodeId);
    return acquisition === "refused" ? "refused" : "connected";
  };

  const coordinator = createHostedConnectionCoordinator({
    scopes: hostedWebConnectionScopes,
    foregroundEnvironmentId: routedEnvironmentId,
    now,
    setTimeout: schedule,
    clearTimeout: cancel,
    setInterval: repeat,
    clearInterval: cancelRepeat,
    maxConnections: input?.maxConnections ?? MAX_HOSTED_WEB_CONNECTIONS,
    connect,
    release: (environmentId) => hostedHubController.releaseEnvironment(environmentId),
    // Demand that yields holds no lease while its reason lasts: background
    // demand that was rate limited, and demand for a node the directory
    // reports offline, which waits for presence instead.
    withholds: (entry) =>
      !keepsBackoff(entry.environmentId) &&
      (rateLimitedScopeKeys.has(entry.key) || awaitsPresence(entry.environmentId)),
  });
  activeCoordinator = coordinator;

  /** Environments holding a slot: connected, or connecting. */
  const liveEnvironmentIds = () => {
    const current = coordinator.executorSnapshot();
    const live = new Set(current.connectingEnvironmentIds);
    for (const entry of current.demand.connections) {
      if (entry.connected) live.add(entry.environmentId);
    }
    return live;
  };

  // A live environment whose demand yields is released. `reportInterrupted`
  // releases only an environment that, with its leases synced, nothing demands.
  const yieldOfflineEnvironments = () => {
    if (disposed) return;
    for (const environmentId of liveEnvironmentIds()) {
      if (!keepsBackoff(environmentId) && awaitsPresence(environmentId)) {
        coordinator.reportInterrupted(environmentId);
      }
    }
  };

  const yieldRateLimited = (environmentId: EnvironmentId) => {
    if (keepsBackoff(environmentId)) return;
    const scopes = hostedWebConnectionScopes
      .list()
      .filter((entry) => entry.environmentId === environmentId);
    // A mounted view keeps the environment on its transport's backoff.
    if (scopes.some((entry) => entry.scope.type !== "interactive")) return;
    for (const entry of scopes) rateLimitedScopeKeys.add(entry.key);
    coordinator.reportInterrupted(environmentId);
  };

  // The connected set is derived from the records, so a suspended, failed or
  // released record frees its slot and is acquired again once it is demanded.
  let observedRecords: ReadonlyMap<EnvironmentId, HostedEnvironmentSessionRecord> | null = null;
  let observingRecords = false;
  let observeRecordsAgain = false;
  const observeRecordsOnce = () => {
    if (disposed) return;
    const { records } = sessions.getSnapshot();
    const previous = observedRecords;
    if (records === previous) return;
    observedRecords = records;
    const executor = coordinator.executorSnapshot();
    const tracked = new Set<EnvironmentId>(executor.connectingEnvironmentIds);
    for (const entry of executor.demand.connections) tracked.add(entry.environmentId);
    // Records that outlived an earlier coordinator still hold their channels.
    // The first pass counts every live one before anything is planned, so new
    // demand waits for a free slot instead of opening channels past the cap.
    if (previous === null) {
      for (const [environmentId, record] of records) {
        if (isHostedEnvironmentSessionLive(record)) tracked.add(environmentId);
      }
    }
    for (const environmentId of tracked) {
      coordinator.reportConnected(
        environmentId,
        isHostedEnvironmentSessionLive(records.get(environmentId)),
      );
    }
    for (const [environmentId, record] of records) {
      const before = previous?.get(environmentId);
      if (
        record.relayGap &&
        (before?.relayGap !== true || before.generation !== record.generation)
      ) {
        coordinator.reportInterrupted(environmentId);
      }
      // A renewed record, or one whose terminal failure the directory lifted,
      // may connect again.
      if (
        before !== undefined &&
        ((before.generation !== record.generation && !record.suspended) ||
          (isHostedEnvironmentConnectBlocked(before) && !isHostedEnvironmentConnectBlocked(record)))
      ) {
        coordinator.unpark(environmentId);
      }
      if (record.failure?.kind === "rate-limited" && before?.failure !== record.failure) {
        yieldRateLimited(environmentId);
      }
    }
    yieldOfflineEnvironments();
  };
  const observeRecords = () => {
    if (disposed) return;
    // A release started here publishes the registry again from inside its
    // notification; that change is observed once this pass is done.
    if (observingRecords) {
      observeRecordsAgain = true;
      return;
    }
    observingRecords = true;
    try {
      do {
        observeRecordsAgain = false;
        observeRecordsOnce();
      } while (observeRecordsAgain);
    } finally {
      observingRecords = false;
    }
  };

  const machineCatalog = (state: HostedHubState) =>
    stableMachines(
      machineCatalogFor(state.nodes, (environmentId) => sessions.read(environmentId), now()),
    );

  /**
   * What a record's lease may hold right now, read from the current directory,
   * the record itself and the snapshots held, never from the last published
   * catalog, which can trail a registry or directory change by a microtask.
   * The shell rule is the catalog's own: the record's session is connected and
   * its node is one this tier may connect to.
   */
  const currentMutationReadiness = (
    state: HostedHubState,
    record: HostedEnvironmentSessionRecord,
  ) => {
    const node = state.nodes.find((entry) => entry.environmentId === record.environmentId);
    return {
      directoryReady:
        state.directoryStatus === "ready" && hostedBrowserRevalidated(state.browserStatus),
      relayReady: record.transportStatus === "online" && record.sessionEstablished,
      shellReady:
        snapshots.has(record.environmentId) &&
        node !== undefined &&
        isHostedWebConnectableNode(node) &&
        hostedSessionConnectionState(record) === "connected",
    };
  };

  // Each environment session earns its lease with its own relay attempt and
  // accepted snapshot, and the lease names the record generation that did.
  // The published catalog must show the shell too, so a projection that is
  // being reset grants nothing.
  const updateMutationLeases = (
    state: HostedHubState,
    machines: ReadonlyArray<WorkspaceMachineCatalogEntry>,
  ) => {
    const publishedShell = (environmentId: EnvironmentId) =>
      machines.some(
        (machine) =>
          machine.environmentId === environmentId &&
          machine.connectionState === "connected" &&
          machine.canMutate,
      );
    const kept = new Set<EnvironmentId>();
    for (const record of sessions.list()) {
      kept.add(record.environmentId);
      const current = currentMutationReadiness(state, record);
      recordMutationLeaseAuthority(record.environmentId).update({
        environmentId: record.environmentId,
        snapshotGeneration: record.generation,
        effectiveRole: record.effectiveRole,
        directoryReady: current.directoryReady,
        relayReady: current.relayReady,
        shellReady: current.shellReady && publishedShell(record.environmentId),
      });
    }
    clearRecordMutationLeases(kept);
  };

  // A lease whose record was suspended, interrupted, renewed, downgraded or
  // released, whose session stopped being ready (replaying, delivery unknown),
  // whose node left the directory or stopped being connectable, whose snapshot
  // is gone, or whose directory or browser is no longer revalidated is revoked
  // in the same turn the registry or hosted store reports it, or the snapshot
  // is dropped. Readiness is read from the current state, never from the
  // published catalog, so a catalog that trails by a microtask keeps nothing.
  // Only revocation is immediate: a lease is granted by the coalesced
  // synchronize, which publishes a fresh machine catalog.
  const revokeStaleMutationLeases = () => {
    const state = hostedHubStore.getState();
    const kept = new Set<EnvironmentId>();
    for (const record of sessions.list()) {
      const authority = recordMutationLeaseAuthorities.get(record.environmentId);
      if (!authority) continue;
      kept.add(record.environmentId);
      if (authority.lease(record.environmentId) === null) continue;
      const held = authority.read();
      const current = currentMutationReadiness(state, record);
      const sameAttempt =
        record.generation === held.snapshotGeneration &&
        record.effectiveRole === held.effectiveRole;
      if (sameAttempt && current.directoryReady && current.relayReady && current.shellReady) {
        continue;
      }
      authority.update({
        environmentId: record.environmentId,
        snapshotGeneration: record.generation,
        effectiveRole: record.effectiveRole,
        directoryReady: held.directoryReady && current.directoryReady,
        relayReady: held.relayReady && current.relayReady && sameAttempt,
        shellReady: held.shellReady && current.shellReady,
      });
    }
    clearRecordMutationLeases(kept);
  };

  /**
   * The environment's last connection attempt ended in a terminal failure, or
   * its background demand yielded to a rate limit.
   */
  const relayFailed = (environmentId: EnvironmentId) =>
    sessions.read(environmentId)?.transportStatus === "terminal-failure" ||
    hostedWebConnectionScopes
      .list()
      .some(
        (entry) => entry.environmentId === environmentId && rateLimitedScopeKeys.has(entry.key),
      );

  let previewIndex: {
    readonly machines: ReadonlyArray<WorkspaceMachineCatalogEntry>;
    readonly snapshots: ReadonlyArray<WorkspaceMetadataSnapshot>;
    readonly index: UnifiedWorkspaceIndex;
  } | null = null;
  const buildPreviewIndex = (
    machines: ReadonlyArray<WorkspaceMachineCatalogEntry>,
    previewSnapshots: ReadonlyArray<WorkspaceMetadataSnapshot>,
  ) => {
    if (previewIndex?.machines !== machines || previewIndex.snapshots !== previewSnapshots) {
      previewIndex = {
        machines,
        snapshots: previewSnapshots,
        index: buildUnifiedWorkspaceIndex({ machines, snapshots: previewSnapshots }),
      };
    }
    return previewIndex.index;
  };

  let previewMachines: {
    readonly cached: ReturnType<typeof readHostedReadCache>;
    readonly machines: ReadonlyArray<WorkspaceMachineCatalogEntry>;
  } | null = null;
  const publish = (machines: ReadonlyArray<WorkspaceMachineCatalogEntry>) => {
    const state = hostedHubStore.getState();
    const cached = readHostedReadCache();
    if (state.accountStatus !== "authenticated" && canShowHostedReadPreview()) {
      clearRecordMutationLeases();
      if (previewMachines?.cached !== cached) {
        previewMachines = {
          cached,
          machines: reconcileWorkspaceMachineCatalog(
            cached.nodes.map((node) =>
              cachedHubNodeCatalogInput({
                environmentId: node.environmentId,
                nodeId: node.nodeId,
                label: node.label,
                observedAt: now(),
                clientTier: "hosted-web",
              }),
            ),
          ).map((machine) => ({ ...machine, canConnect: false, canMutate: false })),
        };
      }
      const cachedMachines = previewMachines.machines;
      publishHostedWorkspace({
        status: "stale",
        accountId: cached.accountId,
        machines: cachedMachines,
        workspace: buildPreviewIndex(cachedMachines, cached.snapshots),
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
    updateMutationLeases(state, machines);
    publishHostedWorkspace({
      status,
      accountId: state.account?.id ?? null,
      machines,
      workspace: workspaceIndexFor(machines),
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
    const eligible = state.nodes.filter(isHostedWebConnectableNode);
    const awaitingCacheShell = (node: HostedHubNode) => {
      const since = pendingCacheShells.get(node.id);
      return since !== undefined && now() - since < HOME_DISCOVERY_CACHE_WAIT_MS;
    };
    if (!canDiscover) {
      releaseDiscovery();
    } else {
      if (discoveryEnvironmentId !== null) {
        const failed = relayFailed(discoveryEnvironmentId);
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
            !failedDiscoveryEnvironments.has(node.environmentId) &&
            !awaitingCacheShell(node),
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

  const authenticatedAccountId = (state: HostedHubState) =>
    state.accountStatus === "authenticated" ? (state.account?.id ?? null) : null;
  /** The account, session and Space whose read model the workspace shows. */
  const authorityKey = (state: HostedHubState) => {
    const accountId = authenticatedAccountId(state);
    return accountId
      ? JSON.stringify([
          hubOrigin,
          accountId,
          state.session?.id ?? null,
          state.session?.activeSpaceId ?? null,
        ])
      : null;
  };

  const synchronize = async () => {
    if (disposed) return;
    const generation = ++syncGeneration;
    const state = hostedHubStore.getState();
    // A failed session check does not prove sign-out. Retain the remembered
    // account's read model while the single lifecycle owner retries access.
    if (state.accountStatus === "unavailable" && canShowHostedReadPreview()) {
      releaseDiscovery();
      publish(NO_MACHINES);
      return;
    }
    const accountId = authenticatedAccountId(state);
    const nextAccountKey = accountId ? JSON.stringify([hubOrigin, accountId]) : null;
    const nextAuthority = authorityKey(state);
    const previousAccountId = activeAccountId;
    const previousAuthority = activeAuthority;
    activeAccountId = accountId;
    activeAuthority = nextAuthority;
    if (previousAuthority && nextAuthority !== previousAuthority) {
      // Fence the visible projection synchronously, before storage or another
      // session's cache response can complete.
      accountKey = null;
      authorityResetPending = true;
      const resetSequence = ++authorityResetSequence;
      releaseDiscovery();
      failedDiscoveryEnvironments.clear();
      clearSnapshots();
      liveSnapshotSources.clear();
      // Mounted route leases express intent, not authority. Preserve them
      // across same-account credential/Space changes so fresh admission can
      // reconnect unchanged routes; an account switch discards that intent.
      if (accountId !== previousAccountId) hostedWebConnectionScopes.reset();
      clearWebHostedAccountScopedState();
      publish(NO_MACHINES);
      const cleanup = Promise.all([
        authorityCleanup,
        previousAccountId
          ? cache.purgeAccount({ hubOrigin, accountId: previousAccountId }).catch(() => undefined)
          : Promise.resolve(),
        purgeHostedReadCacheAuthority().catch(() => undefined),
      ]).then(() => undefined);
      authorityCleanup = cleanup;
      await cleanup;
      if (resetSequence === authorityResetSequence) {
        authorityResetPending = false;
        if (!disposed) runSynchronize();
      }
      return;
    }
    if (authorityResetPending) return;
    if (!accountId) {
      accountKey = null;
      releaseDiscovery();
      publish(NO_MACHINES);
      return;
    }
    const preview = readHostedReadCache();
    if (preview.accountId === accountId) {
      for (const cached of preview.snapshots)
        if (!snapshots.has(cached.environmentId)) setSnapshot(cached.environmentId, cached);
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
        if (disposed || generation !== syncGeneration || authorityResetPending) return;
        if (!eligibleEnvironmentIds.has(record.namespace.environmentId)) {
          await cache.purgeEnvironment(record.namespace).catch(() => undefined);
          continue;
        }
        const current = snapshots.get(record.namespace.environmentId);
        if (!current || current.capturedAt <= record.snapshot.capturedAt)
          setSnapshot(record.namespace.environmentId, record.snapshot);
        useStore
          .getState()
          .hydrateEnvironmentStateFromCache(
            workspaceMetadataToCachedShellSnapshot(record.snapshot),
            record.namespace.environmentId,
          );
      }
    }

    if (disposed || generation !== syncGeneration || authorityResetPending) return;
    const machines = machineCatalog(state);
    const machineByEnvironment = new Map(
      machines.map((machine) => [machine.environmentId, machine] as const),
    );
    if (state.directoryStatus === "ready") {
      for (const [environmentId] of Array.from(snapshots)) {
        if (disposed || generation !== syncGeneration || authorityResetPending) return;
        const machine = machineByEnvironment.get(environmentId);
        if (machine?.cacheDisposition === "available") continue;
        deleteSnapshot(environmentId);
        liveSnapshotSources.delete(environmentId);
        // A lease never outlives its shell, not even until the purge settles.
        revokeStaleMutationLeases();
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

  /**
   * What {@link synchronize} reads from outside: the account, session, Space,
   * directory and browser status, the directory nodes, the read cache and the
   * environment session records. A hosted store patch that changes none of
   * them (a projected transport status, a role, an error message) is skipped.
   */
  const synchronizeInputs = (): ReadonlyArray<unknown> => {
    const state = hostedHubStore.getState();
    return [
      state.accountStatus,
      state.account?.id ?? null,
      state.session?.id ?? null,
      state.session?.activeSpaceId ?? null,
      state.directoryStatus,
      state.browserStatus,
      state.nodes,
      readHostedReadCache(),
      canShowHostedReadPreview(),
      sessions.getSnapshot().records,
    ];
  };
  let synchronizedInputs: ReadonlyArray<unknown> | null = null;
  const runSynchronize = () => {
    synchronizedInputs = synchronizeInputs();
    void synchronize();
  };
  let synchronizePending = false;
  // One pass per microtask, however many patches a transition publishes.
  const scheduleSynchronize = () => {
    if (synchronizePending || disposed) return;
    synchronizePending = true;
    queueMicrotask(() => {
      synchronizePending = false;
      if (disposed) return;
      const inputs = synchronizeInputs();
      if (
        synchronizedInputs !== null &&
        inputs.every((value, index) => Object.is(value, synchronizedInputs![index]))
      ) {
        return;
      }
      runSynchronize();
    });
  };

  /** The store slices an environment's metadata snapshot is derived from. */
  const metadataSlices = (
    environment: EnvironmentState | undefined,
    deliveryUnknown: boolean,
  ): ReadonlyArray<unknown> | null =>
    environment?.bootstrapComplete
      ? [
          environment.projectIds,
          environment.projectById,
          environment.worktreeIds,
          environment.worktreeById,
          environment.threadIds,
          environment.sidebarThreadSummaryById,
          deliveryUnknown,
        ]
      : null;

  const scheduleLiveSnapshotPublish = () => {
    // A busy stream must not postpone metadata discovery indefinitely. Read
    // the latest store at a bounded cadence instead of waiting for silence.
    if (publishTimer !== null) return;
    publishTimer = schedule(() => {
      publishTimer = null;
      if (disposed || authorityResetPending || !activeAccountId) return;
      const machines = hostedWorkspaceSnapshot.machines;
      const state = useStore.getState();
      let changed = false;
      for (const machine of machines) {
        if (!machine.canReadMetadata) continue;
        const { environmentId } = machine;
        const slices = metadataSlices(
          state.environmentStateById[environmentId],
          machine.deliveryUnknown,
        );
        if (slices === null) continue;
        const source = liveSnapshotSources.get(environmentId);
        // Nothing the snapshot shows moved since it was published (a streamed
        // message, for one), and no other snapshot replaced it meanwhile.
        if (
          source !== undefined &&
          snapshots.get(environmentId) === source.snapshot &&
          slices.every((slice, index) => Object.is(slice, source.slices[index]))
        ) {
          continue;
        }
        const snapshot = readWorkspaceMetadataSnapshot(
          environmentId,
          now(),
          machine.deliveryUnknown,
          state,
        );
        if (!snapshot) continue;
        liveSnapshotSources.set(environmentId, { slices, snapshot });
        setSnapshot(environmentId, snapshot);
        changed = true;
        void cache
          .replace({
            namespace: { hubOrigin, accountId: activeAccountId, environmentId },
            snapshot,
            payloadBytes: workspaceMetadataPayloadBytes(snapshot),
            updatedAt: now(),
          })
          .catch(() => undefined);
      }
      if (!changed) return;
      publish(machines);
      scheduleHomeDiscovery();
    }, 100);
  };

  // Re-plan held demand the moment the directory says it can be served, and
  // ask the directory to watch presence faster while demand waits on an
  // offline node. `connect` still enforces every readiness condition itself.
  let demandReadiness = readHostedDemandReadiness(hostedHubStore.getState());
  let releasePresenceWatch: (() => void) | null = null;
  const observeDemand = () => {
    if (disposed) return;
    const state = hostedHubStore.getState();
    const demanded = hostedWebConnectionScopes.list().map((entry) => entry.environmentId);
    const next = readHostedDemandReadiness(state);
    const unblocked = hostedDemandUnblocked(demandReadiness, next, demanded);
    demandReadiness = next;
    if (hostedDemandAwaitsPresence(state, demanded)) {
      releasePresenceWatch ??= hostedHubController.watchDirectoryPresence();
    } else if (releasePresenceWatch) {
      releasePresenceWatch();
      releasePresenceWatch = null;
    }
    if (unblocked) void coordinator.reconcile();
    yieldOfflineEnvironments();
  };

  // Rate-limit yields end with the scopes that yielded, and for the routed
  // environment, which keeps its transport's backoff.
  const forgetRateLimitYields = () => {
    if (rateLimitedScopeKeys.size === 0) return;
    const routed = routedEnvironmentId();
    const present = new Map(
      hostedWebConnectionScopes.list().map((entry) => [entry.key, entry] as const),
    );
    for (const key of Array.from(rateLimitedScopeKeys)) {
      const entry = present.get(key);
      if (entry === undefined || entry.environmentId === routed) rateLimitedScopeKeys.delete(key);
    }
  };

  const unsubscribeHub = hostedHubStore.subscribe(() => {
    observeDemand();
    revokeStaleMutationLeases();
    // A new account, session or Space fences the visible projection in the
    // same patch; every other change coalesces.
    if (authorityKey(hostedHubStore.getState()) !== activeAuthority) runSynchronize();
    else scheduleSynchronize();
  });
  const unsubscribeDemandScopes = hostedWebConnectionScopes.subscribe(() => {
    forgetRateLimitYields();
    observeDemand();
  });
  const unsubscribeReadCache = subscribeHostedReadCache(scheduleSynchronize);
  const unsubscribeRoute = subscribeRoutedHostedNode(() => {
    forgetRateLimitYields();
    scheduleHomeDiscovery();
    void coordinator.reconcile();
    yieldOfflineEnvironments();
  });
  const unsubscribeSessions = sessions.subscribe(() => {
    observeRecords();
    revokeStaleMutationLeases();
    scheduleSynchronize();
  });
  const unsubscribeScopes = hostedWebConnectionScopes.subscribe(scheduleHomeDiscovery);
  const unsubscribeStore = useStore.subscribe(scheduleLiveSnapshotPublish);
  // Queued sends hold demand for their environment until the queue drains.
  const queuedThreadKeys = () => {
    const keys: string[] = [];
    for (const [threadKey, queue] of Object.entries(
      useMessageQueueStore.getState().queuesByThreadKey,
    )) {
      if (queue.length > 0) keys.push(threadKey);
    }
    return keys;
  };
  const stopQueuedSendScopes = startQueuedSendScopeRetention({
    queuedThreadKeys,
    isServerThread: (ref) => selectThreadExistsByRef(useStore.getState(), ref),
    subscribe: (listener) => {
      const unsubscribeQueues = useMessageQueueStore.subscribe(listener);
      // A queued draft becomes a server thread once its thread exists; with
      // nothing queued, a thread store change cannot change the demand.
      const unsubscribeThreads = useStore.subscribe(() => {
        if (queuedThreadKeys().length > 0) listener();
      });
      return () => {
        unsubscribeQueues();
        unsubscribeThreads();
      };
    },
  });
  const unsubscribeCoordinator = coordinator.subscribe(() => {
    publish(hostedWorkspaceSnapshot.machines);
    scheduleHomeDiscovery();
  });
  const resetRouteResolver = setHostedNodeRouteEnvironmentResolver(nodeIdForHostedEnvironment);
  const onCacheShellReadsChanged = (nodeIds: ReadonlySet<string>) => {
    if (disposed) return;
    const at = now();
    for (const nodeId of pendingCacheShells.keys()) {
      if (!nodeIds.has(nodeId)) pendingCacheShells.delete(nodeId);
    }
    for (const nodeId of nodeIds) {
      if (!pendingCacheShells.has(nodeId)) pendingCacheShells.set(nodeId, at);
    }
    if (cacheWaitTimer !== null) cancel(cacheWaitTimer);
    cacheWaitTimer = null;
    if (pendingCacheShells.size > 0) {
      // Re-check at the bound, should a read still be pending then.
      const oldest = Math.min(...pendingCacheShells.values());
      cacheWaitTimer = schedule(
        () => {
          cacheWaitTimer = null;
          scheduleHomeDiscovery();
        },
        Math.max(0, oldest + HOME_DISCOVERY_CACHE_WAIT_MS - at),
      );
    }
    scheduleHomeDiscovery();
  };
  const stopReadCache = (input?.startReadCache ?? startBrowserHostedThreadReadCache)((snapshot) => {
    const previous = snapshots.get(snapshot.environmentId);
    if (previous && previous.capturedAt > snapshot.capturedAt) return;
    setSnapshot(snapshot.environmentId, snapshot);
    publish(hostedWorkspaceSnapshot.machines);
    scheduleHomeDiscovery();
  }, onCacheShellReadsChanged);
  observeRecords();
  void coordinator.reconcile();
  observeDemand();
  runSynchronize();
  return () => {
    disposed = true;
    syncGeneration += 1;
    if (publishTimer !== null) cancel(publishTimer);
    if (cacheWaitTimer !== null) cancel(cacheWaitTimer);
    cacheWaitTimer = null;
    unsubscribeHub();
    unsubscribeSessions();
    unsubscribeDemandScopes();
    releasePresenceWatch?.();
    releasePresenceWatch = null;
    unsubscribeReadCache();
    unsubscribeRoute();
    unsubscribeScopes();
    releaseDiscovery();
    if (retryHomeDiscovery === retryDiscovery) retryHomeDiscovery = null;
    unsubscribeStore();
    stopQueuedSendScopes();
    stopReadCache();
    unsubscribeCoordinator();
    resetRouteResolver();
    coordinator.dispose();
    if (activeCoordinator === coordinator) {
      activeCoordinator = null;
      clearRecordMutationLeases();
      publishHostedWorkspace({
        status: "signed-out",
        accountId: null,
        machines: NO_MACHINES,
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

/**
 * Whether the running workspace coordinator still wants the environment
 * connected: it is routed, or holds a lease. A relay binding asks this before
 * reconnecting a dropped channel. Without a coordinator nothing decides demand,
 * and the transport keeps its own backoff.
 */
export function isHostedEnvironmentDemanded(environmentId: EnvironmentId): boolean {
  return activeCoordinator?.isDemanded(environmentId) ?? true;
}

/**
 * Whether a press on one of the environment's rows may connect it ahead of the
 * navigation that follows: a workspace coordinator runs, the environment's node
 * is one this tier may connect now, and the environment has no session that is
 * live or on its way — selecting such a session adopts or joins it instead.
 */
export function canPreconnectHostedEnvironment(environmentId: EnvironmentId): boolean {
  if (activeCoordinator === null) return false;
  const connectable = hostedHubStore
    .getState()
    .nodes.some((node) => node.environmentId === environmentId && isHostedWebConnectableNode(node));
  if (!connectable) return false;
  const record = getHostedEnvironmentSessions().read(environmentId);
  return (
    record === undefined ||
    (!canAdoptHostedEnvironmentSession(record) && !isJoinableHostedEnvironmentSession(record))
  );
}

/** The hosted lifecycle owner asks the running workspace coordinator to re-plan. */
export function requestHostedWorkspaceReconcile(request: HostedEnvironmentReconcileRequest): void {
  activeCoordinator?.handleReconcileRequest(request);
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
