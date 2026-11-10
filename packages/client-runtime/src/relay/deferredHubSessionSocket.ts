/**
 * The account session socket of a native app, whose upgrade needs an
 * asynchronously minted DPoP proof before the platform WebSocket can exist.
 *
 * `HostedHubSession.createSocket` is synchronous: a browser opens its socket at
 * once and the cookie rides along. A native app first signs a proof over the
 * upgrade (a Secure Enclave or OS key-store operation) and passes it as a
 * header. This adapter is the `HubSessionSocket` the session drives meanwhile:
 * it reports CONNECTING, refuses sends, and replays the session's listener
 * registrations against the platform socket once it exists. A failed mint ends
 * it with `error` then `close`, so the session's ordinary loss path retries.
 *
 * Platform-neutral: React Native's WebSocket and Node's `ws` both expose the
 * DOM-style `addEventListener` this needs.
 *
 * @module relay/deferredHubSessionSocket
 */
import type { HubSessionSocket } from "./hostedHubSession.ts";

/** The part of a platform WebSocket this adapter drives. */
export interface EventWebSocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

const CONNECTING = 0;
const CLOSED = 3;

/** Inbound data as relay bytes, copied; `undefined` for anything that is not binary. */
function binaryBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (Array.isArray(data)) {
    // `ws` delivers a fragmented message as a list of buffers.
    const parts = data.filter((part): part is Uint8Array => ArrayBuffer.isView(part));
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      combined.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
      offset += part.byteLength;
    }
    return combined;
  }
  return undefined;
}

/** A `HubSessionSocket` whose platform socket `open` creates once its upgrade is authorized. */
export function createDeferredHubSessionSocket(
  open: () => Promise<EventWebSocketLike>,
): HubSessionSocket {
  let socket: EventWebSocketLike | null = null;
  let closed = false;
  const openListeners: Array<() => void> = [];
  const messageListeners: Array<(bytes: Uint8Array) => void> = [];
  const closeListeners: Array<(reason?: string, code?: number) => void> = [];
  const errorListeners: Array<() => void> = [];
  let ended = false;
  const end = (reason: string, code: number) => {
    if (ended) return;
    ended = true;
    for (const listener of closeListeners) listener(reason, code);
  };

  void Promise.resolve()
    .then(open)
    .then(
      (created) => {
        if (closed) {
          created.close(1000, "closed");
          return;
        }
        socket = created;
        created.binaryType = "arraybuffer";
        created.addEventListener("open", () => {
          for (const listener of openListeners) listener();
        });
        created.addEventListener("message", (event: never) => {
          const bytes = binaryBytes((event as { readonly data?: unknown }).data);
          if (bytes === undefined) {
            created.close(1002, "protocol_invalid");
            return;
          }
          for (const listener of messageListeners) listener(bytes);
        });
        created.addEventListener("close", (event: never) => {
          const { reason, code } = event as { readonly reason?: string; readonly code?: number };
          end(reason ?? "", code ?? 1006);
        });
        created.addEventListener("error", () => {
          for (const listener of errorListeners) listener();
        });
      },
      () => {
        // The upgrade could not be authorized (no token, a failed proof). The
        // error carries neither; the session's loss path takes it from here.
        for (const listener of errorListeners) listener();
        end("unauthorized", 1006);
      },
    );

  return {
    get bufferedAmount() {
      return socket?.bufferedAmount ?? 0;
    },
    get readyState() {
      if (socket !== null) return socket.readyState;
      return closed ? CLOSED : CONNECTING;
    },
    // Copied: the session zeroes its frame as soon as this returns.
    send: (bytes) => {
      if (socket === null) throw new Error("Hub session socket is not open.");
      socket.send(Uint8Array.from(bytes).buffer as ArrayBuffer);
    },
    close: (code, reason) => {
      closed = true;
      if (socket !== null) socket.close(code, reason);
      else end(reason ?? "closed", code ?? 1000);
    },
    onOpen: (listener) => openListeners.push(listener),
    onBinaryMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    onError: (listener) => errorListeners.push(listener),
  };
}
