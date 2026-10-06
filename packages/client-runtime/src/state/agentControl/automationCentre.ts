import type {
  AgentControlAutomationRunStatus,
  AgentControlProposal,
  AutomationCentreApi,
  AutomationCentreSnapshot,
  ProjectId,
} from "@ryco/contracts";
import { Record as Records } from "effect";

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

/** Single-flight refresh with a trailing read, and no publications after disposal/rebind. */
export function createAutomationCentreReader(input: {
  api: AutomationCentreApi;
  projectId: ProjectId;
  onSnapshot: (snapshot: AutomationCentreSnapshot) => void;
  onError: () => void;
}) {
  let stopped = false;
  let generation = 0;
  let running = false;
  let pending = false;
  const refresh = async () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    do {
      pending = false;
      const epoch = generation;
      try {
        const snapshot = await input.api.snapshot({ projectId: input.projectId });
        if (!stopped && epoch === generation) input.onSnapshot(snapshot);
      } catch {
        if (!stopped && epoch === generation) input.onError();
      }
      if (stopped) break;
    } while (pending);
    running = false;
  };
  return {
    refresh,
    invalidate: () => {
      generation++;
      pending = false;
    },
    stop: () => {
      stopped = true;
    },
  };
}
