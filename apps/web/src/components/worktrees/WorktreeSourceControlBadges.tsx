import {
  visiblePullRequestLinks,
  type WorktreePullRequestLink,
} from "@ryco/shared/worktreePullRequests";
import type { KeyboardEvent, MouseEvent, Ref } from "react";
import { AtlassianJiraIcon } from "../Icons";
import { openExternalLink } from "~/lib/openExternalLink";
import { cn } from "~/lib/utils";
import { prefersExternalPullRequestLink } from "~/pullRequestsRoute";
import { workItemStateLabel } from "~/lib/workItemState";
import {
  resolveStateBadgeVariant,
  type StateBadgeVariant,
} from "../sourceControl/stateBadgeVariants";
import type { LinkedWorktreeItem } from "./LinkedWorktreeItemDialog";
import {
  describeOtherPullRequests,
  groupWorkspacePullRequests,
  hasSeveralPullRequests,
} from "./workspacePullRequests.logic";

export interface WorktreeSourceControlBadgesProps {
  issueNumber?: number | null | undefined;
  prNumber?: number | null | undefined;
  issueState?: "open" | "closed" | null | undefined;
  prState?: "open" | "closed" | "merged" | null | undefined;
  prIsDraft?: boolean | null | undefined;
  workItemProvider?: "jira" | null | undefined;
  workItemKey?: string | null | undefined;
  workItemState?: "open" | "in_progress" | "done" | "closed" | "unknown" | null | undefined;
  workItemStateName?: string | null | undefined;
  onOpenLinkedItem?: ((item: LinkedWorktreeItem) => void) | undefined;
  className?: string | undefined;
  density?: "compact" | "header" | undefined;
  labelStyle?: "number" | "kind" | undefined;
  displayMode?: "all" | "prefer-pr" | undefined;
  /**
   * Every pull request the workspace carries. With two or more and a
   * `pullRequestsToggle`, the pull request badge toggles the surface's pull
   * requests popover; with one it keeps its single click (`onOpenLinkedItem`).
   */
  pullRequests?: ReadonlyArray<WorktreePullRequestLink> | undefined;
  /** The shown pull request's host URL: ⌘/Ctrl-click opens it there. */
  prUrl?: string | null | undefined;
  /** The surface's pull requests popover, which the badge toggles with several. */
  pullRequestsToggle?: WorktreePullRequestsToggle | undefined;
  /** The pull request badge, one-click or toggle: what the surface's popover hangs from. */
  pullRequestBadgeRef?: Ref<HTMLButtonElement> | undefined;
}

export interface WorktreePullRequestsToggle {
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function WorktreeSourceControlBadges({
  pullRequestBadgeRef,
  ...props
}: WorktreeSourceControlBadgesProps) {
  const prNumber = props.prNumber ?? null;
  const issueNumber =
    props.displayMode === "prefer-pr" && prNumber !== null ? null : (props.issueNumber ?? null);
  const workItemKey = props.workItemProvider === "jira" ? (props.workItemKey ?? null) : null;

  if (issueNumber === null && prNumber === null && workItemKey === null) {
    return null;
  }

  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", props.className)}>
      {workItemKey !== null ? (
        <WorktreeWorkItemBadge
          itemKey={workItemKey}
          state={props.workItemState ?? null}
          stateName={props.workItemStateName ?? null}
          density={props.density ?? "compact"}
          onClick={
            props.onOpenLinkedItem
              ? () =>
                  props.onOpenLinkedItem?.({
                    kind: "workItem",
                    provider: "jira",
                    key: workItemKey,
                  })
              : undefined
          }
        />
      ) : null}
      {issueNumber !== null ? (
        <WorktreeSourceControlBadge
          variant={resolveStateBadgeVariant({
            kind: "issue",
            state: props.issueState ?? null,
          })}
          number={issueNumber}
          kind="issue"
          kindLabel="Issue"
          displayLabel={props.labelStyle === "kind" ? `Issue #${issueNumber}` : `#${issueNumber}`}
          density={props.density ?? "compact"}
          onClick={
            props.onOpenLinkedItem
              ? () => props.onOpenLinkedItem?.({ kind: "issue", number: issueNumber })
              : undefined
          }
        />
      ) : null}
      {prNumber !== null &&
      props.pullRequestsToggle &&
      hasSeveralPullRequests(props.pullRequests ?? []) ? (
        <PullRequestsToggleBadge
          prNumber={prNumber}
          prState={props.prState ?? null}
          prIsDraft={props.prIsDraft ?? null}
          links={props.pullRequests ?? []}
          labelStyle={props.labelStyle}
          density={props.density ?? "compact"}
          toggle={props.pullRequestsToggle}
          badgeRef={pullRequestBadgeRef}
        />
      ) : prNumber !== null ? (
        <WorktreeSourceControlBadge
          variant={resolveStateBadgeVariant({
            kind: "pr",
            state: props.prState ?? null,
            isDraft: props.prIsDraft ?? null,
          })}
          number={prNumber}
          kind="pr"
          kindLabel="Pull request"
          displayLabel={props.labelStyle === "kind" ? `PR #${prNumber}` : `#${prNumber}`}
          density={props.density ?? "compact"}
          externalUrl={props.prUrl ?? null}
          buttonRef={pullRequestBadgeRef}
          onClick={
            props.onOpenLinkedItem
              ? () => props.onOpenLinkedItem?.({ kind: "pr", number: prNumber })
              : undefined
          }
        />
      ) : null}
    </span>
  );
}

/** Header and row badge geometry, shared by every badge kind. */
function badgeBaseClass(density: "compact" | "header"): string {
  return density === "header"
    ? "inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold tabular-nums leading-none"
    : "inline-flex h-4 shrink-0 items-center justify-center gap-0.5 rounded-sm border px-1 text-[9px] font-semibold tabular-nums leading-none";
}

/** The sidebar row toggles on Enter/Space; a badge keeps its own activation. */
function stopRowActivation(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

/**
 * The shown pull request's badge when the workspace carries several: it
 * toggles the surface's pull requests popover. It looks exactly like the
 * one-click badge; only its name says there is more ("· 1 earlier").
 */
function PullRequestsToggleBadge({
  badgeRef,
  ...props
}: {
  badgeRef: Ref<HTMLButtonElement> | undefined;
  prNumber: number;
  prState: "open" | "closed" | "merged" | null;
  prIsDraft: boolean | null;
  links: ReadonlyArray<WorktreePullRequestLink>;
  labelStyle: "number" | "kind" | undefined;
  density: "compact" | "header";
  toggle: WorktreePullRequestsToggle;
}) {
  const variant = resolveStateBadgeVariant({
    kind: "pr",
    state: props.prState,
    isDraft: props.prIsDraft,
  });
  const summary = describeOtherPullRequests({
    groups: groupWorkspacePullRequests({
      links: visiblePullRequestLinks(props.links),
      stack: null,
    }),
    shownNumber: props.prNumber,
  });
  const title = `Pull request #${props.prNumber}${variant.label ? ` — ${variant.label}` : ""}${
    summary ? ` · ${summary}` : ""
  }`;
  const Icon = variant.Icon;
  return (
    <button
      ref={badgeRef}
      type="button"
      className={cn(
        badgeBaseClass(props.density),
        variant.compactClassName,
        "cursor-pointer hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-current",
        props.toggle.open && "brightness-125",
      )}
      title={title}
      aria-label={title}
      aria-haspopup="dialog"
      aria-expanded={props.toggle.open}
      data-linked-worktree-item="pr"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        props.toggle.onToggle();
      }}
      onKeyDown={stopRowActivation}
    >
      <Icon className={props.density === "header" ? "size-3" : "size-2.5"} />
      <span>{props.labelStyle === "kind" ? `PR #${props.prNumber}` : `#${props.prNumber}`}</span>
    </button>
  );
}

function WorktreeWorkItemBadge(props: {
  itemKey: string;
  state: WorktreeSourceControlBadgesProps["workItemState"];
  stateName: string | null;
  density: "compact" | "header";
  onClick?: (() => void) | undefined;
}) {
  const baseClass = badgeBaseClass(props.density);
  const iconClass = props.density === "header" ? "size-3" : "size-2.5";
  const stateLabel = props.state
    ? workItemStateLabel({ state: props.state, stateName: props.stateName })
    : null;
  const title = `Jira ${props.itemKey}${stateLabel ? ` — ${stateLabel}` : ""}`;
  const className = "border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300";

  if (props.onClick) {
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      props.onClick?.();
    };
    return (
      <button
        type="button"
        className={cn(
          baseClass,
          className,
          "cursor-pointer hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-current",
        )}
        title={title}
        aria-label={title}
        data-linked-worktree-item="workItem"
        onClick={handleClick}
        onKeyDown={stopRowActivation}
      >
        <AtlassianJiraIcon className={iconClass} />
        <span>{props.itemKey}</span>
      </button>
    );
  }

  return (
    <span
      className={cn(baseClass, className)}
      title={title}
      aria-label={title}
      data-linked-worktree-item="workItem"
    >
      <AtlassianJiraIcon className={iconClass} />
      <span>{props.itemKey}</span>
    </span>
  );
}

function WorktreeSourceControlBadge({
  buttonRef,
  ...props
}: {
  variant: StateBadgeVariant;
  number: number;
  kind: LinkedWorktreeItem["kind"];
  kindLabel: string;
  displayLabel: string;
  density: "compact" | "header";
  externalUrl?: string | null | undefined;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  onClick?: (() => void) | undefined;
}) {
  const Icon = props.variant.Icon;
  const title = props.variant.label
    ? `${props.kindLabel} #${props.number} — ${props.variant.label}`
    : `${props.kindLabel} #${props.number}`;
  const baseClass = badgeBaseClass(props.density);
  const iconClass = props.density === "header" ? "size-3" : "size-2.5";

  if (props.onClick) {
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.externalUrl && prefersExternalPullRequestLink(event)) {
        openExternalLink(props.externalUrl, "Unable to open pull request link");
        return;
      }
      props.onClick?.();
    };
    return (
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          baseClass,
          props.variant.compactClassName,
          "cursor-pointer hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-current",
        )}
        title={title}
        aria-label={title}
        data-linked-worktree-item={props.kind}
        onClick={handleClick}
        onKeyDown={stopRowActivation}
      >
        <Icon className={iconClass} />
        <span>{props.displayLabel}</span>
      </button>
    );
  }

  return (
    <span
      className={cn(baseClass, props.variant.compactClassName)}
      title={title}
      aria-label={title}
      data-linked-worktree-item={props.kind}
    >
      <Icon className={iconClass} />
      <span>{props.displayLabel}</span>
    </span>
  );
}
