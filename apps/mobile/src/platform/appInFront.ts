import { mobileAppLifecycle } from "./appLifecycle";

/**
 * Whether the app is in front, by the app-wide lifecycle: only `background`
 * leaves the app. A Notification Center or Control Center pull, the app
 * switcher peek or a system alert (`inactive`) keeps it in front: its sockets
 * stay open and it may show its own alerts.
 *
 * Thread alerts, push presence and the widgets all ask this one test, so a
 * machine never pushes for a screen the person is looking at (presence said
 * "foreground", local alerts cover it) and never stays quiet while the app is
 * really in the background (presence said "background" the moment it went).
 */
export function isAppInFront(): boolean {
  return mobileAppLifecycle.isForeground();
}

/** Calls `listener` when the app comes to the front or goes to the background. */
export function subscribeAppInFront(listener: (inFront: boolean) => void): () => void {
  return mobileAppLifecycle.subscribe((event) => {
    if (event === "foreground" || event === "background") listener(event === "foreground");
  });
}
