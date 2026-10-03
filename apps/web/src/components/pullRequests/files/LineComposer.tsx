import { DiffIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { KeyHint } from "../primitives";
import { CommentField, SUBMIT_SHORTCUT_LABEL } from "../threads/ReplyComposer";
import { useFocusAfterReveal } from "../threads/useFocusAfterReveal";
import {
  appendSuggestionBlock,
  lineCommentTargetLabel,
  type LineCommentTarget,
} from "./pullRequestFiles.logic";

/**
 * A new comment on a line (or a dragged range), opened from the gutter `+` or
 * the selection chip. It grows in under the last line of the range and takes
 * focus once open. The primary action adds the comment to the pending review
 * (⌘↵); "Comment now" sends it alone as a one-comment review; Suggest drops a
 * ` ```suggestion ` block with the selected lines in, ready to edit. What is
 * written lives with the page (`restoreBody` / `onBodyChange`), so a remount
 * picks it up again.
 */
export function LineComposer(props: {
  readonly target: LineCommentTarget;
  /** Head-side text of the commented lines; null when a suggestion cannot apply. */
  readonly suggestionLines: ReadonlyArray<string> | null;
  /** The pending review already has comments ("Add to review" instead of "Start a review"). */
  readonly reviewStarted: boolean;
  /** The text to start from (what this composer held before it remounted). */
  readonly restoreBody: () => string;
  readonly onBodyChange: (body: string) => void;
  readonly onCancel: () => void;
  readonly onAddToReview: (body: string) => void;
  readonly onCommentNow: (body: string) => Promise<void>;
}) {
  const [body, setBodyState] = useState(props.restoreBody);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useFocusAfterReveal({ open: true, shellRef, targetRef: fieldRef });

  const setBody = (next: string) => {
    setBodyState(next);
    props.onBodyChange(next);
  };

  const label = lineCommentTargetLabel(props.target);
  const canSubmit = body.trim().length > 0 && !sending;

  const addToReview = () => {
    if (!canSubmit) return;
    props.onAddToReview(body.trim());
  };

  const commentNow = async () => {
    if (!canSubmit) return;
    setSending(true);
    setError(null);
    try {
      await props.onCommentNow(body.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the comment.");
      setSending(false);
    }
  };

  const suggest = () => {
    if (!props.suggestionLines) return;
    setBody(appendSuggestionBlock(body, props.suggestionLines));
    requestAnimationFrame(() => {
      const field = fieldRef.current;
      if (!field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    });
  };

  return (
    <div ref={shellRef} className="pr-grow-in max-w-[46rem]">
      <div className="min-h-0 overflow-hidden">
        <div
          data-line-composer
          className="rounded-lg border border-border/70 bg-background shadow-xs/5 transition-colors duration-(--app-motion-duration-chip) focus-within:border-ring/50"
        >
          <CommentField
            textareaRef={fieldRef}
            value={body}
            onChange={(next) => {
              setBody(next);
              setError(null);
            }}
            placeholder={`Comment on ${label}`}
            ariaLabel={`Comment on ${label}`}
            onSubmit={addToReview}
            onCancel={props.onCancel}
            error={error}
            disabled={sending}
            leading={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      disabled={!props.suggestionLines || sending}
                      onClick={suggest}
                    >
                      <DiffIcon className="size-3" />
                      Suggest
                    </Button>
                  }
                />
                <TooltipPopup side="top" sideOffset={4}>
                  {props.suggestionLines
                    ? "Propose replacement text for these lines"
                    : "Suggestions apply to added or unchanged lines"}
                </TooltipPopup>
              </Tooltip>
            }
            actions={
              <>
                <Button size="xs" variant="ghost" onClick={props.onCancel} disabled={sending}>
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canSubmit}
                  onClick={() => void commentNow()}
                >
                  {sending ? <Spinner className="size-3" /> : null}
                  Comment now
                </Button>
                <Button size="xs" disabled={!canSubmit} onClick={addToReview}>
                  {props.reviewStarted ? "Add to review" : "Start a review"}
                  <KeyHint className="border-current/25 text-current/70">
                    {SUBMIT_SHORTCUT_LABEL}
                  </KeyHint>
                </Button>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
