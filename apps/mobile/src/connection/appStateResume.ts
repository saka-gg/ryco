import { AppState, type AppStateStatus } from "react-native";

/**
 * The supervisor's `subscribeBrowserResume` seam, bound to RN AppState. iOS
 * suspends the socket on background, so every background -> foreground
 * transition fires the listener; the supervisor then reconnects any connection
 * whose heartbeat is stale (its own cooldown prevents thrashing). This is the
 * aggressive resume drive the design spec's backgrounding finding calls for.
 *
 * Only `background` counts as leaving: iOS reports `inactive` for transient
 * interruptions (Notification Center, the app-switcher peek, call UI) that do
 * not suspend the process, and it also passes through `inactive` on the way
 * back from background. Neither starts or ends a resume cycle by itself.
 *
 * The returned unsubscribe is a bound wrapper over the subscription's `remove`
 * (the slice-3b "Illegal invocation" lesson — no unbound native method leaks).
 */
export function subscribeAppStateResume(listener: (reason: string) => void): () => void {
  let lastBackgroundedAt: number | null = null;
  const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
    if (next === "background") {
      lastBackgroundedAt = Date.now();
      return;
    }
    if (next === "active" && lastBackgroundedAt !== null) {
      lastBackgroundedAt = null;
      listener("appstate-active");
    }
  });
  return () => subscription.remove();
}
