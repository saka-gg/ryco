import type { AppLifecycleEvent, AppLifecycleService } from "@ryco/client-runtime/platform";
import * as Network from "expo-network";
import { AppState, type AppStateStatus } from "react-native";

// iOS suspends WebSockets on background and the runtime only models resume via
// AppLifecycle "resume" + the supervisor's reconnectAfterResume heartbeat. So
// the mobile adapter drives resume aggressively: every foreground transition
// emits BOTH "foreground" and "resume" so the supervisor re-checks and
// reconnects the socket the OS tore down while backgrounded.

// Cached connectivity so the synchronous `isOnline()` contract can be answered
// without awaiting a network probe. Optimistically online until proven offline.
let cachedOnline = true;
const listeners = new Set<(event: AppLifecycleEvent) => void>();
let stopNativeSubscriptions: (() => void) | undefined;

function emit(event: AppLifecycleEvent): void {
  for (const listener of listeners) listener(event);
}

function isConnected(state: Network.NetworkState): boolean {
  // `undefined` (unknown) is treated as online: the runtime prefers attempting
  // a connection over refusing one on an ambiguous signal.
  return state.isConnected !== false;
}

function subscribeNative(): () => void {
  let lastForeground = AppState.currentState === "active";
  let disposed = false;
  let networkRevision = 0;

  const publishNetworkState = (state: Network.NetworkState) => {
    const online = isConnected(state);
    if (online === cachedOnline) return;
    cachedOnline = online;
    emit(online ? "online" : "offline");
  };

  const refreshNetworkState = () => {
    const revision = ++networkRevision;
    void Network.getNetworkStateAsync()
      .then((state) => {
        // OS notifications and later probes supersede this asynchronous result.
        if (!disposed && revision === networkRevision) publishNetworkState(state);
      })
      .catch(() => undefined);
  };

  const appStateSubscription = AppState.addEventListener("change", (next: AppStateStatus) => {
    if (disposed) return;
    const nowForeground = next === "active";
    const wasForeground = lastForeground;
    lastForeground = nowForeground;
    if (nowForeground && !wasForeground) {
      // Connectivity changes can be missed while iOS suspends the app.
      refreshNetworkState();
      emit("foreground");
      emit("resume");
    } else if (!nowForeground && wasForeground) {
      emit("background");
    }
  });

  const networkSubscription = Network.addNetworkStateListener((state) => {
    if (disposed) return;
    ++networkRevision;
    publishNetworkState(state);
  });
  refreshNetworkState();

  return () => {
    disposed = true;
    appStateSubscription.remove();
    networkSubscription.remove();
  };
}

export const mobileAppLifecycle: AppLifecycleService = {
  isForeground: () => AppState.currentState === "active",
  isOnline: () => cachedOnline,
  subscribe: (listener) => {
    // One native source updates the cache and broadcasts to every consumer.
    // Per-consumer native listeners would let the first consume the transition.
    const subscriber = (event: AppLifecycleEvent) => listener(event);
    listeners.add(subscriber);
    stopNativeSubscriptions ??= subscribeNative();

    return () => {
      listeners.delete(subscriber);
      if (listeners.size === 0) {
        stopNativeSubscriptions?.();
        stopNativeSubscriptions = undefined;
      }
    };
  },
};
