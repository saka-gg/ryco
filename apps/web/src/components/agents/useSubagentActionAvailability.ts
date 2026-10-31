import type { ScopedThreadRef } from "@ryco/contracts";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useHostedHubStore } from "~/hostedHub/state";
import { hostedSwitchTargetLabel } from "~/hostedHub/switchTarget";
import { useWsConnectionStatusForEnvironment } from "~/rpc/wsConnectionState";
import { selectEnvironmentState, useStore } from "~/store";
import { isEnvironmentReachable, resolveSubagentStopAvailability } from "./agentStop.logic";

/**
 * Whether one thread's agents may be sent `method` (Stop, a message): hidden when the user's
 * role on the node never allows it, otherwise why it can't be used yet. Gated on the exact
 * method, so the hosted lifecycle owner decides when it may run.
 */
export function useSubagentActionAvailability(
  threadRef: ScopedThreadRef | null,
  method: string,
  refusedReason?: string,
): {
  readonly hidden: boolean;
  readonly unavailableReason: string | null;
  readonly runtimeSessionId: string | null;
} {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const capability = useHostedRpcCapability(method, environmentId);
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
    ...(refusedReason === undefined ? {} : { refusedReason }),
  });
  return availability === "hidden"
    ? { hidden: true, unavailableReason: null, runtimeSessionId }
    : { hidden: false, unavailableReason: availability.unavailableReason, runtimeSessionId };
}
