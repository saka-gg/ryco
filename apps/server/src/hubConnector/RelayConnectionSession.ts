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
    readonly onFrame: (frame: RelayFrame) => void;
    readonly onTerminal: (error: RelayConnectionError) => void;
  }) {
    this.#identity = options.identity;
    this.#transport = options.transport;
    this.#hubOrigin = options.hubOrigin;
    this.#scheduler = options.scheduler ?? defaultRelayScheduler;
    this.#onFrame = options.onFrame;
    this.#onTerminal = options.onTerminal;
  }

  get socket(): HubRelaySocket | undefined {
    return this.#socket;
  }

  get ready(): RelayReadyFrame | undefined {
    return this.#ready;
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

  async #authenticate(): Promise<RelayReadyFrame> {
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
    let authBytes: Uint8Array;
    try {
      authBytes = unwrapEncoded(auth);
    } finally {
      auth.nonce.fill(0);
      auth.signature.fill(0);
    }

    return new Promise<RelayReadyFrame>((resolve, reject) => {
      this.#pendingAuthBytes = authBytes;
      let socket: HubRelaySocket;
      try {
        socket = this.#transport.open(relayWebSocketUrl(this.#hubOrigin));
      } catch {
        authBytes.fill(0);
        reject(new RelayConnectionError("network"));
        return;
      }
      this.#socket = socket;

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
      const onOpen = () => {
        if (this.#closed) return;
        if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
        try {
          socket.send(authBytes);
        } catch {
          fail(new RelayConnectionError("network"));
          return;
        }
        this.#clearPendingAuthentication();
        this.#timer = this.#scheduler.setTimeout(
          () => fail(new RelayConnectionError("authentication_timeout")),
          RELAY_AUTHENTICATION_DEADLINE_MS,
        );
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
            fail(new RelayConnectionError(relayErrorKind(frame), frame.retryAfterMs));
            return;
          }
          if (
            frame.type !== "ready" ||
            frame.protocolMajor !== RELAY_PROTOCOL_MAJOR ||
            frame.protocolMinor < RELAY_AUTHORIZED_CHANNEL_MINOR ||
            frame.protocolMinor > (this.#offeredProtocolMinor ?? -1)
          ) {
            fail(
              new RelayConnectionError(
                frame.type === "ready" ? "version_incompatible" : "protocol_invalid",
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
      const onError = () => fail(new RelayConnectionError("network"));
      const onClose = () => {
        if (this.#closed) return;
        if (!this.#settled) {
          fail(new RelayConnectionError("network"));
        } else {
          this.#closed = true;
          this.#disposeListeners();
          this.#onTerminal(new RelayConnectionError("network"));
        }
      };
      this.#listeners = { open: onOpen, message: onMessage, error: onError, close: onClose };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      // Opening can stall without an error/close event after network changes.
      // Give the handshake its own full deadline once the socket opens.
      this.#timer = this.#scheduler.setTimeout(
        () => fail(new RelayConnectionError("network")),
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

  #clearPendingAuthentication(): void {
    this.#pendingAuthBytes?.fill(0);
    this.#pendingAuthBytes = undefined;
  }
}
