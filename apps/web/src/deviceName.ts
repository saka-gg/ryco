import type { EnvironmentId } from "@ryco/contracts";
import { usePrimaryEnvironmentDescriptor } from "./environments/primary";
import { useDesktopWorkspaceState } from "./platform/desktopWorkspace";
import { useHostedHubStore } from "./hostedHub/state";
import { isElectron } from "./env";

import { resolveDeviceName } from "./deviceName.logic";

export function useDeviceName(
  environmentId?: EnvironmentId | null,
  fallback?: string | null,
): string {
  const primary = usePrimaryEnvironmentDescriptor();
  const desktop = useDesktopWorkspaceState();
  const nodes = useHostedHubStore((state) => state.nodes);
  const id = environmentId === undefined ? (primary?.environmentId ?? null) : environmentId;
  return resolveDeviceName({
    environmentId: id,
    primaryEnvironmentId: primary?.environmentId ?? null,
    localHubEnvironmentId: isElectron ? desktop.localEnvironmentId : null,
    machines: isElectron ? desktop.machines : nodes,
    fallback: fallback ?? (id === primary?.environmentId ? primary.label : null),
  });
}

export function useAppPreferencesLabel(): string {
  const name = useDeviceName();
  return isElectron ? `Ryco on ${name}` : "Ryco Web · current browser";
}
