import {
  selectServerFollowUpQueueSupported,
  type QueueEnvironmentReadiness,
} from "@ryco/client-runtime/state/message-queue";
import {
  appAtomRegistry,
  getWsConnectionStatusForEnvironment,
  getWsConnectionUiState,
  serverConfigAtom,
  subscribeEnvironmentServerConfigs,
  wsConnectionOpenedCountAtom,
  wsConnectionStatusAtom,
} from "@ryco/client-runtime/rpc";
import { ORCHESTRATION_WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { isHostedHubMode } from "./env";
import { readEnvironmentApi } from "./environmentApi";
import {
  getSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./environments/runtime";
import { readHostedRpcCapability } from "./hostedHub/capabilities";
import { readNodeServerConfig } from "./environments/nodeServerConfig";
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
  // Present only for a node that keeps follow-up queues itself.
  const serverQueue = readServerFollowUpQueueSupported(environmentId)
    ? ({ serverQueue: true } as const)
    : {};
  if (!shellLive) return { shellLive, mutationReady: false, ...serverQueue };
  if (readEnvironmentApi(environmentId) === undefined) {
    return { shellLive, mutationReady: false, ...serverQueue };
  }
  if (isHostedHubMode()) {
    return { shellLive, mutationReady: hostedMutationReady(environmentId), ...serverQueue };
  }
  const socketConnected =
    getWsConnectionUiState(getWsConnectionStatusForEnvironment(environmentId)) === "connected";
  const savedEnvironmentConnected =
    getSavedEnvironmentRecord(environmentId) === null ||
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectionState === "connected";
  return {
    shellLive,
    mutationReady: socketConnected && savedEnvironmentConnected,
    ...serverQueue,
  };
}

/**
 * Whether the node behind `environmentId` keeps follow-up queues itself
 * (`capabilities.serverFollowUpQueue`), from its own last known config. False
 * while unknown: this tab's own queue serves until the node says otherwise.
 */
export function readServerFollowUpQueueSupported(environmentId: EnvironmentId): boolean {
  return selectServerFollowUpQueueSupported(readNodeServerConfig(environmentId));
}

function subscribeServerFollowUpQueueSupport(listener: () => void): () => void {
  const unsubscribers = [
    subscribeEnvironmentServerConfigs(listener),
    useSavedEnvironmentRuntimeStore.subscribe(listener),
    appAtomRegistry.subscribe(serverConfigAtom, listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

/** {@link readServerFollowUpQueueSupported}, re-rendering when the node's config changes. */
export function useServerFollowUpQueueSupported(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const read = () => (environmentId ? readServerFollowUpQueueSupported(environmentId) : false);
  return useSyncExternalStore(subscribeServerFollowUpQueueSupport, read, read);
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
    // A node that starts (or stops) keeping follow-up queues itself.
    subscribeEnvironmentServerConfigs(listener),
    appAtomRegistry.subscribe(serverConfigAtom, listener),
  ];
  if (isHostedHubMode()) unsubscribers.push(getHostedEnvironmentSessions().subscribe(listener));
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
