import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  revertCheckpointGuardFailureMessage,
  readCheckpointRevertPhase,
  runCheckpointRevert,
  subscribeCheckpointReverts,
  type CheckpointRevertMode,
} from "@ryco/client-runtime/state/session";
import type { ApprovalResponseIdentity } from "@ryco/contracts";
import type { EnvironmentId } from "@ryco/contracts";
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@ryco/contracts";
import { useCallback, useState, useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { holdMessageQueueForInterrupt } from "../messageQueueDrain";
import { selectThreadByRef, useStore } from "../store";
import {
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
} from "./chatSessionActions";

export type SetThreadError = (targetThreadId: ThreadId | null, error: string | null) => void;

export interface RevertToTurnCountInput<TPrepared> {
  readonly thread: { readonly id: ThreadId } | null;
  readonly turnCount: number;
  readonly environmentUnavailable: boolean;
  readonly environmentUnavailableLabel: string | null;
  readonly turnInProgress: boolean;
  readonly providerRefusal: string | null;
  /** Asks the user how to revert; null cancels. */
  readonly choose: () => Promise<CheckpointRevertMode | null>;
  /** Runs after the choice, before the revert is sent; a throw reverts nothing. */
  readonly prepare?: ((mode: CheckpointRevertMode) => Promise<TPrepared>) | undefined;
  /**
   * Runs with what `prepare` returned once the node rewound the thread, or
   * when Ryco could not confirm it either way (the node may have deleted it).
   */
  readonly onReverted?: ((prepared: TPrepared) => void) | undefined;
}

export function useChatSessionActions(input: {
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  setThreadError: SetThreadError;
}) {
  const { environmentId, activeThreadId, setThreadError } = input;
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  // Per thread, so it survives switching threads and is not ended by another thread's revert.
  const activeThreadKey = activeThreadId
    ? scopedThreadKey(scopeThreadRef(environmentId, activeThreadId))
    : null;
  const readActiveRevertPhase = () => readCheckpointRevertPhase(activeThreadKey);
  const isRevertingCheckpoint =
    useSyncExternalStore(
      subscribeCheckpointReverts,
      readActiveRevertPhase,
      readActiveRevertPhase,
    ) === "reverting";

  const interruptTurn = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThreadId) {
      return;
    }
    // Stop means stop: hold the follow-up queue before the turn can settle,
    // and undo the hold only if the interrupt never reached the server.
    const held = holdMessageQueueForInterrupt(environmentId, activeThreadId);
    try {
      await interruptThreadTurn(api, activeThreadId);
    } catch (error) {
      held.undo();
      throw error;
    }
  }, [activeThreadId, environmentId]);

  /**
   * Submits an approval decision and rejects when the node refuses it. A redirecting send uses
   * it directly: it must know the decline was taken before it steers.
   */
  const submitApprovalDecision = useCallback(
    async (
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      approvalIdentity?: ApprovalResponseIdentity,
    ) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) {
        throw new Error("This environment is not connected.");
      }

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await respondToThreadApproval({
          api,
          threadId: activeThreadId,
          requestId,
          decision,
          approvalIdentity,
        });
      } finally {
        setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [activeThreadId, environmentId],
  );

  const respondToApproval = useCallback(
    async (
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      approvalIdentity?: ApprovalResponseIdentity,
    ) => {
      if (!readEnvironmentApi(environmentId) || !activeThreadId) {
        return;
      }
      try {
        await submitApprovalDecision(requestId, decision, approvalIdentity);
      } catch (err: unknown) {
        setThreadError(
          activeThreadId,
          err instanceof Error ? err.message : "Failed to submit approval decision.",
        );
      }
    },
    [activeThreadId, environmentId, setThreadError, submitApprovalDecision],
  );

  const respondToUserInput = useCallback(
    async (
      requestId: ApprovalRequestId,
      answers: Record<string, unknown>,
      userInputIdentity?: ApprovalResponseIdentity,
    ) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) {
        return;
      }

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await respondToThreadUserInput({
          api,
          threadId: activeThreadId,
          requestId,
          answers,
          userInputIdentity,
        });
      } catch (err: unknown) {
        setThreadError(
          activeThreadId,
          err instanceof Error ? err.message : "Failed to submit user input.",
        );
      } finally {
        setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const revertToTurnCount = useCallback(
    async <TPrepared = undefined>(input: RevertToTurnCountInput<TPrepared>) => {
      const api = readEnvironmentApi(environmentId);
      const threadId = input.thread?.id ?? null;
      const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
      const result = await runCheckpointRevert<TPrepared>({
        environmentId,
        dispatchCommand: api ? (command) => api.orchestration.dispatchCommand(command) : null,
        threadId,
        turnCount: input.turnCount,
        environmentUnavailable: input.environmentUnavailable,
        environmentUnavailableLabel: input.environmentUnavailableLabel,
        turnInProgress: input.turnInProgress,
        providerRefusal: input.providerRefusal,
        choose: async () => {
          const mode = await input.choose();
          if (mode !== null) setThreadError(threadId, null);
          return mode;
        },
        prepare: input.prepare,
        newCommandId,
        readThread: () =>
          threadRef ? selectThreadByRef(useStore.getState(), threadRef) : undefined,
        subscribe: (listener) => useStore.subscribe(listener),
      });
      switch (result.kind) {
        case "refused": {
          const message = revertCheckpointGuardFailureMessage(result.reason);
          if (message) setThreadError(threadId, message);
          return;
        }
        case "not-reverted":
          setThreadError(threadId, result.error);
          return;
        case "reverted":
          input.onReverted?.(result.prepared);
          // The revert's own row stays out of the timeline, so its note shows here.
          if (result.notice) {
            toastManager.add(
              stackedThreadToast({
                type: result.notice.tone,
                title: result.notice.title,
                description: result.notice.detail,
              }),
            );
          }
          return;
        case "unconfirmed":
          input.onReverted?.(result.prepared);
          setThreadError(threadId, result.error);
          return;
      }
    },
    [environmentId, setThreadError],
  );

  return {
    interruptTurn,
    respondToApproval,
    submitApprovalDecision,
    respondToUserInput,
    revertToTurnCount,
    respondingRequestIds,
    respondingUserInputRequestIds,
    isRevertingCheckpoint,
  };
}
