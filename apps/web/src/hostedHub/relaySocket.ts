import {
  HostedRelayEngine,
  RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE,
  RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE,
  RELAY_MESSAGE_TOO_LARGE_MESSAGE,
  RELAY_PEER_UNSUPPORTED_MESSAGE,
  RELAY_SEND_QUEUE_FULL_MESSAGE,
  type HostedRelaySocketCallbacks,
  type RelayE2eeProvider,
  type RelaySocket,
} from "@ryco/client-runtime/relay";

export type { HostedRelaySocketCallbacks };
export interface HostedRelaySocketOptions {
  readonly url: string;
  readonly ticket: string;
  readonly ticketExpiresAt: number;
  readonly callbacks: HostedRelaySocketCallbacks;
  readonly createSocket?: (url: string) => WebSocket;
  /**
   * docs/relay-e2ee-protocol.md §4.4: the channel's mode machine, built at
   * `channel.accept` from the negotiated limits.
   *
   * Supplied by the CALLER rather than constructed here, because §4.4 requires
   * every selection guard — on this tier, §12.1's in-memory latch and the
   * §12.1.1 classification it decides — to be evaluated "before it has received
   * any payload", which means before this socket exists. A caller that supplies
   * none gets the unchanged legacy channel, byte for byte.
   */
  readonly e2ee?: RelayE2eeProvider | undefined;
}
export function hostedRelayWebSocketUrl(): string {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/relay/client";
  return url.toString();
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

type InboundMessage =
  | { readonly bytes: Uint8Array }
  | { readonly fail: "frame_too_large" | "protocol_invalid" };

/**
 * Classify a browser WebSocket message exactly as the original façade did.
 * ArrayBuffer / typed-array views are copied to relay bytes. A raw
 * SharedArrayBuffer carries a byte length but is not a readable view, so it
 * fails closed as an invalid frame; text, Blob, and anything else have no relay
 * byte length and fail closed as an oversized frame. Nothing is silently
 * dropped.
 */
function classifyInboundMessage(data: unknown): InboundMessage {
  if (data instanceof ArrayBuffer) return { bytes: new Uint8Array(data.slice(0)) };
  if (data instanceof Uint8Array) return { bytes: Uint8Array.from(data) };
  if (ArrayBuffer.isView(data))
    return {
      bytes: Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    };
  if (isSharedArrayBuffer(data)) return { fail: "protocol_invalid" };
  return { fail: "frame_too_large" };
}

/**
 * Every engine send refusal that is about CAPACITY rather than about state.
 *
 * The set is the engine's own exported strings and not four literals, because
 * this mapping is BY MESSAGE: a renamed message silently re-routes a refusal
 * here, and one already had. This arm used to match "RPC payload exceeds the
 * negotiated relay limit.", which the oversized-RPC framing change renamed —
 * after which every over-ceiling submission fell through to `InvalidStateError`
 * and a caller branching on the name read a size refusal as an invalid state.
 *
 * Both E2EE messages are docs/relay-e2ee-protocol.md §11.4
 * `e2ee_send_unavailable`: backpressure like the queue, the channel unaffected,
 * and the caller may submit the same message again. The negotiating message is
 * reachable while §4.4 buffers plaintext; the established-channel message is
 * the synchronous refusal from its bounded protection queue. Both remain quota
 * refusals at this browser boundary, including for RPC keepalive writes.
 */
const QUOTA_EXCEEDED_MESSAGES: ReadonlySet<string> = new Set([
  RELAY_SEND_QUEUE_FULL_MESSAGE,
  RELAY_MESSAGE_TOO_LARGE_MESSAGE,
  RELAY_PEER_UNSUPPORTED_MESSAGE,
  RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE,
  RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE,
]);

/**
 * Map the DOM-free engine's send errors back to the original WebSocket-API
 * DOMException names at the façade boundary.
 *
 * Exported for the mapping's own test: the §4.4 refusal above is reachable only
 * inside one channel's `negotiating` window and never at all without a provider,
 * so a test that could reach it only through `send` would be pinning one
 * caller's timing rather than the contract.
 */
export function sendException(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof DOMException) return error;
  return new DOMException(
    error.message,
    QUOTA_EXCEEDED_MESSAGES.has(error.message) ? "QuotaExceededError" : "InvalidStateError",
  );
}

/** Browser-only EventTarget facade over the package-owned relay engine. */
export class BrowserHostedRelaySocket extends EventTarget {
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  binaryType: BinaryType = "arraybuffer";
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  onopen: ((this: WebSocket, event: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;
  #engine: HostedRelayEngine;
  #state: number = WebSocket.CONNECTING;
  constructor(options: HostedRelaySocketOptions) {
    super();
    this.url = options.url;
    // Fail closed before opening a socket: the bearer ticket may only be sent
    // to the origin-pinned relay endpoint, and an expired attempt must never
    // reach the wire.
    if (options.url !== hostedRelayWebSocketUrl() || options.ticketExpiresAt <= Date.now()) {
      throw new Error("Relay attempt is no longer valid.");
    }
    const ws = (options.createSocket ?? ((url) => new WebSocket(url)))(options.url);
    ws.binaryType = "arraybuffer";
    const socket: RelaySocket = {
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      get readyState() {
        return ws.readyState;
      },
      send: (b) => ws.send(Uint8Array.from(b).buffer),
      close: (c, r) => ws.close(c, r),
      onOpen: (f) => ws.addEventListener("open", f),
      onBinaryMessage: (f) =>
        ws.addEventListener("message", (e) => {
          const message = classifyInboundMessage(e.data);
          if ("bytes" in message) f(message.bytes);
          else this.#engine.reportUndecodableMessage(message.fail);
        }),
      onClose: (f) => ws.addEventListener("close", (event) => f(event.reason)),
      onError: (f) => ws.addEventListener("error", f),
    };
    try {
      this.#engine = new HostedRelayEngine({
        ticket: options.ticket,
        ticketExpiresAt: options.ticketExpiresAt,
        socket,
        callbacks: options.callbacks,
        ...(options.e2ee === undefined ? {} : { e2ee: options.e2ee }),
        timers: {
          now: () => Date.now(),
          setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
          clearTimeout: (id) => globalThis.clearTimeout(id as number),
          queueMicrotask: (f) => globalThis.queueMicrotask(f),
        },
        events: {
          onOpen: () => {
            this.#state = WebSocket.OPEN;
            this.#emit("open", new Event("open"));
          },
          onData: (b) => this.#emit("message", new MessageEvent("message", { data: b })),
          onError: () => this.#emit("error", new Event("error")),
          onClose: (c, r) => {
            this.#state = WebSocket.CLOSED;
            this.#emit(
              "close",
              new CloseEvent("close", {
                code: c,
                reason: r,
                wasClean: c === 1000,
              }),
            );
          },
        },
      });
    } catch (error) {
      try {
        ws.close();
      } catch {
        // The underlying socket may already be closing.
      }
      throw error;
    }
  }
  get readyState() {
    return this.#state;
  }
  get bufferedAmount() {
    return this.#engine.bufferedAmount;
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const b =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer || isSharedArrayBuffer(data)
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : (() => {
                throw new DOMException("Blob RPC writes are unsupported.", "DataError");
              })();
    try {
      this.#engine.send(Uint8Array.from(b));
    } catch (error) {
      throw sendException(error);
    }
  }
  close(code = 1000, reason = "") {
    if (this.#state === WebSocket.CLOSED || this.#state === WebSocket.CLOSING) return;
    this.#state = WebSocket.CLOSING;
    this.#engine.close(code, reason);
  }
  #emit(type: "open" | "message" | "error" | "close", event: Event) {
    this.dispatchEvent(event);
    const listener = this[`on${type}`];
    if (listener) listener.call(this as unknown as WebSocket, event as never);
  }
}
export { BrowserHostedRelaySocket as HostedRelayRpcWebSocket };
