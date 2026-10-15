/**
 * Runs waiting for approval across every connected device: the sidebar's
 * Automations badge. Each connected environment's Agent Control queue is
 * kept live (one shared subscription per environment, see
 * `useAutomationProposalSync`); what counts as a waiting run is the shared
 * model's (`waitingAutomationRunCount`).
 */
import {
  useAgentControlStore,
  waitingAutomationRunCount,
} from "@ryco/client-runtime/state/agentControl";

import { useAgentControlSyncEnvironmentIds } from "../agent-control/agentControlSyncGate";
import { useAutomationProposalSync } from "./data/useAutomationProposalSync";
import { useConnectedEnvironmentIds } from "./data/useConnectedEnvironmentIds";

/** How many runs wait for approval on the devices this app is connected to. */
export function useWaitingAutomationRuns(): number {
  const environmentIds = useConnectedEnvironmentIds();
  // Devices whose own config says Agent Control is off hold no subscription:
  // the badge mounts on every route, and a refused one would also block
  // re-admission when the feature is turned on.
  useAutomationProposalSync(useAgentControlSyncEnvironmentIds(environmentIds));
  return useAgentControlStore((state) =>
    waitingAutomationRunCount(state.queueByEnvironmentId, environmentIds),
  );
}
