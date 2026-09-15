import type {
  AutomationCentreApi,
  AutomationCentreSnapshot,
  ProjectId,
  AgentControlAutomationRunStatus,
} from "@ryco/contracts";

export const automationRunStatusLabel: Record<AgentControlAutomationRunStatus, string> = {
  materializing: "Preparing approval",
  "pending-approval": "Awaiting approval",
  approved: "Approved",
  executing: "Dispatching",
  completed: "Dispatched",
  failed: "Dispatch failed",
  rejected: "Rejected",
  expired: "Approval expired",
  cancelled: "Cancelled",
};
export type AutomationRunFilter = "all" | "unread" | "failed";
export function filterAutomationRuns(
  snapshot: AutomationCentreSnapshot,
  filter: AutomationRunFilter,
) {
  return snapshot.runs.filter((entry) =>
    filter === "unread" ? entry.unread : filter === "failed" ? entry.run.status === "failed" : true,
  );
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
