/**
 * The phone's Devices sheet for a thread: the node's simulators and emulators grouped per
 * platform, which ones the thread has attached, what setup still asks for, and what Start,
 * Attach, Install, Launch and Record send. Grouping, status and the setup gate come from
 * `@ryco/client-runtime/state/device/picker`, which the web panel reads too; this module only
 * shapes them for the sheet and runs the same boot-then-attach sequence the web panel runs.
 * No React or React Native.
 *
 * @module devicePickerModel
 */
import {
  DEVICE_PICKER_STATUS_LABELS,
  DEVICE_PLATFORM_LABELS,
  deviceSetupBlocked,
  devicePickerStatus,
  devicePlatformSummary,
  groupPickerDevices,
  threadAttachments,
  type DevicePickerStatus,
  type DevicePlatformTone,
} from "@ryco/client-runtime/state/device/picker";
import type {
  DeviceAttachPhase,
  DeviceAvailability,
  DeviceBootResult,
  DeviceDescriptor,
  DeviceHostSummary,
  DeviceInstallAppInput,
  DeviceLaunchAppInput,
  DevicePlatform,
  DevicePlatformAvailability,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
  DeviceUdid,
  ThreadDeviceAttachment,
  ThreadDeviceState,
  ThreadId,
} from "@ryco/contracts";

import { errorMessageOr } from "../../lib/errorMessage";
// ── The device list ──────────────────────────────────────────────────

export type DeviceRowAction = "start" | "attach";

export interface DeviceListRow {
  readonly device: DeviceDescriptor;
  readonly status: DevicePickerStatus;
  /** "iOS 26.0 · Running · On this thread". */
  readonly detail: string;
  /** The thread has this device attached. */
  readonly attached: boolean;
  /** What a press does: boot and attach a stopped device, attach a running one. */
  readonly action: DeviceRowAction | null;
}

export interface DeviceListSection {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly DeviceListRow[];
}

/**
 * Every device the node can run, grouped as the web picker groups them (iOS, then Android,
 * per host once SSH hosts exist, running devices first), each with what a press does.
 */
export function deviceListSections(input: {
  readonly devices: readonly DeviceDescriptor[];
  readonly hosts?: readonly DeviceHostSummary[] | undefined;
  readonly threadState: ThreadDeviceState | null;
}): readonly DeviceListSection[] {
  const starting = new Set<string>(input.threadState?.startingDeviceUdids ?? []);
  const attachments = threadAttachments(input.threadState);
  return groupPickerDevices(input.devices, { hosts: input.hosts, starting }).map((group) => ({
    key: group.key,
    label: group.label,
    rows: group.devices.map((device) => {
      const status = devicePickerStatus(device, starting);
      const attachment = attachments.find((entry) => entry.udid === device.udid) ?? null;
      // A person's choice keeps the device: attaching one the agent picked makes it theirs.
      const attached = attachment !== null && attachment.source === "user";
      const parts = [device.runtime, DEVICE_PICKER_STATUS_LABELS[status]];
      if (attachment !== null)
        parts.push(attachment.source === "agent" ? "Agent's device" : "On this thread");
      return {
        device,
        status,
        detail: parts.join(" · "),
        attached: attachment !== null,
        action:
          status === "stopped"
            ? ("start" as const)
            : status === "running" && !attached
              ? ("attach" as const)
              : null,
      };
    }),
  }));
}

// ── The thread's devices ─────────────────────────────────────────────

const ATTACH_PHASE_TEXT: Record<DeviceAttachPhase, string> = {
  booting: "Starting up…",
  "waiting-for-display": "Waiting for the screen…",
  connecting: "Connecting…",
};

export interface AttachedDeviceCard {
  readonly udid: DeviceUdid;
  readonly name: string;
  readonly runtime: string | null;
  readonly platform: DevicePlatform | null;
  readonly source: ThreadDeviceAttachment["source"];
  /** What the device is doing, for the status pill. */
  readonly statusLabel: string;
  readonly tone: "running" | "busy" | "stopped" | "error";
  /** Why the last attachment failed, when it did. */
  readonly error: string | null;
  readonly booted: boolean;
}

/** The devices the thread has attached, newest first: the sheet's top section. */
export function attachedDeviceCards(
  threadState: ThreadDeviceState | null,
  devices: readonly DeviceDescriptor[],
): readonly AttachedDeviceCard[] {
  const starting = new Set<string>(threadState?.startingDeviceUdids ?? []);
  return threadAttachments(threadState)
    .toReversed()
    .map((attachment) => {
      const device = devices.find((entry) => entry.udid === attachment.udid) ?? null;
      const status = device ? devicePickerStatus(device, starting) : null;
      const phase = attachment.attachPhase;
      const statusLabel =
        phase !== null
          ? ATTACH_PHASE_TEXT[phase]
          : attachment.lastError !== null
            ? "Failed"
            : status === null
              ? "Unavailable"
              : DEVICE_PICKER_STATUS_LABELS[status];
      const tone =
        attachment.lastError !== null && phase === null
          ? ("error" as const)
          : phase !== null || status === "starting" || status === "stopping"
            ? ("busy" as const)
            : status === "running"
              ? ("running" as const)
              : ("stopped" as const);
      return {
        udid: attachment.udid,
        name: device?.name ?? "Device",
        runtime: device?.runtime ?? null,
        platform: device?.platform ?? null,
        source: attachment.source,
        statusLabel,
        tone,
        error: attachment.lastError,
        booted: device?.state === "booted",
      };
    });
}

/**
 * The attached device Install, Launch and Record act on: the one the person chose, while it is
 * still attached and running, else the thread's latest running attachment.
 */
export function deviceToolsTarget(
  cards: readonly AttachedDeviceCard[],
  chosen: DeviceUdid | null,
): AttachedDeviceCard | null {
  const booted = cards.filter((card) => card.booted);
  return booted.find((card) => card.udid === chosen) ?? booted[0] ?? null;
}

// ── Setup and availability ───────────────────────────────────────────

export interface DevicePlatformLine {
  readonly platform: DevicePlatform;
  readonly label: string;
  readonly tone: DevicePlatformTone;
  readonly summary: string;
}

export interface DevicesNotice {
  readonly kind:
    | "loading"
    | "unavailable"
    | "setup-due"
    | "off"
    | "unsupported"
    | "helper"
    | "setup";
  readonly title: string;
  readonly detail: string;
  /** Each platform's answer, when the node reported them. */
  readonly platforms: readonly DevicePlatformLine[];
  /** Steps still to do, with the command that does each when the node names one. */
  readonly steps: readonly { readonly label: string; readonly detail: string | null }[];
  /** The owner's way past it from the phone, when there is one. */
  readonly action: { readonly label: string; readonly kind: "finish-setup" | "turn-on" } | null;
}

/** Each platform's answer in a line, from a node's listing (older nodes report none). */
export function devicePlatformLines(
  platforms: readonly DevicePlatformAvailability[] | undefined,
): readonly DevicePlatformLine[] {
  return (platforms ?? []).map((entry) => {
    const { tone, summary } = devicePlatformSummary(entry.availability);
    return {
      platform: entry.platform,
      label: DEVICE_PLATFORM_LABELS[entry.platform],
      tone,
      summary,
    };
  });
}

/**
 * What stands in place of the device list, or null when the list shows: in the web panel's
 * order — no device connection, first-run setup due, simulators turned off, then the node's
 * availability. A helper that stops answering for a moment does not hide a thread whose
 * device is already running.
 */
export function threadDevicesNotice(input: {
  readonly connected: boolean;
  readonly availability: DeviceAvailability | null;
  readonly platforms: readonly DevicePlatformLine[];
  readonly gate: { readonly showSetup: boolean; readonly devicesOff: boolean };
  /** The thread already has a device attached. */
  readonly hasAttachment: boolean;
  /** The thread's attached device is running. */
  readonly attachedRunning: boolean;
  /** This session may change the node's settings. */
  readonly canManage: boolean;
}): DevicesNotice | null {
  const base = { platforms: input.platforms, steps: [], action: null };
  if (!input.connected)
    return {
      ...base,
      kind: "unavailable",
      title: "Not connected",
      detail: "Devices show once this node is connected.",
    };
  if (input.gate.showSetup && !input.hasAttachment)
    return {
      ...base,
      kind: "setup-due",
      title: "Set up simulators",
      detail:
        "Run iOS Simulators and Android Emulators from Ryco, here and in the device tools agents use. Nothing starts until you pick a device.",
      action: input.canManage ? { label: "Finish setup", kind: "finish-setup" } : null,
    };
  if (input.gate.devicesOff)
    return {
      ...base,
      kind: "off",
      title: "Simulators are off on this node",
      detail: "Turn on Use simulators to open devices here and give agents the device tools.",
      action: input.canManage ? { label: "Turn on", kind: "turn-on" } : null,
    };
  const availability = input.availability;
  if (!deviceSetupBlocked(availability)) return null;
  if (availability === null)
    return {
      ...base,
      kind: "loading",
      title: "Checking simulator support…",
      detail: "",
    };
  if (availability.kind === "unsupported-platform")
    return {
      ...base,
      kind: "unsupported",
      title: "Device emulation is unavailable",
      detail: `This node runs on ${availability.platform}. Connect Ryco to a Mac with Xcode, or a Mac, Linux or Windows machine with the Android SDK.`,
    };
  if (availability.kind === "helper-unavailable") {
    if (input.attachedRunning) return null;
    return {
      ...base,
      kind: "helper",
      title: "Simulator helper could not start",
      detail: availability.message,
    };
  }
  if (availability.kind !== "setup-required") return null;
  return {
    ...base,
    kind: "setup",
    title: "Set up simulators and emulators",
    detail: "Finish these on the node. Ryco checks again every few seconds.",
    steps: availability.steps
      .filter((step) => !step.done && step.id !== "build-device-helper")
      .map((step) => ({ label: step.label, detail: step.detail?.trim() || null })),
  };
}

// ── Actions ──────────────────────────────────────────────────────────

export {
  bootAndAttachDevice,
  freeSlotThenAttach,
  type BootAttachOutcome,
  type DevicePickerApi,
} from "@ryco/client-runtime/state/device/picker";

export function bootLimitText(limit: number, requestedName: string): string {
  return `Ryco keeps at most ${limit} simulators it booted running. Shut one down to start ${requestedName}.`;
}

/** An error's own words, or the fallback when it has none. */
export function deviceErrorMessage(error: unknown, fallback: string): string {
  return errorMessageOr(error, fallback);
}

// ── Install and launch ───────────────────────────────────────────────

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const MAX_APP_PATH_LENGTH = 1_024;
const MAX_BUNDLE_ID_LENGTH = 256;

export type DeviceFormResult<T> =
  | { readonly ok: true; readonly input: T }
  | { readonly ok: false; readonly reason: string | null };

/**
 * The install request for a typed path on the node, or why it cannot go: an absolute path to a
 * built `.app` bundle (iOS) or an `.apk` (Android). An empty field has no reason to show.
 */
export function installAppRequest(
  udid: DeviceUdid,
  platform: DevicePlatform | null,
  typed: string,
): DeviceFormResult<DeviceInstallAppInput> {
  const appPath = typed.trim().replace(/[\\/]+$/, "");
  if (appPath === "") return { ok: false, reason: null };
  if (appPath.length > MAX_APP_PATH_LENGTH) return { ok: false, reason: "That path is too long." };
  if (!ABSOLUTE_PATH.test(appPath))
    return { ok: false, reason: "Use the full path on the node, starting with /." };
  const lower = appPath.toLowerCase();
  if (platform === "android-emulator" && !lower.endsWith(".apk"))
    return { ok: false, reason: "An Android emulator installs an .apk file." };
  if (platform === "ios-simulator" && !lower.endsWith(".app"))
    return { ok: false, reason: "An iOS Simulator installs a built .app bundle." };
  return { ok: true, input: { udid, appPath } };
}

/** The launch request for a typed bundle id or package name, or why it cannot go. */
export function launchAppRequest(
  udid: DeviceUdid,
  typed: string,
): DeviceFormResult<DeviceLaunchAppInput> {
  const bundleId = typed.trim();
  if (bundleId === "") return { ok: false, reason: null };
  if (bundleId.length > MAX_BUNDLE_ID_LENGTH || /\s/.test(bundleId))
    return { ok: false, reason: "A bundle id has no spaces, like com.example.app." };
  return { ok: true, input: { udid, bundleId } };
}

/** Bundle ids installed from this sheet, newest first and once each, offered for Launch. */
export function rememberBundleId(
  recent: readonly string[],
  bundleId: string,
  limit = 4,
): readonly string[] {
  return [bundleId, ...recent.filter((entry) => entry !== bundleId)].slice(0, limit);
}

// ── Screen recording ─────────────────────────────────────────────────

export type DeviceRecordingState =
  | { readonly kind: "idle"; readonly saved: DeviceStopRecordingResult | null }
  | { readonly kind: "starting" }
  | {
      readonly kind: "recording" | "stopping";
      readonly path: string;
      /** Server time, so elapsed time does not count request latency. */
      readonly startedAt: string;
    };

export const DEVICE_RECORDING_IDLE: DeviceRecordingState = Object.freeze({
  kind: "idle",
  saved: null,
});

export function recordingStarted(result: DeviceStartRecordingResult): DeviceRecordingState {
  return { kind: "recording", path: result.path, startedAt: result.startedAt };
}

export function recordingStopping(state: DeviceRecordingState): DeviceRecordingState {
  return state.kind === "recording" ? { ...state, kind: "stopping" } : state;
}

/** "1:05" for a duration in milliseconds. */
export function recordingDurationText(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "1:05" since `startedAt`; never negative when the phone's clock runs behind the node's. */
export function recordingElapsedText(startedAt: string, nowMs: number): string {
  const started = Date.parse(startedAt);
  return recordingDurationText(Number.isFinite(started) ? nowMs - started : 0);
}

/** The recording row's line. */
export function recordingStatusText(state: DeviceRecordingState, nowMs: number): string {
  switch (state.kind) {
    case "starting":
      return "Starting…";
    case "recording":
      return `Recording · ${recordingElapsedText(state.startedAt, nowMs)}`;
    case "stopping":
      return "Saving…";
    case "idle":
      return state.saved === null
        ? "Saved on the node when you stop."
        : `Saved ${recordingDurationText(state.saved.durationMs)} to ${state.saved.path}`;
  }
}

/**
 * Recordings this app started, per environment and device, for as long as the app runs: the
 * sheet can close and reopen while one goes on. Another client's recording is not known here;
 * the node refuses a second one and says so.
 */
export function createDeviceRecordingStore() {
  let states: ReadonlyMap<string, DeviceRecordingState> = new Map();
  const listeners = new Set<() => void>();
  return {
    key: (environmentId: string, udid: string) => JSON.stringify([environmentId, udid]),
    get: (key: string): DeviceRecordingState => states.get(key) ?? DEVICE_RECORDING_IDLE,
    set: (key: string, state: DeviceRecordingState) => {
      const next = new Map(states);
      next.set(key, state);
      states = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const deviceRecordings = createDeviceRecordingStore();
