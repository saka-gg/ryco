import type { EnvironmentId } from "@ryco/contracts";
import { useParams } from "@tanstack/react-router";

import { isElectron, isHostedHubMode } from "../env";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { resolveSettingsTargetEnvironmentId } from "../settingsTarget";
import { useStore } from "../store";
import { resolveThreadRouteRef } from "../threadRoutes";
import {
  useEnvironmentSettingsTarget,
  type EnvironmentSettingsTargetState,
} from "./useEnvironmentSettingsTarget";

export interface SettingsPageTargetState extends EnvironmentSettingsTargetState {
  readonly environmentId: EnvironmentId | null;
}

/**
 * The device whose settings the settings page shows. Hosted settings edit the
 * selected node; elsewhere it is the requested environment, else the routed
 * thread's (which `SettingsRouteBridge` hands over as the request when settings
 * open), else the active one, else the primary. The command palette resolves
 * its Settings results against the same device as the page.
 */
export function useSettingsPageTarget(): SettingsPageTargetState {
  const requestedEnvironmentId = useSettingsDialogStore((state) => state.targetEnvironmentId);
  const routedEnvironmentId = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params)?.environmentId ?? null,
  });
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopLocalEnvironmentId = useDesktopWorkspaceState().localEnvironmentId;
  const environmentId = isHostedHubMode()
    ? primaryEnvironmentId
    : resolveSettingsTargetEnvironmentId({
        requestedEnvironmentId,
        routedEnvironmentId,
        activeEnvironmentId,
        primaryEnvironmentId,
        desktopLocalEnvironmentId: isElectron ? desktopLocalEnvironmentId : null,
      });
  return { environmentId, ...useEnvironmentSettingsTarget(environmentId) };
}
