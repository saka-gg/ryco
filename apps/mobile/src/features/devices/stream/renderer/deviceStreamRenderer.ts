/// <reference lib="dom" />
/**
 * The device viewer's WebView document: decodes the H.264 frames React Native
 * hands it with WebCodecs (the decoder web's simulator pane uses,
 * `@ryco/client-runtime/deviceVideo`), paints them, and reports touches in the
 * frame's own coordinates. See `../deviceStreamProtocol.ts`. Bundled into
 * `device-stream.html` by `scripts/build-device-stream-renderer.mts`.
 */
import {
  createDeviceVideoDecoder,
  deviceWebCodecs,
  type DeviceVideoDecoder,
} from "@ryco/client-runtime/deviceVideo";
import type { DeviceUdid } from "@ryco/contracts";

import {
  decodeBase64,
  type DeviceStreamBenchmarkResult,
  type DeviceStreamHostMessage,
  type DeviceStreamPageMessage,
  type DeviceStreamTouchPhase,
} from "../deviceStreamProtocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

const post = (message: DeviceStreamPageMessage) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const context = canvas.getContext("2d", { alpha: false, desynchronized: true });

let decoder: DeviceVideoDecoder | null = null;
let udid = "";
let rotation = 0;
let inputEnabled = false;
let frameWidth = 0;
let frameHeight = 0;
let pointerId: number | null = null;

// Measurement: painted frames, React Native receipt → paint, touch move → next paint.
const receivedAt = new Map<number, number>();
let paintTimes: number[] = [];
let bridgeLatencies: number[] = [];
let moveLatencies: number[] = [];
let pendingMoveAt: number | null = null;
let paintedTotal = 0;
let benchmark: {
  moves: number;
  painted: number;
  moveLatencies: number[];
  bridgeLatencies: number[];
  startedAt: number;
} | null = null;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};
const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

/** Contain the (possibly turned) picture in the viewport, centred. */
function layout() {
  if (frameWidth === 0 || frameHeight === 0) return;
  const sideways = Math.abs(rotation) % 180 === 90;
  const shownWidth = sideways ? frameHeight : frameWidth;
  const shownHeight = sideways ? frameWidth : frameHeight;
  const scale = Math.min(window.innerWidth / shownWidth, window.innerHeight / shownHeight);
  canvas.style.width = `${frameWidth * scale}px`;
  canvas.style.height = `${frameHeight * scale}px`;
  canvas.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
}

/** A client point in the frame's own 0..1 coordinates, undoing the rotation. */
function framePoint(clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  if (width <= 0 || height <= 0) return null;
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const turns = (((Math.round(rotation / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  const [ux, uy] =
    turns === 0 ? [dx, dy] : turns === 1 ? [dy, -dx] : turns === 2 ? [-dx, -dy] : [-dy, dx];
  return { x: ux / width + 0.5, y: uy / height + 0.5 };
}

function sendTouch(phase: DeviceStreamTouchPhase, x: number, y: number) {
  if (phase === "move") {
    pendingMoveAt ??= performance.now();
    if (benchmark) benchmark.moves += 1;
  }
  post({ type: "touch", phase, x, y });
}

function stop() {
  decoder?.close();
  decoder = null;
  receivedAt.clear();
}

function start(message: Extract<DeviceStreamHostMessage, { type: "start" }>) {
  stop();
  document.body.style.background = message.background;
  udid = message.udid;
  rotation = message.rotation;
  inputEnabled = message.input;
  const codecs = deviceWebCodecs(window);
  post({ type: "ready", webCodecs: codecs !== null });
  if (codecs === null) {
    post({ type: "status", status: "unsupported", error: null });
    return;
  }
  decoder = createDeviceVideoDecoder({
    udid: message.udid as DeviceUdid,
    codecs,
    paint: (frame) => {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      context?.drawImage(frame as unknown as CanvasImageSource, 0, 0);
    },
    onPainted: (header) => {
      const at = performance.now();
      paintedTotal += 1;
      paintTimes.push(at);
      if (benchmark) benchmark.painted += 1;
      if (pendingMoveAt !== null) {
        moveLatencies.push(at - pendingMoveAt);
        benchmark?.moveLatencies.push(at - pendingMoveAt);
        pendingMoveAt = null;
      }
      const received = header ? receivedAt.get(header.sequence) : undefined;
      if (header && received !== undefined) {
        receivedAt.delete(header.sequence);
        const latency = Date.now() - received;
        bridgeLatencies.push(latency);
        benchmark?.bridgeLatencies.push(latency);
      }
    },
    requestResync: () => post({ type: "resync" }),
    onStatus: (status, error) => {
      if (status === "idle" || status === "unsupported") return;
      post({ type: "status", status, error });
    },
    onDimensions: (width, height) => {
      frameWidth = width;
      frameHeight = height;
      layout();
      post({ type: "dimensions", width, height });
    },
    now: () => performance.now(),
  });
}

function frame(message: Extract<DeviceStreamHostMessage, { type: "frame" }>) {
  if (!decoder) return;
  const payload = decodeBase64(message.data);
  if (payload === null) return;
  receivedAt.set(message.sequence, message.receivedAt);
  if (receivedAt.size > 64) receivedAt.delete(receivedAt.keys().next().value as number);
  decoder.push({
    header: {
      deviceId: udid,
      sequence: message.sequence,
      timestampMs: message.timestampMs,
      keyframe: message.keyframe,
      codecConfig: message.codecConfig,
    },
    payload,
  });
}

/**
 * A synthetic vertical drag through the real input path (the WebView → React
 * Native → the frame source → the node), for measuring fps and touch-to-paint
 * latency on a device without a finger. Development builds only send it.
 */
function runBenchmark(durationMs: number) {
  if (!inputEnabled || frameWidth === 0) return;
  benchmark = { moves: 0, painted: 0, moveLatencies: [], bridgeLatencies: [], startedAt: 0 };
  const startedAt = performance.now();
  benchmark.startedAt = startedAt;
  const fromY = 0.75;
  const toY = 0.3;
  sendTouch("down", 0.5, fromY);
  const step = () => {
    const progress = Math.min(1, (performance.now() - startedAt) / durationMs);
    const y = fromY + (toY - fromY) * progress;
    if (progress >= 1) {
      sendTouch("up", 0.5, toY);
      const result = benchmark!;
      benchmark = null;
      const elapsed = (performance.now() - startedAt) / 1_000;
      const summary: DeviceStreamBenchmarkResult = {
        moves: result.moves,
        paintedDuringDrag: result.painted,
        fps: Math.round((result.painted / elapsed) * 10) / 10,
        moveToPaintMs:
          result.moveLatencies.length === 0
            ? null
            : {
                median: Math.round(median(result.moveLatencies)!),
                p95: Math.round(percentile(result.moveLatencies, 0.95)),
              },
        bridgeToPaintMs:
          result.bridgeLatencies.length === 0
            ? null
            : {
                median: Math.round(median(result.bridgeLatencies)!),
                p95: Math.round(percentile(result.bridgeLatencies, 0.95)),
              },
      };
      post({ type: "benchmark", result: summary });
      return;
    }
    sendTouch("move", 0.5, y);
    setTimeout(step, 16);
  };
  setTimeout(step, 16);
}

function receive(event: MessageEvent) {
  if (typeof event.data !== "string") return;
  let message: DeviceStreamHostMessage;
  try {
    message = JSON.parse(event.data) as DeviceStreamHostMessage;
  } catch {
    return;
  }
  switch (message.type) {
    case "start":
      return start(message);
    case "frame":
      return frame(message);
    case "reset":
      decoder?.reset(message.reason);
      return;
    case "rotation":
      rotation = message.rotation;
      layout();
      return;
    case "input":
      inputEnabled = message.enabled;
      return;
    case "benchmark":
      return runBenchmark(message.durationMs);
    case "stop":
      return stop();
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (!inputEnabled || pointerId !== null) return;
  const point = framePoint(event.clientX, event.clientY);
  if (!point || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return;
  event.preventDefault();
  pointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  sendTouch("down", point.x, point.y);
});
canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== pointerId) return;
  const point = framePoint(event.clientX, event.clientY);
  if (point) sendTouch("move", point.x, point.y);
});
const endTouch = (event: PointerEvent) => {
  if (event.pointerId !== pointerId) return;
  pointerId = null;
  const point = framePoint(event.clientX, event.clientY);
  sendTouch("up", point?.x ?? 0.5, point?.y ?? 0.5);
};
canvas.addEventListener("pointerup", endTouch);
canvas.addEventListener("pointercancel", endTouch);
canvas.addEventListener("lostpointercapture", endTouch);
window.addEventListener("resize", layout);
window.addEventListener("message", receive);
// Android's WebView dispatches React Native's messages on the document.
document.addEventListener("message", receive as EventListener);

setInterval(() => {
  const now = performance.now();
  paintTimes = paintTimes.filter((at) => now - at <= 1_000);
  post({
    type: "stats",
    stats: {
      fps: paintTimes.length,
      bridgeToPaintMs: median(bridgeLatencies),
      moveToPaintMs: median(moveLatencies),
      painted: paintedTotal,
    },
  });
  bridgeLatencies = [];
  moveLatencies = [];
}, 1_000);
