import { memo } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CornerDownLeftIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { summarizeQueuedMessage, type QueuedMessage } from "~/messageQueue.logic";

interface ComposerQueuedMessagesProps {
  messages: readonly QueuedMessage[];
  onRemove: (id: string) => void;
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
 * reordered or removed before it auto-sends on quiescence.
 */
export const ComposerQueuedMessages = memo(function ComposerQueuedMessages({
  messages,
  onRemove,
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

  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-1.5">
      <div className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Queued · {messages.length}
      </div>
      <ul className="flex flex-col gap-0.5">
        {messages.map((message, index) => {
          const summary = summarizeQueuedMessage(message);
          // Include position + summary so screen readers can tell rows apart.
          const rowLabel = `queued message ${index + 1} of ${messages.length}: ${summary}`;
          const steerUnavailableReason = getSteerUnavailableReason(message);
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
