/**
 * Builds the `thread.activity.append` command for a provider failure (and, with
 * `providerNoticeActivityCommand`, for an informational provider notice). Shared
 * by the provider command reactor and the context-handoff coordinator so both
 * surface turn-start failures with the same activity shape.
 *
 * Pure module: no services, no I/O.
 */
import {
  type ApprovalResponseIdentity,
  type ApprovalResponseState,
  CommandId,
  EventId,
  type MessageId,
  type OrchestrationCommand,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";

export type ProviderFailureActivityKind =
  | "provider.goal.update.failed"
  | "provider.turn.start.failed"
  | "provider.turn.interrupt.failed"
  | "provider.approval.respond.failed"
  | "provider.user-input.respond.failed"
  | "provider.session.stop.failed"
  | "provider.session.restart.failed"
  | "provider.turn.lost";

export interface ProviderFailureActivityInput {
  readonly threadId: ThreadId;
  readonly kind: ProviderFailureActivityKind;
  readonly summary: string;
  readonly detail: string;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
  readonly requestId?: string;
  readonly messageId?: MessageId;
  readonly approvalIdentity?: ApprovalResponseIdentity;
  readonly userInputIdentity?: ApprovalResponseIdentity;
  readonly responseAttemptId?: CommandId;
  readonly responseState?: ApprovalResponseState;
}

export function providerFailureActivityCommand(
  input: ProviderFailureActivityInput,
): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:provider-failure-activity:${crypto.randomUUID()}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(crypto.randomUUID()),
      tone: "error",
      kind: input.kind,
      summary: input.summary,
      payload: {
        detail: input.detail,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.approvalIdentity ? { approvalIdentity: input.approvalIdentity } : {}),
        ...(input.userInputIdentity ? { userInputIdentity: input.userInputIdentity } : {}),
        ...(input.responseAttemptId ? { responseAttemptId: input.responseAttemptId } : {}),
        ...(input.responseState ? { responseState: input.responseState } : {}),
      },
      turnId: input.turnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/** Informational provider notices: same command shape, tone `info`. */
export type ProviderNoticeActivityKind =
  | "provider.turn.start.cancelled"
  | "provider.turn.unresponsive";

export function providerNoticeActivityCommand(input: {
  readonly threadId: ThreadId;
  readonly kind: ProviderNoticeActivityKind;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:provider-notice-activity:${crypto.randomUUID()}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(crypto.randomUUID()),
      tone: "info",
      kind: input.kind,
      summary: input.summary,
      payload: input.payload,
      turnId: input.turnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}
