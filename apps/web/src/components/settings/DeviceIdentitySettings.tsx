import { useState } from "react";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import { useHostedHubStore, hostedHubController } from "../../hostedHub/state";
import { hostedHubApi } from "../../hostedHub/api";
import { useSettingsTarget } from "../../settingsTarget";
import { isElectron, isHostedHubMode } from "../../env";
import { HostedNodeRenameDialog } from "../hostedHub/HostedNodeRenameDialog";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The Hub owns custom names; direct and relay connections retain their stable IDs. */
export function DeviceIdentitySettings() {
  const target = useSettingsTarget();
  const primary = usePrimaryEnvironmentDescriptor();
  const workspace = useDesktopWorkspaceState();
  const nodes = useHostedHubStore((state) => state.nodes);
  const [renaming, setRenaming] = useState(false);
  if (!target) return null;
  const catalogId =
    isElectron && target.environmentId === primary?.environmentId
      ? workspace.localEnvironmentId
      : target.environmentId;
  const desktopMachine = workspace.machines.find((machine) => machine.environmentId === catalogId);
  const hostedNode = nodes.find((node) => node.environmentId === catalogId);
  const canRename = isElectron
    ? desktopMachine?.canRename === true &&
      Boolean(window.desktopBridge?.renameDesktopWorkspaceDevice)
    : isHostedHubMode() && hostedNode?.effectiveRole === "owner" && hostedNode.revokedAt === null;
  const rename = async (label: string) => {
    if (isElectron && desktopMachine && window.desktopBridge?.renameDesktopWorkspaceDevice) {
      await window.desktopBridge.renameDesktopWorkspaceDevice({
        environmentId: desktopMachine.environmentId,
        label,
      });
    } else if (isHostedHubMode() && hostedNode) {
      await hostedHubApi.renameNode(hostedNode.id, label);
      await hostedHubController.refreshDirectory();
    } else {
      throw new Error("Connect this device to your Hub to customize its name.");
    }
  };
  return (
    <SettingsSection title="Device" owner="node" className="mx-6 mt-5 mb-3">
      <SettingsRow
        title="Device name"
        scope={target.nodeLabel}
        description="Shown to everyone who can access this device. Renaming keeps its projects, conversations, and connections."
        control={
          canRename ? (
            <Button variant="outline" onClick={() => setRenaming(true)}>
              Rename device
            </Button>
          ) : undefined
        }
        status={
          !canRename ? (
            <span>
              {catalogId && (desktopMachine || hostedNode)
                ? "Only the device owner can change its name."
                : "Connect to your Hub to customize the device name."}
            </span>
          ) : undefined
        }
      />
      {canRename && (
        <HostedNodeRenameDialog
          key={target.environmentId}
          node={{ label: target.nodeLabel }}
          open={renaming}
          onOpenChange={setRenaming}
          onRename={rename}
        />
      )}
    </SettingsSection>
  );
}
