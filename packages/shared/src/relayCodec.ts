import {
  RELAY_FRAME_TYPES,
  RELAY_MAX_CONTROL_FRAME_BYTES,
  RELAY_MAX_DATA_CHUNK_BYTES,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_PROTOCOL_MAJOR,
  RELAY_PROTOCOL_MINOR,
  RELAY_PROTOCOL_MINIMUM_MINOR,
  RELAY_SUPPORTED_VERSION_RANGE,
  RelayFrame,
  RelayProtocolVersion,
  type RelayProtocolErrorCode,
  type RelaySupportedVersionRange,
} from "@ryco/contracts/relay";
import { decode, encode, rfc8949EncodeOptions } from "cborg";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const MAP_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILE_DEPTH = 64;
const INVALID_PROFILE_VALUE = Symbol("INVALID_PROFILE_VALUE");
const frameTypes = new Set<string>(RELAY_FRAME_TYPES);

const strictDecodeOptions = {
  allowIndefinite: false,
  allowUndefined: false,
  allowInfinity: false,
  allowNaN: false,
  allowBigInt: false,
  strict: true,
  useMaps: true,
  rejectDuplicateMapKeys: true,
  tags: {},
} as const;

export interface RelayCodecError {
  readonly code: RelayProtocolErrorCode;
  readonly supported?: RelaySupportedVersionRange;
}

export type RelayCodecResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: RelayCodecError };

export interface DecodeRelayFrameOptions {
  readonly expectedVersion?: RelayProtocolVersion;
}

const success = <A>(value: A): RelayCodecResult<A> => ({ ok: true, value });

const failure = (
  code: RelayProtocolErrorCode,
  supported?: RelaySupportedVersionRange,
): RelayCodecResult<never> =>
  supported === undefined
    ? { ok: false, error: { code } }
    : { ok: false, error: { code, supported } };

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function toProtocolValue(value: unknown, depth = 0): unknown | typeof INVALID_PROFILE_VALUE {
  if (depth > MAX_PROFILE_DEPTH) {
    return INVALID_PROFILE_VALUE;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : INVALID_PROFILE_VALUE;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const converted = toProtocolValue(item, depth + 1);
      if (converted === INVALID_PROFILE_VALUE) {
        return INVALID_PROFILE_VALUE;
      }
      output.push(converted);
    }
    return output;
  }
  if (value instanceof Map) {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of value) {
      if (typeof key !== "string" || !MAP_KEY_PATTERN.test(key)) {
        return INVALID_PROFILE_VALUE;
      }
      const converted = toProtocolValue(item, depth + 1);
      if (converted === INVALID_PROFILE_VALUE) {
        return INVALID_PROFILE_VALUE;
      }
      output[key] = converted;
    }
    return output;
  }
  return INVALID_PROFILE_VALUE;
}

function decodeCanonicalValue(bytes: Uint8Array): RelayCodecResult<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = decode(bytes, strictDecodeOptions);
  } catch {
    return failure("invalid_encoding");
  }
  if (!(raw instanceof Map)) {
    return failure("invalid_encoding");
  }

  let canonical: Uint8Array;
  try {
    canonical = encode(raw, rfc8949EncodeOptions);
  } catch {
    return failure("invalid_encoding");
  }
  if (!bytesEqual(bytes, canonical)) {
    return failure("invalid_encoding");
  }

  const value = toProtocolValue(raw);
  if (value === INVALID_PROFILE_VALUE || value === null || Array.isArray(value)) {
    return failure("invalid_encoding");
  }
  return success(value as Record<string, unknown>);
}

function validateEnvelopeVersion(
  value: Readonly<Record<string, unknown>>,
  expectedVersion: RelayProtocolVersion | undefined,
): RelayCodecResult<RelayProtocolVersion> {
  const decoded = Schema.decodeUnknownExit(RelayProtocolVersion)({
    protocolMajor: value.protocolMajor,
    protocolMinor: value.protocolMinor,
  });
  if (Exit.isFailure(decoded)) {
    return failure("invalid_frame");
  }
  if (decoded.value.protocolMajor !== RELAY_PROTOCOL_MAJOR) {
    return failure("protocol_unsupported", RELAY_SUPPORTED_VERSION_RANGE);
  }
  if (
    expectedVersion !== undefined &&
    (decoded.value.protocolMajor !== expectedVersion.protocolMajor ||
      decoded.value.protocolMinor !== expectedVersion.protocolMinor)
  ) {
    return failure("invalid_frame");
  }
  return success(decoded.value);
}

export function negotiateRelayVersion(peer: unknown): RelayCodecResult<RelayProtocolVersion> {
  const decoded = Schema.decodeUnknownExit(RelayProtocolVersion)(peer);
  if (Exit.isFailure(decoded)) {
    return failure("invalid_frame");
  }
  if (decoded.value.protocolMajor !== RELAY_PROTOCOL_MAJOR) {
    return failure("protocol_unsupported", RELAY_SUPPORTED_VERSION_RANGE);
  }
  const protocolMinor = Math.min(decoded.value.protocolMinor, RELAY_PROTOCOL_MINOR);
  if (protocolMinor < RELAY_PROTOCOL_MINIMUM_MINOR) {
    return failure("protocol_unsupported", RELAY_SUPPORTED_VERSION_RANGE);
  }
  return success({ protocolMajor: RELAY_PROTOCOL_MAJOR, protocolMinor });
}

export function decodeRelayFrame(
  bytes: Uint8Array,
  options: DecodeRelayFrameOptions = {},
): RelayCodecResult<RelayFrame> {
  if (bytes.byteLength > RELAY_MAX_DATA_FRAME_BYTES) {
    return failure("frame_too_large");
  }

  const canonical = decodeCanonicalValue(bytes);
  if (!canonical.ok) {
    return canonical;
  }
  const value = canonical.value;

  if (value.type !== "data" && bytes.byteLength > RELAY_MAX_CONTROL_FRAME_BYTES) {
    return failure("frame_too_large");
  }
  if (
    value.type === "data" &&
    value.payload instanceof Uint8Array &&
    value.payload.byteLength > RELAY_MAX_DATA_CHUNK_BYTES
  ) {
    return failure("frame_too_large");
  }

  const version = validateEnvelopeVersion(value, options.expectedVersion);
  if (!version.ok) {
    return version;
  }

  if (!("type" in value)) {
    return failure("missing_discriminant");
  }
  if (typeof value.type !== "string") {
    return failure("invalid_frame");
  }
  if (!frameTypes.has(value.type)) {
    return failure("unknown_frame_type");
  }

  const decoded = Schema.decodeUnknownExit(RelayFrame)(value);
  if (Exit.isFailure(decoded)) {
    return failure(value.type === "ready" ? "invalid_limits" : "invalid_frame");
  }
  return success(decoded.value);
}

export function encodeRelayFrame(input: unknown): RelayCodecResult<Uint8Array> {
  if (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    (input as { readonly type?: unknown }).type === "data" &&
    "payload" in input &&
    (input as { readonly payload?: unknown }).payload instanceof Uint8Array &&
    (input as { readonly payload: Uint8Array }).payload.byteLength > RELAY_MAX_DATA_CHUNK_BYTES
  ) {
    return failure("frame_too_large");
  }
  const decoded = Schema.decodeUnknownExit(RelayFrame)(input);
  if (Exit.isFailure(decoded)) {
    const type =
      typeof input === "object" && input !== null && "type" in input
        ? (input as { readonly type?: unknown }).type
        : undefined;
    return failure(type === "ready" ? "invalid_limits" : "invalid_frame");
  }
  if (decoded.value.protocolMajor !== RELAY_PROTOCOL_MAJOR) {
    return failure("protocol_unsupported", RELAY_SUPPORTED_VERSION_RANGE);
  }

  let bytes: Uint8Array;
  try {
    bytes = encode(decoded.value, rfc8949EncodeOptions);
  } catch {
    return failure("invalid_frame");
  }
  const maximumBytes =
    decoded.value.type === "data" ? RELAY_MAX_DATA_FRAME_BYTES : RELAY_MAX_CONTROL_FRAME_BYTES;
  return bytes.byteLength <= maximumBytes ? success(bytes) : failure("frame_too_large");
}

export function makeProtocolUnsupportedErrorFrame() {
  return RelayFrame.make({
    type: "error",
    protocolMajor: RELAY_PROTOCOL_MAJOR,
    protocolMinor: RELAY_PROTOCOL_MINOR,
    code: "protocol_unsupported",
    fatal: true,
    supported: RELAY_SUPPORTED_VERSION_RANGE,
  });
}
