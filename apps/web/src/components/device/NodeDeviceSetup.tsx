import { nodeDeviceSettingsGate } from "@ryco/client-runtime/state/device/picker";
import type { DeviceListResult, EnvironmentId } from "@ryco/contracts";
import { useState, type ReactNode } from "react";

import { useEnvironmentSettingsTarget } from "../../hooks/useEnvironmentSettingsTarget";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  SettingsEditingScopeProvider,
  SettingsTargetProvider,
  type SettingsTarget,
} from "../../settingsTarget";
import { Button } from "../ui/button";
import { DeviceSetupWizard } from "./DeviceSetupWizard";

/*
 * The device panel's view of the node's device settings: whether first-run
 * setup is due and whether simulators are off. Reads and writes go to the
 * panel's own node, as the settings page's do, and only an owner (with a
 * mutation-ready connection, on the Hub) can change them.
 */

export interface NodeDeviceSettingsState {
  readonly target: SettingsTarget | null;
  readonly canManage: boolean;
  /** The node supports setup and it is neither done nor skipped. */
  readonly showSetup: boolean;
  /** Setup is done and Use simulators is off. */
  readonly devicesOff: boolean;
  /** Set for this session once setup ends here, before the node's answer arrives. */
  readonly dismiss: () => void;
}

export function useNodeDeviceSettings(
  environmentId: EnvironmentId | null,
): NodeDeviceSettingsState {
  const { target } = useEnvironmentSettingsTarget(environmentId);
  const [dismissed, setDismissed] = useState(false);
  const { showSetup, devicesOff } = nodeDeviceSettingsGate(target?.serverConfig, dismissed);
  return {
    target,
    canManage: target?.canManage === true,
    showSetup,
    devicesOff,
    dismiss: () => setDismissed(true),
  };
}

function NodeSettingsScope(props: {
  readonly target: SettingsTarget | null;
  readonly children: ReactNode;
}) {
  return (
    <SettingsEditingScopeProvider value="node">
      <SettingsTargetProvider value={props.target}>{props.children}</SettingsTargetProvider>
    </SettingsEditingScopeProvider>
  );
}

export function NodeDeviceSetup(props: {
  readonly state: NodeDeviceSettingsState;
  readonly list: () => Promise<DeviceListResult>;
}) {
  return (
    <NodeSettingsScope target={props.state.target}>
      <SetupWithSettings state={props.state} list={props.list} />
    </NodeSettingsScope>
  );
}

function SetupWithSettings(props: {
  readonly state: NodeDeviceSettingsState;
  readonly list: () => Promise<DeviceListResult>;
}) {
  const devicesEnabled = useSettings((settings) => settings.devicesEnabled);
  const agentDevicesEnabled = useSettings((settings) => settings.agentDevicesEnabled);
  const { updateSettings } = useUpdateSettings();
  return (
    <DeviceSetupWizard
      values={{ devicesEnabled, agentDevicesEnabled }}
      canManage={props.state.canManage}
      list={props.list}
      update={(patch) => updateSettings(patch)}
      onComplete={() => {
        updateSettings({ deviceOnboardingCompleted: true });
        props.state.dismiss();
      }}
    />
  );
}

/** Turns Use simulators back on from the panel. */
export function TurnOnDevicesButton(props: { readonly state: NodeDeviceSettingsState }) {
  return (
    <NodeSettingsScope target={props.state.target}>
      <TurnOn />
    </NodeSettingsScope>
  );
}

function TurnOn() {
  const { updateSettings } = useUpdateSettings();
  return (
    <Button size="sm" onClick={() => updateSettings({ devicesEnabled: true })}>
      Turn on
    </Button>
  );
}
