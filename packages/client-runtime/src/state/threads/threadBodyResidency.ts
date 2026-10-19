import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";

import { planEvictionsToCapacity } from "../../connection/evictionPolicy.ts";
import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import type { AppState, EnvironmentState } from "./store.ts";
import { fullThreadEntry, isArchivedThreadStub, type ChatMessage } from "./types.ts";

/**
 * Bounded retention of loaded thread bodies (messages, activities, proposed
 * plans, turn diffs, history pages). The store keeps every body a thread
 * subscription ever delivered; this module decides which of them to drop once
 * the store holds more than a budget of threads or bytes, and answers whether a
 * thread is busy enough to keep. Shells, sessions, turn state and sidebar
 * summaries are not bodies and are never part of this budget.
 */

/** The most thread bodies the store keeps before the least recently used go. */
export const THREAD_BODY_MAX_THREADS = 64;
/** The estimated bytes of thread bodies the store keeps before the least recently used go. */
export const THREAD_BODY_MAX_BYTES = 48 * 1024 * 1024;
/**
 * A thread of the active environment accessed this recently keeps its body, so
 * switching away from an environment and back renders its latest threads at once.
 * The window is only checked when a pass runs (after a subscription is disposed
 * or a snapshot lands), so a burst of threads opened inside it can leave the
 * store over budget until the idle sweep disposes their subscriptions.
 */
export const THREAD_BODY_RECENT_ACCESS_MS = 5 * 60 * 1000;
/** Fixed per-message overhead (ids, timestamps, envelope) on top of its text. */
const MESSAGE_ROW_OVERHEAD_BYTES = 256;

function ownEntry<K extends string, V>(
  record: Readonly<Record<K, V>> | undefined,
  key: K,
): V | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function isLiveSessionStatus(status: string | undefined): boolean {
  return Boolean(status) && status !== "idle" && status !== "stopped";
}

/**
 * Whether a thread has work that must not lose its body or its subscription:
 * pending approvals or user input, an actionable proposed plan, a session that
 * is not idle or stopped, a running latest turn, or a pending source proposed
 * plan. Reads the shell, summary, session and turn records directly, never
 * composing the thread's content.
 */
export function isThreadNonIdle(state: AppState, ref: ScopedThreadRef): boolean {
  const environmentState = ownEntry(state.environmentStateById, ref.environmentId);
  if (environmentState === undefined) return false;
  const { threadId } = ref;

  // An archived stub knows of no pending work; once loaded, its full summary does.
  const summary = fullThreadEntry(ownEntry(environmentState.sidebarThreadSummaryById, threadId));
  // The summary carries the coarse readiness flags used throughout the UI.
  if (summary) {
    if (
      summary.hasPendingApprovals ||
      summary.hasPendingUserInput ||
      summary.hasActionableProposedPlan
    ) {
      return true;
    }
    if (isLiveSessionStatus(summary.session?.orchestrationStatus)) return true;
    if (summary.latestTurn?.state === "running") return true;
  }

  const shell = ownEntry(environmentState.threadShellById, threadId);
  if (shell === undefined || isArchivedThreadStub(shell)) return false;
  const turnState = ownEntry(environmentState.threadTurnStateById, threadId);
  return (
    isLiveSessionStatus(
      ownEntry(environmentState.threadSessionById, threadId)?.orchestrationStatus,
    ) ||
    turnState?.latestTurn?.state === "running" ||
    turnState?.pendingSourceProposedPlan !== undefined
  );
}

/**
 * The content of a composer draft the user has typed or attached. A draft entry
 * also keeps per-thread composer settings (model, runtime and interaction mode)
 * that outlive a send, so an entry existing says nothing about unsent content.
 */
export interface ComposerDraftContent {
  readonly prompt: string;
  readonly images: ReadonlyArray<unknown>;
  readonly persistedAttachments: ReadonlyArray<unknown>;
  readonly terminalContexts: ReadonlyArray<unknown>;
  readonly sourceControlContexts: ReadonlyArray<unknown>;
}

/** Whether a composer draft holds content that has not been sent. */
export function hasComposerDraftContent(draft: ComposerDraftContent): boolean {
  return (
    draft.prompt.length > 0 ||
    draft.images.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.sourceControlContexts.length > 0
  );
}

/**
 * Work a thread holds that exists nowhere else yet: sends not delivered, or
 * composer content not sent. A draft holding only composer settings is not.
 */
export function hasUnsentThreadWork(
  ref: ScopedThreadRef,
  stores: {
    /** Per thread key: sends queued or in flight. */
    readonly queuesByThreadKey: Readonly<Record<string, ReadonlyArray<unknown> | undefined>>;
    /** Per thread key: the composer draft. */
    readonly draftsByThreadKey: Readonly<Record<string, ComposerDraftContent | undefined>>;
  },
): boolean {
  const key = scopedThreadKey(ref);
  if ((ownEntry(stores.queuesByThreadKey, key)?.length ?? 0) > 0) return true;
  const draft = ownEntry(stores.draftsByThreadKey, key);
  return draft !== undefined && hasComposerDraftContent(draft);
}

/** One thread whose body the store holds. */
export interface ThreadBodyUsage {
  readonly ref: ScopedThreadRef;
  /** An estimate of the body's memory, from message text only. */
  readonly bytes: number;
  /** Whether the thread's environment is the store's active one. */
  readonly environmentActive: boolean;
  /** When the thread last saw activity (epoch ms), 0 when its summary says nothing. */
  readonly lastActivityAt: number;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The later of a thread's last update and its last user message, from its summary. */
function selectThreadActivityAt(environmentState: EnvironmentState, threadId: ThreadId): number {
  const summary = ownEntry(environmentState.sidebarThreadSummaryById, threadId);
  return summary === undefined
    ? 0
    : Math.max(parseTimestamp(summary.updatedAt), parseTimestamp(summary.latestUserMessageAt));
}

// A message slice is replaced, never mutated, once published, so the sum over
// it is computed once per slice however often the budget is checked.
const messageBytesBySlice = new WeakMap<object, number>();

function messageSliceBytes(messages: Readonly<Record<string, ChatMessage>>): number {
  let bytes = messageBytesBySlice.get(messages);
  if (bytes === undefined) {
    bytes = 0;
    for (const message of Object.values(messages)) {
      bytes += message.text.length + MESSAGE_ROW_OVERHEAD_BYTES;
    }
    messageBytesBySlice.set(messages, bytes);
  }
  return bytes;
}

/** The ids of the threads an environment holds any body content for. */
function selectThreadIdsWithBodies(environmentState: EnvironmentState): Set<ThreadId> {
  const threadIds = new Set<ThreadId>();
  for (const record of [
    environmentState.messageByThreadId,
    environmentState.activityByThreadId,
    environmentState.proposedPlanByThreadId,
    environmentState.turnDiffSummaryByThreadId,
    environmentState.pendingMessagesByThreadId,
  ]) {
    for (const threadId of Object.keys(record)) threadIds.add(threadId as ThreadId);
  }
  return threadIds;
}

/** Every thread the store holds a body for, across environments, with its estimated size. */
export function selectThreadBodyUsage(state: AppState): ThreadBodyUsage[] {
  const usage: ThreadBodyUsage[] = [];
  for (const [environmentId, environmentState] of Object.entries(state.environmentStateById)) {
    const environmentActive = state.activeEnvironmentId === environmentId;
    for (const threadId of selectThreadIdsWithBodies(environmentState)) {
      const messages = ownEntry(environmentState.messageByThreadId, threadId);
      usage.push({
        ref: scopeThreadRef(environmentId as EnvironmentId, threadId),
        bytes: messages === undefined ? 0 : messageSliceBytes(messages),
        environmentActive,
        lastActivityAt: selectThreadActivityAt(environmentState, threadId),
      });
    }
  }
  return usage;
}

export interface ThreadBodyResidencyEntry {
  readonly ref: ScopedThreadRef;
  readonly bytes: number;
  /** Zero for a body no subscription ever delivered, which ranks before any accessed one. */
  readonly lastAccessedAt: number;
  /** Breaks ties between equally recently accessed bodies: the more recently active thread stays. */
  readonly lastActivityAt?: number;
  /** Retained, visible, busy, or holding unsent work: never planned away. */
  readonly protected: boolean;
}

/**
 * The bodies to drop so the store stays within `maxThreads` bodies and
 * `maxBytes`: the least recently accessed unprotected threads first, the less
 * recently active first among equal access times. Protected threads count
 * toward both limits but are never returned, so the limits can stay exceeded
 * while everything left is protected. They count toward the byte limit too, so
 * a few large busy bodies can leave no room for idle ones: the budget bounds
 * the store's memory, not only its idle part.
 */
export function planThreadBodyEvictions(input: {
  readonly entries: ReadonlyArray<ThreadBodyResidencyEntry>;
  readonly maxThreads?: number;
  readonly maxBytes?: number;
}): ScopedThreadRef[] {
  // The shared policy keeps the order of entries it ranks equal.
  const ranked = input.entries.toSorted(
    (left, right) =>
      left.lastAccessedAt - right.lastAccessedAt ||
      (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0),
  );
  return planEvictionsToCapacity(
    ranked.map((entry) => ({
      key: entry.ref,
      lastAccessedAt: entry.lastAccessedAt,
      retainedBytes: entry.bytes,
      evictable: !entry.protected,
    })),
    {
      maxEntries: input.maxThreads ?? THREAD_BODY_MAX_THREADS,
      maxBytes: input.maxBytes ?? THREAD_BODY_MAX_BYTES,
    },
  );
}
