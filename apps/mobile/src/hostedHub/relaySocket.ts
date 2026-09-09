import type { DpopSignerService } from "@ryco/client-runtime/platform";
import {
  HostedRelayEngine,
  type HostedRelaySocketCallbacks,
  type RelayE2eeProvider,
  type RelaySocket,
} from "@ryco/client-runtime/relay";

import { createMobileDpopSigner } from "../platform/dpopSigner";
import { mobileSessionCredentials } from "../platform/sessionCredentials";
import { getMobileHostedConfig } from "./runtimeConfig";

/**
 * The relay data channel.
 *
 * `HostedRelayEngine` owns framing, the CBOR auth frame, channel negotiation,
 * flow control, and sequence numbers — none of that is reimplemented here. This
 * module supplies two shapes only:
 *
 *  (a) an outward facade the runtime casts to `WebSocket` and Effect's socket
 *      layer drives, and
 *  (b) the inward `RelaySocket` seam the engine drives.
 *
 * React Native has no reliable `EventTarget`, `MessageEvent`, `CloseEvent`, or
 * `DOMException`, and none exist under the Node test runner, so the facade
 * implements its own listener registry and emits plain objects.
 */

export type { HostedRelaySocketCallbacks };

const RELAY_PATHNAME = "/v1/relay/client";
const INVALID_ATTEMPT = "Relay attempt is no longer valid.";
const UPGRADE_FAILED = "Relay upgrade could not be authorized.";

/**
 * The relay endpoint, derived from the Hub public origin.
 *
 * The upgrade rejects any query string, and `HostedRelayAttemptFactory` returns
 * this value verbatim as the socket URL, so it must be byte-stable across
 * calls. This is deliberately not the direct plane's URL resolver — that is a
 * different scheme entirely.
 */
export function mobileHostedRelayUrl(): string {
  const config = getMobileHostedConfig();
  if (config === null) throw new Error("Hosted mode is not configured.");
  const url = new URL(config.hubOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = RELAY_PATHNAME;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The minimum of React Native's WebSocket this adapter depends on. */
export interface NativeSocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  send: (data: ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (type: string, listener: (event: never) => void) => void;
}

export type NativeSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => NativeSocketLike;

export interface MobileHostedRelaySocketOptions {
  readonly url: string;
  readonly ticket: string;
  readonly ticketExpiresAt: number;
  readonly callbacks: HostedRelaySocketCallbacks;
  /** Test seams; production defaults reach the real adapters. */
  readonly createSocket?: NativeSocketFactory;
  readonly dpopSigner?: () => Promise<DpopSignerService>;
  readonly readBearerToken?: () => string | null;
  readonly relayUrl?: () => string;
  readonly now?: () => number;
  /**
   * docs/relay-e2ee-protocol.md §4.4: the channel's mode machine, built at
   * `channel.accept` from the negotiated limits.
   *
   * Supplied by the CALLER rather than constructed here, because §4.4 requires
   * every selection guard — the resolved pin, the §12.1.1 classification, the
   * device-level verification marker, the owner's recorded consent — to be
   * evaluated "before it has received any payload", which means before this
   * socket exists. A caller that cannot resolve them omits the provider, and
   * the engine runs the unchanged legacy channel.
   */
  readonly e2ee?: RelayE2eeProvider | undefined;
  /** Erases the transient account grant when this one socket attempt ends. */
  readonly disposePreparedContext?: (() => void) | undefined;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

interface FacadeEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

type FacadeListener = (event: FacadeEvent) => void;

interface Registration {
  readonly listener: FacadeListener;
  readonly once: boolean;
}

function defaultCreateSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
): NativeSocketLike {
  // React Native's WebSocket accepts a third options argument carrying request
  // headers; the DOM lib's type does not model it.
  const constructor = globalThis.WebSocket as unknown as new (
    url: string,
    protocols: undefined,
    options: { headers: Readonly<Record<string, string>> },
  ) => NativeSocketLike;
  return new constructor(url, undefined, { headers });
}

type InboundMessage =
  | { readonly bytes: Uint8Array }
  | { readonly fail: "frame_too_large" | "protocol_invalid" };

/**
 * Classify an inbound message. Nothing is silently dropped: a typed view or
 * ArrayBuffer is copied to relay bytes, and anything else fails closed so the
 * engine can report it.
 */
function classifyInboundMessage(data: unknown): InboundMessage {
  if (data instanceof ArrayBuffer) return { bytes: new Uint8Array(data.slice(0)) };
  if (data instanceof Uint8Array) return { bytes: Uint8Array.from(data) };
  if (ArrayBuffer.isView(data)) {
    return {
      bytes: Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    };
  }
  return { fail: "frame_too_large" };
}

export class MobileHostedRelaySocket {
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  binaryType = "arraybuffer";
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  onopen: FacadeListener | null = null;
  onmessage: FacadeListener | null = null;
  onerror: FacadeListener | null = null;
  onclose: FacadeListener | null = null;

  readonly #listeners = new Map<string, Set<Registration>>();
  readonly #engine: HostedRelayEngine;
  #state: number = CONNECTING;
  /** Set once the proof mint resolves and the platform socket exists. */
  #socket: NativeSocketLike | null = null;
  #abandoned = false;
  #preparedContextDisposed = false;

  // The engine registers its listeners synchronously during construction, but
  // the platform socket cannot exist until the async proof mint resolves, so
  // registrations are held and replayed against the real socket.
  readonly #pendingOpen: Array<() => void> = [];
  readonly #pendingMessage: Array<(bytes: Uint8Array) => void> = [];
  readonly #pendingClose: Array<(reason?: string) => void> = [];
  readonly #pendingError: Array<() => void> = [];

  constructor(options: MobileHostedRelaySocketOptions) {
    const now = options.now ?? (() => Date.now());
    const resolveRelayUrl = options.relayUrl ?? mobileHostedRelayUrl;
    this.url = options.url;

    // Fail closed before any socket exists: the ticket may only be sent to the
    // origin-pinned relay endpoint, and an expired attempt must never reach the
    // wire. The engine repeats the expiry check, but this runs first so no
    // socket is created at all.
    if (options.url !== resolveRelayUrl() || options.ticketExpiresAt <= now()) {
      this.#disposePreparedContext(options);
      throw new Error(INVALID_ATTEMPT);
    }

    // The engine drives this seam. Until the proof mint resolves there is no
    // platform socket, so it must report CONNECTING — never OPEN, which would
    // let the engine send before the wire is up — and buffer its listener
    // registrations for replay against the real socket.
    const readSocket = (): NativeSocketLike | null => this.#socket;
    const relaySocket: RelaySocket = {
      get bufferedAmount() {
        return readSocket()?.bufferedAmount ?? 0;
      },
      get readyState() {
        return readSocket()?.readyState ?? CONNECTING;
      },
      // Copy synchronously: the engine zeroes every buffer immediately after
      // `send` returns, so retaining the caller's array for async transmission
      // would put zeros on the wire.
      send: (bytes) => {
        const socket = readSocket();
        if (!socket) throw new Error("Relay channel is not open.");
        socket.send(Uint8Array.from(bytes).buffer as ArrayBuffer);
      },
      close: (code, reason) => readSocket()?.close(code, reason),
      onOpen: (listener) => this.#pendingOpen.push(listener),
      onBinaryMessage: (listener) => this.#pendingMessage.push(listener),
      onClose: (listener) => this.#pendingClose.push(listener),
      onError: (listener) => this.#pendingError.push(listener),
    };

    try {
      this.#engine = new HostedRelayEngine({
        ticket: options.ticket,
        ticketExpiresAt: options.ticketExpiresAt,
        socket: relaySocket,
        callbacks: options.callbacks,
        ...(options.e2ee === undefined ? {} : { e2ee: options.e2ee }),
        timers: {
          // Bound wrappers: unbound platform methods throw "Illegal invocation".
          now,
          setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
          clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
          queueMicrotask: (callback) =>
            typeof globalThis.queueMicrotask === "function"
              ? globalThis.queueMicrotask(callback)
              : void Promise.resolve().then(callback),
        },
        events: {
          onOpen: () => {
            this.#state = OPEN;
            this.#emit({ type: "open" });
          },
          onData: (bytes) => this.#emit({ type: "message", data: bytes }),
          onError: () => this.#emit({ type: "error" }),
          onClose: (code, reason) => {
            this.#disposePreparedContext(options);
            this.#state = CLOSED;
            this.#emit({
              type: "close",
              code,
              reason,
              wasClean: code === 1000,
            });
          },
        },
      });
    } catch (error) {
      this.#abandoned = true;
      this.#disposePreparedContext(options);
      throw error;
    }

    void this.#openWhenAuthorized(options);
  }

  /**
   * Mint the DPoP proof, then open the platform socket with the upgrade
   * headers. On failure the facade fails closed within the ticket's life: it
   * emits `error` then `close` and never opens a socket. It must never hang and
   * must never put the proof or token into an error.
   */
  async #openWhenAuthorized(options: MobileHostedRelaySocketOptions): Promise<void> {
    try {
      // Yield before doing anything that can fail. An async function runs
      // synchronously up to its first `await`, so a failure detected before one
      // — a missing bearer token — would emit `error`/`close` from inside the
      // constructor, before the caller has registered any listener, and the
      // attempt would hang instead of failing closed.
      await Promise.resolve();
      const readToken =
        options.readBearerToken ?? (() => mobileSessionCredentials.readBearerToken?.() ?? null);
      const token = readToken();
      if (token === null || token.length === 0) throw new Error(UPGRADE_FAILED);
      const signer = await (options.dpopSigner ?? createMobileDpopSigner)();
      const proof = await signer.sign({ method: "GET", url: this.url, token });
      if (this.#abandoned) return;

      // These are the only headers this adapter sets. It deliberately sets no
      // `Cookie` — one on this upgrade is a hard 403 server-side.
      //
      // It cannot *guarantee* the absence of one, and that limit is worth being
      // precise about: React Native's own WebSocket module attaches a `Cookie`
      // from the app-global store (Android `ForwardingCookieHandler` →
      // `CookieManager`; iOS `NSHTTPCookieStorage`) before these headers, and
      // appends rather than replaces, so nothing passed here can remove it. It
      // also always sets `Origin`, which the Hub does not check on this branch.
      // The protection is therefore upstream: no in-app WebView ships, and the
      // authorization handoff uses the OS-managed system browser whose cookies
      // never enter the app-global store. Owner acceptance row 8 is what proves
      // it end to end.
      const socket = (options.createSocket ?? defaultCreateSocket)(this.url, {
        Authorization: `DPoP ${token}`,
        DPoP: proof,
      });
      socket.binaryType = "arraybuffer";
      this.#socket = socket;

      socket.addEventListener("open", () => {
        for (const listener of this.#pendingOpen) listener();
      });
      socket.addEventListener("message", (event: never) => {
        const message = classifyInboundMessage((event as { data?: unknown }).data);
        if ("bytes" in message) {
          for (const listener of this.#pendingMessage) listener(message.bytes);
        } else {
          this.#engine.reportUndecodableMessage(message.fail);
        }
      });
      socket.addEventListener("close", (event: { readonly reason?: string }) => {
        for (const listener of this.#pendingClose) listener(event.reason);
      });
      socket.addEventListener("error", () => {
        for (const listener of this.#pendingError) listener();
      });
    } catch {
      // Bounded: never surface the proof, token, or ticket.
      if (this.#abandoned) return;
      this.#abandoned = true;
      // Fail the engine first. It owns the ticket buffer and the failure
      // callback the shared transport reads; closing only the facade would look
      // like an ordinary close, so the transport would reconnect and issue a
      // fresh ticket — turning a permanent key failure into an unbounded ticket
      // loop instead of a terminal state.
      try {
        this.#engine.reportUndecodableMessage("protocol_invalid");
      } catch {
        // Already closed; the fallback below still settles the facade.
      }
      // The engine drives `error` and `close` back through its own events, so
      // emit here only if it was already closed and did nothing.
      if (this.#state !== CLOSED) {
        this.#disposePreparedContext(options);
        this.#emit({ type: "error" });
        this.#state = CLOSED;
        this.#emit({
          type: "close",
          code: 4401,
          reason: UPGRADE_FAILED,
          wasClean: false,
        });
      }
    }
  }

  get readyState(): number {
    return this.#state;
  }

  /** Backpressure is the engine's view, not the raw socket's. */
  get bufferedAmount(): number {
    return this.#engine.bufferedAmount;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : (() => {
                throw new Error("Unsupported relay payload.");
              })();
    // React Native has no DOMException, so the engine's messages are preserved
    // on plain Errors rather than mapped to DOMException names as on web. That
    // includes both §11.4 `e2ee_send_unavailable` cases — while negotiation is
    // buffered and while established protection work is at its bounded
    // ceiling. This is deliberately the identity mapping rather than an
    // adapter-specific wrapper, including for RPC keepalive writes. Re-throwing
    // as a new Error would discard the stack and make ordinary backpressure —
    // the channel is unaffected and the caller may submit again — look like a
    // failure originating here.
    this.#engine.send(Uint8Array.from(bytes));
  }

  close(code = 1000, reason = ""): void {
    if (this.#state === CLOSED || this.#state === CLOSING) return;
    this.#state = CLOSING;
    // Abandon any in-flight proof mint. Without this, a close issued while
    // signing is pending still opens an authenticated upgrade when the proof
    // resolves — against an engine that is already closed, so it would never
    // be authenticated or torn down.
    this.#abandoned = true;
    this.#engine.close(code, reason);
  }

  #disposePreparedContext(options: MobileHostedRelaySocketOptions): void {
    if (this.#preparedContextDisposed) return;
    this.#preparedContextDisposed = true;
    options.disposePreparedContext?.();
  }

  addEventListener(
    type: string,
    listener: FacadeListener,
    options?: { readonly once?: boolean },
  ): void {
    const set = this.#listeners.get(type) ?? new Set<Registration>();
    set.add({ listener, once: options?.once ?? false });
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: FacadeListener): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    // Snapshot: deleting from the live set while walking it would skip entries.
    for (const registration of [...set]) {
      if (registration.listener === listener) set.delete(registration);
    }
  }

  #emit(event: FacadeEvent): void {
    const set = this.#listeners.get(event.type);
    if (set) {
      // Snapshot: `{once:true}` deletes during the walk, and Effect's socket
      // layer registers its open/error/close handlers exactly that way.
      for (const registration of [...set]) {
        if (registration.once) set.delete(registration);
        registration.listener(event);
      }
    }
    const handler = (
      {
        open: this.onopen,
        message: this.onmessage,
        error: this.onerror,
        close: this.onclose,
      } as Record<string, FacadeListener | null>
    )[event.type];
    if (handler) handler(event);
  }
}
