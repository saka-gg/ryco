import type { QueueEnvironmentReadiness } from "@ryco/client-runtime/state/message-queue";
import {
  appAtomRegistry,
  getWsConnectionStatusForEnvironment,
  getWsConnectionUiState,
  wsConnectionOpenedCountAtom,
  wsConnectionStatusAtom,
} from "@ryco/client-runtime/rpc";
import { ORCHESTRATION_WS_METHODS, type EnvironmentId } from "@ryco/contracts";

import { isHostedHubMode } from "./env";
import { readEnvironmentApi } from "./environmentApi";
import {
  getSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./environments/runtime";
import { readHostedRpcCapability } from "./hostedHub/capabilities";
import { getHostedEnvironmentSessions, useHostedHubStore } from "./hostedHub/state";
import { selectEnvironmentShellLive, type AppState } from "@ryco/client-runtime/state/threads";
import { useStore } from "./store";

/**
 * Whether a hosted environment admits queued sends: the environment's own
 * session record decides, selected or not.
 */
function hostedMutationReady(environmentId: EnvironmentId): boolean {
  return readHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand, environmentId).allowed;
}

/**
 * Whether the queue drain may trust and mutate an environment. It only READS
 * readiness: it never creates hosted connection demand or selects a node, so a
 * queue on a hosted node whose session is not ready waits until it is. The
 * demand that connects such a node is the workspace coordinator's queued-send
 * scope, held while the queue has messages for one of the node's server
 * threads. A dropped socket makes the queue wait; it never fails the head.
 */
export function readWebQueueEnvironment(
  environmentId: EnvironmentId,
  state: AppState = useStore.getState(),
): QueueEnvironmentReadiness {
  const shellLive = selectEnvironmentShellLive(state, environmentId);
  if (!shellLive) return { shellLive, mutationReady: false };
  if (readEnvironmentApi(environmentId) === undefined) return { shellLive, mutationReady: false };
  if (isHostedHubMode()) return { shellLive, mutationReady: hostedMutationReady(environmentId) };
  const socketConnected =
    getWsConnectionUiState(getWsConnectionStatusForEnvironment(environmentId)) === "connected";
  const savedEnvironmentConnected =
    getSavedEnvironmentRecord(environmentId) === null ||
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectionState === "connected";
  return { shellLive, mutationReady: socketConnected && savedEnvironmentConnected };
}

/**
 * Readiness inputs that live outside the threads store. Each hosted
 * environment's readiness changes in the session registry, not in the hosted
 * store, so the registry wakes the drain too. Per-environment socket closes
 * without a global status change are covered by the coordinator's periodic
 * environment re-check.
 */
export function subscribeWebQueueEnvironmentReadiness(listener: () => void): () => void {
  const unsubscribers = [
    useHostedHubStore.subscribe(listener),
    useSavedEnvironmentRuntimeStore.subscribe(listener),
    useSavedEnvironmentRegistryStore.subscribe(listener),
    appAtomRegistry.subscribe(wsConnectionOpenedCountAtom, listener),
    appAtomRegistry.subscribe(wsConnectionStatusAtom, listener),
  ];
  if (isHostedHubMode()) unsubscribers.push(getHostedEnvironmentSessions().subscribe(listener));
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
