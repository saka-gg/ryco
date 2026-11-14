import { createHash, timingSafeEqual } from "node:crypto";

import { encode, rfc8949EncodeOptions } from "cborg";

export const NODE_AUTH_TRANSCRIPT_DOMAIN = "ryco.node-auth.proof.v1" as const;
export const NODE_KEY_FINGERPRINT_DOMAIN = "ryco.node-key.v1" as const;
export const NODE_KEY_ROTATION_TRANSCRIPT_DOMAIN = "ryco.node-key-rotation.proof.v1" as const;
export const NATIVE_NODE_CLAIM_TRANSCRIPT_DOMAIN = "ryco.native-node-claim.proof.v1" as const;
export const NODE_CHALLENGE_BYTES = 32;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const HUB_NODE_NAME_MAX_LENGTH = 100;

export type NodeSigningAlgorithm = "ed25519" | "p256";

export interface NodePublicKeyDescriptor {
  readonly algorithm: NodeSigningAlgorithm;
  readonly publicKey: Uint8Array;
}

export interface NodeAuthenticationTranscriptInput {
  readonly hubOrigin: string;
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly nodeId: string;
  readonly activeKeyId: string;
  readonly challengeExpiresAt: number;
  readonly challenge: Uint8Array;
}

export interface NodeKeyRotationTranscriptInput {
  readonly hubOrigin: string;
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly rotationRequestId: string;
  readonly nodeId: string;
  readonly oldActiveKeyId: string;
  readonly newKeyId: string;
  readonly newKey: NodePublicKeyDescriptor;
  readonly challengeExpiresAt: number;
  readonly challenge: Uint8Array;
}

export interface NativeNodeClaimTranscriptInput {
  readonly hubOrigin: string;
  readonly protocolVersion: number;
  readonly transcriptVersion: number;
  readonly claimId: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly sessionId: string;
  readonly dpopKeyThumbprint: Uint8Array;
  readonly installationId: string;
  readonly environmentId: string;
  readonly nodeKey: NodePublicKeyDescriptor;
  readonly claimExpiresAt: number;
  readonly challenge: Uint8Array;
}

export class NodeIdentityValidationError extends Error {
  readonly code = "invalid_node_identity_input" as const;

  constructor() {
    super("Node identity input is invalid.");
    this.name = "NodeIdentityValidationError";
  }
}

const ID_SUFFIX = "[A-Za-z0-9_-]{22}";
const NODE_ID = new RegExp(`^node_${ID_SUFFIX}$`);
const NODE_KEY_ID = new RegExp(`^nkey_${ID_SUFFIX}$`);
const ROTATION_REQUEST_ID = new RegExp(`^nrot_${ID_SUFFIX}$`);
const PUBLIC_ID_SUFFIX = "[A-Za-z0-9_-]{22,43}";
const ACCOUNT_ID = new RegExp(`^acct_${PUBLIC_ID_SUFFIX}$`);
const SPACE_ID = new RegExp(`^space_${PUBLIC_ID_SUFFIX}$`);
const SESSION_ID = new RegExp(`^sess_${PUBLIC_ID_SUFFIX}$`);
const NATIVE_NODE_CLAIM_ID = new RegExp(`^nclaim_${PUBLIC_ID_SUFFIX}$`);
const DESKTOP_INSTALLATION_ID = new RegExp(`^install_${PUBLIC_ID_SUFFIX}$`);
const ENVIRONMENT_ID = /^env_[A-Za-z0-9_-]{22}$/;
// A local copy of the loopback rule (`loopbackHost.ts` with `ipv4: "127.0.0.1"`), on purpose:
// this module is also built outside this package together with a fixed set of sibling files,
// and `loopbackHost.ts` is not one of them. Keep its imports to that set.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function invalid(): never {
  throw new NodeIdentityValidationError();
}

function assertUnsignedSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
}

function assertProtocolVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) invalid();
}

function assertIdentifier(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) invalid();
}

function copyBytes(value: Uint8Array, expectedLengths: readonly number[]): Uint8Array {
  if (!(value instanceof Uint8Array) || !expectedLengths.includes(value.byteLength)) invalid();
  return Uint8Array.from(value);
}

export function canonicalizeHubOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  const isLoopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (
    (url.protocol !== "https:" && !isLoopbackHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.origin
  ) {
    invalid();
  }
  return url.origin;
}

export function normalizeHubNodeName(value: string): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > HUB_NODE_NAME_MAX_LENGTH) invalid();
  return normalized;
}

export function validateNodePublicKey(
  descriptor: NodePublicKeyDescriptor,
): NodePublicKeyDescriptor {
  if (descriptor.algorithm === "ed25519") {
    return {
      algorithm: descriptor.algorithm,
      publicKey: copyBytes(descriptor.publicKey, [ED25519_PUBLIC_KEY_BYTES]),
    };
  }
  if (descriptor.algorithm === "p256") {
    const publicKey = copyBytes(descriptor.publicKey, [33, 65]);
    const prefix = publicKey[0];
    if (
      (publicKey.byteLength === 33 && prefix !== 0x02 && prefix !== 0x03) ||
      (publicKey.byteLength === 65 && prefix !== 0x04)
    ) {
      invalid();
    }
    return { algorithm: descriptor.algorithm, publicKey };
  }
  return invalid();
}

export function fingerprintNodePublicKey(descriptor: NodePublicKeyDescriptor): Uint8Array {
  const key = validateNodePublicKey(descriptor);
  const canonical = encode(
    [NODE_KEY_FINGERPRINT_DOMAIN, key.algorithm, key.publicKey],
    rfc8949EncodeOptions,
  );
  return Uint8Array.from(createHash("sha256").update(canonical).digest());
}

export function formatNodePublicKeyFingerprint(fingerprint: Uint8Array): string {
  const bytes = copyBytes(fingerprint, [32]);
  return `SHA256:${Buffer.from(bytes).toString("base64url")}`;
}

export function encodeNodeAuthenticationTranscript(
  input: NodeAuthenticationTranscriptInput,
): Uint8Array {
  const hubOrigin = canonicalizeHubOrigin(input.hubOrigin);
  assertProtocolVersion(input.protocolMajor);
  assertProtocolVersion(input.protocolMinor);
  assertIdentifier(input.nodeId, NODE_ID);
  assertIdentifier(input.activeKeyId, NODE_KEY_ID);
  assertUnsignedSafeInteger(input.challengeExpiresAt);
  const challenge = copyBytes(input.challenge, [NODE_CHALLENGE_BYTES]);
  return Uint8Array.from(
    encode(
      [
        NODE_AUTH_TRANSCRIPT_DOMAIN,
        hubOrigin,
        input.protocolMajor,
        input.protocolMinor,
        input.nodeId,
        input.activeKeyId,
        input.challengeExpiresAt,
        challenge,
      ],
      rfc8949EncodeOptions,
    ),
  );
}

export function encodeNodeKeyRotationTranscript(input: NodeKeyRotationTranscriptInput): Uint8Array {
  const hubOrigin = canonicalizeHubOrigin(input.hubOrigin);
  assertProtocolVersion(input.protocolMajor);
  assertProtocolVersion(input.protocolMinor);
  assertIdentifier(input.rotationRequestId, ROTATION_REQUEST_ID);
  assertIdentifier(input.nodeId, NODE_ID);
  assertIdentifier(input.oldActiveKeyId, NODE_KEY_ID);
  assertIdentifier(input.newKeyId, NODE_KEY_ID);
  assertUnsignedSafeInteger(input.challengeExpiresAt);
  const newKey = validateNodePublicKey(input.newKey);
  const fingerprint = fingerprintNodePublicKey(newKey);
  const challenge = copyBytes(input.challenge, [NODE_CHALLENGE_BYTES]);
  return Uint8Array.from(
    encode(
      [
        NODE_KEY_ROTATION_TRANSCRIPT_DOMAIN,
        hubOrigin,
        input.protocolMajor,
        input.protocolMinor,
        input.rotationRequestId,
        input.nodeId,
        input.oldActiveKeyId,
        input.newKeyId,
        newKey.algorithm,
        newKey.publicKey,
        fingerprint,
        input.challengeExpiresAt,
        challenge,
      ],
      rfc8949EncodeOptions,
    ),
  );
}

export function encodeNativeNodeClaimTranscript(input: NativeNodeClaimTranscriptInput): Uint8Array {
  const hubOrigin = canonicalizeHubOrigin(input.hubOrigin);
  assertProtocolVersion(input.protocolVersion);
  assertProtocolVersion(input.transcriptVersion);
  assertIdentifier(input.claimId, NATIVE_NODE_CLAIM_ID);
  assertIdentifier(input.accountId, ACCOUNT_ID);
  assertIdentifier(input.spaceId, SPACE_ID);
  assertIdentifier(input.sessionId, SESSION_ID);
  const dpopKeyThumbprint = copyBytes(input.dpopKeyThumbprint, [32]);
  assertIdentifier(input.installationId, DESKTOP_INSTALLATION_ID);
  assertIdentifier(input.environmentId, ENVIRONMENT_ID);
  const nodeKey = validateNodePublicKey(input.nodeKey);
  const nodeFingerprint = fingerprintNodePublicKey(nodeKey);
  assertUnsignedSafeInteger(input.claimExpiresAt);
  const challenge = copyBytes(input.challenge, [NODE_CHALLENGE_BYTES]);
  return Uint8Array.from(
    encode(
      [
        NATIVE_NODE_CLAIM_TRANSCRIPT_DOMAIN,
        hubOrigin,
        input.protocolVersion,
        input.transcriptVersion,
        input.claimId,
        input.accountId,
        input.spaceId,
        input.sessionId,
        dpopKeyThumbprint,
        input.installationId,
        input.environmentId,
        nodeKey.algorithm,
        nodeKey.publicKey,
        nodeFingerprint,
        input.claimExpiresAt,
        challenge,
      ],
      rfc8949EncodeOptions,
    ),
  );
}

export function equalNodeIdentityBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
