// FILE: ChatProjectActions.tsx
// Purpose: The chat-mode actions that replace Git chrome for a "No project"
//          chat: "Turn into project…" (opens the promotion dialog, which grows
//          out of the clicked control) and a quiet "Reveal folder".
// Layer: Web UI. Rendered by the thread header (`ChatHeaderBar`); the overview
//        rail's "Turn into project" section binds through `usePromoteChatBinding`.

import type { ScopedProjectRef, ScopedThreadRef } from "@ryco/contracts";
import { FolderGit2Icon, FolderOpenIcon } from "lucide-react";
import { memo, useMemo, type MouseEvent } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { openFolderWithFeedback } from "../../lib/chatFolderActions";
import type { CrownChatBinding } from "../overview/crown/crownTypes";
import { getEditorLabel } from "../settings/SettingsPanels.editor";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  openPromoteChatDialog,
  preloadPromoteChatDialog,
  useCanPromoteChat,
} from "./promoteChatDialogStore";

/** What turning a chat into a project does, wherever it is offered. */
export const PROMOTE_CHAT_SUMMARY =
  "Move this chat's folder somewhere permanent and add Git, branches, diffs and checkpoints. The conversation stays.";

/** The chat a thread header (or overview rail) shows chat actions for. */
export interface ChatProjectTarget {
  readonly projectRef: ScopedProjectRef;
  readonly threadRef: ScopedThreadRef | null;
  /** The chat's visible title (prefills the project name). */
  readonly title: string;
  /** The chat folder on its device. */
  readonly folderPath: string;
}

function openPromoteChat(chat: ChatProjectTarget, origin: HTMLElement): void {
  openPromoteChatDialog({
    projectRef: chat.projectRef,
    threadRef: chat.threadRef,
    title: chat.title,
    origin,
  });
}

function usePromoteAction(chat: ChatProjectTarget) {
  const canPromote = useCanPromoteChat(chat.projectRef.environmentId);
  const open = (event: MouseEvent<HTMLElement>) => openPromoteChat(chat, event.currentTarget);
  return { canPromote, open };
}

/**
 * The overview rail's "Turn into project" binding: set while `chat` is a chat
 * this client can promote, else undefined (a project, an unsent chat, or a
 * device or session without promotion).
 */
export function usePromoteChatBinding(
  chat: ChatProjectTarget | null,
): CrownChatBinding | undefined {
  const canPromote = useCanPromoteChat(chat?.projectRef.environmentId ?? null);
  return useMemo(
    () =>
      chat && canPromote
        ? {
            turnIntoProject: (origin: HTMLElement) => openPromoteChat(chat, origin),
            preload: preloadPromoteChatDialog,
          }
        : undefined,
    [canPromote, chat],
  );
}

/**
 * Thread header: where a project shows its Git state, a chat offers to become
 * one, plus "Reveal folder" when the folder is on this machine.
 */
export const ChatProjectHeaderActions = memo(function ChatProjectHeaderActions(props: {
  readonly chat: ChatProjectTarget;
}) {
  const { chat } = props;
  const { canPromote, open } = usePromoteAction(chat);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canReveal =
    primaryEnvironmentId !== null && chat.projectRef.environmentId === primaryEnvironmentId;
  if (!canPromote && !canReveal) return null;
  const revealLabel = `Show chat folder in ${getEditorLabel("file-manager", navigator.platform)}`;

  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="chat-header-actions">
      {canPromote ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="xs"
                data-testid="chat-header-promote"
                className="h-6 gap-1 rounded-full px-2 font-medium text-[11px] sm:h-6 sm:text-[11px]"
                onPointerEnter={preloadPromoteChatDialog}
                onFocus={preloadPromoteChatDialog}
                onClick={open}
              />
            }
          >
            <FolderGit2Icon aria-hidden className="size-3 text-primary" />
            Turn into project…
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-64">
            {PROMOTE_CHAT_SUMMARY}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {canReveal ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={revealLabel}
                data-testid="chat-header-reveal-folder"
                className="size-6 text-muted-foreground hover:text-foreground sm:size-6"
                onClick={() => void openFolderWithFeedback(chat.folderPath, "file-manager")}
              />
            }
          >
            <FolderOpenIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{revealLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});
