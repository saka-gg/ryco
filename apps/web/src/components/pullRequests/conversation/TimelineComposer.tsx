import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { cn } from "../../../lib/utils";
import {
  useAddChangeRequestCommentMutation,
  useUpdateChangeRequestMutation,
} from "../../../rpc/useSourceControl";
import {
  appendQuoteToCommentDraft,
  hasSubmittableCommentDraft,
  normalizeCommentDraftForSubmit,
} from "../../projectExplorer/CommentThread.logic";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { usePullRequestSelection } from "../PullRequestsPageContext";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_TEXTAREA_CLASS,
  errorText,
  handleComposerKeys,
  SubmitKeyHint,
} from "./MarkdownEditor";

export interface TimelineComposerHandle {
  /** Append a quote to the draft, then focus the composer and bring it into view. */
  quote(markdown: string): void;
}

/** Drafts survive switching pull requests (the reader remounts per pull request). */
const drafts = new Map<string, string>();

function createClientMutationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The comment box at the end of the timeline. It rests as a single line; on
 * focus (or with a draft) its action row grows in with "Comment" (⌘↵), plus
 * "Close with comment" once there is text and the viewer may close. Closing
 * without a comment lives in the bar's menu, behind a confirmation.
 */
export function TimelineComposer(props: {
  readonly draftKey: string;
  readonly canClose: boolean;
  readonly ref?: Ref<TimelineComposerHandle> | undefined;
}) {
  const selection = usePullRequestSelection();
  const addComment = useAddChangeRequestCommentMutation({
    environmentId: selection.mutationTarget.environmentId,
    cwd: selection.mutationTarget.cwd,
    reference: selection.reference,
  });
  const update = useUpdateChangeRequestMutation(selection.mutationTarget);
  const [draft, setDraftState] = useState(() => drafts.get(props.draftKey) ?? "");
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState<"comment" | "close" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mutationIdRef = useRef<string | null>(null);
  // The field is disabled while posting, which drops focus to <body>; give it
  // back once the post settles if nothing else took it meanwhile.
  const refocusRef = useRef(false);
  useEffect(() => {
    if (pending !== null || !refocusRef.current) return;
    refocusRef.current = false;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [pending]);

  const setDraft = (next: string) => {
    setDraftState(next);
    if (next.length > 0) drafts.set(props.draftKey, next);
    else drafts.delete(props.draftKey);
    mutationIdRef.current = null;
    setError(null);
  };

  useImperativeHandle(
    props.ref,
    () => ({
      quote(markdown) {
        const next = appendQuoteToCommentDraft(textareaRef.current?.value ?? "", markdown);
        setDraft(next);
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus({ preventScroll: true });
        rootRef.current?.scrollIntoView({ block: "nearest" });
        requestAnimationFrame(() => textarea.setSelectionRange(next.length, next.length));
      },
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [props.draftKey],
  );

  const open = focused || draft.length > 0;
  const canSubmit = pending === null && hasSubmittableCommentDraft(draft);

  const submit = async (close: boolean) => {
    if (!canSubmit) return;
    const body = normalizeCommentDraftForSubmit(draft);
    refocusRef.current = rootRef.current?.contains(document.activeElement) ?? false;
    setPending(close ? "close" : "comment");
    setError(null);
    try {
      const clientMutationId = mutationIdRef.current ?? createClientMutationId();
      mutationIdRef.current = clientMutationId;
      await addComment.mutateAsync({ body, clientMutationId });
      setDraft("");
      if (close) await update.mutateAsync({ kind: "close" });
    } catch (submitError) {
      setError(
        errorText(
          submitError,
          close ? "Could not close the pull request." : "Could not post the comment.",
        ),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      ref={rootRef}
      className={COMPOSER_BOX_CLASS}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Comment"
        placeholder="Leave a comment"
        value={draft}
        disabled={pending !== null}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) =>
          handleComposerKeys(event, {
            submit: () => void submit(false),
            cancel: () => textareaRef.current?.blur(),
          })
        }
        className={cn(COMPOSER_TEXTAREA_CLASS, "min-h-10")}
      />
      <div
        data-open={open}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex min-h-10 items-center gap-2 px-2 pb-2 pl-3">
            <div className="min-w-0 flex-1 truncate text-xs" aria-live="polite">
              {error ? (
                <span className="text-destructive">{error}</span>
              ) : (
                <span className="text-muted-foreground/80">Markdown is supported</span>
              )}
            </div>
            {props.canClose && hasSubmittableCommentDraft(draft) ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => void submit(true)}
              >
                {pending === "close" ? <Spinner className="size-3" /> : null}
                Close with comment
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!canSubmit}
              aria-keyshortcuts="Meta+Enter"
              onClick={() => void submit(false)}
            >
              {pending === "comment" ? <Spinner className="size-3" /> : null}
              Comment
              <SubmitKeyHint />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
