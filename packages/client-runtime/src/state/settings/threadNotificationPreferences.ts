import type { ScopedThreadRef } from "@ryco/contracts";
import type { ClientSettings } from "@ryco/contracts/settings";

import type { ThreadNotificationKind } from "../threads/threadNotifications.ts";

/**
 * How a thread alert reaches you while Ryco is open. Stored as two switches,
 * not as the mode itself, so nothing needs migrating and older builds keep
 * reading `notifyOnTurnCompleteWhenUnfocused` with the meaning it had.
 */
export type ThreadNotificationMode = "off" | "notifications" | "sound" | "notifications-and-sound";

type ThreadNotificationModeSettings = Pick<
  ClientSettings,
  "notifyOnTurnCompleteWhenUnfocused" | "threadNotificationSound"
>;

export const THREAD_NOTIFICATION_MODE_OPTIONS: ReadonlyArray<{
  readonly value: ThreadNotificationMode;
  readonly label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "notifications", label: "Notifications" },
  { value: "sound", label: "Sound" },
  { value: "notifications-and-sound", label: "Notifications and sound" },
];

export function hasThreadSystemNotifications(mode: ThreadNotificationMode): boolean {
  return mode === "notifications" || mode === "notifications-and-sound";
}

export function hasThreadAlertSound(mode: ThreadNotificationMode): boolean {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function threadNotificationModeOf(
  settings: ThreadNotificationModeSettings,
): ThreadNotificationMode {
  if (settings.notifyOnTurnCompleteWhenUnfocused) {
    return settings.threadNotificationSound ? "notifications-and-sound" : "notifications";
  }
  return settings.threadNotificationSound ? "sound" : "off";
}

/** The settings patch that stores a mode; it always writes both switches. */
export function threadNotificationModePatch(
  mode: ThreadNotificationMode,
): ThreadNotificationModeSettings {
  return {
    notifyOnTurnCompleteWhenUnfocused: hasThreadSystemNotifications(mode),
    threadNotificationSound: hasThreadAlertSound(mode),
  };
}

export type ThreadAlertSound = "attention" | "completion";

export interface ThreadAlertCopy {
  readonly title: string;
  readonly toastType: "success" | "error" | "warning" | "info";
  readonly sound: ThreadAlertSound;
}

/** Titles follow the inbox's state labels, so an alert and its row say the same. */
export const THREAD_ALERT_COPY: Readonly<Record<ThreadNotificationKind, ThreadAlertCopy>> = {
  approval: { title: "Needs approval", toastType: "warning", sound: "attention" },
  input: { title: "Needs your answer", toastType: "warning", sound: "attention" },
  "plan-ready": { title: "Plan ready", toastType: "info", sound: "attention" },
  completed: { title: "Finished", toastType: "success", sound: "completion" },
  failed: { title: "Failed", toastType: "error", sound: "attention" },
  stopped: { title: "Stopped", toastType: "warning", sound: "attention" },
};

const TAG_OFFSET_BASIS = 0xcbf29ce484222325n;
const TAG_PRIME = 0x100000001b3n;
const TAG_MASK = 0xffffffffffffffffn;

/**
 * One OS notification per thread: a later alert replaces the earlier one with
 * the same tag. A 64-bit FNV-1a hash rather than the ids themselves, because
 * Windows drops toasts whose tag is as long as an environment and thread id.
 */
export function threadNotificationTag(ref: ScopedThreadRef): string {
  const key = `${ref.environmentId}:${ref.threadId}`;
  let hash = TAG_OFFSET_BASIS;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index));
    hash = (hash * TAG_PRIME) & TAG_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface ThreadAlertPlanInput {
  readonly mode: ThreadNotificationMode;
  /** In-app "Open thread" toasts are on. */
  readonly toasts: boolean;
  /** Ryco is visible and has focus. */
  readonly appFocused: boolean;
  /** The alerting thread is on screen, in the route or in a split pane. */
  readonly threadVisible: boolean;
  readonly kind: ThreadNotificationKind;
  /** The thread was delegated by another thread, which receives its result. */
  readonly delegated: boolean;
}

export interface ThreadAlertPlan {
  readonly sound: boolean;
  readonly toast: boolean;
  readonly system: boolean;
  /** Counts toward the app badge; it shows even where notifications are not allowed. */
  readonly badge: boolean;
}

const NO_ALERT: ThreadAlertPlan = { sound: false, toast: false, system: false, badge: false };

/**
 * How one alert is delivered. A toast only while Ryco is in front and the
 * thread is elsewhere; a system notification and a badge only while Ryco is
 * in the background; a sound unless you are looking at the thread. A delegated
 * thread alerts only when it waits for you, since its parent gets its result.
 * A stopped turn alerts only while Ryco is in the background: in front, it is
 * nearly always your own Stop (the thread's, its menu's or a dialog's).
 */
export function planThreadAlert(input: ThreadAlertPlanInput): ThreadAlertPlan {
  if (input.delegated && input.kind !== "approval" && input.kind !== "input") return NO_ALERT;
  if (input.kind === "stopped" && input.appFocused) return NO_ALERT;
  const system = hasThreadSystemNotifications(input.mode) && !input.appFocused;
  return {
    sound: hasThreadAlertSound(input.mode) && !(input.appFocused && input.threadVisible),
    toast: input.toasts && input.appFocused && !input.threadVisible,
    system,
    badge: system,
  };
}
