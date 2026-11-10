import type { EnvironmentId } from "@ryco/contracts";
import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  THREAD_READING_POSITION_CAPACITY,
  decodeCachedEnvironmentContent,
  decodeThreadReadingAnchor,
  type CachedThreadContent,
  type SavedThreadReadingAnchor,
} from "@ryco/client-runtime/state/threads";
import {
  boundWorkspaceMetadataSnapshot,
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";

import { selectEnvironmentState, useStore, type AppState } from "../store";
import { openIndexedDbRecords } from "./indexedDbRecords";
import type { PrimaryShellCacheWriterInput } from "./primaryShellCacheWriter";
import { threadReadingPositions } from "./threadReadingPositions";
import {
  readWorkspaceMetadataSnapshot,
  workspaceMetadataToCachedShellSnapshot,
} from "../workspaceMetadataProjection";

/**
 * Last-known state of the primary environment, so a direct (local or desktop)
 * boot renders its sidebar, and the conversations last read there, before the
 * connection and the shell snapshot have completed. Hosted mode has its own
 * account-fenced read cache and never uses this one.
 *
 * The cache only ever paints. Hydration goes through
 * `hydrateEnvironmentStateFromCache`: the environment stays not bootstrapped
 * and carries `hydratedFromCacheAt`, so every live/mutation gate keeps treating
 * it as not live and the UI shows it as last known; live data always replaces
 * it, and a live environment is never overwritten by it. The cache holds the
 * same bounded metadata the hosted cache holds, the display text of recent
 * conversations under the shared content-cache policy (no sessions, liveness
 * or attachments; none at all when the Desktop keeps no recent conversations)
 * and where threads were left. It is persisted only for a loopback page or the
 * desktop app (no device that merely paired with a node keeps a copy without
 * asking), belongs to one environment id, and is dropped when the session is
 * no longer authenticated. Writing it lives in `primaryShellCacheWriter`,
 * loaded after the paint.
 */

const DATABASE_NAME = "ryco-primary-shell-v1";
const STORE_NAME = "shells";

export interface PrimaryShellCacheRecord {
  readonly origin: string;
  readonly environmentId: EnvironmentId;
  readonly savedAt: number;
  readonly snapshot: WorkspaceMetadataSnapshot;
  /**
   * Display content of recent conversations, by thread id. Absent from
   * records written before it existed and while the Desktop keeps no recent
   * conversations.
   */
  readonly content?: Readonly<Record<string, CachedThreadContent>>;
  /** Where this environment's threads were left away from their end, by scoped thread key. */
  readonly readingPositions?: Readonly<Record<string, SavedThreadReadingAnchor>>;
}

export interface PrimaryShellCacheStorage {
  readonly read: (origin: string) => Promise<unknown>;
  readonly write: (record: PrimaryShellCacheRecord) => Promise<void>;
  readonly remove: (origin: string) => Promise<void>;
}

/**
 * The saved anchors that are still valid and belong to `environmentId`, the
 * most recently left `THREAD_READING_POSITION_CAPACITY` of them.
 */
function decodeReadingPositions(
  value: unknown,
  environmentId: EnvironmentId,
): Record<string, SavedThreadReadingAnchor> {
  const readingPositions: Record<string, SavedThreadReadingAnchor> = {};
  if (typeof value !== "object" || value === null) return readingPositions;
  for (const [key, entry] of Object.entries(value).slice(-THREAD_READING_POSITION_CAPACITY)) {
    const anchor = decodeThreadReadingAnchor(entry);
    if (anchor && parseScopedThreadKey(key)?.environmentId === environmentId)
      readingPositions[key] = anchor;
  }
  return readingPositions;
}

/**
 * The record for this origin and environment, read as untrusted: the
 * metadata must be valid, and content and anchors keep only what decodes
 * within the shared limits (content only for threads the metadata lists).
 * Fields it does not know are dropped, so a newer record still reads.
 */
export function decodePrimaryShellCacheRecord(
  value: unknown,
  origin: string,
  environmentId: EnvironmentId,
): PrimaryShellCacheRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<Record<keyof PrimaryShellCacheRecord, unknown>>;
  if (record.origin !== origin || record.environmentId !== environmentId) return null;
  if (typeof record.savedAt !== "number" || !Number.isFinite(record.savedAt)) return null;
  if (!isWorkspaceMetadataSnapshot(record.snapshot, environmentId)) return null;
  const snapshot = record.snapshot;
  const threadIds = new Set(snapshot.threads.map((thread) => thread.id as string));
  return {
    origin,
    environmentId,
    savedAt: record.savedAt,
    snapshot,
    ...(record.content === undefined
      ? {}
      : { content: decodeCachedEnvironmentContent({ content: record.content }, threadIds) }),
    ...(record.readingPositions === undefined
      ? {}
      : { readingPositions: decodeReadingPositions(record.readingPositions, environmentId) }),
  };
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
export function getPrimaryShellCacheBrowserStorage(): PrimaryShellCacheStorage | null {
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
  storage: PrimaryShellCacheStorage | null = getPrimaryShellCacheBrowserStorage(),
  origin: string = window.location.origin,
): Promise<unknown> {
  if (storage === null) return Promise.resolve(null);
  return storage.read(origin).catch(() => null);
}

/** Drops the cached shell, e.g. once the session is no longer authenticated. */
export function clearPrimaryShellCache(
  storage: PrimaryShellCacheStorage | null = getPrimaryShellCacheBrowserStorage(),
  origin: string = window.location.origin,
): Promise<void> {
  if (storage === null) return Promise.resolve();
  return storage.remove(origin).catch(() => undefined);
}

/**
 * Drops the recent conversations and reading positions the cached record
 * holds and keeps its shell: the Desktop stopped keeping recent conversations.
 */
export async function dropPrimaryShellCacheConversations(
  storage: PrimaryShellCacheStorage | null = getPrimaryShellCacheBrowserStorage(),
  origin: string = window.location.origin,
): Promise<void> {
  if (storage === null) return;
  const value = await storage.read(origin).catch(() => null);
  if (typeof value !== "object" || value === null) return;
  const record = value as Partial<PrimaryShellCacheRecord>;
  if (record.content === undefined && record.readingPositions === undefined) return;
  const { content: _content, readingPositions: _readingPositions, ...shell } = record;
  await storage.write(shell as PrimaryShellCacheRecord).catch(() => undefined);
}

/**
 * Paints the cached shell for `environmentId`, with the conversations it
 * holds, when the store has nothing for it yet, and restores where its threads
 * were left. A record for another environment (a reset or replaced node) is
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
  // Anchors left in this session stay; saved ones fill in behind them.
  if (record.readingPositions)
    threadReadingPositions.restore(Object.entries(record.readingPositions));
  if (useStore.getState().environmentStateById[input.environmentId] !== undefined) return false;
  const shell = workspaceMetadataToCachedShellSnapshot(record.snapshot);
  const content = record.content;
  useStore.getState().hydrateEnvironmentStateFromCache(
    content === undefined
      ? shell
      : {
          ...shell,
          // The rows are this projection's own, so the content goes onto them.
          threads: shell.threads.map((thread) =>
            Object.hasOwn(content, thread.shell.id)
              ? Object.assign(thread, { content: content[thread.shell.id] })
              : thread,
          ),
        },
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
 * Keeps the cache current while the page lives (see `primaryShellCacheWriter`,
 * loaded here so the paint above does not wait for it). Returns a stop function.
 */
export function startPrimaryShellCachePersistence(input: PrimaryShellCacheWriterInput): () => void {
  let stopWriter: (() => void) | null = null;
  let stopped = false;
  void import("./primaryShellCacheWriter")
    .then((writer) => {
      if (!stopped) stopWriter = writer.startPrimaryShellCacheWriter(input);
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stopWriter?.();
  };
}
