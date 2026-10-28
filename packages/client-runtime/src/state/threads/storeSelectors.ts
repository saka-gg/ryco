import {
  type EnvironmentId,
  type MessageId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type WorktreeId,
} from "@ryco/contracts";
import { RuntimeSessionId } from "@ryco/contracts/base-schemas";
import type { SidebarThreadSortOrder } from "@ryco/contracts/settings";
import type { ClaudeCacheReviewThread } from "@ryco/shared/claudeCacheReview";
import { sortThreads, type ThreadSortInput } from "./threadSort.ts";
import {
  selectEnvironmentState,
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  type AppState,
  type EnvironmentState,
} from "./store.ts";
import {
  fullThreadEntry,
  type ChatMessage,
  type Project,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
  type SidebarWorktreeSummary,
  type Thread,
  type ThreadShellOrStub,
} from "./types.ts";
import { getThreadFromEnvironmentState } from "./threadDerivation.ts";

export function createProjectSelectorByRef(
  ref: ScopedProjectRef | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) =>
    ref ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId] : undefined;
}

/**
 * A thread's worktree summary (branch, linked change request), when it has
 * one. Threads carry the worktree id unbranded, hence the plain string.
 */
export function createWorktreeSelector(
  environmentId: EnvironmentId | null | undefined,
  worktreeId: string | null | undefined,
): (state: AppState) => SidebarWorktreeSummary | null {
  return (state) =>
    environmentId && worktreeId
      ? (selectEnvironmentState(state, environmentId).worktreeById?.[worktreeId as WorktreeId] ??
        null)
      : null;
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadFromEnvironmentState(environmentState, ref.threadId);
    return previousThread;
  };
}

export function createThreadSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector(() => ref);
}

export function createThreadSelectorAcrossEnvironments(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector((state) => {
    if (!threadId) {
      return undefined;
    }

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[ScopedThreadRef["environmentId"], EnvironmentState]>) {
      if (environmentState.threadShellById[threadId]) {
        return {
          environmentId,
          threadId,
        };
      }
    }
    return undefined;
  });
}

/**
 * True when `previous` and `next` hold the same value (by reference) under every
 * own key except those `skip` accepts, keys present in only one of them included.
 * Listing no fields keeps a field added later structural by default.
 */
function sameFieldsExcept(previous: object, next: object, skip: (key: string) => boolean): boolean {
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  for (const key of Object.keys(nextRecord)) {
    if (!skip(key) && previousRecord[key] !== nextRecord[key]) return false;
  }
  for (const key of Object.keys(previousRecord)) {
    if (!skip(key) && previousRecord[key] !== nextRecord[key]) return false;
  }
  return true;
}

const isUpdatedAtKey = (key: string): boolean => key === "updatedAt";
const isUpdatedAtOrMessagesKey = (key: string): boolean =>
  key === "updatedAt" || key === "messages";
const isTextKey = (key: string): boolean => key === "text";

/**
 * Two versions of one assistant message that streamed text in both. An empty
 * message can render differently from one with text (the timeline stands in a
 * placeholder for a blank reply), so its first text is structure, and so is the
 * end of its stream.
 */
function sameMessageApartFromStreamedText(previous: ChatMessage, next: ChatMessage): boolean {
  return (
    previous.role === "assistant" &&
    previous.streaming &&
    next.streaming &&
    previous.text !== "" &&
    next.text !== "" &&
    Object.keys(previous).length === Object.keys(next).length &&
    sameFieldsExcept(previous, next, isTextKey)
  );
}

/**
 * True when `next` differs from `previous` only in the text of assistant
 * messages that were already streaming with text and still stream, plus the
 * shell's `updatedAt`. Every other field is compared by reference: the reducer
 * keeps the identity of everything a delta does not touch. An empty message can
 * render differently from one with text, so the first text of a message, and
 * the end of its stream, always count as structure.
 */
export function threadDiffersOnlyInStreamedText(previous: Thread, next: Thread): boolean {
  if (previous === next) return true;
  if (!sameFieldsExcept(previous, next, isUpdatedAtOrMessagesKey)) return false;
  const previousMessages = previous.messages;
  const nextMessages = next.messages;
  if (previousMessages === nextMessages) return true;
  if (previousMessages.length !== nextMessages.length) return false;
  for (let index = 0; index < nextMessages.length; index += 1) {
    const previousMessage = previousMessages[index]!;
    const nextMessage = nextMessages[index]!;
    if (
      previousMessage !== nextMessage &&
      !sameMessageApartFromStreamedText(previousMessage, nextMessage)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The thread as `createThreadSelectorByRef` composes it, except that it keeps
 * returning the previous value while only streamed text grows or only the
 * shell's `updatedAt` moves (see `threadDiffersOnlyInStreamedText`). A
 * streaming message in the returned thread carries the text of the thread's
 * last structural change: read the text it shows through
 * `selectThreadMessageText`. Use it only where message text and the thread's
 * `updatedAt` are not read; the moment anything else changes it returns the
 * newest thread, current text included.
 */
export function createThreadStructureSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return holdWhileEquivalent(createThreadSelectorByRef(ref), threadDiffersOnlyInStreamedText);
}

/**
 * `selectLive`, except that it keeps returning the value it last returned
 * while `isEquivalent(held, live)` holds. It compares with the held value, not
 * the previous live one: after many small changes the held value is still what
 * subscribers last rendered. A missing value (undefined) drops the hold, so a
 * value that comes back is returned as it is.
 */
function holdWhileEquivalent<T extends object>(
  selectLive: (state: AppState) => T | undefined,
  isEquivalent: (held: T, live: T) => boolean,
): (state: AppState) => T | undefined {
  let held: T | undefined;
  return (state) => {
    const live = selectLive(state);
    if (live === undefined) {
      held = undefined;
      return undefined;
    }
    if (held !== undefined && held !== live && isEquivalent(held, live)) {
      return held;
    }
    held = live;
    return live;
  };
}

/**
 * The live text of one loaded message of a thread, or undefined when the
 * thread or message is not loaded. A string, so a subscriber re-renders only
 * when the text changes.
 */
export function selectThreadMessageText(
  state: AppState,
  ref: ScopedThreadRef,
  messageId: MessageId,
): string | undefined {
  return selectEnvironmentState(state, ref.environmentId).messageByThreadId[ref.threadId]?.[
    messageId
  ]?.text;
}

/**
 * A thread's full sidebar summary (undefined for none or an archived stub),
 * kept while a newer one differs only in `updatedAt`. The shell stream rewrites
 * the summary after every event of the thread, each streamed delta included,
 * and nearly always only its `updatedAt` moves. Use it where `updatedAt` is not
 * shown; a value read from it (the inbox's day-scale settle age) can lag by the
 * length of the reply.
 */
export function createThreadSummaryStructureSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => SidebarThreadSummary | undefined {
  return holdWhileEquivalent(
    (state) => fullThreadEntry(selectSidebarThreadSummaryByRef(state, ref)),
    (held, live) => sameFieldsExcept(held, live, isUpdatedAtKey),
  );
}

type FallbackThreadCandidate = Pick<SidebarThreadSummary, "id"> & ThreadSortInput;

const toFallbackThreadCandidate = (
  threadId: ThreadId,
  summary: SidebarThreadOrStub | undefined,
  shell: ThreadShellOrStub | undefined,
): FallbackThreadCandidate | null => {
  if (summary) {
    return summary;
  }
  if (!shell) {
    return null;
  }
  return {
    id: threadId,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    latestUserMessageAt: null,
  };
};

export function createEnvironmentFallbackThreadRefSelector(
  environmentId: ScopedThreadRef["environmentId"] | null | undefined,
  sortOrder: SidebarThreadSortOrder,
): (state: AppState) => ScopedThreadRef | null {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousSidebarThreadSummaryById: EnvironmentState["sidebarThreadSummaryById"] | undefined;
  let previousThreadShellById: EnvironmentState["threadShellById"] | undefined;
  let previousSortOrder: SidebarThreadSortOrder | undefined;
  let previousResultThreadId: ThreadId | null | undefined;
  let previousResult: ScopedThreadRef | null = null;

  return (state) => {
    if (!environmentId) {
      previousThreadIds = undefined;
      previousSidebarThreadSummaryById = undefined;
      previousThreadShellById = undefined;
      previousResultThreadId = null;
      previousResult = null;
      return null;
    }

    const environmentState = selectEnvironmentState(state, environmentId);
    if (
      previousThreadIds === environmentState.threadIds &&
      previousSidebarThreadSummaryById === environmentState.sidebarThreadSummaryById &&
      previousThreadShellById === environmentState.threadShellById &&
      previousSortOrder === sortOrder
    ) {
      return previousResult;
    }

    const candidates = environmentState.threadIds.flatMap((threadId) => {
      const candidate = toFallbackThreadCandidate(
        threadId,
        environmentState.sidebarThreadSummaryById[threadId],
        environmentState.threadShellById[threadId],
      );
      return candidate ? [candidate] : [];
    });
    const resultThreadId = sortThreads(candidates, sortOrder)[0]?.id ?? null;

    previousThreadIds = environmentState.threadIds;
    previousSidebarThreadSummaryById = environmentState.sidebarThreadSummaryById;
    previousThreadShellById = environmentState.threadShellById;
    previousSortOrder = sortOrder;
    if (previousResultThreadId !== resultThreadId) {
      previousResultThreadId = resultThreadId;
      previousResult = resultThreadId ? { environmentId, threadId: resultThreadId } : null;
    }
    return previousResult;
  };
}

/**
 * True once a thread-detail window or full-detail snapshot has been applied.
 * Both detail paths write one of these maps (`syncServerThreadWindow` writes
 * the history entry, `syncServerThreadDetail` the message ids); the shell
 * stream writes neither.
 */
export function selectThreadDetailLoaded(state: AppState, ref: ScopedThreadRef): boolean {
  const environmentState = selectEnvironmentState(state, ref.environmentId);
  return (
    environmentState.threadHistoryByThreadId?.[ref.threadId] !== undefined ||
    environmentState.messageIdsByThreadId[ref.threadId] !== undefined
  );
}

/**
 * True once live detail has been applied for the thread: a thread-detail
 * window, a full-detail snapshot or a live message. Unlike
 * `selectThreadDetailLoaded`, messages hydrated from a read cache (marked in
 * `cachedMessageThreadIds` until live data replaces them) do not count, so
 * work that must wait for the thread's own live window (sibling prefetch)
 * does not start while that window is still on its way.
 */
export function selectThreadLiveDetailLoaded(state: AppState, ref: ScopedThreadRef): boolean {
  const environmentState = selectEnvironmentState(state, ref.environmentId);
  return (
    environmentState.threadHistoryByThreadId?.[ref.threadId] !== undefined ||
    (environmentState.messageIdsByThreadId[ref.threadId] !== undefined &&
      environmentState.cachedMessageThreadIds?.[ref.threadId] !== true)
  );
}

/**
 * True when the environment's rows come from a live shell snapshot: bootstrap
 * completed and not cache provenance. Rows hydrated from the snapshot cache, or
 * demoted after a disconnect, are last-known state with every session dropped.
 */
export function selectEnvironmentShellLive(
  state: AppState,
  environmentId: ScopedThreadRef["environmentId"] | null | undefined,
): boolean {
  const environmentState = selectEnvironmentState(state, environmentId);
  return (
    environmentState.bootstrapComplete && (environmentState.hydratedFromCacheAt ?? null) === null
  );
}

/**
 * What the live thread subscription holds for the Claude resume review
 * (`CommitSendTurnDispatchInput.readSubscribedClaudeReviewState`): only a
 * thread whose environment shell is live (not cache) and whose detail is
 * loaded qualifies. Callers pass the store read at review time, not a value
 * captured at render, so the review judges the newest observation.
 *
 * Accepted gap: "loaded" means loaded at some point, not re-synced since the
 * environment last went live. Just after a reconnect (when a queued-send drain
 * typically runs) the shell can be live while the retained detail still holds
 * pre-disconnect activities, because the store records no per-thread detail
 * sync generation. The review is an advisory cost guard: an older observation
 * usually looks more review-worthy (so the send re-reads the server window),
 * and the server never requires a guard that is absent.
 */
export function selectSubscribedClaudeReviewState(
  state: AppState,
  ref: ScopedThreadRef,
):
  | { readonly thread: ClaudeCacheReviewThread; readonly workspaceCwd: string | undefined }
  | undefined {
  if (!selectEnvironmentShellLive(state, ref.environmentId)) return undefined;
  if (!selectThreadDetailLoaded(state, ref)) return undefined;
  const thread = selectThreadByRef(state, ref);
  if (!thread) return undefined;
  const session = thread.session;
  // The directory the next turn runs in: the thread's worktree, else its
  // project root (the server's resolveThreadWorkspaceCwd).
  const workspaceCwd =
    thread.worktreePath ||
    selectProjectByRef(state, { environmentId: ref.environmentId, projectId: thread.projectId })
      ?.cwd ||
    undefined;
  return {
    thread: {
      modelSelection: thread.modelSelection,
      activities: thread.activities,
      session: session
        ? {
            providerName: session.provider,
            ...(session.runtimeSessionId === undefined
              ? {}
              : { runtimeSessionId: RuntimeSessionId.make(session.runtimeSessionId) }),
            status: session.orchestrationStatus,
            activeTurnId: session.activeTurnId ?? null,
          }
        : null,
    },
    workspaceCwd,
  };
}
