import type { ChangeRequestReviewThread, SourceControlLabel } from "@ryco/contracts";
import type {
  ChangeRequestTimelineCommitItem,
  ChangeRequestTimelineEventSummary,
  ChangeRequestTimelineGroup,
  ChangeRequestTimelineOtherItem,
} from "@ryco/client-runtime/state/pull-request-review";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ClockIcon,
  EyeIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LinkIcon,
  MessageSquareIcon,
  PencilLineIcon,
  RefreshCwIcon,
  TagIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, memo, useId, useState, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { CheckStateGlyph, CHECKS_OVERALL_LABEL, RelativeTime } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { commitChecksOverall, sameRepositoryPullNumber } from "./conversationTimeline.logic";
import { ThreadSlot } from "./TimelinePost";
import { Actor, EventLine, IconNode, TimelineItem, type TimelineNodeTone } from "./TimelineRail";

type EventsGroup = Extract<ChangeRequestTimelineGroup, { kind: "events" }>;
type CommitsGroup = Extract<ChangeRequestTimelineGroup, { kind: "commits" }>;

function Sha(props: { readonly children: ReactNode; readonly className?: string | undefined }) {
  return (
    <code className={cn("font-mono text-[11px] text-foreground/80", props.className)}>
      {props.children}
    </code>
  );
}

function Ref(props: { readonly children: ReactNode }) {
  return <code className="font-mono text-[11px] text-foreground/80">{props.children}</code>;
}

function shortSha(oid: string | undefined): string {
  return oid ? oid.slice(0, 7) : "unknown";
}

/** "a", "a and b", "a, b and c". */
function andList(parts: ReadonlyArray<ReactNode>): ReactNode {
  return parts.map((part, index) => (
    // oxlint-disable-next-line react/no-array-index-key -- a fixed, positional phrase
    <Fragment key={index}>
      {index === 0 ? null : index === parts.length - 1 ? " and " : ", "}
      {part}
    </Fragment>
  ));
}

// ── Commit runs ──────────────────────────────────────────────────────

function CommitRow(props: { readonly commit: ChangeRequestTimelineCommitItem }) {
  const { nav, model } = usePullRequestsPage();
  const { commit } = props;
  const overall = commitChecksOverall(commit.checkState);
  const content = (
    <>
      <Sha className="shrink-0 text-muted-foreground">{commit.shortOid}</Sha>
      <span className="min-w-0 flex-1 truncate">{commit.messageHeadline}</span>
      {overall ? <CheckStateGlyph overall={overall} label={CHECKS_OVERALL_LABEL[overall]} /> : null}
    </>
  );
  const rowClass =
    "-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] text-foreground/90";
  // Hosts without single-commit diffs show the commit without the Files link.
  return (
    <li>
      {model.capabilities.commitDiffs ? (
        <button
          type="button"
          onClick={() => nav.scopeToCommit(commit.oid)}
          title={`Show changes in ${commit.shortOid}`}
          className={cn(
            rowClass,
            "outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
    </li>
  );
}

/** A lone commit inside its event line: sha, headline and checks; scopes Files to it. */
function InlineCommit(props: { readonly commit: ChangeRequestTimelineCommitItem }) {
  const { nav, model } = usePullRequestsPage();
  const { commit } = props;
  const overall = commitChecksOverall(commit.checkState);
  const scopable = model.capabilities.commitDiffs;
  const Root = scopable ? "button" : "span";
  return (
    <Root
      {...(scopable
        ? {
            type: "button" as const,
            onClick: () => nav.scopeToCommit(commit.oid),
            title: `Show changes in ${commit.shortOid}`,
          }
        : {})}
      className="group/commit inline-flex min-w-0 items-center gap-1.5 self-center rounded-[4px] text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Sha className="shrink-0 transition-colors duration-(--app-motion-duration-chip) group-hover/commit:text-foreground">
        {commit.shortOid}
      </Sha>
      <span className="min-w-0 truncate transition-colors duration-(--app-motion-duration-chip) group-hover/commit:text-foreground">
        {commit.messageHeadline}
      </span>
      {overall ? (
        <CheckStateGlyph
          overall={overall}
          label={CHECKS_OVERALL_LABEL[overall]}
          className="size-3"
        />
      ) : null}
    </Root>
  );
}

/**
 * Consecutive pushes by one person. One commit reads inline; more fold into
 * "pushed n commits ›", and each commit scopes Files to itself.
 */
export const CommitRunEntry = memo(function CommitRunEntry(props: {
  readonly group: CommitsGroup;
}) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const time = <RelativeTime value={group.lastAt} />;
  const only = group.commits.length === 1 ? group.commits[0] : undefined;

  if (only) {
    return (
      <TimelineItem size="event" node={<IconNode icon={GitCommitHorizontalIcon} />}>
        <EventLine time={time}>
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">
              <Actor login={group.actor?.login} /> pushed
            </span>
            <InlineCommit commit={only} />
          </span>
        </EventLine>
      </TimelineItem>
    );
  }

  return (
    <TimelineItem size="event" node={<IconNode icon={GitCommitHorizontalIcon} />}>
      <EventLine time={time}>
        <Actor login={group.actor?.login} />{" "}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-0.5 rounded-[4px] outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          pushed <span className="tabular-nums">{group.commits.length}</span> commits
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 transition-transform duration-(--app-motion-duration-chip) ease-(--app-motion-spring-snappy)",
              open && "rotate-90",
            )}
          />
        </button>
      </EventLine>
      <div
        id={regionId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="pt-0.5 pb-1">
            {group.commits.map((commit) => (
              <CommitRow key={commit.id} commit={commit} />
            ))}
          </ul>
        </div>
      </div>
    </TimelineItem>
  );
});

// ── Minor events (labels, assignment, review requests) ───────────────

function LabelName(props: { readonly label: SourceControlLabel }) {
  const color = props.label.color?.replace(/^#/u, "");
  const valid = color !== undefined && /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(color);
  return (
    <span className="inline-flex items-baseline gap-1 text-foreground/85">
      <span
        aria-hidden
        className={cn("size-2 self-center rounded-full", !valid && "bg-muted-foreground/40")}
        style={valid ? { backgroundColor: `#${color}` } : undefined}
      />
      {props.label.name}
    </span>
  );
}

function People(props: { readonly logins: ReadonlyArray<string>; readonly actor?: string }) {
  return andList(
    props.logins.map((login) =>
      login === props.actor ? "themselves" : <Actor key={login} login={login} />,
    ),
  );
}

function summaryParts(summary: ChangeRequestTimelineEventSummary, actor: string | undefined) {
  const parts: ReactNode[] = [];
  const labels = (list: ReadonlyArray<SourceControlLabel>) =>
    andList(list.map((label) => <LabelName key={label.name} label={label} />));
  if (summary.labelsAdded.length > 0) parts.push(<>added {labels(summary.labelsAdded)}</>);
  if (summary.labelsRemoved.length > 0) parts.push(<>removed {labels(summary.labelsRemoved)}</>);
  if (summary.assigned.length > 0) {
    parts.push(
      <>
        assigned <People logins={summary.assigned} {...(actor ? { actor } : {})} />
      </>,
    );
  }
  if (summary.unassigned.length > 0) {
    parts.push(
      <>
        unassigned <People logins={summary.unassigned} {...(actor ? { actor } : {})} />
      </>,
    );
  }
  if (summary.reviewRequested.length > 0) {
    parts.push(
      <>
        requested review from{" "}
        <People logins={summary.reviewRequested.map((entry) => entry.reviewer)} />
      </>,
    );
  }
  if (summary.reviewRequestRemoved.length > 0) {
    parts.push(
      <>
        removed the review request for{" "}
        <People logins={summary.reviewRequestRemoved.map((entry) => entry.reviewer)} />
      </>,
    );
  }
  return parts;
}

function summaryIcon(summary: ChangeRequestTimelineEventSummary): LucideIcon {
  if (summary.labelsAdded.length + summary.labelsRemoved.length > 0) return TagIcon;
  if (summary.assigned.length + summary.unassigned.length > 0) return UserRoundIcon;
  return EyeIcon;
}

/** A run of label, assignee and review-request changes by one person, as one line. */
export const MinorEventsEntry = memo(function MinorEventsEntry(props: {
  readonly group: EventsGroup;
}) {
  const { group } = props;
  const parts = summaryParts(group.summary, group.actor?.login);
  return (
    <TimelineItem size="event" node={<IconNode icon={summaryIcon(group.summary)} />}>
      <EventLine time={<RelativeTime value={group.lastAt} />}>
        <Actor login={group.actor?.login} />{" "}
        {parts.map((part, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a fixed, positional phrase
          <Fragment key={index}>
            {index > 0 ? ", " : null}
            {part}
          </Fragment>
        ))}
      </EventLine>
    </TimelineItem>
  );
});

// ── Other events ─────────────────────────────────────────────────────

type OtherItem = Exclude<ChangeRequestTimelineOtherItem, { kind: "comment" }>;

function CrossReference(props: {
  readonly item: Extract<OtherItem, { kind: "cross-referenced" }>;
}) {
  const { nav } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const { source } = props.item;
  const currentUrl = selection.detail.data?.url ?? selection.summary?.url;
  const number =
    source.kind === "change-request" ? sameRepositoryPullNumber(source.url, currentUrl) : null;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // Pull requests here open in place; ⌘/Ctrl-click still goes to the host.
    if (number === null || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    nav.selectPullRequest(number, { push: true, via: "link" });
  };
  return (
    <>
      mentioned this in{" "}
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={open}
        className="rounded-[4px] text-foreground/85 outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground hover:underline hover:decoration-border hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="tabular-nums">#{source.number}</span> {source.title}
        {number === null ? (
          <ArrowUpRightIcon aria-hidden className="ml-0.5 inline size-3 align-[-1px]" />
        ) : null}
      </a>
      {props.item.willCloseTarget ? " (closes this)" : null}
    </>
  );
}

function describeEvent(item: OtherItem): {
  readonly icon: LucideIcon;
  readonly tone?: TimelineNodeTone;
  readonly text: ReactNode;
} {
  switch (item.kind) {
    case "force-pushed":
      return { icon: RefreshCwIcon, text: <ForcePushText item={item} /> };
    case "renamed":
      return {
        icon: PencilLineIcon,
        text: (
          <>
            changed the title <del className="text-muted-foreground/70">{item.previousTitle}</del>{" "}
            to <span className="text-foreground/85">{item.currentTitle}</span>
          </>
        ),
      };
    case "merged":
      return {
        icon: GitMergeIcon,
        tone: "merged",
        text: (
          <>
            merged {item.commitOid ? <Sha>{shortSha(item.commitOid)}</Sha> : "this"}
            {item.baseRefName ? (
              <>
                {" "}
                into <Ref>{item.baseRefName}</Ref>
              </>
            ) : null}
          </>
        ),
      };
    case "closed":
      return { icon: GitPullRequestClosedIcon, tone: "danger", text: "closed this" };
    case "reopened":
      return { icon: GitPullRequestIcon, tone: "open", text: "reopened this" };
    case "ready-for-review":
      return { icon: EyeIcon, text: "marked this ready for review" };
    case "converted-to-draft":
      return { icon: GitPullRequestDraftIcon, text: "converted this to a draft" };
    case "head-ref-deleted":
      return { icon: GitBranchIcon, text: "deleted the head branch" };
    case "head-ref-restored":
      return { icon: GitBranchIcon, text: "restored the head branch" };
    case "base-ref-changed":
      return {
        icon: GitBranchIcon,
        text: (
          <>
            changed the base
            {item.previousRefName ? (
              <>
                {" "}
                from <Ref>{item.previousRefName}</Ref>
              </>
            ) : null}
            {item.currentRefName ? (
              <>
                {" "}
                to <Ref>{item.currentRefName}</Ref>
              </>
            ) : null}
          </>
        ),
      };
    case "cross-referenced":
      return { icon: LinkIcon, text: <CrossReference item={item} /> };
    case "auto-merge-enabled":
      return {
        icon: ClockIcon,
        text: `enabled auto-merge${item.mergeMethod ? ` (${item.mergeMethod})` : ""}`,
      };
    case "auto-merge-disabled":
      return { icon: ClockIcon, text: "disabled auto-merge" };
    case "review-dismissed":
      return {
        icon: CircleSlashIcon,
        text: (
          <>
            dismissed {item.reviewAuthor ? <Actor login={item.reviewAuthor} /> : "a"}
            {item.reviewAuthor ? "’s" : null} review
            {item.message ? (
              <span className="text-muted-foreground/80">: {item.message}</span>
            ) : null}
          </>
        ),
      };
  }
}

type ForcePushItem = Extract<OtherItem, { kind: "force-pushed" }>;

function ForcePushText(props: { readonly item: ForcePushItem }) {
  return (
    <>
      force-pushed <Sha>{shortSha(props.item.beforeOid)}</Sha>
      <span className="text-muted-foreground/70"> → </span>
      <Sha>{shortSha(props.item.afterOid)}</Sha>
    </>
  );
}

/** "force-pushed a1b2c3d → e4f5a6b": history was rewritten, so earlier commits may be gone. */
export const ForcePushEntry = memo(function ForcePushEntry(props: {
  readonly item: ForcePushItem;
}) {
  return (
    <TimelineItem size="event" node={<IconNode icon={RefreshCwIcon} />}>
      <EventLine time={<RelativeTime value={props.item.createdAt} />}>
        <Actor login={props.item.actor?.login} /> <ForcePushText item={props.item} />
      </EventLine>
    </TimelineItem>
  );
});

/** Any other event (lifecycle, rename, references) as one muted line. */
export const EventEntry = memo(function EventEntry(props: { readonly item: OtherItem }) {
  const { item } = props;
  const event = describeEvent(item);
  return (
    <TimelineItem size="event" node={<IconNode icon={event.icon} tone={event.tone} />}>
      <EventLine time={<RelativeTime value={item.createdAt} />}>
        <Actor login={item.actor?.login} /> {event.text}
      </EventLine>
    </TimelineItem>
  );
});

/** A thread whose review is not in the (truncated) timeline. */
export function UnattachedThreadEntry(props: { readonly thread: ChangeRequestReviewThread }) {
  const first = props.thread.comments[0];
  return (
    <TimelineItem size="post" node={<IconNode icon={MessageSquareIcon} />}>
      <EventLine time={first ? <RelativeTime value={first.createdAt} /> : null}>
        <Actor login={first?.author.login} /> commented on a line
      </EventLine>
      <div className="mt-1.5 max-w-[68ch]">
        <ThreadSlot thread={props.thread} />
      </div>
    </TimelineItem>
  );
}
