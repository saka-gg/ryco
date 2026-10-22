import { hostedHubStore, type HostedHubState } from "@ryco/client-runtime/authorization";
import { planEvictionsToCapacity } from "@ryco/client-runtime/connection";
import type { KVService } from "@ryco/client-runtime/platform";
import {
  MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES,
} from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId } from "@ryco/contracts";

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
  createEnvironmentSnapshotSerializer,
  decodeStoredEnvironmentSnapshot,
  type EnvironmentSnapshotSerializer,
  mayHoldStoredContent,
  toCachedEnvironmentShellSnapshot,
  withoutStoredContent,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
} from "./environmentSnapshotCodec";
import { createSnapshotDb, payloadByteLength, type SnapshotDb } from "./snapshotDb";

/**
 * Orchestrates the per-environment snapshot cache (wave 2): debounced capture
 * of settled projections out of the threads store, cold-start hydration back
 * into it, the persisted Hub node roster mirror (amendment A), and
 * revocation/removal invalidation. All I/O failures degrade to a cache miss
 * with a console warning — persistence must never take the live sync path
 * down with it.
 *
 * Bounded recent message text is stored with each environment's shell while
 * the "keep recent conversations" device setting is on. It is display-only:
 * hydrated as cached message bodies that live data replaces, and removed
 * wherever the shell is, and when the setting is turned off.
 */

/**
 * Trailing debounce on projection writes, bounded by a maximum wait. Every
 * capture writes the whole environment row (up to the per-environment byte
 * cap), so a busy environment is written at most once per window rather than
 * after every short gap in its event stream; the maximum wait keeps a
 * continuously active one from never being written, and backgrounding flushes
 * whatever is pending, so the longer window costs no durability.
 */
export const SNAPSHOT_WRITE_DEBOUNCE_MS = 2_000;
export const SNAPSHOT_WRITE_MAX_WAIT_MS = 10_000;
const ROSTER_WRITE_DEBOUNCE_MS = 1_000;
/**
 * Environments whose thread fragments are kept between captures. Fragments
 * hold each thread's serialized JSON (up to the per-environment byte cap), and
 * only an environment captured again and again — one an agent is running in —
 * gains from them, so only the most recently captured few keep theirs.
 */
const MAX_RETAINED_SNAPSHOT_SERIALIZERS = 2;
/**
 * Total-across-environments bounds, enforced with the shared eviction policy
 * (count cap + byte budget, LRU) from client-runtime. Per-environment bounds
 * are applied at capture in environmentSnapshotCodec.ts.
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
        readonly cached: ReturnType<typeof toCachedEnvironmentShellSnapshot>;
      }>,
      onEntryError?: (environmentId: EnvironmentId, error: unknown) => void,
    ) => void;
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
  /** App backgrounding; pending captures are flushed before the OS may suspend us. */
  readonly subscribeBackground?: (listener: () => void) => () => void;
  /**
   * Yield to the event loop between environments during cold-start hydration,
   * so decoding a large cache does not hold the JS thread in one long task.
   */
  readonly yieldToEventLoop?: () => Promise<void>;
  /** Message text is never stored or shown from storage unless this says so. */
  readonly contentCache?: ThreadContentCacheSetting;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
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
 * serialize exactly the same projection.
 */
interface PersistedSlices {
  readonly projectIds: unknown;
  readonly projectById: unknown;
  readonly worktreeIds: unknown;
  readonly worktreeById: unknown;
  readonly threadIds: unknown;
  readonly threadShellById: unknown;
  readonly sidebarThreadSummaryById: unknown;
  /** Null while message text is not stored, so a change of the setting is a change here. */
  readonly messageIdsByThreadId: unknown;
  readonly messageByThreadId: unknown;
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
    left.messageByThreadId === right.messageByThreadId
  );
}

export function createSnapshotPersistenceRuntime(deps: SnapshotPersistenceDeps) {
  const debounceMs = deps.debounceMs ?? SNAPSHOT_WRITE_DEBOUNCE_MS;
  const maxWaitMs = Math.max(debounceMs, deps.maxWaitMs ?? SNAPSHOT_WRITE_MAX_WAIT_MS);
  const rosterDebounceMs = deps.rosterDebounceMs ?? ROSTER_WRITE_DEBOUNCE_MS;
  const yieldToEventLoop = deps.yieldToEventLoop ?? yieldWithTimeout;
  const dirtyTimers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
  /** When each environment first became dirty since its last capture. */
  const dirtySince = new Map<EnvironmentId, number>();
  /**
   * The slices each environment's stored snapshot was written from, and that
   * environment's removal epoch at the start of the capture. A removal of the
   * row (purge, eviction, hydration discard) bumps the epoch once it has
   * landed, so a row deleted after it was written can never be mistaken for
   * current. Removing another environment's row leaves this one's epoch alone.
   */
  const written = new Map<EnvironmentId, { slices: PersistedSlices; epoch: number }>();
  const removalEpochs = new Map<EnvironmentId, number>();
  const removalEpochOf = (environmentId: EnvironmentId) => removalEpochs.get(environmentId) ?? 0;
  /** Per-environment thread fragments, so a capture re-serializes only changed rows. */
  const serializers = new Map<EnvironmentId, EnvironmentSnapshotSerializer>();
  const removeStoredSnapshot = async (environmentId: EnvironmentId): Promise<void> => {
    written.delete(environmentId);
    serializers.delete(environmentId);
    try {
      await deps.db.removeEnvironmentSnapshot(environmentId);
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

  const evictToCapacity = async (justWrittenEnvironmentId: EnvironmentId): Promise<void> => {
    const stats = await deps.db.listEnvironmentSnapshotStats();
    const planned = planEvictionsToCapacity(
      stats.map((stat) => ({
        key: stat.environmentId,
        lastAccessedAt: stat.updatedAt,
        retainedBytes: stat.payloadBytes,
        evictable: stat.environmentId !== justWrittenEnvironmentId,
      })),
      caps,
    );
    for (const environmentId of planned) {
      await removeStoredSnapshot(environmentId as EnvironmentId);
    }
  };

  // A clear must finish after any write that was already in flight for this node.
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
  const captureNow = async (environmentId: EnvironmentId): Promise<void> => {
    const environmentState = deps.store.getState().environmentStateById[environmentId];
    // Only a live, settled projection is worth persisting: never before the
    // first full shell snapshot (that would write a partial projection as
    // complete), and never a state that itself came from the cache.
    if (
      !environmentState ||
      !environmentState.bootstrapComplete ||
      environmentState.hydratedFromCacheAt !== undefined
    ) {
      return;
    }
    // A capture whose persisted slices are all unchanged since the last write
    // is skipped in O(1). While an agent runs this rarely hits: the shell
    // stream gives the active thread a fresh `updatedAt` (and session) several
    // times a second, replacing its shell and summary, so the serializer
    // re-stringifies only those rows and reuses every other thread's fragment.
    const includeContent = contentEnabled();
    const slices = persistedSlices(environmentState, includeContent);
    const previous = written.get(environmentId);
    const epoch = removalEpochOf(environmentId);
    if (
      previous !== undefined &&
      previous.epoch === epoch &&
      samePersistedSlices(previous.slices, slices)
    ) {
      return;
    }
    const serializer = serializers.get(environmentId) ?? createEnvironmentSnapshotSerializer();
    // Most recently captured last; the least recently captured beyond the
    // bound drops its fragments.
    serializers.delete(environmentId);
    serializers.set(environmentId, serializer);
    for (const retained of serializers.keys()) {
      if (serializers.size <= MAX_RETAINED_SNAPSHOT_SERIALIZERS) break;
      serializers.delete(retained);
    }
    const { payload, payloadBytes } = serializer.serialize(
      environmentState,
      environmentId,
      deps.now(),
      { content: includeContent },
    );
    await deps.db.saveEnvironmentSnapshot({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload,
      payloadBytes,
      updatedAt: deps.now(),
    });
    written.set(environmentId, { slices, epoch });
    await evictToCapacity(environmentId);
  };

  const capture = (environmentId: EnvironmentId): Promise<void> =>
    serialize(environmentId, () => captureNow(environmentId));

  const captureDirty = (environmentId: EnvironmentId): void => {
    const pending = dirtyTimers.get(environmentId);
    if (pending) clearTimeout(pending);
    dirtyTimers.delete(environmentId);
    dirtySince.delete(environmentId);
    void capture(environmentId).catch(warn("could not persist environment snapshot"));
  };

  const markDirty = (environmentId: EnvironmentId): void => {
    if (disposed) return;
    const now = Date.now();
    const since = dirtySince.get(environmentId) ?? now;
    dirtySince.set(environmentId, since);
    const pending = dirtyTimers.get(environmentId);
    if (pending) clearTimeout(pending);
    const delayMs = Math.max(0, Math.min(debounceMs, since + maxWaitMs - now));
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
    const pending = dirtyTimers.get(environmentId);
    if (pending) {
      clearTimeout(pending);
      dirtyTimers.delete(environmentId);
    }
    dirtySince.delete(environmentId);
    await serialize(environmentId, () => removeStoredSnapshot(environmentId));
  };

  /**
   * Rewrites an environment's stored row without its message text. The shell
   * stays as written, and so does the row's timestamp: eviction order follows
   * the last real capture.
   */
  const removeStoredContent = (environmentId: EnvironmentId): Promise<void> =>
    serialize(environmentId, async () => {
      const row = await deps.db.loadEnvironmentSnapshot(environmentId);
      const payload = row ? withoutStoredContent(row.payload) : null;
      if (!row || payload === null) return;
      await deps.db.saveEnvironmentSnapshot({
        environmentId,
        schemaVersion: row.schemaVersion,
        payload,
        payloadBytes: payloadByteLength(payload),
        updatedAt: row.updatedAt,
      });
      // The stored row is no longer what the last capture wrote.
      written.delete(environmentId);
    });

  /** Turning the setting off removes every environment's stored message text at once. */
  const purgeAllStoredContent = async (): Promise<void> => {
    const stats = await deps.db.listEnvironmentSnapshotStats();
    // A row being written right now may not be listed yet. Each removal waits
    // for that environment's writes and then reads its row again.
    const environmentIds = new Set([
      ...stats.map((stat) => stat.environmentId),
      ...writes.keys(),
      ...written.keys(),
    ]);
    await Promise.all(
      [...environmentIds].map((environmentId) =>
        removeStoredContent(environmentId as EnvironmentId).catch(
          warn("could not remove stored conversation text"),
        ),
      ),
    );
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
          void purgeAllStoredContent().catch(warn("could not remove stored conversation text"));
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

  // A thread's messages can change without a shell or orchestration event
  // marking the environment dirty (its detail snapshot, an older page of
  // history), so a change to an environment's message slices marks it too.
  const observedMessages = new Map<string, { readonly ids: unknown; readonly byId: unknown }>();
  const noticeMessageChanges = () => {
    const environments = deps.store.getState().environmentStateById;
    const included = contentEnabled();
    for (const [environmentId, state] of Object.entries(environments)) {
      const seen = observedMessages.get(environmentId);
      if (seen?.ids === state.messageIdsByThreadId && seen.byId === state.messageByThreadId) {
        continue;
      }
      observedMessages.set(environmentId, {
        ids: state.messageIdsByThreadId,
        byId: state.messageByThreadId,
      });
      // An environment seen for the first time is marked by the write that created it.
      if (seen && included && state.bootstrapComplete && state.hydratedFromCacheAt === undefined) {
        markDirty(environmentId as EnvironmentId);
      }
    }
    for (const environmentId of observedMessages.keys()) {
      if (!Object.hasOwn(environments, environmentId)) observedMessages.delete(environmentId);
    }
  };
  noticeMessageChanges();
  uninstallers.push(deps.store.subscribe(noticeMessageChanges));

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

  const hydrate = async (): Promise<void> => {
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

    // One read for every row (most recently written first) instead of a stats
    // query plus one SELECT per environment. Decoded environments are
    // committed in byte-bounded batches with a yield between them, so decoding
    // a large cache never holds the JS thread in one long task.
    let rows: Awaited<ReturnType<SnapshotDb["loadEnvironmentSnapshots"]>>;
    try {
      rows = await deps.db.loadEnvironmentSnapshots();
    } catch (error) {
      warn("could not load environment snapshots")(error);
      return;
    }
    // Stored message text is shown only while the saved choice allows it.
    await contentCache?.ready?.catch(() => undefined);
    const includeContent = contentEnabled();
    // The direct supervisor may already be connected (it starts once the
    // catalog is hydrated). A row a live capture has replaced since the read
    // above is not this hydration's to discard.
    const discardRow = (environmentId: EnvironmentId): Promise<void> =>
      serialize(environmentId, async () => {
        if (written.has(environmentId)) return;
        await removeStoredSnapshot(environmentId);
      });
    const hasState = (environmentId: EnvironmentId) =>
      deps.store.getState().environmentStateById[environmentId] !== undefined;
    let batch: Array<{
      readonly environmentId: EnvironmentId;
      readonly cached: ReturnType<typeof toCachedEnvironmentShellSnapshot>;
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
    for (const row of rows) {
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
          await discardRow(environmentId);
          continue;
        }
        if (!includeContent && mayHoldStoredContent(row.payload)) {
          // Left from before the setting was turned off, whether or not it decodes.
          void removeStoredContent(environmentId).catch(
            warn("could not remove stored conversation text"),
          );
        }
        // Live data wins: a cached projection would be ignored at commit, so
        // decoding it is wasted work on the launch path.
        if (hasState(environmentId)) continue;
        const record = decodeStoredEnvironmentSnapshot(row.payload, environmentId);
        if (!record) {
          // Version bump or corrupt payload: discard rather than mis-decode.
          await discardRow(environmentId);
          continue;
        }
        batch.push({
          environmentId,
          cached: toCachedEnvironmentShellSnapshot(record, { includeContent }),
        });
        batchBytes += row.payload.length;
      } catch (error) {
        warn("could not hydrate environment snapshot")(error);
      }
    }
    commit();
  };

  const dispose = (): void => {
    disposed = true;
    for (const timer of dirtyTimers.values()) clearTimeout(timer);
    dirtyTimers.clear();
    dirtySince.clear();
    serializers.clear();
    observedMessages.clear();
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
  void getSharedSnapshotDb()
    .removeEnvironmentSnapshot(environmentId)
    .catch(warn("could not purge snapshot"));
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
 * environment into the threads store before connections exist, then install
 * the roster mirror and the Hub selection persistence. The caller must have
 * awaited saved-environment catalog hydration first, or the orphan check
 * would misread direct environments as unknown.
 */
export async function initializeMobileSnapshotPersistence(deps: {
  readonly kv: Pick<KVService, "getItem" | "setItem" | "removeItem">;
  readonly hasDirectEnvironment: (environmentId: EnvironmentId) => boolean;
  readonly subscribeBackground?: (listener: () => void) => () => void;
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
    contentCache,
    ...(deps.subscribeBackground ? { subscribeBackground: deps.subscribeBackground } : {}),
  });
  activeRuntime = runtime;
  for (const environmentId of dirtyBeforeInitialization) runtime.markDirty(environmentId);
  dirtyBeforeInitialization.clear();
  await runtime.hydrate();
  runtime.installHostedRosterMirror(hostedHubStore);
}

export function resetMobileSnapshotPersistenceForTests(): void {
  activeRuntime?.dispose();
  activeRuntime = null;
  dirtyBeforeInitialization.clear();
  sharedDb = null;
  uninstallSelectionPersistence?.();
  uninstallSelectionPersistence = null;
}

/** Storage settings reports stored payload bytes, not SQLite allocation or free disk space. */
export async function listEnvironmentCacheStorage() {
  const db = getSharedSnapshotDb();
  const stats = await db.listEnvironmentSnapshotStats();
  return Promise.all(
    stats.map(async (stat) => {
      const stored = await db.loadEnvironmentSnapshot(stat.environmentId);
      const snapshot = stored
        ? decodeStoredEnvironmentSnapshot(stored.payload, stat.environmentId as EnvironmentId)
        : null;
      return {
        environmentId: stat.environmentId,
        payloadBytes: stat.payloadBytes,
        threads: snapshot?.threads.length ?? 0,
        projects: snapshot?.projects.length ?? 0,
      };
    }),
  );
}
export async function clearEnvironmentSnapshotCache(environmentId: EnvironmentId): Promise<void> {
  if (activeRuntime) await activeRuntime.purgeEnvironment(environmentId);
  else await getSharedSnapshotDb().removeEnvironmentSnapshot(environmentId);
  // Evict only offline-hydrated presentation state. Live synchronization retains ownership.
  const state = useStore.getState();
  if (state.environmentStateById[environmentId]?.hydratedFromCacheAt !== undefined) {
    state.removeEnvironmentState(environmentId);
  }
}
