import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS,
  type WorkspaceConnectionScope,
} from "@ryco/client-runtime/state/workspace";

export const HOSTED_WEB_SCOPE_REPORT_INTERVAL_MS = 25_000;
export const HOSTED_WEB_SCOPE_LEASE_TTL_MS = UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS;
/** How long a press on a row holds its environment's demand for the navigation that follows. */
export const HOSTED_WEB_INTENT_SCOPE_TTL_MS = 3_000;

export interface RetainedHostedWebScope {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly scope: WorkspaceConnectionScope;
  readonly refCount: number;
}

function scopeKey(environmentId: EnvironmentId, scope: WorkspaceConnectionScope): string {
  switch (scope.type) {
    case "interactive":
      return JSON.stringify([environmentId, scope.type]);
    case "thread-detail":
      return JSON.stringify([environmentId, scope.type, scope.threadId]);
    case "vcs-status":
      return JSON.stringify([environmentId, scope.type, scope.cwd]);
    case "provider-status":
      return JSON.stringify([environmentId, scope.type, scope.instanceId ?? null]);
  }
}

export interface HostedWebScopeStore {
  readonly retain: (environmentId: EnvironmentId, scope: WorkspaceConnectionScope) => () => void;
  readonly list: () => ReadonlyArray<RetainedHostedWebScope>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reset: () => void;
}

export function createHostedWebScopeStore(): HostedWebScopeStore {
  const entries = new Map<string, RetainedHostedWebScope>();
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    retain(environmentId, scope) {
      const key = scopeKey(environmentId, scope);
      const current = entries.get(key);
      entries.set(key, {
        key,
        environmentId,
        scope,
        refCount: (current?.refCount ?? 0) + 1,
      });
      if (!current) publish();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const active = entries.get(key);
        if (!active) return;
        if (active.refCount > 1) {
          entries.set(key, { ...active, refCount: active.refCount - 1 });
          return;
        }
        entries.delete(key);
        publish();
      };
    },
    list: () => Array.from(entries.values()),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      if (entries.size === 0) return;
      entries.clear();
      publish();
    },
  };
}

export const hostedWebConnectionScopes = createHostedWebScopeStore();

export function retainHostedWorkspaceThreadScope(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  return hostedWebConnectionScopes.retain(environmentId, { type: "thread-detail", threadId });
}

export function retainHostedWorkspaceVcsScope(
  environmentId: EnvironmentId,
  cwd: string,
): () => void {
  return hostedWebConnectionScopes.retain(environmentId, { type: "vcs-status", cwd });
}

export function retainHostedWorkspaceProviderScope(
  environmentId: EnvironmentId,
  instanceId?: string,
): () => void {
  return hostedWebConnectionScopes.retain(environmentId, {
    type: "provider-status",
    ...(instanceId ? { instanceId } : {}),
  });
}

/**
 * Demand for an environment the user is about to open, released after
 * `ttlMs` (or earlier through the returned release). It is an interactive
 * scope, so it is background demand a routed environment may displace and
 * never displaces a mounted view itself.
 */
export function retainHostedIntentScope(
  environmentId: EnvironmentId,
  ttlMs = HOSTED_WEB_INTENT_SCOPE_TTL_MS,
  scopes: HostedWebScopeStore = hostedWebConnectionScopes,
): () => void {
  const release = scopes.retain(environmentId, { type: "interactive" });
  const timer = globalThis.setTimeout(release, ttlMs);
  return () => {
    globalThis.clearTimeout(timer);
    release();
  };
}

export interface QueuedSendScopeSources {
  /** Thread keys whose message queue holds at least one message. */
  readonly queuedThreadKeys: () => Iterable<string>;
  /** Whether the thread is in the thread store: a server thread, not a local draft. */
  readonly isServerThread: (ref: ScopedThreadRef) => boolean;
  /** Fires when the queues or the threads may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Queued sends hold demand: each environment with a queued message for one of
 * its server threads retains one interactive scope until its last such queue
 * empties or is cleared, so the environment connects, or stays warm, to drain
 * it. A queue for a local draft holds none, since a draft's first send goes
 * only from its open draft. Returns the stop, which releases every scope.
 */
export function startQueuedSendScopeRetention(
  sources: QueuedSendScopeSources,
  scopes: HostedWebScopeStore = hostedWebConnectionScopes,
): () => void {
  const releases = new Map<EnvironmentId, () => void>();
  let stopped = false;
  let syncing = false;
  let syncAgain = false;
  const syncOnce = () => {
    const queued = new Set<EnvironmentId>();
    for (const threadKey of sources.queuedThreadKeys()) {
      const ref = parseScopedThreadKey(threadKey);
      if (ref !== null && sources.isServerThread(ref)) queued.add(ref.environmentId);
    }
    for (const [environmentId, release] of Array.from(releases)) {
      if (queued.has(environmentId)) continue;
      releases.delete(environmentId);
      release();
    }
    for (const environmentId of queued) {
      if (stopped) return;
      if (!releases.has(environmentId)) {
        releases.set(environmentId, scopes.retain(environmentId, { type: "interactive" }));
      }
    }
  };
  // A scope change can publish into a listener that changes the stores again;
  // that change is synced once this pass is done.
  const sync = () => {
    if (stopped) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        syncOnce();
      } while (syncAgain);
    } finally {
      syncing = false;
    }
  };
  const unsubscribe = sources.subscribe(sync);
  sync();
  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    for (const release of releases.values()) release();
    releases.clear();
  };
}
