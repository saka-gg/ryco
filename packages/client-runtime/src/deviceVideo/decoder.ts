// Adapted from Synara v0.7.2 (MIT); the decode-queue guard and stall watchdog
// follow t3code's device stream (MIT). See THIRD_PARTY_NOTICES.md.
import type { DeviceUdid } from "@ryco/contracts";
import type { DeviceFrame } from "@ryco/shared/deviceFrame";

import type { DeviceFrameSourceResetReason } from "../connection/deviceFrameSource.ts";
import type { DeviceVideoStatus } from "../state/device/previewSampler.ts";
import { createDeviceFrameGateState, stepDeviceFrameGate } from "./frameGate.ts";

/**
 * Frames the decoder may hold before the stream is treated as behind. A
 * healthy low-latency decoder holds at most one; a backlog this deep means the
 * picture lags the device, and catching up frame by frame only adds latency.
 */
export const DEVICE_DECODE_QUEUE_LIMIT = 8;
/**
 * How long the decoder may sit on queued frames without painting one, and how
 * long an open stream may go without a first picture, before a fresh codec
 * configuration and keyframe are requested. A still screen sends nothing, so
 * silence alone is not a stall: only unanswered work is.
 */
export const DEVICE_DECODE_STALL_MS = 2_000;
export const DEVICE_FIRST_FRAME_TIMEOUT_MS = 3_000;
/** Each unanswered first-frame request doubles the wait, up to this. */
const DEVICE_FIRST_FRAME_TIMEOUT_MAX_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 250;
/**
 * How long a decoded keyframe may go unpainted before the decoder is rebuilt
 * to prefer software decoding. Some hardware decoders (Chrome's on macOS)
 * hold frames back for reordering the stream never does, so a still screen,
 * which sends one keyframe and little else, never paints.
 */
export const DEVICE_KEYFRAME_PAINT_TIMEOUT_MS = 500;

/**
 * Whether a decoder in this page already had to fall back to software. The
 * platform decoder does not change within a page, so later decoders start
 * there instead of repeating the failed hardware attempt (about a second).
 */
let pagePrefersSoftware = false;

/** Tests only: forget the page's fallback. */
export function resetDeviceDecoderPreferenceForTests(): void {
  pagePrefersSoftware = false;
}

// WebCodecs, structurally: this package has no DOM library, and every platform
// that decodes (a browser, the phone's WebView) hands its own constructors in.

export interface DeviceVideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

interface DeviceVideoDecoderLike {
  readonly state: string;
  readonly decodeQueueSize: number;
  configure(config: {
    readonly codec: string;
    readonly optimizeForLatency?: boolean;
    readonly hardwareAcceleration?: "no-preference" | "prefer-software";
  }): void;
  decode(chunk: unknown): void;
  close(): void;
}

export interface DeviceWebCodecs {
  readonly VideoDecoder: new (init: {
    readonly output: (frame: DeviceVideoFrameLike) => void;
    readonly error: (error: { readonly message?: string }) => void;
  }) => DeviceVideoDecoderLike;
  readonly EncodedVideoChunk: new (init: {
    readonly type: "key" | "delta";
    readonly timestamp: number;
    readonly data: Uint8Array;
  }) => unknown;
}

/** The platform's WebCodecs, or `null` where H.264 cannot be decoded. */
export function deviceWebCodecs(scope: unknown = globalThis): DeviceWebCodecs | null {
  const candidate = scope as Partial<DeviceWebCodecs> | null;
  return typeof candidate?.VideoDecoder === "function" &&
    typeof candidate.EncodedVideoChunk === "function"
    ? (candidate as DeviceWebCodecs)
    : null;
}

/** The `avc1.PPCCLL` codec string from the SPS in an Annex B parameter-set payload. */
export function avcCodecString(payload: Uint8Array): string | null {
  for (let offset = 0; offset + 7 < payload.byteLength; offset += 1) {
    const long =
      payload[offset] === 0 &&
      payload[offset + 1] === 0 &&
      payload[offset + 2] === 0 &&
      payload[offset + 3] === 1;
    const short = payload[offset] === 0 && payload[offset + 1] === 0 && payload[offset + 2] === 1;
    if (!long && !short) continue;
    const nal = offset + (long ? 4 : 3);
    if (((payload[nal] ?? 0) & 0x1f) !== 7) continue;
    return `avc1.${[payload[nal + 1], payload[nal + 2], payload[nal + 3]]
      .map((value) => (value ?? 0).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return null;
}

export interface DeviceVideoDecoderOptions {
  readonly udid: DeviceUdid;
  readonly codecs: DeviceWebCodecs;
  /** Paint one decoded frame. The decoder closes it afterwards. */
  readonly paint: (frame: DeviceVideoFrameLike) => void;
  /** Ask the stream for fresh codec parameters and a keyframe (rate-limited by the source). */
  readonly requestResync: () => void;
  readonly onStatus: (status: DeviceVideoStatus, error: string | null) => void;
  /** The picture's pixel size changed (first frame, rotation). */
  readonly onDimensions?: (width: number, height: number) => void;
  /** One frame painted, for measurement. */
  readonly onPainted?: (frame: DeviceFrame["header"] | null) => void;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
}

export interface DeviceVideoDecoder {
  /** One frame from the frame source. */
  readonly push: (frame: DeviceFrame) => void;
  /** The frame source's socket reset; the next frames start a new stream. */
  readonly reset: (reason: DeviceFrameSourceResetReason) => void;
  readonly close: () => void;
}

/**
 * One device's WebCodecs H.264 decoder, fed by a frame source: gates frames
 * (config, keyframe, sequence), configures from the parameter sets, decodes
 * with low latency, and recovers by itself — a decode backlog or a stream that
 * never paints asks for a fresh keyframe; a decoder error waits for the next
 * configuration. The platform owns the source and the surface it paints.
 */
export function createDeviceVideoDecoder(options: DeviceVideoDecoderOptions): DeviceVideoDecoder {
  const { udid, codecs } = options;
  const now = options.now ?? (() => Date.now());
  const timers = globalThis as unknown as {
    setInterval: (callback: () => void, ms: number) => unknown;
    clearInterval: (timer: unknown) => void;
  };
  const startInterval =
    options.setInterval ?? ((callback: () => void, ms: number) => timers.setInterval(callback, ms));
  const stopInterval = options.clearInterval ?? ((timer: unknown) => timers.clearInterval(timer));

  let closed = false;
  let gate = createDeviceFrameGateState();
  let decoder: DeviceVideoDecoderLike | null = null;
  let parameterSets: Uint8Array | null = null;
  let painted = false;
  let firstFrameTimeoutMs = DEVICE_FIRST_FRAME_TIMEOUT_MS;
  /** When the decoder last painted, or was last handed work while idle. */
  let progressAt = now();
  let width = 0;
  let height = 0;
  /** Set once a keyframe went unpainted: later decoders prefer software. */
  let preferSoftware = pagePrefersSoftware;
  /** When the current decoder was handed its first keyframe, until it paints. */
  let keyframeDecodedAt: number | null = null;
  /** Headers of frames handed to the decoder, oldest first, for `onPainted`. */
  const pending: DeviceFrame["header"][] = [];
  let status: DeviceVideoStatus | null = null;
  const report = (next: DeviceVideoStatus, error: string | null) => {
    status = next;
    options.onStatus(next, error);
  };

  const closeDecoder = () => {
    parameterSets = null;
    keyframeDecodedAt = null;
    pending.length = 0;
    try {
      if (decoder !== null && decoder.state !== "closed") decoder.close();
    } catch {
      // An errored decoder can already be closed.
    }
    decoder = null;
  };
  const fail = (message: string) => {
    if (closed) return;
    closeDecoder();
    gate = createDeviceFrameGateState();
    report("error", message);
  };
  /**
   * Drop the decoder and its backlog and wait for a fresh configuration and
   * keyframe. The surface keeps the last picture meanwhile, so a viewer sees a
   * brief hold rather than a spinner.
   */
  const restart = () => {
    closeDecoder();
    gate = createDeviceFrameGateState();
    // Until a fresh keyframe paints, the first-frame watchdog owns the retry:
    // a resync inside the source's cooldown is dropped, and without a decoder
    // nothing else would ask again.
    painted = false;
    progressAt = now();
    options.requestResync();
  };

  // Ask for a fresh configuration and keyframe when work goes unanswered: no
  // first picture on an open stream, or a decoder holding frames without
  // painting any.
  const watchdog = startInterval(() => {
    if (closed) return;
    const at = now();
    if (
      !preferSoftware &&
      !painted &&
      keyframeDecodedAt !== null &&
      at - keyframeDecodedAt >= DEVICE_KEYFRAME_PAINT_TIMEOUT_MS
    ) {
      preferSoftware = true;
      pagePrefersSoftware = true;
      restart();
      return;
    }
    if (!painted && at - progressAt >= firstFrameTimeoutMs) {
      // Each resync restarts the capture, so a stream that never paints (a
      // decoder that cannot handle it) is asked less and less often.
      progressAt = at;
      firstFrameTimeoutMs = Math.min(firstFrameTimeoutMs * 2, DEVICE_FIRST_FRAME_TIMEOUT_MAX_MS);
      options.requestResync();
      return;
    }
    if (decoder && decoder.decodeQueueSize > 0 && at - progressAt >= DEVICE_DECODE_STALL_MS) {
      progressAt = at;
      restart();
    }
  }, WATCHDOG_INTERVAL_MS);

  const configure = (frame: DeviceFrame) => {
    const codec = avcCodecString(frame.payload);
    if (!codec) {
      fail("The device sent video parameters Ryco could not read.");
      options.requestResync();
      return;
    }
    closeDecoder();
    const next = new codecs.VideoDecoder({
      output: (videoFrame) => {
        try {
          if (closed || decoder !== next) return;
          if (videoFrame.displayWidth !== width || videoFrame.displayHeight !== height) {
            width = videoFrame.displayWidth;
            height = videoFrame.displayHeight;
            options.onDimensions?.(width, height);
          }
          options.paint(videoFrame);
          painted = true;
          firstFrameTimeoutMs = DEVICE_FIRST_FRAME_TIMEOUT_MS;
          progressAt = now();
          options.onPainted?.(pending.shift() ?? null);
          if (status !== "streaming") report("streaming", null);
        } finally {
          videoFrame.close();
        }
      },
      error: (decoderError) => {
        if (decoder !== next) return;
        fail(decoderError.message || "The device video decoder failed.");
        options.requestResync();
      },
    });
    try {
      next.configure({
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: preferSoftware ? "prefer-software" : "no-preference",
      });
      decoder = next;
      parameterSets = frame.payload.slice();
    } catch (configureError) {
      fail(
        configureError instanceof Error ? configureError.message : "Video decoder setup failed.",
      );
    }
  };
  const decode = (frame: DeviceFrame, keyframe: boolean) => {
    if (!decoder || decoder.state !== "configured") return;
    if (decoder.decodeQueueSize > DEVICE_DECODE_QUEUE_LIMIT) {
      restart();
      return;
    }
    if (decoder.decodeQueueSize === 0) progressAt = now();
    let data = frame.payload;
    if (keyframe && parameterSets) {
      const combined = new Uint8Array(parameterSets.byteLength + data.byteLength);
      combined.set(parameterSets);
      combined.set(data, parameterSets.byteLength);
      data = combined;
      parameterSets = null;
    }
    try {
      decoder.decode(
        new codecs.EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp: Math.round(frame.header.timestampMs * 1_000),
          data,
        }),
      );
      pending.push(frame.header);
      if (keyframe && !painted) keyframeDecodedAt ??= now();
      if (pending.length > DEVICE_DECODE_QUEUE_LIMIT * 2) pending.shift();
    } catch (decodeError) {
      fail(
        decodeError instanceof Error ? decodeError.message : "A device frame could not be decoded.",
      );
      options.requestResync();
    }
  };

  report("connecting", null);
  return {
    push: (frame) => {
      if (closed) return;
      const step = stepDeviceFrameGate(gate, frame.header, udid);
      gate = step.state;
      if (step.requestKeyframe) options.requestResync();
      if (step.action.kind === "configure") configure(frame);
      if (step.action.kind === "decode") decode(frame, step.action.keyframe);
    },
    reset: (reason) => {
      if (closed) return;
      closeDecoder();
      gate = createDeviceFrameGateState();
      painted = false;
      progressAt = now();
      if (reason === "unavailable") {
        report("unsupported", null);
        return;
      }
      report(
        "recovering",
        reason === "decode-failed" ? "The device sent a malformed frame." : null,
      );
    },
    close: () => {
      if (closed) return;
      closed = true;
      stopInterval(watchdog);
      closeDecoder();
    },
  };
}
