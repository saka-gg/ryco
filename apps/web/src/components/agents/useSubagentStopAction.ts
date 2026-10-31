import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  subagentStopRequest,
  type SubagentStopAction,
} from "@ryco/client-runtime/state/session/subagentStop";
import { ORCHESTRATION_WS_METHODS, type ScopedThreadRef } from "@ryco/contracts";
import { useMemo } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { readHostedRpcCapability } from "~/hostedHub/capabilities";
import { useHostedHubStore } from "~/hostedHub/state";
import { hostedSwitchTargetLabel } from "~/hostedHub/switchTarget";
import { subagentStopRefusal } from "./agentStop.logic";
import { useSubagentActionAvailability } from "./useSubagentActionAvailability";

const STOP_METHOD = ORCHESTRATION_WS_METHODS.stopBackgroundTask;

/**
 * Stop for the native agents of one thread, or null without a thread or when
 * the user's role on its node may not stop them.
 *
 * It is gated on the exact method it sends, so the hosted lifecycle owner
 * decides when it may run, and re-reads that answer at click time so a stale
 * render cannot get past it. It only ever stops the one task: it never falls
 * back to interrupting the turn. The action keeps its identity while nothing
 * it reports changes, so rows that receive it do not re-render.
 */
export function useSubagentStopAction(
  threadRef: ScopedThreadRef | null,
): SubagentStopAction | null {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const { hidden, unavailableReason, runtimeSessionId } = useSubagentActionAvailability(
    threadRef,
    STOP_METHOD,
  );

  return useMemo<SubagentStopAction | null>(() => {
    if (environmentId === null || threadId === null || hidden) return null;
    return {
      threadRef: scopeThreadRef(environmentId, threadId),
      runtimeSessionId,
      unavailableReason,
      stop: async (identity) => {
        const refusal = subagentStopRefusal(
          readHostedRpcCapability(STOP_METHOD, environmentId),
          hostedSwitchTargetLabel(useHostedHubStore.getState(), environmentId),
        );
        if (refusal !== null) throw new Error(refusal);
        const stopTask = readEnvironmentApi(environmentId)?.orchestration.stopBackgroundTask;
        if (!stopTask) throw new Error("This environment can't stop agents.");
        await stopTask(subagentStopRequest(threadId, identity));
      },
    };
  }, [environmentId, hidden, runtimeSessionId, threadId, unavailableReason]);
}
