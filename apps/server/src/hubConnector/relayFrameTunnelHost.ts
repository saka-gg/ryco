/**
 * The node's end of the relay frame tunnel (`@ryco/shared/relayFrameTunnel`)
 * on one end-to-end encrypted relay channel.
 *
 * A hosted client has no frame socket to the node, so it opens streams inside
 * its relay channel instead, and each stream is a device frame viewer
 * (`device/deviceFrameViewer`) exactly like the direct `/ws/device-frames`
 * socket: frame envelopes out as `binary` messages, live input as `text` both
 * ways. Loaded with a channel's first tunnel message, never at boot.
 *
 * Flow control. The client acknowledges binary messages with a cumulative
 * count, and a stream's backlog — bytes handed to the channel and not yet
 * acknowledged — is the sink's `bufferedAmount`, held to
 * `RELAY_FRAME_TUNNEL_WINDOW_BYTES` by the frame transport's per-sink budget.
 * Beyond the window the transport queues and then drops until a keyframe, the
 * policy the direct socket has; an acknowledgement that opens the window
 * drains the queue at once, so a still screen does not strand frames.
 *
 * A frame the channel refuses (`backpressure`, `too_large`) is gone after the
 * transport counted it delivered, so the decoder's references are gone too.
 * The stream then forwards nothing but codec config until a keyframe, and asks
 * the device for one at most once per `RELAY_FRAME_TUNNEL_KEYFRAME_REQUEST_MS`
 * (a request restarts the capture on iOS), so the picture resumes cleanly
 * instead of waiting for the encoder's next natural IDR. `unavailable` means
 * the channel carries nothing more: the stream closes without a message.
 *
 * Rate. The relay counts every byte a channel carries against a per-channel
 * transfer budget (docs/relay-capacity-assessment-3b.md) and ends a channel
 * that overspends it with `transfer_limit` — RPC included. Full-resolution
 * video during a drag runs at several MB/s, so the host spends at most
 * `RELAY_FRAME_TUNNEL_BURST_BYTES` up front and then
 * `RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND`, across all of a channel's
 * streams, leaving room for RPC. A frame over budget is dropped like a refused
 * one, and the keyframe that resumes the stream is asked for only once the
 * budget can carry one (`RELAY_FRAME_TUNNEL_KEYFRAME_RESERVE_BYTES`). The
 * picture degrades to a lower frame rate on a long drag instead of the
 * channel closing.
 *
 * @module hubConnector/relayFrameTunnelHost
 */
import { DeviceUdid } from "@ryco/contracts";
import { peekDeviceFrameHeader } from "@ryco/shared/deviceFrame";
import {
  RELAY_FRAME_TUNNEL_CLOSE,
  RELAY_FRAME_TUNNEL_MAX_STREAMS,
  RELAY_FRAME_TUNNEL_WINDOW_BYTES,
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelBinary,
  encodeRelayFrameTunnelClose,
  encodeRelayFrameTunnelText,
} from "@ryco/shared/relayFrameTunnel";

import type { DeviceFrameSink } from "../device/deviceFrameTransport.ts";
import {
  openDeviceFrameViewer,
  type DeviceFrameViewer,
  type DeviceFrameViewerTarget,
} from "../device/deviceFrameViewer.ts";
import type { NodeE2eeEmitResult } from "./NodeE2eeChannelSession.ts";

/** The least time between two keyframe requests one stream makes after a refused frame. */
export const RELAY_FRAME_TUNNEL_KEYFRAME_REQUEST_MS = 1_000;
/** Video bytes a channel may spend at once before the sustained rate applies. */
export const RELAY_FRAME_TUNNEL_BURST_BYTES = 16 * 1_024 * 1_024;
/** Video bytes per second a channel spends once its burst is gone. */
export const RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND = 768 * 1_024;
/** Budget a resuming keyframe waits for (a full-resolution iPhone keyframe fits). */
export const RELAY_FRAME_TUNNEL_KEYFRAME_RESERVE_BYTES = 384 * 1_024;

export interface RelayFrameTunnelDevices {
  /** False where the node streams no devices; every open is then `unavailable`. */
  readonly supported: boolean;
  readonly manager: DeviceFrameViewerTarget;
}

export interface RelayFrameTunnelHostOptions {
  /** The channel's §4.2 send pipeline (`NodeE2eeChannelSession.emit`). */
  readonly emit: (bytes: Uint8Array) => Promise<NodeE2eeEmitResult>;
  /** Whether this channel's role may send live input (`relayFrameTunnelCanDrive`). */
  readonly canDrive: boolean;
  readonly devices: RelayFrameTunnelDevices | null;
  readonly now?: () => number;
  /** Run `task` after `delayMs`; returns its cancel. A timer by default. */
  readonly schedule?: (task: () => void, delayMs: number) => () => void;
}

export interface RelayFrameTunnelHost {
  /** One tunnel message, the body of an inner RPC record. Malformed ones are dropped. */
  readonly receive: (message: Uint8Array) => void;
  /** The channel is ending: close every stream, lifting held touches and keys. */
  readonly close: () => void;
  readonly streamCount: () => number;
}

/** One binary message handed to the channel and not yet acknowledged. */
interface Outstanding {
  readonly bytes: number;
  /** `pending` until `emit` settles; `dropped` when the channel refused it. */
  state: "pending" | "sent" | "dropped";
}

interface TunnelStream {
  readonly id: number;
  readonly udid: string;
  viewer: DeviceFrameViewer | null;
  open: boolean;
  /** Oldest first. Dropped entries are skipped by acknowledgements. */
  readonly outstanding: Outstanding[];
  outstandingBytes: number;
  /** Binary messages acknowledged so far, modulo 2^32, as the client counts them. */
  acknowledged: number;
  readonly drainListeners: Set<() => void>;
  /** Set by a refused frame: forward nothing but codec config until a keyframe. */
  awaitingKeyframe: boolean;
  lastKeyframeRequestAt: number;
  cancelKeyframeRequest: (() => void) | null;
}

const defaultSchedule = (task: () => void, delayMs: number) => {
  const timer = setTimeout(task, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function makeRelayFrameTunnelHost(
  options: RelayFrameTunnelHostOptions,
): RelayFrameTunnelHost {
  const { canDrive, devices } = options;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const streams = new Map<number, TunnelStream>();
  let hostOpen = true;
  // The channel's video budget, shared by its streams (see "Rate" above).
  let budget = RELAY_FRAME_TUNNEL_BURST_BYTES;
  let budgetAt = now();
  const refillBudget = () => {
    const at = now();
    budget = Math.min(
      RELAY_FRAME_TUNNEL_BURST_BYTES,
      budget + ((at - budgetAt) * RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND) / 1_000,
    );
    budgetAt = at;
  };
  /** Milliseconds until the budget can carry a resuming keyframe. */
  const budgetWaitMs = () => {
    refillBudget();
    const missing = RELAY_FRAME_TUNNEL_KEYFRAME_RESERVE_BYTES - budget;
    return missing <= 0
      ? 0
      : Math.ceil((missing * 1_000) / RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND);
  };

  const emit = (bytes: Uint8Array): Promise<NodeE2eeEmitResult> =>
    options.emit(bytes).catch((): NodeE2eeEmitResult => "unavailable");

  const sendClose = (streamId: number, code: number, reason: string) => {
    void emit(encodeRelayFrameTunnelClose(streamId, code, reason));
  };

  /** Forget a stream. `notify` sends the client a `close` for it. */
  const endStream = (
    stream: TunnelStream,
    notify?: { readonly code: number; readonly reason: string },
  ) => {
    if (!stream.open) return;
    stream.open = false;
    if (streams.get(stream.id) === stream) streams.delete(stream.id);
    stream.cancelKeyframeRequest?.();
    stream.cancelKeyframeRequest = null;
    stream.drainListeners.clear();
    stream.outstanding.length = 0;
    stream.outstandingBytes = 0;
    stream.viewer?.close();
    stream.viewer = null;
    if (notify) sendClose(stream.id, notify.code, notify.reason);
  };

  const drained = (stream: TunnelStream) => {
    for (const listener of [...stream.drainListeners]) {
      if (!stream.open) return;
      listener();
    }
  };

  const trimDropped = (stream: TunnelStream) => {
    while (stream.outstanding[0]?.state === "dropped") stream.outstanding.shift();
  };

  const requestKeyframe = (stream: TunnelStream) => {
    if (!stream.open || !stream.awaitingKeyframe || stream.cancelKeyframeRequest) return;
    const wait = Math.max(
      stream.lastKeyframeRequestAt + RELAY_FRAME_TUNNEL_KEYFRAME_REQUEST_MS - now(),
      budgetWaitMs(),
    );
    if (wait > 0) {
      stream.cancelKeyframeRequest = schedule(() => {
        stream.cancelKeyframeRequest = null;
        requestKeyframe(stream);
      }, wait);
      return;
    }
    stream.lastKeyframeRequestAt = now();
    void devices?.manager.requestKeyframe(stream.udid).catch(() => undefined);
  };

  const settle = (stream: TunnelStream, entry: Outstanding, result: NodeE2eeEmitResult) => {
    if (!stream.open) return;
    if (result === "sent") {
      if (entry.state === "pending") entry.state = "sent";
      return;
    }
    if (result === "unavailable") {
      // The channel will carry no further application record, a close included.
      endStream(stream);
      return;
    }
    // `backpressure` or `too_large`: the frame is gone, and with it what the
    // next P-frames reference.
    if (entry.state === "pending") {
      entry.state = "dropped";
      stream.outstandingBytes -= entry.bytes;
      trimDropped(stream);
    }
    stream.awaitingKeyframe = true;
    requestKeyframe(stream);
    drained(stream);
  };

  const sendBinary = (stream: TunnelStream, envelope: Uint8Array) => {
    if (!stream.open) return;
    if (stream.awaitingKeyframe) {
      const header = peekDeviceFrameHeader(envelope);
      if (header?.keyframe) {
        stream.awaitingKeyframe = false;
        stream.cancelKeyframeRequest?.();
        stream.cancelKeyframeRequest = null;
      } else if (!header?.codecConfig) {
        return;
      }
    }
    const message = encodeRelayFrameTunnelBinary(stream.id, envelope);
    refillBudget();
    if (budget < message.byteLength && !peekDeviceFrameHeader(envelope)?.codecConfig) {
      // Over the channel's video budget: dropped, as a refused frame is.
      stream.awaitingKeyframe = true;
      requestKeyframe(stream);
      return;
    }
    budget = Math.max(0, budget - message.byteLength);
    const entry: Outstanding = { bytes: message.byteLength, state: "pending" };
    stream.outstanding.push(entry);
    stream.outstandingBytes += entry.bytes;
    void emit(message).then((result) => settle(stream, entry, result));
  };

  const sendText = (stream: TunnelStream, text: string) => {
    if (!stream.open) return;
    // Tiny, and not windowed: input-ready and input errors only.
    void emit(encodeRelayFrameTunnelText(stream.id, text)).then((result) => {
      if (result === "unavailable") endStream(stream);
    });
  };

  const acknowledge = (stream: TunnelStream, received: number) => {
    // Cumulative and modulo 2^32. A count beyond what was handed to the
    // channel frees only what was: the window never opens past what is out.
    let remaining = (received - stream.acknowledged) >>> 0;
    let applied = 0;
    while (remaining > 0 && stream.outstanding.length > 0) {
      const entry = stream.outstanding.shift()!;
      if (entry.state === "dropped") continue;
      // A `pending` entry the client already has was sent; its settle is a no-op.
      stream.outstandingBytes -= entry.bytes;
      entry.state = "dropped";
      remaining -= 1;
      applied += 1;
    }
    trimDropped(stream);
    stream.acknowledged = (stream.acknowledged + applied) >>> 0;
    if (applied > 0) drained(stream);
  };

  const openStream = (streamId: number, rawUdid: string) => {
    const existing = streams.get(streamId);
    if (existing) {
      // Both ends must agree on what the id names; the one close covers both.
      endStream(existing);
      sendClose(streamId, RELAY_FRAME_TUNNEL_CLOSE.refused, "Duplicate stream id.");
      return;
    }
    if (streams.size >= RELAY_FRAME_TUNNEL_MAX_STREAMS) {
      sendClose(streamId, RELAY_FRAME_TUNNEL_CLOSE.refused, "Too many streams on this channel.");
      return;
    }
    if (!devices?.supported) {
      sendClose(streamId, RELAY_FRAME_TUNNEL_CLOSE.unavailable, "Device streaming is unavailable.");
      return;
    }
    let udid: string;
    try {
      udid = DeviceUdid.make(rawUdid);
    } catch {
      sendClose(streamId, RELAY_FRAME_TUNNEL_CLOSE.unavailable, "Invalid device.");
      return;
    }
    const stream: TunnelStream = {
      id: streamId,
      udid,
      viewer: null,
      open: true,
      outstanding: [],
      outstandingBytes: 0,
      acknowledged: 0,
      drainListeners: new Set(),
      awaitingKeyframe: false,
      lastKeyframeRequestAt: Number.NEGATIVE_INFINITY,
      cancelKeyframeRequest: null,
    };
    // Registered first: subscribing primes the sink synchronously.
    streams.set(streamId, stream);
    const sink: DeviceFrameSink = {
      send: (bytes) => sendBinary(stream, bytes),
      bufferedAmount: () => stream.outstandingBytes,
      isOpen: () => stream.open,
      budgetBytes: RELAY_FRAME_TUNNEL_WINDOW_BYTES,
      onDrain: (listener) => {
        stream.drainListeners.add(listener);
        return () => stream.drainListeners.delete(listener);
      },
    };
    try {
      const viewer = openDeviceFrameViewer({
        udid,
        canDrive,
        sink,
        sendText: (text) => sendText(stream, text),
        target: devices.manager,
      });
      if (stream.open) stream.viewer = viewer;
      else viewer.close();
    } catch {
      endStream(stream, {
        code: RELAY_FRAME_TUNNEL_CLOSE.unavailable,
        reason: "Device streaming is unavailable.",
      });
    }
  };

  return {
    receive: (bytes) => {
      if (!hostOpen) return;
      const message = decodeRelayFrameTunnelMessage(bytes);
      if (message === null) return;
      switch (message.kind) {
        case "open":
          openStream(message.streamId, message.target.udid);
          return;
        case "close": {
          const stream = streams.get(message.streamId);
          if (stream) endStream(stream);
          return;
        }
        case "text":
          streams.get(message.streamId)?.viewer?.receive(message.text);
          return;
        case "ack": {
          const stream = streams.get(message.streamId);
          if (stream) acknowledge(stream, message.received);
          return;
        }
        case "binary":
          // Nothing the client sends is binary; ignored like unknown ids.
          return;
      }
    },
    close: () => {
      if (!hostOpen) return;
      hostOpen = false;
      for (const stream of [...streams.values()]) endStream(stream);
    },
    streamCount: () => streams.size,
  };
}
