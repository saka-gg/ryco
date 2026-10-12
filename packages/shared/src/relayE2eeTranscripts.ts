import {
  HubDeviceGrantClaims as HubDeviceGrantClaimsSchema,
  type HubDeviceGrantClaims,
} from "@ryco/contracts/native-e2ee";
import { RelayCapability, RelayChannelId, RelayEffectiveRole } from "@ryco/contracts/relay";
import { sha256 } from "@noble/hashes/sha2.js";
import { Tokenizer, Type, decode, encode, rfc8949EncodeOptions } from "cborg";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  E2EE_AGREEMENT_PUBLIC_KEY_BYTES,
  E2EE_CAPABILITY_CARRIER_MAX_BYTES,
  E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES,
  E2EE_CAPABILITY_STATEMENT_MAX_BYTES,
  E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES,
  E2EE_CONTEXT_COMMITMENT_BYTES,
  E2EE_CONTINUITY_CHAIN_MAX_LENGTH,
  E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES,
  E2EE_HUB_ORIGIN_MAX_BYTES,
  E2EE_KEY_FINGERPRINT_BYTES,
  E2EE_PROTOCOL_VERSION,
  E2EE_SUITE_REGISTRY_MAX_ENTRIES,
  E2EE_TRANSCRIPT_DIGEST_BYTES,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
} from "./relayE2eeConstants.ts";
import { assertE2eeAccountId } from "./relayE2eeIds.ts";
import {
  E2EE_CLIENT_IDENTITY_ALGORITHM,
  E2EE_NODE_IDENTITY_ALGORITHM,
  RelayE2eeValidationError,
  e2eeBytesEqual,
  e2eeKeyFingerprint,
  invalidRelayE2eeInput,
  validateE2eeAgreementPublicKey,
  validateE2eeClientIdentityPublicKey,
  validateE2eeClientSignature,
  validateE2eeNodeIdentityPublicKey,
  validateE2eeNodeSignature,
  verifyE2eeSignature,
} from "./relayE2eeKeys.ts";
import {
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
  isE2eeSuiteId,
  type E2eeSuiteId,
} from "./relayE2eeWire.ts";

// Transcripts, certificates, and the authorization context of the Ryco relay
// E2EE protocol — docs/relay-e2ee-protocol.md §7.2.1 (capability signing
// envelope), §7.3–§7.6 (certificates and statements), §8.3 (authorization
// context block), and §8.4 (Noise prologue).
//
// Every encoder here follows the convention the pre-existing node-identity
// encoders set (`nodeIdentity.ts`) and §7.1 restates: validate the inputs,
// canonicalize what has a canonical form, and emit a canonical-CBOR (§3.6)
// definite-length array whose FIRST element is the structure's domain string
// (§3.5). Domain separation lives entirely in the encoders — the node identity
// signing interface signs whatever bytes it is handed, so a structure that
// reached it without a distinct domain would be an attacker-influenced signing
// oracle (§7.2).
//
// NO CONSUMER MAY BUILD TO-BE-SIGNED BYTES AD HOC (§7.2). The signing inputs of
// this protocol are exactly the outputs of the encoders below and of the two
// pre-existing node-identity encoders, and nothing else may be handed to the
// node identity key or to the mobile device key.
//
// Fingerprints are always RECOMPUTED here, never accepted as inputs: §7.1 says a
// verifier MUST recompute every fingerprint it consumes from the
// algorithm-labelled raw public key, and an encoder that took one as a parameter
// would let a caller sign a key under another key's fingerprint. The single
// place a CARRIED fingerprint is an input is the §7.6 cross-signature
// reconstruction, which §7.6 fixes to rebuild the §7.3 array from the
// statement's carried element 6 rather than from a re-derivation — and which
// recomputes that fingerprint anyway and refuses a disagreement, so no
// fingerprint is ever accepted on the carrier's authority.
//
// Encoders throw `RelayE2eeValidationError`; the reachable causes are local
// programming errors and structures a peer supplied that this protocol will not
// represent at all. The one exception is the §7.6.1 bound the §7.6 encoder
// applies to its own output, which throws the `RelayE2eeCapabilityBoundError`
// subclass NAMING the bound, because that failure is the node's own
// configuration rather than peer input. Validators over peer-supplied
// structures — the continuity chain, the canonical-CBOR decode — return typed
// results instead, matching `relayE2eeWire.ts`: those are conditions the caller
// maps onto a §11 row.
//
// Like `relayE2eeConstants.ts` and `relayE2eeKeys.ts` this module is free of
// Node built-ins, because the web and native clients both validate node-signed
// statements and the native client signs its own §7.4 certificate. That is why
// `canonicalizeE2eeHubOrigin` restates the node-identity canonicalization rather
// than importing it from `nodeIdentity.ts`, which imports `node:crypto`;
// `relayE2eeTranscripts.test.ts` pins the two to agree, accepted origin for
// accepted origin and rejected origin for rejected origin.

// ─── §3.5 transcript domains ─────────────────────────────────────────────────

/** Node agreement-prekey certificate transcript (§7.3). */
export const E2EE_NODE_PREKEY_TRANSCRIPT_DOMAIN = "ryco.node-e2ee-prekey.v1" as const;
/** Client agreement-prekey certificate transcript (§7.4). */
export const E2EE_CLIENT_PREKEY_TRANSCRIPT_DOMAIN = "ryco.client-e2ee-prekey.v1" as const;
/** Node identity-continuity certificate transcript (§7.5). */
export const E2EE_NODE_IDENTITY_CONTINUITY_TRANSCRIPT_DOMAIN =
  "ryco.node-identity-continuity.v1" as const;
/** Capability statement transcript (§7.6). */
export const E2EE_NODE_CAPABILITY_TRANSCRIPT_DOMAIN = "ryco.node-e2ee-capability.v1" as const;
/** Capability signing envelope (§7.2.1) — the structure actually signed. */
export const E2EE_NODE_CAPABILITY_DIGEST_DOMAIN = "ryco.node-e2ee-capability-digest.v1" as const;
/** Authorization context block (§8.3). */
export const E2EE_CONTEXT_DOMAIN = "ryco.relay-e2ee.context.v1" as const;
/** Account-enrolled native authorization context block (§18.6). */
export const E2EE_ACCOUNT_CONTEXT_DOMAIN = "ryco.relay-e2ee.account-context.v1" as const;
/** Noise prologue array (§8.4). */
export const E2EE_PROLOGUE_DOMAIN = "ryco.relay-e2ee.prologue.v1" as const;
/**
 * Fallback-occurrence origin-hash input array (§12.5).
 *
 * The one §3.5 domain that is never signed and never leaves the node: it names
 * the input to the `originHash` of a §12.5 ring entry, whose whole purpose is to
 * let a node tell two Hub origins apart in its own instrumentation WITHOUT
 * retaining the origin. It is listed in §3.5 with the rest so the distinctness
 * rule covers it too.
 */
export const E2EE_FALLBACK_ORIGIN_DOMAIN = "ryco.relay-e2ee.fallback-origin.v1" as const;

// ─── §3.4 Noise usage literals ───────────────────────────────────────────────

/** §7.3 element 9 / §7.4 element 7: the suite's DH function. */
export const E2EE_NOISE_DH = "25519" as const;
/** §7.3 element 10 / §7.4 element 8: the suite's hash function. */
export const E2EE_NOISE_HASH = "SHA256" as const;

/** Noise pattern of the signed native tier (§8.1); §7.6 element 14 literal. */
export const E2EE_NOISE_PATTERN_IK = "IK" as const;
/** Noise pattern of the unsigned web tier (§8.1); §7.6 element 14 literal. */
export const E2EE_NOISE_PATTERN_NX = "NX" as const;

export type E2eeNoisePattern = typeof E2EE_NOISE_PATTERN_IK | typeof E2EE_NOISE_PATTERN_NX;

/** The two client tiers, named by the `tier` literals of §8.5 element 1. */
export type E2eeTier = "native" | "web";

/** The Noise pattern a tier runs (§8.1). */
export function e2eeTierNoisePattern(tier: E2eeTier): E2eeNoisePattern {
  return tier === "native" ? E2EE_NOISE_PATTERN_IK : E2EE_NOISE_PATTERN_NX;
}

/**
 * §7.6 element 14, the effective admitted pattern set. It is COMPUTED from the
 * node's committed policy rather than configured, which is what makes it
 * impossible for a node to advertise a set it does not serve; the order is fixed
 * as `"IK"` then `"NX"`. §5.2 step 9 is the only rule that reads it.
 */
export function e2eeEffectiveAdmittedPatterns(
  requireApprovedClientE2EE: boolean,
): readonly E2eeNoisePattern[] {
  return requireApprovedClientE2EE
    ? [E2EE_NOISE_PATTERN_IK]
    : [E2EE_NOISE_PATTERN_IK, E2EE_NOISE_PATTERN_NX];
}

// ─── §3.6 canonical CBOR ─────────────────────────────────────────────────────

/**
 * The §3.6 strict decode profile. `allowBigInt` stays off: no E2EE structure
 * requires the full `uint64` range, because counters and epochs travel as
 * fixed-width byte fields (§3.3) and never as CBOR integers.
 */
export const E2EE_STRICT_DECODE_OPTIONS = {
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

export type E2eeCanonicalDecodeError = "malformed" | "non_canonical" | "float_forbidden";

export type E2eeDecoded<Value> =
  | { readonly kind: "ok"; readonly value: Value }
  | { readonly kind: "error"; readonly reason: E2eeCanonicalDecodeError };

/**
 * §3.6 forbids floating-point values in every E2EE structure and requires a
 * decoder to REJECT any it sees, which is an obligation of its own rather than a
 * consequence of the option list above: those options refuse NaN and infinities
 * only, and the re-encode rule does not close the gap either, because the pinned
 * codec re-emits a shortest-form finite float as the exact bytes it arrived in.
 *
 * THE REJECTION IS OVER THE ENCODING AND NEVER OVER THE DECODED VALUE, because
 * the decoded value cannot carry the distinction: `f9 3c00` is float16 1.0 and
 * reaches JavaScript as a value nothing can tell from the integer 1, so a walk
 * over decoded values leaves every integral float to the re-encode rule, which
 * rejects it under the misleading `non_canonical` reason. Walking the token
 * stream sees the major type instead, so every float head — `f9`, `fa`, and
 * `fb`, at any depth, in a map key as readily as in a value — is
 * `float_forbidden`. NO FLOAT CLASS IS LEFT OVER: a CBOR float is major type 7
 * with minor 25, 26, or 27 and nothing else, every one of those decodes to the
 * codec's float token, and no other head does. Content bytes that merely look
 * like a float head are not one — the walk skips a byte or text string's payload
 * by its length — so nothing legitimate is lost either. The one class this walk
 * never sees is the one §3.6 already hands to the option list: NaN and the
 * infinities fail the decode above and stay `malformed`, one step earlier.
 *
 * PRECONDITION: `bytes` decoded successfully under `E2EE_STRICT_DECODE_OPTIONS`.
 * The codec's `decode` is `decodeFirst` plus a no-remainder check, so it already
 * drove this same tokenizer across these same bytes under these same options and
 * consumed all of them; replaying that walk yields the same token sequence and
 * cannot throw where the decode did not.
 */
function containsE2eeFloatEncoding(bytes: Uint8Array): boolean {
  const tokenizer = new Tokenizer(bytes, E2EE_STRICT_DECODE_OPTIONS);
  while (!tokenizer.done()) {
    if (Type.equals(tokenizer.next().type, Type.float)) return true;
  }
  return false;
}

/**
 * Strict decode, the §3.6 float rejection, and the §3.6 re-encode byte-equality
 * rule, which every verifier MUST apply before acting on a decoded transcript.
 * Bytes that decode but do not re-encode to themselves are not the bytes a
 * signature covers, whatever they decode to.
 */
export function decodeCanonicalE2eeCbor(bytes: Uint8Array): E2eeDecoded<unknown> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return { kind: "error", reason: "malformed" };
  }
  let value: unknown;
  try {
    value = decode(bytes, E2EE_STRICT_DECODE_OPTIONS);
  } catch {
    // `cborg`'s strict reader rejects some well-formed but non-minimal heads
    // before the re-encode check can classify them. Decode once more with only
    // that canonicality gate relaxed so diagnostics can retain the protocol's
    // closed `non_canonical` distinction. This second result is never returned
    // or acted upon; it can only refine a rejection.
    try {
      const laxValue = decode(bytes, { ...E2EE_STRICT_DECODE_OPTIONS, strict: false });
      const canonical = encode(laxValue, rfc8949EncodeOptions);
      if (!e2eeBytesEqual(canonical, bytes)) {
        return { kind: "error", reason: "non_canonical" };
      }
    } catch {
      // The bytes are not even a complete value under the bounded lax profile.
    }
    return { kind: "error", reason: "malformed" };
  }
  if (containsE2eeFloatEncoding(bytes)) return { kind: "error", reason: "float_forbidden" };
  let reencoded: Uint8Array;
  try {
    reencoded = encode(value, rfc8949EncodeOptions);
  } catch {
    return { kind: "error", reason: "non_canonical" };
  }
  if (!e2eeBytesEqual(reencoded, bytes)) {
    return { kind: "error", reason: "non_canonical" };
  }
  return { kind: "ok", value };
}

/**
 * The §3.6 canonical encoder, as an array — the one form every structure in this
 * protocol takes.
 *
 * Exported narrowly, and deliberately not as a general `encode`: §7.2's
 * no-ad-hoc-transcript rule is enforced by there being exactly one encoder per
 * domain in this module, and a general canonical `encode` in the public API
 * would be an invitation to build a transcript somewhere else. The one caller
 * outside this module is §12.5's `originHash`, which is a purely local
 * instrumentation digest under `E2EE_FALLBACK_ORIGIN_DOMAIN` — nothing signs it
 * and nothing verifies it — but it MUST be produced by the same canonical
 * profile as everything else, because a second CBOR encoder in the tree is a
 * second definition of "canonical".
 */
export function encodeCanonicalE2eeCbor(elements: readonly unknown[]): Uint8Array {
  return Uint8Array.from(encode(elements, rfc8949EncodeOptions));
}

// ─── §7.1 identifier and origin validation ───────────────────────────────────

const ID_SUFFIX = "[A-Za-z0-9_-]{22}";
const NODE_ID = new RegExp(`^node_${ID_SUFFIX}$`);
const NODE_KEY_ID = new RegExp(`^nkey_${ID_SUFFIX}$`);
const NODE_PREKEY_ID = new RegExp(`^epk_${ID_SUFFIX}$`);
const CONTINUITY_ID = new RegExp(`^nct_${ID_SUFFIX}$`);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const utf8 = new TextEncoder();

const decodeRelayCapability = Schema.decodeUnknownExit(RelayCapability);
const decodeRelayEffectiveRole = Schema.decodeUnknownExit(RelayEffectiveRole);
const decodeRelayChannelId = Schema.decodeUnknownExit(RelayChannelId);
const decodeHubDeviceGrantClaims = Schema.decodeUnknownExit(HubDeviceGrantClaimsSchema);

function assertIdentifier(value: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalidRelayE2eeInput();
  return value;
}

function assertUnsignedSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) invalidRelayE2eeInput();
  return value;
}

function assertPositiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalidRelayE2eeInput();
  return value;
}

function assertProtocolVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) invalidRelayE2eeInput();
  return value;
}

function assertBoolean(value: boolean): boolean {
  if (typeof value !== "boolean") invalidRelayE2eeInput();
  return value;
}

/**
 * The canonical Hub origin as the node identity primitives define it —
 * scheme-validated, exactly equal to the URL origin, no credentials, path,
 * query, or fragment — and additionally at most `E2EE_HUB_ORIGIN_MAX_BYTES`
 * UTF-8 bytes (§7.1).
 *
 * The E2EE bound is deliberately tighter than the primitives' own: the origin
 * appears once per §7.6 statement and once per carried §7.5 certificate, so it
 * is the dominant term in the §3.2.1 S8 size argument. A node whose canonical
 * Hub origin exceeds it cannot serve E2EE and fails the §7.6.1 self-check; it
 * MUST NOT emit a shorter or elided origin.
 */
export function canonicalizeE2eeHubOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    invalidRelayE2eeInput();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidRelayE2eeInput();
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
    invalidRelayE2eeInput();
  }
  if (utf8.encode(url.origin).byteLength > E2EE_HUB_ORIGIN_MAX_BYTES) {
    invalidRelayE2eeInput();
  }
  return url.origin;
}

// Account id (§7.1) validation is dependency-free so Hub account calls can run
// it without loading this module's hash and CBOR implementations.
export { assertE2eeAccountId };

/**
 * A relay capability literal, validated against the relay contract's closed
 * vocabulary. This protocol does not extend it (§1.1) and does not fork it: the
 * `RelayCapability` schema stays the only place a capability literal is checked.
 */
export function assertRelayCapabilityLiteral(value: string): string {
  if (Exit.isFailure(decodeRelayCapability(value))) invalidRelayE2eeInput();
  return value;
}

/** A relay effective-role literal, validated against the relay contract (§8.3). */
export function assertRelayEffectiveRoleLiteral(value: string): string {
  if (Exit.isFailure(decodeRelayEffectiveRole(value))) invalidRelayE2eeInput();
  return value;
}

/** A relay channel id, validated against the relay contract (§8.3, §8.4). */
export function assertRelayChannelIdLiteral(value: string): string {
  if (Exit.isFailure(decodeRelayChannelId(value))) invalidRelayE2eeInput();
  return value;
}

function assertSuiteId(value: number): E2eeSuiteId {
  if (!isE2eeSuiteId(value)) invalidRelayE2eeInput();
  return value;
}

/**
 * A raw §7.1 fingerprint digest. Fingerprints travel in transcripts as raw
 * digest byte strings, never in display form, and a fingerprint accepted as an
 * input here is one the caller recomputed — §7.1 never lets one be accepted on
 * the carrier's authority (§5.2).
 */
function assertFingerprint(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== E2EE_KEY_FINGERPRINT_BYTES) {
    invalidRelayE2eeInput();
  }
  return Uint8Array.from(value);
}

/**
 * The §7.2 direct-signing bound. §7.3, §7.4, and §7.5 are of bounded,
 * non-growing shape and are signed directly, so an encoder producing more than
 * `E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES` is a defect rather than an
 * oversized input to be handled — and this is the assertion that turns that
 * defect into a failing test instead of a node that cannot sign.
 */
function assertDirectSigningBound(transcript: Uint8Array): Uint8Array {
  if (transcript.byteLength > E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES) {
    invalidRelayE2eeInput();
  }
  return transcript;
}

/**
 * A §7.6.1 bound the node's OWN configuration and history failed, NAMED.
 *
 * `RelayE2eeValidationError` is detail-free because the inputs it rejects
 * include peer-supplied bytes and Hub origins, and an error reflecting them
 * would put them in logs and crash reports. That reasoning does not reach here:
 * a §7.6.1 bound is a function of Hub origin length, continuity-chain depth,
 * suite registry, and identifier widths and of nothing any peer supplies, and
 * §7.6.1 requires the node to surface the failure as a startup error naming the
 * failing bound. The name is a constant of this protocol, never a measurement
 * and never an echo of the failing artifact — which may embed the Hub origin.
 *
 * `bound` is drawn from the §7.6.1 self-check's own vocabulary so an operator
 * reads one set of names whichever pass reported the failure, and the error
 * stays a `RelayE2eeValidationError` so the encoder contract of this module —
 * encoders throw that error — holds for callers that do not care which bound it
 * was.
 */
export class RelayE2eeCapabilityBoundError extends RelayE2eeValidationError {
  /** The failing bound, named as `nodeE2eeCapabilitySelfCheck` names it. */
  readonly bound: NodeE2eeCapabilitySelfCheckFailure;

  constructor(bound: NodeE2eeCapabilitySelfCheckFailure) {
    super();
    this.bound = bound;
    this.name = "RelayE2eeCapabilityBoundError";
    this.message = `Relay E2EE capability statement violates ${bound}.`;
  }
}

/**
 * The §7.6 transcript bound, applied by the encoder to its OWN output: a node
 * MUST check it at encode time and MUST NOT emit a statement over
 * `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES`, and in no case may it fit by pruning
 * the continuity chain (§7.5, §7.6.1).
 *
 * This is the encoder's guard and not the §7.6.1 self-check: the self-check is
 * the operator-facing pass that names the failing bound once per configuration
 * change, and it measures the artifacts it is handed, so it still reports
 * `capability_transcript_max_bytes` for an over-long transcript however that
 * transcript was produced. Both name the same bound, because both report the
 * same node-local configuration failure.
 */
function assertCapabilityTranscriptBound(transcript: Uint8Array): Uint8Array {
  if (transcript.byteLength > E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES) {
    throw new RelayE2eeCapabilityBoundError("capability_transcript_max_bytes");
  }
  return transcript;
}

// ─── §7.3 node agreement-prekey certificate ──────────────────────────────────

export interface NodeE2eePrekeyTranscriptInput {
  readonly hubOrigin: string;
  readonly nodeId: string;
  readonly identityKeyId: string;
  readonly prekeyId: string;
  readonly identityPublicKey: Uint8Array;
  readonly agreementPublicKey: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * The §7.3 transcript: a canonical-CBOR array of exactly 13 elements, signed
 * DIRECTLY by the node identity key (the cross-signature). Elements 9 and 10 pin
 * the agreement key's Noise usage to the §3.4 suite functions, so a certificate
 * whose usage fields disagree with the negotiated suite is rejected rather than
 * reinterpreted.
 *
 * `identityAlgorithm` and `identityFingerprint` are not inputs: version 1 admits
 * exactly one node identity algorithm (§7.1) and the fingerprint is recomputed
 * from the identity key.
 */
export function encodeNodeE2eePrekeyTranscript(input: NodeE2eePrekeyTranscriptInput): Uint8Array {
  return encodeNodeE2eePrekeyTranscriptBytes(input);
}

/**
 * The §7.3 element array, with element 7 either recomputed from element 6 — what
 * the exported encoder above does, and the only behavior a SIGNER may have — or
 * taken verbatim from `carriedIdentityFingerprint`, which is what the §7.6
 * cross-signature reconstruction does with the statement's carried element 6. The
 * two are not equivalent, which is exactly why the reconstruction cannot go
 * through the encoder: a statement whose carried fingerprint disagrees with its
 * identity key MUST reconstruct to bytes the cross-signature does not cover.
 */
function encodeNodeE2eePrekeyTranscriptBytes(
  input: NodeE2eePrekeyTranscriptInput,
  carriedIdentityFingerprint?: Uint8Array,
): Uint8Array {
  const hubOrigin = canonicalizeE2eeHubOrigin(input.hubOrigin);
  const nodeId = assertIdentifier(input.nodeId, NODE_ID);
  const identityKeyId = assertIdentifier(input.identityKeyId, NODE_KEY_ID);
  const prekeyId = assertIdentifier(input.prekeyId, NODE_PREKEY_ID);
  const identityPublicKey = validateE2eeNodeIdentityPublicKey(input.identityPublicKey);
  const identityFingerprint =
    carriedIdentityFingerprint === undefined
      ? e2eeKeyFingerprint("node-identity", identityPublicKey)
      : assertFingerprint(carriedIdentityFingerprint);
  const agreementPublicKey = validateE2eeAgreementPublicKey(input.agreementPublicKey);
  const createdAt = assertUnsignedSafeInteger(input.createdAt);
  const expiresAt = assertUnsignedSafeInteger(input.expiresAt);
  return assertDirectSigningBound(
    encodeCanonicalE2eeCbor([
      E2EE_NODE_PREKEY_TRANSCRIPT_DOMAIN,
      hubOrigin,
      nodeId,
      E2EE_NODE_IDENTITY_ALGORITHM,
      identityKeyId,
      prekeyId,
      identityPublicKey,
      identityFingerprint,
      agreementPublicKey,
      E2EE_NOISE_DH,
      E2EE_NOISE_HASH,
      createdAt,
      expiresAt,
    ]),
  );
}

// ─── §7.4 client agreement-prekey certificate ────────────────────────────────

export interface ClientE2eePrekeyTranscriptInput {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly identityPublicKey: Uint8Array;
  readonly agreementPublicKey: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * The §7.4 transcript: a canonical-CBOR array of exactly 11 elements, signed
 * directly by the mobile device key (ECDSA P-256 over SHA-256, §7.1).
 *
 * It binds the client identity key, the client agreement key, and the
 * `(hubOrigin, accountId)` namespace into one signed statement, and it travels
 * only inside the encrypted IK handshake payload (§8.5) — never in a clear
 * wrapper.
 */
export function encodeClientE2eePrekeyTranscript(
  input: ClientE2eePrekeyTranscriptInput,
): Uint8Array {
  const hubOrigin = canonicalizeE2eeHubOrigin(input.hubOrigin);
  const accountId = assertE2eeAccountId(input.accountId);
  const identityPublicKey = validateE2eeClientIdentityPublicKey(input.identityPublicKey);
  const identityFingerprint = e2eeKeyFingerprint("client-identity", identityPublicKey);
  const agreementPublicKey = validateE2eeAgreementPublicKey(input.agreementPublicKey);
  const createdAt = assertUnsignedSafeInteger(input.createdAt);
  const expiresAt = assertUnsignedSafeInteger(input.expiresAt);
  return assertDirectSigningBound(
    encodeCanonicalE2eeCbor([
      E2EE_CLIENT_PREKEY_TRANSCRIPT_DOMAIN,
      hubOrigin,
      accountId,
      E2EE_CLIENT_IDENTITY_ALGORITHM,
      identityPublicKey,
      identityFingerprint,
      agreementPublicKey,
      E2EE_NOISE_DH,
      E2EE_NOISE_HASH,
      createdAt,
      expiresAt,
    ]),
  );
}

// ─── §7.5 node identity-continuity certificate ───────────────────────────────

export interface NodeIdentityContinuityTranscriptInput {
  readonly hubOrigin: string;
  readonly continuityId: string;
  readonly generation: number;
  readonly oldKeyId: string;
  readonly oldPublicKey: Uint8Array;
  readonly newKeyId: string;
  readonly newPublicKey: Uint8Array;
  readonly createdAt: number;
}

/**
 * The §7.5 transcript: a canonical-CBOR array of exactly 13 elements, signed by
 * the OUTGOING node identity key at rotation time, before that key is destroyed.
 *
 * `generation` starts at 1 for the first rotation and increments by exactly 1
 * per rotation, so 0 is not a generation any certificate may carry; the chain
 * rules that enforce consecutiveness across a carried chain live in
 * `validateNodeE2eeContinuityChain`.
 */
export function encodeNodeIdentityContinuityTranscript(
  input: NodeIdentityContinuityTranscriptInput,
): Uint8Array {
  const hubOrigin = canonicalizeE2eeHubOrigin(input.hubOrigin);
  const continuityId = assertIdentifier(input.continuityId, CONTINUITY_ID);
  const generation = assertPositiveSafeInteger(input.generation);
  const oldKeyId = assertIdentifier(input.oldKeyId, NODE_KEY_ID);
  const oldPublicKey = validateE2eeNodeIdentityPublicKey(input.oldPublicKey);
  const oldFingerprint = e2eeKeyFingerprint("node-identity", oldPublicKey);
  const newKeyId = assertIdentifier(input.newKeyId, NODE_KEY_ID);
  const newPublicKey = validateE2eeNodeIdentityPublicKey(input.newPublicKey);
  const newFingerprint = e2eeKeyFingerprint("node-identity", newPublicKey);
  const createdAt = assertUnsignedSafeInteger(input.createdAt);
  return assertDirectSigningBound(
    encodeCanonicalE2eeCbor([
      E2EE_NODE_IDENTITY_CONTINUITY_TRANSCRIPT_DOMAIN,
      hubOrigin,
      continuityId,
      generation,
      E2EE_NODE_IDENTITY_ALGORITHM,
      oldKeyId,
      oldPublicKey,
      oldFingerprint,
      E2EE_NODE_IDENTITY_ALGORITHM,
      newKeyId,
      newPublicKey,
      newFingerprint,
      createdAt,
    ]),
  );
}

/** The decoded fields of one §7.5 transcript, in the order §7.5 fixes them. */
export interface NodeIdentityContinuityCertificate {
  readonly hubOrigin: string;
  readonly continuityId: string;
  readonly generation: number;
  readonly oldKeyId: string;
  readonly oldPublicKey: Uint8Array;
  readonly oldFingerprint: Uint8Array;
  readonly newKeyId: string;
  readonly newPublicKey: Uint8Array;
  readonly newFingerprint: Uint8Array;
  readonly createdAt: number;
}

const CONTINUITY_TRANSCRIPT_ELEMENTS = 13;

function isTextElement(value: unknown): value is string {
  return typeof value === "string";
}

function isUintElement(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBytesElement(value: unknown, expectedLength: number): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === expectedLength;
}

/**
 * Decode one §7.5 transcript under the §3.6 profile, including the re-encode
 * equality rule, and recompute both fingerprints from the keys they claim to
 * describe. A certificate whose carried fingerprint disagrees with the
 * recomputation is rejected here: §7.1 never lets a fingerprint be accepted on
 * the carrier's authority.
 *
 * Nothing about the signature is checked here; that is the chain walk's job,
 * because which key verifies an entry is a property of the chain and not of the
 * entry.
 */
export function decodeNodeIdentityContinuityTranscript(
  transcript: Uint8Array,
): E2eeDecoded<NodeIdentityContinuityCertificate> {
  const decoded = decodeCanonicalE2eeCbor(transcript);
  if (decoded.kind === "error") return decoded;
  const elements = decoded.value;
  if (!Array.isArray(elements) || elements.length !== CONTINUITY_TRANSCRIPT_ELEMENTS) {
    return { kind: "error", reason: "malformed" };
  }
  const [
    domain,
    hubOrigin,
    continuityId,
    generation,
    oldAlgorithm,
    oldKeyId,
    oldPublicKey,
    oldFingerprint,
    newAlgorithm,
    newKeyId,
    newPublicKey,
    newFingerprint,
    createdAt,
  ] = elements as readonly unknown[];
  if (
    domain !== E2EE_NODE_IDENTITY_CONTINUITY_TRANSCRIPT_DOMAIN ||
    oldAlgorithm !== E2EE_NODE_IDENTITY_ALGORITHM ||
    newAlgorithm !== E2EE_NODE_IDENTITY_ALGORITHM ||
    !isTextElement(hubOrigin) ||
    !isTextElement(continuityId) ||
    !isUintElement(generation) ||
    !isTextElement(oldKeyId) ||
    !isTextElement(newKeyId) ||
    !isBytesElement(oldPublicKey, ED25519_PUBLIC_KEY_BYTES) ||
    !isBytesElement(oldFingerprint, E2EE_KEY_FINGERPRINT_BYTES) ||
    !isBytesElement(newPublicKey, ED25519_PUBLIC_KEY_BYTES) ||
    !isBytesElement(newFingerprint, E2EE_KEY_FINGERPRINT_BYTES) ||
    !isUintElement(createdAt)
  ) {
    return { kind: "error", reason: "malformed" };
  }
  if (
    !NODE_KEY_ID.test(oldKeyId) ||
    !NODE_KEY_ID.test(newKeyId) ||
    !CONTINUITY_ID.test(continuityId) ||
    generation < 1
  ) {
    return { kind: "error", reason: "malformed" };
  }
  let recomputedOld: Uint8Array;
  let recomputedNew: Uint8Array;
  try {
    recomputedOld = e2eeKeyFingerprint("node-identity", oldPublicKey);
    recomputedNew = e2eeKeyFingerprint("node-identity", newPublicKey);
  } catch {
    return { kind: "error", reason: "malformed" };
  }
  if (
    !e2eeBytesEqual(recomputedOld, oldFingerprint) ||
    !e2eeBytesEqual(recomputedNew, newFingerprint)
  ) {
    return { kind: "error", reason: "malformed" };
  }
  return {
    kind: "ok",
    value: {
      hubOrigin,
      continuityId,
      generation,
      oldKeyId,
      oldPublicKey,
      oldFingerprint,
      newKeyId,
      newPublicKey,
      newFingerprint,
      createdAt,
    },
  };
}

/** The carried form of one §7.5 certificate: `[ bstr(transcript), bstr(signature) ]`. */
export interface NodeIdentityContinuityChainEntry {
  readonly transcript: Uint8Array;
  readonly signature: Uint8Array;
}

/**
 * The carried shape of one entry, checked rather than assumed: the chain reaches
 * this module from a decoded peer statement relayed by an untrusted Hub, so the
 * declared type is a convenience for local callers and not a runtime fact. A
 * shape this rejects is `malformed_entry` and never a thrown `TypeError`.
 */
function isContinuityChainEntry(value: unknown): value is NodeIdentityContinuityChainEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<NodeIdentityContinuityChainEntry>;
  return (
    entry.transcript instanceof Uint8Array &&
    entry.signature instanceof Uint8Array &&
    entry.signature.byteLength === ED25519_SIGNATURE_BYTES
  );
}

export interface NodeIdentityContinuityChainInput {
  /** §7.6 element 11, in carried order. An empty chain is valid: the node has never rotated. */
  readonly chain: readonly NodeIdentityContinuityChainEntry[];
  /** §7.6 element 1. Every entry MUST carry the identical value. */
  readonly hubOrigin: string;
  /** §7.6 element 18. Every entry MUST carry the identical value. */
  readonly continuityId: string;
  /** §7.6 element 5 — the node's current identity key. */
  readonly identityPublicKey: Uint8Array;
  /**
   * The verifier's pinned node identity fingerprint (§13.1), when it holds one.
   * With a pin supplied, the chain is accepted only if it reaches that pin.
   */
  readonly pinnedIdentityFingerprint?: Uint8Array | undefined;
}

export type NodeIdentityContinuityChainFailure =
  | "chain_too_long"
  | "malformed_entry"
  /**
   * §7.6 element 5 — the statement's own identity key — is not a key this
   * protocol represents. It is its own failure and not `malformed_entry`,
   * because no entry is at fault: the chain may be empty, and a node that has
   * never rotated carries exactly that.
   */
  | "invalid_identity_key"
  | "hub_origin_mismatch"
  | "continuity_id_mismatch"
  | "generation_not_consecutive"
  | "link_mismatch"
  | "invalid_signature"
  | "identity_key_mismatch"
  | "pin_not_reached";

export type NodeIdentityContinuityChainResult =
  | {
      readonly kind: "ok";
      readonly certificates: readonly NodeIdentityContinuityCertificate[];
      /**
       * True when a pin was supplied and already equalled the current identity
       * key, so no rotation happened since it was recorded. False when the pin
       * was reached through the chain, which is the §13.3 silent pin update.
       * Undefined when no pin was supplied.
       */
      readonly pinnedFingerprintUnchanged?: boolean;
    }
  | { readonly kind: "error"; readonly failure: NodeIdentityContinuityChainFailure };

/**
 * The §7.5 chain rules, applied to the chain a statement carries.
 *
 * Within the carried chain: generations are consecutive and strictly
 * increasing; each entry's `oldPublicKey`/`oldFingerprint` equals the previous
 * entry's `newPublicKey`/`newFingerprint`; every entry's `continuityId` equals
 * the statement-level continuity id, which subsumes the requirement that the
 * entries agree with each other; `hubOrigin` is identical across all entries;
 * and the final entry's new key equals the statement's current identity key.
 * Every signature is verified under THAT ENTRY'S OLD KEY — the outgoing key
 * signs the rotation away from itself — and every fingerprint is recomputed.
 *
 * A verifier holding a pin accepts the current identity key only by walking from
 * the certificate whose `oldFingerprint` equals the pin to the final entry, so a
 * chain that verifies internally but does not reach the pin is rejected: a
 * spliced, reordered, truncated, or signature-invalid chain, a generation
 * regression, and a continuity id disagreeing with the statement are all
 * channel-fatal and route to the §13 re-verification surface rather than to a
 * silent pin update.
 *
 * A matching continuity id is never evidence of identity (§7.5): agreement here
 * classifies a channel, and re-anchors nothing.
 *
 * Every input is peer-supplied and every failure is a typed result: a chain that
 * is not an array, or an entry that is not the carried two-field shape, is
 * `malformed_entry` rather than a thrown error, and an identity key this
 * protocol does not represent is `invalid_identity_key` — element 5 of the
 * statement, reachable with no entries at all, and so never an entry's failure.
 */
export function validateNodeE2eeContinuityChain(
  input: NodeIdentityContinuityChainInput,
): NodeIdentityContinuityChainResult {
  if (!Array.isArray(input.chain)) {
    return { kind: "error", failure: "malformed_entry" };
  }
  if (input.chain.length > E2EE_CONTINUITY_CHAIN_MAX_LENGTH) {
    return { kind: "error", failure: "chain_too_long" };
  }
  let identityPublicKey: Uint8Array;
  let identityFingerprint: Uint8Array;
  try {
    identityPublicKey = validateE2eeNodeIdentityPublicKey(input.identityPublicKey);
    identityFingerprint = e2eeKeyFingerprint("node-identity", identityPublicKey);
  } catch {
    return { kind: "error", failure: "invalid_identity_key" };
  }

  const certificates: NodeIdentityContinuityCertificate[] = [];
  let previous: NodeIdentityContinuityCertificate | undefined;
  for (const entry of input.chain) {
    if (!isContinuityChainEntry(entry)) {
      return { kind: "error", failure: "malformed_entry" };
    }
    const decoded = decodeNodeIdentityContinuityTranscript(entry.transcript);
    if (decoded.kind === "error") return { kind: "error", failure: "malformed_entry" };
    const certificate = decoded.value;
    if (certificate.hubOrigin !== input.hubOrigin) {
      return { kind: "error", failure: "hub_origin_mismatch" };
    }
    if (certificate.continuityId !== input.continuityId) {
      return { kind: "error", failure: "continuity_id_mismatch" };
    }
    if (previous !== undefined) {
      if (certificate.generation !== previous.generation + 1) {
        return { kind: "error", failure: "generation_not_consecutive" };
      }
      if (
        !e2eeBytesEqual(certificate.oldPublicKey, previous.newPublicKey) ||
        !e2eeBytesEqual(certificate.oldFingerprint, previous.newFingerprint)
      ) {
        return { kind: "error", failure: "link_mismatch" };
      }
    }
    if (
      !verifyE2eeSignature({
        algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
        publicKey: certificate.oldPublicKey,
        message: entry.transcript,
        signature: entry.signature,
      })
    ) {
      return { kind: "error", failure: "invalid_signature" };
    }
    certificates.push(certificate);
    previous = certificate;
  }

  if (previous !== undefined && !e2eeBytesEqual(previous.newPublicKey, identityPublicKey)) {
    return { kind: "error", failure: "identity_key_mismatch" };
  }

  const pin = input.pinnedIdentityFingerprint;
  if (pin === undefined) return { kind: "ok", certificates };
  if (e2eeBytesEqual(pin, identityFingerprint)) {
    return { kind: "ok", certificates, pinnedFingerprintUnchanged: true };
  }
  const reached = certificates.some((certificate) =>
    e2eeBytesEqual(certificate.oldFingerprint, pin),
  );
  if (!reached) return { kind: "error", failure: "pin_not_reached" };
  return { kind: "ok", certificates, pinnedFingerprintUnchanged: false };
}

// ─── §7.6 capability statement transcript ────────────────────────────────────

export interface NodeE2eeCapabilityPrekeyCertificate {
  readonly prekeyId: string;
  readonly agreementPublicKey: Uint8Array;
  /** The §7.3 cross-signature over the reconstructible node prekey transcript. */
  readonly crossSignature: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface NodeE2eeCapabilityTranscriptInput {
  readonly hubOrigin: string;
  readonly nodeId: string;
  readonly identityKeyId: string;
  readonly identityPublicKey: Uint8Array;
  readonly e2eeVersionMin: number;
  readonly e2eeVersionMax: number;
  readonly suiteRegistry: readonly number[];
  readonly prekeyCertificate: NodeE2eeCapabilityPrekeyCertificate;
  readonly continuityChain: readonly NodeIdentityContinuityChainEntry[];
  readonly requireE2EE: boolean;
  readonly requireApprovedClientE2EE: boolean;
  readonly policyGeneration: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly continuityId: string;
}

/**
 * The §7.6 transcript: a canonical-CBOR array of exactly 19 elements. This fixes
 * the byte-level encoding of the §5.2 statement.
 *
 * Two elements are derived rather than accepted. Element 14, the effective
 * admitted pattern set, is computed from `requireApprovedClientE2EE` (§7.6), so
 * a node cannot advertise a set it does not serve. The prekey certificate's
 * agreement fingerprint (member 3) is recomputed from the agreement key, like
 * every other fingerprint here.
 *
 * The transcript is NEVER signed directly — its length grows with the carried
 * continuity chain, so it is signed through the fixed-size §7.2.1 envelope.
 * `E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES` is checked HERE, at encode time, as §7.6
 * requires of a node that MUST NOT emit a statement over it, and again by the
 * envelope encoder, which will not sign bytes it may not sign (§7.2, §7.6.1).
 */
export function encodeNodeE2eeCapabilityTranscript(
  input: NodeE2eeCapabilityTranscriptInput,
): Uint8Array {
  const hubOrigin = canonicalizeE2eeHubOrigin(input.hubOrigin);
  const nodeId = assertIdentifier(input.nodeId, NODE_ID);
  const identityKeyId = assertIdentifier(input.identityKeyId, NODE_KEY_ID);
  const identityPublicKey = validateE2eeNodeIdentityPublicKey(input.identityPublicKey);
  const identityFingerprint = e2eeKeyFingerprint("node-identity", identityPublicKey);
  const e2eeVersionMin = assertProtocolVersion(input.e2eeVersionMin);
  const e2eeVersionMax = assertProtocolVersion(input.e2eeVersionMax);
  if (e2eeVersionMin > e2eeVersionMax) invalidRelayE2eeInput();

  if (
    !Array.isArray(input.suiteRegistry) ||
    input.suiteRegistry.length === 0 ||
    input.suiteRegistry.length > E2EE_SUITE_REGISTRY_MAX_ENTRIES
  ) {
    invalidRelayE2eeInput();
  }
  const suiteRegistry = input.suiteRegistry.map(assertSuiteId);

  const prekeyId = assertIdentifier(input.prekeyCertificate.prekeyId, NODE_PREKEY_ID);
  const agreementPublicKey = validateE2eeAgreementPublicKey(
    input.prekeyCertificate.agreementPublicKey,
  );
  const agreementFingerprint = e2eeKeyFingerprint("agreement", agreementPublicKey);
  const crossSignature = validateE2eeNodeSignature(input.prekeyCertificate.crossSignature);
  const prekeyCreatedAt = assertUnsignedSafeInteger(input.prekeyCertificate.createdAt);
  const prekeyExpiresAt = assertUnsignedSafeInteger(input.prekeyCertificate.expiresAt);

  if (
    !Array.isArray(input.continuityChain) ||
    input.continuityChain.length > E2EE_CONTINUITY_CHAIN_MAX_LENGTH
  ) {
    invalidRelayE2eeInput();
  }
  const continuityChain = input.continuityChain.map((entry) => {
    if (!(entry.transcript instanceof Uint8Array) || entry.transcript.byteLength === 0) {
      invalidRelayE2eeInput();
    }
    const transcript = assertDirectSigningBound(Uint8Array.from(entry.transcript));
    return [transcript, validateE2eeNodeSignature(entry.signature)];
  });

  const requireE2EE = assertBoolean(input.requireE2EE);
  const requireApprovedClientE2EE = assertBoolean(input.requireApprovedClientE2EE);
  const admittedPatterns = e2eeEffectiveAdmittedPatterns(requireApprovedClientE2EE);
  const policyGeneration = assertUnsignedSafeInteger(input.policyGeneration);
  const issuedAt = assertUnsignedSafeInteger(input.issuedAt);
  const expiresAt = assertUnsignedSafeInteger(input.expiresAt);
  const continuityId = assertIdentifier(input.continuityId, CONTINUITY_ID);

  return assertCapabilityTranscriptBound(
    encodeCanonicalE2eeCbor([
      E2EE_NODE_CAPABILITY_TRANSCRIPT_DOMAIN,
      hubOrigin,
      nodeId,
      E2EE_NODE_IDENTITY_ALGORITHM,
      identityKeyId,
      identityPublicKey,
      identityFingerprint,
      e2eeVersionMin,
      e2eeVersionMax,
      suiteRegistry,
      [
        prekeyId,
        agreementPublicKey,
        crossSignature,
        agreementFingerprint,
        prekeyCreatedAt,
        prekeyExpiresAt,
      ],
      continuityChain,
      requireE2EE,
      requireApprovedClientE2EE,
      admittedPatterns,
      policyGeneration,
      issuedAt,
      expiresAt,
      continuityId,
    ]),
  );
}

/**
 * The §7.6 statement as a verifier holds it: the exact transcript and signature
 * bytes received, and every element decoded AS CARRIED.
 *
 * NOTHING HERE IS RE-DERIVED. Element 6 and the prekey's member 3 are the values
 * the wire supplied, not recomputations from the keys beside them, because §5.2
 * step 2 is a COMPARISON against the carried value and a decoder that quietly
 * substituted a recomputation would repair the attacker's statement on the way
 * past. The same reasoning fixes §7.6's cross-signature reconstruction to the
 * carried element 6.
 */
export interface NodeE2eeCapabilityStatement {
  /** The exact element bytes the §7.2.1 envelope is rebuilt from (§5.2 step 1). */
  readonly transcript: Uint8Array;
  readonly signature: Uint8Array;
  readonly hubOrigin: string;
  readonly nodeId: string;
  readonly identityKeyId: string;
  readonly identityPublicKey: Uint8Array;
  /** §7.6 element 6, as carried. */
  readonly identityFingerprint: Uint8Array;
  readonly e2eeVersionMin: number;
  readonly e2eeVersionMax: number;
  readonly suiteRegistry: readonly number[];
  readonly prekeyCertificate: NodeE2eeCapabilityAdvertisedPrekeyCertificate;
  readonly continuityChain: readonly NodeIdentityContinuityChainEntry[];
  readonly requireE2EE: boolean;
  readonly requireApprovedClientE2EE: boolean;
  readonly admittedPatterns: readonly E2eeNoisePattern[];
  readonly policyGeneration: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly continuityId: string;
}

export type NodeE2eeCapabilityStatementDecodeFailure =
  /** §5.2 step 0 / §15, applied BEFORE the statement CBOR is decoded. */
  | "statement_too_large"
  | "statement_malformed"
  | "statement_non_canonical"
  | "statement_float_forbidden"
  /** §5.2 step 0 / §15, applied BEFORE the transcript CBOR is decoded. */
  | "transcript_too_large"
  | "transcript_malformed"
  | "transcript_non_canonical"
  | "transcript_float_forbidden"
  /** §7.1 / §15, over element 1. */
  | "hub_origin_too_long"
  /** §7.6 element 9 / §15, checked before any signature verification. */
  | "suite_registry_too_large"
  /** §7.5 / §15, checked before any signature verification. */
  | "continuity_chain_too_long";

export type NodeE2eeCapabilityStatementDecodeResult =
  | { readonly kind: "ok"; readonly value: NodeE2eeCapabilityStatement }
  | { readonly kind: "error"; readonly failure: NodeE2eeCapabilityStatementDecodeFailure };

const CAPABILITY_STATEMENT_ELEMENTS = 2;
const CAPABILITY_TRANSCRIPT_ELEMENTS = 19;
const CAPABILITY_PREKEY_MEMBERS = 6;
const CONTINUITY_CHAIN_ENTRY_MEMBERS = 2;
/** §3.3 gives the envelope's suite field one byte, so no larger id is representable. */
const SUITE_ID_MAX = 0xff;

function statementDecodeFailure(
  reason: E2eeCanonicalDecodeError,
): NodeE2eeCapabilityStatementDecodeFailure {
  if (reason === "non_canonical") return "statement_non_canonical";
  if (reason === "float_forbidden") return "statement_float_forbidden";
  return "statement_malformed";
}

function transcriptDecodeFailure(
  reason: E2eeCanonicalDecodeError,
): NodeE2eeCapabilityStatementDecodeFailure {
  if (reason === "non_canonical") return "transcript_non_canonical";
  if (reason === "float_forbidden") return "transcript_float_forbidden";
  return "transcript_malformed";
}

function decodeFailed(
  failure: NodeE2eeCapabilityStatementDecodeFailure,
): NodeE2eeCapabilityStatementDecodeResult {
  return { kind: "error", failure };
}

function isProtocolVersionElement(value: unknown): value is number {
  return isUintElement(value) && value <= 65_535;
}

function decodeCapabilityPrekey(
  value: unknown,
): NodeE2eeCapabilityAdvertisedPrekeyCertificate | undefined {
  if (!Array.isArray(value) || value.length !== CAPABILITY_PREKEY_MEMBERS) return undefined;
  const [prekeyId, agreementPublicKey, crossSignature, agreementFingerprint, createdAt, expiresAt] =
    value as readonly unknown[];
  if (
    !isTextElement(prekeyId) ||
    !NODE_PREKEY_ID.test(prekeyId) ||
    !isBytesElement(agreementPublicKey, E2EE_AGREEMENT_PUBLIC_KEY_BYTES) ||
    !isBytesElement(crossSignature, ED25519_SIGNATURE_BYTES) ||
    !isBytesElement(agreementFingerprint, E2EE_KEY_FINGERPRINT_BYTES) ||
    !isUintElement(createdAt) ||
    !isUintElement(expiresAt)
  ) {
    return undefined;
  }
  return {
    prekeyId,
    agreementPublicKey,
    crossSignature,
    agreementFingerprint,
    createdAt,
    expiresAt,
  };
}

function decodeCapabilityChainEntry(value: unknown): NodeIdentityContinuityChainEntry | undefined {
  if (!Array.isArray(value) || value.length !== CONTINUITY_CHAIN_ENTRY_MEMBERS) return undefined;
  const [transcript, signature] = value as readonly unknown[];
  if (
    !(transcript instanceof Uint8Array) ||
    transcript.byteLength === 0 ||
    transcript.byteLength > E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES ||
    !isBytesElement(signature, ED25519_SIGNATURE_BYTES)
  ) {
    return undefined;
  }
  return { transcript, signature };
}

/**
 * Decode the §7.6 signed capability statement — the canonical-CBOR array
 * `[ bstr(transcript), bstr(signature) ]` — into its 19 transcript elements,
 * under the §3.6 profile including the re-encode equality rule at BOTH layers.
 *
 * The order is the one §5.2 step 0 and §15 fix and is not an implementation
 * detail: the statement bound is applied before the statement is decoded, the
 * transcript bound before the transcript is decoded, and the §15 counting bounds
 * — suite registry entries and continuity chain depth — before this returns at
 * all, so no signature verification anywhere downstream is reached with an
 * unbounded structure in hand.
 *
 * Element 14 is checked against the set §7.6 DERIVES from element 13 rather than
 * merely parsed: the effective admitted pattern set is computed from the
 * committed policy, so a statement whose two policy elements disagree is
 * self-inconsistent and no admission rule may be run from it.
 *
 * The advertised protocol range is NOT compared against `E2EE_PROTOCOL_VERSION`
 * here, and an inverted range is not a decode failure: §5.2 step 8 gives both
 * the `unusable evidence` disposition, which is not the disposition an invalid
 * statement takes, and a decoder that rejected them would collapse the two.
 *
 * Unregistered suite ids are likewise carried rather than rejected. §3.4 reserves
 * them, so §8.2 cannot select one; refusing the statement instead would make a
 * node that offers one future suite alongside a registered one unreachable.
 */
export function decodeNodeE2eeCapabilityStatement(
  statement: Uint8Array,
): NodeE2eeCapabilityStatementDecodeResult {
  if (!(statement instanceof Uint8Array)) return decodeFailed("statement_malformed");
  if (statement.byteLength > E2EE_CAPABILITY_STATEMENT_MAX_BYTES) {
    return decodeFailed("statement_too_large");
  }
  const outer = decodeCanonicalE2eeCbor(statement);
  if (outer.kind === "error") return decodeFailed(statementDecodeFailure(outer.reason));
  if (!Array.isArray(outer.value) || outer.value.length !== CAPABILITY_STATEMENT_ELEMENTS) {
    return decodeFailed("statement_malformed");
  }
  const [transcript, signature] = outer.value as readonly unknown[];
  if (!(transcript instanceof Uint8Array) || transcript.byteLength === 0) {
    return decodeFailed("statement_malformed");
  }
  // Before anything else is read off the statement, including the shape of the
  // signature element: §5.2 step 0 rejects an over-long transcript rather than
  // reporting whatever else is wrong with the statement carrying it.
  if (transcript.byteLength > E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES) {
    return decodeFailed("transcript_too_large");
  }
  if (!isBytesElement(signature, ED25519_SIGNATURE_BYTES)) {
    return decodeFailed("statement_malformed");
  }

  const inner = decodeCanonicalE2eeCbor(transcript);
  if (inner.kind === "error") return decodeFailed(transcriptDecodeFailure(inner.reason));
  if (!Array.isArray(inner.value) || inner.value.length !== CAPABILITY_TRANSCRIPT_ELEMENTS) {
    return decodeFailed("transcript_malformed");
  }
  const [
    domain,
    hubOrigin,
    nodeId,
    identityAlgorithm,
    identityKeyId,
    identityPublicKey,
    identityFingerprint,
    e2eeVersionMin,
    e2eeVersionMax,
    suiteRegistry,
    prekeyCertificate,
    continuityChain,
    requireE2EE,
    requireApprovedClientE2EE,
    admittedPatterns,
    policyGeneration,
    issuedAt,
    expiresAt,
    continuityId,
  ] = inner.value as readonly unknown[];

  if (
    domain !== E2EE_NODE_CAPABILITY_TRANSCRIPT_DOMAIN ||
    identityAlgorithm !== E2EE_NODE_IDENTITY_ALGORITHM ||
    !isTextElement(hubOrigin) ||
    !isTextElement(nodeId) ||
    !NODE_ID.test(nodeId) ||
    !isTextElement(identityKeyId) ||
    !NODE_KEY_ID.test(identityKeyId) ||
    !isBytesElement(identityPublicKey, ED25519_PUBLIC_KEY_BYTES) ||
    !isBytesElement(identityFingerprint, E2EE_KEY_FINGERPRINT_BYTES) ||
    !isProtocolVersionElement(e2eeVersionMin) ||
    !isProtocolVersionElement(e2eeVersionMax) ||
    typeof requireE2EE !== "boolean" ||
    typeof requireApprovedClientE2EE !== "boolean" ||
    !isUintElement(policyGeneration) ||
    !isUintElement(issuedAt) ||
    !isUintElement(expiresAt) ||
    !isTextElement(continuityId) ||
    !CONTINUITY_ID.test(continuityId)
  ) {
    return decodeFailed("transcript_malformed");
  }

  if (utf8.encode(hubOrigin).byteLength > E2EE_HUB_ORIGIN_MAX_BYTES) {
    return decodeFailed("hub_origin_too_long");
  }
  try {
    canonicalizeE2eeHubOrigin(hubOrigin);
  } catch {
    return decodeFailed("transcript_malformed");
  }

  if (!Array.isArray(suiteRegistry) || suiteRegistry.length === 0) {
    return decodeFailed("transcript_malformed");
  }
  if (suiteRegistry.length > E2EE_SUITE_REGISTRY_MAX_ENTRIES) {
    return decodeFailed("suite_registry_too_large");
  }
  if (!suiteRegistry.every((entry) => isUintElement(entry) && entry <= SUITE_ID_MAX)) {
    return decodeFailed("transcript_malformed");
  }

  if (!Array.isArray(continuityChain)) return decodeFailed("transcript_malformed");
  if (continuityChain.length > E2EE_CONTINUITY_CHAIN_MAX_LENGTH) {
    return decodeFailed("continuity_chain_too_long");
  }
  const chain: NodeIdentityContinuityChainEntry[] = [];
  for (const entry of continuityChain) {
    const decoded = decodeCapabilityChainEntry(entry);
    if (decoded === undefined) return decodeFailed("transcript_malformed");
    chain.push(decoded);
  }

  const prekey = decodeCapabilityPrekey(prekeyCertificate);
  if (prekey === undefined) return decodeFailed("transcript_malformed");

  const derivedPatterns = e2eeEffectiveAdmittedPatterns(requireApprovedClientE2EE);
  if (
    !Array.isArray(admittedPatterns) ||
    admittedPatterns.length !== derivedPatterns.length ||
    !derivedPatterns.every((pattern, index) => admittedPatterns[index] === pattern)
  ) {
    return decodeFailed("transcript_malformed");
  }

  return {
    kind: "ok",
    value: {
      transcript,
      signature,
      hubOrigin,
      nodeId,
      identityKeyId,
      identityPublicKey,
      identityFingerprint,
      e2eeVersionMin,
      e2eeVersionMax,
      suiteRegistry,
      prekeyCertificate: prekey,
      continuityChain: chain,
      requireE2EE,
      requireApprovedClientE2EE,
      admittedPatterns: derivedPatterns,
      policyGeneration,
      issuedAt,
      expiresAt,
      continuityId,
    },
  };
}

// ─── §7.2.1 capability signing envelope ──────────────────────────────────────

/**
 * The §7.2.1 signing envelope: the canonical-CBOR array
 * `[ "ryco.node-e2ee-capability-digest.v1", bstr(SHA-256(transcript)) ]`, which
 * is exactly `E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES` for every input because
 * both elements are fixed-width. It is what the node identity key actually signs
 * for a capability statement.
 *
 * IT TAKES THE TRANSCRIPT, NOT A DIGEST, and that is the point: §7.2.1 forbids
 * any structure that invites a verifier to accept a digest it did not compute,
 * so there is no way to reach this encoder with a digest of bytes other than the
 * ones in hand. It applies the §7.2.1 order — check the transcript's length,
 * digest it, encode the envelope — and the envelope is never transmitted; both
 * signer and verifier rebuild it.
 *
 * A bare 32-byte digest is NOT an acceptable signing input under §7.2 and MUST
 * NOT be signed: it carries no domain and its first byte is unconstrained, which
 * is exactly the ad-hoc signing-oracle shape the rule exists to forbid.
 */
export function encodeNodeE2eeCapabilitySigningEnvelope(transcript: Uint8Array): Uint8Array {
  if (
    !(transcript instanceof Uint8Array) ||
    transcript.byteLength === 0 ||
    transcript.byteLength > E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES
  ) {
    invalidRelayE2eeInput();
  }
  const digest = sha256(transcript);
  if (digest.byteLength !== E2EE_TRANSCRIPT_DIGEST_BYTES) invalidRelayE2eeInput();
  const envelope = encodeCanonicalE2eeCbor([E2EE_NODE_CAPABILITY_DIGEST_DOMAIN, digest]);
  if (envelope.byteLength !== E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES) invalidRelayE2eeInput();
  return envelope;
}

// ─── §7.6.1 statement self-check ─────────────────────────────────────────────

export type NodeE2eeCapabilitySelfCheckFailure =
  | "hub_origin_max_bytes"
  | "capability_transcript_max_bytes"
  | "capability_signing_envelope_bytes"
  | "capability_statement_max_bytes"
  | "capability_carrier_max_bytes"
  | "protocol_version_out_of_range"
  | "continuity_id_unresolved";

export interface NodeE2eeCapabilitySelfCheckInput {
  readonly hubOrigin: string;
  readonly transcript: Uint8Array;
  readonly envelope: Uint8Array;
  /** The §7.6 `[ bstr(transcript), bstr(signature) ]` statement CBOR. */
  readonly statement: Uint8Array;
  /** The §5.3 carrier JSON, UTF-8 encoded. */
  readonly carrier: Uint8Array;
  readonly e2eeVersionMin: number;
  readonly e2eeVersionMax: number;
  /**
   * Whether the §7.5 continuity-id startup cross-check resolved to a single
   * value the node may advertise. §7.6 element 18 is REQUIRED, so a node in the
   * unresolvable state has no conforming statement to build at all.
   */
  readonly continuityIdResolved: boolean;
}

export type NodeE2eeCapabilitySelfCheckResult =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly failure: NodeE2eeCapabilitySelfCheckFailure };

/**
 * The §7.6.1 self-check. Whether a node can build and sign a conforming
 * statement is a function of the node's OWN configuration and history and of
 * nothing any peer supplies, so it is checked once per configuration change —
 * startup, identity rotation, chain append or prune, prekey rotation, policy
 * generation increment — and never once per channel.
 *
 * A failure is an operator-actionable condition, and in no case is it handled by
 * shrinking what is advertised: pruning the continuity chain to make the
 * transcript fit is explicitly forbidden, because chain truncation is
 * channel-fatal for a pinned client and would turn a configuration problem into
 * deployment-wide re-verification prompts (§7.5, §7.6.1).
 *
 * The result names the failing bound so the caller can surface it; it carries no
 * measured length, because the failing artifact may embed the Hub origin.
 */
export function nodeE2eeCapabilitySelfCheck(
  input: NodeE2eeCapabilitySelfCheckInput,
): NodeE2eeCapabilitySelfCheckResult {
  if (utf8.encode(input.hubOrigin).byteLength > E2EE_HUB_ORIGIN_MAX_BYTES) {
    return { kind: "error", failure: "hub_origin_max_bytes" };
  }
  if (input.transcript.byteLength > E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES) {
    return { kind: "error", failure: "capability_transcript_max_bytes" };
  }
  if (input.envelope.byteLength !== E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES) {
    return { kind: "error", failure: "capability_signing_envelope_bytes" };
  }
  if (input.statement.byteLength > E2EE_CAPABILITY_STATEMENT_MAX_BYTES) {
    return { kind: "error", failure: "capability_statement_max_bytes" };
  }
  if (input.carrier.byteLength > E2EE_CAPABILITY_CARRIER_MAX_BYTES) {
    return { kind: "error", failure: "capability_carrier_max_bytes" };
  }
  if (
    !(
      input.e2eeVersionMin <= E2EE_PROTOCOL_VERSION && E2EE_PROTOCOL_VERSION <= input.e2eeVersionMax
    )
  ) {
    return { kind: "error", failure: "protocol_version_out_of_range" };
  }
  if (!input.continuityIdResolved) {
    return { kind: "error", failure: "continuity_id_unresolved" };
  }
  return { kind: "ok" };
}

// ─── §8.3 authorization context block ────────────────────────────────────────

/**
 * The tier-dependent half of the context block. Elements 10 and 16 are the ONLY
 * tier-dependent elements, and modelling them as a discriminated union is what
 * makes the §8.3 absence semantics unrepresentable-wrong: the web tier cannot
 * carry an account id or a client fingerprint pair, and the native tier cannot
 * omit them.
 */
export type E2eeAuthorizationContextClient =
  | {
      readonly tier: "native";
      readonly accountId: string;
      readonly identityFingerprint: Uint8Array;
      readonly agreementFingerprint: Uint8Array;
    }
  | { readonly tier: "web" };

export interface E2eeAuthorizationContextInput {
  readonly hubOrigin: string;
  readonly channelId: string;
  readonly relayProtocolMajor: number;
  readonly relayProtocolMinor: number;
  readonly e2eeVersion: number;
  readonly suiteId: number;
  readonly nodeId: string;
  readonly nodeIdentityFingerprint: Uint8Array;
  readonly clientIntendedCapability: string;
  readonly clientIntendedRole: string;
  readonly channelOpenCapability: string;
  readonly channelOpenEffectiveRole: string;
  /** Element 15 entry 0: the agreement-key fingerprint of the prekey advertised on this channel. */
  readonly nodeAgreementFingerprint: Uint8Array;
  /**
   * Element 15 entries 1…n: the exact §7.5 transcript bytes of the continuity
   * chain advertised ON THIS CHANNEL, in chain order. The digests are taken
   * here, so no caller can contribute a digest of bytes it did not carry.
   */
  readonly nodeContinuityChainTranscripts: readonly Uint8Array[];
  readonly nodeContinuityId: string;
  readonly client: E2eeAuthorizationContextClient;
}

/**
 * The §8.3 authorization context block: a canonical-CBOR array of exactly 18
 * elements under `ryco.relay-e2ee.context.v1`.
 *
 * Both endpoints build it independently from their own state and compare only
 * the commitment (§8.6 step 7), so what this encoder guarantees is that two
 * conforming endpoints holding the same view produce the same bytes. It does NOT
 * check element 11 against element 13 or element 12 against element 14: §8.3
 * requires exact equality at both endpoints, and a difference is a context
 * mismatch the handshake must surface as such (§8.6, §11.3 P13) rather than a
 * structure this encoder refuses to build.
 *
 * The node's own material — elements 7–9, 15, and 17 — belongs to the statement
 * it ADVERTISED ON THIS CHANNEL and not to its current state, so a rotation,
 * chain append, or prune landing between advertisement and hello does not
 * retroactively change an open channel's context (§7.5, §8.3). The caller owns
 * that snapshot; this encoder only fixes the bytes.
 *
 * Element 17 is the continuity id, and agreement on it is not evidence of
 * identity: it detects disagreement about which lineage the channel belongs to
 * and relaxes no guard (§7.5).
 */
function e2eeAuthorizationContextElements(
  input: E2eeAuthorizationContextInput,
  domain: typeof E2EE_CONTEXT_DOMAIN | typeof E2EE_ACCOUNT_CONTEXT_DOMAIN,
): readonly unknown[] {
  const hubOrigin = canonicalizeE2eeHubOrigin(input.hubOrigin);
  const channelId = assertRelayChannelIdLiteral(input.channelId);
  const relayProtocolMajor = assertProtocolVersion(input.relayProtocolMajor);
  const relayProtocolMinor = assertProtocolVersion(input.relayProtocolMinor);
  if (input.e2eeVersion !== E2EE_PROTOCOL_VERSION) invalidRelayE2eeInput();
  const suiteId = assertSuiteId(input.suiteId);
  const nodeId = assertIdentifier(input.nodeId, NODE_ID);
  const nodeIdentityFingerprint = assertFingerprint(input.nodeIdentityFingerprint);
  const clientIntendedCapability = assertRelayCapabilityLiteral(input.clientIntendedCapability);
  const clientIntendedRole = assertRelayEffectiveRoleLiteral(input.clientIntendedRole);
  const channelOpenCapability = assertRelayCapabilityLiteral(input.channelOpenCapability);
  const channelOpenEffectiveRole = assertRelayEffectiveRoleLiteral(input.channelOpenEffectiveRole);
  const nodeContinuityId = assertIdentifier(input.nodeContinuityId, CONTINUITY_ID);

  if (
    !Array.isArray(input.nodeContinuityChainTranscripts) ||
    input.nodeContinuityChainTranscripts.length > E2EE_CONTINUITY_CHAIN_MAX_LENGTH
  ) {
    invalidRelayE2eeInput();
  }
  const nodeCertificateFingerprints: Uint8Array[] = [
    assertFingerprint(input.nodeAgreementFingerprint),
  ];
  for (const transcript of input.nodeContinuityChainTranscripts) {
    if (!(transcript instanceof Uint8Array) || transcript.byteLength === 0) {
      invalidRelayE2eeInput();
    }
    nodeCertificateFingerprints.push(sha256(transcript));
  }

  const accountId =
    input.client.tier === "native" ? assertE2eeAccountId(input.client.accountId) : "";
  const clientCertificateFingerprints =
    input.client.tier === "native"
      ? [
          assertFingerprint(input.client.identityFingerprint),
          assertFingerprint(input.client.agreementFingerprint),
        ]
      : [];

  return [
    domain,
    hubOrigin,
    channelId,
    relayProtocolMajor,
    relayProtocolMinor,
    E2EE_PROTOCOL_VERSION,
    suiteId,
    nodeId,
    E2EE_NODE_IDENTITY_ALGORITHM,
    nodeIdentityFingerprint,
    accountId,
    clientIntendedCapability,
    clientIntendedRole,
    channelOpenCapability,
    channelOpenEffectiveRole,
    nodeCertificateFingerprints,
    clientCertificateFingerprints,
    nodeContinuityId,
  ];
}

export function encodeE2eeAuthorizationContext(input: E2eeAuthorizationContextInput): Uint8Array {
  if (input.suiteId !== E2EE_SUITE_25519_CHACHAPOLY_SHA256) invalidRelayE2eeInput();
  return encodeCanonicalE2eeCbor(e2eeAuthorizationContextElements(input, E2EE_CONTEXT_DOMAIN));
}

export type E2eeAccountGrantAuthorizationContextInput = Omit<
  E2eeAuthorizationContextInput,
  "client" | "suiteId"
> & {
  readonly suiteId: typeof E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256;
  readonly client: Extract<E2eeAuthorizationContextClient, { readonly tier: "native" }>;
  /** A grant already strict-decoded and signature/binding-verified by the caller. */
  readonly grant: HubDeviceGrantClaims;
  /** SHA-256 of the exact signed grant envelope. */
  readonly deviceGrantDigest: Uint8Array;
};

/**
 * The separately domain-separated 29-element suite-0x02 authorization context
 * (§18.6). The first 18 elements have the exact §8.3 construction, while the
 * final 11 bind the single-use grant, ticket, enrollment epochs, statement,
 * certificate, and authority ceiling. Every overlapping field is compared
 * here before bytes are emitted, so a caller cannot commit to two identities.
 */
export function encodeE2eeAccountGrantAuthorizationContext(
  input: E2eeAccountGrantAuthorizationContextInput,
): Uint8Array {
  if (
    input.suiteId !== E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 ||
    input.relayProtocolMajor !== 1 ||
    input.relayProtocolMinor < 3
  ) {
    invalidRelayE2eeInput();
  }
  const decodedGrant = decodeHubDeviceGrantClaims(input.grant);
  if (Exit.isFailure(decodedGrant)) invalidRelayE2eeInput();
  const grant = decodedGrant.value;
  const nodeAgreementFingerprint = assertFingerprint(input.nodeAgreementFingerprint);
  const deviceGrantDigest = assertFingerprint(input.deviceGrantDigest);
  if (
    grant.suiteId !== input.suiteId ||
    grant.issuerHubOrigin !== input.hubOrigin ||
    grant.nodeId !== input.nodeId ||
    grant.accountId !== input.client.accountId ||
    grant.nodeContinuityId !== input.nodeContinuityId ||
    !e2eeBytesEqual(grant.nodeIdentityFingerprint, input.nodeIdentityFingerprint) ||
    !e2eeBytesEqual(grant.nodeAgreementFingerprint, nodeAgreementFingerprint) ||
    !e2eeBytesEqual(grant.deviceIdentityFingerprint, input.client.identityFingerprint) ||
    !e2eeBytesEqual(grant.deviceAgreementFingerprint, input.client.agreementFingerprint)
  ) {
    invalidRelayE2eeInput();
  }
  const base = e2eeAuthorizationContextElements(input, E2EE_ACCOUNT_CONTEXT_DOMAIN);
  return encodeCanonicalE2eeCbor([
    ...base,
    deviceGrantDigest,
    grant.relayTicketId,
    grant.nodeCapabilityStatementDigest,
    grant.clientPrekeyCertificateDigest,
    grant.enrollmentId,
    grant.enrollmentRevision,
    grant.accountAuthEpoch,
    grant.deviceAuthEpoch,
    grant.maximumRole,
    [...grant.capabilities],
    grant.nonce,
  ]);
}

/**
 * The exact §18.4 client-certificate carrier. Its digest, rather than the
 * transcript alone, is bound by a Hub device grant.
 */
export function encodeClientE2eePrekeyCertificateCarrier(
  transcript: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  if (
    !(transcript instanceof Uint8Array) ||
    transcript.byteLength === 0 ||
    transcript.byteLength > E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES
  ) {
    invalidRelayE2eeInput();
  }
  return encodeCanonicalE2eeCbor([
    Uint8Array.from(transcript),
    validateE2eeClientSignature(signature),
  ]);
}

/**
 * `contextCommitment = SHA-256(canonical-CBOR(contextBlock))` (§8.3), of length
 * `E2EE_CONTEXT_COMMITMENT_BYTES`. It travels in the hello wrapper and in
 * `E2EEServerAccept`, and the responder rebuilds the block it commits to from
 * its own state — no wrapper value is trusted (§8.4, §8.6 step 7).
 */
export function e2eeAuthorizationContextCommitment(contextBlock: Uint8Array): Uint8Array {
  if (!(contextBlock instanceof Uint8Array) || contextBlock.byteLength === 0) {
    invalidRelayE2eeInput();
  }
  const commitment = sha256(contextBlock);
  if (commitment.byteLength !== E2EE_CONTEXT_COMMITMENT_BYTES) invalidRelayE2eeInput();
  return commitment;
}

// ─── §8.4 Noise prologue ─────────────────────────────────────────────────────

export interface E2eeNoisePrologueInput {
  readonly hubOrigin: string;
  readonly channelId: string;
  readonly relayProtocolMajor: number;
  readonly relayProtocolMinor: number;
  readonly e2eeVersion: number;
  readonly suiteId: number;
  readonly nodeId: string;
  readonly contextCommitment: Uint8Array;
}

/**
 * The §8.4 Noise prologue, which both sides construct identically. Noise mixes
 * it into the handshake hash, so any disagreement about these public fields or
 * about the commitment makes the handshake fail cryptographically rather than
 * producing a channel the two ends describe differently.
 *
 * The responder takes `contextCommitment` from the hello wrapper; every other
 * element comes from its own channel state, and `e2eeVersion` and `suiteId` are
 * established by the §8.6 step 2 registry check rather than adopted from the
 * wrapper — which is why this encoder accepts only `E2EE_PROTOCOL_VERSION` and a
 * registered suite id.
 *
 * Channel ids are unique per channel, so the prologue — and therefore every
 * Noise message and derived key — is channel-unique: a recorded hello replayed
 * on another channel fails Noise processing outright.
 */
export function encodeE2eeNoisePrologue(input: E2eeNoisePrologueInput): Uint8Array {
  const hubOrigin = canonicalizeE2eeHubOrigin(input.hubOrigin);
  const channelId = assertRelayChannelIdLiteral(input.channelId);
  const relayProtocolMajor = assertProtocolVersion(input.relayProtocolMajor);
  const relayProtocolMinor = assertProtocolVersion(input.relayProtocolMinor);
  if (input.e2eeVersion !== E2EE_PROTOCOL_VERSION) invalidRelayE2eeInput();
  const suiteId = assertSuiteId(input.suiteId);
  const nodeId = assertIdentifier(input.nodeId, NODE_ID);
  if (
    !(input.contextCommitment instanceof Uint8Array) ||
    input.contextCommitment.byteLength !== E2EE_CONTEXT_COMMITMENT_BYTES
  ) {
    invalidRelayE2eeInput();
  }
  return encodeCanonicalE2eeCbor([
    E2EE_PROLOGUE_DOMAIN,
    hubOrigin,
    channelId,
    relayProtocolMajor,
    relayProtocolMinor,
    E2EE_PROTOCOL_VERSION,
    suiteId,
    nodeId,
    Uint8Array.from(input.contextCommitment),
  ]);
}

// ─── §7.6 cross-signature reconstruction ─────────────────────────────────────

/**
 * The §7.6 element 10 members AS A STATEMENT CARRIES THEM. Member 3, the
 * agreement fingerprint, is absent from the encoder's input because an encoder
 * derives every fingerprint it emits, and present here because a verifier
 * recomputes every fingerprint a statement advertises (§7.1, §7.6).
 */
export interface NodeE2eeCapabilityAdvertisedPrekeyCertificate extends NodeE2eeCapabilityPrekeyCertificate {
  readonly agreementFingerprint: Uint8Array;
}

export interface NodeE2eeCapabilityCrossSignatureInput {
  readonly hubOrigin: string;
  readonly nodeId: string;
  readonly identityKeyId: string;
  readonly identityPublicKey: Uint8Array;
  /** §7.6 element 6, exactly as the statement carries it. */
  readonly identityFingerprint: Uint8Array;
  readonly prekeyCertificate: NodeE2eeCapabilityAdvertisedPrekeyCertificate;
}

/**
 * The §7.6 cross-signature reconstruction. The statement does not carry the §7.3
 * transcript bytes; the verifier rebuilds them from the statement's own identity
 * fields and prekey members, and THAT is what binds the advertised prekey to the
 * advertised identity. A prekey lifted from another statement reconstructs to
 * different bytes and fails here.
 *
 * §7.6 FIXES THE CONSTRUCTION FIELD BY FIELD, and element 7 of the reconstructed
 * §7.3 array is the statement's CARRIED element 6 — not a fingerprint re-derived
 * from the statement's identity key. The two differ exactly when the statement
 * disagrees with itself, and the spec's construction is the one that fails there:
 * the reconstruction produces bytes the cross-signature does not cover, whereas
 * re-deriving would repair the disagreement and admit the statement.
 *
 * The separate §7.6 obligation — a verifier recomputes every fingerprint a
 * statement advertises and rejects any disagreement — is enforced here too, over
 * both advertised fingerprints, so the two rules agree on the verdict instead of
 * leaving it to whichever runs first.
 *
 * Returns `false` for any disagreement, including material this protocol will
 * not represent, so a caller holding a decoded statement never has to guard the
 * reconstruction itself.
 */
export function verifyNodeE2eeCapabilityCrossSignature(
  input: NodeE2eeCapabilityCrossSignatureInput,
): boolean {
  let transcript: Uint8Array;
  try {
    transcript = encodeNodeE2eePrekeyTranscriptBytes(
      {
        hubOrigin: input.hubOrigin,
        nodeId: input.nodeId,
        identityKeyId: input.identityKeyId,
        prekeyId: input.prekeyCertificate.prekeyId,
        identityPublicKey: input.identityPublicKey,
        agreementPublicKey: input.prekeyCertificate.agreementPublicKey,
        createdAt: input.prekeyCertificate.createdAt,
        expiresAt: input.prekeyCertificate.expiresAt,
      },
      input.identityFingerprint,
    );
    if (
      !e2eeBytesEqual(
        e2eeKeyFingerprint("node-identity", input.identityPublicKey),
        input.identityFingerprint,
      ) ||
      !e2eeBytesEqual(
        e2eeKeyFingerprint("agreement", input.prekeyCertificate.agreementPublicKey),
        input.prekeyCertificate.agreementFingerprint,
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return verifyE2eeSignature({
    algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
    publicKey: input.identityPublicKey,
    message: transcript,
    signature: input.prekeyCertificate.crossSignature,
  });
}
