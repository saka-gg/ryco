import { WS_METHODS } from "@ryco/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { GitPullRequestIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { cn } from "../../lib/utils";

import { CommandDialogTrigger } from "../ui/command";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SIDEBAR_PRIMARY_ACTION_CLASS_NAME =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-hidden ring-ring transition-colors hover:bg-accent focus-visible:ring-2";

export interface SidebarPrimaryActionsProps {
  readonly newThreadShortcutLabel: string | null;
  readonly newThreadDisabled: boolean;
  readonly onNewThread: () => void;
  readonly searchShortcutLabel: string | null;
}

/**
 * Sidebar-level entry points shared by the Projects and Inbox modes, above the
 * mode-specific content.
 *
 * "New thread" starts in the project you last worked in and lets the page's own
 * "Work in …" row retarget from there. "Search" opens the command palette, the
 * one place for everything else — adding a project, jumping to a thread,
 * starting a thread elsewhere — so neither mode can strand you without it.
 * "Pull requests" opens the review page for every connected repository.
 */
export const SidebarPrimaryActions = memo(function SidebarPrimaryActions({
  newThreadShortcutLabel,
  newThreadDisabled,
  onNewThread,
  searchShortcutLabel,
}: SidebarPrimaryActionsProps) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const pullRequestsCapability = useHostedRpcCapability(WS_METHODS.sourceControlListChangeRequests);
  const pullRequestsActive = pathname === "/pull-requests";
  return (
    <div className="space-y-px px-2 pb-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={newThreadDisabled}
              onClick={onNewThread}
              data-testid="sidebar-new-thread-button"
              className={`${SIDEBAR_PRIMARY_ACTION_CLASS_NAME} font-medium text-foreground/90 disabled:pointer-events-none disabled:opacity-50`}
            >
              <SquarePenIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate">New thread</span>
              {newThreadShortcutLabel ? (
                <span className="shrink-0 text-[10px] text-muted-foreground/50">
                  {newThreadShortcutLabel}
                </span>
              ) : null}
            </button>
          }
        />
        <TooltipPopup side="bottom">
          {newThreadDisabled ? "Add a project first" : "Start a new thread"}
        </TooltipPopup>
      </Tooltip>
      <CommandDialogTrigger
        data-testid="command-palette-trigger"
        className={`${SIDEBAR_PRIMARY_ACTION_CLASS_NAME} text-muted-foreground/70 hover:text-foreground`}
      >
        <SearchIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Search</span>
        {searchShortcutLabel ? (
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px] pointer-coarse:hidden">
            {searchShortcutLabel}
          </Kbd>
        ) : null}
      </CommandDialogTrigger>
      {pullRequestsCapability.allowed ? (
        <Link
          to="/pull-requests"
          aria-current={pullRequestsActive ? "page" : undefined}
          data-testid="sidebar-pull-requests-link"
          className={cn(
            SIDEBAR_PRIMARY_ACTION_CLASS_NAME,
            pullRequestsActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <GitPullRequestIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Pull requests</span>
        </Link>
      ) : null}
    </div>
  );
});
