import { useCallback } from "react";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import {
  EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
  type ThreadEnvMode,
  WorktreeId,
} from "@ryco/contracts";
import { newCommandId } from "../../../lib/utils";
import { readEnvironmentApi } from "../../../environmentApi";
import { readLocalApi } from "../../../localApi";
import { useStore } from "../../../store";
import { openInPreferredEditor } from "../../../editorPreferences";
import {
  openWorkspaceReviewDialog,
  runWorkspaceLifecycleAction,
  type WorkspaceLifecycleTarget,
} from "../../../workspaceLifecycle";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import {
  isSyntheticWorktreeId,
  type SidebarTreeThread,
  type SidebarTreeWorktree,
} from "./useSidebarTree";

const newestFirst = (left: SidebarTreeThread, right: SidebarTreeThread) =>
  Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt);

/**
 * Where opening a workspace goes: its latest active thread, else a new thread
 * there, but only while the workspace is live. An archived workspace or a
 * removed checkout never gets a new thread: it reopens its latest archived
 * conversation, or nothing.
 */
export function resolveWorktreeOpenTarget(
  worktreeNode: Pick<SidebarTreeWorktree, "sessions" | "archivedSessions" | "worktree">,
):
  | { readonly kind: "thread"; readonly thread: SidebarTreeThread }
  | { readonly kind: "new-thread" }
  | { readonly kind: "none" } {
  const active = worktreeNode.sessions.toSorted(newestFirst)[0];
  if (active) return { kind: "thread", thread: active };
  const live =
    worktreeNode.worktree.archivedAt == null && worktreeNode.worktree.checkoutRemovedAt == null;
  if (live) return { kind: "new-thread" };
  const archived = worktreeNode.archivedSessions.toSorted(newestFirst)[0];
  return archived ? { kind: "thread", thread: archived } : { kind: "none" };
}

export function useSidebarWorktreeActions(params: {
  project: SidebarProjectSnapshot;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  createThreadForProjectMember: (
    member: SidebarProjectGroupMember,
    seedOverride?: {
      branch?: string | null;
      envMode: ThreadEnvMode;
      worktreePath?: string | null;
    },
  ) => void;
  copyPathToClipboard: (value: string, ctx: { path: string }) => void;
  /**
   * Checkout changes are reviewed first; this opens that review. Defaults to
   * the app-wide review dialog; the project map reviews in its inspector.
   */
  openWorkspaceReview?: (target: WorkspaceLifecycleTarget) => void;
}) {
  const {
    project,
    navigateToThread,
    createThreadForProjectMember,
    copyPathToClipboard,
    openWorkspaceReview = openWorkspaceReviewDialog,
  } = params;

  const createThreadInWorktree = useCallback(
    (worktreeNode: SidebarTreeWorktree) => {
      const targetMember =
        project.memberProjects.find(
          (member) =>
            member.environmentId === worktreeNode.worktree.environmentId &&
            member.id === worktreeNode.worktree.sourceProjectId,
        ) ?? project.memberProjects[0];
      if (!targetMember) {
        return;
      }
      createThreadForProjectMember(targetMember, {
        branch: worktreeNode.worktree.branch,
        envMode: worktreeNode.worktree.worktreePath ? "worktree" : "local",
        worktreePath: worktreeNode.worktree.worktreePath,
      });
    },
    [createThreadForProjectMember, project.memberProjects],
  );

  const openWorktree = useCallback(
    (worktreeNode: SidebarTreeWorktree) => {
      const target = resolveWorktreeOpenTarget(worktreeNode);
      if (target.kind === "thread") {
        navigateToThread(scopeThreadRef(target.thread.environmentId, target.thread.id));
        return;
      }
      if (target.kind === "new-thread") {
        createThreadInWorktree(worktreeNode);
        return;
      }
      toastManager.add({
        type: "info",
        title:
          worktreeNode.worktree.checkoutRemovedAt != null
            ? "Recreate the checkout to start a thread here"
            : "Restore the workspace to start a thread here",
      });
    },
    [createThreadInWorktree, navigateToThread],
  );

  const resolveWorktreeFilesystemPath = useCallback(
    (worktreeNode: SidebarTreeWorktree) =>
      worktreeNode.worktree.worktreePath ?? worktreeNode.worktree.sourceProjectCwd ?? project.cwd,
    [project.cwd],
  );

  const resolveWorktreeEnvironmentId = useCallback(
    (worktreeNode: SidebarTreeWorktree) =>
      worktreeNode.worktree.environmentId
        ? EnvironmentId.make(worktreeNode.worktree.environmentId)
        : project.environmentId,
    [project.environmentId],
  );

  const copyWorktreePath = useCallback(
    (worktreeNode: SidebarTreeWorktree) => {
      const path = resolveWorktreeFilesystemPath(worktreeNode);
      if (!path) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Path unavailable",
            description: "This worktree does not have a workspace path to copy.",
          }),
        );
        return;
      }
      copyPathToClipboard(path, { path });
    },
    [copyPathToClipboard, resolveWorktreeFilesystemPath],
  );

  const openWorktreeInEditor = useCallback(
    (worktreeNode: SidebarTreeWorktree) => {
      const path = resolveWorktreeFilesystemPath(worktreeNode);
      const api = readLocalApi();
      if (!api || !path) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open worktree",
            description: "No local editor bridge is available.",
          }),
        );
        return;
      }
      void openInPreferredEditor(api, path).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open worktree",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    },
    [resolveWorktreeFilesystemPath],
  );

  /**
   * Workspace actions never touch conversations directly: the server lifecycle
   * service archives (never deletes) them as part of checkout removal, after a
   * review that shows the exact effects.
   */
  const runWorkspaceAction = useCallback(
    (worktreeNode: SidebarTreeWorktree, action: WorkspaceActionId) => {
      if (isSyntheticWorktreeId(worktreeNode.worktree.worktreeId)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Not a registered workspace",
            description:
              "This group is derived from its sessions. Manage its conversations individually.",
          }),
        );
        return;
      }
      void runWorkspaceLifecycleAction(
        {
          environmentId: resolveWorktreeEnvironmentId(worktreeNode),
          projectId: ProjectId.make(
            worktreeNode.worktree.sourceProjectId ?? worktreeNode.worktree.projectId,
          ),
          worktreeId: WorktreeId.make(worktreeNode.worktree.worktreeId),
          action,
          title: worktreeNode.worktree.title ?? worktreeNode.worktree.branch,
        },
        openWorkspaceReview,
      );
    },
    [openWorkspaceReview, resolveWorktreeEnvironmentId],
  );

  const renameWorktree = useCallback(
    async (worktreeNode: SidebarTreeWorktree, title: string) => {
      const trimmed = title.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Worktree title cannot be empty",
        });
        return;
      }

      const environmentId = resolveWorktreeEnvironmentId(worktreeNode);
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename worktree",
            description: "Project API unavailable.",
          }),
        );
        return;
      }

      try {
        const changedAt = new Date().toISOString();
        const worktreeId = WorktreeId.make(worktreeNode.worktree.worktreeId);
        await api.orchestration.dispatchCommand({
          type: "worktree.meta.update",
          commandId: newCommandId(),
          worktreeId,
          title: trimmed,
          changedAt,
        });
        useStore.getState().setSidebarWorktreeTitle(environmentId, worktreeId, trimmed, changedAt);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename worktree",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [resolveWorktreeEnvironmentId],
  );

  return {
    createThreadInWorktree,
    openWorktree,
    resolveWorktreeFilesystemPath,
    copyWorktreePath,
    openWorktreeInEditor,
    runWorkspaceAction,
    renameWorktree,
  };
}
