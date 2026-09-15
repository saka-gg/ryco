import { availablePaneSplit, useChatPanesStore } from "../../../chatPanesStore";
import React, { useCallback, useRef, useState } from "react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import { type ScopedProjectRef, type ScopedThreadRef, type ThreadId } from "@ryco/contracts";
import { newCommandId } from "../../../lib/utils";
import { readEnvironmentApi } from "../../../environmentApi";
import { readLocalApi } from "../../../localApi";
import { useComposerDraftStore, type DraftId } from "../../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../../threadRoutes";
import { useUiStateStore } from "../../../uiStateStore";
import type { useRouter } from "@tanstack/react-router";
import type { useThreadActions } from "../../../hooks/useThreadActions";
import {
  canArchiveSidebarThread,
  shouldConfirmSidebarThreadArchive,
  shouldConfirmSidebarThreadDelete,
} from "../../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type { SidebarThreadSummary } from "../../../types";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { requestThreadPinChange } from "../../../threadPinning";

export type ThreadMenuActionId =
  | "open-in-split"
  | "pin"
  | "unpin"
  | "rename"
  | "mark-unread"
  | "project-settings"
  | "copy-project-path"
  | "copy-worktree-path"
  | "copy-path"
  | "copy-thread-id"
  | "archive"
  | "close";

export interface ThreadMenuActionItem {
  readonly id: ThreadMenuActionId;
  readonly label: string;
  readonly destructive?: boolean;
}

export function useThreadMenuActions(params: {
  router: ReturnType<typeof useRouter>;
  appSettingsConfirmThreadDelete: boolean;
  appSettingsConfirmThreadArchive: boolean;
  appSettingsConfirmThreadUnpin: boolean;
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  copyPathToClipboard: (value: string, ctx: { path: string }) => void;
  copyThreadIdToClipboard: (value: string, ctx: { threadId: ThreadId }) => void;
  sidebarThreadByKeyRef: React.RefObject<ReadonlyMap<string, SidebarThreadSummary>>;
  memberProjectByScopedKey: ReadonlyMap<string, Pick<SidebarProjectGroupMember, "cwd">>;
  projectCwd: string | null | undefined;
  openProjectSettings?: (projectRef: ScopedProjectRef) => void;
}) {
  const {
    router,
    appSettingsConfirmThreadDelete,
    appSettingsConfirmThreadArchive,
    appSettingsConfirmThreadUnpin,
    deleteThread,
    archiveThread,
    markThreadUnread,
    copyPathToClipboard,
    copyThreadIdToClipboard,
    sidebarThreadByKeyRef,
    memberProjectByScopedKey,
    projectCwd,
    openProjectSettings,
  } = params;
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);

  const closeThread = useCallback(
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
      const shouldConfirmClose = shouldConfirmSidebarThreadDelete({
        confirmThreadDelete: appSettingsConfirmThreadDelete,
        thread,
      });
      if (shouldConfirmClose) {
        const message = [
          `Close session "${thread.title}"?`,
          "This permanently clears conversation history for this thread.",
        ].join("\n");
        const localApi = readLocalApi();
        const confirmed = localApi
          ? await localApi.dialogs.confirm(message)
          : window.confirm(message);
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadRef, {
        ...opts,
        // Always optimistic after the (synchronous) confirmation. The
        // non-optimistic branch awaits the WS round-trip before touching
        // the UI — perceived as a multi-second freeze. The optimistic
        // branch already toasts errors if the server delete fails.
        optimistic: true,
      });
    },
    [appSettingsConfirmThreadDelete, deleteThread, router],
  );

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
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
          title: trimmed,
        });
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

  // The single thread action inventory, as data. Both presenters — the DOM
  // context menu (desktop right-click) and the phone bottom-sheet kebab —
  // render this inventory and dispatch through `performThreadMenuAction`, so
  // the handlers are never forked.
  const listThreadMenuActions = useCallback(
    (threadKey: string): ThreadMenuActionItem[] => {
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return [];
      const draftId = (thread as SidebarThreadSummary & { draftId?: DraftId | undefined }).draftId;
      if (draftId) {
        return [{ id: "close", label: "Close session" }];
      }
      const archiveAvailable = canArchiveSidebarThread(thread);
      const isPinned = useUiStateStore.getState().pinnedThreadKeys[threadKey] === true;
      const panes = useChatPanesStore.getState();
      const splitAvailable = availablePaneSplit(
        panes.root,
        panes.activeRef,
        scopeThreadRef(thread.environmentId, thread.id),
      );
      return [
        ...(splitAvailable
          ? [{ id: "open-in-split", label: "Open in split view" } satisfies ThreadMenuActionItem]
          : []),
        { id: isPinned ? "unpin" : "pin", label: isPinned ? "Unpin thread" : "Pin thread" },
        { id: "rename", label: "Rename thread" },
        { id: "mark-unread", label: "Mark unread" },
        ...(openProjectSettings
          ? [
              ...(memberProjectByScopedKey.has(
                scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
              )
                ? ([
                    { id: "project-settings", label: "Project settings" },
                    { id: "copy-project-path", label: "Copy Project Path" },
                  ] satisfies ThreadMenuActionItem[])
                : []),
              ...(thread.worktreePath
                ? ([
                    { id: "copy-worktree-path", label: "Copy Worktree Path" },
                  ] satisfies ThreadMenuActionItem[])
                : []),
            ]
          : ([{ id: "copy-path", label: "Copy Path" }] satisfies ThreadMenuActionItem[])),
        { id: "copy-thread-id", label: "Copy Thread ID" },
        ...(archiveAvailable
          ? [{ id: "archive", label: "Archive session" } satisfies ThreadMenuActionItem]
          : []),
        {
          id: "close",
          label: thread.worktreeId || thread.worktreePath ? "Close session" : "Delete thread",
          destructive: true,
        },
      ];
    },
    [sidebarThreadByKeyRef, memberProjectByScopedKey, openProjectSettings],
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
      if (actionId === "archive") {
        if (
          shouldConfirmSidebarThreadArchive({
            archiveAvailable,
            confirmThreadArchive: appSettingsConfirmThreadArchive,
          })
        ) {
          const message = [
            `Archive session "${thread.title}"?`,
            "You can restore archived sessions from Settings > Archive.",
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
      if (actionId !== "close") return;
      await closeThread(thread);
    },
    [
      attemptArchiveThread,
      appSettingsConfirmThreadArchive,
      appSettingsConfirmThreadUnpin,
      closeThread,
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
    closeThread,
    attemptArchiveThread,
    startThreadRename,
    cancelRename,
    commitRename,
    listThreadMenuActions,
    performThreadMenuAction,
  };
}
