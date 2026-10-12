import type { EnvironmentId } from "@ryco/contracts";
import {
  boundWorkspaceMetadataSnapshot,
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";

import { selectEnvironmentState, useStore, type AppState } from "../store";
import { openIndexedDbRecords } from "./indexedDbRecords";
import {
  readWorkspaceMetadataSnapshot,
  workspaceMetadataToCachedShellSnapshot,
} from "../workspaceMetadataProjection";

/**
 * Last-known shell of the primary environment, so a direct (local or desktop)
 * boot renders its sidebar before the connection and the shell snapshot have
 * completed. Hosted mode has its own account-fenced read cache and never uses
 * this one.
 *
 * The cache only ever paints. Hydration goes through
 * `hydrateEnvironmentStateFromCache`: the environment stays not bootstrapped
 * and carries `hydratedFromCacheAt`, so every live/mutation gate keeps treating
 * it as not live and the UI shows it as last known; live data always replaces
 * it, and a live environment is never overwritten by it. The cache holds the
 * same bounded metadata the hosted cache holds (no message content, sessions
 * or liveness), is persisted only for a loopback page or the desktop app (no
 * device that merely paired with a node keeps a copy without asking), belongs
 * to one environment id, and is dropped when the session is no longer
 * authenticated.
 */

const DATABASE_NAME = "ryco-primary-shell-v1";
const STORE_NAME = "shells";
/** Wait this long after the last change before writing, then for an idle moment. */
export const PRIMARY_SHELL_CACHE_WRITE_DELAY_MS = 2_000;

export interface PrimaryShellCacheRecord {
  readonly origin: string;
  readonly environmentId: EnvironmentId;
  readonly savedAt: number;
  readonly snapshot: WorkspaceMetadataSnapshot;
}

export interface PrimaryShellCacheStorage {
  readonly read: (origin: string) => Promise<unknown>;
  readonly write: (record: PrimaryShellCacheRecord) => Promise<void>;
  readonly remove: (origin: string) => Promise<void>;
}

export function decodePrimaryShellCacheRecord(
  value: unknown,
  origin: string,
  environmentId: EnvironmentId,
): PrimaryShellCacheRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<PrimaryShellCacheRecord>;
  if (record.origin !== origin || record.environmentId !== environmentId) return null;
  if (typeof record.savedAt !== "number" || !Number.isFinite(record.savedAt)) return null;
  if (!isWorkspaceMetadataSnapshot(record.snapshot, environmentId)) return null;
  return record as PrimaryShellCacheRecord;
}

export function createIndexedDbPrimaryShellCacheStorage(
  factory: IDBFactory,
  databaseName = DATABASE_NAME,
): PrimaryShellCacheStorage {
  const records = openIndexedDbRecords<PrimaryShellCacheRecord>({
    factory,
    databaseName,
    storeName: STORE_NAME,
    keyPath: "origin",
  });
  return { read: records.get, write: records.put, remove: records.delete };
}

let browserStorage: PrimaryShellCacheStorage | null = null;
function getBrowserStorage(): PrimaryShellCacheStorage | null {
  if (browserStorage) return browserStorage;
  if (typeof indexedDB === "undefined") return null;
  browserStorage = createIndexedDbPrimaryShellCacheStorage(indexedDB);
  return browserStorage;
}

/**
 * Reads the cached record for this page's origin; resolves `null` instead of
 * failing. Starts before the environment id is known, so a boot overlaps the
 * read with its network round trips.
 */
export function readPrimaryShellCache(
  storage: PrimaryShellCacheStorage | null = getBrowserStorage(),
  origin: string = window.location.origin,
): Promise<unknown> {
  if (storage === null) return Promise.resolve(null);
  return storage.read(origin).catch(() => null);
}

/** Drops the cached shell, e.g. once the session is no longer authenticated. */
export function clearPrimaryShellCache(
  storage: PrimaryShellCacheStorage | null = getBrowserStorage(),
  origin: string = window.location.origin,
): Promise<void> {
  if (storage === null) return Promise.resolve();
  return storage.remove(origin).catch(() => undefined);
}

/**
 * Paints the cached shell for `environmentId` when the store has nothing for
 * it yet. A record for another environment (a reset or replaced node) is
 * discarded. Returns whether anything was hydrated.
 */
export function hydratePrimaryShellFromCache(input: {
  readonly value: unknown;
  readonly environmentId: EnvironmentId;
  readonly origin?: string;
  readonly storage?: PrimaryShellCacheStorage | null;
}): boolean {
  const origin = input.origin ?? window.location.origin;
  const record = decodePrimaryShellCacheRecord(input.value, origin, input.environmentId);
  if (record === null) {
    if (input.value != null) void clearPrimaryShellCache(input.storage, origin);
    return false;
  }
  if (useStore.getState().environmentStateById[input.environmentId] !== undefined) return false;
  useStore
    .getState()
    .hydrateEnvironmentStateFromCache(
      workspaceMetadataToCachedShellSnapshot(record.snapshot),
      input.environmentId,
    );
  return (
    useStore.getState().environmentStateById[input.environmentId]?.hydratedFromCacheAt !== undefined
  );
}

/** The environment's shell, live and bootstrapped, as a bounded cache snapshot. */
export function capturePrimaryShellSnapshot(
  environmentId: EnvironmentId,
  state: AppState,
  capturedAt: number,
): WorkspaceMetadataSnapshot | null {
  const environment = selectEnvironmentState(state, environmentId);
  // Only a live shell is worth keeping; a cached or demoted one is not newer.
  if (!environment.bootstrapComplete || environment.hydratedFromCacheAt !== undefined) return null;
  const snapshot = readWorkspaceMetadataSnapshot(environmentId, capturedAt, false, state);
  return snapshot === null ? null : boundWorkspaceMetadataSnapshot(snapshot);
}

/**
 * Keeps the cache current while the page lives: a change to the primary
 * environment's shell schedules one write after `PRIMARY_SHELL_CACHE_WRITE_DELAY_MS`
 * of quiet, at an idle moment. Returns a stop function.
 */
let activePersistence: (() => void) | null = null;

export function startPrimaryShellCachePersistence(input: {
  readonly environmentId: EnvironmentId;
  readonly storage?: PrimaryShellCacheStorage | null;
  readonly origin?: string;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly whenIdle?: (callback: () => void) => void;
}): () => void {
  const storage = input.storage === undefined ? getBrowserStorage() : input.storage;
  if (storage === null) return () => undefined;
  const origin = input.origin ?? window.location.origin;
  const now = input.now ?? Date.now;
  const schedule =
    input.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancel =
    input.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const whenIdle =
    input.whenIdle ??
    ((callback: () => void) => {
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(callback, { timeout: 5_000 });
      else globalThis.setTimeout(callback, 0);
    });
  let stopped = false;
  let timer: unknown = null;
  let lastWritten: string | null = null;
  let observed = selectEnvironmentState(useStore.getState(), input.environmentId);
  const write = () => {
    if (stopped) return;
    const snapshot = capturePrimaryShellSnapshot(input.environmentId, useStore.getState(), now());
    if (snapshot === null) return;
    const { capturedAt: _capturedAt, ...content } = snapshot;
    const fingerprint = JSON.stringify(content);
    if (fingerprint === lastWritten) return;
    lastWritten = fingerprint;
    void storage
      .write({ origin, environmentId: input.environmentId, savedAt: snapshot.capturedAt, snapshot })
      .catch(() => {
        lastWritten = null;
      });
  };
  const scheduleWrite = (environment: ReturnType<typeof selectEnvironmentState>) => {
    if (!environment.bootstrapComplete || environment.hydratedFromCacheAt !== undefined) return;
    if (timer !== null) cancel(timer);
    timer = schedule(() => {
      timer = null;
      whenIdle(write);
    }, PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
  };
  const unsubscribe = useStore.subscribe((state) => {
    const environment = selectEnvironmentState(state, input.environmentId);
    if (environment === observed) return;
    observed = environment;
    scheduleWrite(environment);
  });
  scheduleWrite(observed);
  // One writer per page: a later start (a re-run boot) replaces the earlier one.
  activePersistence?.();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (timer !== null) cancel(timer);
    timer = null;
    if (activePersistence === stop) activePersistence = null;
  };
  activePersistence = stop;
  return stop;
}
