import { hostedHubController, hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  HostedHubSession,
  type HostedHubSessionInvalidation,
  type HostedHubSessionStatus,
  type RelaySocket,
} from "@ryco/client-runtime/relay";
import { RelayNodeId } from "@ryco/contracts/relay";
import * as Schema from "effect/Schema";
import { createBrowserRelaySocket, hostedHubSessionWebSocketUrl } from "./relaySocket";

const isRelayNodeId = Schema.is(RelayNodeId);

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

/**
 * Ask the account socket to prove it is alive now. Called on signals that a
 * network path may have changed under a socket that still looks open; a dead
 * one fails through the session's own loss path and reconnects.
 */
export function probeWebHubSession(): void {
  session?.probe();
}

/**
 * A foreground, `online` or network-change signal: an account socket waiting
 * out its reconnect backoff connects at once, and a live-looking one is probed
 * (or replaced at once when it has been silent past the liveness bound). See
 * `HostedHubSession.resume`.
 */
export function resumeWebHubSession(): void {
  session?.resume();
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
      // Server-minted streams are bound to exactly the session this tab restored; a socket the
      // Hub authenticated as anyone else opens none and sends the session back to its owner.
      expectedIdentity: { accountId: state.account.id, sessionId: state.session.id },
      onIdentityMismatch: () => {
        if (current()) void hostedHubController.revalidateSession();
      },
      createSocket: (protocols) =>
        createBrowserRelaySocket(hostedHubSessionWebSocketUrl(), undefined, undefined, protocols),
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

/**
 * Whether the next relay channel can be authenticated by the Hub itself over the account socket
 * (Hub session version 2), skipping the HTTP ticket request.
 */
export function isWebHubServerAuthenticatedRelayAvailable(): boolean {
  return (
    session?.serverMintedOpenAvailable() === true &&
    hostedHubStore.getState().accountStatus === "authenticated"
  );
}

/** A logical stream the Hub authenticates with a ticket it mints and consumes itself. */
export function createWebHubServerAuthenticatedRelaySocket(open: {
  readonly nodeId: string;
  readonly protocolMinor: 2 | 3;
}): RelaySocket {
  if (!session || hostedHubStore.getState().accountStatus !== "authenticated") {
    throw new Error("An authenticated Hub session is required.");
  }
  if (!isRelayNodeId(open.nodeId)) throw new Error("Invalid hosted node id.");
  return session.createSocket({
    serverMinted: { nodeId: open.nodeId, protocolMinor: open.protocolMinor },
  });
}
