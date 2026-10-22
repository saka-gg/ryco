import * as Schema from "effect/Schema";

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

export const RELAY_CLOSE_REASONS = [
  "authentication_required",
  "authentication_failed",
  "ticket_expired",
  "ticket_consumed",
  "node_offline",
  "node_revoked",
  "grant_revoked",
  "protocol_unsupported",
  "frame_too_large",
  "slow_consumer",
  "rate_limited",
  "server_draining",
  "internal_error",
  "authentication_timeout",
  "authorization_failed",
  "channel_rejected",
  "connection_replaced",
  "transfer_limit",
  "revoked",
] as const;

export const RELAY_MINOR_2_CLOSE_REASONS = [
  "authentication_timeout",
  "authorization_failed",
  "channel_rejected",
  "connection_replaced",
  "transfer_limit",
  "revoked",
] as const;

export const RELAY_FRAME_TYPES = [
  "auth",
  "ready",
  "channel.open",
  "channel.accept",
  "channel.reject",
  "data",
  "flow.pause",
  "flow.resume",
  "channel.close",
  "ping",
  "pong",
  "error",
  "node.e2ee.statement",
  "node.e2ee.statement.ack",
  "e2ee.verifier-keys",
  "e2ee.enrollment-revoked",
] as const;

export const RELAY_PROTOCOL_ERROR_CODES = [
  "invalid_encoding",
  "invalid_frame",
  "invalid_limits",
  "missing_discriminant",
  "unknown_frame_type",
  ...RELAY_CLOSE_REASONS,
] as const;

const UInt16 = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(0xffff),
);
const UInt32 = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(0xffff_ffff),
);
const RetryAfterMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(RELAY_MAX_RETRY_AFTER_MS),
);

const ProtocolFields = {
  protocolMajor: UInt16,
  protocolMinor: UInt16,
} as const;

const boundedBytes = (minimum: number, maximum: number) =>
  Schema.Uint8Array.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));

export const RelayProtocolVersion = Schema.Struct(ProtocolFields);
export type RelayProtocolVersion = typeof RelayProtocolVersion.Type;

export const RelayFrameType = Schema.Literals(RELAY_FRAME_TYPES);
export type RelayFrameType = typeof RelayFrameType.Type;

export const RelayCloseReason = Schema.Literals(RELAY_CLOSE_REASONS);
export type RelayCloseReason = typeof RelayCloseReason.Type;

export const RelayCapability = Schema.Literal("ryco.rpc");
export type RelayCapability = typeof RelayCapability.Type;

export const RelayEffectiveRole = Schema.Literals(["viewer", "operator", "owner"]);
export type RelayEffectiveRole = typeof RelayEffectiveRole.Type;

export const RelayProtocolErrorCode = Schema.Literals(RELAY_PROTOCOL_ERROR_CODES);
export type RelayProtocolErrorCode = typeof RelayProtocolErrorCode.Type;

export const RelayNodeId = Schema.String.check(
  Schema.isPattern(/^node_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
).pipe(Schema.brand("RelayNodeId"));
export type RelayNodeId = typeof RelayNodeId.Type;

export const RelayChannelId = Schema.String.check(
  Schema.isPattern(/^ch_[A-Za-z0-9_-]{22}$/),
  Schema.isMaxLength(25),
).pipe(Schema.brand("RelayChannelId"));
export type RelayChannelId = typeof RelayChannelId.Type;

export const NativeE2eeEnrollmentId = Schema.String.check(
  Schema.isPattern(/^enr_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(47),
).pipe(Schema.brand("NativeE2eeEnrollmentId"));
export type NativeE2eeEnrollmentId = typeof NativeE2eeEnrollmentId.Type;

export const HubGrantVerificationKeyId = Schema.String.check(
  Schema.isPattern(/^hgk_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(47),
).pipe(Schema.brand("HubGrantVerificationKeyId"));
export type HubGrantVerificationKeyId = typeof HubGrantVerificationKeyId.Type;

export const RelayTicketId = Schema.String.check(
  Schema.isPattern(/^rtk_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(47),
).pipe(Schema.brand("RelayTicketId"));
export type RelayTicketId = typeof RelayTicketId.Type;

export const NativeE2eeEnrollmentRevision = UInt32.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("NativeE2eeEnrollmentRevision"),
);
export type NativeE2eeEnrollmentRevision = typeof NativeE2eeEnrollmentRevision.Type;

export const E2eeAuthorizationEpoch = UInt32.pipe(Schema.brand("E2eeAuthorizationEpoch"));
export type E2eeAuthorizationEpoch = typeof E2eeAuthorizationEpoch.Type;

export const E2eeKeysetGeneration = UInt32.pipe(Schema.brand("E2eeKeysetGeneration"));
export type E2eeKeysetGeneration = typeof E2eeKeysetGeneration.Type;

export const RelayConnectorGeneration = UInt32.pipe(Schema.brand("RelayConnectorGeneration"));
export type RelayConnectorGeneration = typeof RelayConnectorGeneration.Type;

export const RelaySequence = UInt32.pipe(Schema.brand("RelaySequence"));
export type RelaySequence = typeof RelaySequence.Type;

export const RelayHeartbeatNonce = boundedBytes(8, 8);
export type RelayHeartbeatNonce = typeof RelayHeartbeatNonce.Type;

export const RelayAuthenticationNonce = boundedBytes(32, 32);
export type RelayAuthenticationNonce = typeof RelayAuthenticationNonce.Type;

export const RelaySignatureMaterial = boundedBytes(64, 512);
export type RelaySignatureMaterial = typeof RelaySignatureMaterial.Type;

export const RelayTicketMaterial = boundedBytes(32, 64);
export type RelayTicketMaterial = typeof RelayTicketMaterial.Type;

export const RelayE2eeDigest = boundedBytes(32, 32).pipe(Schema.brand("RelayE2eeDigest"));
export type RelayE2eeDigest = typeof RelayE2eeDigest.Type;

export const RelayAccountGrantContext = Schema.Tuple([
  Schema.Literal(2),
  RelayTicketId,
  RelayE2eeDigest,
  RelayE2eeDigest,
]);
export type RelayAccountGrantContext = typeof RelayAccountGrantContext.Type;

export const RelayLimits = Schema.Struct({
  maxControlFrameBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RELAY_MIN_CONTROL_FRAME_BYTES),
    Schema.isLessThanOrEqualTo(RELAY_MAX_CONTROL_FRAME_BYTES),
  ),
  maxDataChunkBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RELAY_MIN_DATA_CHUNK_BYTES),
    Schema.isLessThanOrEqualTo(RELAY_MAX_DATA_CHUNK_BYTES),
  ),
  maxQueuedBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RELAY_MIN_QUEUED_BYTES),
    Schema.isLessThanOrEqualTo(RELAY_MAX_QUEUED_BYTES),
  ),
  maxChannels: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RELAY_MIN_CHANNELS),
    Schema.isLessThanOrEqualTo(RELAY_MAX_CHANNELS),
  ),
  heartbeatIntervalMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RELAY_MIN_HEARTBEAT_INTERVAL_MS),
    Schema.isLessThanOrEqualTo(RELAY_HEARTBEAT_INTERVAL_MS),
  ),
  deadConnectionTimeoutMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RELAY_MIN_DEAD_CONNECTION_TIMEOUT_MS),
    Schema.isLessThanOrEqualTo(RELAY_DEAD_CONNECTION_TIMEOUT_MS),
  ),
  authenticationDeadlineMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RELAY_MIN_AUTHENTICATION_DEADLINE_MS),
    Schema.isLessThanOrEqualTo(RELAY_AUTHENTICATION_DEADLINE_MS),
  ),
}).check(
  Schema.makeFilter((limits) => {
    const requiredQueuedBytes = Math.max(
      limits.maxControlFrameBytes,
      limits.maxDataChunkBytes + RELAY_MAX_DATA_FRAME_OVERHEAD_BYTES,
    );
    if (limits.maxQueuedBytes < requiredQueuedBytes) {
      return "maxQueuedBytes must hold one maximum encoded frame";
    }
    if (limits.deadConnectionTimeoutMs < limits.heartbeatIntervalMs * 2) {
      return "deadConnectionTimeoutMs must be at least twice heartbeatIntervalMs";
    }
  }),
);
export type RelayLimits = typeof RelayLimits.Type;

export const RELAY_INITIAL_LIMITS = RelayLimits.make({
  maxControlFrameBytes: RELAY_MAX_CONTROL_FRAME_BYTES,
  maxDataChunkBytes: RELAY_MAX_DATA_CHUNK_BYTES,
  maxQueuedBytes: RELAY_MAX_QUEUED_BYTES,
  maxChannels: RELAY_MAX_CHANNELS,
  heartbeatIntervalMs: RELAY_HEARTBEAT_INTERVAL_MS,
  deadConnectionTimeoutMs: RELAY_DEAD_CONNECTION_TIMEOUT_MS,
  authenticationDeadlineMs: RELAY_AUTHENTICATION_DEADLINE_MS,
});

const minorVersionSupportsRetryAfter = (input: {
  readonly protocolMinor: number;
  readonly retryAfterMs?: number | undefined;
}) =>
  input.retryAfterMs === undefined || input.protocolMinor >= 1
    ? undefined
    : "retryAfterMs requires protocol minor version 1 or newer";

const minor2CloseReasons = new Set<string>(RELAY_MINOR_2_CLOSE_REASONS);

const minorVersionSupportsCloseReason = (
  protocolMinor: number,
  reason: RelayProtocolErrorCode | RelayCloseReason | undefined,
) =>
  reason === undefined || !minor2CloseReasons.has(reason) || protocolMinor >= 2
    ? undefined
    : "close reason requires protocol minor version 2 or newer";

const minorVersionSupportsAuthorizedChannel = (input: {
  readonly protocolMinor: number;
  readonly capability?: RelayCapability | undefined;
  readonly effectiveRole?: RelayEffectiveRole | undefined;
  readonly accountGrantContext?: RelayAccountGrantContext | undefined;
}) => {
  const hasCapability = input.capability !== undefined;
  const hasEffectiveRole = input.effectiveRole !== undefined;
  if (input.accountGrantContext !== undefined && input.protocolMinor < RELAY_ACCOUNT_GRANT_MINOR) {
    return "account grant context requires protocol minor version 3 or newer";
  }
  if (input.protocolMinor >= RELAY_AUTHORIZED_CHANNEL_MINOR) {
    if (!hasCapability || !hasEffectiveRole) {
      return "protocol minor version 2 or newer requires channel authorization metadata";
    }
    return undefined;
  }
  return !hasCapability && !hasEffectiveRole
    ? undefined
    : "channel authorization metadata requires protocol minor version 2 or newer";
};

/**
 * The node's software version, for the Hub's record of the node. Display metadata only: it is not
 * part of the signed transcript and grants nothing. Hubs that predate the field ignore it.
 */
export const RelayNodeClientVersion = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isTrimmed(),
);

export const RelayNodeAuthHandshake = Schema.Struct({
  type: Schema.Literal("auth"),
  peer: Schema.Literal("node"),
  ...ProtocolFields,
  nodeId: RelayNodeId,
  nonce: RelayAuthenticationNonce,
  signature: RelaySignatureMaterial,
  clientVersion: Schema.optionalKey(RelayNodeClientVersion),
});
export type RelayNodeAuthHandshake = typeof RelayNodeAuthHandshake.Type;

export const RelayClientAuthHandshake = Schema.Struct({
  type: Schema.Literal("auth"),
  peer: Schema.Literal("client"),
  ...ProtocolFields,
  relayTicket: RelayTicketMaterial,
});
export type RelayClientAuthHandshake = typeof RelayClientAuthHandshake.Type;

export const RelayAuthHandshake = Schema.Union([RelayNodeAuthHandshake, RelayClientAuthHandshake]);
export type RelayAuthHandshake = typeof RelayAuthHandshake.Type;

export const RelayReadyFrame = Schema.Struct({
  type: Schema.Literal("ready"),
  ...ProtocolFields,
  limits: RelayLimits,
});
export type RelayReadyFrame = typeof RelayReadyFrame.Type;

export const RelayChannelOpenFrame = Schema.Struct({
  type: Schema.Literal("channel.open"),
  ...ProtocolFields,
  channelId: RelayChannelId,
  capability: Schema.optionalKey(RelayCapability),
  effectiveRole: Schema.optionalKey(RelayEffectiveRole),
  accountGrantContext: Schema.optionalKey(RelayAccountGrantContext),
}).check(Schema.makeFilter(minorVersionSupportsAuthorizedChannel));
export type RelayChannelOpenFrame = typeof RelayChannelOpenFrame.Type;

const minor3Frame = <S extends Schema.Struct.Fields>(fields: S) =>
  Schema.Struct({ ...fields, ...ProtocolFields }).check(
    Schema.makeFilter((frame) =>
      (frame as { readonly protocolMinor: number }).protocolMinor >= RELAY_ACCOUNT_GRANT_MINOR
        ? undefined
        : "frame requires protocol minor version 3 or newer",
    ),
  );

export const RelayNodeE2eeStatementFrame = minor3Frame({
  type: Schema.Literal("node.e2ee.statement"),
  connectorGeneration: RelayConnectorGeneration,
  statement: boundedBytes(1, RELAY_E2EE_CAPABILITY_STATEMENT_MAX_BYTES),
  statementDigest: RelayE2eeDigest,
  expiresAt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
});
export type RelayNodeE2eeStatementFrame = typeof RelayNodeE2eeStatementFrame.Type;

export const RelayNodeE2eeStatementAckFrame = minor3Frame({
  type: Schema.Literal("node.e2ee.statement.ack"),
  connectorGeneration: RelayConnectorGeneration,
  statementDigest: RelayE2eeDigest,
});
export type RelayNodeE2eeStatementAckFrame = typeof RelayNodeE2eeStatementAckFrame.Type;

export const RelayHubGrantVerificationKey = Schema.Struct({
  keyId: HubGrantVerificationKeyId,
  publicKey: boundedBytes(32, 32),
  notBefore: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  notAfter: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
}).check(
  Schema.makeFilter((key) =>
    key.notAfter > key.notBefore ? undefined : "notAfter must be after notBefore",
  ),
);
export type RelayHubGrantVerificationKey = typeof RelayHubGrantVerificationKey.Type;

export const RelayE2eeVerifierKeysFrame = minor3Frame({
  type: Schema.Literal("e2ee.verifier-keys"),
  generation: E2eeKeysetGeneration,
  keys: Schema.Array(RelayHubGrantVerificationKey).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(RELAY_E2EE_GRANT_KEYSET_MAX_KEYS),
    Schema.makeFilter((keys) =>
      new Set(keys.map((key) => key.keyId)).size === keys.length
        ? undefined
        : "grant verification key ids must be distinct",
    ),
  ),
});
export type RelayE2eeVerifierKeysFrame = typeof RelayE2eeVerifierKeysFrame.Type;

export const RelayE2eeEnrollmentRevokedFrame = minor3Frame({
  type: Schema.Literal("e2ee.enrollment-revoked"),
  enrollmentId: NativeE2eeEnrollmentId,
  enrollmentRevision: NativeE2eeEnrollmentRevision,
  accountAuthEpoch: E2eeAuthorizationEpoch,
  deviceAuthEpoch: E2eeAuthorizationEpoch,
});
export type RelayE2eeEnrollmentRevokedFrame = typeof RelayE2eeEnrollmentRevokedFrame.Type;

export const RelayChannelAcceptFrame = Schema.Struct({
  type: Schema.Literal("channel.accept"),
  ...ProtocolFields,
  channelId: RelayChannelId,
});
export type RelayChannelAcceptFrame = typeof RelayChannelAcceptFrame.Type;

export const RelayChannelRejectFrame = Schema.Struct({
  type: Schema.Literal("channel.reject"),
  ...ProtocolFields,
  channelId: RelayChannelId,
  reason: RelayCloseReason,
  retryAfterMs: Schema.optionalKey(RetryAfterMs),
}).check(
  Schema.makeFilter(
    (input) =>
      minorVersionSupportsRetryAfter(input) ??
      minorVersionSupportsCloseReason(input.protocolMinor, input.reason),
  ),
);
export type RelayChannelRejectFrame = typeof RelayChannelRejectFrame.Type;

export const RelayDataFrame = Schema.Struct({
  type: Schema.Literal("data"),
  ...ProtocolFields,
  channelId: RelayChannelId,
  sequence: RelaySequence,
  payload: boundedBytes(0, RELAY_MAX_DATA_CHUNK_BYTES),
});
export type RelayDataFrame = typeof RelayDataFrame.Type;

export const RelayFlowPauseFrame = Schema.Struct({
  type: Schema.Literal("flow.pause"),
  ...ProtocolFields,
  channelId: RelayChannelId,
});
export type RelayFlowPauseFrame = typeof RelayFlowPauseFrame.Type;

export const RelayFlowResumeFrame = Schema.Struct({
  type: Schema.Literal("flow.resume"),
  ...ProtocolFields,
  channelId: RelayChannelId,
});
export type RelayFlowResumeFrame = typeof RelayFlowResumeFrame.Type;

export const RelayChannelCloseFrame = Schema.Struct({
  type: Schema.Literal("channel.close"),
  ...ProtocolFields,
  channelId: RelayChannelId,
  reason: Schema.optionalKey(RelayCloseReason),
}).check(
  Schema.makeFilter((input) => minorVersionSupportsCloseReason(input.protocolMinor, input.reason)),
);
export type RelayChannelCloseFrame = typeof RelayChannelCloseFrame.Type;

export const RelayPingFrame = Schema.Struct({
  type: Schema.Literal("ping"),
  ...ProtocolFields,
  nonce: RelayHeartbeatNonce,
});
export type RelayPingFrame = typeof RelayPingFrame.Type;

export const RelayPongFrame = Schema.Struct({
  type: Schema.Literal("pong"),
  ...ProtocolFields,
  nonce: RelayHeartbeatNonce,
});
export type RelayPongFrame = typeof RelayPongFrame.Type;

export const RelaySupportedVersionRange = Schema.Struct({
  protocolMajor: UInt16,
  minimumMinor: UInt16,
  maximumMinor: UInt16,
}).check(
  Schema.makeFilter((range) =>
    range.minimumMinor <= range.maximumMinor
      ? undefined
      : "minimumMinor must be less than or equal to maximumMinor",
  ),
);
export type RelaySupportedVersionRange = typeof RelaySupportedVersionRange.Type;

export const RELAY_SUPPORTED_VERSION_RANGE = RelaySupportedVersionRange.make({
  protocolMajor: RELAY_PROTOCOL_MAJOR,
  minimumMinor: RELAY_PROTOCOL_MINIMUM_MINOR,
  maximumMinor: RELAY_PROTOCOL_MINOR,
});

export const RelayErrorFrame = Schema.Struct({
  type: Schema.Literal("error"),
  ...ProtocolFields,
  code: RelayProtocolErrorCode,
  fatal: Schema.Boolean,
  supported: Schema.optionalKey(RelaySupportedVersionRange),
  retryAfterMs: Schema.optionalKey(RetryAfterMs),
}).check(
  Schema.makeFilter((input) => {
    const retryAfterIssue = minorVersionSupportsRetryAfter(input);
    if (retryAfterIssue !== undefined) {
      return retryAfterIssue;
    }
    const closeReasonIssue = minorVersionSupportsCloseReason(input.protocolMinor, input.code);
    if (closeReasonIssue !== undefined) {
      return closeReasonIssue;
    }
    if (input.code === "protocol_unsupported") {
      if (!input.fatal) {
        return "protocol_unsupported errors must be fatal";
      }
      if (input.supported === undefined) {
        return "protocol_unsupported errors must include the supported version range";
      }
    }
  }),
);
export type RelayErrorFrame = typeof RelayErrorFrame.Type;

export const RelayControlFrame = Schema.Union([
  RelayNodeAuthHandshake,
  RelayClientAuthHandshake,
  RelayReadyFrame,
  RelayChannelOpenFrame,
  RelayChannelAcceptFrame,
  RelayChannelRejectFrame,
  RelayFlowPauseFrame,
  RelayFlowResumeFrame,
  RelayChannelCloseFrame,
  RelayPingFrame,
  RelayPongFrame,
  RelayErrorFrame,
  RelayNodeE2eeStatementFrame,
  RelayNodeE2eeStatementAckFrame,
  RelayE2eeVerifierKeysFrame,
  RelayE2eeEnrollmentRevokedFrame,
]);
export type RelayControlFrame = typeof RelayControlFrame.Type;

export const RelayFrame = Schema.Union([RelayControlFrame, RelayDataFrame]);
export type RelayFrame = typeof RelayFrame.Type;
