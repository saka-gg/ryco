import type { DesktopKeepAwakeMode, DesktopKeepAwakeState } from "@ryco/contracts";

import { isMacPlatform } from "../../lib/utils";

/** "this Mac" on macOS, "this computer" everywhere else. */
export function desktopDeviceNoun(platform: string): string {
  return isMacPlatform(platform) ? "this Mac" : "this computer";
}

/**
 * The row's element id: the settings search result jumps to it, because the row's title names
 * the device ("this Mac") and so never equals the search entry's title.
 */
export const DESKTOP_KEEP_AWAKE_ROW_ID = "desktop-keep-awake";

export const DESKTOP_KEEP_AWAKE_MODE_OPTIONS: ReadonlyArray<{
  readonly value: DesktopKeepAwakeMode;
  readonly label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "reachable", label: "While reachable" },
  { value: "reachable-or-working", label: "While reachable or agents work" },
];

/** One sentence for the keep-awake row: what Ryco is doing right now, and why. */
export function describeDesktopKeepAwake(
  state: DesktopKeepAwakeState | null,
  device: string,
): string {
  if (state === null) return "Loading…";
  if (state.mode === "off") {
    return `${capitalize(device)} may sleep when idle. Running chats pause and devices that reach it lose access until it wakes.`;
  }
  const wanted = state.reachable || (state.mode === "reachable-or-working" && state.agentWorking);
  if (!wanted) {
    return state.mode === "reachable-or-working"
      ? `Turns on while agents work, or once other devices can reach ${device} through the Hub, the network, or Tailscale.`
      : `Turns on once other devices can reach ${device} through the Hub, the network, or Tailscale.`;
  }
  if (state.onBattery) {
    return `Paused on battery power. Ryco keeps ${device} awake again when it is plugged in.`;
  }
  if (state.active && state.reachable) {
    return `Ryco keeps ${device} awake so other devices can reach it. The display can still sleep.`;
  }
  if (state.active) {
    return `Ryco keeps ${device} awake while agents work. The display can still sleep.`;
  }
  return `Ryco keeps ${device} awake while it is plugged in.`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
