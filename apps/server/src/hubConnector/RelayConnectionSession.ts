import {
  RELAY_AUTHENTICATION_DEADLINE_MS,
  RELAY_AUTHORIZED_CHANNEL_MINOR,
  RELAY_PROTOCOL_MAJOR,
  RELAY_PROTOCOL_MINOR,
  type RelayErrorFrame,
  type RelayFrame,
  type RelayNodeAuthHandshake,
  type RelayReadyFrame,
} from "@ryco/contracts/relay";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";

import type { ConnectorFailureKind } from "./HubConnectorState.ts";
import { HubRelayAuthenticationError, type HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import {
  type HubRelaySocket,
  type HubRelaySocketEventMap,
  type HubRelayTransport,
  relayWebSocketUrl,
} from "./HubRelayTransport.ts";

export class RelayConnectionError extends Error {
  readonly kind: ConnectorFailureKind;
  readonly retryAfterMs: number | undefined;

  constructor(kind: ConnectorFailureKind, retryAfterMs?: number) {
    super("Hub relay connection failed.");
    this.name = "RelayConnectionError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RelaySessionScheduler {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export const defaultRelayScheduler: RelaySessionScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function unwrapEncoded(frame: RelayFrame): Uint8Array {
  const result = encodeRelayFrame(frame);
  if (!result.ok) throw new RelayConnectionError("protocol_invalid");
  return result.value;
}

export function relayErrorKind(frame: RelayErrorFrame): ConnectorFailureKind {
  switch (frame.code) {
    case "authentication_timeout":
      return "authentication_timeout";
    case "authentication_failed":
    case "authentication_required":
      return "authentication_failed";
    case "connection_replaced":
      return "connection_replaced";
    case "server_draining":
      return "server_draining";
    case "rate_limited":
      return "rate_limited";
    case "revoked":
    case "node_revoked":
      return "revoked";
    case "protocol_unsupported":
      return "version_incompatible";
    case "internal_error":
      return "internal_error";
    default:
      return "protocol_invalid";
  }
}

/**
 * The close the Hub gives a socket another connection displaced.
 *
 * The Hub terminates the older of two connections for one node identity with
 * this close and no error frame. Read as an ordinary network drop, both copies
 * reconnect at once and displace each other indefinitely, and neither ever
 * reaches the `connection_replaced` handling that spaces them out. Matched on
 * the exact code and reason, so no other 1012 ("service restart") is affected.
 */
const REPLACED_CLOSE_CODE = 1012;
const REPLACED_CLOSE_REASON = "connection_replaced";

function closeEventKind(event: CloseEvent | undefined): ConnectorFailureKind {
  return event?.code === REPLACED_CLOSE_CODE && event.reason === REPLACED_CLOSE_REASON
    ? "connection_replaced"
    : "network";
}

function binaryMessage(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return Uint8Array.from(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return undefined;
}

const copyRelayBytes = <T extends Uint8Array>(bytes: T): T => Uint8Array.from(bytes) as T;

function detachRelayFrameBytes(frame: RelayFrame): RelayFrame {
  switch (frame.type) {
    case "auth":
      return frame.peer === "node"
        ? {
            ...frame,
            nonce: Uint8Array.from(frame.nonce),
            signature: Uint8Array.from(frame.signature),
          }
        : { ...frame, relayTicket: Uint8Array.from(frame.relayTicket) };
    case "data":
      return { ...frame, payload: Uint8Array.from(frame.payload) };
    case "channel.open":
      return frame.accountGrantContext === undefined
        ? frame
        : {
            ...frame,
            accountGrantContext: [
              frame.accountGrantContext[0],
              frame.accountGrantContext[1],
              copyRelayBytes(frame.accountGrantContext[2]),
              copyRelayBytes(frame.accountGrantContext[3]),
            ],
          };
    case "node.e2ee.statement":
      return {
        ...frame,
        statement: Uint8Array.from(frame.statement),
        statementDigest: copyRelayBytes(frame.statementDigest),
      };
    case "node.e2ee.statement.ack":
      return { ...frame, statementDigest: copyRelayBytes(frame.statementDigest) };
    case "e2ee.verifier-keys":
      return {
        ...frame,
        keys: frame.keys.map((key) => ({
          ...key,
          publicKey: Uint8Array.from(key.publicKey),
        })),
      };
    case "ping":
    case "pong":
      return { ...frame, nonce: Uint8Array.from(frame.nonce) };
    default:
      return frame;
  }
}

const MAX_PENDING_POST_READY_FRAMES = 16;

/**
 * How long a socket opened beside a still-pending proof waits for it. One
 * second short of the Hub's own authentication deadline, so the socket is
 * released before the Hub would time it out.
 */
const PROOF_AFTER_OPEN_DEADLINE_MS = RELAY_AUTHENTICATION_DEADLINE_MS - 1_000;
/** The attempt released its socket because the proof was late; see `#authenticate`. */
const PROOF_LATE = Symbol("proof-late");

/**
 * A proof this old may have reached the Hub after its challenge expired.
 *
 * The Hub honours a challenge for 30 seconds and rejects an expired one with
 * the same `authentication_failed` it uses for a wrong or revoked key, so the
 * two cannot be told apart from the frame. Age is measured locally, from before
 * the challenge was requested until the proof was sent, which overstates it and
 * is immune to clock skew.
 */
const STALE_PROOF_AGE_MS = 20_000;

function clearRelayFrameBytes(frame: RelayFrame): void {
  switch (frame.type) {
    case "auth":
      if (frame.peer === "node") {
        frame.nonce.fill(0);
        frame.signature.fill(0);
      } else {
        frame.relayTicket.fill(0);
      }
      break;
    case "data":
      frame.payload.fill(0);
      break;
    case "channel.open":
      frame.accountGrantContext?.[2].fill(0);
      frame.accountGrantContext?.[3].fill(0);
      break;
    case "node.e2ee.statement":
      frame.statement.fill(0);
      frame.statementDigest.fill(0);
      break;
    case "node.e2ee.statement.ack":
      frame.statementDigest.fill(0);
      break;
    case "e2ee.verifier-keys":
      for (const key of frame.keys) key.publicKey.fill(0);
      break;
    case "ping":
    case "pong":
      frame.nonce.fill(0);
      break;
  }
}

export class RelayConnectionSession {
  readonly #identity: HubIdentityRuntimeShape;
  readonly #transport: HubRelayTransport;
  readonly #hubOrigin: string;
  readonly #scheduler: RelaySessionScheduler;
  readonly #onFrame: (frame: RelayFrame) => void;
  readonly #onTerminal: (error: RelayConnectionError) => void;
  readonly #now: () => number;
  readonly #proofFirst: boolean;
  #proofRefused = false;
  #proofRequestedAt: number | undefined;
  #proofSentAt: number | undefined;
  #socket: HubRelaySocket | undefined;
  #ready: RelayReadyFrame | undefined;
  #offeredProtocolMinor: number | undefined;
  #timer: unknown;
  #pendingAuthBytes: Uint8Array | undefined;
  #pendingPostReadyFrames: RelayFrame[] = [];
  #frameDeliveryActive = false;
  #settled = false;
  #closed = false;
  #authenticationStarted = false;
  #rejectAuthentication: ((error: RelayConnectionError) => void) | undefined;
  #listeners:
    | {
        readonly open: (event: Event) => void;
        readonly message: (event: MessageEvent<unknown>) => void;
        readonly error: (event: Event) => void;
        readonly close: (event: CloseEvent) => void;
      }
    | undefined;

  constructor(options: {
    readonly identity: HubIdentityRuntimeShape;
    readonly transport: HubRelayTransport;
    readonly hubOrigin: string;
    readonly scheduler?: RelaySessionScheduler;
    /** Wall clock for the proof's age; injectable for tests. */
    readonly now?: () => number;
    /**
     * Prepare the proof before opening the socket instead of beside it. For an
     * attempt that follows a refused proof (see {@link proofRefused}): a Hub
     * refusing the challenge (draining, rate limiting) would otherwise be
     * handed a relay upgrade it does not want on every retry.
     */
    readonly proofFirst?: boolean;
    readonly onFrame: (frame: RelayFrame) => void;
    readonly onTerminal: (error: RelayConnectionError) => void;
  }) {
    this.#identity = options.identity;
    this.#transport = options.transport;
    this.#hubOrigin = options.hubOrigin;
    this.#scheduler = options.scheduler ?? defaultRelayScheduler;
    this.#now = options.now ?? Date.now;
    this.#proofFirst = options.proofFirst ?? false;
    this.#onFrame = options.onFrame;
    this.#onTerminal = options.onTerminal;
  }

  get socket(): HubRelaySocket | undefined {
    return this.#socket;
  }

  get ready(): RelayReadyFrame | undefined {
    return this.#ready;
  }

  /**
   * Whether this attempt's proof (the HTTPS challenge and the signature) failed
   * for a reason other than the network: the Hub answered and refused it
   * (draining, rate limiting, a malformed exchange), or this node could not
   * make it (its key store, an incompatible version). A network failure is not
   * a refusal: it reached no Hub, the socket beside it would not have either,
   * and holding the next socket back would only make the reconnect that ends
   * an outage pay the proof and the socket in sequence.
   */
  get proofRefused(): boolean {
    return this.#proofRefused;
  }

  authenticate(): Promise<RelayReadyFrame> {
    if (this.#authenticationStarted || this.#closed) {
      return Promise.reject(new RelayConnectionError("internal_error"));
    }
    this.#authenticationStarted = true;
    return new Promise((resolve, reject) => {
      // Closing a session must release the connector even while native key
      // access is pending. A late proof is still cleared by the closed check.
      this.#rejectAuthentication = reject;
      void this.#authenticate().then(
        (ready) => {
          this.#rejectAuthentication = undefined;
          resolve(ready);
        },
        (error: unknown) => {
          this.#rejectAuthentication = undefined;
          reject(error);
        },
      );
    });
  }

  /**
   * The signed authentication frame, encoded: the HTTPS challenge, the
   * signature, and the version and shutdown checks. Every rejection is a
   * bounded {@link RelayConnectionError}, and the frame's key material is wiped
   * whatever happens to it.
   */
  async #prepareAuthentication(): Promise<Uint8Array> {
    let auth: RelayNodeAuthHandshake;
    try {
      auth = await this.#identity.createRelayAuthenticationFrame(this.#hubOrigin, {
        protocolMajor: RELAY_PROTOCOL_MAJOR,
        protocolMinor: RELAY_PROTOCOL_MINOR,
      });
    } catch (error) {
      throw new RelayConnectionError(
        error instanceof HubRelayAuthenticationError ? error.failure : "authentication_failed",
      );
    }
    if (
      auth.protocolMajor !== RELAY_PROTOCOL_MAJOR ||
      auth.protocolMinor < RELAY_AUTHORIZED_CHANNEL_MINOR ||
      auth.protocolMinor > RELAY_PROTOCOL_MINOR
    ) {
      auth.nonce.fill(0);
      auth.signature.fill(0);
      throw new RelayConnectionError("version_incompatible");
    }
    this.#offeredProtocolMinor = auth.protocolMinor;
    if (this.#closed) {
      auth.nonce.fill(0);
      auth.signature.fill(0);
      throw new RelayConnectionError("network");
    }
    try {
      return unwrapEncoded(auth);
    } finally {
      auth.nonce.fill(0);
      auth.signature.fill(0);
    }
  }

  /**
   * Prove this node's identity and open the relay socket at the same time.
   *
   * The proof is an HTTPS challenge plus a signature, and the socket a fresh
   * TCP, TLS and upgrade exchange; neither needs the other, so running them in
   * sequence put two to three Hub round trips on every reconnect. The frame is
   * sent once both are ready. Should the proof still be pending close to the
   * Hub's authentication deadline after the socket opened (a slow key store,
   * a credential prompt), that socket is let go before the Hub times it out and
   * the attempt continues in the original order: proof first, then a fresh
   * socket, so a slow key store can never make every attempt time out. A
   * session built `proofFirst` uses that order from the start.
   */
  async #authenticate(): Promise<RelayReadyFrame> {
    this.#proofRequestedAt = this.#now();
    const proof = this.#prepareAuthentication();
    // A proof that lands after shutdown is wiped; every other outcome is
    // consumed by one of the attempts below.
    proof.then(
      (bytes) => {
        if (this.#closed) bytes.fill(0);
      },
      (error: unknown) => {
        this.#proofRefused = !(error instanceof RelayConnectionError && error.kind === "network");
      },
    );
    if (!this.#proofFirst) {
      const concurrent = await this.#connect(proof, PROOF_AFTER_OPEN_DEADLINE_MS);
      if (concurrent !== PROOF_LATE) return concurrent;
    }
    const authBytes = await proof;
    if (this.#closed) {
      authBytes.fill(0);
      throw new RelayConnectionError("network");
    }
    const serial = await this.#connect(Promise.resolve(authBytes), null);
    if (serial === PROOF_LATE) throw new RelayConnectionError("internal_error");
    return serial;
  }

  /**
   * One socket attempt. `proofWaitMs` bounds how long an opened socket waits
   * for a proof still being prepared before the attempt resolves
   * {@link PROOF_LATE} with that socket released; `null` means the proof is
   * already in hand.
   */
  #connect(
    proof: Promise<Uint8Array>,
    proofWaitMs: number | null,
  ): Promise<RelayReadyFrame | typeof PROOF_LATE> {
    return new Promise<RelayReadyFrame | typeof PROOF_LATE>((resolve, reject) => {
      let authBytes: Uint8Array | undefined;
      let proofFailure: RelayConnectionError | undefined;
      let opened = false;
      let released = false;
      let socket: HubRelaySocket | undefined;

      const fail = (error: RelayConnectionError) => {
        this.#clearPendingAuthentication();
        if (!this.#settled) {
          this.#settled = true;
          reject(error);
        } else if (!this.#closed) {
          this.#onTerminal(error);
        }
        this.close();
      };
      /** Let this attempt's socket go without ending the session. */
      const releaseSocket = () => {
        released = true;
        if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#disposeListeners();
        const current = this.#socket;
        this.#socket = undefined;
        try {
          current?.close(1000);
        } catch {
          // A socket that is already closing requires no further cleanup.
        }
      };
      /**
       * A socket that fails before authenticating while the proof is still
       * being prepared is released at once, and the attempt reports the proof's
       * own failure if it has one: a refused or revoked node must not be
       * reported as a network drop because its socket happened to fail first.
       */
      const failBeforeAuthentication = (error: RelayConnectionError) => {
        if (authBytes !== undefined || proofFailure !== undefined || this.#closed) {
          fail(proofFailure ?? error);
          return;
        }
        releaseSocket();
        proof.then(
          (bytes) => {
            bytes.fill(0);
            fail(error);
          },
          (cause: unknown) =>
            fail(
              cause instanceof RelayConnectionError ? cause : new RelayConnectionError("network"),
            ),
        );
      };
      const sendAuthentication = () => {
        if (this.#closed || released || socket === undefined || authBytes === undefined) return;
        if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
        try {
          socket.send(authBytes);
        } catch {
          fail(new RelayConnectionError("network"));
          return;
        }
        this.#proofSentAt = this.#now();
        this.#clearPendingAuthentication();
        authBytes = undefined;
        this.#timer = this.#scheduler.setTimeout(
          () => fail(new RelayConnectionError("authentication_timeout")),
          RELAY_AUTHENTICATION_DEADLINE_MS,
        );
      };

      proof.then(
        (bytes) => {
          if (released || this.#closed) return;
          authBytes = bytes;
          this.#pendingAuthBytes = bytes;
          if (opened) sendAuthentication();
        },
        (cause: unknown) => {
          if (released || this.#closed) return;
          proofFailure =
            cause instanceof RelayConnectionError ? cause : new RelayConnectionError("network");
          fail(proofFailure);
        },
      );

      try {
        socket = this.#transport.open(relayWebSocketUrl(this.#hubOrigin));
      } catch {
        failBeforeAuthentication(new RelayConnectionError("network"));
        return;
      }
      this.#socket = socket;
      const openedSocket = socket;

      const onOpen = () => {
        if (this.#closed || released) return;
        opened = true;
        if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
        this.#timer = undefined;
        if (authBytes !== undefined) {
          sendAuthentication();
          return;
        }
        if (proofWaitMs === null) return;
        this.#timer = this.#scheduler.setTimeout(() => {
          if (this.#closed || released || authBytes !== undefined) return;
          releaseSocket();
          resolve(PROOF_LATE);
        }, proofWaitMs);
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        const bytes = binaryMessage(event.data);
        if (bytes === undefined) {
          fail(new RelayConnectionError("protocol_invalid"));
          return;
        }
        const decoded = decodeRelayFrame(
          bytes,
          this.#ready === undefined
            ? {}
            : {
                expectedVersion: {
                  protocolMajor: this.#ready.protocolMajor,
                  protocolMinor: this.#ready.protocolMinor,
                },
              },
        );
        if (!decoded.ok) {
          bytes.fill(0);
          fail(new RelayConnectionError("protocol_invalid"));
          return;
        }
        const frame = detachRelayFrameBytes(decoded.value);
        bytes.fill(0);
        if (this.#ready === undefined) {
          if (frame.type === "error") {
            const kind = relayErrorKind(frame);
            fail(
              new RelayConnectionError(
                kind === "authentication_failed" && this.#proofWasStale()
                  ? "authentication_stale"
                  : kind,
                frame.retryAfterMs,
              ),
            );
            return;
          }
          if (
            frame.type !== "ready" ||
            this.#proofSentAt === undefined ||
            frame.protocolMajor !== RELAY_PROTOCOL_MAJOR ||
            frame.protocolMinor < RELAY_AUTHORIZED_CHANNEL_MINOR ||
            frame.protocolMinor > (this.#offeredProtocolMinor ?? -1)
          ) {
            fail(
              new RelayConnectionError(
                frame.type === "ready" && this.#proofSentAt !== undefined
                  ? "version_incompatible"
                  : "protocol_invalid",
              ),
            );
            return;
          }
          this.#ready = frame;
          if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
          this.#timer = undefined;
          this.#settled = true;
          resolve(frame);
          return;
        }
        if (!this.#frameDeliveryActive) {
          if (this.#pendingPostReadyFrames.length >= MAX_PENDING_POST_READY_FRAMES) {
            clearRelayFrameBytes(frame);
            fail(new RelayConnectionError("protocol_invalid"));
            return;
          }
          this.#pendingPostReadyFrames.push(frame);
          return;
        }
        this.#onFrame(frame);
      };
      const onError = () => {
        if (this.#ready === undefined && this.#proofSentAt === undefined) {
          failBeforeAuthentication(new RelayConnectionError("network"));
          return;
        }
        fail(new RelayConnectionError("network"));
      };
      const onClose = (event: CloseEvent) => {
        if (this.#closed || released) return;
        const kind = closeEventKind(event);
        if (!this.#settled) {
          if (this.#proofSentAt === undefined) {
            failBeforeAuthentication(new RelayConnectionError(kind));
            return;
          }
          fail(new RelayConnectionError(kind));
        } else {
          this.#closed = true;
          this.#disposeListeners();
          this.#onTerminal(new RelayConnectionError(kind));
        }
      };
      this.#listeners = { open: onOpen, message: onMessage, error: onError, close: onClose };
      openedSocket.addEventListener("open", onOpen);
      openedSocket.addEventListener("message", onMessage);
      openedSocket.addEventListener("error", onError);
      openedSocket.addEventListener("close", onClose);
      // Opening can stall without an error/close event after network changes.
      // Give the handshake its own full deadline once the socket opens.
      this.#timer = this.#scheduler.setTimeout(
        () => failBeforeAuthentication(new RelayConnectionError("network")),
        RELAY_AUTHENTICATION_DEADLINE_MS,
      );
    });
  }

  /**
   * Start routing frames received after `ready` to the connector.
   *
   * The Hub may send connection-scoped state in the same network turn as
   * `ready`. Keep those frames bounded and ordered until the connector has
   * installed every generation-owned consumer, then release them exactly once.
   */
  activateFrameDelivery(): void {
    if (this.#ready === undefined || this.#closed) {
      throw new RelayConnectionError("network");
    }
    if (this.#frameDeliveryActive) return;
    this.#frameDeliveryActive = true;
    const pending = this.#pendingPostReadyFrames;
    this.#pendingPostReadyFrames = [];
    for (const frame of pending) this.#onFrame(frame);
  }

  send(frame: RelayFrame): void {
    if (this.#ready === undefined || this.#closed || this.#socket === undefined) {
      throw new RelayConnectionError("network");
    }
    const bytes = unwrapEncoded(frame);
    try {
      this.#socket.send(bytes);
    } catch {
      throw new RelayConnectionError("network");
    } finally {
      bytes.fill(0);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#settled) {
      this.#settled = true;
      this.#rejectAuthentication?.(new RelayConnectionError("network"));
    }
    this.#rejectAuthentication = undefined;
    for (const frame of this.#pendingPostReadyFrames) clearRelayFrameBytes(frame);
    this.#pendingPostReadyFrames = [];
    this.#clearPendingAuthentication();
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#disposeListeners();
    try {
      this.#socket?.close(1000);
    } catch {
      // A socket that is already closing requires no further cleanup.
    }
  }

  #disposeListeners(): void {
    const socket = this.#socket;
    const listeners = this.#listeners;
    if (socket === undefined || listeners === undefined) return;
    for (const type of ["open", "message", "error", "close"] as const) {
      socket.removeEventListener(
        type,
        listeners[type] as (event: HubRelaySocketEventMap[typeof type]) => void,
      );
    }
    this.#listeners = undefined;
  }

  #proofWasStale(): boolean {
    const requestedAt = this.#proofRequestedAt;
    if (requestedAt === undefined) return false;
    return (this.#proofSentAt ?? this.#now()) - requestedAt >= STALE_PROOF_AGE_MS;
  }

  #clearPendingAuthentication(): void {
    this.#pendingAuthBytes?.fill(0);
    this.#pendingAuthBytes = undefined;
  }
}
