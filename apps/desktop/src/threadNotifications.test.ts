import { describe, expect, it, vi } from "vite-plus/test";

import { THREAD_NOTIFICATION_IPC } from "./threadNotificationChannels.ts";
import {
  installThreadNotificationIpc,
  type ThreadNotificationHost,
  type ThreadNotificationWindow,
} from "./threadNotifications.ts";

const notification = {
  threadId: "thread-1",
  environmentId: "environment-1",
  tag: "0123456789abcdef",
  title: "Finished",
  body: "Fix the login bug",
};
const overlayImage = "data:image/png;base64,iVBORw0KGgo=";

interface FakeWindow extends ThreadNotificationWindow {
  focused: boolean;
  readonly sent: Array<ReadonlyArray<unknown>>;
}

function fakeWindow(): FakeWindow {
  const sent: Array<ReadonlyArray<unknown>> = [];
  return {
    focused: false,
    sent,
    isDestroyed: () => false,
    isFocused() {
      return this.focused;
    },
    webContents: { send: (...args: unknown[]) => sent.push(args) },
  };
}

/** Main's thread notification IPC on a fake Electron. */
function harness(platform: NodeJS.Platform = "darwin") {
  type Handler = (event: unknown, ...args: readonly unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const window = fakeWindow();
  const focusListeners: Array<() => void> = [];
  const quitListeners: Array<() => void> = [];
  const shown: Array<{
    readonly title: string;
    readonly body: string;
    readonly onClick: () => void;
    readonly close: ReturnType<typeof vi.fn>;
  }> = [];
  let supported = true;
  const host = {
    platform,
    ipcMain: {
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    onWindowFocus: (listener) => focusListeners.push(listener),
    onBeforeQuit: (listener) => quitListeners.push(listener),
    getMainWindow: () => window,
    getAllWindows: () => [window],
    revealWindow: vi.fn(),
    notificationsSupported: () => supported,
    showNotification: ({ title, body, onClick, onClose }) => {
      const entry = { title, body, onClick, close: vi.fn(onClose) };
      shown.push(entry);
      return entry;
    },
    setBadgeCount: vi.fn(),
    setOverlayIcon: vi.fn(),
  } satisfies ThreadNotificationHost<FakeWindow>;
  installThreadNotificationIpc(host);
  const invoke = (channel: string, payload: unknown) => handlers.get(channel)?.({}, payload);

  return {
    host,
    window,
    shown,
    notify: (payload: unknown) => invoke(THREAD_NOTIFICATION_IPC.notify, payload),
    setBadge: (payload: unknown) => invoke(THREAD_NOTIFICATION_IPC.setBadge, payload),
    setSupported: (next: boolean) => {
      supported = next;
    },
    focusWindow: () => focusListeners.forEach((listener) => listener()),
    quit: () => quitListeners.forEach((listener) => listener()),
  };
}

describe("thread notifications", () => {
  it("shows one silent notification per thread", () => {
    const test = harness();
    expect(test.notify(notification)).toBe("shown");
    expect(test.notify({ ...notification, title: "Needs approval" })).toBe("shown");

    expect(test.shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "Finished", body: "Fix the login bug" },
      { title: "Needs approval", body: "Fix the login bug" },
    ]);
    expect(test.shown[0]?.close).toHaveBeenCalled();
    expect(test.shown[1]?.close).not.toHaveBeenCalled();
  });

  it("leaves the alert to the app while its window has focus", () => {
    const test = harness();
    test.window.focused = true;
    expect(test.notify(notification)).toBe("window-focused");
    expect(test.shown).toEqual([]);
  });

  it("says so where the OS shows no notifications", () => {
    const test = harness();
    test.setSupported(false);
    expect(test.notify(notification)).toBe("unsupported");
    expect(test.shown).toEqual([]);
  });

  it("opens the thread when a notification is clicked", () => {
    const test = harness();
    test.notify(notification);
    test.shown[0]?.onClick();

    expect(test.host.revealWindow).toHaveBeenCalledWith(test.window);
    expect(test.window.sent).toEqual([
      [THREAD_NOTIFICATION_IPC.activated, { environmentId: "environment-1", threadId: "thread-1" }],
    ]);
  });

  it("rejects malformed notifications", () => {
    const test = harness();
    for (const payload of [
      null,
      { ...notification, title: "  " },
      { ...notification, tag: "not-a-tag" },
      { ...notification, environmentId: undefined },
      { ...notification, body: "x".repeat(241) },
    ]) {
      expect(() => test.notify(payload)).toThrow();
    }
    expect(test.shown).toEqual([]);
  });

  it("rejects malformed badges", () => {
    const test = harness("win32");
    for (const payload of [
      { count: -1, image: null },
      { count: 1.5, image: null },
      { count: 1, image: "data:image/jpeg;base64,AAAA" },
      { count: 1, image: `data:image/png;base64,${"A".repeat(16_384)}` },
    ]) {
      expect(() => test.setBadge(payload)).toThrow();
    }
    expect(test.host.setOverlayIcon).not.toHaveBeenCalled();
  });

  it("counts on the dock or launcher on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const test = harness(platform);
      test.setBadge({ count: 2, image: null });
      expect(test.host.setBadgeCount).toHaveBeenLastCalledWith(2);
      expect(test.host.setOverlayIcon).not.toHaveBeenCalled();
    }
  });

  it("draws the renderer's overlay on the Windows taskbar", () => {
    const test = harness("win32");
    test.setBadge({ count: 3, image: overlayImage });
    expect(test.host.setOverlayIcon).toHaveBeenLastCalledWith(
      test.window,
      overlayImage,
      "3 thread alerts",
    );

    test.setBadge({ count: 0, image: null });
    expect(test.host.setOverlayIcon).toHaveBeenLastCalledWith(test.window, null, "");
    expect(test.host.setBadgeCount).not.toHaveBeenCalled();
  });

  it("shows no badge while a window has focus", () => {
    const test = harness();
    test.window.focused = true;
    test.setBadge({ count: 1, image: null });

    expect(test.host.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(test.window.sent).toEqual([[THREAD_NOTIFICATION_IPC.badgeCleared]]);
  });

  it("clears the badge and the notifications when a window gets focus", () => {
    const test = harness();
    test.notify(notification);
    test.setBadge({ count: 1, image: null });

    test.focusWindow();
    expect(test.shown[0]?.close).toHaveBeenCalled();
    expect(test.host.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(test.window.sent).toEqual([[THREAD_NOTIFICATION_IPC.badgeCleared]]);
  });

  it("clears the badge before quitting", () => {
    const test = harness();
    test.setBadge({ count: 4, image: null });
    test.quit();
    expect(test.host.setBadgeCount).toHaveBeenLastCalledWith(0);
  });
});
