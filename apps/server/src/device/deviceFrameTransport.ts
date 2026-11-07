/**
 * Device frame transport - fan-out of encoded video frames to WebSocket clients.
 *
 * Video uses its own authenticated WebSocket, and this module makes sure a slow
 * client can never consume unbounded memory or stall other frame viewers:
 *
 * - Nothing is ever buffered unboundedly. Each subscriber has a bounded queue
 *   and a byte budget; exceeding either drops frames.
 * - Drops are keyframe-aligned. H.264 P-frames referencing a dropped frame
 *   decode into garbage, so once a subscriber falls behind it stays in a
 *   dropping state until the next keyframe, then resumes cleanly.
 * - A subscriber that is behind on the socket itself (`bufferedAmount` above
 *   its budget) is not written to at all, and its queue drains in order, only
 *   while the backlog stays within that budget. A sink that can tell when its
 *   backlog shrank (`onDrain`) has its queue flushed then, rather than with the
 *   next published frame, so a still screen cannot leave frames stuck.
 *
 * New subscribers are primed with the cached codec-config and the most recent
 * keyframe, so a pane opened mid-stream decodes its first frame rather than
 * waiting for the encoder's next IDR.
 *
 * @module device/deviceFrameTransport
 */
import { encodeDeviceFrame } from "@ryco/shared/deviceFrame";

import type { DeviceStreamFrame } from "./DeviceBackend.ts";

/** Frames queued per subscriber before drop-until-keyframe engages. */
export const DEVICE_FRAME_QUEUE_LIMIT = 8;
/** Socket backlog above which a subscriber is considered too slow to write to. */
export const DEVICE_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

export interface DeviceFrameSink {
  /** Deliver one encoded envelope. */
  readonly send: (bytes: Uint8Array) => void;
  /** Bytes already queued on the underlying socket, if the transport knows. */
  readonly bufferedAmount: () => number;
  /** False once the connection is gone; the subscriber is then dropped. */
  readonly isOpen: () => boolean;
  /**
   * This sink's backlog budget in bytes, when it differs from the transport's
   * socket budget: a relay tunnel stream's acknowledgement window, say.
   */
  readonly budgetBytes?: number;
  /**
   * Register a listener the sink calls whenever its backlog shrank, so queued
   * frames go out without waiting for the next published one. Returns the
   * unregister function, which the transport calls when the subscriber leaves.
   */
  readonly onDrain?: (listener: () => void) => () => void;
}

export interface DeviceFrameSubscriberStats {
  readonly sent: number;
  readonly dropped: number;
  readonly awaitingKeyframe: boolean;
  readonly queued: number;
}

interface Subscriber {
  readonly id: string;
  readonly deviceId: string;
  readonly sink: DeviceFrameSink;
  readonly budgetBytes: number;
  readonly queue: Uint8Array[];
  queuedBytes: number;
  removeDrainListener: (() => void) | null;
  awaitingKeyframe: boolean;
  sent: number;
  dropped: number;
}

export interface DeviceFrameTransportOptions {
  readonly queueLimit?: number;
  readonly socketBudgetBytes?: number;
}

/**
 * Routes frames for many devices to many subscribers. One instance per server;
 * subscribers name the device they want.
 */
export class DeviceFrameTransport {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly subscribersByDevice = new Map<string, Set<Subscriber>>();
  private readonly latestKeyframe = new Map<string, Uint8Array>();
  private readonly codecConfig = new Map<string, Uint8Array>();
  private readonly queueLimit: number;
  private readonly socketBudgetBytes: number;
  private nextSubscriberId = 1;

  constructor(options: DeviceFrameTransportOptions = {}) {
    this.queueLimit = options.queueLimit ?? DEVICE_FRAME_QUEUE_LIMIT;
    this.socketBudgetBytes = options.socketBudgetBytes ?? DEVICE_FRAME_SOCKET_BUDGET_BYTES;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.subscribersByDevice.get(deviceId)?.size ?? 0;
  }

  /**
   * Register a sink for one device's stream. Returns an unsubscribe function.
   * The subscriber is immediately primed with codec config and the last
   * keyframe when the stream has already produced them.
   */
  subscribe(deviceId: string, sink: DeviceFrameSink): () => void {
    const subscriber: Subscriber = {
      id: `device-frame-subscriber:${this.nextSubscriberId++}`,
      deviceId,
      sink,
      budgetBytes: sink.budgetBytes ?? this.socketBudgetBytes,
      queue: [],
      queuedBytes: 0,
      removeDrainListener: null,
      // Priming below clears this when a keyframe is available; otherwise the
      // subscriber correctly waits for the encoder's next one.
      awaitingKeyframe: true,
      sent: 0,
      dropped: 0,
    };
    this.subscribers.set(subscriber.id, subscriber);
    let deviceSubscribers = this.subscribersByDevice.get(deviceId);
    if (!deviceSubscribers) {
      deviceSubscribers = new Set();
      this.subscribersByDevice.set(deviceId, deviceSubscribers);
    }
    deviceSubscribers.add(subscriber);
    subscriber.removeDrainListener =
      sink.onDrain?.(() => {
        if (this.subscribers.get(subscriber.id) !== subscriber) return;
        if (!subscriber.sink.isOpen()) {
          this.removeSubscriber(subscriber);
          return;
        }
        this.flush(subscriber);
      }) ?? null;

    const config = this.codecConfig.get(deviceId);
    if (config) this.deliver(subscriber, config, true);
    const keyframe = this.latestKeyframe.get(deviceId);
    if (keyframe) {
      subscriber.awaitingKeyframe = false;
      this.deliver(subscriber, keyframe);
    }

    return () => this.removeSubscriber(subscriber);
  }

  /** Encode one frame and fan it out to every subscriber of that device. */
  publish(deviceId: string, frame: DeviceStreamFrame): void {
    const encoded = encodeDeviceFrame({
      header: {
        deviceId,
        sequence: frame.sequence,
        timestampMs: frame.timestampMs,
        keyframe: frame.keyframe,
        codecConfig: frame.codecConfig,
      },
      payload: frame.data,
    });

    // Cached for late subscribers. Codec config and keyframes are the only two
    // records a decoder needs to start, so nothing else is retained.
    if (frame.codecConfig) this.codecConfig.set(deviceId, encoded);
    else if (frame.keyframe) this.latestKeyframe.set(deviceId, encoded);

    const deviceSubscribers = this.subscribersByDevice.get(deviceId);
    if (!deviceSubscribers || deviceSubscribers.size === 0) return;

    // Snapshotted: a closed sink is removed from the set during the walk.
    for (const subscriber of Array.from(deviceSubscribers)) {
      if (!subscriber.sink.isOpen()) {
        this.removeSubscriber(subscriber);
        continue;
      }
      // Codec config is never dropped: without it nothing downstream decodes.
      if (frame.codecConfig) {
        this.deliver(subscriber, encoded, true);
        continue;
      }
      if (subscriber.awaitingKeyframe) {
        if (!frame.keyframe) {
          subscriber.dropped += 1;
          continue;
        }
        subscriber.awaitingKeyframe = false;
      }
      this.deliver(subscriber, encoded);
    }
  }

  /** Forget cached keyframes for a device whose stream ended. */
  resetDevice(deviceId: string): void {
    this.latestKeyframe.delete(deviceId);
    this.codecConfig.delete(deviceId);
    for (const subscriber of this.subscribersByDevice.get(deviceId) ?? []) {
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
    }
  }

  statsFor(deviceId: string): readonly DeviceFrameSubscriberStats[] {
    return [...(this.subscribersByDevice.get(deviceId) ?? [])].map((subscriber) => ({
      sent: subscriber.sent,
      dropped: subscriber.dropped,
      awaitingKeyframe: subscriber.awaitingKeyframe,
      queued: subscriber.queue.length,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Write when the socket has room and nothing older is waiting, otherwise
   * queue; a full queue discards the whole backlog and waits for the next
   * keyframe rather than shipping frames whose references are already gone.
   */
  private deliver(subscriber: Subscriber, encoded: Uint8Array, codecConfig = false): void {
    if (!subscriber.sink.isOpen()) {
      this.removeSubscriber(subscriber);
      return;
    }

    this.flush(subscriber);
    if (
      subscriber.queue.length === 0 &&
      subscriber.sink.bufferedAmount() <= subscriber.budgetBytes
    ) {
      subscriber.sink.send(encoded);
      subscriber.sent += 1;
      return;
    }

    if (subscriber.queue.length >= this.queueLimit) {
      subscriber.dropped += subscriber.queue.length + (codecConfig ? 0 : 1);
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
      // Codec config survives the purge: the keyframe the subscriber now
      // waits for decodes only with it.
      if (!codecConfig) return;
    }
    subscriber.queue.push(encoded);
    subscriber.queuedBytes += encoded.byteLength;
  }

  /**
   * Send queued frames in order while the backlog stays within budget. Each
   * send may grow the backlog (a sink that counts in-flight bytes), so the
   * budget is read again before every frame; the rest waits for a drain.
   */
  private flush(subscriber: Subscriber): void {
    // Shifted one at a time, so a sink that drains re-entrantly from `send`
    // or closes (its removal clears the queue) leaves nothing inconsistent.
    while (
      subscriber.queue.length > 0 &&
      subscriber.sink.bufferedAmount() <= subscriber.budgetBytes
    ) {
      const queued = subscriber.queue.shift()!;
      subscriber.queuedBytes -= queued.byteLength;
      subscriber.sink.send(queued);
      subscriber.sent += 1;
    }
  }

  private removeSubscriber(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber.id);
    const deviceSubscribers = this.subscribersByDevice.get(subscriber.deviceId);
    deviceSubscribers?.delete(subscriber);
    if (deviceSubscribers && deviceSubscribers.size === 0) {
      this.subscribersByDevice.delete(subscriber.deviceId);
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
    subscriber.removeDrainListener?.();
    subscriber.removeDrainListener = null;
  }
}
