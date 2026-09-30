import type { WorktreeSubmoduleInitialization } from "@ryco/contracts";
import { toastManager } from "../ui/toast";

/** Use the server's actual setup outcome, including its skip reason. */
export function notifyWorktreeSubmoduleSetup(
  outcome: WorktreeSubmoduleInitialization | undefined,
): void {
  if (outcome?.status === "skipped" && outcome.mode === "none") {
    toastManager.add({ type: "info", title: "Worktree created", description: outcome.reason });
  }
}
