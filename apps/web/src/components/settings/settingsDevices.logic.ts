// Device status for the settings page's device items and device bar. Its own
// module, apart from `settingsSections.logic`, which the app shell imports: only
// the settings page needs this.

/** Why a node a settings menu offers cannot be reached now, as its label says it. */
export type SettingsNodeStatus = "offline" | "connecting";

/**
 * Whether a node shows as Offline or Connecting, from the facts the settings
 * page's empty state uses: a node its directory reports offline, a connection
 * underway or one its Hub machine record allows, else any other connection
 * that is not up. A node this client holds no connection to by design (a
 * hosted node the selection cursor is not on) only shows Offline when its
 * directory says so.
 */
export function settingsNodeStatus(facts: {
  readonly connection: "connected" | "connecting" | "disconnected" | "error" | undefined;
  /** The directory's presence, or the Hub machine record's. */
  readonly online?: boolean | undefined;
  /** The Hub machine record allows connecting to it. */
  readonly canConnect?: boolean | undefined;
}): SettingsNodeStatus | null {
  if (facts.online === false) return "offline";
  if (facts.connection === undefined || facts.connection === "connected") return null;
  if (facts.connection === "connecting" || facts.canConnect === true) return "connecting";
  return "offline";
}

/**
 * How this app reaches a device, for its card and page: its own backend, a
 * node through the Hub, or a saved remote environment (direct or over SSH).
 */
export type SettingsDeviceKind = "this-computer" | "hub" | "remote" | "ssh";

export const SETTINGS_DEVICE_KIND_LABELS: Readonly<Record<SettingsDeviceKind, string>> = {
  "this-computer": "This computer",
  hub: "Hub device",
  remote: "Remote environment",
  ssh: "SSH environment",
};

/** The Ryco version a device runs and the one an update would bring, as the Updates plan has them. */
export interface SettingsDeviceVersion {
  readonly version: string | null;
  /** Set when an update is ready (one click, this app's own, or by hand). */
  readonly updateTo: string | null;
}

type PlannedNodeVersion =
  | {
      readonly kind: "one-click" | "this-app";
      readonly fromVersion: string;
      readonly toVersion: string;
    }
  | {
      readonly kind: "manual";
      readonly fromVersion: string | null;
      readonly toVersion: string | null;
    }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "unknown"; readonly version: string | null };

/** A device's version from its Updates plan entry; null when the plan has nothing to say. */
export function readSettingsDeviceVersion(
  node: PlannedNodeVersion | null | undefined,
): SettingsDeviceVersion | null {
  if (!node) return null;
  switch (node.kind) {
    case "one-click":
    case "this-app":
      return { version: node.fromVersion, updateTo: node.toVersion };
    case "manual":
      if (node.fromVersion === null && node.toVersion === null) return null;
      return { version: node.fromVersion, updateTo: node.toVersion };
    case "current":
      return { version: node.version, updateTo: null };
    case "unknown":
      return node.version === null ? null : { version: node.version, updateTo: null };
  }
}

/**
 * "Online", "Connecting", or "Offline · Last seen 2 h ago" when the last
 * sighting is known.
 */
export function settingsDeviceStatusLine(
  status: SettingsNodeStatus | null,
  lastSeen: string | null,
): string {
  if (status === null) return "Online";
  if (status === "connecting") return "Connecting";
  return lastSeen ? `Offline · ${lastSeen}` : "Offline";
}

/** How many devices the device bar shows as pills before the rest go into "More". */
export const DEVICE_BAR_PILL_LIMIT = 5;

/**
 * The device bar's pills and its "More" list: the first devices in list
 * order, with the shown device always among the pills (it takes the last
 * pill's place when it is further down), and the rest, in order, under More.
 */
export function splitDeviceBarChoices<T extends { readonly environmentId: string }>(
  choices: ReadonlyArray<T>,
  selected: string | null,
  limit = DEVICE_BAR_PILL_LIMIT,
): { readonly pills: ReadonlyArray<T>; readonly more: ReadonlyArray<T> } {
  if (choices.length <= limit) return { pills: choices, more: [] };
  const index = choices.findIndex((choice) => choice.environmentId === selected);
  const pills =
    index < limit ? choices.slice(0, limit) : [...choices.slice(0, limit - 1), choices[index]!];
  const shown = new Set(pills.map((choice) => choice.environmentId));
  return { pills, more: choices.filter((choice) => !shown.has(choice.environmentId)) };
}
