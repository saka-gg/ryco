import type { DeviceDescriptor, DeviceHostSummary, DevicePlatform } from "@ryco/contracts";

/*
 * How the device picker groups and orders devices: one group per platform,
 * split per host once SSH hosts are in play, running devices first.
 */

export interface DevicePickerGroup {
  readonly key: string;
  readonly label: string;
  readonly devices: readonly DeviceDescriptor[];
}

const PLATFORM_LABELS: Record<DevicePlatform, string> = {
  "ios-simulator": "iOS Simulators",
  "android-emulator": "Android Emulators",
};

const PLATFORM_ORDER: readonly DevicePlatform[] = ["ios-simulator", "android-emulator"];

export type DevicePickerStatus = "running" | "starting" | "stopping" | "stopped";

export function devicePickerStatus(
  device: DeviceDescriptor,
  starting: ReadonlySet<string> = new Set(),
): DevicePickerStatus {
  if (device.state === "booting" || starting.has(device.udid)) return "starting";
  if (device.state === "booted") return "running";
  if (device.state === "shutting-down") return "stopping";
  return "stopped";
}

const STATUS_RANK: Record<DevicePickerStatus, number> = {
  running: 0,
  starting: 1,
  stopping: 2,
  stopped: 3,
};

export function groupPickerDevices(
  devices: readonly DeviceDescriptor[],
  options: {
    readonly hosts?: readonly DeviceHostSummary[] | undefined;
    readonly starting?: ReadonlySet<string>;
  } = {},
): readonly DevicePickerGroup[] {
  const byHost = (options.hosts ?? []).some((host) => host.transport === "ssh");
  const groups = new Map<string, { label: string; rank: number; devices: DeviceDescriptor[] }>();
  for (const device of devices) {
    const platformRank = PLATFORM_ORDER.indexOf(device.platform);
    const host = byHost ? device.host : undefined;
    const key = host ? `${host.id}:${device.platform}` : device.platform;
    let group = groups.get(key);
    if (!group) {
      const platform = PLATFORM_LABELS[device.platform];
      group = {
        label: host ? `${platform} · ${host.name}` : platform,
        // Local devices before remote ones, then platforms in a fixed order.
        rank: (host && host.transport === "ssh" ? 10 : 0) + platformRank,
        devices: [],
      };
      groups.set(key, group);
    }
    group.devices.push(device);
  }
  return [...groups.entries()]
    .toSorted(
      ([, left], [, right]) => left.rank - right.rank || left.label.localeCompare(right.label),
    )
    .map(([key, group]) => ({
      key,
      label: group.label,
      devices: group.devices.toSorted(
        (left, right) =>
          STATUS_RANK[devicePickerStatus(left, options.starting)] -
            STATUS_RANK[devicePickerStatus(right, options.starting)] ||
          left.name.localeCompare(right.name) ||
          left.runtime.localeCompare(right.runtime),
      ),
    }));
}

/** "Starting iPhone 17 Pro…" for one device, a count for several. */
export function startingBannerText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `Starting ${names[0]}… this can take a minute.`;
  return `Starting ${names.length} devices… this can take a minute.`;
}
