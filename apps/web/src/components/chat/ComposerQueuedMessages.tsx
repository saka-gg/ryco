import { memo, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CornerDownLeftIcon,
  LoaderCircleIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";

import { describeQueueHold, type QueueHold } from "@ryco/client-runtime/state/message-queue";

import { cn } from "~/lib/utils";
import { summarizeQueuedMessage, type QueuedMessage } from "~/messageQueue.logic";

/**
 * Why queued messages are not going out yet, shown under the queue's title.
 * The caller words it; a draft's queue is only ever shown from the open draft,
 * which is the one view that sends it, so it never waits on another view.
 */
export interface QueuedMessagesWait {
  /**
   * `connecting`: the environment's connection is being established. `role`:
   * the user's role on the node does not allow sending. `unavailable`: the
   * environment refuses for another reason.
   */
  readonly kind: "connecting" | "role" | "unavailable";
  readonly copy: string;
  /**
   * The environment's own reason, shown instead of a `connecting` wait once it
   * has lasted longer than a session may take to synchronize.
   */
  readonly failure?: string | null;
}

/**
 * How long a send waits on a connection before the wait shows the connection's
 * own reason: the time a hosted environment session is given to synchronize
 * (a test keeps the two equal). Declared here so the thread route never loads
 * the hosted session registry in standard builds.
 */
export const CONNECTING_WAIT_DEADLINE_MS = 30_000;

/** Keyed by the wait's kind: a connection that starts waiting again starts a new deadline. */
function QueuedMessagesWaitCaption({ wait }: { readonly wait: QueuedMessagesWait }) {
  const connecting = wait.kind === "connecting";
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!connecting) return;
    const timeout = window.setTimeout(() => setOverdue(true), CONNECTING_WAIT_DEADLINE_MS);
    return () => window.clearTimeout(timeout);
  }, [connecting]);
  const copy = connecting && overdue && wait.failure ? wait.failure : wait.copy;
  return (
    <span
      data-queued-messages-wait={wait.kind}
      className="min-w-0 flex-1 truncate text-muted-foreground/70"
      title={copy}
    >
      {copy}
    </span>
  );
}

interface ComposerQueuedMessagesProps {
  messages: readonly QueuedMessage[];
  /** A recorded pause (Stop, error, review, stalled start); shown on every tier. */
  hold?: QueueHold | null | undefined;
  /** Why the queue is not sending yet, when it is waiting on something outside it. */
  wait?: QueuedMessagesWait | null | undefined;
  onResume?: (() => void) | undefined;
  onRemove: (id: string) => void;
  /** Pulls the message back into the composer for editing; it leaves the queue. */
  onEdit: (id: string) => void;
  getEditUnavailableReason: (message: QueuedMessage) => string | null;
  onRetry?: ((id: string) => void) | undefined;
  onMove: (id: string, direction: "up" | "down") => void;
  showSteerAction: boolean;
  steeringIds: readonly string[];
  getSteerUnavailableReason: (message: QueuedMessage) => string | null;
  onSteer: (message: QueuedMessage) => void;
}

const iconButtonClass = cn(
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/80",
  "transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

/**
 * Compact list of messages queued while a turn is running. Each row can be
 * edited, reordered or removed before it auto-sends on quiescence.
 */
export const ComposerQueuedMessages = memo(function ComposerQueuedMessages({
  messages,
  hold = null,
  wait = null,
  onResume,
  onRemove,
  onEdit,
  getEditUnavailableReason,
  onMove,
  onRetry,
  showSteerAction,
  steeringIds,
  getSteerUnavailableReason,
  onSteer,
}: ComposerQueuedMessagesProps) {
  if (messages.length === 0) {
    return null;
  }

  const held = hold ? describeQueueHold(hold) : null;

  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-1.5">
      {held ? (
        <div className="flex min-w-0 items-center gap-1.5 px-1.5 pb-1 text-[11px]">
          <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground">
            {held.title} · {messages.length}
          </span>
          {held.detail ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/70" title={held.detail}>
              {held.detail}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {onResume ? (
            <button
              type="button"
              className={cn(iconButtonClass, "w-auto px-1.5 text-[11px] text-foreground")}
              onClick={onResume}
              aria-label="Resume queued messages"
            >
              Resume
            </button>
          ) : null}
        </div>
      ) : wait ? (
        <div className="flex min-w-0 items-center gap-1.5 px-1.5 pb-1 text-[11px]">
          <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground">
            Queued · {messages.length}
          </span>
          <QueuedMessagesWaitCaption key={wait.kind} wait={wait} />
        </div>
      ) : (
        <div className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Queued · {messages.length}
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {messages.map((message, index) => {
          const summary = summarizeQueuedMessage(message);
          // Include position + summary so screen readers can tell rows apart.
          const rowLabel = `queued message ${index + 1} of ${messages.length}: ${summary}`;
          const steerUnavailableReason = getSteerUnavailableReason(message);
          const editUnavailableReason = getEditUnavailableReason(message);
          const isSteering = steeringIds.includes(message.id);
          const isSending = message.deliveryStatus === "sending";
          return (
            <li
              key={message.id}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/50"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={summary}>
                {summary}
              </span>
              {onRetry && message.deliveryStatus === "failed" ? (
                <button
                  type="button"
                  className={cn(iconButtonClass, "w-auto px-1.5 text-[11px]")}
                  onClick={() => onRetry(message.id)}
                  aria-label={`Retry ${rowLabel}`}
                  title="Send failed. Your message and attachments are still queued."
                >
                  Retry
                </button>
              ) : null}
              {showSteerAction ? (
                <button
                  type="button"
                  className={cn(iconButtonClass, "w-auto gap-1 px-1.5 text-[11px]")}
                  disabled={steerUnavailableReason !== null || isSteering || isSending}
                  onClick={() => onSteer(message)}
                  aria-label={`Steer ${rowLabel} into the active turn`}
                  title={steerUnavailableReason ?? "Send this message into the active turn"}
                >
                  {isSteering ? (
                    <LoaderCircleIcon className="size-3 animate-spin" />
                  ) : (
                    <CornerDownLeftIcon className="size-3" />
                  )}
                  Steer
                </button>
              ) : null}
              <button
                type="button"
                className={iconButtonClass}
                disabled={editUnavailableReason !== null}
                onClick={() => onEdit(message.id)}
                aria-label={`Edit ${rowLabel}`}
                title={editUnavailableReason ?? "Edit this message in the composer"}
              >
                <PencilIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButtonClass}
                disabled={index === 0 || isSending}
                onClick={() => onMove(message.id, "up")}
                aria-label={`Move ${rowLabel} up`}
              >
                <ChevronUpIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButtonClass}
                disabled={index === messages.length - 1 || isSending}
                onClick={() => onMove(message.id, "down")}
                aria-label={`Move ${rowLabel} down`}
              >
                <ChevronDownIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButtonClass}
                disabled={isSending}
                onClick={() => onRemove(message.id)}
                aria-label={`Remove ${rowLabel}`}
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
