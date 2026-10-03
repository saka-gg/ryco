import type { ChangeRequestReviewThread } from "@ryco/contracts";
import { CheckCircle2Icon, ChevronRightIcon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import {
  useAddChangeRequestCommentReactionMutation,
  useReplyToReviewThreadMutation,
  useSetReviewThreadResolvedMutation,
} from "../../../rpc/useSourceControl";
import { Button } from "../../ui/button";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { usePullRequestAgentHandoff } from "../agentHandoff";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { ReplyComposer } from "./ReplyComposer";
import { ReviewCommentBody, ReviewCommentRow } from "./ReviewComment";
import {
  commentSnippet,
  diffHunkExcerpt,
  suggestionBaseLines,
  threadLocationLabel,
  type DiffHunkLine,
} from "./reviewThread.logic";
import { useFocusAfterReveal } from "./useFocusAfterReveal";

export interface ReviewThreadProps {
  readonly thread: ChangeRequestReviewThread;
  /**
   * `inline`: rendered inside the diff under its line.
   * `timeline`: rendered in Conversation under its review, with a `path:line`
   * header and a short `diffHunk` excerpt; clicking the header reveals it in Files.
   */
  readonly variant: "inline" | "timeline";
  readonly className?: string | undefined;
}

const DISCLOSURE_SHELL =
  "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)";

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Controls focus returns to when the one holding it folds away. */
type ThreadFocusTarget = "resolve" | "reply";

function threadControl(
  section: HTMLElement,
  name: "expand" | ThreadFocusTarget,
): HTMLElement | null {
  return section.querySelector<HTMLElement>(`[data-thread-control="${name}"]`);
}

/**
 * One review thread, the same in the diff and in the timeline: its comments
 * (suggestions drawn as small diffs), then "Reply…", Resolve and a quiet
 * "Ask agent". Resolving collapses the thread to one line at once (the cache
 * write is optimistic, and so is this view); a resolved thread reopens on
 * click. The timeline variant leads with `path:line` and the hunk excerpt the
 * first comment was written against. Focus never drops out of the thread when
 * its own controls fold away: resolving moves it to the one-line header,
 * closing the reply field returns it to "Reply…".
 */
export const ReviewThread = memo(function ReviewThread({
  thread,
  variant,
  className,
}: ReviewThreadProps) {
  const { nav, model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const handoff = usePullRequestAgentHandoff();
  const resolveMutation = useSetReviewThreadResolvedMutation(selection.mutationTarget);
  const replyMutation = useReplyToReviewThreadMutation(selection.mutationTarget);
  const reactionMutation = useAddChangeRequestCommentReactionMutation({
    environmentId: selection.mutationTarget.environmentId,
    cwd: selection.mutationTarget.cwd,
    reference: selection.reference,
  });

  const [optimisticResolved, setOptimisticResolved] = useState<boolean | null>(null);
  const resolved = optimisticResolved ?? thread.isResolved;
  const [expanded, setExpanded] = useState(false);
  const open = !resolved || expanded;
  const [replyOpen, setReplyOpen] = useState(false);
  const replyShellRef = useRef<HTMLDivElement>(null);
  const replyFieldRef = useRef<HTMLTextAreaElement>(null);
  useFocusAfterReveal({ open: replyOpen, shellRef: replyShellRef, targetRef: replyFieldRef });

  // An action that folds away the control holding focus (inert or unmounted)
  // claims focus first; once the thread re-renders it lands on what is left.
  // A control disabled mid-request drops focus to <body>; the thread still
  // owns it then, unless focus has since moved somewhere else.
  const sectionRef = useRef<HTMLElement>(null);
  const focusWithinRef = useRef(false);
  const focusClaimRef = useRef<ThreadFocusTarget | null>(null);
  const claimFocus = (target: ThreadFocusTarget) => {
    const focused = document.activeElement;
    const owned =
      (sectionRef.current?.contains(focused) ?? false) ||
      ((focused === null || focused === document.body) && focusWithinRef.current);
    focusClaimRef.current = owned ? target : null;
  };
  useLayoutEffect(() => {
    const target = focusClaimRef.current;
    const section = sectionRef.current;
    focusClaimRef.current = null;
    if (target === null || !section) return;
    const focused = document.activeElement;
    const stranded =
      focused === null ||
      focused === document.body ||
      !focused.isConnected ||
      (section.contains(focused) && focused.closest("[inert]") !== null);
    if (!stranded) return;
    const next = !open
      ? threadControl(section, "expand")
      : (threadControl(section, target) ??
        threadControl(section, target === "reply" ? "resolve" : "reply"));
    next?.focus({ preventScroll: true });
  });

  const first = thread.comments[0];
  const location = threadLocationLabel(thread);
  const baseLines = suggestionBaseLines(thread);
  const capabilities = model.capabilities;
  const canReact = capabilities.reactions && selection.activity.data?.viewer != null;
  const canReply = capabilities.replyToThreads && thread.viewerCanReply;
  const canResolve =
    capabilities.resolveThreads && (resolved ? thread.viewerCanUnresolve : thread.viewerCanResolve);
  const hiddenCount = Math.max(0, thread.totalComments - thread.comments.length);

  const setResolved = async (next: boolean) => {
    claimFocus("resolve");
    setOptimisticResolved(next);
    setReplyOpen(false);
    setExpanded(false);
    try {
      await resolveMutation.mutateAsync({ threadId: thread.id, resolved: next });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: next ? "Could not resolve the conversation" : "Could not reopen the conversation",
          description: errorDescription(error),
        }),
      );
    } finally {
      // A failed resolve reopens the thread under the header holding focus.
      claimFocus("resolve");
      setOptimisticResolved(null);
    }
  };

  const closeReply = () => {
    claimFocus("reply");
    setReplyOpen(false);
  };

  const threadContext = () =>
    [
      `${location}${thread.isOutdated ? " (outdated)" : ""}`,
      thread.diffHunk ? `\`\`\`diff\n${thread.diffHunk}\n\`\`\`` : null,
      ...thread.comments.map((comment) => `@${comment.author.login}: ${comment.body}`),
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");

  const askAgent = () =>
    void handoff.start({
      kind: "address-thread",
      prompt: `Address this review comment on ${location} in pull request #${selection.number}, then reply with what changed.`,
      context: threadContext(),
    });

  const applySuggestion = (lines: ReadonlyArray<string>) =>
    void handoff.start({
      kind: "apply-suggestion",
      prompt: `Apply the suggested change on ${location} in pull request #${selection.number}.`,
      context: `${threadContext()}\n\nSuggested replacement:\n\`\`\`\n${lines.join("\n")}\n\`\`\``,
    });

  const revealInFiles = () => {
    const anchored = (selection.threads.anchoredByPath.get(thread.path) ?? []).some(
      (entry) => entry.thread.id === thread.id,
    );
    if (anchored) {
      nav.revealThread(thread.id);
      return;
    }
    // Outdated threads live at the end of their file in Files.
    nav.setSearch({
      tab: "files",
      file: thread.path,
      thread: thread.id,
      line: undefined,
      side: undefined,
      commit: undefined,
    });
  };

  return (
    <section
      ref={sectionRef}
      onFocus={() => {
        focusWithinRef.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          focusWithinRef.current = false;
        }
      }}
      data-review-thread-id={thread.id}
      data-resolved={resolved}
      aria-label={`Conversation on ${location}`}
      className={cn(
        "pr-review-thread overflow-hidden rounded-lg border border-border/70 bg-background text-[13px]",
        variant === "inline" && "max-w-[46rem]",
        className,
      )}
    >
      {resolved ? (
        <button
          type="button"
          data-thread-control="expand"
          aria-expanded={open}
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 focus-visible:bg-accent/60",
            open && "border-b border-border/60",
          )}
        >
          <CheckCircle2Icon aria-hidden className="size-3.5 shrink-0 text-success" />
          <span className="shrink-0 text-muted-foreground">Resolved</span>
          {variant === "timeline" ? (
            <span className="min-w-0 shrink truncate font-mono text-[11.5px] text-muted-foreground">
              {location}
            </span>
          ) : null}
          {first ? (
            <span className="shrink-0 font-medium text-foreground">{first.author.login}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
            {first ? commentSnippet(first.body) : ""}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {thread.totalComments}
          </span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--app-motion-duration-chip) ease-(--app-motion-spring-snappy)",
              open && "rotate-90",
            )}
          />
        </button>
      ) : null}
      <div
        className={cn(
          DISCLOSURE_SHELL,
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {variant === "timeline" ? (
            <ThreadLocationHeader
              location={location}
              outdated={thread.isOutdated}
              onReveal={revealInFiles}
              excerpt={diffHunkExcerpt(thread.diffHunk, 4)}
              showLocation={!resolved}
            />
          ) : thread.isOutdated ? (
            <div className="border-b border-border/60">
              <p className="flex h-7 min-w-0 items-center gap-1.5 px-3 text-[11px] text-muted-foreground">
                <span className="shrink-0">Outdated</span>
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate font-mono">{location}</span>
              </p>
              <DiffExcerpt lines={diffHunkExcerpt(thread.diffHunk, 4)} />
            </div>
          ) : null}
          <div className="py-0.5">
            {thread.comments.map((comment) => (
              <ReviewCommentRow
                key={comment.id}
                login={comment.author.login}
                avatarUrl={comment.author.avatarUrl}
                createdAt={comment.createdAt}
                pending={comment.state === "pending"}
                reactions={comment.reactions}
                onReact={
                  canReact && comment.state !== "pending"
                    ? (content) => reactionMutation.mutateAsync({ commentId: comment.id, content })
                    : undefined
                }
                body={
                  <ReviewCommentBody
                    body={comment.body}
                    suggestionBase={baseLines}
                    onApplySuggestion={handoff.available && !resolved ? applySuggestion : undefined}
                    applyUnavailableReason={
                      handoff.available || !handoff.supported
                        ? undefined
                        : handoff.unavailableReason
                    }
                  />
                }
              />
            ))}
            {hiddenCount > 0 ? (
              <p className="px-3 pb-2 pl-[2.625rem] text-xs text-muted-foreground">
                {hiddenCount} more {hiddenCount === 1 ? "reply" : "replies"} on the host
              </p>
            ) : null}
          </div>
          {canReply || canResolve || handoff.available ? (
            <div
              ref={replyShellRef}
              className={cn(
                "grid border-t border-border/60 transition-[grid-template-rows] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
                replyOpen ? "grid-rows-[0fr_1fr]" : "grid-rows-[1fr_0fr]",
              )}
            >
              <div className="min-h-0 overflow-hidden" inert={replyOpen}>
                <div className="flex items-center gap-1 px-1.5 py-1.5">
                  {canReply ? (
                    <button
                      type="button"
                      data-thread-control="reply"
                      aria-expanded={replyOpen}
                      onClick={() => setReplyOpen(true)}
                      className="flex h-7 min-w-0 flex-1 items-center rounded-md px-2 text-left text-xs text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Reply…
                    </button>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {canResolve ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      data-thread-control="resolve"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => void setResolved(!resolved)}
                    >
                      {resolved ? (
                        <RotateCcwIcon className="size-3" />
                      ) : (
                        <CheckCircle2Icon className="size-3 text-success" />
                      )}
                      {resolved ? "Unresolve" : "Resolve"}
                    </Button>
                  ) : null}
                  {handoff.supported ? (
                    <AskAgentButton
                      available={handoff.available}
                      reason={handoff.unavailableReason}
                      onClick={askAgent}
                    />
                  ) : null}
                </div>
              </div>
              <div className="min-h-0 overflow-hidden" inert={!replyOpen}>
                {canReply ? (
                  <ReplyComposer
                    textareaRef={replyFieldRef}
                    onCancel={closeReply}
                    onSubmit={async (body) => {
                      await replyMutation.mutateAsync({ threadId: thread.id, body });
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
});

function AskAgentButton(props: {
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            disabled={!props.available}
            onClick={props.onClick}
          >
            <SparklesIcon className="size-3" />
            Ask agent
          </Button>
        }
      />
      <TooltipPopup side="top" sideOffset={4}>
        {props.available
          ? "Start an agent on the branch to address this"
          : (props.reason ?? "Agents are unavailable")}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Timeline header: `path:line` (opens it in Files) and the hunk excerpt it refers to. */
function ThreadLocationHeader(props: {
  readonly location: string;
  readonly outdated: boolean;
  readonly excerpt: ReadonlyArray<DiffHunkLine>;
  readonly showLocation: boolean;
  readonly onReveal: () => void;
}) {
  return (
    <div className="border-b border-border/60">
      {props.showLocation ? (
        <button
          type="button"
          onClick={props.onReveal}
          className="group/location flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 focus-visible:bg-accent/60"
          title="Show in Files"
        >
          <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground/85 group-hover/location:text-foreground">
            {props.location}
          </span>
          {props.outdated ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">Outdated</span>
          ) : null}
        </button>
      ) : null}
      <DiffExcerpt lines={props.excerpt} className={props.showLocation ? "pt-0" : "pt-1"} />
    </div>
  );
}

/** The few hunk lines a thread was written against, drawn as a quiet diff. */
function DiffExcerpt(props: {
  readonly lines: ReadonlyArray<DiffHunkLine>;
  readonly className?: string | undefined;
}) {
  if (props.lines.length === 0) return null;
  return (
    <div className={cn("overflow-x-auto pb-1 font-mono text-[12px] leading-5", props.className)}>
      {props.lines.map((line, index) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- excerpt lines are positional
          key={index}
          className={cn(
            "flex min-w-max pr-3",
            line.kind === "add" && "bg-[color-mix(in_srgb,var(--background)_92%,var(--success))]",
            line.kind === "del" &&
              "bg-[color-mix(in_srgb,var(--background)_92%,var(--destructive))]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "w-6 shrink-0 text-center select-none",
              line.kind === "add"
                ? "text-success"
                : line.kind === "del"
                  ? "text-destructive"
                  : "text-muted-foreground/50",
            )}
          >
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
          </span>
          <span className="whitespace-pre text-foreground/85">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
