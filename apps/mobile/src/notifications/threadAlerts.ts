import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";
import type { PushAlertKind } from "@ryco/contracts/push";
import { wantedThreadAlertKinds } from "@ryco/client-runtime/state/settings";
import {
  startThreadNotificationFeed,
  type SidebarThreadOrStub,
  type ThreadNotificationCandidate,
  type ThreadNotificationFeed,
  type ThreadNotificationSource,
} from "@ryco/client-runtime/state/threads";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { isAppInFront } from "../platform/appInFront";
import type { Preferences } from "../state/preferencesStore";
import {
  NOTIFICATION_CATEGORIES,
  notificationCategoryForKind,
  notificationRouteOf,
  type NotificationRoute,
} from "./notificationActionsModel";
import {
  clearPendingNotificationActions,
  setPendingNotificationAction,
} from "./pendingNotificationAction";
import {
  planMobileThreadAlert,
  presentsInForeground,
  threadAlertLinkPath,
  threadAlertModeOf,
  type MobileThreadAlert,
} from "./threadAlerts.logic";

/** What thread alerts read from the app. */
export interface MobileThreadAlertsDeps {
  readonly source: ThreadNotificationSource;
  readonly readEnvironmentThreads: (
    environmentId: EnvironmentId,
  ) => ReadonlyArray<SidebarThreadOrStub>;
  readonly readPreferences: () => Preferences;
  readonly subscribePreferences: (listener: () => void) => () => void;
  readonly readVisibleThread: () => ScopedThreadRef | null;
  /**
   * Background push brings this environment's alerts of this kind while the
   * app is in the background, so the app does not post its own.
   */
  readonly isBackgroundPushActive?: (environmentId: EnvironmentId, kind: PushAlertKind) => boolean;
}

/** The native notification APIs alerts use; tests replace them. */
export interface MobileThreadAlertsPlatform {
  /** The app is in front. */
  readonly isAppActive: () => boolean;
  /** Readies the platform to post; every alert waits for it. */
  readonly prepare: () => Promise<void>;
  readonly present: (alert: MobileThreadAlert) => Promise<void>;
  /** Shows alerts while the app is in front; the returned function stops that. */
  readonly presentInForeground: () => () => void;
  /**
   * Calls back once with each notification response that names a thread: a tap or one of its
   * actions, the one that launched the app included.
   */
  readonly subscribeOpened: (listener: (route: NotificationRoute) => void) => () => void;
  readonly openThread: (ref: ScopedThreadRef) => void;
}

const THREAD_ALERT_CHANNEL_ID = "thread-alerts";

let threadAlertChannel: Promise<void> | null = null;
let threadAlertCategories: Promise<void> | null = null;

/**
 * Registers the alert categories and their actions (`notificationActionsModel.ts`). iOS keeps them
 * across launches; the push extension sets the same identifiers on the alerts it opens.
 */
function ensureThreadAlertCategories(): Promise<void> {
  threadAlertCategories ??= (async () => {
    // One at a time: each call reads iOS's category set and writes it back with its own, so
    // calls in parallel keep only the last one.
    for (const category of NOTIFICATION_CATEGORIES) {
      await Notifications.setNotificationCategoryAsync(
        category.identifier,
        category.actions.map((action) => ({
          ...action,
          options: { ...action.options },
          ...(action.textInput ? { textInput: { ...action.textInput } } : {}),
        })),
      );
    }
  })().catch((error: unknown) => {
    threadAlertCategories = null;
    throw error;
  });
  return threadAlertCategories;
}

/** Android posts through a channel, which must exist before it may ask to notify. */
function ensureThreadAlertChannel(): Promise<void> {
  if (Platform.OS !== "android") return Promise.resolve();
  threadAlertChannel ??= Notifications.setNotificationChannelAsync(THREAD_ALERT_CHANNEL_ID, {
    name: "Thread alerts",
    importance: Notifications.AndroidImportance.HIGH,
  }).then(
    () => undefined,
    (error: unknown) => {
      threadAlertChannel = null;
      throw error;
    },
  );
  return threadAlertChannel;
}

export function createExpoThreadAlertsPlatform(
  options: {
    /** The app holds a live connection to this machine. */
    readonly isEnvironmentLive?: (environmentId: EnvironmentId) => boolean;
    /** The thread on screen: an alert for it stays quiet while the app is in front. */
    readonly readVisibleThread?: () => ScopedThreadRef | null;
  } = {},
): MobileThreadAlertsPlatform {
  /** Responses already routed: the one that launched the app also arrives as an event. */
  const routed = new Set<string>();
  return {
    // The test push presence uses (`isAppInFront`), so the two never disagree.
    isAppActive: isAppInFront,
    prepare: () =>
      Promise.all([ensureThreadAlertChannel(), ensureThreadAlertCategories()]).then(
        () => undefined,
      ),
    present: async (alert) => {
      await Notifications.scheduleNotificationAsync({
        identifier: alert.identifier,
        content: {
          title: alert.title,
          // iOS shows it between the title and the body; Android as the notification's subtext.
          ...(alert.subtitle === null ? {} : { subtitle: alert.subtitle }),
          body: alert.body,
          // Always set: left out, the default sound plays.
          sound: alert.sound,
          categoryIdentifier: notificationCategoryForKind(alert.kind),
          data: {
            environmentId: alert.ref.environmentId,
            threadId: alert.ref.threadId,
            kind: alert.kind,
            ...(alert.turnId === null ? {} : { turnId: alert.turnId }),
            // The approval an Approve or Deny on this alert answers, and no other.
            ...(alert.approvalRequestId === null ? {} : { requestId: alert.approvalRequestId }),
          },
        },
        trigger: Platform.OS === "android" ? { channelId: THREAD_ALERT_CHANNEL_ID } : null,
      });
    },
    presentInForeground: () => {
      Notifications.setNotificationHandler({
        // The notification's own sound setting decides; refusing sound here
        // would also hide the banner on Android.
        handleNotification: async (notification) => {
          // Typed as a trigger input; a delivered push carries `{ type: "push" }`.
          const trigger: unknown = notification.request.trigger;
          const show = presentsInForeground({
            remote:
              typeof trigger === "object" &&
              trigger !== null &&
              (trigger as { readonly type?: unknown }).type === "push",
            data: notification.request.content.data,
            isEnvironmentLive: options.isEnvironmentLive ?? (() => false),
            visibleThread: options.readVisibleThread?.() ?? null,
          });
          return {
            shouldShowBanner: show,
            shouldShowList: show,
            shouldPlaySound: show,
            shouldSetBadge: false,
          };
        },
      });
      return () => Notifications.setNotificationHandler(null);
    },
    subscribeOpened: (listener) => {
      const open = (response: Notifications.NotificationResponse | null) => {
        if (response === null) return;
        const route = notificationRouteOf(response);
        if (route === null || routed.has(route.responseKey)) return;
        routed.add(route.responseKey);
        Notifications.clearLastNotificationResponse();
        listener(route);
      };
      open(Notifications.getLastNotificationResponse());
      const subscription = Notifications.addNotificationResponseReceivedListener(open);
      return () => subscription.remove();
    },
    openThread: (ref) => {
      // Alerts run outside the workspace navigator; the app's own deep link
      // reaches it, through the access gate when that locked meanwhile.
      void Linking.openURL(Linking.createURL(threadAlertLinkPath(ref))).catch(() => undefined);
    },
  };
}

/** Whether this device lets Ryco post notifications. */
export async function readThreadAlertPermission(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

/**
 * Asks to post notifications, from the switch that turns alerts on. A
 * notification tapped while alerts were off is forgotten first, so turning
 * them on does not open its thread now.
 */
export async function requestThreadAlertPermission(): Promise<boolean> {
  Notifications.clearLastNotificationResponse();
  await ensureThreadAlertChannel();
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true },
  });
  return permission.granted;
}

export interface MobileThreadAlerts {
  readonly stop: () => void;
}

/**
 * Turns notification candidates into local notifications while the app runs:
 * one per thread, a newer alert replacing the older one, with the system sound
 * when that is on. The feed runs while alerts are on, so turning them back on
 * starts from a silent baseline. Opening a notification opens its thread for as
 * long as this runs, alerts on or off.
 */
export function startMobileThreadAlerts(
  deps: MobileThreadAlertsDeps,
  platform: MobileThreadAlertsPlatform = createExpoThreadAlertsPlatform(),
): MobileThreadAlerts {
  let feed: ThreadNotificationFeed | null = null;
  let stopped = false;

  const deliver = (candidate: ThreadNotificationCandidate) => {
    const appActive = platform.isAppActive();
    const preferences = deps.readPreferences();
    const alert = planMobileThreadAlert({
      candidate,
      mode: threadAlertModeOf(preferences),
      wantedKinds: wantedThreadAlertKinds(preferences.mutedAlertKinds),
      appActive,
      visibleThread: deps.readVisibleThread(),
      pushCovers:
        !appActive &&
        deps.isBackgroundPushActive?.(candidate.event.ref.environmentId, candidate.event.kind) ===
          true,
    });
    if (stopped || alert === null) return;
    void platform
      .prepare()
      .then(() => {
        if (stopped || feed?.isCurrent(candidate.event) !== true) return;
        return platform.present(alert);
      })
      .catch((error: unknown) => {
        console.warn("Thread alert failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const syncPreferences = () => {
    if (stopped) return;
    if (threadAlertModeOf(deps.readPreferences()) === "off") {
      feed?.stop();
      feed = null;
      return;
    }
    feed ??= startThreadNotificationFeed({
      source: deps.source,
      readEnvironmentThreads: deps.readEnvironmentThreads,
      isSnoozed: isThreadSnoozed,
      now: Date.now,
      onCandidate: deliver,
    });
  };

  // The categories also serve the alerts push brings while Ryco is closed.
  void platform.prepare().catch((error: unknown) => {
    console.warn("Thread alert actions were not registered", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const stopForeground = platform.presentInForeground();
  const unsubscribeOpened = platform.subscribeOpened((route) => {
    // The thread's screen carries the action out once its connection is ready for it.
    if (route.action !== null) setPendingNotificationAction(route.ref, route.action, Date.now());
    platform.openThread(route.ref);
  });
  const unsubscribePreferences = deps.subscribePreferences(syncPreferences);
  syncPreferences();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribePreferences();
      unsubscribeOpened();
      stopForeground();
      feed?.stop();
      feed = null;
      // Signed out or locked: what was tapped for this session never runs in the next one.
      clearPendingNotificationActions();
    },
  };
}
