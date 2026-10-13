import type { NativeE2eeTrustSource } from "@ryco/contracts/native-e2ee";
import { equalBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { encode, rfc8949EncodeOptions } from "cborg";

import {
  E2EE_AGREEMENT_PUBLIC_KEY_BYTES,
  E2EE_CONFIRMATION_BYTES,
  E2EE_CONTEXT_COMMITMENT_BYTES,
  E2EE_HANDSHAKE_NONCE_BYTES,
  E2EE_HUB_DEVICE_GRANT_MAX_BYTES,
  E2EE_KEY_FINGERPRINT_BYTES,
  E2EE_MAX_CLOCK_SKEW,
  E2EE_PREKEY_LIFETIME,
  E2EE_PROTOCOL_VERSION,
  E2EE_SESSION_BINDING_HASH_BYTES,
  E2EE_SUITE_REGISTRY_MAX_ENTRIES,
  P256_PUBLIC_KEY_BYTES,
  T_HANDSHAKE,
  T_HANDSHAKE_NODE,
} from "./relayE2eeConstants.ts";
import {
  E2EE_CLIENT_IDENTITY_ALGORITHM,
  e2eeKeyFingerprint,
  e2eeX25519PublicKey,
  invalidRelayE2eeInput,
  validateE2eeAgreementPublicKey,
  validateE2eeClientIdentityPublicKey,
  validateE2eeClientSignature,
  verifyE2eeSignature,
} from "./relayE2eeKeys.ts";
import { E2eeNoiseHandshake } from "./relayE2eeNoise.ts";
import {
  deriveE2eeSessionSecrets,
  eraseE2eeSessionSecrets,
  type E2eeSessionSecrets,
} from "./relayE2eeSession.ts";
import {
  E2EE_NOISE_DH,
  E2EE_NOISE_HASH,
  assertE2eeAccountId,
  assertRelayCapabilityLiteral,
  assertRelayEffectiveRoleLiteral,
  decodeCanonicalE2eeCbor,
  e2eeAuthorizationContextCommitment,
  e2eeEffectiveAdmittedPatterns,
  e2eeTierNoisePattern,
  encodeClientE2eePrekeyCertificateCarrier,
  encodeE2eeAccountGrantAuthorizationContext,
  encodeClientE2eePrekeyTranscript,
  encodeE2eeAuthorizationContext,
  encodeE2eeNoisePrologue,
  type E2eeNoisePattern,
  type E2eeTier,
} from "./relayE2eeTranscripts.ts";
import { decodeHubDeviceGrant, type DecodedHubDeviceGrant } from "./relayE2eeHubDeviceGrant.ts";
import {
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
  E2EE_NEGOTIATION_TYPE_CLIENT_HELLO,
  E2EE_NEGOTIATION_TYPE_SERVER_ACCEPT,
  decodeE2eeNegotiationRecord,
  encodeE2eeNegotiationRecord,
  isE2eeSuiteId,
  type E2eeDecodeResult,
  type E2eeSuiteId,
} from "./relayE2eeWire.ts";

// The handshake driver of the Ryco relay E2EE protocol —
// docs/relay-e2ee-protocol.md §8.2 (client-selected suite), §8.5
// (`E2EEClientHello`), §8.6 (responder processing), §8.7 (`E2EEServerAccept`,
// `ServerAcceptTBS`, and confirmation), §8.8 (client verification and session
// binding), and §8.9 (implicit client finish).
//
// This module drives the two tiers of §8 end to end and produces exactly one
// thing the rest of the system consumes: an established session — the §6.5
// secrets plus the §8.8 `sessionBindingHash` that enters the AAD of every
// envelope. It builds NOTHING it can import:
//
//   - the §3.2 constants and the §4.5 budget are `relayE2eeConstants`;
//   - the negotiation framing, its per-type bounds, and the registries are
//     `relayE2eeWire`;
//   - fingerprints, strict key and signature validation, and the single
//     signature-verification choke point are `relayE2eeKeys`;
//   - the §7.4 client certificate encoder, the §8.3 context block, the §8.4
//     prologue, and the §3.6 canonical decode are `relayE2eeTranscripts`;
//   - the frozen Noise IK/NX state machine, `Split()`, and the §6.5 exporter
//     are `relayE2eeNoise`;
//   - the §6.5 key schedule and `serverConfirmationKey` are `relayE2eeSession`.
//
// WHAT IT ADDS is the ordering §8 fixes and the comparisons §8 requires: the
// §8.5 and §8.7 body schemas, the numbered §8.6 responder steps in order, the
// §8.7 transcripts over EXACT WIRE BYTES, the §8.8 symmetric checks, and the
// §8.9 implicit finish with its revocation re-check.
//
// IT READS NO CLOCK AND HOLDS NO CHANNEL I/O. Every deadline takes `now` from
// the caller (§4.4's timers are the caller's), every durable read is a caller
// callback, and the two drivers return bytes rather than sending them.
//
// FAILURE REASONS ARE LOCAL CLASSIFICATION ONLY. §11.2 requires every pre-key
// failure to be externally indistinguishable: one byte-identical
// `E2EEHandshakeReject` from the node, `channel_rejected`, and zero application
// payload. The `row` and `reason` fields below exist so an implementation can
// diagnose and so a §16.2 fixture can name its §11.2 row; NO REASON MAY REACH A
// PEER, A LOG, OR AN ERROR SURFACE.
//
// Peer-supplied input yields typed results; local programming mistakes throw,
// matching `relayE2eeWire` and `relayE2eeTranscripts`. This module is free of
// Node built-ins, so it runs on Bun, in browsers, and on Hermes.

// ─── §3.5 transcript domains ─────────────────────────────────────────────────

/** §8.7 confirmation transcript array (§3.5). */
export const E2EE_CONFIRMATION_DOMAIN = "ryco.relay-e2ee.confirmation.v1" as const;
/** §8.8 session-binding transcript array (§3.5). */
export const E2EE_SESSION_BINDING_DOMAIN = "ryco.relay-e2ee.session.v1" as const;

// ─── comparisons ─────────────────────────────────────────────────────────────

/**
 * Constant-time byte equality, for the comparisons §11.2 names as
 * secret-dependent: context commitments (§8.6 step 7), confirmation tags (§8.8
 * step 5), and key and fingerprint equality (§7.1).
 *
 * It is the audited cipher package's own comparison rather than a second
 * hand-written loop (§14.2, §14.6), and it is deliberately NOT
 * `e2eeBytesEqual`, whose doc comment says in as many words that it is an
 * ordinary comparison and MUST NOT be used for secrets. Length is public in
 * every structure this protocol compares — every one is fixed-width — so the
 * length short-circuit leaks nothing.
 */
export function e2eeSecretBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  return equalBytes(left, right);
}

function encodeCanonical(elements: readonly unknown[]): Uint8Array {
  return Uint8Array.from(encode(elements, rfc8949EncodeOptions));
}

function isTextElement(value: unknown): value is string {
  return typeof value === "string";
}

function isUintElement(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBytesElement(value: unknown, expectedLength?: number): value is Uint8Array {
  if (!(value instanceof Uint8Array)) return false;
  return expectedLength === undefined || value.byteLength === expectedLength;
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

// ─── §8.3 role ordering ──────────────────────────────────────────────────────

/**
 * §8.3: `viewer < operator < owner`. The MEMBERSHIP of this vocabulary belongs
 * to the relay contract and is checked through it (§1.1, §3.2); the ORDERING is
 * this protocol's, and it exists nowhere else, so it is defined here over the
 * literals the contract admits.
 *
 * A literal the contract admits and this table does not is a vocabulary change
 * that §8.3 has not been updated for — it throws rather than ranking as
 * anything, because a silently unranked role would make every ceiling check
 * meaningless in exactly the direction that widens authority.
 */
const E2EE_ROLE_ORDER: Readonly<Record<string, number>> = {
  viewer: 0,
  operator: 1,
  owner: 2,
};

/** The §8.3 rank of a relay effective role. Throws for anything the ordering does not cover. */
export function e2eeRoleRank(role: string): number {
  const rank = E2EE_ROLE_ORDER[assertRelayEffectiveRoleLiteral(role)];
  if (rank === undefined) invalidRelayE2eeInput();
  return rank;
}

/** §8.3: is `role` at or below `ceiling` under the role ordering? */
export function e2eeRoleWithinCeiling(role: string, ceiling: string): boolean {
  return e2eeRoleRank(role) <= e2eeRoleRank(ceiling);
}

// ─── §13.6 Branch A records and the withdrawal test ──────────────────────────

/** §13.6 record `status`. */
export type E2eeClientAuthorizationStatus = "pending" | "approved" | "revoked";

/** The full §13.6 record key. §8.6 step 6 and §13.6 compare all three fields. */
export interface E2eeClientAuthorizationKey {
  readonly hubOrigin: string;
  readonly accountId: string;
  /** `ryco.client-key.v1` (§7.1), never a raw key. */
  readonly clientIdentityFingerprint: Uint8Array;
}

/** The authority half of a §13.6 record — the only fields §8.6 step 6 reads. */
export interface E2eeClientAuthorization {
  readonly status: E2eeClientAuthorizationStatus;
  readonly maxRole: string;
  readonly capabilitySet: readonly string[];
}

/**
 * §8.6 step 6 / §15: the admitted-authority snapshot. The full record key plus
 * the `status`, `maxRole`, and `capabilitySet` that read returned — AND NO
 * OTHER RECORD CONTENT: not the safety number, not the display label, not any
 * timestamp.
 *
 * It is recorded on the channel's in-flight handshake entry at the moment of
 * the step 6 read and survives onto the established channel for its lifetime,
 * because §13.6's sweep and §8.9's re-check both evaluate against it rather
 * than against the authority the channel is currently exercising.
 */
export interface E2eeAdmittedAuthoritySnapshot
  extends E2eeClientAuthorizationKey, E2eeClientAuthorization {}

/**
 * §13.6: the full-key comparison. A sweep keyed on the fingerprint alone would
 * close channels admitted under a different `(hubOrigin, accountId)` scope,
 * whose authority the owner did not touch.
 */
export function e2eeAuthorizationKeysEqual(
  left: E2eeClientAuthorizationKey,
  right: E2eeClientAuthorizationKey,
): boolean {
  return (
    left.hubOrigin === right.hubOrigin &&
    left.accountId === right.accountId &&
    e2eeSecretBytesEqual(left.clientIdentityFingerprint, right.clientIdentityFingerprint)
  );
}

/**
 * The §13.6 **withdrawal test**, evaluated against a channel's admitted-authority
 * snapshot: withdrawn when the post-change record is absent, or its `status` is
 * not `approved`, or its `maxRole` is below the snapshot's under the §8.3
 * ordering, or its `capabilitySet` no longer contains every member of the
 * snapshot's.
 *
 * Re-reading only `status` is NOT sufficient and that is the whole point: a
 * demotion or a capability removal leaves `status = approved`, so a status-only
 * re-check passes a channel the owner has just narrowed.
 *
 * The caller matches the record key first (`e2eeAuthorizationKeysEqual`); this
 * is the authority half of the test.
 */
export function e2eeAuthorizationWithdrawn(
  snapshot: E2eeClientAuthorization,
  record: E2eeClientAuthorization | undefined,
): boolean {
  if (record === undefined) return true;
  if (record.status !== "approved") return true;
  if (e2eeRoleRank(record.maxRole) < e2eeRoleRank(snapshot.maxRole)) return true;
  const granted = new Set(record.capabilitySet);
  return snapshot.capabilitySet.some((capability) => !granted.has(capability));
}

// ─── §8.2 client-selected suite, with §5.2 steps 8 and 9 ─────────────────────

/**
 * The three ways a well-formed, correctly signed capability statement can still
 * be unusable (§8.2). They are exhaustive because they are exactly the three
 * signed fields a hello must satisfy before §8.6 can accept it, and all three
 * carry the identical disposition: the client MUST NOT send a hello, and rows
 * K2/K3 of §4.4 govern the channel (§11.2 P15 when the selection is latched).
 */
export type E2eeStatementUnusableReason =
  /** §5.2 step 8: `E2EE_PROTOCOL_VERSION` outside `[min, max]`, or `min > max`. */
  | "protocol_version_out_of_range"
  /** §5.2 step 9: the Noise pattern this client's tier runs is absent from §7.6 element 14. */
  | "pattern_not_admitted"
  /** §8.2: the client's local suite policy and the advertised registry do not intersect. */
  | "empty_suite_intersection";

export type E2eeSuiteSelection =
  | { readonly kind: "usable"; readonly selectedSuite: E2eeSuiteId }
  | { readonly kind: "unusable"; readonly reason: E2eeStatementUnusableReason };

export interface E2eeSuiteSelectionInput {
  readonly tier: E2eeTier;
  /**
   * The credential class available for this attempt. Omission preserves the
   * version-1 default: locally verified for native, unsigned for Web.
   */
  readonly trustSource?: NativeE2eeTrustSource | undefined;
  /** The client's own FIXED local preference order (§8.2). */
  readonly localSuitePreference: readonly number[];
  /** §7.6 element 9, as the validated statement advertises it, in signed order. */
  readonly advertisedSuiteRegistry: readonly number[];
  /** §7.6 elements 7–8. */
  readonly advertisedVersionMin: number;
  readonly advertisedVersionMax: number;
  /** §7.6 element 14, the effective admitted pattern set. */
  readonly advertisedAdmittedPatterns: readonly E2eeNoisePattern[];
}

function effectiveSelectionTrustSource(input: E2eeSuiteSelectionInput): NativeE2eeTrustSource {
  return input.trustSource ?? (input.tier === "native" ? "locally-verified" : "web-unsigned");
}

function suiteSupportsCredential(
  suite: E2eeSuiteId,
  tier: E2eeTier,
  trustSource: NativeE2eeTrustSource,
): boolean {
  if (suite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256) {
    return tier === "native" && trustSource === "account-enrolled";
  }
  return tier === "web" ? trustSource === "web-unsigned" : trustSource === "locally-verified";
}

/**
 * §8.2 with §5.2 steps 8–9: decide whether a VALIDATED capability statement is
 * usable and, if it is, select the suite.
 *
 * Selection is the client's: it takes its own fixed local preference order and
 * selects the first entry that appears in the advertised registry. The server
 * may only accept that selection or reject (§8.2); this module never lets a
 * responder substitute one.
 *
 * The three checks run step 8, then step 9, then §8.2. §5.2 fixes 8 before 9
 * and says their relative order carries no requirement because neither masks
 * the other; the suite intersection is placed last for the same reason. All
 * three produce the same wire disposition, so the order is diagnostic only.
 *
 * PRECONDITION: the statement already passed §5.2 steps 0–7. An over-long
 * registry never validates (§7.6, §15), so it is a local error here rather than
 * an unusability verdict.
 */
export function selectE2eeSuite(input: E2eeSuiteSelectionInput): E2eeSuiteSelection {
  if (
    !Array.isArray(input.advertisedSuiteRegistry) ||
    input.advertisedSuiteRegistry.length === 0 ||
    input.advertisedSuiteRegistry.length > E2EE_SUITE_REGISTRY_MAX_ENTRIES ||
    !Array.isArray(input.localSuitePreference) ||
    input.localSuitePreference.length === 0
  ) {
    invalidRelayE2eeInput();
  }
  if (
    !Number.isSafeInteger(input.advertisedVersionMin) ||
    !Number.isSafeInteger(input.advertisedVersionMax) ||
    input.advertisedVersionMin > input.advertisedVersionMax ||
    input.advertisedVersionMin > E2EE_PROTOCOL_VERSION ||
    E2EE_PROTOCOL_VERSION > input.advertisedVersionMax
  ) {
    return { kind: "unusable", reason: "protocol_version_out_of_range" };
  }
  const pattern = e2eeTierNoisePattern(input.tier);
  if (!input.advertisedAdmittedPatterns.includes(pattern)) {
    return { kind: "unusable", reason: "pattern_not_admitted" };
  }
  const trustSource = effectiveSelectionTrustSource(input);
  // §3.4 reserves every unregistered suite id, so an unregistered entry is not
  // selectable even where both lists carry it. A registered suite that does
  // not represent this tier and trust source is filtered before preference,
  // preventing Web from selecting 0x02 and account credentials from silently
  // downgrading to the local-approval suite.
  const selected = input.localSuitePreference.find(
    (suite) =>
      isE2eeSuiteId(suite) &&
      suiteSupportsCredential(suite, input.tier, trustSource) &&
      input.advertisedSuiteRegistry.includes(suite),
  );
  if (selected === undefined || !isE2eeSuiteId(selected)) {
    return { kind: "unusable", reason: "empty_suite_intersection" };
  }
  return { kind: "usable", selectedSuite: selected };
}

/**
 * The suite's Noise usage fields (§3.4), which §7.3 element 9–10 and §7.4
 * element 7–8 pin into every agreement-prekey certificate and which §8.6 step 5
 * requires to match the negotiated suite.
 */
export function e2eeSuiteNoiseUsage(suite: E2eeSuiteId): {
  readonly dh: string;
  readonly hash: string;
} {
  if (!isE2eeSuiteId(suite)) invalidRelayE2eeInput();
  return { dh: E2EE_NOISE_DH, hash: E2EE_NOISE_HASH };
}

// ─── §8.5 `E2EEClientHello` ──────────────────────────────────────────────────

const CLIENT_HELLO_ELEMENTS = 7;
const IK_HELLO_PAYLOAD_ELEMENTS = 5;
const ACCOUNT_GRANT_IK_HELLO_PAYLOAD_ELEMENTS = 6;
const SERVER_ACCEPT_ELEMENTS = 5;
const ACCEPT_PAYLOAD_ELEMENTS = 3;

/** §8.5 element 1: the tier literal selecting the Noise pattern (§8.1). */
export const E2EE_TIER_NATIVE = "native" as const;
/** §8.5 element 1. */
export const E2EE_TIER_WEB = "web" as const;

function isE2eeTier(value: unknown): value is E2eeTier {
  return value === E2EE_TIER_NATIVE || value === E2EE_TIER_WEB;
}

/** The §8.5 wrapper, as a peer sends it. */
export interface E2eeClientHelloBody {
  readonly e2eeVersion: number;
  readonly tier: E2eeTier;
  readonly selectedSuite: number;
  readonly offeredSuites: readonly number[];
  readonly clientNonce: Uint8Array;
  readonly contextCommitment: Uint8Array;
  readonly noiseMessage1: Uint8Array;
}

export interface E2eeClientHelloInput {
  readonly tier: E2eeTier;
  readonly selectedSuite: E2eeSuiteId;
  readonly offeredSuites: readonly number[];
  readonly clientNonce: Uint8Array;
  readonly contextCommitment: Uint8Array;
  readonly noiseMessage1: Uint8Array;
}

/**
 * Encode a complete `E2EEClientHello` negotiation record (§8.5): negotiation
 * type `0x01` over the canonical-CBOR array of exactly 7 elements, bounded by
 * `E2EE_CLIENT_HELLO_MAX_BYTES` — which `encodeE2eeNegotiationRecord` enforces
 * on the framed record, so a sender cannot emit a hello its peer must reject
 * unread (§3.3, §8.6 step 1).
 *
 * `e2eeVersion` is not an input: a conforming version-1 sender emits
 * `E2EE_PROTOCOL_VERSION` and nothing else, exactly as the §8.4 prologue
 * encoder does.
 *
 * THE CLEAR WRAPPER CARRIES NO CLIENT IDENTIFIER — no account id, no client
 * key, no fingerprint, no certificate (§8.5). On IK those travel only inside
 * the encrypted Noise payload below.
 */
export function encodeE2eeClientHello(input: E2eeClientHelloInput): Uint8Array {
  if (!isE2eeTier(input.tier)) invalidRelayE2eeInput();
  if (!isE2eeSuiteId(input.selectedSuite)) invalidRelayE2eeInput();
  if (
    !Array.isArray(input.offeredSuites) ||
    input.offeredSuites.length === 0 ||
    input.offeredSuites.length > E2EE_SUITE_REGISTRY_MAX_ENTRIES ||
    !input.offeredSuites.every(isUintElement) ||
    !input.offeredSuites.includes(input.selectedSuite)
  ) {
    invalidRelayE2eeInput();
  }
  if (!isBytesElement(input.clientNonce, E2EE_HANDSHAKE_NONCE_BYTES)) invalidRelayE2eeInput();
  if (!isBytesElement(input.contextCommitment, E2EE_CONTEXT_COMMITMENT_BYTES)) {
    invalidRelayE2eeInput();
  }
  if (!isBytesElement(input.noiseMessage1) || input.noiseMessage1.byteLength === 0) {
    invalidRelayE2eeInput();
  }
  const body = encodeCanonical([
    E2EE_PROTOCOL_VERSION,
    input.tier,
    input.selectedSuite,
    [...input.offeredSuites],
    copyBytes(input.clientNonce),
    copyBytes(input.contextCommitment),
    copyBytes(input.noiseMessage1),
  ]);
  return encodeE2eeNegotiationRecord(E2EE_NEGOTIATION_TYPE_CLIENT_HELLO, body);
}

export type E2eeNegotiationBodyDecodeError =
  /**
   * §11.2 P3: the record is over its per-type bound, of the wrong type, or
   * misdirected. Decided on the framing alone, before any body parse (§3.3).
   */
  | "bad_record"
  /** §11.2 P9 / §8.8 step 1: strict decode, element shape, or an exact field length. */
  | "malformed_body";

/**
 * Decode a post-strip payload as an `E2EEClientHello` (§8.5, §8.6 steps 1–2).
 *
 * The per-type BOUND IS ENFORCED FIRST, on the framed record, without parsing
 * the body — that is §3.3's rule and §8.6 step 1's "bounds before crypto".
 * Nothing here checks the wrapper against node state: `e2eeVersion` against the
 * advertised range, `tier` against policy, and `selectedSuite` against the
 * registries are §8.6 step 2's, and this module holds no node state.
 */
export function decodeE2eeClientHello(
  payload: Uint8Array,
): E2eeDecodeResult<E2eeClientHelloBody, E2eeNegotiationBodyDecodeError> {
  const record = decodeE2eeNegotiationRecord(payload);
  if (record.kind === "error" || record.value.recordType !== E2EE_NEGOTIATION_TYPE_CLIENT_HELLO) {
    return { kind: "error", reason: "bad_record" };
  }
  const decoded = decodeCanonicalE2eeCbor(record.value.body);
  if (decoded.kind === "error") return { kind: "error", reason: "malformed_body" };
  const elements = decoded.value;
  if (!Array.isArray(elements) || elements.length !== CLIENT_HELLO_ELEMENTS) {
    return { kind: "error", reason: "malformed_body" };
  }
  const [e2eeVersion, tier, selectedSuite, offeredSuites, clientNonce, commitment, message1] =
    elements as readonly unknown[];
  if (
    !isUintElement(e2eeVersion) ||
    !isE2eeTier(tier) ||
    !isUintElement(selectedSuite) ||
    !Array.isArray(offeredSuites) ||
    offeredSuites.length === 0 ||
    offeredSuites.length > E2EE_SUITE_REGISTRY_MAX_ENTRIES ||
    !offeredSuites.every(isUintElement) ||
    !isBytesElement(clientNonce, E2EE_HANDSHAKE_NONCE_BYTES) ||
    !isBytesElement(commitment, E2EE_CONTEXT_COMMITMENT_BYTES) ||
    !isBytesElement(message1) ||
    message1.byteLength === 0
  ) {
    return { kind: "error", reason: "malformed_body" };
  }
  return {
    kind: "ok",
    value: {
      e2eeVersion,
      tier,
      selectedSuite,
      offeredSuites: offeredSuites as readonly number[],
      clientNonce,
      contextCommitment: commitment,
      noiseMessage1: message1,
    },
  };
}

/** The §8.5 IK message-1 payload — certification metadata only, never application data. */
export interface E2eeIkHelloPayload {
  /** Exact §7.4 transcript bytes. */
  readonly clientPrekeyTranscript: Uint8Array;
  /** Device-key signature over element 0 (§7.1). */
  readonly clientPrekeySignature: Uint8Array;
  readonly accountId: string;
  /** §8.3 element 11. */
  readonly intendedCapability: string;
  /** §8.3 element 12. */
  readonly intendedRole: string;
}

/** The suite-0x02 IK message-1 payload; suite 0x01 remains exactly five elements. */
export interface E2eeAccountGrantIkHelloPayload extends E2eeIkHelloPayload {
  /** Exact signed §18.3 Hub device-grant envelope. */
  readonly hubDeviceGrant: Uint8Array;
}

/**
 * The §8.5 IK message-1 payload: a canonical-CBOR array of exactly 5 elements,
 * encrypted inside `noiseMessage1`.
 *
 * §8.10 grades this payload authentication 1 / confidentiality 2 and §8.5 draws
 * the consequence: it carries certification metadata only, never application
 * data, and the responder acts on it only as §8.6 describes.
 */
export function encodeE2eeIkHelloPayload(input: E2eeIkHelloPayload): Uint8Array {
  if (!isBytesElement(input.clientPrekeyTranscript) || input.clientPrekeyTranscript.length === 0) {
    invalidRelayE2eeInput();
  }
  const signature = validateE2eeClientSignature(input.clientPrekeySignature);
  return encodeCanonical([
    copyBytes(input.clientPrekeyTranscript),
    signature,
    assertE2eeAccountId(input.accountId),
    assertRelayCapabilityLiteral(input.intendedCapability),
    assertRelayEffectiveRoleLiteral(input.intendedRole),
  ]);
}

/**
 * Decode the §8.5 IK message-1 payload (§8.6 step 5). The capability and role
 * literals are checked against the relay contract's closed vocabularies here,
 * because §8.3 element 11 MUST be a member of `RELAY_CAPABILITY_LITERALS` and
 * the context encoder would otherwise throw on peer input.
 */
export function decodeE2eeIkHelloPayload(
  payload: Uint8Array,
): E2eeDecodeResult<E2eeIkHelloPayload, "malformed_body"> {
  const decoded = decodeCanonicalE2eeCbor(payload);
  if (decoded.kind === "error") return { kind: "error", reason: "malformed_body" };
  const elements = decoded.value;
  if (!Array.isArray(elements) || elements.length !== IK_HELLO_PAYLOAD_ELEMENTS) {
    return { kind: "error", reason: "malformed_body" };
  }
  const [transcript, signature, accountId, capability, role] = elements as readonly unknown[];
  if (
    !isBytesElement(transcript) ||
    transcript.byteLength === 0 ||
    !isBytesElement(signature) ||
    !isTextElement(accountId) ||
    !isTextElement(capability) ||
    !isTextElement(role)
  ) {
    return { kind: "error", reason: "malformed_body" };
  }
  try {
    assertE2eeAccountId(accountId);
    assertRelayCapabilityLiteral(capability);
    assertRelayEffectiveRoleLiteral(role);
    validateE2eeClientSignature(signature);
  } catch {
    return { kind: "error", reason: "malformed_body" };
  }
  return {
    kind: "ok",
    value: {
      clientPrekeyTranscript: transcript,
      clientPrekeySignature: signature,
      accountId,
      intendedCapability: capability,
      intendedRole: role,
    },
  };
}

export function encodeE2eeAccountGrantIkHelloPayload(
  input: E2eeAccountGrantIkHelloPayload,
): Uint8Array {
  if (
    !isBytesElement(input.hubDeviceGrant) ||
    input.hubDeviceGrant.byteLength === 0 ||
    input.hubDeviceGrant.byteLength > E2EE_HUB_DEVICE_GRANT_MAX_BYTES
  ) {
    invalidRelayE2eeInput();
  }
  const local = decodeCanonicalE2eeCbor(encodeE2eeIkHelloPayload(input));
  if (local.kind !== "ok" || !Array.isArray(local.value)) invalidRelayE2eeInput();
  return encodeCanonical([...local.value, copyBytes(input.hubDeviceGrant)]);
}

export function decodeE2eeAccountGrantIkHelloPayload(
  payload: Uint8Array,
): E2eeDecodeResult<E2eeAccountGrantIkHelloPayload, "malformed_body"> {
  const decoded = decodeCanonicalE2eeCbor(payload);
  if (decoded.kind === "error") return { kind: "error", reason: "malformed_body" };
  const elements = decoded.value;
  if (!Array.isArray(elements) || elements.length !== ACCOUNT_GRANT_IK_HELLO_PAYLOAD_ELEMENTS) {
    return { kind: "error", reason: "malformed_body" };
  }
  const [transcript, signature, accountId, capability, role, deviceGrant] = elements;
  if (
    !(deviceGrant instanceof Uint8Array) ||
    deviceGrant.byteLength === 0 ||
    deviceGrant.byteLength > E2EE_HUB_DEVICE_GRANT_MAX_BYTES
  ) {
    return { kind: "error", reason: "malformed_body" };
  }
  const base = decodeE2eeIkHelloPayload(
    encodeCanonical([transcript, signature, accountId, capability, role]),
  );
  if (base.kind === "error") return base;
  return {
    kind: "ok",
    value: { ...base.value, hubDeviceGrant: copyBytes(deviceGrant) },
  };
}

/**
 * The NX message-1 payload (§8.5): ZERO-LENGTH, always. The NX first message
 * has no encryption keys (§8.10 grades it 0/0), nothing may ride in it, and a
 * responder MUST treat a nonempty one as a handshake failure.
 *
 * A shared singleton, which is safe here for the same reason the rule exists:
 * a zero-length array has nothing to mutate.
 */
export const E2EE_NX_HELLO_PAYLOAD: Uint8Array = new Uint8Array(0);

// ─── §8.7 `E2EEServerAccept` ─────────────────────────────────────────────────

/** Fields 0–3 of §8.7 — the `ServerAcceptTBS` content, with the confirmation absent. */
export interface E2eeServerAcceptTbsInput {
  readonly acceptedSuite: E2eeSuiteId;
  readonly nodePrekeyId: string;
  readonly contextCommitment: Uint8Array;
  readonly noiseMessage2: Uint8Array;
}

/** The §8.7 wrapper, as a peer sends it. */
export interface E2eeServerAcceptBody {
  readonly acceptedSuite: number;
  readonly nodePrekeyId: string;
  readonly contextCommitment: Uint8Array;
  readonly noiseMessage2: Uint8Array;
  readonly serverConfirmation: Uint8Array;
}

function assertServerAcceptTbsInput(input: E2eeServerAcceptTbsInput): void {
  if (!isE2eeSuiteId(input.acceptedSuite)) invalidRelayE2eeInput();
  if (!isTextElement(input.nodePrekeyId) || input.nodePrekeyId.length === 0) {
    invalidRelayE2eeInput();
  }
  if (!isBytesElement(input.contextCommitment, E2EE_CONTEXT_COMMITMENT_BYTES)) {
    invalidRelayE2eeInput();
  }
  if (!isBytesElement(input.noiseMessage2) || input.noiseMessage2.byteLength === 0) {
    invalidRelayE2eeInput();
  }
}

/**
 * `ServerAcceptTBS` (§8.7): the negotiation record whose body is the
 * canonical-CBOR 4-element array of fields 0–3, THE CONFIRMATION FIELD ABSENT.
 *
 * "Wire bytes" in §8.7 always means the complete post-strip negotiation record
 * — discriminator, record type, and body — so this returns a framed record and
 * not a bare body. It is never transmitted: both endpoints rebuild it, the
 * responder from what it is about to send and the client from fields 0–3 of
 * what it received.
 *
 * THE CONFIRMATION MAC NEVER INCLUDES ITSELF. It covers these bytes, not the
 * final record; §8.8's session binding covers the finished record, which is why
 * there is no self-reference cycle.
 */
export function encodeE2eeServerAcceptTbs(input: E2eeServerAcceptTbsInput): Uint8Array {
  assertServerAcceptTbsInput(input);
  const body = encodeCanonical([
    input.acceptedSuite,
    input.nodePrekeyId,
    copyBytes(input.contextCommitment),
    copyBytes(input.noiseMessage2),
  ]);
  return encodeE2eeNegotiationRecord(E2EE_NEGOTIATION_TYPE_SERVER_ACCEPT, body);
}

/**
 * The final `E2EEServerAccept` record (§8.7): the 5-element body, field 4 being
 * the `serverConfirmation` computed over `ServerAcceptTBS`. Bounded by
 * `E2EE_SERVER_ACCEPT_MAX_BYTES`, enforced by the framing encoder.
 */
export function encodeE2eeServerAccept(
  input: E2eeServerAcceptTbsInput & { readonly serverConfirmation: Uint8Array },
): Uint8Array {
  assertServerAcceptTbsInput(input);
  if (!isBytesElement(input.serverConfirmation, E2EE_CONFIRMATION_BYTES)) invalidRelayE2eeInput();
  const body = encodeCanonical([
    input.acceptedSuite,
    input.nodePrekeyId,
    copyBytes(input.contextCommitment),
    copyBytes(input.noiseMessage2),
    copyBytes(input.serverConfirmation),
  ]);
  return encodeE2eeNegotiationRecord(E2EE_NEGOTIATION_TYPE_SERVER_ACCEPT, body);
}

/** Decode a post-strip payload as an `E2EEServerAccept` (§8.8 step 1). */
export function decodeE2eeServerAccept(
  payload: Uint8Array,
): E2eeDecodeResult<E2eeServerAcceptBody, E2eeNegotiationBodyDecodeError> {
  const record = decodeE2eeNegotiationRecord(payload);
  if (record.kind === "error" || record.value.recordType !== E2EE_NEGOTIATION_TYPE_SERVER_ACCEPT) {
    return { kind: "error", reason: "bad_record" };
  }
  const decoded = decodeCanonicalE2eeCbor(record.value.body);
  if (decoded.kind === "error") return { kind: "error", reason: "malformed_body" };
  const elements = decoded.value;
  if (!Array.isArray(elements) || elements.length !== SERVER_ACCEPT_ELEMENTS) {
    return { kind: "error", reason: "malformed_body" };
  }
  const [acceptedSuite, nodePrekeyId, commitment, message2, confirmation] =
    elements as readonly unknown[];
  if (
    !isUintElement(acceptedSuite) ||
    !isTextElement(nodePrekeyId) ||
    nodePrekeyId.length === 0 ||
    !isBytesElement(commitment, E2EE_CONTEXT_COMMITMENT_BYTES) ||
    !isBytesElement(message2) ||
    message2.byteLength === 0 ||
    !isBytesElement(confirmation, E2EE_CONFIRMATION_BYTES)
  ) {
    return { kind: "error", reason: "malformed_body" };
  }
  return {
    kind: "ok",
    value: {
      acceptedSuite,
      nodePrekeyId,
      contextCommitment: commitment,
      noiseMessage2: message2,
      serverConfirmation: confirmation,
    },
  };
}

/** The §8.7 message-2 payload — the node-received authority and the prekey binding. */
export interface E2eeServerAcceptPayload {
  /** The `channel.open.capability` the node received (§8.3 element 13). */
  readonly channelOpenCapability: string;
  /** The `channel.open.effectiveRole` the node received (§8.3 element 14). */
  readonly channelOpenEffectiveRole: string;
  /** `ryco.e2ee-agreement-key.v1` fingerprint of the responder static used. */
  readonly nodeAgreementKeyFingerprint: Uint8Array;
}

/**
 * The §8.7 message-2 payload, in both patterns: a canonical-CBOR array of
 * exactly 3 elements. On NX it is encrypted to an ANONYMOUS EPHEMERAL INITIATOR
 * (§8.10), which is why its contents are limited to relay-visible authority
 * fields and a public fingerprint.
 */
export function encodeE2eeServerAcceptPayload(input: E2eeServerAcceptPayload): Uint8Array {
  if (!isBytesElement(input.nodeAgreementKeyFingerprint, E2EE_KEY_FINGERPRINT_BYTES)) {
    invalidRelayE2eeInput();
  }
  return encodeCanonical([
    assertRelayCapabilityLiteral(input.channelOpenCapability),
    assertRelayEffectiveRoleLiteral(input.channelOpenEffectiveRole),
    copyBytes(input.nodeAgreementKeyFingerprint),
  ]);
}

/** Decode the §8.7 message-2 payload (§8.8 step 4). */
export function decodeE2eeServerAcceptPayload(
  payload: Uint8Array,
): E2eeDecodeResult<E2eeServerAcceptPayload, "malformed_body"> {
  const decoded = decodeCanonicalE2eeCbor(payload);
  if (decoded.kind === "error") return { kind: "error", reason: "malformed_body" };
  const elements = decoded.value;
  if (!Array.isArray(elements) || elements.length !== ACCEPT_PAYLOAD_ELEMENTS) {
    return { kind: "error", reason: "malformed_body" };
  }
  const [capability, role, fingerprint] = elements as readonly unknown[];
  if (
    !isTextElement(capability) ||
    !isTextElement(role) ||
    !isBytesElement(fingerprint, E2EE_KEY_FINGERPRINT_BYTES)
  ) {
    return { kind: "error", reason: "malformed_body" };
  }
  return {
    kind: "ok",
    value: {
      channelOpenCapability: capability,
      channelOpenEffectiveRole: role,
      nodeAgreementKeyFingerprint: fingerprint,
    },
  };
}

// ─── §8.7 confirmation and §8.8 session binding ──────────────────────────────

/**
 * Embed a §8.3 context block as the NESTED CANONICAL ARRAY ITSELF, not as a
 * byte string (§8.7). The two wire-byte elements around it are byte strings
 * with explicit CBOR boundaries, so no consumer concatenates transcript fields
 * ad hoc.
 *
 * The block is decoded under the §3.6 profile — which includes the re-encode
 * byte-equality rule — so a non-canonical block cannot be spliced in as an
 * array that re-encodes to different bytes than the ones the commitment was
 * taken over.
 */
function contextBlockArray(contextBlock: Uint8Array): readonly unknown[] {
  const decoded = decodeCanonicalE2eeCbor(contextBlock);
  if (decoded.kind === "error" || !Array.isArray(decoded.value)) invalidRelayE2eeInput();
  return decoded.value as readonly unknown[];
}

export interface E2eeConfirmationTranscriptInput {
  /** The EXACT `E2EEClientHello` wire bytes — the complete post-strip record. */
  readonly clientHelloWireBytes: Uint8Array;
  /** The EXACT `ServerAcceptTBS` wire bytes (§8.7). */
  readonly serverAcceptTbsWireBytes: Uint8Array;
  /** The §8.3 context block, canonical CBOR. */
  readonly contextBlock: Uint8Array;
}

/**
 * `confirmationTranscript` (§8.7):
 * `SHA-256(canonical-CBOR([ "ryco.relay-e2ee.confirmation.v1", bstr(hello wire
 * bytes), bstr(ServerAcceptTBS wire bytes), contextBlock ]))`.
 *
 * Hashing EXACT WIRE BYTES binds the offered-suite list, the Noise messages,
 * any future extension bytes, and — through `contextBlock` — the full
 * authorization context. Suite-list stripping, role or capability escalation,
 * node substitution, and cross-account splice each change one of the hashed
 * inputs and MUST break confirmation or fail the §8.3/§8.6 checks.
 */
export function e2eeConfirmationTranscript(input: E2eeConfirmationTranscriptInput): Uint8Array {
  if (
    !isBytesElement(input.clientHelloWireBytes) ||
    input.clientHelloWireBytes.byteLength === 0 ||
    !isBytesElement(input.serverAcceptTbsWireBytes) ||
    input.serverAcceptTbsWireBytes.byteLength === 0
  ) {
    invalidRelayE2eeInput();
  }
  return sha256(
    encodeCanonical([
      E2EE_CONFIRMATION_DOMAIN,
      copyBytes(input.clientHelloWireBytes),
      copyBytes(input.serverAcceptTbsWireBytes),
      contextBlockArray(input.contextBlock),
    ]),
  );
}

/**
 * `serverConfirmation = HMAC-SHA256(serverConfirmationKey,
 * confirmationTranscript)` (§8.7), of length `E2EE_CONFIRMATION_BYTES`.
 *
 * `serverConfirmationKey` is derived from `exporterSecret` by
 * `relayE2eeSession`, which owns the whole §6.5 schedule; this is the one place
 * that key is used.
 */
export function e2eeServerConfirmation(
  serverConfirmationKey: Uint8Array,
  confirmationTranscript: Uint8Array,
): Uint8Array {
  if (
    !isBytesElement(serverConfirmationKey) ||
    !isBytesElement(confirmationTranscript, E2EE_CONFIRMATION_BYTES)
  ) {
    invalidRelayE2eeInput();
  }
  return hmac(sha256, serverConfirmationKey, confirmationTranscript);
}

export interface E2eeSessionBindingInput {
  readonly clientHelloWireBytes: Uint8Array;
  /** The EXACT FINAL `E2EEServerAccept` wire bytes — confirmation included. */
  readonly serverAcceptWireBytes: Uint8Array;
  readonly contextBlock: Uint8Array;
}

/**
 * `sessionBindingHash` (§8.8):
 * `SHA-256(canonical-CBOR([ "ryco.relay-e2ee.session.v1", bstr(hello wire
 * bytes), bstr(final accept wire bytes), contextBlock ]))`, of length
 * `E2EE_SESSION_BINDING_HASH_BYTES`.
 *
 * It includes the final confirmation, inside the final record bytes, WITHOUT a
 * self-reference cycle: confirmation covers TBS, session binding covers the
 * finished record. The node computes the identical value from the bytes it
 * emitted, and the value enters the AAD of every envelope (§3.3, §9).
 */
export function e2eeSessionBindingHash(input: E2eeSessionBindingInput): Uint8Array {
  if (
    !isBytesElement(input.clientHelloWireBytes) ||
    input.clientHelloWireBytes.byteLength === 0 ||
    !isBytesElement(input.serverAcceptWireBytes) ||
    input.serverAcceptWireBytes.byteLength === 0
  ) {
    invalidRelayE2eeInput();
  }
  const hash = sha256(
    encodeCanonical([
      E2EE_SESSION_BINDING_DOMAIN,
      copyBytes(input.clientHelloWireBytes),
      copyBytes(input.serverAcceptWireBytes),
      contextBlockArray(input.contextBlock),
    ]),
  );
  if (hash.byteLength !== E2EE_SESSION_BINDING_HASH_BYTES) invalidRelayE2eeInput();
  return hash;
}

// ─── §8.6 step 5: the client agreement-prekey certificate ────────────────────

const CLIENT_PREKEY_TRANSCRIPT_ELEMENTS = 11;

/** The decoded §7.4 certificate fields §8.6 step 5 acts on. */
export interface E2eeClientPrekeyCertificate {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly identityPublicKey: Uint8Array;
  readonly identityFingerprint: Uint8Array;
  readonly agreementPublicKey: Uint8Array;
  readonly agreementFingerprint: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type E2eeClientPrekeyFailure =
  | "malformed"
  | "hub_origin_mismatch"
  | "usage_mismatch"
  | "invalid_signature"
  | "expired";

export type E2eeClientPrekeyResult =
  | { readonly kind: "ok"; readonly certificate: E2eeClientPrekeyCertificate }
  | { readonly kind: "error"; readonly failure: E2eeClientPrekeyFailure };

export interface E2eeClientPrekeyVerification {
  readonly transcript: Uint8Array;
  readonly signature: Uint8Array;
  /** The channel's Hub origin; the certificate's MUST equal it (§8.6 step 5). */
  readonly hubOrigin: string;
  /** The negotiated suite, whose usage fields the certificate MUST match. */
  readonly suite: E2eeSuiteId;
  readonly now: number;
}

/**
 * §8.6 step 5, over the §7.4 certificate: re-encode equality, domain, formats,
 * point validation, device-key signature, fingerprint recomputation, and
 * validity with `E2EE_MAX_CLOCK_SKEW`.
 *
 * THE RE-ENCODE EQUALITY IS AGAINST THE §7.4 ENCODER ITSELF, not against a
 * second copy of its element list. The decoded fields are handed back to
 * `encodeClientE2eePrekeyTranscript` and the result must byte-equal the
 * received transcript, so the domain string, the algorithm label, the element
 * order, the derived identity fingerprint, and the §7.4 usage fields are all
 * checked by construction — a certificate carrying a fingerprint that disagrees
 * with its identity key cannot re-encode to itself (§7.1).
 *
 * `verifyE2eeSignature` is the single verification choke point (§7.1, §14.3);
 * nothing here reaches a curve library.
 */
export function verifyE2eeClientPrekeyCertificate(
  input: E2eeClientPrekeyVerification,
): E2eeClientPrekeyResult {
  const decoded = decodeCanonicalE2eeCbor(input.transcript);
  if (decoded.kind === "error") return { kind: "error", failure: "malformed" };
  const elements = decoded.value;
  if (!Array.isArray(elements) || elements.length !== CLIENT_PREKEY_TRANSCRIPT_ELEMENTS) {
    return { kind: "error", failure: "malformed" };
  }
  const [
    ,
    hubOrigin,
    accountId,
    algorithm,
    identityPublicKey,
    identityFingerprint,
    agreementPublicKey,
    dh,
    hash,
    createdAt,
    expiresAt,
  ] = elements as readonly unknown[];
  if (
    !isTextElement(hubOrigin) ||
    !isTextElement(accountId) ||
    algorithm !== E2EE_CLIENT_IDENTITY_ALGORITHM ||
    !isBytesElement(identityPublicKey, P256_PUBLIC_KEY_BYTES) ||
    !isBytesElement(identityFingerprint, E2EE_KEY_FINGERPRINT_BYTES) ||
    !isBytesElement(agreementPublicKey, E2EE_AGREEMENT_PUBLIC_KEY_BYTES) ||
    !isTextElement(dh) ||
    !isTextElement(hash) ||
    !isUintElement(createdAt) ||
    !isUintElement(expiresAt)
  ) {
    return { kind: "error", failure: "malformed" };
  }

  let reencoded: Uint8Array;
  let agreementFingerprint: Uint8Array;
  try {
    validateE2eeClientIdentityPublicKey(identityPublicKey);
    validateE2eeAgreementPublicKey(agreementPublicKey);
    validateE2eeClientSignature(input.signature);
    reencoded = encodeClientE2eePrekeyTranscript({
      hubOrigin,
      accountId,
      identityPublicKey,
      agreementPublicKey,
      createdAt,
      expiresAt,
    });
    agreementFingerprint = e2eeKeyFingerprint("agreement", agreementPublicKey);
  } catch {
    return { kind: "error", failure: "malformed" };
  }
  if (!e2eeSecretBytesEqual(reencoded, input.transcript)) {
    return { kind: "error", failure: "malformed" };
  }

  // The certificate's Hub origin MUST equal the channel's (§8.6 step 5). The
  // re-encode above already proved the carried origin canonical, so this is a
  // comparison of two canonical origins.
  if (hubOrigin !== input.hubOrigin) return { kind: "error", failure: "hub_origin_mismatch" };

  const usage = e2eeSuiteNoiseUsage(input.suite);
  if (dh !== usage.dh || hash !== usage.hash) return { kind: "error", failure: "usage_mismatch" };

  if (
    !verifyE2eeSignature({
      algorithm: E2EE_CLIENT_IDENTITY_ALGORITHM,
      publicKey: identityPublicKey,
      message: input.transcript,
      signature: input.signature,
    })
  ) {
    return { kind: "error", failure: "invalid_signature" };
  }

  // §6.4: the lifetime bound, and expiry evaluated at handshake time only,
  // against the verifier's clock with at most `E2EE_MAX_CLOCK_SKEW` allowance.
  if (
    expiresAt <= createdAt ||
    expiresAt - createdAt > E2EE_PREKEY_LIFETIME ||
    input.now + E2EE_MAX_CLOCK_SKEW < createdAt ||
    input.now - E2EE_MAX_CLOCK_SKEW > expiresAt
  ) {
    return { kind: "error", failure: "expired" };
  }

  return {
    kind: "ok",
    certificate: {
      hubOrigin,
      accountId,
      identityPublicKey,
      identityFingerprint,
      agreementPublicKey,
      agreementFingerprint,
      createdAt,
      expiresAt,
    },
  };
}

// ─── failure surfaces ────────────────────────────────────────────────────────

/**
 * The §11.2 row a failure enumerates. LOCAL DIAGNOSIS ONLY: §11.2 requires
 * every pre-key failure to be externally indistinguishable, and §16.2 requires
 * a fixture to name exactly one row.
 */
export type E2eePreKeyRow =
  /** Negotiation record over its per-type bound, of an unknown type, or misdirected. */
  | "P3"
  /** A second hello on the channel, or an accept with no hello sent. */
  | "P4"
  /** A §15 concurrency, rate, or size bound exceeded. */
  | "P8"
  /** Hello wrapper failure (§8.6 step 2). */
  | "P9"
  /** Noise processing failure (§8.1, §8.6 step 4, §8.8 step 3). */
  | "P10"
  /** IK binding failure (§8.6 step 5). */
  | "P11"
  /** Authorization failure, including the in-flight withdrawal abort (§8.6 step 6, §13.6). */
  | "P12"
  /** Context mismatch (§8.3, §8.6 step 7, §8.8). */
  | "P13"
  /** `E2EEServerAccept` without a sent hello, or failing any §8.8 step 1–5 check. */
  | "P16"
  /** `T_HANDSHAKE` expiry after hello emit without a valid accept (§4.4 K15). */
  | "P20"
  /** Policy-withdrawal in-flight abort (§12.6, §8.6 step 2). */
  | "P25";

export type E2eeHandshakeFailureReason =
  | "attempt_not_admitted"
  | "record_bounds"
  | "handshake_spent"
  | "wrapper"
  | "noise"
  | "nx_payload_not_empty"
  | "client_binding"
  | "authorization"
  | "authorization_withdrawn"
  | "policy_withdrawn"
  | "context_mismatch"
  | "accept_mismatch"
  | "confirmation_mismatch"
  | "handshake_deadline";

export interface E2eeHandshakeFailure {
  readonly kind: "fatal";
  readonly row: E2eePreKeyRow;
  readonly reason: E2eeHandshakeFailureReason;
}

function fatal(row: E2eePreKeyRow, reason: E2eeHandshakeFailureReason): E2eeHandshakeFailure {
  return { kind: "fatal", row, reason };
}

// ─── shared handshake inputs ─────────────────────────────────────────────────

/** The channel state both endpoints build §8.3 and §8.4 from. */
export interface E2eeHandshakeChannel {
  /** The canonical Hub origin THIS endpoint is actually connected to (§8.3 element 1). */
  readonly hubOrigin: string;
  readonly channelId: string;
  readonly relayProtocolMajor: number;
  readonly relayProtocolMinor: number;
  /** The `channel.open.capability` THIS endpoint received (§8.3 element 13). */
  readonly channelOpenCapability: string;
  /** The `channel.open.effectiveRole` THIS endpoint received (§8.3 element 14). */
  readonly channelOpenEffectiveRole: string;
  /** Relay-minor-3 context delivered on both authenticated Hub paths for suite 0x02. */
  readonly accountGrantContext?:
    | {
        readonly relayTicketId: string;
        readonly deviceGrantDigest: Uint8Array;
        readonly nodeCapabilityStatementDigest: Uint8Array;
      }
    | undefined;
}

/**
 * The node material of §8.3 elements 7–9, 15, and 17, pinned to the statement
 * advertised ON THIS CHANNEL (§8.3 construction rules, §7.5, §15's per-channel
 * advertised-statement snapshot).
 *
 * On the node this is its own advertisement snapshot and never its current
 * state: an identity rotation, a chain append, a chain prune, or a prekey
 * rotation landing between advertisement emit and hello arrival does NOT
 * retroactively change an open channel's context. On the client it comes from
 * the statement it validated on this channel — except `nodeIdentityFingerprint`
 * and `continuityId`, which follow §8.3's provenance rule: from the resolved
 * verified pin where one exists, and from the validated statement only on
 * genuine first contact and on the web tier.
 *
 * The agreement FINGERPRINT is not a field here: §7.1 requires every
 * fingerprint to be recomputed from the algorithm-labelled raw public key, and
 * both endpoints hold that key.
 */
export interface E2eeAdvertisedChannelMaterial {
  readonly nodeId: string;
  /** `ryco.node-key.v1` (§8.3 element 9). */
  readonly nodeIdentityFingerprint: Uint8Array;
  /** §7.6 element 10 member 0; echoed as `E2EEServerAccept` field 1. */
  readonly prekeyId: string;
  /** The node agreement prekey advertised on this channel (§6.4). */
  readonly agreementPublicKey: Uint8Array;
  /** Exact §7.5 transcript bytes, in chain order; empty for a node that never rotated. */
  readonly continuityChainTranscripts: readonly Uint8Array[];
  /** §7.6 element 18 (§8.3 element 17). Nonempty on BOTH tiers. */
  readonly continuityId: string;
  /** §18.3 element 26; required only by the account-enrolled suite. */
  readonly policyGeneration?: number | undefined;
  /** SHA-256 of the exact signed capability statement; required only by suite 0x02. */
  readonly capabilityStatementDigest?: Uint8Array | undefined;
}

interface E2eeNativeClientHandshakeKeyMaterial {
  readonly tier: "native";
  readonly accountId: string;
  /** P-256 client identity key; its `ryco.client-key.v1` fingerprint is recomputed here. */
  readonly identityPublicKey: Uint8Array;
  /** X25519 client agreement key, the Noise `s` of IK. */
  readonly agreementPublicKey: Uint8Array;
  readonly agreementSecretKey: Uint8Array;
  /** Exact §7.4 transcript bytes. */
  readonly prekeyTranscript: Uint8Array;
  readonly prekeySignature: Uint8Array;
}

/**
 * Client credentials, split by trust source so Web cannot represent a grant
 * and a native account grant cannot accidentally run as the local suite.
 * `trustSource` remains optional only on the legacy local arm so existing
 * suite-0x01 callers retain their exact source shape and bytes.
 */
export type E2eeClientHandshakeCredentials =
  | (E2eeNativeClientHandshakeKeyMaterial & {
      readonly trustSource?: "locally-verified" | undefined;
    })
  | (E2eeNativeClientHandshakeKeyMaterial & {
      readonly trustSource: "account-enrolled";
      /** Result of `verifyHubDeviceGrant`; exact envelope bytes are retained. */
      readonly deviceGrant: DecodedHubDeviceGrant;
    })
  | { readonly tier: "web"; readonly trustSource?: "web-unsigned" | undefined };

type E2eeAccountGrantClientCredentials = Extract<
  E2eeClientHandshakeCredentials,
  { readonly trustSource: "account-enrolled" }
>;

function isAccountGrantCredentials(
  credentials: E2eeClientHandshakeCredentials,
): credentials is E2eeAccountGrantClientCredentials {
  return credentials.tier === "native" && credentials.trustSource === "account-enrolled";
}

function e2eeHandshakeTrustSource(tier: E2eeTier, suite: E2eeSuiteId): NativeE2eeTrustSource {
  if (tier === "web") return "web-unsigned";
  return suite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256
    ? "account-enrolled"
    : "locally-verified";
}

function buildContext(input: {
  readonly channel: E2eeHandshakeChannel;
  readonly advertised: E2eeAdvertisedChannelMaterial;
  readonly suite: E2eeSuiteId;
  readonly intendedCapability: string;
  readonly intendedRole: string;
  readonly client:
    | {
        readonly tier: "native";
        readonly accountId: string;
        readonly identityFingerprint: Uint8Array;
        readonly agreementFingerprint: Uint8Array;
      }
    | { readonly tier: "web" };
}): { readonly block: Uint8Array; readonly commitment: Uint8Array } {
  const block = encodeE2eeAuthorizationContext({
    hubOrigin: input.channel.hubOrigin,
    channelId: input.channel.channelId,
    relayProtocolMajor: input.channel.relayProtocolMajor,
    relayProtocolMinor: input.channel.relayProtocolMinor,
    e2eeVersion: E2EE_PROTOCOL_VERSION,
    suiteId: input.suite,
    nodeId: input.advertised.nodeId,
    nodeIdentityFingerprint: input.advertised.nodeIdentityFingerprint,
    clientIntendedCapability: input.intendedCapability,
    clientIntendedRole: input.intendedRole,
    channelOpenCapability: input.channel.channelOpenCapability,
    channelOpenEffectiveRole: input.channel.channelOpenEffectiveRole,
    nodeAgreementFingerprint: e2eeKeyFingerprint("agreement", input.advertised.agreementPublicKey),
    nodeContinuityChainTranscripts: input.advertised.continuityChainTranscripts,
    nodeContinuityId: input.advertised.continuityId,
    client: input.client,
  });
  return { block, commitment: e2eeAuthorizationContextCommitment(block) };
}

function accountGrantBindingsMatch(input: {
  readonly channel: E2eeHandshakeChannel;
  readonly advertised: E2eeAdvertisedChannelMaterial;
  readonly grant: DecodedHubDeviceGrant;
  readonly certificate: E2eeClientPrekeyCertificate;
  readonly certificateDigest: Uint8Array;
  readonly intendedCapability: string;
  readonly intendedRole: string;
}): boolean {
  const { channel, advertised, grant, certificate } = input;
  const claims = grant.claims;
  const grantContext = channel.accountGrantContext;
  const statementDigest = advertised.capabilityStatementDigest;
  const policyGeneration = advertised.policyGeneration;
  return (
    channel.relayProtocolMajor === 1 &&
    channel.relayProtocolMinor >= 3 &&
    grantContext !== undefined &&
    statementDigest instanceof Uint8Array &&
    Number.isSafeInteger(policyGeneration) &&
    policyGeneration !== undefined &&
    claims.suiteId === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 &&
    claims.issuerHubOrigin === channel.hubOrigin &&
    claims.accountId === certificate.accountId &&
    claims.nodeId === advertised.nodeId &&
    claims.nodeContinuityId === advertised.continuityId &&
    claims.nodePolicyGeneration === policyGeneration &&
    claims.relayTicketId === grantContext.relayTicketId &&
    claims.capabilities.some((capability) => capability === input.intendedCapability) &&
    e2eeRoleWithinCeiling(input.intendedRole, claims.maximumRole) &&
    e2eeSecretBytesEqual(grant.grantDigest, sha256(grant.envelope)) &&
    e2eeSecretBytesEqual(grant.grantDigest, grantContext.deviceGrantDigest) &&
    e2eeSecretBytesEqual(
      claims.nodeCapabilityStatementDigest,
      grantContext.nodeCapabilityStatementDigest,
    ) &&
    e2eeSecretBytesEqual(claims.nodeCapabilityStatementDigest, statementDigest) &&
    e2eeSecretBytesEqual(claims.clientPrekeyCertificateDigest, input.certificateDigest) &&
    e2eeSecretBytesEqual(claims.deviceIdentityPublicKey, certificate.identityPublicKey) &&
    e2eeSecretBytesEqual(claims.deviceIdentityFingerprint, certificate.identityFingerprint) &&
    e2eeSecretBytesEqual(claims.deviceAgreementPublicKey, certificate.agreementPublicKey) &&
    e2eeSecretBytesEqual(claims.deviceAgreementFingerprint, certificate.agreementFingerprint) &&
    e2eeSecretBytesEqual(claims.nodeIdentityFingerprint, advertised.nodeIdentityFingerprint) &&
    e2eeSecretBytesEqual(claims.nodeAgreementPublicKey, advertised.agreementPublicKey) &&
    e2eeSecretBytesEqual(
      claims.nodeAgreementFingerprint,
      e2eeKeyFingerprint("agreement", advertised.agreementPublicKey),
    )
  );
}

function buildAccountGrantContext(input: {
  readonly channel: E2eeHandshakeChannel;
  readonly advertised: E2eeAdvertisedChannelMaterial;
  readonly grant: DecodedHubDeviceGrant;
  readonly certificate: E2eeClientPrekeyCertificate;
  readonly certificateDigest: Uint8Array;
  readonly intendedCapability: string;
  readonly intendedRole: string;
}): { readonly block: Uint8Array; readonly commitment: Uint8Array } {
  if (!accountGrantBindingsMatch(input)) invalidRelayE2eeInput();
  const block = encodeE2eeAccountGrantAuthorizationContext({
    hubOrigin: input.channel.hubOrigin,
    channelId: input.channel.channelId,
    relayProtocolMajor: input.channel.relayProtocolMajor,
    relayProtocolMinor: input.channel.relayProtocolMinor,
    e2eeVersion: E2EE_PROTOCOL_VERSION,
    suiteId: E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
    nodeId: input.advertised.nodeId,
    nodeIdentityFingerprint: input.advertised.nodeIdentityFingerprint,
    clientIntendedCapability: input.intendedCapability,
    clientIntendedRole: input.intendedRole,
    channelOpenCapability: input.channel.channelOpenCapability,
    channelOpenEffectiveRole: input.channel.channelOpenEffectiveRole,
    nodeAgreementFingerprint: e2eeKeyFingerprint("agreement", input.advertised.agreementPublicKey),
    nodeContinuityChainTranscripts: input.advertised.continuityChainTranscripts,
    nodeContinuityId: input.advertised.continuityId,
    client: {
      tier: "native",
      accountId: input.certificate.accountId,
      identityFingerprint: input.certificate.identityFingerprint,
      agreementFingerprint: input.certificate.agreementFingerprint,
    },
    grant: input.grant.claims,
    deviceGrantDigest: input.grant.grantDigest,
  });
  return { block, commitment: e2eeAuthorizationContextCommitment(block) };
}

/**
 * §8.3: element 11 MUST equal element 13 and element 12 MUST equal element 14,
 * AT BOTH ENDPOINTS. A silent role reduction — the received effective role
 * differing from the committed role in EITHER DIRECTION — is a context
 * mismatch, and the handshake fails rather than proceeding at the lower
 * authority.
 */
function intentMatchesChannelOpen(
  channel: E2eeHandshakeChannel,
  intendedCapability: string,
  intendedRole: string,
): boolean {
  return (
    intendedCapability === channel.channelOpenCapability &&
    intendedRole === channel.channelOpenEffectiveRole
  );
}

// ─── §4.4 deadlines ──────────────────────────────────────────────────────────

/** §4.4 K15: the client deadline, from hello emit. */
export function e2eeClientHandshakeDeadline(helloEmittedAt: number): number {
  return helloEmittedAt + T_HANDSHAKE;
}

/**
 * §4.4 N8 and §8.9: the node deadline, from ADVERTISEMENT EMIT, extending
 * through the `e2ee` state until the implicit client finish authenticates.
 */
export function e2eeNodeHandshakeDeadline(advertisementEmittedAt: number): number {
  return advertisementEmittedAt + T_HANDSHAKE_NODE;
}

// ─── the client handshake (§8.5, §8.8) ───────────────────────────────────────

export interface E2eeClientHandshakeOptions {
  readonly channel: E2eeHandshakeChannel;
  readonly advertised: E2eeAdvertisedChannelMaterial;
  /** The client's selection (§8.2). `selectE2eeSuite` produces it. */
  readonly selectedSuite: E2eeSuiteId;
  /** The client's COMPLETE ordered local suite-preference list (§8.5 element 3). */
  readonly offeredSuites: readonly number[];
  readonly credentials: E2eeClientHandshakeCredentials;
  /** §8.3 element 11 — the capability this client commits to exercise. */
  readonly intendedCapability: string;
  /** §8.3 element 12 — the role this client commits to exercise. */
  readonly intendedRole: string;
  /**
   * TEST AND FIXTURE-GENERATOR USE ONLY (§16.1). Production callers MUST omit
   * both, so the nonce and the ephemeral come from the §14.5 CSPRNG.
   */
  readonly testOnlyClientNonce?: Uint8Array | undefined;
  readonly testOnlyEphemeralSecretKey?: Uint8Array | undefined;
}

export type E2eeClientHelloResult =
  | {
      readonly kind: "hello";
      /** The complete post-strip record to send, and the bytes §8.7/§8.8 hash. */
      readonly record: Uint8Array;
      readonly contextBlock: Uint8Array;
      readonly contextCommitment: Uint8Array;
      readonly prologue: Uint8Array;
      /** §4.4 K15: `T_HANDSHAKE` starts here. */
      readonly deadlineAt: number;
    }
  | E2eeHandshakeFailure;

export type E2eeClientEstablishedResult =
  | {
      readonly kind: "established";
      /** §8.8 step 6; enters the AAD of every envelope (§3.3, §9). */
      readonly sessionBindingHash: Uint8Array;
      /** §6.5 secrets; OWNERSHIP TRANSFERS to the caller, which erases them (§9.5). */
      readonly secrets: E2eeSessionSecrets;
      readonly suite: E2eeSuiteId;
      readonly trustSource: NativeE2eeTrustSource;
      readonly contextBlock: Uint8Array;
      readonly serverAcceptTbs: Uint8Array;
      readonly confirmationTranscript: Uint8Array;
      /**
       * This client's own Noise ephemeral public key for this handshake (§6.2),
       * present ON THE WEB ARM ALONE and consumed by exactly one caller: §13.5's
       * `WebSAS`. Public material, never a session secret.
       *
       * ABSENT — not `undefined`-valued — whenever the credentials took the
       * `{ tier: "native" }` arm. §13.5 exists because web has no long-term
       * client identity; the native tier's owner-facing value is §13.4's
       * long-term safety number, computed from the client identity key and never
       * from an ephemeral. An IK result that carried one would be a per-session
       * string the native surfaces have no honest use for, so the field is
       * populated from the credentials union rather than from the presence of an
       * ephemeral, which BOTH patterns transmit.
       */
      readonly webEphemeralPublicKey?: Uint8Array;
    }
  | E2eeHandshakeFailure;

type ClientState = "created" | "hello_sent" | "established" | "failed";

/**
 * The client half of §8 — the Noise INITIATOR in both patterns (§8.1).
 *
 * SINGLE USE, ONE ATTEMPT PER CHANNEL (§4.4, §8.1): after the accept is
 * verified, or after any failure, every operation returns `handshake_spent`. A
 * retry requires a fresh ticket, channel, and handshake.
 */
export class E2eeClientHandshake {
  readonly #options: E2eeClientHandshakeOptions;
  readonly #tier: E2eeTier;
  #state: ClientState = "created";
  #noise: E2eeNoiseHandshake | undefined;
  #helloRecord: Uint8Array | undefined;
  #contextBlock: Uint8Array | undefined;
  #contextCommitment: Uint8Array | undefined;
  #deadlineAt: number | undefined;

  constructor(options: E2eeClientHandshakeOptions) {
    if (!isE2eeSuiteId(options.selectedSuite)) {
      throw new TypeError("Relay E2EE client handshake requires a registered suite selection.");
    }
    const accountSuite = options.selectedSuite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256;
    if (
      accountSuite !== isAccountGrantCredentials(options.credentials) ||
      (accountSuite &&
        (options.credentials.tier !== "native" ||
          options.channel.relayProtocolMajor !== 1 ||
          options.channel.relayProtocolMinor < 3 ||
          options.channel.accountGrantContext === undefined)) ||
      (!accountSuite && options.channel.accountGrantContext !== undefined)
    ) {
      throw new TypeError("Relay E2EE suite, trust source, and channel context do not agree.");
    }
    this.#options = options;
    this.#tier = options.credentials.tier;
  }

  get tier(): E2eeTier {
    return this.#tier;
  }

  get state(): ClientState {
    return this.#state;
  }

  /** §4.4 K15: `T_HANDSHAKE` from hello emit; `undefined` before the hello. */
  get deadlineAt(): number | undefined {
    return this.#deadlineAt;
  }

  /** §4.4 K15 / §11.2 P20. */
  deadlineExpired(now: number): boolean {
    return this.#deadlineAt !== undefined && now > this.#deadlineAt;
  }

  /**
   * Build the §8.5 hello: the §8.3 context block and its commitment, the §8.4
   * prologue, the tier's Noise first message with its payload, and the wrapper.
   *
   * The context is built from THIS CLIENT'S OWN state — its selection, the
   * authority it is willing to exercise, and the `channel.open` it received —
   * and never from relay frames it later receives (§8.3).
   *
   * THE WHOLE BODY RUNS INSIDE THE LOCAL FAILURE FUNNEL. Every step of it can
   * throw on material this client holds — the §8.3 context encoder, the §8.4
   * prologue encoder, the §7.4 payload encoder, the agreement-key self-check,
   * and the §8.5 hello encoder, which validates the offered suites and enforces
   * `E2EE_CLIENT_HELLO_MAX_BYTES` after the Noise write has already produced a
   * live handshake. An escaping throw would leave this object in `created` with
   * that handshake dropped un-erased, and `created` is re-enterable: §8.1 admits
   * exactly one handshake attempt per channel, so the funnel spends the object.
   */
  createHello(now: number): E2eeClientHelloResult {
    if (this.#state !== "created") return this.#fail(fatal("P4", "handshake_spent"));
    let noise: E2eeNoiseHandshake | undefined;
    try {
      return this.#createHello(now, (created) => {
        noise = created;
      });
    } catch (error) {
      noise?.destroy();
      this.destroy();
      throw error;
    }
  }

  #createHello(now: number, holdNoise: (noise: E2eeNoiseHandshake) => void): E2eeClientHelloResult {
    const options = this.#options;
    const credentials = options.credentials;

    // §8.3: elements 11/13 and 12/14 must be exactly equal at both endpoints, so
    // a client whose committed authority differs from the authority the Hub
    // presented on this channel has already lost the handshake (§11.2 P13). It
    // detects that here rather than spending a Noise handshake to learn it.
    if (
      !intentMatchesChannelOpen(options.channel, options.intendedCapability, options.intendedRole)
    ) {
      return this.#fail(fatal("P13", "context_mismatch"));
    }

    let accountGrantCertificate:
      | {
          readonly certificate: E2eeClientPrekeyCertificate;
          readonly digest: Uint8Array;
          readonly grant: DecodedHubDeviceGrant;
        }
      | undefined;
    if (isAccountGrantCredentials(credentials)) {
      const carrier = encodeClientE2eePrekeyCertificateCarrier(
        credentials.prekeyTranscript,
        credentials.prekeySignature,
      );
      const verifiedCertificate = verifyE2eeClientPrekeyCertificate({
        transcript: credentials.prekeyTranscript,
        signature: credentials.prekeySignature,
        hubOrigin: options.channel.hubOrigin,
        suite: options.selectedSuite,
        now,
      });
      const decodedGrant = decodeHubDeviceGrant(credentials.deviceGrant.envelope);
      if (
        verifiedCertificate.kind === "error" ||
        decodedGrant.kind === "error" ||
        !e2eeSecretBytesEqual(decodedGrant.claimsBytes, credentials.deviceGrant.claimsBytes) ||
        !e2eeSecretBytesEqual(decodedGrant.signature, credentials.deviceGrant.signature) ||
        !e2eeSecretBytesEqual(decodedGrant.grantDigest, credentials.deviceGrant.grantDigest) ||
        verifiedCertificate.certificate.accountId !== credentials.accountId ||
        !e2eeSecretBytesEqual(
          verifiedCertificate.certificate.identityPublicKey,
          credentials.identityPublicKey,
        ) ||
        !e2eeSecretBytesEqual(
          verifiedCertificate.certificate.agreementPublicKey,
          credentials.agreementPublicKey,
        )
      ) {
        throw new TypeError("Relay E2EE account grant does not match the client certificate.");
      }
      accountGrantCertificate = {
        certificate: verifiedCertificate.certificate,
        digest: sha256(carrier),
        grant: decodedGrant,
      };
    }

    const context =
      isAccountGrantCredentials(credentials) && accountGrantCertificate !== undefined
        ? buildAccountGrantContext({
            channel: options.channel,
            advertised: options.advertised,
            grant: accountGrantCertificate.grant,
            certificate: accountGrantCertificate.certificate,
            certificateDigest: accountGrantCertificate.digest,
            intendedCapability: options.intendedCapability,
            intendedRole: options.intendedRole,
          })
        : credentials.tier === "native"
          ? buildContext({
              channel: options.channel,
              advertised: options.advertised,
              suite: options.selectedSuite,
              intendedCapability: options.intendedCapability,
              intendedRole: options.intendedRole,
              client: {
                tier: "native",
                accountId: credentials.accountId,
                identityFingerprint: e2eeKeyFingerprint(
                  "client-identity",
                  credentials.identityPublicKey,
                ),
                agreementFingerprint: e2eeKeyFingerprint(
                  "agreement",
                  credentials.agreementPublicKey,
                ),
              },
            })
          : buildContext({
              channel: options.channel,
              advertised: options.advertised,
              suite: options.selectedSuite,
              intendedCapability: options.intendedCapability,
              intendedRole: options.intendedRole,
              client: { tier: "web" },
            });

    const prologue = encodeE2eeNoisePrologue({
      hubOrigin: options.channel.hubOrigin,
      channelId: options.channel.channelId,
      relayProtocolMajor: options.channel.relayProtocolMajor,
      relayProtocolMinor: options.channel.relayProtocolMinor,
      e2eeVersion: E2EE_PROTOCOL_VERSION,
      suiteId: options.selectedSuite,
      nodeId: options.advertised.nodeId,
      contextCommitment: context.commitment,
    });

    let payload: Uint8Array;
    if (credentials.tier === "native") {
      // A local guard, not a protocol step: an agreement secret that does not
      // match the certificate's agreement key produces a Noise `s` the node
      // rejects at §8.6 step 5, one round trip and one single-use ticket later.
      const derived = e2eeX25519PublicKey(credentials.agreementSecretKey);
      if (!e2eeSecretBytesEqual(derived, credentials.agreementPublicKey)) {
        throw new TypeError(
          "Relay E2EE client agreement secret key does not match its certificate key.",
        );
      }
      const nativePayload = {
        clientPrekeyTranscript: credentials.prekeyTranscript,
        clientPrekeySignature: credentials.prekeySignature,
        accountId: credentials.accountId,
        intendedCapability: options.intendedCapability,
        intendedRole: options.intendedRole,
      };
      payload = isAccountGrantCredentials(credentials)
        ? encodeE2eeAccountGrantIkHelloPayload({
            ...nativePayload,
            hubDeviceGrant: accountGrantCertificate!.grant.envelope,
          })
        : encodeE2eeIkHelloPayload(nativePayload);
    } else {
      // §8.5: NX message-1 payload MUST be zero-length.
      payload = E2EE_NX_HELLO_PAYLOAD;
    }

    const noise = new E2eeNoiseHandshake({
      pattern: e2eeTierNoisePattern(this.#tier),
      role: "initiator",
      prologue,
      staticSecretKey: credentials.tier === "native" ? credentials.agreementSecretKey : undefined,
      remoteStaticPublicKey:
        credentials.tier === "native" ? options.advertised.agreementPublicKey : undefined,
      testOnlyEphemeralSecretKey: options.testOnlyEphemeralSecretKey,
    });
    // From here a live Noise handshake exists; the funnel above owns erasing it.
    holdNoise(noise);

    let noiseMessage1: Uint8Array;
    try {
      noiseMessage1 = noise.writeMessage(payload);
    } catch {
      noise.destroy();
      return this.#fail(fatal("P10", "noise"));
    }

    const record = encodeE2eeClientHello({
      tier: this.#tier,
      selectedSuite: options.selectedSuite,
      offeredSuites: options.offeredSuites,
      clientNonce: options.testOnlyClientNonce ?? randomBytes(E2EE_HANDSHAKE_NONCE_BYTES),
      contextCommitment: context.commitment,
      noiseMessage1,
    });

    this.#noise = noise;
    this.#helloRecord = record;
    this.#contextBlock = context.block;
    this.#contextCommitment = context.commitment;
    this.#deadlineAt = e2eeClientHandshakeDeadline(now);
    this.#state = "hello_sent";
    return {
      kind: "hello",
      record,
      contextBlock: context.block,
      contextCommitment: context.commitment,
      prologue,
      deadlineAt: this.#deadlineAt,
    };
  }

  /**
   * §8.8, in order: the record bound and strict decode; the echoed suite,
   * prekey id, and commitment; `noiseMessage2` including the NX responder-static
   * equality check; the message-2 payload against elements 13–14 and the
   * advertised agreement fingerprint; `Split()`, the recomputed
   * `confirmationTranscript`, and the constant-time confirmation comparison;
   * then the session binding over the EXACT FINAL WIRE BYTES.
   *
   * Step 5 is the client's symmetric context check: the transcript embeds its
   * OWN `contextBlock`, so a responder that verified a different context cannot
   * have produced a matching MAC.
   *
   * Any failure in steps 1–5 is fatal for the channel (K6; one attempt, §8.1).
   *
   * The steps run inside the LOCAL failure funnel, for the same reason the
   * node's do: the §8.7 encoders and the §8.7/§8.8 transcript builders validate
   * their inputs and can throw, and from `Split()` onward a throw would drop the
   * §6.5 secrets un-erased and leave this object in `hello_sent` — spendable
   * again against a second accept, which §8.1 does not admit.
   */
  receiveServerAccept(payload: Uint8Array, now: number): E2eeClientEstablishedResult {
    if (this.#state !== "hello_sent") return this.#fail(fatal("P16", "handshake_spent"));
    const noise = this.#noise;
    const helloRecord = this.#helloRecord;
    const contextBlock = this.#contextBlock;
    const contextCommitment = this.#contextCommitment;
    if (
      noise === undefined ||
      helloRecord === undefined ||
      contextBlock === undefined ||
      contextCommitment === undefined
    ) {
      return this.#fail(fatal("P16", "handshake_spent"));
    }
    // §4.4 K15: the deadline is the caller's timer; this is the check that a
    // late accept never establishes a session behind an expired one.
    if (this.deadlineExpired(now)) return this.#fail(fatal("P20", "handshake_deadline"));

    let secrets: E2eeSessionSecrets | undefined;
    try {
      return this.#receiveServerAccept({
        payload,
        noise,
        helloRecord,
        contextBlock,
        contextCommitment,
        holdSecrets: (derived) => {
          secrets = derived;
        },
      });
    } catch (error) {
      if (secrets !== undefined) eraseE2eeSessionSecrets(secrets);
      this.destroy();
      throw error;
    }
  }

  #receiveServerAccept(input: {
    readonly payload: Uint8Array;
    readonly noise: E2eeNoiseHandshake;
    readonly helloRecord: Uint8Array;
    readonly contextBlock: Uint8Array;
    readonly contextCommitment: Uint8Array;
    readonly holdSecrets: (secrets: E2eeSessionSecrets) => void;
  }): E2eeClientEstablishedResult {
    const { payload, noise, helloRecord, contextBlock, contextCommitment } = input;

    // Step 1.
    const decoded = decodeE2eeServerAccept(payload);
    if (decoded.kind === "error") {
      return this.#fail(
        decoded.reason === "bad_record"
          ? fatal("P3", "record_bounds")
          : fatal("P16", "accept_mismatch"),
      );
    }
    const accept = decoded.value;

    // Step 2.
    if (
      accept.acceptedSuite !== this.#options.selectedSuite ||
      accept.nodePrekeyId !== this.#options.advertised.prekeyId
    ) {
      return this.#fail(fatal("P16", "accept_mismatch"));
    }
    if (!e2eeSecretBytesEqual(accept.contextCommitment, contextCommitment)) {
      return this.#fail(fatal("P13", "context_mismatch"));
    }

    // Step 3.
    let payloadBytes: Uint8Array;
    try {
      payloadBytes = noise.readMessage(accept.noiseMessage2);
    } catch {
      return this.#fail(fatal("P10", "noise"));
    }
    // §8.7: in NX the `s` token of message 2 transmits the node static, and the
    // client MUST require it to byte-equal the advertised prekey certificate's
    // `agreementPublicKey`. In IK the initiator supplied that static itself, so
    // the same comparison holds trivially and is made on both tiers rather than
    // being a branch that could be taken on the wrong one.
    const remoteStatic = noise.remoteStaticPublicKey;
    if (
      remoteStatic === undefined ||
      !e2eeSecretBytesEqual(remoteStatic, this.#options.advertised.agreementPublicKey)
    ) {
      // A check on the accept's content rather than a Noise processing failure,
      // so it enumerates as P16 — "failing any §8.8 step 1–5 check" — and not as
      // one of P10's three named conditions.
      return this.#fail(fatal("P16", "accept_mismatch"));
    }

    // Step 4.
    const decodedPayload = decodeE2eeServerAcceptPayload(payloadBytes);
    if (decodedPayload.kind === "error") return this.#fail(fatal("P16", "accept_mismatch"));
    const acceptPayload = decodedPayload.value;
    if (
      acceptPayload.channelOpenCapability !== this.#options.channel.channelOpenCapability ||
      acceptPayload.channelOpenEffectiveRole !== this.#options.channel.channelOpenEffectiveRole
    ) {
      return this.#fail(fatal("P13", "context_mismatch"));
    }
    if (
      !e2eeSecretBytesEqual(
        acceptPayload.nodeAgreementKeyFingerprint,
        e2eeKeyFingerprint("agreement", this.#options.advertised.agreementPublicKey),
      )
    ) {
      return this.#fail(fatal("P13", "context_mismatch"));
    }

    // Step 5.
    let secrets: E2eeSessionSecrets;
    try {
      secrets = deriveE2eeSessionSecrets(noise);
    } catch {
      return this.#fail(fatal("P10", "noise"));
    }
    // From here the §6.5 secrets exist; the funnel above owns erasing them on
    // any throw, which no return path below would otherwise do.
    input.holdSecrets(secrets);
    const serverAcceptTbs = encodeE2eeServerAcceptTbs({
      acceptedSuite: this.#options.selectedSuite,
      nodePrekeyId: accept.nodePrekeyId,
      contextCommitment: accept.contextCommitment,
      noiseMessage2: accept.noiseMessage2,
    });
    const confirmationTranscript = e2eeConfirmationTranscript({
      clientHelloWireBytes: helloRecord,
      serverAcceptTbsWireBytes: serverAcceptTbs,
      contextBlock,
    });
    const expected = e2eeServerConfirmation(secrets.serverConfirmationKey, confirmationTranscript);
    if (!e2eeSecretBytesEqual(expected, accept.serverConfirmation)) {
      eraseE2eeSessionSecrets(secrets);
      return this.#fail(fatal("P16", "confirmation_mismatch"));
    }

    // Step 6: the binding is over the EXACT FINAL WIRE BYTES received, so it
    // covers the confirmation the peer actually sent.
    const sessionBindingHash = e2eeSessionBindingHash({
      clientHelloWireBytes: helloRecord,
      serverAcceptWireBytes: payload,
      contextBlock,
    });

    // §13.5, and only on the web arm — the mirror of the node's own read at
    // `E2eeNodeAcceptResult.peerEphemeralPublicKey`. Taken INSIDE the funnel and
    // before the state flip: `Split()` has already run above, so a throw here
    // would otherwise strand the §6.5 secrets on an object that had already
    // declared itself established. The public component survives `Split()` by
    // design (`E2eeNoiseHandshake.localEphemeralPublicKey`) while the secret is
    // erased with everything else, so the absence branch is a shape check
    // against a pattern-table edit — both patterns write `e` in message 1 — and
    // not a runtime condition.
    let webEphemeralPublicKey: Uint8Array | undefined;
    if (this.#options.credentials.tier === "web") {
      webEphemeralPublicKey = noise.localEphemeralPublicKey;
      if (webEphemeralPublicKey === undefined) {
        throw new TypeError("Relay E2EE client handshake has no local ephemeral.");
      }
    }

    this.#state = "established";
    this.#noise = undefined;
    return {
      kind: "established",
      sessionBindingHash,
      secrets,
      suite: this.#options.selectedSuite,
      trustSource: e2eeHandshakeTrustSource(this.#tier, this.#options.selectedSuite),
      contextBlock,
      serverAcceptTbs,
      confirmationTranscript,
      ...(webEphemeralPublicKey === undefined ? {} : { webEphemeralPublicKey }),
    };
  }

  /** §11.2: erase any partial handshake state. Idempotent. */
  destroy(): void {
    this.#noise?.destroy();
    this.#noise = undefined;
    if (this.#state !== "established") this.#state = "failed";
  }

  #fail(failure: E2eeHandshakeFailure): E2eeHandshakeFailure {
    this.destroy();
    return failure;
  }
}

// ─── the node handshake (§8.6, §8.7, §8.9) ───────────────────────────────────

/**
 * The node's COMMITTED admission policy, read at §8.6 step 2 — never the values
 * the advertised snapshot carries (§12.6).
 *
 * The effective admitted pattern set is not a field: §7.6 element 14 is
 * COMPUTED from `requireApprovedClientE2EE`, which is what makes it impossible
 * for a node to admit a tier it does not advertise.
 */
export interface E2eeNodeAdmissionPolicy {
  readonly requireApprovedClientE2EE: boolean;
  /** §7.6 element 9, the node's advertised suite registry, from committed policy. */
  readonly suiteRegistry: readonly number[];
}

/**
 * What row N3 is decided from (§4.4, §8.6 step 8).
 *
 * The §12.6 withdrawal test reads the channel's tier and selected suite, and the
 * §13.6 test reads the admitted-authority snapshot; all three are fixed by steps
 * 2, 4 and 6 and none of them is knowable to a caller before `receiveHello`
 * runs. Handing them to the transition is what lets an implementation evaluate
 * both tests inside the same synchronous turn as the reads that produced them,
 * which is exactly the atomicity §8.6 steps 2 and 6 require — rather than
 * re-deriving the selection from a second decode of the same wrapper bytes.
 */
export interface E2eeNodeModeTransitionSelection {
  readonly tier: E2eeTier;
  /** §7.6 element 14's vocabulary; `e2eeTierNoisePattern(tier)`, computed once here. */
  readonly pattern: E2eeNoisePattern;
  readonly suite: E2eeSuiteId;
  readonly trustSource: NativeE2eeTrustSource;
  /** §8.6 step 6; IK only — NX carries no Branch A record and no snapshot. */
  readonly admittedAuthority: E2eeAdmittedAuthoritySnapshot | undefined;
  /** §18.7; suite 0x02 only. Contains no grant envelope or raw public key. */
  readonly accountGrantAuthority: E2eeAccountGrantAuthoritySnapshot | undefined;
}

/** The bounded enrollment/authority handle retained by an account-enrolled channel. */
export interface E2eeAccountGrantAuthoritySnapshot {
  readonly trustSource: "account-enrolled";
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly enrollmentId: string;
  readonly enrollmentRevision: number;
  readonly accountAuthEpoch: number;
  readonly deviceAuthEpoch: number;
  readonly clientIdentityFingerprint: Uint8Array;
  readonly maximumRole: string;
  readonly capabilitySet: readonly string[];
}

/**
 * Inputs handed to the node owner's authenticated Hub/keyset verifier. The
 * callback performs signature, time, revocation, ticket, policy, and local
 * restriction checks; this pure handshake layer performs no fetch or write.
 */
export interface E2eeAccountGrantNodeVerificationInput {
  readonly grant: DecodedHubDeviceGrant;
  readonly certificate: E2eeClientPrekeyCertificate;
  readonly certificateDigest: Uint8Array;
  readonly channel: E2eeHandshakeChannel;
  readonly advertised: E2eeAdvertisedChannelMaterial;
  readonly intendedCapability: string;
  readonly intendedRole: string;
  readonly now: number;
}

/** Row N3 (§4.4): the channel's transition into `e2ee`. */
export type E2eeModeTransition =
  | { readonly kind: "entered" }
  /** §12.6: a policy withdrawal committed after the step-2 read (§11.2 P25). */
  | { readonly kind: "refused"; readonly reason: "policy_withdrawn" }
  /** §13.6: an authorization withdrawal committed after the step-6 read (§11.2 P12). */
  | { readonly kind: "refused"; readonly reason: "authorization_withdrawn" };

export interface E2eeNodeHandshakeOptions {
  readonly channel: E2eeHandshakeChannel;
  /** The material this node advertised ON THIS CHANNEL (§8.3, §7.5, §15). */
  readonly advertised: E2eeAdvertisedChannelMaterial;
  /** §7.6 elements 7–8, as advertised on this channel; checked at §8.6 step 2. */
  readonly advertisedVersionMin: number;
  readonly advertisedVersionMax: number;
  /** The secret half of the prekey advertised on this channel (§6.4). */
  readonly agreementSecretKey: Uint8Array;
  /** §4.4: `T_HANDSHAKE_NODE` runs from here, through the §8.9 implicit finish. */
  readonly advertisementEmittedAt: number;
  /**
   * §8.6 step 2. ALWAYS the node's own committed policy. This read and the row
   * N3 transition below MUST be atomic with respect to the §12.6
   * policy-withdrawal commit; `enterE2eeMode` is where an implementation closes
   * that window.
   */
  readonly readPolicy: () => E2eeNodeAdmissionPolicy;
  /**
   * §8.6 step 1 / §15: the pre-authentication bounds — the per-Hub-origin
   * handshake-attempt token bucket and the concurrency bound — evaluated BEFORE
   * any signature verification or DH computation. Refusal is §11.2 P8.
   */
  readonly admitAttempt?: (() => boolean) | undefined;
  /**
   * §8.6 step 6 (IK only): the Branch A record for
   * `(hubOrigin, accountId, clientIdentityFingerprint)`. This read and the row
   * N3 transition MUST be atomic with respect to the §13.6
   * authorization-withdrawal write.
   */
  readonly lookupClientAuthorization?:
    | ((key: E2eeClientAuthorizationKey) => E2eeClientAuthorization | undefined)
    | undefined;
  /**
   * §13.2 step 3 (IK only): the pending-class DECISION — the §15 caps and the
   * §13.6 pairing-window reservation — taken here and entirely in memory.
   *
   * HERE and not one step earlier, because §13.6 grants the reservation only to
   * an attempt whose **authenticated** `clientIdentityFingerprint` matches the
   * owner-named discriminator: step 5 has bound that fingerprint to a
   * certificate self-signed by the client identity key, so this runs against a
   * value the node has proven rather than one the peer asserted.
   *
   * CALLED ON EVERY NATIVE STEP-6 READ, not only on the refusal below. §13.6
   * spends the window's single reservation on "the first attempt that matches
   * the discriminator, whatever that attempt's outcome" — an owner's device that
   * the node already holds a record for is such an attempt, and a window left
   * open after it arrived tells the owner their device has not reached the node.
   *
   * RETURNS NOTHING, and this module holds no result: §13.2 step 3 forbids the
   * durable half from running before the reject and the close (§11.2), and every
   * caller of `receiveHello` is still inside the response path. The decision
   * belongs to the caller, which commits it after both.
   *
   * The client identity key is passed because §13.4's safety number is derived
   * from it and no other step-6 value can stand in for it. The record persists
   * the derived display string only, never either raw key (§13.6).
   */
  readonly evaluatePairingAdmission?:
    | ((client: {
        readonly hubOrigin: string;
        readonly accountId: string;
        readonly clientIdentityFingerprint: Uint8Array;
        readonly clientIdentityPublicKey: Uint8Array;
      }) => void)
    | undefined;
  /** §18.7 suite-0x02 authorization against connector-owned Hub state. */
  readonly verifyAccountGrant?:
    | ((input: E2eeAccountGrantNodeVerificationInput) => boolean)
    | undefined;
  /**
   * Row N3 (§8.6 step 8). The caller performs the transition into `e2ee` here,
   * inside whatever serialization makes the step-2 and step-6 reads atomic with
   * respect to the §12.6 and §13.6 commits, and refuses when a withdrawal
   * landed in between. Omitted means "entered".
   *
   * It is handed the selection those steps fixed, because both withdrawal tests
   * are evaluated against it and neither is answerable from state the caller
   * holds before the hello is processed.
   */
  readonly enterE2eeMode?:
    | ((selection: E2eeNodeModeTransitionSelection) => E2eeModeTransition)
    | undefined;
  /** TEST AND FIXTURE-GENERATOR USE ONLY (§16.1). */
  readonly testOnlyEphemeralSecretKey?: Uint8Array | undefined;
}

export type E2eeNodeAcceptResult =
  | {
      readonly kind: "accepted";
      /** The complete `E2EEServerAccept` record to send (row N3). */
      readonly record: Uint8Array;
      readonly sessionBindingHash: Uint8Array;
      /**
       * The client's Noise ephemeral public key for this handshake (§6.2).
       *
       * Present on BOTH tiers because the Noise pattern transmits it on both,
       * and consumed by exactly one caller: §13.5's `WebSAS`, which is defined
       * over the web client's ephemeral and is the only per-session value the
       * node can display for a peer that has no long-term identity. Public
       * material, never a session secret.
       */
      readonly peerEphemeralPublicKey: Uint8Array;
      /** §6.5 secrets; OWNERSHIP TRANSFERS to the caller, which erases them (§9.5). */
      readonly secrets: E2eeSessionSecrets;
      readonly suite: E2eeSuiteId;
      readonly tier: E2eeTier;
      readonly trustSource: NativeE2eeTrustSource;
      readonly contextBlock: Uint8Array;
      readonly contextCommitment: Uint8Array;
      readonly serverAcceptTbs: Uint8Array;
      readonly confirmationTranscript: Uint8Array;
      /** §8.6 step 6; IK only — NX carries no Branch A record and no snapshot. */
      readonly admittedAuthority: E2eeAdmittedAuthoritySnapshot | undefined;
      /** §18.7 suite-0x02 lease handle; never includes the grant envelope. */
      readonly accountGrantAuthority: E2eeAccountGrantAuthoritySnapshot | undefined;
      /** §8.9: the implicit-finish deadline, armed unconditionally. */
      readonly implicitFinishDeadlineAt: number;
    }
  | E2eeHandshakeFailure;

export type E2eeImplicitFinishResult =
  | { readonly kind: "finished" }
  | {
      readonly kind: "fatal";
      /** §11.3 Q8 (deadline) or Q9 (authorization withdrawal). */
      readonly row: "Q8" | "Q9";
      /** The §11.3 code NAME; its wire value belongs to the §11.3 registry. */
      readonly errorCode: "protocol_violation" | "policy";
      readonly reason: "implicit_finish_deadline" | "authorization_withdrawn";
    };

type NodeState = "awaiting_hello" | "e2ee" | "finished" | "failed";

/**
 * The node half of §8 — the Noise RESPONDER in both patterns (§8.1).
 *
 * `receiveHello` runs the §8.6 steps IN ORDER and stops at the first failure;
 * every failure is FATAL-PRE and externally indistinguishable from every other
 * pre-key failure (§11.2). EXACTLY ONE HELLO PER CHANNEL: a second one is
 * §11.2 P4, and any failure spends the object.
 */
export class E2eeNodeHandshake {
  readonly #options: E2eeNodeHandshakeOptions;
  #state: NodeState = "awaiting_hello";
  #admittedAuthority: E2eeAdmittedAuthoritySnapshot | undefined;
  #accountGrantAuthority: E2eeAccountGrantAuthoritySnapshot | undefined;
  #tier: E2eeTier | undefined;
  #implicitFinishDeadlineAt: number;

  constructor(options: E2eeNodeHandshakeOptions) {
    this.#options = options;
    this.#implicitFinishDeadlineAt = e2eeNodeHandshakeDeadline(options.advertisementEmittedAt);
  }

  get state(): NodeState {
    return this.#state;
  }

  /** The tier the channel ran, fixed at §8.6 step 4; consumed by the §12.6 test. */
  get tier(): E2eeTier | undefined {
    return this.#tier;
  }

  /** §8.6 step 6 / §15. IK only. */
  get admittedAuthority(): E2eeAdmittedAuthoritySnapshot | undefined {
    return this.#admittedAuthority;
  }

  /** §18.7 suite-0x02 lease handle. */
  get accountGrantAuthority(): E2eeAccountGrantAuthoritySnapshot | undefined {
    return this.#accountGrantAuthority;
  }

  /**
   * §8.9: `T_HANDSHAKE_NODE` from advertisement emit, ARMED UNCONDITIONALLY —
   * under every policy including the compatibility default — and satisfied only
   * by an authenticated implicit finish. The justification is key-material
   * lifetime, not availability.
   */
  get implicitFinishDeadlineAt(): number {
    return this.#implicitFinishDeadlineAt;
  }

  deadlineExpired(now: number): boolean {
    return this.#state !== "finished" && now > this.#implicitFinishDeadlineAt;
  }

  /**
   * §8.9: until the first client-to-node envelope authenticates, the node MUST
   * NOT emit node-to-client application RPC and MUST NOT invoke the RPC handler
   * for anything (row N9). It MAY still emit an encrypted `E2EEError` or
   * `E2EEClose`, which is why this gates the RPC handler and not the send path.
   */
  get mayInvokeRpcHandler(): boolean {
    return this.#state === "finished";
  }

  /** §8.9, the same gate on the node's own application output. */
  get mayEmitApplicationRpc(): boolean {
    return this.#state === "finished";
  }

  /**
   * §8.6, every numbered step in order.
   *
   * THE WHOLE METHOD RUNS INSIDE THE LOCAL FAILURE FUNNEL, not merely steps 7
   * and 8. Every stretch of it can throw on something other than peer input:
   * `admitAttempt`, `readPolicy`, `lookupClientAuthorization`, and
   * `enterE2eeMode` are caller callbacks; the §8.4 prologue encoder and the §8.3
   * context encoder reject material this node holds; and the §8.3 role ordering
   * throws on a stored `maxRole` outside the relay vocabulary. From step 4 a
   * live Noise handshake exists and from `Split()` the §6.5 secrets do, and an
   * escaping throw anywhere would leave this object in `awaiting_hello` — a
   * second attempt on one channel, which §8.1 forbids — with that state
   * un-erased.
   */
  receiveHello(payload: Uint8Array, now: number): E2eeNodeAcceptResult {
    if (this.#state !== "awaiting_hello") return this.#fail(fatal("P4", "handshake_spent"));
    let noise: E2eeNoiseHandshake | undefined;
    let secrets: E2eeSessionSecrets | undefined;
    try {
      return this.#receiveHello({
        payload,
        now,
        holdNoise: (created) => {
          noise = created;
        },
        holdSecrets: (derived) => {
          secrets = derived;
        },
      });
    } catch (error) {
      if (secrets !== undefined) eraseE2eeSessionSecrets(secrets);
      this.#failLocal(noise);
      throw error;
    }
  }

  #receiveHello(input: {
    readonly payload: Uint8Array;
    readonly now: number;
    readonly holdNoise: (noise: E2eeNoiseHandshake) => void;
    readonly holdSecrets: (secrets: E2eeSessionSecrets) => void;
  }): E2eeNodeAcceptResult {
    const { payload, now } = input;
    const options = this.#options;

    // ── Step 1: bounds before crypto ────────────────────────────────────────
    // §15's pre-authentication bounds run before any signature verification or
    // DH computation; the record-size bound is applied by the framing decoder,
    // before the body is parsed at all.
    if (options.admitAttempt !== undefined && !options.admitAttempt()) {
      return this.#fail(fatal("P8", "attempt_not_admitted"));
    }
    const decoded = decodeE2eeClientHello(payload);
    if (decoded.kind === "error") {
      return this.#fail(
        decoded.reason === "bad_record" ? fatal("P3", "record_bounds") : fatal("P9", "wrapper"),
      );
    }
    const hello = decoded.value;

    // ── Step 2: wrapper checks ──────────────────────────────────────────────
    // The policy read is the node's own COMMITTED policy, never the advertised
    // snapshot's (§12.6). This read and the row N3 transition below are atomic
    // with respect to the §12.6 commit; `enterE2eeMode` is the caller's hook
    // for that, and a withdrawal landing in between is P25 rather than P9.
    const policy = options.readPolicy();
    const admittedPatterns = e2eeEffectiveAdmittedPatterns(policy.requireApprovedClientE2EE);
    if (
      hello.e2eeVersion !== E2EE_PROTOCOL_VERSION ||
      hello.e2eeVersion < options.advertisedVersionMin ||
      hello.e2eeVersion > options.advertisedVersionMax ||
      !admittedPatterns.includes(e2eeTierNoisePattern(hello.tier)) ||
      !isE2eeSuiteId(hello.selectedSuite) ||
      !policy.suiteRegistry.includes(hello.selectedSuite) ||
      !hello.offeredSuites.includes(hello.selectedSuite) ||
      (hello.selectedSuite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 &&
        (hello.tier !== "native" ||
          options.channel.relayProtocolMajor !== 1 ||
          options.channel.relayProtocolMinor < 3 ||
          options.channel.accountGrantContext === undefined)) ||
      (hello.selectedSuite === E2EE_SUITE_25519_CHACHAPOLY_SHA256 &&
        options.channel.accountGrantContext !== undefined)
    ) {
      return this.#fail(fatal("P9", "wrapper"));
    }
    const suite: E2eeSuiteId = hello.selectedSuite;
    const tier = hello.tier;
    this.#tier = tier;

    // ── Step 3: prologue ────────────────────────────────────────────────────
    // Built from the node's OWN channel state plus the wrapper commitment; no
    // other wrapper value is adopted (§8.4).
    const prologue = encodeE2eeNoisePrologue({
      hubOrigin: options.channel.hubOrigin,
      channelId: options.channel.channelId,
      relayProtocolMajor: options.channel.relayProtocolMajor,
      relayProtocolMinor: options.channel.relayProtocolMinor,
      e2eeVersion: E2EE_PROTOCOL_VERSION,
      suiteId: suite,
      nodeId: options.advertised.nodeId,
      contextCommitment: hello.contextCommitment,
    });

    // ── Step 4: Noise ───────────────────────────────────────────────────────
    const noise = new E2eeNoiseHandshake({
      pattern: e2eeTierNoisePattern(tier),
      role: "responder",
      prologue,
      staticSecretKey: options.agreementSecretKey,
      testOnlyEphemeralSecretKey: options.testOnlyEphemeralSecretKey,
    });
    // From here a live Noise handshake exists; the funnel above owns erasing it.
    input.holdNoise(noise);
    let helloPayload: Uint8Array;
    try {
      helloPayload = noise.readMessage(hello.noiseMessage1);
    } catch {
      noise.destroy();
      return this.#fail(fatal("P10", "noise"));
    }

    // ── Step 5: IK bindings ─────────────────────────────────────────────────
    let clientContext:
      | {
          readonly tier: "native";
          readonly accountId: string;
          readonly identityFingerprint: Uint8Array;
          readonly agreementFingerprint: Uint8Array;
          /**
           * §13.4's client half, carried only as far as step 6.
           *
           * The context block (§8.3 element 10) commits to the FINGERPRINT and
           * nothing here changes that; the key is kept because §13.2 step 3
           * derives the safety number from both identity keys and step 6 is the
           * last point at which this side of the pair is in hand.
           */
          readonly identityPublicKey: Uint8Array;
        }
      | { readonly tier: "web" };
    let claims: E2eeIkHelloPayload | E2eeAccountGrantIkHelloPayload | undefined;
    let clientCertificate: E2eeClientPrekeyCertificate | undefined;
    let certificateDigest: Uint8Array | undefined;
    let accountGrant: DecodedHubDeviceGrant | undefined;
    if (tier === "native") {
      const payloadDecoded =
        suite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256
          ? decodeE2eeAccountGrantIkHelloPayload(helloPayload)
          : decodeE2eeIkHelloPayload(helloPayload);
      if (payloadDecoded.kind === "error") {
        noise.destroy();
        return this.#fail(fatal("P11", "client_binding"));
      }
      claims = payloadDecoded.value;
      const certificate = verifyE2eeClientPrekeyCertificate({
        transcript: claims.clientPrekeyTranscript,
        signature: claims.clientPrekeySignature,
        hubOrigin: options.channel.hubOrigin,
        suite,
        now,
      });
      if (certificate.kind === "error") {
        noise.destroy();
        return this.#fail(fatal("P11", "client_binding"));
      }
      clientCertificate = certificate.certificate;
      certificateDigest = sha256(
        encodeClientE2eePrekeyCertificateCarrier(
          claims.clientPrekeyTranscript,
          claims.clientPrekeySignature,
        ),
      );
      if (suite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256) {
        if (!("hubDeviceGrant" in claims) || !(claims.hubDeviceGrant instanceof Uint8Array)) {
          noise.destroy();
          return this.#fail(fatal("P11", "client_binding"));
        }
        const decodedGrant = decodeHubDeviceGrant(claims.hubDeviceGrant);
        if (decodedGrant.kind === "error") {
          noise.destroy();
          return this.#fail(fatal("P12", "authorization"));
        }
        accountGrant = decodedGrant;
      }
      const remoteStatic = noise.remoteStaticPublicKey;
      if (
        remoteStatic === undefined ||
        !e2eeSecretBytesEqual(remoteStatic, certificate.certificate.agreementPublicKey) ||
        claims.accountId !== certificate.certificate.accountId
      ) {
        noise.destroy();
        return this.#fail(fatal("P11", "client_binding"));
      }
      clientContext = {
        tier: "native",
        accountId: claims.accountId,
        identityFingerprint: e2eeKeyFingerprint(
          "client-identity",
          certificate.certificate.identityPublicKey,
        ),
        agreementFingerprint: certificate.certificate.agreementFingerprint,
        identityPublicKey: certificate.certificate.identityPublicKey,
      };
    } else {
      // §8.5: a nonempty NX message-1 payload is a handshake failure. The NX
      // first message has no encryption keys (§8.10), so nothing may ride in it.
      if (helloPayload.byteLength !== 0) {
        noise.destroy();
        return this.#fail(fatal("P10", "nx_payload_not_empty"));
      }
      clientContext = { tier: "web" };
    }

    // §8.3 absence semantics: on NX elements 11–12 MUST equal the received
    // `channel.open` values; on IK they are the authenticated payload claims.
    const intendedCapability =
      claims === undefined ? options.channel.channelOpenCapability : claims.intendedCapability;
    const intendedRole =
      claims === undefined ? options.channel.channelOpenEffectiveRole : claims.intendedRole;
    if (!intentMatchesChannelOpen(options.channel, intendedCapability, intendedRole)) {
      noise.destroy();
      return this.#fail(fatal("P13", "context_mismatch"));
    }

    // ── Step 6: authorization (IK) ──────────────────────────────────────────
    let snapshot: E2eeAdmittedAuthoritySnapshot | undefined;
    let accountGrantSnapshot: E2eeAccountGrantAuthoritySnapshot | undefined;
    if (clientContext.tier === "native") {
      if (suite === E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256) {
        if (
          accountGrant === undefined ||
          clientCertificate === undefined ||
          certificateDigest === undefined ||
          !accountGrantBindingsMatch({
            channel: options.channel,
            advertised: options.advertised,
            grant: accountGrant,
            certificate: clientCertificate,
            certificateDigest,
            intendedCapability,
            intendedRole,
          }) ||
          options.verifyAccountGrant?.({
            grant: accountGrant,
            certificate: clientCertificate,
            certificateDigest,
            channel: options.channel,
            advertised: options.advertised,
            intendedCapability,
            intendedRole,
            now,
          }) !== true
        ) {
          noise.destroy();
          return this.#fail(fatal("P12", "authorization"));
        }
        accountGrantSnapshot = {
          trustSource: "account-enrolled",
          hubOrigin: options.channel.hubOrigin,
          accountId: accountGrant.claims.accountId,
          enrollmentId: accountGrant.claims.enrollmentId,
          enrollmentRevision: accountGrant.claims.enrollmentRevision,
          accountAuthEpoch: accountGrant.claims.accountAuthEpoch,
          deviceAuthEpoch: accountGrant.claims.deviceAuthEpoch,
          clientIdentityFingerprint: copyBytes(accountGrant.claims.deviceIdentityFingerprint),
          maximumRole: accountGrant.claims.maximumRole,
          capabilitySet: [...accountGrant.claims.capabilities],
        };
      } else {
        const key: E2eeClientAuthorizationKey = {
          hubOrigin: options.channel.hubOrigin,
          accountId: clientContext.accountId,
          clientIdentityFingerprint: clientContext.identityFingerprint,
        };
        const record = options.lookupClientAuthorization?.(key);
        // §13.2 step 3, between the read and the refusal: the caps and the window
        // reservation, in memory, with nothing emitted yet. It is deliberately not
        // conditioned on `record` — see the option's own note for why the window
        // is spent by a matching attempt whatever this read returned — and it
        // deliberately changes nothing below it, because §11.2 requires the wire
        // surface of a pairing attempt to be the one every other pre-key cause
        // takes.
        options.evaluatePairingAdmission?.({
          hubOrigin: key.hubOrigin,
          accountId: key.accountId,
          clientIdentityFingerprint: key.clientIdentityFingerprint,
          clientIdentityPublicKey: clientContext.identityPublicKey,
        });
        if (
          record === undefined ||
          record.status !== "approved" ||
          !record.capabilitySet.includes(intendedCapability) ||
          !e2eeRoleWithinCeiling(intendedRole, record.maxRole)
        ) {
          noise.destroy();
          return this.#fail(fatal("P12", "authorization"));
        }
        snapshot = {
          hubOrigin: key.hubOrigin,
          accountId: key.accountId,
          clientIdentityFingerprint: copyBytes(key.clientIdentityFingerprint),
          status: record.status,
          maxRole: record.maxRole,
          capabilitySet: [...record.capabilitySet],
        };
      }
    }

    // ── Step 7: context reconstruction ──────────────────────────────────────
    // Built from the node's OWN `channel.open`, the authenticated payload
    // claims, and the identity, prekey, chain, and continuity-id material IT
    // ADVERTISED ON THIS CHANNEL — never its current state, which a rotation
    // or prune concurrent with this channel may already have moved.
    const context =
      accountGrant !== undefined &&
      clientCertificate !== undefined &&
      certificateDigest !== undefined
        ? buildAccountGrantContext({
            channel: options.channel,
            advertised: options.advertised,
            grant: accountGrant,
            certificate: clientCertificate,
            certificateDigest,
            intendedCapability,
            intendedRole,
          })
        : buildContext({
            channel: options.channel,
            advertised: options.advertised,
            suite,
            intendedCapability,
            intendedRole,
            client: clientContext,
          });
    if (!e2eeSecretBytesEqual(context.commitment, hello.contextCommitment)) {
      noise.destroy();
      return this.#fail(fatal("P13", "context_mismatch"));
    }

    // ── Step 8: build and send `E2EEServerAccept` (row N3) ──────────────────
    const transition = options.enterE2eeMode?.({
      tier,
      pattern: e2eeTierNoisePattern(tier),
      suite,
      trustSource: e2eeHandshakeTrustSource(tier, suite),
      admittedAuthority: snapshot,
      accountGrantAuthority: accountGrantSnapshot,
    }) ?? { kind: "entered" as const };
    if (transition.kind === "refused") {
      noise.destroy();
      return this.#fail(
        transition.reason === "policy_withdrawn"
          ? fatal("P25", "policy_withdrawn")
          : fatal("P12", "authorization_withdrawn"),
      );
    }

    const agreementFingerprint = e2eeKeyFingerprint(
      "agreement",
      options.advertised.agreementPublicKey,
    );
    let secrets: E2eeSessionSecrets;
    let noiseMessage2: Uint8Array;
    let peerEphemeralPublicKey: Uint8Array;
    try {
      noiseMessage2 = noise.writeMessage(
        encodeE2eeServerAcceptPayload({
          channelOpenCapability: options.channel.channelOpenCapability,
          channelOpenEffectiveRole: options.channel.channelOpenEffectiveRole,
          nodeAgreementKeyFingerprint: agreementFingerprint,
        }),
      );
      // Taken INSIDE the funnel and before `Split()`, not after the accept is
      // built: every exit below `holdSecrets` is a `return` rather than a
      // `throw`, so a failure raised there would leave the §6.5 secrets with no
      // owner to erase them. Both patterns transmit the initiator's `e` in
      // message 1, which `readMessage` has already processed, so the absence
      // branch is a shape check against a pattern-table edit rather than a
      // runtime condition — and it throws so the catch below destroys the Noise
      // state on the way out, exactly as every other failure here does.
      const ephemeral = noise.remoteEphemeralPublicKey;
      if (ephemeral === undefined) throw new TypeError("Noise handshake has no peer ephemeral.");
      peerEphemeralPublicKey = ephemeral;
      // §8.7: `Split()` completes AFTER message 2 is produced.
      secrets = deriveE2eeSessionSecrets(noise);
    } catch {
      noise.destroy();
      return this.#fail(fatal("P10", "noise"));
    }
    // From here the §6.5 secrets exist; the funnel above owns erasing them on
    // any throw, which no return path below would otherwise do.
    input.holdSecrets(secrets);

    const tbsInput: E2eeServerAcceptTbsInput = {
      acceptedSuite: suite,
      nodePrekeyId: options.advertised.prekeyId,
      contextCommitment: context.commitment,
      noiseMessage2,
    };
    const serverAcceptTbs = encodeE2eeServerAcceptTbs(tbsInput);
    const helloWireBytes = copyBytes(payload);
    const confirmationTranscript = e2eeConfirmationTranscript({
      clientHelloWireBytes: helloWireBytes,
      serverAcceptTbsWireBytes: serverAcceptTbs,
      contextBlock: context.block,
    });
    const serverConfirmation = e2eeServerConfirmation(
      secrets.serverConfirmationKey,
      confirmationTranscript,
    );
    const record = encodeE2eeServerAccept({ ...tbsInput, serverConfirmation });
    const sessionBindingHash = e2eeSessionBindingHash({
      clientHelloWireBytes: helloWireBytes,
      serverAcceptWireBytes: record,
      contextBlock: context.block,
    });

    this.#admittedAuthority = snapshot;
    this.#accountGrantAuthority = accountGrantSnapshot;
    this.#state = "e2ee";
    return {
      kind: "accepted",
      record,
      sessionBindingHash,
      peerEphemeralPublicKey,
      secrets,
      suite,
      tier,
      trustSource: e2eeHandshakeTrustSource(tier, suite),
      contextBlock: context.block,
      contextCommitment: context.commitment,
      serverAcceptTbs,
      confirmationTranscript,
      admittedAuthority: snapshot,
      accountGrantAuthority: accountGrantSnapshot,
      implicitFinishDeadlineAt: this.#implicitFinishDeadlineAt,
    };
  }

  /**
   * §8.9: the FIRST VALID client-to-node `0x01` envelope is the client's
   * confirmation that it verified `E2EEServerAccept`, matched the context, and
   * derived identical keys. The caller invokes this once that envelope has
   * authenticated under the client's epoch-0 sequence (§9) — never before.
   *
   * It is also the first point at which the node may invoke the RPC handler,
   * and therefore the last re-check point before a withdrawn authority could
   * reach application state. On IK an implementation that cannot locally prove
   * the §13.6 ordering MUST re-read the Branch A record it looked up at §8.6
   * step 6 — with the FULL RECORD KEY of the snapshot, not the fingerprint
   * alone — and apply the §13.6 withdrawal test against the snapshot. Re-reading
   * only `status` is not sufficient.
   *
   * NX carries no Branch A record and therefore no snapshot, so no withdrawal
   * can name an NX channel and there is nothing to re-read (§12.4 governs NX
   * admission instead).
   */
  authenticateImplicitFinish(input: {
    readonly now: number;
    /**
     * The §13.6 re-read, for the IK re-check. Omitted where the implementation
     * can prove the §13.6 ordering locally; when supplied it MUST be the record
     * read under the snapshot's full key.
     */
    readonly reReadAuthorization?:
      | ((key: E2eeClientAuthorizationKey) => E2eeClientAuthorization | undefined)
      | undefined;
    /** §18.7 account/enrollment epoch and policy re-check for suite 0x02. */
    readonly reReadAccountGrantAuthorization?:
      | ((snapshot: E2eeAccountGrantAuthoritySnapshot) => boolean)
      | undefined;
  }): E2eeImplicitFinishResult {
    if (this.#state !== "e2ee") {
      throw new TypeError("Relay E2EE implicit finish requires an established handshake.");
    }
    try {
      return this.#authenticateImplicitFinish(input);
    } catch (error) {
      // The re-read is a caller callback and the §13.6 withdrawal test ranks a
      // STORED role through the §8.3 ordering, which throws on a literal the
      // relay vocabulary does not admit. Either throw arrives after the client's
      // first envelope has authenticated — a commitment this method cannot undo
      // — and this is the last re-check before a withdrawn authority could reach
      // application state, so it fails closed: the object is spent, `finished`
      // is never reached, and §8.9's RPC gates stay shut.
      this.#state = "failed";
      throw error;
    }
  }

  #authenticateImplicitFinish(input: {
    readonly now: number;
    readonly reReadAuthorization?:
      | ((key: E2eeClientAuthorizationKey) => E2eeClientAuthorization | undefined)
      | undefined;
    readonly reReadAccountGrantAuthorization?:
      | ((snapshot: E2eeAccountGrantAuthoritySnapshot) => boolean)
      | undefined;
  }): E2eeImplicitFinishResult {
    if (this.deadlineExpired(input.now)) {
      this.#state = "failed";
      return {
        kind: "fatal",
        row: "Q8",
        errorCode: "protocol_violation",
        reason: "implicit_finish_deadline",
      };
    }
    const snapshot = this.#admittedAuthority;
    if (snapshot !== undefined && input.reReadAuthorization !== undefined) {
      const record = input.reReadAuthorization({
        hubOrigin: snapshot.hubOrigin,
        accountId: snapshot.accountId,
        clientIdentityFingerprint: snapshot.clientIdentityFingerprint,
      });
      if (e2eeAuthorizationWithdrawn(snapshot, record)) {
        this.#state = "failed";
        return {
          kind: "fatal",
          row: "Q9",
          errorCode: "policy",
          reason: "authorization_withdrawn",
        };
      }
    }
    const accountSnapshot = this.#accountGrantAuthority;
    if (
      accountSnapshot !== undefined &&
      input.reReadAccountGrantAuthorization !== undefined &&
      !input.reReadAccountGrantAuthorization(accountSnapshot)
    ) {
      this.#state = "failed";
      return {
        kind: "fatal",
        row: "Q9",
        errorCode: "policy",
        reason: "authorization_withdrawn",
      };
    }
    this.#state = "finished";
    return { kind: "finished" };
  }

  #fail(failure: E2eeHandshakeFailure): E2eeHandshakeFailure {
    this.#state = "failed";
    return failure;
  }

  /**
   * The same funnel as `#fail`, for a LOCAL failure — a throw out of a
   * transcript builder or an encoder, on material this node holds rather than on
   * peer input. §11.2's table enumerates peer-input conditions only and this
   * module's convention is that local mistakes throw, so no row is invented for
   * it; what it still MUST do is what every §11.2 failure does — erase the
   * partial handshake state and spend the object, because §8.1 admits exactly
   * one attempt per channel and an object left in `awaiting_hello` with a live
   * Noise state would admit a second.
   *
   * The handshake is optional because the funnel covers the whole of §8.6: a
   * throw out of step 1's `admitAttempt`, step 2's `readPolicy`, or the step-3
   * prologue encoder lands here before any Noise state exists, and it spends the
   * object exactly as a later one does.
   */
  #failLocal(noise: E2eeNoiseHandshake | undefined): void {
    noise?.destroy();
    this.#state = "failed";
  }
}
