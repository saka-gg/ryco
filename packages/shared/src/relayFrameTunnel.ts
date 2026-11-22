/**
 * Frame sockets carried inside an end-to-end encrypted relay RPC channel.
 *
 * A direct client watches a device on its own WebSocket (`/ws/device-frames`):
 * binary H.264 envelopes one way, the live input protocol as text both ways. A
 * hosted client has no socket to the node, only its relay channel, so this
 * module tunnels that same socket through the channel. A second target carries
 * the node browser's frame socket (`/ws/node-browser-frames`: JPEG envelopes
 * one way, the client's `{"type":"ack"}` per frame the other), for handed-off
 * desktop tabs (`handoff-<32 hex>`) only; ordinary node tabs stay off the relay. Each tunnel message is
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
 * A node browser stream needs no dropping: its viewer sends the next frame
 * only after the client's per-frame ack, so at most one frame is out.
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
 * bytes (a device or node browser frame envelope); `ack` is a uint32 count of binary messages
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

/** What a stream connects to: a device's frame socket. */
export const RELAY_FRAME_TUNNEL_DEVICE_FRAMES = "device-frames";
/**
 * Or a node browser tab's frame socket, for a handed-off desktop tab only
 * (`isRelayFrameTunnelNodeBrowserTabId`).
 */
export const RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES = "node-browser-frames";

export interface RelayFrameTunnelDeviceTarget {
  readonly target: typeof RELAY_FRAME_TUNNEL_DEVICE_FRAMES;
  readonly udid: string;
}

export interface RelayFrameTunnelNodeBrowserTarget {
  readonly target: typeof RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES;
  /** `handoff-<32 lowercase hex>`; no other tab id is ever tunnelled. */
  readonly tabId: string;
  /** The viewer's frame size in device pixels and JPEG quality, as the frame socket's query. */
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly quality?: number;
}

const boundedInt = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;

export type RelayFrameTunnelOpenTarget =
  | RelayFrameTunnelDeviceTarget
  | RelayFrameTunnelNodeBrowserTarget;

/** WebSocket close codes the node uses on a tunnelled stream. */
export const RELAY_FRAME_TUNNEL_CLOSE = {
  /** The client closed it, or the channel is ending. */
  normal: 1000,
  /**
   * The node does not stream devices, or the device is unknown; for a node
   * browser stream, the node serves no handed-off tabs through the tunnel.
   */
  unavailable: 4404,
  /** Too many streams on this channel, or a malformed open. */
  refused: 4400,
  /**
   * This channel's role may not open the target: a node browser stream needs
   * an owner channel. The node browser frame socket's own `forbidden` code, so
   * the client's frame source stops instead of retrying.
   */
  forbidden: 4403,
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
const HANDOFF_TAB_ID_PATTERN = /^handoff-[0-9a-f]{32}$/u;

/**
 * Whether a node browser tab id may be tunnelled: a handed-off desktop tab's id
 * (`userActionRemoteViewTabId`), nothing else.
 */
export function isRelayFrameTunnelNodeBrowserTabId(tabId: string): boolean {
  return HANDOFF_TAB_ID_PATTERN.test(tabId);
}

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
    const { target, udid, tabId, maxWidth, maxHeight, quality } = parsed as {
      readonly target?: unknown;
      readonly udid?: unknown;
      readonly tabId?: unknown;
      readonly maxWidth?: unknown;
      readonly maxHeight?: unknown;
      readonly quality?: unknown;
    };
    switch (target) {
      case RELAY_FRAME_TUNNEL_DEVICE_FRAMES:
        if (typeof udid !== "string" || !UDID_PATTERN.test(udid)) return null;
        return { target, udid };
      case RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES:
        if (typeof tabId !== "string" || !isRelayFrameTunnelNodeBrowserTabId(tabId)) return null;
        {
          // Out-of-range sizes are dropped (the node's defaults apply), never trusted.
          const width = boundedInt(maxWidth, 64, 4096);
          const height = boundedInt(maxHeight, 64, 4096);
          const jpegQuality = boundedInt(quality, 20, 80);
          return {
            target,
            tabId,
            ...(width === undefined ? {} : { maxWidth: width }),
            ...(height === undefined ? {} : { maxHeight: height }),
            ...(jpegQuality === undefined ? {} : { quality: jpegQuality }),
          };
        }
      default:
        return null;
    }
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
