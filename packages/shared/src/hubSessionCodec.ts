import {
  HUB_SESSION_CLOSE_REASON_BYTES,
  HUB_SESSION_HEADER_BYTES,
  HUB_SESSION_MAX_CHANNELS,
  HUB_SESSION_MAX_FRAME_BYTES,
  HUB_SESSION_PROTOCOL_VERSION,
  type HubSessionFrame,
} from "@ryco/contracts/hub-session";
import { RELAY_MAX_DATA_FRAME_BYTES } from "@ryco/contracts/relay";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: "invalid_frame" };
const invalid = { ok: false, error: "invalid_frame" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const kinds = { open: 1, data: 2, close: 3, ready: 4, ping: 5, pong: 6, invalidate: 7 } as const;

export function encodeHubSessionFrame(frame: HubSessionFrame): Result<Uint8Array> {
  let payload: Uint8Array;
  const streamId = "streamId" in frame ? frame.streamId : 0;
  if (
    "streamId" in frame &&
    (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffff_ffff)
  )
    return invalid;
  switch (frame.type) {
    case "open":
      payload = new Uint8Array(0);
      break;
    case "data":
      if (frame.payload.byteLength < 1 || frame.payload.byteLength > RELAY_MAX_DATA_FRAME_BYTES)
        return invalid;
      payload = frame.payload;
      break;
    case "close": {
      const reason = encoder.encode(frame.reason);
      if (
        reason.byteLength > HUB_SESSION_CLOSE_REASON_BYTES ||
        !Number.isInteger(frame.code) ||
        frame.code < 1000 ||
        frame.code > 4999
      )
        return invalid;
      payload = new Uint8Array(2 + reason.byteLength);
      new DataView(payload.buffer).setUint16(0, frame.code);
      payload.set(reason, 2);
      break;
    }
    case "ready":
      if (
        frame.protocolVersion !== HUB_SESSION_PROTOCOL_VERSION ||
        !Number.isInteger(frame.maxChannels) ||
        frame.maxChannels < 1 ||
        frame.maxChannels > HUB_SESSION_MAX_CHANNELS
      )
        return invalid;
      payload = Uint8Array.of(HUB_SESSION_PROTOCOL_VERSION, frame.maxChannels);
      break;
    case "ping":
    case "pong":
      if (frame.nonce.byteLength !== 8) return invalid;
      payload = frame.nonce;
      break;
    case "invalidate":
      if (!frame.directory && !frame.threadCache) return invalid;
      payload = Uint8Array.of((frame.directory ? 1 : 0) | (frame.threadCache ? 2 : 0));
      break;
  }
  const bytes = new Uint8Array(HUB_SESSION_HEADER_BYTES + payload.byteLength);
  bytes[0] = kinds[frame.type];
  new DataView(bytes.buffer).setUint32(1, streamId);
  bytes.set(payload, HUB_SESSION_HEADER_BYTES);
  return { ok: true, value: bytes };
}

/** All returned payloads are owned copies; the caller may erase the input. */
export function decodeHubSessionFrame(bytes: Uint8Array): Result<HubSessionFrame> {
  if (bytes.byteLength < HUB_SESSION_HEADER_BYTES || bytes.byteLength > HUB_SESSION_MAX_FRAME_BYTES)
    return invalid;
  const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  const payload = bytes.subarray(HUB_SESSION_HEADER_BYTES);
  const kind = bytes[0];
  if (kind === undefined || kind < 1 || kind > 7 || kind <= 3 !== streamId > 0) return invalid;
  let frame: HubSessionFrame;
  switch (kind) {
    case 1:
      if (payload.byteLength !== 0) return invalid;
      frame = { type: "open", streamId };
      break;
    case 2:
      if (payload.byteLength < 1) return invalid;
      frame = { type: "data", streamId, payload: Uint8Array.from(payload) };
      break;
    case 3: {
      if (payload.byteLength < 2 || payload.byteLength > HUB_SESSION_CLOSE_REASON_BYTES + 2)
        return invalid;
      const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(
        0,
      );
      if (code < 1000 || code > 4999) return invalid;
      try {
        frame = { type: "close", streamId, code, reason: decoder.decode(payload.subarray(2)) };
      } catch {
        return invalid;
      }
      break;
    }
    case 4:
      if (
        payload.byteLength !== 2 ||
        payload[0] !== HUB_SESSION_PROTOCOL_VERSION ||
        payload[1]! < 1 ||
        payload[1]! > HUB_SESSION_MAX_CHANNELS
      )
        return invalid;
      frame = {
        type: "ready",
        protocolVersion: HUB_SESSION_PROTOCOL_VERSION,
        maxChannels: payload[1]!,
      };
      break;
    case 5:
    case 6:
      if (payload.byteLength !== 8) return invalid;
      frame = { type: kind === 5 ? "ping" : "pong", nonce: Uint8Array.from(payload) };
      break;
    case 7:
      if (payload.byteLength !== 1 || payload[0]! < 1 || payload[0]! > 3) return invalid;
      frame = {
        type: "invalidate",
        directory: (payload[0]! & 1) !== 0,
        threadCache: (payload[0]! & 2) !== 0,
      };
      break;
    default:
      return invalid;
  }
  return { ok: true, value: frame };
}
