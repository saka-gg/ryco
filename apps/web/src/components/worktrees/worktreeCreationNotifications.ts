import type { WorktreeSubmoduleInitialization } from "@ryco/contracts";
import { worktreeSubmoduleSetupNotice } from "@ryco/shared/worktreeSubmodules";
import { toastManager } from "../ui/toast";

/** Use the server's actual setup outcome, including its skip reason (the notice forks show too). */
export function notifyWorktreeSubmoduleSetup(
  outcome: WorktreeSubmoduleInitialization | undefined,
): void {
  const notice = worktreeSubmoduleSetupNotice(outcome);
  if (notice !== null) {
    toastManager.add({ type: "info", title: "Worktree created", description: notice });
  }
}
