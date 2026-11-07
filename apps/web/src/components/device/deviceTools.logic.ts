import type {
  DeviceAccessibilitySetting,
  DeviceColorFilter,
  DeviceDetail,
  DeviceDetailSettings,
  DeviceTestingPermission,
  DeviceTestingTextSize,
  DeviceToolControl,
  DeviceUiFrame,
  DeviceUiNode,
} from "@ryco/contracts";

/*
 * The Tools drawer's pure parts: which controls a device has, labels, presets,
 * the frames the overlay draws and the push payload alert text builds.
 */

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isBundleId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && BUNDLE_ID.test(value);
}

export function hasControl(detail: DeviceDetail | null, control: DeviceToolControl): boolean {
  return detail?.controls.includes(control) ?? false;
}

export const ACCESSIBILITY_TOGGLES: readonly {
  readonly setting: DeviceAccessibilitySetting;
  readonly label: string;
  readonly field: keyof Pick<
    DeviceDetailSettings,
    "reduceMotion" | "increaseContrast" | "reduceTransparency" | "showBorders" | "voiceOver"
  >;
}[] = [
  { setting: "reduce-motion", label: "Reduce Motion", field: "reduceMotion" },
  { setting: "increase-contrast", label: "Increase Contrast", field: "increaseContrast" },
  { setting: "reduce-transparency", label: "Reduce Transparency", field: "reduceTransparency" },
  { setting: "show-borders", label: "Show Borders", field: "showBorders" },
  { setting: "voiceover", label: "VoiceOver", field: "voiceOver" },
];

export const COLOR_FILTER_LABELS: Record<DeviceColorFilter, string> = {
  none: "None",
  grayscale: "Grayscale",
  "red-green": "Red/Green (protanopia)",
  "green-red": "Green/Red (deuteranopia)",
  "blue-yellow": "Blue/Yellow (tritanopia)",
};

export const TEXT_SIZE_LABELS: Record<DeviceTestingTextSize, string> = {
  "extra-small": "Extra small",
  small: "Small",
  medium: "Medium",
  large: "Large (default)",
  "extra-large": "Extra large",
  "extra-extra-large": "XX large",
  "extra-extra-extra-large": "XXX large",
  "accessibility-medium": "Accessibility M",
  "accessibility-large": "Accessibility L",
  "accessibility-extra-large": "Accessibility XL",
  "accessibility-extra-extra-large": "Accessibility XXL",
  "accessibility-extra-extra-extra-large": "Accessibility XXXL",
};

export const PERMISSION_LABELS: Record<DeviceTestingPermission, string> = {
  calendar: "Calendar",
  "contacts-limited": "Contacts (limited)",
  contacts: "Contacts",
  location: "Location",
  "location-always": "Location (always)",
  "photos-add": "Add photos",
  photos: "Photos",
  "media-library": "Media library",
  microphone: "Microphone",
  motion: "Motion",
  reminders: "Reminders",
  siri: "Siri",
};

/** Services each platform can change. */
export const IOS_PERMISSIONS: readonly DeviceTestingPermission[] = [
  "location",
  "location-always",
  "photos",
  "photos-add",
  "contacts",
  "contacts-limited",
  "calendar",
  "reminders",
  "microphone",
  "motion",
  "media-library",
  "siri",
];
export const ANDROID_PERMISSIONS: readonly DeviceTestingPermission[] = [
  "location",
  "location-always",
  "photos",
  "contacts",
  "calendar",
  "microphone",
  "motion",
  "media-library",
];

export const LOCATION_PRESETS: readonly {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
}[] = [
  { label: "Cupertino", latitude: 37.3349, longitude: -122.009 },
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5074, longitude: -0.1278 },
  { label: "Berlin", latitude: 52.52, longitude: 13.405 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  { label: "Sydney", latitude: -33.8688, longitude: 151.2093 },
];

/** Coordinates typed into the drawer, or null while they are not a valid pair. */
export function parseCoordinates(
  latitude: string,
  longitude: string,
): { latitude: number; longitude: number } | null {
  if (latitude.trim() === "" || longitude.trim() === "") return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: lat, longitude: lon };
}

/** The push payload for plain alert text. */
export function alertPushPayload(text: string): string {
  return JSON.stringify({ aps: { alert: text, sound: "default" } });
}

/** At most this many frames are drawn; a long list is mostly off-screen rows. */
export const UI_FRAME_LIMIT = 400;

/**
 * Every distinct element frame in the tree that has a size, below the root:
 * the root is the whole screen, and outlining it says nothing. A wrapper with
 * its child's exact frame would draw the same outline twice.
 */
export function flattenUiFrames(root: DeviceUiNode): DeviceUiFrame[] {
  const frames: DeviceUiFrame[] = [];
  const seen = new Set<string>();
  const visit = (node: DeviceUiNode, depth: number) => {
    if (frames.length >= UI_FRAME_LIMIT) return;
    const { frame } = node;
    const key = `${frame.x},${frame.y},${frame.width},${frame.height}`;
    if (depth > 0 && frame.width > 0 && frame.height > 0 && !seen.has(key)) {
      seen.add(key);
      frames.push(frame);
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return frames;
}

export function formatCoordinate(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, "");
}
