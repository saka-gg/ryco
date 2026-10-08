// FILE: ChatProjectActions.tsx
// Purpose: The chat-mode actions that replace Git chrome for a "No project"
//          chat: "Turn into project…" (opens the promotion dialog, which grows
//          out of the clicked control) and a quiet "Reveal folder".
// Layer: Web UI. Rendered by the thread header (`ChatHeaderBar`) and by the
//        overview panel's source-control slot (`GitActionsControl`).

import type { ScopedProjectRef, ScopedThreadRef } from "@ryco/contracts";
import { FolderGit2Icon, FolderOpenIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { openFolderWithFeedback } from "../../lib/chatFolderActions";
import { cn } from "../../lib/utils";
import { getEditorLabel } from "../settings/SettingsPanels.editor";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  openPromoteChatDialog,
  preloadPromoteChatDialog,
  useCanPromoteChat,
} from "./promoteChatDialogStore";

/** The chat a thread header (or overview panel) shows chat actions for. */
export interface ChatProjectTarget {
  readonly projectRef: ScopedProjectRef;
  readonly threadRef: ScopedThreadRef | null;
  /** The chat's visible title (prefills the project name). */
  readonly title: string;
  /** The chat folder on its device. */
  readonly folderPath: string;
}

function usePromoteAction(chat: ChatProjectTarget) {
  const canPromote = useCanPromoteChat(chat.projectRef.environmentId);
  const open = (event: MouseEvent<HTMLElement>) =>
    openPromoteChatDialog({
      projectRef: chat.projectRef,
      threadRef: chat.threadRef,
      title: chat.title,
      origin: event.currentTarget,
    });
  return { canPromote, open };
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
            Move this chat's folder somewhere permanent and add Git, branches, diffs and
            checkpoints. The conversation stays.
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

/**
 * Overview panel: stands in for "Initialize Git" (and the Git actions) while
 * the thread's project is a chat.
 */
export function ChatProjectPromoteBlock(props: {
  readonly chat: ChatProjectTarget;
  readonly block: boolean;
}) {
  const { canPromote, open } = usePromoteAction(props.chat);
  if (!canPromote) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", props.block && "w-full")}>
      <Button
        variant={props.block ? "default" : "outline"}
        size={props.block ? "sm" : "xs"}
        data-testid="chat-promote-block"
        className={cn(props.block && "h-8 w-full justify-center gap-1.5 text-[13px]")}
        onPointerEnter={preloadPromoteChatDialog}
        onFocus={preloadPromoteChatDialog}
        onClick={open}
      >
        <FolderGit2Icon aria-hidden />
        Turn into project…
      </Button>
      {props.block ? (
        <p className="text-center text-[11px] text-muted-foreground">
          Adds Git, branches, diffs and checkpoints. The conversation stays.
        </p>
      ) : null}
    </div>
  );
}
