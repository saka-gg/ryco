/**
 * The typed testing actions (`DeviceTestingInput`) on an Android emulator:
 * appearance, font scale, location, runtime permissions, orientation and
 * network, each as fixed `adb shell` or emulator-console argument lists.
 *
 * Pure planning, so every mapping is unit-tested; the backend runs the steps.
 * No value reaches a shell unquoted: steps are argv, quoted by the backend.
 *
 * @module device/android/androidTesting
 */
import type {
  DeviceTestingAction,
  DeviceTestingInput,
  DeviceTestingPermission,
  DeviceTestingTextSize,
} from "@ryco/contracts";

import { DeviceBackendError } from "../DeviceBackend.ts";

export type AndroidTestingStep =
  /** `adb shell <argv>`. */
  | { readonly kind: "shell"; readonly args: readonly string[] }
  /** `adb emu <argv>`: the emulator console. */
  | { readonly kind: "emu"; readonly args: readonly string[] }
  /**
   * One `pm` command per permission; succeeds when at least one does, since
   * an app requests only some of a group (fine but not coarse location).
   */
  | {
      readonly kind: "permissions";
      readonly bundleId: string;
      readonly decision: "grant" | "revoke" | "reset";
      readonly permissions: readonly string[];
    };

/** Android's font scale for each iOS content size; "large" is both defaults. */
export const ANDROID_FONT_SCALE: Record<DeviceTestingTextSize, string> = {
  "extra-small": "0.8",
  small: "0.85",
  medium: "0.9",
  large: "1.0",
  "extra-large": "1.1",
  "extra-extra-large": "1.2",
  "extra-extra-extra-large": "1.3",
  "accessibility-medium": "1.5",
  "accessibility-large": "1.7",
  "accessibility-extra-large": "1.8",
  "accessibility-extra-extra-large": "1.9",
  "accessibility-extra-extra-extra-large": "2.0",
};

/** `Surface.ROTATION_*` for each orientation. */
export const ANDROID_ROTATION = {
  portrait: "0",
  "landscape-left": "1",
  "portrait-upside-down": "2",
  "landscape-right": "3",
} as const;

/** Runtime permissions per service. Media permissions split at API 33. */
export function androidPermissions(
  service: DeviceTestingPermission,
  apiLevel: number,
): readonly string[] {
  const media = (modern: readonly string[]) =>
    apiLevel >= 33 ? modern : ["android.permission.READ_EXTERNAL_STORAGE"];
  switch (service) {
    case "calendar":
      return ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"];
    case "contacts":
    case "contacts-limited":
      return ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"];
    case "location":
      return [
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
      ];
    case "location-always":
      return [
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
      ];
    case "photos":
    case "photos-add":
      return media(["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO"]);
    case "media-library":
      return media(["android.permission.READ_MEDIA_AUDIO"]);
    case "microphone":
      return ["android.permission.RECORD_AUDIO"];
    case "motion":
      return ["android.permission.ACTIVITY_RECOGNITION"];
    case "reminders":
    case "siri":
      throw new DeviceBackendError(`Android has no ${service} permission.`);
  }
}

function plan(action: DeviceTestingAction, apiLevel: number): AndroidTestingStep[] {
  switch (action.type) {
    case "appearance":
      return [
        { kind: "shell", args: ["cmd", "uimode", "night", action.value === "dark" ? "yes" : "no"] },
      ];
    case "text-size":
      return [
        {
          kind: "shell",
          args: ["settings", "put", "system", "font_scale", ANDROID_FONT_SCALE[action.value]],
        },
      ];
    case "location":
      // The console takes longitude first.
      return [
        { kind: "emu", args: ["geo", "fix", String(action.longitude), String(action.latitude)] },
      ];
    case "clear-location":
      throw new DeviceBackendError(
        "An Android emulator keeps its last location; set another location instead of clearing it.",
      );
    case "permission":
      return [
        {
          kind: "permissions",
          bundleId: action.bundleId,
          decision: action.decision,
          permissions: androidPermissions(action.service, apiLevel),
        },
      ];
    case "push":
      throw new DeviceBackendError(
        "Push notifications need Firebase Cloud Messaging on Android; Ryco cannot simulate them on an emulator.",
      );
    case "orientation":
      return [
        { kind: "shell", args: ["settings", "put", "system", "accelerometer_rotation", "0"] },
        {
          kind: "shell",
          args: ["settings", "put", "system", "user_rotation", ANDROID_ROTATION[action.value]],
        },
      ];
    case "network": {
      const verb = action.value === "on" ? "enable" : "disable";
      return [
        { kind: "shell", args: ["svc", "wifi", verb] },
        { kind: "shell", args: ["svc", "data", verb] },
      ];
    }
    case "preset":
      switch (action.value) {
        case "dark":
          return plan({ type: "appearance", value: "dark" }, apiLevel);
        case "large-text":
          return plan({ type: "text-size", value: "accessibility-large" }, apiLevel);
        case "dark-large-text":
          return [
            ...plan({ type: "appearance", value: "dark" }, apiLevel),
            ...plan({ type: "text-size", value: "accessibility-large" }, apiLevel),
          ];
        case "standard":
          return [
            ...plan({ type: "appearance", value: "light" }, apiLevel),
            ...plan({ type: "text-size", value: "large" }, apiLevel),
          ];
      }
  }
}

export function planAndroidTestingAction(
  input: DeviceTestingInput,
  apiLevel: number,
): readonly AndroidTestingStep[] {
  return plan(input.action, apiLevel);
}

/** `pm` arguments for one permission and decision. */
export function permissionCommand(
  bundleId: string,
  decision: "grant" | "revoke" | "reset",
  permission: string,
): readonly (readonly string[])[] {
  if (decision === "grant") return [["pm", "grant", bundleId, permission]];
  if (decision === "revoke") return [["pm", "revoke", bundleId, permission]];
  // Back to "ask": revoke, then forget the user's earlier answer.
  return [
    ["pm", "revoke", bundleId, permission],
    ["pm", "clear-permission-flags", bundleId, permission, "user-set", "user-fixed"],
  ];
}
