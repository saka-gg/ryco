import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";
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
import { AppState, Platform } from "react-native";

import type { Preferences } from "../state/preferencesStore";
import {
  planMobileThreadAlert,
  threadAlertLinkPath,
  threadAlertModeOf,
  threadAlertRefOf,
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
  /** Calls back with the data of each notification the user opens, the one that launched the app included. */
  readonly subscribeOpened: (listener: (data: unknown) => void) => () => void;
  readonly openThread: (ref: ScopedThreadRef) => void;
}

const THREAD_ALERT_CHANNEL_ID = "thread-alerts";

let threadAlertChannel: Promise<void> | null = null;

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

export function createExpoThreadAlertsPlatform(): MobileThreadAlertsPlatform {
  let lastOpened: string | null = null;
  return {
    isAppActive: () => AppState.currentState === "active",
    prepare: ensureThreadAlertChannel,
    present: async (alert) => {
      await Notifications.scheduleNotificationAsync({
        identifier: alert.identifier,
        content: {
          title: alert.title,
          body: alert.body,
          // Always set: left out, the default sound plays.
          sound: alert.sound,
          data: { environmentId: alert.ref.environmentId, threadId: alert.ref.threadId },
        },
        trigger: Platform.OS === "android" ? { channelId: THREAD_ALERT_CHANNEL_ID } : null,
      });
    },
    presentInForeground: () => {
      Notifications.setNotificationHandler({
        // The notification's own sound setting decides; refusing sound here
        // would also hide the banner on Android.
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
      return () => Notifications.setNotificationHandler(null);
    },
    subscribeOpened: (listener) => {
      const open = (response: Notifications.NotificationResponse | null) => {
        if (response?.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
        // The response that launched the app can also arrive as an event.
        const key = `${response.notification.request.identifier}:${response.notification.date}`;
        if (key === lastOpened) return;
        lastOpened = key;
        Notifications.clearLastNotificationResponse();
        listener(response.notification.request.content.data);
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
    const alert = planMobileThreadAlert({
      candidate,
      mode: threadAlertModeOf(deps.readPreferences()),
      appActive: platform.isAppActive(),
      visibleThread: deps.readVisibleThread(),
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

  const stopForeground = platform.presentInForeground();
  const unsubscribeOpened = platform.subscribeOpened((data) => {
    const ref = threadAlertRefOf(data);
    if (ref !== null) platform.openThread(ref);
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
    },
  };
}
