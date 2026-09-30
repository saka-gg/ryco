import type {
  EnvironmentId,
  MessageId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationThreadHistoryCollection,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadHistoryPageInfo,
  OrchestrationThreadWindowSnapshot,
  ThreadId,
} from "@ryco/contracts";

import { scopedThreadKey, scopeThreadRef } from "../scoped.ts";
import type { EnvironmentConnection } from "./connection.ts";
import type { EnvironmentStateSink } from "./environmentStateSink.ts";
import { planEvictionsToCapacity } from "./evictionPolicy.ts";
import {
  classifyProjectionSnapshot,
  createProjectionTracker,
  shouldApplyProjectionEvent,
} from "./projectionTracker.ts";
import {
  orderSavedEnvironmentConnectionQueue,
  runSavedEnvironmentConnectionQueue,
} from "./savedEnvironmentConnectionScheduler.ts";
import { createThreadHistoryPaginationController } from "./threadHistoryPagination.ts";

const NOOP = () => undefined;
const THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS = 5 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;
const MAX_CACHED_THREAD_DETAIL_ESTIMATED_BYTES = 12 * 1024 * 1024;
const BROWSER_RESUME_RECONNECT_COOLDOWN_MS = 2_000;
const SAVED_ENVIRONMENT_STARTUP_DELAY_MS = 2500;
const SAVED_ENVIRONMENT_CONNECT_CONCURRENCY = 2;
/**
 * A saved environment that could not be reached — the remote machine asleep,
 * offline, or not started yet — is tried again on this doubling schedule until
 * it connects, instead of staying disconnected until the app restarts.
 */
const SAVED_ENVIRONMENT_RETRY_BASE_MS = 5_000;
const SAVED_ENVIRONMENT_RETRY_MAX_MS = 60_000;

export interface EnvironmentSupervisorThrottle {
  readonly maybeExecute: () => void;
  readonly cancel: () => void;
}

export interface EnvironmentSupervisorInput<SavedEnvironmentRecord> {
  readonly isHostedMode: () => boolean;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => void;
  readonly createInvalidationThrottle: () => EnvironmentSupervisorThrottle;
  readonly resetProviderInvalidation: () => void;
  readonly createPrimaryConnection: () => EnvironmentConnection | null;
  readonly listSavedEnvironmentRecords: () => ReadonlyArray<SavedEnvironmentRecord>;
  readonly hasSavedEnvironmentRegistryHydrated: () => boolean;
  readonly waitForSavedEnvironmentRegistryHydration: () => Promise<void>;
  readonly subscribeSavedEnvironmentRegistry: (listener: () => void) => () => void;
  readonly connectSavedEnvironment: (
    record: SavedEnvironmentRecord,
    isCancelled: () => boolean,
  ) => Promise<EnvironmentConnection>;
  readonly disconnectSavedEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  readonly waitForPrimaryShellSnapshotApplied: (timeoutMs: number) => Promise<void>;
  readonly subscribeBrowserResume: (listener: (reason: string) => void) => () => void;
  readonly isThreadDetailSubscriptionNonIdle: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => boolean;
  readonly syncThreadDetailSnapshot: (environmentId: EnvironmentId, snapshot: unknown) => void;
  readonly syncThreadWindowSnapshot?: (
    environmentId: EnvironmentId,
    snapshot: OrchestrationThreadWindowSnapshot,
  ) => void;
  readonly syncThreadHistoryPage?: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    page: OrchestrationThreadHistoryPage,
  ) => void;
  readonly setThreadHistoryRequestState?: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly collection: OrchestrationThreadHistoryCollection;
    readonly status: "idle" | "loading" | "error";
    readonly cursor: string | null;
    readonly error: string | null;
  }) => void;
  readonly applyThreadDetailEvent: (environmentId: EnvironmentId, event: unknown) => void;
  readonly stateSink: EnvironmentStateSink;
  readonly onShellSnapshotReceived: (environmentId: EnvironmentId) => void;
  readonly onShellSnapshotCurrent: (environmentId: EnvironmentId) => void;
  readonly onShellSnapshotApplied: (environmentId: EnvironmentId) => void;
  readonly onShellSnapshotReady: (environmentId: EnvironmentId) => void;
  readonly onRegistryChange?: () => void;
}

export class SavedEnvironmentConnectionCancelledError extends Error {
  constructor(environmentId: EnvironmentId) {
    super(`Saved environment ${environmentId} connection was cancelled.`);
    this.name = "SavedEnvironmentConnectionCancelledError";
  }
}

/**
 * The saved credential is missing or no longer accepted. Retrying cannot help;
 * the user has to pair the environment again, so the supervisor does not retry.
 */
export class SavedEnvironmentCredentialError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SavedEnvironmentCredentialError";
  }
}

export function savedEnvironmentRetryDelayMs(failedAttempts: number): number {
  const exponent = Math.max(0, Math.min(failedAttempts - 1, 8));
  return Math.min(SAVED_ENVIRONMENT_RETRY_BASE_MS * 2 ** exponent, SAVED_ENVIRONMENT_RETRY_MAX_MS);
}

type ThreadDetailSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
  protocol: "bounded" | "legacy";
  estimatedRetainedBytes: number;
};

export interface ThreadDetailSubscriptionReleaseOptions {
  readonly immediately?: boolean | undefined;
}

export type ReleaseThreadDetailSubscription = (
  options?: ThreadDetailSubscriptionReleaseOptions,
) => void;

export interface EnvironmentConnectionSupervisor {
  readonly subscribe: (listener: () => void) => () => void;
  readonly list: () => ReadonlyArray<EnvironmentConnection>;
  readonly read: (environmentId: EnvironmentId) => EnvironmentConnection | null;
  readonly require: (environmentId: EnvironmentId) => EnvironmentConnection;
  readonly register: (connection: EnvironmentConnection) => EnvironmentConnection;
  readonly remove: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly connectPrimary: () => EnvironmentConnection | null;
  readonly disconnectPrimary: (environmentId?: EnvironmentId) => Promise<void>;
  readonly ensureSavedEnvironmentConnection: (
    record: { readonly environmentId: EnvironmentId },
    connect: (isCancelled: () => boolean) => Promise<EnvironmentConnection>,
  ) => Promise<EnvironmentConnection>;
  readonly cancelPendingSavedEnvironmentConnection: (environmentId: EnvironmentId) => void;
  readonly applyShellEvent: (
    event: OrchestrationShellStreamEvent,
    environmentId: EnvironmentId,
  ) => void;
  readonly resetShellProjection: (environmentId: EnvironmentId) => void;
  /** The last shell sequence applied for an environment, for resuming its subscription. */
  readonly readShellProjectionSequence: (environmentId: EnvironmentId) => number | null;
  readonly syncShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
    callbacks?: {
      readonly onCurrent: () => void;
      readonly onReady: () => void;
    },
  ) => void;
  readonly retainThreadDetailSubscription: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => ReleaseThreadDetailSubscription;
  readonly disposeThreadDetailSubscriptionsForEnvironment: (environmentId: EnvironmentId) => void;
  readonly disposeThreadDetailSubscription: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => boolean;
  readonly reconcileThreadDetailSubscriptionEvictionForEnvironment: (
    environmentId: EnvironmentId,
  ) => void;
  readonly reconcileThreadDetailSubscriptionEvictionForThread: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => void;
  readonly reconcileThreadDetailSubscriptionsForEnvironment: (
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
  ) => void;
  readonly evictIdleThreadDetailSubscriptionsToCapacity: () => void;
  readonly loadOlderThreadHistory: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly collection: OrchestrationThreadHistoryCollection;
    readonly page: OrchestrationThreadHistoryPageInfo;
    readonly limit: number;
  }) => Promise<OrchestrationThreadHistoryPage | null>;
  readonly loadThreadHistoryAroundMessage: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly limit: number;
  }) => Promise<OrchestrationThreadHistoryPage | null>;
  readonly start: () => () => void;
  readonly requestProviderInvalidation: () => void;
  readonly resetForTests: () => Promise<void>;
}

/**
 * Neutral home for the process-wide connection supervision state. Platform code supplies
 * connection construction and presentation callbacks; this owner keeps registry/cache ordering.
 */
export function createEnvironmentConnectionSupervisor<
  SavedEnvironmentRecord extends {
    readonly environmentId: EnvironmentId;
    readonly lastConnectedAt?: string | null;
  },
>(input: EnvironmentSupervisorInput<SavedEnvironmentRecord>): EnvironmentConnectionSupervisor {
  const connections = new Map<EnvironmentId, EnvironmentConnection>();
  const pendingSavedEnvironmentConnections = new Map<
    EnvironmentId,
    { cancelled: boolean; readonly promise: Promise<EnvironmentConnection> }
  >();
  const listeners = new Set<() => void>();
  const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
  const projectionTracker = createProjectionTracker();
  let activeService: {
    readonly throttle: EnvironmentSupervisorThrottle;
    refCount: number;
    stop: () => void;
  } | null = null;
  let lastBrowserResumeReconnectAt = Number.NEGATIVE_INFINITY;
  const savedRetries = new Map<
    EnvironmentId,
    { failedAttempts: number; timeoutId: ReturnType<typeof setTimeout> | null }
  >();
  let requestSavedSyncForRetry: (() => void) | null = null;
  const clearSavedRetry = (environmentId: EnvironmentId) => {
    const retry = savedRetries.get(environmentId);
    if (retry?.timeoutId != null) input.clearTimeout(retry.timeoutId);
    savedRetries.delete(environmentId);
  };
  const clearAllSavedRetries = () => {
    for (const environmentId of [...savedRetries.keys()]) clearSavedRetry(environmentId);
  };
  const scheduleSavedRetry = (environmentId: EnvironmentId) => {
    const retry = savedRetries.get(environmentId) ?? { failedAttempts: 0, timeoutId: null };
    retry.failedAttempts += 1;
    savedRetries.set(environmentId, retry);
    if (retry.timeoutId !== null) return;
    retry.timeoutId = input.setTimeout(() => {
      retry.timeoutId = null;
      requestSavedSyncForRetry?.();
    }, savedEnvironmentRetryDelayMs(retry.failedAttempts));
  };

  const emit = () => {
    for (const listener of listeners) listener();
    input.onRegistryChange?.();
  };
  const keyFor = (environmentId: EnvironmentId, threadId: ThreadId) =>
    scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const estimateRetainedBytes = (value: unknown): number => {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return 0;
    }
  };
  const recordRetainedSnapshot = (entry: ThreadDetailSubscriptionEntry, snapshot: unknown) => {
    entry.estimatedRetainedBytes = estimateRetainedBytes(snapshot);
  };
  const recordRetainedEvent = (entry: ThreadDetailSubscriptionEntry, event: unknown) => {
    entry.estimatedRetainedBytes = Math.min(
      MAX_CACHED_THREAD_DETAIL_ESTIMATED_BYTES,
      entry.estimatedRetainedBytes + estimateRetainedBytes(event),
    );
  };
  const clearEviction = (entry: ThreadDetailSubscriptionEntry) => {
    if (entry.evictionTimeoutId !== null) {
      input.clearTimeout(entry.evictionTimeoutId);
      entry.evictionTimeoutId = null;
    }
  };
  const shouldEvict = (entry: ThreadDetailSubscriptionEntry) =>
    entry.refCount === 0 &&
    !input.isThreadDetailSubscriptionNonIdle(entry.environmentId, entry.threadId);

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const read = (environmentId: EnvironmentId) => connections.get(environmentId) ?? null;
  const require = (environmentId: EnvironmentId) => {
    const connection = read(environmentId);
    if (!connection)
      throw new Error(`No websocket client registered for environment ${environmentId}.`);
    return connection;
  };

  const historyPagination = createThreadHistoryPaginationController({
    request: (environmentId, request) => {
      const query = require(environmentId).client.orchestration.getThreadHistoryPage;
      return query
        ? query(request)
        : Promise.reject(new Error("Thread history pagination is unavailable"));
    },
    apply: (environmentId, threadId, page) => {
      input.syncThreadHistoryPage?.(environmentId, threadId, page);
      const entry = threadDetailSubscriptions.get(keyFor(environmentId, threadId));
      if (entry) {
        recordRetainedEvent(entry, page);
        evictToCapacity();
      }
    },
    setRequestState: (requestState) => input.setThreadHistoryRequestState?.(requestState),
    recoverStale: async (scope) => {
      const query = require(scope.environmentId).client.orchestration.getThreadWindow;
      if (!query) throw new Error("Bounded thread history is unavailable");
      const snapshot = await query({
        threadId: scope.threadId,
        limits: { messages: 150, proposedPlans: 30, activities: 150, checkpoints: 30 },
      });
      if (input.syncThreadWindowSnapshot) {
        input.syncThreadWindowSnapshot(scope.environmentId, snapshot);
      } else {
        input.syncThreadDetailSnapshot(scope.environmentId, snapshot);
      }
      const entry = threadDetailSubscriptions.get(keyFor(scope.environmentId, scope.threadId));
      if (entry) {
        recordRetainedSnapshot(entry, snapshot);
        evictToCapacity();
      }
    },
  });

  const attach = (entry: ThreadDetailSubscriptionEntry): boolean => {
    if (entry.unsubscribeConnectionListener !== null) {
      entry.unsubscribeConnectionListener();
      entry.unsubscribeConnectionListener = null;
    }
    if (entry.unsubscribe !== NOOP) return true;
    const connection = read(entry.environmentId);
    if (!connection) return false;
    let active = true;
    let unsubscribeCurrent: () => void = NOOP;
    const scope = {
      environmentId: entry.environmentId,
      threadId: entry.threadId,
    };
    const subscribeLegacy = () => {
      if (!active) return;
      entry.protocol = "legacy";
      unsubscribeCurrent();
      unsubscribeCurrent = connection.client.orchestration.subscribeThread(
        { threadId: entry.threadId },
        (item) => {
          if (item.kind === "snapshot") {
            historyPagination.beginSnapshot(scope);
            recordRetainedSnapshot(entry, item.snapshot);
            evictToCapacity();
            input.syncThreadDetailSnapshot(entry.environmentId, item.snapshot);
            return;
          }
          recordRetainedEvent(entry, item.event);
          evictToCapacity();
          input.applyThreadDetailEvent(entry.environmentId, item.event);
        },
      );
    };
    entry.unsubscribe = () => {
      active = false;
      unsubscribeCurrent();
    };
    const subscribeWindow = connection.client.orchestration.subscribeThreadWindow;
    if (entry.protocol === "legacy" || subscribeWindow === undefined) {
      subscribeLegacy();
      return true;
    }
    let fallbackRequested = false;
    const requestLegacy = () => {
      fallbackRequested = true;
      if (unsubscribeCurrent !== NOOP) subscribeLegacy();
    };
    unsubscribeCurrent = subscribeWindow(
      {
        threadId: entry.threadId,
        limits: {
          messages: 150,
          proposedPlans: 30,
          activities: 150,
          checkpoints: 30,
        },
      },
      (item) => {
        if (item.kind === "snapshot") {
          historyPagination.beginSnapshot(scope);
          recordRetainedSnapshot(entry, item.snapshot);
          evictToCapacity();
          if (input.syncThreadWindowSnapshot) {
            input.syncThreadWindowSnapshot(entry.environmentId, item.snapshot);
          } else {
            input.syncThreadDetailSnapshot(entry.environmentId, item.snapshot);
          }
          return;
        }
        recordRetainedEvent(entry, item.event);
        evictToCapacity();
        input.applyThreadDetailEvent(entry.environmentId, item.event);
      },
      { onError: requestLegacy },
    );
    if (fallbackRequested) subscribeLegacy();
    return true;
  };
  const watch = (entry: ThreadDetailSubscriptionEntry) => {
    if (entry.unsubscribeConnectionListener !== null) return;
    entry.unsubscribeConnectionListener = subscribe(() => {
      if (attach(entry)) entry.lastAccessedAt = input.now();
    });
    attach(entry);
  };
  const disposeByKey = (key: string): boolean => {
    const entry = threadDetailSubscriptions.get(key);
    if (!entry) return false;
    clearEviction(entry);
    entry.unsubscribeConnectionListener?.();
    entry.unsubscribeConnectionListener = null;
    threadDetailSubscriptions.delete(key);
    historyPagination.invalidate({
      environmentId: entry.environmentId,
      threadId: entry.threadId,
    });
    entry.unsubscribe();
    entry.unsubscribe = NOOP;
    return true;
  };
  const evictToCapacity = () => {
    const planned = planEvictionsToCapacity(
      [...threadDetailSubscriptions.entries()].map(([key, entry]) => ({
        key,
        lastAccessedAt: entry.lastAccessedAt,
        retainedBytes: entry.estimatedRetainedBytes,
        evictable: shouldEvict(entry),
      })),
      {
        maxEntries: MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS,
        maxBytes: MAX_CACHED_THREAD_DETAIL_ESTIMATED_BYTES,
      },
    );
    for (const key of planned) disposeByKey(key);
  };
  const reconcileEntry = (entry: ThreadDetailSubscriptionEntry) => {
    clearEviction(entry);
    if (!shouldEvict(entry)) return;
    entry.evictionTimeoutId = input.setTimeout(() => {
      const current = threadDetailSubscriptions.get(keyFor(entry.environmentId, entry.threadId));
      if (!current) return;
      current.evictionTimeoutId = null;
      if (shouldEvict(current)) disposeByKey(keyFor(current.environmentId, current.threadId));
    }, THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS);
  };
  const reconcileForEnvironment = (environmentId: EnvironmentId) => {
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.environmentId === environmentId) reconcileEntry(entry);
    }
    evictToCapacity();
  };
  const reconcileForThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const entry = threadDetailSubscriptions.get(keyFor(environmentId, threadId));
    if (entry) reconcileEntry(entry);
  };
  const reconcileSubscriptionsForEnvironment = (
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
  ) => {
    const activeThreadIds = new Set(threadIds);
    for (const [key, entry] of threadDetailSubscriptions) {
      if (entry.environmentId === environmentId && !activeThreadIds.has(entry.threadId)) {
        disposeByKey(key);
      }
    }
  };

  const register = (connection: EnvironmentConnection) => {
    const existing = connections.get(connection.environmentId);
    if (existing === connection) return connection;
    if (existing && existing !== connection) {
      throw new Error(`Environment ${connection.environmentId} already has an active connection.`);
    }
    connections.set(connection.environmentId, connection);
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.environmentId === connection.environmentId) attach(entry);
    }
    emit();
    return connection;
  };
  const remove = async (environmentId: EnvironmentId): Promise<boolean> => {
    const connection = connections.get(environmentId);
    if (!connection) return false;
    connections.delete(environmentId);
    projectionTracker.clearEnvironment(environmentId);
    historyPagination.clearEnvironment(environmentId);
    emit();
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.environmentId !== environmentId) continue;
      entry.unsubscribe();
      entry.unsubscribe = NOOP;
      watch(entry);
    }
    await connection.dispose();
    return true;
  };
  const retain = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const key = keyFor(environmentId, threadId);
    const existing = threadDetailSubscriptions.get(key);
    const entry = existing ?? {
      environmentId,
      threadId,
      unsubscribe: NOOP,
      unsubscribeConnectionListener: null,
      refCount: 0,
      lastAccessedAt: input.now(),
      evictionTimeoutId: null,
      protocol: "bounded" as const,
      estimatedRetainedBytes: 0,
    };
    if (!existing) threadDetailSubscriptions.set(key, entry);
    clearEviction(entry);
    entry.refCount += 1;
    entry.lastAccessedAt = input.now();
    if (!attach(entry)) watch(entry);
    if (!existing) evictToCapacity();
    let released = false;
    return (options?: ThreadDetailSubscriptionReleaseOptions) => {
      if (released) return;
      released = true;
      if (threadDetailSubscriptions.get(key) !== entry) return;
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastAccessedAt = input.now();
      if (entry.refCount === 0) {
        if (options?.immediately === true && shouldEvict(entry)) {
          disposeByKey(key);
          return;
        }
        reconcileEntry(entry);
        evictToCapacity();
      }
    };
  };
  const disposeForEnvironment = (environmentId: EnvironmentId) => {
    for (const [key, entry] of threadDetailSubscriptions) {
      if (entry.environmentId === environmentId) disposeByKey(key);
    }
  };
  const connectPrimary = () => {
    const connection = input.createPrimaryConnection();
    if (!connection) return null;
    const existing = read(connection.environmentId);
    if (existing) {
      // Multi-primary callers can revisit an already-retained environment. The
      // factory has already built the candidate (and its subscriptions), so it
      // still has to be disposed; returning it leaked a second live client.
      if (existing !== connection) void connection.dispose().catch(NOOP);
      return existing;
    }
    return register(connection);
  };
  const disconnectPrimary = async (environmentId?: EnvironmentId) => {
    const connection = environmentId
      ? connections.get(environmentId)
      : [...connections.values()].find((entry) => entry.kind === "primary");
    if (connection?.kind !== "primary") return;
    if (connection) await remove(connection.environmentId).catch(() => false);
  };
  const ensureSavedEnvironmentConnection = (
    record: { readonly environmentId: EnvironmentId },
    connect: (isCancelled: () => boolean) => Promise<EnvironmentConnection>,
  ) => {
    const existing = read(record.environmentId);
    if (existing) return Promise.resolve(existing);
    const pending = pendingSavedEnvironmentConnections.get(record.environmentId);
    if (pending) return pending.promise;

    const pendingEntry: {
      cancelled: boolean;
      promise: Promise<EnvironmentConnection>;
    } = {
      cancelled: false,
      promise: Promise.resolve().then(async () => {
        const connection = await connect(() => pendingEntry.cancelled);
        if (pendingEntry.cancelled) {
          const removed = await remove(connection.environmentId).catch(() => false);
          if (!removed) await connection.dispose().catch(NOOP);
          throw new SavedEnvironmentConnectionCancelledError(record.environmentId);
        }
        return connection;
      }),
    };
    pendingSavedEnvironmentConnections.set(record.environmentId, pendingEntry);
    return pendingEntry.promise.finally(() => {
      if (pendingSavedEnvironmentConnections.get(record.environmentId) === pendingEntry) {
        pendingSavedEnvironmentConnections.delete(record.environmentId);
      }
    });
  };
  const cancelPendingSavedEnvironmentConnection = (environmentId: EnvironmentId) => {
    const pending = pendingSavedEnvironmentConnections.get(environmentId);
    if (!pending) return;
    pending.cancelled = true;
    pendingSavedEnvironmentConnections.delete(environmentId);
  };
  const applyShellEvent = (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) => {
    if (
      !shouldApplyProjectionEvent({
        current: projectionTracker.read(environmentId),
        sequence: event.sequence,
      })
    ) {
      return;
    }
    const context = input.stateSink.prepareShellEvent(environmentId, event);
    input.stateSink.applyShellEvent(environmentId, event);
    projectionTracker.markEvent(environmentId, event.sequence);
    input.stateSink.afterShellEventApplied(environmentId, event, context);
  };
  const syncShellSnapshot = (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
    callbacks?: {
      readonly onCurrent: () => void;
      readonly onReady: () => void;
    },
  ) => {
    input.onShellSnapshotReceived(environmentId);
    const snapshotClassification = classifyProjectionSnapshot({
      current: projectionTracker.read(environmentId),
      next: snapshot,
    });
    if (snapshotClassification === "current") {
      input.onShellSnapshotCurrent(environmentId);
      callbacks?.onCurrent();
      return;
    }
    if (snapshotClassification === "stale") return;

    input.stateSink.syncServerShellSnapshot(environmentId, snapshot);
    input.onShellSnapshotApplied(environmentId);
    projectionTracker.markSnapshot(environmentId, snapshot);
    input.onShellSnapshotReady(environmentId);
    callbacks?.onReady();
    reconcileSubscriptionsForEnvironment(
      environmentId,
      snapshot.threads.map((thread) => thread.id),
    );
    reconcileForEnvironment(environmentId);
    input.stateSink.reconcileSnapshotDerivedState();
  };
  const syncSaved = async () => {
    const records = input.listSavedEnvironmentRecords();
    const expected = new Set(records.map((record) => record.environmentId));
    const stale = [...connections.values()]
      .filter((connection) => connection.kind === "saved")
      .map((connection) => connection.environmentId)
      .filter((environmentId) => !expected.has(environmentId));
    await Promise.all(
      stale.map((environmentId) => input.disconnectSavedEnvironment(environmentId)),
    );
    await input.waitForPrimaryShellSnapshotApplied(SAVED_ENVIRONMENT_STARTUP_DELAY_MS);
    for (const environmentId of [...savedRetries.keys()]) {
      if (!expected.has(environmentId)) clearSavedRetry(environmentId);
    }
    await runSavedEnvironmentConnectionQueue(orderSavedEnvironmentConnectionQueue(records), {
      concurrency: SAVED_ENVIRONMENT_CONNECT_CONCURRENCY,
      connect: async (record) => {
        try {
          await ensureSavedEnvironmentConnection(record, (isCancelled) =>
            input.connectSavedEnvironment(record, isCancelled),
          );
          clearSavedRetry(record.environmentId);
        } catch (error) {
          if (
            error instanceof SavedEnvironmentCredentialError ||
            error instanceof SavedEnvironmentConnectionCancelledError
          ) {
            clearSavedRetry(record.environmentId);
            return;
          }
          scheduleSavedRetry(record.environmentId);
        }
      },
    });
  };
  const createSyncScheduler = () => {
    let active: Promise<void> | null = null;
    let queued = false;
    const run = async () => {
      do {
        queued = false;
        await syncSaved();
      } while (queued);
    };
    return () => {
      if (active) {
        queued = true;
        return active;
      }
      active = run()
        .catch(() => undefined)
        .finally(() => {
          active = null;
        });
      return active;
    };
  };
  const reconnectAfterResume = (reason: string) => {
    const now = input.now();
    if (now - lastBrowserResumeReconnectAt < BROWSER_RESUME_RECONNECT_COOLDOWN_MS) return;
    // Waking or regaining the network is the moment an unreachable environment
    // most likely became reachable: try every one now rather than on the
    // backoff it had grown while the machine slept.
    if (savedRetries.size > 0) {
      for (const retry of savedRetries.values()) {
        if (retry.timeoutId !== null) input.clearTimeout(retry.timeoutId);
        retry.timeoutId = null;
        retry.failedAttempts = 0;
      }
      requestSavedSyncForRetry?.();
    }
    for (const connection of connections.values()) {
      if (connection.client.isHeartbeatFresh()) continue;
      lastBrowserResumeReconnectAt = now;
      void connection.reconnect().catch((error) => {
        console.warn("Environment reconnect after browser resume failed", {
          environmentId: connection.environmentId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };
  const stopActive = () => {
    activeService?.stop();
    activeService = null;
    requestSavedSyncForRetry = null;
    clearAllSavedRetries();
  };
  const requestProviderInvalidation = () => {
    activeService?.throttle.maybeExecute();
  };
  const start = () => {
    if (activeService) {
      const existing = activeService;
      existing.refCount += 1;
      return () => {
        if (activeService !== existing) return;
        existing.refCount -= 1;
        if (existing.refCount === 0) stopActive();
      };
    }
    stopActive();
    input.resetProviderInvalidation();
    const throttle = input.createInvalidationThrottle();
    const requestSavedSync = createSyncScheduler();
    requestSavedSyncForRetry = () => {
      void requestSavedSync();
    };
    connectPrimary();
    const unsubscribeSaved = input.isHostedMode()
      ? NOOP
      : input.subscribeSavedEnvironmentRegistry(() => {
          if (input.hasSavedEnvironmentRegistryHydrated()) void requestSavedSync();
        });
    if (!input.isHostedMode()) {
      void input.waitForSavedEnvironmentRegistryHydration().then(requestSavedSync).catch(NOOP);
    }
    const unsubscribeResume = input.isHostedMode()
      ? NOOP
      : input.subscribeBrowserResume(reconnectAfterResume);
    const service = {
      throttle,
      refCount: 1,
      stop: () => {
        unsubscribeSaved();
        unsubscribeResume();
        throttle.cancel();
      },
    };
    activeService = service;
    return () => {
      if (activeService !== service) return;
      service.refCount -= 1;
      if (service.refCount === 0) stopActive();
    };
  };
  const resetForTests = async () => {
    stopActive();
    lastBrowserResumeReconnectAt = Number.NEGATIVE_INFINITY;
    for (const key of threadDetailSubscriptions.keys()) disposeByKey(key);
    await Promise.all([...connections.keys()].map((environmentId) => remove(environmentId)));
    pendingSavedEnvironmentConnections.clear();
    projectionTracker.clear();
  };
  return {
    subscribe,
    list: () => [...connections.values()],
    read,
    require,
    register,
    remove,
    connectPrimary,
    disconnectPrimary,
    ensureSavedEnvironmentConnection,
    cancelPendingSavedEnvironmentConnection,
    applyShellEvent,
    resetShellProjection: (environmentId) => projectionTracker.clearEnvironment(environmentId),
    readShellProjectionSequence: (environmentId) =>
      projectionTracker.read(environmentId)?.sequence ?? null,
    syncShellSnapshot,
    retainThreadDetailSubscription: retain,
    disposeThreadDetailSubscriptionsForEnvironment: disposeForEnvironment,
    disposeThreadDetailSubscription: (environmentId, threadId) =>
      disposeByKey(keyFor(environmentId, threadId)),
    reconcileThreadDetailSubscriptionEvictionForEnvironment: reconcileForEnvironment,
    reconcileThreadDetailSubscriptionEvictionForThread: reconcileForThread,
    reconcileThreadDetailSubscriptionsForEnvironment: reconcileSubscriptionsForEnvironment,
    evictIdleThreadDetailSubscriptionsToCapacity: evictToCapacity,
    loadOlderThreadHistory: ({ environmentId, threadId, collection, page, limit }) =>
      historyPagination.loadBefore({
        scope: { environmentId, threadId },
        collection,
        page,
        limit,
      }),
    loadThreadHistoryAroundMessage: ({ environmentId, threadId, messageId, limit }) =>
      historyPagination.loadAroundMessage({
        scope: { environmentId, threadId },
        anchorId: messageId,
        limit,
      }),
    start,
    requestProviderInvalidation,
    resetForTests,
  };
}
