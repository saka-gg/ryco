import { memo, type Ref } from "react";
import { ChatHeaderBreadcrumb } from "./ChatHeaderBreadcrumb";
import type { WorktreeOriginLike } from "./ChatHeaderBreadcrumb.logic";
import type { LinkedWorktreeItem } from "../worktrees/LinkedWorktreeItemDialog";
import type { WorktreePullRequestLink } from "@ryco/shared/worktreePullRequests";
import { WorktreeSourceControlBadges } from "../worktrees/WorktreeSourceControlBadges";
import type { WorktreePullRequestsToggle } from "../worktrees/WorktreeSourceControlBadges";

export interface ChatHeaderBarProps {
  projectName: string | null | undefined;
  isGitRepo: boolean;
  worktreeBranch: string | null | undefined;
  worktreeTitle: string | null | undefined;
  worktreeOrigin: WorktreeOriginLike;
  worktreeIssueNumber?: number | null | undefined;
  worktreePrNumber?: number | null | undefined;
  worktreeIssueState?: "open" | "closed" | null | undefined;
  worktreePrState?: "open" | "closed" | "merged" | null | undefined;
  worktreePrIsDraft?: boolean | null | undefined;
  /** Every pull request the workspace carries; with the popover, the badge opens them. */
  worktreePullRequests?: ReadonlyArray<WorktreePullRequestLink> | undefined;
  worktreePrUrl?: string | null | undefined;
  worktreePullRequestsToggle?: WorktreePullRequestsToggle | undefined;
  worktreePullRequestBadgeRef?: Ref<HTMLButtonElement> | undefined;
  worktreeWorkItemProvider?: "jira" | null | undefined;
  worktreeWorkItemKey?: string | null | undefined;
  worktreeWorkItemState?: "open" | "in_progress" | "done" | "closed" | "unknown" | null | undefined;
  worktreeWorkItemStateName?: string | null | undefined;
  sessionTitle: string;
  onSelectProject?: (() => void) | undefined;
  onSelectWorktree?: (() => void) | undefined;
  onOpenLinkedWorktreeItem?: ((item: LinkedWorktreeItem) => void) | undefined;
  inlineActions?: React.ReactNode;
}

export const ChatHeaderBar = memo(function ChatHeaderBar({
  worktreePullRequestBadgeRef,
  ...props
}: ChatHeaderBarProps) {
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <ChatHeaderBreadcrumb
          projectName={props.projectName}
          worktreeBranch={props.worktreeBranch}
          worktreeTitle={props.worktreeTitle}
          worktreeOrigin={props.worktreeOrigin}
          sessionTitle={props.sessionTitle}
          {...(props.onSelectProject ? { onSelectProject: props.onSelectProject } : {})}
          {...(props.onSelectWorktree ? { onSelectWorktree: props.onSelectWorktree } : {})}
        />
        <WorktreeSourceControlBadges
          issueNumber={props.worktreeIssueNumber}
          issueState={props.worktreeIssueState}
          prNumber={props.worktreePrNumber}
          prState={props.worktreePrState}
          prIsDraft={props.worktreePrIsDraft}
          workItemProvider={props.worktreeWorkItemProvider}
          workItemKey={props.worktreeWorkItemKey}
          workItemState={props.worktreeWorkItemState}
          workItemStateName={props.worktreeWorkItemStateName}
          density="header"
          labelStyle="kind"
          onOpenLinkedItem={props.onOpenLinkedWorktreeItem}
          prUrl={props.worktreePrUrl}
          pullRequests={props.worktreePullRequests}
          pullRequestsToggle={props.worktreePullRequestsToggle}
          pullRequestBadgeRef={worktreePullRequestBadgeRef}
        />
        {props.projectName && !props.isGitRepo ? (
          <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
            No Git
          </span>
        ) : null}
      </div>
      {props.inlineActions ? (
        <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
          {props.inlineActions}
        </div>
      ) : null}
    </div>
  );
});
