import type {
  EnvironmentId,
  MessageId,
  OrchestrationStubbedShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationShellThreadPrioritiesItem,
  OrchestrationThreadHistoryCollection,
  OrchestrationThreadHistoryLimits,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadHistoryPageInfo,
  OrchestrationThreadWindowSnapshot,
  ThreadId,
} from "@ryco/contracts";

import {
  isResponseTooLargeError,
  isUnsupportedRpcError,
  type SubscriptionFailureKind,
} from "../rpc/wsTransport.ts";
import { scopedThreadKey, scopeThreadRef } from "../scoped.ts";
import { createEnvironmentEventBatcher } from "../state/threads/eventBatching.ts";
import type { ShellStoreUpdate } from "../state/threads/store.ts";
import type { EnvironmentConnection } from "./connection.ts";
import type { EnvironmentStateSink } from "./environmentStateSink.ts";
import { createArchivedThreadShellLoader } from "./archivedThreadShellLoader.ts";
import { planEvictionsToCapacity } from "./evictionPolicy.ts";
import { createRetainedThreadBytes, type RetainedThreadBytes } from "./retainedThreadBytes.ts";
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
/** Runs after the current task's synchronous work, e.g. after a delivered chunk. */
const afterCurrentChunk = (callback: () => void) => {
  void Promise.resolve().then(callback);
};
const THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS = 5 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;
const MAX_CACHED_THREAD_DETAIL_ESTIMATED_BYTES = 12 * 1024 * 1024;
/** The window a thread subscription asks for; shrunk only when a response cannot fit. */
const THREAD_WINDOW_LIMITS: OrchestrationThreadHistoryLimits = {
  messages: 150,
  proposedPlans: 30,
  activities: 150,
  checkpoints: 30,
};
const MIN_THREAD_WINDOW_ITEMS = 10;
/** Backoff for re-requesting a window the server failed to load (not a size or support failure). */
const THREAD_WINDOW_RETRY_BASE_MS = 1_000;
const THREAD_WINDOW_RETRY_MAX_MS = 30_000;
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
/**
 * The longest one saved environment may hold a connect slot. The platform
 * connect bounds its own steps; this is the backstop that keeps one hung connect
 * — an SSH password prompt, a keychain read — from stalling every other saved
 * environment, and every later sync, until the app restarts.
 */
export const SAVED_ENVIRONMENT_CONNECT_TIMEOUT_MS = 60_000;

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
    /** Aborted when the attempt is given up (a cancel, or its slot timing out). */
    signal: AbortSignal,
  ) => Promise<EnvironmentConnection>;
  /**
   * A saved environment whose credential the node rejected. Syncs skip it: they
   * run on every registry change and retry tick, and each attempt would only
   * present the dead credential again. Pairing again and an explicit Connect go
   * through `ensureSavedEnvironmentConnection` and still reach it.
   */
  readonly isSavedEnvironmentAwaitingRepair?: (environmentId: EnvironmentId) => boolean;
  readonly disconnectSavedEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  readonly waitForPrimaryShellSnapshotApplied: (timeoutMs: number) => Promise<void>;
  readonly subscribeBrowserResume: (listener: (reason: string) => void) => () => void;
  readonly isThreadDetailSubscriptionNonIdle: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => boolean;
  readonly syncThreadDetailSnapshot: (environmentId: EnvironmentId, snapshot: unknown) => void;
  /**
   * Ask windows and history pages for bounded activity previews. Only a client
   * that fetches full payloads on demand (`orchestration.getActivityPayload`)
   * may set it; servers without previews ignore it.
   */
  readonly threadWindowActivityPayloads?: "preview";
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
  /**
   * Schedules the commit of the shell items buffered since the last one. The
   * default is the threads runtime's animation-frame scheduler.
   */
  readonly scheduleShellFrame?: (callback: () => void) => void;
  readonly onShellSnapshotReceived: (environmentId: EnvironmentId) => void;
  readonly onShellSnapshotCurrent: (environmentId: EnvironmentId) => void;
  readonly onShellSnapshotApplied: (environmentId: EnvironmentId) => void;
  readonly onShellSnapshotReady: (environmentId: EnvironmentId) => void;
  readonly onRegistryChange?: () => void;
}

export class SavedEnvironmentConnectionCancelledError extends Error {
  constructor(environmentId: EnvironmentId, options?: { readonly cause?: unknown }) {
    super(`Saved environment ${environmentId} connection was cancelled.`, options);
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

/** Halves the message and activity limits, or null once they cannot shrink further. */
function shrinkThreadWindowLimits(
  limits: OrchestrationThreadHistoryLimits,
): OrchestrationThreadHistoryLimits | null {
  if (limits.messages <= MIN_THREAD_WINDOW_ITEMS && limits.activities <= MIN_THREAD_WINDOW_ITEMS) {
    return null;
  }
  return {
    ...limits,
    messages: Math.max(MIN_THREAD_WINDOW_ITEMS, Math.floor(limits.messages / 2)),
    activities: Math.max(MIN_THREAD_WINDOW_ITEMS, Math.floor(limits.activities / 2)),
  };
}

/**
 * Only a server without bounded windows gets the legacy full-detail stream,
 * which has no limit at all: a window that failed for size or a server error
 * would fail the same way, only larger.
 */
function isThreadWindowUnsupportedError(error: unknown): boolean {
  if (isUnsupportedRpcError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Bounded thread history is unavailable");
}

function classifyThreadWindowFailure(error: unknown): SubscriptionFailureKind {
  if (isThreadWindowUnsupportedError(error)) return "unsupported";
  if (isResponseTooLargeError(error)) return "response-too-large";
  return "failed";
}

type ThreadDetailSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
  /** Retains from views the user has open; the rest only keep the thread warm. */
  viewCount: number;
  /** View retains ever taken; a retain handle compares it to tell whether a view came since. */
  viewRetains: number;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
  protocol: "bounded" | "legacy";
  /** The window this subscription asks for; shrunk after a response too large to carry. */
  windowLimits: OrchestrationThreadHistoryLimits;
  /**
   * Approximate client memory this thread holds: its last snapshot plus the
   * rows live events and history pages added since, never the traffic.
   */
  estimatedRetainedBytes: number;
  /** The rows behind `estimatedRetainedBytes`, capped like the store's collections. */
  readonly retainedRows: RetainedThreadBytes;
};

export interface ThreadDetailSubscriptionReleaseOptions {
  /**
   * Dispose the subscription now instead of keeping it in the idle cache, when
   * this was its last retain and no view retained the thread while this retain
   * was held (including a view that was already open when it was taken). A speculative retain (a hover, a press) that led to the thread
   * being opened hands the stream to the idle cache like the view's release.
   */
  readonly immediately?: boolean | undefined;
}

export interface ThreadDetailSubscriptionRetainOptions {
  /**
   * The retain serves a view the user has open, not a prewarm or a background
   * owner. Provider history recovery runs only while a view retains the thread.
   */
  readonly view?: boolean | undefined;
}

export type ReleaseThreadDetailSubscription = (
  options?: ThreadDetailSubscriptionReleaseOptions,
) => void;

interface PendingSavedEnvironmentConnection {
  /**
   * Cancels the attempt and aborts its requests. With `error`, everyone waiting
   * on it receives that error at once.
   */
  readonly abandon: (error?: Error) => void;
  readonly promise: Promise<EnvironmentConnection>;
}

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
    connect: (isCancelled: () => boolean, signal: AbortSignal) => Promise<EnvironmentConnection>,
  ) => Promise<EnvironmentConnection>;
  readonly cancelPendingSavedEnvironmentConnection: (environmentId: EnvironmentId) => void;
  /** Buffers a shell event; buffered items commit once per environment and frame. */
  readonly applyShellEvent: (
    event: OrchestrationShellStreamEvent,
    environmentId: EnvironmentId,
  ) => void;
  /** Buffers a thread-priority ranking behind the shell events before it. */
  readonly applyThreadPriorities: (
    item: OrchestrationShellThreadPrioritiesItem,
    environmentId: EnvironmentId,
  ) => void;
  /** Commits buffered shell items now (tests, teardown). */
  readonly flushShellEvents: () => void;
  readonly resetShellProjection: (environmentId: EnvironmentId) => void;
  /** The last shell sequence applied for an environment, for resuming its subscription. */
  readonly readShellProjectionSequence: (environmentId: EnvironmentId) => number | null;
  readonly syncShellSnapshot: (
    snapshot: OrchestrationStubbedShellSnapshot,
    environmentId: EnvironmentId,
    callbacks?: {
      readonly onCurrent: () => void;
      readonly onReady: () => void;
    },
  ) => void;
  readonly retainThreadDetailSubscription: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    options?: ThreadDetailSubscriptionRetainOptions,
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
  /**
   * Loads the full shells of threads the store holds as archived stubs, for a
   * view that needs more than a stub carries without opening the thread. A
   * no-op for full shells; opening a thread loads its own.
   */
  readonly ensureArchivedThreadShells: (
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
  ) => void;
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
    PendingSavedEnvironmentConnection
  >();
  const listeners = new Set<() => void>();
  const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
  const projectionTracker = createProjectionTracker();
  // The threads each environment's applied shell lists. Absent until a snapshot
  // lands: until then nothing is known missing and subscriptions attach as before.
  const shellThreadIdsByEnvironment = new Map<EnvironmentId, Set<ThreadId>>();
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
    for (const environmentId of savedRetries.keys()) clearSavedRetry(environmentId);
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
  const setRetainedBytes = (entry: ThreadDetailSubscriptionEntry, bytes: number) => {
    entry.estimatedRetainedBytes = Math.min(MAX_CACHED_THREAD_DETAIL_ESTIMATED_BYTES, bytes);
  };
  const recordRetainedSnapshot = (entry: ThreadDetailSubscriptionEntry, snapshot: unknown) => {
    entry.retainedRows.recordSnapshot(snapshot);
    setRetainedBytes(entry, entry.retainedRows.bytes());
  };
  const recordRetainedEvent = (entry: ThreadDetailSubscriptionEntry, event: unknown) => {
    entry.retainedRows.recordEvent(event);
    setRetainedBytes(entry, entry.retainedRows.bytes());
  };
  const recordRetainedHistoryPage = (entry: ThreadDetailSubscriptionEntry, page: unknown) => {
    entry.retainedRows.recordHistoryPage(page);
    setRetainedBytes(entry, entry.retainedRows.bytes());
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

  // Full shells for archived stubs the user opens (or that a retained
  // subscription keeps warm), from the environment's current connection.
  const archivedThreadShells = createArchivedThreadShellLoader({
    sourceFor: (environmentId) => {
      const connection = read(environmentId);
      return connection === null
        ? null
        : { token: connection, getThreadShells: connection.client.orchestration.getThreadShells };
    },
    isArchivedThreadStub: (environmentId, threadId) =>
      input.stateSink.isArchivedThreadStub?.(environmentId, threadId) ?? false,
    apply: (environmentId, threads) =>
      input.stateSink.applyLoadedThreadShells?.(environmentId, threads),
  });

  const activityPayloads = input.threadWindowActivityPayloads;
  const activityPayloadsRequest = activityPayloads !== undefined ? { activityPayloads } : {};
  const historyPagination = createThreadHistoryPaginationController({
    request: (environmentId, request) => {
      const query = require(environmentId).client.orchestration.getThreadHistoryPage;
      return query
        ? query(
            request.collection === "activities" && activityPayloads !== undefined
              ? { ...request, activityPayloads }
              : request,
          )
        : Promise.reject(new Error("Thread history pagination is unavailable"));
    },
    apply: (environmentId, threadId, page) => {
      input.syncThreadHistoryPage?.(environmentId, threadId, page);
      const entry = threadDetailSubscriptions.get(keyFor(environmentId, threadId));
      if (entry) {
        recordRetainedHistoryPage(entry, page);
        scheduleEvictToCapacity();
      }
    },
    setRequestState: (requestState) => input.setThreadHistoryRequestState?.(requestState),
    recoverStale: async (scope) => {
      const query = require(scope.environmentId).client.orchestration.getThreadWindow;
      if (!query) throw new Error("Bounded thread history is unavailable");
      const current = threadDetailSubscriptions.get(keyFor(scope.environmentId, scope.threadId));
      const snapshot = await query({
        threadId: scope.threadId,
        limits: current?.windowLimits ?? THREAD_WINDOW_LIMITS,
        ...activityPayloadsRequest,
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

  const historyRecoveryMode = (entry: ThreadDetailSubscriptionEntry) =>
    entry.viewCount > 0 ? ("active" as const) : ("passive" as const);
  /**
   * A view attached to (or left) a subscription that is already running: the
   * server learns it so history recovery follows the view. A subscription that
   * starts later sends its mode with the request instead.
   */
  const announceHistoryRecoveryMode = (entry: ThreadDetailSubscriptionEntry) => {
    if (entry.unsubscribe === NOOP) return;
    const setMode = read(entry.environmentId)?.client.orchestration.setThreadHistoryRecovery;
    if (setMode === undefined) return;
    // An older server ignores the mode altogether; nothing to retry.
    void setMode({ threadId: entry.threadId, mode: historyRecoveryMode(entry) }).catch(NOOP);
  };
  const isMissingFromShell = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const threadIds = shellThreadIdsByEnvironment.get(environmentId);
    return threadIds !== undefined && !threadIds.has(threadId);
  };
  const attach = (entry: ThreadDetailSubscriptionEntry): boolean => {
    if (entry.unsubscribeConnectionListener !== null) {
      entry.unsubscribeConnectionListener();
      entry.unsubscribeConnectionListener = null;
    }
    if (entry.unsubscribe !== NOOP) return true;
    // A local draft's thread does not exist on the server until its first send,
    // and the transport retries a missing thread every 250 ms. Wait for the
    // shell to list the thread instead; `attachListedThreads` picks it up.
    if (isMissingFromShell(entry.environmentId, entry.threadId)) return true;
    const connection = read(entry.environmentId);
    if (!connection) return false;
    // Before this connection's first snapshot a stub can only be a cached one; the
    // snapshot's own pass below loads whatever is still a stub then.
    if (shellThreadIdsByEnvironment.has(entry.environmentId)) {
      archivedThreadShells.ensureFullShell(entry.environmentId, entry.threadId);
    }
    let active = true;
    let unsubscribeCurrent: () => void = NOOP;
    const scope = {
      environmentId: entry.environmentId,
      threadId: entry.threadId,
    };
    // The last sequence this subscription applied. A replacement subscription
    // after a reconnect resumes after it instead of reloading the thread. Hosted
    // and Hub-relayed connections always take a fresh snapshot.
    let appliedSequence: number | null = null;
    const resumable = !input.isHostedMode() && connection.knownEnvironment.source !== "hub-hosted";
    const subscriptionOptions = {
      ...(resumable ? { resumeFromSequence: () => appliedSequence } : {}),
      historyRecovery: () => historyRecoveryMode(entry),
    };
    const applyEvent = (event: { readonly sequence: number }) => {
      appliedSequence = Math.max(appliedSequence ?? 0, event.sequence);
      recordRetainedEvent(entry, event);
      scheduleEvictToCapacity();
      input.applyThreadDetailEvent(entry.environmentId, event);
    };
    const subscribeLegacy = () => {
      if (!active) return;
      entry.protocol = "legacy";
      unsubscribeCurrent();
      appliedSequence = null;
      unsubscribeCurrent = connection.client.orchestration.subscribeThread(
        { threadId: entry.threadId },
        (item) => {
          if (item.kind === "resumed") return;
          if (item.kind === "snapshot") {
            appliedSequence = item.snapshot.snapshotSequence;
            historyPagination.beginSnapshot(scope);
            recordRetainedSnapshot(entry, item.snapshot);
            evictToCapacity();
            input.syncThreadDetailSnapshot(entry.environmentId, item.snapshot);
            return;
          }
          applyEvent(item.event);
        },
        subscriptionOptions,
      );
    };
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let failedWindowAttempts = 0;
    const clearRetry = () => {
      if (retryTimeoutId === null) return;
      input.clearTimeout(retryTimeoutId);
      retryTimeoutId = null;
    };
    entry.unsubscribe = () => {
      active = false;
      clearRetry();
      unsubscribeCurrent();
    };
    const subscribeWindow = connection.client.orchestration.subscribeThreadWindow;
    if (entry.protocol === "legacy" || subscribeWindow === undefined) {
      subscribeLegacy();
      return true;
    }
    // A failure can arrive synchronously, before the subscription below has
    // returned its unsubscribe; it is handled once that has happened.
    let pendingFailure: { readonly kind: SubscriptionFailureKind | undefined } | null = null;
    let subscribing = false;
    const handleWindowFailure = (kind: SubscriptionFailureKind | undefined) => {
      if (!active) return;
      if (kind === "unsupported") {
        subscribeLegacy();
        return;
      }
      unsubscribeCurrent();
      unsubscribeCurrent = NOOP;
      if (kind === "response-too-large") {
        // The window did not fit the connection (the relay's message cap):
        // ask again for fewer rows; history pagination reaches the rest.
        const smaller = shrinkThreadWindowLimits(entry.windowLimits);
        if (smaller === null) {
          // Only a single row larger than the connection carries is left.
          console.warn("Thread window does not fit this connection", {
            threadId: entry.threadId,
          });
          return;
        }
        entry.windowLimits = smaller;
        subscribeBoundedWindow();
        return;
      }
      // A server-side load failure: retry the bounded window with backoff.
      failedWindowAttempts += 1;
      const delayMs = Math.min(
        THREAD_WINDOW_RETRY_BASE_MS * 2 ** Math.min(failedWindowAttempts - 1, 8),
        THREAD_WINDOW_RETRY_MAX_MS,
      );
      clearRetry();
      retryTimeoutId = input.setTimeout(() => {
        retryTimeoutId = null;
        subscribeBoundedWindow();
      }, delayMs);
    };
    const subscribeBoundedWindow = () => {
      if (!active) return;
      subscribing = true;
      pendingFailure = null;
      unsubscribeCurrent = subscribeWindow(
        { threadId: entry.threadId, limits: entry.windowLimits, ...activityPayloadsRequest },
        (item) => {
          // Any item, a resume included, means the server served this window.
          failedWindowAttempts = 0;
          if (item.kind === "resumed") return;
          if (item.kind === "snapshot") {
            appliedSequence = item.snapshot.snapshotSequence;
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
          applyEvent(item.event);
        },
        {
          ...subscriptionOptions,
          classifyFailure: classifyThreadWindowFailure,
          onError: (kind) => {
            if (subscribing) pendingFailure = { kind };
            else handleWindowFailure(kind);
          },
        },
      );
      subscribing = false;
      const failure = pendingFailure as {
        readonly kind: SubscriptionFailureKind | undefined;
      } | null;
      if (failure !== null) {
        pendingFailure = null;
        handleWindowFailure(failure.kind);
      }
    };
    subscribeBoundedWindow();
    return true;
  };
  const watch = (entry: ThreadDetailSubscriptionEntry) => {
    if (entry.unsubscribeConnectionListener !== null) return;
    entry.unsubscribeConnectionListener = subscribe(() => {
      if (attach(entry)) entry.lastAccessedAt = input.now();
    });
    attach(entry);
  };
  const attachListedThreads = (environmentId: EnvironmentId) => {
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.environmentId !== environmentId || entry.unsubscribe !== NOOP) continue;
      if (!attach(entry)) watch(entry);
    }
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
        // A busy pinned thread must not starve the cache of idle ones.
        byteBudget: "evictable",
      },
    );
    for (const key of planned) disposeByKey(key);
  };
  // Live events arrive a chunk at a time; the cache is re-planned once after
  // the chunk rather than once per event.
  let evictionScheduled = false;
  const scheduleEvictToCapacity = () => {
    if (evictionScheduled) return;
    evictionScheduled = true;
    afterCurrentChunk(() => {
      evictionScheduled = false;
      evictToCapacity();
    });
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
  // Event application asks for this once per event; it runs once per chunk.
  const pendingReconcileEnvironmentIds = new Set<EnvironmentId>();
  const scheduleReconcileForEnvironment = (environmentId: EnvironmentId) => {
    if (pendingReconcileEnvironmentIds.size === 0) {
      afterCurrentChunk(() => {
        const environmentIds = [...pendingReconcileEnvironmentIds];
        pendingReconcileEnvironmentIds.clear();
        for (const pendingEnvironmentId of environmentIds) {
          reconcileForEnvironment(pendingEnvironmentId);
        }
      });
    }
    pendingReconcileEnvironmentIds.add(environmentId);
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
      if (entry.environmentId !== environmentId || activeThreadIds.has(entry.threadId)) continue;
      if (entry.refCount === 0) {
        disposeByKey(key);
        continue;
      }
      // Still retained (a draft before its first send): detach and wait for the
      // shell to list the thread, so its creation still starts the stream.
      historyPagination.invalidate({ environmentId, threadId: entry.threadId });
      entry.unsubscribe();
      entry.unsubscribe = NOOP;
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
    flushShellEvents();
    connections.delete(environmentId);
    archivedThreadShells.clearEnvironment(environmentId);
    projectionTracker.clearEnvironment(environmentId);
    shellThreadIdsByEnvironment.delete(environmentId);
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
  const retain = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    options?: ThreadDetailSubscriptionRetainOptions,
  ) => {
    const key = keyFor(environmentId, threadId);
    const existing = threadDetailSubscriptions.get(key);
    const entry = existing ?? {
      environmentId,
      threadId,
      unsubscribe: NOOP,
      unsubscribeConnectionListener: null,
      refCount: 0,
      viewCount: 0,
      viewRetains: 0,
      lastAccessedAt: input.now(),
      evictionTimeoutId: null,
      protocol: "bounded" as const,
      windowLimits: THREAD_WINDOW_LIMITS,
      estimatedRetainedBytes: 0,
      retainedRows: createRetainedThreadBytes(),
    };
    if (!existing) threadDetailSubscriptions.set(key, entry);
    clearEviction(entry);
    entry.refCount += 1;
    const view = options?.view === true;
    if (view) {
      entry.viewCount += 1;
      entry.viewRetains += 1;
      if (entry.viewCount === 1) announceHistoryRecoveryMode(entry);
    }
    // A view already open, or one opened while this retain is held, means the
    // user has looked at the thread: its release then goes to the idle cache.
    const viewedAtRetain = entry.viewCount > (view ? 1 : 0);
    const viewRetainsAtRetain = entry.viewRetains;
    entry.lastAccessedAt = input.now();
    if (!attach(entry)) watch(entry);
    if (!existing) evictToCapacity();
    let released = false;
    return (options?: ThreadDetailSubscriptionReleaseOptions) => {
      if (released) return;
      released = true;
      if (threadDetailSubscriptions.get(key) !== entry) return;
      if (view) {
        entry.viewCount = Math.max(0, entry.viewCount - 1);
        if (entry.viewCount === 0) announceHistoryRecoveryMode(entry);
      }
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastAccessedAt = input.now();
      if (entry.refCount === 0) {
        if (
          options?.immediately === true &&
          !viewedAtRetain &&
          entry.viewRetains === viewRetainsAtRetain &&
          shouldEvict(entry)
        ) {
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
    connect: (isCancelled: () => boolean, signal: AbortSignal) => Promise<EnvironmentConnection>,
  ) => {
    const existing = read(record.environmentId);
    if (existing) return Promise.resolve(existing);
    const pending = pendingSavedEnvironmentConnections.get(record.environmentId);
    if (pending) return pending.promise;

    const controller = new AbortController();
    let rejectWaiters: (error: Error) => void = NOOP;
    const abandoned = new Promise<never>((_resolve, reject) => {
      rejectWaiters = reject;
    });
    const state = { cancelled: false, abandonedWith: null as Error | null };
    const attempt = Promise.resolve().then(async () => {
      let connection: EnvironmentConnection;
      try {
        connection = await connect(() => state.cancelled, controller.signal);
      } catch (error) {
        if (state.abandonedWith !== null) throw state.abandonedWith;
        // A cancelled attempt's failure is not the environment's: a disconnect
        // or a new pairing replaced it, and that owner reports the outcome.
        if (state.cancelled && !(error instanceof SavedEnvironmentConnectionCancelledError)) {
          throw new SavedEnvironmentConnectionCancelledError(record.environmentId, {
            cause: error,
          });
        }
        throw error;
      }
      if (state.cancelled) {
        const removed = await remove(connection.environmentId).catch(() => false);
        if (!removed) await connection.dispose().catch(NOOP);
        throw (
          state.abandonedWith ?? new SavedEnvironmentConnectionCancelledError(record.environmentId)
        );
      }
      return connection;
    });
    const pendingEntry: PendingSavedEnvironmentConnection = {
      abandon: (error) => {
        state.cancelled = true;
        if (error !== undefined) {
          state.abandonedWith = error;
          rejectWaiters(error);
        }
        controller.abort();
      },
      // An abandoned attempt rejects its waiters at once; the attempt itself
      // winds down (and disposes what it built) whenever it notices.
      promise: Promise.race([attempt, abandoned]),
    };
    pendingSavedEnvironmentConnections.set(record.environmentId, pendingEntry);
    return pendingEntry.promise.finally(() => {
      if (pendingSavedEnvironmentConnections.get(record.environmentId) === pendingEntry) {
        pendingSavedEnvironmentConnections.delete(record.environmentId);
      }
    });
  };
  /**
   * Gives up the environment's pending attempt: it is cancelled, its in-flight
   * requests are aborted, and the next connect starts fresh instead of joining
   * it. With `error`, everyone waiting on the attempt receives that error.
   */
  const abandonPendingSavedEnvironmentConnection = (
    environmentId: EnvironmentId,
    error?: Error,
    /** Only this attempt: one that has since replaced it is left alone. */
    expected?: PendingSavedEnvironmentConnection,
  ) => {
    const pending = pendingSavedEnvironmentConnections.get(environmentId);
    if (!pending || (expected !== undefined && pending !== expected)) return;
    pendingSavedEnvironmentConnections.delete(environmentId);
    pending.abandon(error);
  };
  const cancelPendingSavedEnvironmentConnection = (environmentId: EnvironmentId) =>
    abandonPendingSavedEnvironmentConnection(environmentId);
  const connectWithinSlot = (
    environmentId: EnvironmentId,
    connecting: Promise<EnvironmentConnection>,
  ): Promise<EnvironmentConnection> =>
    new Promise((resolve, reject) => {
      // The attempt `connecting` started or joined. A disconnect or a new
      // pairing may replace it meanwhile; the slot never gives up that one.
      const attempt = pendingSavedEnvironmentConnections.get(environmentId);
      const timeoutId = input.setTimeout(() => {
        // A connect this late is hung (a half-open socket after sleep, an
        // unanswered request): give the attempt up and abort what it has in
        // flight, so the retry and the next Connect start fresh rather than
        // joining it. Whoever joined it receives the same timeout.
        const error = new Error(`Saved environment ${environmentId} did not connect in time.`);
        if (attempt !== undefined) {
          abandonPendingSavedEnvironmentConnection(environmentId, error, attempt);
        }
        reject(error);
      }, SAVED_ENVIRONMENT_CONNECT_TIMEOUT_MS);
      connecting.then(
        (connection) => {
          input.clearTimeout(timeoutId);
          resolve(connection);
        },
        (error: unknown) => {
          input.clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  /**
   * Applies one environment's buffered shell items: the events the projection
   * does not hold yet, and every priority ranking, land in one store commit;
   * the after-hooks then run per event against the applied state.
   */
  const applyShellBatch = (
    environmentId: EnvironmentId,
    updates: ReadonlyArray<ShellStoreUpdate>,
  ) => {
    const accepted: ShellStoreUpdate[] = [];
    for (const update of updates) {
      if (update.kind !== "thread-priorities") {
        if (
          !shouldApplyProjectionEvent({
            current: projectionTracker.read(environmentId),
            sequence: update.sequence,
          })
        ) {
          continue;
        }
        projectionTracker.markEvent(environmentId, update.sequence);
      }
      accepted.push(update);
    }
    if (accepted.length === 0) return;
    const contexts = input.stateSink.applyShellEvents(environmentId, accepted);
    for (let index = 0; index < accepted.length; index += 1) {
      const event = accepted[index]!;
      if (event.kind === "thread-priorities") continue;
      input.stateSink.afterShellEventApplied(environmentId, event, contexts[index]);
      const shellThreadIds = shellThreadIdsByEnvironment.get(environmentId);
      if (shellThreadIds === undefined) continue;
      if (event.kind === "thread-removed") {
        shellThreadIds.delete(event.threadId);
      } else if (event.kind === "thread-upserted" && !shellThreadIds.has(event.thread.id)) {
        // A draft's first send created the thread: start what was retained for it.
        shellThreadIds.add(event.thread.id);
        attachListedThreads(environmentId);
      }
    }
  };
  // Shell items arrive one WebSocket chunk at a time (a thread upsert per
  // streaming tick). They wait for the next frame and land as one store commit
  // per environment. The batcher is a store mutation barrier, so any other
  // store write applies them first; snapshots, resets and resume reads flush
  // them explicitly, since those consult the projection tracker first.
  const shellBatcher = createEnvironmentEventBatcher<ShellStoreUpdate>({
    apply: applyShellBatch,
    ...(input.scheduleShellFrame === undefined ? {} : { scheduleFrame: input.scheduleShellFrame }),
  });
  const flushShellEvents = () => shellBatcher.flush();
  const applyShellEvent = (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) =>
    shellBatcher.enqueue(environmentId, event);
  const applyThreadPriorities = (
    item: OrchestrationShellThreadPrioritiesItem,
    environmentId: EnvironmentId,
  ) => shellBatcher.enqueue(environmentId, item);
  const syncShellSnapshot = (
    snapshot: OrchestrationStubbedShellSnapshot,
    environmentId: EnvironmentId,
    callbacks?: {
      readonly onCurrent: () => void;
      readonly onReady: () => void;
    },
  ) => {
    // Items buffered before the snapshot apply first, against the old baseline.
    flushShellEvents();
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
    const shellThreadIds = [
      ...snapshot.threads.map((thread) => thread.id),
      ...(snapshot.archivedThreadStubs ?? []).map((stub) => stub.id),
    ];
    shellThreadIdsByEnvironment.set(environmentId, new Set(shellThreadIds));
    reconcileSubscriptionsForEnvironment(environmentId, shellThreadIds);
    attachListedThreads(environmentId);
    // A thread held open whose stub no longer matches what the store had is a
    // stub again: load its full shell anew.
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.environmentId === environmentId && entry.refCount > 0) {
        archivedThreadShells.ensureFullShell(environmentId, entry.threadId);
      }
    }
    reconcileForEnvironment(environmentId);
    input.stateSink.reconcileSnapshotDerivedState();
  };
  const syncSaved = async () => {
    const records = input.listSavedEnvironmentRecords();
    const expected = new Set(records.map((record) => record.environmentId));
    // Desktop's Hub relay connections register as `saved` without a registry
    // record. A registry write must not drop them: they are owned by main's
    // workspace demand, not by this sync.
    const stale = [...connections.values()]
      .filter(
        (connection) =>
          connection.kind === "saved" && connection.knownEnvironment.source !== "hub-hosted",
      )
      .map((connection) => connection.environmentId)
      .filter((environmentId) => !expected.has(environmentId));
    await Promise.all(
      stale.map((environmentId) => input.disconnectSavedEnvironment(environmentId)),
    );
    await input.waitForPrimaryShellSnapshotApplied(SAVED_ENVIRONMENT_STARTUP_DELAY_MS);
    const awaitingRepair = (environmentId: EnvironmentId) =>
      input.isSavedEnvironmentAwaitingRepair?.(environmentId) === true;
    for (const environmentId of savedRetries.keys()) {
      if (!expected.has(environmentId) || awaitingRepair(environmentId)) {
        clearSavedRetry(environmentId);
      }
    }
    const connectable = records.filter((record) => !awaitingRepair(record.environmentId));
    await runSavedEnvironmentConnectionQueue(orderSavedEnvironmentConnectionQueue(connectable), {
      concurrency: SAVED_ENVIRONMENT_CONNECT_CONCURRENCY,
      connect: async (record) => {
        try {
          await connectWithinSlot(
            record.environmentId,
            ensureSavedEnvironmentConnection(record, (isCancelled, signal) =>
              input.connectSavedEnvironment(record, isCancelled, signal),
            ),
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
    flushShellEvents();
    stopActive();
    lastBrowserResumeReconnectAt = Number.NEGATIVE_INFINITY;
    for (const key of threadDetailSubscriptions.keys()) disposeByKey(key);
    await Promise.all([...connections.keys()].map((environmentId) => remove(environmentId)));
    // Deleting the visited entry while iterating a Map is well defined.
    for (const environmentId of pendingSavedEnvironmentConnections.keys()) {
      abandonPendingSavedEnvironmentConnection(environmentId);
    }
    projectionTracker.clear();
    shellThreadIdsByEnvironment.clear();
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
    applyThreadPriorities,
    flushShellEvents,
    resetShellProjection: (environmentId) => {
      // What the old subscription delivered applies before its baseline goes.
      flushShellEvents();
      projectionTracker.clearEnvironment(environmentId);
    },
    readShellProjectionSequence: (environmentId) => {
      flushShellEvents();
      return projectionTracker.read(environmentId)?.sequence ?? null;
    },
    syncShellSnapshot,
    retainThreadDetailSubscription: retain,
    disposeThreadDetailSubscriptionsForEnvironment: disposeForEnvironment,
    disposeThreadDetailSubscription: (environmentId, threadId) =>
      disposeByKey(keyFor(environmentId, threadId)),
    reconcileThreadDetailSubscriptionEvictionForEnvironment: scheduleReconcileForEnvironment,
    reconcileThreadDetailSubscriptionEvictionForThread: reconcileForThread,
    reconcileThreadDetailSubscriptionsForEnvironment: reconcileSubscriptionsForEnvironment,
    evictIdleThreadDetailSubscriptionsToCapacity: evictToCapacity,
    ensureArchivedThreadShells: (environmentId, threadIds) => {
      for (const threadId of threadIds) {
        archivedThreadShells.ensureFullShell(environmentId, threadId);
      }
    },
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
