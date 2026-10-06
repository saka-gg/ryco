/**
 * Runs waiting for approval across every connected device: the sidebar's
 * Automations badge. Each connected environment's Agent Control queue is
 * kept live (one shared subscription per environment, see
 * `useAutomationProposalSync`); what counts as a waiting run is the shared
 * model's (`waitingAutomationRunCount`).
 */
import type { EnvironmentId } from "@ryco/contracts";
import {
  useAgentControlStore,
  waitingAutomationRunCount,
} from "@ryco/client-runtime/state/agentControl";
import { useSyncExternalStore } from "react";

import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { proposalSyncKey, useAutomationProposalSync } from "./data/useAutomationProposalSync";

/* The connected environments, one array per distinct set, so a store
   snapshot keeps its identity until a connection comes or goes. */
let connected: { readonly key: string; readonly ids: readonly EnvironmentId[] } = {
  key: proposalSyncKey([]),
  ids: [],
};
function readConnectedEnvironments(): readonly EnvironmentId[] {
  const ids = [
    ...new Set(listEnvironmentConnections().map((connection) => connection.environmentId)),
  ].toSorted();
  const key = proposalSyncKey(ids);
  if (key !== connected.key) connected = { key, ids };
  return connected.ids;
}
const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];

/** How many runs wait for approval on the devices this app is connected to. */
export function useWaitingAutomationRuns(): number {
  const environmentIds = useSyncExternalStore(
    subscribeEnvironmentConnections,
    readConnectedEnvironments,
    () => NO_ENVIRONMENTS,
  );
  useAutomationProposalSync(environmentIds);
  return useAgentControlStore((state) =>
    waitingAutomationRunCount(state.queueByEnvironmentId, environmentIds),
  );
}
