/**
 * Live pane input on the device frame socket.
 *
 * A finger on the pane streams as touch down, moves and up while it moves,
 * and keys (by physical position, as a hardware keyboard sends them) and
 * pastes follow in the order they were made. The messages
 * ride the frame socket (`DEVICE_FRAME_WS_PATH`) as JSON text: the socket is
 * already authenticated, already per device, and needs no RPC round trip per
 * event. Video goes the other way as binary messages, so text messages in
 * either direction are unambiguous.
 *
 * The server says whether this socket may drive the device with a
 * `device.input.ready` message right after it opens; owner sessions may, as
 * with the input RPC. A client that never hears it (an older server) keeps
 * using the RPC path. Delivery failures come back as `device.input.error`.
 *
 * Coordinates are device points, like the tap RPC, in portrait device space
 * whatever the device's orientation.
 */

export const DEVICE_LIVE_TOUCH_MESSAGE = "device.touch";
export const DEVICE_LIVE_KEY_MESSAGE = "device.key";
export const DEVICE_LIVE_PASTE_MESSAGE = "device.paste";
export const DEVICE_INPUT_READY_MESSAGE = "device.input.ready";
export const DEVICE_INPUT_ERROR_MESSAGE = "device.input.error";

/** Larger than any message the pane sends; a bigger one is not input. */
export const DEVICE_LIVE_INPUT_MAX_MESSAGE_BYTES = 4_096;
/** Characters per paste message, so a chunk stays far below the byte cap. */
export const DEVICE_LIVE_PASTE_CHUNK_LENGTH = 256;
/** The most a single paste may carry, matching the paste RPC's bound. */
export const DEVICE_LIVE_PASTE_MAX_LENGTH = 16_384;

export type DeviceLiveTouchPhase = "down" | "move" | "up";
export type DeviceLiveKeyPhase = "down" | "up";

export type DeviceLiveInput =
  | {
      readonly type: typeof DEVICE_LIVE_TOUCH_MESSAGE;
      readonly phase: DeviceLiveTouchPhase;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: typeof DEVICE_LIVE_KEY_MESSAGE;
      /** A USB HID keyboard usage (page 7); modifiers are keys of their own. */
      readonly usage: number;
      readonly phase: DeviceLiveKeyPhase;
    }
  | {
      readonly type: typeof DEVICE_LIVE_PASTE_MESSAGE;
      /** One chunk of the pasted text. */
      readonly text: string;
      /** Chunks of one paste share a group; a new group discards an unfinished one. */
      readonly group: number;
      /** The last chunk: the server pastes the whole group when it arrives. */
      readonly final: boolean;
    };

export type DeviceLiveInputKind = "touch" | "key" | "paste";

export type DeviceLiveInputServerMessage =
  | {
      readonly type: typeof DEVICE_INPUT_READY_MESSAGE;
      /** False when this session may only watch. */
      readonly input: boolean;
    }
  | {
      readonly type: typeof DEVICE_INPUT_ERROR_MESSAGE;
      readonly input: DeviceLiveInputKind;
      readonly message: string;
    };

const MAX_COORDINATE = 100_000;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;

const textDecoder = new TextDecoder();

function messageText(message: string | Uint8Array): string | null {
  if (typeof message === "string") {
    return message.length > DEVICE_LIVE_INPUT_MAX_MESSAGE_BYTES ? null : message;
  }
  if (message.byteLength > DEVICE_LIVE_INPUT_MAX_MESSAGE_BYTES) return null;
  return textDecoder.decode(message);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function coordinate(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_COORDINATE
    ? value
    : null;
}

/** Reads one client message, or null for anything that is not live input. */
export function decodeDeviceLiveInput(message: string | Uint8Array): DeviceLiveInput | null {
  const text = messageText(message);
  if (text === null) return null;
  const parsed = parseObject(text);
  if (!parsed) return null;
  switch (parsed.type) {
    case DEVICE_LIVE_TOUCH_MESSAGE: {
      const { phase } = parsed;
      const x = coordinate(parsed.x);
      const y = coordinate(parsed.y);
      if ((phase !== "down" && phase !== "move" && phase !== "up") || x === null || y === null) {
        return null;
      }
      return { type: DEVICE_LIVE_TOUCH_MESSAGE, phase, x, y };
    }
    case DEVICE_LIVE_KEY_MESSAGE: {
      const { phase, usage } = parsed;
      if (phase !== "down" && phase !== "up") return null;
      if (typeof usage !== "number" || !Number.isInteger(usage) || usage <= 0 || usage > 0xffff) {
        return null;
      }
      return { type: DEVICE_LIVE_KEY_MESSAGE, usage, phase };
    }
    case DEVICE_LIVE_PASTE_MESSAGE: {
      const { text: value, group, final } = parsed;
      if (typeof value !== "string" || value.length > DEVICE_LIVE_PASTE_CHUNK_LENGTH) return null;
      if (typeof group !== "number" || !Number.isSafeInteger(group)) return null;
      if (typeof final !== "boolean") return null;
      return { type: DEVICE_LIVE_PASTE_MESSAGE, text: value, group, final };
    }
    default:
      return null;
  }
}

/** Reads one server text message, or null when it is not about input. */
export function decodeDeviceLiveInputServerMessage(
  message: string,
): DeviceLiveInputServerMessage | null {
  const text = messageText(message);
  if (text === null) return null;
  const parsed = parseObject(text);
  if (!parsed) return null;
  if (parsed.type === DEVICE_INPUT_READY_MESSAGE && typeof parsed.input === "boolean") {
    return { type: DEVICE_INPUT_READY_MESSAGE, input: parsed.input };
  }
  if (
    parsed.type === DEVICE_INPUT_ERROR_MESSAGE &&
    (parsed.input === "touch" || parsed.input === "key" || parsed.input === "paste") &&
    typeof parsed.message === "string"
  ) {
    return {
      type: DEVICE_INPUT_ERROR_MESSAGE,
      input: parsed.input,
      message: parsed.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    };
  }
  return null;
}

/** Splits text into chunks of at most `length` UTF-16 units without splitting a surrogate pair. */
export function chunkDeviceLiveText(
  text: string,
  length: number = DEVICE_LIVE_PASTE_CHUNK_LENGTH,
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && end - 1 > start) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
