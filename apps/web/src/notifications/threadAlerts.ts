import type { DesktopBridge, EnvironmentId, ScopedThreadRef } from "@ryco/contracts";
import type { ClientSettings } from "@ryco/contracts/settings";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  hasThreadAlertSound,
  planThreadAlert,
  THREAD_ALERT_COPY,
  threadNotificationModeOf,
  threadNotificationTag,
  type ThreadAlertCopy,
} from "@ryco/client-runtime/state/settings";
import {
  startThreadNotificationFeed,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
  type ThreadNotificationCandidate,
  type ThreadNotificationEvent,
  type ThreadNotificationFeed,
  type ThreadNotificationSource,
} from "@ryco/client-runtime/state/threads";

import type { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  createThreadAlertSoundPlayer,
  type ThreadAlertAudioContext,
  type ThreadAlertSoundPlayer,
} from "./threadAlertSound";

/**
 * What thread alerts read from the app. The bootstrap passes in the app's
 * singletons, so this lazily loaded module imports none of the shell's
 * modules and its chunk never pulls one out of the shell.
 */
export interface ThreadAlertsDeps {
  readonly source: ThreadNotificationSource;
  readonly readEnvironmentThreads: (
    environmentId: EnvironmentId,
  ) => ReadonlyArray<SidebarThreadOrStub>;
  readonly isThreadSnoozed: (thread: SidebarThreadSummary, nowMs: number) => boolean;
  /** This device's settings, or null until they have loaded: nothing alerts before that. */
  readonly readSettings: () => ClientSettings | null;
  /** Called when the settings change or finish loading. */
  readonly subscribeSettings: (listener: () => void) => () => void;
  readonly toastManager: Pick<typeof toastManager, "add" | "close">;
  readonly stackedThreadToast: typeof stackedThreadToast;
  readonly navigateToThread: (ref: ScopedThreadRef) => void;
  /** The threads on screen: the route's, or every pane of the split it is in. */
  readonly readVisibleThreadRefs: () => ReadonlyArray<ScopedThreadRef>;
  readonly isPhoneTier: () => boolean;
}

/** A browser notification on screen. */
interface ShownWebNotification {
  readonly close: () => void;
}

/** The window, document and platform APIs alerts use; tests replace them. */
export interface ThreadAlertsPlatform {
  /** Ryco is visible and has focus. */
  readonly readAppFocused: () => boolean;
  readonly subscribeWindowFocus: (listener: () => void) => () => void;
  readonly focusWindow: () => void;
  /** Shows a browser notification, or returns null where none may be shown. */
  readonly showWebNotification: (notification: {
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly onClick: () => void;
    readonly onClose: () => void;
  }) => ShownWebNotification | null;
  readonly desktopBridge: Pick<DesktopBridge, "notifyTurnComplete"> | undefined;
  readonly createAudioContext: () => ThreadAlertAudioContext | null;
  readonly gestureTarget: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly hasUserActivation: () => boolean;
}

export function createBrowserThreadAlertsPlatform(): ThreadAlertsPlatform {
  return {
    readAppFocused: () => document.visibilityState === "visible" && document.hasFocus(),
    subscribeWindowFocus: (listener) => {
      window.addEventListener("focus", listener);
      return () => window.removeEventListener("focus", listener);
    },
    focusWindow: () => window.focus(),
    showWebNotification: ({ title, body, tag, onClick, onClose }) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") {
        return null;
      }
      // Silent: a sound mode plays its own chime.
      const notification = new Notification(title, { body, tag, silent: true });
      notification.addEventListener("click", onClick);
      notification.addEventListener("close", onClose);
      return notification;
    },
    desktopBridge: window.desktopBridge,
    createAudioContext: () => (typeof AudioContext === "undefined" ? null : new AudioContext()),
    gestureTarget: window,
    hasUserActivation: () => navigator.userActivation?.hasBeenActive === true,
  };
}

export interface ThreadAlerts {
  /** Closes the toasts of threads that came on screen. */
  readonly syncVisibleThreads: () => void;
  readonly stop: () => void;
}

type ToastId = ReturnType<ThreadAlertsDeps["toastManager"]["add"]>;

/** An alert toast stays up this long once seen, like other result toasts. */
const ALERT_TOAST_VISIBLE_MS = 10_000;

/**
 * Turns notification candidates into alerts: an "Open thread" toast while
 * Ryco is in front, a desktop or browser notification while it is not, and an
 * optional chime. The feed runs while any alert is on, so turning alerts back
 * on starts from a silent baseline. One toast and one notification per thread:
 * a newer alert replaces the older one.
 */
export function startThreadAlerts(
  deps: ThreadAlertsDeps,
  platform: ThreadAlertsPlatform = createBrowserThreadAlertsPlatform(),
): ThreadAlerts {
  const toastIdByThread = new Map<string, ToastId>();
  const webNotificationByTag = new Map<string, ShownWebNotification>();
  let feed: ThreadNotificationFeed | null = null;
  let sound: ThreadAlertSoundPlayer | null = null;
  let stopped = false;

  const closeToast = (groupKey: string) => {
    const toastId = toastIdByThread.get(groupKey);
    if (toastId === undefined) return;
    toastIdByThread.delete(groupKey);
    deps.toastManager.close(toastId);
  };

  const closeWebNotifications = () => {
    const shown = Array.from(webNotificationByTag.values());
    webNotificationByTag.clear();
    for (const notification of shown) notification.close();
  };

  const showToast = (event: ThreadNotificationEvent, copy: ThreadAlertCopy) => {
    const { groupKey } = event;
    closeToast(groupKey);
    const toastId = deps.toastManager.add(
      // No thread scope: a thread-scoped toast only shows on its own thread.
      deps.stackedThreadToast({
        type: copy.toastType,
        title: copy.title,
        description: event.title,
        timeout: 0,
        actionProps: {
          children: "Open thread",
          onClick: () => {
            closeToast(groupKey);
            deps.navigateToThread(event.ref);
          },
        },
        actionVariant: "outline",
        data: {
          hideCopyButton: true,
          dismissAfterVisibleMs: ALERT_TOAST_VISIBLE_MS,
          onClose: () => {
            if (toastIdByThread.get(groupKey) === toastId) toastIdByThread.delete(groupKey);
          },
        },
      }),
    );
    toastIdByThread.set(groupKey, toastId);
  };

  const showSystemNotification = (event: ThreadNotificationEvent, copy: ThreadAlertCopy) => {
    const { desktopBridge } = platform;
    if (desktopBridge) {
      desktopBridge
        .notifyTurnComplete({
          threadId: event.ref.threadId,
          environmentId: event.ref.environmentId,
          title: copy.title,
          body: event.title,
        })
        .catch(() => undefined);
      return;
    }
    const tag = threadNotificationTag(event.ref);
    webNotificationByTag.get(tag)?.close();
    try {
      const notification = platform.showWebNotification({
        title: copy.title,
        body: event.title,
        tag,
        onClick: () => {
          platform.focusWindow();
          deps.navigateToThread(event.ref);
          notification?.close();
        },
        onClose: () => {
          if (webNotificationByTag.get(tag) === notification) webNotificationByTag.delete(tag);
        },
      });
      if (notification !== null) webNotificationByTag.set(tag, notification);
    } catch (error) {
      // Some browsers (Android Chrome) have the constructor but refuse it.
      console.warn("Thread notification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const deliver = ({ event, delegated }: ThreadNotificationCandidate) => {
    const settings = deps.readSettings();
    if (stopped || settings === null || deps.isPhoneTier()) return;
    const plan = planThreadAlert({
      mode: threadNotificationModeOf(settings),
      toasts: settings.threadNotificationToasts,
      appFocused: platform.readAppFocused(),
      threadVisible: deps
        .readVisibleThreadRefs()
        .some((ref) => scopedThreadKey(ref) === event.groupKey),
      kind: event.kind,
      delegated,
    });
    const copy = THREAD_ALERT_COPY[event.kind];
    if (plan.toast) showToast(event, copy);
    if (plan.system) showSystemNotification(event, copy);
    if (plan.sound) {
      sound?.play(copy.sound, () => {
        const current = deps.readSettings();
        return (
          current !== null &&
          hasThreadAlertSound(threadNotificationModeOf(current)) &&
          feed?.isCurrent(event) === true
        );
      });
    }
  };

  const syncSettings = () => {
    if (stopped) return;
    const settings = deps.readSettings();
    const mode = settings === null ? "off" : threadNotificationModeOf(settings);
    if (mode === "off" && settings?.threadNotificationToasts !== true) {
      feed?.stop();
      feed = null;
    } else {
      feed ??= startThreadNotificationFeed({
        source: deps.source,
        readEnvironmentThreads: deps.readEnvironmentThreads,
        isSnoozed: deps.isThreadSnoozed,
        now: Date.now,
        onCandidate: deliver,
      });
    }
    if (hasThreadAlertSound(mode)) {
      sound ??= createThreadAlertSoundPlayer(platform);
    } else {
      sound?.dispose();
      sound = null;
    }
  };

  const unsubscribeSettings = deps.subscribeSettings(syncSettings);
  // Coming back to Ryco answers the notifications that called you there.
  const unsubscribeWindowFocus = platform.subscribeWindowFocus(closeWebNotifications);
  syncSettings();

  return {
    syncVisibleThreads: () => {
      for (const ref of deps.readVisibleThreadRefs()) closeToast(scopedThreadKey(ref));
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribeSettings();
      unsubscribeWindowFocus();
      feed?.stop();
      feed = null;
      sound?.dispose();
      sound = null;
      for (const groupKey of Array.from(toastIdByThread.keys())) closeToast(groupKey);
      closeWebNotifications();
    },
  };
}
