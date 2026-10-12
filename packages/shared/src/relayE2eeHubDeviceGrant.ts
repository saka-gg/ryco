import {
  HubGrantVerificationKeyId,
  HubDeviceGrantClaims as HubDeviceGrantClaimsSchema,
  type HubDeviceGrantClaims,
  type NativeE2eeEnrollmentStatus,
} from "@ryco/contracts/native-e2ee";
import type { RelayCapability, RelayEffectiveRole } from "@ryco/contracts/relay";
import { sha256 } from "@noble/hashes/sha2.js";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  E2EE_ACCOUNT_GRANT_CAPABILITIES_MAX,
  E2EE_ACCOUNT_GRANT_SUITE,
  E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW,
  E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS,
  E2EE_HUB_DEVICE_GRANT_MAX_BYTES,
} from "./relayE2eeConstants.ts";
import {
  E2EE_AGREEMENT_ALGORITHM,
  E2EE_CLIENT_IDENTITY_ALGORITHM,
  E2EE_NODE_IDENTITY_ALGORITHM,
  e2eeBytesEqual,
  e2eeKeyFingerprint,
  invalidRelayE2eeInput,
  validateE2eeAgreementPublicKey,
  validateE2eeClientIdentityPublicKey,
  validateE2eeNodeIdentityPublicKey,
  verifyE2eeSignature,
} from "./relayE2eeKeys.ts";
import {
  canonicalizeE2eeHubOrigin,
  decodeCanonicalE2eeCbor,
  encodeCanonicalE2eeCbor,
} from "./relayE2eeTranscripts.ts";

/** §18.3 domain of the exact 35-element claims array. */
export const E2EE_HUB_DEVICE_GRANT_CLAIMS_DOMAIN = "ryco.hub-device-grant-claims.v1" as const;
/** §18.3 domain of the fixed-size digest envelope that the Hub signs. */
export const E2EE_HUB_DEVICE_GRANT_SIGNATURE_DOMAIN = "ryco.hub-device-grant.v1" as const;

type DerivedClaimField =
  | "version"
  | "suiteId"
  | "deviceIdentityAlgorithm"
  | "deviceIdentityFingerprint"
  | "deviceAgreementAlgorithm"
  | "deviceAgreementFingerprint"
  | "nodeIdentityAlgorithm"
  | "nodeIdentityFingerprint"
  | "nodeAgreementAlgorithm"
  | "nodeAgreementFingerprint";

/**
 * Hub-side encoder input. Algorithm labels, suite/version, and fingerprints are
 * deliberately derived here so no signer can bless a mismatched carried value.
 */
export type HubDeviceGrantClaimsInput = Omit<HubDeviceGrantClaims, DerivedClaimField>;

export interface HubDeviceGrantVerificationKey {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  readonly notBefore: number;
  readonly notAfter: number;
}

/** Every independently authenticated value a grant is required to bind. */
export interface HubDeviceGrantBindings {
  readonly issuerHubOrigin: string;
  readonly accountId: string;
  readonly accountAuthEpoch: number;
  readonly enrollmentId: string;
  readonly enrollmentRevision: number;
  readonly deviceAuthEpoch: number;
  readonly enrollmentStatus: NativeE2eeEnrollmentStatus;
  readonly deviceIdentityPublicKey: Uint8Array;
  readonly deviceAgreementPublicKey: Uint8Array;
  readonly clientPrekeyCertificateDigest: Uint8Array;
  readonly clientPrekeyCertificateExpiresAt: number;
  readonly nodeId: string;
  readonly nodeIdentityPublicKey: Uint8Array;
  readonly nodeAgreementPublicKey: Uint8Array;
  readonly nodeAgreementPrekeyExpiresAt: number;
  readonly nodeContinuityId: string;
  readonly nodePolicyGeneration: number;
  readonly nodeCapabilityStatementDigest: Uint8Array;
  readonly nodeCapabilityStatementExpiresAt: number;
  readonly relayTicketId: string;
  readonly relayTicketExpiresAt: number;
  readonly effectiveRole: RelayEffectiveRole;
  readonly effectiveCapabilities: readonly RelayCapability[];
  /** False for a local denial, conflicting verified pin, or policy that forbids suite 0x02. */
  readonly accountGrantAllowed: boolean;
  readonly now: number;
}

export type HubDeviceGrantFailureReason =
  | "grant_oversize"
  | "grant_malformed"
  | "grant_non_canonical"
  | "grant_version"
  | "grant_unknown_key"
  | "grant_signature"
  | "grant_not_yet_valid"
  | "grant_expired"
  | "grant_binding"
  | "grant_revoked"
  | "grant_policy";

export interface DecodedHubDeviceGrant {
  readonly claims: HubDeviceGrantClaims;
  /** Exact canonical signed envelope bytes. */
  readonly envelope: Uint8Array;
  readonly claimsBytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly grantDigest: Uint8Array;
}

export type HubDeviceGrantDecodeResult =
  | ({ readonly kind: "ok" } & DecodedHubDeviceGrant)
  | { readonly kind: "error"; readonly reason: HubDeviceGrantFailureReason };

export type HubDeviceGrantVerificationResult =
  | ({ readonly kind: "ok" } & DecodedHubDeviceGrant)
  | { readonly kind: "error"; readonly reason: HubDeviceGrantFailureReason };

const decodeClaimsSchema = Schema.decodeUnknownExit(HubDeviceGrantClaimsSchema);
const decodeGrantKeyId = Schema.decodeUnknownExit(HubGrantVerificationKeyId);
const ROLE_RANK: Readonly<Record<RelayEffectiveRole, number>> = {
  viewer: 0,
  operator: 1,
  owner: 2,
};

function claimsArray(claims: HubDeviceGrantClaims): readonly unknown[] {
  return [
    E2EE_HUB_DEVICE_GRANT_CLAIMS_DOMAIN,
    claims.version,
    claims.suiteId,
    claims.issuerHubOrigin,
    claims.keyId,
    claims.grantId,
    claims.accountId,
    claims.accountAuthEpoch,
    claims.enrollmentId,
    claims.enrollmentRevision,
    claims.deviceAuthEpoch,
    claims.deviceIdentityAlgorithm,
    claims.deviceIdentityPublicKey,
    claims.deviceIdentityFingerprint,
    claims.deviceAgreementAlgorithm,
    claims.deviceAgreementPublicKey,
    claims.deviceAgreementFingerprint,
    claims.clientPrekeyCertificateDigest,
    claims.nodeId,
    claims.nodeIdentityAlgorithm,
    claims.nodeIdentityPublicKey,
    claims.nodeIdentityFingerprint,
    claims.nodeAgreementAlgorithm,
    claims.nodeAgreementPublicKey,
    claims.nodeAgreementFingerprint,
    claims.nodeContinuityId,
    claims.nodePolicyGeneration,
    claims.nodeCapabilityStatementDigest,
    claims.relayTicketId,
    claims.maximumRole,
    claims.capabilities,
    claims.issuedAt,
    claims.notBefore,
    claims.expiresAt,
    claims.nonce,
  ];
}

function claimsObject(value: readonly unknown[]): Record<string, unknown> {
  return {
    version: value[1],
    suiteId: value[2],
    issuerHubOrigin: value[3],
    keyId: value[4],
    grantId: value[5],
    accountId: value[6],
    accountAuthEpoch: value[7],
    enrollmentId: value[8],
    enrollmentRevision: value[9],
    deviceAuthEpoch: value[10],
    deviceIdentityAlgorithm: value[11],
    deviceIdentityPublicKey: value[12],
    deviceIdentityFingerprint: value[13],
    deviceAgreementAlgorithm: value[14],
    deviceAgreementPublicKey: value[15],
    deviceAgreementFingerprint: value[16],
    clientPrekeyCertificateDigest: value[17],
    nodeId: value[18],
    nodeIdentityAlgorithm: value[19],
    nodeIdentityPublicKey: value[20],
    nodeIdentityFingerprint: value[21],
    nodeAgreementAlgorithm: value[22],
    nodeAgreementPublicKey: value[23],
    nodeAgreementFingerprint: value[24],
    nodeContinuityId: value[25],
    nodePolicyGeneration: value[26],
    nodeCapabilityStatementDigest: value[27],
    relayTicketId: value[28],
    maximumRole: value[29],
    capabilities: value[30],
    issuedAt: value[31],
    notBefore: value[32],
    expiresAt: value[33],
    nonce: value[34],
  };
}

function fingerprintsMatch(claims: HubDeviceGrantClaims): boolean {
  try {
    validateE2eeClientIdentityPublicKey(claims.deviceIdentityPublicKey);
    validateE2eeAgreementPublicKey(claims.deviceAgreementPublicKey);
    validateE2eeNodeIdentityPublicKey(claims.nodeIdentityPublicKey);
    validateE2eeAgreementPublicKey(claims.nodeAgreementPublicKey);
    return (
      e2eeBytesEqual(
        claims.deviceIdentityFingerprint,
        e2eeKeyFingerprint("client-identity", claims.deviceIdentityPublicKey),
      ) &&
      e2eeBytesEqual(
        claims.deviceAgreementFingerprint,
        e2eeKeyFingerprint("agreement", claims.deviceAgreementPublicKey),
      ) &&
      e2eeBytesEqual(
        claims.nodeIdentityFingerprint,
        e2eeKeyFingerprint("node-identity", claims.nodeIdentityPublicKey),
      ) &&
      e2eeBytesEqual(
        claims.nodeAgreementFingerprint,
        e2eeKeyFingerprint("agreement", claims.nodeAgreementPublicKey),
      )
    );
  } catch {
    return false;
  }
}

/** Canonically encode the exact §18.3 claims array. */
export function encodeHubDeviceGrantClaims(input: HubDeviceGrantClaimsInput): Uint8Array {
  const deviceIdentityPublicKey = validateE2eeClientIdentityPublicKey(
    input.deviceIdentityPublicKey,
  );
  const deviceAgreementPublicKey = validateE2eeAgreementPublicKey(input.deviceAgreementPublicKey);
  const nodeIdentityPublicKey = validateE2eeNodeIdentityPublicKey(input.nodeIdentityPublicKey);
  const nodeAgreementPublicKey = validateE2eeAgreementPublicKey(input.nodeAgreementPublicKey);
  const candidate = {
    ...input,
    version: 1,
    suiteId: E2EE_ACCOUNT_GRANT_SUITE,
    deviceIdentityAlgorithm: E2EE_CLIENT_IDENTITY_ALGORITHM,
    deviceIdentityPublicKey,
    deviceIdentityFingerprint: e2eeKeyFingerprint("client-identity", deviceIdentityPublicKey),
    deviceAgreementAlgorithm: E2EE_AGREEMENT_ALGORITHM,
    deviceAgreementPublicKey,
    deviceAgreementFingerprint: e2eeKeyFingerprint("agreement", deviceAgreementPublicKey),
    nodeIdentityAlgorithm: E2EE_NODE_IDENTITY_ALGORITHM,
    nodeIdentityPublicKey,
    nodeIdentityFingerprint: e2eeKeyFingerprint("node-identity", nodeIdentityPublicKey),
    nodeAgreementAlgorithm: E2EE_AGREEMENT_ALGORITHM,
    nodeAgreementPublicKey,
    nodeAgreementFingerprint: e2eeKeyFingerprint("agreement", nodeAgreementPublicKey),
  };
  const decoded = decodeClaimsSchema(candidate);
  if (Exit.isFailure(decoded)) invalidRelayE2eeInput();
  const canonicalOrigin = canonicalizeE2eeHubOrigin(decoded.value.issuerHubOrigin);
  if (canonicalOrigin !== decoded.value.issuerHubOrigin) invalidRelayE2eeInput();
  return encodeCanonicalE2eeCbor(claimsArray(decoded.value));
}

/** Rebuild the only byte string a Hub grant key is allowed to sign. */
export function encodeHubDeviceGrantSigningEnvelope(claimsBytes: Uint8Array): Uint8Array {
  if (!(claimsBytes instanceof Uint8Array) || claimsBytes.byteLength === 0) {
    invalidRelayE2eeInput();
  }
  return encodeCanonicalE2eeCbor([E2EE_HUB_DEVICE_GRANT_SIGNATURE_DOMAIN, sha256(claimsBytes)]);
}

/** Canonically wrap exact claims bytes and their Ed25519 signature. */
export function encodeHubDeviceGrantEnvelope(
  claimsBytes: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  if (
    !(claimsBytes instanceof Uint8Array) ||
    claimsBytes.byteLength === 0 ||
    !(signature instanceof Uint8Array) ||
    signature.byteLength !== 64
  ) {
    invalidRelayE2eeInput();
  }
  const envelope = encodeCanonicalE2eeCbor([claimsBytes, signature]);
  if (envelope.byteLength > E2EE_HUB_DEVICE_GRANT_MAX_BYTES) invalidRelayE2eeInput();
  return envelope;
}

function canonicalFailure(
  reason: "malformed" | "non_canonical" | "float_forbidden",
): "grant_malformed" | "grant_non_canonical" {
  return reason === "non_canonical" ? "grant_non_canonical" : "grant_malformed";
}

/** Strictly decode and structurally validate a signed grant without trusting it. */
export function decodeHubDeviceGrant(envelope: Uint8Array): HubDeviceGrantDecodeResult {
  if (!(envelope instanceof Uint8Array)) return { kind: "error", reason: "grant_malformed" };
  if (envelope.byteLength > E2EE_HUB_DEVICE_GRANT_MAX_BYTES) {
    return { kind: "error", reason: "grant_oversize" };
  }
  const outer = decodeCanonicalE2eeCbor(envelope);
  if (outer.kind === "error") {
    return { kind: "error", reason: canonicalFailure(outer.reason) };
  }
  if (
    !Array.isArray(outer.value) ||
    outer.value.length !== 2 ||
    !(outer.value[0] instanceof Uint8Array) ||
    !(outer.value[1] instanceof Uint8Array) ||
    outer.value[1].byteLength !== 64
  ) {
    return { kind: "error", reason: "grant_malformed" };
  }
  const claimsBytes = outer.value[0];
  const signature = outer.value[1];
  const decodedClaims = decodeCanonicalE2eeCbor(claimsBytes);
  if (decodedClaims.kind === "error") {
    return { kind: "error", reason: canonicalFailure(decodedClaims.reason) };
  }
  if (!Array.isArray(decodedClaims.value) || decodedClaims.value.length !== 35) {
    return { kind: "error", reason: "grant_malformed" };
  }
  if (
    decodedClaims.value[0] !== E2EE_HUB_DEVICE_GRANT_CLAIMS_DOMAIN ||
    decodedClaims.value[1] !== 1 ||
    decodedClaims.value[2] !== E2EE_ACCOUNT_GRANT_SUITE
  ) {
    return { kind: "error", reason: "grant_version" };
  }
  const semantic = decodeClaimsSchema(claimsObject(decodedClaims.value));
  if (Exit.isFailure(semantic)) return { kind: "error", reason: "grant_malformed" };
  try {
    if (
      canonicalizeE2eeHubOrigin(semantic.value.issuerHubOrigin) !== semantic.value.issuerHubOrigin
    ) {
      return { kind: "error", reason: "grant_malformed" };
    }
  } catch {
    return { kind: "error", reason: "grant_malformed" };
  }
  if (!fingerprintsMatch(semantic.value)) {
    return { kind: "error", reason: "grant_binding" };
  }
  return {
    kind: "ok",
    claims: semantic.value,
    envelope: Uint8Array.from(envelope),
    claimsBytes: Uint8Array.from(claimsBytes),
    signature: Uint8Array.from(signature),
    grantDigest: sha256(envelope),
  };
}

function sameTextArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  let equal = true;
  for (let index = 0; index < left.length; index += 1) {
    equal = left[index] === right[index] && equal;
  }
  return equal;
}

function bindingsMatch(claims: HubDeviceGrantClaims, expected: HubDeviceGrantBindings): boolean {
  let equal = true;
  const text = (left: string, right: string): void => {
    equal = left === right && equal;
  };
  const integer = (left: number, right: number): void => {
    equal = left === right && equal;
  };
  const bytes = (left: Uint8Array, right: Uint8Array): void => {
    equal = e2eeBytesEqual(left, right) && equal;
  };
  text(claims.issuerHubOrigin, expected.issuerHubOrigin);
  text(claims.accountId, expected.accountId);
  integer(claims.accountAuthEpoch, expected.accountAuthEpoch);
  text(claims.enrollmentId, expected.enrollmentId);
  integer(claims.enrollmentRevision, expected.enrollmentRevision);
  integer(claims.deviceAuthEpoch, expected.deviceAuthEpoch);
  bytes(claims.deviceIdentityPublicKey, expected.deviceIdentityPublicKey);
  bytes(claims.deviceAgreementPublicKey, expected.deviceAgreementPublicKey);
  bytes(claims.clientPrekeyCertificateDigest, expected.clientPrekeyCertificateDigest);
  text(claims.nodeId, expected.nodeId);
  bytes(claims.nodeIdentityPublicKey, expected.nodeIdentityPublicKey);
  bytes(claims.nodeAgreementPublicKey, expected.nodeAgreementPublicKey);
  text(claims.nodeContinuityId, expected.nodeContinuityId);
  integer(claims.nodePolicyGeneration, expected.nodePolicyGeneration);
  bytes(claims.nodeCapabilityStatementDigest, expected.nodeCapabilityStatementDigest);
  text(claims.relayTicketId, expected.relayTicketId);
  return equal;
}

/** Verify a grant against an authenticated keyset and caller-owned bindings. */
export function verifyHubDeviceGrant(input: {
  readonly envelope: Uint8Array;
  readonly verificationKeys: readonly HubDeviceGrantVerificationKey[];
  readonly bindings: HubDeviceGrantBindings;
}): HubDeviceGrantVerificationResult {
  const decoded = decodeHubDeviceGrant(input.envelope);
  if (decoded.kind === "error") return decoded;
  const { claims } = decoded;

  if (
    !Array.isArray(input.verificationKeys) ||
    input.verificationKeys.length < 1 ||
    input.verificationKeys.length > E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS
  ) {
    return { kind: "error", reason: "grant_unknown_key" };
  }
  const ids = new Set<string>();
  let selected: HubDeviceGrantVerificationKey | undefined;
  for (const key of input.verificationKeys) {
    if (
      typeof key?.keyId !== "string" ||
      Exit.isFailure(decodeGrantKeyId(key.keyId)) ||
      ids.has(key.keyId) ||
      !(key.publicKey instanceof Uint8Array) ||
      !Number.isSafeInteger(key.notBefore) ||
      !Number.isSafeInteger(key.notAfter) ||
      key.notBefore < 0 ||
      key.notAfter <= key.notBefore
    ) {
      return { kind: "error", reason: "grant_unknown_key" };
    }
    try {
      validateE2eeNodeIdentityPublicKey(key.publicKey);
    } catch {
      return { kind: "error", reason: "grant_unknown_key" };
    }
    ids.add(key.keyId);
    if (key.keyId === claims.keyId) selected = key;
  }
  if (
    selected === undefined ||
    selected.notBefore > claims.notBefore ||
    selected.notAfter < claims.expiresAt
  ) {
    return { kind: "error", reason: "grant_unknown_key" };
  }
  const { bindings } = input;
  if (!Number.isSafeInteger(bindings.now) || bindings.now < 0) {
    return { kind: "error", reason: "grant_binding" };
  }
  if (bindings.now < claims.notBefore - E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW) {
    return { kind: "error", reason: "grant_not_yet_valid" };
  }
  if (bindings.now > claims.expiresAt) {
    return { kind: "error", reason: "grant_expired" };
  }
  if (
    !verifyE2eeSignature({
      algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
      publicKey: selected.publicKey,
      message: encodeHubDeviceGrantSigningEnvelope(decoded.claimsBytes),
      signature: decoded.signature,
    })
  ) {
    return { kind: "error", reason: "grant_signature" };
  }
  if (!bindingsMatch(claims, bindings)) {
    return { kind: "error", reason: "grant_binding" };
  }
  if (bindings.enrollmentStatus !== "active") {
    return { kind: "error", reason: "grant_revoked" };
  }
  if (
    ![
      bindings.relayTicketExpiresAt,
      bindings.clientPrekeyCertificateExpiresAt,
      bindings.nodeCapabilityStatementExpiresAt,
      bindings.nodeAgreementPrekeyExpiresAt,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    claims.expiresAt > bindings.relayTicketExpiresAt ||
    claims.expiresAt > bindings.clientPrekeyCertificateExpiresAt ||
    claims.expiresAt > bindings.nodeCapabilityStatementExpiresAt ||
    claims.expiresAt > bindings.nodeAgreementPrekeyExpiresAt
  ) {
    return { kind: "error", reason: "grant_binding" };
  }
  if (
    bindings.accountGrantAllowed !== true ||
    ROLE_RANK[bindings.effectiveRole] === undefined ||
    !Array.isArray(bindings.effectiveCapabilities) ||
    bindings.effectiveCapabilities.length < 1 ||
    bindings.effectiveCapabilities.length > E2EE_ACCOUNT_GRANT_CAPABILITIES_MAX ||
    ROLE_RANK[bindings.effectiveRole] > ROLE_RANK[claims.maximumRole] ||
    !bindings.effectiveCapabilities.every((capability) =>
      claims.capabilities.includes(capability),
    ) ||
    !sameTextArray([...new Set(bindings.effectiveCapabilities)], bindings.effectiveCapabilities)
  ) {
    return { kind: "error", reason: "grant_policy" };
  }
  return decoded;
}
