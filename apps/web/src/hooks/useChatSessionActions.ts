import type { ApprovalResponseIdentity } from "@ryco/contracts";
import type { EnvironmentId } from "@ryco/contracts";
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@ryco/contracts";
import { useCallback, useEffect, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { readLocalApi } from "../localApi";
import { holdMessageQueueForInterrupt } from "../messageQueueDrain";
import {
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpointWithGuards,
  type RevertThreadCheckpointGuardFailure,
} from "./chatSessionActions";

export type SetThreadError = (targetThreadId: ThreadId | null, error: string | null) => void;

export function revertCheckpointGuardFailureMessage(
  failure: RevertThreadCheckpointGuardFailure,
): string | null {
  switch (failure.type) {
    case "missing-api":
    case "missing-thread":
    case "user-cancelled":
      return null;
    case "environment-unavailable":
      return `Reconnect ${failure.label} before reverting checkpoints.`;
    case "turn-in-progress":
      return "Interrupt the current turn before reverting checkpoints.";
    case "provider-unsupported":
      return failure.message;
  }
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
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThreadId]);

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

  const respondToApproval = useCallback(
    async (
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      approvalIdentity?: ApprovalResponseIdentity,
    ) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) {
        return;
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
      } catch (err: unknown) {
        setThreadError(
          activeThreadId,
          err instanceof Error ? err.message : "Failed to submit approval decision.",
        );
      } finally {
        setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [activeThreadId, environmentId, setThreadError],
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
    async (input: {
      thread: { id: ThreadId } | null;
      turnCount: number;
      environmentUnavailable: boolean;
      environmentUnavailableLabel: string | null;
      turnInProgress: boolean;
      providerRefusal: string | null;
    }) => {
      const api = readEnvironmentApi(environmentId);
      const localApi = readLocalApi();
      if (isRevertingCheckpoint) {
        return;
      }

      setIsRevertingCheckpoint(true);
      if (input.thread) {
        setThreadError(input.thread.id, null);
      }
      try {
        const result = await revertThreadCheckpointWithGuards({
          api: api ?? null,
          localApi: localApi ?? null,
          thread: input.thread,
          turnCount: input.turnCount,
          environmentUnavailable: input.environmentUnavailable,
          environmentUnavailableLabel: input.environmentUnavailableLabel,
          turnInProgress: input.turnInProgress,
          providerRefusal: input.providerRefusal,
          confirmMessage: [
            `Revert this thread to checkpoint ${input.turnCount}?`,
            "The agent forgets the newer turns, and the files in this checkout go back to how they were at that checkpoint. Changes made since then, including your own edits, are discarded.",
            "This action cannot be undone.",
          ].join("\n"),
        });
        if (!result.ok) {
          const message = revertCheckpointGuardFailureMessage(result.reason);
          if (message && input.thread) {
            setThreadError(input.thread.id, message);
          }
        }
      } catch (err: unknown) {
        if (input.thread) {
          setThreadError(
            input.thread.id,
            err instanceof Error ? err.message : "Failed to revert thread state.",
          );
        }
      } finally {
        setIsRevertingCheckpoint(false);
      }
    },
    [environmentId, isRevertingCheckpoint, setThreadError],
  );

  return {
    interruptTurn,
    respondToApproval,
    respondToUserInput,
    revertToTurnCount,
    respondingRequestIds,
    respondingUserInputRequestIds,
    isRevertingCheckpoint,
  };
}
