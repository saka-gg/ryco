import { availablePaneSplit, useChatPanesStore } from "../../../chatPanesStore";
import React, { useCallback, useRef, useState } from "react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import {
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import { newCommandId } from "../../../lib/utils";
import { readEnvironmentApi } from "../../../environmentApi";
import { readLocalApi } from "../../../localApi";
import { useComposerDraftStore, type DraftId } from "../../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../../threadRoutes";
import { useUiStateStore } from "../../../uiStateStore";
import { selectSidebarWorktreesForProjectRef, useStore } from "../../../store";
import { renameThread } from "../../../threadMutations";
import { buildWorkspaceLocation, runWorkspaceLifecycleAction } from "../../../workspaceLifecycle";
import {
  buildThreadMenuInventory,
  type ThreadMenuActionId,
  type ThreadMenuActionItem,
} from "../threadMenuInventory";
import type { useRouter } from "@tanstack/react-router";
import { trashConfirmationMessage, type useThreadActions } from "../../../hooks/useThreadActions";
import {
  canArchiveSidebarThread,
  shouldConfirmSidebarThreadArchive,
  shouldConfirmSidebarThreadDelete,
} from "../../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type { SidebarThreadSummary } from "../../../types";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { requestThreadPinChange } from "../../../threadPinning";

export type { ThreadMenuActionId, ThreadMenuActionItem };

export function useThreadMenuActions(params: {
  router: ReturnType<typeof useRouter>;
  appSettingsConfirmThreadDelete: boolean;
  appSettingsConfirmThreadArchive: boolean;
  appSettingsConfirmThreadUnpin: boolean;
  trashThread: ReturnType<typeof useThreadActions>["trashThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  stopThreadSession: ReturnType<typeof useThreadActions>["stopThreadSession"];
  interruptThreadTurn: ReturnType<typeof useThreadActions>["interruptThreadTurn"];
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  copyPathToClipboard: (value: string, ctx: { path: string }) => void;
  copyThreadIdToClipboard: (value: string, ctx: { threadId: ThreadId }) => void;
  sidebarThreadByKeyRef: React.RefObject<ReadonlyMap<string, SidebarThreadSummary>>;
  memberProjectByScopedKey: ReadonlyMap<string, Pick<SidebarProjectGroupMember, "cwd">>;
  projectCwd: string | null | undefined;
  openProjectSettings?: (projectRef: ScopedProjectRef) => void;
  /**
   * Inbox rows add a Workspace submenu; project-sidebar rows sit under their workspace node.
   * Checkout changes and "Manage workspaces…" open the thread's project page.
   */
  includeWorkspaceSubmenu?: boolean;
}) {
  const {
    router,
    appSettingsConfirmThreadDelete,
    appSettingsConfirmThreadArchive,
    appSettingsConfirmThreadUnpin,
    trashThread,
    archiveThread,
    stopThreadSession,
    interruptThreadTurn,
    markThreadUnread,
    copyPathToClipboard,
    copyThreadIdToClipboard,
    sidebarThreadByKeyRef,
    memberProjectByScopedKey,
    projectCwd,
    openProjectSettings,
    includeWorkspaceSubmenu = false,
  } = params;
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);

  // Drafts are discarded locally; server threads move to Trash (never deleted here).
  const requestTrashThread = useCallback(
    async (
      thread: SidebarThreadSummary & { draftId?: DraftId | undefined },
      opts: { deletedThreadKeys?: ReadonlySet<string> } = {},
    ) => {
      if (thread.draftId) {
        const draftStore = useComposerDraftStore.getState();
        draftStore.clearDraftThread(thread.draftId);
        const currentRouteParams =
          router.state.matches[router.state.matches.length - 1]?.params ?? {};
        const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
        if (currentRouteTarget?.kind === "draft" && currentRouteTarget.draftId === thread.draftId) {
          await router.navigate({ to: "/", replace: true });
        }
        return;
      }
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      if (
        shouldConfirmSidebarThreadDelete({
          confirmThreadDelete: appSettingsConfirmThreadDelete,
          thread,
        })
      ) {
        const message = trashConfirmationMessage([thread.title]);
        const localApi = readLocalApi();
        const confirmed = localApi
          ? await localApi.dialogs.confirm(message)
          : window.confirm(message);
        if (!confirmed) {
          return;
        }
      }
      await trashThread(threadRef, {
        ...opts,
        // Always optimistic after the (synchronous) confirmation. The
        // non-optimistic branch awaits the WS round-trip before touching
        // the UI — perceived as a multi-second freeze. The optimistic
        // branch already toasts errors if the server refuses.
        optimistic: true,
      });
    },
    [appSettingsConfirmThreadDelete, trashThread, router],
  );

  /** The registered workspace record a thread belongs to, if any. */
  const resolveThreadWorkspace = useCallback((thread: SidebarThreadSummary) => {
    const worktrees = selectSidebarWorktreesForProjectRef(
      useStore.getState(),
      scopeProjectRef(thread.environmentId, thread.projectId),
    );
    const record =
      worktrees.find((worktree) =>
        thread.worktreeId != null
          ? worktree.id === thread.worktreeId
          : thread.worktreePath !== null && worktree.worktreePath === thread.worktreePath,
      ) ?? null;
    return {
      record,
      protectedWorkspace:
        record === null || record.origin === "main" || record.worktreePath === null,
    };
  }, []);

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        const thread = sidebarThreadByKeyRef.current.get(scopedThreadKey(threadRef)) ?? null;
        if (thread && !canArchiveSidebarThread(thread)) {
          toastManager.add({
            type: "warning",
            title: "Send a message before archiving",
          });
          return;
        }
        await archiveThread(threadRef);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread, sidebarThreadByKeyRef],
  );

  const startThreadRename = useCallback((threadKey: string, title: string) => {
    setRenamingThreadKey(threadKey);
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
      const threadKey = scopedThreadKey(threadRef);
      const finishRename = () => {
        setRenamingThreadKey((current) => {
          if (current !== threadKey) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) {
        finishRename();
        return;
      }
      try {
        await renameThread(threadRef, trimmed);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      finishRename();
    },
    [],
  );

  // The single thread action inventory, as data. Every presenter — the DOM
  // context menu, the Inbox menu, the native menu and the phone bottom sheet —
  // renders this inventory and dispatches through `performThreadMenuAction`, so
  // the handlers are never forked.
  const listThreadMenuActions = useCallback(
    (threadKey: string): ThreadMenuActionItem[] => {
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return [];
      const draftId = (thread as SidebarThreadSummary & { draftId?: DraftId | undefined }).draftId;
      const panes = useChatPanesStore.getState();
      return buildThreadMenuInventory({
        thread,
        isDraft: Boolean(draftId),
        isPinned: useUiStateStore.getState().pinnedThreadKeys[threadKey] === true,
        splitAvailable: Boolean(
          availablePaneSplit(
            panes.root,
            panes.activeRef,
            scopeThreadRef(thread.environmentId, thread.id),
          ),
        ),
        projectActions: openProjectSettings
          ? {
              memberProject: memberProjectByScopedKey.has(
                scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
              ),
            }
          : null,
        workspace: includeWorkspaceSubmenu ? resolveThreadWorkspace(thread) : null,
      });
    },
    [
      includeWorkspaceSubmenu,
      memberProjectByScopedKey,
      openProjectSettings,
      resolveThreadWorkspace,
      sidebarThreadByKeyRef,
    ],
  );

  const performThreadMenuAction = useCallback(
    async (threadRef: ScopedThreadRef, actionId: ThreadMenuActionId) => {
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const draftId = (thread as SidebarThreadSummary & { draftId?: DraftId | undefined }).draftId;
      const archiveAvailable = !draftId && canArchiveSidebarThread(thread);
      const threadProject = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const threadWorkspacePath = thread.worktreePath ?? threadProject?.cwd ?? projectCwd ?? null;

      if (actionId === "project-settings") {
        if (threadProject)
          openProjectSettings?.(scopeProjectRef(thread.environmentId, thread.projectId));
        return;
      }
      if (actionId === "copy-project-path" || actionId === "copy-worktree-path") {
        const path = actionId === "copy-project-path" ? threadProject?.cwd : thread.worktreePath;
        if (path) copyPathToClipboard(path, { path });
        return;
      }

      if (actionId === "open-in-split") {
        useChatPanesStore.getState().open(threadRef);
        return;
      }

      if (actionId === "rename") {
        startThreadRename(threadKey, thread.title);
        return;
      }

      if (actionId === "pin" || actionId === "unpin") {
        await requestThreadPinChange({
          threadKey,
          threadTitle: thread.title,
          pinned: actionId === "pin",
          confirmUnpin: appSettingsConfirmThreadUnpin,
        });
        return;
      }

      if (actionId === "mark-unread") {
        markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        return;
      }
      if (actionId === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (actionId === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (actionId === "unarchive") {
        const api = readEnvironmentApi(threadRef.environmentId);
        if (!api) return;
        try {
          await api.orchestration.dispatchCommand({
            type: "thread.unarchive",
            commandId: newCommandId(),
            threadId: threadRef.threadId,
          });
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (actionId === "interrupt-turn") {
        await interruptThreadTurn(threadRef);
        return;
      }
      if (actionId === "stop-session") {
        await stopThreadSession(threadRef);
        return;
      }
      if (actionId === "workspace:manage") {
        const { record } = resolveThreadWorkspace(thread);
        await router.navigate(
          buildWorkspaceLocation({
            environmentId: thread.environmentId,
            projectId: thread.projectId,
            worktreeId: record ? WorktreeId.make(record.id) : null,
          }),
        );
        return;
      }
      if (actionId.startsWith("workspace:")) {
        const { record } = resolveThreadWorkspace(thread);
        if (!record) return;
        await runWorkspaceLifecycleAction({
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          worktreeId: WorktreeId.make(record.id),
          action: actionId.slice("workspace:".length) as WorkspaceActionId,
          title: record.title ?? record.branch,
        });
        return;
      }
      if (actionId === "archive") {
        if (
          shouldConfirmSidebarThreadArchive({
            archiveAvailable,
            confirmThreadArchive: appSettingsConfirmThreadArchive,
          })
        ) {
          const message = [
            `Archive thread "${thread.title}"?`,
            "Its session stops and its history is kept indefinitely. Unarchive it from Settings › Archive.",
          ].join("\n");
          const localApi = readLocalApi();
          const confirmed = localApi
            ? await localApi.dialogs.confirm(message)
            : window.confirm(message);
          if (!confirmed) return;
        }
        await attemptArchiveThread(threadRef);
        return;
      }
      if (actionId !== "trash" && actionId !== "discard-draft") return;
      await requestTrashThread(thread);
    },
    [
      attemptArchiveThread,
      appSettingsConfirmThreadArchive,
      appSettingsConfirmThreadUnpin,
      requestTrashThread,
      interruptThreadTurn,
      resolveThreadWorkspace,
      router,
      stopThreadSession,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      markThreadUnread,
      memberProjectByScopedKey,
      openProjectSettings,
      projectCwd,
      sidebarThreadByKeyRef,
      startThreadRename,
    ],
  );

  return {
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingCommittedRef,
    renamingInputRef,
    requestTrashThread,
    attemptArchiveThread,
    startThreadRename,
    cancelRename,
    commitRename,
    listThreadMenuActions,
    performThreadMenuAction,
  };
}
