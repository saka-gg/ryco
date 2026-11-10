import type { HostedHubSessionStatus } from "./hostedHubSession.ts";
import type { RelaySocket } from "./relayEngine.ts";

/**
 * When a native app (iPhone, Mac) holds its DPoP-authenticated account session socket
 * (docs/hub-session-protocol.md, "Native sessions"), over injected dependencies:
 *
 * - open while signed in, on a Hub that announced the native session, and only in the
 *   foreground; replaced when the account, session or Space changes;
 * - in the background, kept exactly as long as a machine channel still rides it (the app's own
 *   background rules decide how long channels stay) and closed with the last one;
 * - streams are handed out only while it is online; an attempt made while it connects or
 *   reconnects opens its own socket, as before;
 * - a refused credential closes it and hands the session back to its owner to revalidate; it is
 *   opened again after that (a rotated token keeps its session) but at most once per
 *   {@link NATIVE_HUB_SESSION_REFUSED_RETRY_MS} for the same account, so a Hub that keeps refusing
 *   costs one attempt a minute while channels use sockets of their own.
 *
 * @module relay/nativeHubSessionManager
 */

/** The part of `HostedHubSession` the manager drives. */
export interface ManagedHubSession {
  start(): void;
  dispose(): void;
  probe(): void;
  resume(): void;
  createSocket(): RelaySocket;
}

export const NATIVE_HUB_SESSION_REFUSED_RETRY_MS = 60_000;

export interface HubSessionManagerDeps {
  /** Who is signed in, or null; a change of it replaces the session. */
  readonly authority: () => string | null;
  /** The Hub announced the native session in its last directory answer. */
  readonly announced: () => boolean;
  readonly isForeground: () => boolean;
  /**
   * A session reporting to `events`; `null` when the account session socket URL is unknown
   * (hosted mode not configured).
   */
  readonly create: (events: {
    readonly onStatus: (status: HostedHubSessionStatus) => void;
    readonly onDirectoryInvalidated: () => void;
    readonly onFailure: (failure: { readonly kind: string; readonly retryable: boolean }) => void;
  }) => ManagedHubSession | null;
  readonly onDirectoryInvalidated: () => void;
  /** The Hub refused the session's credentials; resolves once the owner checked them. */
  readonly revalidateSession: () => Promise<unknown> | void;
  readonly now: () => number;
}

export interface HubSessionManager {
  /** Open, keep or close the session to match the current state. */
  readonly sync: () => void;
  /** A new network path: check the socket now. */
  readonly networkChanged: () => void;
  readonly isOnline: () => boolean;
  readonly probe: () => void;
  /** A stream factory while online, else undefined (the channel opens its own socket). */
  readonly streamFactory: () => (() => RelaySocket) | undefined;
  readonly dispose: () => void;
}

export function createHubSessionManager(deps: HubSessionManagerDeps): HubSessionManager {
  let session: ManagedHubSession | null = null;
  let status: HostedHubSessionStatus = "closed";
  let authority: string | null = null;
  /** Machine channels riding the current session. */
  let liveStreams = 0;
  /** The account whose session the Hub refused, and when. */
  let refused: { readonly authority: string; readonly at: number } | null = null;

  const dispose = () => {
    const previous = session;
    session = null;
    status = "closed";
    authority = null;
    liveStreams = 0;
    previous?.dispose();
  };

  const open = (nextAuthority: string) => {
    let created: ManagedHubSession | null = null;
    created = deps.create({
      onStatus: (value) => {
        if (session === created) status = value;
      },
      onDirectoryInvalidated: () => {
        if (session === created) deps.onDirectoryInvalidated();
      },
      onFailure: (failure) => {
        if (session !== created) return;
        // Channels reconnect on sockets of their own until a session is back.
        if (failure.kind === "authentication") {
          refused = { authority: nextAuthority, at: deps.now() };
          dispose();
          void Promise.resolve(deps.revalidateSession()).then(sync, sync);
        } else if (!failure.retryable) {
          dispose();
        }
      },
    });
    if (created === null) return;
    session = created;
    authority = nextAuthority;
    created.start();
  };

  const sync = () => {
    const nextAuthority = deps.authority();
    if (nextAuthority === null || !deps.announced()) {
      dispose();
      return;
    }
    if (!deps.isForeground()) {
      // Kept while channels still ride it (the app's background stay), never opened here.
      if (session !== null && (liveStreams === 0 || authority !== nextAuthority)) dispose();
      return;
    }
    if (session !== null && authority === nextAuthority) return;
    if (
      session === null &&
      refused?.authority === nextAuthority &&
      deps.now() - refused.at < NATIVE_HUB_SESSION_REFUSED_RETRY_MS
    ) {
      return;
    }
    dispose();
    open(nextAuthority);
  };

  return {
    sync,
    networkChanged: () => session?.resume(),
    isOnline: () => session !== null && status === "online",
    probe: () => session?.probe(),
    streamFactory: () => {
      const current = session;
      if (current === null || status !== "online") return undefined;
      return () => {
        const stream = current.createSocket();
        liveStreams += 1;
        let ended = false;
        stream.onClose(() => {
          if (ended) return;
          ended = true;
          if (session !== current) return;
          liveStreams -= 1;
          if (liveStreams === 0) sync();
        });
        return stream;
      };
    },
    dispose,
  };
}
