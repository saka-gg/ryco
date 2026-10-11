import { Schema } from "effect";

import { rejectExcessProperties } from "./baseSchemas.ts";
import { HubAccountId } from "./hostedIdentity.ts";
import {
  E2eeAuthorizationEpoch,
  E2eeKeysetGeneration,
  HubGrantVerificationKeyId,
  NativeE2eeEnrollmentId,
  NativeE2eeEnrollmentRevision,
  RelayCapability,
  RELAY_E2EE_CAPABILITY_STATEMENT_MAX_BYTES,
  RELAY_E2EE_GRANT_KEYSET_MAX_KEYS,
  RelayEffectiveRole,
  RelayNodeId,
  RelayTicketId,
} from "./relay.ts";

export {
  E2eeAuthorizationEpoch,
  E2eeKeysetGeneration,
  HubGrantVerificationKeyId,
  NativeE2eeEnrollmentId,
  NativeE2eeEnrollmentRevision,
  RelayTicketId,
} from "./relay.ts";

export const NATIVE_E2EE_PROTOCOL_VERSION = 1 as const;
export const NATIVE_E2EE_CURRENT_DEVICE_PATH = "/api/native/e2ee/devices/current" as const;
export const NATIVE_E2EE_GRANT_KEYS_PATH = "/api/native/e2ee/grant-keys" as const;
export const NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH =
  "/api/native/relay/tickets/account-grant" as const;
export const ACCOUNT_E2EE_DEVICES_PATH = "/api/account/e2ee/devices" as const;
export const ACCOUNT_E2EE_DEVICE_PATH_PREFIX = "/api/account/e2ee/devices" as const;

export const NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS = 100;
export const NATIVE_E2EE_APP_VERSION_MAX_CHARS = 64;
export const NATIVE_E2EE_MAX_ACCOUNT_DEVICES = 128;
export const NATIVE_E2EE_MAX_GRANT_KEYS = RELAY_E2EE_GRANT_KEYSET_MAX_KEYS;
export const NATIVE_E2EE_MAX_CAPABILITIES = 32;
export const HUB_DEVICE_GRANT_MAX_BYTES = 2_048;
export const HUB_DEVICE_GRANT_BASE64URL_MAX_CHARS = 2_731;
export const HUB_DEVICE_GRANT_MAX_VALIDITY_MS = 120_000;
export const CLIENT_PREKEY_CERTIFICATE_MAX_BYTES = 1_094;
export const CLIENT_PREKEY_CERTIFICATE_BASE64URL_MAX_CHARS = 1_459;
export const NODE_E2EE_CAPABILITY_STATEMENT_MAX_BYTES = RELAY_E2EE_CAPABILITY_STATEMENT_MAX_BYTES;
export const NODE_E2EE_CAPABILITY_STATEMENT_BASE64URL_MAX_CHARS = 6_920;

const UInt32 = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(0xffff_ffff),
);
const EpochMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ExactBytes = (length: number) =>
  Schema.Uint8Array.check(Schema.isMinLength(length), Schema.isMaxLength(length));
const Base64Url = (minimum: number, maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(minimum),
    Schema.isMaxLength(maximum),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    Schema.makeFilter((value) =>
      value.length % 4 === 1 ? "invalid unpadded base64url length" : undefined,
    ),
  );
const Base64Url32 = Base64Url(43, 43);
const Base64UrlP256 = Base64Url(87, 87);

export const HubDeviceGrantId = Schema.String.check(
  Schema.isPattern(/^hgr_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(47),
).pipe(Schema.brand("HubDeviceGrantId"));
export type HubDeviceGrantId = typeof HubDeviceGrantId.Type;

export const NodeE2eeContinuityId = Schema.String.check(
  Schema.isPattern(/^nct_[A-Za-z0-9_-]{22}$/),
  Schema.isMaxLength(26),
).pipe(Schema.brand("NodeE2eeContinuityId"));
export type NodeE2eeContinuityId = typeof NodeE2eeContinuityId.Type;

export const NativeE2eePlatform = Schema.Literals(["darwin", "linux", "windows", "ios", "android"]);
export type NativeE2eePlatform = typeof NativeE2eePlatform.Type;

export const NativeE2eeReportedKeyBacking = Schema.Literals([
  "secure-enclave",
  "strongbox",
  "tee",
  "tpm",
  "hardware-backed",
  "unavailable",
]);
export type NativeE2eeReportedKeyBacking = typeof NativeE2eeReportedKeyBacking.Type;

export const NativeE2eeUsableKeyBacking = Schema.Literals([
  "secure-enclave",
  "strongbox",
  "tee",
  "tpm",
  "hardware-backed",
]);
export type NativeE2eeUsableKeyBacking = typeof NativeE2eeUsableKeyBacking.Type;

export const NativeE2eeEnrollmentStatus = Schema.Literals(["active", "revoked", "superseded"]);
export type NativeE2eeEnrollmentStatus = typeof NativeE2eeEnrollmentStatus.Type;

export const NativeE2eeTrustSource = Schema.Literals([
  "locally-verified",
  "account-enrolled",
  "web-unsigned",
]);
export type NativeE2eeTrustSource = typeof NativeE2eeTrustSource.Type;

export const NodeE2eeAdmissionPolicy = Schema.Literals([
  "compatibility",
  "require-e2ee",
  "require-native-e2ee",
  "require-locally-approved-native-e2ee",
]);
export type NodeE2eeAdmissionPolicy = typeof NodeE2eeAdmissionPolicy.Type;

export const HubDeviceGrantEnvelope = Base64Url(1, HUB_DEVICE_GRANT_BASE64URL_MAX_CHARS).pipe(
  Schema.brand("HubDeviceGrantEnvelope"),
);
export type HubDeviceGrantEnvelope = typeof HubDeviceGrantEnvelope.Type;

export const E2eeDigestBase64Url = Base64Url32.pipe(Schema.brand("E2eeDigestBase64Url"));
export type E2eeDigestBase64Url = typeof E2eeDigestBase64Url.Type;

const BoundedCapabilities = Schema.Array(RelayCapability).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(NATIVE_E2EE_MAX_CAPABILITIES),
  Schema.makeFilter((values) =>
    new Set(values).size === values.length ? undefined : "capabilities must be distinct",
  ),
);

const HubOrigin = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^https?:\/\/[^\s/]+$/),
);
const DeviceLabel = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS),
);
const AppVersion = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(NATIVE_E2EE_APP_VERSION_MAX_CHARS),
);
const IdempotencyKey = Base64Url32.pipe(Schema.brand("NativeE2eeIdempotencyKey"));
const ReasonCode = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_]*$/),
);

export const HubDeviceGrantClaims = rejectExcessProperties(
  Schema.Struct({
    version: Schema.Literal(1),
    suiteId: Schema.Literal(2),
    issuerHubOrigin: HubOrigin,
    keyId: HubGrantVerificationKeyId,
    grantId: HubDeviceGrantId,
    accountId: HubAccountId,
    accountAuthEpoch: E2eeAuthorizationEpoch,
    enrollmentId: NativeE2eeEnrollmentId,
    enrollmentRevision: NativeE2eeEnrollmentRevision,
    deviceAuthEpoch: E2eeAuthorizationEpoch,
    deviceIdentityAlgorithm: Schema.Literal("p256"),
    deviceIdentityPublicKey: ExactBytes(65),
    deviceIdentityFingerprint: ExactBytes(32),
    deviceAgreementAlgorithm: Schema.Literal("x25519"),
    deviceAgreementPublicKey: ExactBytes(32),
    deviceAgreementFingerprint: ExactBytes(32),
    clientPrekeyCertificateDigest: ExactBytes(32),
    nodeId: RelayNodeId,
    nodeIdentityAlgorithm: Schema.Literal("ed25519"),
    nodeIdentityPublicKey: ExactBytes(32),
    nodeIdentityFingerprint: ExactBytes(32),
    nodeAgreementAlgorithm: Schema.Literal("x25519"),
    nodeAgreementPublicKey: ExactBytes(32),
    nodeAgreementFingerprint: ExactBytes(32),
    nodeContinuityId: NodeE2eeContinuityId,
    nodePolicyGeneration: UInt32,
    nodeCapabilityStatementDigest: ExactBytes(32),
    relayTicketId: RelayTicketId,
    maximumRole: RelayEffectiveRole,
    capabilities: BoundedCapabilities,
    issuedAt: EpochMs,
    notBefore: EpochMs,
    expiresAt: EpochMs,
    nonce: ExactBytes(32),
  }).check(
    Schema.makeFilter((claims) =>
      claims.notBefore <= claims.issuedAt &&
      claims.issuedAt < claims.expiresAt &&
      claims.expiresAt - claims.issuedAt <= HUB_DEVICE_GRANT_MAX_VALIDITY_MS
        ? undefined
        : "invalid grant validity interval",
    ),
  ),
);
export type HubDeviceGrantClaims = typeof HubDeviceGrantClaims.Type;

export const NativeE2eeEnrollmentUpsertRequest = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    hubOrigin: HubOrigin,
    accountId: HubAccountId,
    enrollmentId: NativeE2eeEnrollmentId,
    expectedEnrollmentRevision: Schema.optionalKey(UInt32),
    identityPublicKey: Base64UrlP256,
    identityFingerprint: Base64Url32,
    agreementPublicKey: Base64Url32,
    agreementFingerprint: Base64Url32,
    clientPrekeyCertificate: Base64Url(1, CLIENT_PREKEY_CERTIFICATE_BASE64URL_MAX_CHARS),
    clientPrekeyCertificateDigest: Base64Url32,
    certificateExpiresAt: EpochMs,
    platform: NativeE2eePlatform,
    appVersion: AppVersion,
    reportedKeyBacking: NativeE2eeUsableKeyBacking,
    deviceLabel: DeviceLabel,
    requestedMaximumRole: RelayEffectiveRole,
    requestedCapabilities: BoundedCapabilities,
    enrollmentNonce: Base64Url32,
    idempotencyKey: IdempotencyKey,
  }),
);
export type NativeE2eeEnrollmentUpsertRequest = typeof NativeE2eeEnrollmentUpsertRequest.Type;

export const AccountE2eeDeviceSummary = rejectExcessProperties(
  Schema.Struct({
    enrollmentId: NativeE2eeEnrollmentId,
    enrollmentRevision: NativeE2eeEnrollmentRevision,
    accountAuthEpoch: E2eeAuthorizationEpoch,
    deviceAuthEpoch: E2eeAuthorizationEpoch,
    platform: NativeE2eePlatform,
    appVersion: AppVersion,
    reportedKeyBacking: NativeE2eeReportedKeyBacking,
    deviceLabel: DeviceLabel,
    identityFingerprint: Base64Url32,
    agreementFingerprint: Base64Url32,
    clientPrekeyCertificateDigest: Base64Url32,
    certificateExpiresAt: EpochMs,
    status: NativeE2eeEnrollmentStatus,
    createdAt: EpochMs,
    updatedAt: EpochMs,
    lastUsedAt: Schema.NullOr(EpochMs),
    revokedAt: Schema.NullOr(EpochMs),
  }).check(
    Schema.makeFilter((device) => {
      if (device.updatedAt < device.createdAt) return "updatedAt must not precede createdAt";
      if (device.lastUsedAt !== null && device.lastUsedAt < device.createdAt) {
        return "lastUsedAt must not precede createdAt";
      }
      if (device.revokedAt !== null && device.revokedAt < device.createdAt) {
        return "revokedAt must not precede createdAt";
      }
      if (device.status === "active" && device.revokedAt !== null) {
        return "active enrollment cannot have revokedAt";
      }
      if (device.status !== "active" && device.revokedAt === null) {
        return "inactive enrollment requires revokedAt";
      }
      return undefined;
    }),
  ),
);
export type AccountE2eeDeviceSummary = typeof AccountE2eeDeviceSummary.Type;

export const NativeE2eeEnrollmentUpsertResponse = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    enrollment: AccountE2eeDeviceSummary,
  }),
);
export type NativeE2eeEnrollmentUpsertResponse = typeof NativeE2eeEnrollmentUpsertResponse.Type;

export const AccountE2eeDeviceListResponse = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    devices: Schema.Array(AccountE2eeDeviceSummary).check(
      Schema.isMaxLength(NATIVE_E2EE_MAX_ACCOUNT_DEVICES),
      Schema.makeFilter((devices) =>
        new Set(devices.map((device) => `${device.enrollmentId}:${device.enrollmentRevision}`))
          .size === devices.length
          ? undefined
          : "device enrollment revisions must be distinct",
      ),
    ),
  }),
);
export type AccountE2eeDeviceListResponse = typeof AccountE2eeDeviceListResponse.Type;

export const AccountE2eeDeviceRenameRequest = rejectExcessProperties(
  Schema.Struct({
    expectedEnrollmentRevision: NativeE2eeEnrollmentRevision,
    deviceLabel: DeviceLabel,
  }),
);
export type AccountE2eeDeviceRenameRequest = typeof AccountE2eeDeviceRenameRequest.Type;

export const AccountE2eeDeviceRevokeRequest = rejectExcessProperties(
  Schema.Struct({
    expectedEnrollmentRevision: NativeE2eeEnrollmentRevision,
    reasonCode: ReasonCode,
  }),
);
export type AccountE2eeDeviceRevokeRequest = typeof AccountE2eeDeviceRevokeRequest.Type;

export const AccountE2eeDeviceMutationResponse = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    enrollment: AccountE2eeDeviceSummary,
  }),
);
export type AccountE2eeDeviceMutationResponse = typeof AccountE2eeDeviceMutationResponse.Type;

export const HubGrantVerificationKey = rejectExcessProperties(
  Schema.Struct({
    keyId: HubGrantVerificationKeyId,
    publicKey: Base64Url32,
    notBefore: EpochMs,
    notAfter: EpochMs,
  }).check(
    Schema.makeFilter((key) =>
      key.notAfter > key.notBefore ? undefined : "notAfter must be after notBefore",
    ),
  ),
);
export type HubGrantVerificationKey = typeof HubGrantVerificationKey.Type;

const HubGrantVerificationKeys = Schema.Array(HubGrantVerificationKey).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(NATIVE_E2EE_MAX_GRANT_KEYS),
  Schema.makeFilter((keys) =>
    new Set(keys.map((key) => key.keyId)).size === keys.length
      ? undefined
      : "grant verification key ids must be distinct",
  ),
);

export const HubGrantVerificationKeysetResponse = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    generation: E2eeKeysetGeneration,
    keys: HubGrantVerificationKeys,
  }),
);
export type HubGrantVerificationKeysetResponse = typeof HubGrantVerificationKeysetResponse.Type;

export const NativeAccountGrantRelayTicketRequest = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    nodeId: RelayNodeId,
    capability: RelayCapability,
    protocolMajor: Schema.Literal(1),
    protocolMinor: Schema.Literal(3),
    suiteId: Schema.Literal(2),
    enrollmentId: NativeE2eeEnrollmentId,
    enrollmentRevision: NativeE2eeEnrollmentRevision,
    clientPrekeyCertificateDigest: Base64Url32,
  }),
);
export type NativeAccountGrantRelayTicketRequest = typeof NativeAccountGrantRelayTicketRequest.Type;

export const NativeAccountGrantRelayTicketResponse = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    ticket: Base64Url(43, 86),
    ticketId: RelayTicketId,
    expiresAt: EpochMs,
    protocolMajor: Schema.Literal(1),
    protocolMinor: Schema.Literal(3),
    suiteId: Schema.Literal(2),
    deviceGrant: HubDeviceGrantEnvelope,
    deviceGrantDigest: E2eeDigestBase64Url,
    nodeCapabilityStatement: Base64Url(1, NODE_E2EE_CAPABILITY_STATEMENT_BASE64URL_MAX_CHARS),
    nodeCapabilityStatementDigest: E2eeDigestBase64Url,
    keysetGeneration: E2eeKeysetGeneration,
    capability: RelayCapability,
    effectiveRole: RelayEffectiveRole,
  }),
);
export type NativeAccountGrantRelayTicketResponse =
  typeof NativeAccountGrantRelayTicketResponse.Type;

export const NativeE2eeEnrollmentRevocationEvent = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(NATIVE_E2EE_PROTOCOL_VERSION),
    enrollmentId: NativeE2eeEnrollmentId,
    enrollmentRevision: NativeE2eeEnrollmentRevision,
    accountAuthEpoch: E2eeAuthorizationEpoch,
    deviceAuthEpoch: E2eeAuthorizationEpoch,
  }),
);
export type NativeE2eeEnrollmentRevocationEvent = typeof NativeE2eeEnrollmentRevocationEvent.Type;
