import type {
  EnvironmentId,
  MessageId,
  OrchestrationStubbedShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationThreadHistoryCollection,
  OrchestrationThreadHistoryLimits,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadHistoryPageInfo,
  OrchestrationThreadWindowSnapshot,
  OrchestrationWireEvent,
  ScopedThreadRef,
  ThreadId,
} from "@ryco/contracts";

import { skipNewerNodeContent } from "../rpc/newerNodeState.ts";
import {
  isResponseTooLargeError,
  isUnsupportedRpcError,
  type SubscriptionFailureKind,
} from "../rpc/wsTransport.ts";
import { recordEnvironmentShellSettlementPolicy } from "../rpc/environmentServerConfigs.ts";
import { scopedThreadKey, scopeThreadRef } from "../scoped.ts";
import { createEnvironmentEventBatcher } from "../state/threads/eventBatching.ts";
import {
  planThreadBodyResidency,
  THREAD_BODY_RECENT_ACCESS_MS,
  THREAD_BODY_RESIDENCY_BACKSTOP_MS,
  type ThreadBodyResidencyEntry,
  type ThreadBodyUsage,
} from "../state/threads/threadBodyResidency.ts";
import { isSavedEnvironmentSwitchedOff } from "./catalog.ts";
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
import { expandSlimThreadEvent } from "./slimThreadEvent.ts";
import { createThreadHistoryPaginationController } from "./threadHistoryPagination.ts";
import { jitterRetryDelayMs } from "../rpc/retryJitter.ts";

const NOOP = () => undefined;
/** A shell event of a kind a newer node added, queued in order with the rest. */
const SKIPPED_SHELL_EVENT = Symbol("skipped-shell-event");
interface SkippedShellEvent {
  readonly kind: typeof SKIPPED_SHELL_EVENT;
  readonly sequence: number;
}
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
/**
 * After a first window smaller than {@link THREAD_WINDOW_LIMITS}
 * (`threadWindowInitialLimits`), the rest of the usual window is read as
 * history pages this long after the window arrived, while a view still shows
 * the thread.
 */
const THREAD_WINDOW_BACKFILL_DELAY_MS = 750;
const THREAD_WINDOW_BACKFILL_COLLECTIONS = ["messages", "activities"] as const;
/** Backoff for re-requesting a window the server failed to load (not a size or support failure). */
const THREAD_WINDOW_RETRY_BASE_MS = 1_000;
const THREAD_WINDOW_RETRY_MAX_MS = 30_000;
/**
 * How long a thread on a Hub relay waits for its session to accept a fresh
 * thread list before it resumes. Past it the thread loads a fresh window, as
 * it did before relays resumed.
 */
export const THREAD_RESUME_SESSION_WAIT_MS = 20_000;
const BROWSER_RESUME_RECONNECT_COOLDOWN_MS = 2_000;
/**
 * A page or window that comes back into view does not reconnect a socket only because its last
 * pong is old. While hidden, the RPC pinger ran about once a minute (Chrome's intensive timer
 * throttling), so the pong is always old there, yet the socket is alive: Effect 4.0.5 sends a
 * ping on a late tick before it can declare silence. The pinger's first visible tick (every 8 s)
 * pings, so a socket that answered nothing within this window after the page came back, and did
 * not reconnect by itself meanwhile, is reconnected. A connection with no answer for
 * {@link VIEW_RESUME_SILENT_MS} is reconnected at once: hidden, it still pings about once a
 * minute, so that long a silence means the machine slept or the page was frozen. Waking from
 * sleep where it is signalled (desktop, phone), a page restored from the back/forward cache,
 * coming online and network changes reconnect at once, as before.
 */
export const VIEW_RESUME_HEARTBEAT_GRACE_MS = 12_000;
export const VIEW_RESUME_SILENT_MS = 3 * 60_000;
const VIEW_RESUME_REASONS: ReadonlySet<string> = new Set(["visibilitychange", "pageshow"]);
const SAVED_ENVIRONMENT_STARTUP_DELAY_MS = 2500;
/**
 * How many saved environments connect at once unless the platform says
 * otherwise (`savedEnvironmentConnectConcurrency`).
 */
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
  /**
   * Every saved machine, switched off ones included: a record whose
   * `disabledAt` is set is left unconnected by every path here
   * (`isSavedEnvironmentSwitchedOff`).
   */
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
  /**
   * How many saved environments may connect at once; two when absent. Each
   * connect holds its slot until it lands or fails, so with two slots two
   * machines that are asleep keep a reachable third waiting behind them. A
   * client whose saved machines are its whole workspace asks for more.
   */
  readonly savedEnvironmentConnectConcurrency?: number;
  /**
   * Machines the user is looking at besides those of the threads a view has
   * open (the supervisor knows those): the active environment, say. They
   * connect before the other saved machines, ahead of any still queued.
   */
  readonly readPriorityEnvironmentIds?: () => Iterable<EnvironmentId>;
  readonly subscribeBrowserResume: (listener: (reason: string) => void) => () => void;
  /**
   * The device stayed online but moved to another network path (the platform's
   * `network-changed`). Optional: a platform that cannot tell paths apart omits it.
   */
  readonly subscribeNetworkChange?: (listener: () => void) => () => void;
  readonly isThreadDetailSubscriptionNonIdle: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => boolean;
  /**
   * Bounded retention of the thread bodies the store holds. Once a thread
   * subscription is disposed, a thread snapshot or history page lands, or the
   * idle sweep runs, bodies past the thread and byte budgets are dropped, least
   * recently accessed first. A store left over budget is checked again when the
   * recency of a body it keeps lapses, and at least once a minute.
   * `listThreadBodies` names the bodies the store holds and `evictThreadBodies`
   * drops them; without both nothing is dropped. A retained or busy thread, one
   * holding messages that arrived before its shell, and one for which
   * `isThreadBodyProtected` answers true (queued sends, an unsent draft), keeps
   * its body.
   */
  readonly listThreadBodies?: () => ReadonlyArray<ThreadBodyUsage>;
  readonly evictThreadBodies?: (threadRefs: ReadonlyArray<ScopedThreadRef>) => void;
  readonly isThreadBodyProtected?: (threadRef: ScopedThreadRef) => boolean;
  /**
   * Whether the store holds a body of the thread that a resume may extend: one
   * this supervisor's subscriptions delivered (`holdsLiveThreadBody`), or one
   * the platform restored from its own saved copy of a thread window (see
   * `readRestoredThreadSequence`), never one a display cache filled in. With
   * it, a thread's resume point outlives its subscription: reopening the
   * thread, or a connection registering again, resumes after the last event
   * the body holds instead of loading the window again. Without it a resume
   * point lives only as long as one attached subscription.
   */
  readonly holdsThreadBody?: (threadRef: ScopedThreadRef) => boolean;
  /**
   * The sequence a body the platform restored from its own saved copy is
   * current to, for a thread this supervisor holds no resume point for. Only
   * a complete thread window may answer (messages, activities, plans and
   * checkpoints as the window delivered them, saved with
   * `readThreadDetailSequence`); a display-only copy answers null and is
   * reloaded.
   */
  readonly readRestoredThreadSequence?: (threadRef: ScopedThreadRef) => number | null;
  readonly syncThreadDetailSnapshot: (environmentId: EnvironmentId, snapshot: unknown) => void;
  /**
   * Ask windows and history pages for bounded activity previews. Only a client
   * that fetches full payloads on demand (`orchestration.getActivityPayload`)
   * may set it; servers without previews ignore it.
   */
  readonly threadWindowActivityPayloads?: "preview";
  /**
   * Ask windows and history pages to send very long finished messages as
   * previews (`OrchestrationMessage.textPreview`). Only a client that reads the
   * whole text on demand (`orchestration.getMessageText`) may set it; servers
   * without previews ignore it.
   */
  readonly threadWindowMessageText?: "preview";
  /**
   * The first window a thread subscription asks for, sized to the screen (a
   * phone shows far fewer rows than {@link THREAD_WINDOW_LIMITS}). While a view
   * shows the thread, the rest of the usual window follows as history pages.
   */
  readonly threadWindowInitialLimits?: OrchestrationThreadHistoryLimits;
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

/**
 * The user switched the saved machine off. A cancellation like any other: the
 * retry ladder stops and nothing reports it as a connection failure. Every
 * connect path rejects with it until the machine is switched on again.
 */
export class SavedEnvironmentSwitchedOffError extends SavedEnvironmentConnectionCancelledError {
  constructor(environmentId: EnvironmentId) {
    super(environmentId);
    this.message = `Saved environment ${environmentId} is switched off.`;
    this.name = "SavedEnvironmentSwitchedOffError";
  }
}

/** Spread per client (`jitterRetryDelayMs`), so the clients of a machine that restarts do not retry together. */
export function savedEnvironmentRetryDelayMs(failedAttempts: number): number {
  const exponent = Math.max(0, Math.min(failedAttempts - 1, 8));
  return jitterRetryDelayMs(
    Math.min(SAVED_ENVIRONMENT_RETRY_BASE_MS * 2 ** exponent, SAVED_ENVIRONMENT_RETRY_MAX_MS),
    exponent,
    "saved-environment-retry",
  );
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
  /**
   * Every retain this entry has had was speculative (a navigation intent), so
   * the body it fetched has no recency of its own.
   */
  speculativeOnly: boolean;
  /**
   * When the entry became a candidate for idle eviction, or null while it is
   * retained or busy. The supervisor's one sweep disposes it once the idle
   * window has passed.
   */
  idleSince: number | null;
  protocol: "bounded" | "legacy";
  /**
   * The last sequence the store's body of this thread holds: the snapshot's,
   * then each event applied on top. A replacement subscription (a reconnect, a
   * connection registering again) resumes after it; `null` asks for a fresh
   * window.
   */
  appliedSequence: number | null;
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

/** What the residency pass knows of a thread body's use, from its subscription. */
type ThreadBodyAccess = Pick<
  ThreadDetailSubscriptionEntry,
  "lastAccessedAt" | "speculativeOnly" | "estimatedRetainedBytes"
>;

/**
 * A body the store keeps after its subscription went: how it was used, and
 * where a subscription that opens it again resumes.
 */
type DepartedThreadBody = ThreadBodyAccess &
  Pick<ThreadDetailSubscriptionEntry, "appliedSequence" | "retainedRows">;

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
  /**
   * The retain is a navigation intent (a hover or a press) that may never lead
   * to a view. A body only such retains fetched, and no other retain held,
   * ranks for eviction like one no subscription delivered once the intents let
   * go.
   */
  readonly speculative?: boolean | undefined;
}

export type ReleaseThreadDetailSubscription = (
  options?: ThreadDetailSubscriptionReleaseOptions,
) => void;

/**
 * What the shell stream just committed to the store: a snapshot that replaced
 * the environment's shell, or one batch's accepted events in order (rankings
 * and kinds a newer node added are left out).
 */
export type ShellAcceptance =
  | { readonly kind: "snapshot"; readonly environmentId: EnvironmentId }
  | {
      readonly kind: "events";
      readonly environmentId: EnvironmentId;
      readonly events: ReadonlyArray<OrchestrationShellStreamEvent>;
    };

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
  /**
   * Buffers a shell event of a kind a newer node added, at `sequence`: nothing
   * is applied, but the shell's sequence moves past it in order with the
   * events around it, so a resume does not replay it.
   */
  readonly skipShellEvent: (sequence: number, environmentId: EnvironmentId) => void;
  /** Commits buffered shell items now (tests, teardown). */
  readonly flushShellEvents: () => void;
  readonly resetShellProjection: (environmentId: EnvironmentId) => void;
  /**
   * The last shell sequence applied for an environment, for resuming its
   * subscription; `null` once the store no longer holds that shell as live
   * (`EnvironmentStateSink.isEnvironmentShellLive`).
   */
  readonly readShellProjectionSequence: (environmentId: EnvironmentId) => number | null;
  /**
   * The sequence the store's body of a thread is current to, while this
   * supervisor holds a resume point for it; for a platform that saves thread
   * windows and resumes from them (`readRestoredThreadSequence`).
   */
  readonly readThreadDetailSequence: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => number | null;
  readonly syncShellSnapshot: (
    snapshot: OrchestrationStubbedShellSnapshot,
    environmentId: EnvironmentId,
    callbacks?: {
      readonly onCurrent: () => void;
      readonly onReady: () => void;
    },
  ) => void;
  /**
   * Observes what the shell stream commits, once the store holds it and its
   * after-hooks ran. A listener can run inside a store mutation barrier, so it
   * must not reach the user synchronously.
   */
  readonly subscribeShellAcceptance: (
    listener: (acceptance: ShellAcceptance) => void,
  ) => () => void;
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
    readonly disabledAt?: string | undefined;
  },
>(input: EnvironmentSupervisorInput<SavedEnvironmentRecord>): EnvironmentConnectionSupervisor {
  const connections = new Map<EnvironmentId, EnvironmentConnection>();
  const pendingSavedEnvironmentConnections = new Map<
    EnvironmentId,
    PendingSavedEnvironmentConnection
  >();
  const listeners = new Set<() => void>();
  const shellAcceptanceListeners = new Set<(acceptance: ShellAcceptance) => void>();
  const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
  // When, and how large, the thread bodies of disposed subscriptions were last
  // used. The store keeps those bodies after the subscription goes; this is
  // what ranks them for the residency pass until they are dropped.
  const departedThreadBodies = new Map<string, DepartedThreadBody>();
  const residencyConfigured =
    input.listThreadBodies !== undefined && input.evictThreadBodies !== undefined;
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
  let viewResumeCheckTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastNetworkChangeReconnectAt = Number.NEGATIVE_INFINITY;
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
  const emitShellAcceptance = (acceptance: ShellAcceptance) => {
    // Listeners run inside shell application: one failing must not stop it.
    for (const listener of Array.from(shellAcceptanceListeners)) {
      try {
        listener(acceptance);
      } catch (error) {
        console.warn("Shell acceptance listener failed", {
          environmentId: acceptance.environmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const keyFor = (environmentId: EnvironmentId, threadId: ThreadId) =>
    scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const setRetainedBytes = (entry: ThreadDetailSubscriptionEntry, bytes: number) => {
    entry.estimatedRetainedBytes = Math.min(MAX_CACHED_THREAD_DETAIL_ESTIMATED_BYTES, bytes);
  };
  const recordRetainedSnapshot = (entry: ThreadDetailSubscriptionEntry, snapshot: unknown) => {
    entry.retainedRows.recordSnapshot(snapshot);
    setRetainedBytes(entry, entry.retainedRows.bytes());
    // A snapshot is what adds a thread's body to the store.
    scheduleResidencyPass();
  };
  const recordRetainedEvent = (entry: ThreadDetailSubscriptionEntry, event: unknown) => {
    entry.retainedRows.recordEvent(event);
    setRetainedBytes(entry, entry.retainedRows.bytes());
  };
  const recordRetainedHistoryPage = (entry: ThreadDetailSubscriptionEntry, page: unknown) => {
    entry.retainedRows.recordHistoryPage(page);
    setRetainedBytes(entry, entry.retainedRows.bytes());
    // A page grows the thread's body in the store.
    scheduleResidencyPass();
  };
  const shouldEvict = (entry: ThreadDetailSubscriptionEntry) =>
    entry.refCount === 0 &&
    !input.isThreadDetailSubscriptionNonIdle(entry.environmentId, entry.threadId);
  // One timer serves every cached thread: it is armed for the earliest idle
  // deadline and re-armed after each sweep, so an event chunk that reconciles a
  // whole environment never touches a timer per entry.
  let sweepTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let sweepDeadline: number | null = null;
  let sweeping = false;
  const armEvictionSweep = () => {
    if (sweeping) return;
    let earliest: number | null = null;
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.idleSince === null) continue;
      const deadline = entry.idleSince + THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS;
      if (earliest === null || deadline < earliest) earliest = deadline;
    }
    if (earliest === sweepDeadline) return;
    if (sweepTimeoutId !== null) input.clearTimeout(sweepTimeoutId);
    sweepTimeoutId = null;
    sweepDeadline = earliest;
    if (earliest === null) return;
    sweepTimeoutId = input.setTimeout(sweepIdleEntries, Math.max(0, earliest - input.now()));
  };
  const sweepIdleEntries = () => {
    sweepTimeoutId = null;
    sweepDeadline = null;
    const now = input.now();
    sweeping = true;
    try {
      for (const [key, entry] of threadDetailSubscriptions) {
        if (entry.idleSince === null) continue;
        if (entry.idleSince + THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS > now) continue;
        if (shouldEvict(entry)) disposeByKey(key);
        // Busy again since it was marked: it has no window until reconciled.
        else entry.idleSince = null;
      }
    } finally {
      sweeping = false;
    }
    armEvictionSweep();
    // Bodies can enter the store without a subscription (read-cache hydration),
    // so the sweep checks the store's budget whether or not it disposed anything.
    scheduleResidencyPass();
  };
  /** The entry is retained again (or gone): it is no longer an eviction candidate. */
  const clearEviction = (entry: ThreadDetailSubscriptionEntry) => {
    entry.idleSince = null;
    armEvictionSweep();
  };

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
  const messageText = input.threadWindowMessageText;
  const activityPayloadsRequest = {
    ...(activityPayloads !== undefined ? { activityPayloads } : {}),
    ...(messageText !== undefined ? { messageText } : {}),
  };
  // A client that reads previews on demand takes live tool output as previews too.
  // Live events in the slim form (no ids or metadata the client never reads);
  // an older server ignores the field and sends full events.
  const windowSubscriptionPayloads = {
    ...activityPayloadsRequest,
    ...(activityPayloads === "preview" ? { liveActivityPayloads: activityPayloads } : {}),
    liveEventForm: "slim" as const,
  };
  const historyPagination = createThreadHistoryPaginationController({
    request: (environmentId, request) => {
      const query = require(environmentId).client.orchestration.getThreadHistoryPage;
      return query
        ? query(
            request.collection === "activities" && activityPayloads !== undefined
              ? { ...request, activityPayloads }
              : request.collection === "messages" &&
                  messageText !== undefined &&
                  request.mode.kind !== "around"
                ? { ...request, messageText }
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

  /**
   * A window smaller than the usual one (a screen-sized first window, or one
   * shrunk to fit the connection) is completed with history pages in the
   * background while a view shows the thread, so scrolling up finds the usual
   * window's rows already there.
   */
  const scheduleWindowBackfill = (
    entry: ThreadDetailSubscriptionEntry,
    snapshot: OrchestrationThreadWindowSnapshot,
  ) => {
    const pages = THREAD_WINDOW_BACKFILL_COLLECTIONS.flatMap((collection) => {
      const missing = THREAD_WINDOW_LIMITS[collection] - entry.windowLimits[collection];
      const page = snapshot.history[collection];
      return missing > 0 && page.hasMoreBefore ? [{ collection, page, limit: missing }] : [];
    });
    if (pages.length === 0) return;
    input.setTimeout(() => {
      const current = threadDetailSubscriptions.get(keyFor(entry.environmentId, entry.threadId));
      if (current !== entry || entry.viewCount === 0) return;
      const scope = { environmentId: entry.environmentId, threadId: entry.threadId };
      for (const { collection, page, limit } of pages) {
        // A newer snapshot or a failed read only skips the backfill; scrolling still pages.
        historyPagination.loadBefore({ scope, collection, page, limit }).catch(NOOP);
      }
    }, THREAD_WINDOW_BACKFILL_DELAY_MS);
  };

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
  /** Whether the store still holds the body the entry's resume point belongs to. */
  const holdsResumableBody = (entry: ThreadDetailSubscriptionEntry) =>
    input.holdsThreadBody === undefined ||
    input.holdsThreadBody(scopeThreadRef(entry.environmentId, entry.threadId));
  /**
   * Resolves true once the connection's session is current, false when it is
   * not within {@link THREAD_RESUME_SESSION_WAIT_MS} or the wait is given up.
   */
  const waitForSessionReadiness = (connection: EnvironmentConnection, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = NOOP;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const settle = (ready: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timeoutId !== null) input.clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
        resolve(ready);
      };
      const onAbort = () => settle(false);
      if (signal.aborted) {
        settle(false);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      unsubscribe = connection.sessionReadiness.subscribe(() => {
        if (connection.sessionReadiness.read()) settle(true);
      });
      timeoutId = input.setTimeout(() => settle(false), THREAD_RESUME_SESSION_WAIT_MS);
      if (connection.sessionReadiness.read()) settle(true);
    });
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
    // A platform that cannot tell whether the store still holds the body this
    // resume point belongs to resumes only within one attached subscription.
    if (input.holdsThreadBody === undefined) entry.appliedSequence = null;
    // A replacement subscription resumes after the body's last sequence. On a
    // Hub relay (hosted mode, or a Hub-hosted machine) it first waits until
    // this connection's session has accepted a fresh thread list of its own
    // current attempt and generation (`sessionReadiness`), so a resume never
    // rests on a list a lost channel or a replaced generation delivered.
    const resumeWaitsForSession =
      input.isHostedMode() || connection.knownEnvironment.source === "hub-hosted";
    const resumeFromSequence = (signal: AbortSignal): number | null | Promise<number | null> => {
      const sequence = entry.appliedSequence;
      if (sequence === null) return null;
      if (!holdsResumableBody(entry)) {
        entry.appliedSequence = null;
        return null;
      }
      if (!resumeWaitsForSession || connection.sessionReadiness.read()) return sequence;
      return waitForSessionReadiness(connection, signal).then((ready) =>
        ready && active && read(entry.environmentId) === connection && holdsResumableBody(entry)
          ? entry.appliedSequence
          : null,
      );
    };
    const subscriptionOptions = {
      resumeFromSequence,
      historyRecovery: () => historyRecoveryMode(entry),
    };
    const applyEvent = (event: OrchestrationWireEvent) => {
      entry.appliedSequence = Math.max(entry.appliedSequence ?? 0, event.sequence);
      // An event type a newer node added: skipped, but a resume starts after it.
      if (skipNewerNodeContent(entry.environmentId, event)) return;
      recordRetainedEvent(entry, event);
      scheduleEvictToCapacity();
      input.applyThreadDetailEvent(entry.environmentId, event);
    };
    const subscribeLegacy = (fallback: boolean) => {
      if (!active) return;
      entry.protocol = "legacy";
      unsubscribeCurrent();
      // A server without bounded windows: start over from its own snapshot.
      if (fallback) entry.appliedSequence = null;
      unsubscribeCurrent = connection.client.orchestration.subscribeThread(
        { threadId: entry.threadId },
        (item) => {
          if (skipNewerNodeContent(entry.environmentId, item) || item.kind === "resumed") return;
          if (item.kind === "snapshot") {
            entry.appliedSequence = item.snapshot.snapshotSequence;
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
      subscribeLegacy(entry.protocol !== "legacy");
      return true;
    }
    // A failure can arrive synchronously, before the subscription below has
    // returned its unsubscribe; it is handled once that has happened.
    let pendingFailure: { readonly kind: SubscriptionFailureKind | undefined } | null = null;
    let subscribing = false;
    const handleWindowFailure = (kind: SubscriptionFailureKind | undefined) => {
      if (!active) return;
      if (kind === "unsupported") {
        subscribeLegacy(true);
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
      const delayMs = jitterRetryDelayMs(
        Math.min(
          THREAD_WINDOW_RETRY_BASE_MS * 2 ** Math.min(failedWindowAttempts - 1, 8),
          THREAD_WINDOW_RETRY_MAX_MS,
        ),
        failedWindowAttempts,
        "thread-window-retry",
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
        { threadId: entry.threadId, limits: entry.windowLimits, ...windowSubscriptionPayloads },
        (item) => {
          // Any item, a resume included, means the server served this window.
          failedWindowAttempts = 0;
          if (skipNewerNodeContent(entry.environmentId, item) || item.kind === "resumed") return;
          if (item.kind === "snapshot") {
            entry.appliedSequence = item.snapshot.snapshotSequence;
            historyPagination.beginSnapshot(scope);
            recordRetainedSnapshot(entry, item.snapshot);
            evictToCapacity();
            if (input.syncThreadWindowSnapshot) {
              input.syncThreadWindowSnapshot(entry.environmentId, item.snapshot);
            } else {
              input.syncThreadDetailSnapshot(entry.environmentId, item.snapshot);
            }
            scheduleWindowBackfill(entry, item.snapshot);
            return;
          }
          applyEvent(
            item.kind === "slim-event"
              ? expandSlimThreadEvent(item.event, entry.threadId)
              : item.event,
          );
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
  /**
   * Starts what is retained for an environment, the threads the user has open
   * first and then the most recently used. Idle cached threads stay detached
   * (their rows stay in the store) until something retains them again, so a
   * connection coming back does not open a window per cached thread.
   */
  const attachListedThreads = (environmentId: EnvironmentId) => {
    const retained = [...threadDetailSubscriptions.values()].filter(
      (entry) =>
        entry.environmentId === environmentId && entry.refCount > 0 && entry.unsubscribe === NOOP,
    );
    retained.sort(
      (left, right) =>
        Number(right.viewCount > 0) - Number(left.viewCount > 0) ||
        right.lastAccessedAt - left.lastAccessedAt,
    );
    for (const entry of retained) {
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
    if (residencyConfigured) {
      departedThreadBodies.set(key, {
        lastAccessedAt: entry.lastAccessedAt,
        speculativeOnly: entry.speculativeOnly,
        estimatedRetainedBytes: entry.estimatedRetainedBytes,
        appliedSequence: entry.appliedSequence,
        retainedRows: entry.retainedRows,
      });
    }
    scheduleResidencyPass();
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
  // The store keeps the bodies of threads whose subscription is gone. After
  // disposals, snapshots and history pages (once per chunk, however many) and
  // after each idle sweep, the bodies past the store's thread and byte budgets
  // are dropped, least recently accessed first.
  let residencyPassScheduled = false;
  let residencyPassRunning = false;
  // Bumped by a reset: a pass scheduled before it must not run after it.
  let residencyEpoch = 0;
  // One timer re-checks a store a pass left over budget: when the recency of a
  // body it kept lapses, or after the backstop, whichever comes first.
  let residencyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const armResidencyTimer = (deadline: number | null) => {
    if (residencyTimeoutId !== null) input.clearTimeout(residencyTimeoutId);
    residencyTimeoutId = null;
    if (deadline === null) return;
    residencyTimeoutId = input.setTimeout(
      () => {
        residencyTimeoutId = null;
        scheduleResidencyPass();
      },
      Math.max(0, deadline - input.now()),
    );
  };
  /** How the residency pass ranks and protects one body the store holds. */
  const residencyEntryOf = ({
    ref,
    bytes,
    environmentActive,
    lastActivityAt,
    hasPendingMessages,
  }: ThreadBodyUsage): ThreadBodyResidencyEntry => {
    const key = scopedThreadKey(ref);
    const subscription = threadDetailSubscriptions.get(key);
    const access = subscription ?? departedThreadBodies.get(key);
    // A body no subscription ever delivered (cached content) has no access
    // time, and so no recency: such bodies go first, the least recently active
    // among them first. Neither has a body only a navigation intent fetched: it
    // carries no recent-access protection and goes before any body a view or
    // another owner used.
    const lastAccessedAt =
      access === undefined || access.speculativeOnly ? 0 : access.lastAccessedAt;
    return {
      ref,
      lastActivityAt,
      bytes:
        access !== undefined && access.estimatedRetainedBytes > 0
          ? access.estimatedRetainedBytes
          : bytes,
      lastAccessedAt,
      protected:
        (subscription !== undefined && subscription.refCount > 0) ||
        input.isThreadDetailSubscriptionNonIdle(ref.environmentId, ref.threadId) ||
        input.isThreadBodyProtected?.(ref) === true ||
        hasPendingMessages,
      // A thread of the active environment keeps its body for a while after
      // its last access, so returning to it renders at once.
      protectedUntil:
        environmentActive && lastAccessedAt > 0
          ? lastAccessedAt + THREAD_BODY_RECENT_ACCESS_MS
          : undefined,
    };
  };
  const runResidencyPass = () => {
    const { listThreadBodies, evictThreadBodies } = input;
    if (listThreadBodies === undefined || evictThreadBodies === undefined) return;
    const now = input.now();
    const usage = listThreadBodies();
    const heldKeys = new Set(usage.map(({ ref }) => scopedThreadKey(ref)));
    for (const key of departedThreadBodies.keys()) {
      if (!heldKeys.has(key)) departedThreadBodies.delete(key);
    }
    const plan = planThreadBodyResidency({ now, entries: usage.map(residencyEntryOf) });
    // A store left over budget is checked again, whatever kept it there: a
    // body whose recency lapses, protection that ends unseen, or bodies the
    // read cache restored without a subscription. One within budget arms
    // nothing and waits for the next disposal, snapshot, page or sweep.
    armResidencyTimer(
      plan.overBudget
        ? Math.min(
            plan.recheckAt ?? Number.POSITIVE_INFINITY,
            now + THREAD_BODY_RESIDENCY_BACKSTOP_MS,
          )
        : null,
    );
    const planned = plan.evict;
    if (planned.length === 0) return;
    // An idle cached subscription would write events into a body that is gone.
    residencyPassRunning = true;
    try {
      for (const ref of planned) disposeByKey(scopedThreadKey(ref));
    } finally {
      residencyPassRunning = false;
    }
    for (const ref of planned) departedThreadBodies.delete(scopedThreadKey(ref));
    evictThreadBodies(planned);
  };
  const scheduleResidencyPass = () => {
    if (!residencyConfigured || residencyPassScheduled || residencyPassRunning) return;
    residencyPassScheduled = true;
    const epoch = residencyEpoch;
    afterCurrentChunk(() => {
      if (epoch !== residencyEpoch) return;
      residencyPassScheduled = false;
      runResidencyPass();
    });
  };
  /**
   * Marks whether the entry is an eviction candidate. A new idle window starts
   * when the entry becomes idle, or on `restart` (the thread saw activity, or
   * its last retain was just released); an entry already idle keeps its window.
   */
  const reconcileEntry = (entry: ThreadDetailSubscriptionEntry, restart: boolean) => {
    if (!shouldEvict(entry)) {
      entry.idleSince = null;
    } else if (restart || entry.idleSince === null) {
      entry.idleSince = input.now();
    }
  };
  const reconcileForEnvironment = (environmentId: EnvironmentId) => {
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.environmentId === environmentId) reconcileEntry(entry, false);
    }
    armEvictionSweep();
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
    if (!entry) return;
    reconcileEntry(entry, true);
    armEvictionSweep();
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
      // Whatever lists it then starts from that thread's own snapshot.
      historyPagination.invalidate({ environmentId, threadId: entry.threadId });
      entry.unsubscribe();
      entry.unsubscribe = NOOP;
      entry.appliedSequence = null;
    }
  };

  const register = (connection: EnvironmentConnection) => {
    const existing = connections.get(connection.environmentId);
    if (existing === connection) return connection;
    if (existing && existing !== connection) {
      throw new Error(`Environment ${connection.environmentId} already has an active connection.`);
    }
    connections.set(connection.environmentId, connection);
    attachListedThreads(connection.environmentId);
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
    // A hosted connection's idle cached streams go now: the rows they delivered
    // stay in the store, and a retain resumes from them (`departedThreadBodies`)
    // once the connection that comes back has accepted its fresh thread list.
    const disposeIdle = input.isHostedMode() || connection.knownEnvironment.source === "hub-hosted";
    for (const [key, entry] of threadDetailSubscriptions) {
      if (entry.environmentId !== environmentId) continue;
      if (disposeIdle && entry.refCount === 0) {
        disposeByKey(key);
        continue;
      }
      entry.unsubscribe();
      entry.unsubscribe = NOOP;
      watch(entry);
    }
    await connection.dispose();
    return true;
  };
  /**
   * Where a new subscription of a thread whose body the store holds resumes:
   * after the last sequence of the subscription that delivered it, or of the
   * platform's own saved window. Null loads a fresh window.
   */
  const resumePointFor = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    departed: DepartedThreadBody | undefined,
  ): { readonly sequence: number; readonly departed: DepartedThreadBody | null } | null => {
    const ref = scopeThreadRef(environmentId, threadId);
    if (input.holdsThreadBody === undefined || !input.holdsThreadBody(ref)) return null;
    if (departed !== undefined && departed.appliedSequence !== null) {
      return { sequence: departed.appliedSequence, departed };
    }
    const restored = input.readRestoredThreadSequence?.(ref) ?? null;
    return restored === null ? null : { sequence: restored, departed: null };
  };
  const retain = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    options?: ThreadDetailSubscriptionRetainOptions,
  ) => {
    const key = keyFor(environmentId, threadId);
    const existing = threadDetailSubscriptions.get(key);
    // A body the store kept after its subscription went resumes where it stopped.
    const departed = existing === undefined ? departedThreadBodies.get(key) : undefined;
    const resumed =
      existing === undefined ? resumePointFor(environmentId, threadId, departed) : null;
    const entry = existing ?? {
      environmentId,
      threadId,
      unsubscribe: NOOP,
      unsubscribeConnectionListener: null,
      refCount: 0,
      viewCount: 0,
      viewRetains: 0,
      lastAccessedAt: input.now(),
      // A body another owner used before keeps that standing when an intent
      // fetches it again.
      speculativeOnly:
        options?.speculative === true && departedThreadBodies.get(key)?.speculativeOnly !== false,
      idleSince: null,
      protocol: "bounded" as const,
      appliedSequence: resumed?.sequence ?? null,
      windowLimits: THREAD_WINDOW_LIMITS,
      estimatedRetainedBytes: resumed?.departed?.estimatedRetainedBytes ?? 0,
      retainedRows: resumed?.departed?.retainedRows ?? createRetainedThreadBytes(),
    };
    if (!existing) threadDetailSubscriptions.set(key, entry);
    // A new subscription's first window is sized to the screen (`threadWindowInitialLimits`).
    if (!existing && input.threadWindowInitialLimits) {
      entry.windowLimits = input.threadWindowInitialLimits;
    }
    clearEviction(entry);
    entry.refCount += 1;
    const view = options?.view === true;
    if (view) {
      entry.viewCount += 1;
      entry.viewRetains += 1;
      if (entry.viewCount === 1) announceHistoryRecoveryMode(entry);
      connectViewedSavedEnvironment(environmentId);
    }
    // A view already open, or one opened while this retain is held, means the
    // user has looked at the thread: its release then goes to the idle cache.
    const viewedAtRetain = entry.viewCount > (view ? 1 : 0);
    const viewRetainsAtRetain = entry.viewRetains;
    // Any other owner gives the body a use of its own, for the entry's life.
    if (options?.speculative !== true) entry.speculativeOnly = false;
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
        reconcileEntry(entry, true);
        armEvictionSweep();
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
  /** Read from the registry now, never from a record a caller kept. */
  const isSwitchedOff = (environmentId: EnvironmentId) =>
    input
      .listSavedEnvironmentRecords()
      .some(
        (record) => record.environmentId === environmentId && isSavedEnvironmentSwitchedOff(record),
      );
  const ensureSavedEnvironmentConnection = (
    record: { readonly environmentId: EnvironmentId },
    connect: (isCancelled: () => boolean, signal: AbortSignal) => Promise<EnvironmentConnection>,
  ) => {
    // A resume, a network change, a stray Connect or a renewal never reaches a
    // machine the user switched off.
    if (isSwitchedOff(record.environmentId)) {
      return Promise.reject(new SavedEnvironmentSwitchedOffError(record.environmentId));
    }
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
        // Switched off while it connected: whatever the attempt hit on its way
        // out (the switch-off's own cancellation, a dropped tunnel), its
        // waiters learn the machine is off, not that it failed or was merely
        // cancelled.
        if (isSwitchedOff(record.environmentId)) {
          throw error instanceof SavedEnvironmentSwitchedOffError
            ? error
            : new SavedEnvironmentSwitchedOffError(record.environmentId);
        }
        // A cancelled attempt's failure is not the environment's: a disconnect
        // or a new pairing replaced it, and that owner reports the outcome.
        if (state.cancelled && !(error instanceof SavedEnvironmentConnectionCancelledError)) {
          throw new SavedEnvironmentConnectionCancelledError(record.environmentId, {
            cause: error,
          });
        }
        throw error;
      }
      // Switched off while it connected: what it opened goes at once. This
      // fallback only sees a machine that is still off when the attempt lands.
      // One switched off and on again meanwhile relies on the switch-off having
      // cancelled the attempt (`state.cancelled`): every switch path does, in
      // its session teardown (web and mobile `teardownSavedEnvironmentSession`).
      const switchedOff = isSwitchedOff(record.environmentId);
      if (state.cancelled || switchedOff) {
        const removed = await remove(connection.environmentId).catch(() => false);
        if (!removed) await connection.dispose().catch(NOOP);
        throw (
          state.abandonedWith ??
          (switchedOff
            ? new SavedEnvironmentSwitchedOffError(record.environmentId)
            : new SavedEnvironmentConnectionCancelledError(record.environmentId))
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
   * does not hold yet land in one store commit;
   * the after-hooks then run per event against the applied state.
   */
  const applyShellBatch = (
    environmentId: EnvironmentId,
    updates: ReadonlyArray<OrchestrationShellStreamEvent | SkippedShellEvent>,
  ) => {
    const accepted: OrchestrationShellStreamEvent[] = [];
    for (const update of updates) {
      if (update.kind === SKIPPED_SHELL_EVENT) {
        projectionTracker.markEvent(environmentId, update.sequence);
        continue;
      }
      if (
        !shouldApplyProjectionEvent({
          current: projectionTracker.read(environmentId),
          sequence: update.sequence,
        })
      ) {
        continue;
      }
      projectionTracker.markEvent(environmentId, update.sequence);
      accepted.push(update);
    }
    if (accepted.length === 0) return;
    const contexts = input.stateSink.applyShellEvents(environmentId, accepted);
    for (let index = 0; index < accepted.length; index += 1) {
      const event = accepted[index]!;
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
    if (shellAcceptanceListeners.size === 0) return;
    emitShellAcceptance({ kind: "events", environmentId, events: accepted });
  };
  // Shell items arrive one WebSocket chunk at a time (a thread upsert per
  // streaming tick). They wait for the next frame and land as one store commit
  // per environment. The batcher is a store mutation barrier, so any other
  // store write applies them first; snapshots, resets and resume reads flush
  // them explicitly, since those consult the projection tracker first.
  const shellBatcher = createEnvironmentEventBatcher<
    OrchestrationShellStreamEvent | SkippedShellEvent
  >({
    apply: applyShellBatch,
    ...(input.scheduleShellFrame === undefined ? {} : { scheduleFrame: input.scheduleShellFrame }),
  });
  const flushShellEvents = () => shellBatcher.flush();
  const applyShellEvent = (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) =>
    shellBatcher.enqueue(environmentId, event);
  const skipShellEvent = (sequence: number, environmentId: EnvironmentId) =>
    shellBatcher.enqueue(environmentId, { kind: SKIPPED_SHELL_EVENT, sequence });
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
    // The node's rule can change without moving the shell sequence.
    if (snapshotClassification !== "stale") {
      recordEnvironmentShellSettlementPolicy(environmentId, snapshot.settlementPolicy);
    }
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
    emitShellAcceptance({ kind: "snapshot", environmentId });
  };
  const syncSaved = async () => {
    // A switched-off machine is saved but never connected: its live connection
    // is stale and its retry stops. An attempt under way drops what it opened
    // when it lands (`ensureSavedEnvironmentConnection`).
    const records = input
      .listSavedEnvironmentRecords()
      .filter((record) => !isSavedEnvironmentSwitchedOff(record));
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
    const priority = readPriorityEnvironmentIds();
    await runSavedEnvironmentConnectionQueue(
      orderSavedEnvironmentConnectionQueue(connectable, priority),
      {
        concurrency:
          input.savedEnvironmentConnectConcurrency ?? SAVED_ENVIRONMENT_CONNECT_CONCURRENCY,
        // A thread opened while the queue runs moves its machine to the next slot.
        readPriority: readPriorityEnvironmentIds,
        connect: connectSavedRecord,
      },
    );
  };
  /** One saved machine's connect within its slot, with the retry ladder on failure. */
  const connectSavedRecord = async (record: SavedEnvironmentRecord) => {
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
  };
  /**
   * A view opened a thread of a saved machine that is neither connected nor
   * connecting: it connects now instead of waiting for a slot that machines
   * asleep may hold for up to a minute. A machine switched off or waiting to be
   * paired again is left to the user.
   */
  const connectViewedSavedEnvironment = (environmentId: EnvironmentId) => {
    if (activeService === null || input.isHostedMode()) return;
    if (read(environmentId) || pendingSavedEnvironmentConnections.has(environmentId)) return;
    if (input.isSavedEnvironmentAwaitingRepair?.(environmentId) === true) return;
    const record = input
      .listSavedEnvironmentRecords()
      .find((candidate) => candidate.environmentId === environmentId);
    if (record === undefined || isSavedEnvironmentSwitchedOff(record)) return;
    void connectSavedRecord(record);
  };
  /** The machines the user is looking at: those of threads a view has open, then the platform's. */
  const readPriorityEnvironmentIds = (): ReadonlySet<EnvironmentId> => {
    const priority = new Set<EnvironmentId>();
    for (const entry of threadDetailSubscriptions.values()) {
      if (entry.viewCount > 0) priority.add(entry.environmentId);
    }
    for (const environmentId of input.readPriorityEnvironmentIds?.() ?? []) {
      priority.add(environmentId);
    }
    return priority;
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
  // Waking or regaining the network is the moment an unreachable environment
  // most likely became reachable: try every one now rather than on the backoff
  // it had grown while the machine slept or sat on the other network.
  const retrySavedEnvironmentsNow = () => {
    if (savedRetries.size === 0) return;
    for (const retry of savedRetries.values()) {
      if (retry.timeoutId !== null) input.clearTimeout(retry.timeoutId);
      retry.timeoutId = null;
      retry.failedAttempts = 0;
    }
    requestSavedSyncForRetry?.();
  };
  const reconnectLogged = (connection: EnvironmentConnection, reason: string) => {
    void connection.reconnect().catch((error) => {
      console.warn("Environment reconnect after a wake signal failed", {
        environmentId: connection.environmentId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const cancelViewResumeCheck = () => {
    if (viewResumeCheckTimeoutId !== null) input.clearTimeout(viewResumeCheckTimeoutId);
    viewResumeCheckTimeoutId = null;
  };
  /**
   * After the page came back into view, reconnects the connections it already had that have not
   * answered a heartbeat since and did not reconnect by themselves (see
   * {@link VIEW_RESUME_HEARTBEAT_GRACE_MS}); one silent for {@link VIEW_RESUME_SILENT_MS} is
   * reconnected at once. Connections made meanwhile are left alone: their pinger has not run yet.
   */
  const checkHeartbeatsAfterViewResume = (reason: string) => {
    cancelViewResumeCheck();
    const resumedAt = input.now();
    const stale = [...connections.values()].filter(
      (connection) => !connection.client.isHeartbeatFresh(),
    );
    const resumed: EnvironmentConnection[] = [];
    for (const connection of stale) {
      if (connection.client.isHeartbeatFresh(VIEW_RESUME_SILENT_MS)) {
        resumed.push(connection);
      } else {
        lastBrowserResumeReconnectAt = resumedAt;
        reconnectLogged(connection, reason);
      }
    }
    if (resumed.length === 0) return;
    viewResumeCheckTimeoutId = input.setTimeout(() => {
      viewResumeCheckTimeoutId = null;
      for (const connection of resumed) {
        if (connections.get(connection.environmentId) !== connection) continue;
        if (connection.client.isHeartbeatFresh(VIEW_RESUME_HEARTBEAT_GRACE_MS)) continue;
        if (connection.client.hasReopenedSince?.(resumedAt) === true) continue;
        lastBrowserResumeReconnectAt = input.now();
        reconnectLogged(connection, reason);
      }
    }, VIEW_RESUME_HEARTBEAT_GRACE_MS);
  };
  const reconnectAfterResume = (reason: string) => {
    const now = input.now();
    if (now - lastBrowserResumeReconnectAt < BROWSER_RESUME_RECONNECT_COOLDOWN_MS) return;
    retrySavedEnvironmentsNow();
    if (VIEW_RESUME_REASONS.has(reason)) {
      checkHeartbeatsAfterViewResume(reason);
      return;
    }
    cancelViewResumeCheck();
    for (const connection of connections.values()) {
      if (connection.client.isHeartbeatFresh()) continue;
      lastBrowserResumeReconnectAt = now;
      reconnectLogged(connection, reason);
    }
  };
  // A new network path leaves sockets opened on the old one dead without a close,
  // and a heartbeat answered just before the move still reads as fresh for up
  // to its 16 s timeout. So every direct connection reconnects now, not only
  // the stale ones resume picks. Hub relay connections are left to their own
  // lifecycle owner.
  const reconnectAfterNetworkChange = () => {
    const now = input.now();
    if (now - lastNetworkChangeReconnectAt < BROWSER_RESUME_RECONNECT_COOLDOWN_MS) return;
    lastNetworkChangeReconnectAt = now;
    retrySavedEnvironmentsNow();
    for (const connection of connections.values()) {
      if (connection.knownEnvironment.source === "hub-hosted") continue;
      reconnectLogged(connection, "network-changed");
    }
  };
  const stopActive = () => {
    activeService?.stop();
    activeService = null;
    requestSavedSyncForRetry = null;
    clearAllSavedRetries();
    cancelViewResumeCheck();
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
    const unsubscribeNetworkChange = input.isHostedMode()
      ? NOOP
      : (input.subscribeNetworkChange?.(reconnectAfterNetworkChange) ?? NOOP);
    const service = {
      throttle,
      refCount: 1,
      stop: () => {
        unsubscribeSaved();
        unsubscribeResume();
        unsubscribeNetworkChange();
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
    lastNetworkChangeReconnectAt = Number.NEGATIVE_INFINITY;
    for (const key of threadDetailSubscriptions.keys()) disposeByKey(key);
    departedThreadBodies.clear();
    // The disposals above scheduled a pass; with no access records left it
    // would rank every body in the shared store as never accessed.
    residencyEpoch += 1;
    residencyPassScheduled = false;
    armResidencyTimer(null);
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
    skipShellEvent,
    flushShellEvents,
    resetShellProjection: (environmentId) => {
      // What the old subscription delivered applies before its baseline goes.
      flushShellEvents();
      projectionTracker.clearEnvironment(environmentId);
    },
    readShellProjectionSequence: (environmentId) => {
      flushShellEvents();
      // A shell demoted to last-known state (its sessions cleared) or replaced
      // by a cache cannot take a replay on top: it needs a fresh snapshot.
      if (input.stateSink.isEnvironmentShellLive?.(environmentId) === false) return null;
      return projectionTracker.read(environmentId)?.sequence ?? null;
    },
    readThreadDetailSequence: (environmentId, threadId) => {
      const key = keyFor(environmentId, threadId);
      const sequence =
        threadDetailSubscriptions.get(key)?.appliedSequence ??
        departedThreadBodies.get(key)?.appliedSequence ??
        null;
      return sequence !== null &&
        input.holdsThreadBody?.(scopeThreadRef(environmentId, threadId)) === true
        ? sequence
        : null;
    },
    syncShellSnapshot,
    subscribeShellAcceptance: (listener) => {
      shellAcceptanceListeners.add(listener);
      return () => {
        shellAcceptanceListeners.delete(listener);
      };
    },
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
