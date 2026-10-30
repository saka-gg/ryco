import { ScopedThreadRef } from "@ryco/contracts/environment";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  hasThreadSystemNotifications,
  planThreadAlert,
  THREAD_ALERT_COPY,
  threadNotificationModeOf,
  threadNotificationTag,
  type ThreadNotificationMode,
} from "@ryco/client-runtime/state/settings";
import type { ThreadNotificationCandidate } from "@ryco/client-runtime/state/threads";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MVP_ROOT_ROUTES } from "../navigation/mvpRouteConfig";
import type { Preferences } from "../state/preferencesStore";

/** The sound plays with the notification, so it only counts while alerts are on. */
export function threadAlertModeOf(
  preferences: Pick<Preferences, "threadAlerts" | "threadAlertSound">,
): ThreadNotificationMode {
  const alerts = preferences.threadAlerts === true;
  return threadNotificationModeOf({
    notifyOnTurnCompleteWhenUnfocused: alerts,
    threadNotificationSound: alerts && preferences.threadAlertSound === true,
  });
}

/** A local notification for one thread. */
export interface MobileThreadAlert {
  /** The thread's notification tag: a newer alert replaces the one before. */
  readonly identifier: string;
  readonly title: string;
  readonly body: string;
  readonly sound: boolean;
  readonly ref: ScopedThreadRef;
}

/**
 * The notification a candidate shows, or null when it stays quiet. The app has
 * no in-app toast, so in front its banner takes the toast's place and shows
 * unless the thread is on screen; in the background it is the system alert,
 * unless background push already brings it (`pushCovers`): the node then
 * sends the same alert through the Hub, and the two must not double up.
 */
export function planMobileThreadAlert(input: {
  readonly candidate: ThreadNotificationCandidate;
  readonly mode: ThreadNotificationMode;
  readonly appActive: boolean;
  readonly visibleThread: ScopedThreadRef | null;
  readonly pushCovers?: boolean;
}): MobileThreadAlert | null {
  const { event, delegated } = input.candidate;
  if (!input.appActive && input.pushCovers === true) return null;
  const plan = planThreadAlert({
    mode: input.mode,
    toasts: hasThreadSystemNotifications(input.mode),
    appFocused: input.appActive,
    threadVisible:
      input.visibleThread !== null && scopedThreadKey(input.visibleThread) === event.groupKey,
    kind: event.kind,
    delegated,
  });
  if (!plan.system && !plan.toast) return null;
  return {
    identifier: threadNotificationTag(event.ref),
    title: THREAD_ALERT_COPY[event.kind].title,
    body: event.title,
    sound: plan.sound,
    ref: event.ref,
  };
}

/** The deep link path of the thread route, which a tapped alert opens. */
export function threadAlertLinkPath(ref: ScopedThreadRef): string {
  return MVP_ROOT_ROUTES.Thread.linking
    .replace(":environmentId", encodeURIComponent(ref.environmentId))
    .replace(":threadId", encodeURIComponent(ref.threadId));
}

const decodeThreadRef = Schema.decodeUnknownOption(ScopedThreadRef);

/** The thread a tapped notification's data names, or null when it is not a thread alert. */
export function threadAlertRefOf(data: unknown): ScopedThreadRef | null {
  return Option.getOrNull(decodeThreadRef(data));
}

/**
 * Whether a notification arriving while the app is in front shows its banner.
 * A background push for a machine the app is connected to stays quiet: the
 * app's own alert for it already ran through the rules above (the node holds
 * pushes for a device in front, so this only catches a race).
 */
export function presentsInForeground(input: {
  readonly remote: boolean;
  readonly data: unknown;
  readonly isEnvironmentLive: (environmentId: ScopedThreadRef["environmentId"]) => boolean;
}): boolean {
  if (!input.remote) return true;
  const ref = threadAlertRefOf(input.data);
  return ref === null || !input.isEnvironmentLive(ref.environmentId);
}
