import { useCallback } from "react";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  EnvironmentId,
  type ScopedThreadRef,
  type ThreadEnvMode,
  type WorkspaceLifecycleAction,
  WorktreeId,
} from "@ryco/contracts";
import { newCommandId } from "../../../lib/utils";
import { readEnvironmentApi } from "../../../environmentApi";
import { readLocalApi } from "../../../localApi";
import { useStore } from "../../../store";
import { openInPreferredEditor } from "../../../editorPreferences";
import { runWorkspaceLifecycleAction } from "../../../workspaceLifecycle";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { isSyntheticWorktreeId, type SidebarTreeWorktree } from "./useSidebarTree";

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
}) {
  const { project, navigateToThread, createThreadForProjectMember, copyPathToClipboard } = params;

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
      const activeThreads = worktreeNode.sessions.toSorted(
        (left, right) =>
          Date.parse(right.updatedAt ?? right.createdAt) -
          Date.parse(left.updatedAt ?? left.createdAt),
      );
      const targetThread = activeThreads[0];
      if (targetThread) {
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }
      createThreadInWorktree(worktreeNode);
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
    (worktreeNode: SidebarTreeWorktree, action: WorkspaceLifecycleAction) => {
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
      void runWorkspaceLifecycleAction({
        environmentId: resolveWorktreeEnvironmentId(worktreeNode),
        worktreeId: WorktreeId.make(worktreeNode.worktree.worktreeId),
        action,
        title: worktreeNode.worktree.title ?? worktreeNode.worktree.branch,
      });
    },
    [resolveWorktreeEnvironmentId],
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
