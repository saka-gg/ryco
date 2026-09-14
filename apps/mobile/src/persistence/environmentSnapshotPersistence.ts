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
import { useStore, type EnvironmentState } from "../state/threadsRuntime";
import {
  boundStoredEnvironmentSnapshot,
  captureEnvironmentSnapshotRecord,
  decodeStoredEnvironmentSnapshot,
  toCachedEnvironmentShellSnapshot,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
} from "./environmentSnapshotCodec";
import { createSnapshotDb, type SnapshotDb } from "./snapshotDb";

/**
 * Orchestrates the per-environment snapshot cache (wave 2): debounced capture
 * of settled projections out of the threads store, cold-start hydration back
 * into it, the persisted Hub node roster mirror (amendment A), and
 * revocation/removal invalidation. All I/O failures degrade to a cache miss
 * with a console warning — persistence must never take the live sync path
 * down with it.
 */

/** Trailing debounce on projection writes; matches the upstream cache's coalescing. */
const SNAPSHOT_WRITE_DEBOUNCE_MS = 500;
const ROSTER_WRITE_DEBOUNCE_MS = 1_000;
/**
 * Total-across-environments bounds, enforced with the shared eviction policy
 * (count cap + byte budget, LRU) from client-runtime. Per-environment bounds
 * are applied at capture in environmentSnapshotCodec.ts.
 */
const MAX_CACHED_ENVIRONMENT_SNAPSHOTS = MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS;
const MAX_CACHED_ENVIRONMENT_SNAPSHOT_TOTAL_BYTES = MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES;

interface ThreadsStoreLike {
  readonly getState: () => {
    readonly environmentStateById: Record<string, EnvironmentState>;
    readonly hydrateEnvironmentStateFromCache: (
      cached: ReturnType<typeof toCachedEnvironmentShellSnapshot>,
      environmentId: EnvironmentId,
    ) => void;
    readonly removeEnvironmentState: (environmentId: EnvironmentId) => void;
  };
}

interface HostedStoreLike {
  readonly getState: () => HostedHubState;
  readonly subscribe: (listener: () => void) => () => void;
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
  readonly debounceMs?: number;
  readonly rosterDebounceMs?: number;
  readonly caps?: { readonly maxEntries: number; readonly maxBytes: number };
}

const warn = (message: string) => (error: unknown) => {
  console.warn(`[snapshot-cache] ${message}`, error);
};

export function createSnapshotPersistenceRuntime(deps: SnapshotPersistenceDeps) {
  const debounceMs = deps.debounceMs ?? SNAPSHOT_WRITE_DEBOUNCE_MS;
  const rosterDebounceMs = deps.rosterDebounceMs ?? ROSTER_WRITE_DEBOUNCE_MS;
  const dirtyTimers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
  let rosterTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const uninstallers: Array<() => void> = [];

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
      await deps.db.removeEnvironmentSnapshot(environmentId);
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
    const record = captureEnvironmentSnapshotRecord(environmentState, environmentId, deps.now());
    const { payload } = boundStoredEnvironmentSnapshot(record);
    await deps.db.saveEnvironmentSnapshot({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload,
      updatedAt: deps.now(),
    });
    await evictToCapacity(environmentId);
  };

  const capture = (environmentId: EnvironmentId): Promise<void> =>
    serialize(environmentId, () => captureNow(environmentId));

  const markDirty = (environmentId: EnvironmentId): void => {
    if (disposed) return;
    const pending = dirtyTimers.get(environmentId);
    if (pending) clearTimeout(pending);
    dirtyTimers.set(
      environmentId,
      setTimeout(() => {
        dirtyTimers.delete(environmentId);
        void capture(environmentId).catch(warn("could not persist environment snapshot"));
      }, debounceMs),
    );
  };

  const purgeEnvironment = async (environmentId: EnvironmentId): Promise<void> => {
    const pending = dirtyTimers.get(environmentId);
    if (pending) {
      clearTimeout(pending);
      dirtyTimers.delete(environmentId);
    }
    await serialize(environmentId, () => deps.db.removeEnvironmentSnapshot(environmentId));
  };

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

    let stats: ReadonlyArray<{ environmentId: string }>;
    try {
      stats = await deps.db.listEnvironmentSnapshotStats();
    } catch (error) {
      warn("could not list environment snapshots")(error);
      return;
    }
    for (const stat of stats) {
      const environmentId = stat.environmentId as EnvironmentId;
      try {
        // A revoked node's cached content must disappear; an environment no
        // roster entry or catalog record can name has nothing to render it.
        if (
          revokedEnvironmentIds.has(environmentId) ||
          (!rosterEnvironmentIds.has(environmentId) && !deps.hasDirectEnvironment(environmentId))
        ) {
          await deps.db.removeEnvironmentSnapshot(environmentId);
          continue;
        }
        const row = await deps.db.loadEnvironmentSnapshot(environmentId);
        if (!row) continue;
        const record = decodeStoredEnvironmentSnapshot(row.payload, environmentId);
        if (!record) {
          // Version bump or corrupt payload: discard rather than mis-decode.
          await deps.db.removeEnvironmentSnapshot(environmentId);
          continue;
        }
        deps.store
          .getState()
          .hydrateEnvironmentStateFromCache(
            toCachedEnvironmentShellSnapshot(record),
            environmentId,
          );
      } catch (error) {
        warn("could not hydrate environment snapshot")(error);
      }
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const timer of dirtyTimers.values()) clearTimeout(timer);
    dirtyTimers.clear();
    if (rosterTimer) clearTimeout(rosterTimer);
    rosterTimer = null;
    for (const uninstall of uninstallers.splice(0)) uninstall();
  };

  return { markDirty, capture, purgeEnvironment, hydrate, installHostedRosterMirror, dispose };
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

/** The sink's projection-changed seam; a no-op until the runtime is initialized. */
export function markEnvironmentSnapshotDirty(environmentId: EnvironmentId): void {
  activeRuntime?.markDirty(environmentId);
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
}): Promise<void> {
  if (activeRuntime) return;
  const runtime = createSnapshotPersistenceRuntime({
    db: getSharedSnapshotDb(),
    store: useStore,
    now: () => Date.now(),
    hasDirectEnvironment: deps.hasDirectEnvironment,
  });
  activeRuntime = runtime;
  await runtime.hydrate();
  runtime.installHostedRosterMirror(hostedHubStore);
  uninstallSelectionPersistence = installHubSelectionPersistence({
    kv: deps.kv,
    store: hostedHubStore,
  });
}

export function resetMobileSnapshotPersistenceForTests(): void {
  activeRuntime?.dispose();
  activeRuntime = null;
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
