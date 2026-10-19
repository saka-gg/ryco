import {
  createNodeMutationLeaseAuthority,
  hostedBrowserRevalidated,
  isHostedEnvironmentConnectBlocked,
  isHostedEnvironmentSessionLive,
  type HostedEnvironmentReconcileRequest,
  type HostedEnvironmentSessionRecord,
  type HostedEnvironmentSessionsMode,
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
  reconcileWorkspaceMachineCatalog,
  workspaceMetadataPayloadBytes,
  type ConnectionDemandConnectResult,
  type ConnectionDemandExecutorSnapshot,
  type UnifiedWorkspaceIndex,
  type WorkspaceConnectionDemandState,
  type WorkspaceMachineCatalogEntry,
  type WorkspaceMachineCatalogInput,
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
import {
  getHostedEnvironmentSessions,
  hostedEnvironmentSessionsMode,
  hostedHubController,
  hostedHubStore,
} from "./state";
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
  type HostedWebScopeStore,
  type RetainedHostedWebScope,
} from "./hostedConnectionScopes";

/**
 * Hosted Web remains at one connection. The native ceiling of three from
 * docs/relay-capacity-assessment-3b.md is not assumed safe for concurrent
 * full-PNG browser streams; raising this constant requires measurements in the
 * same change.
 * Retained environment sessions are enabled only when this is > 1 (see
 * `HOSTED_WEB_RETAINED_ENVIRONMENT_SESSIONS`).
 */
export const MAX_HOSTED_WEB_CONNECTIONS = 1;
export const HOSTED_WEB_WAKE_STAGGER_MS = 750;
/**
 * How long home discovery passes over a node whose Hub cache shell is still
 * being read before waking it over the relay anyway.
 */
export const HOME_DISCOVERY_CACHE_WAIT_MS = 1_500;

export interface HostedConnectionCoordinatorDeps {
  readonly scopes: HostedWebScopeStore;
  /**
   * The routed environment. With one session a navigation intent takes
   * precedence over scopes from the outgoing shell; with retained sessions the
   * routed environment connects first and may displace background demand.
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
  /** Defaults to `single`. */
  readonly mode?: HostedEnvironmentSessionsMode;
  /**
   * Retained sessions only: a scope whose demand stands down for now, so it
   * holds no lease. The routed environment's scopes never do.
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
 * scopes — drafts, home discovery, a routed node without a thread — are
 * background demand a routed environment may displace, though never while
 * their own environment is routed; views never are. With one session only the
 * routed environment's scopes count; with retained sessions every scope does,
 * and the routed environment is the executor's foreground.
 */
export function createHostedConnectionCoordinator(
  deps: HostedConnectionCoordinatorDeps,
): HostedConnectionCoordinator {
  const mode = deps.mode ?? "single";
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
    if (mode === "retained") executor.setForeground(foregroundEnvironmentId);
    const active = new Map<string, RetainedHostedWebScope>();
    for (const entry of deps.scopes.list()) {
      const counts =
        mode === "single"
          ? foregroundEnvironmentId === null || entry.environmentId === foregroundEnvironmentId
          : entry.environmentId === foregroundEnvironmentId || deps.withholds?.(entry) !== true;
      if (counts) active.set(entry.key, entry);
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
/** The selected node's mutation readiness, with one session. */
const hostedMutationLeaseAuthority = createNodeMutationLeaseAuthority();
/** Each environment session's own mutation readiness, with retained sessions. */
const recordMutationLeaseAuthorities = new Map<EnvironmentId, NodeMutationLeaseAuthority>();
const mutationLeaseListeners = new Set<() => void>();

function notifyMutationLeaseListeners(): void {
  for (const listener of Array.from(mutationLeaseListeners)) listener();
}

hostedMutationLeaseAuthority.subscribe(notifyMutationLeaseListeners);

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
  return (
    recordMutationLeaseAuthorities.get(environmentId)?.lease(environmentId) ??
    hostedMutationLeaseAuthority.lease(environmentId)
  );
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
 * Each directory node as a machine with retained sessions: its connection
 * state, role and delivery come from the node's own environment session.
 */
function retainedMachineCatalog(
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

/**
 * Each directory node as a machine with one session: the selected node is
 * connected while its relay is online and its session established — replaying
 * or with unknown delivery included — and every other node is disconnected.
 * Roles and last-seen times come from the directory.
 */
function singleSessionMachineCatalog(
  nodes: ReadonlyArray<HostedHubNode>,
  state: HostedHubState,
  now: number,
): ReadonlyArray<WorkspaceMachineCatalogEntry> {
  const selectedEnvironmentId = state.selectedNode?.environmentId ?? null;
  const connected = state.transportStatus === "online" && state.sessionEstablished;
  return reconcileWorkspaceMachineCatalog(
    nodes.map((node): WorkspaceMachineCatalogInput => {
      const selected = node.environmentId === selectedEnvironmentId;
      return {
        ...hostedNodeCatalogInput(node, {
          ...HOSTED_WEB_CATALOG_CLIENT,
          session: null,
          deliveryUnknown: false,
          observedAt: now,
        }),
        lastSeenAt: node.presence.lastHeartbeatAt,
        connectionState: selected && connected ? "connected" : "disconnected",
        deliveryUnknown: selected && state.sessionStatus === "delivery-unknown",
      };
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
  /** Defaults to the hosted runtime's configured environment session mode. */
  readonly mode?: HostedEnvironmentSessionsMode;
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
  let accountKey: string | null = null;
  let activeAccountId: string | null = null;
  let activeAuthority: string | null = null;
  let authorityResetPending = false;
  let authorityResetSequence = 0;
  let authorityCleanup: Promise<void> = Promise.resolve();
  let publishTimer: unknown = null;
  let disposed = false;
  let syncGeneration = 0;
  let lastSelectedEnvironmentId: EnvironmentId | null = null;
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
  const mode = input?.mode ?? hostedEnvironmentSessionsMode();
  const retained = mode === "retained";
  const sessions = getHostedEnvironmentSessions();
  /**
   * Retained sessions: scopes of background demand that yielded to a rate
   * limit. They hold no lease until they are released or their environment is
   * routed, so a rate-limited relay is not retried by every tick.
   */
  const rateLimitedScopeKeys = new Set<string>();
  /**
   * One session: the selected node whose relay just failed terminally while it
   * held its slot. The re-plan its freed slot starts must not retry it at once
   * — after an E2EE FATAL-PRE that is never allowed — so that connect fails as
   * transient, and a planned reconcile (the renewal tick, a demand or route
   * change, a presence edge) retries it.
   */
  let unretriedTerminalFailure: EnvironmentId | null = null;

  // With one session the routed node is connected only while it is online;
  // with retained sessions an offline routed node still gets its bounded
  // attempt from the lifecycle owner.
  const routedEnvironmentId = (): EnvironmentId | null => {
    const route = getRoutedHostedNode();
    if (route.malformed || route.nodeId === null) return null;
    return (
      hostedHubStore
        .getState()
        .nodes.find(
          (node) =>
            node.id === route.nodeId &&
            (retained
              ? node.revokedAt === null && !hostedNodeRequiresNativeClient(node)
              : isHostedWebConnectableNode(node)),
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

  const connectSelected = async (
    environmentId: EnvironmentId,
  ): Promise<ConnectionDemandConnectResult> => {
    const state = hostedHubStore.getState();
    if (
      disposed ||
      state.accountStatus !== "authenticated" ||
      state.directoryStatus !== "ready" ||
      (state.browserStatus !== "current" && state.browserStatus !== "synchronizing") ||
      !hostedWebConnectionScopes.list().some((scope) => scope.environmentId === environmentId)
    ) {
      throw new Error("Hosted Web directory is not current.");
    }
    const node = state.nodes.find(
      (candidate) =>
        candidate.environmentId === environmentId && isHostedWebConnectableNode(candidate),
    );
    if (!node) throw new Error("Hosted Web environment is not eligible.");
    if (state.selectedNode?.id !== node.id) {
      await hostedHubController.selectNode(node.id);
    } else if (state.transportStatus === "terminal-failure") {
      if (unretriedTerminalFailure === environmentId) {
        unretriedTerminalFailure = null;
        throw new Error("A terminally failed relay waits for a planned reconcile.");
      }
      await hostedHubController.retrySelectedNode();
    }
    // An already selected node's activation is its connection.
    if (disposed || hostedHubStore.getState().selectedNode?.id !== node.id) {
      throw new Error("Hosted Web connection demand was superseded.");
    }
    return "connected";
  };

  const releaseSelected = async (environmentId: EnvironmentId) => {
    if (hostedHubStore.getState().selectedNode?.environmentId === environmentId) {
      await hostedHubController.returnToDirectory();
    }
  };

  // Retained sessions: the lifecycle owner's acquire is the only way any
  // connection is created, and it never moves the selection.
  const connectRetained = async (
    environmentId: EnvironmentId,
  ): Promise<ConnectionDemandConnectResult> => {
    const nodeId = disposed ? null : nodeIdForHostedEnvironment(environmentId);
    if (nodeId === null) throw new Error("Hosted Web environment is not eligible.");
    const acquisition = await hostedHubController.acquireEnvironment(nodeId);
    return acquisition === "refused" ? "refused" : "connected";
  };

  const releaseRetained = (environmentId: EnvironmentId) =>
    hostedHubController.releaseEnvironment(environmentId);

  const coordinator = createHostedConnectionCoordinator({
    scopes: hostedWebConnectionScopes,
    foregroundEnvironmentId: routedEnvironmentId,
    now,
    setTimeout: schedule,
    clearTimeout: cancel,
    setInterval: repeat,
    clearInterval: cancelRepeat,
    maxConnections: input?.maxConnections ?? MAX_HOSTED_WEB_CONNECTIONS,
    mode,
    connect: retained ? connectRetained : connectSelected,
    release: retained ? releaseRetained : releaseSelected,
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
    if (!retained || disposed) return;
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

  // Retained sessions: the connected set is derived from the records, so a
  // suspended, failed or released record frees its slot and is acquired again
  // once it is demanded.
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
    if (!retained || disposed) return;
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
    retained
      ? retainedMachineCatalog(state.nodes, (environmentId) => sessions.read(environmentId), now())
      : singleSessionMachineCatalog(state.nodes, state, now());

  const updateMutationLeases = (
    state: HostedHubState,
    machines: ReadonlyArray<WorkspaceMachineCatalogEntry>,
  ) => {
    const shellReady = (environmentId: EnvironmentId) =>
      snapshots.has(environmentId) &&
      machines.some(
        (machine) =>
          machine.environmentId === environmentId &&
          machine.connectionState === "connected" &&
          machine.canMutate,
      );
    if (!retained) {
      clearRecordMutationLeases();
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
        shellReady: selectedEnvironmentId !== null && shellReady(selectedEnvironmentId),
      });
      return;
    }
    // Each environment session earns its lease with its own relay attempt and
    // accepted snapshot, and the lease names the record generation that did.
    if (hostedMutationLeaseAuthority.read().environmentId !== null) {
      hostedMutationLeaseAuthority.update(NO_MUTATION_READINESS);
    }
    const directoryReady =
      state.directoryStatus === "ready" && hostedBrowserRevalidated(state.browserStatus);
    const kept = new Set<EnvironmentId>();
    for (const record of sessions.list()) {
      kept.add(record.environmentId);
      recordMutationLeaseAuthority(record.environmentId).update({
        environmentId: record.environmentId,
        snapshotGeneration: record.generation,
        effectiveRole: record.effectiveRole,
        directoryReady,
        relayReady: record.transportStatus === "online" && record.sessionEstablished,
        shellReady: shellReady(record.environmentId),
      });
    }
    clearRecordMutationLeases(kept);
  };

  /**
   * The environment's last connection attempt ended in a terminal failure, or,
   * with retained sessions, its background demand yielded to a rate limit.
   */
  const relayFailed = (state: HostedHubState, environmentId: EnvironmentId) =>
    retained
      ? sessions.read(environmentId)?.transportStatus === "terminal-failure" ||
        hostedWebConnectionScopes
          .list()
          .some(
            (entry) => entry.environmentId === environmentId && rateLimitedScopeKeys.has(entry.key),
          )
      : state.selectedNode?.environmentId === environmentId &&
        state.transportStatus === "terminal-failure";

  const publish = (machines: ReadonlyArray<WorkspaceMachineCatalogEntry>) => {
    const state = hostedHubStore.getState();
    const cached = readHostedReadCache();
    if (state.accountStatus !== "authenticated" && canShowHostedReadPreview()) {
      hostedMutationLeaseAuthority.update(NO_MUTATION_READINESS);
      clearRecordMutationLeases();
      const cachedMachines = reconcileWorkspaceMachineCatalog(
        cached.nodes.map((node) =>
          cachedHubNodeCatalogInput({
            environmentId: node.environmentId,
            nodeId: node.nodeId,
            label: node.label,
            observedAt: now(),
            clientTier: "hosted-web",
          }),
        ),
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
    updateMutationLeases(state, machines);
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
    const eligible = state.nodes.filter(isHostedWebConnectableNode);
    const awaitingCacheShell = (node: HostedHubNode) => {
      const since = pendingCacheShells.get(node.id);
      return since !== undefined && now() - since < HOME_DISCOVERY_CACHE_WAIT_MS;
    };
    if (!canDiscover) {
      releaseDiscovery();
    } else {
      if (discoveryEnvironmentId !== null) {
        const failed = relayFailed(state, discoveryEnvironmentId);
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

  const synchronize = async () => {
    if (disposed) return;
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
    const nextAuthority = accountId
      ? JSON.stringify([
          hubOrigin,
          accountId,
          state.session?.id ?? null,
          state.session?.activeSpaceId ?? null,
        ])
      : null;
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
      snapshots.clear();
      // Mounted route leases express intent, not authority. Preserve them
      // across same-account credential/Space changes so fresh admission can
      // reconnect unchanged routes; an account switch discards that intent.
      if (accountId !== previousAccountId) hostedWebConnectionScopes.reset();
      clearWebHostedAccountScopedState();
      publish([]);
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
        if (!disposed) void synchronize();
      }
      return;
    }
    if (authorityResetPending) return;
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
        if (disposed || generation !== syncGeneration || authorityResetPending) return;
        if (!eligibleEnvironmentIds.has(record.namespace.environmentId)) {
          await cache.purgeEnvironment(record.namespace).catch(() => undefined);
          continue;
        }
        const current = snapshots.get(record.namespace.environmentId);
        if (!current || current.capturedAt <= record.snapshot.capturedAt)
          snapshots.set(record.namespace.environmentId, record.snapshot);
        useStore
          .getState()
          .hydrateEnvironmentStateFromCache(
            workspaceMetadataToCachedShellSnapshot(record.snapshot),
            record.namespace.environmentId,
          );
      }
    }

    if (disposed || generation !== syncGeneration || authorityResetPending) return;
    if (!retained) {
      // One session: the selected node is the only connection, as the shared
      // state reports it. Retained sessions report each record instead.
      const selectedEnvironmentId = state.selectedNode?.environmentId ?? null;
      const activeAttempt =
        selectedEnvironmentId !== null &&
        state.transportStatus !== "idle" &&
        state.transportStatus !== "terminal-failure";
      if (lastSelectedEnvironmentId && lastSelectedEnvironmentId !== selectedEnvironmentId) {
        coordinator.reportConnected(lastSelectedEnvironmentId, false);
      }
      if (selectedEnvironmentId) {
        if (
          state.transportStatus === "terminal-failure" &&
          liveEnvironmentIds().has(selectedEnvironmentId)
        ) {
          unretriedTerminalFailure = selectedEnvironmentId;
        }
        coordinator.reportConnected(selectedEnvironmentId, activeAttempt);
      }
      lastSelectedEnvironmentId = selectedEnvironmentId;
    }
    const machines = machineCatalog(state);
    const machineByEnvironment = new Map(
      machines.map((machine) => [machine.environmentId, machine] as const),
    );
    if (state.directoryStatus === "ready") {
      for (const [environmentId] of Array.from(snapshots)) {
        if (disposed || generation !== syncGeneration || authorityResetPending) return;
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
    // A busy stream must not postpone metadata discovery indefinitely. Read
    // the latest store at a bounded cadence instead of waiting for silence.
    if (publishTimer !== null) return;
    publishTimer = schedule(() => {
      publishTimer = null;
      if (disposed || authorityResetPending || !activeAccountId) return;
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
    if (unblocked) {
      unretriedTerminalFailure = null;
      void coordinator.reconcile();
    }
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
    void synchronize();
  });
  const unsubscribeDemandScopes = hostedWebConnectionScopes.subscribe(() => {
    unretriedTerminalFailure = null;
    forgetRateLimitYields();
    observeDemand();
  });
  const unsubscribeReadCache = subscribeHostedReadCache(() => void synchronize());
  const unsubscribeRoute = subscribeRoutedHostedNode(() => {
    unretriedTerminalFailure = null;
    forgetRateLimitYields();
    scheduleHomeDiscovery();
    void coordinator.reconcile();
    yieldOfflineEnvironments();
  });
  const unsubscribeSessions = retained
    ? sessions.subscribe(() => {
        observeRecords();
        void synchronize();
      })
    : () => undefined;
  const unsubscribeScopes = hostedWebConnectionScopes.subscribe(scheduleHomeDiscovery);
  const unsubscribeStore = useStore.subscribe(scheduleLiveSnapshotPublish);
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
    snapshots.set(snapshot.environmentId, snapshot);
    publish(hostedWorkspaceSnapshot.machines);
    scheduleHomeDiscovery();
  }, onCacheShellReadsChanged);
  observeRecords();
  void coordinator.reconcile();
  observeDemand();
  void synchronize();
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
    stopReadCache();
    unsubscribeCoordinator();
    resetRouteResolver();
    coordinator.dispose();
    if (activeCoordinator === coordinator) {
      activeCoordinator = null;
      hostedMutationLeaseAuthority.update(NO_MUTATION_READINESS);
      clearRecordMutationLeases();
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

/**
 * Whether the running workspace coordinator still wants the environment
 * connected: it is routed, or holds a lease. A relay binding asks this before
 * reconnecting a dropped channel. Without a coordinator nothing decides demand,
 * and the transport keeps its own backoff.
 */
export function isHostedEnvironmentDemanded(environmentId: EnvironmentId): boolean {
  return activeCoordinator?.isDemanded(environmentId) ?? true;
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
