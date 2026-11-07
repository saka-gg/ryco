/**
 * The Tools drawer's read-back for an Android emulator, parsed from `adb shell`
 * output. Pure parsing, so every mapping is unit-tested; the backend runs the
 * commands.
 *
 * @module device/android/androidDetail
 */
import type {
  DeviceColorFilter,
  DeviceDetailSettings,
  DeviceOrientation,
  DevicePermissionState,
  DeviceTestingPermission,
  DeviceTestingTextSize,
  DeviceToolControl,
} from "@ryco/contracts";

import { ANDROID_DALTONIZER, ANDROID_FONT_SCALE, androidPermissions } from "./androidTesting.ts";

/** Every control an Android emulator supports. */
export const ANDROID_DETAIL_CONTROLS: readonly DeviceToolControl[] = [
  "foreground-app",
  "terminate-app",
  "launch-app",
  "open-url",
  "appearance",
  "text-size",
  "orientation",
  "color-filter",
  "network",
  "reduce-motion",
  "increase-contrast",
  "location",
  "permission",
  "presets",
];

/** The `adb shell` reads, in the order `parseAndroidSettings` takes their output. */
export const ANDROID_DETAIL_READS = {
  night: ["cmd", "uimode", "night"],
  fontScale: ["settings", "get", "system", "font_scale"],
  animator: ["settings", "get", "global", "animator_duration_scale"],
  wifi: ["settings", "get", "global", "wifi_on"],
  contrast: ["settings", "get", "secure", "high_text_contrast_enabled"],
  daltonizerEnabled: ["settings", "get", "secure", "accessibility_display_daltonizer_enabled"],
  daltonizer: ["settings", "get", "secure", "accessibility_display_daltonizer"],
  displays: ["dumpsys", "window", "displays"],
  // API 36 dropped the focus from `dumpsys window windows`; the full dump keeps it.
  window: ["dumpsys", "window"],
  location: ["dumpsys", "location"],
} as const satisfies Record<string, readonly string[]>;

export type AndroidDetailOutputs = { [K in keyof typeof ANDROID_DETAIL_READS]: string | null };

const ROTATIONS: readonly DeviceOrientation[] = [
  "portrait",
  "landscape-left",
  "portrait-upside-down",
  "landscape-right",
];

/** The content size whose Android font scale is nearest to `scale`. */
export function textSizeForFontScale(scale: number): DeviceTestingTextSize {
  let best: DeviceTestingTextSize = "large";
  let distance = Number.POSITIVE_INFINITY;
  for (const [size, value] of Object.entries(ANDROID_FONT_SCALE) as [
    DeviceTestingTextSize,
    string,
  ][]) {
    const delta = Math.abs(Number(value) - scale);
    if (delta < distance) {
      best = size;
      distance = delta;
    }
  }
  return best;
}

const setting = (output: string | null): string | null => {
  const value = output?.trim();
  return value === undefined || value === "" || value === "null" ? null : value;
};

export function parseAndroidSettings(
  outputs: AndroidDetailOutputs,
  applied: { readonly latitude: number; readonly longitude: number } | null | undefined,
): DeviceDetailSettings {
  const night = outputs.night?.match(/Night mode:\s*(yes|no)/u)?.[1];
  const fontScale = Number(setting(outputs.fontScale) ?? Number.NaN);
  const animator = setting(outputs.animator);
  const wifi = setting(outputs.wifi);
  const contrast = setting(outputs.contrast);
  const daltonizerEnabled = setting(outputs.daltonizerEnabled);
  const daltonizer = setting(outputs.daltonizer) ?? "12";
  const rotation = defaultDisplayRotation(outputs.displays);
  const filter =
    daltonizerEnabled === "1"
      ? ((Object.entries(ANDROID_DALTONIZER).find(([, value]) => value === daltonizer)?.[0] as
          | DeviceColorFilter
          | undefined) ?? undefined)
      : daltonizerEnabled === "0" || daltonizerEnabled === null
        ? "none"
        : undefined;
  const reported = outputs.location?.match(
    /last location=Location\[\w+ (-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/u,
  );
  const location = reported
    ? {
        latitude: Number(reported[1]),
        longitude: Number(reported[2]),
        source: "device" as const,
      }
    : applied
      ? { ...applied, source: "applied" as const }
      : undefined;
  return {
    ...(night ? { appearance: night === "yes" ? "dark" : "light" } : {}),
    ...(Number.isFinite(fontScale) && fontScale > 0 && fontScale <= 10
      ? { fontScale, textSize: textSizeForFontScale(fontScale) }
      : {}),
    // Unset means the default of 1: animations on.
    ...(animator === null
      ? { reduceMotion: false }
      : Number.isFinite(Number(animator))
        ? { reduceMotion: Number(animator) === 0 }
        : {}),
    ...(wifi === "0" || wifi === "1" ? { network: wifi === "1" ? "on" : "off" } : {}),
    increaseContrast: contrast === "1",
    ...(filter ? { colorFilter: filter } : {}),
    ...(rotation !== undefined ? { orientation: ROTATIONS[Number(rotation)]! } : {}),
    ...(location ? { location } : applied === null ? { location: null } : {}),
  };
}

/**
 * The built-in display's rotation from `dumpsys window displays`. Other
 * displays (a virtual one scrcpy or an app made) come first in the dump and
 * keep their own rotation, so only display 0's section counts.
 */
export function defaultDisplayRotation(dump: string | null): string | undefined {
  if (!dump) return undefined;
  const sections = dump.split(/^\s*Display: mDisplayId=/mu);
  const builtIn = sections.find((section) => /^0\b/u.test(section));
  return (builtIn ?? (sections.length === 1 ? dump : "")).match(/\bmRotation=([0-3])\b/u)?.[1];
}

/** The focused app's package from `dumpsys window`. */
export function parseForegroundPackage(windowDump: string | null): string | null {
  const match = windowDump?.match(
    /m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\//u,
  );
  return match?.[1] ?? null;
}

/** Runtime permission states from `dumpsys package <package>`, per service it requested. */
export function parseAndroidPermissions(
  packageDump: string,
  apiLevel: number,
): { service: DeviceTestingPermission; state: DevicePermissionState }[] {
  const runtime = packageDump.split(/runtime permissions:/u)[1] ?? "";
  const entries = new Map<string, { granted: boolean; userSet: boolean }>();
  for (const line of runtime.split(/\r?\n/u)) {
    const match = /^\s+([\w.]+): granted=(true|false)(?:, flags=\[([^\]]*)\])?/u.exec(line);
    if (!match) {
      // The first user's list ends at the first line that is not a permission.
      if (entries.size > 0) break;
      continue;
    }
    entries.set(match[1]!, {
      granted: match[2] === "true",
      userSet: /USER_SET|USER_FIXED/u.test(match[3] ?? ""),
    });
  }
  const states: { service: DeviceTestingPermission; state: DevicePermissionState }[] = [];
  const services: readonly DeviceTestingPermission[] = [
    "calendar",
    "contacts",
    "location",
    "photos",
    "media-library",
    "microphone",
    "motion",
  ];
  for (const service of services) {
    const found = androidPermissions(service, apiLevel)
      .map((permission) => entries.get(permission))
      .filter((entry) => entry !== undefined);
    // An app that never asked for a permission has no state to show.
    if (found.length === 0) continue;
    states.push({
      service,
      state: found.some((entry) => entry.granted)
        ? "granted"
        : found.some((entry) => entry.userSet)
          ? "denied"
          : "not-determined",
    });
  }
  return states;
}
