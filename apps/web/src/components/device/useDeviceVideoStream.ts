// The decoder is shared with the phone's device viewer
// (`@ryco/client-runtime/deviceVideo`); this hook owns the canvas and the socket.
import type { DeviceFrameSource, DeviceFrameSourceHandlers } from "@ryco/client-runtime/connection";
import {
  createDeviceVideoDecoder,
  deviceWebCodecs,
  type DeviceVideoDecoder,
} from "@ryco/client-runtime/deviceVideo";
import type { DeviceUdid } from "@ryco/contracts";
import {
  DEVICE_INPUT_ERROR_MESSAGE,
  decodeDeviceLiveInputServerMessage,
  type DeviceLiveInput,
  type DeviceLiveInputKind,
} from "@ryco/shared/deviceLiveInput";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

export {
  DEVICE_DECODE_QUEUE_LIMIT,
  DEVICE_DECODE_STALL_MS,
  DEVICE_FIRST_FRAME_TIMEOUT_MS,
} from "@ryco/client-runtime/deviceVideo";
export type { DeviceVideoStatus } from "@ryco/client-runtime/state/device/previewSampler";
import type { DeviceVideoStatus } from "@ryco/client-runtime/state/device/previewSampler";

/** Whether this browser can decode the native H.264 stream. */
export function deviceVideoDecodingSupported(): boolean {
  return deviceWebCodecs() !== null;
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
    const codecs = deviceWebCodecs();
    if (codecs === null) {
      setStatus("unsupported");
      return;
    }

    const generation = ++generationRef.current;
    let source: DeviceFrameSource | null = null;
    /** Whether the current socket was cleared for input; read by `send`. */
    let inputSocketReady = false;
    const current = () => generation === generationRef.current;
    sendRef.current = (message) =>
      current() && inputSocketReady && (source?.sendText(JSON.stringify(message)) ?? false);
    const decoder: DeviceVideoDecoder = createDeviceVideoDecoder({
      udid,
      codecs,
      paint: (videoFrame) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (
          canvas.width !== videoFrame.displayWidth ||
          canvas.height !== videoFrame.displayHeight
        ) {
          canvas.width = videoFrame.displayWidth;
          canvas.height = videoFrame.displayHeight;
        }
        canvas.getContext("2d")?.drawImage(videoFrame as VideoFrame, 0, 0);
      },
      requestResync: () => void source?.requestResync(),
      onStatus: (next, message) => {
        if (!current()) return;
        setStatus(next);
        if (next === "streaming" || message !== null) setError(message);
      },
      onDimensions: (width, height) => {
        if (current()) setDimensions({ width, height });
      },
      now: () => performance.now(),
    });

    source = openFrameSource(udid, {
      onFrame: (frame) => {
        if (current()) decoder.push(frame);
      },
      onReset: (reason) => {
        if (!current()) return;
        decoder.reset(reason);
        if (reason !== "decode-failed") {
          inputSocketReady = false;
          setInputReady({ udid, ready: false });
        }
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
      sendRef.current = () => false;
      source?.close();
      decoder.close();
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
