import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequestId } from "@ryco/contracts";
import type { SessionPhase, Thread } from "../../types";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../ChatView.logic";

export interface UseLocalDispatchStateInput {
  /** The thread the view shows (its scoped key); a dispatch belongs to the thread it began on. */
  threadKey: string | null;
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}

/** A send's begin and reset, bound to the thread the view showed when the send started. */
export interface ThreadLocalDispatch {
  beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void;
  resetLocalDispatch: () => void;
}

export interface UseLocalDispatchStateResult extends ThreadLocalDispatch {
  /**
   * Binds a send to the shown thread. ChatView follows thread navigation, so a
   * send still running after the user moved on must neither mark the thread now
   * shown as busy (its server state never acknowledges a dispatch it did not
   * make) nor clear that thread's own dispatch.
   */
  bindLocalDispatch: () => ThreadLocalDispatch;
  localDispatchStartedAt: string | null;
  isPreparingWorktree: boolean;
  isSendBusy: boolean;
}

/** Each thread's dispatch, kept while the view shows another so it is still busy on return. */
type LocalDispatchSnapshots = Readonly<Record<string, LocalDispatchSnapshot>>;

const NO_DISPATCHES: LocalDispatchSnapshots = {};

const snapshotKeyOf = (threadKey: string | null) => threadKey ?? "";

function withoutDispatch(
  current: LocalDispatchSnapshots,
  threadKey: string | null,
): LocalDispatchSnapshots {
  const key = snapshotKeyOf(threadKey);
  if (!(key in current)) return current;
  const { [key]: _removed, ...rest } = current;
  return rest;
}

/**
 * Tracks the optimistic "local dispatch" window between pressing send and the
 * server acknowledging the turn, surfacing the derived send-busy state and
 * clearing itself once the server catches up.
 */
export function useLocalDispatchState(
  input: UseLocalDispatchStateInput,
): UseLocalDispatchStateResult {
  const [localDispatchState, setLocalDispatchState] =
    useState<LocalDispatchSnapshots>(NO_DISPATCHES);
  // A send holds this callback across awaits (a Claude resume review can run a
  // `/compact` turn first), so the snapshot must be of the thread as it is now.
  const activeThreadRef = useRef(input.activeThread);
  const threadKeyRef = useRef(input.threadKey);
  useLayoutEffect(() => {
    activeThreadRef.current = input.activeThread;
    threadKeyRef.current = input.threadKey;
  }, [input.activeThread, input.threadKey]);

  const bindLocalDispatch = useCallback((): ThreadLocalDispatch => {
    const threadKey = threadKeyRef.current;
    const key = snapshotKeyOf(threadKey);
    return {
      beginLocalDispatch: (options) => {
        const preparingWorktree = Boolean(options?.preparingWorktree);
        // Once the view moved on, a new snapshot would be of another thread:
        // only the thread's own dispatch is updated.
        const shown = threadKeyRef.current === threadKey;
        setLocalDispatchState((current) => {
          const existing = current[key];
          if (existing) {
            return existing.preparingWorktree === preparingWorktree
              ? current
              : { ...current, [key]: { ...existing, preparingWorktree } };
          }
          if (!shown) return current;
          return {
            ...current,
            [key]: createLocalDispatchSnapshot(activeThreadRef.current, options),
          };
        });
      },
      resetLocalDispatch: () => {
        setLocalDispatchState((current) => withoutDispatch(current, threadKey));
      },
    };
  }, []);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => bindLocalDispatch().beginLocalDispatch(options),
    [bindLocalDispatch],
  );

  /** Clears the shown thread's dispatch; other threads keep theirs. */
  const resetLocalDispatch = useCallback(
    () => bindLocalDispatch().resetLocalDispatch(),
    [bindLocalDispatch],
  );

  const localDispatch = localDispatchState[snapshotKeyOf(input.threadKey)] ?? null;

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
    bindLocalDispatch,
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}
