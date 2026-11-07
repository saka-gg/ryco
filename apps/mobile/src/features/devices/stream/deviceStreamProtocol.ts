/**
 * The bridge between the device viewer's React Native side and its WebView
 * (`renderer/deviceStreamRenderer.ts`), as JSON strings over `postMessage`.
 *
 * React Native owns the connection: the frame source (the direct frame socket
 * or the hosted relay's frame tunnel), authorization and live input. The
 * WebView owns only WebCodecs: it decodes and paints the frames it is handed
 * and reports where a finger is, in the frame's own coordinates. It holds no
 * credential and can reach no network (its document's CSP).
 *
 * Shared by both sides; no React, React Native or DOM imports.
 *
 * @module deviceStreamProtocol
 */

export type DeviceStreamTouchPhase = "down" | "move" | "up";

/** React Native to the WebView. */
export type DeviceStreamHostMessage =
  | {
      readonly type: "start";
      readonly udid: string;
      /** Clockwise CSS degrees the picture turns (an iOS frame stays portrait when rotated). */
      readonly rotation: number;
      readonly background: string;
      /** Whether touches are reported (the session may drive the device). */
      readonly input: boolean;
    }
  | {
      readonly type: "frame";
      readonly sequence: number;
      readonly timestampMs: number;
      readonly keyframe: boolean;
      readonly codecConfig: boolean;
      /** The H.264 payload, base64. */
      readonly data: string;
      /** `Date.now()` when React Native received it, for the bridge latency figure. */
      readonly receivedAt: number;
    }
  | {
      readonly type: "reset";
      readonly reason: "closed" | "error" | "decode-failed" | "unavailable";
    }
  | { readonly type: "rotation"; readonly rotation: number }
  | { readonly type: "input"; readonly enabled: boolean }
  | { readonly type: "benchmark"; readonly durationMs: number }
  | { readonly type: "stop" };

export interface DeviceStreamStats {
  /** Frames painted in the last window, per second. */
  readonly fps: number;
  /** Median ms from React Native receiving a frame to its paint, last window. */
  readonly bridgeToPaintMs: number | null;
  /** Median ms from a touch move to the next painted frame, last window. */
  readonly moveToPaintMs: number | null;
  readonly painted: number;
}

/** The WebView to React Native. */
export type DeviceStreamPageMessage =
  | { readonly type: "ready"; readonly webCodecs: boolean }
  | {
      readonly type: "status";
      readonly status: "connecting" | "streaming" | "recovering" | "error" | "unsupported";
      readonly error: string | null;
    }
  | { readonly type: "resync" }
  | { readonly type: "dimensions"; readonly width: number; readonly height: number }
  | {
      readonly type: "touch";
      readonly phase: DeviceStreamTouchPhase;
      /** 0..1 across the frame's own (unrotated) width and height. */
      readonly x: number;
      readonly y: number;
    }
  | { readonly type: "stats"; readonly stats: DeviceStreamStats }
  | { readonly type: "benchmark"; readonly result: DeviceStreamBenchmarkResult };

export interface DeviceStreamBenchmarkResult {
  readonly moves: number;
  readonly paintedDuringDrag: number;
  readonly fps: number;
  readonly moveToPaintMs: { readonly median: number; readonly p95: number } | null;
  readonly bridgeToPaintMs: { readonly median: number; readonly p95: number } | null;
}

const PHASES = new Set<unknown>(["down", "move", "up"]);
const STATUSES = new Set<unknown>([
  "connecting",
  "streaming",
  "recovering",
  "error",
  "unsupported",
]);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Parse a message from the WebView; anything malformed is `null`. */
export function decodeDeviceStreamPageMessage(raw: string): DeviceStreamPageMessage | null {
  if (raw.length > 8_192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case "ready":
      return typeof message.webCodecs === "boolean"
        ? { type: "ready", webCodecs: message.webCodecs }
        : null;
    case "status":
      return STATUSES.has(message.status) &&
        (message.error === null || typeof message.error === "string")
        ? {
            type: "status",
            status: message.status as Extract<
              DeviceStreamPageMessage,
              { type: "status" }
            >["status"],
            error: message.error === null ? null : String(message.error).slice(0, 500),
          }
        : null;
    case "resync":
      return { type: "resync" };
    case "dimensions":
      return isFiniteNumber(message.width) &&
        isFiniteNumber(message.height) &&
        message.width > 0 &&
        message.height > 0
        ? { type: "dimensions", width: message.width, height: message.height }
        : null;
    case "touch":
      return PHASES.has(message.phase) && isFiniteNumber(message.x) && isFiniteNumber(message.y)
        ? {
            type: "touch",
            phase: message.phase as DeviceStreamTouchPhase,
            x: Math.min(1, Math.max(0, message.x)),
            y: Math.min(1, Math.max(0, message.y)),
          }
        : null;
    case "stats":
    case "benchmark":
      return typeof message.stats === "object" || typeof message.result === "object"
        ? (message as unknown as DeviceStreamPageMessage)
        : null;
    default:
      return null;
  }
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 of `bytes`, without depending on the platform's `btoa`. */
export function encodeBase64(bytes: Uint8Array): string {
  const length = bytes.byteLength;
  const parts: string[] = [];
  let chunk = "";
  let index = 0;
  for (; index + 2 < length; index += 3) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    chunk +=
      BASE64[(value >> 18) & 63]! +
      BASE64[(value >> 12) & 63]! +
      BASE64[(value >> 6) & 63]! +
      BASE64[value & 63]!;
    if (chunk.length >= 16_384) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (index < length) {
    const value = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8);
    chunk += BASE64[(value >> 18) & 63]! + BASE64[(value >> 12) & 63]!;
    chunk += index + 1 < length ? BASE64[(value >> 6) & 63]! + "=" : "==";
  }
  parts.push(chunk);
  return parts.join("");
}

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64.length; index += 1) table[BASE64.charCodeAt(index)] = index;
  return table;
})();

/** Decode standard base64; `null` when malformed. */
export function decodeBase64(text: string): Uint8Array | null {
  const clean = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if (text.length % 4 !== 0) return null;
  const bytes = new Uint8Array((text.length / 4) * 3 - clean);
  let out = 0;
  for (let index = 0; index < text.length; index += 4) {
    const a = DECODE[text.charCodeAt(index)] ?? -1;
    const b = DECODE[text.charCodeAt(index + 1)] ?? -1;
    const c = text[index + 2] === "=" ? 0 : (DECODE[text.charCodeAt(index + 2)] ?? -1);
    const d = text[index + 3] === "=" ? 0 : (DECODE[text.charCodeAt(index + 3)] ?? -1);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const value = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < bytes.length) bytes[out++] = (value >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (value >> 8) & 255;
    if (out < bytes.length) bytes[out++] = value & 255;
  }
  return bytes;
}
