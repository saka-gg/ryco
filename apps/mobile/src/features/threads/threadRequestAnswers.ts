import type { PendingApproval, PendingUserInput } from "@ryco/client-runtime/state/session";
import type { EnvironmentId, ProviderApprovalDecision, ThreadId } from "@ryco/contracts";

import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { respondToThreadApproval, respondToThreadUserInput } from "./sessionActions";

/**
 * Answers one of a thread's approvals: the card's buttons, a send that declines the waiting
 * approvals, and an action tapped on a notification all answer through here. Async, so a
 * missing connection (`ensureEnvironmentApi` throws synchronously) rejects like a failed RPC.
 */
export async function answerThreadApproval(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly approval: Pick<PendingApproval, "requestId" | "approvalIdentity">;
  readonly decision: ProviderApprovalDecision;
}): Promise<void> {
  await respondToThreadApproval({
    api: ensureEnvironmentApi(input.environmentId),
    threadId: input.threadId,
    requestId: input.approval.requestId,
    decision: input.decision,
    approvalIdentity: input.approval.approvalIdentity,
  });
}

/** Answers one of a thread's questions; the card and a notification reply answer through here. */
export async function answerThreadUserInput(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly userInput: Pick<PendingUserInput, "requestId" | "userInputIdentity">;
  readonly answers: Record<string, unknown>;
}): Promise<void> {
  await respondToThreadUserInput({
    api: ensureEnvironmentApi(input.environmentId),
    threadId: input.threadId,
    requestId: input.userInput.requestId,
    answers: input.answers,
    userInputIdentity: input.userInput.userInputIdentity,
  });
}
