import {
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelAck,
  encodeRelayFrameTunnelClose,
  encodeRelayFrameTunnelOpen,
  encodeRelayFrameTunnelText,
  RELAY_FRAME_TUNNEL_CLOSE,
  RELAY_FRAME_TUNNEL_MAX_STREAMS,
  type RelayFrameTunnelOpenTarget,
} from "@ryco/shared/relayFrameTunnel";

/**
 * WebSocket close code a tunnelled socket reports when its relay channel ends
 * underneath it, the code a browser reports for an abnormal closure.
 */
export const RELAY_FRAME_TUNNEL_CHANNEL_LOST = 1006;

type Listener = (event: never) => void;

/**
 * One tunnelled frame socket, shaped like the WebSocket the direct path opens
 * (`DeviceFrameWebSocket`), so `createDeviceFrameSource` supervises it
 * unchanged: binary messages are device frame envelopes, text is the live
 * input protocol. Binary messages are acknowledged as they arrive, before any
 * listener runs (`@ryco/shared/relayFrameTunnel`, flow control).
 */
export interface RelayFrameTunnelSocket {
  binaryType: string;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    type: "message" | "close" | "error" | "open",
    listener: Listener,
    options?: unknown,
  ) => void;
}

interface Stream {
  readonly id: number;
  readonly listeners: Map<string, Set<Listener>>;
  received: number;
  ended: boolean;
}

function emit(stream: Stream, type: string, event: unknown): void {
  for (const listener of stream.listeners.get(type) ?? []) {
    try {
      (listener as (event: unknown) => void)(event);
    } catch {
      // A listener's failure is its own; the stream keeps delivering.
    }
  }
}

/**
 * The client half of the relay frame tunnel for one relay channel. The engine
 * owning the channel creates it once the channel locked `e2ee`, hands it every
 * inbound tunnel message, and ends it with the channel; `send` is the engine's
 * encrypted send path and refuses (false) once the channel cannot carry a
 * record.
 */
export class RelayFrameTunnelClient {
  readonly #send: (bytes: Uint8Array) => boolean;
  readonly #schedule: (callback: () => void) => void;
  readonly #streams = new Map<number, Stream>();
  #nextStreamId = 1;
  #closed = false;

  constructor(options: {
    readonly send: (bytes: Uint8Array) => boolean;
    readonly queueMicrotask: (callback: () => void) => void;
  }) {
    this.#send = options.send;
    this.#schedule = options.queueMicrotask;
  }

  /** The channel ended; a new channel needs a new tunnel. */
  get closed(): boolean {
    return this.#closed;
  }

  get openStreams(): number {
    return this.#streams.size;
  }

  /**
   * Open one stream. Events follow the WebSocket ones: `open` once the request
   * is on its way, then messages, then one `close` (the node refused or ended
   * it, the client closed it, or the channel ended).
   */
  openSocket(target: RelayFrameTunnelOpenTarget): RelayFrameTunnelSocket {
    if (this.#closed) throw new Error("The relay channel is closed.");
    if (this.#streams.size >= RELAY_FRAME_TUNNEL_MAX_STREAMS) {
      throw new Error("Too many device streams on this relay channel.");
    }
    const id = this.#nextStreamId;
    this.#nextStreamId = id >= 0xffff_ffff ? 1 : id + 1;
    const stream: Stream = { id, listeners: new Map(), received: 0, ended: false };
    this.#streams.set(id, stream);
    const opened = this.#send(encodeRelayFrameTunnelOpen(id, target));
    const socket: RelayFrameTunnelSocket = {
      binaryType: "arraybuffer",
      send: (data) => {
        if (stream.ended) throw new Error("The device stream is closed.");
        if (!this.#send(encodeRelayFrameTunnelText(id, data))) {
          throw new Error("The relay channel refused the message.");
        }
      },
      close: () => {
        if (stream.ended) return;
        this.#send(encodeRelayFrameTunnelClose(id));
        this.#end(stream, RELAY_FRAME_TUNNEL_CLOSE.normal, "");
      },
      addEventListener: (type, listener) => {
        let set = stream.listeners.get(type);
        if (!set) stream.listeners.set(type, (set = new Set()));
        set.add(listener);
      },
    };
    // Listeners are attached after this returns, as with a WebSocket.
    this.#schedule(() => {
      if (stream.ended) return;
      if (opened) emit(stream, "open", { type: "open" });
      else this.#end(stream, RELAY_FRAME_TUNNEL_CHANNEL_LOST, "");
    });
    return socket;
  }

  /** One inbound tunnel message, already authenticated by the channel. */
  receive(bytes: Uint8Array): void {
    if (this.#closed) return;
    const message = decodeRelayFrameTunnelMessage(bytes);
    if (message === null) return;
    const stream = this.#streams.get(message.streamId);
    // A message for a stream this client closed is normal after the race.
    if (!stream || stream.ended) return;
    switch (message.kind) {
      case "binary":
        stream.received = (stream.received + 1) >>> 0;
        this.#send(encodeRelayFrameTunnelAck(stream.id, stream.received));
        emit(stream, "message", { type: "message", data: message.bytes });
        return;
      case "text":
        emit(stream, "message", { type: "message", data: message.text });
        return;
      case "close":
        this.#end(stream, message.code ?? RELAY_FRAME_TUNNEL_CLOSE.normal, message.reason);
        return;
      case "open":
      case "ack":
        // Client-to-node kinds; a node never sends them.
        return;
    }
  }

  /** The channel ended: every stream closes as lost. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stream of [...this.#streams.values()]) {
      this.#end(stream, RELAY_FRAME_TUNNEL_CHANNEL_LOST, "");
    }
  }

  #end(stream: Stream, code: number, reason: string): void {
    if (stream.ended) return;
    stream.ended = true;
    this.#streams.delete(stream.id);
    this.#schedule(() => {
      emit(stream, "close", { type: "close", code, reason, wasClean: code === 1000 });
      stream.listeners.clear();
    });
  }
}
