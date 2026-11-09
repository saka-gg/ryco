// FILE: outcome.ts
// Purpose: How a finished workspace lifecycle run reads back: whether it
//          recreated the checkout, and the heading of a run that did not
//          complete. Kept out of the lifecycle index, which the web's boot
//          path imports, so these stay with the screens that show results.
// Layer: Client runtime, pure.

import type { WorkspaceLifecycleOutcome, WorkspaceLifecycleResult } from "@ryco/contracts";

import { WORKSPACE_LIFECYCLE_ACTION_LABELS, type WorkspaceActionId } from "./index.ts";

/** Whether a run recreated the workspace's checkout (Restore does when it was removed). */
export const recreatedCheckout = (result: WorkspaceLifecycleResult): boolean =>
  result.steps.some((step) => step.id === "recreate-checkout" && step.status === "done");

/** The heading of a run that did not complete: "… partly completed" or "… did not run". */
export function workspaceLifecycleIncompleteTitle(
  action: WorkspaceActionId,
  outcome: Exclude<WorkspaceLifecycleOutcome, "completed">,
): string {
  const label = WORKSPACE_LIFECYCLE_ACTION_LABELS[action];
  return outcome === "partial" ? `${label} partly completed` : `${label} did not run`;
}
