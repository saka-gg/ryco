// Adapted from Synara v0.7.2 (MIT); the decode-queue guard and stall watchdog
// follow t3code's device stream (MIT). See THIRD_PARTY_NOTICES.md.
import type { DeviceFrameSource, DeviceFrameSourceHandlers } from "@ryco/client-runtime/connection";
import type { DeviceUdid } from "@ryco/contracts";
import type { DeviceFrame } from "@ryco/shared/deviceFrame";
import {
  DEVICE_INPUT_ERROR_MESSAGE,
  decodeDeviceLiveInputServerMessage,
  type DeviceLiveInput,
  type DeviceLiveInputKind,
} from "@ryco/shared/deviceLiveInput";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { createDeviceFrameGateState, stepDeviceFrameGate } from "./deviceFrameGate";

export type { DeviceVideoStatus } from "@ryco/client-runtime/state/device/previewSampler";
import type { DeviceVideoStatus } from "@ryco/client-runtime/state/device/previewSampler";

function avcCodecString(payload: Uint8Array): string | null {
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

/** Whether this browser can decode the native H.264 stream. */
export function deviceVideoDecodingSupported(): boolean {
  return (
    typeof globalThis.VideoDecoder === "function" &&
    typeof globalThis.EncodedVideoChunk === "function"
  );
}

/**
 * The live input channel on the frame socket. `ready` is false until the
 * server clears this session for input, so callers fall back to the RPC path.
 */
export interface DeviceLiveInputChannel {
  readonly ready: boolean;
  readonly send: (input: DeviceLiveInput) => boolean;
}

export function useDeviceVideoStream(input: {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly udid: DeviceUdid | null;
  readonly openFrameSource?: (
    udid: DeviceUdid,
    handlers: DeviceFrameSourceHandlers,
  ) => DeviceFrameSource;
  /** Live input the server could not deliver. */
  readonly onInputError?: (error: {
    readonly input: DeviceLiveInputKind;
    readonly message: string;
  }) => void;
}): {
  readonly status: DeviceVideoStatus;
  readonly error: string | null;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly input: DeviceLiveInputChannel;
} {
  const { canvasRef, udid, openFrameSource } = input;
  const [status, setStatus] = useState<DeviceVideoStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  // Readiness of the current device's socket; another device's never counts.
  const [inputReady, setInputReady] = useState<{
    readonly udid: DeviceUdid;
    readonly ready: boolean;
  } | null>(null);
  const generationRef = useRef(0);
  const sendRef = useRef<(message: DeviceLiveInput) => boolean>(() => false);
  const onInputErrorRef = useRef(input.onInputError);
  useEffect(() => {
    onInputErrorRef.current = input.onInputError;
  }, [input.onInputError]);

  useEffect(() => {
    if (!udid || !openFrameSource) {
      setStatus("idle");
      setError(null);
      return;
    }
    if (!deviceVideoDecodingSupported()) {
      setStatus("unsupported");
      return;
    }

    const generation = ++generationRef.current;
    let gate = createDeviceFrameGateState();
    let decoder: VideoDecoder | null = null;
    let source: DeviceFrameSource | null = null;
    let parameterSets: Uint8Array | null = null;
    let painted = false;
    let firstFrameTimeoutMs = DEVICE_FIRST_FRAME_TIMEOUT_MS;
    /** Whether the current socket was cleared for input; read by `send`. */
    let inputSocketReady = false;
    sendRef.current = (message) =>
      current() && inputSocketReady && (source?.sendText(JSON.stringify(message)) ?? false);
    /** When the decoder last painted, or was last handed work while idle. */
    let progressAt = performance.now();
    const current = () => generation === generationRef.current;
    setStatus("connecting");
    setError(null);

    // Ask for a fresh configuration and keyframe when work goes unanswered:
    // no first picture on an open stream, or a decoder holding frames without
    // painting any. Resync requests are rate-limited by the source.
    const watchdog = setInterval(() => {
      if (!current() || !source) return;
      const now = performance.now();
      if (!painted && now - progressAt >= firstFrameTimeoutMs) {
        // Each resync restarts the capture, so a stream that never paints
        // (a decoder that cannot handle it) is asked less and less often.
        progressAt = now;
        firstFrameTimeoutMs = Math.min(firstFrameTimeoutMs * 2, DEVICE_FIRST_FRAME_TIMEOUT_MAX_MS);
        source.requestResync();
        return;
      }
      if (decoder && decoder.decodeQueueSize > 0 && now - progressAt >= DEVICE_DECODE_STALL_MS) {
        progressAt = now;
        restart();
      }
    }, 500);

    const closeDecoder = () => {
      parameterSets = null;
      try {
        if (decoder?.state !== "closed") decoder?.close();
      } catch {
        // An errored decoder can already be closed.
      }
      decoder = null;
    };
    const fail = (message: string) => {
      if (!current()) return;
      closeDecoder();
      gate = createDeviceFrameGateState();
      setError(message);
      setStatus("error");
    };
    /**
     * Drop the decoder and its backlog and wait for a fresh configuration and
     * keyframe. The canvas keeps the last picture meanwhile, so a viewer sees
     * a brief hold rather than a spinner.
     */
    const restart = () => {
      closeDecoder();
      gate = createDeviceFrameGateState();
      // Until a fresh keyframe paints, the first-frame watchdog owns the
      // retry: a resync inside the source's cooldown is dropped, and without
      // a decoder nothing else would ask again.
      painted = false;
      progressAt = performance.now();
      source?.requestResync();
    };
    const configure = (frame: DeviceFrame) => {
      const codec = avcCodecString(frame.payload);
      if (!codec) {
        fail("The simulator sent video parameters Ryco could not read.");
        source?.requestResync();
        return;
      }
      closeDecoder();
      const next = new VideoDecoder({
        output: (videoFrame) => {
          try {
            if (!current()) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            if (
              canvas.width !== videoFrame.displayWidth ||
              canvas.height !== videoFrame.displayHeight
            ) {
              canvas.width = videoFrame.displayWidth;
              canvas.height = videoFrame.displayHeight;
              setDimensions({ width: videoFrame.displayWidth, height: videoFrame.displayHeight });
            }
            canvas.getContext("2d")?.drawImage(videoFrame, 0, 0);
            painted = true;
            firstFrameTimeoutMs = DEVICE_FIRST_FRAME_TIMEOUT_MS;
            progressAt = performance.now();
            setStatus("streaming");
            setError(null);
          } finally {
            videoFrame.close();
          }
        },
        error: (decoderError) => {
          fail(decoderError.message || "The simulator video decoder failed.");
          source?.requestResync();
        },
      });
      try {
        next.configure({ codec, optimizeForLatency: true });
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
      if (decoder.decodeQueueSize === 0) progressAt = performance.now();
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
          new EncodedVideoChunk({
            type: keyframe ? "key" : "delta",
            timestamp: Math.round(frame.header.timestampMs * 1_000),
            data,
          }),
        );
      } catch (decodeError) {
        fail(
          decodeError instanceof Error
            ? decodeError.message
            : "A simulator frame could not be decoded.",
        );
        source?.requestResync();
      }
    };
    const onFrame = (frame: DeviceFrame) => {
      if (!current()) return;
      const step = stepDeviceFrameGate(gate, frame.header, udid);
      gate = step.state;
      if (step.requestKeyframe) source?.requestResync();
      if (step.action.kind === "configure") configure(frame);
      if (step.action.kind === "decode") decode(frame, step.action.keyframe);
    };
    source = openFrameSource(udid, {
      onFrame,
      onReset: (reason) => {
        if (!current()) return;
        closeDecoder();
        gate = createDeviceFrameGateState();
        if (reason === "decode-failed") setError("The simulator sent a malformed frame.");
        if (reason !== "decode-failed") {
          inputSocketReady = false;
          setInputReady({ udid, ready: false });
        }
        painted = false;
        progressAt = performance.now();
        setStatus("recovering");
      },
      // The server says whether this socket may drive the device after each
      // (re)connect; a socket that ends takes the permission with it, and an
      // older server never grants it, so its pane keeps the input RPCs.
      onText: (text) => {
        if (!current()) return;
        const message = decodeDeviceLiveInputServerMessage(text);
        if (!message) return;
        if (message.type === DEVICE_INPUT_ERROR_MESSAGE) {
          onInputErrorRef.current?.({ input: message.input, message: message.message });
        } else {
          inputSocketReady = message.input;
          setInputReady({ udid, ready: message.input });
        }
      },
    });

    return () => {
      generationRef.current += 1;
      clearInterval(watchdog);
      sendRef.current = () => false;
      source?.close();
      closeDecoder();
    };
  }, [canvasRef, openFrameSource, udid]);

  const ready = inputReady !== null && inputReady.udid === udid && inputReady.ready;
  const liveInput = useMemo<DeviceLiveInputChannel>(
    () => ({
      ready,
      send: (message) => sendRef.current(message),
    }),
    [ready],
  );

  return { status, error, dimensions, input: liveInput };
}
