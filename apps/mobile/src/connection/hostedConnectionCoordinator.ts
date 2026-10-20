import {
  getHostedEnvironmentSessions,
  HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
  hostedBrowserRevalidated,
  hostedHubController,
  hostedHubStore,
  isHostedEnvironmentConnectBlocked,
  isHostedEnvironmentSessionLive,
  type HostedEnvironmentReconcileRequest,
  type HostedEnvironmentSessionRecord,
  type HostedEnvironmentSessionsSnapshot,
  type HostedHubNode,
  type HostedHubState,
  type HostedRelayFailure,
  type HostedRelayTransportStatus,
  type HostedRycoSessionStatus,
} from "@ryco/client-runtime/authorization";
import {
  createConnectionDemandExecutor,
  isWarmRestoreForegroundSettled,
  UNIFIED_WORKSPACE_MAX_CONNECTIONS,
  warmRestoreWaitsForForeground,
  type ConnectionDemandConnectResult,
  type ConnectionDemandExecutorSnapshot,
  type ConnectionDemandLeaseInput,
} from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId, RelayEffectiveRole } from "@ryco/contracts";

import type {
  MobileHostedConnectionScope,
  MobileHostedScopeLeaseStore,
} from "./hostedConnectionScopes";

/**
 * docs/relay-capacity-assessment-3b.md discharges Wave 3b for at most three
 * simultaneous client connections/channels (0.59% of the 512-slot limits and
 * 15% of one peer's 20-token upgrade burst per client), with scope leases,
 * background release, staggered wake-up, and a five-node bound assertion.
 */
export const MAX_MOBILE_HOSTED_CONNECTIONS = UNIFIED_WORKSPACE_MAX_CONNECTIONS;
export const MOBILE_HOSTED_WAKE_STAGGER_MS = 750;

/** One hosted environment's session, as the mobile surfaces read it. */
export interface MobileHostedConnectionState {
  readonly environmentId: EnvironmentId;
  readonly nodeId: string;
  readonly label: string;
  readonly generation: number;
  readonly lastAccessedAt: number;
  readonly transportStatus: HostedRelayTransportStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly effectiveRole: RelayEffectiveRole | null;
  /** The relay channel of this generation reached `online` since it last (re)opened. */
  readonly attemptPrepared: boolean;
  readonly sessionEstablished: boolean;
  readonly sessionRecoveredAfterUnknown: boolean;
  readonly errorMessage: string | null;
}

interface MobileHostedConnectionsSnapshot {
  readonly selectedNodes: ReadonlyArray<MobileHostedConnectionState>;
  readonly deliveryUnknownEnvironmentIds: ReadonlyArray<EnvironmentId>;
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

const projectedStates = new WeakMap<HostedEnvironmentSessionRecord, MobileHostedConnectionState>();

/**
 * The mobile view of an environment's shared session record. A record object
 * is replaced only when it changes, so its view keeps its identity until then.
 */
function connectionStateFor(record: HostedEnvironmentSessionRecord): MobileHostedConnectionState {
  const cached = projectedStates.get(record);
  if (cached !== undefined) return cached;
  const state: MobileHostedConnectionState = {
    environmentId: record.environmentId,
    nodeId: record.nodeId,
    label: record.label,
    generation: record.generation,
    lastAccessedAt: record.lastAccessedAt,
    transportStatus: record.transportStatus,
    sessionStatus: record.sessionStatus,
    effectiveRole: record.effectiveRole,
    attemptPrepared: record.transportReachedOnline,
    sessionEstablished: record.sessionEstablished,
    sessionRecoveredAfterUnknown: record.sessionRecoveredAfterUnknown,
    errorMessage: record.syncFailed
      ? HOSTED_SESSION_SYNC_FAILURE_MESSAGE
      : record.failure === null
        ? null
        : relayFailureMessage(record.failure),
  };
  projectedStates.set(record, state);
  return state;
}

/**
 * The hosted environments' sessions, most recently accessed first, and the
 * environments whose delivery is uncertain. A projection of the shared session
 * registry, never a second copy: it keeps its identity until the registry
 * publishes a change.
 */
function createConnectionStore() {
  let projection: {
    readonly snapshot: HostedEnvironmentSessionsSnapshot;
    readonly state: MobileHostedConnectionsSnapshot;
  } | null = null;
  return {
    getState(): MobileHostedConnectionsSnapshot {
      const sessions = getHostedEnvironmentSessions();
      const snapshot = sessions.getSnapshot();
      if (projection?.snapshot !== snapshot) {
        projection = {
          snapshot,
          state: {
            selectedNodes: sessions.list().map(connectionStateFor),
            deliveryUnknownEnvironmentIds: Array.from(snapshot.deliveryUnknown),
          },
        };
      }
      return projection.state;
    },
    subscribe: (listener: () => void): (() => void) =>
      getHostedEnvironmentSessions().subscribe(listener),
  };
}

export const mobileHostedConnectionsStore = createConnectionStore();

export interface MobileHostedConnectionCoordinatorDeps {
  readonly scopes: MobileHostedScopeLeaseStore;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly nodeForId: (nodeId: string) => HostedHubNode | null;
  /**
   * The direct plane owns this environment. Its mounted scopes keep a direct
   * connection, never a hosted one, so they are not hosted demand.
   */
  readonly isDirectEnvironment: (environmentId: EnvironmentId) => boolean;
}

export interface MobileHostedConnectionCoordinator {
  /**
   * Show the node and connect it: moves the shared selection cursor to it,
   * which makes it the foreground environment the demand executor connects
   * first. Resolves once the executor planned it and its connection, if one
   * started, was requested.
   */
  readonly acquireNode: (nodeId: string) => Promise<void>;
  readonly retainPairingScope: (
    nodeId: string,
    environmentId: EnvironmentId,
  ) => (() => void) | null;
  /**
   * Release the environment's session, then connect it again through the
   * executor. Resolves `true` once its connection started, or once it waits
   * for a free slot; `false` when it could not be released or is refused.
   */
  readonly reconnectNode: (nodeId: string, environmentId: EnvironmentId) => Promise<boolean>;
  /**
   * Close the environment's session and connection now, as after an identity
   * conflict. It is not connected again until the node is acquired or retried.
   */
  readonly releaseEnvironment: (environmentId: EnvironmentId) => Promise<boolean>;
  /** Whether a connection to the environment is wanted: see {@link isDemanded}. */
  readonly shouldActivate: (environmentId: EnvironmentId) => boolean;
  /** The environment is selected or held by a mounted scope, so its relay may reconnect. */
  readonly isDemanded: (environmentId: EnvironmentId) => boolean;
  /** Refresh (or start) the environment's record from its directory entry; never connects. */
  readonly ensureRecord: (node: HostedHubNode) => MobileHostedConnectionState;
  readonly read: (environmentId: EnvironmentId) => MobileHostedConnectionState | null;
  readonly isCurrentGeneration: (environmentId: EnvironmentId, generation: number) => boolean;
  /** A replayed orchestration command could not be confirmed, whatever the generation. */
  readonly markEnvironmentDeliveryUnknown: (environmentId: EnvironmentId) => void;
  readonly acknowledgeDeliveryUnknown: (environmentId: EnvironmentId) => void;
  /** The hosted lifecycle owner asks for a new plan: after a resume, a retry or a directory change. */
  readonly requestEnvironmentReconcile: (request: HostedEnvironmentReconcileRequest) => void;
  readonly releaseNonRetainedForBackground: () => Promise<void>;
  readonly cancelPendingRecovery: () => void;
  readonly reconnectRetainedAfterForeground: () => void;
  readonly releaseAll: () => Promise<void>;
  /** The executor's view: demand, queued environments, slots and pending wakes. */
  readonly demand: () => ConnectionDemandExecutorSnapshot;
  readonly dispose: () => void;
}

/** A mounted scope as executor demand. Only a pairing ceremony may be displaced by the foreground. */
function scopeDemand(
  environmentId: EnvironmentId,
  scope: MobileHostedConnectionScope,
): ConnectionDemandLeaseInput {
  switch (scope.type) {
    case "thread-detail":
      return { environmentId, scope: { type: "thread-detail", threadId: scope.threadId } };
    case "vcs-status":
      return { environmentId, scope: { type: "vcs-status", cwd: scope.cwd } };
    case "provider-status":
      return {
        environmentId,
        scope:
          scope.instanceId === undefined
            ? { type: "provider-status" }
            : { type: "provider-status", instanceId: scope.instanceId },
      };
    case "node-pairing":
      return { environmentId, scope: { type: "interactive" }, preemptible: true };
  }
}

/** The account is signed in and this browser lifecycle has checked its access and directory. */
function accessRevalidated(state: HostedHubState): boolean {
  return state.accountStatus === "authenticated" && hostedBrowserRevalidated(state.browserStatus);
}

/**
 * The account, session and Space whose use the warm set records, or `null`
 * signed out. A check of access in progress keeps the current one.
 */
function warmSetAuthority(state: HostedHubState, current: string | null): string | null {
  if (state.accountStatus === "authenticating" || state.accountStatus === "unavailable") {
    return current;
  }
  if (state.accountStatus !== "authenticated" || state.account === null) return null;
  return JSON.stringify([
    state.account.id,
    state.session?.id ?? null,
    state.session?.activeSpaceId ?? null,
  ]);
}

/** What decides whether connecting an environment can be planned again. */
function connectabilityKey(state: HostedHubState): ReadonlyArray<unknown> {
  return [
    state.accountStatus,
    state.directoryStatus,
    accessRevalidated(state),
    state.nodes,
    state.selectedNode?.environmentId ?? null,
  ];
}

/**
 * The session failed for good after its connection was requested, and nothing
 * has released, suspended or started it over since. Its channel may still be
 * open: a session that could not synchronize keeps its transport.
 */
function connectionFailed(record: HostedEnvironmentSessionRecord): boolean {
  return !record.suspended && record.transportStatus === "terminal-failure";
}

/**
 * Whether the environment takes one of the executor's slots: a live or
 * establishing session, or a failed one whose failure still blocks
 * reconnecting. Nothing connects that one again until its directory entry
 * changes or the user retries, and its channel may still be open, so it keeps
 * its slot until it is released or started over.
 */
function holdsConnectionSlot(record: HostedEnvironmentSessionRecord): boolean {
  return (
    isHostedEnvironmentSessionLive(record) ||
    (connectionFailed(record) && isHostedEnvironmentConnectBlocked(record))
  );
}

/**
 * The session's connection is down, and only its transport's own retries,
 * which stop once nobody demands the environment, or a retry would bring it
 * back: it was suspended, its relay dropped, an attempt failed and waits to
 * retry, or the session failed for good.
 */
function connectionInterrupted(record: HostedEnvironmentSessionRecord): boolean {
  if (record.suspended || connectionFailed(record)) return true;
  return (
    isHostedEnvironmentSessionLive(record) &&
    (record.relayGap ||
      record.transportStatus === "reconnecting" ||
      (record.failure !== null && record.transportStatus !== "online"))
  );
}

/** The directory's live node for the environment, if it lists one. */
function hostedNodeForEnvironment(environmentId: EnvironmentId): HostedHubNode | null {
  return (
    hostedHubStore
      .getState()
      .nodes.find(
        (candidate) => candidate.environmentId === environmentId && candidate.revokedAt === null,
      ) ?? null
  );
}

/**
 * Mobile's hosted connections on the shared session registry and demand
 * executor.
 *
 * The hosted controller stays the only lifecycle owner: it creates, adopts,
 * suspends and releases every environment session. This coordinator only feeds
 * the shared executor what the app demands — the selected node, mounted thread,
 * VCS and provider views, a pairing ceremony — and lets it decide when to call
 * the controller's `acquireEnvironment` and `releaseEnvironment`. The executor
 * alone decides eviction, keeps at most {@link MAX_MOBILE_HOSTED_CONNECTIONS}
 * slots (an environment holds its slot until its release resolved), connects
 * the foreground first and staggers later wakes. The connected set comes from
 * the registry, so suspended sessions are planned again, and a failed one keeps
 * its slot while its channel may still be open. An environment nobody demands
 * whose connection is down or failed is released instead of reconnecting by
 * itself — also when its demand ends only after the drop. After the
 * background the executor restores the last warm set, the recently selected
 * environments, as preemptible demand once access is revalidated and the
 * selected one has connected; it never moves the selection.
 */
export function createMobileHostedConnectionCoordinator(
  deps: MobileHostedConnectionCoordinatorDeps,
): MobileHostedConnectionCoordinator {
  const sessions = getHostedEnvironmentSessions();
  /** Executor lease of each demanded scope, by a key stable across refcount changes. */
  const leases = new Map<string, string>();
  /** Explicitly released environments, refused until the node is acquired or retried. */
  const held = new Set<EnvironmentId>();
  /** Environments refused because the directory did not list them, until it does. */
  const unlisted = new Set<EnvironmentId>();
  /** Releases the coordinator started; their environments keep their slots until they resolve. */
  const explicitReleases = new Map<EnvironmentId, Promise<boolean>>();
  const pendingConnects = new Map<EnvironmentId, Promise<ConnectionDemandConnectResult>>();
  const releasesInFlight = new Set<Promise<void>>();
  /** Whether the executor last heard of each record as live. */
  const observed = new Map<EnvironmentId, boolean>();
  let recordSyncScheduled = false;
  let disposed = false;

  const trackRelease = (release: Promise<void>): Promise<void> => {
    releasesInFlight.add(release);
    const settled = () => {
      releasesInFlight.delete(release);
    };
    void release.then(settled, settled);
    return release;
  };

  const syncLeases = () => {
    const desired = new Map<string, ConnectionDemandLeaseInput>();
    for (const entry of deps.scopes.list()) {
      if (deps.isDirectEnvironment(entry.environmentId)) continue;
      desired.set(
        JSON.stringify([entry.environmentId, entry.scope]),
        scopeDemand(entry.environmentId, entry.scope),
      );
    }
    // The selected node is the route the user is looking at: a mounted view
    // like any other, and the environment the executor connects first.
    const foreground = selectedEnvironmentId(hostedHubStore.getState());
    if (foreground !== null) {
      desired.set(JSON.stringify([foreground, "selected"]), {
        environmentId: foreground,
        scope: { type: "interactive" },
      });
    }
    executor.setForeground(foreground);
    let demandEnded = false;
    for (const [key, leaseId] of Array.from(leases)) {
      if (desired.has(key)) continue;
      leases.delete(key);
      executor.releaseLease(leaseId);
      demandEnded = true;
    }
    for (const [key, lease] of desired) {
      const leaseId = leases.get(key);
      if (leaseId !== undefined && executor.renew(leaseId)) continue;
      leases.set(key, executor.retain(lease));
    }
    // An environment whose connection dropped while it was demanded stops
    // retrying once nothing demands it any more: the record sync releases it.
    if (demandEnded) scheduleRecordSync();
  };

  const acquire = async (environmentId: EnvironmentId): Promise<ConnectionDemandConnectResult> => {
    if (held.has(environmentId)) return "refused";
    const node = hostedNodeForEnvironment(environmentId);
    // Held back until the directory lists it; it takes no slot meanwhile.
    if (!node) {
      unlisted.add(environmentId);
      return "refused";
    }
    if ((await hostedHubController.acquireEnvironment(node.id)) === "refused") return "refused";
    // Adopted, joined or connecting: the session is live. Anything else is
    // transient, and the next plan the hosted state asks for retries it.
    if (!isHostedEnvironmentSessionLive(sessions.read(environmentId))) {
      throw new Error("The hosted environment session did not start.");
    }
    return "connected";
  };

  const connect = (environmentId: EnvironmentId): Promise<ConnectionDemandConnectResult> => {
    const attempt = acquire(environmentId);
    pendingConnects.set(environmentId, attempt);
    const settled = () => {
      if (pendingConnects.get(environmentId) === attempt) pendingConnects.delete(environmentId);
    };
    void attempt.then(settled, settled);
    return attempt;
  };

  /** The non-direct environment the selection shows, if any. */
  const selectedEnvironmentId = (state: HostedHubState): EnvironmentId | null => {
    const selected = state.selectedNode;
    return selected === null || deps.isDirectEnvironment(selected.environmentId)
      ? null
      : selected.environmentId;
  };

  /**
   * The selected environment's attempt is still under way (its node is listed
   * and online); a warm restore waits for it.
   */
  const selectedEnvironmentEstablishing = (state: HostedHubState): boolean => {
    const environmentId = selectedEnvironmentId(state);
    if (environmentId === null) return false;
    return warmRestoreWaitsForForeground({
      connectable: hostedNodeForEnvironment(environmentId)?.presence.online === true,
      parked: executor.snapshot().parkedEnvironmentIds.includes(environmentId),
      session: sessions.read(environmentId),
    });
  };

  // The last warm set to restore, once access is revalidated and the selected
  // environment has connected: the recently used environments the directory
  // lists online, never a released, direct or offline one. Nothing is
  // persisted, so a new process starts with none.
  const warmRestore = (
    recent: ReadonlyArray<EnvironmentId>,
  ): ReadonlyArray<EnvironmentId> | null => {
    if (disposed) return null;
    const state = hostedHubStore.getState();
    if (!accessRevalidated(state) || state.directoryStatus !== "ready") return null;
    if (selectedEnvironmentEstablishing(state)) return null;
    return recent
      .filter(
        (environmentId) =>
          !held.has(environmentId) &&
          !deps.isDirectEnvironment(environmentId) &&
          hostedNodeForEnvironment(environmentId)?.presence.online === true,
      )
      .slice(0, MAX_MOBILE_HOSTED_CONNECTIONS);
  };

  const executor = createConnectionDemandExecutor({
    maxConnections: MAX_MOBILE_HOSTED_CONNECTIONS,
    wakeStaggerMs: MOBILE_HOSTED_WAKE_STAGGER_MS,
    ports: {
      now: deps.now,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
      connect,
      // A release this coordinator started already tears the environment
      // down: the executor keeps its slot until that teardown resolved.
      release: (environmentId) =>
        trackRelease(
          explicitReleases.get(environmentId)?.then(() => undefined) ??
            hostedHubController.releaseEnvironment(environmentId),
        ),
      beforePlan: syncLeases,
      warmRestore,
    },
  });

  /**
   * Tell the executor whether the environment holds a slot: see
   * {@link holdsConnectionSlot}. One whose connection is down or failed is
   * reported interrupted first, on every sync rather than only when it drops,
   * since its demand may end later: the executor releases it unless it is
   * demanded.
   */
  const syncRecord = (environmentId: EnvironmentId) => {
    const record = sessions.read(environmentId);
    const wasLive = observed.get(environmentId);
    if (record === undefined) {
      if (wasLive === undefined) return;
      observed.delete(environmentId);
      executor.reportConnected(environmentId, false);
      return;
    }
    // A failed session whose directory entry changed may connect again. The
    // selected one is the foreground, planned first into the slot it frees, and
    // its reconnect replaces the failed channel. Any other could wait behind
    // fresher demand with that channel still open, so it is released first and
    // keeps its slot until its channel closed; if it is still demanded then,
    // it connects afresh.
    if (
      connectionFailed(record) &&
      !isHostedEnvironmentConnectBlocked(record) &&
      hostedHubStore.getState().selectedNode?.environmentId !== environmentId
    ) {
      void release(environmentId, false);
      return;
    }
    const live = holdsConnectionSlot(record);
    observed.set(environmentId, live);
    if (connectionInterrupted(record)) executor.reportInterrupted(environmentId);
    if (live !== (wasLive ?? false)) executor.reportConnected(environmentId, live);
  };

  /** The selected session last seen settled, by environment and generation. */
  let settledSelection: string | null = null;

  const syncRecords = () => {
    recordSyncScheduled = false;
    if (disposed) return;
    const environmentIds = new Set([...observed.keys(), ...sessions.getSnapshot().records.keys()]);
    for (const environmentId of environmentIds) {
      // A release this coordinator started keeps its slot until it resolved.
      if (!explicitReleases.has(environmentId)) syncRecord(environmentId);
    }
    // The selected environment is in use once established, and its attempt
    // settling is what a waiting warm restore waits for.
    const selected = selectedEnvironmentId(hostedHubStore.getState());
    const record = selected === null ? undefined : sessions.read(selected);
    if (
      selected !== null &&
      record !== undefined &&
      isHostedEnvironmentSessionLive(record) &&
      record.sessionEstablished
    ) {
      executor.noteUsed(selected);
    }
    const settled =
      record !== undefined && isWarmRestoreForegroundSettled(record)
        ? JSON.stringify([record.environmentId, record.generation])
        : null;
    if (settled !== null && settled !== settledSelection) executor.pollWarmRestore();
    settledSelection = settled;
  };

  // Registry callbacks run inside the controller's own updates; the executor
  // hears of them once those have finished.
  const scheduleRecordSync = () => {
    if (recordSyncScheduled || disposed) return;
    recordSyncScheduled = true;
    void Promise.resolve().then(syncRecords);
  };

  /** Settles after the plan a reconcile scheduled, which plans on the next microtask. */
  const afterPlan = async (environmentId?: EnvironmentId) => {
    await Promise.resolve();
    const attempt = environmentId === undefined ? undefined : pendingConnects.get(environmentId);
    await attempt?.catch(() => undefined);
  };

  const release = (environmentId: EnvironmentId, hold: boolean): Promise<boolean> => {
    if (hold) held.add(environmentId);
    const pending = explicitReleases.get(environmentId);
    if (pending) return pending;
    const next = trackRelease(hostedHubController.releaseEnvironment(environmentId))
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        if (explicitReleases.get(environmentId) === next) explicitReleases.delete(environmentId);
        if (disposed) return;
        // The slot is free only now. The executor may count the environment
        // connected before the registry ever said so, so say it either way.
        if (sessions.read(environmentId) === undefined) {
          observed.delete(environmentId);
          executor.reportConnected(environmentId, false);
        } else {
          syncRecord(environmentId);
        }
      });
    explicitReleases.set(environmentId, next);
    return next;
  };

  const acquireNode = async (nodeId: string): Promise<void> => {
    if (disposed) return;
    const node = deps.nodeForId(nodeId);
    if (!node) return;
    // Asking for the node is a new demand edge, and only a foreground user acts.
    held.delete(node.environmentId);
    unlisted.delete(node.environmentId);
    executor.unpark(node.environmentId);
    executor.setBackgrounded(false);
    // A cursor move only: the selection lease and the foreground follow it.
    await hostedHubController.selectNode(nodeId);
    if (disposed) return;
    // A node opened again is listed first even when its session is reused as
    // it is; its selection lease already makes it the last one evicted.
    const entry = deps.nodeForId(nodeId);
    if (
      entry?.environmentId === node.environmentId &&
      entry.revokedAt === null &&
      sessions.read(node.environmentId) !== undefined
    ) {
      sessions.ensureRecord(entry);
    }
    executor.reconcile();
    await afterPlan(node.environmentId);
  };

  let lastConnectability = connectabilityKey(hostedHubStore.getState());
  let wasRevalidated = accessRevalidated(hostedHubStore.getState());
  let wasDirectoryReady = hostedHubStore.getState().directoryStatus === "ready";
  let warmAuthority = warmSetAuthority(hostedHubStore.getState(), null);
  const unsubscribeHosted = hostedHubStore.subscribe(() => {
    const state = hostedHubStore.getState();
    // What one account, session or Space used is not another's.
    const authority = warmSetAuthority(state, warmAuthority);
    if (authority !== warmAuthority) {
      if (warmAuthority !== null) executor.resetWarmSet();
      warmAuthority = authority;
    }
    const next = connectabilityKey(state);
    if (next.every((value, index) => Object.is(value, lastConnectability[index]))) return;
    lastConnectability = next;
    // Access is revalidated only in the foreground — at launch, sign-in or a
    // resume — so nothing held back while the app was away is owed any more.
    const revalidated = accessRevalidated(state);
    if (revalidated && !wasRevalidated) {
      executor.setBackgrounded(false);
      executor.pollWarmRestore();
    }
    wasRevalidated = revalidated;
    const directoryReady = state.directoryStatus === "ready";
    if (directoryReady && !wasDirectoryReady) executor.pollWarmRestore();
    wasDirectoryReady = directoryReady;
    // An environment the directory did not list may be listed now.
    for (const environmentId of Array.from(unlisted)) {
      if (!hostedNodeForEnvironment(environmentId)) continue;
      unlisted.delete(environmentId);
      executor.unpark(environmentId);
    }
    executor.reconcile();
  });
  const unsubscribeSessions = sessions.subscribe(scheduleRecordSync);
  const unsubscribeScopes = deps.scopes.subscribe(() => executor.reconcile());
  syncRecords();
  executor.reconcile();

  return {
    acquireNode,
    retainPairingScope(nodeId, environmentId) {
      const node = deps.nodeForId(nodeId);
      if (!node || node.environmentId !== environmentId) return null;
      return deps.scopes.retain(environmentId, { type: "node-pairing", nodeId });
    },
    async reconnectNode(nodeId, environmentId) {
      const node = deps.nodeForId(nodeId);
      if (!node || node.environmentId !== environmentId) return false;
      if (!(await release(environmentId, false))) return false;
      if (disposed) return false;
      await acquireNode(nodeId);
      if (disposed) return false;
      if (isHostedEnvironmentSessionLive(sessions.read(environmentId))) return true;
      // Mounted views elsewhere may hold every slot: the environment then
      // waits for one and connects as soon as it frees, which is no failure.
      const planned = executor.snapshot();
      return (
        planned.queuedEnvironmentIds.includes(environmentId) ||
        planned.pendingWakes.some((wake) => wake.environmentId === environmentId)
      );
    },
    releaseEnvironment: (environmentId) => release(environmentId, true),
    shouldActivate: (environmentId) => !disposed && executor.isDemanded(environmentId),
    isDemanded: (environmentId) => !disposed && executor.isDemanded(environmentId),
    ensureRecord: (node) => connectionStateFor(sessions.ensureRecord(node)),
    read(environmentId) {
      const record = sessions.read(environmentId);
      return record === undefined ? null : connectionStateFor(record);
    },
    isCurrentGeneration: (environmentId, generation) =>
      sessions.isCurrentGeneration(environmentId, generation),
    markEnvironmentDeliveryUnknown: (environmentId) =>
      hostedHubController.markEnvironmentDeliveryUnknown(environmentId),
    // Any environment can be acknowledged from its own thread, not only the
    // selected one; the shared cursor's projection follows its record.
    acknowledgeDeliveryUnknown: (environmentId) =>
      hostedHubController.acknowledgeDeliveryUnknown(environmentId),
    requestEnvironmentReconcile(request) {
      if (disposed) return;
      // A retry, or a directory entry that changed, lifts a refusal.
      if (request.reason !== "resume" && request.environmentId !== undefined) {
        held.delete(request.environmentId);
        executor.unpark(request.environmentId);
      }
      // The controller asks once an environment can connect again, which only a
      // foreground app sees; one asked for too early is refused and re-planned.
      executor.setBackgrounded(false);
      executor.reconcile();
    },
    async releaseNonRetainedForBackground() {
      if (disposed) return;
      // Suspended sessions nobody demands are released by the record sync;
      // backgrounded planning connects nothing until the next foreground.
      syncRecords();
      executor.setBackgrounded(true);
      await afterPlan();
      await Promise.allSettled(Array.from(releasesInFlight));
    },
    // Background and offline: no wake is owed until the next recovery.
    cancelPendingRecovery: () => {
      if (!disposed) executor.setBackgrounded(true);
    },
    reconnectRetainedAfterForeground() {
      if (disposed) return;
      executor.setBackgrounded(false);
      executor.reconcile();
    },
    async releaseAll() {
      await Promise.all(sessions.list().map((record) => release(record.environmentId, false)));
    },
    demand: () => executor.snapshot(),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeHosted();
      unsubscribeSessions();
      unsubscribeScopes();
      executor.dispose();
      leases.clear();
      held.clear();
      unlisted.clear();
      observed.clear();
      pendingConnects.clear();
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

/** The configured coordinator, or `null` before the runtime bootstrap configured one. */
export function readMobileHostedConnectionCoordinator(): MobileHostedConnectionCoordinator | null {
  return mobileCoordinator;
}

export function resetMobileHostedConnectionCoordinatorForTests(): void {
  mobileCoordinator?.dispose();
  mobileCoordinator = null;
}
