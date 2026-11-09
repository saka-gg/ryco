// Jira work item states in the words every client shows.
import type { WorkItemState } from "@ryco/contracts";

export function normalizedWorkItemStateLabel(state: WorkItemState): string {
  switch (state) {
    case "open":
      return "Open";
    case "in_progress":
      return "In progress";
    case "done":
      return "Done";
    case "closed":
      return "Closed";
    case "unknown":
      return "Unknown";
  }
}

export function workItemStateLabel(input: {
  readonly state: WorkItemState;
  readonly stateName?: string | null | undefined;
}): string {
  return input.stateName?.trim() || normalizedWorkItemStateLabel(input.state);
}
