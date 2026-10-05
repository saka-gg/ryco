import { hostedHubController, hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  HostedHubSession,
  type HostedHubSessionInvalidation,
  type HostedHubSessionStatus,
  type RelaySocket,
} from "@ryco/client-runtime/relay";
import { createBrowserRelaySocket, hostedHubSessionWebSocketUrl } from "./relaySocket";

let session: HostedHubSession | null = null;
let authority: string | null = null;
let status: HostedHubSessionStatus = "closed";
let stopWatching: (() => void) | null = null;
const invalidations = new Set<(event: HostedHubSessionInvalidation) => void>();

export function subscribeWebHubInvalidation(
  listener: (event: HostedHubSessionInvalidation) => void,
): () => void {
  invalidations.add(listener);
  return () => invalidations.delete(listener);
}

export function isWebHubSessionOnline(): boolean {
  return status === "online";
}

function disposeSession(): void {
  const previous = session;
  session = null;
  authority = null;
  status = "closed";
  previous?.dispose();
}

/** The physical socket belongs to the authenticated browser, never a route or node. */
export function watchWebHostedHubSession(): () => void {
  if (stopWatching) return stopWatching;
  const sync = () => {
    const state = hostedHubStore.getState();
    if (state.accountStatus === "signed-out" || state.accountStatus === "session-expired") {
      disposeSession();
      return;
    }
    if (state.accountStatus !== "authenticated" || !state.account || !state.session) return;
    const nextAuthority = JSON.stringify([
      state.account.id,
      state.session.id,
      state.session.activeSpaceId ?? null,
    ]);
    if (authority === nextAuthority && session) return;
    disposeSession();
    authority = nextAuthority;
    const current = () => session === next;
    const next = new HostedHubSession({
      createSocket: () => createBrowserRelaySocket(hostedHubSessionWebSocketUrl()),
      timers: {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (timer) => globalThis.clearTimeout(timer as number),
        queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
      },
      onStatus: (value) => {
        if (current()) status = value;
      },
      onInvalidate: (event) => {
        if (!current()) return;
        if (event.directory) hostedHubController.notifyDirectoryInvalidated();
        for (const listener of invalidations) listener(event);
      },
      onFailure: (failure) => {
        if (!current()) return;
        if (failure.kind === "authentication") {
          void hostedHubController.expireSession();
        } else if (!failure.retryable) {
          hostedHubController.failure(hostedHubStore.getState().generation, failure);
        }
      },
    });
    session = next;
    next.start();
  };
  const unsubscribe = hostedHubStore.subscribe(sync);
  stopWatching = () => {
    unsubscribe();
    stopWatching = null;
    disposeSession();
  };
  sync();
  return stopWatching;
}

export function createWebHubRelaySocket(): RelaySocket {
  if (!session || hostedHubStore.getState().accountStatus !== "authenticated") {
    throw new Error("An authenticated Hub session is required.");
  }
  return session.createSocket();
}
