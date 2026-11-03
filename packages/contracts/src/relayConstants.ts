/**
 * The relay protocol's numbers: versions, frame and queue limits, timing, and
 * the application chunk header. Plain values with no schemas, so code that
 * only sizes or times something (a reconnect's retry ceiling, an upload's
 * message cap) imports them without the relay's wire schemas, which the
 * standard build never decodes. `./relay.ts` re-exports all of them.
 */
export const RELAY_PROTOCOL_MAJOR = 1 as const;
export const RELAY_PROTOCOL_MINOR = 3 as const;
export const RELAY_PROTOCOL_MINIMUM_MINOR = 0 as const;
export const RELAY_AUTHORIZED_CHANNEL_MINOR = 2 as const;
export const RELAY_ACCOUNT_GRANT_MINOR = 3 as const;
export const RELAY_E2EE_CAPABILITY_STATEMENT_MAX_BYTES = 5_190;
export const RELAY_E2EE_GRANT_KEYSET_MAX_KEYS = 4;

export const RELAY_MAX_CONTROL_FRAME_BYTES = 256 * 1_024;
export const RELAY_MAX_DATA_CHUNK_BYTES = 256 * 1_024;
export const RELAY_MAX_DATA_FRAME_OVERHEAD_BYTES = 1_024;
export const RELAY_MAX_DATA_FRAME_BYTES =
  RELAY_MAX_DATA_CHUNK_BYTES + RELAY_MAX_DATA_FRAME_OVERHEAD_BYTES;
export const RELAY_MAX_QUEUED_BYTES = 8 * 1_024 * 1_024;
export const RELAY_MAX_CHANNELS = 8;
export const RELAY_HEARTBEAT_INTERVAL_MS = 20_000;
export const RELAY_DEAD_CONNECTION_TIMEOUT_MS = 45_000;
export const RELAY_AUTHENTICATION_DEADLINE_MS = 5_000;

// ─── Application-level message chunking ──────────────────────────────────────
//
// One RPC response is one relay data frame, and a frame is capped at
// RELAY_MAX_DATA_CHUNK_BYTES — so any response above that ceiling destroys the
// channel. See docs/superpowers/plans/2026-07-27-relay-oversized-rpc-framing.md.
//
// The fix splits a large message across several frames with an 8-byte header
// INSIDE `data.payload`. The relay spec keeps that payload opaque ("does not
// parse it as Ryco RPC, events, terminal data, attachments, JSON, text, or any
// other application format"), precisely so the payload schema can change
// without touching relay routing — so this needs no wire-format change, no
// protocol version bump and nothing from the Hub.
//
// Header: magic(1) version(1) flags(1) reserved(1) totalBytes(4, big-endian).
// A payload that already fits stays unchunked. New endpoints may prefix it
// with JSON whitespace to advertise chunk support; legacy JSON decoders accept
// that marker unchanged, so independently upgraded peers remain compatible.
export const RELAY_CHUNK_HEADER_BYTES = 8;
/** JSON payloads never start with NUL, so this distinguishes chunked from legacy. */
export const RELAY_CHUNK_MAGIC = 0x00;
export const RELAY_CHUNK_VERSION = 0x01;
export const RELAY_CHUNK_FLAG_FINAL = 0x01;
/**
 * Hard ceiling on a reassembled message. Bounds what a peer can make a receiver
 * buffer; must stay below `maxQueuedBytes - maxControlFrameBytes` so a message
 * in flight cannot alone exhaust the queue budget.
 */
export const RELAY_MAX_RPC_MESSAGE_BYTES = 4 * 1_024 * 1_024;

export const RELAY_MIN_CONTROL_FRAME_BYTES = 1_024;
export const RELAY_MIN_DATA_CHUNK_BYTES = 1_024;
export const RELAY_MIN_QUEUED_BYTES = 2_048;
export const RELAY_MIN_CHANNELS = 1;
export const RELAY_MIN_HEARTBEAT_INTERVAL_MS = 5_000;
export const RELAY_MIN_DEAD_CONNECTION_TIMEOUT_MS = 15_000;
export const RELAY_MIN_AUTHENTICATION_DEADLINE_MS = 1_000;
export const RELAY_MAX_RETRY_AFTER_MS = 300_000;
