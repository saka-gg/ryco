import {
  FILE_REFERENCE_COMMENT_MAX_LENGTH,
  FILE_REFERENCE_PROMPT_MAX_COUNT,
} from "@ryco/client-runtime/state/composer";
import { useEffect, useRef, useState } from "react";

import type { ReferenceAddResult } from "../../composerContextIntake";
import { KeyHint } from "../pullRequests/primitives";
import { CommentField, SUBMIT_SHORTCUT_LABEL } from "../pullRequests/threads/ReplyComposer";
import { Button } from "../ui/button";

/** What the note row says when "Add to chat" did not add, by result. */
export type ReferenceAddErrors = Readonly<Record<Exclude<ReferenceAddResult, "added">, string>>;

const FILE_ADD_ERRORS: ReferenceAddErrors = {
  refused: "The chat can’t take these lines right now.",
  full: `This message already has ${FILE_REFERENCE_PROMPT_MAX_COUNT} file references. Remove one to add more.`,
  invalid: "These lines can’t be sent to the chat.",
};

/**
 * Opens under the last line of a range picked with the gutter `+` (drag for
 * more lines), or above the page for an element picked in the Browser panel:
 * an optional note, then "Add to chat" hands the pick and the note to the
 * thread's composer (⌘↵). Esc or Cancel drops the pick; a refusal stays
 * inline, with the note kept. A panel whose rows remount (the diff while it
 * scrolls) keeps the note itself (`restoreComment` / `onCommentChange`). Key
 * it by the pick's id: a new pick starts a fresh note. Plain in-flow markup,
 * never a dialog, popover or menu, so it does not cover the browser's native
 * page.
 */
export function FileReferenceNoteComposer(props: {
  /** "src/app.ts lines 12-18": what is being added. */
  readonly title: string;
  /** The note to start from, for a row that mounts again; empty by default. */
  readonly restoreComment?: (() => string) | undefined;
  readonly onCommentChange?: ((comment: string) => void) | undefined;
  readonly onCancel: () => void;
  readonly onAdd: (comment: string) => ReferenceAddResult;
  /** How long the note may be; a file reference's limit by default. */
  readonly maxLength?: number | undefined;
  /** What a refusal says; the file-reference wording by default. */
  readonly addErrors?: ReferenceAddErrors | undefined;
  readonly placeholder?: string | undefined;
}) {
  const maxLength = props.maxLength ?? FILE_REFERENCE_COMMENT_MAX_LENGTH;
  const [comment, setComment] = useState(() => props.restoreComment?.() ?? "");
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    fieldRef.current?.focus({ preventScroll: true });
  }, []);

  const add = () => {
    const result = props.onAdd(comment.trim());
    if (result !== "added") setError((props.addErrors ?? FILE_ADD_ERRORS)[result]);
  };

  return (
    <div className="px-3 py-2.5 font-sans text-[13px] leading-normal whitespace-normal text-foreground">
      <div
        data-file-reference-composer
        className="max-w-[46rem] rounded-lg border border-border/70 bg-background shadow-xs/5 transition-colors duration-(--app-motion-duration-chip) focus-within:border-ring/50"
      >
        <div className="truncate px-3 pt-2 font-mono text-[11px] text-muted-foreground">
          {props.title}
        </div>
        <CommentField
          textareaRef={fieldRef}
          value={comment}
          onChange={(next) => {
            const bounded = next.slice(0, maxLength);
            setComment(bounded);
            setError(null);
            props.onCommentChange?.(bounded);
          }}
          error={error}
          placeholder={props.placeholder ?? "Add a note for the agent (optional)"}
          ariaLabel={`Note on ${props.title}`}
          minHeightClassName="min-h-12"
          onSubmit={add}
          onCancel={props.onCancel}
          actions={
            <>
              <Button size="xs" variant="ghost" onClick={props.onCancel}>
                Cancel
              </Button>
              <Button size="xs" onClick={add}>
                Add to chat
                <KeyHint className="border-current/25 text-current/70">
                  {SUBMIT_SHORTCUT_LABEL}
                </KeyHint>
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
