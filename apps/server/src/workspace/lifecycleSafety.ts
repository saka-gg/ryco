import type { OrchestrationShellSnapshot } from "@ryco/contracts";

/** Shared by human storage management and Agent Control lifecycle preflight. */
export const workspaceSessionActive = (thread: OrchestrationShellSnapshot["threads"][number]) =>
  thread.session?.status === "running" ||
  thread.session?.status === "starting" ||
  thread.session?.activeTurnId != null ||
  Boolean(thread.backgroundLiveness) ||
  thread.latestTurn?.state === "running";
