import type { EnvironmentApi, EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult,
} from "@ryco/contracts/orchestration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Atom from "effect/reactivity/Atom";

import { appAtomRegistry } from "./atomRegistry.ts";

export interface CheckpointDiffInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
  readonly cacheScope?: string | null;
  /**
   * Keys in the same slot (per environment, thread and whitespace mode)
   * supersede each other: once a newer key of the slot is watched, older keys
   * are dropped as soon as nothing watches them. A full-conversation view uses
   * this because every completed turn produces a new full-range key.
   */
  readonly cacheSlot?: string | null;
  readonly enabled?: boolean;
}

export interface CheckpointDiffState {
  readonly data: OrchestrationGetTurnDiffResult | null;
  readonly error: Error | null;
  readonly isLoading: boolean;
}

type DecodedCheckpointDiffRequest =
  | { readonly kind: "fullThreadDiff"; readonly input: OrchestrationGetFullThreadDiffInput }
  | { readonly kind: "turnDiff"; readonly input: OrchestrationGetTurnDiffInput };

/**
 * Stable cache key for a checkpoint diff request. `cacheScope` and
 * `ignoreWhitespace` are included so reused turn counts and whitespace-hidden
 * diffs never collide in the cache (matching the previous React Query keys).
 */
export function checkpointDiffCacheKey(input: CheckpointDiffInput): string {
  return JSON.stringify([
    input.environmentId ?? null,
    input.threadId,
    input.fromTurnCount,
    input.toTurnCount,
    input.ignoreWhitespace,
    input.cacheScope ?? null,
  ]);
}

export function decodeCheckpointDiffRequest(
  input: CheckpointDiffInput,
): Option.Option<DecodedCheckpointDiffRequest> {
  if (input.fromTurnCount === 0) {
    return Schema.decodeUnknownOption(OrchestrationGetFullThreadDiffInput)({
      threadId: input.threadId,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace: input.ignoreWhitespace,
    }).pipe(Option.map((fields) => ({ kind: "fullThreadDiff" as const, input: fields })));
  }

  return Schema.decodeUnknownOption(OrchestrationGetTurnDiffInput)({
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    ignoreWhitespace: input.ignoreWhitespace,
  }).pipe(Option.map((fields) => ({ kind: "turnDiff" as const, input: fields })));
}

export function isCheckpointDiffEnabled(input: CheckpointDiffInput): boolean {
  return (
    (input.enabled ?? true) &&
    !!input.environmentId &&
    !!input.threadId &&
    Option.isSome(decodeCheckpointDiffRequest(input))
  );
}

function asCheckpointErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

export function normalizeCheckpointErrorMessage(error: unknown): string {
  const message = asCheckpointErrorMessage(error).trim();
  if (message.length === 0) {
    return "Failed to load checkpoint diff.";
  }

  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return "Turn diffs are unavailable because this project is not a git repository.";
  }

  if (
    lower.includes("checkpoint unavailable for thread") ||
    lower.includes("checkpoint invariant violation")
  ) {
    const separatorIndex = message.indexOf(":");
    if (separatorIndex >= 0) {
      const detail = message.slice(separatorIndex + 1).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
  }

  return message;
}

export function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    message.includes("checkpoint is unavailable for turn") ||
    message.includes("filesystem checkpoint is unavailable")
  );
}

/**
 * Retry policy preserved from the previous React Query implementation:
 * checkpoint-not-ready errors retry far longer than generic failures.
 */
export function shouldRetryCheckpointDiff(failureCount: number, error: unknown): boolean {
  if (isCheckpointTemporarilyUnavailable(error)) {
    return failureCount < 12;
  }
  return failureCount < 3;
}

export function checkpointDiffRetryDelay(attempt: number, error: unknown): number {
  return isCheckpointTemporarilyUnavailable(error)
    ? Math.min(5_000, 250 * 2 ** (attempt - 1))
    : Math.min(1_000, 100 * 2 ** (attempt - 1));
}

const IDLE_CHECKPOINT_DIFF_STATE = Object.freeze<CheckpointDiffState>({
  data: null,
  error: null,
  isLoading: false,
});
const LOADING_CHECKPOINT_DIFF_STATE = Object.freeze<CheckpointDiffState>({
  data: null,
  error: null,
  isLoading: true,
});

export const DISABLED_CHECKPOINT_DIFF_STATE = IDLE_CHECKPOINT_DIFF_STATE;

type CheckpointDiffOrchestrationApi = Pick<
  EnvironmentApi["orchestration"],
  "getFullThreadDiff" | "getTurnDiff"
>;

export interface CheckpointDiffStoreOptions {
  /** The orchestration API of a connected environment; throws when there is none. */
  readonly resolveOrchestrationApi: (
    environmentId: EnvironmentId,
  ) => CheckpointDiffOrchestrationApi;
  /**
   * Unwatched entries stay cached so re-opening a recent diff is instant, but
   * a patch can reach 10 MB, so the inactive set is bounded by count and by
   * retained patch characters. Watched entries are never evicted.
   */
  readonly maxInactiveEntries: number;
  readonly maxInactiveChars: number;
}

export interface CheckpointDiffStore {
  readonly checkpointDiffStateAtom: (key: string) => Atom.Writable<CheckpointDiffState>;
  /** Single attempt at resolving a diff; throws the raw error for the retry loop. */
  readonly executeCheckpointDiffRequest: (
    input: CheckpointDiffInput,
  ) => Promise<OrchestrationGetTurnDiffResult>;
  /** Retains a diff (fetching it when needed) until the returned release runs. */
  readonly watchCheckpointDiff: (input: CheckpointDiffInput) => () => void;
  /**
   * Drops every cached diff of a thread (archived or removed). Diffs still on
   * screen are dropped when their last watcher releases them.
   */
  readonly evictCheckpointDiffsForThread: (threadId: ThreadId) => void;
  readonly invalidateCheckpointDiff: (threadId: ThreadId) => void;
  readonly invalidateAllCheckpointDiffs: () => void;
  /** Drops every unwatched diff of one environment; watched ones stay. */
  readonly clearUnwatchedCheckpointDiffsForEnvironment: (environmentId: EnvironmentId) => void;
  /** The resolved results of one environment's unwatched entries (cache-usage accounting). */
  readonly readUnwatchedCheckpointDiffResults: (
    environmentId: EnvironmentId,
  ) => ReadonlyArray<OrchestrationGetTurnDiffResult>;
  readonly clearCheckpointDiffState: () => void;
}

interface CheckpointDiffEntry {
  readonly key: string;
  readonly input: CheckpointDiffInput;
  readonly threadId: ThreadId;
  readonly slotKey: string | null;
  refCount: number;
  generation: number;
  hasResolved: boolean;
  fetching: boolean;
  /** Drop the entry once its last watcher releases it (thread archived while viewed). */
  evictOnRelease: boolean;
}

function checkpointDiffSlotKey(input: CheckpointDiffInput): string | null {
  if (!input.cacheSlot) {
    return null;
  }
  return JSON.stringify([
    input.environmentId ?? null,
    input.threadId,
    input.ignoreWhitespace,
    input.cacheSlot,
  ]);
}

const NOOP: () => void = () => undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * The checkpoint-diff cache over the app atom registry: a ref-counted,
 * generation-fenced keyed query with staleTime-Infinity semantics, the
 * checkpoint retry policy, a bounded LRU of unwatched entries, slot
 * supersession, and per-thread eviction. Each app builds one store over its
 * own environment API lookup.
 */
export function createCheckpointDiffStore(
  options: CheckpointDiffStoreOptions,
): CheckpointDiffStore {
  const knownCheckpointDiffKeys = new Set<string>();

  const checkpointDiffStateAtom = Atom.family((key: string) => {
    knownCheckpointDiffKeys.add(key);
    return Atom.make<CheckpointDiffState>(LOADING_CHECKPOINT_DIFF_STATE).pipe(
      Atom.keepAlive,
      Atom.withLabel(`checkpoint-diff:${key}`),
    );
  });

  const checkpointDiffEntries = new Map<string, CheckpointDiffEntry>();
  const checkpointDiffKeysByThread = new Map<ThreadId, Set<string>>();
  /** Insertion-ordered: the first key is the least recently released. */
  const inactiveCheckpointDiffKeys = new Set<string>();
  const latestCheckpointDiffKeyBySlot = new Map<string, string>();

  function setCheckpointDiffState(key: string, state: CheckpointDiffState): void {
    appAtomRegistry.set(checkpointDiffStateAtom(key), state);
  }

  function getCheckpointDiffState(key: string): CheckpointDiffState {
    return appAtomRegistry.get(checkpointDiffStateAtom(key));
  }

  async function executeCheckpointDiffRequest(
    input: CheckpointDiffInput,
  ): Promise<OrchestrationGetTurnDiffResult> {
    const decoded = decodeCheckpointDiffRequest(input);
    if (!input.environmentId || !input.threadId || Option.isNone(decoded)) {
      throw new Error("Checkpoint diff is unavailable.");
    }

    const api = options.resolveOrchestrationApi(input.environmentId);
    if (decoded.value.kind === "fullThreadDiff") {
      return await api.getFullThreadDiff(decoded.value.input);
    }
    return await api.getTurnDiff(decoded.value.input);
  }

  function startCheckpointDiffFetch(entry: CheckpointDiffEntry): void {
    const generation = ++entry.generation;
    entry.fetching = true;
    const current = getCheckpointDiffState(entry.key);
    // Background refetches keep the previously resolved diff visible (staleTime
    // Infinity semantics); only the initial load reports isLoading.
    setCheckpointDiffState(entry.key, {
      data: current.data,
      error: null,
      isLoading: current.data === null,
    });

    void (async () => {
      let failureCount = 0;
      while (true) {
        try {
          const result = await executeCheckpointDiffRequest(entry.input);
          if (entry.generation !== generation) {
            return;
          }
          entry.fetching = false;
          entry.hasResolved = true;
          setCheckpointDiffState(entry.key, { data: result, error: null, isLoading: false });
          // A fetch can outlive its last watcher; the late patch counts against
          // the inactive budget like any other unwatched entry.
          if (entry.refCount === 0) {
            enforceInactiveCheckpointDiffBudget();
          }
          return;
        } catch (rawError) {
          const normalized = new Error(normalizeCheckpointErrorMessage(rawError), {
            cause: rawError,
          });
          failureCount += 1;
          if (entry.generation !== generation) {
            return;
          }
          if (!shouldRetryCheckpointDiff(failureCount, normalized)) {
            entry.fetching = false;
            setCheckpointDiffState(entry.key, { data: null, error: normalized, isLoading: false });
            return;
          }
          await sleep(checkpointDiffRetryDelay(failureCount, normalized));
          if (entry.generation !== generation) {
            return;
          }
        }
      }
    })();
  }

  function registerCheckpointDiffKeyForThread(threadId: ThreadId, key: string): void {
    const existing = checkpointDiffKeysByThread.get(threadId);
    if (existing) {
      existing.add(key);
      return;
    }
    checkpointDiffKeysByThread.set(threadId, new Set([key]));
  }

  function retainedCheckpointDiffChars(key: string): number {
    return getCheckpointDiffState(key).data?.diff.length ?? 0;
  }

  function evictCheckpointDiffEntry(entry: CheckpointDiffEntry): void {
    // Cancel in-flight work so a late response cannot repopulate the atom.
    entry.generation += 1;
    entry.fetching = false;
    checkpointDiffEntries.delete(entry.key);
    inactiveCheckpointDiffKeys.delete(entry.key);
    const threadKeys = checkpointDiffKeysByThread.get(entry.threadId);
    threadKeys?.delete(entry.key);
    if (threadKeys?.size === 0) {
      checkpointDiffKeysByThread.delete(entry.threadId);
    }
    if (entry.slotKey !== null && latestCheckpointDiffKeyBySlot.get(entry.slotKey) === entry.key) {
      latestCheckpointDiffKeyBySlot.delete(entry.slotKey);
    }
    // Releases the patch string. The atom reads exactly like a never-fetched
    // key, so a later watch shows its loading state rather than an empty diff.
    knownCheckpointDiffKeys.delete(entry.key);
    setCheckpointDiffState(entry.key, LOADING_CHECKPOINT_DIFF_STATE);
  }

  function enforceInactiveCheckpointDiffBudget(): void {
    let retainedChars = 0;
    for (const key of inactiveCheckpointDiffKeys) {
      retainedChars += retainedCheckpointDiffChars(key);
    }
    for (const key of inactiveCheckpointDiffKeys) {
      if (
        inactiveCheckpointDiffKeys.size <= options.maxInactiveEntries &&
        retainedChars <= options.maxInactiveChars
      ) {
        return;
      }
      const entry = checkpointDiffEntries.get(key);
      retainedChars -= retainedCheckpointDiffChars(key);
      if (entry) {
        evictCheckpointDiffEntry(entry);
      } else {
        inactiveCheckpointDiffKeys.delete(key);
      }
    }
  }

  function isSupersededCheckpointDiffEntry(entry: CheckpointDiffEntry): boolean {
    if (entry.slotKey === null) {
      return false;
    }
    const latestKey = latestCheckpointDiffKeyBySlot.get(entry.slotKey);
    return latestKey !== undefined && latestKey !== entry.key;
  }

  function releaseCheckpointDiffEntry(entry: CheckpointDiffEntry): void {
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) {
      return;
    }
    if (entry.evictOnRelease || isSupersededCheckpointDiffEntry(entry)) {
      evictCheckpointDiffEntry(entry);
      return;
    }
    inactiveCheckpointDiffKeys.delete(entry.key);
    inactiveCheckpointDiffKeys.add(entry.key);
    enforceInactiveCheckpointDiffBudget();
  }

  function supersedeCheckpointDiffSlot(entry: CheckpointDiffEntry): void {
    if (entry.slotKey === null) {
      return;
    }
    latestCheckpointDiffKeyBySlot.set(entry.slotKey, entry.key);
    const threadKeys = checkpointDiffKeysByThread.get(entry.threadId);
    if (!threadKeys) {
      return;
    }
    // Deleting the visited key from a Set during iteration is safe.
    for (const key of threadKeys) {
      const candidate = checkpointDiffEntries.get(key);
      if (
        candidate &&
        candidate !== entry &&
        candidate.slotKey === entry.slotKey &&
        candidate.refCount === 0
      ) {
        evictCheckpointDiffEntry(candidate);
      }
    }
  }

  function watchCheckpointDiff(input: CheckpointDiffInput): () => void {
    if (!isCheckpointDiffEnabled(input) || input.threadId === null) {
      return NOOP;
    }

    const key = checkpointDiffCacheKey(input);
    let entry = checkpointDiffEntries.get(key);
    if (!entry) {
      entry = {
        key,
        input,
        threadId: input.threadId,
        slotKey: checkpointDiffSlotKey(input),
        refCount: 0,
        generation: 0,
        hasResolved: false,
        fetching: false,
        evictOnRelease: false,
      };
      checkpointDiffEntries.set(key, entry);
      knownCheckpointDiffKeys.add(key);
      registerCheckpointDiffKeyForThread(input.threadId, key);
    }

    entry.refCount += 1;
    inactiveCheckpointDiffKeys.delete(key);
    supersedeCheckpointDiffSlot(entry);
    if (!entry.hasResolved && !entry.fetching) {
      startCheckpointDiffFetch(entry);
    }

    const watchedEntry = entry;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      // An entry evicted meanwhile (environment reset) is no longer tracked.
      if (checkpointDiffEntries.get(key) !== watchedEntry) {
        return;
      }
      releaseCheckpointDiffEntry(watchedEntry);
    };
  }

  function evictCheckpointDiffsForThread(threadId: ThreadId): void {
    const keys = checkpointDiffKeysByThread.get(threadId);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      const entry = checkpointDiffEntries.get(key);
      if (!entry) {
        continue;
      }
      if (entry.refCount > 0) {
        entry.evictOnRelease = true;
        continue;
      }
      evictCheckpointDiffEntry(entry);
    }
  }

  function invalidateCheckpointDiffEntry(entry: CheckpointDiffEntry): void {
    entry.hasResolved = false;
    if (entry.refCount > 0) {
      startCheckpointDiffFetch(entry);
      return;
    }
    // No active observers: cancel any in-flight work so a future watch refetches.
    entry.generation += 1;
    entry.fetching = false;
  }

  function invalidateCheckpointDiff(threadId: ThreadId): void {
    const keys = checkpointDiffKeysByThread.get(threadId);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      const entry = checkpointDiffEntries.get(key);
      if (entry) {
        invalidateCheckpointDiffEntry(entry);
      }
    }
  }

  function invalidateAllCheckpointDiffs(): void {
    for (const entry of checkpointDiffEntries.values()) {
      invalidateCheckpointDiffEntry(entry);
    }
  }

  function clearUnwatchedCheckpointDiffsForEnvironment(environmentId: EnvironmentId): void {
    // Deleting the visited entry from a Map during iteration is safe.
    for (const entry of checkpointDiffEntries.values()) {
      if (entry.input.environmentId === environmentId && entry.refCount === 0) {
        evictCheckpointDiffEntry(entry);
      }
    }
  }

  function readUnwatchedCheckpointDiffResults(
    environmentId: EnvironmentId,
  ): ReadonlyArray<OrchestrationGetTurnDiffResult> {
    const results: OrchestrationGetTurnDiffResult[] = [];
    for (const entry of checkpointDiffEntries.values()) {
      if (entry.input.environmentId !== environmentId || entry.refCount > 0) continue;
      const data = getCheckpointDiffState(entry.key).data;
      if (data !== null) results.push(data);
    }
    return results;
  }

  function clearCheckpointDiffState(): void {
    for (const entry of checkpointDiffEntries.values()) {
      entry.generation += 1;
    }
    checkpointDiffEntries.clear();
    checkpointDiffKeysByThread.clear();
    inactiveCheckpointDiffKeys.clear();
    latestCheckpointDiffKeyBySlot.clear();
    for (const key of knownCheckpointDiffKeys) {
      setCheckpointDiffState(key, LOADING_CHECKPOINT_DIFF_STATE);
    }
    knownCheckpointDiffKeys.clear();
  }

  return {
    checkpointDiffStateAtom,
    executeCheckpointDiffRequest,
    watchCheckpointDiff,
    evictCheckpointDiffsForThread,
    invalidateCheckpointDiff,
    invalidateAllCheckpointDiffs,
    clearUnwatchedCheckpointDiffsForEnvironment,
    readUnwatchedCheckpointDiffResults,
    clearCheckpointDiffState,
  };
}
