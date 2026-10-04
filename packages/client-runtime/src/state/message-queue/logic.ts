import type {
  AgentTokenMode,
  CommandId,
  FollowUpBehavior,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
  TurnSteerRejectionReason,
  UploadChatAttachment,
} from "@ryco/contracts";
import {
  readTurnSteerRejectionActivity,
  turnSteerRejectionActivityId,
  type TurnSteerRejectionActivity,
} from "@ryco/shared/turnSteer";

/**
 * The queue is deliberately independent of the UI send pipeline. The caller
 * owns the snapshot shape, while the runtime owns its ordering semantics.
 */
export interface QueuedMessage<Composer = unknown, Settings = unknown> {
  readonly id: string;
  readonly createdAt?: string;
  readonly deliveryStatus?: "sending" | "failed";
  readonly composer: Composer;
  readonly settings: Settings;
}

export type QueuedMessageSteerEligibility =
  | { readonly allowed: true; readonly expectedTurnId: TurnId }
  | { readonly allowed: false; readonly reason: string };

export interface QueuedMessageSteerEligibilityInput {
  readonly mutationReady: boolean;
  readonly turnRunning: boolean;
  readonly activeTurnId: TurnId | null | undefined;
  readonly supportsTurnSteering: boolean;
  readonly queuedModelSelection: ModelSelection | null | undefined;
  readonly activeModelSelection: ModelSelection | null | undefined;
  readonly queuedRuntimeMode: RuntimeMode | undefined;
  readonly activeRuntimeMode: RuntimeMode | undefined;
  readonly queuedInteractionMode: ProviderInteractionMode | undefined;
  readonly activeInteractionMode: ProviderInteractionMode | undefined;
  readonly queuedTokenMode: AgentTokenMode | undefined;
  readonly activeTokenMode: AgentTokenMode | undefined;
}

export function buildQueuedMessageSteerCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly expectedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly createdAt: string;
  readonly requestedAt: string;
}) {
  return {
    type: "thread.turn.steer" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: input.text,
      attachments: [...input.attachments],
    },
    createdAt: input.createdAt,
    requestedAt: input.requestedAt,
  };
}

function modelSelectionsEqual(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

/** Provider-neutral policy shared by web/desktop and native mobile. */
export function resolveQueuedMessageSteerEligibility(
  input: QueuedMessageSteerEligibilityInput,
): QueuedMessageSteerEligibility {
  if (!input.mutationReady) {
    return {
      allowed: false,
      reason: "Steering is unavailable until the connection is ready.",
    };
  }
  if (!input.turnRunning || input.activeTurnId === null || input.activeTurnId === undefined) {
    return {
      allowed: false,
      reason: "Steering is available only while a turn is running.",
    };
  }
  if (!input.supportsTurnSteering) {
    return {
      allowed: false,
      reason: "This provider does not support active-turn steering.",
    };
  }
  if (!modelSelectionsEqual(input.queuedModelSelection, input.activeModelSelection)) {
    return {
      allowed: false,
      reason: "The queued provider or model no longer matches the active turn.",
    };
  }
  if (
    input.queuedRuntimeMode !== input.activeRuntimeMode ||
    input.queuedInteractionMode !== input.activeInteractionMode ||
    input.queuedTokenMode !== input.activeTokenMode
  ) {
    return {
      allowed: false,
      reason: "The queued runtime settings do not match the active turn.",
    };
  }
  return { allowed: true, expectedTurnId: input.activeTurnId };
}

/** What sending a composer message does: start a turn, queue it, or steer the running turn. */
export type ComposerFollowUpAction = "send" | "queue" | "steer";

export function alternateFollowUpBehavior(behavior: FollowUpBehavior): FollowUpBehavior {
  return behavior === "queue" ? "steer" : "queue";
}

/**
 * Not running → "send". Otherwise the preferred behaviour (inverted by Mod+Enter); "steer"
 * degrades to "queue" when the surface cannot steer or the input is a slash command.
 */
export function resolveComposerFollowUpAction(input: {
  readonly turnRunning: boolean;
  readonly followUpBehavior: FollowUpBehavior;
  readonly invert: boolean;
  readonly surfaceAllowsSteer: boolean;
  readonly isSlashCommand: boolean;
}): ComposerFollowUpAction {
  if (!input.turnRunning) return "send";
  const preferred = input.invert
    ? alternateFollowUpBehavior(input.followUpBehavior)
    : input.followUpBehavior;
  if (preferred === "steer" && input.surfaceAllowsSteer && !input.isSlashCommand) return "steer";
  return "queue";
}

/**
 * One steer of one queued message. Keyed by the steer request's `commandId`: only that request's
 * own outcome may end it, so a stale rejection of an earlier attempt never ends a re-steer.
 */
export interface QueuedMessageSteerAttempt {
  readonly commandId: string;
  readonly expectedTurnId: TurnId;
  readonly startedAt: string;
  /** The user asked for this steer (Steer button, Mod+Enter); outcomes are surfaced. */
  readonly explicit: boolean;
}

export type QueuedMessageSteerOutcome =
  | { readonly status: "pending" }
  | { readonly status: "accepted" }
  | {
      readonly status: "rejected";
      readonly reason: TurnSteerRejectionReason;
      readonly error: string;
      readonly deliveryUncertain: boolean;
    };

const EMPTY_STEER_REJECTIONS: ReadonlyMap<string, TurnSteerRejectionActivity> = new Map();

/** Steer rejection rows keyed by activity id (one row per steer request). */
export function indexTurnSteerRejections(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
  }>,
): ReadonlyMap<string, TurnSteerRejectionActivity> {
  let index: Map<string, TurnSteerRejectionActivity> | undefined;
  for (const activity of activities) {
    const rejection = readTurnSteerRejectionActivity(activity);
    if (rejection === null) continue;
    index ??= new Map();
    index.set(activity.id, rejection);
  }
  return index ?? EMPTY_STEER_REJECTIONS;
}

/** Accepted if projected; rejected only by the activity of THIS attempt's request; else pending. */
export function resolveQueuedMessageSteerOutcome(input: {
  readonly messageId: string;
  readonly attempt: QueuedMessageSteerAttempt;
  readonly projectedMessageIds: ReadonlySet<string>;
  readonly rejectionsByActivityId: ReadonlyMap<string, TurnSteerRejectionActivity>;
}): QueuedMessageSteerOutcome {
  if (input.projectedMessageIds.has(input.messageId)) return { status: "accepted" };
  const rejection = input.rejectionsByActivityId.get(
    turnSteerRejectionActivityId(input.attempt.commandId),
  );
  if (rejection === undefined) return { status: "pending" };
  if (rejection.messageId !== null && rejection.messageId !== input.messageId) {
    return { status: "pending" };
  }
  return {
    status: "rejected",
    reason: rejection.reason,
    error: rejection.error,
    deliveryUncertain: rejection.deliveryUncertain,
  };
}

/**
 * A steer attempt its own request rejected. The message stays queued for the next turn, unless
 * `deliveryUncertain`: the provider may already have it, so sending it again could duplicate
 * it. Such a message is marked failed and waits for an explicit retry or removal.
 */
export interface QueuedMessageSteerRejection {
  readonly messageId: string;
  readonly attempt: QueuedMessageSteerAttempt;
  readonly reason: TurnSteerRejectionReason;
  readonly error: string;
  readonly deliveryUncertain: boolean;
}

/** Settled steer attempts: accepted (projected) message ids and rejections, in attempt order. */
export function collectQueuedMessageSteerOutcomes(input: {
  readonly attempts: Iterable<readonly [string, QueuedMessageSteerAttempt]>;
  readonly projectedMessageIds: ReadonlySet<string>;
  readonly rejectionsByActivityId: ReadonlyMap<string, TurnSteerRejectionActivity>;
}): { readonly accepted: string[]; readonly rejected: QueuedMessageSteerRejection[] } {
  const accepted: string[] = [];
  const rejected: QueuedMessageSteerRejection[] = [];
  for (const [messageId, attempt] of input.attempts) {
    const outcome = resolveQueuedMessageSteerOutcome({
      messageId,
      attempt,
      projectedMessageIds: input.projectedMessageIds,
      rejectionsByActivityId: input.rejectionsByActivityId,
    });
    if (outcome.status === "accepted") accepted.push(messageId);
    else if (outcome.status === "rejected") {
      rejected.push({
        messageId,
        attempt,
        reason: outcome.reason,
        error: outcome.error,
        deliveryUncertain: outcome.deliveryUncertain,
      });
    }
  }
  return { accepted, rejected };
}

export function removeQueuedMessage<Composer, Settings>(
  queue: readonly QueuedMessage<Composer, Settings>[],
  id: string,
): QueuedMessage<Composer, Settings>[] {
  return queue.filter((message) => message.id !== id);
}

export function moveQueuedMessage<Composer, Settings>(
  queue: readonly QueuedMessage<Composer, Settings>[],
  id: string,
  direction: "up" | "down",
): QueuedMessage<Composer, Settings>[] {
  const index = queue.findIndex((message) => message.id === id);
  if (index === -1) return [...queue];

  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= queue.length) return [...queue];

  const next = [...queue];
  const [moved] = next.splice(index, 1);
  next.splice(targetIndex, 0, moved!);
  return next;
}

export interface QueuedMessageSummaryInput {
  readonly trimmedPrompt: string;
  readonly imageCount: number;
  readonly terminalContextCount: number;
}

export function getQueuedThreadKeys<Composer, Settings>(
  queuesByThreadKey: Readonly<Record<string, readonly QueuedMessage<Composer, Settings>[]>>,
): Set<string> {
  return new Set(
    Object.entries(queuesByThreadKey).flatMap(([threadKey, queue]) =>
      queue.length > 0 ? [threadKey] : [],
    ),
  );
}

const QUEUED_MESSAGE_SUMMARY_MAX_CHARS = 120;

export function summarizeQueuedMessage(input: QueuedMessageSummaryInput): string {
  const text = input.trimmedPrompt.trim();
  if (text.length > 0) {
    return text.length > QUEUED_MESSAGE_SUMMARY_MAX_CHARS
      ? `${text.slice(0, QUEUED_MESSAGE_SUMMARY_MAX_CHARS - 1)}…`
      : text;
  }
  if (input.imageCount > 0)
    return input.imageCount === 1 ? "1 image" : `${input.imageCount} images`;
  if (input.terminalContextCount > 0) {
    return input.terminalContextCount === 1
      ? "1 terminal context"
      : `${input.terminalContextCount} terminal contexts`;
  }
  return "Queued message";
}
