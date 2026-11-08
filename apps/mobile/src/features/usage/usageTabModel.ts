// Pure, react-native-free model of the Usage tab: its views and windows, which
// devices a view asks, what the screen shows while they answer, and when coming
// back to Limits asks the providers again.

import type { StatRange } from "@ryco/client-runtime/usage";

import type { InboxEnvironment } from "../inbox/inboxModel";
import type { StatisticsTab } from "../settings/statistics/statisticsRoute";

/** What the Usage tab shows: subscription limits, recorded usage, or work activity. */
export type UsageView = StatisticsTab;

/** The view switch, in order. Limits come first: they are what a glance is for. */
export const USAGE_VIEW_OPTIONS: ReadonlyArray<{
  readonly value: UsageView;
  readonly label: string;
}> = [
  { value: "limits", label: "Limits" },
  { value: "usage", label: "Usage" },
  { value: "activity", label: "Activity" },
];

export const DEFAULT_USAGE_VIEW: UsageView = "limits";

/** The window switch of Usage and Activity. Limits are current, so they have none. */
export const USAGE_RANGE_OPTIONS: ReadonlyArray<{
  readonly value: StatRange;
  readonly label: string;
  readonly accessibilityLabel: string;
}> = [
  { value: "7d", label: "7d", accessibilityLabel: "Past 7 days" },
  { value: "30d", label: "30d", accessibilityLabel: "Past 30 days" },
  { value: "90d", label: "90d", accessibilityLabel: "Past 90 days" },
  { value: "all", label: "All", accessibilityLabel: "All time" },
];

export const DEFAULT_USAGE_RANGE: StatRange = "30d";

/** The device filter's value for every connected device. */
export const ALL_DEVICES = "all";

/** Whether a view filters by date. */
export function usageViewHasRange(view: UsageView): boolean {
  return view !== "limits";
}

function isReadable(environment: InboxEnvironment): boolean {
  return environment.connectionState === "connected" || environment.connectionState === "read-only";
}

export interface UsageScope {
  /** The device filter as it applies: a device that went away falls back to all. */
  readonly device: string;
  /** The devices the filter picks. */
  readonly selected: readonly InboxEnvironment[];
  /** The one device Activity reads; activity snapshots are per device, as on desktop. */
  readonly activityDevice: InboxEnvironment | undefined;
  /** The devices this view asks. */
  readonly scoped: readonly InboxEnvironment[];
}

/**
 * The devices a view asks: every connected device, or the one the filter names.
 * Activity reads a single device, the first connected one of the selection.
 */
export function scopeUsageEnvironments(
  environments: readonly InboxEnvironment[],
  device: string,
  view: UsageView,
): UsageScope {
  const named = environments.filter((environment) => environment.environmentId === device);
  const applied = named.length > 0 ? device : ALL_DEVICES;
  const selected = named.length > 0 ? named : environments.filter(isReadable);
  const activityDevice = selected.find(
    (environment) => environment.connectionState === "connected",
  );
  const activity = activityDevice === undefined ? selected.slice(0, 1) : [activityDevice];
  return {
    device: applied,
    selected,
    activityDevice: activity[0],
    scoped: view === "activity" ? activity : selected,
  };
}

export interface UsageDeviceMenu {
  readonly title: string;
  /** The picked option. */
  readonly value: string;
  /** What the filter shows now, for the line under the title and the button's label. */
  readonly label: string;
  /** Whether one device is picked, so the button shows that the view is narrowed. */
  readonly filtered: boolean;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

/** The device filter: every connected device (or Activity's device), then each device. */
export function usageDeviceMenu(
  environments: readonly InboxEnvironment[],
  scope: UsageScope,
  view: UsageView,
): UsageDeviceMenu {
  const allLabel =
    view === "activity"
      ? (scope.activityDevice?.label ?? "No device connected")
      : "All connected devices";
  const options = [
    { value: ALL_DEVICES, label: allLabel },
    ...environments.map((environment) => ({
      value: environment.environmentId as string,
      label: environment.label,
    })),
  ];
  const current = options.find((option) => option.value === scope.device);
  return {
    title: "Devices",
    value: scope.device,
    label: current === undefined ? allLabel : current.label,
    filtered: scope.device !== ALL_DEVICES,
    options,
  };
}

/** How long Limits trust the providers' last answer before coming back asks again. */
export const LIMITS_AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * What coming back to Limits does (the tab in front, the view switched to, the
 * app back in the foreground): the first visit loads on its own, a visit within
 * the interval keeps the numbers on screen, and a later one asks again.
 */
export function limitsFocusRefresh(
  lastAskedAt: number | null,
  now: number,
): "first" | "reload" | "skip" {
  if (lastAskedAt === null) return "first";
  return now - lastAskedAt >= LIMITS_AUTO_REFRESH_INTERVAL_MS ? "reload" : "skip";
}

/** A device that could not answer, said beside what the others did. */
export interface UsageDeviceNotice {
  readonly key: string;
  readonly label: string;
  readonly message: string;
}

export type UsageContentState =
  | { readonly kind: "no-devices"; readonly title: string; readonly detail: string }
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "failed"; readonly notices: readonly UsageDeviceNotice[] }
  | { readonly kind: "empty"; readonly title: string; readonly detail: string }
  | { readonly kind: "ready"; readonly notices: readonly UsageDeviceNotice[] };

const LOADING_LABEL: Record<UsageView, string> = {
  limits: "Checking provider limits…",
  usage: "Scanning provider transcripts…",
  activity: "Reading activity…",
};

const EMPTY: Record<UsageView, { readonly title: string; readonly detail: string }> = {
  limits: { title: "No limits yet", detail: "These devices have not reported provider limits." },
  usage: { title: "No usage yet", detail: "No provider-recorded usage on these devices." },
  activity: { title: "No activity yet", detail: "This device has not recorded any work." },
};

const NO_DEVICES_DETAIL: Record<UsageView, string> = {
  limits: "Connect a device to see its subscription limits.",
  usage: "Connect a device to see the usage its providers recorded.",
  activity: "Connect a device to see its work activity.",
};

/**
 * What the view shows: an empty state without devices, a loading line until
 * the first answer, every device's error when none could answer, an empty
 * state when they answered with nothing, else the content with a notice for
 * each device that failed.
 */
export function usageContentState(input: {
  readonly view: UsageView;
  /** Devices the app knows at all. */
  readonly environmentCount: number;
  /** Devices this view asks. */
  readonly scopedCount: number;
  readonly loading: boolean;
  /** Whether anything readable is on screen for this view. */
  readonly hasContent: boolean;
  readonly nodes: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly error?: string | undefined;
  }>;
}): UsageContentState {
  if (input.scopedCount === 0) {
    return {
      kind: "no-devices",
      title: input.environmentCount === 0 ? "No devices yet" : "No device connected",
      detail: NO_DEVICES_DETAIL[input.view],
    };
  }
  const notices = input.nodes.flatMap((node) =>
    node.error === undefined || node.error === ""
      ? []
      : [{ key: node.environmentId, label: node.label, message: node.error }],
  );
  if (input.hasContent) return { kind: "ready", notices };
  if (input.loading) return { kind: "loading", label: LOADING_LABEL[input.view] };
  if (notices.length > 0) return { kind: "failed", notices };
  return { kind: "empty", ...EMPTY[input.view] };
}
