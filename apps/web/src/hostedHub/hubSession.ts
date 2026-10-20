import { hostedHubController, hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  HostedHubSession,
  type HostedHubSessionIdentity,
  type HostedHubSessionInvalidation,
  type HostedHubSessionStatus,
  type RelaySocket,
} from "@ryco/client-runtime/relay";
import { RelayNodeId } from "@ryco/contracts/relay";
import * as Schema from "effect/Schema";
import { createBrowserRelaySocket, hostedHubSessionWebSocketUrl } from "./relaySocket";

const isRelayNodeId = Schema.is(RelayNodeId);

let session: HostedHubSession | null = null;
/**
 * The account, browser session and Space the session belongs to; null while a
 * session opened beside an access check waits for its answer.
 */
let authority: string | null = null;
let status: HostedHubSessionStatus = "closed";
let stopWatching: (() => void) | null = null;
/** The access check an unbound session waits for; see {@link openWebHubSessionBesideAccessCheck}. */
let awaitedAccessCheck: Promise<void> | null = null;
/** What an unbound session was told to invalidate, delivered once it is bound. */
let heldInvalidation: HostedHubSessionInvalidation | null = null;
const invalidations = new Set<(event: HostedHubSessionInvalidation) => void>();

export function subscribeWebHubInvalidation(
  listener: (event: HostedHubSessionInvalidation) => void,
): () => void {
  invalidations.add(listener);
  return () => invalidations.delete(listener);
}

export function isWebHubSessionOnline(): boolean {
  return status === "online" && authority !== null;
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
  awaitedAccessCheck = null;
  heldInvalidation = null;
  previous?.dispose();
}

function deliverInvalidation(event: HostedHubSessionInvalidation): void {
  if (event.directory) hostedHubController.notifyDirectoryInvalidated();
  for (const listener of invalidations) listener(event);
}

/**
 * The account socket. `expectedIdentity` is the account and browser session
 * the access check answered, or null for a socket opened before that answer,
 * which `sync` binds once it arrives.
 */
function openSession(expectedIdentity: HostedHubSessionIdentity | null): void {
  const current = () => session === next;
  const unbound = () => authority === null;
  const next = new HostedHubSession({
    // Server-minted streams are bound to exactly the session this tab restored; a socket the
    // Hub authenticated as anyone else opens none and sends the session back to its owner.
    ...(expectedIdentity ? { expectedIdentity } : {}),
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
      if (unbound()) {
        heldInvalidation = {
          directory: event.directory || heldInvalidation?.directory === true,
          threadCache: event.threadCache || heldInvalidation?.threadCache === true,
        };
        return;
      }
      deliverInvalidation(event);
    },
    onFailure: (failure) => {
      if (!current()) return;
      if (unbound()) {
        // A socket nobody is bound to yet reports nothing: it closes on a
        // rejection, the access check's own answer decides about the session,
        // and an authenticated answer opens a fresh socket.
        if (failure.kind === "authentication" || !failure.retryable) disposeSession();
      } else if (failure.kind === "authentication") {
        void hostedHubController.expireSession();
      } else if (!failure.retryable) {
        // Every node channel rides this socket, so the failure reaches every
        // environment session the controller holds, not just the selected one.
        hostedHubController.reportHubSessionFailure(failure);
      }
    },
  });
  session = next;
  next.start();
}

/** The physical socket belongs to the authenticated browser, never a route or node. */
export function watchWebHostedHubSession(): () => void {
  if (stopWatching) return stopWatching;
  const sync = () => {
    const state = hostedHubStore.getState();
    const authenticated =
      state.accountStatus === "authenticated" && state.account !== null && state.session !== null;
    // A socket opened beside an access check waits for that check: until it
    // answers, the store still shows the account as it was before it.
    if (session && authority === null && awaitedAccessCheck && !authenticated) return;
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
    const identity = { accountId: state.account.id, sessionId: state.session.id };
    if (session && authority === null && session.bindExpectedIdentity(identity)) {
      // The early socket was authenticated as exactly this session (or has not
      // heard from the Hub yet, which then checks its `ready` against it).
      authority = nextAuthority;
      awaitedAccessCheck = null;
      const held = heldInvalidation;
      heldInvalidation = null;
      if (held) {
        // This runs inside the access check's own publish, before that check
        // commits the directory read it sent beside the session restore. A
        // directory invalidation delivered here would find no read in flight,
        // send a second one and make the check drop its own; a microtask later
        // it is a follow-up to that read instead.
        const bound = session;
        globalThis.queueMicrotask(() => {
          if (session === bound && authority !== null) deliverInvalidation(held);
        });
      }
      return;
    }
    disposeSession();
    authority = nextAuthority;
    openSession(identity);
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

/**
 * Open the account socket beside an access check that is still on the wire,
 * for a browser that was signed in at its last check: the WebSocket upgrade
 * and the Hub's `ready` then overlap the check instead of following its answer.
 *
 * The socket is bound to nobody until the check answers. It opens no stream
 * (relay sockets require an authenticated account), delivers no invalidation
 * and counts as no live subscription. An authenticated answer binds it to the
 * account and session that answer names, replacing it if its `ready` named
 * anyone else; any other answer closes it. Requires the watcher; does nothing
 * when a socket already exists.
 */
export function openWebHubSessionBesideAccessCheck(accessCheck: Promise<void>): void {
  if (!stopWatching || session) return;
  if (hostedHubStore.getState().accountStatus === "authenticated") return;
  awaitedAccessCheck = accessCheck;
  openSession(null);
  const opened = session;
  const settle = () => {
    if (session !== opened || awaitedAccessCheck !== accessCheck) return;
    awaitedAccessCheck = null;
    if (authority === null) disposeSession();
  };
  void accessCheck.then(settle, settle);
}

/** The account socket, once it is bound to the authenticated account; see `sync`. */
function authenticatedSession(): HostedHubSession | null {
  return session !== null &&
    authority !== null &&
    hostedHubStore.getState().accountStatus === "authenticated"
    ? session
    : null;
}

export function createWebHubRelaySocket(): RelaySocket {
  const current = authenticatedSession();
  if (!current) throw new Error("An authenticated Hub session is required.");
  return current.createSocket();
}

/**
 * Whether the next relay channel can be authenticated by the Hub itself over the account socket
 * (Hub session version 2), skipping the HTTP ticket request.
 */
export function isWebHubServerAuthenticatedRelayAvailable(): boolean {
  return authenticatedSession()?.serverMintedOpenAvailable() === true;
}

/** A logical stream the Hub authenticates with a ticket it mints and consumes itself. */
export function createWebHubServerAuthenticatedRelaySocket(open: {
  readonly nodeId: string;
  readonly protocolMinor: 2 | 3;
}): RelaySocket {
  const current = authenticatedSession();
  if (!current) throw new Error("An authenticated Hub session is required.");
  if (!isRelayNodeId(open.nodeId)) throw new Error("Invalid hosted node id.");
  return current.createSocket({
    serverMinted: { nodeId: open.nodeId, protocolMinor: open.protocolMinor },
  });
}
