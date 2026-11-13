import { createContext, memo, useContext, type ReactNode } from "react";
import { LoaderCircleIcon, RotateCcwIcon } from "lucide-react";

import type { HeldSendView } from "../../heldSends";
import { cn } from "~/lib/utils";

/** What a view showing held messages (sent while their uploads ran) can do with them. */
export interface HeldSendActions {
  readonly onRetryUpload: (attachmentId: string) => void;
  /** Drops the file; the message goes out without it. */
  readonly onSendWithout: (messageId: string, attachmentId: string) => void;
  /** Takes the message back into the composer, after what it holds. */
  readonly onCancel: (messageId: string) => void;
}

export interface HeldSendTimelineValue extends HeldSendActions {
  readonly heldSends: ReadonlyMap<string, HeldSendView>;
}

/**
 * The thread's held messages for the timeline. Read only by the small meta slot under a user
 * message, so upload progress re-renders that slot, never the rows around it.
 */
export const HeldSendTimelineContext = createContext<HeldSendTimelineValue | null>(null);

const actionClassName =
  "inline-flex cursor-pointer items-center gap-1 font-medium underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none";

function formatProgress(view: HeldSendView): string {
  const uploading = view.uploads.uploads.filter((upload) => upload.kind === "uploading");
  if (uploading.length === 0) return "Waiting to send";
  const label =
    uploading.length === 1
      ? `Uploading ${uploading[0]!.name}`
      : `Uploading ${uploading.length} files`;
  const progress = uploading.map((upload) => upload.progress ?? 0);
  const average = progress.reduce((sum, value) => sum + value, 0) / progress.length;
  return average > 0 ? `${label} · ${Math.round(average * 100)}%` : `${label}…`;
}

/**
 * A held message's state: its uploads and, once one failed, what to do about it (retry the
 * upload, send without the file, or take the message back). `align` follows its surroundings.
 */
export const HeldSendStatus = memo(function HeldSendStatus({
  held,
  actions,
  align = "end",
}: {
  held: HeldSendView;
  actions: HeldSendActions;
  align?: "start" | "end";
}) {
  const messageId = held.entry.id;
  const failed = held.uploads.uploads.find((upload) => upload.kind === "failed");
  const sending = held.entry.deliveryStatus === "sending";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]",
        align === "end" ? "justify-end text-right" : "justify-start",
      )}
      data-held-send-state={failed ? "failed" : sending ? "sending" : "waiting"}
      role="status"
      aria-live="polite"
    >
      {failed ? (
        <>
          <span className="min-w-0 truncate text-destructive" title={failed.message}>
            {failed.name} failed to upload
          </span>
          {failed.retryable ? (
            <button
              type="button"
              className={cn(actionClassName, "text-foreground/80")}
              onClick={() => actions.onRetryUpload(failed.id)}
              aria-label={`Retry uploading ${failed.name}`}
            >
              <RotateCcwIcon className="size-3" aria-hidden="true" />
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className={cn(actionClassName, "text-foreground/80")}
            onClick={() => actions.onSendWithout(messageId, failed.id)}
            aria-label={`Send without ${failed.name}`}
          >
            Send without it
          </button>
        </>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground/70">
          <LoaderCircleIcon className="size-3 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0 truncate">{sending ? "Sending…" : formatProgress(held)}</span>
        </span>
      )}
      {sending ? null : (
        <button
          type="button"
          className={cn(actionClassName, "text-muted-foreground/80")}
          onClick={() => actions.onCancel(messageId)}
          aria-label="Cancel sending this message"
        >
          Cancel
        </button>
      )}
    </div>
  );
});

/**
 * The line under a user message: its time, or for a message held for its uploads, their state
 * and actions.
 */
export function UserMessageMeta({
  messageId,
  children,
}: {
  messageId: string;
  children: ReactNode;
}) {
  const value = useContext(HeldSendTimelineContext);
  const held = value?.heldSends.get(messageId);
  if (!value || !held) return children;
  return <HeldSendStatus held={held} actions={value} />;
}
