import { HubAccountId, HubBrowserSessionId } from "@ryco/contracts/hosted-identity";
import {
  HUB_SESSION_BASE_PROTOCOL_VERSION,
  HUB_SESSION_CLOSE_REASON_BYTES,
  HUB_SESSION_HEADER_BYTES,
  HUB_SESSION_MAX_CHANNELS,
  HUB_SESSION_MAX_FRAME_BYTES,
  HUB_SESSION_OPEN_NODE_CAPABILITIES,
  HUB_SESSION_PROTOCOL_VERSION,
  HUB_SESSION_SUBPROTOCOL_PREFIX,
  type HubSessionFrame,
  type HubSessionProtocolVersion,
} from "@ryco/contracts/hub-session";
import { RELAY_MAX_DATA_FRAME_BYTES, RelayNodeId } from "@ryco/contracts/relay";
import * as Schema from "effect/Schema";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: "invalid_frame" };
const invalid = { ok: false, error: "invalid_frame" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const kinds = {
  open: 1,
  data: 2,
  close: 3,
  ready: 4,
  ping: 5,
  pong: 6,
  invalidate: 7,
  openNode: 8,
} as const;
/** Kinds that address a logical stream; every other kind is session control on stream zero. */
const STREAM_KINDS: ReadonlySet<number> = new Set([
  kinds.open,
  kinds.data,
  kinds.close,
  kinds.openNode,
]);
/** Wire codes of {@link HUB_SESSION_OPEN_NODE_CAPABILITIES}, by position plus one. */
const OPEN_NODE_CAPABILITY_CODES = HUB_SESSION_OPEN_NODE_CAPABILITIES;
/** Every identifier the codec carries is ASCII and at most 48 characters. */
const MAX_IDENTIFIER_BYTES = 48;
const isNodeId = Schema.is(RelayNodeId);
const isAccountId = Schema.is(HubAccountId);
const isSessionId = Schema.is(HubBrowserSessionId);

/**
 * The client's maximum session version from a `Sec-WebSocket-Protocol` offer, or the base version
 * when it advertises none. Offers that are not `ryco.hub-session.v<N>` are ignored, never fatal:
 * a client that predates the offer sends nothing, and an unrecognised token must not cost a
 * client the version every Hub speaks. Returns the offered token too, because a Hub that selects a
 * subprotocol must answer with exactly one the client offered.
 */
export function parseHubSessionSubprotocols(header: string | null): {
  readonly maxVersion: number;
  readonly token: string | null;
} {
  let best: { maxVersion: number; token: string | null } = {
    maxVersion: HUB_SESSION_BASE_PROTOCOL_VERSION,
    token: null,
  };
  if (header === null || header.length > 256) return best;
  const offers = header.split(",");
  if (offers.length > 8) return best;
  for (const offer of offers) {
    const token = offer.trim();
    if (!token.startsWith(HUB_SESSION_SUBPROTOCOL_PREFIX)) continue;
    const digits = token.slice(HUB_SESSION_SUBPROTOCOL_PREFIX.length);
    if (!/^[1-9][0-9]{0,2}$/.test(digits)) continue;
    const version = Number(digits);
    if (best.token === null || version > best.maxVersion) best = { maxVersion: version, token };
  }
  return best;
}

/** The version both ends speak: the lower of the client's advertised maximum and the Hub's. */
export function negotiateHubSessionVersion(
  clientMaxVersion: number,
  serverMaxVersion: HubSessionProtocolVersion,
): HubSessionProtocolVersion {
  return Math.min(clientMaxVersion, serverMaxVersion, HUB_SESSION_PROTOCOL_VERSION) >= 2 ? 2 : 1;
}

function encodeIdentifier(value: string): Uint8Array | null {
  const bytes = encoder.encode(value);
  return bytes.byteLength >= 1 && bytes.byteLength <= MAX_IDENTIFIER_BYTES ? bytes : null;
}

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
    case "ready": {
      if (
        !Number.isInteger(frame.maxChannels) ||
        frame.maxChannels < 1 ||
        frame.maxChannels > HUB_SESSION_MAX_CHANNELS
      )
        return invalid;
      if (frame.protocolVersion === HUB_SESSION_BASE_PROTOCOL_VERSION) {
        // Version 1 stays byte for byte what a version-1 client decodes.
        payload = Uint8Array.of(HUB_SESSION_BASE_PROTOCOL_VERSION, frame.maxChannels);
        break;
      }
      if (frame.protocolVersion !== 2 || !isAccountId(frame.accountId)) return invalid;
      if (!isSessionId(frame.sessionId)) return invalid;
      const account = encodeIdentifier(frame.accountId);
      const session = encodeIdentifier(frame.sessionId);
      if (account === null || session === null) return invalid;
      payload = new Uint8Array(4 + account.byteLength + session.byteLength);
      payload[0] = 2;
      payload[1] = frame.maxChannels;
      payload[2] = account.byteLength;
      payload.set(account, 3);
      payload[3 + account.byteLength] = session.byteLength;
      payload.set(session, 4 + account.byteLength);
      break;
    }
    case "ping":
    case "pong":
      if (frame.nonce.byteLength !== 8) return invalid;
      payload = frame.nonce;
      break;
    case "invalidate":
      if (!frame.directory && !frame.threadCache) return invalid;
      payload = Uint8Array.of((frame.directory ? 1 : 0) | (frame.threadCache ? 2 : 0));
      break;
    case "openNode": {
      const capability = OPEN_NODE_CAPABILITY_CODES.indexOf(frame.capability);
      if (
        capability < 0 ||
        frame.protocolMajor !== 1 ||
        (frame.protocolMinor !== 2 && frame.protocolMinor !== 3) ||
        !isNodeId(frame.nodeId) ||
        !isSessionId(frame.sessionId)
      )
        return invalid;
      const nodeId = encodeIdentifier(frame.nodeId);
      const sessionId = encodeIdentifier(frame.sessionId);
      if (nodeId === null || sessionId === null) return invalid;
      payload = new Uint8Array(5 + nodeId.byteLength + sessionId.byteLength);
      payload[0] = frame.protocolMajor;
      payload[1] = frame.protocolMinor;
      payload[2] = capability + 1;
      payload[3] = nodeId.byteLength;
      payload.set(nodeId, 4);
      payload[4 + nodeId.byteLength] = sessionId.byteLength;
      payload.set(sessionId, 5 + nodeId.byteLength);
      break;
    }
  }
  const bytes = new Uint8Array(HUB_SESSION_HEADER_BYTES + payload.byteLength);
  bytes[0] = kinds[frame.type];
  new DataView(bytes.buffer).setUint32(1, streamId);
  bytes.set(payload, HUB_SESSION_HEADER_BYTES);
  return { ok: true, value: bytes };
}

export interface HubSessionDecodeOptions {
  /**
   * Return a `data` frame's payload as a view into `bytes` instead of a copy.
   * For a caller that hands the payload to a consumer taking ownership of it
   * (the relay engine decodes and zeroes what it receives) and that neither
   * reuses nor erases `bytes` itself: the copy only left an unzeroed duplicate.
   */
  readonly borrowDataPayload?: boolean;
  /**
   * The session version this connection negotiated — or, for a client still awaiting `ready`, the
   * highest it advertised. Frames a lower version does not define (`openNode`, a version-2
   * `ready`) fail closed. Defaults to version 1, which decodes exactly what a version-1 codec did.
   */
  readonly protocolVersion?: HubSessionProtocolVersion;
}

/** One length-prefixed ASCII identifier at `offset`, or null when it does not fit exactly. */
function readIdentifier(
  payload: Uint8Array,
  offset: number,
): { readonly value: string; readonly end: number } | null {
  const length = payload[offset];
  if (length === undefined || length < 1 || length > MAX_IDENTIFIER_BYTES) return null;
  const end = offset + 1 + length;
  if (end > payload.byteLength) return null;
  try {
    return { value: decoder.decode(payload.subarray(offset + 1, end)), end };
  } catch {
    return null;
  }
}

/**
 * All returned payloads are owned copies, and the caller may erase the input,
 * except a `data` payload decoded with `borrowDataPayload`.
 */
export function decodeHubSessionFrame(
  bytes: Uint8Array,
  options?: HubSessionDecodeOptions,
): Result<HubSessionFrame> {
  if (bytes.byteLength < HUB_SESSION_HEADER_BYTES || bytes.byteLength > HUB_SESSION_MAX_FRAME_BYTES)
    return invalid;
  const version = options?.protocolVersion ?? HUB_SESSION_BASE_PROTOCOL_VERSION;
  const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  const payload = bytes.subarray(HUB_SESSION_HEADER_BYTES);
  const kind = bytes[0];
  const maxKind = version >= 2 ? kinds.openNode : kinds.invalidate;
  if (kind === undefined || kind < 1 || kind > maxKind || STREAM_KINDS.has(kind) !== streamId > 0)
    return invalid;
  let frame: HubSessionFrame;
  switch (kind) {
    case 1:
      if (payload.byteLength !== 0) return invalid;
      frame = { type: "open", streamId };
      break;
    case 2:
      if (payload.byteLength < 1) return invalid;
      frame = {
        type: "data",
        streamId,
        payload: options?.borrowDataPayload === true ? payload : Uint8Array.from(payload),
      };
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
    case 4: {
      const maxChannels = payload[1];
      if (maxChannels === undefined || maxChannels < 1 || maxChannels > HUB_SESSION_MAX_CHANNELS)
        return invalid;
      if (payload[0] === HUB_SESSION_BASE_PROTOCOL_VERSION) {
        if (payload.byteLength !== 2) return invalid;
        frame = { type: "ready", protocolVersion: HUB_SESSION_BASE_PROTOCOL_VERSION, maxChannels };
        break;
      }
      if (payload[0] !== 2 || version < 2) return invalid;
      const account = readIdentifier(payload, 2);
      const session = account === null ? null : readIdentifier(payload, account.end);
      if (
        account === null ||
        session === null ||
        session.end !== payload.byteLength ||
        !isAccountId(account.value) ||
        !isSessionId(session.value)
      )
        return invalid;
      frame = {
        type: "ready",
        protocolVersion: 2,
        maxChannels,
        accountId: account.value,
        sessionId: session.value,
      };
      break;
    }
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
    case 8: {
      const capability = OPEN_NODE_CAPABILITY_CODES[(payload[2] ?? 0) - 1];
      const minor = payload[1];
      const nodeId = readIdentifier(payload, 3);
      const sessionId = nodeId === null ? null : readIdentifier(payload, nodeId.end);
      if (
        payload[0] !== 1 ||
        (minor !== 2 && minor !== 3) ||
        capability === undefined ||
        nodeId === null ||
        sessionId === null ||
        sessionId.end !== payload.byteLength ||
        !isNodeId(nodeId.value) ||
        !isSessionId(sessionId.value)
      )
        return invalid;
      frame = {
        type: "openNode",
        streamId,
        nodeId: nodeId.value,
        sessionId: sessionId.value,
        capability,
        protocolMajor: 1,
        protocolMinor: minor,
      };
      break;
    }
    default:
      return invalid;
  }
  return { ok: true, value: frame };
}
