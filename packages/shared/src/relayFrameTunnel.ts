/**
 * Frame sockets carried inside an end-to-end encrypted relay RPC channel.
 *
 * A direct client watches a device on its own WebSocket (`/ws/device-frames`):
 * binary H.264 envelopes one way, the live input protocol as text both ways. A
 * hosted client has no socket to the node, only its relay channel, so this
 * module tunnels that same socket through the channel. Each tunnel message is
 * the body of an ordinary RPC inner record (relay-e2ee-protocol.md §3.4,
 * `0x01`), exactly like a §4.6 compressed frame: the Hub forwards ciphertext,
 * sees only record lengths, and needs no change. The first byte tells a tunnel
 * message from JSON RPC: `0xFE` never begins UTF-8 and is not `0xFF` (§4.6).
 *
 * Only `e2ee` channels carry it. A `legacy` channel is plaintext to the Hub,
 * and its post-strip discrimination admits JSON alone.
 *
 * The client opens every stream, so a node sends tunnel messages only to a
 * client that asked for them; the client asks only a node that advertised the
 * tunnel (`ThreadDeviceState.relayFrameTunnel`). An older node would hand the
 * bytes to its JSON parser.
 *
 * Flow control is end to end. The client acknowledges every binary message as
 * it arrives (a cumulative count), and the node keeps at most
 * `RELAY_FRAME_TUNNEL_WINDOW_BYTES` unacknowledged per stream, dropping video
 * until the next keyframe beyond that the way the direct socket does. Video
 * therefore never fills the Hub's per-connection queue, whose high-water mark
 * pauses the whole channel, RPC included.
 *
 * Layout, big-endian:
 *
 * | Offset | Bytes | Field                                        |
 * | ------ | ----- | -------------------------------------------- |
 * | 0      | 1     | magic `0xFE`                                 |
 * | 1      | 1     | version, `0x01`                              |
 * | 2      | 1     | kind (`RELAY_FRAME_TUNNEL_KIND`)             |
 * | 3      | 4     | stream id, `1..2^32-1`, chosen by the client |
 * | 7      | rest  | body, by kind                                |
 *
 * Bodies: `open` is UTF-8 JSON naming the target; `close` is an optional
 * uint16 close code then UTF-8 reason; `text` is UTF-8; `binary` is opaque
 * bytes (a device frame envelope); `ack` is a uint32 count of binary messages
 * received on the stream so far, modulo 2^32.
 */

export const RELAY_FRAME_TUNNEL_MAGIC = 0xfe;
export const RELAY_FRAME_TUNNEL_VERSION = 1;
export const RELAY_FRAME_TUNNEL_HEADER_BYTES = 7;

export const RELAY_FRAME_TUNNEL_KIND = {
  open: 0x01,
  close: 0x02,
  text: 0x03,
  binary: 0x04,
  ack: 0x05,
} as const;

export type RelayFrameTunnelKind = keyof typeof RELAY_FRAME_TUNNEL_KIND;

/** Streams one channel may hold open at once: one per visible device, with room to switch. */
export const RELAY_FRAME_TUNNEL_MAX_STREAMS = 4;
/**
 * Unacknowledged binary bytes a node may have outstanding on one stream. More
 * than an iPhone keyframe, so a keyframe always fits an empty window, and far
 * below the Hub's per-connection high-water mark.
 */
export const RELAY_FRAME_TUNNEL_WINDOW_BYTES = 768 * 1_024;
/** Larger than any open request; a bigger one is not one. */
export const RELAY_FRAME_TUNNEL_MAX_OPEN_BYTES = 512;
/** Larger than any live input message (`DEVICE_LIVE_INPUT_MAX_MESSAGE_BYTES`). */
export const RELAY_FRAME_TUNNEL_MAX_TEXT_BYTES = 8_192;
export const RELAY_FRAME_TUNNEL_MAX_REASON_BYTES = 123;

/** What a stream connects to. Only the device frame socket, for now. */
export const RELAY_FRAME_TUNNEL_DEVICE_FRAMES = "device-frames";

export interface RelayFrameTunnelOpenTarget {
  readonly target: typeof RELAY_FRAME_TUNNEL_DEVICE_FRAMES;
  readonly udid: string;
}

/** WebSocket close codes the node uses on a tunnelled stream. */
export const RELAY_FRAME_TUNNEL_CLOSE = {
  /** The client closed it, or the channel is ending. */
  normal: 1000,
  /** The node does not stream devices, or the device is unknown. */
  unavailable: 4404,
  /** Too many streams on this channel, or a malformed open. */
  refused: 4400,
} as const;

export type RelayFrameTunnelMessage =
  | {
      readonly kind: "open";
      readonly streamId: number;
      readonly target: RelayFrameTunnelOpenTarget;
    }
  | {
      readonly kind: "close";
      readonly streamId: number;
      readonly code: number | null;
      readonly reason: string;
    }
  | { readonly kind: "text"; readonly streamId: number; readonly text: string }
  | { readonly kind: "binary"; readonly streamId: number; readonly bytes: Uint8Array }
  | { readonly kind: "ack"; readonly streamId: number; readonly received: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const KIND_BY_CODE = new Map<number, RelayFrameTunnelKind>(
  (Object.entries(RELAY_FRAME_TUNNEL_KIND) as [RelayFrameTunnelKind, number][]).map(
    ([kind, code]) => [code, kind],
  ),
);

const UDID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Whether a reassembled RPC record body is a tunnel message rather than JSON RPC. */
export function isRelayFrameTunnelMessage(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 1 && bytes[0] === RELAY_FRAME_TUNNEL_MAGIC;
}

export function isValidRelayFrameTunnelStreamId(streamId: number): boolean {
  return Number.isInteger(streamId) && streamId >= 1 && streamId <= 0xffff_ffff;
}

function frame(kind: RelayFrameTunnelKind, streamId: number, body: Uint8Array): Uint8Array {
  if (!isValidRelayFrameTunnelStreamId(streamId)) {
    throw new RangeError("Relay frame tunnel stream id is out of range.");
  }
  const bytes = new Uint8Array(RELAY_FRAME_TUNNEL_HEADER_BYTES + body.byteLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = RELAY_FRAME_TUNNEL_MAGIC;
  bytes[1] = RELAY_FRAME_TUNNEL_VERSION;
  bytes[2] = RELAY_FRAME_TUNNEL_KIND[kind];
  view.setUint32(3, streamId, false);
  bytes.set(body, RELAY_FRAME_TUNNEL_HEADER_BYTES);
  return bytes;
}

export function encodeRelayFrameTunnelOpen(
  streamId: number,
  target: RelayFrameTunnelOpenTarget,
): Uint8Array {
  return frame("open", streamId, encoder.encode(JSON.stringify(target)));
}

export function encodeRelayFrameTunnelClose(
  streamId: number,
  code?: number,
  reason?: string,
): Uint8Array {
  if (code === undefined) return frame("close", streamId, new Uint8Array(0));
  const reasonBytes = encoder.encode(reason ?? "").subarray(0, RELAY_FRAME_TUNNEL_MAX_REASON_BYTES);
  const body = new Uint8Array(2 + reasonBytes.byteLength);
  new DataView(body.buffer).setUint16(0, code, false);
  body.set(reasonBytes, 2);
  return frame("close", streamId, body);
}

export function encodeRelayFrameTunnelText(streamId: number, text: string): Uint8Array {
  return frame("text", streamId, encoder.encode(text));
}

export function encodeRelayFrameTunnelBinary(streamId: number, bytes: Uint8Array): Uint8Array {
  return frame("binary", streamId, bytes);
}

export function encodeRelayFrameTunnelAck(streamId: number, received: number): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, received >>> 0, false);
  return frame("ack", streamId, body);
}

function decodeOpenTarget(body: Uint8Array): RelayFrameTunnelOpenTarget | null {
  if (body.byteLength > RELAY_FRAME_TUNNEL_MAX_OPEN_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(body));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { target, udid } = parsed as { readonly target?: unknown; readonly udid?: unknown };
    if (target !== RELAY_FRAME_TUNNEL_DEVICE_FRAMES) return null;
    if (typeof udid !== "string" || !UDID_PATTERN.test(udid)) return null;
    return { target, udid };
  } catch {
    return null;
  }
}

/**
 * Parse one tunnel message, or `null` for anything malformed. Binary bodies
 * are views into `bytes`, not copies.
 */
export function decodeRelayFrameTunnelMessage(bytes: Uint8Array): RelayFrameTunnelMessage | null {
  if (bytes.byteLength < RELAY_FRAME_TUNNEL_HEADER_BYTES) return null;
  if (bytes[0] !== RELAY_FRAME_TUNNEL_MAGIC || bytes[1] !== RELAY_FRAME_TUNNEL_VERSION) return null;
  const kind = KIND_BY_CODE.get(bytes[2] ?? 0);
  if (kind === undefined) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(3, false);
  if (!isValidRelayFrameTunnelStreamId(streamId)) return null;
  const body = bytes.subarray(RELAY_FRAME_TUNNEL_HEADER_BYTES);
  switch (kind) {
    case "open": {
      const target = decodeOpenTarget(body);
      return target === null ? null : { kind, streamId, target };
    }
    case "close": {
      if (body.byteLength === 0) return { kind, streamId, code: null, reason: "" };
      if (body.byteLength < 2 || body.byteLength > 2 + RELAY_FRAME_TUNNEL_MAX_REASON_BYTES) {
        return null;
      }
      try {
        const code = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(0);
        return { kind, streamId, code, reason: decoder.decode(body.subarray(2)) };
      } catch {
        return null;
      }
    }
    case "text": {
      if (body.byteLength > RELAY_FRAME_TUNNEL_MAX_TEXT_BYTES) return null;
      try {
        return { kind, streamId, text: decoder.decode(body) };
      } catch {
        return null;
      }
    }
    case "binary":
      return { kind, streamId, bytes: body };
    case "ack": {
      if (body.byteLength !== 4) return null;
      const received = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
      return { kind, streamId, received };
    }
  }
}
