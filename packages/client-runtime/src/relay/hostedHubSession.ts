import {
  HUB_SESSION_CLOSE_REASON_BYTES,
  HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS,
  HUB_SESSION_HEARTBEAT_INTERVAL_MS,
  HUB_SESSION_MAX_CHANNELS,
  HUB_SESSION_MAX_QUEUED_BYTES,
  HUB_SESSION_MAX_QUEUED_FRAMES,
  HUB_SESSION_PROTOCOL_VERSION,
  hubSessionSubprotocol,
  type HubSessionFrame,
  type HubSessionProtocolVersion,
} from "@ryco/contracts/hub-session";
import type { RelayNodeId } from "@ryco/contracts/relay";
import { bytesEqual } from "@ryco/shared/bytesEqual";
import { decodeHubSessionFrame, encodeHubSessionFrame } from "@ryco/shared/hubSessionCodec";
import type { RelaySocket, RelayTimers } from "./relayEngine.ts";

export interface HubSessionSocket extends RelaySocket {
  onClose(listener: (reason?: string, code?: number) => void): void;
}
export type HostedHubSessionInvalidation = {
  readonly directory: boolean;
  readonly threadCache: boolean;
};
export type HostedHubSessionStatus = "connecting" | "online" | "reconnecting" | "closed";
/** Who the Hub authenticated the account socket as; carried by a version 2 `ready`. */
export interface HostedHubSessionIdentity {
  readonly accountId: string;
  readonly sessionId: string;
}
/**
 * A logical stream the Hub authenticates itself (session version 2 `openNode`): it mints and
 * consumes the node ticket for this socket's session, so no ticket exists on the client.
 */
export interface HostedHubServerMintedOpen {
  readonly nodeId: RelayNodeId;
  readonly protocolMinor: 2 | 3;
}
/**
 * The close reason of a server-minted stream whose replacement connection negotiated a version
 * without `openNode`. Not a relay close reason, so the relay engine reports a retryable network
 * failure and its owner's next attempt buys an HTTP ticket instead.
 */
export const HUB_SESSION_SERVER_MINTED_UNAVAILABLE_REASON = "server-minted open unavailable";
/**
 * The close reason of a server-minted stream whose connection was authenticated as an account or
 * browser session other than the one the client restored (say, a sign-in in another tab replaced
 * the cookie). Nothing is opened under the other identity; the owner revalidates the session.
 */
export const HUB_SESSION_IDENTITY_MISMATCH_REASON = "session identity mismatch";
/**
 * How long the session offers no version subprotocol once stripping is confirmed.
 *
 * A proxy that strips `Sec-WebSocket-Protocol` makes browsers fail every handshake that offered
 * one, the version 1 path included. A browser cannot tell that apart from any other pre-open
 * failure (a Hub restart, a draining 503, a rate-limited 429 all look the same), so one failure
 * proves nothing. The rule is therefore: after a handshake offering the subprotocol fails before
 * opening, retry once offering none. If that one opens, stripping is only suspected: that
 * connection runs version 1, and the next reconnect offers again. Only if that offered handshake
 * also fails while the next one offering none opens is stripping confirmed and this latch set. If
 * a handshake offering none fails too, it was an outage, and every bit of evidence is dropped. A
 * deploy or restart therefore costs at most one version 1 connection, never a latch.
 */
export const HUB_SESSION_SUBPROTOCOL_FALLBACK_MS = 10 * 60_000;
/** The subprotocols the session offers: the highest version it decodes. */
export const HUB_SESSION_SUBPROTOCOLS: readonly string[] = Object.freeze([
  hubSessionSubprotocol(HUB_SESSION_PROTOCOL_VERSION),
]);
export interface HostedHubSessionOptions {
  /**
   * Open the physical socket offering `protocols` as its WebSocket subprotocols. They advertise
   * the highest session version this client decodes; the version in `ready` is the negotiated one.
   */
  readonly createSocket: (protocols: readonly string[]) => HubSessionSocket;
  readonly timers: RelayTimers;
  readonly random?: () => number;
  readonly onStatus?: (status: HostedHubSessionStatus) => void;
  readonly onFailure?: (failure: {
    readonly kind: "network" | "protocol" | "authentication";
    readonly retryable: boolean;
  }) => void;
  readonly onInvalidate?: (event: HostedHubSessionInvalidation) => void;
  /**
   * The account and browser session the owner restored and created this session for. A version
   * 2 `ready` must name exactly these, or the connection offers no server-minted opens and
   * {@link onIdentityMismatch} runs. Without it the session never offers server-minted opens:
   * `openNode` must name the session it expects. An owner that starts the session before it
   * knows the identity binds it later with {@link HostedHubSession.bindExpectedIdentity}.
   */
  readonly expectedIdentity?: HostedHubSessionIdentity;
  /** A version 2 `ready` named another identity; the owner should revalidate its session. */
  readonly onIdentityMismatch?: () => void;
}
interface LogicalStream {
  readonly id: number;
  readonly createdAt: number;
  state: number;
  opened: boolean;
  /** Opened with `openNode` rather than `open`; null for a stream that authenticates itself. */
  readonly serverMinted: HostedHubServerMintedOpen | null;
  readonly open: Set<() => void>;
  readonly message: Set<(bytes: Uint8Array) => void>;
  readonly close: Set<(reason?: string) => void>;
  readonly error: Set<() => void>;
}
interface QueuedFrame {
  readonly type: HubSessionFrame["type"];
  readonly bytes: Uint8Array;
}
/** Account-level frames that belong to no stream and may overtake stream frames. */
function isControlFrame(type: HubSessionFrame["type"]): boolean {
  return type === "ping" || type === "pong";
}
const SEND_HIGH_WATER_BYTES = 256 * 1_024;
const CONTROL_RESERVE_BYTES = 4 * 1_024;
const READY_TIMEOUT_MS = 10_000;
/**
 * How long a suspicion probe waits for any frame before the connection counts
 * as lost — the node connector's bound for the same question.
 */
export const HUB_SESSION_PROBE_TIMEOUT_MS = 5_000;
/**
 * How long a logical stream that was never opened may wait across lost
 * connections for a replacement `ready`. Its ticket is unused until the stream
 * opens, so carrying it to the next connection saves a ticket and a reconnect
 * of the relay attempt riding it; past this bound it is closed like any other
 * stream so its owner retries on its own schedule.
 */
const PENDING_STREAM_MAX_WAIT_MS = READY_TIMEOUT_MS;

/**
 * One account-owned physical connection; logical relay authorization and E2EE remain per node.
 * A stream authenticates with its own client-held ticket (`open`), or on a version 2 connection
 * with a ticket the Hub mints and consumes for it (`openNode`).
 */
export class HostedHubSession {
  readonly #options: HostedHubSessionOptions;
  readonly #streams = new Map<number, LogicalStream>();
  readonly #invalidations = new Set<(event: HostedHubSessionInvalidation) => void>();
  #socket: HubSessionSocket | null = null;
  #disposed = false;
  #started = false;
  #ready = false;
  /** What the current connection's `ready` negotiated; null until it arrives. */
  #protocolVersion: HubSessionProtocolVersion | null = null;
  #identity: HostedHubSessionIdentity | null = null;
  /** {@link HostedHubSessionOptions.expectedIdentity}, or the identity bound since. */
  #expectedIdentity: HostedHubSessionIdentity | undefined;
  /** The current connection offered the version subprotocol, and whether its socket opened. */
  #offered = true;
  #socketOpened = false;
  /** The previous handshake offering the subprotocol failed before opening; try without it. */
  #probingWithoutOffer = false;
  /** A handshake offering none opened right after one offering it failed; confirm next time. */
  #strippingSuspected = false;
  /** Until when handshakes offer no subprotocol; see {@link HUB_SESSION_SUBPROTOCOL_FALLBACK_MS}. */
  #noOfferUntil = 0;
  #nextStream = 0;
  #maxChannels = HUB_SESSION_MAX_CHANNELS;
  #failures = 0;
  #retry: unknown;
  #deadline: unknown;
  #heartbeat: unknown;
  #drain: unknown;
  #probeDeadline: unknown;
  #queue: QueuedFrame[] = [];
  #queueBytes = 0;
  #lastReceived = 0;
  #onlineAt = 0;
  #probeSequence = 0;
  #probe: Uint8Array | null = null;
  /** When the pending {@link #probe} ping left the queue; undefined while it waits in it. */
  #probeSentAt: number | undefined;
  /** Bytes handed to the current physical socket. */
  #handedBytes = 0;

  constructor(options: HostedHubSessionOptions) {
    this.#options = options;
    this.#expectedIdentity = options.expectedIdentity;
  }

  start(): void {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    this.#connect();
  }

  subscribeInvalidation(listener: (event: HostedHubSessionInvalidation) => void): () => void {
    this.#invalidations.add(listener);
    return () => this.#invalidations.delete(listener);
  }

  /**
   * Whether a logical stream created now could be opened with a server-minted ticket: the
   * connection is ready, negotiated version 2, and is not under a suspicion probe. Only a hint
   * for choosing how to authenticate: a stream created now that ends up on a replacement
   * connection without version 2 is closed retryably rather than opened.
   */
  serverMintedOpenAvailable(): boolean {
    return (
      !this.#disposed &&
      this.#ready &&
      this.#serverMintedOpensHere() &&
      this.#probeDeadline === undefined
    );
  }

  /**
   * Bind the identity of a session started without one: an owner that opened the connection
   * before its access check answered binds the account and browser session that answer named.
   * From then on the session behaves as if it had been created with
   * {@link HostedHubSessionOptions.expectedIdentity}: server-minted opens name it, and a later
   * `ready` naming anyone else runs {@link HostedHubSessionOptions.onIdentityMismatch}.
   *
   * Returns false and binds nothing when the session is closed, already expects another
   * identity, or the current connection's `ready` named someone else; the owner then replaces
   * the session rather than keep a connection authenticated as another identity.
   */
  bindExpectedIdentity(identity: HostedHubSessionIdentity): boolean {
    if (this.#disposed) return false;
    const sameAs = (other: HostedHubSessionIdentity | null | undefined) =>
      other?.accountId === identity.accountId && other.sessionId === identity.sessionId;
    if (this.#expectedIdentity !== undefined) return sameAs(this.#expectedIdentity);
    if (this.#ready && this.#identity !== null && !sameAs(this.#identity)) return false;
    this.#expectedIdentity = { accountId: identity.accountId, sessionId: identity.sessionId };
    return true;
  }

  /** This connection negotiated version 2 and was authenticated as the expected identity. */
  #serverMintedOpensHere(): boolean {
    const expected = this.#expectedIdentity;
    return (
      this.#protocolVersion !== null &&
      this.#protocolVersion >= 2 &&
      expected !== undefined &&
      this.#identity !== null &&
      this.#identity.accountId === expected.accountId &&
      this.#identity.sessionId === expected.sessionId
    );
  }

  /**
   * The account and browser session the Hub authenticated the current connection as (version 2
   * `ready`), or null before `ready`, on version 1, or after the connection is lost.
   */
  readyIdentity(): HostedHubSessionIdentity | null {
    return this.#ready ? this.#identity : null;
  }

  createSocket(open?: { readonly serverMinted: HostedHubServerMintedOpen }): RelaySocket {
    if (this.#disposed) throw new Error("Hub session is closed.");
    if (this.#streams.size >= this.#maxChannels || this.#nextStream >= 0xffff_ffff)
      throw new Error("Hub session channel capacity reached.");
    const stream: LogicalStream = {
      id: ++this.#nextStream,
      createdAt: this.#options.timers.now(),
      state: 0,
      opened: false,
      serverMinted: open?.serverMinted ?? null,
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };
    this.#streams.set(stream.id, stream);
    const bufferedAmount = () => this.#queueBytes + (this.#socket?.bufferedAmount ?? 0);
    const socket: RelaySocket = {
      get readyState() {
        return stream.state;
      },
      get bufferedAmount() {
        return bufferedAmount();
      },
      send: (bytes) => {
        if (stream.state !== 1 || !this.#ready) throw new Error("Hub relay channel is not open.");
        this.#send({ type: "data", streamId: stream.id, payload: bytes });
      },
      close: (code = 1000, reason = "closed") => this.#closeStream(stream, code, reason, true),
      onOpen(listener) {
        stream.open.add(listener);
      },
      onBinaryMessage(listener) {
        stream.message.add(listener);
      },
      onClose(listener) {
        stream.close.add(listener);
      },
      onError(listener) {
        stream.error.add(listener);
      },
    };
    this.start();
    // A socket under suspicion carries no new stream: one sent into a dead path
    // would only be lost with it. The stream opens once a frame proves the
    // socket alive, or on the replacement's `ready`.
    if (this.#ready && this.#probeDeadline === undefined)
      this.#options.timers.queueMicrotask(() => this.#openStream(stream));
    return socket;
  }

  /**
   * A lifecycle signal — foreground, `online`, a network change — says the
   * network may have changed or come back.
   *
   * A session waiting out its reconnect backoff connects at once instead: the
   * signal is new information the backoff could not have had. This happens once
   * per signal; the failure count is kept, so consecutive failures still back
   * off. An online session is probed ({@link probe}), and one already silent past
   * the liveness bound is replaced at once rather than after the probe wait. A
   * disposed session — signed out, or an authentication or protocol failure —
   * stays closed.
   */
  resume(): void {
    if (this.#disposed || !this.#started) return;
    if (this.#ready) {
      if (!this.#silentPastDeadBound()) {
        this.probe();
        return;
      }
      this.#lost("network", true);
    }
    if (this.#socket !== null || this.#retry === undefined) return;
    this.#clearTimer("retry");
    this.#connect();
  }

  /**
   * Check now, rather than on the next heartbeat, that the connection is alive.
   *
   * A network change — Wi-Fi to cellular, a NAT rebinding, a laptop waking —
   * can leave this end of the socket open on a path that is already dead, and
   * the heartbeat alone takes up to the 45-second liveness bound to notice.
   * Meanwhile new logical streams are opened on the dead socket and no
   * invalidation arrives. A probe sends a ping at once (or reuses the one
   * already pending) and, if no frame at all arrives within `timeoutMs`,
   * treats the connection as lost through the ordinary path: `onFailure`,
   * then the bounded reconnect. A probe before `ready`, or while one is already
   * armed, does nothing; the connect deadline and the armed probe cover those.
   *
   * A congested uplink is not a dead one. The ping overtakes queued stream
   * data, its wait counts from when it leaves the queue, and while a backlog
   * of outbound bytes keeps leaving the socket the wait is extended — never
   * past the liveness bound since the last frame received.
   */
  probe(timeoutMs = HUB_SESSION_PROBE_TIMEOUT_MS): void {
    const socket = this.#socket;
    if (this.#disposed || !this.#ready || !socket || this.#probeDeadline !== undefined) return;
    // Nothing for longer than the bound the Hub itself closes a silent peer
    // after: the socket is gone, and a probe wait would only delay the
    // replacement.
    if (this.#silentPastDeadBound()) {
      this.#lost("network", true);
      return;
    }
    const startedAt = this.#options.timers.now();
    // Reuse a pending heartbeat probe: its pong is the answer either way, and a
    // second nonce would make the first one's valid pong look forged.
    if (!this.#probe) {
      this.#sendPing();
      if (this.#socket !== socket || !this.#ready) return;
    }
    this.#armProbeDeadline(socket, startedAt, timeoutMs, timeoutMs);
  }

  /**
   * Any frame received clears this deadline. When it fires, the connection is
   * lost unless the ping left the queue less than `timeoutMs` ago, or the
   * uplink was backlogged at the last check and bytes have left the socket
   * since: the path still moves data, it is only busy.
   *
   * Progress alone is no proof of life. A browser socket's buffer also drains
   * on a dead path until the kernel's send buffer fills, so the probe's own
   * ping, or a few small frames, would keep re-arming a dead connection up to
   * the liveness bound. Only a backlog at least {@link SEND_HIGH_WATER_BYTES}
   * deep, or a ping still waiting behind one, earns the extension.
   *
   * Progress is measured from `since`, the drained-bytes baseline of the last
   * full wait. Finishing the ping's own window after it left the queue keeps
   * that baseline: an uplink drains in bursts, often 50–100 ms apart, so a
   * window of the few milliseconds since the ping left would see no progress
   * on a live upload. The progress check therefore always spans at least
   * `timeoutMs`.
   */
  #armProbeDeadline(
    socket: HubSessionSocket,
    startedAt: number,
    timeoutMs: number,
    delay: number,
    since = this.#drainedBytes(socket),
  ): void {
    const backlogged =
      this.#probeSentAt === undefined ||
      this.#queueBytes + socket.bufferedAmount >= SEND_HIGH_WATER_BYTES;
    this.#probeDeadline = this.#options.timers.setTimeout(() => {
      this.#probeDeadline = undefined;
      if (this.#socket !== socket || !this.#ready || this.#disposed) return;
      if (this.#lastReceived >= startedAt) return;
      const now = this.#options.timers.now();
      const sentAt = this.#probeSentAt;
      // The ping has not been out for a full wait yet: finish its window, still
      // measuring progress from this wait's baseline.
      const pingWindow = sentAt !== undefined && now - sentAt < timeoutMs;
      const wait = pingWindow
        ? timeoutMs - (now - sentAt)
        : backlogged && this.#drainedBytes(socket) > since
          ? timeoutMs
          : undefined;
      if (wait === undefined || this.#silentPastDeadBound()) {
        this.#lost("network", true);
        return;
      }
      this.#armProbeDeadline(
        socket,
        startedAt,
        timeoutMs,
        Math.min(wait, HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS - (now - this.#lastReceived)),
        pingWindow ? since : undefined,
      );
    }, delay);
  }

  /** Outbound bytes that have left the socket's own buffer; only ever grows. */
  #drainedBytes(socket: HubSessionSocket): number {
    return this.#handedBytes - socket.bufferedAmount;
  }

  #sendPing(): void {
    this.#probe = new Uint8Array(8);
    new DataView(this.#probe.buffer).setUint32(4, ++this.#probeSequence);
    this.#probeSentAt = undefined;
    this.#sendControl({ type: "ping", nonce: this.#probe });
  }

  #silentPastDeadBound(): boolean {
    return (
      this.#options.timers.now() - this.#lastReceived >= HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#protocolVersion = null;
    this.#identity = null;
    this.#discardQueue();
    for (const stream of Array.from(this.#streams.values()))
      this.#closeStream(stream, 1000, "session closed", false);
    this.#invalidations.clear();
    socket?.close(1000, "session closed");
    this.#options.onStatus?.("closed");
  }

  #connect(): void {
    if (this.#disposed || this.#socket) return;
    this.#options.onStatus?.(this.#failures === 0 ? "connecting" : "reconnecting");
    let socket: HubSessionSocket;
    const offer = !this.#probingWithoutOffer && this.#options.timers.now() >= this.#noOfferUntil;
    this.#offered = offer;
    this.#socketOpened = false;
    try {
      socket = this.#options.createSocket(offer ? HUB_SESSION_SUBPROTOCOLS : []);
    } catch {
      this.#lost("network", true);
      return;
    }
    this.#socket = socket;
    this.#ready = false;
    this.#protocolVersion = null;
    this.#identity = null;
    this.#handedBytes = 0;
    const current = () => this.#socket === socket && !this.#disposed;
    socket.onOpen(() => {
      // READY, not the TCP upgrade, authenticates the session. An open only shows the handshake
      // itself works, which decides whether to keep offering the version subprotocol.
      if (!current()) return;
      this.#socketOpened = true;
      if (this.#offered) {
        // The offer works on this path: whatever failed before was not stripping.
        this.#strippingSuspected = false;
      } else if (this.#probingWithoutOffer) {
        this.#probingWithoutOffer = false;
        if (this.#strippingSuspected) {
          // The same pattern twice running: the path strips the subprotocol.
          this.#strippingSuspected = false;
          this.#noOfferUntil = this.#options.timers.now() + HUB_SESSION_SUBPROTOCOL_FALLBACK_MS;
        } else {
          this.#strippingSuspected = true;
        }
      }
    });
    socket.onBinaryMessage((bytes) => {
      if (current()) this.#receive(bytes);
    });
    socket.onClose((_reason, code) => {
      if (!current()) return;
      const authentication = code === 4401 || code === 4403 || code === 4411;
      const protocol =
        code === 1002 || code === 1007 || code === 1009 || code === 4400 || code === 4406;
      this.#lost(
        authentication ? "authentication" : protocol ? "protocol" : "network",
        !authentication && !protocol,
      );
    });
    socket.onError(() => {
      if (current()) this.#lost("network", true);
    });
    this.#deadline = this.#options.timers.setTimeout(() => {
      if (current()) this.#lost("network", true);
    }, READY_TIMEOUT_MS);
  }

  #receive(bytes: Uint8Array): void {
    // The socket's buffer is this session's alone (see `RelaySocket`), and a
    // data payload is handed to its stream's engine, which decodes and zeroes
    // it in place: a copy would only leave the original behind, unzeroed.
    // Before `ready` the session decodes what it advertised; after it, only what was negotiated.
    const decoded = decodeHubSessionFrame(bytes, {
      borrowDataPayload: true,
      protocolVersion: this.#protocolVersion ?? HUB_SESSION_PROTOCOL_VERSION,
    });
    if (!decoded.ok) {
      this.#lost("protocol", false);
      return;
    }
    const frame = decoded.value;
    if (!this.#ready) {
      if (frame.type !== "ready") {
        this.#lost("protocol", false);
        return;
      }
      this.#ready = true;
      this.#protocolVersion = frame.protocolVersion;
      this.#identity =
        frame.protocolVersion >= 2 && "accountId" in frame
          ? { accountId: frame.accountId, sessionId: frame.sessionId }
          : null;
      const expected = this.#expectedIdentity;
      const mismatch =
        this.#identity !== null &&
        expected !== undefined &&
        (this.#identity.accountId !== expected.accountId ||
          this.#identity.sessionId !== expected.sessionId);
      this.#maxChannels = frame.maxChannels;
      this.#lastReceived = this.#options.timers.now();
      this.#onlineAt = this.#lastReceived;
      this.#clearTimer("deadline");
      this.#options.onStatus?.("online");
      // Another identity: nothing is opened under it (see #openStream); the owner revalidates.
      if (mismatch) this.#options.onIdentityMismatch?.();
      if (this.#disposed || !this.#ready) return;
      this.#notifyInvalidation({ directory: true, threadCache: true });
      let admitted = 0;
      for (const stream of Array.from(this.#streams.values())) {
        if (admitted++ >= this.#maxChannels)
          this.#closeStream(stream, 4429, "channel capacity", false);
        else this.#openStream(stream);
      }
      if (this.#ready) this.#scheduleHeartbeat();
      return;
    }
    this.#lastReceived = this.#options.timers.now();
    // Any frame answers a pending suspicion probe; streams held back from the
    // suspect socket may open now.
    if (this.#probeDeadline !== undefined) {
      this.#clearTimer("probe");
      this.#openPendingStreams();
      if (!this.#ready) return;
    }
    switch (frame.type) {
      case "ping":
        this.#sendControl({ type: "pong", nonce: frame.nonce });
        return;
      case "pong":
        if (!this.#probe || !bytesEqual(frame.nonce, this.#probe)) {
          this.#lost("protocol", false);
          return;
        }
        this.#probe = null;
        return;
      case "invalidate":
        this.#notifyInvalidation(frame);
        return;
      case "data": {
        const stream = this.#streams.get(frame.streamId);
        // A close may cross already-sent data. Never route it into a newer stream.
        if (!stream) {
          frame.payload.fill(0);
          if (frame.streamId > this.#nextStream) this.#lost("protocol", false);
          return;
        }
        if (stream.state !== 1) {
          frame.payload.fill(0);
          this.#lost("protocol", false);
          return;
        }
        for (const listener of Array.from(stream.message)) listener(frame.payload);
        return;
      }
      case "close": {
        const stream = this.#streams.get(frame.streamId);
        if (stream) this.#closeStream(stream, frame.code, frame.reason, false);
        else if (frame.streamId > this.#nextStream) this.#lost("protocol", false);
        return;
      }
      default:
        this.#lost("protocol", false);
    }
  }

  #notifyInvalidation(event: HostedHubSessionInvalidation): void {
    if (this.#disposed) return;
    this.#options.onInvalidate?.(event);
    for (const listener of Array.from(this.#invalidations)) listener(event);
  }

  #openPendingStreams(): void {
    for (const stream of Array.from(this.#streams.values())) {
      if (stream.state === 0) this.#openStream(stream);
    }
  }

  #openStream(stream: LogicalStream): void {
    if (!this.#ready || this.#streams.get(stream.id) !== stream || stream.state !== 0) return;
    const frame = this.#openFrame(stream);
    if (frame === null) {
      // This connection cannot mint for the expected session: nothing was sent for the stream.
      // On version 1 its owner simply tries again over HTTP; under another identity it fails
      // and the session owner revalidates.
      this.#closeStream(
        stream,
        1012,
        (this.#protocolVersion ?? 1) < 2
          ? HUB_SESSION_SERVER_MINTED_UNAVAILABLE_REASON
          : HUB_SESSION_IDENTITY_MISMATCH_REASON,
        false,
      );
      return;
    }
    try {
      this.#send(frame);
      if (!this.#ready || this.#streams.get(stream.id) !== stream) return;
      stream.opened = true;
      stream.state = 1;
      for (const listener of Array.from(stream.open)) listener();
    } catch {
      this.#closeStream(stream, 4429, "channel unavailable", false);
    }
  }

  /** `open`, or `openNode` naming the expected session; null when this connection cannot mint. */
  #openFrame(stream: LogicalStream): HubSessionFrame | null {
    const serverMinted = stream.serverMinted;
    if (serverMinted === null) return { type: "open", streamId: stream.id };
    const expected = this.#expectedIdentity;
    if (expected === undefined || !this.#serverMintedOpensHere()) return null;
    return {
      type: "openNode",
      streamId: stream.id,
      nodeId: serverMinted.nodeId,
      sessionId: expected.sessionId,
      capability: "ryco.rpc",
      protocolMajor: 1,
      protocolMinor: serverMinted.protocolMinor,
    };
  }

  #closeStream(stream: LogicalStream, code: number, reason: string, notifyPeer: boolean): void {
    if (stream.state === 3) return;
    stream.state = 3;
    this.#streams.delete(stream.id);
    if (notifyPeer && stream.opened && this.#ready) {
      // Preserve queued OPEN/DATA ordering before CLOSE, including an auth frame.
      try {
        this.#send({
          type: "close",
          streamId: stream.id,
          code: Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1000,
          reason:
            new TextEncoder().encode(reason).byteLength <= HUB_SESSION_CLOSE_REASON_BYTES
              ? reason
              : "closed",
        });
      } catch {
        this.#lost("network", true);
      }
    }
    for (const listener of Array.from(stream.close)) listener(reason);
    stream.open.clear();
    stream.message.clear();
    stream.close.clear();
    stream.error.clear();
  }

  #send(frame: HubSessionFrame): void {
    const socket = this.#socket;
    if (!this.#ready || !socket || socket.readyState !== 1)
      throw new Error("Hub session is not online.");
    const encoded = encodeHubSessionFrame(frame);
    if (!encoded.ok) throw new Error("Invalid Hub session frame.");
    const bytes = encoded.value;
    const ceiling =
      HUB_SESSION_MAX_QUEUED_BYTES - (frame.type === "data" ? CONTROL_RESERVE_BYTES : 0);
    const frameCeiling = HUB_SESSION_MAX_QUEUED_FRAMES - (frame.type === "data" ? 16 : 0);
    if (
      this.#queue.length >= frameCeiling ||
      this.#queueBytes + socket.bufferedAmount + bytes.byteLength > ceiling
    ) {
      bytes.fill(0);
      throw new Error("Hub session send queue is full.");
    }
    if (this.#queue.length === 0 && socket.bufferedAmount < SEND_HIGH_WATER_BYTES) {
      try {
        this.#hand(socket, frame.type, bytes);
      } finally {
        bytes.fill(0);
      }
      return;
    }
    const entry: QueuedFrame = { type: frame.type, bytes };
    if (isControlFrame(frame.type)) {
      // A ping or pong belongs to no stream, so it may overtake queued stream
      // frames: a liveness answer must not wait behind megabytes of data.
      // Control frames keep their order among themselves.
      const index = this.#queue.findIndex((queued) => !isControlFrame(queued.type));
      this.#queue.splice(index === -1 ? this.#queue.length : index, 0, entry);
    } else {
      this.#queue.push(entry);
    }
    this.#queueBytes += bytes.byteLength;
    this.#scheduleDrain();
  }

  #hand(socket: HubSessionSocket, type: HubSessionFrame["type"], bytes: Uint8Array): void {
    socket.send(bytes);
    this.#handedBytes += bytes.byteLength;
    if (type === "ping") this.#probeSentAt = this.#options.timers.now();
  }

  #sendControl(frame: HubSessionFrame): void {
    try {
      this.#send(frame);
    } catch {
      this.#lost("network", true);
    }
  }

  #scheduleDrain(): void {
    if (this.#drain !== undefined) return;
    this.#drain = this.#options.timers.setTimeout(() => {
      this.#drain = undefined;
      const socket = this.#socket;
      if (!socket || !this.#ready) return;
      while (this.#queue.length > 0 && socket.bufferedAmount < SEND_HIGH_WATER_BYTES) {
        const entry = this.#queue.shift()!;
        this.#queueBytes -= entry.bytes.byteLength;
        try {
          this.#hand(socket, entry.type, entry.bytes);
        } catch {
          this.#lost("network", true);
          return;
        } finally {
          entry.bytes.fill(0);
        }
      }
      if (this.#queue.length > 0) this.#scheduleDrain();
    }, 10);
  }

  #scheduleHeartbeat(): void {
    this.#heartbeat = this.#options.timers.setTimeout(
      () => {
        this.#heartbeat = undefined;
        if (!this.#ready) return;
        if (
          this.#options.timers.now() - this.#lastReceived >=
          HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS
        ) {
          this.#lost("network", true);
          return;
        }
        // Do not overwrite a pending probe: delayed valid pongs must remain valid.
        if (!this.#probe) this.#sendPing();
        if (this.#ready) this.#scheduleHeartbeat();
      },
      Math.min(
        HUB_SESSION_HEARTBEAT_INTERVAL_MS,
        Math.max(
          1,
          HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS -
            (this.#options.timers.now() - this.#lastReceived),
        ),
      ),
    );
  }

  #lost(kind: "network" | "protocol" | "authentication", retryable: boolean): void {
    if (this.#disposed) return;
    const socket = this.#socket;
    if (socket !== null && !this.#socketOpened) this.#handshakeFailed();
    if (this.#ready && this.#options.timers.now() - this.#onlineAt >= 30_000) this.#failures = 0;
    this.#socket = null;
    this.#ready = false;
    this.#protocolVersion = null;
    this.#identity = null;
    this.#probe = null;
    this.#clearTimers();
    this.#discardQueue();
    const now = this.#options.timers.now();
    for (const stream of Array.from(this.#streams.values())) {
      // A stream that never opened sent nothing on the lost socket: while
      // reconnecting it waits, bounded, for the replacement `ready` instead.
      if (retryable && stream.state === 0 && now - stream.createdAt < PENDING_STREAM_MAX_WAIT_MS)
        continue;
      this.#closeStream(stream, 1012, "session unavailable", false);
    }
    socket?.close(1000, "session unavailable");
    this.#options.onFailure?.({ kind, retryable });
    if (this.#disposed) return;
    if (!retryable) {
      this.dispose();
      return;
    }
    this.#options.onStatus?.("reconnecting");
    if (this.#disposed) return;
    const base = 500 * 2 ** Math.min(this.#failures++, 5);
    const delay = Math.min(
      10_000,
      Math.round(base * (0.75 + (this.#options.random ?? Math.random)() * 0.5)),
    );
    this.#retry = this.#options.timers.setTimeout(() => {
      this.#retry = undefined;
      this.#connect();
    }, delay);
  }

  /**
   * A handshake failed before its socket opened. One that offered the version subprotocol is
   * retried offering none, in case something on the path strips it; one that offered none too is
   * an ordinary outage, after which every bit of stripping evidence is dropped and offering
   * resumes. See {@link HUB_SESSION_SUBPROTOCOL_FALLBACK_MS}.
   */
  #handshakeFailed(): void {
    if (this.#offered) {
      this.#probingWithoutOffer = true;
      return;
    }
    this.#probingWithoutOffer = false;
    this.#strippingSuspected = false;
    this.#noOfferUntil = 0;
  }

  #discardQueue(): void {
    for (const entry of this.#queue) entry.bytes.fill(0);
    this.#queue = [];
    this.#queueBytes = 0;
  }
  #clearTimer(kind: "retry" | "deadline" | "heartbeat" | "drain" | "probe"): void {
    const timer =
      kind === "retry"
        ? this.#retry
        : kind === "deadline"
          ? this.#deadline
          : kind === "heartbeat"
            ? this.#heartbeat
            : kind === "probe"
              ? this.#probeDeadline
              : this.#drain;
    if (timer !== undefined) this.#options.timers.clearTimeout(timer);
    if (kind === "retry") this.#retry = undefined;
    else if (kind === "deadline") this.#deadline = undefined;
    else if (kind === "heartbeat") this.#heartbeat = undefined;
    else if (kind === "probe") this.#probeDeadline = undefined;
    else this.#drain = undefined;
  }
  #clearTimers(): void {
    for (const kind of ["retry", "deadline", "heartbeat", "drain", "probe"] as const)
      this.#clearTimer(kind);
  }
}
