import type {
  SourceControlCommentAuthorRole,
  SourceControlCommentReaction,
  SourceControlCommentReactionContent,
  SourceControlIssueComment,
  SourceControlReviewState,
} from "@ryco/contracts";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CodeIcon,
  CircleHelpIcon,
  EyeIcon,
  FileTextIcon,
  HeartIcon,
  MessageSquareIcon,
  PartyPopperIcon,
  PlusIcon,
  QuoteIcon,
  RocketIcon,
  SendIcon,
  SmileIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XCircleIcon,
} from "lucide-react";
import { DateTime } from "effect";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  appendQuoteToCommentDraft,
  authorAssociationLabel,
  commentRoleBadges,
  commentToneForAuthorRole,
  hasSubmittableCommentDraft,
  normalizeCommentDraftForSubmit,
  type CommentRoleBadgeTone,
  type CommentRoleTone,
} from "./CommentThread.logic";
import { MarkdownView } from "./MarkdownView";
import { CommentAvatar } from "./CommentAvatar";

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const COMMENT_REACTION_META: ReadonlyArray<{
  content: SourceControlCommentReactionContent;
  label: string;
  icon: ReactNode;
}> = [
  { content: "thumbs-up", label: "Thumbs up", icon: <ThumbsUpIcon className="size-3.5" /> },
  { content: "thumbs-down", label: "Thumbs down", icon: <ThumbsDownIcon className="size-3.5" /> },
  { content: "laugh", label: "Laugh", icon: <SmileIcon className="size-3.5" /> },
  { content: "hooray", label: "Hooray", icon: <PartyPopperIcon className="size-3.5" /> },
  { content: "confused", label: "Confused", icon: <CircleHelpIcon className="size-3.5" /> },
  { content: "heart", label: "Heart", icon: <HeartIcon className="size-3.5" /> },
  { content: "rocket", label: "Rocket", icon: <RocketIcon className="size-3.5" /> },
  { content: "eyes", label: "Eyes", icon: <EyeIcon className="size-3.5" /> },
];

function createClientMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Failed to post comment.";
}

function reactionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Failed to update reaction.";
}

export function AuthorAssociationBadge({
  association,
  override,
  tone,
  variant = "default",
}: {
  association?: string | undefined;
  override?: string | undefined;
  tone?: CommentRoleBadgeTone | undefined;
  variant?: "default" | "highlight";
}) {
  const label = override ?? authorAssociationLabel(association);
  if (label === null) return null;
  const badgeTone = tone ?? (variant === "highlight" ? "author" : "default");
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-[10px] font-medium",
        badgeTone === "author"
          ? "border-primary/30 bg-primary/10 text-primary"
          : badgeTone === "owner"
            ? "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300"
            : badgeTone === "maintainer"
              ? "border-sky-500/35 bg-sky-500/12 text-sky-700 dark:text-sky-300"
              : "border-border/60 bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

export interface CommentItemProps {
  author: string;
  body: string;
  createdAt: DateTime.Utc;
  authorAssociation?: string | undefined;
  authorRole?: SourceControlCommentAuthorRole | undefined;
  reviewState?: SourceControlReviewState | undefined;
  isOriginalPost?: boolean;
  itemKind?: "body" | "comment" | "review" | undefined;
  eyebrow?: string | undefined;
  reactions?: ReadonlyArray<SourceControlCommentReaction> | undefined;
  actions?: ReactNode | undefined;
  onQuote?: (() => void) | undefined;
  onAddReaction?:
    | ((content: SourceControlCommentReactionContent) => Promise<void> | void)
    | undefined;
  className?: string;
}

export interface CommentQuoteInsertion {
  readonly id: number;
  readonly markdown: string;
}

const REVIEW_STATE_META: Record<
  SourceControlReviewState,
  { label: string; tone: string; icon: ReactNode }
> = {
  approved: {
    label: "Approved",
    tone: "border-emerald-500/30 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    icon: <CheckCircle2Icon className="size-3" />,
  },
  changes_requested: {
    label: "Changes requested",
    tone: "border-rose-500/30 bg-rose-500/12 text-rose-600 dark:text-rose-400",
    icon: <XCircleIcon className="size-3" />,
  },
  commented: {
    label: "Reviewed",
    tone: "border-sky-500/30 bg-sky-500/12 text-sky-600 dark:text-sky-400",
    icon: <MessageSquareIcon className="size-3" />,
  },
  dismissed: {
    label: "Dismissed",
    tone: "border-border/60 bg-muted text-muted-foreground",
    icon: <XCircleIcon className="size-3" />,
  },
  pending: {
    label: "Pending review",
    tone: "border-amber-500/30 bg-amber-500/12 text-amber-600 dark:text-amber-400",
    icon: <MessageSquareIcon className="size-3" />,
  },
};

function ReviewStateBadge({ state }: { state: SourceControlReviewState }) {
  const meta = REVIEW_STATE_META[state];
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium",
        meta.tone,
      )}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

function commentArticleToneClassName(tone: CommentRoleTone): string {
  switch (tone) {
    case "author":
      return "border-primary/30 bg-primary/4";
    case "owner":
      return "border-amber-500/28 bg-amber-500/8";
    case "maintainer":
      return "border-sky-500/28 bg-sky-500/8";
    case "participant":
      return "border-border/60 bg-muted/24";
  }
}

function commentKindAccentClassName(kind: "body" | "comment" | "review"): string {
  switch (kind) {
    case "body":
      return "border-l-4 border-l-primary/55";
    case "review":
      return "border-l-4 border-l-sky-500/55";
    case "comment":
      return "";
  }
}

function reactionMeta(content: SourceControlCommentReactionContent) {
  return COMMENT_REACTION_META.find((meta) => meta.content === content);
}

function reactionTitle(input: {
  readonly label: string;
  readonly viewerHasReacted: boolean;
}): string {
  return `${input.viewerHasReacted ? "Remove" : "Add"} ${input.label.toLowerCase()} reaction`;
}

function CommentReactionBar(props: {
  reactions: ReadonlyArray<SourceControlCommentReaction>;
  onAddReaction?:
    | ((content: SourceControlCommentReactionContent) => Promise<void> | void)
    | undefined;
}) {
  const [pendingContent, setPendingContent] = useState<SourceControlCommentReactionContent | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const canReact = props.onAddReaction !== undefined;
  const visibleReactions = props.reactions.filter((reaction) => reaction.count > 0);

  if (visibleReactions.length === 0 && !canReact) {
    return null;
  }

  const addReaction = async (content: SourceControlCommentReactionContent) => {
    if (!props.onAddReaction || pendingContent !== null) return;
    setPendingContent(content);
    setError(null);
    try {
      await props.onAddReaction(content);
    } catch (reactionError) {
      setError(reactionErrorMessage(reactionError));
    } finally {
      setPendingContent(null);
    }
  };

  return (
    <footer className="mt-3 flex flex-wrap items-center gap-1.5">
      {visibleReactions.map((reaction) => {
        const meta = reactionMeta(reaction.content);
        if (!meta) return null;
        const isPending = pendingContent === reaction.content;
        const viewerHasReacted = reaction.viewerHasReacted === true;
        const content = (
          <>
            {isPending ? <Spinner className="size-3" /> : meta.icon}
            <span className="font-medium tabular-nums">{reaction.count}</span>
            <span className="sr-only">{meta.label}</span>
          </>
        );
        if (!canReact) {
          return (
            <span
              key={reaction.content}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border/60 bg-muted/35 px-1.5 text-muted-foreground text-xs"
              title={meta.label}
            >
              {content}
            </span>
          );
        }
        return (
          <button
            key={reaction.content}
            type="button"
            disabled={pendingContent !== null}
            onClick={() => void addReaction(reaction.content)}
            aria-pressed={viewerHasReacted}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs transition-colors disabled:opacity-60",
              viewerHasReacted
                ? "border-primary/45 bg-primary/10 text-primary hover:bg-primary/15"
                : "border-border/60 bg-muted/35 text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
            title={reactionTitle({ label: meta.label, viewerHasReacted })}
          >
            {content}
          </button>
        );
      })}
      {canReact ? (
        <Menu>
          <MenuTrigger
            disabled={pendingContent !== null}
            className="inline-flex size-6 items-center justify-center rounded-md border border-dashed border-border/70 text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-60"
            aria-label="Add reaction"
            title="Add reaction"
          >
            <PlusIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-44">
            {COMMENT_REACTION_META.map((meta) => {
              const reaction = props.reactions.find((item) => item.content === meta.content);
              const viewerHasReacted = reaction?.viewerHasReacted === true;
              return (
                <MenuItem
                  key={meta.content}
                  disabled={pendingContent !== null}
                  onClick={() => void addReaction(meta.content)}
                >
                  {pendingContent === meta.content ? <Spinner className="size-3.5" /> : meta.icon}
                  {meta.label}
                  {viewerHasReacted ? (
                    <CheckCircle2Icon className="ms-auto size-3.5 text-primary" />
                  ) : null}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
      {error ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-destructive text-xs">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      ) : null}
    </footer>
  );
}

export const CommentItem = memo(function CommentItem(props: CommentItemProps) {
  const [showRaw, setShowRaw] = useState(false);
  const isoDate = DateTime.toDate(props.createdAt).toISOString();
  const itemKind = props.itemKind ?? (props.reviewState ? "review" : "comment");
  const roleTone = commentToneForAuthorRole(
    props.authorRole,
    props.isOriginalPost,
    props.authorAssociation,
  );
  const roleBadges = commentRoleBadges({
    role: props.authorRole,
    association: props.authorAssociation,
    isOriginalPost: props.isOriginalPost,
  });
  return (
    <article
      className={cn(
        "overflow-hidden rounded-lg border p-3",
        commentArticleToneClassName(roleTone),
        commentKindAccentClassName(itemKind),
        props.className,
      )}
    >
      <header className="mb-2 flex items-start gap-2">
        <CommentAvatar author={props.author} size={itemKind === "body" ? 32 : 28} />
        <div className="min-w-0 flex-1">
          {props.eyebrow ? (
            <div className="mb-0.5 text-muted-foreground text-[11px]">{props.eyebrow}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-sm">{props.author}</span>
            {roleBadges.map((badge) => (
              <AuthorAssociationBadge
                key={`${badge.tone}-${badge.label}`}
                override={badge.label}
                tone={badge.tone}
              />
            ))}
            {props.reviewState ? <ReviewStateBadge state={props.reviewState} /> : null}
          </div>
          <time dateTime={isoDate} className="text-muted-foreground text-xs" title={isoDate}>
            {dateTimeFmt.format(DateTime.toDate(props.createdAt))}
          </time>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.onQuote ? (
            <button
              type="button"
              onClick={props.onQuote}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Quote ${props.author}'s comment`}
              title="Quote reply"
            >
              <QuoteIcon className="size-3.5" />
            </button>
          ) : null}
          {props.actions}
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={showRaw ? "Show rendered markdown" : "Show raw source"}
            title={showRaw ? "Show rendered markdown" : "Show raw source"}
          >
            {showRaw ? <FileTextIcon className="size-3.5" /> : <CodeIcon className="size-3.5" />}
          </button>
        </div>
      </header>
      <MarkdownView text={props.body} raw={showRaw} />
      <CommentReactionBar reactions={props.reactions ?? []} onAddReaction={props.onAddReaction} />
    </article>
  );
});

export function CommentComposer(props: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (input: { readonly body: string; readonly clientMutationId: string }) => Promise<void>;
  quoteInsertion?: CommentQuoteInsertion | null | undefined;
  onQuoteInsertionHandled?: ((id: number) => void) | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mutationIdRef = useRef<string | null>(null);
  const submittedBodyRef = useRef<string | null>(null);
  const handledQuoteInsertionIdRef = useRef<number | null>(null);
  const pendingFocusPositionRef = useRef<number | null>(null);
  const {
    className,
    disabled,
    onQuoteInsertionHandled,
    onSubmit,
    placeholder,
    quoteInsertion,
    submitLabel,
  } = props;

  const submitBody = normalizeCommentDraftForSubmit(draft);
  const canSubmit = !disabled && !isSubmitting && hasSubmittableCommentDraft(draft);

  useEffect(() => {
    const pendingQuoteInsertion = quoteInsertion ?? null;
    if (
      pendingQuoteInsertion === null ||
      handledQuoteInsertionIdRef.current === pendingQuoteInsertion.id ||
      disabled ||
      isSubmitting
    ) {
      return;
    }

    handledQuoteInsertionIdRef.current = pendingQuoteInsertion.id;
    setDraft((currentDraft) => {
      const nextDraft = appendQuoteToCommentDraft(currentDraft, pendingQuoteInsertion.markdown);
      pendingFocusPositionRef.current = nextDraft.length;
      const nextBody = normalizeCommentDraftForSubmit(nextDraft);
      if (submittedBodyRef.current !== null && submittedBodyRef.current !== nextBody) {
        mutationIdRef.current = null;
      }
      return nextDraft;
    });
    setSuccessMessage(null);
    setSubmitError(null);
    onQuoteInsertionHandled?.(pendingQuoteInsertion.id);
  }, [disabled, isSubmitting, onQuoteInsertionHandled, quoteInsertion]);

  useEffect(() => {
    const focusPosition = pendingFocusPositionRef.current;
    if (focusPosition === null) return;
    pendingFocusPositionRef.current = null;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(focusPosition, focusPosition);
  }, [draft]);

  const handleDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextDraft = event.target.value;
    const nextBody = normalizeCommentDraftForSubmit(nextDraft);
    setDraft(nextDraft);
    setSuccessMessage(null);
    setSubmitError(null);
    if (submittedBodyRef.current !== null && submittedBodyRef.current !== nextBody) {
      mutationIdRef.current = null;
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;

    const body = submitBody;
    const clientMutationId = mutationIdRef.current ?? createClientMutationId();
    mutationIdRef.current = clientMutationId;
    submittedBodyRef.current = body;
    setIsSubmitting(true);
    setSubmitError(null);
    setSuccessMessage(null);

    try {
      await onSubmit({ body, clientMutationId });
      setDraft("");
      mutationIdRef.current = null;
      submittedBodyRef.current = null;
      setSuccessMessage("Comment posted.");
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("rounded-lg border border-border/60 bg-background p-3", className)}
    >
      <Textarea
        ref={textareaRef}
        aria-label="Comment body"
        placeholder={placeholder}
        value={draft}
        onChange={handleDraftChange}
        disabled={disabled || isSubmitting}
        size="sm"
        className="min-h-28 bg-muted/12"
      />
      <div className="mt-2 flex min-h-7 items-center gap-2">
        <div className="min-w-0 flex-1 text-xs" aria-live="polite">
          {isSubmitting ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Spinner className="size-3" />
              Posting comment...
            </span>
          ) : submitError ? (
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <AlertCircleIcon className="size-3.5 shrink-0" />
              <span className="truncate">{submitError}</span>
            </span>
          ) : successMessage ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2Icon className="size-3.5 shrink-0" />
              {successMessage}
            </span>
          ) : null}
        </div>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isSubmitting ? <Spinner className="size-3.5" /> : <SendIcon className="size-3.5" />}
          {submitError ? "Retry" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export const CommentThread = memo(function CommentThread(props: {
  comments: ReadonlyArray<SourceControlIssueComment>;
  onQuoteComment?: ((comment: SourceControlIssueComment) => void) | undefined;
}) {
  if (props.comments.length === 0) {
    return null;
  }
  return (
    <ol className="space-y-4">
      {props.comments.map((comment) => (
        <li key={`${comment.author}-${comment.createdAt}-${comment.body}`}>
          <CommentItem
            author={comment.author}
            body={comment.body}
            createdAt={comment.createdAt}
            authorAssociation={comment.authorAssociation}
            authorRole={comment.authorRole}
            reviewState={comment.reviewState}
            reactions={comment.reactions}
            onQuote={
              props.onQuoteComment !== undefined ? () => props.onQuoteComment?.(comment) : undefined
            }
          />
        </li>
      ))}
    </ol>
  );
});
