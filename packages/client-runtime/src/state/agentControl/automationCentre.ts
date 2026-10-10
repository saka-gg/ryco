import type {
  AgentControlAutomationRunStatus,
  AgentControlProposal,
  AutomationCentreApi,
  AutomationCentreSnapshot,
  ProjectId,
} from "@ryco/contracts";
import { Record as Records } from "effect";

import { createSingleFlightReader, type SingleFlightReader } from "../singleFlightReader.ts";
import { AUTOMATION_RUN_STATUS } from "./automationSchedules.ts";

/** One run vocabulary app-wide: the labels of `AUTOMATION_RUN_STATUS`. */
export const automationRunStatusLabel: Readonly<Record<AgentControlAutomationRunStatus, string>> =
  Records.map(AUTOMATION_RUN_STATUS, (status) => status.label);

/**
 * A run waiting for the user, as a device's Agent Control queue holds it: an
 * automation run whose approval is still pending. It is the same run a
 * checkout's snapshot says is "pending-approval" (`dueScheduleRuns`); the
 * queue is what every project on the device shares, so counts across
 * projects (the sidebar's badge) read it from here.
 */
export function isWaitingAutomationRun(proposal: AgentControlProposal): boolean {
  return proposal.status === "pending-user-approval" && proposal.plan.kind === "automationRun";
}

/** Runs waiting for approval in the given environments' queues. */
export function waitingAutomationRunCount(
  queues: Readonly<
    Record<string, { readonly proposalsById: Readonly<Record<string, AgentControlProposal>> }>
  >,
  environmentIds: readonly string[],
): number {
  let count = 0;
  for (const environmentId of environmentIds)
    for (const proposal of Object.values(queues[environmentId]?.proposalsById ?? {}))
      if (isWaitingAutomationRun(proposal)) count += 1;
  return count;
}

/** The checkout's automation snapshot through the shared single-flight reader. */
export function createAutomationCentreReader(input: {
  api: AutomationCentreApi;
  projectId: ProjectId;
  onSnapshot: (snapshot: AutomationCentreSnapshot) => void;
  onError: () => void;
}): SingleFlightReader {
  return createSingleFlightReader({
    read: () => input.api.snapshot({ projectId: input.projectId }),
    onValue: input.onSnapshot,
    onError: () => input.onError(),
  });
}
