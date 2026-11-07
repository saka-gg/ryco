import type { EnvironmentId } from "@ryco/contracts";
import { useCallback } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";

export interface LocalComputerEnvironments {
  /** The direct connection to the backend the desktop app manages, when there is one. */
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** This Mac's entry in the Hub account catalog, which can carry a different id. */
  readonly hubEnvironmentId: EnvironmentId | null;
}

/**
 * The environment Computer Use talks to on this Mac. The direct desktop
 * connection wins: chats opened through it carry its id, and the Hub catalog
 * names the same machine under its own id.
 */
export function preferredLocalComputerEnvironmentId(
  local: LocalComputerEnvironments,
): EnvironmentId | null {
  return local.primaryEnvironmentId ?? local.hubEnvironmentId;
}

/** Whether an environment is this Mac, under either of its ids. */
export function isLocalComputerEnvironment(
  environmentId: EnvironmentId | null | undefined,
  local: LocalComputerEnvironments,
): boolean {
  if (!environmentId) return false;
  return environmentId === local.primaryEnvironmentId || environmentId === local.hubEnvironmentId;
}

function useLocalComputerEnvironments(): LocalComputerEnvironments {
  const desktopWorkspace = useDesktopWorkspaceState();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return {
    primaryEnvironmentId:
      readPrimaryEnvironmentTarget()?.source === "desktop-managed" ? primaryEnvironmentId : null,
    hubEnvironmentId: desktopWorkspace.localEnvironmentId,
  };
}

/**
 * The environment the desktop app runs on this Mac: the only one Computer Use can drive.
 * Remote, hosted and mobile environments never get local desktop control.
 */
export function useLocalComputerEnvironmentId(): EnvironmentId | null {
  return preferredLocalComputerEnvironmentId(useLocalComputerEnvironments());
}

/** Tells whether a chat's environment is this Mac, under its direct or its Hub id. */
export function useIsLocalComputerEnvironment(): (
  environmentId: EnvironmentId | null | undefined,
) => boolean {
  const { primaryEnvironmentId, hubEnvironmentId } = useLocalComputerEnvironments();
  return useCallback(
    (environmentId) =>
      isLocalComputerEnvironment(environmentId, { primaryEnvironmentId, hubEnvironmentId }),
    [primaryEnvironmentId, hubEnvironmentId],
  );
}
