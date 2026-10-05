import {
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type WorktreeId,
} from "@ryco/contracts";
import type { SidebarThreadSortOrder } from "@ryco/contracts/settings";
import { sortThreads, type ThreadSortInput } from "./threadSort.ts";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store.ts";
import {
  type Project,
  type SidebarThreadSummary,
  type SidebarWorktreeSummary,
  type Thread,
  type ThreadShell,
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
  summary: SidebarThreadSummary | undefined,
  shell: ThreadShell | undefined,
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
