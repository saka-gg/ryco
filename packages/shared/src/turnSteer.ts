/**
 * Shared vocabulary for steer rejections: the server decider writes the activity row and clients
 * (work log, queue reconciliation) read it back. Pure module.
 */
import type { TurnSteerRejectionReason } from "@ryco/contracts";

export const TURN_STEER_FAILED_ACTIVITY_KIND = "provider.turn.steer.failed" as const;

/** One activity row per steer request, so a re-steer of the same message never reuses an id. */
export const turnSteerRejectionActivityId = (requestCommandId: string): string =>
  `turn-steer-rejected:${requestCommandId}`;

export interface TurnSteerRejectionActivity {
  readonly messageId: string | null;
  readonly reason: TurnSteerRejectionReason;
  readonly error: string;
  /**
   * The provider may have received the steer (a restart cut off its delivery). The queue holds
   * the message for an explicit retry or removal instead of sending it again as a turn.
   */
  readonly deliveryUncertain: boolean;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Legacy rows (no `reason`) read as "failed". Returns null for other kinds. */
export function readTurnSteerRejectionActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): TurnSteerRejectionActivity | null {
  if (activity.kind !== TURN_STEER_FAILED_ACTIVITY_KIND) return null;
  const payload = readRecord(activity.payload);
  const messageId =
    typeof payload?.messageId === "string" && payload.messageId.length > 0
      ? payload.messageId
      : null;
  const reason: TurnSteerRejectionReason = payload?.reason === "deferred" ? "deferred" : "failed";
  const error =
    typeof payload?.error === "string" && payload.error.trim().length > 0
      ? payload.error.trim()
      : reason === "deferred"
        ? "The message stays queued and is sent next."
        : "Provider rejected turn steering.";
  // Only a failure can be uncertain; a deferred steer provably never reached the provider.
  const deliveryUncertain = reason === "failed" && payload?.deliveryUncertain === true;
  return { messageId, reason, error, deliveryUncertain };
}
