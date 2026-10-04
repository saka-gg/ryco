import type { DesktopKeepAwakeState } from "@ryco/contracts";

import { isMacPlatform } from "../../lib/utils";

/** "this Mac" on macOS, "this computer" everywhere else. */
export function desktopDeviceNoun(platform: string): string {
  return isMacPlatform(platform) ? "this Mac" : "this computer";
}

/** One sentence for the keep-awake row: what Ryco is doing right now, and why. */
export function describeDesktopKeepAwake(
  state: DesktopKeepAwakeState | null,
  device: string,
): string {
  if (state === null) return "Loading…";
  if (!state.enabled) {
    return `${capitalize(device)} may sleep when idle. Devices that reach it lose access until it wakes.`;
  }
  if (!state.reachable) {
    return `Turns on once other devices can reach ${device} through the Hub, the network, or Tailscale.`;
  }
  if (state.onBattery) {
    return `Paused on battery power. Ryco keeps ${device} awake again when it is plugged in.`;
  }
  return state.active
    ? `Ryco keeps ${device} awake so other devices can reach it. The display can still sleep.`
    : `Ryco keeps ${device} awake while it is plugged in and reachable.`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
