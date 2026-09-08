import {
  RELAY_CHUNK_HEADER_BYTES,
  RELAY_CHUNK_MAGIC,
  RELAY_CLOSE_REASONS,
  RELAY_MAX_CHANNELS,
  RELAY_MAX_DATA_CHUNK_BYTES,
  RELAY_MAX_RPC_MESSAGE_BYTES,
  RELAY_MIN_DATA_CHUNK_BYTES,
} from "@ryco/contracts/relay";
import {
  HUB_DEVICE_GRANT_BASE64URL_MAX_CHARS,
  HUB_DEVICE_GRANT_MAX_BYTES,
  HUB_DEVICE_GRANT_MAX_VALIDITY_MS,
  NATIVE_E2EE_MAX_CAPABILITIES,
  NATIVE_E2EE_MAX_GRANT_KEYS,
} from "@ryco/contracts/native-e2ee";

import { RELAY_CHUNK_CAPABILITY_PRELUDE } from "./relayMessageChunks.ts";

// Constants of the Ryco relay E2EE protocol — docs/relay-e2ee-protocol.md §3.2.
//
// §3.2 is the single source of truth in prose; this module is its single source
// of truth in code. Every later slice of the implementation imports from here
// and never re-declares a value, exactly as §3.2 says later sections reference
// constants by name and never restate them.
//
// It also carries the two size budgets §3.2 and §4.5 state as arithmetic over
// those constants and the Hub-asserted `ready` limits rather than as literals —
// `E2EE_NEGOTIATION_BUFFER_MAX_BYTES` and the §4.5 ceilings. They are functions
// of the same two limits over the same constants, so keeping them together is
// what stops the limits type and that arithmetic from being forked twice.
//
// Names and values are the spec's, verbatim. Where a §3.2 row is a format
// description rather than a scalar it is carried in structured form and the row
// is quoted in the doc comment. Where a row is defined by another module — the
// relay chunking, relay connection, RPC keepalive, and `ED25519_*` rows — that
// module stays authoritative: the value is re-exported where importing it is
// free of cost, and cross-checked by `relayE2eeConstants.test.ts` where it is
// not. Rows whose value is non-obvious carry the spec section that fixes them.
//
// DURATIONS ARE MILLISECONDS. §3.2 states timers in ms, validity intervals in
// seconds, and lifetimes in days; a single unit in code is worth more than a
// literal transcription of three, so every duration below is milliseconds and
// shows the arithmetic against the value §3.2 states.
//
// This module is free of Node built-ins so the web and mobile clients can carry
// it; that is also why `ED25519_*` is restated rather than re-exported from
// `nodeIdentity.ts`, which imports `node:crypto`.

// ─── Wire (§3.2 area: Wire; layouts in §3.3) ─────────────────────────────────

/** First post-strip byte of every E2EE envelope (§3.3, §3.4). */
export const E2EE_ENVELOPE_DISCRIMINATOR = 0x01;
/** First post-strip byte of every negotiation record (§3.3, §3.4). */
export const E2EE_NEGOTIATION_DISCRIMINATOR = 0x02;
/** Envelope `version` field value for protocol version 1. */
export const E2EE_PROTOCOL_VERSION = 0x01;
/** Envelope header length: discriminator, version, suite, epoch, counter. */
export const E2EE_ENVELOPE_HEADER_BYTES = 15;
/** Epoch field width (`uint32be`). */
export const E2EE_EPOCH_FIELD_BYTES = 4;
/** Counter field width (`uint64be`). */
export const E2EE_COUNTER_FIELD_BYTES = 8;
/** ChaCha20-Poly1305 authentication tag length. */
export const E2EE_AEAD_TAG_BYTES = 16;
/** Encrypted inner-record type prefix length (§3.4 registry). */
export const E2EE_INNER_TYPE_BYTES = 1;
/**
 * `E2EE_ENVELOPE_HEADER_BYTES + E2EE_AEAD_TAG_BYTES + E2EE_INNER_TYPE_BYTES`;
 * also the minimum envelope length. An envelope shorter than this is malformed
 * and MUST be rejected before any cryptographic processing (§3.3).
 */
export const E2EE_ENVELOPE_OVERHEAD_BYTES = 32;
/** AEAD nonce length: epoch ‖ counter, exactly the ChaCha20-Poly1305 nonce. */
export const E2EE_AEAD_NONCE_BYTES = 12;
/** Length of `sessionBindingHash` (SHA-256 output, §8). */
export const E2EE_SESSION_BINDING_HASH_BYTES = 32;
/** Length of a direction label (§3.4). */
export const E2EE_DIRECTION_LABEL_BYTES = 3;
/** AAD length: header ‖ `sessionBindingHash` ‖ direction label (§3.3). */
export const E2EE_AAD_BYTES = 50;
/** Length of `contextCommitment` (SHA-256 output, §8). */
export const E2EE_CONTEXT_COMMITMENT_BYTES = 32;
/** Length of the `E2EEClientHello` `clientNonce` field (§8). */
export const E2EE_HANDSHAKE_NONCE_BYTES = 32;
/** Length of `serverConfirmation` (HMAC-SHA-256 output, §8). */
export const E2EE_CONFIRMATION_BYTES = 32;
/** Length of `closeCommitment` (SHA-256 output, §10). */
export const E2EE_CLOSE_COMMITMENT_BYTES = 32;
/** Maximum `E2EEError` body length (§11). */
export const E2EE_ERROR_BODY_MAX_BYTES = 16;

// ─── Negotiation (§3.2 area: Negotiation) ────────────────────────────────────

/**
 * Maximum total `E2EEClientHello` record length. Deliberate headroom, not a
 * derived bound: no §3.2.1 invariant ties it to the record's structure, so a
 * revision that grows §7.4 or §8.5 MUST re-check the worst case by hand.
 */
export const E2EE_CLIENT_HELLO_MAX_BYTES = 4_096;
/**
 * Maximum total `E2EEServerAccept` record length — the Noise response, the
 * `channel.open` authority echo, and the prekey binding. Deliberate headroom on
 * the same terms as the row above (§8.7).
 */
export const E2EE_SERVER_ACCEPT_MAX_BYTES = 8_192;
/** Exact total `E2EEHandshakeReject` record length — the only pre-key error record (§11.2). */
export const E2EE_HANDSHAKE_REJECT_BYTES = 64;
/**
 * Zero-byte padding length inside `E2EEHandshakeReject`, sized so the record
 * totals exactly `E2EE_HANDSHAKE_REJECT_BYTES` (§11.2).
 */
export const E2EE_HANDSHAKE_REJECT_PAD_BYTES = 60;
/**
 * Maximum UTF-8 byte length of a canonical Hub origin in any E2EE transcript.
 * Deliberately tighter than the bound the node identity primitives apply, so
 * the §3.2.1 size invariants close (§7.1).
 */
export const E2EE_HUB_ORIGIN_MAX_BYTES = 128;
/** Maximum number of suite ids a capability statement may offer (§7.6 element 9). */
export const E2EE_SUITE_REGISTRY_MAX_ENTRIES = 8;
/**
 * Maximum capability-statement transcript length (§7.6). The transcript is
 * signed through the fixed-size §7.2.1 envelope, so this bound is set by the
 * carrier arithmetic rather than by the signing interface.
 */
export const E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES = 5_120;
/**
 * Maximum canonical-CBOR overhead the `[ bstr(transcript), bstr(signature) ]`
 * statement wrapper adds to a maximal transcript (§7.6).
 */
export const E2EE_STATEMENT_WRAPPER_MAX_BYTES = 70;
/** Maximum capability-statement CBOR length before base64url; derived by §3.2.1 S4. */
export const E2EE_CAPABILITY_STATEMENT_MAX_BYTES = 5_190;
/** Reserved `_tag` value of the capability carrier (§5.3). */
export const E2EE_CAPABILITY_CARRIER_TAG = "ryco.e2ee.capability.v1";
/**
 * Length of the §5.3 carrier JSON with an empty `statement` member — the fixed
 * wrapper the base64url statement text is placed into.
 */
export const E2EE_CAPABILITY_CARRIER_FIXED_BYTES = 49;
/** Maximum carrier JSON length; derived by §3.2.1 S5. */
export const E2EE_CAPABILITY_CARRIER_MAX_BYTES = 6_969;
/**
 * Smallest Hub-asserted `maxDataChunkBytes` on which the advertisement is
 * serviceable (§5.5); satisfies §3.2.1 S6.
 */
export const E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES = 8_192;
/** Maximum UTF-8 byte length of an account identifier in any E2EE structure (§7, §8). */
export const E2EE_ACCOUNT_ID_MAX_BYTES = 256;

// ─── Account-enrolled native grants (§18) ──────────────────────────────────

/** Maximum encoded `[claims, signature]` Hub device-grant envelope. */
export const E2EE_HUB_DEVICE_GRANT_MAX_BYTES = HUB_DEVICE_GRANT_MAX_BYTES;
/** Maximum canonical unpadded-base64url length of a complete grant. */
export const E2EE_HUB_DEVICE_GRANT_B64URL_MAX_CHARS = HUB_DEVICE_GRANT_BASE64URL_MAX_CHARS;
/** Maximum lifetime of a Hub device grant, in milliseconds. */
export const E2EE_HUB_DEVICE_GRANT_MAX_VALIDITY = HUB_DEVICE_GRANT_MAX_VALIDITY_MS;
/** Allowed early-arrival skew. There is deliberately no post-expiry skew. */
export const E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW = 30_000;
/** Exact grant nonce size. */
export const E2EE_HUB_DEVICE_GRANT_NONCE_BYTES = 32;
/** Maximum number of simultaneously advertised Hub grant verification keys. */
export const E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS = NATIVE_E2EE_MAX_GRANT_KEYS;
/** Maximum number of effective capabilities carried by one grant. */
export const E2EE_ACCOUNT_GRANT_CAPABILITIES_MAX = NATIVE_E2EE_MAX_CAPABILITIES;
/** Closed identifier bounds from the §18.2 prefixed-base64url registries. */
export const E2EE_HUB_DEVICE_GRANT_ID_MAX_BYTES = 47;
export const E2EE_HUB_GRANT_KEY_ID_MAX_BYTES = 47;
export const E2EE_NATIVE_ENROLLMENT_ID_MAX_BYTES = 47;
export const E2EE_RELAY_TICKET_ID_MAX_BYTES = 47;
/** Registry id of the account-enrolled native IK suite. */
export const E2EE_ACCOUNT_GRANT_SUITE = 0x02;

/**
 * The two Hub-asserted `ready` limits every size budget below is computed from
 * (§4.5). Both arrive in the relay `ready` frame and both endpoints adopt them
 * verbatim; §2.1 declares the party that chooses them untrusted, so nothing
 * here treats them as negotiated or as trustworthy.
 */
export interface E2eeReadyLimits {
  readonly maxQueuedBytes: number;
  readonly maxControlFrameBytes: number;
}

/**
 * `E2EE_NEGOTIATION_BUFFER_MAX_BYTES` (§3.2, §4.4): the total plaintext bytes
 * an E2EE-capable client MAY hold in its `negotiating` send buffers, summed
 * across every channel on one relay connection.
 *
 * It is a function rather than a literal because §3.2 derives it from the
 * Hub-asserted `ready` limits, and the accounting is per connection because
 * that is the scope of the single relay send queue it mirrors.
 */
export function e2eeNegotiationBufferMaxBytes(limits: E2eeReadyLimits): number {
  return limits.maxQueuedBytes - limits.maxControlFrameBytes;
}

// ─── Size budget (§4.5) ──────────────────────────────────────────────────────

export interface E2eeChannelSizeBudget {
  /**
   * §4.5: `min(RELAY_MAX_RPC_MESSAGE_BYTES, maxQueuedBytes − maxControlFrameBytes)`.
   * The largest ENCRYPTED message — the envelope, which is what the chunking
   * layer sees — this channel may emit.
   */
  readonly effectiveMessageCeiling: number;
  /**
   * §4.5: `effectiveMessageCeiling − E2EE_ENVELOPE_OVERHEAD_BYTES`. The ceiling
   * on every inner-record body, RPC and control alike, enforced BEFORE
   * encryption (§4.2 step 2). Exactly the deliberate, documented reduction of
   * the maximum plaintext message size relative to a legacy channel.
   *
   * It may be zero or negative, which is what `establishable` reports.
   */
  readonly plaintextCeiling: number;
  /**
   * §4.5: false when `plaintextCeiling` is not positive, in which case the
   * channel MUST fail during establishment — before it is released to the
   * application — rather than shrinking anything silently (§11.2 P14). It is a
   * field rather than a separate function so no caller can read a ceiling
   * without the verdict that says whether the channel may exist at all.
   */
  readonly establishable: boolean;
}

/**
 * The §4.5 size budget of one channel, from that channel's own `ready` limits.
 *
 * The relay's own caps still apply to the encrypted byte count at both ends;
 * this is the additional budget each endpoint computes for itself, and it is
 * the only place either ceiling is derived.
 */
export function e2eeChannelSizeBudget(limits: E2eeReadyLimits): E2eeChannelSizeBudget {
  const effectiveMessageCeiling = Math.min(
    RELAY_MAX_RPC_MESSAGE_BYTES,
    limits.maxQueuedBytes - limits.maxControlFrameBytes,
  );
  const plaintextCeiling = effectiveMessageCeiling - E2EE_ENVELOPE_OVERHEAD_BYTES;
  return { effectiveMessageCeiling, plaintextCeiling, establishable: plaintextCeiling > 0 };
}

// ─── Timers (§3.2 area: Timers; invariants L1–L5 in §3.2.2) ──────────────────

/**
 * 1,500 ms. Client advertisement wait, from receipt of `channel.accept`. Fixed
 * by the §3.2.2 L1 keepalive budget together with `T_TRUST_COMMIT` and
 * `T_HANDSHAKE`.
 */
export const T_ADV = 1_500;
/**
 * 3,000 ms. Local pre-key deadline for committing an authenticated statement
 * before the client may emit `E2EEClientHello`.
 */
export const T_TRUST_COMMIT = 3_000;
/** 3,000 ms. Client handshake deadline, from `E2EEClientHello` emit (§4.4 K15). */
export const T_HANDSHAKE = 3_000;
/**
 * 10,000 ms. Node handshake deadline, from advertisement emit, extending
 * through the authenticated implicit client finish (§8.9). Bounded below by
 * §3.2.2 L2.
 */
export const T_HANDSHAKE_NODE = 10_000;
/**
 * 500 ms reserved inside `RPC_KEEPALIVE_INTERVAL` for the tail of a window in
 * which an E2EE-capable client cannot write the keepalive `Ping` (§3.2.2 L1, L5).
 */
export const T_KEEPALIVE_FLUSH_MARGIN = 500;
/**
 * 1,500 ms. Close-exchange deadline at every step of the close exchange, before
 * the close is reported unclean (§10). Fixed by §3.2.2 L5, which charges it
 * twice for the simultaneous path.
 */
export const T_CLOSE = 1_500;
/** 1,000 ms. Maximum last-record linger before the outer `channel.close` (§10.3). */
export const T_CLOSE_LINGER_MAX = 1_000;
/** §3.2: 600 s. Maximum capability-statement validity (`expiresAt − issuedAt`). */
export const E2EE_CAPABILITY_STATEMENT_VALIDITY = 600 * 1_000;
/** §3.2: 300 s. Maximum verifier clock skew for statement and prekey validity checks. */
export const E2EE_MAX_CLOCK_SKEW = 300 * 1_000;
/** §3.2: 30 days. Agreement-prekey certificate lifetime (§6). */
export const E2EE_PREKEY_LIFETIME = 30 * 24 * 60 * 60 * 1_000;
/** §3.2: 48 hours. Staged-rotation window where outgoing and incoming prekeys both verify (§6). */
export const E2EE_PREKEY_ROTATION_OVERLAP = 48 * 60 * 60 * 1_000;
/**
 * §3.2: 14 days. Fallback-observation window of representative use that MUST
 * precede the `requireE2EE` default flip (§12.3, §12.5).
 */
export const E2EE_FALLBACK_OBSERVATION_WINDOW = 14 * 24 * 60 * 60 * 1_000;

// ─── Rekey (§3.2 area: Rekey; schedule in §9.4, exhaustion in §9.6) ──────────

/** Per-direction protected-record count threshold *N* (§9). */
export const E2EE_REKEY_MAX_RECORDS = 65_536;
/** Per-direction authenticated inner-plaintext byte threshold *B* (§9). */
export const E2EE_REKEY_MAX_BYTES = 268_435_456;
/**
 * 2^32 − 1. Epoch exhaustion bound; reaching it terminates the channel before
 * wrap (§9). A bigint because §3.1 forbids the IEEE-754 `number` type for epoch
 * and counter values, and §9.3 requires exact arithmetic over the field range.
 */
export const E2EE_EPOCH_MAX = 0xffff_ffffn;
/** 2^64 − 1. Counter exhaustion bound; bigint for the reason above (§3.1, §9). */
export const E2EE_COUNTER_MAX = 0xffff_ffff_ffff_ffffn;
/**
 * Per-direction record capacity, under both §9.4 thresholds, an endpoint MUST
 * hold in reserve for the authenticated close (§9.6, §10.2). Not the whole §9.6
 * reserve, which is this plus `E2EE_ERROR_RECORDS_RESERVED`.
 */
export const E2EE_CLOSE_RECORDS_RESERVED = 2;
/**
 * Per-direction record capacity reserved, in addition to
 * `E2EE_CLOSE_RECORDS_RESERVED`, for the single terminal `E2EEError` (§9.6,
 * §10.2, §11.3).
 */
export const E2EE_ERROR_RECORDS_RESERVED = 1;

// ─── Keys (§3.2 area: Keys) ──────────────────────────────────────────────────

/** X25519 agreement public-key length (§6, §7). */
export const E2EE_AGREEMENT_PUBLIC_KEY_BYTES = 32;
/** Key-fingerprint digest length (SHA-256 output, §7). */
export const E2EE_KEY_FINGERPRINT_BYTES = 32;
/**
 * Length of every handshake-derived secret and per-epoch AEAD key (HKDF-Expand
 * output length; equals the ChaCha20-Poly1305 key length) (§6, §8, §9).
 */
export const E2EE_SECRET_BYTES = 32;
/**
 * Ed25519 public-key length. Defined by the node identity primitives
 * (`nodeIdentity.ts`), restated here rather than re-exported so this module
 * stays free of `node:crypto`; the cross-check is a test.
 */
export const ED25519_PUBLIC_KEY_BYTES = 32;
/** Ed25519 signature length; defined by the node identity primitives (see above). */
export const ED25519_SIGNATURE_BYTES = 64;
/** P-256 public-key length: X9.63 uncompressed point `0x04 ‖ X ‖ Y` (§7). */
export const P256_PUBLIC_KEY_BYTES = 65;
/** P-256 ECDSA signature length: fixed-width raw `r ‖ s` (§7). */
export const P256_SIGNATURE_BYTES = 64;

// ─── Signing (§3.2 area: Signing; §7.2) ──────────────────────────────────────

/**
 * Hard input bound of the node identity signing interface: it rejects any input
 * outside 1..this many bytes, so no signed structure may exceed it (§7.2).
 */
export const E2EE_SIGNING_INPUT_MAX_BYTES = 4_096;
/**
 * Maximum length of an E2EE transcript signed directly, without the §7.2.1
 * envelope (§7.3, §7.4, §7.5).
 */
export const E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES = 1_024;
/** Transcript-digest length inside the §7.2.1 signing envelope (SHA-256 output). */
export const E2EE_TRANSCRIPT_DIGEST_BYTES = 32;
/** Exact encoded length of the §7.2.1 capability signing envelope, for every input. */
export const E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES = 72;

// ─── Chains (§3.2 area: Chains) ──────────────────────────────────────────────

/** Maximum identity-continuity certificate chain length (§13). */
export const E2EE_CONTINUITY_CHAIN_MAX_LENGTH = 8;

// ─── Client records (§3.2 area: Client records; §13.6) ───────────────────────

/** Global cap on pending client-key records (§13). */
export const E2EE_PENDING_CLIENTS_MAX_GLOBAL = 64;
/** Pending client-key records per (Hub origin, account id) (§13). */
export const E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT = 8;
/** §3.2: 7 days. Pending client-key record retention (§13). */
export const E2EE_PENDING_CLIENT_RETENTION = 7 * 24 * 60 * 60 * 1_000;
/** Maximum approved client-key records (§13). */
export const E2EE_APPROVED_CLIENTS_MAX = 256;
/**
 * Maximum retained revoked client-key records; only the oldest revoked records
 * past this cap are evicted (§13).
 */
export const E2EE_REVOKED_CLIENTS_RETAINED_MAX = 1_024;
/** §3.2: 3,600 s. Last-seen writes per record are coalesced to one per interval (§13). */
export const E2EE_LAST_SEEN_WRITE_INTERVAL = 3_600 * 1_000;
/** Maximum owner-assigned display-label length in a client authorization record (§13). */
export const E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS = 100;
/** §3.2: 300 s. Maximum duration of an owner-opened pairing window on the node (§13.6). */
export const E2EE_PAIRING_WINDOW = 300 * 1_000;
/**
 * §3.2: 3,600 s. Maximum age, from record creation, for which a pending record
 * created under an owner-opened pairing window keeps its reservation against a
 * later pairing-window eviction (§13.6). Its equality with
 * `E2EE_LAST_SEEN_WRITE_INTERVAL` is coincidental; §3.2.2 L4 is what binds it.
 */
export const E2EE_PAIRING_RESERVATION_LIFETIME = 3_600 * 1_000;

// ─── Client trust state (§3.2 area: Client trust state; §13.1) ───────────────

/**
 * Maximum Hub-minted node ids retained per client-side pin record as untrusted
 * selection-resolution hints; oldest-first eviction (§13.1).
 */
export const E2EE_PIN_NODE_ID_HINTS_MAX = 8;

// ─── Instrumentation (§3.2 area: Instrumentation; §12.5) ─────────────────────

/**
 * Bounded ring of most recent fallback occurrences retained by the node;
 * occurrences evicted past it are counted by the per-class ring-overflow
 * counter (§12.3, §12.5).
 */
export const E2EE_FALLBACK_RING_SIZE = 32;
/**
 * §3.2: 3,600 s. Fallback-counter durable writes are coalesced to one per
 * interval per class, after a leading-edge durable write (§12.5). Deliberately
 * equal to `E2EE_LAST_SEEN_WRITE_INTERVAL`, which it mirrors.
 */
export const E2EE_FALLBACK_WRITE_INTERVAL = 3_600 * 1_000;

// ─── Pre-auth bounds (§3.2 area: Pre-auth bounds; §15) ───────────────────────

/**
 * Token-bucket capacity of the node's per-Hub-origin handshake-attempt budget;
 * satisfies §3.2.2 L3 (§15).
 */
export const E2EE_HANDSHAKE_RATE_BURST = 8;
/**
 * Refill rate of that bucket, in tokens **per second**, per Hub origin. Sized
 * at or above the per-node ticket-issuance rate the Hub deployment authorizes;
 * a deployment MUST re-check this against its Hub's ticket rate limits (§15).
 */
export const E2EE_HANDSHAKE_RATE_REFILL = 2;

// ─── Display (§3.2 area: Display; §13.4, §13.5) ──────────────────────────────

/**
 * §3.2: "60 decimal digits, rendered as 12 groups of 5, separated by single
 * spaces". The one §3.2 row that is a format rather than a scalar, carried
 * structured so §13.4 rendering reads every part of it from this module. The
 * fixed length is the checksum.
 */
export const E2EE_SAFETY_NUMBER_DIGITS = {
  digits: 60,
  groups: 12,
  digitsPerGroup: 5,
  separator: " ",
} as const;
/**
 * Required minimum anti-grinding entropy of the rendered native safety number.
 * The adversary model is offline: the value is long-term (§13.4, §3.2.1 S10).
 */
export const E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS = 60;
/**
 * §3.2: "8 Crockford base32 characters, rendered 4-4, separated by a single
 * hyphen" — the `WebSAS` output format, structured as above (§13.5).
 */
export const E2EE_WEB_SAS_CHARS = {
  chars: 8,
  groups: 2,
  charsPerGroup: 4,
  separator: "-",
} as const;
/**
 * Required minimum displayed entropy of the rendered `WebSAS`. Unlike the
 * safety-number floor this is not an offline work factor: §13.5 derives it from
 * the grinding window an interposer actually has (§13.5, §17.5, §3.2.1 S11).
 */
export const E2EE_WEB_SAS_MIN_DISPLAYED_BITS = 30;
/** HKDF output bytes consumed per displayed safety-number group (§13). */
export const E2EE_SAFETY_NUMBER_GROUP_BYTES = 5;
/** Modulus reducing each safety-number group to its five-digit decimal form (§13). */
export const E2EE_SAFETY_NUMBER_GROUP_MODULUS = 100_000;
/** Total safety-number HKDF-Expand output length (§13). */
export const E2EE_SAFETY_NUMBER_HKDF_BYTES = 60;
/** `WebSAS` HKDF-Expand output length — exactly the displayed bits (§13). */
export const E2EE_WEB_SAS_HKDF_BYTES = 5;
/** Crockford base32 alphabet used by `WebSAS` rendering (§13). */
export const E2EE_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ─── Encoding and dependencies (§3.2 areas: Encoding, Dependencies) ──────────

/**
 * Pinned canonical-CBOR codec and version (§3.6). Changing it is a
 * protocol-relevant change, because canonical bytes participate in signatures
 * and hashes.
 */
export const E2EE_CBOR_CODEC = "cborg@6.1.2";
/** Maintainer security-audit baseline for X25519/Ed25519/P-256 (April 2026; §14). */
export const E2EE_NOBLE_CURVES_AUDIT_BASELINE = "@noble/curves@2.2.0";
/** Maintainer security-audit baseline for ChaCha20-Poly1305 (April 2026; §14). */
export const E2EE_NOBLE_CIPHERS_AUDIT_BASELINE = "@noble/ciphers@2.2.0";
/** Maintainer security-audit baseline for SHA-256/HMAC/HKDF (April 2026; §14). */
export const E2EE_NOBLE_HASHES_AUDIT_BASELINE = "@noble/hashes@2.2.0";

// ─── Handshake (§3.2 area: Handshake) ────────────────────────────────────────

/** Noise Protocol Framework specification revision the suite registry is defined against. */
export const NOISE_SPEC_REVISION = 34;

// ─── Relay chunking and connection (§3.2 areas: Relay chunking, Relay
//     connection, RPC keepalive) ───────────────────────────────────────────────
//
// These rows are defined by the relay protocol, its message-chunking layer, and
// the pinned RPC client. §3.2 restates them for cross-checking and leaves their
// defining modules authoritative, so they are re-exported here rather than
// re-declared: one definition site, one import site for later slices.
//
// `RELAY_CAPABILITY_LITERALS` is deliberately absent. §3.2 names that set
// without restating its members and §1.1 forbids forking a relay-owned
// registry; the relay contract's `RelayCapability` schema in
// `@ryco/contracts/relay` remains the only place to validate a capability
// literal against.

export {
  RELAY_CHUNK_CAPABILITY_PRELUDE,
  RELAY_CHUNK_HEADER_BYTES,
  RELAY_CHUNK_MAGIC,
  RELAY_CLOSE_REASONS,
  RELAY_MAX_CHANNELS,
  RELAY_MAX_DATA_CHUNK_BYTES,
  RELAY_MAX_RPC_MESSAGE_BYTES,
  RELAY_MIN_DATA_CHUNK_BYTES,
};

/**
 * Length of `RELAY_CHUNK_CAPABILITY_PRELUDE`, named by §3.2 so the §3.2.1
 * carrier invariants are expressible over constant names alone. Derived from
 * the prelude itself so the two can never disagree.
 */
export const RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES = RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength;

/**
 * 8,000 ms. Period of the pinned RPC client's keepalive fiber (§3.2.2 L1). The
 * pinned client hard-codes it (`Effect.delay("8 seconds")` in `makePinger`,
 * `patches/effect@4.0.0-beta.106.patch`) and exports no constant, so this is the
 * one restated row with no importable definition site.
 */
export const RPC_KEEPALIVE_INTERVAL = 8_000;
