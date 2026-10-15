import {
  type EnvironmentId,
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
  selectThreadByRef,
  type AppState,
  type EnvironmentState,
} from "./store.ts";
import {
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
