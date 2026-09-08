import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELAY_CHUNK_HEADER_BYTES as CONTRACT_CHUNK_HEADER_BYTES,
  RELAY_CHUNK_MAGIC as CONTRACT_CHUNK_MAGIC,
  RELAY_MAX_CHANNELS as CONTRACT_MAX_CHANNELS,
  RELAY_MAX_DATA_CHUNK_BYTES as CONTRACT_MAX_DATA_CHUNK_BYTES,
  RELAY_MAX_RPC_MESSAGE_BYTES as CONTRACT_MAX_RPC_MESSAGE_BYTES,
  RELAY_MIN_DATA_CHUNK_BYTES as CONTRACT_MIN_DATA_CHUNK_BYTES,
} from "@ryco/contracts/relay";
import { encode, rfc8949EncodeOptions } from "cborg";
import { describe, expect, it } from "vite-plus/test";

import {
  ED25519_PUBLIC_KEY_BYTES as IDENTITY_ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES as IDENTITY_ED25519_SIGNATURE_BYTES,
} from "./nodeIdentity.ts";
import {
  E2EE_AAD_BYTES,
  E2EE_ACCOUNT_ID_MAX_BYTES,
  E2EE_ACCOUNT_GRANT_CAPABILITIES_MAX,
  E2EE_ACCOUNT_GRANT_SUITE,
  E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES,
  E2EE_AEAD_NONCE_BYTES,
  E2EE_AEAD_TAG_BYTES,
  E2EE_AGREEMENT_PUBLIC_KEY_BYTES,
  E2EE_APPROVED_CLIENTS_MAX,
  E2EE_CAPABILITY_CARRIER_FIXED_BYTES,
  E2EE_CAPABILITY_CARRIER_MAX_BYTES,
  E2EE_CAPABILITY_CARRIER_TAG,
  E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES,
  E2EE_CAPABILITY_STATEMENT_MAX_BYTES,
  E2EE_CAPABILITY_STATEMENT_VALIDITY,
  E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES,
  E2EE_CBOR_CODEC,
  E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS,
  E2EE_CLIENT_HELLO_MAX_BYTES,
  E2EE_CLOSE_COMMITMENT_BYTES,
  E2EE_CLOSE_RECORDS_RESERVED,
  E2EE_CONFIRMATION_BYTES,
  E2EE_CONTEXT_COMMITMENT_BYTES,
  E2EE_CONTINUITY_CHAIN_MAX_LENGTH,
  E2EE_COUNTER_FIELD_BYTES,
  E2EE_COUNTER_MAX,
  E2EE_CROCKFORD_ALPHABET,
  E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES,
  E2EE_DIRECTION_LABEL_BYTES,
  E2EE_ENVELOPE_DISCRIMINATOR,
  E2EE_ENVELOPE_HEADER_BYTES,
  E2EE_ENVELOPE_OVERHEAD_BYTES,
  E2EE_EPOCH_FIELD_BYTES,
  E2EE_EPOCH_MAX,
  E2EE_ERROR_BODY_MAX_BYTES,
  E2EE_ERROR_RECORDS_RESERVED,
  E2EE_FALLBACK_OBSERVATION_WINDOW,
  E2EE_FALLBACK_RING_SIZE,
  E2EE_FALLBACK_WRITE_INTERVAL,
  E2EE_HANDSHAKE_NONCE_BYTES,
  E2EE_HANDSHAKE_RATE_BURST,
  E2EE_HANDSHAKE_RATE_REFILL,
  E2EE_HANDSHAKE_REJECT_BYTES,
  E2EE_HANDSHAKE_REJECT_PAD_BYTES,
  E2EE_HUB_ORIGIN_MAX_BYTES,
  E2EE_HUB_DEVICE_GRANT_B64URL_MAX_CHARS,
  E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW,
  E2EE_HUB_DEVICE_GRANT_ID_MAX_BYTES,
  E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS,
  E2EE_HUB_DEVICE_GRANT_MAX_BYTES,
  E2EE_HUB_DEVICE_GRANT_MAX_VALIDITY,
  E2EE_HUB_DEVICE_GRANT_NONCE_BYTES,
  E2EE_HUB_GRANT_KEY_ID_MAX_BYTES,
  E2EE_INNER_TYPE_BYTES,
  E2EE_KEY_FINGERPRINT_BYTES,
  E2EE_LAST_SEEN_WRITE_INTERVAL,
  E2EE_MAX_CLOCK_SKEW,
  E2EE_NEGOTIATION_DISCRIMINATOR,
  E2EE_NATIVE_ENROLLMENT_ID_MAX_BYTES,
  E2EE_NOBLE_CIPHERS_AUDIT_BASELINE,
  E2EE_NOBLE_CURVES_AUDIT_BASELINE,
  E2EE_NOBLE_HASHES_AUDIT_BASELINE,
  E2EE_PAIRING_RESERVATION_LIFETIME,
  E2EE_PAIRING_WINDOW,
  E2EE_PENDING_CLIENT_RETENTION,
  E2EE_PENDING_CLIENTS_MAX_GLOBAL,
  E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
  E2EE_PIN_NODE_ID_HINTS_MAX,
  E2EE_PREKEY_LIFETIME,
  E2EE_PREKEY_ROTATION_OVERLAP,
  E2EE_PROTOCOL_VERSION,
  E2EE_REKEY_MAX_BYTES,
  E2EE_REKEY_MAX_RECORDS,
  E2EE_RELAY_TICKET_ID_MAX_BYTES,
  E2EE_REVOKED_CLIENTS_RETAINED_MAX,
  E2EE_SAFETY_NUMBER_DIGITS,
  E2EE_SAFETY_NUMBER_GROUP_BYTES,
  E2EE_SAFETY_NUMBER_GROUP_MODULUS,
  E2EE_SAFETY_NUMBER_HKDF_BYTES,
  E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS,
  E2EE_SECRET_BYTES,
  E2EE_SERVER_ACCEPT_MAX_BYTES,
  E2EE_SESSION_BINDING_HASH_BYTES,
  E2EE_SIGNING_INPUT_MAX_BYTES,
  E2EE_STATEMENT_WRAPPER_MAX_BYTES,
  E2EE_SUITE_REGISTRY_MAX_ENTRIES,
  E2EE_TRANSCRIPT_DIGEST_BYTES,
  E2EE_WEB_SAS_CHARS,
  E2EE_WEB_SAS_HKDF_BYTES,
  E2EE_WEB_SAS_MIN_DISPLAYED_BITS,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  NOISE_SPEC_REVISION,
  P256_PUBLIC_KEY_BYTES,
  P256_SIGNATURE_BYTES,
  RELAY_CHUNK_CAPABILITY_PRELUDE,
  RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES,
  RELAY_CHUNK_HEADER_BYTES,
  RELAY_CHUNK_MAGIC,
  RELAY_MAX_CHANNELS,
  RELAY_MAX_DATA_CHUNK_BYTES,
  RELAY_MAX_RPC_MESSAGE_BYTES,
  RELAY_MIN_DATA_CHUNK_BYTES,
  RPC_KEEPALIVE_INTERVAL,
  T_ADV,
  T_CLOSE,
  T_CLOSE_LINGER_MAX,
  T_HANDSHAKE,
  T_HANDSHAKE_NODE,
  T_KEEPALIVE_FLUSH_MARGIN,
  T_TRUST_COMMIT,
  e2eeChannelSizeBudget,
  e2eeNegotiationBufferMaxBytes,
} from "./relayE2eeConstants.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ─────────────────────────────────────────────────────────────────────────────
// The §3.2 table, row for row, in the order §3.2 states it.
//
// Every expected value below is the LITERAL the specification prints, never a
// reference to the constant under test and never a relationship between two of
// them. That is deliberate and it is the point of this file: an assertion
// written over the constant it is checking cannot fail when the constant
// changes, and these are exactly the values on which interoperability with an
// independent implementation rests. A reviewer is meant to diff this table
// against §3.2 by eye, so it carries the area and the name §3.2 uses.
//
// Rows §3.2 states in seconds, hours, or days show the conversion, because this
// module carries every duration in milliseconds. Rows defined by another module
// (relay chunking, relay connection, RPC keepalive, `ED25519_*`) are restated
// here for the same cross-checking reason §3.2 restates them; the agreement
// tests further down are what keep them in step with their defining module.
//
// Three §3.2 rows are deliberately absent, each for a reason §3.2 states:
// `E2EE_NEGOTIATION_BUFFER_MAX_BYTES` is a formula over the Hub-asserted limits
// and is tested as one; `RELAY_CLOSE_REASONS` and `RELAY_CAPABILITY_LITERALS`
// are relay-owned sets §3.2 names without restating, and §1.1 forbids forking
// them.
// ─────────────────────────────────────────────────────────────────────────────

type SpecConstantRow = readonly [area: string, name: string, actual: unknown, specValue: unknown];

const SPEC_CONSTANTS: ReadonlyArray<SpecConstantRow> = [
  ["Wire", "E2EE_ENVELOPE_DISCRIMINATOR", E2EE_ENVELOPE_DISCRIMINATOR, 0x01],
  ["Wire", "E2EE_NEGOTIATION_DISCRIMINATOR", E2EE_NEGOTIATION_DISCRIMINATOR, 0x02],
  ["Wire", "E2EE_PROTOCOL_VERSION", E2EE_PROTOCOL_VERSION, 0x01],
  ["Wire", "E2EE_ENVELOPE_HEADER_BYTES", E2EE_ENVELOPE_HEADER_BYTES, 15],
  ["Wire", "E2EE_EPOCH_FIELD_BYTES", E2EE_EPOCH_FIELD_BYTES, 4],
  ["Wire", "E2EE_COUNTER_FIELD_BYTES", E2EE_COUNTER_FIELD_BYTES, 8],
  ["Wire", "E2EE_AEAD_TAG_BYTES", E2EE_AEAD_TAG_BYTES, 16],
  ["Wire", "E2EE_INNER_TYPE_BYTES", E2EE_INNER_TYPE_BYTES, 1],
  ["Wire", "E2EE_ENVELOPE_OVERHEAD_BYTES", E2EE_ENVELOPE_OVERHEAD_BYTES, 32],
  ["Wire", "E2EE_AEAD_NONCE_BYTES", E2EE_AEAD_NONCE_BYTES, 12],
  ["Wire", "E2EE_SESSION_BINDING_HASH_BYTES", E2EE_SESSION_BINDING_HASH_BYTES, 32],
  ["Wire", "E2EE_DIRECTION_LABEL_BYTES", E2EE_DIRECTION_LABEL_BYTES, 3],
  ["Wire", "E2EE_AAD_BYTES", E2EE_AAD_BYTES, 50],
  ["Wire", "E2EE_CONTEXT_COMMITMENT_BYTES", E2EE_CONTEXT_COMMITMENT_BYTES, 32],
  ["Wire", "E2EE_HANDSHAKE_NONCE_BYTES", E2EE_HANDSHAKE_NONCE_BYTES, 32],
  ["Wire", "E2EE_CONFIRMATION_BYTES", E2EE_CONFIRMATION_BYTES, 32],
  ["Wire", "E2EE_CLOSE_COMMITMENT_BYTES", E2EE_CLOSE_COMMITMENT_BYTES, 32],
  ["Wire", "E2EE_ERROR_BODY_MAX_BYTES", E2EE_ERROR_BODY_MAX_BYTES, 16],
  ["Negotiation", "E2EE_CLIENT_HELLO_MAX_BYTES", E2EE_CLIENT_HELLO_MAX_BYTES, 4_096],
  ["Negotiation", "E2EE_SERVER_ACCEPT_MAX_BYTES", E2EE_SERVER_ACCEPT_MAX_BYTES, 8_192],
  ["Negotiation", "E2EE_HANDSHAKE_REJECT_BYTES", E2EE_HANDSHAKE_REJECT_BYTES, 64],
  ["Negotiation", "E2EE_HANDSHAKE_REJECT_PAD_BYTES", E2EE_HANDSHAKE_REJECT_PAD_BYTES, 60],
  ["Negotiation", "E2EE_HUB_ORIGIN_MAX_BYTES", E2EE_HUB_ORIGIN_MAX_BYTES, 128],
  ["Negotiation", "E2EE_SUITE_REGISTRY_MAX_ENTRIES", E2EE_SUITE_REGISTRY_MAX_ENTRIES, 8],
  [
    "Negotiation",
    "E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES",
    E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES,
    5_120,
  ],
  ["Negotiation", "E2EE_STATEMENT_WRAPPER_MAX_BYTES", E2EE_STATEMENT_WRAPPER_MAX_BYTES, 70],
  [
    "Negotiation",
    "E2EE_CAPABILITY_STATEMENT_MAX_BYTES",
    E2EE_CAPABILITY_STATEMENT_MAX_BYTES,
    5_190,
  ],
  [
    "Negotiation",
    "E2EE_CAPABILITY_CARRIER_TAG",
    E2EE_CAPABILITY_CARRIER_TAG,
    "ryco.e2ee.capability.v1",
  ],
  ["Negotiation", "E2EE_CAPABILITY_CARRIER_FIXED_BYTES", E2EE_CAPABILITY_CARRIER_FIXED_BYTES, 49],
  ["Negotiation", "E2EE_CAPABILITY_CARRIER_MAX_BYTES", E2EE_CAPABILITY_CARRIER_MAX_BYTES, 6_969],
  ["Negotiation", "E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES", E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES, 8_192],
  ["Negotiation", "E2EE_ACCOUNT_ID_MAX_BYTES", E2EE_ACCOUNT_ID_MAX_BYTES, 256],
  ["Account grant", "E2EE_HUB_DEVICE_GRANT_MAX_BYTES", E2EE_HUB_DEVICE_GRANT_MAX_BYTES, 2_048],
  [
    "Account grant",
    "E2EE_HUB_DEVICE_GRANT_B64URL_MAX_CHARS",
    E2EE_HUB_DEVICE_GRANT_B64URL_MAX_CHARS,
    2_731,
  ],
  ["Account grant", "E2EE_HUB_DEVICE_GRANT_NONCE_BYTES", E2EE_HUB_DEVICE_GRANT_NONCE_BYTES, 32],
  [
    "Account grant",
    "E2EE_HUB_DEVICE_GRANT_MAX_VALIDITY",
    E2EE_HUB_DEVICE_GRANT_MAX_VALIDITY,
    120_000,
  ],
  ["Account grant", "E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW", E2EE_HUB_DEVICE_GRANT_CLOCK_SKEW, 30_000],
  [
    "Account grant",
    "E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS",
    E2EE_HUB_DEVICE_GRANT_KEYSET_MAX_KEYS,
    4,
  ],
  ["Account grant", "E2EE_HUB_DEVICE_GRANT_ID_MAX_BYTES", E2EE_HUB_DEVICE_GRANT_ID_MAX_BYTES, 47],
  ["Account grant", "E2EE_HUB_GRANT_KEY_ID_MAX_BYTES", E2EE_HUB_GRANT_KEY_ID_MAX_BYTES, 47],
  ["Account grant", "E2EE_NATIVE_ENROLLMENT_ID_MAX_BYTES", E2EE_NATIVE_ENROLLMENT_ID_MAX_BYTES, 47],
  ["Account grant", "E2EE_RELAY_TICKET_ID_MAX_BYTES", E2EE_RELAY_TICKET_ID_MAX_BYTES, 47],
  ["Account grant", "E2EE_ACCOUNT_GRANT_CAPABILITIES_MAX", E2EE_ACCOUNT_GRANT_CAPABILITIES_MAX, 32],
  ["Account grant", "E2EE_ACCOUNT_GRANT_SUITE", E2EE_ACCOUNT_GRANT_SUITE, 0x02],
  ["Timers", "T_ADV", T_ADV, 1_500],
  ["Timers", "T_TRUST_COMMIT", T_TRUST_COMMIT, 3_000],
  ["Timers", "T_HANDSHAKE", T_HANDSHAKE, 3_000],
  ["Timers", "T_HANDSHAKE_NODE", T_HANDSHAKE_NODE, 10_000],
  ["Timers", "T_KEEPALIVE_FLUSH_MARGIN", T_KEEPALIVE_FLUSH_MARGIN, 500],
  ["Timers", "T_CLOSE", T_CLOSE, 1_500],
  ["Timers", "T_CLOSE_LINGER_MAX", T_CLOSE_LINGER_MAX, 1_000],
  [
    "Timers",
    "E2EE_CAPABILITY_STATEMENT_VALIDITY (600 s)",
    E2EE_CAPABILITY_STATEMENT_VALIDITY,
    600 * SECOND,
  ],
  ["Timers", "E2EE_MAX_CLOCK_SKEW (300 s)", E2EE_MAX_CLOCK_SKEW, 300 * SECOND],
  ["Timers", "E2EE_PREKEY_LIFETIME (30 days)", E2EE_PREKEY_LIFETIME, 30 * DAY],
  ["Timers", "E2EE_PREKEY_ROTATION_OVERLAP (48 hours)", E2EE_PREKEY_ROTATION_OVERLAP, 48 * HOUR],
  [
    "Timers",
    "E2EE_FALLBACK_OBSERVATION_WINDOW (14 days)",
    E2EE_FALLBACK_OBSERVATION_WINDOW,
    14 * DAY,
  ],
  ["Rekey", "E2EE_REKEY_MAX_RECORDS", E2EE_REKEY_MAX_RECORDS, 65_536],
  ["Rekey", "E2EE_REKEY_MAX_BYTES", E2EE_REKEY_MAX_BYTES, 268_435_456],
  ["Rekey", "E2EE_EPOCH_MAX (2^32 − 1)", E2EE_EPOCH_MAX, 4_294_967_295n],
  ["Rekey", "E2EE_COUNTER_MAX (2^64 − 1)", E2EE_COUNTER_MAX, 18_446_744_073_709_551_615n],
  ["Rekey", "E2EE_CLOSE_RECORDS_RESERVED", E2EE_CLOSE_RECORDS_RESERVED, 2],
  ["Rekey", "E2EE_ERROR_RECORDS_RESERVED", E2EE_ERROR_RECORDS_RESERVED, 1],
  ["Keys", "E2EE_AGREEMENT_PUBLIC_KEY_BYTES", E2EE_AGREEMENT_PUBLIC_KEY_BYTES, 32],
  ["Keys", "E2EE_KEY_FINGERPRINT_BYTES", E2EE_KEY_FINGERPRINT_BYTES, 32],
  ["Keys", "E2EE_SECRET_BYTES", E2EE_SECRET_BYTES, 32],
  ["Keys", "ED25519_PUBLIC_KEY_BYTES", ED25519_PUBLIC_KEY_BYTES, 32],
  ["Keys", "ED25519_SIGNATURE_BYTES", ED25519_SIGNATURE_BYTES, 64],
  ["Keys", "P256_PUBLIC_KEY_BYTES", P256_PUBLIC_KEY_BYTES, 65],
  ["Keys", "P256_SIGNATURE_BYTES", P256_SIGNATURE_BYTES, 64],
  ["Signing", "E2EE_SIGNING_INPUT_MAX_BYTES", E2EE_SIGNING_INPUT_MAX_BYTES, 4_096],
  [
    "Signing",
    "E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES",
    E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES,
    1_024,
  ],
  ["Signing", "E2EE_TRANSCRIPT_DIGEST_BYTES", E2EE_TRANSCRIPT_DIGEST_BYTES, 32],
  ["Signing", "E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES", E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES, 72],
  ["Chains", "E2EE_CONTINUITY_CHAIN_MAX_LENGTH", E2EE_CONTINUITY_CHAIN_MAX_LENGTH, 8],
  ["Client records", "E2EE_PENDING_CLIENTS_MAX_GLOBAL", E2EE_PENDING_CLIENTS_MAX_GLOBAL, 64],
  [
    "Client records",
    "E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT",
    E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
    8,
  ],
  [
    "Client records",
    "E2EE_PENDING_CLIENT_RETENTION (7 days)",
    E2EE_PENDING_CLIENT_RETENTION,
    7 * DAY,
  ],
  ["Client records", "E2EE_APPROVED_CLIENTS_MAX", E2EE_APPROVED_CLIENTS_MAX, 256],
  ["Client records", "E2EE_REVOKED_CLIENTS_RETAINED_MAX", E2EE_REVOKED_CLIENTS_RETAINED_MAX, 1_024],
  [
    "Client records",
    "E2EE_LAST_SEEN_WRITE_INTERVAL (3,600 s)",
    E2EE_LAST_SEEN_WRITE_INTERVAL,
    3_600 * SECOND,
  ],
  [
    "Client records",
    "E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS",
    E2EE_CLIENT_DISPLAY_LABEL_MAX_CHARS,
    100,
  ],
  ["Client records", "E2EE_PAIRING_WINDOW (300 s)", E2EE_PAIRING_WINDOW, 300 * SECOND],
  [
    "Client records",
    "E2EE_PAIRING_RESERVATION_LIFETIME (3,600 s)",
    E2EE_PAIRING_RESERVATION_LIFETIME,
    3_600 * SECOND,
  ],
  ["Client trust state", "E2EE_PIN_NODE_ID_HINTS_MAX", E2EE_PIN_NODE_ID_HINTS_MAX, 8],
  ["Instrumentation", "E2EE_FALLBACK_RING_SIZE", E2EE_FALLBACK_RING_SIZE, 32],
  [
    "Instrumentation",
    "E2EE_FALLBACK_WRITE_INTERVAL (3,600 s)",
    E2EE_FALLBACK_WRITE_INTERVAL,
    3_600 * SECOND,
  ],
  ["Pre-auth bounds", "E2EE_HANDSHAKE_RATE_BURST", E2EE_HANDSHAKE_RATE_BURST, 8],
  ["Pre-auth bounds", "E2EE_HANDSHAKE_RATE_REFILL (per second)", E2EE_HANDSHAKE_RATE_REFILL, 2],
  [
    "Display",
    "E2EE_SAFETY_NUMBER_DIGITS (60 digits, 12 groups of 5, single spaces)",
    E2EE_SAFETY_NUMBER_DIGITS,
    { digits: 60, groups: 12, digitsPerGroup: 5, separator: " " },
  ],
  ["Display", "E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS", E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS, 60],
  [
    "Display",
    "E2EE_WEB_SAS_CHARS (8 Crockford base32 chars, 4-4, single hyphen)",
    E2EE_WEB_SAS_CHARS,
    { chars: 8, groups: 2, charsPerGroup: 4, separator: "-" },
  ],
  ["Display", "E2EE_WEB_SAS_MIN_DISPLAYED_BITS", E2EE_WEB_SAS_MIN_DISPLAYED_BITS, 30],
  ["Display", "E2EE_SAFETY_NUMBER_GROUP_BYTES", E2EE_SAFETY_NUMBER_GROUP_BYTES, 5],
  ["Display", "E2EE_SAFETY_NUMBER_GROUP_MODULUS", E2EE_SAFETY_NUMBER_GROUP_MODULUS, 100_000],
  ["Display", "E2EE_SAFETY_NUMBER_HKDF_BYTES", E2EE_SAFETY_NUMBER_HKDF_BYTES, 60],
  ["Display", "E2EE_WEB_SAS_HKDF_BYTES", E2EE_WEB_SAS_HKDF_BYTES, 5],
  [
    "Display",
    "E2EE_CROCKFORD_ALPHABET",
    E2EE_CROCKFORD_ALPHABET,
    "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
  ],
  ["Encoding", "E2EE_CBOR_CODEC", E2EE_CBOR_CODEC, "cborg@6.1.2"],
  [
    "Dependencies",
    "E2EE_NOBLE_CURVES_AUDIT_BASELINE",
    E2EE_NOBLE_CURVES_AUDIT_BASELINE,
    "@noble/curves@2.2.0",
  ],
  [
    "Dependencies",
    "E2EE_NOBLE_CIPHERS_AUDIT_BASELINE",
    E2EE_NOBLE_CIPHERS_AUDIT_BASELINE,
    "@noble/ciphers@2.2.0",
  ],
  [
    "Dependencies",
    "E2EE_NOBLE_HASHES_AUDIT_BASELINE",
    E2EE_NOBLE_HASHES_AUDIT_BASELINE,
    "@noble/hashes@2.2.0",
  ],
  ["Handshake", "NOISE_SPEC_REVISION", NOISE_SPEC_REVISION, 34],
  [
    "Relay chunking",
    "RELAY_CHUNK_CAPABILITY_PRELUDE",
    [...RELAY_CHUNK_CAPABILITY_PRELUDE],
    [0x20, 0x09, 0x0d, 0x0a, 0x20, 0x09, 0x0d, 0x0a],
  ],
  [
    "Relay chunking",
    "RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES",
    RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES,
    8,
  ],
  ["Relay chunking", "RELAY_CHUNK_MAGIC", RELAY_CHUNK_MAGIC, 0x00],
  ["Relay chunking", "RELAY_CHUNK_HEADER_BYTES", RELAY_CHUNK_HEADER_BYTES, 8],
  ["Relay chunking", "RELAY_MAX_RPC_MESSAGE_BYTES", RELAY_MAX_RPC_MESSAGE_BYTES, 4_194_304],
  ["Relay chunking", "RELAY_MAX_DATA_CHUNK_BYTES", RELAY_MAX_DATA_CHUNK_BYTES, 262_144],
  ["Relay chunking", "RELAY_MIN_DATA_CHUNK_BYTES", RELAY_MIN_DATA_CHUNK_BYTES, 1_024],
  ["Relay connection", "RELAY_MAX_CHANNELS", RELAY_MAX_CHANNELS, 8],
  ["RPC keepalive", "RPC_KEEPALIVE_INTERVAL", RPC_KEEPALIVE_INTERVAL, 8_000],
];

describe("§3.2 constants, pinned to the literal values the table states", () => {
  for (const [area, name, actual, specValue] of SPEC_CONSTANTS) {
    it(`${area} | ${name}`, () => {
      expect(actual).toEqual(specValue);
    });
  }
});

describe("wire constant arithmetic (§3.2, §3.3)", () => {
  it("derives every envelope length from its fields", () => {
    // discriminator + version + suite + epoch + counter.
    expect(E2EE_ENVELOPE_HEADER_BYTES).toBe(
      1 + 1 + 1 + E2EE_EPOCH_FIELD_BYTES + E2EE_COUNTER_FIELD_BYTES,
    );
    expect(E2EE_ENVELOPE_OVERHEAD_BYTES).toBe(
      E2EE_ENVELOPE_HEADER_BYTES + E2EE_AEAD_TAG_BYTES + E2EE_INNER_TYPE_BYTES,
    );
    // nonce = epoch ‖ counter, exactly the ChaCha20-Poly1305 nonce.
    expect(E2EE_AEAD_NONCE_BYTES).toBe(E2EE_EPOCH_FIELD_BYTES + E2EE_COUNTER_FIELD_BYTES);
    // AAD = envelope header ‖ sessionBindingHash ‖ direction label.
    expect(E2EE_AAD_BYTES).toBe(
      E2EE_ENVELOPE_HEADER_BYTES + E2EE_SESSION_BINDING_HASH_BYTES + E2EE_DIRECTION_LABEL_BYTES,
    );
  });

  it("keeps the fixed-size reject record's padding consistent with its total", () => {
    // The body is the canonical-CBOR byte string holding
    // E2EE_HANDSHAKE_REJECT_PAD_BYTES zero bytes (§11.2), inside the two-byte
    // negotiation framing of §3.3.
    const body = encode(new Uint8Array(E2EE_HANDSHAKE_REJECT_PAD_BYTES), rfc8949EncodeOptions);
    expect(2 + body.byteLength).toBe(E2EE_HANDSHAKE_REJECT_BYTES);
  });

  it("holds epoch and counter bounds as exact bigints, never as doubles", () => {
    // §3.1 forbids the IEEE-754 number type for these values. The counter bound
    // is the reason: it is nearly 2^11 times MAX_SAFE_INTEGER.
    expect(E2EE_EPOCH_MAX).toBe(2n ** 32n - 1n);
    expect(E2EE_COUNTER_MAX).toBe(2n ** 64n - 1n);
    expect(E2EE_COUNTER_MAX).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(E2EE_EPOCH_MAX).toBe(2n ** BigInt(E2EE_EPOCH_FIELD_BYTES * 8) - 1n);
    expect(E2EE_COUNTER_MAX).toBe(2n ** BigInt(E2EE_COUNTER_FIELD_BYTES * 8) - 1n);
  });
});

describe("size-relationship invariants (§3.2.1 S1–S11)", () => {
  // S8 and S9 are deliberately absent: §3.2.1 discharges them with the
  // generated worst-case transcript fixtures of §16.3 F3 and F5, which need the
  // §7 transcript encoders. They belong to that slice, not to this one.

  it("S1 — the capability signing envelope fits the signing interface", () => {
    expect(E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES).toBeLessThanOrEqual(
      E2EE_SIGNING_INPUT_MAX_BYTES,
    );
  });

  it("S2 — every directly signed transcript fits the signing interface", () => {
    expect(E2EE_DIRECT_SIGNING_TRANSCRIPT_MAX_BYTES).toBeLessThanOrEqual(
      E2EE_SIGNING_INPUT_MAX_BYTES,
    );
  });

  it("S3 — the signing envelope is exactly the canonical CBOR it claims to be", () => {
    const envelope = encode(
      ["ryco.node-e2ee-capability-digest.v1", new Uint8Array(E2EE_TRANSCRIPT_DIGEST_BYTES)],
      rfc8949EncodeOptions,
    );
    expect(envelope.byteLength).toBe(E2EE_CAPABILITY_SIGNING_ENVELOPE_BYTES);
  });

  it("S4 — the statement bound is the transcript bound plus the wrapper", () => {
    expect(E2EE_CAPABILITY_STATEMENT_MAX_BYTES).toBe(
      E2EE_CAPABILITY_TRANSCRIPT_MAX_BYTES + E2EE_STATEMENT_WRAPPER_MAX_BYTES,
    );
  });

  it("S5 — the carrier bound is the wrapper plus the base64url statement", () => {
    expect(E2EE_CAPABILITY_CARRIER_MAX_BYTES).toBe(
      E2EE_CAPABILITY_CARRIER_FIXED_BYTES +
        Math.ceil((4 * E2EE_CAPABILITY_STATEMENT_MAX_BYTES) / 3),
    );
  });

  it("S6 — the largest carrier plus the prelude fits the advertisement floor", () => {
    expect(
      E2EE_CAPABILITY_CARRIER_MAX_BYTES + RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES,
    ).toBeLessThanOrEqual(E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES);
  });

  it("S7 — the advertisement floor is reachable on this relay protocol", () => {
    expect(E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES).toBeLessThanOrEqual(RELAY_MAX_DATA_CHUNK_BYTES);
    // Deliberately NOT guaranteed: the relay still admits connections below the
    // floor, which is the residual gap §5.5 handles and §17.13 records.
    expect(RELAY_MIN_DATA_CHUNK_BYTES).toBeLessThan(E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES);
  });

  it("S10 — the safety number clears its offline entropy floor", () => {
    const groups = E2EE_SAFETY_NUMBER_HKDF_BYTES / E2EE_SAFETY_NUMBER_GROUP_BYTES;
    expect(groups * Math.log2(E2EE_SAFETY_NUMBER_GROUP_MODULUS)).toBeGreaterThanOrEqual(
      E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS,
    );
    expect(groups).toBe(E2EE_SAFETY_NUMBER_DIGITS.groups);
    expect(E2EE_SAFETY_NUMBER_DIGITS.groups * E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup).toBe(
      E2EE_SAFETY_NUMBER_DIGITS.digits,
    );
  });

  it("S11 — the WebSAS clears its displayed entropy floor", () => {
    expect(E2EE_WEB_SAS_HKDF_BYTES * 8).toBeGreaterThanOrEqual(E2EE_WEB_SAS_MIN_DISPLAYED_BITS);
    expect(E2EE_WEB_SAS_CHARS.groups * E2EE_WEB_SAS_CHARS.charsPerGroup).toBe(
      E2EE_WEB_SAS_CHARS.chars,
    );
  });
});

describe("liveness and concurrency invariants (§3.2.2 L1–L5)", () => {
  it("L1 — the negotiating window fits inside one keepalive period", () => {
    expect(T_ADV + T_TRUST_COMMIT + T_HANDSHAKE + T_KEEPALIVE_FLUSH_MARGIN).toBeLessThanOrEqual(
      RPC_KEEPALIVE_INTERVAL,
    );
  });

  it("L2 — the node never times out a handshake the client still considers live", () => {
    expect(T_ADV + T_TRUST_COMMIT + T_HANDSHAKE).toBeLessThanOrEqual(T_HANDSHAKE_NODE);
  });

  it("L3 — the pre-authentication rate limit cannot bite before the structural bound", () => {
    expect(E2EE_HANDSHAKE_RATE_BURST).toBeGreaterThanOrEqual(RELAY_MAX_CHANNELS);
  });

  it("L4 — a pairing reservation outlives its window and expires before its record", () => {
    expect(E2EE_PAIRING_WINDOW).toBeLessThanOrEqual(E2EE_PAIRING_RESERVATION_LIFETIME);
    expect(E2EE_PAIRING_RESERVATION_LIFETIME).toBeLessThan(E2EE_PENDING_CLIENT_RETENTION);
  });

  it("L5 — the close phase fits inside one keepalive period, charging T_CLOSE twice", () => {
    expect(2 * T_CLOSE + T_CLOSE_LINGER_MAX + T_KEEPALIVE_FLUSH_MARGIN).toBeLessThanOrEqual(
      RPC_KEEPALIVE_INTERVAL,
    );
  });
});

describe("the two deliberate equalities §3.2 states in prose", () => {
  it("mirrors the last-seen write interval with the fallback write interval", () => {
    // §3.2 calls this equality out as deliberate: the fallback interval mirrors
    // the last-seen interval. The pairing-reservation row's equality with the
    // same value is, by contrast, explicitly coincidental, so nothing asserts it.
    expect(E2EE_FALLBACK_WRITE_INTERVAL).toBe(E2EE_LAST_SEEN_WRITE_INTERVAL);
  });
});

describe("rows defined by another module (§3.2 cross-check)", () => {
  it("re-exports the relay chunking and connection rows unchanged", () => {
    expect(RELAY_CHUNK_MAGIC).toBe(CONTRACT_CHUNK_MAGIC);
    expect(RELAY_CHUNK_HEADER_BYTES).toBe(CONTRACT_CHUNK_HEADER_BYTES);
    expect(RELAY_MAX_RPC_MESSAGE_BYTES).toBe(CONTRACT_MAX_RPC_MESSAGE_BYTES);
    expect(RELAY_MAX_DATA_CHUNK_BYTES).toBe(CONTRACT_MAX_DATA_CHUNK_BYTES);
    expect(RELAY_MIN_DATA_CHUNK_BYTES).toBe(CONTRACT_MIN_DATA_CHUNK_BYTES);
    expect(RELAY_MAX_CHANNELS).toBe(CONTRACT_MAX_CHANNELS);
  });

  it("derives the prelude length from the prelude itself", () => {
    expect(RELAY_CHUNK_CAPABILITY_PRELUDE_BYTES).toBe(RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength);
  });

  it("agrees with the node identity primitives on the Ed25519 rows", () => {
    // Restated rather than re-exported so the constants module stays free of
    // `node:crypto`; this is the cross-check that keeps the two in step.
    expect(ED25519_PUBLIC_KEY_BYTES).toBe(IDENTITY_ED25519_PUBLIC_KEY_BYTES);
    expect(ED25519_SIGNATURE_BYTES).toBe(IDENTITY_ED25519_SIGNATURE_BYTES);
  });
});

describe("e2eeNegotiationBufferMaxBytes (§3.2, §4.4)", () => {
  it("mirrors the relay send queue's own aggregate budget", () => {
    expect(
      e2eeNegotiationBufferMaxBytes({
        maxQueuedBytes: 8 * 1_024 * 1_024,
        maxControlFrameBytes: 256 * 1_024,
      }),
    ).toBe(8 * 1_024 * 1_024 - 256 * 1_024);
  });

  it("goes non-positive exactly when the Hub asserts limits that leave no room", () => {
    expect(
      e2eeNegotiationBufferMaxBytes({ maxQueuedBytes: 2_048, maxControlFrameBytes: 2_048 }),
    ).toBe(0);
  });
});

describe("channel size budget (§4.5)", () => {
  const budget = (maxQueuedBytes: number, maxControlFrameBytes: number) =>
    e2eeChannelSizeBudget({ maxQueuedBytes, maxControlFrameBytes });

  it("clamps to the relay message ceiling when the queue budget is the larger term", () => {
    const large = budget(64 * 1_024 * 1_024, 256 * 1_024);
    expect(large.effectiveMessageCeiling).toBe(4_194_304);
    expect(large.plaintextCeiling).toBe(4_194_304 - 32);
    expect(large.establishable).toBe(true);
  });

  it("takes the queue budget when the Hub asserts limits below the relay ceiling", () => {
    const small = budget(8 * 1_024 * 1_024, 8 * 1_024 * 1_024 - 4_096);
    expect(small.effectiveMessageCeiling).toBe(4_096);
    expect(small.plaintextCeiling).toBe(4_096 - E2EE_ENVELOPE_OVERHEAD_BYTES);
  });

  it("switches terms at exactly the relay message ceiling", () => {
    const control = 1_024;
    const below = budget(RELAY_MAX_RPC_MESSAGE_BYTES + control - 1, control);
    const at = budget(RELAY_MAX_RPC_MESSAGE_BYTES + control, control);
    const above = budget(RELAY_MAX_RPC_MESSAGE_BYTES + control + 1, control);
    expect(below.effectiveMessageCeiling).toBe(RELAY_MAX_RPC_MESSAGE_BYTES - 1);
    expect(at.effectiveMessageCeiling).toBe(RELAY_MAX_RPC_MESSAGE_BYTES);
    // Above the relay ceiling the Hub's larger assertion buys nothing: the
    // reassembly cap on the receiving side is fixed and not Hub-asserted.
    expect(above.effectiveMessageCeiling).toBe(RELAY_MAX_RPC_MESSAGE_BYTES);
  });

  it("is exactly one envelope overhead below the message ceiling", () => {
    // §4.5's documented reduction relative to a legacy channel, at both terms
    // of the minimum.
    for (const limits of [budget(64 * 1_024 * 1_024, 1_024), budget(100_000, 1_024)]) {
      expect(limits.effectiveMessageCeiling - limits.plaintextCeiling).toBe(
        E2EE_ENVELOPE_OVERHEAD_BYTES,
      );
    }
  });

  it("fails establishment exactly when the ceiling cannot hold the envelope overhead", () => {
    // §4.5: a channel whose plaintextCeiling is not positive MUST fail during
    // establishment (§11.2 P14), so the boundary is at one byte of plaintext.
    const oneByte = budget(E2EE_ENVELOPE_OVERHEAD_BYTES + 1 + 1_024, 1_024);
    expect(oneByte.plaintextCeiling).toBe(1);
    expect(oneByte.establishable).toBe(true);

    const noBytes = budget(E2EE_ENVELOPE_OVERHEAD_BYTES + 1_024, 1_024);
    expect(noBytes.plaintextCeiling).toBe(0);
    expect(noBytes.establishable).toBe(false);

    const short = budget(E2EE_ENVELOPE_OVERHEAD_BYTES - 1 + 1_024, 1_024);
    expect(short.plaintextCeiling).toBe(-1);
    expect(short.establishable).toBe(false);

    // The untrusted Hub may also assert a control-frame budget larger than the
    // whole queue; that is fail-closed here rather than a negative allowance.
    const inverted = budget(1_024, 4_096);
    expect(inverted.effectiveMessageCeiling).toBe(-3_072);
    expect(inverted.establishable).toBe(false);
  });

  it("shares the one subtraction with the negotiation buffer budget", () => {
    const limits = { maxQueuedBytes: 3 * 1_024 * 1_024, maxControlFrameBytes: 256 * 1_024 };
    expect(e2eeChannelSizeBudget(limits).effectiveMessageCeiling).toBe(
      e2eeNegotiationBufferMaxBytes(limits),
    );
  });
});

describe("negotiation record bounds (§3.2, §3.3)", () => {
  it("keeps the handshake reject far below the records it replaces", () => {
    expect(E2EE_HANDSHAKE_REJECT_BYTES).toBeLessThan(E2EE_CLIENT_HELLO_MAX_BYTES);
    expect(E2EE_CLIENT_HELLO_MAX_BYTES).toBeLessThan(E2EE_SERVER_ACCEPT_MAX_BYTES);
    // Every negotiation record fits the smallest serviceable data chunk, so no
    // handshake record is ever the reason an advertisement-capable connection
    // fails (§5.5).
    expect(E2EE_SERVER_ACCEPT_MAX_BYTES).toBeLessThanOrEqual(E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES);
  });
});

// ─── §14.2 pin-audited-lineage rule, §14.4 codec pin ─────────────────────────
//
// §14.2 requires exact pins inside the independently audited major lineage and
// at or above each audit baseline, and states plainly that the 2.x line of each
// noble package carries only a maintainer self-audit — adopting it REQUIRES
// recorded owner acceptance in a revision of that section and MUST NOT happen
// as an incidental dependency bump. That rule is machine-checked below rather
// than left to review, because an incidental bump is exactly the failure mode
// it names and a lockfile diff is exactly what review skims.

function readPackageJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function findUpwards(relativePath: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Could not locate ${relativePath}.`);
    directory = parent;
  }
}

function installedVersion(packageName: string): string {
  const manifest = readPackageJson(findUpwards(join("node_modules", packageName, "package.json")));
  return String(manifest["version"]);
}

function workspaceCatalog(): Record<string, string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const manifest = readPackageJson(candidate) as {
        readonly workspaces?: { readonly catalog?: Record<string, string> };
      };
      const catalog = manifest.workspaces?.catalog;
      if (catalog) return catalog;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Could not locate the workspace catalog.");
    directory = parent;
  }
}

/** Split a `name@version` §3.2 pin, tolerating the leading `@` of a scope. */
function splitPin(pin: string): { readonly name: string; readonly version: string } {
  const separator = pin.lastIndexOf("@");
  return { name: pin.slice(0, separator), version: pin.slice(separator + 1) };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("dependency pins (§3.2 Encoding and Dependencies, §14.2, §14.4)", () => {
  const catalog = workspaceCatalog();

  it("installs exactly the canonical-CBOR codec version §3.2 pins", () => {
    const pin = splitPin(E2EE_CBOR_CODEC);
    expect(pin.name).toBe("cborg");
    expect(catalog[pin.name]).toBe(pin.version);
    expect(installedVersion(pin.name)).toBe(pin.version);
  });

  for (const baseline of [
    E2EE_NOBLE_CURVES_AUDIT_BASELINE,
    E2EE_NOBLE_CIPHERS_AUDIT_BASELINE,
    E2EE_NOBLE_HASHES_AUDIT_BASELINE,
  ]) {
    const { name, version: baselineVersion } = splitPin(baseline);

    it(`keeps ${name} in its audited lineage, at or above its baseline`, () => {
      const pinned = catalog[name];
      // "MUST pin exact versions": a range would let a resolver pick the
      // unaudited line without any diff to review.
      expect(pinned).toMatch(EXACT_VERSION);
      const installed = installedVersion(name);
      expect(installed).toBe(pinned);
      expect(installed).toMatch(EXACT_VERSION);
      // Stay within the reviewed major lineage so a future major requires an
      // explicit protocol-security review rather than only a catalog edit.
      expect(installed.split(".")[0]).toBe(baselineVersion.split(".")[0]);
      // And never older than the audited baseline itself.
      expect(compareVersions(installed, baselineVersion)).toBeGreaterThanOrEqual(0);
    });
  }
});
