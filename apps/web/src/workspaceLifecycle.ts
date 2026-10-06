import {
  isWorkspaceReviewAction,
  WORKSPACE_LIFECYCLE_ACTION_LABELS,
  type WorkspaceActionId,
  type WorkspaceReviewAction,
} from "@ryco/client-runtime/state/lifecycle";
import type {
  EnvironmentId,
  ProjectId,
  WorkspaceLifecycleResult,
  WorktreeId,
} from "@ryco/contracts";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";
import { buildProjectsPageLocation } from "./projectsRoute";

export interface WorkspaceLifecycleTarget {
  readonly environmentId: EnvironmentId;
  /** The checkout the workspace belongs to; its project page hosts the review. */
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly action: WorkspaceActionId;
  readonly title: string;
}

/** A target whose action is reviewed before it runs. */
export type WorkspaceReviewTarget = WorkspaceLifecycleTarget & {
  readonly action: WorkspaceReviewAction;
};

interface WorkspaceReviewDialogStore {
  /** The review open in the app-wide dialog, if any. */
  readonly target: WorkspaceReviewTarget | null;
  /** Bumps on every open so the same target re-opens fresh after a retry. */
  readonly token: number;
  readonly open: (target: WorkspaceReviewTarget) => void;
  readonly close: () => void;
}

/**
 * The review a menu (sidebar, Inbox, toast Retry) opens: a small dialog over
 * whatever the reader is doing, rather than a trip to the project's map.
 */
export const useWorkspaceReviewDialog = create<WorkspaceReviewDialogStore>((set) => ({
  target: null,
  token: 0,
  open: (target) => set((state) => ({ target, token: state.token + 1 })),
  close: () => set({ target: null }),
}));

export function openWorkspaceReviewDialog(target: WorkspaceLifecycleTarget): void {
  const { action } = target;
  if (isWorkspaceReviewAction(action))
    useWorkspaceReviewDialog.getState().open({ ...target, action });
}

interface WorkspaceLifecycleChangeStore {
  /** Bumps after every applied action so open workspace lists re-inspect. */
  readonly revision: number;
  readonly markChanged: () => void;
}

export const useWorkspaceLifecycleChanges = create<WorkspaceLifecycleChangeStore>((set) => ({
  revision: 0,
  markChanged: () => set((state) => ({ revision: state.revision + 1 })),
}));

/**
 * The lifecycle API of a connected environment. Never throws: settings and menus render
 * during reconnects, when an environment may only be partially available.
 */
export function readLifecycleApi(environmentId: EnvironmentId | null | undefined) {
  if (!environmentId) return undefined;
  try {
    return readEnvironmentApi(environmentId)?.lifecycle;
  } catch {
    return undefined;
  }
}

/**
 * Where a workspace is managed: its project's map, with the workspace
 * selected. With a review action, that review opens in the map's inspector.
 */
export function buildWorkspaceLocation(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreeId?: WorktreeId | null;
  readonly review?: WorkspaceReviewAction | null;
}) {
  return buildProjectsPageLocation({
    environmentId: input.environmentId,
    projectId: input.projectId,
    view: "map",
    workspace: input.worktreeId ?? undefined,
    review: input.worktreeId && input.review ? input.review : undefined,
  });
}

export function announceWorkspaceLifecycleResult(
  target: WorkspaceLifecycleTarget,
  result: WorkspaceLifecycleResult,
  retry: () => void,
): void {
  useWorkspaceLifecycleChanges.getState().markChanged();
  if (result.outcome === "completed") {
    toastManager.add({ type: "success", title: result.message });
    return;
  }
  const failedStep = result.steps.find((step) => step.status === "failed");
  toastManager.add(
    stackedThreadToast({
      type: result.outcome === "partial" ? "warning" : "error",
      title:
        result.outcome === "partial"
          ? `${WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]} partly completed`
          : `${WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]} did not run`,
      description: failedStep ? `${result.message}\n\n${failedStep.detail}` : result.message,
      actionProps: { children: "Retry", onClick: retry },
    }),
  );
}

/**
 * Entry point for every surface (sidebar worktree menu, Inbox Workspace submenu,
 * the project page). Hiding/restoring a record runs directly; anything that
 * touches a checkout goes to its review with the server's exact effects.
 */
export async function runWorkspaceLifecycleAction(
  target: WorkspaceLifecycleTarget,
  openReview: (target: WorkspaceLifecycleTarget) => void = openWorkspaceReviewDialog,
): Promise<void> {
  const { action } = target;
  if (isWorkspaceReviewAction(action)) {
    openReview(target);
    return;
  }
  const retry = () => void runWorkspaceLifecycleAction(target, openReview);
  const lifecycle = readLifecycleApi(target.environmentId);
  if (!lifecycle) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Workspace actions unavailable",
        description: "This environment does not support workspace lifecycle management.",
      }),
    );
    return;
  }
  try {
    const preview = await lifecycle.previewWorkspace({ worktreeId: target.worktreeId, action });
    if (preview.blockers.length > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `${WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]} is not available`,
          description: preview.blockers.join("\n"),
        }),
      );
      return;
    }
    const result = await lifecycle.applyWorkspace({
      ...preview.request,
      expectedFingerprint: preview.fingerprint,
    });
    announceWorkspaceLifecycleResult(target, result, retry);
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `${WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]} failed`,
        description: error instanceof Error ? error.message : "An error occurred.",
        actionProps: { children: "Retry", onClick: retry },
      }),
    );
  }
}
