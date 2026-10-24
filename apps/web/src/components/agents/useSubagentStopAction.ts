import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SubagentStopAction } from "@ryco/client-runtime/state/session/subagentStop";
import { ORCHESTRATION_WS_METHODS, RuntimeSessionId, type ScopedThreadRef } from "@ryco/contracts";
import { useMemo } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { readHostedRpcCapability, useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useHostedHubStore } from "~/hostedHub/state";
import { hostedSwitchTargetLabel } from "~/hostedHub/switchTarget";
import { useWsConnectionStatusForEnvironment } from "~/rpc/wsConnectionState";
import { selectEnvironmentState, useStore } from "~/store";
import {
  isEnvironmentReachable,
  resolveSubagentStopAvailability,
  subagentStopRefusal,
} from "./agentStop.logic";

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
  const capability = useHostedRpcCapability(STOP_METHOD, environmentId);
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const wsPhase = useWsConnectionStatusForEnvironment(environmentId).phase;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironment = useSavedEnvironmentRegistryStore(
    (state) =>
      environmentId !== null &&
      environmentId !== primaryEnvironmentId &&
      state.byId[environmentId] !== undefined,
  );
  const savedConnectionState = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId]?.connectionState ?? null),
  );
  const runtimeSessionId = useStore((state) =>
    environmentId === null || threadId === null
      ? null
      : (selectEnvironmentState(state, environmentId).threadSessionById[threadId]
          ?.runtimeSessionId ?? null),
  );
  const availability = resolveSubagentStopAvailability({
    capability,
    nodeLabel,
    reachable: isEnvironmentReachable({ savedEnvironment, savedConnectionState, wsPhase }),
  });
  const hidden = availability === "hidden";
  const unavailableReason = hidden ? null : availability.unavailableReason;

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
        await stopTask({
          threadId,
          taskId: identity.taskId,
          expected: {
            runtimeSessionId: RuntimeSessionId.make(identity.runtimeSessionId),
            attempt: identity.attempt,
          },
        });
      },
    };
  }, [environmentId, hidden, runtimeSessionId, threadId, unavailableReason]);
}
