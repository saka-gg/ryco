import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { ThreadEnvMode } from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useSettings } from "../../hooks/useSettings";
import type { useThreadActions } from "../../hooks/useThreadActions";
import { openExternalLink } from "../../lib/openExternalLink";
import { cn } from "../../lib/utils";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME } from "../Sidebar.logic";
import { SidebarGroup, SidebarMenuSub, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useChatRowMenuContext } from "./hooks/useChatRowMenuContext";
import { useSidebarThreadActions } from "./hooks/useSidebarThreadActions";
import { useThreadClipboardActions } from "./hooks/useThreadClipboardActions";
import type { SidebarChatRow } from "./sidebarChats.logic";
import { SidebarThreadRow } from "./SidebarThreadRow";

const CHATS_EXPANDED_STORAGE_KEY = "ryco:sidebar-chats-expanded";
const EMPTY_PROJECT_MEMBERS = new Map();

export interface SidebarChatListProps {
  /** From `buildSidebarChatRows`; the section hides itself when empty. */
  readonly chats: ReadonlyArray<SidebarChatRow>;
  readonly activeRouteThreadKey: string | null;
  readonly handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  readonly trashThread: ReturnType<typeof useThreadActions>["trashThread"];
  readonly stopThreadSession: ReturnType<typeof useThreadActions>["stopThreadSession"];
  readonly interruptThreadTurn: ReturnType<typeof useThreadActions>["interruptThreadTurn"];
  readonly attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  /** Starts a new "No project" chat; null hides the button (chats unavailable). */
  readonly onNewChat: (() => void) | null;
}

/**
 * The sidebar's "Chats" section: "No project" chats live here instead of in the
 * project tree, newest first, one row per chat thread. Rows reuse the project
 * tree's thread row (rename, archive, Trash, selection); their menu swaps the
 * project items for chat folder actions and the chat menu extensions (see
 * `chatRowMenu.ts`, where "Turn into project…" plugs in).
 */
export const SidebarChatList = memo(function SidebarChatList(props: SidebarChatListProps) {
  const { chats, activeRouteThreadKey, attachThreadListAutoAnimateRef, onNewChat } = props;
  const [expanded, setExpanded] = useLocalStorage(CHATS_EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const appSettingsConfirmThreadDelete = useSettings<boolean>((s) => s.confirmThreadDelete);
  const appSettingsConfirmThreadArchive = useSettings<boolean>((s) => s.confirmThreadArchive);
  const appSettingsConfirmThreadUnpin = useSettings<boolean>((s) => s.confirmThreadUnpin);
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>((s) => s.defaultThreadEnvMode);
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const selectedThreadCount = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { copyThreadIdToClipboard, copyPathToClipboard } = useThreadClipboardActions();
  const chat = useChatRowMenuContext();
  const chatByKey = useMemo(
    () =>
      new Map<string, SidebarThreadSummary>(
        chats.map((row) => [scopedThreadKey(scopeThreadRef(row.environmentId, row.id)), row]),
      ),
    [chats],
  );
  // Row actions read the latest rows through this ref, so their callbacks stay stable across
  // list changes. Updated after commit, before any event can read it.
  const chatByKeyRef = useRef<ReadonlyMap<string, SidebarThreadSummary>>(chatByKey);
  useLayoutEffect(() => {
    chatByKeyRef.current = chatByKey;
  }, [chatByKey]);
  const orderedChatKeys = useMemo(() => [...chatByKey.keys()], [chatByKey]);
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();
    openExternalLink(prUrl, "Unable to open pull request link");
  }, []);
  const actions = useSidebarThreadActions({
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
    appSettingsConfirmThreadArchive,
    appSettingsConfirmThreadUnpin,
    defaultThreadEnvMode,
    trashThread: props.trashThread,
    archiveThread: props.archiveThread,
    stopThreadSession: props.stopThreadSession,
    interruptThreadTurn: props.interruptThreadTurn,
    handleNewThread: props.handleNewThread,
    markThreadUnread,
    copyPathToClipboard,
    copyThreadIdToClipboard,
    sidebarThreadByKeyRef: chatByKeyRef,
    memberProjectByScopedKey: EMPTY_PROJECT_MEMBERS,
    projectCwd: null,
    chat,
  });

  if (chats.length === 0) return null;

  return (
    <SidebarGroup className="px-2 pt-0 pb-2" data-testid="sidebar-chats-section">
      <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="sidebar-chats-toggle"
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium text-[10px] text-muted-foreground/60 uppercase tracking-wider transition-colors hover:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 transition-transform duration-150 ease-out motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
          Chats
          <span className="font-normal text-muted-foreground/45 tabular-nums">{chats.length}</span>
        </button>
        {onNewChat ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New chat without a project"
                  data-testid="sidebar-new-chat"
                  className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                  onClick={onNewChat}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">New chat without a project</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {expanded ? (
        <SidebarMenuSub
          ref={attachThreadListAutoAnimateRef}
          aria-label="Chats"
          className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
        >
          {chats.map((row) => {
            const threadKey = scopedThreadKey(scopeThreadRef(row.environmentId, row.id));
            return (
              <SidebarThreadRow
                key={threadKey}
                thread={row}
                projectCwd={null}
                // A chat folder is not a repository: no Git status per row.
                gitStatusTarget={null}
                orderedProjectThreadKeys={orderedChatKeys}
                isActive={activeRouteThreadKey === threadKey}
                jumpLabel={null}
                appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
                renamingThreadKey={actions.renamingThreadKey}
                renamingTitle={actions.renamingTitle}
                setRenamingTitle={actions.setRenamingTitle}
                startThreadRename={actions.startThreadRename}
                renamingInputRef={actions.renamingInputRef}
                renamingCommittedRef={actions.renamingCommittedRef}
                confirmingArchiveThreadKey={confirmingArchiveThreadKey}
                setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
                confirmArchiveButtonRefs={confirmArchiveButtonRefs}
                handleThreadClick={actions.handleThreadClick}
                navigateToThread={actions.navigateToThread}
                navigateToDraft={actions.navigateToDraft}
                handleMultiSelectContextMenu={actions.handleMultiSelectContextMenu}
                handleThreadContextMenu={actions.handleThreadContextMenu}
                requestTrashThread={actions.requestTrashThread}
                clearSelection={clearSelection}
                commitRename={actions.commitRename}
                cancelRename={actions.cancelRename}
                attemptArchiveThread={actions.attemptArchiveThread}
                openPrLink={openPrLink}
              />
            );
          })}
        </SidebarMenuSub>
      ) : null}
    </SidebarGroup>
  );
});
