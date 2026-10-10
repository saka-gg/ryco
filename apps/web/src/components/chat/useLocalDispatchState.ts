import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequestId } from "@ryco/contracts";
import type { SessionPhase, Thread } from "../../types";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../ChatView.logic";

export interface UseLocalDispatchStateInput {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}

export interface UseLocalDispatchStateResult {
  beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void;
  resetLocalDispatch: () => void;
  localDispatchStartedAt: string | null;
  isPreparingWorktree: boolean;
  isSendBusy: boolean;
}

/**
 * Tracks the optimistic "local dispatch" window between pressing send and the
 * server acknowledging the turn, surfacing the derived send-busy state and
 * clearing itself once the server catches up.
 */
export function useLocalDispatchState(
  input: UseLocalDispatchStateInput,
): UseLocalDispatchStateResult {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  // A send holds this callback across awaits (a Claude resume review can run a
  // `/compact` turn first), so the snapshot must be of the thread as it is now.
  const activeThreadRef = useRef(input.activeThread);
  useEffect(() => {
    activeThreadRef.current = input.activeThread;
  }, [input.activeThread]);

  const beginLocalDispatch = useCallback((options?: { preparingWorktree?: boolean }) => {
    const preparingWorktree = Boolean(options?.preparingWorktree);
    setLocalDispatch((current) => {
      if (current) {
        return current.preparingWorktree === preparingWorktree
          ? current
          : { ...current, preparingWorktree };
      }
      return createLocalDispatchSnapshot(activeThreadRef.current, options);
    });
  }, []);

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}
