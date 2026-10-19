import type { EnvironmentId } from "@ryco/contracts";

import {
  createWorkspaceConnectionDemandState,
  isWorkspaceEnvironmentDemanded,
  planWorkspaceConnectionDemand,
  pruneExpiredWorkspaceConnectionScopes,
  releaseWorkspaceConnectionScope,
  renewWorkspaceConnectionScope,
  retainWorkspaceConnectionScope,
  setWorkspaceConnectionBackgrounded,
  setWorkspaceEnvironmentConnected,
  UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS,
  type WorkspaceConnectionDemandState,
  type WorkspaceConnectionScope,
} from "./connectionDemand.js";

/**
 * `"refused"`: the platform will not connect this environment (for example a
 * terminal failure that needs a directory change or a user retry). The
 * executor parks it until {@link ConnectionDemandExecutor.unpark} or a new
 * demand edge.
 */
export type ConnectionDemandConnectResult = "connected" | "refused";

export interface ConnectionDemandExecutorPorts {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  /**
   * Starts, or joins, the platform's connection to one environment. A
   * rejection is a transient failure: a later reconcile may retry, and the
   * platform's connect enforces its own backoff and eligibility. The signal
   * aborts when the executor no longer wants the connection.
   */
  readonly connect: (
    environmentId: EnvironmentId,
    signal: AbortSignal,
  ) => Promise<ConnectionDemandConnectResult>;
  /**
   * Local teardown of one environment's connection. It must not wait for a
   * remote acknowledgement: a connect that needs the slot waits for it.
   */
  readonly release: (environmentId: EnvironmentId) => Promise<void>;
  /**
   * Runs synchronously before every plan and every demand query, so the
   * platform syncs leases from its scope store (retain new scopes, renew
   * present ones, release removed ones) even when its own renewal timer is
   * throttled. Lease calls made here never schedule another plan.
   */
  readonly beforePlan?: () => void;
  readonly onChange?: () => void;
}

export interface ConnectionDemandExecutorOptions {
  /** At most `UNIFIED_WORKSPACE_MAX_CONNECTIONS`; never exceeded, not even during a swap. */
  readonly maxConnections: number;
  /** Spacing between staggered wakes after the first; the foreground never waits for it. */
  readonly wakeStaggerMs: number;
  readonly leaseTtlMs?: number;
  readonly ports: ConnectionDemandExecutorPorts;
}

export interface ConnectionDemandLeaseInput {
  readonly environmentId: EnvironmentId;
  readonly scope: WorkspaceConnectionScope;
  /** Background or intent demand a foreground environment may displace. */
  readonly preemptible?: boolean;
}

export interface ConnectionDemandPendingWake {
  readonly environmentId: EnvironmentId;
  readonly dueAt: number;
}

export interface ConnectionDemandExecutorSnapshot {
  readonly demand: WorkspaceConnectionDemandState;
  readonly queuedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Environments holding a slot through a live or in-flight connection. */
  readonly activeConnectionCount: number;
  readonly connectingEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Environments that keep their slot until their release resolved. */
  readonly releasingEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly pendingWakes: ReadonlyArray<ConnectionDemandPendingWake>;
  readonly parkedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

export interface ConnectionDemandExecutor {
  /** Adds a lease and returns its id. A new lease unparks its environment. */
  readonly retain: (input: ConnectionDemandLeaseInput) => string;
  /**
   * Extends a lease. `false` when the lease is unknown — released, or expired
   * and pruned by a plan — and must be retained again.
   */
  readonly renew: (leaseId: string) => boolean;
  readonly releaseLease: (leaseId: string) => void;
  /** The environment the user is looking at: it connects first and may preempt. */
  readonly setForeground: (environmentId: EnvironmentId | null) => void;
  readonly setBackgrounded: (backgrounded: boolean) => void;
  /**
   * The platform's view of a connection. `false` means the environment no
   * longer holds a live or establishing connection, so its slot is free.
   */
  readonly reportConnected: (environmentId: EnvironmentId, connected: boolean) => void;
  /**
   * A live environment's relay dropped. One that is not demanded is released
   * instead of reconnecting; a demanded one is left to its transport's backoff.
   */
  readonly reportInterrupted: (environmentId: EnvironmentId) => void;
  /**
   * Whether the environment is the foreground or holds an unexpired lease,
   * after syncing leases through `beforePlan`. Platforms pass it to their relay
   * binding so only demanded environments reconnect after a drop.
   */
  readonly isDemanded: (environmentId: EnvironmentId) => boolean;
  /** Lets a parked environment connect again (its directory entry changed, or the user retried). */
  readonly unpark: (environmentId: EnvironmentId) => void;
  readonly reconcile: () => void;
  readonly snapshot: () => ConnectionDemandExecutorSnapshot;
  readonly dispose: () => void;
}

interface ConnectAttempt {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

interface PendingWake {
  readonly dueAt: number;
  timer: unknown;
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
 * Decides when to call a platform's connect and release ports for a set of
 * environments. It holds no authority: the platform's lifecycle owner still
 * establishes, recovers and suspends sessions; the executor only keeps the
 * set of connected environments within its cap.
 *
 * - Each `reconcile` coalesces into one synchronous plan on the next
 *   microtask. Nothing waits on another environment's connect.
 * - An environment holds a slot from the moment its connect starts until its
 *   release resolved, so a swap never exceeds the cap. A connect starts only
 *   with a free slot, and an environment that is still releasing connects
 *   only after its own release resolved.
 * - Connects and releases are single-flight per environment and run
 *   concurrently across environments.
 * - Staggered wakes are timers. When one fires the executor re-plans and
 *   connects the environment only if it is still planned. A starting
 *   foreground cancels the pending wakes and re-arms them from its plan.
 */
export function createConnectionDemandExecutor(
  options: ConnectionDemandExecutorOptions,
): ConnectionDemandExecutor {
  const { ports } = options;
  const maxConnections = options.maxConnections;
  const wakeStaggerMs = Math.max(0, options.wakeStaggerMs);
  const leaseTtlMs = options.leaseTtlMs ?? UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS;
  let demand = createWorkspaceConnectionDemandState(maxConnections);
  let foreground: EnvironmentId | null = null;
  let queued: ReadonlyArray<EnvironmentId> = [];
  let leaseSequence = 0;
  let disposed = false;
  let syncing = false;
  let planRequestedWhileSyncing = false;
  let planScheduled = false;
  let planRequested = false;
  let planning = false;
  let notifyPending = false;
  let cachedSnapshot: ConnectionDemandExecutorSnapshot | null = null;
  const connecting = new Map<EnvironmentId, ConnectAttempt>();
  const releasing = new Set<EnvironmentId>();
  const wakes = new Map<EnvironmentId, PendingWake>();
  const dueWakes = new Set<EnvironmentId>();
  const parked = new Set<EnvironmentId>();
  /**
   * Environments whose connect rejected since the last requested reconcile.
   * Plans the executor runs on its own (a freed slot, a wake) skip them, so a
   * connect that fails at once cannot spin; the platform's next reconcile
   * retries them.
   */
  const failed = new Set<EnvironmentId>();

  /**
   * Records a change the snapshot shows. Changes made by a plan, or by a call
   * that schedules one, are reported once when that plan ends, so a plan that
   * changes nothing keeps the snapshot and stays silent.
   */
  const markChanged = () => {
    cachedSnapshot = null;
    if (!disposed) notifyPending = true;
  };

  const notify = () => {
    if (!notifyPending || disposed) return;
    notifyPending = false;
    ports.onChange?.();
  };

  const changed = () => {
    markChanged();
    if (!planning) notify();
  };

  const isConnected = (environmentId: EnvironmentId) =>
    demand.connections.some((entry) => entry.environmentId === environmentId && entry.connected);

  const slotHolders = () => {
    const holders = new Set<EnvironmentId>([...connecting.keys(), ...releasing]);
    for (const entry of demand.connections) {
      if (entry.connected) holders.add(entry.environmentId);
    }
    return holders;
  };

  const syncLeases = () => {
    if (syncing || !ports.beforePlan) return;
    syncing = true;
    try {
      ports.beforePlan();
    } finally {
      syncing = false;
    }
  };

  const schedulePlan = (requested: boolean) => {
    if (disposed) return;
    // Lease calls made while syncing feed the plan (or demand query) that follows the sync.
    if (syncing) {
      planRequestedWhileSyncing ||= requested;
      return;
    }
    if (requested) planRequested = true;
    if (planScheduled) return;
    planScheduled = true;
    void Promise.resolve().then(runPlan);
  };

  const cancelWake = (environmentId: EnvironmentId) => {
    const wake = wakes.get(environmentId);
    if (!wake) return;
    ports.clearTimeout(wake.timer);
    wakes.delete(environmentId);
    markChanged();
  };

  const cancelAllWakes = () => {
    for (const environmentId of Array.from(wakes.keys())) cancelWake(environmentId);
    dueWakes.clear();
  };

  const armWake = (environmentId: EnvironmentId, delayMs: number) => {
    const wake: PendingWake = { dueAt: ports.now() + delayMs, timer: null };
    wakes.set(environmentId, wake);
    wake.timer = ports.setTimeout(() => {
      if (wakes.get(environmentId) !== wake) return;
      wakes.delete(environmentId);
      dueWakes.add(environmentId);
      // The plan that follows reports the fired wake.
      markChanged();
      schedulePlan(false);
    }, delayMs);
    markChanged();
  };

  /** The demand as the planner sees it: in-flight connects hold slots, parked environments wait. */
  const planningState = (): WorkspaceConnectionDemandState => {
    const leases =
      parked.size === 0
        ? demand.leases
        : demand.leases.filter((lease) => !parked.has(lease.environmentId));
    const inFlight = Array.from(connecting.keys()).filter(
      (environmentId) => !releasing.has(environmentId),
    );
    if (inFlight.length === 0) return leases === demand.leases ? demand : { ...demand, leases };
    const connections = demand.connections.map((entry) =>
      !entry.connected && inFlight.includes(entry.environmentId)
        ? { ...entry, connected: true }
        : entry,
    );
    for (const environmentId of inFlight) {
      if (!connections.some((entry) => entry.environmentId === environmentId)) {
        connections.push({ environmentId, connected: true, lastAccessedAt: 0 });
      }
    }
    return { ...demand, leases, connections };
  };

  const settleConnect = (
    environmentId: EnvironmentId,
    attempt: ConnectAttempt,
    result: ConnectionDemandConnectResult | "failed",
  ) => {
    if (connecting.get(environmentId) !== attempt) return;
    connecting.delete(environmentId);
    if (disposed) return;
    // A release took over this attempt; its teardown follows.
    if (!releasing.has(environmentId)) {
      demand = setWorkspaceEnvironmentConnected(
        demand,
        environmentId,
        result === "connected",
        ports.now(),
      );
      if (result === "refused") parked.add(environmentId);
      if (result === "failed") failed.add(environmentId);
    }
    changed();
    // A refused or failed connect frees its slot for waiting demand.
    if (result !== "connected") schedulePlan(false);
  };

  const startConnect = (environmentId: EnvironmentId) => {
    const controller = new AbortController();
    let settle!: () => void;
    const attempt: ConnectAttempt = {
      controller,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    connecting.set(environmentId, attempt);
    changed();
    let outcome: Promise<ConnectionDemandConnectResult>;
    try {
      outcome = Promise.resolve(ports.connect(environmentId, controller.signal));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    void outcome
      .then(
        (result) => settleConnect(environmentId, attempt, result),
        () => settleConnect(environmentId, attempt, "failed"),
      )
      .finally(settle);
  };

  const startWhenSlotFree = (environmentId: EnvironmentId) => {
    // Joins an in-flight connect; an environment still releasing waits for its own release.
    if (connecting.has(environmentId) || releasing.has(environmentId)) return;
    // Whatever frees a slot re-plans: a resolved release, a refused or failed
    // connect, or a disconnect the platform reports.
    if (slotHolders().size >= maxConnections) return;
    cancelWake(environmentId);
    dueWakes.delete(environmentId);
    startConnect(environmentId);
  };

  const callRelease = (environmentId: EnvironmentId): Promise<void> => {
    try {
      return Promise.resolve(ports.release(environmentId)).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  };

  const release = (environmentId: EnvironmentId) => {
    if (releasing.has(environmentId)) return;
    releasing.add(environmentId);
    cancelWake(environmentId);
    dueWakes.delete(environmentId);
    demand = setWorkspaceEnvironmentConnected(demand, environmentId, false, ports.now());
    changed();
    const inFlight = connecting.get(environmentId);
    inFlight?.controller.abort();
    const teardown = inFlight
      ? inFlight.settled.then(() => (disposed ? undefined : callRelease(environmentId)))
      : callRelease(environmentId);
    void teardown.then(() => {
      releasing.delete(environmentId);
      changed();
      schedulePlan(false);
    });
  };

  const runPlan = () => {
    planScheduled = false;
    const requested = planRequested;
    planRequested = false;
    if (disposed) return;
    if (requested) failed.clear();
    planning = true;
    try {
      syncLeases();
      planRequestedWhileSyncing = false;
      const now = ports.now();
      const pruned = pruneExpiredWorkspaceConnectionScopes(demand, now);
      if (pruned !== demand) {
        demand = pruned;
        markChanged();
      }
      const plan = planWorkspaceConnectionDemand(planningState(), {
        now,
        wakeStaggerMs,
        foregroundEnvironmentId: foreground,
      });
      if (!sameEnvironmentIds(queued, plan.queued)) {
        queued = plan.queued;
        markChanged();
      }
      for (const environmentId of plan.release) release(environmentId);

      const planned = new Set(plan.connect.map((command) => command.environmentId));
      for (const environmentId of Array.from(wakes.keys())) {
        if (!planned.has(environmentId)) cancelWake(environmentId);
      }
      for (const environmentId of Array.from(dueWakes)) {
        if (!planned.has(environmentId)) dueWakes.delete(environmentId);
      }
      const commands = plan.connect.filter((command) => !failed.has(command.environmentId));
      // A starting foreground preempts the pending wakes; they are re-armed from this plan.
      if (foreground !== null && commands[0]?.environmentId === foreground) cancelAllWakes();
      for (const { environmentId, delayMs } of commands) {
        const due =
          environmentId === foreground ||
          dueWakes.has(environmentId) ||
          (delayMs === 0 && !wakes.has(environmentId));
        if (due) startWhenSlotFree(environmentId);
        else if (!wakes.has(environmentId)) armWake(environmentId, delayMs);
      }
    } finally {
      planning = false;
    }
    notify();
  };

  const isDemanded = (environmentId: EnvironmentId) => {
    if (disposed) return false;
    syncLeases();
    if (planRequestedWhileSyncing) {
      planRequestedWhileSyncing = false;
      schedulePlan(true);
    }
    return isWorkspaceEnvironmentDemanded(demand, environmentId, {
      now: ports.now(),
      foregroundEnvironmentId: foreground,
    });
  };

  return {
    retain(input) {
      const leaseId = `connection-demand-${++leaseSequence}`;
      demand = retainWorkspaceConnectionScope(demand, {
        leaseId,
        environmentId: input.environmentId,
        scope: input.scope,
        now: ports.now(),
        ttlMs: leaseTtlMs,
        ...(input.preemptible === true ? { preemptible: true } : {}),
      });
      // A new lease is a new demand edge: a parked or failed environment may connect again.
      parked.delete(input.environmentId);
      failed.delete(input.environmentId);
      // The plan that follows reports the new lease.
      markChanged();
      schedulePlan(true);
      return leaseId;
    },
    renew(leaseId) {
      if (!demand.leases.some((lease) => lease.leaseId === leaseId)) return false;
      // Extending a lease that a plan has not pruned changes no plan, so it
      // refreshes the snapshot without reporting a change.
      demand = renewWorkspaceConnectionScope(demand, leaseId, ports.now(), leaseTtlMs);
      cachedSnapshot = null;
      return true;
    },
    releaseLease(leaseId) {
      if (!demand.leases.some((lease) => lease.leaseId === leaseId)) return;
      demand = releaseWorkspaceConnectionScope(demand, leaseId);
      markChanged();
      schedulePlan(true);
    },
    setForeground(environmentId) {
      if (environmentId === foreground) return;
      foreground = environmentId;
      if (environmentId !== null) {
        parked.delete(environmentId);
        failed.delete(environmentId);
      }
      schedulePlan(true);
    },
    setBackgrounded(backgrounded) {
      const next = setWorkspaceConnectionBackgrounded(demand, backgrounded);
      if (next === demand) return;
      demand = next;
      // The backgrounded plan releases, and so aborts, in-flight connects without a lease.
      if (backgrounded) cancelAllWakes();
      changed();
      schedulePlan(true);
    },
    reportConnected(environmentId, connected) {
      // An environment being released keeps its slot until the release resolved.
      if (connected && releasing.has(environmentId)) return;
      const wasConnected = isConnected(environmentId);
      if (!connected && !wasConnected) return;
      const unparked = connected && parked.delete(environmentId);
      demand = setWorkspaceEnvironmentConnected(demand, environmentId, connected, ports.now());
      if (connected && wasConnected && !unparked) {
        // Only its access time moved.
        cachedSnapshot = null;
        return;
      }
      changed();
      // A disconnect frees the environment's slot for waiting demand.
      if (!connected) schedulePlan(false);
    },
    reportInterrupted(environmentId) {
      if (disposed || isDemanded(environmentId)) return;
      release(environmentId);
    },
    isDemanded,
    unpark(environmentId) {
      if (parked.delete(environmentId)) markChanged();
      failed.delete(environmentId);
      schedulePlan(true);
    },
    reconcile() {
      schedulePlan(true);
    },
    snapshot() {
      if (cachedSnapshot) return cachedSnapshot;
      const connectingEnvironmentIds = Array.from(connecting.keys()).filter(
        (environmentId) => !releasing.has(environmentId),
      );
      const active = new Set(connectingEnvironmentIds);
      for (const entry of demand.connections) {
        if (entry.connected && !releasing.has(entry.environmentId)) active.add(entry.environmentId);
      }
      cachedSnapshot = {
        demand,
        queuedEnvironmentIds: queued,
        activeConnectionCount: active.size,
        connectingEnvironmentIds,
        releasingEnvironmentIds: Array.from(releasing),
        pendingWakes: Array.from(wakes, ([environmentId, wake]) => ({
          environmentId,
          dueAt: wake.dueAt,
        })),
        parkedEnvironmentIds: Array.from(parked),
      };
      return cachedSnapshot;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAllWakes();
      for (const attempt of connecting.values()) attempt.controller.abort();
      connecting.clear();
      cachedSnapshot = null;
    },
  };
}
