import { queueMigrationFailedCauseKey } from "./drain.ts";
import type { QueueHold } from "./hold.ts";

// ---------------------------------------------------------------------------
// Moving a device's queue to the node's follow-up queue (design §3.7). The
// drain policy decides when a thread's entries move (`resolveQueueDrainStep`'s
// `migrate` step); this is the move itself, shared by web's coordinator and
// mobile's persistent outbox. Platform-neutral: no DOM or React Native imports.
// ---------------------------------------------------------------------------

/** How one move of a thread's device queue ended. */
export type DeviceQueueMoveOutcome<E> =
  /** Every entry that could move did; any left wait for something else first. */
  | { readonly kind: "moved" }
  /** The node did not take this entry, or the connection went away; it and the rest stay. */
  | { readonly kind: "failed"; readonly entry: E; readonly error: unknown }
  /** The move was superseded (stopped, or the device queue was reset): nothing to do. */
  | { readonly kind: "stale" };

const MOVED = { kind: "moved" } as const;
const STALE = { kind: "stale" } as const;

/**
 * Moves one thread's device queue to the node's queue, head first, one `thread.queue.add` at a
 * time under each entry's own message id. An entry leaves the device only once the node
 * acknowledged its add. The node's add is a no-op for an id it already queued, sent or steered,
 * so a retry after a lost reply, a second device's copy, or a send that went through meanwhile
 * never makes a second message. Stops at the first entry that may not move now, or that the
 * node did not take.
 */
export async function moveDeviceQueueToServer<E>(input: {
  /** The thread's head while it may move now; null when none is left or the head must wait. */
  readonly nextEntry: () => E | null;
  /** Sends the entry's `thread.queue.add`; resolves once the node acknowledged it. */
  readonly move: (entry: E) => Promise<void>;
  /** Whether the entry is still queued on this device (it may have been removed meanwhile). */
  readonly isQueued: (entry: E) => boolean;
  /** Drops an acknowledged entry from the device queue. */
  readonly drop: (entry: E) => void;
  /** False once this move was superseded. */
  readonly current: () => boolean;
  /**
   * The entry whose add is on its way, then null once it settled (a superseded move leaves
   * that to the caller's reset). While an entry moves, the device must not edit or steer it:
   * the add can still land, so an edited copy or a steer would make a second message.
   */
  readonly onMoving?: ((entry: E | null) => void) | undefined;
}): Promise<DeviceQueueMoveOutcome<E>> {
  for (;;) {
    if (!input.current()) return STALE;
    const entry = input.nextEntry();
    if (entry === null) return MOVED;
    input.onMoving?.(entry);
    try {
      await input.move(entry);
    } catch (error) {
      if (!input.current()) return STALE;
      input.onMoving?.(null);
      return { kind: "failed", entry, error };
    }
    if (!input.current()) return STALE;
    input.onMoving?.(null);
    if (input.isQueued(entry)) input.drop(entry);
  }
}

/**
 * The device hold recorded when the node refused one entry of a move while the connection was
 * up. It shows the node's answer and waits for Resume, which tries again. A connection that went
 * away is not a refusal: the caller records nothing then, and the move resumes once the
 * environment is ready again.
 */
export function queueMigrationFailedHold(
  messageId: string,
  error: unknown,
  heldAt: string,
): QueueHold {
  return {
    reason: "error",
    causeKeys: [queueMigrationFailedCauseKey(messageId)],
    detail:
      error instanceof Error && error.message.length > 0
        ? error.message
        : "This message could not be moved to the node's queue.",
    heldAt,
  };
}
