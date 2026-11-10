/**
 * What a very long message the thread window sent as its head
 * (`ChatMessage.textPreview`) adds to its row: the control that shows the
 * whole text, and a copy button that copies the whole text. Loaded only for
 * such a message (a lazy chunk), so ordinary rows carry none of it. The whole
 * text goes into the store (`setWholeMessageText`); the row then renders it
 * like any message and this module's control disappears.
 */
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  loadWholeMessageText,
  MESSAGE_TEXT_PREVIEW_COPY,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { Button } from "../ui/button";
import { anchoredToastManager } from "../ui/toast";

export interface MessageTextPreviewProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly fullLength: number;
}

const loadWhole = (props: MessageTextPreviewProps) =>
  loadWholeMessageText({
    environmentId: props.environmentId,
    threadId: props.threadId,
    messageId: props.messageId,
    read: ensureEnvironmentApi(props.environmentId).orchestration.getMessageText,
    apply: (text) =>
      useStore
        .getState()
        .setWholeMessageText(
          scopeThreadRef(props.environmentId, props.threadId),
          props.messageId,
          text,
        ),
  });

const STATUS_CLASS_NAME = "mt-2 text-[11px] text-muted-foreground/60";

export function MessageTextPreviewControl(props: MessageTextPreviewProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "too-long">("idle");
  const show = () => {
    setStatus("loading");
    loadWhole(props).then(
      // A whole text replaces the preview in the store, which unmounts this control.
      (result) => setStatus(result.truncated ? "too-long" : "idle"),
      () => setStatus("error"),
    );
  };
  if (status === "loading") {
    return (
      <p data-message-text-status="loading" className={cn(STATUS_CLASS_NAME, "italic")}>
        {MESSAGE_TEXT_PREVIEW_COPY.loading}
      </p>
    );
  }
  if (status === "too-long") {
    return (
      <p data-message-text-status="truncated" className={cn(STATUS_CLASS_NAME, "italic")}>
        {MESSAGE_TEXT_PREVIEW_COPY.tooLong}
      </p>
    );
  }
  if (status === "error") {
    return (
      <p
        data-message-text-status="error"
        className={cn(STATUS_CLASS_NAME, "flex items-center gap-2")}
      >
        <span>{MESSAGE_TEXT_PREVIEW_COPY.failed}</span>
        <button
          type="button"
          className="rounded px-1 text-foreground/80 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={(event) => {
            event.stopPropagation();
            show();
          }}
        >
          {MESSAGE_TEXT_PREVIEW_COPY.retry}
        </button>
      </p>
    );
  }
  return (
    <button
      type="button"
      data-message-text-status="preview"
      className="mt-2 flex items-center gap-1 rounded text-[11px] text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      onClick={(event) => {
        event.stopPropagation();
        show();
      }}
    >
      <ChevronDownIcon className="size-3" aria-hidden="true" />
      {MESSAGE_TEXT_PREVIEW_COPY.show(props.fullLength)}
    </button>
  );
}

/**
 * Writes text still being read to the clipboard. A `ClipboardItem` holding the
 * pending text keeps the click's clipboard permission across the read (Safari
 * allows writes only while the click is handled); elsewhere the text is
 * written once read.
 */
async function writePendingClipboardText(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
    try {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // Fall through: a failed read rejects again below, with its own error.
    }
  }
  await navigator.clipboard.writeText(await text);
}

const COPIED_MS = 1000;

/** The row's copy button for a preview: copies the whole text, read first. */
export function WholeMessageCopyButton(
  props: MessageTextPreviewProps & {
    readonly className?: string;
    readonly ariaLabel: string;
    /** What the row copies of a text (a sent prompt copies without its context blocks). */
    readonly toCopyText: (text: string) => string;
  },
) {
  const ref = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const toast = (title: string, description?: string) => {
    if (!ref.current) return;
    anchoredToastManager.add({
      data: { tooltipStyle: true },
      positionerProps: { anchor: ref.current },
      timeout: COPIED_MS,
      title,
      ...(description === undefined ? {} : { description }),
    });
  };
  const copy = () => {
    const text = loadWhole(props).then((result) => props.toCopyText(result.text));
    writePendingClipboardText(text).then(
      () => {
        setCopied(true);
        toast("Copied!");
        setTimeout(() => setCopied(false), COPIED_MS);
      },
      (error: unknown) =>
        toast("Failed to copy", error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <Button
      aria-label={props.ariaLabel}
      disabled={copied}
      onClick={copy}
      ref={ref}
      type="button"
      size="icon-xs"
      variant="ghost"
      className={cn(props.className)}
    >
      {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
}

/** The one lazy entry the timeline loads: the control (no `toCopyText`) or the copy button. */
export default function MessageTextPreview(
  props: MessageTextPreviewProps & {
    readonly className?: string;
    readonly ariaLabel?: string;
    readonly toCopyText?: (text: string) => string;
  },
) {
  const { toCopyText, ariaLabel = "Copy message", ...rest } = props;
  return toCopyText ? (
    <WholeMessageCopyButton {...rest} ariaLabel={ariaLabel} toCopyText={toCopyText} />
  ) : (
    <MessageTextPreviewControl {...rest} />
  );
}
