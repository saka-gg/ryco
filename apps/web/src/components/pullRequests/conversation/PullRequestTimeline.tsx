import type {
  ChangeRequestActivity,
  ChangeRequestTimelineItem,
  SourceControlIssueComment,
} from "@ryco/contracts";
import { groupChangeRequestTimeline } from "@ryco/client-runtime/state/pull-request-review";
import { ArrowUpRightIcon, HistoryIcon } from "lucide-react";
import { memo, useMemo, type Ref } from "react";

import { invalidateSourceControl } from "../../../rpc/useSourceControl";
import { Skeleton } from "../../ui/skeleton";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import {
  buildConversationTimeline,
  type ConversationTimelineEntry,
} from "./conversationTimeline.logic";
import { TimelineComposer, type TimelineComposerHandle } from "./TimelineComposer";
import {
  CommitRunEntry,
  EventEntry,
  ForcePushEntry,
  MinorEventsEntry,
  UnattachedThreadEntry,
} from "./TimelineEvents";
import { CommentEntry, ReviewEntry, type PostActions } from "./TimelinePost";
import { AvatarNode, EventLine, IconNode, TimelineItem, TimelineList } from "./TimelineRail";

type CommentItem = Extract<ChangeRequestTimelineItem, { kind: "comment" }>;

/**
 * Conversation's history: the grouped activity timeline (comments, reviews
 * with their threads, commit runs, force-pushes, merged minor events) on one
 * rail, ending in the comment composer. Hosts without the activity read
 * (everything but GitHub) get the pull request's comments as a flat timeline.
 */
export function PullRequestTimeline(props: {
  readonly composerRef?: Ref<TimelineComposerHandle> | undefined;
  readonly onQuote: (markdown: string) => void;
}) {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const activity = selection.activity;

  if (!model.supportsReview) return <DetailCommentsTimeline />;
  if (activity.data) {
    return (
      <ActivityTimeline
        activity={activity.data}
        composerRef={props.composerRef}
        onQuote={props.onQuote}
      />
    );
  }
  if (activity.error) {
    return (
      <TimelineNotice
        message="Couldn’t load the activity."
        onRetry={() =>
          invalidateSourceControl({
            environmentId: selection.mutationTarget.environmentId,
            cwd: selection.mutationTarget.cwd,
          })
        }
      />
    );
  }
  return <TimelineSkeleton />;
}

function ActivityTimeline({
  activity,
  composerRef,
  onQuote,
}: {
  readonly activity: ChangeRequestActivity;
  readonly composerRef?: Ref<TimelineComposerHandle> | undefined;
  readonly onQuote: (markdown: string) => void;
}) {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const entries = useMemo(
    () =>
      buildConversationTimeline(
        groupChangeRequestTimeline(activity.timeline, activity.reviewThreads),
      ),
    [activity.timeline, activity.reviewThreads],
  );
  const viewer = activity.viewer;
  const actions = useMemo<PostActions>(
    () => ({ canReact: viewer !== null, onQuote: viewer !== null ? onQuote : undefined }),
    [onQuote, viewer],
  );
  const state = detail?.state ?? selection.summary?.state ?? "open";
  const url = detail?.url ?? selection.summary?.url ?? null;

  return (
    <TimelineList label="Activity">
      {activity.timelineTruncated && url ? (
        <EarlierActivityEntry url={url} host={model.provider?.name ?? "GitHub"} />
      ) : null}
      {entries.map((entry) => (
        <TimelineEntry key={entry.id} entry={entry} actions={actions} />
      ))}
      {viewer && selection.draftKey ? (
        <TimelineItem
          size="post"
          node={
            <AvatarNode login={viewer.login} avatarUrl={viewerAvatar(activity, viewer.login)} />
          }
        >
          <TimelineComposer
            ref={composerRef}
            draftKey={selection.draftKey}
            canClose={viewer.canUpdate && state === "open"}
          />
        </TimelineItem>
      ) : null}
    </TimelineList>
  );
}

/** The viewer's avatar, borrowed from anything they did on this pull request. */
function viewerAvatar(activity: ChangeRequestActivity, login: string): string | undefined {
  const key = login.toLowerCase();
  for (const item of activity.timeline) {
    if (item.actor?.login.toLowerCase() === key && item.actor.avatarUrl) {
      return item.actor.avatarUrl;
    }
  }
  return undefined;
}

const TimelineEntry = memo(function TimelineEntry(props: {
  readonly entry: ConversationTimelineEntry;
  readonly actions: PostActions;
}) {
  const { entry, actions } = props;
  if (entry.kind === "thread") return <UnattachedThreadEntry thread={entry.thread} />;
  const { group } = entry;
  switch (group.kind) {
    case "commits":
      return <CommitRunEntry group={group} />;
    case "events":
      return <MinorEventsEntry group={group} />;
    case "review":
      return <ReviewEntry review={group.review} threads={group.threads} actions={actions} />;
    case "item": {
      const item = group.item;
      if (item.kind === "comment") return <CommentEntry item={item} actions={actions} />;
      if (item.kind === "force-pushed") return <ForcePushEntry item={item} />;
      return <EventEntry item={item} />;
    }
  }
});

function EarlierActivityEntry(props: { readonly url: string; readonly host: string }) {
  return (
    <TimelineItem size="event" node={<IconNode icon={HistoryIcon} />}>
      <EventLine>
        <a
          href={props.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 rounded-[4px] outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Earlier activity on {props.host}
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      </EventLine>
    </TimelineItem>
  );
}

// ── Hosts without the activity read ──────────────────────────────────

function detailCommentItem(comment: SourceControlIssueComment, index: number): CommentItem {
  return {
    id: comment.id ?? `detail-comment-${index}`,
    createdAt: comment.createdAt,
    actor: { login: comment.author || "ghost" },
    kind: "comment",
    body: comment.body,
    ...(comment.authorAssociation ? { authorAssociation: comment.authorAssociation } : {}),
    ...(comment.reactions ? { reactions: comment.reactions } : {}),
  };
}

const READ_ONLY_ACTIONS: PostActions = { canReact: false };

function DetailCommentsTimeline() {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const items = useMemo(() => (detail?.comments ?? []).map(detailCommentItem), [detail?.comments]);
  if (!detail) return selection.detail.error ? null : <TimelineSkeleton />;
  if (items.length === 0 && !detail.truncated) return null;
  return (
    <TimelineList label="Comments">
      {detail.truncated ? (
        <EarlierActivityEntry url={detail.url} host={model.provider?.name ?? "the host"} />
      ) : null}
      {items.map((item) => (
        <CommentEntry key={item.id} item={item} actions={READ_ONLY_ACTIONS} />
      ))}
    </TimelineList>
  );
}

// ── Loading and errors ───────────────────────────────────────────────

/** Matches the timeline's geometry: event lines, then a post with a body. */
export function TimelineSkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      {[0.42, 0.3].map((width) => (
        <div key={width} className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 pb-2.5">
          <div className="flex size-[22px] items-center justify-center">
            <Skeleton className="size-3.5 rounded-full" />
          </div>
          <div className="flex h-[22px] items-center">
            <Skeleton className="h-3 rounded-full" style={{ width: `${width * 100}%` }} />
          </div>
        </div>
      ))}
      <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 pt-4">
        <Skeleton className="size-[22px] rounded-full" />
        <div className="flex max-w-[68ch] flex-col gap-2.5 pt-1">
          <Skeleton className="h-3 w-32 rounded-full" />
          <Skeleton className="h-3.5 w-[92%] rounded-full" />
          <Skeleton className="h-3.5 w-[78%] rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function TimelineNotice(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      {props.message}
      <button
        type="button"
        onClick={props.onRetry}
        className="rounded-[4px] text-foreground/80 underline decoration-border underline-offset-2 outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Retry
      </button>
    </p>
  );
}
