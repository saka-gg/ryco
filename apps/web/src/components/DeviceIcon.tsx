import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

import {
  resolveEnvironmentMachineKind,
  inferEnvironmentMachineKind,
} from "@ryco/shared/environmentIcon";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useHostedHubStore } from "../hostedHub/state";
import { useServerConfigSelector } from "../rpc/serverState";
import { isElectron } from "../env";

// The machine kind is all an icon reads: provider and settings pushes keep it.
const selectMachineKind = (config: ServerConfig | null) =>
  config ? resolveEnvironmentMachineKind(config) : null;

/** Read existing snapshots only. Rendering an icon never connects or wakes a node. */
export function DeviceIcon({
  environmentId,
  label,
  platformOs,
  className,
}: {
  environmentId?: EnvironmentId | null;
  label?: string;
  platformOs?: string;
  className?: string | undefined;
}) {
  const primary = usePrimaryEnvironmentDescriptor();
  const desktop = useDesktopWorkspaceState();
  const primaryKind = useServerConfigSelector(selectMachineKind);
  const id =
    isElectron && environmentId === desktop.localEnvironmentId
      ? primary?.environmentId
      : (environmentId ?? primary?.environmentId);
  const savedKind = useSavedEnvironmentRuntimeStore((state) => {
    const config = id ? state.byId[id]?.serverConfig : undefined;
    return config ? resolveEnvironmentMachineKind(config) : null;
  });
  const node = useHostedHubStore((state) =>
    state.nodes.find((node) => node.environmentId === environmentId),
  );
  const configKind = id === primary?.environmentId ? primaryKind : savedKind;
  const kind =
    configKind ?? inferEnvironmentMachineKind(platformOs ?? node?.platformOs, label ?? node?.label);
  return <EnvironmentMachineIcon kind={kind} className={className} />;
}
