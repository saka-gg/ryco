import {
  submitApprovalResponse,
  submitUserInputResponse,
} from "@ryco/client-runtime/state/session";
import type { ApprovalResponseIdentity } from "@ryco/contracts";
import type { EnvironmentApi } from "@ryco/contracts";
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@ryco/contracts";

import type { SidebarActionCommand } from "@ryco/client-runtime/state/threads";
import { newCommandId } from "../../lib/ids";

// §3-15: pure thread session-action dispatch wrappers, ported from
// apps/web/src/hooks/chatSessionActions.ts. Each dispatches an orchestration
// command through the EnvironmentApi seam (§3-12); no forked runtime logic. The
// checkpoint revert is shared with web: `runCheckpointRevert`
// in `@ryco/client-runtime/state/session` ("Edit from here", `editFromHere.ts`).

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

export async function setThreadArchived(
  api: EnvironmentApi,
  threadId: ThreadId,
  archived: boolean,
  dispatch: (command: SidebarActionCommand) => Promise<unknown> = api.orchestration.dispatchCommand,
): Promise<void> {
  await dispatch({
    type: archived ? "thread.archive" : "thread.unarchive",
    commandId: newCommandId(),
    threadId,
  });
}

export async function setThreadSettled(
  api: EnvironmentApi,
  threadId: ThreadId,
  settled: boolean,
  dispatch: (command: SidebarActionCommand) => Promise<unknown> = api.orchestration.dispatchCommand,
): Promise<void> {
  await dispatch(
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
  userInputIdentity?: ApprovalResponseIdentity | undefined;
}): Promise<void> {
  await submitUserInputResponse({
    ...input,
    submit: () =>
      input.api.orchestration.dispatchCommand({
        type: "thread.user-input.respond",
        commandId: newCommandId(),
        threadId: input.threadId,
        requestId: input.requestId,
        answers: input.answers,
        ...(input.userInputIdentity ? { userInputIdentity: input.userInputIdentity } : {}),
        createdAt: new Date().toISOString(),
      }),
  });
}
