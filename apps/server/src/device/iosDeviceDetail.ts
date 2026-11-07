/**
 * The Tools drawer's read-back for an iOS simulator: what the device reports
 * now, never what Ryco last asked for (except location, which simulators do
 * not report and which is labelled as applied).
 *
 * Loaded on the first read, off the server's boot graph.
 *
 * @module device/iosDeviceDetail
 */
import type {
  DeviceColorFilter,
  DeviceDetailSettings,
  DevicePermissionState,
  DeviceTestingPermission,
  DeviceTestingTextSize,
} from "@ryco/contracts";
import { DeviceTestingTextSize as TextSizes } from "@ryco/contracts";
import * as path from "node:path";

import type { ProcessRunResult, runProcess } from "../processRunner.ts";
import type { DeviceBackendDetail } from "./DeviceBackend.ts";

export interface IosDetailIo {
  readonly simctl: (args: readonly string[]) => Promise<ProcessRunResult>;
  readonly simSettingsTool: () => Promise<string>;
  /** The frontmost app's process and accessibility label, when a helper is bound. */
  readonly foregroundPid: () => Promise<{ pid: number | null; label: string | null } | null>;
  /** Undefined: never set by Ryco. Null: cleared. */
  readonly appliedLocation:
    | { readonly latitude: number; readonly longitude: number }
    | null
    | undefined;
  /** The simulator's `data` directory, for the permission database. */
  readonly dataDirectory: string;
  readonly run: typeof runProcess;
}

/** Every control an iOS simulator on this node supports. */
export const IOS_DETAIL_CONTROLS = [
  "foreground-app",
  "terminate-app",
  "launch-app",
  "open-url",
  "appearance",
  "text-size",
  "orientation",
  "liquid-glass",
  "color-filter",
  "reduce-motion",
  "increase-contrast",
  "reduce-transparency",
  "show-borders",
  "voiceover",
  "location",
  "clear-location",
  "permission",
  "push",
  "presets",
] as const;

/** TCC service names for the permissions `simctl privacy` changes; location is not in TCC. */
const TCC_SERVICES: Partial<Record<DeviceTestingPermission, string>> = {
  calendar: "kTCCServiceCalendar",
  contacts: "kTCCServiceAddressBook",
  "contacts-limited": "kTCCServiceAddressBook",
  photos: "kTCCServicePhotos",
  "photos-add": "kTCCServicePhotosAdd",
  "media-library": "kTCCServiceMediaLibrary",
  microphone: "kTCCServiceMicrophone",
  motion: "kTCCServiceMotion",
  reminders: "kTCCServiceReminders",
  siri: "kTCCServiceSiri",
};

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SIM_SETTINGS_TOGGLES = {
  "reduce-motion": "reduceMotion",
  "reduce-transparency": "reduceTransparency",
  "show-borders": "showBorders",
  voiceover: "voiceOver",
} as const;
const COLOR_FILTERS: readonly DeviceColorFilter[] = [
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
];

/** `ryco-sim-settings status` output; unknown or unsupported keys are dropped. */
export function parseSimSettingsStatus(stdout: string): Partial<DeviceDetailSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const status = parsed as Record<string, unknown>;
  const settings: { -readonly [K in keyof DeviceDetailSettings]?: DeviceDetailSettings[K] } = {};
  for (const [key, field] of Object.entries(SIM_SETTINGS_TOGGLES)) {
    const value = status[key];
    if (value === "on" || value === "off") settings[field] = value === "on";
  }
  const filter = status["color-filter"];
  if (typeof filter === "string" && (COLOR_FILTERS as readonly string[]).includes(filter)) {
    settings.colorFilter = filter as DeviceColorFilter;
  }
  const glass = status["liquid-glass"];
  if (glass === "clear" || glass === "tinted") settings.liquidGlass = glass;
  return settings;
}

/** The bundle id of `pid` in `launchctl list` (`UIKitApplication:<bundle>[…]`). */
export function bundleForPid(launchctlList: string, pid: number): string | null {
  for (const line of launchctlList.split(/\r?\n/u)) {
    const [first, , label] = line.trim().split(/\s+/u);
    if (Number(first) !== pid || !label) continue;
    const match = /^UIKitApplication:([^[\s]+)/u.exec(label);
    if (match && BUNDLE_ID.test(match[1]!)) return match[1]!;
  }
  return null;
}

/** Whether `pid` is SpringBoard in `launchctl list`. */
export function isSpringBoard(launchctlList: string, pid: number): boolean {
  return launchctlList.split(/\r?\n/u).some((line) => {
    const [first, , label] = line.trim().split(/\s+/u);
    return Number(first) === pid && label === "com.apple.SpringBoard";
  });
}

/** Permission rows from `access` as `[{service, auth_value}]` JSON. */
export function permissionStates(
  rows: readonly { readonly service?: unknown; readonly auth_value?: unknown }[],
): { service: DeviceTestingPermission; state: DevicePermissionState }[] {
  const byService = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.service === "string" && typeof row.auth_value === "number") {
      byService.set(row.service, row.auth_value);
    }
  }
  const states: { service: DeviceTestingPermission; state: DevicePermissionState }[] = [];
  for (const [service, tcc] of Object.entries(TCC_SERVICES) as [
    DeviceTestingPermission,
    string,
  ][]) {
    // One TCC entry backs both contacts services; report it once.
    if (service === "contacts-limited") continue;
    const value = byService.get(tcc);
    states.push({
      service,
      // auth_value: 0 denied, 2 allowed, 3 limited; no row is not determined.
      state:
        value === undefined
          ? "not-determined"
          : value === 2
            ? "granted"
            : value === 3
              ? "limited"
              : "denied",
    });
  }
  return states;
}

async function readPermissions(
  io: IosDetailIo,
  bundleId: string,
): Promise<{ service: DeviceTestingPermission; state: DevicePermissionState }[] | null> {
  if (!BUNDLE_ID.test(bundleId)) return null;
  const database = path.join(io.dataDirectory, "Library", "TCC", "TCC.db");
  // Read-only, with the client bound as a literal checked above: the value is
  // a validated bundle id and sqlite3 receives argv, never a shell.
  const result = await io
    .run(
      "/usr/bin/sqlite3",
      [
        "-readonly",
        "-json",
        database,
        `select service, auth_value from access where client = '${bundleId}'`,
      ],
      { timeoutMs: 5_000, allowNonZeroExit: true, outputMode: "truncate" },
    )
    .catch(() => null);
  if (!result || result.code !== 0) return null;
  try {
    const rows = result.stdout.trim() === "" ? [] : (JSON.parse(result.stdout) as unknown);
    return Array.isArray(rows) ? permissionStates(rows) : null;
  } catch {
    return null;
  }
}

/** The app in front: null on the home screen, undefined when it cannot be told. */
async function readForeground(
  io: IosDetailIo,
  udid: string,
): Promise<DeviceBackendDetail["foregroundApp"]> {
  const front = await io.foregroundPid().catch(() => null);
  if (!front?.pid) return undefined;
  const list = await io.simctl(["spawn", udid, "launchctl", "list"]).catch(() => null);
  if (!list || list.code !== 0) return undefined;
  const bundleId = bundleForPid(list.stdout, front.pid);
  // SpringBoard in front is the home screen (or a system sheet over it).
  if (!bundleId) return isSpringBoard(list.stdout, front.pid) ? null : undefined;
  return { bundleId, ...(front.label ? { name: front.label.slice(0, 256) } : {}) };
}

export async function readIosDeviceDetail(
  io: IosDetailIo,
  udid: string,
  bundleId: string | undefined,
): Promise<DeviceBackendDetail> {
  const uiValue = async (option: string) => {
    const result = await io.simctl(["ui", udid, option]).catch(() => null);
    return result && result.code === 0 ? result.stdout.trim().toLowerCase() : null;
  };
  const simSettings = async () => {
    const tool = await io.simSettingsTool().catch(() => null);
    if (!tool) return {};
    const result = await io.simctl(["spawn", udid, tool, "status"]).catch(() => null);
    return result && result.code === 0 ? parseSimSettingsStatus(result.stdout) : {};
  };
  const [appearance, contentSize, contrast, toggles, foregroundApp] = await Promise.all([
    uiValue("appearance"),
    uiValue("content_size"),
    uiValue("increase_contrast"),
    simSettings(),
    readForeground(io, udid),
  ]);
  const permissionTarget = bundleId ?? foregroundApp?.bundleId;
  const permissions = permissionTarget ? await readPermissions(io, permissionTarget) : null;
  const settings: DeviceDetailSettings = {
    ...(appearance === "light" || appearance === "dark" ? { appearance } : {}),
    ...(contentSize && (TextSizes.literals as readonly string[]).includes(contentSize)
      ? { textSize: contentSize as DeviceTestingTextSize }
      : {}),
    ...(contrast === "enabled" || contrast === "disabled"
      ? { increaseContrast: contrast === "enabled" }
      : {}),
    ...toggles,
    ...(io.appliedLocation === undefined
      ? {}
      : {
          location:
            io.appliedLocation === null ? null : { ...io.appliedLocation, source: "applied" },
        }),
  };
  return {
    ...(foregroundApp === undefined ? {} : { foregroundApp }),
    settings,
    ...(permissions && permissionTarget
      ? { permissions: { bundleId: permissionTarget, states: permissions } }
      : {}),
    controls: IOS_DETAIL_CONTROLS,
  };
}
