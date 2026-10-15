import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";

// Compressed relay RPC payloads: the framing, the in-band advertisement, and the
// length padding. Pure byte logic — no deflate implementation lives here, so the
// node (node:zlib) and every client platform (DecompressionStream, fflate) share
// one definition of the format and bring their own codec.
//
// WHERE THE FRAME SITS. A compressed payload replaces ONE node-to-client RPC
// message — the bytes the RPC serializer produced — before anything below the
// RPC layer sees it. On an E2EE channel it is therefore the body of an inner RPC
// record and never visible to the Hub; on a legacy channel it is the post-strip
// payload itself. Chunking, the chunk prelude, and the E2EE envelope all apply to
// the compressed frame exactly as they apply to plain JSON.
//
// WHY THE MAGIC CANNOT COLLIDE. 0xFF never occurs anywhere in UTF-8 text, so no
// JSON RPC message can start with it. No other payload form this layer can meet
// starts with it either: relay chunks start RELAY_CHUNK_MAGIC (0x00), the chunk
// capability prelude starts 0x20, E2EE envelopes 0x01, E2EE negotiation records
// 0x02, and legacy JSON `{` or `[`.
//
// NEGOTIATION. A client that can inflate appends an advertisement — eight bytes
// of JSON whitespace — to the END of its own RPC messages. JSON permits trailing
// whitespace, so an old node's `JSON.parse` ignores it; the canonical encoder
// never emits it, so a new node can recognize it. The node compresses a
// channel's responses only after it has seen the advertisement on that channel.
// The trailing position is deliberate: the leading bytes of a post-strip payload
// are the E2EE discriminator's (a payload must start `{` or `[` to be legacy
// JSON) and the chunk prelude's.
//
// VERSIONING. The advertisement is a four-byte magic followed by the highest
// frame version the client inflates, as four base-4 digits spelled in JSON
// whitespace. A client that advertises version N MUST accept every frame
// version from 1 to N; a node frames with the highest version it supports that
// does not exceed N, and does not compress at all when there is none. A future
// format is therefore a new version number, and a client advertising today
// keeps receiving version 1 frames or plain JSON — never a format it cannot
// read.

/** First byte of a compressed relay payload. */
export const RELAY_COMPRESSED_PAYLOAD_MAGIC = 0xff;
/** The highest (and today the only) frame version this module reads or writes. */
export const RELAY_COMPRESSED_PAYLOAD_VERSION = 0x01;
/**
 * `magic(1) version(1) flags(1)=0 reserved(1)=0 uncompressedBytes(u32 BE)
 * deflateBytes(u32 BE)`, then the raw DEFLATE body, then zero padding.
 */
export const RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES = 12;

/**
 * The advertisement's fixed first half. Only JSON whitespace, in an order
 * `JSON.stringify` never produces (it produces no whitespace outside strings at
 * all), and distinct from the leading RELAY_CHUNK_CAPABILITY_PRELUDE.
 */
const ADVERTISEMENT_MAGIC = [0x0a, 0x0d, 0x09, 0x20] as const;
/** The four JSON whitespace bytes as base-4 digits 0..3 of the advertised version. */
const ADVERTISEMENT_DIGITS = [0x20, 0x09, 0x0a, 0x0d] as const;
const ADVERTISEMENT_VERSION_DIGITS = 4;
const ADVERTISEMENT_BYTES = ADVERTISEMENT_MAGIC.length + ADVERTISEMENT_VERSION_DIGITS;

/** The advertisement of a client that inflates frame versions 1 to `maxVersion`. */
export function relayCompressionAdvertisement(maxVersion: number): Uint8Array {
  if (!Number.isInteger(maxVersion) || maxVersion < 1 || maxVersion > 255) {
    throw new RangeError("Relay compression versions are 1 to 255.");
  }
  const bytes = new Uint8Array(ADVERTISEMENT_BYTES);
  bytes.set(ADVERTISEMENT_MAGIC);
  for (let digit = 0; digit < ADVERTISEMENT_VERSION_DIGITS; digit += 1) {
    const shift = 2 * (ADVERTISEMENT_VERSION_DIGITS - 1 - digit);
    bytes[ADVERTISEMENT_MAGIC.length + digit] = ADVERTISEMENT_DIGITS[(maxVersion >> shift) & 3]!;
  }
  return bytes;
}

/** What this module's clients advertise: frame versions up to RELAY_COMPRESSED_PAYLOAD_VERSION. */
export const RELAY_COMPRESSION_ADVERTISEMENT = relayCompressionAdvertisement(
  RELAY_COMPRESSED_PAYLOAD_VERSION,
);

/** Smallest padding bucket: the compressed frame is never observable below 1 KiB. */
export const RELAY_COMPRESSION_MIN_PAD_BYTES = 1_024;
/** Buckets per doubling of size: the granularity is 1/16 of the enclosing power of two. */
export const RELAY_COMPRESSION_PAD_BUCKETS_PER_DOUBLING = 16;

export type CompressedRelayPayloadError =
  | "truncated"
  | "unsupported_version"
  | "bad_header"
  | "too_large"
  | "bad_padding";

export type CompressedRelayPayloadDecodeResult =
  | {
      readonly kind: "ok";
      /** The declared length of the inflated message. */
      readonly uncompressedBytes: number;
      /** The raw DEFLATE body, a view into the frame. */
      readonly body: Uint8Array;
    }
  | { readonly kind: "error"; readonly reason: CompressedRelayPayloadError };

/** Whether a payload claims to be a compressed frame. Valid or not is `decode`'s call. */
export function isCompressedRelayPayload(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && bytes[0] === RELAY_COMPRESSED_PAYLOAD_MAGIC;
}

/**
 * The padded length of a frame of `frameBytes` bytes.
 *
 * Geometric buckets: a frame is rounded up to a multiple of 1/16 of the largest
 * power of two not above it, and never to less than 1 KiB. The overhead is
 * therefore below 6.25% at every size, and the Hub's length resolution on a
 * compressed message degrades in proportion to the message rather than staying
 * a fixed kilobyte that a large message makes negligible.
 */
export function relayCompressionPaddedLength(frameBytes: number): number {
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 0) {
    throw new TypeError("Relay compression frame length must be a non-negative safe integer.");
  }
  if (frameBytes === 0) return 0;
  const power = 2 ** Math.floor(Math.log2(frameBytes));
  const bucket = Math.max(
    RELAY_COMPRESSION_MIN_PAD_BYTES,
    power / RELAY_COMPRESSION_PAD_BUCKETS_PER_DOUBLING,
  );
  return Math.ceil(frameBytes / bucket) * bucket;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    ((source[offset]! << 24) >>> 0) +
    ((source[offset + 1]! << 16) >>> 0) +
    ((source[offset + 2]! << 8) >>> 0) +
    source[offset + 3]!
  );
}

/**
 * Frame a raw DEFLATE body that inflates to `uncompressedBytes` bytes, padded
 * with zeros to its bucket (see `relayCompressionPaddedLength`).
 */
export function encodeCompressedRelayPayload(
  deflated: Uint8Array,
  uncompressedBytes: number,
): Uint8Array {
  if (
    !Number.isSafeInteger(uncompressedBytes) ||
    uncompressedBytes < 1 ||
    uncompressedBytes > RELAY_MAX_RPC_MESSAGE_BYTES
  ) {
    throw new RangeError("Compressed relay payloads carry 1 to RELAY_MAX_RPC_MESSAGE_BYTES bytes.");
  }
  if (deflated.byteLength < 1) {
    throw new RangeError("A compressed relay payload needs a non-empty body.");
  }
  const frameBytes = RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES + deflated.byteLength;
  const frame = new Uint8Array(relayCompressionPaddedLength(frameBytes));
  frame[0] = RELAY_COMPRESSED_PAYLOAD_MAGIC;
  frame[1] = RELAY_COMPRESSED_PAYLOAD_VERSION;
  writeUint32(frame, 4, uncompressedBytes);
  writeUint32(frame, 8, deflated.byteLength);
  frame.set(deflated, RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES);
  return frame;
}

/**
 * Validate a frame's header and padding and expose its body. Nothing is
 * inflated here; the declared length it returns is the hard cap the caller's
 * inflater runs under.
 *
 * `maxUncompressedBytes` defaults to the relay's own message limit, which is
 * the largest message the receiver would have accepted uncompressed: a frame
 * declaring more is refused before a byte of it is inflated.
 */
export function decodeCompressedRelayPayload(
  frame: Uint8Array,
  maxUncompressedBytes: number = RELAY_MAX_RPC_MESSAGE_BYTES,
): CompressedRelayPayloadDecodeResult {
  if (frame.byteLength < RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES) {
    return { kind: "error", reason: "truncated" };
  }
  if (frame[0] !== RELAY_COMPRESSED_PAYLOAD_MAGIC) return { kind: "error", reason: "bad_header" };
  if (frame[1] !== RELAY_COMPRESSED_PAYLOAD_VERSION) {
    return { kind: "error", reason: "unsupported_version" };
  }
  if (frame[2] !== 0 || frame[3] !== 0) return { kind: "error", reason: "bad_header" };
  const uncompressedBytes = readUint32(frame, 4);
  const deflateBytes = readUint32(frame, 8);
  if (uncompressedBytes === 0 || deflateBytes === 0) {
    return { kind: "error", reason: "bad_header" };
  }
  if (uncompressedBytes > Math.min(maxUncompressedBytes, RELAY_MAX_RPC_MESSAGE_BYTES)) {
    return { kind: "error", reason: "too_large" };
  }
  const bodyEnd = RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES + deflateBytes;
  if (bodyEnd > frame.byteLength) return { kind: "error", reason: "truncated" };
  for (let index = bodyEnd; index < frame.byteLength; index += 1) {
    if (frame[index] !== 0) return { kind: "error", reason: "bad_padding" };
  }
  return {
    kind: "ok",
    uncompressedBytes,
    body: frame.subarray(RELAY_COMPRESSED_PAYLOAD_HEADER_BYTES, bodyEnd),
  };
}

/**
 * The advertisement a (reassembled, decrypted) client RPC message ends with:
 * the highest frame version the client inflates, and the message without it.
 * `undefined` when it carries none.
 */
export function readRelayCompressionAdvertisement(
  message: Uint8Array,
): { readonly maxVersion: number; readonly message: Uint8Array } | undefined {
  if (message.byteLength <= ADVERTISEMENT_BYTES) return undefined;
  const offset = message.byteLength - ADVERTISEMENT_BYTES;
  for (let index = 0; index < ADVERTISEMENT_MAGIC.length; index += 1) {
    if (message[offset + index] !== ADVERTISEMENT_MAGIC[index]) return undefined;
  }
  let maxVersion = 0;
  for (let digit = 0; digit < ADVERTISEMENT_VERSION_DIGITS; digit += 1) {
    const value = ADVERTISEMENT_DIGITS.indexOf(
      message[offset + ADVERTISEMENT_MAGIC.length + digit] as (typeof ADVERTISEMENT_DIGITS)[number],
    );
    if (value < 0) return undefined;
    maxVersion = maxVersion * 4 + value;
  }
  if (maxVersion < 1) return undefined;
  return { maxVersion, message: message.subarray(0, offset) };
}

/** Whether a client RPC message carries an advertisement of any version. */
export function hasRelayCompressionAdvertisement(message: Uint8Array): boolean {
  return readRelayCompressionAdvertisement(message) !== undefined;
}

/** The message without a trailing advertisement, as a view; unchanged when it has none. */
export function stripRelayCompressionAdvertisement(message: Uint8Array): Uint8Array {
  return readRelayCompressionAdvertisement(message)?.message ?? message;
}

/** A copy of `message` with this client's advertisement appended. */
export function appendRelayCompressionAdvertisement(
  message: Uint8Array,
  advertisement: Uint8Array = RELAY_COMPRESSION_ADVERTISEMENT,
): Uint8Array {
  const advertised = new Uint8Array(message.byteLength + advertisement.byteLength);
  advertised.set(message);
  advertised.set(advertisement, message.byteLength);
  return advertised;
}
