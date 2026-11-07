/**
 * The wire format of scrcpy-server (Apache-2.0, Genymobile), version-pinned in
 * `scrcpyServer.ts`. The protocol is internal to scrcpy and changes between
 * releases, so everything here matches exactly that version: see scrcpy's
 * `doc/develop.md` ("Protocol"), `ControlMessageReader.java` and
 * `DeviceMessageWriter.java`.
 *
 * Pure encoders and a streaming parser, so the byte layout is unit-tested
 * without a device.
 *
 * @module device/android/scrcpyProtocol
 */

/** `"h264"` as the u32 codec id the video socket opens with. */
export const SCRCPY_CODEC_H264 = 0x68323634;

/** Control message types (client to device). */
export const ScrcpyControlType = {
  injectKeycode: 0,
  injectText: 1,
  injectTouch: 2,
  injectScroll: 3,
  backOrScreenOn: 4,
  expandNotificationPanel: 5,
  collapsePanels: 7,
  setClipboard: 9,
  rotateDevice: 11,
  resetVideo: 17,
} as const;

/** Android `MotionEvent` and `KeyEvent` actions. */
export const ScrcpyTouchAction = { down: 0, up: 1, move: 2 } as const;
export const ScrcpyKeyAction = { down: 0, up: 1 } as const;

/**
 * scrcpy's own pointer ids for a mouse (-1) and a generic finger (-2). A
 * finger id makes Android treat the touch as a touchscreen, not a mouse.
 */
export const SCRCPY_POINTER_FINGER = -2n;

/** `INJECT_TEXT_MAX_LENGTH`: longer text is split before it is sent. */
export const SCRCPY_INJECT_TEXT_MAX_BYTES = 300;
/** `CLIPBOARD_TEXT_MAX_LENGTH`: 256 KiB message less its header. */
export const SCRCPY_CLIPBOARD_MAX_BYTES = (1 << 18) - 14;

export interface ScrcpyScreenSize {
  readonly width: number;
  readonly height: number;
}

function u16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}

function i32(value: number): number {
  return Math.max(-0x80000000, Math.min(0x7fffffff, Math.round(value)));
}

/**
 * A touch at (`x`, `y`) in the coordinates of `screen`. With a video stream
 * the device drops events whose screen size is not the current video size (a
 * rotation since); without one it reads the coordinates as display pixels.
 */
export function encodeTouch(
  action: (typeof ScrcpyTouchAction)[keyof typeof ScrcpyTouchAction],
  x: number,
  y: number,
  screen: ScrcpyScreenSize,
): Uint8Array {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt8(ScrcpyControlType.injectTouch, 0);
  bytes.writeUInt8(action, 1);
  bytes.writeBigInt64BE(SCRCPY_POINTER_FINGER, 2);
  bytes.writeInt32BE(i32(x), 10);
  bytes.writeInt32BE(i32(y), 14);
  bytes.writeUInt16BE(u16(screen.width), 18);
  bytes.writeUInt16BE(u16(screen.height), 20);
  // Pressure as u16 fixed point: 0xffff is 1.0; a lifted finger has none.
  bytes.writeUInt16BE(action === ScrcpyTouchAction.up ? 0 : 0xffff, 22);
  bytes.writeInt32BE(0, 24); // action button
  bytes.writeInt32BE(0, 28); // buttons
  return bytes;
}

export function encodeKeycode(
  action: (typeof ScrcpyKeyAction)[keyof typeof ScrcpyKeyAction],
  keycode: number,
  metaState = 0,
  repeat = 0,
): Uint8Array {
  const bytes = Buffer.alloc(14);
  bytes.writeUInt8(ScrcpyControlType.injectKeycode, 0);
  bytes.writeUInt8(action, 1);
  bytes.writeInt32BE(keycode, 2);
  bytes.writeInt32BE(repeat, 6);
  bytes.writeInt32BE(metaState, 10);
  return bytes;
}

/** Text typed through the device's key character map; one message per chunk. */
export function encodeText(text: string): Uint8Array {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength > SCRCPY_INJECT_TEXT_MAX_BYTES)
    throw new RangeError("scrcpy text messages carry at most 300 bytes.");
  const bytes = Buffer.alloc(5 + payload.byteLength);
  bytes.writeUInt8(ScrcpyControlType.injectText, 0);
  bytes.writeUInt32BE(payload.byteLength, 1);
  payload.copy(bytes, 5);
  return bytes;
}

/**
 * Put `text` on the device clipboard and, with `paste`, press PASTE. The
 * device acknowledges `sequence` once the clipboard is set (0 asks for none).
 */
export function encodeSetClipboard(text: string, paste: boolean, sequence: bigint): Uint8Array {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength > SCRCPY_CLIPBOARD_MAX_BYTES)
    throw new RangeError("Clipboard text is too long for scrcpy.");
  const bytes = Buffer.alloc(14 + payload.byteLength);
  bytes.writeUInt8(ScrcpyControlType.setClipboard, 0);
  bytes.writeBigInt64BE(sequence, 1);
  bytes.writeUInt8(paste ? 1 : 0, 9);
  bytes.writeUInt32BE(payload.byteLength, 10);
  payload.copy(bytes, 14);
  return bytes;
}

/** A message with no payload: rotate, reset video, panels. */
export function encodeEmpty(type: number): Uint8Array {
  return Uint8Array.of(type);
}

/**
 * Split text into pieces that each fit one message without cutting a UTF-16
 * surrogate pair or a multi-byte character in half.
 */
export function chunkUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (currentBytes + size > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Video stream ──────────────────────────────────────────────────────

export type ScrcpyVideoEvent =
  | { readonly kind: "codec"; readonly codecId: number }
  | { readonly kind: "session"; readonly width: number; readonly height: number }
  | {
      readonly kind: "packet";
      readonly config: boolean;
      readonly keyframe: boolean;
      /** Microseconds, as MediaCodec stamps it. */
      readonly ptsUs: bigint;
      readonly data: Uint8Array;
    };

/** Above this a packet is not video but a desynchronized stream. */
export const SCRCPY_MAX_PACKET_BYTES = 16 * 1024 * 1024;

export class ScrcpyProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrcpyProtocolError";
  }
}

const PTS_MASK = (1n << 61n) - 1n;

/**
 * Incremental parser for the video socket with `send_stream_meta=true` and
 * `send_frame_meta=true`: an optional dummy byte (forward tunnels), the codec
 * id, then session packets (12 bytes, high bit set: a new capture size) and
 * media packets (12-byte header and payload).
 *
 * Bytes are buffered only up to one packet; the parser never holds a backlog.
 */
export class ScrcpyVideoParser {
  private buffered: Buffer = Buffer.alloc(0);
  private stage: "dummy" | "codec" | "packets";

  constructor(options: { readonly dummyByte: boolean }) {
    this.stage = options.dummyByte ? "dummy" : "codec";
  }

  push(chunk: Uint8Array): ScrcpyVideoEvent[] {
    this.buffered =
      this.buffered.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
    const events: ScrcpyVideoEvent[] = [];
    let offset = 0;
    const available = () => this.buffered.byteLength - offset;
    while (true) {
      if (this.stage === "dummy") {
        if (available() < 1) break;
        offset += 1;
        this.stage = "codec";
        continue;
      }
      if (this.stage === "codec") {
        if (available() < 4) break;
        const codecId = this.buffered.readUInt32BE(offset);
        offset += 4;
        this.stage = "packets";
        events.push({ kind: "codec", codecId });
        continue;
      }
      if (available() < 12) break;
      const first = this.buffered.readUInt8(offset);
      if ((first & 0x80) !== 0) {
        const width = this.buffered.readUInt32BE(offset + 4);
        const height = this.buffered.readUInt32BE(offset + 8);
        offset += 12;
        if (width === 0 || height === 0 || width > 16_384 || height > 16_384)
          throw new ScrcpyProtocolError(`Invalid scrcpy video size ${width}x${height}.`);
        events.push({ kind: "session", width, height });
        continue;
      }
      const size = this.buffered.readUInt32BE(offset + 8);
      if (size > SCRCPY_MAX_PACKET_BYTES)
        throw new ScrcpyProtocolError(`scrcpy video packet of ${size} bytes is not plausible.`);
      if (available() < 12 + size) break;
      const header = this.buffered.readBigUInt64BE(offset);
      const data = new Uint8Array(this.buffered.subarray(offset + 12, offset + 12 + size));
      offset += 12 + size;
      events.push({
        kind: "packet",
        config: ((header >> 62n) & 1n) === 1n,
        keyframe: ((header >> 61n) & 1n) === 1n,
        ptsUs: header & PTS_MASK,
        data,
      });
    }
    this.buffered = offset === 0 ? this.buffered : Buffer.from(this.buffered.subarray(offset));
    return events;
  }
}

// ── Device messages (control socket, device to client) ───────────────

export type ScrcpyDeviceMessage =
  | { readonly kind: "clipboard"; readonly text: string }
  | { readonly kind: "ack-clipboard"; readonly sequence: bigint }
  | { readonly kind: "uhid-output" };

/** Reads what the device sends back on the control socket; only acks are used. */
export class ScrcpyDeviceMessageParser {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): ScrcpyDeviceMessage[] {
    this.buffered =
      this.buffered.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
    const messages: ScrcpyDeviceMessage[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= 1) {
      const type = this.buffered.readUInt8(offset);
      const rest = this.buffered.byteLength - offset - 1;
      if (type === 0) {
        if (rest < 4) break;
        const length = this.buffered.readUInt32BE(offset + 1);
        if (length > SCRCPY_CLIPBOARD_MAX_BYTES)
          throw new ScrcpyProtocolError("scrcpy clipboard message is too long.");
        if (rest < 4 + length) break;
        messages.push({
          kind: "clipboard",
          text: this.buffered.toString("utf8", offset + 5, offset + 5 + length),
        });
        offset += 5 + length;
      } else if (type === 1) {
        if (rest < 8) break;
        messages.push({
          kind: "ack-clipboard",
          sequence: this.buffered.readBigUInt64BE(offset + 1),
        });
        offset += 9;
      } else if (type === 2) {
        if (rest < 4) break;
        const length = this.buffered.readUInt16BE(offset + 3);
        if (rest < 4 + length) break;
        messages.push({ kind: "uhid-output" });
        offset += 5 + length;
      } else {
        throw new ScrcpyProtocolError(`Unknown scrcpy device message type ${type}.`);
      }
    }
    this.buffered = offset === 0 ? this.buffered : Buffer.from(this.buffered.subarray(offset));
    return messages;
  }
}
