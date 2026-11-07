/**
 * Whether agents may use this node's simulators and emulators: the `devicesEnabled` ("Use
 * simulators") and `agentDevicesEnabled` ("Agents can use simulators") settings as the device
 * tool gateway reads them, synchronously.
 *
 * `DeviceToolAccessLive` (device/Layers/DeviceToolAccess.ts) keeps this snapshot in step with
 * the settings file. Until it has read them the defaults (both on) apply, which is what a node
 * without the settings does too.
 *
 * Read twice: when a provider session starts (off: the session gets no device tools at all,
 * so it pays nothing for them) and at each call (turned off since: the call is refused). A
 * session started while access was off keeps no tools until a new session starts.
 *
 * @module providerTools/deviceToolAccess
 */

export interface DeviceToolAccess {
  readonly devicesEnabled: boolean;
  readonly agentDevicesEnabled: boolean;
}

export const DEFAULT_DEVICE_TOOL_ACCESS: DeviceToolAccess = {
  devicesEnabled: true,
  agentDevicesEnabled: true,
};

let current: DeviceToolAccess = DEFAULT_DEVICE_TOOL_ACCESS;

export function setDeviceToolAccess(access: DeviceToolAccess): void {
  current = {
    devicesEnabled: access.devicesEnabled,
    agentDevicesEnabled: access.agentDevicesEnabled,
  };
}

export function deviceToolAccess(): DeviceToolAccess {
  return current;
}

export const DEVICES_OFF_TEXT =
  "Simulators are turned off on this Ryco node (Settings, this device's Simulators tab, Use simulators). Tell the user what you wanted to check on a device and that it needs this setting; do not drive a simulator another way (simctl, adb, idb, AppleScript).";

export const AGENT_DEVICES_OFF_TEXT =
  "The user has not allowed agents to use simulators on this Ryco node (Settings, this device's Simulators tab, Agents can use simulators). Tell the user what you wanted to check on a device and that it needs this setting; do not drive a simulator another way (simctl, adb, idb, AppleScript).";

/** Why agents may not use devices right now, or null when they may. */
export function agentDeviceRefusal(access: DeviceToolAccess = current): string | null {
  if (!access.devicesEnabled) return DEVICES_OFF_TEXT;
  if (!access.agentDevicesEnabled) return AGENT_DEVICES_OFF_TEXT;
  return null;
}
