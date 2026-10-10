import type { WorkspaceState } from "../../state/workspaceModel";

export function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    (!state.hasLoadedShellSnapshot &&
      (state.hasConnectingEnvironment || state.hasPendingShellSnapshot)) ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

export function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
    return "Saved view · Machines unavailable";
  if (state.hasConnectingEnvironment) return "Loading workspace...";
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}
