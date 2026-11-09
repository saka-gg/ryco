import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { resolveThreadWorkspaceRoot } from "@ryco/client-runtime/state/files";
import type { Project, SidebarWorktreeSummary, Thread } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useMemo } from "react";

import { useHomeWorkspaceData } from "../../state/homeData";
import { selectProjectByRef, selectThreadByRef, useStore } from "../../state/threadsRuntime";
import { findThreadWorktree } from "../threads/threadHeaderModel";

/**
 * The `cwd` both file screens hand to the node.
 *
 * Memoized because it is a cache-key input: the query hooks re-subscribe on a
 * changed key, and recomputing an identical string per render would be fine
 * while an identical-but-new object would not — keeping the resolution in one
 * place is what stops that distinction from being rediscovered per screen.
 */
export function useThreadWorkspaceRoot(input: {
  readonly thread: Pick<Thread, "worktreePath"> | null | undefined;
  readonly worktree: Pick<SidebarWorktreeSummary, "worktreePath"> | null;
  readonly project: Pick<Project, "cwd"> | null;
}): string | null {
  const { thread, worktree, project } = input;
  return useMemo(
    () => resolveThreadWorkspaceRoot({ thread: thread ?? null, worktree, project }),
    [project, thread, worktree],
  );
}

/**
 * The workspace a thread's file tools work in, looked up from the thread: its
 * worktree, else its project's folder. For screens that start from route params.
 */
export function useThreadWorkspaceCwd(environmentId: EnvironmentId, threadId: ThreadId) {
  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const project = useStore((state) =>
    thread
      ? (selectProjectByRef(state, scopeProjectRef(environmentId, thread.projectId)) ?? null)
      : null,
  );
  const { worktrees } = useHomeWorkspaceData();
  const worktree = useMemo(
    () => (thread ? findThreadWorktree(thread, worktrees) : null),
    [thread, worktrees],
  );
  return useThreadWorkspaceRoot({ thread, worktree, project });
}
