import type {
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  SourceControlCommentReaction,
  SourceControlCommentReactionContent,
  SourceControlReviewState,
} from "@ryco/contracts";
import type { ChangeRequestTimelineReviewItem } from "@ryco/client-runtime/state/pull-request-review";
import { DateTime } from "effect";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CopyIcon,
  EllipsisIcon,
  FileDiffIcon,
  MessageSquareIcon,
  PencilIcon,
  QuoteIcon,
  SmilePlusIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { cn } from "../../../lib/utils";
import {
  useAddChangeRequestCommentReactionMutation,
  useUpdateChangeRequestCommentMutation,
} from "../../../rpc/useSourceControl";
import { buildCommentQuoteMarkdown } from "../../projectExplorer/CommentThread.logic";
import { MarkdownView } from "../../projectExplorer/MarkdownView";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { RelativeTime } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { ReviewThread } from "../threads/ReviewThread";
import { toggleCommentReaction } from "./conversationTimeline.logic";
import { PROSE_CLASS } from "./DescriptionBlock";
import { errorText, MarkdownEditor } from "./MarkdownEditor";
import {
  Actor,
  AvatarNode,
  EventLine,
  TimelineItem,
  TimeSlot,
  VerdictNode,
  type TimelineNodeTone,
} from "./TimelineRail";

type CommentItem = Extract<ChangeRequestTimelineItem, { kind: "comment" }>;

/** A comment or a review body, normalized for the shared header / body / reactions. */
interface Post {
  readonly id: string;
  readonly commentKind: "issue-comment" | "review";
  readonly author: string;
  readonly avatarUrl?: string | undefined;
  readonly isBot: boolean;
  readonly body: string;
  readonly createdAt: DateTime.Utc;
  readonly edited: boolean;
  readonly url?: string | undefined;
  readonly reactions: ReadonlyArray<SourceControlCommentReaction>;
  readonly viewerCanUpdate: boolean;
  readonly viewerCanDelete: boolean;
}

export interface PostActions {
  /** Quote into the timeline composer. */
  readonly onQuote?: ((markdown: string) => void) | undefined;
  /** The host implements reactions (and the viewer is known). */
  readonly canReact: boolean;
  /** The host edits comments; the post's own `viewerCanUpdate` still decides. */
  readonly canEdit: boolean;
  /** The host deletes comments; the post's own `viewerCanDelete` still decides. */
  readonly canDelete: boolean;
}

const REACTIONS: ReadonlyArray<{
  readonly content: SourceControlCommentReactionContent;
  readonly emoji: string;
  readonly label: string;
}> = [
  { content: "thumbs-up", emoji: "👍", label: "Thumbs up" },
  { content: "thumbs-down", emoji: "👎", label: "Thumbs down" },
  { content: "laugh", emoji: "😄", label: "Laugh" },
  { content: "hooray", emoji: "🎉", label: "Hooray" },
  { content: "confused", emoji: "😕", label: "Confused" },
  { content: "heart", emoji: "❤️", label: "Heart" },
  { content: "rocket", emoji: "🚀", label: "Rocket" },
  { content: "eyes", emoji: "👀", label: "Eyes" },
];

const TOOL_BUTTON_CLASS =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground";

function isEdited(createdAt: DateTime.Utc, updatedAt: DateTime.Utc | undefined): boolean {
  return (
    updatedAt !== undefined &&
    DateTime.toEpochMillis(updatedAt) - DateTime.toEpochMillis(createdAt) > 60_000
  );
}

function commentPost(item: CommentItem, actions: PostActions): Post {
  return {
    id: item.id,
    commentKind: "issue-comment",
    author: item.actor?.login ?? "ghost",
    avatarUrl: item.actor?.avatarUrl,
    isBot: item.actor?.isBot === true || (item.actor?.login.endsWith("[bot]") ?? false),
    body: item.body,
    createdAt: item.createdAt,
    edited: isEdited(item.createdAt, item.updatedAt),
    url: item.url,
    reactions: item.reactions ?? [],
    viewerCanUpdate: actions.canEdit && item.viewerCanUpdate === true,
    viewerCanDelete: actions.canDelete && item.viewerCanDelete === true,
  };
}

function reviewPost(review: ChangeRequestTimelineReviewItem, actions: PostActions): Post {
  return {
    id: review.id,
    commentKind: "review",
    author: review.actor?.login ?? "ghost",
    avatarUrl: review.actor?.avatarUrl,
    isBot: review.actor?.isBot === true,
    body: review.body,
    createdAt: review.createdAt,
    edited: false,
    url: review.url,
    reactions: review.reactions ?? [],
    viewerCanUpdate: actions.canEdit && review.viewerCanUpdate === true,
    viewerCanDelete: false,
  };
}

function hasVisibleBody(body: string): boolean {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length > 0;
}

// ── Post state: edit, delete, reactions ──────────────────────────────

function usePost(post: Post) {
  const selection = usePullRequestSelection();
  const updateComment = useUpdateChangeRequestCommentMutation(selection.mutationTarget);
  const react = useAddChangeRequestCommentReactionMutation({
    environmentId: selection.mutationTarget.environmentId,
    cwd: selection.mutationTarget.cwd,
    reference: selection.reference,
  });
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The activity read refreshes after a reaction lands; until then show the
  // viewer's toggle on top of the reactions it was made against.
  const [optimistic, setOptimistic] = useState<{
    readonly base: ReadonlyArray<SourceControlCommentReaction>;
    readonly value: ReadonlyArray<SourceControlCommentReaction>;
  } | null>(null);
  const reactions =
    optimistic !== null && optimistic.base === post.reactions ? optimistic.value : post.reactions;

  const toggleReaction = (content: SourceControlCommentReactionContent) => {
    setError(null);
    setOptimistic({ base: post.reactions, value: toggleCommentReaction(reactions, content) });
    react.mutateAsync({ commentId: post.id, content }).catch((reactionError: unknown) => {
      setOptimistic(null);
      setError(errorText(reactionError, "Could not update the reaction."));
    });
  };

  const saveBody = async (body: string) => {
    await updateComment.mutateAsync({
      commentId: post.id,
      commentKind: post.commentKind,
      action: "edit",
      body,
    });
    setEditing(false);
  };

  const deletePost = async () => {
    try {
      await updateComment.mutateAsync({
        commentId: post.id,
        commentKind: "issue-comment",
        action: "delete",
      });
      setConfirmDelete(false);
    } catch (deleteError) {
      setConfirmDelete(false);
      setError(errorText(deleteError, "Could not delete the comment."));
    }
  };

  return {
    editing,
    setEditing,
    confirmDelete,
    setConfirmDelete,
    deletePending: updateComment.isPending && confirmDelete,
    error,
    reactions,
    toggleReaction,
    saveBody,
    deletePost,
  };
}

type PostState = ReturnType<typeof usePost>;

// ── Pieces ───────────────────────────────────────────────────────────

/** Login and verb, then (on hover) the post's tools, then the time at the right edge. */
function PostHeader(props: {
  readonly children: ReactNode;
  readonly tools?: ReactNode;
  readonly createdAt: DateTime.Utc;
  readonly edited?: boolean | undefined;
}) {
  return (
    <div className="flex min-h-[22px] min-w-0 items-center gap-2 text-[13px]">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">{props.children}</div>
      {props.tools ? (
        <div className="-my-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--app-motion-duration-chip) group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
          {props.tools}
        </div>
      ) : null}
      <TimeSlot>
        {props.edited ? <span className="mr-1.5">edited</span> : null}
        <RelativeTime value={props.createdAt} />
      </TimeSlot>
    </div>
  );
}

function postMenuHasItems(post: Post, actions: PostActions): boolean {
  return (
    actions.onQuote !== undefined ||
    post.url !== undefined ||
    post.viewerCanUpdate ||
    post.viewerCanDelete
  );
}

/** Reactions and the ⋯ menu, when the host and the viewer's rights offer any. */
function postTools(post: Post, state: PostState, actions: PostActions): ReactNode {
  if (!actions.canReact && !postMenuHasItems(post, actions)) return undefined;
  return <PostTools post={post} state={state} actions={actions} />;
}

function PostTools(props: {
  readonly post: Post;
  readonly state: PostState;
  readonly actions: PostActions;
}) {
  const { post, state, actions } = props;
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () =>
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Copied link", timeout: 1600 }),
      ),
  });
  return (
    <>
      {actions.canReact ? (
        <ReactionPicker reactions={state.reactions} onToggle={state.toggleReaction} />
      ) : null}
      {postMenuHasItems(post, actions) ? (
        <Menu>
          <MenuTrigger
            render={
              <button type="button" aria-label="Comment actions" className={TOOL_BUTTON_CLASS}>
                <EllipsisIcon className="size-3.5" />
              </button>
            }
          />
          <MenuPopup align="end" className="min-w-44">
            {actions.onQuote ? (
              <MenuItem
                onClick={() =>
                  actions.onQuote?.(
                    buildCommentQuoteMarkdown({
                      author: post.author,
                      body: post.body,
                      createdAt: post.createdAt,
                    }),
                  )
                }
              >
                <QuoteIcon aria-hidden />
                Quote reply
              </MenuItem>
            ) : null}
            {post.url ? (
              <MenuItem onClick={() => copyToClipboard(post.url ?? "")}>
                <CopyIcon aria-hidden />
                Copy link
              </MenuItem>
            ) : null}
            {(actions.onQuote || post.url) && (post.viewerCanUpdate || post.viewerCanDelete) ? (
              <MenuSeparator />
            ) : null}
            {post.viewerCanUpdate ? (
              <MenuItem onClick={() => state.setEditing(true)}>
                <PencilIcon aria-hidden />
                Edit
              </MenuItem>
            ) : null}
            {post.viewerCanDelete ? (
              <MenuItem variant="destructive" onClick={() => state.setConfirmDelete(true)}>
                <Trash2Icon aria-hidden />
                Delete
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
}

function ReactionPicker(props: {
  readonly reactions: ReadonlyArray<SourceControlCommentReaction>;
  readonly onToggle: (content: SourceControlCommentReactionContent) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button type="button" aria-label="Add reaction" className={TOOL_BUTTON_CLASS}>
            <SmilePlusIcon className="size-3.5" />
          </button>
        }
      />
      <MenuPopup align="end">
        <div className="grid grid-cols-4 gap-0.5">
          {REACTIONS.map((reaction) => {
            const reacted = props.reactions.some(
              (entry) => entry.content === reaction.content && entry.viewerHasReacted === true,
            );
            return (
              <MenuItem
                key={reaction.content}
                aria-label={reaction.label}
                aria-pressed={reacted}
                onClick={() => props.onToggle(reaction.content)}
                className={cn(
                  "size-8 justify-center p-0 text-base sm:size-8 sm:min-h-8",
                  reacted && "bg-accent",
                )}
              >
                {reaction.emoji}
              </MenuItem>
            );
          })}
        </div>
      </MenuPopup>
    </Menu>
  );
}

function ReactionRow(props: {
  readonly reactions: ReadonlyArray<SourceControlCommentReaction>;
  readonly onToggle?: ((content: SourceControlCommentReactionContent) => void) | undefined;
}) {
  const visible = props.reactions.filter((reaction) => reaction.count > 0);
  if (visible.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1">
      {visible.map((reaction) => {
        const meta = REACTIONS.find((entry) => entry.content === reaction.content);
        if (!meta) return null;
        const reacted = reaction.viewerHasReacted === true;
        const content = (
          <>
            <span aria-hidden className="text-[13px] leading-none">
              {meta.emoji}
            </span>
            <span className="tabular-nums">{reaction.count}</span>
          </>
        );
        const className = cn(
          "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors duration-(--app-motion-duration-chip)",
          reacted
            ? "border-foreground/25 text-foreground"
            : "border-border/80 text-muted-foreground",
        );
        return props.onToggle ? (
          <button
            key={reaction.content}
            type="button"
            aria-pressed={reacted}
            aria-label={`${meta.label}: ${reaction.count}${reacted ? ", including you" : ""}`}
            onClick={() => props.onToggle?.(reaction.content)}
            className={cn(
              className,
              "outline-hidden hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {content}
          </button>
        ) : (
          <span
            key={reaction.content}
            className={className}
            aria-label={`${meta.label}: ${reaction.count}`}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
}

function PostBody(props: { readonly post: Post; readonly state: PostState }) {
  const { post, state } = props;
  if (state.editing) {
    return (
      <MarkdownEditor
        className="mt-1.5 max-w-[68ch]"
        initialValue={post.body}
        label={post.commentKind === "review" ? "Review summary" : "Comment"}
        onCancel={() => state.setEditing(false)}
        onSubmit={state.saveBody}
      />
    );
  }
  if (!hasVisibleBody(post.body)) {
    return (
      <p className="mt-1 text-[13px] text-muted-foreground italic">No description provided.</p>
    );
  }
  return <MarkdownView text={post.body} className={cn(PROSE_CLASS, "mt-1")} />;
}

function DeleteDialog(props: { readonly state: PostState }) {
  const { state } = props;
  return (
    <AlertDialog
      open={state.confirmDelete}
      onOpenChange={(open) => !state.deletePending && state.setConfirmDelete(open)}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
          <AlertDialogDescription>
            It is removed from the pull request on the host. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />} disabled={state.deletePending}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={state.deletePending}
            onClick={() => void state.deletePost()}
          >
            Delete comment
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function PostError(props: { readonly state: PostState }) {
  return props.state.error ? (
    <p className="mt-2 text-xs text-destructive" role="status">
      {props.state.error}
    </p>
  ) : null;
}

function BotTag() {
  return (
    <span className="rounded-[4px] border border-border/80 px-1 text-[10px] leading-[14px] text-muted-foreground">
      bot
    </span>
  );
}

// ── Comment ──────────────────────────────────────────────────────────

/** A conversation comment: avatar on the rail, then login, time, body and reactions. */
export const CommentEntry = memo(function CommentEntry(props: {
  readonly item: CommentItem;
  readonly actions: PostActions;
}) {
  const post = commentPost(props.item, props.actions);
  const state = usePost(post);
  const [showHidden, setShowHidden] = useState(false);
  const hidden = props.item.isMinimized === true && !showHidden;
  return (
    <TimelineItem
      size="post"
      id={`comment-${post.id}`}
      node={<AvatarNode login={post.author} avatarUrl={post.avatarUrl} />}
    >
      <PostHeader
        createdAt={post.createdAt}
        edited={post.edited}
        tools={hidden ? undefined : postTools(post, state, props.actions)}
      >
        <Actor login={post.author} />
        {post.isBot ? <BotTag /> : null}
      </PostHeader>
      {hidden ? (
        <p className="mt-1 text-[13px] text-muted-foreground">
          This comment was hidden.{" "}
          <button
            type="button"
            onClick={() => setShowHidden(true)}
            className="rounded-[4px] text-foreground/80 underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Show
          </button>
        </p>
      ) : (
        <>
          <PostBody post={post} state={state} />
          <ReactionRow
            reactions={state.reactions}
            onToggle={props.actions.canReact ? state.toggleReaction : undefined}
          />
        </>
      )}
      <PostError state={state} />
      {post.viewerCanDelete ? <DeleteDialog state={state} /> : null}
    </TimelineItem>
  );
});

// ── Review ───────────────────────────────────────────────────────────

const VERDICTS: Record<
  SourceControlReviewState,
  { readonly verb: string; readonly icon: LucideIcon; readonly tone: TimelineNodeTone }
> = {
  approved: { verb: "approved", icon: CircleCheckIcon, tone: "success" },
  changes_requested: { verb: "requested changes", icon: FileDiffIcon, tone: "danger" },
  commented: { verb: "reviewed", icon: MessageSquareIcon, tone: "muted" },
  dismissed: { verb: "reviewed", icon: CircleSlashIcon, tone: "muted" },
  pending: { verb: "started a review", icon: CircleDashedIcon, tone: "warning" },
};

const VERB_TONE_CLASS: Partial<Record<TimelineNodeTone, string>> = {
  success: "text-success-foreground",
  danger: "text-destructive-foreground",
};

/**
 * A review: its verdict as the rail node, the summary, then each thread it
 * opened. A review with neither body nor threads is a single line.
 */
export const ReviewEntry = memo(function ReviewEntry(props: {
  readonly review: ChangeRequestTimelineReviewItem;
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
  readonly actions: PostActions;
}) {
  const post = reviewPost(props.review, props.actions);
  const state = usePost(post);
  const verdict = VERDICTS[props.review.state];
  const hasBody = hasVisibleBody(post.body) || state.editing;
  const node = <VerdictNode icon={verdict.icon} tone={verdict.tone} label={verdict.verb} />;
  const verb = (
    <span className={cn("text-muted-foreground", VERB_TONE_CLASS[verdict.tone])}>
      {verdict.verb}
    </span>
  );
  const dismissed =
    props.review.state === "dismissed" ? (
      <span className="text-muted-foreground/70">· dismissed</span>
    ) : null;

  if (!hasBody && props.threads.length === 0) {
    return (
      <TimelineItem size="event" id={`review-${post.id}`} node={node}>
        <EventLine time={<RelativeTime value={post.createdAt} />}>
          <Actor login={post.author} /> {verb} {dismissed}
        </EventLine>
      </TimelineItem>
    );
  }

  return (
    <TimelineItem size="post" id={`review-${post.id}`} node={node}>
      <PostHeader
        createdAt={post.createdAt}
        tools={hasBody ? postTools(post, state, props.actions) : undefined}
      >
        <Actor login={post.author} />
        {post.isBot ? <BotTag /> : null}
        {verb}
        {dismissed}
      </PostHeader>
      {hasBody ? (
        <>
          <PostBody post={post} state={state} />
          <ReactionRow
            reactions={state.reactions}
            onToggle={props.actions.canReact ? state.toggleReaction : undefined}
          />
        </>
      ) : null}
      <PostError state={state} />
      {props.threads.length > 0 ? (
        <div className="mt-3 flex max-w-[68ch] flex-col gap-2">
          {props.threads.map((thread) => (
            <ThreadSlot key={thread.id} thread={thread} />
          ))}
        </div>
      ) : null}
    </TimelineItem>
  );
});

// ── Threads ──────────────────────────────────────────────────────────

/**
 * Hosts the shared `ReviewThread` (timeline variant) and marks it for deep
 * links and N/P. Until that component renders anything, a one-line excerpt
 * that reveals the thread stands in (CSS hides it once the host has content).
 */
export function ThreadSlot(props: { readonly thread: ChangeRequestReviewThread }) {
  const { thread } = props;
  return (
    <div
      data-pr-thread={thread.id}
      data-unresolved={thread.isResolved ? undefined : ""}
      className="pr-thread-slot scroll-mt-6 rounded-lg"
    >
      <div className="pr-thread-host">
        <ReviewThread variant="timeline" thread={thread} />
      </div>
      <ThreadExcerpt thread={thread} />
    </div>
  );
}

function ThreadExcerpt(props: { readonly thread: ChangeRequestReviewThread }) {
  const { thread } = props;
  const { nav } = usePullRequestsPage();
  const first = thread.comments[0];
  const name = thread.path.split("/").at(-1) ?? thread.path;
  const line = thread.line ?? thread.originalLine ?? null;
  const status = thread.isOutdated ? "Outdated" : thread.isResolved ? "Resolved" : null;
  return (
    <button
      type="button"
      onClick={() => nav.revealThread(thread.id)}
      title={thread.path}
      className="pr-thread-fallback flex min-h-8 w-full items-center gap-2.5 rounded-lg border border-border/70 px-3 py-1.5 text-left text-xs text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="shrink-0 font-mono text-[11px] text-foreground/85">
        {name}
        {line !== null ? <span className="text-muted-foreground">:{line}</span> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {first ? `${first.author.login}: ${first.body.replace(/\s+/gu, " ")}` : null}
      </span>
      <span className="shrink-0 tabular-nums">
        {status ?? `${thread.totalComments} ${thread.totalComments === 1 ? "comment" : "comments"}`}
      </span>
    </button>
  );
}
