// §6 checkpoint-diff cache. Mirrors apps/web/src/rpc/providerAtoms.ts verbatim
// (first-party Ryco code) over B1's single appAtomRegistry — the ref-counted,
// generation-fenced keyed-query layer with staleTime-Infinity semantics and the
// checkpoint retry policy (12 retries when not-ready, else 3). Only the
// environmentApi import path differs; requests route through ensureEnvironmentApi.
import {
  type EnvironmentId,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult,
  type ThreadId,
} from "@ryco/contracts";
import { Option, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { cachedPayloadBytes } from "../persistence/cacheSize";
import { ensureEnvironmentApi } from "../connection/environmentApi";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";

export interface CheckpointDiffInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
  readonly cacheScope?: string | null;
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

/**
 * Single attempt at resolving a checkpoint diff. Throws the raw provider error
 * so the retry loop can classify it; final normalization happens in the loop.
 */
export async function executeCheckpointDiffRequest(
  input: CheckpointDiffInput,
): Promise<OrchestrationGetTurnDiffResult> {
  const decoded = decodeCheckpointDiffRequest(input);
  if (!input.environmentId || !input.threadId || Option.isNone(decoded)) {
    throw new Error("Checkpoint diff is unavailable.");
  }

  const api = ensureEnvironmentApi(input.environmentId);
  if (decoded.value.kind === "fullThreadDiff") {
    return await api.orchestration.getFullThreadDiff(decoded.value.input);
  }
  return await api.orchestration.getTurnDiff(decoded.value.input);
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
export const DISABLED_CHECKPOINT_DIFF_ATOM = Atom.make(DISABLED_CHECKPOINT_DIFF_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("checkpoint-diff:disabled"),
);

const knownCheckpointDiffKeys = new Set<string>();

export const checkpointDiffStateAtom = Atom.family((key: string) => {
  knownCheckpointDiffKeys.add(key);
  return Atom.make(LOADING_CHECKPOINT_DIFF_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`checkpoint-diff:${key}`),
  );
});

interface CheckpointDiffEntry {
  readonly key: string;
  readonly input: CheckpointDiffInput;
  readonly threadId: ThreadId;
  refCount: number;
  generation: number;
  hasResolved: boolean;
  fetching: boolean;
}

const checkpointDiffEntries = new Map<string, CheckpointDiffEntry>();
const checkpointDiffKeysByThread = new Map<ThreadId, Set<string>>();

const NOOP: () => void = () => undefined;

function setCheckpointDiffState(key: string, state: CheckpointDiffState): void {
  appAtomRegistry.set(checkpointDiffStateAtom(key), state);
}

function getCheckpointDiffState(key: string): CheckpointDiffState {
  return appAtomRegistry.get(checkpointDiffStateAtom(key));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

export function watchCheckpointDiff(input: CheckpointDiffInput): () => void {
  if (!isCheckpointDiffEnabled(input) || input.threadId === null) {
    return NOOP;
  }

  const key = checkpointDiffCacheKey(input);
  knownCheckpointDiffKeys.add(key);
  let entry = checkpointDiffEntries.get(key);
  if (!entry) {
    entry = {
      key,
      input,
      threadId: input.threadId,
      refCount: 0,
      generation: 0,
      hasResolved: false,
      fetching: false,
    };
    checkpointDiffEntries.set(key, entry);
    registerCheckpointDiffKeyForThread(input.threadId, key);
  }

  entry.refCount += 1;
  if (!entry.hasResolved && !entry.fetching) {
    startCheckpointDiffFetch(entry);
  }

  return () => {
    const current = checkpointDiffEntries.get(key);
    if (!current) {
      return;
    }
    current.refCount = Math.max(0, current.refCount - 1);
  };
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

export function invalidateCheckpointDiff(threadId: ThreadId): void {
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

export function invalidateAllCheckpointDiffs(): void {
  for (const entry of checkpointDiffEntries.values()) {
    invalidateCheckpointDiffEntry(entry);
  }
}

export function clearCheckpointDiffState(): void {
  for (const entry of checkpointDiffEntries.values()) {
    entry.generation += 1;
  }
  checkpointDiffEntries.clear();
  checkpointDiffKeysByThread.clear();
  for (const key of knownCheckpointDiffKeys) {
    setCheckpointDiffState(key, LOADING_CHECKPOINT_DIFF_STATE);
  }
  knownCheckpointDiffKeys.clear();
}

export const resetCheckpointDiffStateForTests = clearCheckpointDiffState;

export function checkpointDiffCacheBytes(environmentId: EnvironmentId): number {
  let bytes = 0;
  for (const key of knownCheckpointDiffKeys) {
    if (
      JSON.parse(key)[0] === environmentId &&
      (checkpointDiffEntries.get(key)?.refCount ?? 0) === 0
    )
      bytes += cachedPayloadBytes(getCheckpointDiffState(key).data);
  }
  return bytes;
}
export function clearCheckpointDiffCacheForEnvironment(environmentId: EnvironmentId): void {
  for (const key of knownCheckpointDiffKeys) {
    if (JSON.parse(key)[0] !== environmentId) continue;
    const entry = checkpointDiffEntries.get(key);
    if (entry && entry.refCount > 0) continue;
    if (entry) {
      entry.generation += 1;
      checkpointDiffEntries.delete(key);
      const threadKeys = checkpointDiffKeysByThread.get(entry.threadId);
      threadKeys?.delete(key);
      if (threadKeys?.size === 0) checkpointDiffKeysByThread.delete(entry.threadId);
    }
    setCheckpointDiffState(key, LOADING_CHECKPOINT_DIFF_STATE);
    knownCheckpointDiffKeys.delete(key);
  }
}
