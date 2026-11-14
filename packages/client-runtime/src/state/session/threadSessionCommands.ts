import type {
  ApprovalRequestId,
  ApprovalResponseIdentity,
  CommandId,
  EnvironmentApi,
  ProviderApprovalDecision,
  ThreadId,
} from "@ryco/contracts";

import { submitApprovalResponse, submitUserInputResponse } from "./approvalResponses.ts";

/** How a client stamps a command: its own id source (web and mobile make UUIDs differently). */
export interface ThreadCommandStamp {
  readonly newCommandId: () => CommandId;
  readonly now?: () => Date;
}

export interface ThreadSessionCommands {
  /** Stops the running turn. `holdQueue` also holds the node's follow-up queue, in the same batch. */
  readonly interruptThreadTurn: (
    api: EnvironmentApi,
    threadId: ThreadId,
    options?: { readonly holdQueue?: boolean },
  ) => Promise<void>;
  readonly respondToThreadApproval: (input: {
    api: EnvironmentApi;
    threadId: ThreadId;
    requestId: ApprovalRequestId;
    decision: ProviderApprovalDecision;
    approvalIdentity?: ApprovalResponseIdentity | undefined;
  }) => Promise<void>;
  readonly respondToThreadUserInput: (input: {
    api: EnvironmentApi;
    threadId: ThreadId;
    requestId: ApprovalRequestId;
    answers: Record<string, unknown>;
    userInputIdentity?: ApprovalResponseIdentity | undefined;
  }) => Promise<void>;
}

/**
 * The thread session-action commands web and mobile dispatch: one shape for the protocol, with
 * each client's command ids.
 */
export function createThreadSessionCommands(stamp: ThreadCommandStamp): ThreadSessionCommands {
  const createdAt = () => (stamp.now?.() ?? new Date()).toISOString();
  return {
    interruptThreadTurn: async (api, threadId, options) => {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: stamp.newCommandId(),
        threadId,
        // A person's Stop also holds the node's follow-up queue, in the same batch.
        ...(options?.holdQueue ? { holdQueue: true as const } : {}),
        createdAt: createdAt(),
      });
    },
    respondToThreadApproval: async (input) => {
      await submitApprovalResponse({
        ...input,
        submit: () =>
          input.api.orchestration.dispatchCommand({
            type: "thread.approval.respond",
            commandId: stamp.newCommandId(),
            threadId: input.threadId,
            requestId: input.requestId,
            decision: input.decision,
            ...(input.approvalIdentity ? { approvalIdentity: input.approvalIdentity } : {}),
            createdAt: createdAt(),
          }),
      });
    },
    respondToThreadUserInput: async (input) => {
      await submitUserInputResponse({
        ...input,
        submit: () =>
          input.api.orchestration.dispatchCommand({
            type: "thread.user-input.respond",
            commandId: stamp.newCommandId(),
            threadId: input.threadId,
            requestId: input.requestId,
            answers: input.answers,
            ...(input.userInputIdentity ? { userInputIdentity: input.userInputIdentity } : {}),
            createdAt: createdAt(),
          }),
      });
    },
  };
}
