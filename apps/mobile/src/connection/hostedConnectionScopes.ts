import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS } from "@ryco/client-runtime/state/workspace";

/**
 * Mounted mobile work that makes a hosted environment non-evictable.
 *
 * This intentionally mirrors the small refcounted shape used by t3code's
 * mobile background-activity scopes, but the vocabulary is Ryco's. A scope is
 * retained by the mounted surface that consumes it and released by that
 * surface's cleanup; inbox rendering and prefetch never create one.
 */
export type MobileHostedConnectionScope =
  | { readonly type: "thread-detail"; readonly threadId: ThreadId }
  | { readonly type: "vcs-status"; readonly cwd: string }
  | { readonly type: "provider-status"; readonly instanceId?: string }
  /** Exact-machine trust ceremony; never acquired by list rendering or prefetch. */
  | { readonly type: "node-pairing"; readonly nodeId: string };

export interface RetainedMobileHostedConnectionScope {
  readonly environmentId: EnvironmentId;
  readonly scope: MobileHostedConnectionScope;
  readonly refCount: number;
}

export const MOBILE_SCOPE_LEASE_TTL_MS = UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS;

/** Aggregate-only view of the retained scopes: no environment, thread, cwd, or payload identifiers. */
export interface MobileHostedScopeLeaseDiagnostics {
  readonly observedAt: number;
  readonly ttlMs: typeof MOBILE_SCOPE_LEASE_TTL_MS;
  readonly activeScopeCount: number;
  readonly retainedEnvironmentCount: number;
}

export interface MobileHostedScopeLeaseStore {
  readonly retain: (environmentId: EnvironmentId, scope: MobileHostedConnectionScope) => () => void;
  readonly list: (
    environmentId?: EnvironmentId,
  ) => ReadonlyArray<RetainedMobileHostedConnectionScope>;
  readonly isEnvironmentRetained: (environmentId: EnvironmentId) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reset: () => void;
}

function stableScopeKey(environmentId: EnvironmentId, scope: MobileHostedConnectionScope): string {
  switch (scope.type) {
    case "thread-detail":
      return JSON.stringify([environmentId, scope.type, scope.threadId]);
    case "vcs-status":
      return JSON.stringify([environmentId, scope.type, scope.cwd]);
    case "provider-status":
      return JSON.stringify([environmentId, scope.type, scope.instanceId ?? null]);
    case "node-pairing":
      return JSON.stringify([environmentId, scope.type, scope.nodeId]);
  }
}

export function createMobileHostedScopeLeaseStore(): MobileHostedScopeLeaseStore {
  const retained = new Map<string, RetainedMobileHostedConnectionScope>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const list = (environmentId?: EnvironmentId) =>
    Array.from(retained.values()).filter(
      (entry) => environmentId === undefined || entry.environmentId === environmentId,
    );

  return {
    retain(environmentId, scope) {
      const key = stableScopeKey(environmentId, scope);
      const current = retained.get(key);
      retained.set(key, {
        environmentId,
        scope,
        refCount: (current?.refCount ?? 0) + 1,
      });
      if (!current) notify();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const active = retained.get(key);
        if (!active) return;
        if (active.refCount > 1) {
          retained.set(key, { ...active, refCount: active.refCount - 1 });
          return;
        }
        retained.delete(key);
        notify();
      };
    },
    list,
    isEnvironmentRetained: (environmentId) => list(environmentId).length > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      if (retained.size === 0) return;
      retained.clear();
      notify();
    },
  };
}

export const mobileHostedConnectionScopes = createMobileHostedScopeLeaseStore();

/** Computed on demand from the live refcounts; nothing observes or reports on a timer. */
export function readMobileHostedScopeLeaseDiagnostics(
  store: Pick<MobileHostedScopeLeaseStore, "list"> = mobileHostedConnectionScopes,
  now: () => number = () => Date.now(),
): MobileHostedScopeLeaseDiagnostics {
  const scopes = store.list();
  return {
    observedAt: now(),
    ttlMs: MOBILE_SCOPE_LEASE_TTL_MS,
    activeScopeCount: scopes.length,
    retainedEnvironmentCount: new Set(scopes.map((entry) => entry.environmentId)).size,
  };
}

/** Capacity-assessment arithmetic, kept executable for the PR evidence. */
export function measureHostedLeaseReconnectTraffic(input: {
  readonly clients: number;
  readonly bound: number;
  readonly retainedEnvironmentsPerClient: number;
}): {
  readonly unleasedReconnects: number;
  readonly leasedReconnects: number;
  readonly unleasedShellStreams: number;
  readonly leasedShellStreams: number;
  readonly reduction: number;
} {
  const unleasedReconnects = input.clients * input.bound;
  const leasedReconnects =
    input.clients * Math.min(input.bound, input.retainedEnvironmentsPerClient);
  return {
    unleasedReconnects,
    leasedReconnects,
    // Every environment connection unconditionally owns one shell stream
    // (`connection/connection.ts`). Releasing a connection releases that
    // stream, so connection count is an exact baseline-stream measurement.
    unleasedShellStreams: unleasedReconnects,
    leasedShellStreams: leasedReconnects,
    reduction:
      unleasedReconnects === 0 ? 0 : (unleasedReconnects - leasedReconnects) / unleasedReconnects,
  };
}
