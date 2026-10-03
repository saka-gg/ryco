import type { ReviewDraftComment } from "@ryco/client-runtime/state/pull-request-review";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { KeyHint } from "../primitives";
import { CommentField, SUBMIT_SHORTCUT_LABEL } from "../threads/ReplyComposer";
import { ReviewCommentBody, ReviewCommentRow } from "../threads/ReviewComment";
import { useFocusAfterReveal } from "../threads/useFocusAfterReveal";

const ICON_ACTION_CLASS =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-[color,background-color,opacity] duration-(--app-motion-duration-chip) group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A comment in the viewer's pending review, shown under its line like a
 * thread but marked "Pending": only the viewer sees it until the review is
 * submitted. Edit and delete stay quiet until the card is hovered or focused.
 * A draft written on an older head is labelled outdated and never re-anchored.
 */
export const PendingDraftCard = memo(function PendingDraftCard(props: {
  readonly draft: ReviewDraftComment;
  readonly outdated: boolean;
  readonly viewerLogin: string;
  readonly viewerAvatarUrl?: string | undefined;
  readonly onUpdate: (body: string) => void;
  readonly onRemove: () => void;
  readonly className?: string | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(props.draft.body);
  const shellRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useFocusAfterReveal({ open: editing, shellRef, targetRef: fieldRef });

  const save = () => {
    const next = body.trim();
    if (next.length === 0) return;
    props.onUpdate(next);
    setEditing(false);
  };

  return (
    <section
      data-review-draft-id={props.draft.id}
      aria-label="Pending comment"
      className={cn(
        "max-w-[46rem] overflow-hidden rounded-lg border border-dashed border-border bg-background text-[13px]",
        props.className,
      )}
    >
      {props.outdated ? (
        <p className="flex h-7 items-center border-b border-border/60 px-3 text-[11px] text-muted-foreground">
          Outdated · written on an earlier commit
        </p>
      ) : null}
      {editing ? (
        <div ref={shellRef} className="pr-grow-in">
          <div className="min-h-0 overflow-hidden">
            <CommentField
              textareaRef={fieldRef}
              value={body}
              onChange={setBody}
              placeholder="Edit comment"
              ariaLabel="Edit pending comment"
              onSubmit={save}
              onCancel={() => {
                setBody(props.draft.body);
                setEditing(false);
              }}
              actions={
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setBody(props.draft.body);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button size="xs" disabled={body.trim().length === 0} onClick={save}>
                    Save
                    <KeyHint className="border-current/25 text-current/70">
                      {SUBMIT_SHORTCUT_LABEL}
                    </KeyHint>
                  </Button>
                </>
              }
            />
          </div>
        </div>
      ) : (
        <ReviewCommentRow
          login={props.viewerLogin}
          avatarUrl={props.viewerAvatarUrl}
          createdAt={new Date(props.draft.createdAt).toISOString()}
          pending
          body={<ReviewCommentBody body={props.draft.body} />}
          trailing={
            <>
              {props.outdated ? null : (
                <button
                  type="button"
                  aria-label="Edit pending comment"
                  className={ICON_ACTION_CLASS}
                  onClick={() => {
                    setBody(props.draft.body);
                    setEditing(true);
                  }}
                >
                  <PencilIcon className="size-3" />
                </button>
              )}
              <button
                type="button"
                aria-label="Delete pending comment"
                className={ICON_ACTION_CLASS}
                onClick={props.onRemove}
              >
                <Trash2Icon className="size-3" />
              </button>
            </>
          }
        />
      )}
    </section>
  );
});
