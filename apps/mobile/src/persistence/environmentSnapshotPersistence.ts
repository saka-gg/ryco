import { hostedHubStore, type HostedHubState } from "@ryco/client-runtime/authorization";
import { planEvictionsToCapacity } from "@ryco/client-runtime/connection";
import type { KVService } from "@ryco/client-runtime/platform";
import type { AppState, CachedEnvironmentShellSnapshot } from "@ryco/client-runtime/state/threads";
import { hydrateCachedThreadBodies } from "@ryco/client-runtime/state/threads/threadBodyCache";
import {
  MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES,
} from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import {
  encodeStoredHubNodeRoster,
  getCachedHubNodeRoster,
  reconcileHubNodeRoster,
  setCachedHubNodeRoster,
  HUB_NODE_ROSTER_SCHEMA_VERSION,
  decodeStoredHubNodeRoster,
} from "../hostedHub/nodeRoster";
import { installHubSelectionPersistence } from "../hostedHub/selectionPersistence";
import {
  isPreferencesHydrated,
  isThreadContentCacheEnabled,
  subscribePreferences,
  whenPreferencesHydrated,
} from "../state/preferencesStore";
import { useStore, type EnvironmentState } from "../state/threadsRuntime";
import {
  createEnvironmentRowSerializer,
  decodeStoredEnvironmentEnvelope,
  decodeStoredEnvironmentSnapshot,
  decodeStoredEnvironmentThread,
  decodeStoredThreadBody,
  environmentRowsFromLegacyRecord,
  type EnvironmentRows,
  type EnvironmentRowSerializer,
  type StoredEnvironmentSnapshotThread,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
} from "./environmentSnapshotCodec";
import { purgeEnvironmentDeviceData } from "./environmentDevicePurge";
import { setSavedQueryStore } from "../rpc/savedQueries";
import {
  createSavedQueryStore,
  savedQueryBytes,
  type SavedQueryStoreHandle,
} from "./savedQueryStore";
import { purgeTaskCache } from "../features/tasks/taskCacheKeys";
import {
  forgetEnvironmentSavedThreadBodies,
  forgetSavedThreadBody,
  installSavedThreadBodyLoader,
  replaceSavedThreadBodyKeys,
  setEnvironmentSavedThreadBodyKeys,
} from "./savedThreadBodies";
import { hydrateSavedServerConfigs, installServerConfigSaving } from "./serverConfigPersistence";
import { createSnapshotDb, type SnapshotDb } from "./snapshotDb";

/**
 * Orchestrates the per-environment snapshot cache: debounced capture of
 * settled projections out of the threads store, cold-start hydration back
 * into it, the persisted Hub node roster mirror (amendment A), and
 * revocation/removal invalidation. All I/O failures degrade to a cache miss
 * with a console warning — persistence must never take the live sync path
 * down with it.
 *
 * A machine is stored as rows (`snapshotDb.ts`): an envelope, one row per
 * thread, and one body per thread with saved text. A capture writes only the
 * rows that changed, in one transaction. Launch reads envelopes and thread
 * rows only; a thread's body (recent message text and its open approval or
 * question cards) is read when the thread opens (`savedThreadBodies.ts`).
 * Bodies are kept only while the "keep recent conversations" device setting
 * is on; they are display-only: live data replaces them, and they are removed
 * wherever the machine's rows are, and when the setting is turned off.
 */

/**
 * Trailing debounce on projection writes, bounded by a maximum wait. A
 * busy environment is written at most once per window rather than after every
 * short gap in its event stream; the maximum wait keeps a continuously active
 * one from never being written, and backgrounding flushes whatever is
 * pending, so the longer window costs no durability.
 */
export const SNAPSHOT_WRITE_DEBOUNCE_MS = 2_000;
export const SNAPSHOT_WRITE_MAX_WAIT_MS = 10_000;
/**
 * An environment written within the last `SNAPSHOT_BUSY_WINDOW_MS` and dirty
 * again is busy (an agent streams into it): it is written at most once per
 * `SNAPSHOT_BUSY_MAX_WAIT_MS`, after `SNAPSHOT_BUSY_DEBOUNCE_MS` of quiet. A
 * capture re-captures the streaming thread's body (up to its text limit) and
 * writes it whole, so while an agent runs this cuts that work and those bytes
 * threefold; backgrounding still flushes at once, so nothing a person saw is
 * lost when the app is suspended.
 */
export const SNAPSHOT_BUSY_WINDOW_MS = 60_000;
export const SNAPSHOT_BUSY_DEBOUNCE_MS = 5_000;
export const SNAPSHOT_BUSY_MAX_WAIT_MS = 30_000;
const ROSTER_WRITE_DEBOUNCE_MS = 1_000;
/**
 * Environments whose row fragments are kept between captures. Fragments hold
 * each thread's serialized JSON (up to the per-environment byte cap), and only
 * an environment captured again and again — one an agent is running in —
 * gains from them, so only the most recently captured few keep theirs.
 */
const MAX_RETAINED_SNAPSHOT_SERIALIZERS = 2;
/**
 * Total-across-environments bounds, enforced with the shared eviction policy
 * (count cap + byte budget, LRU) from client-runtime over each machine's
 * summed rows. Per-environment bounds are applied at capture in
 * environmentSnapshotCodec.ts.
 */
const MAX_CACHED_ENVIRONMENT_SNAPSHOTS = MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS;
const MAX_CACHED_ENVIRONMENT_SNAPSHOT_TOTAL_BYTES = MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES;

/**
 * Cold-start hydration commits decoded environments in batches of about this
 * many payload bytes, then yields. Small environments share one store commit
 * (one render) instead of one each; a large one still lands, and yields, on
 * its own, so no task decodes much more than one slice.
 */
const HYDRATION_SLICE_BYTES = 64 * 1024;

interface ThreadsStoreLike {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => {
    readonly environmentStateById: Record<string, EnvironmentState>;
    readonly hydrateEnvironmentStatesFromCache: (
      entries: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly cached: CachedEnvironmentShellSnapshot;
      }>,
      onEntryError?: (environmentId: EnvironmentId, error: unknown) => void,
    ) => void;
    readonly applyStateTransition: (transition: (state: AppState) => AppState) => void;
    readonly removeEnvironmentState: (environmentId: EnvironmentId) => void;
  };
}

interface HostedStoreLike {
  readonly getState: () => HostedHubState;
  readonly subscribe: (listener: () => void) => () => void;
}

/** The device setting that lets recent conversation text be kept on this device. */
export interface ThreadContentCacheSetting {
  /** Whether message text may be stored and shown from storage right now. */
  readonly isEnabled: () => boolean;
  /** Resolves once `isEnabled` reflects the saved choice rather than a default. */
  readonly ready?: Promise<void>;
  /** Calls `listener` whenever `isEnabled` may have changed. */
  readonly subscribe?: (listener: () => void) => () => void;
}

export interface SnapshotPersistenceDeps {
  readonly db: SnapshotDb;
  readonly store: ThreadsStoreLike;
  readonly now: () => number;
  /**
   * The dual-plane guard: an environment also present in the direct/saved
   * catalog is owned by that plane, so Hub-side revocation or removal must
   * not purge its store rows or its snapshot.
   */
  readonly hasDirectEnvironment: (environmentId: EnvironmentId) => boolean;
  /**
   * A node paired directly that the user switched off. Its stored snapshot is
   * kept for when it is switched on, but not shown while it is off.
   */
  readonly isEnvironmentSwitchedOff?: (environmentId: EnvironmentId) => boolean;
  /** App backgrounding; pending captures are flushed before the OS may suspend us. */
  readonly subscribeBackground?: (listener: () => void) => () => void;
  /**
   * Yield to the event loop between environments during cold-start hydration,
   * so decoding a large cache does not hold the JS thread in one long task.
   */
  readonly yieldToEventLoop?: () => Promise<void>;
  /** Message text is never stored or shown from storage unless this says so. */
  readonly contentCache?: ThreadContentCacheSetting;
  /**
   * The sequence the store's body of a thread is current to (the supervisor's
   * `readThreadDetailSequence`), saved with the thread's body.
   */
  readonly readThreadSequence?: (environmentId: EnvironmentId, threadId: ThreadId) => number | null;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  /** Write window of a busy environment; defaults to the plain window when that is overridden. */
  readonly busyDebounceMs?: number;
  readonly busyMaxWaitMs?: number;
  readonly rosterDebounceMs?: number;
  readonly caps?: { readonly maxEntries: number; readonly maxBytes: number };
}

const warn = (message: string) => (error: unknown) => {
  console.warn(`[snapshot-cache] ${message}`, error);
};

const yieldWithTimeout = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * The store slices a capture persists. The threads store updates immutably, so
 * a capture whose slices are all identical to the last written ones would
 * write exactly the same rows.
 */
interface PersistedSlices {
  readonly projectIds: unknown;
  readonly projectById: unknown;
  readonly worktreeIds: unknown;
  readonly worktreeById: unknown;
  readonly threadIds: unknown;
  readonly threadShellById: unknown;
  readonly sidebarThreadSummaryById: unknown;
  /** Null while bodies are not stored, so a change of the setting is a change here. */
  readonly messageIdsByThreadId: unknown;
  readonly messageByThreadId: unknown;
  readonly activityIdsByThreadId: unknown;
  readonly activityByThreadId: unknown;
}

function persistedSlices(state: EnvironmentState, includeContent: boolean): PersistedSlices {
  return {
    projectIds: state.projectIds,
    projectById: state.projectById,
    worktreeIds: state.worktreeIds,
    worktreeById: state.worktreeById,
    threadIds: state.threadIds,
    threadShellById: state.threadShellById,
    sidebarThreadSummaryById: state.sidebarThreadSummaryById,
    messageIdsByThreadId: includeContent ? state.messageIdsByThreadId : null,
    messageByThreadId: includeContent ? state.messageByThreadId : null,
    activityIdsByThreadId: includeContent ? state.activityIdsByThreadId : null,
    activityByThreadId: includeContent ? state.activityByThreadId : null,
  };
}

function samePersistedSlices(left: PersistedSlices, right: PersistedSlices): boolean {
  return (
    left.projectIds === right.projectIds &&
    left.projectById === right.projectById &&
    left.worktreeIds === right.worktreeIds &&
    left.worktreeById === right.worktreeById &&
    left.threadIds === right.threadIds &&
    left.threadShellById === right.threadShellById &&
    left.sidebarThreadSummaryById === right.sidebarThreadSummaryById &&
    left.messageIdsByThreadId === right.messageIdsByThreadId &&
    left.messageByThreadId === right.messageByThreadId &&
    left.activityIdsByThreadId === right.activityIdsByThreadId &&
    left.activityByThreadId === right.activityByThreadId
  );
}

/** What a machine's stored rows were written from: each row's hash, and each body's sequence. */
interface StoredRows {
  /** The envelope payload last written in this process; null when not known. */
  readonly envelope: string | null;
  readonly threads: ReadonlyMap<string, number>;
  readonly bodies: ReadonlyMap<string, { readonly hash: number; readonly sequence: number | null }>;
}

/** The rows to write to turn `stored` into `rows`. */
function planRowWrites(rows: EnvironmentRows, stored: StoredRows) {
  const keptThreads = new Set(rows.threads.map((row) => row.threadId));
  const keptBodies = new Set(rows.bodies.map((row) => row.threadId));
  return {
    envelopePayload: stored.envelope === rows.envelope.payload ? undefined : rows.envelope.payload,
    upsertThreads: rows.threads.filter((row) => stored.threads.get(row.threadId) !== row.hash),
    deleteThreads: [...stored.threads.keys()].filter((threadId) => !keptThreads.has(threadId)),
    upsertBodies: rows.bodies.filter((row) => stored.bodies.get(row.threadId)?.hash !== row.hash),
    bodySequences: rows.bodies.flatMap((row) => {
      const previous = stored.bodies.get(row.threadId);
      return previous !== undefined &&
        previous.hash === row.hash &&
        previous.sequence !== row.sequence
        ? [{ threadId: row.threadId, sequence: row.sequence }]
        : [];
    }),
    deleteBodies: [...stored.bodies.keys()].filter((threadId) => !keptBodies.has(threadId)),
  };
}

function storedRowsOf(rows: EnvironmentRows): StoredRows {
  return {
    envelope: rows.envelope.payload,
    threads: new Map(rows.threads.map((row) => [row.threadId, row.hash])),
    bodies: new Map(
      rows.bodies.map((row) => [row.threadId, { hash: row.hash, sequence: row.sequence }]),
    ),
  };
}

function threadOrder(
  left: StoredEnvironmentSnapshotThread,
  right: StoredEnvironmentSnapshotThread,
): number {
  return (
    left.shell.createdAt.localeCompare(right.shell.createdAt) ||
    left.shell.id.localeCompare(right.shell.id)
  );
}

export function createSnapshotPersistenceRuntime(deps: SnapshotPersistenceDeps) {
  const debounceMs = deps.debounceMs ?? SNAPSHOT_WRITE_DEBOUNCE_MS;
  const maxWaitMs = Math.max(debounceMs, deps.maxWaitMs ?? SNAPSHOT_WRITE_MAX_WAIT_MS);
  const windowOverridden = deps.debounceMs !== undefined || deps.maxWaitMs !== undefined;
  const busyDebounceMs =
    deps.busyDebounceMs ?? (windowOverridden ? debounceMs : SNAPSHOT_BUSY_DEBOUNCE_MS);
  const busyMaxWaitMs = Math.max(
    busyDebounceMs,
    deps.busyMaxWaitMs ?? (windowOverridden ? maxWaitMs : SNAPSHOT_BUSY_MAX_WAIT_MS),
  );
  /** When each environment's last capture started (`Date.now()`), for the busy window. */
  const lastCapturedAt = new Map<EnvironmentId, number>();
  const rosterDebounceMs = deps.rosterDebounceMs ?? ROSTER_WRITE_DEBOUNCE_MS;
  const yieldToEventLoop = deps.yieldToEventLoop ?? yieldWithTimeout;
  const dirtyTimers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
  /** When each environment first became dirty since its last capture. */
  const dirtySince = new Map<EnvironmentId, number>();
  /**
   * The slices each environment's stored rows were written from, the rows
   * themselves (by hash), and that environment's removal epoch at the start of
   * the capture. A removal of the rows (purge, eviction, hydration discard)
   * bumps the epoch once it has landed, so rows deleted after they were
   * written can never be mistaken for current. Removing another environment's
   * rows leaves this one's epoch alone.
   */
  const written = new Map<
    EnvironmentId,
    { slices: PersistedSlices | null; epoch: number; rows: StoredRows }
  >();
  const removalEpochs = new Map<EnvironmentId, number>();
  const removalEpochOf = (environmentId: EnvironmentId) => removalEpochs.get(environmentId) ?? 0;
  /** Per-environment row fragments, so a capture re-serializes only changed rows. */
  const serializers = new Map<EnvironmentId, EnvironmentRowSerializer>();
  const removeStoredSnapshot = async (environmentId: EnvironmentId): Promise<void> => {
    written.delete(environmentId);
    serializers.delete(environmentId);
    forgetEnvironmentSavedThreadBodies(environmentId);
    // The machine's task list copy goes with the rest of its cached content.
    purgeTaskCache(environmentId);
    try {
      await deps.db.removeEnvironment(environmentId);
    } finally {
      removalEpochs.set(environmentId, removalEpochOf(environmentId) + 1);
    }
  };
  let rosterTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const uninstallers: Array<() => void> = [];

  const contentCache = deps.contentCache;
  const contentEnabled = (): boolean => contentCache?.isEnabled() ?? false;

  const caps = deps.caps ?? {
    maxEntries: MAX_CACHED_ENVIRONMENT_SNAPSHOTS,
    maxBytes: MAX_CACHED_ENVIRONMENT_SNAPSHOT_TOTAL_BYTES,
  };

  // Writes and removals of one machine run one after another; a clear must
  // finish after any write that was already in flight for it.
  const writes = new Map<EnvironmentId, Promise<void>>();
  const serialize = (environmentId: EnvironmentId, action: () => Promise<void>): Promise<void> => {
    const result = (writes.get(environmentId) ?? Promise.resolve()).catch(() => {}).then(action);
    writes.set(environmentId, result);
    void result
      .finally(() => {
        if (writes.get(environmentId) === result) writes.delete(environmentId);
      })
      .catch(() => {});
    return result;
  };

  /**
   * Runs outside any machine's write chain: an evicted machine's removal waits
   * for its own writes, and a write never waits for another machine's.
   */
  const evictToCapacity = async (justWrittenEnvironmentId: EnvironmentId): Promise<void> => {
    const stats = await deps.db.listEnvironmentCacheStats();
    const planned = planEvictionsToCapacity(
      stats.map((stat) => ({
        key: stat.environmentId,
        lastAccessedAt: stat.updatedAt,
        retainedBytes: stat.bytes,
        evictable: stat.environmentId !== justWrittenEnvironmentId,
      })),
      caps,
    );
    await Promise.all(
      planned.map((environmentId) =>
        serialize(environmentId as EnvironmentId, () =>
          removeStoredSnapshot(environmentId as EnvironmentId),
        ),
      ),
    );
  };

  /** What the database holds for a machine this process has not written yet. */
  const readStoredRows = async (environmentId: EnvironmentId): Promise<StoredRows> => {
    const hashes = await deps.db.loadEnvironmentRowHashes(environmentId);
    return { envelope: null, threads: hashes.threads, bodies: hashes.bodies };
  };

  /** Whether the capture wrote anything. */
  const captureNow = async (environmentId: EnvironmentId): Promise<boolean> => {
    const environmentState = deps.store.getState().environmentStateById[environmentId];
    // Only a live, settled projection is worth persisting: never before the
    // first full shell snapshot (that would write a partial projection as
    // complete), and never a state that itself came from the cache.
    if (
      !environmentState ||
      !environmentState.bootstrapComplete ||
      environmentState.hydratedFromCacheAt !== undefined
    ) {
      return false;
    }
    // A capture whose persisted slices are all unchanged since the last write
    // is skipped in O(1). While an agent runs this rarely hits: the shell
    // stream gives the active thread a fresh `updatedAt` several times a
    // second, so the serializer re-stringifies only that row, and only the
    // rows whose hash changed are written.
    const includeContent = contentEnabled();
    const slices = persistedSlices(environmentState, includeContent);
    const previous = written.get(environmentId);
    const epoch = removalEpochOf(environmentId);
    if (
      previous !== undefined &&
      previous.epoch === epoch &&
      previous.slices !== null &&
      samePersistedSlices(previous.slices, slices)
    ) {
      return false;
    }
    const serializer = serializers.get(environmentId) ?? createEnvironmentRowSerializer();
    // Most recently captured last; the least recently captured beyond the
    // bound drops its fragments.
    serializers.delete(environmentId);
    serializers.set(environmentId, serializer);
    for (const retained of serializers.keys()) {
      if (serializers.size <= MAX_RETAINED_SNAPSHOT_SERIALIZERS) break;
      serializers.delete(retained);
    }
    const readSequence = deps.readThreadSequence;
    const rows = serializer.serialize(environmentState, environmentId, {
      content: includeContent,
      ...(readSequence
        ? { readSequence: (threadId: string) => readSequence(environmentId, threadId as ThreadId) }
        : {}),
    });
    const stored =
      previous !== undefined && previous.epoch === epoch
        ? previous.rows
        : await readStoredRows(environmentId);
    const plan = planRowWrites(rows, stored);
    await deps.db.writeEnvironmentRows({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      updatedAt: deps.now(),
      envelope: {
        ...(plan.envelopePayload === undefined ? {} : { payload: plan.envelopePayload }),
        bytes: rows.envelope.bytes,
        threadCount: rows.threads.length,
        projectCount: rows.projectCount,
      },
      upsertThreads: plan.upsertThreads,
      deleteThreads: plan.deleteThreads,
      upsertBodies: plan.upsertBodies,
      bodySequences: plan.bodySequences,
      deleteBodies: plan.deleteBodies,
    });
    written.set(environmentId, { slices, epoch, rows: storedRowsOf(rows) });
    setEnvironmentSavedThreadBodyKeys(
      environmentId,
      rows.bodies.map((row) => row.threadId as ThreadId),
    );
    return true;
  };

  const capture = async (environmentId: EnvironmentId): Promise<void> => {
    let wrote = false;
    await serialize(environmentId, async () => {
      wrote = await captureNow(environmentId);
    });
    if (wrote) await evictToCapacity(environmentId);
  };

  const captureDirty = (environmentId: EnvironmentId): void => {
    const pending = dirtyTimers.get(environmentId);
    if (pending) clearTimeout(pending);
    dirtyTimers.delete(environmentId);
    dirtySince.delete(environmentId);
    lastCapturedAt.set(environmentId, Date.now());
    void capture(environmentId).catch(warn("could not persist environment snapshot"));
  };

  const markDirty = (environmentId: EnvironmentId): void => {
    if (disposed) return;
    const now = Date.now();
    const since = dirtySince.get(environmentId) ?? now;
    dirtySince.set(environmentId, since);
    const pending = dirtyTimers.get(environmentId);
    if (pending) clearTimeout(pending);
    const busy = now - (lastCapturedAt.get(environmentId) ?? -Infinity) < SNAPSHOT_BUSY_WINDOW_MS;
    const delayMs = busy
      ? Math.max(0, Math.min(busyDebounceMs, since + busyMaxWaitMs - now))
      : Math.max(0, Math.min(debounceMs, since + maxWaitMs - now));
    dirtyTimers.set(
      environmentId,
      setTimeout(() => captureDirty(environmentId), delayMs),
    );
  };

  /** Capture every pending environment now (the app is going to the background). */
  const flushPending = (): void => {
    if (disposed) return;
    for (const environmentId of Array.from(dirtyTimers.keys())) captureDirty(environmentId);
  };
  if (deps.subscribeBackground) uninstallers.push(deps.subscribeBackground(flushPending));

  const purgeEnvironment = async (environmentId: EnvironmentId): Promise<void> => {
    serializers.delete(environmentId);
    lastCapturedAt.delete(environmentId);
    const pending = dirtyTimers.get(environmentId);
    if (pending) {
      clearTimeout(pending);
      dirtyTimers.delete(environmentId);
    }
    dirtySince.delete(environmentId);
    await Promise.all([
      serialize(environmentId, () => removeStoredSnapshot(environmentId)),
      purgeEnvironmentDeviceData(environmentId),
    ]);
  };

  /**
   * Removes a machine's saved bodies after any write in flight for it. Its
   * thread rows and envelope stay as written, and so does the row's
   * timestamp: eviction order follows the last real capture.
   */
  const removeStoredBodies = (environmentId: EnvironmentId): Promise<void> =>
    serialize(environmentId, async () => {
      await deps.db.removeThreadBodies(environmentId);
      forgetEnvironmentSavedThreadBodies(environmentId);
      const entry = written.get(environmentId);
      // The next capture compares against a machine with no bodies.
      if (entry) {
        written.set(environmentId, {
          ...entry,
          slices: null,
          rows: { ...entry.rows, bodies: new Map() },
        });
      }
    });

  /** Turning the setting off removes every machine's saved bodies at once. */
  const purgeAllStoredBodies = async (): Promise<void> => {
    replaceSavedThreadBodyKeys([]);
    const stats = await deps.db.listEnvironmentCacheStats();
    // A machine being written right now may not be listed yet. Each removal
    // waits for that machine's writes.
    const environmentIds = new Set([
      ...stats.map((stat) => stat.environmentId),
      ...writes.keys(),
      ...written.keys(),
    ]);
    await Promise.all(
      [...environmentIds].map((environmentId) =>
        removeStoredBodies(environmentId as EnvironmentId).catch(
          warn("could not remove stored conversation text"),
        ),
      ),
    );
    // Bodies of a machine with no envelope (none is expected) go too.
    await deps.db.removeThreadBodies();
  };

  // The setting turned on captures what is already live; turned off, it purges.
  let contentWasEnabled = contentEnabled();
  if (contentCache?.subscribe) {
    uninstallers.push(
      contentCache.subscribe(() => {
        const enabled = contentEnabled();
        if (enabled === contentWasEnabled) return;
        contentWasEnabled = enabled;
        if (!enabled) {
          void purgeAllStoredBodies().catch(warn("could not remove stored conversation text"));
          // Saved screen answers follow the same setting.
          void deps.db.clearSavedQueries().catch(warn("could not remove saved answers"));
          return;
        }
        for (const [environmentId, state] of Object.entries(
          deps.store.getState().environmentStateById,
        )) {
          if (state.bootstrapComplete && state.hydratedFromCacheAt === undefined) {
            markDirty(environmentId as EnvironmentId);
          }
        }
      }),
    );
  }

  // A thread's body can change without a shell or orchestration event
  // marking the environment dirty (its detail snapshot, an older page of
  // history), so a change to an environment's message or activity slices
  // marks it too.
  const observedBodies = new Map<
    string,
    {
      readonly messageIds: unknown;
      readonly messages: unknown;
      readonly activityIds: unknown;
      readonly activities: unknown;
    }
  >();
  // The threads store changes on every event of every environment; most of
  // those changes leave `environmentStateById` (or a given environment's
  // state) as it was. Only environments whose state object changed are
  // looked at, so a busy store costs O(1) per change for the others.
  let observedEnvironments: Record<string, EnvironmentState> | null = null;
  const noticeBodyChanges = () => {
    const environments = deps.store.getState().environmentStateById;
    const previous = observedEnvironments;
    if (environments === previous) return;
    observedEnvironments = environments;
    const included = contentEnabled();
    for (const environmentId in environments) {
      const state = environments[environmentId] as EnvironmentState;
      if (previous !== null && previous[environmentId] === state) continue;
      const seen = observedBodies.get(environmentId);
      if (
        seen?.messageIds === state.messageIdsByThreadId &&
        seen.messages === state.messageByThreadId &&
        seen.activityIds === state.activityIdsByThreadId &&
        seen.activities === state.activityByThreadId
      ) {
        continue;
      }
      observedBodies.set(environmentId, {
        messageIds: state.messageIdsByThreadId,
        messages: state.messageByThreadId,
        activityIds: state.activityIdsByThreadId,
        activities: state.activityByThreadId,
      });
      // An environment seen for the first time is marked by the write that created it.
      if (seen && included && state.bootstrapComplete && state.hydratedFromCacheAt === undefined) {
        markDirty(environmentId as EnvironmentId);
      }
    }
    for (const environmentId of observedBodies.keys()) {
      if (!Object.hasOwn(environments, environmentId)) observedBodies.delete(environmentId);
    }
  };
  noticeBodyChanges();
  uninstallers.push(deps.store.subscribe(noticeBodyChanges));

  const persistRosterDebounced = (): void => {
    if (rosterTimer) clearTimeout(rosterTimer);
    rosterTimer = setTimeout(() => {
      rosterTimer = null;
      void deps.db
        .saveHubNodeRoster({
          schemaVersion: HUB_NODE_ROSTER_SCHEMA_VERSION,
          payload: encodeStoredHubNodeRoster(getCachedHubNodeRoster()),
          updatedAt: deps.now(),
        })
        .catch(warn("could not persist hub node roster"));
    }, rosterDebounceMs);
  };

  // Explicit Hub sign-out is a privacy boundary: cached content must not
  // outlive the account that could read it. Everything the roster names (and
  // the roster itself) is purged, except environments the direct plane owns.
  // Session expiry deliberately does not purge — same account, and offline
  // content across a re-auth is the point of the cache.
  const purgeHostedCache = (): void => {
    for (const record of getCachedHubNodeRoster()) {
      if (deps.hasDirectEnvironment(record.environmentId)) continue;
      void purgeEnvironment(record.environmentId).catch(warn("could not purge hub environment"));
      deps.store.getState().removeEnvironmentState(record.environmentId);
    }
    setCachedHubNodeRoster([]);
    if (rosterTimer) {
      clearTimeout(rosterTimer);
      rosterTimer = null;
    }
    void deps.db
      .saveHubNodeRoster({
        schemaVersion: HUB_NODE_ROSTER_SCHEMA_VERSION,
        payload: encodeStoredHubNodeRoster([]),
        updatedAt: deps.now(),
      })
      .catch(warn("could not persist cleared hub node roster"));
  };

  const installHostedRosterMirror = (hostedStore: HostedStoreLike): void => {
    let previousAccountStatus = hostedStore.getState().accountStatus;
    const reconcile = () => {
      const state = hostedStore.getState();
      const accountStatus = state.accountStatus;
      if (accountStatus === "signed-out" && previousAccountStatus !== "signed-out") {
        previousAccountStatus = accountStatus;
        purgeHostedCache();
        return;
      }
      previousAccountStatus = accountStatus;
      // Only a ready directory is authoritative; reconciling against the
      // transient empty list of bootstrap or sign-out teardown would read as
      // every node having been removed.
      if (state.directoryStatus !== "ready") return;
      const { roster, purgeEnvironmentIds, changed } = reconcileHubNodeRoster(
        getCachedHubNodeRoster(),
        state.nodes,
        deps.now(),
      );
      if (changed) {
        setCachedHubNodeRoster(roster);
        persistRosterDebounced();
      }
      for (const environmentId of purgeEnvironmentIds) {
        if (deps.hasDirectEnvironment(environmentId)) continue;
        void purgeEnvironment(environmentId).catch(warn("could not purge revoked environment"));
        deps.store.getState().removeEnvironmentState(environmentId);
      }
    };
    uninstallers.push(hostedStore.subscribe(reconcile));
    reconcile();
  };

  /**
   * Moves machines saved in the single-row layout (v1 to v3) into rows, once.
   * A row that does not decode is dropped, as a launch always did.
   */
  const moveLegacyRows = async (): Promise<void> => {
    let legacy: Awaited<ReturnType<SnapshotDb["loadLegacyEnvironmentSnapshots"]>>;
    try {
      legacy = await deps.db.loadLegacyEnvironmentSnapshots();
    } catch (error) {
      warn("could not read single-row snapshots")(error);
      return;
    }
    for (const row of legacy) {
      const environmentId = row.environmentId as EnvironmentId;
      await serialize(environmentId, async () => {
        const record = decodeStoredEnvironmentSnapshot(row.payload, environmentId);
        // A machine this process already wrote keeps its new rows.
        if (record !== null && !written.has(environmentId)) {
          const rows = environmentRowsFromLegacyRecord(record);
          const stored = await readStoredRows(environmentId);
          const plan = planRowWrites(rows, stored);
          await deps.db.writeEnvironmentRows({
            environmentId,
            schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
            updatedAt: record.capturedAt,
            envelope: {
              payload: rows.envelope.payload,
              bytes: rows.envelope.bytes,
              threadCount: rows.threads.length,
              projectCount: rows.projectCount,
            },
            upsertThreads: plan.upsertThreads,
            deleteThreads: plan.deleteThreads,
            upsertBodies: plan.upsertBodies,
            bodySequences: plan.bodySequences,
            deleteBodies: plan.deleteBodies,
          });
        }
        await deps.db.removeLegacyEnvironmentSnapshot(environmentId);
      }).catch(warn("could not move a single-row snapshot"));
    }
  };

  /** Resolves when the launch read has committed what it shows (or the runtime is gone). */
  let resolveHydrated!: () => void;
  const hydrated = new Promise<void>((resolve) => {
    resolveHydrated = resolve;
  });

  const hydrateNow = async (): Promise<void> => {
    try {
      const storedRoster = await deps.db.loadHubNodeRoster();
      if (storedRoster) {
        const nodes = decodeStoredHubNodeRoster(storedRoster.payload);
        if (nodes) setCachedHubNodeRoster(nodes);
      }
    } catch (error) {
      warn("could not hydrate hub node roster")(error);
    }

    const roster = getCachedHubNodeRoster();
    const revokedEnvironmentIds = new Set(
      roster.filter((record) => record.revokedAt !== null).map((record) => record.environmentId),
    );
    const rosterEnvironmentIds = new Set(
      roster.filter((record) => record.revokedAt === null).map((record) => record.environmentId),
    );

    // A launch starts with no thread known to have a saved body.
    replaceSavedThreadBodyKeys([]);
    await moveLegacyRows();
    // Saved bodies are only read when a thread opens; which threads have one
    // is known once the saved choice is. Bodies left from before the setting
    // was turned off are removed instead.
    const bodyKeys = (contentCache?.ready ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (!contentEnabled()) {
          replaceSavedThreadBodyKeys([]);
          await deps.db.removeThreadBodies();
          return;
        }
        const keys = await deps.db.listThreadBodyKeys();
        replaceSavedThreadBodyKeys(
          keys.map((key) => [key.environmentId as EnvironmentId, key.threadId as ThreadId]),
        );
      })
      .catch(warn("could not read saved conversation keys"));

    // Envelopes most recently written first, then each machine's thread rows.
    // Decoded machines are committed in byte-bounded batches with a yield
    // between them, so decoding a large cache never holds the JS thread in
    // one long task.
    let envelopes: Awaited<ReturnType<SnapshotDb["loadEnvironmentEnvelopes"]>>;
    try {
      envelopes = await deps.db.loadEnvironmentEnvelopes();
    } catch (error) {
      warn("could not load environment snapshots")(error);
      await bodyKeys;
      return;
    }
    // The direct supervisor may already be connected (it starts once the
    // catalog is hydrated), and so may a Hub machine. Rows a live capture has
    // replaced since the read above are not this hydration's to discard.
    const discardRows = (environmentId: EnvironmentId): Promise<void> =>
      serialize(environmentId, async () => {
        if (written.has(environmentId)) return;
        await removeStoredSnapshot(environmentId);
      });
    const hasState = (environmentId: EnvironmentId) =>
      deps.store.getState().environmentStateById[environmentId] !== undefined;
    let batch: Array<{
      readonly environmentId: EnvironmentId;
      readonly cached: CachedEnvironmentShellSnapshot;
    }> = [];
    let batchBytes = 0;
    const commit = () => {
      if (batch.length === 0) return;
      // The store re-applies its live-wins guard per entry at commit time.
      deps.store
        .getState()
        .hydrateEnvironmentStatesFromCache(batch, (_environmentId, error) =>
          warn("could not hydrate environment snapshot")(error),
        );
      batch = [];
      batchBytes = 0;
    };
    for (const row of envelopes) {
      const environmentId = row.environmentId as EnvironmentId;
      // A full slice is committed before anything else waits on the database.
      if (batchBytes >= HYDRATION_SLICE_BYTES) {
        commit();
        await yieldToEventLoop();
      }
      try {
        // A revoked node's cached content must disappear; an environment no
        // roster entry or catalog record can name has nothing to render it.
        if (
          revokedEnvironmentIds.has(environmentId) ||
          (!rosterEnvironmentIds.has(environmentId) && !deps.hasDirectEnvironment(environmentId))
        ) {
          await discardRows(environmentId);
          continue;
        }
        // Switched off: kept for when it is on again, never shown meanwhile.
        if (deps.isEnvironmentSwitchedOff?.(environmentId) === true) continue;
        // Live data wins: a cached projection would be ignored at commit, so
        // decoding it is wasted work on the launch path.
        if (hasState(environmentId)) continue;
        const envelope = decodeStoredEnvironmentEnvelope(row.payload, environmentId);
        if (!envelope) {
          // Version bump or corrupt payload: discard rather than mis-decode.
          await discardRows(environmentId);
          continue;
        }
        const threadRows = await deps.db.loadEnvironmentThreads(environmentId);
        if (hasState(environmentId)) continue;
        const threads: StoredEnvironmentSnapshotThread[] = [];
        let bytes = row.payload.length;
        for (const threadRow of threadRows) {
          bytes += threadRow.payload.length;
          // A thread row that does not decode is left out; the others still show.
          const thread = decodeStoredEnvironmentThread(threadRow.payload, environmentId);
          if (thread !== null && thread.shell.id === threadRow.threadId) threads.push(thread);
        }
        batch.push({
          environmentId,
          cached: {
            capturedAt: row.updatedAt,
            projects: envelope.projects,
            worktrees: envelope.worktrees,
            threads: threads.toSorted(threadOrder),
          },
        });
        batchBytes += bytes;
      } catch (error) {
        warn("could not hydrate environment snapshot")(error);
      }
    }
    commit();
    await bodyKeys;
  };

  const hydrate = (): Promise<void> => hydrateNow().finally(resolveHydrated);

  /**
   * Shows a thread's saved body (recent text, open cards) once the launch read
   * is in the store: display-only, and only where live data has given the
   * thread no body yet. Read from the database when the thread opens or is
   * about to.
   */
  const loadThreadBody = async (environmentId: EnvironmentId, threadId: ThreadId) => {
    await hydrated;
    if (disposed || !contentEnabled()) return;
    const environmentState = deps.store.getState().environmentStateById[environmentId];
    if (
      environmentState === undefined ||
      !Object.hasOwn(environmentState.threadShellById, threadId) ||
      Object.hasOwn(environmentState.messageByThreadId, threadId)
    ) {
      return;
    }
    const epoch = removalEpochOf(environmentId);
    const row = await deps.db.loadThreadBody(environmentId, threadId);
    if (disposed || epoch !== removalEpochOf(environmentId) || !contentEnabled()) return;
    const body = row === null ? null : decodeStoredThreadBody(row.payload);
    if (body === null) {
      forgetSavedThreadBody(environmentId, threadId);
      return;
    }
    deps.store
      .getState()
      .applyStateTransition((state) =>
        hydrateCachedThreadBodies(state, [
          { environmentId, threadId, content: body.content, prompts: body.prompts },
        ]),
      );
  };

  const dispose = (): void => {
    disposed = true;
    resolveHydrated();
    for (const timer of dirtyTimers.values()) clearTimeout(timer);
    dirtyTimers.clear();
    dirtySince.clear();
    lastCapturedAt.clear();
    serializers.clear();
    observedBodies.clear();
    if (rosterTimer) clearTimeout(rosterTimer);
    rosterTimer = null;
    for (const uninstall of uninstallers.splice(0)) uninstall();
  };

  return {
    markDirty,
    capture,
    flushPending,
    purgeEnvironment,
    hydrate,
    loadThreadBody,
    installHostedRosterMirror,
    dispose,
  };
}

export type SnapshotPersistenceRuntime = ReturnType<typeof createSnapshotPersistenceRuntime>;

// ---------------------------------------------------------------------------
// App singleton wiring
// ---------------------------------------------------------------------------

let sharedDb: SnapshotDb | null = null;
let activeRuntime: SnapshotPersistenceRuntime | null = null;
let uninstallSelectionPersistence: (() => void) | null = null;
let activeSavedQueryStore: SavedQueryStoreHandle | null = null;
let uninstallSavedQueryFlush: (() => void) | null = null;
let uninstallServerConfigSaving: (() => void) | null = null;

function getSharedSnapshotDb(): SnapshotDb {
  return (sharedDb ??= createSnapshotDb());
}

/**
 * Projection writes that landed before the runtime existed. The direct plane
 * can deliver its first live snapshot while the persistence module is still
 * being initialized; those marks are replayed instead of dropped, so the
 * snapshot is captured without waiting for the environment's next change.
 */
const dirtyBeforeInitialization = new Set<EnvironmentId>();

/** The sink's projection-changed seam; buffered until the runtime is initialized. */
export function markEnvironmentSnapshotDirty(environmentId: EnvironmentId): void {
  if (activeRuntime) activeRuntime.markDirty(environmentId);
  else dirtyBeforeInitialization.add(environmentId);
}

/** Forget an environment's cached snapshot (environment removal path). */
export function purgeEnvironmentSnapshot(environmentId: EnvironmentId): void {
  const runtime = activeRuntime;
  if (runtime) {
    void runtime.purgeEnvironment(environmentId).catch(warn("could not purge snapshot"));
    return;
  }
  purgeTaskCache(environmentId);
  forgetEnvironmentSavedThreadBodies(environmentId);
  void getSharedSnapshotDb()
    .removeEnvironment(environmentId)
    .catch(warn("could not purge snapshot"));
  void purgeEnvironmentDeviceData(environmentId);
}

/** The device setting as persistence reads it: off until the preferences have loaded. */
function createPreferencesContentCache(): ThreadContentCacheSetting {
  return {
    isEnabled: () => isPreferencesHydrated() && isThreadContentCacheEnabled(),
    ready: whenPreferencesHydrated(),
    subscribe: subscribePreferences,
  };
}

/**
 * One-time cold-start initialization: hydrate the roster and every cached
 * environment's thread list into the threads store, then install
 * the roster mirror and the Hub selection persistence. The caller must have
 * awaited saved-environment catalog hydration first, or the orphan check
 * would misread direct environments as unknown.
 */
export async function initializeMobileSnapshotPersistence(deps: {
  readonly kv: Pick<KVService, "getItem" | "setItem" | "removeItem">;
  readonly hasDirectEnvironment: (environmentId: EnvironmentId) => boolean;
  readonly isEnvironmentSwitchedOff?: (environmentId: EnvironmentId) => boolean;
  readonly subscribeBackground?: (listener: () => void) => () => void;
  readonly readThreadSequence?: (environmentId: EnvironmentId, threadId: ThreadId) => number | null;
}): Promise<void> {
  if (activeRuntime) return;
  // Loading the saved setting overlaps the SQLite open and decode below.
  const contentCache = createPreferencesContentCache();
  // Selection persistence needs only its own KV record, not the snapshot cache:
  // installed first, its read overlaps the SQLite open and decode, and the
  // restore can act the moment the directory is authoritative.
  uninstallSelectionPersistence = installHubSelectionPersistence({
    kv: deps.kv,
    store: hostedHubStore,
  });
  const runtime = createSnapshotPersistenceRuntime({
    db: getSharedSnapshotDb(),
    store: useStore,
    now: () => Date.now(),
    hasDirectEnvironment: deps.hasDirectEnvironment,
    ...(deps.isEnvironmentSwitchedOff
      ? { isEnvironmentSwitchedOff: deps.isEnvironmentSwitchedOff }
      : {}),
    contentCache,
    ...(deps.subscribeBackground ? { subscribeBackground: deps.subscribeBackground } : {}),
    ...(deps.readThreadSequence ? { readThreadSequence: deps.readThreadSequence } : {}),
  });
  activeRuntime = runtime;
  // A thread opened (or about to be) shows its saved body; requests made
  // before this point wait for it.
  installSavedThreadBodyLoader((environmentId, threadId) =>
    runtime.loadThreadBody(environmentId, threadId),
  );
  const savedQueryStore = createSavedQueryStore({
    db: getSharedSnapshotDb(),
    isEnabled: contentCache.isEnabled,
    ...(contentCache.ready ? { ready: contentCache.ready } : {}),
    now: () => Date.now(),
  });
  activeSavedQueryStore = savedQueryStore;
  // Answers waiting to be written go before the OS may suspend the app.
  uninstallSavedQueryFlush = deps.subscribeBackground?.(() => void savedQueryStore.flush()) ?? null;
  setSavedQueryStore(savedQueryStore);
  for (const environmentId of dirtyBeforeInitialization) runtime.markDirty(environmentId);
  dirtyBeforeInitialization.clear();
  await runtime.hydrate();
  // Every environment the cache could show gets its saved config (pickers,
  // provider status, settings) without waiting for its node; not awaited.
  void hydrateSavedServerConfigs(
    savedQueryStore,
    Object.keys(useStore.getState().environmentStateById) as EnvironmentId[],
  ).catch(warn("could not hydrate saved server configs"));
  uninstallServerConfigSaving = installServerConfigSaving(savedQueryStore);
  runtime.installHostedRosterMirror(hostedHubStore);
}

export function resetMobileSnapshotPersistenceForTests(): void {
  setSavedQueryStore(null);
  activeSavedQueryStore?.dispose();
  activeSavedQueryStore = null;
  uninstallSavedQueryFlush?.();
  uninstallSavedQueryFlush = null;
  uninstallServerConfigSaving?.();
  uninstallServerConfigSaving = null;
  activeRuntime?.dispose();
  activeRuntime = null;
  installSavedThreadBodyLoader(null);
  replaceSavedThreadBodyKeys([]);
  dirtyBeforeInitialization.clear();
  sharedDb = null;
  uninstallSelectionPersistence?.();
  uninstallSelectionPersistence = null;
}

/** Bytes of one environment's saved screen answers (Settings' device cache sizes). */
export function savedScreenAnswerBytes(environmentId: EnvironmentId): Promise<number> {
  return savedQueryBytes(getSharedSnapshotDb(), environmentId);
}

/**
 * Storage settings reports stored payload bytes (not SQLite allocation or free
 * disk space) and the counts kept beside each machine's rows: no row is read.
 */
export async function listEnvironmentCacheStorage() {
  const stats = await getSharedSnapshotDb().listEnvironmentCacheStats();
  return stats.map((stat) => ({
    environmentId: stat.environmentId,
    payloadBytes: stat.bytes,
    threads: stat.threadCount,
    projects: stat.projectCount,
  }));
}

/**
 * The thread window's sequence saved with a thread's body, or null. Kept for
 * a resume from the saved copy; not used for one yet, since a saved body is a
 * trimmed display copy, not the complete window (`readRestoredThreadSequence`).
 */
export function readSavedThreadSequence(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<number | null> {
  return getSharedSnapshotDb().loadThreadBodySequence(environmentId, threadId);
}

export async function clearEnvironmentSnapshotCache(environmentId: EnvironmentId): Promise<void> {
  if (activeRuntime) await activeRuntime.purgeEnvironment(environmentId);
  else {
    purgeTaskCache(environmentId);
    forgetEnvironmentSavedThreadBodies(environmentId);
    await Promise.all([
      getSharedSnapshotDb().removeEnvironment(environmentId),
      purgeEnvironmentDeviceData(environmentId),
    ]);
  }
  // Evict only offline-hydrated presentation state. Live synchronization retains ownership.
  const state = useStore.getState();
  if (state.environmentStateById[environmentId]?.hydratedFromCacheAt !== undefined) {
    state.removeEnvironmentState(environmentId);
  }
}
