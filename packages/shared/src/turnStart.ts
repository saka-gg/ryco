/**
 * Shared vocabulary for a turn start that ended without a turn: the node appends the
 * activity, and the server (projection cleanup, effect planning) and clients (`ryco thread`)
 * read which user message it ended the same way. Pure module.
 */
import { MessageId } from "@ryco/contracts/base-schemas";

/**
 * Activity kinds that end a turn start without a turn: the reactor's (or the
 * handoff coordinator's) visible failure, and a Stop's cancel notice.
 */
export const TURN_START_ENDED_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "provider.turn.start.failed",
  "provider.turn.start.cancelled",
]);

/** The user message whose turn start this activity ended, or null. */
export const turnStartEndedMessageId = (activity: {
  readonly kind: string;
  readonly payload: unknown;
}): MessageId | null => {
  if (!TURN_START_ENDED_ACTIVITY_KINDS.has(activity.kind)) return null;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || !("messageId" in payload)) return null;
  const messageId = payload.messageId;
  return typeof messageId === "string" && messageId.trim().length > 0
    ? MessageId.make(messageId)
    : null;
};
