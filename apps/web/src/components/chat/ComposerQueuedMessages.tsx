import { memo, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CornerDownLeftIcon,
  LoaderCircleIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";

import {
  describeQueueHold,
  type FollowUpQueueRow,
  type QueueHold,
} from "@ryco/client-runtime/state/message-queue";

import { cn } from "~/lib/utils";

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
  /** The shared view: the node's entries, adds on their way, then this tab's own entries. */
  rows: readonly FollowUpQueueRow[];
  /** A recorded pause (Stop, error, review, stalled start); shown on every tier. */
  hold?: QueueHold | null | undefined;
  /** Why the queue is not sending yet, when it is waiting on something outside it. */
  wait?: QueuedMessagesWait | null | undefined;
  onResume?: (() => void) | undefined;
  /** Pauses the node's queue; only where the node keeps it. */
  onPause?: (() => void) | undefined;
  onRemove: (row: FollowUpQueueRow) => void;
  /** Pulls the message back into the composer for editing. */
  onEdit: (row: FollowUpQueueRow) => void;
  getEditUnavailableReason: (row: FollowUpQueueRow) => string | null;
  onRetry?: ((row: FollowUpQueueRow) => void) | undefined;
  onMove: (row: FollowUpQueueRow, direction: "up" | "down") => void;
  showSteerAction: boolean;
  getSteerUnavailableReason: (row: FollowUpQueueRow) => string | null;
  onSteer: (row: FollowUpQueueRow) => void;
  /** The node's entry the composer is editing; saving the composer saves it. */
  editingId?: string | null | undefined;
  onCancelEdit?: (() => void) | undefined;
}

const iconButtonClass = cn(
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/80",
  "transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);
const textButtonClass = cn(iconButtonClass, "w-auto px-1.5 text-[11px]");

/** Rows move only among rows of their own kind (the node's, or this tab's). */
function movableRange(rows: readonly FollowUpQueueRow[], index: number) {
  const source = rows[index]!.source;
  return {
    first: index === 0 || rows[index - 1]!.source !== source,
    last: index === rows.length - 1 || rows[index + 1]!.source !== source,
  };
}

/**
 * Compact list of messages queued while a turn is running. Each row can be
 * edited, reordered or removed before it is sent on quiescence: by the node,
 * where it keeps the queue, else by this tab.
 */
export const ComposerQueuedMessages = memo(function ComposerQueuedMessages({
  rows,
  hold = null,
  wait = null,
  onResume,
  onPause,
  onRemove,
  onEdit,
  getEditUnavailableReason,
  onMove,
  onRetry,
  showSteerAction,
  getSteerUnavailableReason,
  onSteer,
  editingId = null,
  onCancelEdit,
}: ComposerQueuedMessagesProps) {
  if (rows.length === 0) {
    return null;
  }

  const held = hold ? describeQueueHold(hold) : null;

  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-1.5">
      {held ? (
        <div className="flex min-w-0 items-center gap-1.5 px-1.5 pb-1 text-[11px]">
          <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground">
            {held.title} · {rows.length}
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
              className={cn(textButtonClass, "text-foreground")}
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
            Queued · {rows.length}
          </span>
          <QueuedMessagesWaitCaption key={wait.kind} wait={wait} />
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 px-1.5 pb-1 text-[11px]">
          <span className="flex-1 font-medium uppercase tracking-wide text-muted-foreground">
            Queued · {rows.length}
          </span>
          {onPause ? (
            <button
              type="button"
              className={textButtonClass}
              onClick={onPause}
              aria-label="Pause queued messages"
              title="Keep queued messages from being sent until you resume"
            >
              Pause
            </button>
          ) : null}
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {rows.map((row, index) => {
          const summary = row.summary;
          // Include position + summary so screen readers can tell rows apart.
          const rowLabel = `queued message ${index + 1} of ${rows.length}: ${summary}`;
          // On its way to the node's queue: an add of this tab, or a tab entry moving there.
          const queuing = row.status === "queuing" || row.status === "moving";
          const editing = editingId !== null && row.id === editingId;
          const busy = queuing || editing || row.status === "sending";
          const steerUnavailableReason = busy ? null : getSteerUnavailableReason(row);
          const editUnavailableReason = busy ? null : getEditUnavailableReason(row);
          const isSteering = row.status === "steering";
          const range = movableRange(rows, index);
          return (
            <li
              key={row.id}
              data-queued-message-source={row.source}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/50"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={summary}>
                {summary}
              </span>
              {queuing ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <LoaderCircleIcon className="size-3 animate-spin" />
                  Queuing…
                </span>
              ) : null}
              {editing ? (
                <>
                  <span className="shrink-0 text-[11px] text-muted-foreground">Editing</span>
                  {onCancelEdit ? (
                    <button
                      type="button"
                      className={textButtonClass}
                      onClick={onCancelEdit}
                      aria-label={`Cancel editing ${rowLabel}`}
                    >
                      Cancel
                    </button>
                  ) : null}
                </>
              ) : null}
              {onRetry && row.status === "failed" ? (
                <button
                  type="button"
                  className={textButtonClass}
                  onClick={() => onRetry(row)}
                  aria-label={`Retry ${rowLabel}`}
                  title={
                    row.failureDetail ??
                    "Send failed. Your message and attachments are still queued."
                  }
                >
                  Retry
                </button>
              ) : null}
              {showSteerAction && !queuing && !editing ? (
                <button
                  type="button"
                  className={cn(textButtonClass, "gap-1")}
                  disabled={steerUnavailableReason !== null || isSteering || busy}
                  onClick={() => onSteer(row)}
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
                disabled={busy || editUnavailableReason !== null}
                onClick={() => onEdit(row)}
                aria-label={`Edit ${rowLabel}`}
                title={editUnavailableReason ?? "Edit this message in the composer"}
              >
                <PencilIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButtonClass}
                disabled={range.first || busy}
                onClick={() => onMove(row, "up")}
                aria-label={`Move ${rowLabel} up`}
              >
                <ChevronUpIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButtonClass}
                disabled={range.last || busy}
                onClick={() => onMove(row, "down")}
                aria-label={`Move ${rowLabel} down`}
              >
                <ChevronDownIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButtonClass}
                disabled={busy}
                onClick={() => onRemove(row)}
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
