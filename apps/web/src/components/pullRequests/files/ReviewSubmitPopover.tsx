import type { ChangeRequestReviewEvent } from "@ryco/contracts";
import {
  buildSubmitReviewInput,
  isReviewDraftCommentOutdated,
  type ReviewDraft,
  type ReviewDraftComment,
} from "@ryco/client-runtime/state/pull-request-review";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../../lib/utils";
import { usePullRequestReviewDraftStore } from "../../../pullRequestReviewDraftStore";
import { useSubmitChangeRequestReviewMutation } from "../../../rpc/useSourceControl";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { KeyHint } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { SUBMIT_SHORTCUT_LABEL } from "../threads/ReplyComposer";
import { commentSnippet } from "../threads/reviewThread.logic";
import { lineCommentTargetLabel } from "./pullRequestFiles.logic";

const EVENTS: ReadonlyArray<{ readonly id: ChangeRequestReviewEvent; readonly label: string }> = [
  { id: "comment", label: "Comment" },
  { id: "approve", label: "Approve" },
  { id: "request_changes", label: "Request changes" },
];

const CONFIRM_WINDOW_MS = 4000;

function draftLocation(comment: ReviewDraftComment): string {
  const name = comment.path.split("/").at(-1) ?? comment.path;
  if (comment.subjectType === "file" || comment.line === undefined) return name;
  const label = lineCommentTargetLabel({
    path: comment.path,
    line: comment.line,
    side: comment.side ?? "right",
    ...(comment.startLine !== undefined
      ? { startLine: comment.startLine, startSide: comment.startSide ?? comment.side ?? "right" }
      : {}),
  });
  return `${name}:${label.replace(/^lines? /u, "")}`;
}

/**
 * Finishing the pending review: a summary, the verdict, and the comments that
 * go with it (each one a jump back to its line). Drafts written against an
 * older head are marked and can be removed; they are never sent. Comments in
 * a review the viewer started on the host are submitted along with it.
 */
export function ReviewSubmitPopover(props: {
  readonly draftKey: string;
  readonly draft: ReviewDraft;
  readonly onClose: () => void;
}) {
  const { nav, model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const { draftKey, draft } = props;
  const viewer = selection.activity.data?.viewer ?? null;
  const hostPending = selection.activity.data?.pendingReview ?? null;
  const headSha = selection.headSha;
  const isAuthor = viewer?.isAuthor ?? false;
  const event: ChangeRequestReviewEvent =
    isAuthor && draft.event !== "comment" ? "comment" : (draft.event ?? "comment");

  const setSummary = usePullRequestReviewDraftStore((state) => state.setSummary);
  const setEvent = usePullRequestReviewDraftStore((state) => state.setEvent);
  const removeComments = usePullRequestReviewDraftStore((state) => state.removeComments);
  const removeComment = usePullRequestReviewDraftStore((state) => state.removeComment);
  const clear = usePullRequestReviewDraftStore((state) => state.clear);
  const clearSubmitted = usePullRequestReviewDraftStore((state) => state.clearSubmitted);
  const submit = useSubmitChangeRequestReviewMutation(selection.mutationTarget);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const summaryRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!confirmDiscard) return;
    const timer = window.setTimeout(() => setConfirmDiscard(false), CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [confirmDiscard]);

  const outdated = draft.comments.filter((comment) =>
    isReviewDraftCommentOutdated(comment, headSha),
  );
  const hasAnything =
    draft.comments.length > 0 ||
    draft.summary.trim().length > 0 ||
    (hostPending?.commentsCount ?? 0) > 0;

  const onSubmit = async () => {
    if (submit.isPending || !model.cwd) return;
    setError(null);
    const built = buildSubmitReviewInput(draft, {
      cwd: model.cwd,
      reference: selection.reference,
      headSha,
      event,
      hostPendingComments: hostPending?.commentsCount ?? 0,
    });
    if (!built.ok) {
      setError(built.message);
      return;
    }
    const { cwd: _cwd, reference: _reference, ...payload } = built.input;
    try {
      await submit.mutateAsync(payload);
      clearSubmitted(draftKey, {
        commentIds: built.commentIds,
        summary: built.summary,
        event: built.event,
      });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title:
            built.event === "approve"
              ? "Approved"
              : built.event === "request_changes"
                ? "Changes requested"
                : "Review submitted",
          timeout: 2000,
        }),
      );
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the review.");
    }
  };

  const onSummaryKeyDown = (keyEvent: KeyboardEvent<HTMLTextAreaElement>) => {
    if (keyEvent.key === "Enter" && (keyEvent.metaKey || keyEvent.ctrlKey)) {
      keyEvent.preventDefault();
      void onSubmit();
    }
  };

  const jumpTo = (comment: ReviewDraftComment) => {
    props.onClose();
    nav.revealFile(
      comment.path,
      comment.line,
      comment.line === undefined ? undefined : comment.side,
    );
  };

  return (
    <div className="flex w-[min(24rem,calc(100vw-2rem))] flex-col">
      <div className="space-y-3 px-4 pt-4 pb-3">
        <p className="text-[13px] font-medium text-foreground">Finish your review</p>
        <textarea
          ref={summaryRef}
          aria-label="Review summary"
          placeholder="Leave a summary (optional)"
          value={draft.summary}
          onChange={(change) => setSummary(draftKey, change.target.value)}
          onKeyDown={onSummaryKeyDown}
          disabled={submit.isPending}
          className="block field-sizing-content max-h-48 min-h-20 w-full resize-none rounded-lg border border-border/70 bg-transparent px-3 py-2.5 text-[13px] leading-[1.55] text-foreground outline-none transition-colors duration-(--app-motion-duration-chip) placeholder:text-muted-foreground/70 focus:border-ring/50"
        />
        <div>
          <div
            role="radiogroup"
            aria-label="Verdict"
            className="flex gap-0.5 rounded-lg border border-border/70 p-0.5"
          >
            {EVENTS.map((option) => {
              const disabled = isAuthor && option.id !== "comment";
              const checked = event === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={disabled || submit.isPending}
                  onClick={() => setEvent(draftKey, option.id)}
                  className={cn(
                    "h-7 flex-auto rounded-md px-2.5 text-xs whitespace-nowrap outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45",
                    checked
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {isAuthor ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              You opened this pull request, so you can comment but not approve or request changes.
            </p>
          ) : null}
        </div>
      </div>
      {draft.comments.length > 0 || hostPending ? (
        <div className="border-t border-border/60 px-4 pt-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Pending comments <span className="tabular-nums">· {draft.comments.length}</span>
            </p>
            {outdated.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  removeComments(
                    draftKey,
                    outdated.map((comment) => comment.id),
                  )
                }
                className="rounded text-[11px] text-muted-foreground underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Remove {outdated.length} outdated
              </button>
            ) : null}
          </div>
          {draft.comments.length > 0 ? (
            <ul className="-mx-2 mt-1.5 max-h-48 overflow-y-auto">
              {draft.comments.map((comment) => {
                const isOutdated = isReviewDraftCommentOutdated(comment, headSha);
                return (
                  <li key={comment.id} className="group/pending flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => jumpTo(comment)}
                      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[11px]",
                          isOutdated ? "text-muted-foreground line-through" : "text-foreground/85",
                        )}
                      >
                        {draftLocation(comment)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {isOutdated ? "Outdated · " : ""}
                        {commentSnippet(comment.body, 90)}
                      </span>
                      <ArrowUpRightIcon
                        aria-hidden
                        className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-(--app-motion-duration-chip) group-hover/pending:opacity-100"
                      />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove pending comment on ${draftLocation(comment)}`}
                      onClick={() => removeComment(draftKey, comment.id)}
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-[opacity,color,background-color] duration-(--app-motion-duration-chip) group-focus-within/pending:opacity-100 group-hover/pending:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {hostPending && hostPending.commentsCount > 0 ? (
            <p className="mt-1.5 mb-1 text-[11px] text-muted-foreground">
              Also submits {hostPending.commentsCount}{" "}
              {hostPending.commentsCount === 1 ? "comment" : "comments"} from the review you started
              on GitHub.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-12 items-center gap-2 border-t border-border/60 px-3 py-2">
        {draft.comments.length > 0 || draft.summary.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={submit.isPending}
            onClick={() => {
              if (!confirmDiscard) {
                setConfirmDiscard(true);
                return;
              }
              clear(draftKey);
              setConfirmDiscard(false);
              props.onClose();
            }}
            className={cn(
              confirmDiscard
                ? "text-destructive-foreground hover:text-destructive-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {confirmDiscard
              ? `Discard ${draft.comments.length > 0 ? `${draft.comments.length} ${draft.comments.length === 1 ? "comment" : "comments"}` : "review"}?`
              : "Discard"}
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 truncate text-xs text-destructive" aria-live="polite">
          {error}
        </div>
        <Button
          size="sm"
          disabled={submit.isPending || (!hasAnything && event !== "approve") || !headSha}
          onClick={() => void onSubmit()}
        >
          {submit.isPending ? <Spinner className="size-3.5" /> : null}
          Submit review
          <KeyHint className="border-current/25 text-current/70">{SUBMIT_SHORTCUT_LABEL}</KeyHint>
        </Button>
      </div>
    </div>
  );
}
