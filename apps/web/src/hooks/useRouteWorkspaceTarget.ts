import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import type { Project, Thread, TurnDiffSummary } from "../types";

const EMPTY_TURN_DIFF_SUMMARIES: readonly TurnDiffSummary[] = [];

/** The routed server thread or draft, reduced to what workspace surfaces read. */
export interface RouteWorkspaceThread {
  readonly id: Thread["id"];
  readonly environmentId: Thread["environmentId"];
  readonly projectId: Thread["projectId"];
  readonly worktreePath: Thread["worktreePath"];
  readonly turnDiffSummaries: readonly TurnDiffSummary[];
}

export interface RouteWorkspaceTarget {
  readonly activeThread: RouteWorkspaceThread | undefined;
  readonly activeProject: Project | undefined;
  /** The folder the workspace is read from: the thread's worktree, else its project's folder. */
  readonly activeCwd: string | null;
}

/**
 * The workspace of the routed thread or draft. The Files panel and the
 * workspace pickers share it, so a picked path always names a file in the
 * folder the Files panel reads.
 */
export function useRouteWorkspaceTarget(): RouteWorkspaceTarget {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeDraftId = useParams({
    strict: false,
    select: (params) => (typeof params.draftId === "string" ? DraftId.make(params.draftId) : null),
  });
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const draftThread = useComposerDraftStore((store) => {
    if (serverThread) return null;
    if (routeDraftId) return store.getDraftSession(routeDraftId);
    if (routeThreadRef) return store.getDraftThreadByRef(routeThreadRef);
    return null;
  });
  const activeThread = useMemo(() => {
    if (serverThread) {
      return {
        id: serverThread.id,
        environmentId: serverThread.environmentId,
        projectId: serverThread.projectId,
        worktreePath: serverThread.worktreePath,
        turnDiffSummaries: serverThread.turnDiffSummaries,
      };
    }
    if (draftThread) {
      return {
        id: draftThread.threadId,
        environmentId: draftThread.environmentId,
        projectId: draftThread.projectId,
        worktreePath: draftThread.worktreePath,
        turnDiffSummaries: EMPTY_TURN_DIFF_SUMMARIES,
      };
    }
    return undefined;
  }, [serverThread, draftThread]);
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeThread && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  return { activeThread, activeProject, activeCwd };
}
