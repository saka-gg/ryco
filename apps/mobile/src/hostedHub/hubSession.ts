import {
  getHostedHubApi,
  HUB_NATIVE_SESSION_FEATURE,
  hostedHubController,
  hostedHubStore,
} from "@ryco/client-runtime/authorization";
import { HostedHubSession, type RelaySocket } from "@ryco/client-runtime/relay";
import { createDeferredHubSessionSocket } from "@ryco/client-runtime/relay/deferredHubSessionSocket";
import {
  createHubSessionManager,
  type HubSessionManager,
} from "@ryco/client-runtime/relay/nativeHubSessionManager";
import { HUB_SESSION_PATH } from "@ryco/contracts/hub-session";

import { mobileAppLifecycle } from "../platform/appLifecycle";
import {
  defaultCreateSocket,
  prepareMobileUpgradeHeaders,
  setMobileRelayChannelsRideSession,
} from "./relaySocket";
import { getMobileHostedConfig } from "./runtimeConfig";

/**
 * The phone's account session socket (docs/hub-session-protocol.md, "Native sessions"): one
 * DPoP-authenticated WebSocket to the Hub that carries a logical stream per machine, instead of a
 * TLS socket of its own per machine, and pushes `invalidate` when the machine list changes, so
 * the directory is re-read on change rather than polled every 20 s.
 *
 * Open while hosted mode is configured, the account is signed in and the Hub announced
 * {@link HUB_NATIVE_SESSION_FEATURE} in its last directory answer; opened only in the foreground.
 * In the background it stays exactly as long as a machine channel still rides it — the app's
 * background stay decides how long channels are kept — and closes with the last one (at once
 * when none does). An older Hub announces nothing and this never opens; the app then keeps its
 * per-machine sockets and polling exactly as before. Each machine's channel still authenticates
 * with its own ticket and runs its own E2EE: the session grants no node authority.
 *
 * Relay attempts use the session only while it is online; one made while it connects or
 * reconnects opens its own socket, as before. The rules live in `@ryco/client-runtime/relay/nativeHubSessionManager`.
 */

let manager: HubSessionManager | null = null;
let stopWatching: (() => void) | null = null;

/** The account session socket URL (`wss://<hub>/v1/relay/session`), or null when not hosted. */
export function mobileHostedHubSessionUrl(): string | null {
  const config = getMobileHostedConfig();
  if (config === null) return null;
  const url = new URL(config.hubOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = HUB_SESSION_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Whether the account session is up and carries invalidations and channels. */
export function isMobileHubSessionOnline(): boolean {
  return manager?.isOnline() ?? false;
}

/** Ask the account session to prove it is alive now (see `HostedHubSession.probe`). */
export function probeMobileHubSession(): void {
  manager?.probe();
}

/** A stream factory while the account session is online; else undefined (own socket). */
export function mobileHubSessionStreamFactory(): (() => RelaySocket) | undefined {
  return manager?.streamFactory();
}

function createManager(): HubSessionManager {
  return createHubSessionManager({
    authority: () => {
      const state = hostedHubStore.getState();
      if (state.accountStatus !== "authenticated" || !state.account || !state.session) return null;
      return JSON.stringify([
        state.account.id,
        state.session.id,
        state.session.activeSpaceId ?? null,
      ]);
    },
    announced: () => getHostedHubApi().hubFeatures().includes(HUB_NATIVE_SESSION_FEATURE),
    isForeground: () => mobileAppLifecycle.isForeground(),
    create: (events) => {
      const url = mobileHostedHubSessionUrl();
      if (url === null) return null;
      return new HostedHubSession({
        createSocket: (protocols) =>
          createDeferredHubSessionSocket(async () => {
            const headers = await prepareMobileUpgradeHeaders({ url });
            return defaultCreateSocket(url, headers, protocols);
          }),
        timers: {
          now: () => Date.now(),
          setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
          clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
          queueMicrotask: (callback) =>
            typeof globalThis.queueMicrotask === "function"
              ? globalThis.queueMicrotask(callback)
              : void Promise.resolve().then(callback),
        },
        onStatus: events.onStatus,
        onInvalidate: (event) => {
          if (event.directory) events.onDirectoryInvalidated();
        },
        onFailure: events.onFailure,
      });
    },
    onDirectoryInvalidated: () => hostedHubController.notifyDirectoryInvalidated(),
    revalidateSession: () => hostedHubController.revalidateSession(),
    now: () => Date.now(),
  });
}

/** Keep the account session open exactly while it is wanted (see the module comment). */
export function watchMobileHubSession(): () => void {
  if (stopWatching) return stopWatching;
  const current = createManager();
  manager = current;
  setMobileRelayChannelsRideSession(current.isOnline);
  const unsubscribeStore = hostedHubStore.subscribe(current.sync);
  const unsubscribeFeatures = getHostedHubApi().subscribeHubFeatures(current.sync);
  const unsubscribeLifecycle = mobileAppLifecycle.subscribe((event) => {
    if (event === "background" || event === "foreground") current.sync();
    else if (event === "network-changed") current.networkChanged();
  });
  stopWatching = () => {
    unsubscribeStore();
    unsubscribeFeatures();
    unsubscribeLifecycle();
    setMobileRelayChannelsRideSession(() => false);
    current.dispose();
    if (manager === current) manager = null;
    stopWatching = null;
  };
  current.sync();
  return stopWatching;
}
