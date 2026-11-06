import type { EnvironmentId } from "@ryco/contracts";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";

/**
 * The environment the desktop app runs on this Mac: the only one Computer Use can drive.
 * Remote, hosted and mobile environments never get local desktop control.
 */
export function useLocalComputerEnvironmentId(): EnvironmentId | null {
  const desktopWorkspace = useDesktopWorkspaceState();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return (
    desktopWorkspace.localEnvironmentId ??
    (readPrimaryEnvironmentTarget()?.source === "desktop-managed" ? primaryEnvironmentId : null)
  );
}
