import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
  type ContextHandoffEndpointSnapshot,
  type ContextHandoffId,
  type ContextHandoffInspectionSummaryMetadata,
  type ContextHandoffReason,
  type MessageId,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@ryco/contracts";
import { Schema } from "effect";

export type ContextHandoffTimelineStatus = "consumed" | "failed" | "delivery-uncertain";

export interface ContextHandoffTimelineEntry {
  id: string;
  activityId: string;
  handoffId: ContextHandoffId;
  createdAt: string;
  turnId: TurnId | null;
  status: ContextHandoffTimelineStatus;
  /** Absent for model changes recorded before handoffs carried a reason. */
  reason?: ContextHandoffReason;
  targetMessageId: MessageId;
  targetTurnId: TurnId | null;
  sources: ReadonlyArray<ContextHandoffEndpointSnapshot>;
  target: ContextHandoffEndpointSnapshot;
  error?: string;
  inspection?: ContextHandoffInspectionSummaryMetadata;
}

/**
 * Whether a handoff continued the thread after its working directory moved
 * (a chat turned into a project, a relocated workspace) rather than switching
 * models. Accepts timeline entries and decoded activity payloads alike; a
 * missing reason is a model change recorded before handoffs carried one.
 */
export function isCwdRelocationHandoff(handoff: {
  readonly reason?: ContextHandoffReason | undefined;
}): boolean {
  return handoff.reason === "cwd-relocation";
}

/**
 * Platform-neutral copy for a working-directory relocation handoff. Its source
 * and target are normally the same model, so it reads as a fresh session in
 * the new folder instead of a model transition.
 */
export const CWD_RELOCATION_HANDOFF_COPY = {
  /** Divider headline once the fresh session received the context. */
  continued: "Continued in a fresh session in the new folder",
  /** Divider headline for an attempt that failed or could not be confirmed. */
  attempted: "Fresh session in the new folder",
  /** Why the conversation was not resumed natively. */
  explanation:
    "The working folder moved and this provider can't resume a conversation from another folder, so a fresh session received the conversation's context.",
  /** Nothing was sent: the same message goes out again with a new send. */
  retryHint: "Send your message again to retry.",
} as const;

/** The relocation divider's headline for a terminal handoff status. */
export function cwdRelocationHandoffHeadline(status: ContextHandoffTimelineStatus): string {
  return status === "consumed"
    ? CWD_RELOCATION_HANDOFF_COPY.continued
    : CWD_RELOCATION_HANDOFF_COPY.attempted;
}

/** The divider subject both kinds of handoff are described from. */
export interface ContextHandoffMarkerSubject {
  readonly status: ContextHandoffTimelineStatus;
  readonly reason?: ContextHandoffReason | undefined;
  readonly error?: string | undefined;
}

/**
 * How a handoff that did not complete ended, with its error: "Failed: …" or
 * "Delivery uncertain: …". Null once the target received the context.
 */
export function contextHandoffStatusSuffix(handoff: ContextHandoffMarkerSubject): string | null {
  const detail = handoff.error ? `: ${handoff.error}` : "";
  if (handoff.status === "failed") return `Failed${detail}`;
  if (handoff.status === "delivery-uncertain") return `Delivery uncertain${detail}`;
  return null;
}

/**
 * What a failed working-directory relocation tells the user to do: nothing was
 * sent, so the same message goes out again with a new send. Null for every
 * other handoff, including model changes, which offer no retry of their own.
 */
export function cwdRelocationHandoffRetryHint(handoff: ContextHandoffMarkerSubject): string | null {
  return isCwdRelocationHandoff(handoff) && handoff.status === "failed"
    ? CWD_RELOCATION_HANDOFF_COPY.retryHint
    : null;
}

/**
 * The screen-reader label of a relocation divider: its headline, how it ended
 * and what to do next, as sentences. Model changes name their endpoints, which
 * each platform labels itself.
 */
export function cwdRelocationHandoffAccessibleLabel(handoff: ContextHandoffMarkerSubject): string {
  return [
    cwdRelocationHandoffHeadline(handoff.status),
    contextHandoffStatusSuffix(handoff),
    cwdRelocationHandoffRetryHint(handoff),
  ]
    .filter((part): part is string => part !== null)
    .map((part) => part.replace(/\.+$/, ""))
    .join(". ");
}

const decodeContextHandoffActivityPayload = Schema.decodeUnknownSync(ContextHandoffActivityPayload);

/**
 * Validates the otherwise opaque activity payload and projects only terminal
 * handoff states. Internal preparation states intentionally have no timeline
 * representation.
 */
export function toContextHandoffTimelineEntry(
  activity: OrchestrationThreadActivity,
): ContextHandoffTimelineEntry | null {
  if (activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) {
    return null;
  }

  let payload;
  try {
    payload = decodeContextHandoffActivityPayload(activity.payload);
  } catch {
    return null;
  }

  if (
    payload.status !== "consumed" &&
    payload.status !== "failed" &&
    payload.status !== "delivery-uncertain"
  ) {
    return null;
  }

  return {
    id: `context-handoff:${activity.id}`,
    activityId: activity.id,
    handoffId: payload.handoffId,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    status: payload.status,
    ...(payload.reason ? { reason: payload.reason } : {}),
    targetMessageId: payload.targetMessageId,
    targetTurnId: payload.targetTurnId ?? activity.turnId,
    sources: payload.sources,
    target: payload.target,
    ...(payload.inspection ? { inspection: payload.inspection } : {}),
    ...(payload.status === "failed" || payload.status === "delivery-uncertain"
      ? { error: payload.error }
      : {}),
  };
}
