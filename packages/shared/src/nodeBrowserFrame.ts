/**
 * The node browser's frame socket: live JPEG frames of one tab, on a socket of
 * their own so a slow link never queues images in front of RPC replies. It is
 * never compressed (JPEG already is) and never cached.
 *
 * Each binary message is one frame in a small envelope (little-endian): magic
 * `0x5242` ("RB"), version 1, `seq` u32, `cssWidth` u16, `cssHeight` u16, then
 * the JPEG. The page's CSS size travels with every frame, so a client maps
 * input against the frame it shows, never against a size that raced it.
 *
 * The client acknowledges every frame with `{"type":"ack"}` and sends nothing
 * else; the node sends the next frame only after that ack.
 *
 * @module nodeBrowserFrame
 */

export const NODE_BROWSER_FRAME_WS_PATH = "/ws/node-browser-frames";

/** Query parameters of the frame socket. */
export const NODE_BROWSER_FRAME_PARAMS = {
  tab: "tab",
  /** The largest frame the client wants, in device pixels. */
  maxWidth: "maxWidth",
  maxHeight: "maxHeight",
  /** JPEG quality, 20 to 80. */
  quality: "quality",
} as const;

export const NODE_BROWSER_FRAME_ACK = '{"type":"ack"}';
/** An ack is a dozen bytes; anything larger is not one. */
const MAX_CLIENT_MESSAGE_BYTES = 64;

/**
 * Codes the node closes the frame socket with. Each is sent after the
 * upgrade: a refused upgrade reads as an authentication failure to clients.
 */
export const NODE_BROWSER_FRAME_CLOSE = {
  /** The browser restarted: reconnect. */
  restarted: 1012,
  /** The node streams as many tabs as it allows: try again later. */
  capacity: 1013,
  /** The session may not watch node browser tabs (operators only). */
  forbidden: 4403,
  /** The tab is closed, crashed or unknown. */
  tabGone: 4404,
  /** The browser cannot run on the node; the reason is the close reason. */
  unavailable: 4503,
} as const;

export const NODE_BROWSER_FRAME_MAGIC = 0x5242;
export const NODE_BROWSER_FRAME_VERSION = 1;
export const NODE_BROWSER_FRAME_HEADER_BYTES = 11;

export interface NodeBrowserFrame {
  readonly seq: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly jpeg: Uint8Array;
}

export type NodeBrowserFrameDecodeResult =
  | { readonly ok: true; readonly frame: NodeBrowserFrame }
  | { readonly ok: false; readonly reason: "truncated" | "bad-magic" | "bad-version" };

export const encodeNodeBrowserFrame = (frame: NodeBrowserFrame): Uint8Array => {
  const bytes = new Uint8Array(NODE_BROWSER_FRAME_HEADER_BYTES + frame.jpeg.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, NODE_BROWSER_FRAME_MAGIC, true);
  view.setUint8(2, NODE_BROWSER_FRAME_VERSION);
  view.setUint32(3, frame.seq >>> 0, true);
  view.setUint16(7, Math.min(0xffff, Math.max(0, Math.round(frame.cssWidth))), true);
  view.setUint16(9, Math.min(0xffff, Math.max(0, Math.round(frame.cssHeight))), true);
  bytes.set(frame.jpeg, NODE_BROWSER_FRAME_HEADER_BYTES);
  return bytes;
};

/** The JPEG is a view into `bytes`, not a copy. */
export const decodeNodeBrowserFrame = (bytes: Uint8Array): NodeBrowserFrameDecodeResult => {
  if (bytes.byteLength <= NODE_BROWSER_FRAME_HEADER_BYTES)
    return { ok: false, reason: "truncated" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== NODE_BROWSER_FRAME_MAGIC)
    return { ok: false, reason: "bad-magic" };
  if (view.getUint8(2) !== NODE_BROWSER_FRAME_VERSION) return { ok: false, reason: "bad-version" };
  return {
    ok: true,
    frame: {
      seq: view.getUint32(3, true),
      cssWidth: view.getUint16(7, true),
      cssHeight: view.getUint16(9, true),
      jpeg: bytes.subarray(NODE_BROWSER_FRAME_HEADER_BYTES),
    },
  };
};

/** Whether a client message is the frame ack; anything else is ignored, never dispatched. */
export const isNodeBrowserFrameAck = (message: string | Uint8Array): boolean => {
  const size = typeof message === "string" ? message.length : message.byteLength;
  if (size > MAX_CLIENT_MESSAGE_BYTES) return false;
  try {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { readonly type?: unknown }).type === "ack"
    );
  } catch {
    return false;
  }
};
