import type { EnvironmentId, ThreadId } from "@ryco/contracts";

/**
 * docs/relay-capacity-assessment-3b.md qualifies no more than three simultaneous
 * unified node connections. Platforms may choose a lower bound, never a higher one.
 */
export const UNIFIED_WORKSPACE_MAX_CONNECTIONS = 3;
export const UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS = 45_000;
/** How long a restored warm lease lasts unless use renews it. */
export const UNIFIED_WORKSPACE_WARM_LEASE_TTL_MS = 600_000;
/** How long an environment whose warm lease was dropped is left out of warm restores. */
export const UNIFIED_WORKSPACE_WARM_RESTORE_COOLDOWN_MS = 300_000;

export type WorkspaceConnectionScope =
  | { readonly type: "interactive" }
  | { readonly type: "thread-detail"; readonly threadId: ThreadId }
  | { readonly type: "vcs-status"; readonly cwd: string }
  | { readonly type: "provider-status"; readonly instanceId?: string };

export interface WorkspaceConnectionScopeLease {
  readonly leaseId: string;
  readonly environmentId: EnvironmentId;
  readonly scope: WorkspaceConnectionScope;
  readonly retainedAt: number;
  readonly expiresAt: number;
  /**
   * Background or intent demand (drafts, discovery, queued sends, press
   * intent) that a foreground environment may displace when no slot is free.
   * Mounted views never set it. Absent means `false`.
   */
  readonly preemptible?: boolean;
  /**
   * A restored member of the last warm set: it asks for a connection only
   * while a slot is free, never releases a connection to make room, yields to
   * every other demand and never makes its environment demanded. A warm lease
   * is always preemptible. Absent means `false`.
   */
  readonly warm?: boolean;
}

export interface WorkspaceDemandConnection {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly lastAccessedAt: number;
}

export interface WorkspaceConnectionDemandState {
  readonly platformMaxConnections: number;
  readonly backgrounded: boolean;
  readonly leases: ReadonlyArray<WorkspaceConnectionScopeLease>;
  readonly connections: ReadonlyArray<WorkspaceDemandConnection>;
}

export interface WorkspaceConnectionDemandPlan {
  readonly state: WorkspaceConnectionDemandState;
  readonly retain: ReadonlyArray<EnvironmentId>;
  readonly release: ReadonlyArray<EnvironmentId>;
  readonly connect: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly delayMs: number;
  }>;
  readonly queued: ReadonlyArray<EnvironmentId>;
}

export function createWorkspaceConnectionDemandState(
  platformMaxConnections: number,
): WorkspaceConnectionDemandState {
  if (
    !Number.isInteger(platformMaxConnections) ||
    platformMaxConnections < 1 ||
    platformMaxConnections > UNIFIED_WORKSPACE_MAX_CONNECTIONS
  ) {
    throw new RangeError(
      `platformMaxConnections must be between 1 and ${UNIFIED_WORKSPACE_MAX_CONNECTIONS}`,
    );
  }
  return { platformMaxConnections, backgrounded: false, leases: [], connections: [] };
}

function upsertConnection(
  state: WorkspaceConnectionDemandState,
  environmentId: EnvironmentId,
  update: (current: WorkspaceDemandConnection) => WorkspaceDemandConnection,
): WorkspaceConnectionDemandState {
  const current = state.connections.find((entry) => entry.environmentId === environmentId) ?? {
    environmentId,
    connected: false,
    lastAccessedAt: 0,
  };
  return {
    ...state,
    connections: [
      ...state.connections.filter((entry) => entry.environmentId !== environmentId),
      update(current),
    ],
  };
}

export function touchWorkspaceEnvironment(
  state: WorkspaceConnectionDemandState,
  environmentId: EnvironmentId,
  now: number,
): WorkspaceConnectionDemandState {
  return upsertConnection(state, environmentId, (current) => ({
    ...current,
    lastAccessedAt: Math.max(current.lastAccessedAt, now),
  }));
}

export function setWorkspaceEnvironmentConnected(
  state: WorkspaceConnectionDemandState,
  environmentId: EnvironmentId,
  connected: boolean,
  now: number,
): WorkspaceConnectionDemandState {
  return upsertConnection(state, environmentId, (current) => ({
    ...current,
    connected,
    lastAccessedAt: Math.max(current.lastAccessedAt, now),
  }));
}

export function retainWorkspaceConnectionScope(
  state: WorkspaceConnectionDemandState,
  input: {
    readonly leaseId: string;
    readonly environmentId: EnvironmentId;
    readonly scope: WorkspaceConnectionScope;
    readonly now: number;
    readonly ttlMs?: number;
    readonly preemptible?: boolean;
    /** Sets both `warm` and `preemptible`. */
    readonly warm?: boolean;
  },
): WorkspaceConnectionDemandState {
  if (input.leaseId.length === 0) throw new TypeError("leaseId must not be empty");
  if (state.leases.some((lease) => lease.leaseId === input.leaseId)) {
    throw new Error(`Duplicate workspace connection lease: ${input.leaseId}`);
  }
  const ttlMs = input.ttlMs ?? UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
  return touchWorkspaceEnvironment(
    {
      ...state,
      leases: [
        ...state.leases,
        {
          leaseId: input.leaseId,
          environmentId: input.environmentId,
          scope: input.scope,
          retainedAt: input.now,
          expiresAt: input.now + ttlMs,
          ...(input.warm === true
            ? { preemptible: true, warm: true }
            : input.preemptible === true
              ? { preemptible: true }
              : {}),
        },
      ],
    },
    input.environmentId,
    input.now,
  );
}

export function renewWorkspaceConnectionScope(
  state: WorkspaceConnectionDemandState,
  leaseId: string,
  now: number,
  ttlMs = UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS,
): WorkspaceConnectionDemandState {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
  return {
    ...state,
    leases: state.leases.map((lease) =>
      lease.leaseId === leaseId ? { ...lease, expiresAt: now + ttlMs } : lease,
    ),
  };
}

export function releaseWorkspaceConnectionScope(
  state: WorkspaceConnectionDemandState,
  leaseId: string,
): WorkspaceConnectionDemandState {
  return { ...state, leases: state.leases.filter((lease) => lease.leaseId !== leaseId) };
}

export function setWorkspaceConnectionBackgrounded(
  state: WorkspaceConnectionDemandState,
  backgrounded: boolean,
): WorkspaceConnectionDemandState {
  return state.backgrounded === backgrounded ? state : { ...state, backgrounded };
}

export function pruneExpiredWorkspaceConnectionScopes(
  state: WorkspaceConnectionDemandState,
  now: number,
): WorkspaceConnectionDemandState {
  const leases = state.leases.filter((lease) => lease.expiresAt > now);
  return leases.length === state.leases.length ? state : { ...state, leases };
}

/**
 * Whether an environment's connection is wanted right now: it is the
 * foreground environment or holds an unexpired lease that is not warm. A live
 * environment that is not demanded is released after a relay drop instead of
 * reconnecting, so a warm environment never reconnects on its own.
 */
export function isWorkspaceEnvironmentDemanded(
  state: WorkspaceConnectionDemandState,
  environmentId: EnvironmentId,
  input: { readonly now: number; readonly foregroundEnvironmentId?: EnvironmentId | null },
): boolean {
  if (input.foregroundEnvironmentId === environmentId) return true;
  return state.leases.some(
    (lease) =>
      lease.environmentId === environmentId && lease.expiresAt > input.now && lease.warm !== true,
  );
}

/**
 * Whether only warm leases hold the environment: it is not the foreground and
 * every unexpired lease it holds, at least one, is warm.
 */
export function isWorkspaceEnvironmentWarmOnly(
  state: WorkspaceConnectionDemandState,
  environmentId: EnvironmentId,
  input: { readonly now: number; readonly foregroundEnvironmentId?: EnvironmentId | null },
): boolean {
  if (input.foregroundEnvironmentId === environmentId) return false;
  let warm = false;
  for (const lease of state.leases) {
    if (lease.environmentId !== environmentId || lease.expiresAt <= input.now) continue;
    if (lease.warm !== true) return false;
    warm = true;
  }
  return warm;
}

/**
 * Moves the environment to the front of a most-recently-used list of at most
 * `limit` entries. Returns the same array when nothing changed.
 */
export function noteRecentWorkspaceEnvironment(
  recent: ReadonlyArray<EnvironmentId>,
  environmentId: EnvironmentId,
  limit: number,
): ReadonlyArray<EnvironmentId> {
  const bound = Math.max(0, Math.floor(limit));
  if (recent[0] === environmentId && recent.length <= bound) return recent;
  const next = [environmentId, ...recent.filter((entry) => entry !== environmentId)].slice(
    0,
    bound,
  );
  return next.length === recent.length && next.every((entry, index) => entry === recent[index])
    ? recent
    : next;
}

/**
 * Decides which environments to release, connect and queue. The planner alone
 * decides eviction: retained environments are never released, except that
 *
 * - retained environments without a free slot, the foreground among them,
 *   displace warm-only connected environments, least recently retained first,
 *   one per slot they need; and
 * - a retained foreground environment that still has no free slot may displace
 *   one whose leases are all preemptible; when none qualifies it is queued.
 *
 * Displaced environments are queued and keep their leases. The foreground
 * connects first with no delay, the other retained environments follow by
 * retain recency and warm-only ones after them, each `wakeStaggerMs` after the
 * previous one. Warm-only environments take only free slots and never displace
 * anything: unlike other demand, they never release a connection nothing
 * retains, connected or still connecting, to make room. While backgrounded
 * they are released and not queued.
 */
export function planWorkspaceConnectionDemand(
  source: WorkspaceConnectionDemandState,
  input: {
    readonly now: number;
    readonly wakeStaggerMs?: number;
    readonly foregroundEnvironmentId?: EnvironmentId | null;
  },
): WorkspaceConnectionDemandPlan {
  const state = pruneExpiredWorkspaceConnectionScopes(source, input.now);
  const foreground = input.foregroundEnvironmentId ?? null;
  const retainedSet = new Set<EnvironmentId>();
  // Warm leases order only environments nothing else holds, so they never
  // reorder other demand.
  const retainedAtByEnvironment = new Map<EnvironmentId, number>();
  const warmRetainedAtByEnvironment = new Map<EnvironmentId, number>();
  const preemptibleByEnvironment = new Map<EnvironmentId, boolean>();
  for (const lease of state.leases) {
    retainedSet.add(lease.environmentId);
    const recency = lease.warm === true ? warmRetainedAtByEnvironment : retainedAtByEnvironment;
    recency.set(
      lease.environmentId,
      Math.max(recency.get(lease.environmentId) ?? Number.NEGATIVE_INFINITY, lease.retainedAt),
    );
    preemptibleByEnvironment.set(
      lease.environmentId,
      (preemptibleByEnvironment.get(lease.environmentId) ?? true) && lease.preemptible === true,
    );
  }
  const retainedAt = (environmentId: EnvironmentId) =>
    retainedAtByEnvironment.get(environmentId) ??
    warmRetainedAtByEnvironment.get(environmentId) ??
    0;
  const isWarmOnly = (environmentId: EnvironmentId) =>
    environmentId !== foreground &&
    retainedSet.has(environmentId) &&
    !retainedAtByEnvironment.has(environmentId);
  const byRetainRecency = (left: EnvironmentId, right: EnvironmentId) =>
    retainedAt(right) - retainedAt(left) || String(left).localeCompare(String(right));
  const byLeastRecentlyRetained = (left: EnvironmentId, right: EnvironmentId) =>
    retainedAt(left) - retainedAt(right) || String(left).localeCompare(String(right));
  const retained = Array.from(retainedSet);
  const connected = state.connections.filter((entry) => entry.connected);
  const connectedSet = new Set(connected.map((entry) => entry.environmentId));
  const nonRetainedConnected = connected
    .filter((entry) => !retainedSet.has(entry.environmentId))
    .toSorted(
      (left, right) =>
        left.lastAccessedAt - right.lastAccessedAt ||
        String(left.environmentId).localeCompare(String(right.environmentId)),
    );
  const warmOnlyConnected = connected
    .map((entry) => entry.environmentId)
    .filter(isWarmOnly)
    .toSorted(byLeastRecentlyRetained);
  const missingByRecency = retained
    .filter((environmentId) => !connectedSet.has(environmentId))
    .toSorted(byRetainRecency);
  const missingDemand = missingByRecency.filter((environmentId) => !isWarmOnly(environmentId));
  const missingNonWarm =
    foreground !== null && missingDemand.includes(foreground)
      ? [foreground, ...missingDemand.filter((environmentId) => environmentId !== foreground)]
      : missingDemand;
  const missingRetained = [...missingNonWarm, ...missingByRecency.filter(isWarmOnly)];
  const foregroundMissing = foreground !== null && missingRetained[0] === foreground;

  const release: EnvironmentId[] = [];
  if (state.backgrounded) {
    release.push(...nonRetainedConnected.map((entry) => entry.environmentId), ...warmOnlyConnected);
    return {
      state,
      retain: retained.filter(
        (environmentId) => connectedSet.has(environmentId) && !isWarmOnly(environmentId),
      ),
      release,
      connect: [],
      queued: missingNonWarm,
    };
  }

  let projectedConnected = connected.length;
  const victims = [...nonRetainedConnected];
  // Only demand that is not warm makes room: a warm restore never releases,
  // or aborts, a connection.
  while (
    victims.length > 0 &&
    (projectedConnected > state.platformMaxConnections ||
      projectedConnected + missingNonWarm.length > state.platformMaxConnections)
  ) {
    const victim = victims.shift()!;
    release.push(victim.environmentId);
    projectedConnected -= 1;
  }

  // Other demand without a free slot displaces warm-only environments, one per slot.
  const displaced = warmOnlyConnected.slice(
    0,
    Math.max(0, missingNonWarm.length - (state.platformMaxConnections - projectedConnected)),
  );
  release.push(...displaced);
  projectedConnected -= displaced.length;

  const preempted: EnvironmentId[] = [];
  const slotsNeeded = projectedConnected - state.platformMaxConnections + 1;
  if (foregroundMissing && slotsNeeded > 0) {
    const candidates = connected
      .map((entry) => entry.environmentId)
      .filter(
        (environmentId) =>
          environmentId !== foreground &&
          retainedSet.has(environmentId) &&
          !displaced.includes(environmentId) &&
          preemptibleByEnvironment.get(environmentId) === true,
      )
      .toSorted(byLeastRecentlyRetained);
    if (candidates.length >= slotsNeeded) {
      preempted.push(...candidates.slice(0, slotsNeeded));
      release.push(...preempted);
      projectedConnected -= preempted.length;
    }
  }

  const available = Math.max(0, state.platformMaxConnections - projectedConnected);
  const connectNow = missingRetained.slice(0, available);
  const wakeStaggerMs = Math.max(0, input.wakeStaggerMs ?? 0);
  return {
    state,
    retain: retained.filter(
      (environmentId) =>
        connectedSet.has(environmentId) &&
        !displaced.includes(environmentId) &&
        !preempted.includes(environmentId),
    ),
    release,
    connect: connectNow.map((environmentId, index) => ({
      environmentId,
      delayMs: index * wakeStaggerMs,
    })),
    queued: [...missingRetained.slice(connectNow.length), ...displaced, ...preempted],
  };
}
