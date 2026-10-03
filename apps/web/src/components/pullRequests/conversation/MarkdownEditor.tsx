import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { KeyHint } from "../primitives";

/**
 * The bordered box every composer and inline editor in Conversation uses —
 * one of the few places the page draws a box (composers are level 1).
 */
export const COMPOSER_BOX_CLASS =
  "rounded-lg border border-border/80 bg-background transition-[border-color,box-shadow] duration-(--app-motion-duration-chip) ease-(--app-motion-ease) focus-within:border-ring/70 focus-within:ring-[3px] focus-within:ring-ring/14";

/** Auto-growing textarea inside a composer box; long drafts scroll inside it. */
export const COMPOSER_TEXTAREA_CLASS =
  "block field-sizing-content max-h-[min(28rem,55cqh)] w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-[1.55] text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-64";

/** The ⌘↵ hint inside a primary submit button; the button carries `aria-keyshortcuts` instead. */
export function SubmitKeyHint() {
  return (
    <span aria-hidden className="contents">
      <KeyHint className="border-primary-foreground/25 text-primary-foreground/70">⌘↵</KeyHint>
    </span>
  );
}

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}

/** ⌘↵ / Ctrl↵ submits; Esc cancels. Returns true when the key was handled. */
export function handleComposerKeys(
  event: KeyboardEvent<HTMLTextAreaElement>,
  actions: { readonly submit: () => void; readonly cancel?: (() => void) | undefined },
): boolean {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    actions.submit();
    return true;
  }
  if (event.key === "Escape" && actions.cancel) {
    event.preventDefault();
    event.stopPropagation();
    actions.cancel();
    return true;
  }
  return false;
}

/**
 * Inline Markdown editor for a body that already exists (description,
 * comment, review): opens focused at the end, saves with ⌘↵, cancels with
 * Esc, and keeps the text and an inline error when saving fails.
 */
export function MarkdownEditor(props: {
  readonly initialValue: string;
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly submitLabel?: string | undefined;
  /** Allow saving an empty body (a description can be cleared; a comment cannot). */
  readonly allowEmpty?: boolean | undefined;
  readonly onSubmit: (value: string) => Promise<void>;
  readonly onCancel: () => void;
  readonly footerStart?: ReactNode;
  readonly className?: string | undefined;
}) {
  const [value, setValue] = useState(props.initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const trimmed = value.trimEnd();
  const changed = trimmed !== props.initialValue.trimEnd();
  const canSubmit = !pending && changed && (props.allowEmpty === true || trimmed.trim() !== "");

  const submit = async () => {
    if (!canSubmit) {
      if (!changed && !pending) props.onCancel();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await props.onSubmit(trimmed);
    } catch (submitError) {
      setError(errorText(submitError, "Could not save."));
      setPending(false);
    }
  };

  return (
    <div className={cn(COMPOSER_BOX_CLASS, props.className)}>
      <textarea
        ref={textareaRef}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={value}
        disabled={pending}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) =>
          handleComposerKeys(event, {
            submit: () => void submit(),
            cancel: pending ? undefined : props.onCancel,
          })
        }
        className={cn(COMPOSER_TEXTAREA_CLASS, "min-h-24")}
      />
      <div className="flex min-h-10 items-center gap-2 px-2 pb-2 pl-3">
        <div className="min-w-0 flex-1 truncate text-xs" aria-live="polite">
          {error ? <span className="text-destructive">{error}</span> : (props.footerStart ?? null)}
        </div>
        <Button size="xs" variant="ghost" disabled={pending} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={!canSubmit}
          aria-keyshortcuts="Meta+Enter"
          onClick={() => void submit()}
        >
          {pending ? <Spinner className="size-3" /> : null}
          {props.submitLabel ?? "Save"}
          <SubmitKeyHint />
        </Button>
      </div>
    </div>
  );
}
