import { useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { KeyHint } from "../primitives";

const SUBMIT_SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘↵" : "Ctrl↵";

export { SUBMIT_SHORTCUT_LABEL };

/**
 * The body of a reply or line comment: an auto-growing field and a row of
 * actions ending in the primary one (⌘↵). Esc cancels. Errors stay inline
 * next to the actions so the draft is never lost. While it sends, the field
 * is read-only rather than disabled, so it keeps focus (and the caret).
 */
export function CommentField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly textareaRef?: React.Ref<HTMLTextAreaElement> | undefined;
  readonly leading?: React.ReactNode;
  readonly actions: React.ReactNode;
  readonly error?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly minHeightClassName?: string | undefined;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Sending: neither submit again nor cancel what is in flight.
    if (props.disabled) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      props.onSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    }
  };
  return (
    <div className="flex flex-col">
      <textarea
        ref={props.textareaRef}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        value={props.value}
        readOnly={props.disabled}
        aria-disabled={props.disabled || undefined}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          "block field-sizing-content max-h-80 w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-[1.55] text-foreground outline-none placeholder:text-muted-foreground/70 aria-disabled:opacity-64",
          props.minHeightClassName ?? "min-h-16",
        )}
      />
      <div className="flex min-h-9 items-center gap-1.5 px-2 pb-2">
        {props.leading}
        <div className="min-w-0 flex-1 truncate text-xs text-destructive" aria-live="polite">
          {props.error ?? null}
        </div>
        {props.actions}
      </div>
    </div>
  );
}

/** Reply to a thread; mounted inside the thread's disclosure. */
export function ReplyComposer(props: {
  readonly textareaRef: React.Ref<HTMLTextAreaElement>;
  readonly onSubmit: (body: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const canSubmit = body.trim().length > 0 && !pending;
  const submit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await props.onSubmit(body.trim());
      setBody("");
      props.onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the reply.");
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  };
  return (
    <CommentField
      textareaRef={props.textareaRef}
      value={body}
      onChange={(next) => {
        setBody(next);
        setError(null);
      }}
      placeholder="Reply…"
      ariaLabel="Reply"
      onSubmit={() => void submit()}
      onCancel={() => {
        setBody("");
        setError(null);
        props.onCancel();
      }}
      error={error}
      disabled={pending}
      minHeightClassName="min-h-14"
      actions={
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setBody("");
              props.onCancel();
            }}
          >
            Cancel
          </Button>
          <Button size="xs" disabled={!canSubmit} onClick={() => void submit()}>
            {pending ? <Spinner className="size-3" /> : null}
            Reply
            <KeyHint className="border-current/25 text-current/70">{SUBMIT_SHORTCUT_LABEL}</KeyHint>
          </Button>
        </>
      }
    />
  );
}
