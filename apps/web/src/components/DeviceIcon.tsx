import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import type { EnvironmentId } from "@ryco/contracts";

import {
  resolveEnvironmentMachineKind,
  inferEnvironmentMachineKind,
} from "@ryco/shared/environmentIcon";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useHostedHubStore } from "../hostedHub/state";
import { useServerConfig } from "../rpc/serverState";
import { isElectron } from "../env";

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
  const primaryConfig = useServerConfig();
  const id =
    isElectron && environmentId === desktop.localEnvironmentId
      ? primary?.environmentId
      : (environmentId ?? primary?.environmentId);
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    id ? state.byId[id]?.serverConfig : undefined,
  );
  const node = useHostedHubStore((state) =>
    state.nodes.find((node) => node.environmentId === environmentId),
  );
  const config = id === primary?.environmentId ? primaryConfig : saved;
  const kind = config
    ? resolveEnvironmentMachineKind(config)
    : inferEnvironmentMachineKind(platformOs ?? node?.platformOs, label ?? node?.label);
  return <EnvironmentMachineIcon kind={kind} className={className} />;
}
