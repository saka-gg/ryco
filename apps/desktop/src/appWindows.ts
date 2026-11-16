/**
 * The app's own windows: one per `createWindow` in main.ts, each loading the app with its
 * preload. Electron's `BrowserWindow.getAllWindows()` also lists windows that are not the app:
 * the embedded browser's tab hosts (hidden until a tab is popped out, and kept until the tab is
 * closed or the app quits), the computer-use overlays and sign-in popups. Whatever counts app
 * windows or picks one to show, focus or message goes through this registry instead.
 */

export interface AppWindowLike {
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
}

export interface AppWindowRegistry<W extends AppWindowLike> {
  /** Records `window` as an app window until it closes. */
  track(window: W): void;
  /** Whether `window` is an app window that is still open. */
  has(window: W | null | undefined): window is W;
  /** The open app windows, oldest first. */
  list(): W[];
  /** The first of `preferred` that is an open app window, else the oldest one; null when none is open. */
  pick(...preferred: ReadonlyArray<W | null | undefined>): W | null;
}

export function createAppWindowRegistry<W extends AppWindowLike>(options: {
  /**
   * The last app window closed. Other windows may still be open: Electron's `window-all-closed`
   * waits for those too, so it cannot tell that the app has no window left.
   */
  readonly onLastClosed: () => void;
}): AppWindowRegistry<W> {
  const windows = new Set<W>();
  const has = (window: W | null | undefined): window is W =>
    window != null && windows.has(window) && !window.isDestroyed();
  const list = () => [...windows].filter((window) => !window.isDestroyed());
  return {
    track: (window) => {
      if (windows.has(window)) return;
      windows.add(window);
      window.once("closed", () => {
        if (!windows.delete(window)) return;
        if (windows.size === 0) options.onLastClosed();
      });
    },
    has,
    list,
    pick: (...preferred) => preferred.find(has) ?? list()[0] ?? null,
  };
}
