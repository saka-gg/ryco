import { submitApprovalResponse } from "@ryco/client-runtime/state/session";
import type { ApprovalResponseIdentity } from "@ryco/contracts";
import type { EnvironmentApi } from "@ryco/contracts";
import {
  type ApprovalRequestId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@ryco/contracts";

import { newCommandId } from "../../lib/ids";

// §3-15: pure thread session-action dispatch wrappers, ported from
// apps/web/src/hooks/chatSessionActions.ts. Each dispatches an orchestration
// command through the EnvironmentApi seam (§3-12); no forked runtime logic. The
// revert guard is adapted from web's localApi.dialogs.confirm to a plain confirm
// callback (mobile drives it through ConfirmDialogHost).

export async function interruptThreadTurn(api: EnvironmentApi, threadId: ThreadId): Promise<void> {
  await api.orchestration.dispatchCommand({
    type: "thread.turn.interrupt",
    commandId: newCommandId(),
    threadId,
    createdAt: new Date().toISOString(),
  });
}

export async function renameThread(
  api: EnvironmentApi,
  threadId: ThreadId,
  title: string,
): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Task title cannot be empty.");
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    title: trimmed,
  });
}

// Note the asymmetry with `thread.meta.update` above: the mode-set commands
// REQUIRE `createdAt` and `thread.meta.update` has no such field at all. Adding
// it to the meta command fails schema validation at the server.
export async function setThreadRuntimeMode(
  api: EnvironmentApi,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
): Promise<void> {
  await api.orchestration.dispatchCommand({
    type: "thread.runtime-mode.set",
    commandId: newCommandId(),
    threadId,
    runtimeMode,
    createdAt: new Date().toISOString(),
  });
}

export async function setThreadInteractionMode(
  api: EnvironmentApi,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
): Promise<void> {
  await api.orchestration.dispatchCommand({
    type: "thread.interaction-mode.set",
    commandId: newCommandId(),
    threadId,
    interactionMode,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Model changes ride `thread.meta.update` — there is no `thread.model.set`.
 * Note it takes no `createdAt`, unlike the two mode commands above.
 */
export async function setThreadModelSelection(
  api: EnvironmentApi,
  threadId: ThreadId,
  modelSelection: ModelSelection,
): Promise<void> {
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    modelSelection,
  });
}

export async function setThreadArchived(
  api: EnvironmentApi,
  threadId: ThreadId,
  archived: boolean,
): Promise<void> {
  await api.orchestration.dispatchCommand({
    type: archived ? "thread.archive" : "thread.unarchive",
    commandId: newCommandId(),
    threadId,
  });
}

export async function setThreadSettled(
  api: EnvironmentApi,
  threadId: ThreadId,
  settled: boolean,
): Promise<void> {
  await api.orchestration.dispatchCommand(
    settled
      ? { type: "thread.settle", commandId: newCommandId(), threadId }
      : {
          type: "thread.unsettle",
          commandId: newCommandId(),
          threadId,
          reason: "user",
        },
  );
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
  | { type: "environment-unavailable"; label: string }
  | { type: "turn-in-progress" }
  | { type: "user-cancelled" };

export type RevertThreadCheckpointResult =
  | { ok: true }
  | { ok: false; reason: RevertThreadCheckpointGuardFailure };

export async function revertThreadCheckpointWithGuards(input: {
  api: EnvironmentApi | null;
  thread: { id: ThreadId } | null;
  turnCount: number;
  environmentUnavailable: boolean;
  environmentUnavailableLabel: string | null;
  turnInProgress: boolean;
  confirmMessage: string;
  confirm: (message: string) => Promise<boolean>;
}): Promise<RevertThreadCheckpointResult> {
  if (!input.api || !input.thread) {
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
  const confirmed = await input.confirm(input.confirmMessage);
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
