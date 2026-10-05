/**
 * Durable provider-bound intents: the pure planner for the
 * `provider_effect_intents` ledger (migration 073).
 *
 * Each tracked request event gets one row, keyed by its event sequence. The
 * row is recorded in the engine's commit transaction for that event and
 * deleted in the commit transaction of the event that makes its outcome
 * visible. So an open row always means that no outcome for the intent was
 * ever committed, and startup recovery can resolve leftovers visibly:
 *
 * - process-bound intents (turn start, steer) are cancelled visibly and never
 *   re-sent (t3 `PROCESS_BOUND_EFFECT_TYPES`);
 * - replay-safe intents (session stop) are retried (t3
 *   `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS`).
 *
 * Pure module: no services, no I/O.
 *
 * @module providerEffectIntents
 */
import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  CommandId,
  ContextHandoffActivityPayload,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@ryco/contracts";
import { Option, Schema } from "effect";

export const PROVIDER_EFFECT_INTENT_KINDS = ["turn-start", "turn-steer", "session-stop"] as const;
export type ProviderEffectIntentKind = (typeof PROVIDER_EFFECT_INTENT_KINDS)[number];
/** Cancelled visibly after process loss; never re-sent (t3 PROCESS_BOUND_EFFECT_TYPES). */
export const PROCESS_BOUND_INTENT_KINDS = ["turn-start", "turn-steer"] as const;
/** Idempotent; retried after process loss (t3 REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS). */
export const REPLAY_SAFE_INTENT_KINDS = ["session-stop"] as const;
/** Boots a prior-process row may survive before it is settled with only a log line. */
export const MAX_PROVIDER_INTENT_RECOVERY_ATTEMPTS = 5;

export interface ProviderEffectIntentRecord {
  readonly sequence: number;
  readonly eventId: EventId;
  readonly threadId: ThreadId;
  readonly kind: ProviderEffectIntentKind;
  readonly messageId: MessageId | null;
  readonly handoffId: string | null;
  readonly recordedAt: string;
}

export type ProviderEffectIntentSettlement =
  | {
      readonly _tag: "ByMessage";
      readonly threadId: ThreadId;
      readonly kind: "turn-start" | "turn-steer";
      readonly messageId: MessageId;
    }
  | { readonly _tag: "ByHandoff"; readonly threadId: ThreadId; readonly handoffId: string }
  | { readonly _tag: "DispatchedTurnStarts"; readonly threadId: ThreadId }
  | { readonly _tag: "SessionStops"; readonly threadId: ThreadId }
  | { readonly _tag: "Thread"; readonly threadId: ThreadId };

export interface ProviderEffectIntentPlan {
  readonly record: ProviderEffectIntentRecord | null;
  readonly settlements: ReadonlyArray<ProviderEffectIntentSettlement>;
  /** `event.sequence`: settlements only touch rows recorded before it. 0 for an empty plan. */
  readonly beforeSequence: number;
}

/** Shared by every untracked, non-settling event: planning allocates nothing for them. */
export const EMPTY_PROVIDER_EFFECT_INTENT_PLAN: ProviderEffectIntentPlan = Object.freeze({
  record: null,
  settlements: Object.freeze([]),
  beforeSequence: 0,
});

export type TrackedProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.turn-start-requested"
      | "thread.turn-steer-requested"
      | "thread.session-stop-requested";
  }
>;

export const isTrackedProviderIntentEvent = (
  event: OrchestrationEvent,
): event is TrackedProviderIntentEvent =>
  event.type === "thread.turn-start-requested" ||
  event.type === "thread.turn-steer-requested" ||
  event.type === "thread.session-stop-requested";

/** The ledger kind of a tracked request event type. */
export const providerIntentKindOf = (
  type: TrackedProviderIntentEvent["type"],
): ProviderEffectIntentKind =>
  type === "thread.turn-start-requested"
    ? "turn-start"
    : type === "thread.turn-steer-requested"
      ? "turn-steer"
      : "session-stop";

/**
 * Activity kinds that end a turn start without a turn: the reactor's (or the
 * handoff coordinator's) visible failure, and a Stop's cancel notice.
 */
export const TURN_START_ENDED_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "provider.turn.start.failed",
  "provider.turn.start.cancelled",
]);

/**
 * The user message whose turn start this activity ended, or null. Shared by the
 * planner and `ProjectionPipeline` (pending-row cleanup), so both read the
 * outcome key identically.
 */
export const turnStartEndedMessageId = (
  activity: OrchestrationThreadActivity,
): MessageId | null => {
  if (!TURN_START_ENDED_ACTIVITY_KINDS.has(activity.kind)) return null;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || !("messageId" in payload)) return null;
  const messageId = payload.messageId;
  return typeof messageId === "string" && messageId.trim().length > 0
    ? MessageId.make(messageId)
    : null;
};

const decodeHandoffActivityPayload = Schema.decodeUnknownOption(ContextHandoffActivityPayload);

const TERMINAL_HANDOFF_STATUSES: ReadonlySet<string> = new Set([
  "consumed",
  "failed",
  "delivery-uncertain",
]);

const settlementsForActivity = (
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<ProviderEffectIntentSettlement> => {
  const endedMessageId = turnStartEndedMessageId(activity);
  if (endedMessageId !== null) {
    return [{ _tag: "ByMessage", threadId, kind: "turn-start", messageId: endedMessageId }];
  }
  if (activity.kind === "provider.session.stop.failed") {
    return [{ _tag: "SessionStops", threadId }];
  }
  if (activity.kind === CONTEXT_HANDOFF_ACTIVITY_KIND) {
    const payload = Option.getOrUndefined(decodeHandoffActivityPayload(activity.payload));
    if (payload !== undefined && TERMINAL_HANDOFF_STATUSES.has(payload.status)) {
      return [{ _tag: "ByHandoff", threadId, handoffId: payload.handoffId }];
    }
  }
  return [];
};

const settlementPlan = (
  event: OrchestrationEvent,
  settlements: ReadonlyArray<ProviderEffectIntentSettlement>,
): ProviderEffectIntentPlan =>
  settlements.length === 0
    ? EMPTY_PROVIDER_EFFECT_INTENT_PLAN
    : { record: null, settlements, beforeSequence: event.sequence };

const recordPlan = (
  event: TrackedProviderIntentEvent,
  fields: Pick<ProviderEffectIntentRecord, "kind" | "messageId" | "handoffId">,
): ProviderEffectIntentPlan => ({
  record: {
    sequence: event.sequence,
    eventId: event.eventId,
    threadId: event.payload.threadId,
    recordedAt: event.occurredAt,
    ...fields,
  },
  settlements: [],
  beforeSequence: event.sequence,
});

/** What one committed event records into and settles from the ledger. */
export const planProviderEffectIntent = (event: OrchestrationEvent): ProviderEffectIntentPlan => {
  switch (event.type) {
    case "thread.turn-start-requested":
      return recordPlan(event, {
        kind: "turn-start",
        messageId: event.payload.messageId,
        handoffId: event.payload.contextHandoff?.handoffId ?? null,
      });
    case "thread.turn-steer-requested":
      return recordPlan(event, {
        kind: "turn-steer",
        messageId: event.payload.message.messageId,
        handoffId: null,
      });
    case "thread.session-stop-requested":
      return recordPlan(event, { kind: "session-stop", messageId: null, handoffId: null });
    case "thread.activity-appended":
      return settlementPlan(
        event,
        settlementsForActivity(event.payload.threadId, event.payload.activity),
      );
    case "thread.turn-steer-accepted":
    case "thread.turn-steer-rejected":
      return settlementPlan(event, [
        {
          _tag: "ByMessage",
          threadId: event.payload.threadId,
          kind: "turn-steer",
          messageId: event.payload.messageId,
        },
      ]);
    case "thread.session-set": {
      const session = event.payload.session;
      if (session.status === "running" && session.activeTurnId !== null) {
        return settlementPlan(event, [
          { _tag: "DispatchedTurnStarts", threadId: event.payload.threadId },
        ]);
      }
      if (session.status === "stopped") {
        return settlementPlan(event, [{ _tag: "SessionStops", threadId: event.payload.threadId }]);
      }
      return EMPTY_PROVIDER_EFFECT_INTENT_PLAN;
    }
    case "thread.deleted":
    case "thread.trashed":
      return settlementPlan(event, [{ _tag: "Thread", threadId: event.payload.threadId }]);
    default:
      return EMPTY_PROVIDER_EFFECT_INTENT_PLAN;
  }
};

/** Whether the provider may have received the intent before the process died. */
export type IntentDeliveryState = "not-sent" | "uncertain";

export const deliveryStateOf = (dispatchedAt: string | null): IntentDeliveryState =>
  dispatchedAt === null ? "not-sent" : "uncertain";

/** Final user-visible wording for an intent that a restart cut off. */
export const recoveryCopy = (input: {
  readonly kind: "turn-start" | "turn-steer";
  readonly deliveryState: IntentDeliveryState;
  readonly delegatedReturn: boolean;
}): { readonly summary: string; readonly detail: string } => {
  const notSent = input.deliveryState === "not-sent";
  if (input.kind === "turn-steer") {
    return {
      // The decider titles the activity from the rejection reason; only the error is ours.
      summary: "Steer failed",
      detail: notSent
        ? "Ryco restarted before this steer message reached the provider. It was not sent."
        : "Ryco restarted while delivering this steer message. It may have reached the provider. Check the turn before sending it again.",
    };
  }
  if (input.delegatedReturn) {
    return notSent
      ? {
          summary: "Delegated return was not submitted",
          detail:
            "Ryco restarted before this delegated result reached the provider. Inspect the result before sending it manually.",
        }
      : {
          summary: "Delegated return delivery unconfirmed",
          detail:
            "Ryco restarted while submitting this delegated result. It may have reached the provider. Inspect the parent thread before sending it manually.",
        };
  }
  return notSent
    ? {
        summary: "Message was not sent",
        detail:
          "Ryco restarted before this message reached the provider. Nothing was sent. Send it again to continue.",
      }
    : {
        summary: "Message delivery unconfirmed",
        detail:
          "Ryco restarted after handing this message to the provider but before the provider confirmed it. It may have been received. Check the thread before sending it again.",
      };
};

/** Deterministic ids for recovery dispatches, so a repeated recovery dedups on the receipt. */
export const providerIntentRecoveryIds = (sequence: number) => ({
  commandId: CommandId.make(`server:provider-intent-recovery:${sequence}`),
  activityId: EventId.make(`provider-intent-recovery:${sequence}`),
});

/** Deterministic ids for the visible outcome of a failure that escaped a tracked handler. */
export const providerIntentFailureIds = (sequence: number) => ({
  commandId: CommandId.make(`server:provider-intent-failure:${sequence}`),
  activityId: EventId.make(`provider-intent-failure:${sequence}`),
});
