import {
  DesktopNotificationBadge,
  DesktopThreadNotification,
  type DesktopThreadNotificationResult,
} from "@ryco/contracts/desktop-notifications";
import * as Schema from "effect/Schema";

import type { IpcInvokeRegistrar } from "./deferredIpc.ts";
import { THREAD_NOTIFICATION_IPC } from "./threadNotificationChannels.ts";

/** The part of a `BrowserWindow` thread notifications use. */
export interface ThreadNotificationWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  readonly webContents: { send(channel: string, ...args: unknown[]): void };
}

/** An OS notification on screen. */
export interface ShownThreadNotification {
  close(): void;
}

/** The Electron surface thread notifications run on; tests pass fakes. */
export interface ThreadNotificationHost<Window extends ThreadNotificationWindow> {
  readonly platform: NodeJS.Platform;
  readonly ipcMain: IpcInvokeRegistrar;
  /** Any of the app's windows got focus. */
  readonly onWindowFocus: (listener: () => void) => void;
  readonly onBeforeQuit: (listener: () => void) => void;
  /** The app window: it shows in-app alerts and opens a clicked notification's thread. */
  readonly getMainWindow: () => Window | null;
  readonly getAllWindows: () => ReadonlyArray<Window>;
  readonly revealWindow: (window: Window) => void;
  readonly notificationsSupported: () => boolean;
  /** Shows a silent notification: the renderer plays its own chime in a sound mode. */
  readonly showNotification: (notification: {
    readonly title: string;
    readonly body: string;
    readonly onClick: () => void;
    readonly onClose: () => void;
  }) => ShownThreadNotification;
  /** The dock (macOS) or launcher (Linux) count. */
  readonly setBadgeCount: (count: number) => void;
  /** The Windows taskbar overlay; a null image removes it. */
  readonly setOverlayIcon: (window: Window, image: string | null, description: string) => void;
}

/**
 * Thread alerts in the OS for the renderer: one notification per thread (a
 * newer one replaces it), and the badge counting threads that alerted while
 * Ryco was in the background. While the app window has focus the renderer
 * alerts in the app instead, and focusing any window clears the badge and
 * closes the notifications that led back. Call once.
 */
export function installThreadNotificationIpc<Window extends ThreadNotificationWindow>(
  host: ThreadNotificationHost<Window>,
): void {
  // Electron drops a notification's handlers once nothing references it.
  const shownByTag = new Map<string, ShownThreadNotification>();
  const liveWindows = () => host.getAllWindows().filter((window) => !window.isDestroyed());

  const applyBadge = ({ count, image }: DesktopNotificationBadge) => {
    try {
      if (host.platform === "darwin" || host.platform === "linux") {
        host.setBadgeCount(count);
      } else if (host.platform === "win32") {
        const overlay = count > 0 ? image : null;
        const description = count === 1 ? "1 thread alert" : `${count} thread alerts`;
        for (const window of liveWindows()) {
          host.setOverlayIcon(window, overlay, overlay === null ? "" : description);
        }
      }
    } catch (error) {
      console.warn("[desktop] failed to update the notification badge", error);
    }
  };
  const clearBadge = () => {
    applyBadge({ count: 0, image: null });
    for (const window of liveWindows()) {
      window.webContents.send(THREAD_NOTIFICATION_IPC.badgeCleared);
    }
  };

  host.ipcMain.removeHandler(THREAD_NOTIFICATION_IPC.notify);
  host.ipcMain.handle(
    THREAD_NOTIFICATION_IPC.notify,
    (_event, raw): DesktopThreadNotificationResult => {
      const { environmentId, threadId, tag, title, body } =
        Schema.decodeUnknownSync(DesktopThreadNotification)(raw);
      if (host.getMainWindow()?.isFocused() === true) return "window-focused";
      if (!host.notificationsSupported()) return "unsupported";

      shownByTag.get(tag)?.close();
      const forget = () => {
        if (shownByTag.get(tag) === shown) shownByTag.delete(tag);
      };
      const shown = host.showNotification({
        title,
        body,
        onClick: () => {
          forget();
          const window = host.getMainWindow();
          if (window === null || window.isDestroyed()) return;
          host.revealWindow(window);
          window.webContents.send(THREAD_NOTIFICATION_IPC.activated, { environmentId, threadId });
        },
        onClose: forget,
      });
      shownByTag.set(tag, shown);
      return "shown";
    },
  );

  host.ipcMain.removeHandler(THREAD_NOTIFICATION_IPC.setBadge);
  host.ipcMain.handle(THREAD_NOTIFICATION_IPC.setBadge, (_event, raw) => {
    const badge = Schema.decodeUnknownSync(DesktopNotificationBadge)(raw);
    // A badge is for coming back to Ryco: a window with focus already did.
    if (badge.count > 0 && liveWindows().some((window) => window.isFocused())) clearBadge();
    else applyBadge(badge);
  });

  host.onWindowFocus(() => {
    const shown = Array.from(shownByTag.values());
    shownByTag.clear();
    for (const notification of shown) notification.close();
    clearBadge();
  });
  host.onBeforeQuit(clearBadge);
}
