import type { DeviceFrameSource } from "@ryco/client-runtime/connection";
import type { DeviceRpcClient } from "@ryco/client-runtime/rpc";
import { devicePointSize, type DevicePoint } from "@ryco/client-runtime/state/device/devicePoint";
import type { DeviceDescriptor, DeviceOrientation, DeviceUdid } from "@ryco/contracts";
import {
  DEVICE_INPUT_ERROR_MESSAGE,
  DEVICE_LIVE_TOUCH_MESSAGE,
  decodeDeviceLiveInputServerMessage,
  type DeviceLiveInput,
} from "@ryco/shared/deviceLiveInput";
import { useCallback, useEffect, useRef, useState } from "react";

import { devicePressInput } from "../deviceViewerModel";
import {
  decodeDeviceStreamPageMessage,
  encodeBase64,
  type DeviceStreamBenchmarkResult,
  type DeviceStreamHostMessage,
  type DeviceStreamStats,
} from "./deviceStreamProtocol";

/**
 * Clockwise CSS degrees the picture turns for each orientation, as web's pane
 * turns its chassis (`deviceTouchGeometry.ts`). Only iOS needs it: a rotated
 * simulator's framebuffer stays portrait while Android's frames turn.
 */
const IOS_ORIENTATION_ROTATION: Readonly<Record<DeviceOrientation, number>> = {
  portrait: 0,
  "landscape-left": -90,
  "portrait-upside-down": 180,
  "landscape-right": 90,
};

export type DeviceLiveStreamStatus =
  | "connecting"
  | "streaming"
  | "recovering"
  | "error"
  | "unsupported"
  | "paused";

const BENCHMARK = process.env.EXPO_PUBLIC_RYCO_DEVICE_BENCH === "1";

/**
 * Live H.264 video and live touch for one device in the phone's viewer.
 *
 * The connection stays here, in the shared runtime: `client.openFrameSource`
 * is the direct frame socket or, on a hosted connection, the relay channel's
 * frame tunnel, each fenced by its own lifecycle owner. The WebView
 * (`DeviceStreamWebView`) only decodes and paints. The stream runs only while
 * `active` (the screen focused, the app in front): pausing closes the source,
 * so a backgrounded app neither receives video nor holds a decoder busy.
 *
 * `unsupported` means this WebView cannot decode H.264 (no WebCodecs): the
 * caller falls back to the screenshot sampler.
 */
export function useDeviceLiveStream(input: {
  readonly client: Pick<DeviceRpcClient, "openFrameSource" | "tap" | "swipe"> | null | undefined;
  readonly udid: DeviceUdid | null;
  readonly device: DeviceDescriptor | null;
  readonly active: boolean;
  readonly canDrive: boolean;
  readonly onInputError: (message: string) => void;
}) {
  const { client, udid, device, active, canDrive } = input;
  const [status, setStatus] = useState<DeviceLiveStreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const [stats, setStats] = useState<DeviceStreamStats | null>(null);
  const [webCodecs, setWebCodecs] = useState<boolean | null>(null);
  const [sender, setSender] = useState<((message: DeviceStreamHostMessage) => boolean) | null>(
    null,
  );
  const sourceRef = useRef<DeviceFrameSource | null>(null);
  const inputReadyRef = useRef(false);
  const dimensionsRef = useRef<{ width: number; height: number } | null>(null);
  const pressRef = useRef<{ point: DevicePoint; at: number } | null>(null);
  const benchmarkedRef = useRef(false);
  const latest = useRef({ client, udid, device, canDrive, onInputError: input.onInputError });
  useEffect(() => {
    latest.current = { client, udid, device, canDrive, onInputError: input.onInputError };
  }, [client, udid, device, canDrive, input.onInputError]);

  const rotation =
    device?.platform === "ios-simulator"
      ? IOS_ORIENTATION_ROTATION[device.orientation ?? "portrait"]
      : 0;

  // The page starts (and reports whether it decodes) once its document loaded.
  useEffect(() => {
    if (!sender || udid === null) return;
    setWebCodecs(null);
    sender({ type: "start", udid, rotation, background: "#000000", input: canDrive });
    // Rotation and input are sent on their own below; a new start would drop the picture.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sender, udid]);
  useEffect(() => {
    sender?.({ type: "rotation", rotation });
  }, [sender, rotation]);
  useEffect(() => {
    sender?.({ type: "input", enabled: canDrive });
  }, [sender, canDrive]);

  // The frame source runs while the viewer is in front and the page decodes.
  useEffect(() => {
    if (!active) {
      setStatus("paused");
      return;
    }
    if (!sender || udid === null || webCodecs !== true || !client?.openFrameSource) return;
    setStatus("connecting");
    let closed = false;
    const source = client.openFrameSource(udid, {
      onFrame: (frame) => {
        if (closed) return;
        sender({
          type: "frame",
          sequence: frame.header.sequence,
          timestampMs: frame.header.timestampMs,
          keyframe: frame.header.keyframe,
          codecConfig: frame.header.codecConfig,
          data: encodeBase64(frame.payload),
          receivedAt: Date.now(),
        });
      },
      onReset: (reason) => {
        if (closed) return;
        // This connection cannot stream at all: the viewer takes screenshots.
        if (reason === "unavailable") {
          setStatus("unsupported");
          return;
        }
        sender({ type: "reset", reason });
        if (reason !== "decode-failed") {
          inputReadyRef.current = false;
          setInputReady(false);
        }
      },
      // Whether this socket may drive the device, after each (re)connect.
      onText: (text) => {
        if (closed) return;
        const message = decodeDeviceLiveInputServerMessage(text);
        if (!message) return;
        if (message.type === DEVICE_INPUT_ERROR_MESSAGE) {
          latest.current.onInputError(message.message || "The device did not take the input.");
          return;
        }
        inputReadyRef.current = message.input;
        setInputReady(message.input);
      },
    });
    sourceRef.current = source;
    return () => {
      closed = true;
      sourceRef.current = null;
      inputReadyRef.current = false;
      setInputReady(false);
      source.close();
    };
  }, [active, client, sender, udid, webCodecs]);

  const toDevicePoint = (x: number, y: number): DevicePoint | null => {
    const dimensions = dimensionsRef.current;
    if (!dimensions) return null;
    const size = devicePointSize(latest.current.device, dimensions.width, dimensions.height);
    return { x: Math.round(x * size.pointWidth), y: Math.round(y * size.pointHeight) };
  };

  const onMessage = useCallback((raw: string) => {
    const message = decodeDeviceStreamPageMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "ready":
        setWebCodecs(message.webCodecs);
        if (!message.webCodecs) setStatus("unsupported");
        return;
      case "status":
        setStatus(message.status);
        setError(message.error);
        return;
      case "resync":
        sourceRef.current?.requestResync();
        return;
      case "dimensions":
        dimensionsRef.current = { width: message.width, height: message.height };
        return;
      case "touch": {
        const { client: current, udid: target, canDrive: drive } = latest.current;
        if (!drive || target === null) return;
        const point = toDevicePoint(message.x, message.y);
        if (point === null) return;
        if (inputReadyRef.current && sourceRef.current) {
          const live: DeviceLiveInput = {
            type: DEVICE_LIVE_TOUCH_MESSAGE,
            phase: message.phase,
            x: point.x,
            y: point.y,
          };
          if (sourceRef.current.sendText(JSON.stringify(live))) return;
        }
        // No live input on this socket (an older node, a reconnect): a tap or a
        // swipe on release, as before.
        if (message.phase === "down") pressRef.current = { point, at: Date.now() };
        if (message.phase !== "up" || !current) return;
        const started = pressRef.current;
        pressRef.current = null;
        if (!started) return;
        const sent = devicePressInput({
          udid: target,
          from: started.point,
          to: point,
          durationMs: Date.now() - started.at,
        });
        if (sent === null) return;
        const request = sent.kind === "tap" ? current.tap(sent.input) : current.swipe(sent.input);
        void request.catch((cause: unknown) =>
          latest.current.onInputError(
            cause instanceof Error ? cause.message : "The device did not take the input.",
          ),
        );
        return;
      }
      case "stats":
        setStats(message.stats);
        if (BENCHMARK) console.log("[device-stream] stats", JSON.stringify(message.stats));
        return;
      case "benchmark":
        console.log(
          "[device-stream] benchmark",
          JSON.stringify(message.result as DeviceStreamBenchmarkResult),
        );
        return;
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reads `latest` and refs only
  }, []);

  // Development builds can measure a synthetic drag through the real input path.
  useEffect(() => {
    if (!BENCHMARK || benchmarkedRef.current || status !== "streaming" || !inputReady) return;
    benchmarkedRef.current = true;
    const timer = setTimeout(() => sender?.({ type: "benchmark", durationMs: 1_500 }), 2_000);
    return () => clearTimeout(timer);
  }, [inputReady, sender, status]);

  const onSender = useCallback(
    (next: ((message: DeviceStreamHostMessage) => boolean) | null) => setSender(() => next),
    [],
  );
  const onFailure = useCallback(() => setStatus("unsupported"), []);

  return {
    status,
    error,
    inputReady,
    stats,
    webView: { onSender, onMessage, onFailure },
  };
}
