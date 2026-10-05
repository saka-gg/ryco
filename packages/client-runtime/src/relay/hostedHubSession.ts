import {
  HUB_SESSION_CLOSE_REASON_BYTES,
  HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS,
  HUB_SESSION_HEARTBEAT_INTERVAL_MS,
  HUB_SESSION_MAX_CHANNELS,
  HUB_SESSION_MAX_QUEUED_BYTES,
  HUB_SESSION_MAX_QUEUED_FRAMES,
  type HubSessionFrame,
} from "@ryco/contracts/hub-session";
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
export interface HostedHubSessionOptions {
  readonly createSocket: () => HubSessionSocket;
  readonly timers: RelayTimers;
  readonly random?: () => number;
  readonly onStatus?: (status: HostedHubSessionStatus) => void;
  readonly onFailure?: (failure: {
    readonly kind: "network" | "protocol" | "authentication";
    readonly retryable: boolean;
  }) => void;
  readonly onInvalidate?: (event: HostedHubSessionInvalidation) => void;
}
interface LogicalStream {
  readonly id: number;
  state: number;
  opened: boolean;
  readonly open: Set<() => void>;
  readonly message: Set<(bytes: Uint8Array) => void>;
  readonly close: Set<(reason?: string) => void>;
  readonly error: Set<() => void>;
}
interface QueuedFrame {
  readonly streamId: number;
  readonly bytes: Uint8Array;
}
const SEND_HIGH_WATER_BYTES = 256 * 1_024;
const CONTROL_RESERVE_BYTES = 4 * 1_024;
const READY_TIMEOUT_MS = 10_000;

/** One account-owned physical connection; logical relay tickets and E2EE remain per node. */
export class HostedHubSession {
  readonly #options: HostedHubSessionOptions;
  readonly #streams = new Map<number, LogicalStream>();
  readonly #invalidations = new Set<(event: HostedHubSessionInvalidation) => void>();
  #socket: HubSessionSocket | null = null;
  #disposed = false;
  #started = false;
  #ready = false;
  #nextStream = 0;
  #maxChannels = HUB_SESSION_MAX_CHANNELS;
  #failures = 0;
  #retry: unknown;
  #deadline: unknown;
  #heartbeat: unknown;
  #drain: unknown;
  #queue: QueuedFrame[] = [];
  #queueBytes = 0;
  #lastReceived = 0;
  #onlineAt = 0;
  #probeSequence = 0;
  #probe: Uint8Array | null = null;

  constructor(options: HostedHubSessionOptions) {
    this.#options = options;
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

  createSocket(): RelaySocket {
    if (this.#disposed) throw new Error("Hub session is closed.");
    if (this.#streams.size >= this.#maxChannels || this.#nextStream >= 0xffff_ffff)
      throw new Error("Hub session channel capacity reached.");
    const stream: LogicalStream = {
      id: ++this.#nextStream,
      state: 0,
      opened: false,
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
    if (this.#ready) this.#options.timers.queueMicrotask(() => this.#openStream(stream));
    return socket;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
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
    try {
      socket = this.#options.createSocket();
    } catch {
      this.#lost("network", true);
      return;
    }
    this.#socket = socket;
    this.#ready = false;
    const current = () => this.#socket === socket && !this.#disposed;
    socket.onOpen(() => {
      /* READY, not the TCP upgrade, authenticates the session. */
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
    const decoded = decodeHubSessionFrame(bytes);
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
      this.#maxChannels = frame.maxChannels;
      this.#lastReceived = this.#options.timers.now();
      this.#onlineAt = this.#lastReceived;
      this.#clearTimer("deadline");
      this.#options.onStatus?.("online");
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
    switch (frame.type) {
      case "ping":
        this.#sendControl({ type: "pong", nonce: frame.nonce });
        return;
      case "pong":
        if (!this.#probe || !frame.nonce.every((byte, index) => byte === this.#probe![index])) {
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
          if (frame.streamId > this.#nextStream) this.#lost("protocol", false);
          return;
        }
        if (stream.state !== 1) {
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

  #openStream(stream: LogicalStream): void {
    if (!this.#ready || this.#streams.get(stream.id) !== stream || stream.state !== 0) return;
    try {
      this.#send({ type: "open", streamId: stream.id });
      if (!this.#ready || this.#streams.get(stream.id) !== stream) return;
      stream.opened = true;
      stream.state = 1;
      for (const listener of Array.from(stream.open)) listener();
    } catch {
      this.#closeStream(stream, 4429, "channel unavailable", false);
    }
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
        socket.send(bytes);
      } finally {
        bytes.fill(0);
      }
      return;
    }
    this.#queue.push({ streamId: "streamId" in frame ? frame.streamId : 0, bytes });
    this.#queueBytes += bytes.byteLength;
    this.#scheduleDrain();
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
          socket.send(entry.bytes);
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
        if (!this.#probe) {
          this.#probe = new Uint8Array(8);
          new DataView(this.#probe.buffer).setUint32(4, ++this.#probeSequence);
          this.#sendControl({ type: "ping", nonce: this.#probe });
        }
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
    if (this.#ready && this.#options.timers.now() - this.#onlineAt >= 30_000) this.#failures = 0;
    this.#socket = null;
    this.#ready = false;
    this.#probe = null;
    this.#clearTimers();
    this.#discardQueue();
    for (const stream of Array.from(this.#streams.values()))
      this.#closeStream(stream, 1012, "session unavailable", false);
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

  #discardQueue(): void {
    for (const entry of this.#queue) entry.bytes.fill(0);
    this.#queue = [];
    this.#queueBytes = 0;
  }
  #clearTimer(kind: "retry" | "deadline" | "heartbeat" | "drain"): void {
    const timer =
      kind === "retry"
        ? this.#retry
        : kind === "deadline"
          ? this.#deadline
          : kind === "heartbeat"
            ? this.#heartbeat
            : this.#drain;
    if (timer !== undefined) this.#options.timers.clearTimeout(timer);
    if (kind === "retry") this.#retry = undefined;
    else if (kind === "deadline") this.#deadline = undefined;
    else if (kind === "heartbeat") this.#heartbeat = undefined;
    else this.#drain = undefined;
  }
  #clearTimers(): void {
    for (const kind of ["retry", "deadline", "heartbeat", "drain"] as const) this.#clearTimer(kind);
  }
}
