/**
 * What every client's device picker decides, with no UI: how the node's simulators and
 * emulators group and order (one group per platform, split per host once SSH hosts are in play,
 * running devices first), what each one is doing, which devices a thread has attached, whether
 * the node's setup still blocks the picker, and what one platform's availability says.
 *
 * The web panel (`SimulatorPanel`, `DevicePicker`, `DeviceSetupWizard`) and the phone's
 * Devices sheet both read these, so the two never disagree about what a device is doing or
 * when setup is due.
 *
 * @module state/device/picker
 */
import type {
  DeviceAvailability,
  DeviceBootResult,
  DeviceDescriptor,
  DeviceHostSummary,
  DevicePlatform,
  DeviceUdid,
  ServerConfig,
  ThreadDeviceAttachment,
  ThreadDeviceState,
  ThreadId,
} from "@ryco/contracts";

export { threadAttachments } from "./threadAttachments.ts";

export interface DevicePickerGroup {
  readonly key: string;
  readonly label: string;
  readonly devices: readonly DeviceDescriptor[];
}

const PLATFORM_GROUP_LABELS: Record<DevicePlatform, string> = {
  "ios-simulator": "iOS Simulators",
  "android-emulator": "Android Emulators",
};

/** One device's platform, singular: "iOS Simulator". */
export const DEVICE_PLATFORM_LABELS: Record<DevicePlatform, string> = {
  "ios-simulator": "iOS Simulator",
  "android-emulator": "Android Emulator",
};

const PLATFORM_ORDER: readonly DevicePlatform[] = ["ios-simulator", "android-emulator"];

export type DevicePickerStatus = "running" | "starting" | "stopping" | "stopped";

export const DEVICE_PICKER_STATUS_LABELS: Record<DevicePickerStatus, string> = {
  running: "Running",
  starting: "Starting",
  stopping: "Shutting down",
  stopped: "Stopped",
};

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
      const platform = PLATFORM_GROUP_LABELS[device.platform];
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

/**
 * Whether the node's availability keeps the picker from showing: not known yet, a platform
 * Ryco cannot run devices on, a helper that did not start, or setup steps left besides the
 * helper build (which happens by itself the first time a device opens).
 */
export function deviceSetupBlocked(availability: DeviceAvailability | null | undefined): boolean {
  return (
    !availability ||
    availability.kind === "unsupported-platform" ||
    availability.kind === "helper-unavailable" ||
    (availability.kind === "setup-required" &&
      availability.steps.some((step) => !step.done && step.id !== "build-device-helper"))
  );
}

/** A node's availability asks to be read again every few seconds until it settles. */
export function devicesNeedSetupPoll(availability: DeviceAvailability | null | undefined): boolean {
  return availability?.kind === "setup-required" || availability?.kind === "helper-unavailable";
}

/** How often a picker reads a node whose setup is still underway. */
export const DEVICE_SETUP_POLL_MS = 5_000;

export type DevicePlatformTone = "ready" | "warn" | "off";

/** One platform's answer in a line: ready, limited, what is missing, or not on this OS. */
export function devicePlatformSummary(availability: DeviceAvailability): {
  readonly tone: DevicePlatformTone;
  readonly summary: string;
} {
  switch (availability.kind) {
    case "available":
      return { tone: "ready", summary: "Ready" };
    case "degraded":
      return {
        tone: "warn",
        summary: `Ready, limited by this Xcode: ${availability.capabilities
          .filter((capability) => !capability.ok)
          .map((capability) => capability.id)
          .join(", ")}`,
      };
    case "setup-required": {
      const remaining = availability.steps.filter((step) => !step.done);
      // The helper builds itself the first time a device opens.
      const onlyHelper = remaining.every((step) => step.id === "build-device-helper");
      return onlyHelper
        ? {
            tone: "ready",
            summary: "Ready; the Ryco helper builds the first time you open a device",
          }
        : {
            tone: "warn",
            summary: `${remaining.length} step${remaining.length === 1 ? "" : "s"} left`,
          };
    }
    case "unsupported-platform":
      return { tone: "off", summary: `Not available on ${availability.platform}` };
    case "helper-unavailable":
      return { tone: "warn", summary: availability.message };
  }
}

/**
 * The node's device settings as a picker reads them: first-run setup is due (the node supports
 * it and it is neither done nor skipped, nor dismissed in this session), or setup is done and
 * Use simulators is off.
 */
export function nodeDeviceSettingsGate(
  config: Pick<ServerConfig, "environment" | "settings"> | null | undefined,
  dismissed = false,
): { readonly showSetup: boolean; readonly devicesOff: boolean } {
  const supported = config?.environment.capabilities.deviceSetup === true;
  const settings = config?.settings;
  const completed = dismissed || settings?.deviceOnboardingCompleted !== false;
  return {
    showSetup: supported && settings !== undefined && !completed,
    devicesOff: supported && completed && settings?.devicesEnabled === false,
  };
}

/** The device calls a picker makes, as both the typed facade and the RPC client offer them. */
export interface DevicePickerApi {
  readonly boot: (input: { udid: DeviceUdid; threadId?: ThreadId }) => Promise<DeviceBootResult>;
  readonly attach: (input: { threadId: ThreadId; udid: DeviceUdid }) => Promise<ThreadDeviceState>;
  readonly shutdown: (input: { udid: DeviceUdid }) => Promise<void>;
}

export type BootAttachOutcome =
  | { readonly kind: "attached"; readonly state: ThreadDeviceState }
  | {
      readonly kind: "boot-limit";
      readonly requested: DeviceDescriptor;
      readonly candidates: readonly DeviceDescriptor[];
      readonly limit: number;
    };

/**
 * Boot when needed, then attach as the person's choice, for the desktop panel and the phone sheet alike. A boot past
 * the node's limit on Ryco-booted devices is not an error; it names the devices one of which
 * must shut down first.
 */
export async function bootAndAttachDevice(
  api: Pick<DevicePickerApi, "boot" | "attach">,
  threadId: ThreadId,
  device: DeviceDescriptor,
): Promise<BootAttachOutcome> {
  if (device.state === "shutdown") {
    const result = await api.boot({ udid: device.udid, threadId });
    if (result.kind === "boot-limit-reached")
      return {
        kind: "boot-limit",
        requested: device,
        candidates: result.rycoBooted,
        limit: result.limit,
      };
  }
  return { kind: "attached", state: await api.attach({ threadId, udid: device.udid }) };
}

/** Free a slot by shutting one Ryco-booted device down, then start the one asked for. */
export async function freeSlotThenAttach(
  api: DevicePickerApi,
  threadId: ThreadId,
  candidate: DeviceDescriptor,
  requested: DeviceDescriptor,
): Promise<BootAttachOutcome> {
  await api.shutdown({ udid: candidate.udid });
  return bootAndAttachDevice(api, threadId, requested);
}
