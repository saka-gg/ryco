import type { AppLifecycleEvent, AppLifecycleService } from "@ryco/client-runtime/platform";
import * as Network from "expo-network";
import { AppState, type AppStateStatus } from "react-native";

// iOS suspends WebSockets on background and the runtime only models resume via
// AppLifecycle "resume" + the supervisor's reconnectAfterResume heartbeat. So
// the mobile adapter drives resume aggressively: every return from background
// emits BOTH "foreground" and "resume" so the supervisor re-checks and
// reconnects the socket the OS tore down while backgrounded.
//
// Only `background` means the OS may suspend the process. iOS also reports
// `inactive` for Notification Center and Control Center pulls, the app-switcher
// peek, system alerts and call UI; the process keeps running and its sockets
// stay open, so `inactive` is treated as still in the foreground and neither
// entering nor leaving it emits an event. iOS returns from background through
// `inactive` before `active`, which is why leaving `background` is only
// observed on `active`.

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

function isBackground(state: AppStateStatus): boolean {
  return state === "background";
}

function subscribeNative(): () => void {
  let backgrounded = isBackground(AppState.currentState);
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
    if (isBackground(next)) {
      if (backgrounded) return;
      backgrounded = true;
      emit("background");
    } else if (next === "active" && backgrounded) {
      backgrounded = false;
      // Connectivity changes can be missed while iOS suspends the app.
      refreshNetworkState();
      emit("foreground");
      emit("resume");
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
  isForeground: () => !isBackground(AppState.currentState),
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
