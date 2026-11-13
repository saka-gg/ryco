import { availablePaneSplit, useChatPanesStore } from "../../../chatPanesStore";
import React, { useCallback, useRef, useState } from "react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import {
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { openFolderWithFeedback } from "../../../lib/chatFolderActions";
import { getEditorLabel } from "../../settings/editorLabels.logic";
import {
  CHAT_EXTENSION_ACTION_PREFIX,
  type ChatRowMenuExtension,
  type ChatRowMenuSubject,
} from "../chatRowMenu";
import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import { newCommandId, newProjectId } from "../../../lib/utils";
import { readEnvironmentApi } from "../../../environmentApi";
import { readLocalApi } from "../../../localApi";
import { useComposerDraftStore, type DraftId } from "../../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../../threadRoutes";
import { useUiStateStore } from "../../../uiStateStore";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarWorktreesForProjectRef,
  useStore,
} from "../../../store";
import {
  listMoveTargetProjects,
  threadMoveConfirmation,
  threadMoveNotices,
  threadProjectMoveCommand,
  threadSummaryMoveBlocker,
} from "@ryco/client-runtime/state/threads";
import { resolveChatsAvailability } from "@ryco/client-runtime/state/composer";
import { isChatProject } from "@ryco/shared/projectKind";
import { threadProjectMoveBlockerMessage } from "@ryco/shared/threadMove";
import { readEnvironmentServerConfig } from "../../../hooks/useChatsAvailability";
import { renameThread } from "../../../threadMutations";
import { buildWorkspaceLocation, runWorkspaceLifecycleAction } from "../../../workspaceLifecycle";
import {
  buildThreadMenuInventory,
  moveToProjectTargetOf,
  type ThreadMenuActionId,
  type ThreadMenuActionItem,
} from "../threadMenuInventory";
import type { useRouter } from "@tanstack/react-router";
import { deleteConfirmationMessage, type useThreadActions } from "../../../hooks/useThreadActions";
import { shouldConfirmSidebarThreadDelete } from "../../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type { SidebarThreadSummary } from "../../../types";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { attemptThreadArchive, requestThreadArchive } from "../../../threadLifecycleCommands";
import { requestThreadPinChange } from "../../../threadPinning";

export type { ThreadMenuActionId, ThreadMenuActionItem };

export function useThreadMenuActions(params: {
  router: ReturnType<typeof useRouter>;
  appSettingsConfirmThreadDelete: boolean;
  appSettingsConfirmThreadArchive: boolean;
  appSettingsConfirmThreadUnpin: boolean;
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
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
  /**
   * Offer "Move to project" (the project sidebar, chats and the Inbox). The frozen phone tier
   * leaves it out.
   */
  includeMoveToProject?: boolean;
  /**
   * "No project" chat rows: folder actions and chat menu extensions replace the
   * project/workspace items for threads this resolves to a chat.
   */
  chat?:
    | {
        readonly resolveSubject: (thread: SidebarThreadSummary) => ChatRowMenuSubject | null;
        readonly extensions: ReadonlyArray<ChatRowMenuExtension>;
        /** Chat folders on this environment can be revealed and opened locally. */
        readonly localEnvironmentId: EnvironmentId | null;
      }
    | undefined;
}) {
  const {
    router,
    appSettingsConfirmThreadDelete,
    appSettingsConfirmThreadArchive,
    appSettingsConfirmThreadUnpin,
    deleteThread,
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
    includeMoveToProject = false,
    chat,
  } = params;
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);

  // Drafts are discarded locally; server threads are deleted with an Undo window
  // (the server purges them once it ends).
  const requestDeleteThread = useCallback(
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
        const message = deleteConfirmationMessage([thread.title]);
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
        // branch already toasts errors if the server refuses.
        optimistic: true,
      });
    },
    [appSettingsConfirmThreadDelete, deleteThread, router],
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
    (threadRef: ScopedThreadRef) =>
      attemptThreadArchive({
        target: threadRef,
        thread: sidebarThreadByKeyRef.current.get(scopedThreadKey(threadRef)),
        archiveThread,
      }),
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

  /** The thread's node's projects, and whether that node can hold chats without a project. */
  const readMoveContext = useCallback((thread: SidebarThreadSummary) => {
    const projects = selectProjectsAcrossEnvironments(useStore.getState()).filter(
      (project) => project.environmentId === thread.environmentId,
    );
    const config = readEnvironmentServerConfig(thread.environmentId);
    return {
      projects,
      source: projects.find((project) => project.id === thread.projectId) ?? null,
      chatsAvailable: config !== null && resolveChatsAvailability(config).available,
    };
  }, []);

  const moveToProjectMenu = useCallback(
    (thread: SidebarThreadSummary) => {
      const { projects, source, chatsAvailable } = readMoveContext(thread);
      const blocker = threadSummaryMoveBlocker(thread);
      return {
        targets: listMoveTargetProjects(projects, thread.projectId).map((project) => ({
          id: project.id,
          name: project.name,
        })),
        // A chat already is "No project"; a node without chat support has no such place.
        offerNoProject: chatsAvailable && !isChatProject(source),
        blockedReason: blocker === null ? null : threadProjectMoveBlockerMessage(blocker),
      };
    },
    [readMoveContext],
  );

  const moveThreadToProject = useCallback(
    async (threadRef: ScopedThreadRef, actionId: ThreadMenuActionId): Promise<boolean> => {
      const target = moveToProjectTargetOf(actionId);
      if (target === null) return false;
      const thread = sidebarThreadByKeyRef.current.get(scopedThreadKey(threadRef)) ?? null;
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!thread || !api) return true;
      const { projects, source } = readMoveContext(thread);
      const targetProject =
        target.kind === "project"
          ? projects.find((project) => project.id === target.projectId)
          : null;
      if (target.kind === "project" && !targetProject) return true;
      const targetName = targetProject?.name ?? "No project";
      const sourceIsChat = isChatProject(source);
      const delegatedTaskCount = [...sidebarThreadByKeyRef.current.values()].filter(
        (other) =>
          other.environmentId === thread.environmentId &&
          other.lineage?.parentThreadId === thread.id &&
          other.archivedAt === null,
      ).length;
      const confirmation = threadMoveConfirmation({
        threadTitle: thread.title,
        targetName,
        notices: threadMoveNotices({
          sourceProjectName: source?.name ?? "the old project",
          worktreePath: thread.worktreePath,
          chatFolderPath: sourceIsChat ? (source?.cwd ?? null) : null,
          activePullRequestWatches: thread.pullRequestWatches?.active.length ?? 0,
          commandWatchCount: thread.commandWatchCount ?? 0,
          delegatedTaskCount,
          // A chat folder records no checkpoints; a project thread with turns has some.
          hasFileChanges: !sourceIsChat && thread.latestTurn !== null,
        }),
      });
      if (confirmation !== null) {
        const localApi = readLocalApi();
        const confirmed = localApi
          ? await localApi.dialogs.confirm(confirmation)
          : window.confirm(confirmation);
        if (!confirmed) return true;
      }
      try {
        await api.orchestration.dispatchCommand(
          threadProjectMoveCommand({
            commandId: newCommandId(),
            threadId: thread.id,
            threadTitle: thread.title,
            currentProjectId: thread.projectId,
            target:
              target.kind === "project"
                ? { kind: "project", projectId: targetProject!.id }
                : { kind: "new-chat", projectId: newProjectId() },
            createdAt: new Date().toISOString(),
          }),
        );
        toastManager.add(stackedThreadToast({ type: "success", title: `Moved to ${targetName}` }));
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to move thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return true;
    },
    [readMoveContext, sidebarThreadByKeyRef],
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
      const chatSubject = chat?.resolveSubject(thread) ?? null;
      const moveToProject = includeMoveToProject && !draftId ? moveToProjectMenu(thread) : null;
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
        chat:
          chat && chatSubject
            ? {
                localFolder:
                  chatSubject.folderPath !== null &&
                  thread.environmentId === chat.localEnvironmentId,
                fileManagerLabel: getEditorLabel("file-manager", navigator.platform),
                extensions: chat.extensions
                  .filter((extension) => extension.isAvailable?.(chatSubject) ?? true)
                  .map((extension) => ({ id: extension.id, label: extension.label })),
              }
            : null,
        moveToProject,
      });
    },
    [
      chat,
      includeMoveToProject,
      includeWorkspaceSubmenu,
      memberProjectByScopedKey,
      moveToProjectMenu,
      openProjectSettings,
      resolveThreadWorkspace,
      sidebarThreadByKeyRef,
    ],
  );

  /** Folder actions and menu extensions of a "No project" chat row. */
  const performChatMenuAction = useCallback(
    async (thread: SidebarThreadSummary, actionId: ThreadMenuActionId): Promise<boolean> => {
      if (!actionId.startsWith("chat-")) return false;
      const subject = chat?.resolveSubject(thread) ?? null;
      if (!chat || !subject) return true;
      if (actionId.startsWith(CHAT_EXTENSION_ACTION_PREFIX)) {
        const extensionId = actionId.slice(CHAT_EXTENSION_ACTION_PREFIX.length);
        await chat.extensions.find((extension) => extension.id === extensionId)?.run(subject);
        return true;
      }
      const path = subject.folderPath;
      if (!path) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Chat folder unavailable",
            description: "This chat's folder is not known yet. Try again once it has synced.",
          }),
        );
        return true;
      }
      if (actionId === "chat-copy-folder-path") {
        copyPathToClipboard(path, { path });
        return true;
      }
      await openFolderWithFeedback(
        path,
        actionId === "chat-reveal-folder" ? "file-manager" : "editor",
      );
      return true;
    },
    [chat, copyPathToClipboard],
  );

  const performThreadMenuAction = useCallback(
    async (threadRef: ScopedThreadRef, actionId: ThreadMenuActionId) => {
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const draftId = (thread as SidebarThreadSummary & { draftId?: DraftId | undefined }).draftId;
      const threadProject = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const threadWorkspacePath = thread.worktreePath ?? threadProject?.cwd ?? projectCwd ?? null;

      if (await performChatMenuAction(thread, actionId)) return;
      if (await moveThreadToProject(threadRef, actionId)) return;
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
        await requestThreadArchive({
          target: threadRef,
          thread,
          isDraft: Boolean(draftId),
          confirmThreadArchive: appSettingsConfirmThreadArchive,
          archiveThread,
        });
        return;
      }
      if (actionId !== "delete" && actionId !== "discard-draft") return;
      await requestDeleteThread(thread);
    },
    [
      archiveThread,
      appSettingsConfirmThreadArchive,
      appSettingsConfirmThreadUnpin,
      requestDeleteThread,
      interruptThreadTurn,
      resolveThreadWorkspace,
      router,
      stopThreadSession,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      markThreadUnread,
      memberProjectByScopedKey,
      moveThreadToProject,
      openProjectSettings,
      performChatMenuAction,
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
    requestDeleteThread,
    attemptArchiveThread,
    startThreadRename,
    cancelRename,
    commitRename,
    listThreadMenuActions,
    performThreadMenuAction,
  };
}
