import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encode, rfc8949EncodeOptions } from "cborg";

import {
  E2EE_AGREEMENT_PUBLIC_KEY_BYTES,
  E2EE_KEY_FINGERPRINT_BYTES,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  P256_PUBLIC_KEY_BYTES,
  P256_SIGNATURE_BYTES,
} from "./relayE2eeConstants.ts";
import { RelayE2eeValidationError, invalidRelayE2eeInput } from "./relayE2eeIds.ts";

// Key material, fingerprints, and signature verification for the Ryco relay
// E2EE protocol — docs/relay-e2ee-protocol.md §7.1 (encoding conventions,
// fingerprints, and key material validation) and §14.3 (mandated primitive
// behavior).
//
// This is the lowest layer of the E2EE implementation: the transcript encoders
// (§7.2–§7.6, §8.3) and the display derivations (§13.4, §13.5) all sit on top of
// it, and every signature this protocol verifies passes through
// `verifyE2eeSignature` below.
//
// THE ONE VERIFICATION CHOKE POINT. §14.3 requires `zip215: false` on every
// Ed25519 verification and full §7.1 validation on every P-256 key and
// signature. A rule that has to be repeated at each call site is a rule one call
// site will eventually omit, so there is exactly one verification function here
// and it is the only place either curve's verify is reached. It takes the
// algorithm as a value rather than exposing one entry point per curve, so an
// added algorithm is a change to this function and not a new unguarded path.
//
// It is free of Node built-ins so the web and mobile clients can carry it: the
// web tier validates node-signed statements (§5.2) and the native tier signs its
// own prekey certificate (§7.4), so this module runs on Bun, in evergreen
// browsers, and on Hermes (§14.2). That is also why the `ryco.node-key.v1`
// fingerprint is computed here rather than imported from `nodeIdentity.ts`,
// which imports `node:crypto`: §7.1 defines the node-identity fingerprint as the
// existing construction reused unchanged, and `relayE2eeKeys.test.ts` pins that
// equality — raw digest and display form — against the node identity primitives
// themselves, exactly as `relayE2eeConstants.ts` cross-checks the `ED25519_*`
// lengths it restates for the same reason.
//
// Validators return copies and throw on rejection: they are handed local key
// material and material a caller has already length-checked out of a decoded
// structure, and a rejection is a fatal condition for the structure that carried
// it. `verifyE2eeSignature` is the exception — it takes unvalidated peer bytes
// and returns `false` for every failure, never throwing.

// The single validation error lives in the dependency-free `relayE2eeIds.ts` so
// identifier validation never loads the primitives above; it is re-exported here
// unchanged, so `instanceof` holds across both import paths.
export { RelayE2eeValidationError, invalidRelayE2eeInput };

/** Cross-runtime SHA-256 used for exact E2EE wire-artifact digests. */
export function e2eeSha256(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

// ─── §7.1 fingerprint domains and algorithm labels ───────────────────────────

/** Node identity keys (§3.5, §7.1). The existing definition, reused unchanged. */
export const E2EE_NODE_KEY_FINGERPRINT_DOMAIN = "ryco.node-key.v1" as const;
/** Client identity keys (§3.5, §7.1). */
export const E2EE_CLIENT_KEY_FINGERPRINT_DOMAIN = "ryco.client-key.v1" as const;
/** X25519 agreement keys, node and client alike (§3.5, §7.1). */
export const E2EE_AGREEMENT_KEY_FINGERPRINT_DOMAIN = "ryco.e2ee-agreement-key.v1" as const;

/** Node identity algorithm label; the only one protocol version 1 admits (§7.1). */
export const E2EE_NODE_IDENTITY_ALGORITHM = "ed25519" as const;
/** Client identity algorithm label; the only one protocol version 1 admits (§7.1). */
export const E2EE_CLIENT_IDENTITY_ALGORITHM = "p256" as const;
/** Agreement-key algorithm label (§7.1). */
export const E2EE_AGREEMENT_ALGORITHM = "x25519" as const;

/** The literal prefix of the fingerprint display form (§7.1). */
export const E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX = "SHA256:" as const;

/**
 * The three key families of the §7.1 fingerprint table. A family fixes the
 * domain, the algorithm label, and the validation the raw key must pass, so no
 * caller chooses a domain and an algorithm label independently and none can
 * fingerprint a key it did not validate.
 */
export type E2eeKeyFamily = "node-identity" | "client-identity" | "agreement";

export type E2eeSignatureAlgorithm =
  | typeof E2EE_NODE_IDENTITY_ALGORITHM
  | typeof E2EE_CLIENT_IDENTITY_ALGORITHM;

const FINGERPRINT_DOMAINS: Readonly<Record<E2eeKeyFamily, string>> = {
  "node-identity": E2EE_NODE_KEY_FINGERPRINT_DOMAIN,
  "client-identity": E2EE_CLIENT_KEY_FINGERPRINT_DOMAIN,
  agreement: E2EE_AGREEMENT_KEY_FINGERPRINT_DOMAIN,
};

const FINGERPRINT_ALGORITHMS: Readonly<Record<E2eeKeyFamily, string>> = {
  "node-identity": E2EE_NODE_IDENTITY_ALGORITHM,
  "client-identity": E2EE_CLIENT_IDENTITY_ALGORITHM,
  agreement: E2EE_AGREEMENT_ALGORITHM,
};

// ─── §7.1 key material validation ────────────────────────────────────────────

function copyExactBytes(value: Uint8Array, expectedLength: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    invalidRelayE2eeInput();
  }
  return Uint8Array.from(value);
}

function bytesToBigIntBe(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]!);
  }
  return value;
}

/**
 * Ed25519 public key (§7.1): exactly `ED25519_PUBLIC_KEY_BYTES`, strict RFC 8032
 * decoding. Strict means the ZIP215 relaxation is off, so a `y` coordinate at or
 * above the field prime is rejected here rather than silently accepted as a
 * different point at verification time (§14.3).
 */
export function validateE2eeNodeIdentityPublicKey(publicKey: Uint8Array): Uint8Array {
  const copy = copyExactBytes(publicKey, ED25519_PUBLIC_KEY_BYTES);
  if (!ed25519.utils.isValidPublicKey(copy, false)) invalidRelayE2eeInput();
  return copy;
}

/**
 * P-256 public key (§7.1): `P256_PUBLIC_KEY_BYTES` in X9.63 uncompressed form,
 * first byte `0x04`, both coordinates strictly below the field prime, on the
 * curve, and not the identity.
 *
 * The coordinate-range check is explicit because the pinned curve library
 * decodes an uncompressed point without reducing or range-checking the
 * coordinates first, so `X + p` would otherwise decode to the same point as `X`
 * and give one key two accepted encodings — and every fingerprint in §7.1 is
 * taken over the encoding.
 */
export function validateE2eeClientIdentityPublicKey(publicKey: Uint8Array): Uint8Array {
  const copy = copyExactBytes(publicKey, P256_PUBLIC_KEY_BYTES);
  if (copy[0] !== 0x04) invalidRelayE2eeInput();
  const coordinateBytes = (P256_PUBLIC_KEY_BYTES - 1) / 2;
  const fieldPrime = p256.Point.Fp.ORDER;
  const x = bytesToBigIntBe(copy.subarray(1, 1 + coordinateBytes));
  const y = bytesToBigIntBe(copy.subarray(1 + coordinateBytes));
  if (x >= fieldPrime || y >= fieldPrime) invalidRelayE2eeInput();
  try {
    if (p256.Point.fromBytes(copy).is0()) invalidRelayE2eeInput();
  } catch {
    return invalidRelayE2eeInput();
  }
  return copy;
}

/**
 * X25519 agreement public key (§7.1): exact length and nothing else. There is no
 * point validation for X25519; the single mandated behavior for invalid and
 * low-order inputs is the §8.6 all-zero shared-secret abort, which belongs to
 * the handshake and not to this module.
 */
export function validateE2eeAgreementPublicKey(publicKey: Uint8Array): Uint8Array {
  return copyExactBytes(publicKey, E2EE_AGREEMENT_PUBLIC_KEY_BYTES);
}

/** Validate a public key against the rules its §7.1 family fixes. */
export function validateE2eePublicKey(family: E2eeKeyFamily, publicKey: Uint8Array): Uint8Array {
  switch (family) {
    case "node-identity":
      return validateE2eeNodeIdentityPublicKey(publicKey);
    case "client-identity":
      return validateE2eeClientIdentityPublicKey(publicKey);
    case "agreement":
      return validateE2eeAgreementPublicKey(publicKey);
    default:
      return invalidRelayE2eeInput();
  }
}

/**
 * Ed25519 signature encoding check (§7.1): exactly `ED25519_SIGNATURE_BYTES`.
 * Canonicality of the point and scalar halves is decided by the strict
 * verification in `verifyE2eeSignature`, which is where a non-canonical value
 * has to fail — it cannot be seen from the length alone.
 */
export function validateE2eeNodeSignature(signature: Uint8Array): Uint8Array {
  return copyExactBytes(signature, ED25519_SIGNATURE_BYTES);
}

/**
 * P-256 ECDSA signature encoding check (§7.1): exactly `P256_SIGNATURE_BYTES` of
 * fixed-width raw `r ‖ s`, each coordinate big-endian, with `1 ≤ r, s ≤ n − 1`.
 * ASN.1/DER never has this length and is rejected here. Either `s` value is
 * accepted: the protocol derives no uniqueness from signature bytes.
 */
export function validateE2eeClientSignature(signature: Uint8Array): Uint8Array {
  const copy = copyExactBytes(signature, P256_SIGNATURE_BYTES);
  const half = P256_SIGNATURE_BYTES / 2;
  const groupOrder = p256.Point.Fn.ORDER;
  const r = bytesToBigIntBe(copy.subarray(0, half));
  const s = bytesToBigIntBe(copy.subarray(half));
  if (r < 1n || r >= groupOrder || s < 1n || s >= groupOrder) invalidRelayE2eeInput();
  return copy;
}

// ─── §7.1 fingerprints ───────────────────────────────────────────────────────

/**
 * `fingerprint(domain, algorithm, publicKey) =
 * SHA-256(canonical-CBOR([ domain, algorithm, bstr(publicKey) ]))` (§7.1),
 * producing `E2EE_KEY_FINGERPRINT_BYTES`.
 *
 * The key is validated for its family first, so no fingerprint of a key this
 * protocol would refuse can be produced, and a verifier that recomputes a
 * received fingerprint here is recomputing it from validated material.
 */
export function e2eeKeyFingerprint(family: E2eeKeyFamily, publicKey: Uint8Array): Uint8Array {
  const validated = validateE2eePublicKey(family, publicKey);
  const canonical = encode(
    [FINGERPRINT_DOMAINS[family], FINGERPRINT_ALGORITHMS[family], validated],
    rfc8949EncodeOptions,
  );
  return sha256(canonical);
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Unpadded base64url, written out rather than taken from a platform helper
 * because this module runs on Hermes, where neither `Buffer` nor `btoa` is
 * guaranteed. It is used for the §7.1 display form only; nothing signed or
 * hashed passes through it.
 */
function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += BASE64URL_ALPHABET[first >> 2];
    out += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    out += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    out += BASE64URL_ALPHABET[third & 0x3f];
  }
  return out;
}

/**
 * The §7.1 display form: `SHA256:` followed by the unpadded base64url digest.
 * Fingerprints travel in transcripts as raw digest byte strings and take this
 * form only where a human reads them.
 */
export function formatE2eeKeyFingerprint(fingerprint: Uint8Array): string {
  const digest = copyExactBytes(fingerprint, E2EE_KEY_FINGERPRINT_BYTES);
  return `${E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX}${encodeBase64Url(digest)}`;
}

/**
 * The inverse of `formatE2eeKeyFingerprint`, for the one input that arrives in
 * the display form: §13.6 requires the owner to name a client key at the node
 * CLI, and the value they read off the device is the §7.1 display string.
 *
 * STRICT, and deliberately so. It admits exactly what the formatter emits — the
 * prefix, then the unpadded base64url of exactly `E2EE_KEY_FINGERPRINT_BYTES` —
 * and rejects padding, whitespace, alternate alphabets, and any trailing bits
 * the last character could smuggle in. A lenient parser here would let two
 * different strings name one record and one string name none, and the §13.6
 * pairing-window discriminator is matched by byte equality against a value the
 * node has already authenticated.
 */
export function parseE2eeKeyFingerprint(display: string): Uint8Array {
  if (typeof display !== "string") invalidRelayE2eeInput();
  if (!display.startsWith(E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX)) invalidRelayE2eeInput();
  const encoded = display.slice(E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX.length);
  const bytes = new Uint8Array(E2EE_KEY_FINGERPRINT_BYTES);
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of encoded) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    if (value < 0) invalidRelayE2eeInput();
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (written >= E2EE_KEY_FINGERPRINT_BYTES) invalidRelayE2eeInput();
      bytes[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
  }
  // The trailing partial group must be zero-padded, exactly as the encoder
  // leaves it; a nonzero remainder is a distinct string for the same digest.
  if (written !== E2EE_KEY_FINGERPRINT_BYTES) invalidRelayE2eeInput();
  if (bits !== 0 && (accumulator & ((1 << bits) - 1)) !== 0) invalidRelayE2eeInput();
  return bytes;
}

/**
 * Byte equality for the public material this protocol compares — fingerprints,
 * public keys, commitments, chain links. Every value compared through it is
 * public by construction (§6.2), so this is an ordinary comparison and MUST NOT
 * be used for secrets.
 */
export function e2eeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// ─── §6.2 static agreement key generation ────────────────────────────────────

/**
 * X25519 secret-scalar length (RFC 7748 §5).
 *
 * Deliberately NOT a §3.2 constant: §3.2 names the lengths of values this
 * protocol puts on a wire or in a signed structure, and no structure carries an
 * agreement secret key. It exists here only to bound the input of
 * `deriveE2eeAgreementPublicKey`.
 */
const X25519_SECRET_KEY_BYTES = 32;

/**
 * A static X25519 agreement keypair (§6.2).
 *
 * The secret half is a live secret from the moment it is returned: the caller
 * owns its buffer and MUST zeroize it once it has been handed to its custody
 * layer (§6.3).
 */
export interface E2eeAgreementKeyPair {
  /** The X25519 secret scalar. Caller-owned; zeroize after use (§6.3). */
  readonly secretKey: Uint8Array;
  /** `E2EE_AGREEMENT_PUBLIC_KEY_BYTES` (§7.1). */
  readonly publicKey: Uint8Array;
}

/**
 * Generate a static X25519 agreement keypair — the node agreement prekey (§6.2,
 * §6.4) and the native client's per-device agreement key (§6.2, §7.4).
 *
 * This lives here, and not in the endpoint that stores the key, for the reason
 * §14.2 gives: every curve operation in this protocol is a call into the pinned
 * primitive packages through their documented entry points, and this module is
 * the one place either curve is reached from outside the §14.1 Noise module.
 * An endpoint that generated its own agreement key would be a second,
 * unreviewed path to the same primitive.
 *
 * Handshake ephemerals are NOT generated here: §6.2 makes them per-handshake
 * state owned by the Noise module, which generates and erases them itself.
 *
 * §14.5: the CSPRNG is the primitive's, and it fails closed when the runtime has
 * no `crypto.getRandomValues` rather than falling back to anything.
 */
export function generateE2eeAgreementKeyPair(): E2eeAgreementKeyPair {
  const keyPair = x25519.keygen();
  return { secretKey: keyPair.secretKey, publicKey: keyPair.publicKey };
}

/**
 * Recover the public half of a stored static agreement key (§6.2, §6.3).
 *
 * A custody layer that persists only the secret scalar — which is the whole of
 * an X25519 private key — derives the public key on load rather than trusting a
 * separately stored copy that could disagree with it.
 *
 * The returned key is validated as a §7.1 agreement public key, so a caller can
 * hand it straight to a §7 encoder. The input is not copied and not zeroized:
 * the secret belongs to the caller, which is the only party that knows when its
 * borrow ends.
 */
export function deriveE2eeAgreementPublicKey(secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== X25519_SECRET_KEY_BYTES) {
    invalidRelayE2eeInput();
  }
  try {
    return validateE2eeAgreementPublicKey(x25519.getPublicKey(secretKey));
  } catch (error: unknown) {
    if (error instanceof RelayE2eeValidationError) throw error;
    return invalidRelayE2eeInput();
  }
}

// ─── §7.1, §14.3 signature verification ──────────────────────────────────────

export interface E2eeSignatureVerification {
  readonly algorithm: E2eeSignatureAlgorithm;
  readonly publicKey: Uint8Array;
  /** The exact bytes emitted by the applicable named encoder (§7.2). */
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
}

/**
 * Verify one signature under the §7.1 encodings and the §14.3 mandated primitive
 * behavior. THIS IS THE ONLY VERIFICATION PATH IN THIS PROTOCOL; nothing else
 * may call a curve library's `verify`.
 *
 * - Ed25519 is verified with `zip215: false`, which is strict RFC 8032: a
 *   non-canonical point or scalar encoding — values a ZIP215-style verifier
 *   accepts — is rejected, and so is a small-order public key.
 * - P-256 is ECDSA over SHA-256 of the message, with the signature read as
 *   fixed-width raw `r ‖ s` (`format: "compact"`). DER is not a format this
 *   function will parse. `lowS` is off because §7.1 accepts either `s` value.
 *
 * Returns `false` for every failure and never throws: the caller is holding peer
 * bytes, and a thrown verification is a denial-of-service surface, not a
 * verdict.
 */
export function verifyE2eeSignature(input: E2eeSignatureVerification): boolean {
  try {
    if (input.algorithm === E2EE_NODE_IDENTITY_ALGORITHM) {
      const publicKey = validateE2eeNodeIdentityPublicKey(input.publicKey);
      const signature = validateE2eeNodeSignature(input.signature);
      const memoKey = verifiedSignatureKey(input.algorithm, publicKey, input.message, signature);
      if (rememberedVerifiedSignature(memoKey)) return true;
      const verified = ed25519.verify(signature, input.message, publicKey, { zip215: false });
      if (verified) rememberVerifiedSignature(memoKey);
      return verified;
    }
    if (input.algorithm === E2EE_CLIENT_IDENTITY_ALGORITHM) {
      const publicKey = validateE2eeClientIdentityPublicKey(input.publicKey);
      const signature = validateE2eeClientSignature(input.signature);
      const memoKey = verifiedSignatureKey(input.algorithm, publicKey, input.message, signature);
      if (rememberedVerifiedSignature(memoKey)) return true;
      const verified = p256.verify(signature, sha256(input.message), publicKey, {
        prehash: false,
        lowS: false,
        format: "compact",
      });
      if (verified) rememberVerifiedSignature(memoKey);
      return verified;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── verified-signature memo ──────────────────────────────────────────────────
//
// A client re-verifies the same node-signed bytes on every reconnect: the §5.2
// capability statement's identity signature, its prekey cross-signature, and
// every §7.5 continuity link, all through the function above. A signature
// verdict under §14.3 is a pure function of (algorithm, key, message,
// signature), so a triple this process has already verified true verifies true
// again, and only that verdict is remembered. A failure is never remembered,
// every §7.1 validation above still runs first, and nothing about the
// statement's time, origin, pin, policy generation or suite selection is
// cached — the callers re-run every one of those checks around each lookup.
//
// The key is SHA-256 over the length-prefixed algorithm label, key, message and
// signature, so a hit requires those exact bytes. Bounded and per process (per
// tab on the web): it holds digests only, never key material or messages.

const VERIFIED_SIGNATURE_MEMO_LIMIT = 128;
const verifiedSignatures = new Set<string>();

function verifiedSignatureKey(
  algorithm: E2eeSignatureAlgorithm,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): string {
  const hash = sha256.create();
  for (const part of [new TextEncoder().encode(algorithm), publicKey, message, signature]) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, part.byteLength);
    hash.update(length);
    hash.update(part);
  }
  return bytesToHex(hash.digest());
}

function rememberedVerifiedSignature(key: string): boolean {
  if (!verifiedSignatures.has(key)) return false;
  // Most recently used last, so the bound evicts the stalest verdict.
  verifiedSignatures.delete(key);
  verifiedSignatures.add(key);
  return true;
}

function rememberVerifiedSignature(key: string): void {
  verifiedSignatures.add(key);
  if (verifiedSignatures.size > VERIFIED_SIGNATURE_MEMO_LIMIT) {
    verifiedSignatures.delete(verifiedSignatures.values().next().value!);
  }
}

/** Test seam: forget every remembered verdict. */
export function resetE2eeSignatureMemoForTests(): void {
  verifiedSignatures.clear();
}

/** Test seam: how many verdicts are remembered. */
export function e2eeSignatureMemoSizeForTests(): number {
  return verifiedSignatures.size;
}

// RFC 8032 §7.1 TEST 1: a valid Ed25519 signature over the empty message.
const WARM_ED25519_PUBLIC_KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const WARM_ED25519_SIGNATURE =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
let primitivesWarmed = false;

/**
 * Run each curve operation a client handshake needs once, off its critical
 * path, so the first real connect does not pay the curve library's lazy
 * precomputation and the engine's first-call compilation (about 20 ms on a
 * desktop, several times that on a phone). A throwaway X25519 key pair and
 * agreement, and one strict Ed25519 verification of a fixed public test vector
 * through the verification path above. Nothing it computes is kept or used;
 * it runs once per process.
 */
export function warmE2eePrimitives(): void {
  if (primitivesWarmed) return;
  primitivesWarmed = true;
  try {
    const local = x25519.keygen();
    const remote = x25519.keygen();
    x25519.getSharedSecret(local.secretKey, remote.publicKey).fill(0);
    local.secretKey.fill(0);
    remote.secretKey.fill(0);
    verifyE2eeSignature({
      algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
      publicKey: hexToBytes(WARM_ED25519_PUBLIC_KEY),
      message: new Uint8Array(0),
      signature: hexToBytes(WARM_ED25519_SIGNATURE),
    });
  } catch {
    // A warm-up is an optimization only; the real handshake reports failures.
  }
}
