import type {
  AgentTokenMode,
  CommandId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
  UploadChatAttachment,
} from "@ryco/contracts";

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
