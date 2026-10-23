import {
  submitApprovalResponse,
  submitUserInputResponse,
} from "@ryco/client-runtime/state/session";
import type { ApprovalResponseIdentity } from "@ryco/contracts";
import type { EnvironmentApi } from "@ryco/contracts";
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@ryco/contracts";

import { newCommandId } from "../lib/utils";

// The checkpoint revert, from its guards to the node's verdict, is shared with mobile:
// `runCheckpointRevert` in `@ryco/client-runtime/state/session`.

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
