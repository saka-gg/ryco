import React, { useCallback } from "react";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  type ContextMenuItem,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadEnvMode,
  type ThreadId,
} from "@ryco/contracts";
import { isMacPlatform } from "../../../lib/utils";
import { readLocalApi } from "../../../localApi";
import { useComposerDraftStore, type DraftId } from "../../../composerDraftStore";
import { selectThreadByRef, useStore } from "../../../store";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../../threadRoutes";
import { useThreadSelectionStore } from "../../../threadSelectionStore";
import type { useRouter } from "@tanstack/react-router";
import type { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { trashConfirmationMessage, type useThreadActions } from "../../../hooks/useThreadActions";
import {
  isTrailingDoubleClick,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  shouldConfirmSidebarThreadSelectionDelete,
} from "../../Sidebar.logic";
import type { SidebarThreadSummary } from "../../../types";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";

export type { ThreadMenuActionId, ThreadMenuActionItem } from "./useThreadMenuActions";
import {
  useThreadMenuActions,
  type ThreadMenuActionId,
  type ThreadMenuActionItem,
} from "./useThreadMenuActions";

export function useSidebarThreadActions(params: {
  router: ReturnType<typeof useRouter>;
  isMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  clearSelection: () => void;
  setSelectionAnchor: (threadKey: string) => void;
  toggleThreadSelection: (threadKey: string) => void;
  rangeSelectTo: (threadKey: string, orderedThreadKeys: readonly string[]) => void;
  removeFromSelection: (threadKeys: readonly string[]) => void;
  selectedThreadCount: number;
  appSettingsConfirmThreadDelete: boolean;
  appSettingsConfirmThreadArchive: boolean;
  appSettingsConfirmThreadUnpin: boolean;
  defaultThreadEnvMode: ThreadEnvMode;
  trashThread: ReturnType<typeof useThreadActions>["trashThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  stopThreadSession: ReturnType<typeof useThreadActions>["stopThreadSession"];
  interruptThreadTurn: ReturnType<typeof useThreadActions>["interruptThreadTurn"];
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  copyPathToClipboard: (value: string, ctx: { path: string }) => void;
  copyThreadIdToClipboard: (value: string, ctx: { threadId: ThreadId }) => void;
  sidebarThreadByKeyRef: React.RefObject<ReadonlyMap<string, SidebarThreadSummary>>;
  memberProjectByScopedKey: ReadonlyMap<string, SidebarProjectGroupMember>;
  projectCwd: string | null | undefined;
  /** See `useThreadMenuActions`; the frozen phone tier leaves it unset. */
  openProjectSettings?: (projectRef: ScopedProjectRef) => void;
}) {
  const {
    router,
    isMobile,
    setOpenMobile,
    clearSelection,
    setSelectionAnchor,
    toggleThreadSelection,
    rangeSelectTo,
    removeFromSelection,
    selectedThreadCount,
    appSettingsConfirmThreadDelete,
    defaultThreadEnvMode,
    trashThread,
    handleNewThread,
    markThreadUnread,
    sidebarThreadByKeyRef,
  } = params;

  const {
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
  } = useThreadMenuActions(params);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId, threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/draft/$draftId",
        params: { draftId },
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const handleThreadClick = useCallback(
    (
      event: React.MouseEvent,
      threadRef: ScopedThreadRef,
      orderedProjectThreadKeys: readonly string[],
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const threadKey = scopedThreadKey(threadRef);
      const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedProjectThreadKeys);
        return;
      }

      // Ignore the trailing click of a plain double-click so it doesn't navigate
      // while a double-click is starting an inline rename. Placed after the
      // modifier branches so cmd/shift selection still processes every click.
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }

      if (currentSelectionCount > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [
      clearSelection,
      isMobile,
      rangeSelectTo,
      router,
      setOpenMobile,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "trash", label: `Move to Trash (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = sidebarThreadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "trash") return;

      const shouldConfirmTrash = shouldConfirmSidebarThreadSelectionDelete({
        confirmThreadDelete: appSettingsConfirmThreadDelete,
        threads: threadKeys.map((threadKey) => sidebarThreadByKeyRef.current.get(threadKey)),
      });

      if (shouldConfirmTrash) {
        const confirmed = await api.dialogs.confirm(
          trashConfirmationMessage(
            threadKeys.map(
              (threadKey) => sidebarThreadByKeyRef.current.get(threadKey)?.title ?? "",
            ),
          ),
        );
        if (!confirmed) return;
      }

      const deletedThreadKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = sidebarThreadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        await trashThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
      }
      removeFromSelection(threadKeys);
    },
    [
      appSettingsConfirmThreadDelete,
      clearSelection,
      trashThread,
      markThreadUnread,
      removeFromSelection,
      sidebarThreadByKeyRef,
    ],
  );

  const createThreadForProjectMember = useCallback(
    (
      member: SidebarProjectGroupMember,
      seedOverride?: {
        branch?: string | null;
        envMode: ThreadEnvMode;
        worktreePath?: string | null;
      },
    ) => {
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
      const currentActiveThread =
        currentRouteTarget?.kind === "server"
          ? (selectThreadByRef(useStore.getState(), currentRouteTarget.threadRef) ?? null)
          : null;
      const draftStore = useComposerDraftStore.getState();
      const currentActiveDraftThread =
        currentRouteTarget?.kind === "server"
          ? (draftStore.getDraftThread(currentRouteTarget.threadRef) ?? null)
          : currentRouteTarget?.kind === "draft"
            ? (draftStore.getDraftSession(currentRouteTarget.draftId) ?? null)
            : null;
      const seedContext =
        seedOverride ??
        resolveSidebarNewThreadSeedContext({
          projectId: member.id,
          defaultEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: defaultThreadEnvMode,
          }),
          activeThread:
            currentActiveThread && currentActiveThread.projectId === member.id
              ? {
                  projectId: currentActiveThread.projectId,
                  branch: currentActiveThread.branch,
                  worktreePath: currentActiveThread.worktreePath,
                }
              : null,
          activeDraftThread:
            currentActiveDraftThread && currentActiveDraftThread.projectId === member.id
              ? {
                  projectId: currentActiveDraftThread.projectId,
                  branch: currentActiveDraftThread.branch,
                  worktreePath: currentActiveDraftThread.worktreePath,
                  envMode: currentActiveDraftThread.envMode,
                }
              : null,
        });
      if (isMobile) {
        setOpenMobile(false);
      }
      void handleNewThread(scopeProjectRef(member.environmentId, member.id), {
        ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
        ...(seedContext.worktreePath !== undefined
          ? { worktreePath: seedContext.worktreePath }
          : {}),
        // Contextual choices stay explicit; a plain new draft resolves the owning project's defaults.
        ...(seedOverride ||
        seedContext.branch !== undefined ||
        seedContext.worktreePath !== undefined
          ? { envMode: seedContext.envMode }
          : {}),
      });
    },
    [defaultThreadEnvMode, handleNewThread, isMobile, router, setOpenMobile],
  );

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const draftId = (thread as SidebarThreadSummary & { draftId?: DraftId | undefined }).draftId;
      if (draftId && selectedThreadCount > 0) {
        clearSelection();
      }
      const items = listThreadMenuActions(threadKey);
      if (items.length === 0) return;
      const toNativeItem = (item: ThreadMenuActionItem): ContextMenuItem<ThreadMenuActionId> => ({
        id: item.id,
        label: item.label,
        ...(item.destructive ? { destructive: true } : {}),
        ...(item.children ? { children: item.children.map(toNativeItem) } : {}),
      });
      const clicked = await api.contextMenu.show(items.map(toNativeItem), position);
      if (!clicked) return;
      await performThreadMenuAction(threadRef, clicked as ThreadMenuActionId);
    },
    [
      clearSelection,
      listThreadMenuActions,
      performThreadMenuAction,
      selectedThreadCount,
      sidebarThreadByKeyRef,
    ],
  );

  return {
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingCommittedRef,
    renamingInputRef,
    navigateToThread,
    navigateToDraft,
    requestTrashThread,
    handleThreadClick,
    handleMultiSelectContextMenu,
    createThreadForProjectMember,
    attemptArchiveThread,
    startThreadRename,
    cancelRename,
    commitRename,
    listThreadMenuActions,
    performThreadMenuAction,
    handleThreadContextMenu,
  };
}
