import { submitApprovalResponse } from "@ryco/client-runtime/state/session";
import type { ApprovalResponseIdentity } from "@ryco/contracts";
import type { EnvironmentApi } from "@ryco/contracts";
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@ryco/contracts";

import { newCommandId } from "../lib/utils";

export async function interruptThreadTurn(api: EnvironmentApi, threadId: ThreadId): Promise<void> {
  await api.orchestration.dispatchCommand({
    type: "thread.turn.interrupt",
    commandId: newCommandId(),
    threadId,
    createdAt: new Date().toISOString(),
  });
}

export async function respondToThreadApproval(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  decision: ProviderApprovalDecision;
  approvalIdentity?: ApprovalResponseIdentity | undefined;
}): Promise<void> {
  await submitApprovalResponse({
    ...input,
    submit: () =>
      input.api.orchestration.dispatchCommand({
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision,
        ...(input.approvalIdentity ? { approvalIdentity: input.approvalIdentity } : {}),
        createdAt: new Date().toISOString(),
      }),
  });
}

export async function respondToThreadUserInput(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  answers: Record<string, unknown>;
}): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "thread.user-input.respond",
    commandId: newCommandId(),
    threadId: input.threadId,
    requestId: input.requestId,
    answers: input.answers,
    createdAt: new Date().toISOString(),
  });
}

export async function revertThreadToTurnCount(input: {
  api: EnvironmentApi;
  threadId: ThreadId;
  turnCount: number;
}): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "thread.checkpoint.revert",
    commandId: newCommandId(),
    threadId: input.threadId,
    turnCount: input.turnCount,
    createdAt: new Date().toISOString(),
  });
}

export type RevertThreadCheckpointGuardFailure =
  | { type: "missing-api" }
  | { type: "missing-thread" }
  | { type: "environment-unavailable"; label: string }
  | { type: "turn-in-progress" }
  | { type: "user-cancelled" };

export type RevertThreadCheckpointResult =
  | { ok: true }
  | { ok: false; reason: RevertThreadCheckpointGuardFailure };

export async function revertThreadCheckpointWithGuards(input: {
  api: EnvironmentApi | null;
  localApi: { dialogs: { confirm: (message: string) => Promise<boolean> } } | null;
  thread: { id: ThreadId } | null;
  turnCount: number;
  environmentUnavailable: boolean;
  environmentUnavailableLabel: string | null;
  turnInProgress: boolean;
  confirmMessage: string;
}): Promise<RevertThreadCheckpointResult> {
  if (!input.api || !input.localApi || !input.thread) {
    return { ok: false, reason: { type: "missing-api" } };
  }
  if (input.environmentUnavailable) {
    return {
      ok: false,
      reason: {
        type: "environment-unavailable",
        label: input.environmentUnavailableLabel ?? "environment",
      },
    };
  }
  if (input.turnInProgress) {
    return { ok: false, reason: { type: "turn-in-progress" } };
  }
  const confirmed = await input.localApi.dialogs.confirm(input.confirmMessage);
  if (!confirmed) {
    return { ok: false, reason: { type: "user-cancelled" } };
  }
  await revertThreadToTurnCount({
    api: input.api,
    threadId: input.thread.id,
    turnCount: input.turnCount,
  });
  return { ok: true };
}
