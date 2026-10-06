import { WORKSPACE_LIFECYCLE_ACTION_LABELS } from "@ryco/client-runtime/state/lifecycle";
import type {
  EnvironmentId,
  WorkspaceLifecycleAction,
  WorkspaceLifecycleResult,
  WorktreeId,
} from "@ryco/contracts";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";

export interface WorkspaceLifecycleTarget {
  readonly environmentId: EnvironmentId;
  readonly worktreeId: WorktreeId;
  readonly action: WorkspaceLifecycleAction;
  /** Shown before the preview loads. */
  readonly title: string;
}

interface WorkspaceLifecycleDialogStore {
  readonly target: WorkspaceLifecycleTarget | null;
  /** Bumps after every applied action so open management views refresh. */
  readonly revision: number;
  readonly open: (target: WorkspaceLifecycleTarget) => void;
  readonly close: () => void;
  readonly markChanged: () => void;
}

export const useWorkspaceLifecycleDialogStore = create<WorkspaceLifecycleDialogStore>((set) => ({
  target: null,
  revision: 0,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
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

/** Actions that change files or the record's checkout always go through the exact-effects review. */
export const workspaceActionNeedsReview = (action: WorkspaceLifecycleAction): boolean =>
  action === "remove-checkout" ||
  action === "remove-stale-record" ||
  action === "recreate-checkout";

export function announceWorkspaceLifecycleResult(
  target: WorkspaceLifecycleTarget,
  result: WorkspaceLifecycleResult,
): void {
  useWorkspaceLifecycleDialogStore.getState().markChanged();
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
      actionProps: {
        children: "Review and retry",
        onClick: () => useWorkspaceLifecycleDialogStore.getState().open(target),
      },
    }),
  );
}

/**
 * Entry point for every surface (sidebar worktree menu, Inbox Workspace submenu,
 * workspace management). Hiding/restoring a record runs directly; anything that
 * touches a checkout opens the review dialog with the server's exact effects.
 */
export async function runWorkspaceLifecycleAction(target: WorkspaceLifecycleTarget) {
  if (workspaceActionNeedsReview(target.action)) {
    useWorkspaceLifecycleDialogStore.getState().open(target);
    return;
  }
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
    const preview = await lifecycle.previewWorkspace({
      worktreeId: target.worktreeId,
      action: target.action,
    });
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
    announceWorkspaceLifecycleResult(target, result);
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `${WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]} failed`,
        description: error instanceof Error ? error.message : "An error occurred.",
        actionProps: {
          children: "Retry",
          onClick: () => void runWorkspaceLifecycleAction(target),
        },
      }),
    );
  }
}
