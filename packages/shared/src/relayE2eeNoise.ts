import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { clean, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  E2EE_AEAD_NONCE_BYTES,
  E2EE_AEAD_TAG_BYTES,
  E2EE_AGREEMENT_PUBLIC_KEY_BYTES,
  E2EE_SECRET_BYTES,
} from "./relayE2eeConstants.ts";
import { e2eeX25519KeyPair, e2eeX25519PublicKey, e2eeX25519SharedSecret } from "./relayE2eeKeys.ts";
import {
  E2EE_NOISE_PATTERN_IK,
  E2EE_NOISE_PATTERN_NX,
  type E2eeNoisePattern,
} from "./relayE2eeTranscripts.ts";

// The Noise handshake state machine of the Ryco relay E2EE protocol —
// docs/relay-e2ee-protocol.md §8 (handshake), §6.5 (session keys and the
// exporter), §3.4 (suite registry), and §14.1 (the owner-accepted deviation
// that produced this file).
//
// THIS FILE IS THE ENTIRE SCOPE OF THE §14.1 AUDIT OBLIGATION. §14.1 permits
// exactly one first-party module implementing the Noise
// `CipherState`/`SymmetricState`/`HandshakeState` composition for the two §3.4
// protocol names, message ordering, nonce handling, `Split()`, and the §6.5
// exporter — and requires that it "perform no primitive arithmetic of its own
// and call only the §14.2 primitive packages". Every AEAD, hash, HMAC/HKDF, and
// curve operation below is therefore a call into `@noble/ciphers`,
// `@noble/hashes`, or `@noble/curves`, through their documented public entry
// points only (§14.6) — the X25519 operations through the `relayE2eeKeys`
// dispatch functions, which call `@noble/curves` unless a §14.7 native
// implementation is installed, and then still leave every all-zero abort and
// every error to `@noble/curves`. Nothing here reimplements a primitive, and
// nothing here may grow a second protocol name, a PSK token, a fallback
// pattern, or a transport cipher state.
//
// KEEP IT SMALL. §14.1's bound on first-party Noise code is what makes a scoped
// third-party audit possible at all, and that audit is a precondition for
// flipping the `requireE2EE` default (§12.3). A change here is a change to the
// audited surface.
//
// Noise references below are to the Noise Protocol Framework at revision
// `NOISE_SPEC_REVISION` (§3.2), whose section numbers are cited as "Noise §n".
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO:
//
//   - It defines no transport encryption. §6.5 consumes the two `Split()`
//     outputs as the directional epoch-0 secrets of §9 and forbids using the
//     Noise cipher states themselves for transport, so `split()` returns key
//     bytes and this module never builds a post-handshake `CipherState`.
//   - It enforces no §8 payload schema. The §8.5 rule that an NX message-1
//     payload MUST be zero-length, the §8.5/§8.7 CBOR payload shapes, and the
//     §8.6 ordering of responder checks all belong to the handshake driver: the
//     official §16.3 F15 vectors carry payloads on every message of both
//     patterns, and this module MUST reproduce them exactly (§14.1).
//   - It reads no clock, holds no channel state, and logs nothing.
//
// ERRORS ARE FATAL AND CARRY NO INPUT. Every throw out of this module aborts the
// handshake for good — that is §8.1's "any failure after a hello is sent or
// consumed is fatal for the channel" and §8.6 step 4's "any Noise failure …
// aborts". The failures the primitives raise (an all-zero X25519 shared secret,
// §14.3; an AEAD authentication failure) propagate UNCHANGED rather than being
// caught and reclassified, because §14.3 makes the primitive's throw the single
// mandated signal for the low-order/invalid-input case. `E2eeNoiseHandshakeError`
// covers this module's own guards, and its `reason` is a LOCAL classification
// only: §11.2 requires every pre-key failure to be externally indistinguishable,
// so no reason may reach a peer, a log, or an error surface.

// ─── §3.4 protocol names, §3.5 exporter label ────────────────────────────────

/**
 * Noise protocol name of the signed native tier (§3.4 suite `0x01`, §8.1). The
 * client is the initiator and the responder static is the node agreement prekey
 * advertised on the channel.
 */
export const E2EE_NOISE_PROTOCOL_NAME_IK = "Noise_IK_25519_ChaChaPoly_SHA256" as const;
/** Noise protocol name of the unsigned web tier (§3.4 suite `0x01`, §8.1); no client static. */
export const E2EE_NOISE_PROTOCOL_NAME_NX = "Noise_NX_25519_ChaChaPoly_SHA256" as const;
/** §3.5 HKDF label deriving `exporterSecret` from the final chaining key (§6.5). Not directional. */
export const E2EE_NOISE_EXPORTER_LABEL = "ryco.relay-e2ee.exporter.v1" as const;

/** The §3.4 protocol name the tier's pattern runs under (§8.1). */
export function e2eeNoiseProtocolName(pattern: E2eeNoisePattern): string {
  return pattern === E2EE_NOISE_PATTERN_IK
    ? E2EE_NOISE_PROTOCOL_NAME_IK
    : E2EE_NOISE_PROTOCOL_NAME_NX;
}

// ─── suite sizes ─────────────────────────────────────────────────────────────

/** Noise `HASHLEN` for SHA-256. Read from the primitive so the two can never disagree. */
const HASH_LEN = sha256.outputLen;
/** Noise `DHLEN` for X25519: the §3.2 agreement public-key length. */
const DH_LEN = E2EE_AGREEMENT_PUBLIC_KEY_BYTES;
/** ChaCha20-Poly1305 key length; §3.2 fixes it equal to every handshake-derived secret. */
const KEY_LEN = E2EE_SECRET_BYTES;
/** ChaCha20-Poly1305 tag length (§3.2). */
const TAG_LEN = E2EE_AEAD_TAG_BYTES;
/**
 * Noise §3: a Noise message is at most 65535 bytes. The §3.3 record bounds are
 * far tighter, but this is the pattern-level bound and it belongs here.
 */
const MAX_MESSAGE_BYTES = 65_535;
/**
 * Noise §5.1: `n` is a 64-bit nonce and the value 2^64 − 1 is reserved for
 * `Rekey()`, so an operation that would use it signals an error instead. A
 * bigint because the value does not fit an IEEE-754 integer, matching §3.1's
 * rule for the §3.3 counter — this is the Noise nonce, not the §9 counter, and
 * the two are deliberately not the same constant.
 */
const MAX_NONCE = 0xffff_ffff_ffff_ffffn;

const EXPORTER_LABEL_BYTES = utf8ToBytes(E2EE_NOISE_EXPORTER_LABEL);
const EMPTY_BYTES = new Uint8Array(0);

// ─── failures ────────────────────────────────────────────────────────────────

export type E2eeNoiseFailureReason =
  /** The option set does not describe a conforming role in the requested pattern (§8.1). */
  | "invalid_options"
  /** A key, or an injected ephemeral, is not exactly `DHLEN` bytes. */
  | "invalid_key_material"
  /** The operation is not the one this party owes at this point in the pattern. */
  | "out_of_sequence"
  /** The handshake already completed, failed, or was destroyed; it is single-use (§8.1). */
  | "handshake_consumed"
  /** The message is shorter than the message pattern requires, or a decrypted static is not `DHLEN`. */
  | "malformed_message"
  /** The message exceeds the Noise message bound (Noise §3). */
  | "message_too_large"
  /** The Noise nonce space is exhausted (Noise §5.1); unreachable inside a two-message pattern. */
  | "nonce_exhausted";

/**
 * The single error class of the Noise state machine. Its message is fixed and
 * its `reason` is local classification: §11.2 requires every pre-key failure to
 * be indistinguishable on the wire, so a caller maps every reason — and every
 * error the primitives raise — onto the same FATAL-PRE disposition.
 */
export class E2eeNoiseHandshakeError extends Error {
  readonly code = "relay_e2ee_noise_handshake_failed" as const;
  readonly reason: E2eeNoiseFailureReason;

  constructor(reason: E2eeNoiseFailureReason) {
    super("Relay E2EE Noise handshake failed.");
    this.name = "E2eeNoiseHandshakeError";
    this.reason = reason;
  }
}

function noiseFailure(reason: E2eeNoiseFailureReason): never {
  throw new E2eeNoiseHandshakeError(reason);
}

/**
 * Exact-length check for material this module READS. It acquires nothing, which
 * is what lets a caller validate before it acquires — see the constructor of
 * `E2eeNoiseHandshake`, and the ownership rule stated in `relayE2eeSession.ts`.
 */
function requireExactBytes(value: Uint8Array, expectedLength: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    noiseFailure("invalid_key_material");
  }
}

/** Exact-length check plus a defensive copy, for material this module then owns. */
function copyExactBytes(value: Uint8Array, expectedLength: number): Uint8Array {
  requireExactBytes(value, expectedLength);
  return Uint8Array.from(value);
}

/**
 * §9.5 erasure of buffers this module may or may not hold, TOTAL: it never
 * throws, whatever it is handed. Every use of it is on a path where key
 * material must be zeroed before a failure propagates, and an erasure that
 * threw would replace that failure with its own and strand the rest of the
 * buffers.
 */
function eraseBytes(...buffers: readonly (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) {
    if (!(buffer instanceof Uint8Array)) continue;
    try {
      clean(buffer);
    } catch {
      // One unusable buffer must not stop the rest from being zeroed.
    }
  }
}

// ─── Noise §4.3 / §5.1 HKDF and the §6.5 exporter ────────────────────────────

/**
 * Noise §4.3 `HKDF(chaining_key, input_key_material, 2)`, expressed on the
 * audited HKDF primitive rather than on a hand-rolled HMAC chain.
 *
 * The identity is exact, and it is the one thing an auditor should check here:
 * Noise defines `temp_key = HMAC-HASH(chaining_key, input_key_material)`,
 * `output1 = HMAC-HASH(temp_key, 0x01)`, and
 * `output2 = HMAC-HASH(temp_key, output1 ‖ 0x02)`. RFC 5869 defines
 * `HKDF-Extract(salt, IKM) = HMAC(salt, IKM)` and, for an EMPTY `info`,
 * `T(1) = HMAC(PRK, 0x01)` and `T(2) = HMAC(PRK, T(1) ‖ 0x02)`. So Noise's
 * `temp_key` is `extract` with the chaining key as the salt, and Noise's two
 * outputs are the first 2·HASHLEN bytes of `expand` with no `info`.
 *
 * No truncation branch exists: it applies only to a 64-byte hash, and this
 * suite's hash is SHA-256 (§3.4).
 */
function noiseHkdf2(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
): [Uint8Array, Uint8Array] {
  const tempKey = extract(sha256, inputKeyMaterial, chainingKey);
  let output: Uint8Array | undefined;
  let first: Uint8Array | undefined;
  try {
    output = expand(sha256, tempKey, undefined, 2 * HASH_LEN);
    first = output.slice(0, HASH_LEN);
    const second = output.slice(HASH_LEN);
    return [first, second];
  } catch (error) {
    // §9.5: every byte this function derives is either returned or zeroed. The
    // second slice is the only statement that can fail with the first already
    // split out, and a caller that never receives them cannot erase them.
    eraseBytes(first);
    throw error;
  } finally {
    eraseBytes(tempKey, output);
  }
}

/**
 * The Noise cipher nonce for counter `n` (Noise §5.1, §12.3): 32 bits of zeros
 * followed by the LITTLE-ENDIAN encoding of `n`, `E2EE_AEAD_NONCE_BYTES` in
 * total. `2^64 − 1` is reserved for `Rekey()`, so an operation that would use it
 * signals an error instead — which, in a two-message pattern, is unreachable.
 *
 * NOT the §3.3 record nonce, which is `epoch ‖ counter` big-endian and belongs
 * to `relayE2eeWire.ts`. The two are the same length and nothing else, and this
 * one exists only inside the handshake.
 *
 * It is exported for one reason, stated plainly: EVERY AEAD invocation in both
 * §3.4 patterns uses counter 0, because each of them is preceded by a `MixKey()`
 * that resets the counter. No handshake transcript — including the official
 * §16.3 F15 vectors, whose transport messages this module does not produce —
 * can therefore distinguish this encoding from any other, and an untested
 * encoding in this module is not acceptable. `relayE2eeNoise.test.ts` pins it
 * against literal vectors.
 */
export function e2eeNoiseCipherNonce(counter: bigint): Uint8Array {
  if (typeof counter !== "bigint" || counter < 0n) noiseFailure("invalid_options");
  if (counter >= MAX_NONCE) noiseFailure("nonce_exhausted");
  const nonce = new Uint8Array(E2EE_AEAD_NONCE_BYTES);
  let remaining = counter;
  for (let index = E2EE_AEAD_NONCE_BYTES - 8; index < E2EE_AEAD_NONCE_BYTES; index += 1) {
    nonce[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return nonce;
}

/**
 * THE §6.5 EXPORTER — `HKDF-Expand(ck_final, "ryco.relay-e2ee.exporter.v1",
 * E2EE_SECRET_BYTES)`, where `ck_final` is the Noise chaining key at the moment
 * `Split()` is invoked.
 *
 * This is a supported, documented API of this protocol and not a reach into any
 * dependency's internals, which is exactly how §14.6's no-undocumented-internals
 * rule is satisfied for the exporter: the state machine defining it is ours.
 * `E2eeNoiseHandshake.split()` calls it and returns its output; the chaining key
 * itself is never handed out, so the only way to reach an exporter secret from a
 * live handshake is through `split()`, and §6.5 permits no other extraction.
 *
 * `exporterSecret` feeds only `serverConfirmationKey` (§8.7).
 */
export function e2eeNoiseExporterSecret(chainingKey: Uint8Array): Uint8Array {
  if (!(chainingKey instanceof Uint8Array) || chainingKey.byteLength !== HASH_LEN) {
    noiseFailure("invalid_key_material");
  }
  return expand(sha256, chainingKey, EXPORTER_LABEL_BYTES, E2EE_SECRET_BYTES);
}

// ─── Noise §5.1 CipherState ──────────────────────────────────────────────────

/**
 * Noise §5.1. Handshake-only: §6.5 forbids using a Noise cipher state for
 * transport, so no instance of this class outlives `split()`.
 */
class NoiseCipherState {
  #k: Uint8Array | undefined = undefined;
  #n = 0n;

  /**
   * Noise §5.1 `InitializeKey(key)`. Takes ownership of `key`; resets `n` to
   * zero. The length check and the erasure of the previous key both precede the
   * acquisition, and the erasure is total, so nothing between them can throw
   * with `key` held by neither the caller nor this object.
   */
  initializeKey(key: Uint8Array): void {
    if (key.byteLength !== KEY_LEN) noiseFailure("invalid_key_material");
    eraseBytes(this.#k);
    this.#k = key;
    this.#n = 0n;
  }

  /** Noise §5.1 `HasKey()`. */
  get hasKey(): boolean {
    return this.#k !== undefined;
  }

  /** Noise §5.1 `EncryptWithAd(ad, plaintext)`; the identity function while unkeyed. */
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const key = this.#k;
    if (key === undefined) return plaintext;
    const nonce = e2eeNoiseCipherNonce(this.#n);
    const ciphertext = chacha20poly1305(key, nonce, ad).encrypt(plaintext);
    clean(nonce);
    this.#n += 1n;
    return ciphertext;
  }

  /**
   * Noise §5.1 `DecryptWithAd(ad, ciphertext)`; the identity function while
   * unkeyed. The primitive throws on authentication failure and `n` is
   * incremented only on success, exactly as Noise requires.
   */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const key = this.#k;
    if (key === undefined) return ciphertext;
    const nonce = e2eeNoiseCipherNonce(this.#n);
    const plaintext = chacha20poly1305(key, nonce, ad).decrypt(ciphertext);
    clean(nonce);
    this.#n += 1n;
    return plaintext;
  }

  /** §9.5 erasure: overwrite the key bytes with zeros before releasing them. */
  erase(): void {
    eraseBytes(this.#k);
    this.#k = undefined;
    this.#n = 0n;
  }
}

// ─── Noise §5.2 SymmetricState ───────────────────────────────────────────────

/** Noise §5.2. */
class NoiseSymmetricState {
  #ck: Uint8Array;
  #h: Uint8Array;
  readonly #cipher = new NoiseCipherState();

  /**
   * Noise §5.2 `InitializeSymmetric(protocol_name)`: a name of at most HASHLEN
   * bytes is zero-padded to HASHLEN, a longer one is hashed. Both §3.4 protocol
   * names are exactly 32 bytes, so the padding branch is the reachable one and
   * `h` starts as their ASCII bytes; the hashing branch is kept because Noise
   * defines it and a revision that renames the suite would need it.
   */
  constructor(protocolName: string) {
    const name = utf8ToBytes(protocolName);
    const h = new Uint8Array(HASH_LEN);
    if (name.byteLength <= HASH_LEN) h.set(name);
    else h.set(sha256(name));
    this.#h = h;
    this.#ck = Uint8Array.from(h);
  }

  get hasKey(): boolean {
    return this.#cipher.hasKey;
  }

  /** Noise §5.2 `h`, copied out. See `E2eeNoiseHandshake.testOnlyHandshakeHash`. */
  get handshakeHash(): Uint8Array {
    return Uint8Array.from(this.#h);
  }

  /** Noise §5.2 `MixKey(input_key_material)`. */
  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, temporaryKey] = noiseHkdf2(this.#ck, inputKeyMaterial);
    try {
      eraseBytes(this.#ck);
      this.#ck = chainingKey;
      this.#cipher.initializeKey(temporaryKey);
    } catch (error) {
      // The chaining key is this object's from the assignment above and `erase`
      // will find it; the cipher key is nobody's until `initializeKey` takes it,
      // and its length check is the one statement here that can refuse.
      eraseBytes(temporaryKey);
      throw error;
    }
  }

  /** Noise §5.2 `MixHash(data)`. */
  mixHash(data: Uint8Array): void {
    const next = sha256(concatBytes(this.#h, data));
    eraseBytes(this.#h);
    this.#h = next;
  }

  /** Noise §5.2 `EncryptAndHash(plaintext)`. */
  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher.encryptWithAd(this.#h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  /** Noise §5.2 `DecryptAndHash(ciphertext)`. */
  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher.decryptWithAd(this.#h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /**
   * Noise §5.2 `Split()` together with the §6.5 exporter, in one operation
   * because §6.5 defines exactly three extractable values and this is where all
   * three exist. `Split()` derives them from the final chaining key, so the
   * exporter is taken from the same `ck` in the same step, and the whole
   * symmetric state is erased before returning (§6.5, §9.5).
   *
   * Noise's `Split()` returns two `CipherState`s; §6.5 consumes the two keys as
   * the directional epoch-0 secrets of §9 instead, so the keys are returned raw
   * and no transport cipher state is ever constructed.
   */
  splitAndExport(): E2eeNoiseSessionKeys {
    const [first, second] = noiseHkdf2(this.#ck, EMPTY_BYTES);
    // The two `Split()` outputs are live and owned by nobody until this returns
    // them, and both the exporter derivation and the erasure below can still
    // fail, so they run inside the §9.5 funnel: either the caller receives all
    // three values or all three are zeroed.
    let exporterSecret: Uint8Array | undefined;
    try {
      exporterSecret = e2eeNoiseExporterSecret(this.#ck);
      this.erase();
      return { epochSecretC2N: first, epochSecretN2C: second, exporterSecret };
    } catch (error) {
      eraseBytes(first, second, exporterSecret);
      throw error;
    }
  }

  /** §9.5 erasure of the chaining key, the handshake hash, and the cipher state. */
  erase(): void {
    eraseBytes(this.#ck, this.#h);
    this.#cipher.erase();
  }
}

// ─── Noise §7 message patterns ───────────────────────────────────────────────

type NoiseToken = "e" | "s" | "ee" | "es" | "se" | "ss";

/**
 * The §3.4 patterns, verbatim from the Noise §7.5 pattern definitions, and the
 * only two this module admits:
 *
 * ```text
 * IK:                      NX:
 *   <- s                     -> e
 *   ...                      <- e, ee, s, es
 *   -> e, es, s, ss
 *   <- e, ee, se
 * ```
 *
 * IK's pre-message `<- s` is the node agreement prekey the client already holds
 * from the advertisement (§5.1, §6.4); NX has no pre-message, which is exactly
 * why the web tier authenticates no client (§8.10).
 */
const MESSAGE_PATTERNS: Readonly<Record<E2eeNoisePattern, readonly (readonly NoiseToken[])[]>> = {
  [E2EE_NOISE_PATTERN_IK]: [
    ["e", "es", "s", "ss"],
    ["e", "ee", "se"],
  ],
  [E2EE_NOISE_PATTERN_NX]: [["e"], ["e", "ee", "s", "es"]],
};

// ─── the handshake ───────────────────────────────────────────────────────────

/** §8.1: the client is always the initiator and the node always the responder. */
export type E2eeNoiseRole = "initiator" | "responder";

export type E2eeNoiseHandshakeStatus =
  /** This party owes the next handshake message. */
  | "awaiting_write"
  /** This party is waiting for the peer's next handshake message. */
  | "awaiting_read"
  /** Both messages are done; `split()` is the only remaining operation. */
  | "awaiting_split"
  /** `split()` returned; the handshake state is erased and the object is spent. */
  | "complete"
  /** A failure or an explicit `destroy()` erased the state; the object is spent. */
  | "destroyed";

/** The §6.5 outputs — the complete set of values extractable from a finished handshake. */
export interface E2eeNoiseSessionKeys {
  /**
   * `k_c2n`, the FIRST `Split()` output in Noise order (initiator to responder),
   * consumed as `epochSecret_c2n[0]` (§6.5, §9). The client is always the
   * initiator (§8.1), so Noise order and direction order coincide.
   */
  readonly epochSecretC2N: Uint8Array;
  /** `k_n2c`, the second `Split()` output, consumed as `epochSecret_n2c[0]` (§6.5, §9). */
  readonly epochSecretN2C: Uint8Array;
  /** `HKDF-Expand(ck_final, "ryco.relay-e2ee.exporter.v1", E2EE_SECRET_BYTES)`; feeds only §8.7. */
  readonly exporterSecret: Uint8Array;
}

export interface E2eeNoiseHandshakeOptions {
  /** The pattern the tier runs (§8.1): `"IK"` for native, `"NX"` for web. */
  readonly pattern: E2eeNoisePattern;
  readonly role: E2eeNoiseRole;
  /** The §8.4 prologue bytes, mixed before any pre-message key. */
  readonly prologue: Uint8Array;
  /**
   * This party's static agreement secret key. Required for both IK roles and for
   * the NX responder; FORBIDDEN for the NX initiator, which has no static at all
   * (§8.1). The public key is derived here rather than accepted, so a mismatched
   * pair cannot be supplied. The caller keeps its buffer; this module copies and
   * erases its copy.
   */
  readonly staticSecretKey?: Uint8Array | undefined;
  /**
   * The responder's static agreement public key. Required for — and permitted
   * only to — the IK initiator, which is the party that already holds the
   * advertised node agreement prekey (§5.1, §6.4, §8.1).
   */
  readonly remoteStaticPublicKey?: Uint8Array | undefined;
  /**
   * TEST AND FIXTURE-GENERATOR USE ONLY: the ephemeral secret key this handshake
   * will use instead of a fresh CSPRNG one. §16.1 requires the corpus generator
   * to inject ephemerals deterministically, and §16.1 marks all such material
   * test-only; production callers MUST omit this so that generation goes through
   * the §14.5 CSPRNG. The handshake TAKES OWNERSHIP of the buffer and erases it
   * with the rest of the state.
   */
  readonly testOnlyEphemeralSecretKey?: Uint8Array | undefined;
}

interface NoiseKeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/**
 * One Noise handshake, for one channel, in one direction of use. §8.1 allows
 * exactly one handshake attempt per channel and §6.5 destroys the session with
 * the channel, so this object is SINGLE-USE: after `split()`, `destroy()`, or
 * any failure, every operation throws `handshake_consumed`.
 *
 * The two patterns are two messages long, so the sequence is fixed: the
 * initiator writes message 1 and reads message 2, the responder reads message 1
 * and writes message 2, and both then call `split()`. Any other order is
 * rejected as `out_of_sequence`. Those rejections are pure precondition checks
 * that touch no state and therefore do NOT destroy a live handshake; every
 * failure raised while PROCESSING a message does, because a partially applied
 * message leaves a symmetric state no conforming peer can still agree with.
 */
export class E2eeNoiseHandshake {
  readonly #role: E2eeNoiseRole;
  readonly #messages: readonly (readonly NoiseToken[])[];
  readonly #symmetric: NoiseSymmetricState;
  #s: NoiseKeyPair | undefined;
  #e: NoiseKeyPair | undefined;
  #rs: Uint8Array | undefined;
  #re: Uint8Array | undefined;
  #localEphemeralPublicKey: Uint8Array | undefined;
  #pendingEphemeralSecretKey: Uint8Array | undefined;
  #messageIndex = 0;
  #status: E2eeNoiseHandshakeStatus;

  /**
   * Noise §5.3 `Initialize(handshake_pattern, initiator, prologue, s, e, rs,
   * re)`: derive the protocol name from the pattern, initialize the symmetric
   * state, mix the prologue, then mix the pre-message public keys in Noise §7
   * order — for IK that is the responder's static, hashed by both parties.
   *
   * ACQUIRE LAST (§9.5; the ownership rule is stated in `relayE2eeSession.ts`).
   * Everything that can fail runs BEFORE the first byte of key material is
   * acquired: the option shape, the §8.1 role matrix, both key lengths, the
   * remote static's copy, the symmetric state, the §8.4 prologue mix, the
   * public-key derivation, and the IK pre-message mix. The acquisitions are the
   * last statements in the body, and the only one of them that can fail — the
   * copy — leaves nothing behind when it does.
   *
   * A CONSTRUCTOR THAT FAILS THEREFORE OWNS NOTHING: it has not copied the
   * caller's static secret and it has not adopted `testOnlyEphemeralSecretKey`,
   * so both buffers are untouched and remain the caller's to reuse or erase.
   * There is no half-built handshake holding key material that no `destroy()`
   * will ever reach — which is what the erasure funnel that used to sit here
   * could not promise, because the symmetric state, the prologue, and the
   * pre-message all ran after it had closed.
   */
  constructor(options: E2eeNoiseHandshakeOptions) {
    const pattern = options.pattern;
    if (pattern !== E2EE_NOISE_PATTERN_IK && pattern !== E2EE_NOISE_PATTERN_NX) {
      noiseFailure("invalid_options");
    }
    const role = options.role;
    if (role !== "initiator" && role !== "responder") noiseFailure("invalid_options");
    if (!(options.prologue instanceof Uint8Array)) noiseFailure("invalid_options");

    // §8.1's role/tier matrix, stated as a shape rather than as a runtime check
    // at each use: IK authenticates both statics, NX authenticates only the
    // node's, and the IK initiator is the only party that knows its peer's
    // static in advance.
    const requiresStatic = pattern === E2EE_NOISE_PATTERN_IK || role === "responder";
    const requiresRemoteStatic = pattern === E2EE_NOISE_PATTERN_IK && role === "initiator";
    if (requiresStatic !== (options.staticSecretKey !== undefined)) noiseFailure("invalid_options");
    if (requiresRemoteStatic !== (options.remoteStaticPublicKey !== undefined)) {
      noiseFailure("invalid_options");
    }

    // Lengths are CHECKED here and nothing is taken: the caller's two secret
    // buffers are read no earlier than the pre-message mix that needs one of
    // them, and copied no earlier than the acquisition at the end.
    const staticSecretKey = options.staticSecretKey;
    if (staticSecretKey !== undefined) requireExactBytes(staticSecretKey, DH_LEN);
    const injectedEphemeralSecretKey = options.testOnlyEphemeralSecretKey;
    if (injectedEphemeralSecretKey !== undefined) {
      requireExactBytes(injectedEphemeralSecretKey, DH_LEN);
    }
    const remoteStaticPublicKey =
      options.remoteStaticPublicKey === undefined
        ? undefined
        : copyExactBytes(options.remoteStaticPublicKey, DH_LEN);

    this.#role = role;
    this.#messages = MESSAGE_PATTERNS[pattern];
    this.#rs = remoteStaticPublicKey;
    const symmetric = new NoiseSymmetricState(e2eeNoiseProtocolName(pattern));
    symmetric.mixHash(options.prologue);
    // Deriving the public key READS the caller's secret and takes nothing: the
    // output is public, and the copy this object owns is made further down. A
    // caller that mutates its own buffer between the two gets a key pair that
    // disagrees with itself and a handshake its peer rejects — never a leaked
    // copy.
    const staticPublicKey =
      staticSecretKey === undefined ? undefined : e2eeX25519PublicKey(staticSecretKey);
    if (pattern === E2EE_NOISE_PATTERN_IK) {
      // Noise §5.3: one MixHash per pre-message public key. IK's only
      // pre-message is `<- s`, so both parties hash the responder's static. The
      // §8.1 matrix above makes exactly one of the two defined for each role.
      symmetric.mixHash(role === "initiator" ? remoteStaticPublicKey! : staticPublicKey!);
    }
    this.#symmetric = symmetric;

    // THE ACQUISITION, and the end of the constructor. The copy is the only
    // statement below that can fail, and a failure leaves it unmade rather than
    // unowned; the ephemeral's adoption and the status are plain assignments.
    if (staticSecretKey !== undefined) {
      this.#s = { secretKey: Uint8Array.from(staticSecretKey), publicKey: staticPublicKey! };
    }
    this.#pendingEphemeralSecretKey = injectedEphemeralSecretKey;
    this.#status = role === "initiator" ? "awaiting_write" : "awaiting_read";
  }

  get status(): E2eeNoiseHandshakeStatus {
    return this.#status;
  }

  /**
   * The peer's static agreement public key once the pattern has transmitted it —
   * the IK responder learns it from message 1, the NX initiator from message 2 —
   * and `undefined` before that, and on the NX responder, whose peer has none.
   *
   * PUBLIC MATERIAL, not a derived secret: §6.5's rule that nothing but the
   * three session values may be extracted is about the key schedule. §8.6 step 5
   * requires the node to compare this against the client certificate's
   * `agreementPublicKey`, and §8.7 requires the NX client to compare it against
   * the advertised prekey certificate, so both comparisons need it by name. It
   * survives `split()` because those checks are the caller's, not this module's.
   */
  get remoteStaticPublicKey(): Uint8Array | undefined {
    return this.#rs === undefined ? undefined : Uint8Array.from(this.#rs);
  }

  /**
   * The peer's EPHEMERAL public key once the pattern has transmitted it — both
   * roles learn it from the message the other party writes first — and
   * `undefined` before that.
   *
   * PUBLIC MATERIAL, on exactly the footing `remoteStaticPublicKey` is on, and
   * it survives `split()` for the same reason: the consumer is the caller's, not
   * this module's. §13.5 derives the `WebSAS` over the WEB CLIENT'S Noise
   * ephemeral, so the node — the NX responder, whose peer has no static at all —
   * can reach that value through nothing else. It is not a session value and no
   * key schedule reads it; §6.5's rule about what may be extracted is about the
   * three derived secrets, and this is neither derived nor secret.
   */
  get remoteEphemeralPublicKey(): Uint8Array | undefined {
    return this.#re === undefined ? undefined : Uint8Array.from(this.#re);
  }

  /**
   * THIS PARTY'S OWN ephemeral public key, on the INITIATOR alone, once message
   * 1 has transmitted it — and `undefined` before that, and on the responder.
   *
   * PUBLIC MATERIAL, on exactly the footing the two accessors above are on: the
   * public component is retained past `#eraseSecrets` while the SECRET is zeroed
   * there with every other private byte, so §6.2's "ephemeral private keys MUST
   * be erased when `Split()` completes" and §6.5/§9.5 are untouched. Nothing
   * derived is retained; a public key is not a session value and no key schedule
   * reads it back.
   *
   * IT EXISTS FOR ONE CALLER, AND ONLY ON ONE TIER. §13.5's `WebSAS` is defined
   * over the WEB CLIENT'S Noise ephemeral, and the node reaches that value
   * through `remoteEphemeralPublicKey`; the client is the initiator in both
   * patterns (§8.1), so this is the mirror the client half needs to render the
   * same string. The responder is excluded rather than merely unused: nothing in
   * this protocol displays the NODE'S ephemeral, so retaining it would be a
   * surface with no consumer.
   */
  get localEphemeralPublicKey(): Uint8Array | undefined {
    return this.#localEphemeralPublicKey === undefined
      ? undefined
      : Uint8Array.from(this.#localEphemeralPublicKey);
  }

  /**
   * TEST AND FIXTURE USE ONLY: Noise §5.2 `h`, the handshake hash of the LIVE
   * handshake, or `undefined` once `split()` or `destroy()` has erased it.
   *
   * NOT part of the §6.5 supported API and NOT a session value. §6.5 fixes the
   * three extractable values and requires the handshake hash to be erased rather
   * than used, and nothing in this protocol consumes `h`: no key, no transcript,
   * and no binding derives from it — §8.7 and §8.8 hash exact wire bytes
   * instead. Production callers MUST NOT read this, exactly as they MUST NOT set
   * `testOnlyEphemeralSecretKey`.
   *
   * It exists for one reason. §14.1 makes the official cacophony and snow vector
   * sets a MUST for this module, those vector sets publish a `handshake_hash`
   * per vector, and `h` is unobservable through every other surface here — the
   * `Split()` outputs and the §6.5 exporter all derive from `ck`, not from `h`.
   * Without this accessor the §16.3 F15 obligation could not be discharged for
   * that field, and `relayE2eeNoise.test.ts` would have to silently drop it.
   *
   * THE ERASED ANSWER IS READ FROM `h` ITSELF, NOT FROM `#status`. `split()` and
   * `destroy()` both zero the symmetric state in place (§6.5, §9.5), so the
   * all-zero buffer IS the erasure and this accessor reports exactly that. A
   * status check here would have been cheaper and strictly weaker: it would make
   * the `undefined` both suites assert witness a state transition rather than
   * the §6.5 rule, and an implementation that stopped erasing the symmetric
   * state would keep returning `undefined` with `h` and `ck` still live. A live
   * `h` is a SHA-256 output and is never all-zero in practice.
   */
  get testOnlyHandshakeHash(): Uint8Array | undefined {
    const hash = this.#symmetric.handshakeHash;
    if (hash.every((byte) => byte === 0)) return undefined;
    return hash;
  }

  /**
   * Noise §5.3 `WriteMessage(payload, message_buffer)` for the message this
   * party owes, returning the complete Noise message.
   *
   * The payload is encrypted under whatever keys the pattern has established at
   * that point — for NX message 1 that is none, and the payload travels in the
   * clear (§8.5, §8.10), which is why §8.5 requires it to be empty and why this
   * module leaves that requirement to the caller.
   */
  writeMessage(payload: Uint8Array): Uint8Array {
    this.#requireTurn("awaiting_write");
    if (!(payload instanceof Uint8Array)) noiseFailure("invalid_options");
    try {
      const parts: Uint8Array[] = [];
      for (const token of this.#messages[this.#messageIndex]!) {
        switch (token) {
          case "e": {
            const ephemeral = this.#generateEphemeral();
            this.#e = ephemeral;
            // §13.5's initiator half: the PUBLIC component only, retained past
            // the erasure funnel because the display duty that reads it outlives
            // the handshake. See `localEphemeralPublicKey`.
            if (this.#role === "initiator") {
              this.#localEphemeralPublicKey = Uint8Array.from(ephemeral.publicKey);
            }
            parts.push(ephemeral.publicKey);
            this.#symmetric.mixHash(ephemeral.publicKey);
            break;
          }
          case "s": {
            if (this.#s === undefined) noiseFailure("out_of_sequence");
            parts.push(this.#symmetric.encryptAndHash(this.#s.publicKey));
            break;
          }
          default:
            this.#mixDh(token);
        }
      }
      parts.push(this.#symmetric.encryptAndHash(payload));
      const message = concatBytes(...parts);
      if (message.byteLength > MAX_MESSAGE_BYTES) noiseFailure("message_too_large");
      this.#advance();
      return message;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * Noise §5.3 `ReadMessage(message, payload_buffer)` for the message this party
   * is owed, returning the decrypted payload.
   *
   * Every failure here is a handshake abort (§8.6 step 4): a length the pattern
   * does not admit, an AEAD authentication failure, and the §8.1 all-zero
   * X25519 output alike. The primitives' errors propagate unchanged (§14.3).
   */
  readMessage(message: Uint8Array): Uint8Array {
    this.#requireTurn("awaiting_read");
    if (!(message instanceof Uint8Array)) noiseFailure("invalid_options");
    try {
      // Inside the abort scope, unlike the turn check above: a message that
      // violates the pattern is peer input, and every peer-input failure ends
      // the handshake (§8.6 step 4).
      if (message.byteLength > MAX_MESSAGE_BYTES) noiseFailure("message_too_large");
      let offset = 0;
      const take = (length: number): Uint8Array => {
        if (offset + length > message.byteLength) noiseFailure("malformed_message");
        const chunk = message.subarray(offset, offset + length);
        offset += length;
        return chunk;
      };
      for (const token of this.#messages[this.#messageIndex]!) {
        switch (token) {
          case "e": {
            const remoteEphemeral = Uint8Array.from(take(DH_LEN));
            this.#re = remoteEphemeral;
            this.#symmetric.mixHash(remoteEphemeral);
            break;
          }
          case "s": {
            const encrypted = take(this.#symmetric.hasKey ? DH_LEN + TAG_LEN : DH_LEN);
            const remoteStatic = this.#symmetric.decryptAndHash(encrypted);
            if (remoteStatic.byteLength !== DH_LEN) noiseFailure("malformed_message");
            this.#rs = remoteStatic;
            break;
          }
          default:
            this.#mixDh(token);
        }
      }
      const payload = this.#symmetric.decryptAndHash(message.subarray(offset));
      this.#advance();
      return payload;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * Noise §5.2 `Split()` plus the §6.5 exporter: the three values a completed
   * handshake yields, and the only ones. Callable exactly once, only after both
   * messages, and it erases the entire handshake state before returning —
   * ephemeral secret, static copy, chaining key, handshake hash, and cipher
   * state (§6.5, §9.5). The returned buffers belong to the caller, which MUST
   * erase them on close (§9.5).
   */
  split(): E2eeNoiseSessionKeys {
    this.#requireTurn("awaiting_split");
    // The §6.5 outputs are live from `splitAndExport` and belong to the caller
    // only once this returns them, so the funnel that spends the object on a
    // failure erases them too: `destroy()` reaches this object's own key
    // material and nothing else.
    let keys: E2eeNoiseSessionKeys | undefined;
    try {
      keys = this.#symmetric.splitAndExport();
      this.#eraseSecrets();
      this.#status = "complete";
      return keys;
    } catch (error) {
      if (keys !== undefined) {
        eraseBytes(keys.epochSecretC2N, keys.epochSecretN2C, keys.exporterSecret);
      }
      this.destroy();
      throw error;
    }
  }

  /**
   * Erase the handshake state and spend the object, for the abort paths: any
   * FATAL-PRE condition the caller detects, a channel close during negotiation,
   * or a §8.9 deadline. Idempotent, and never reached from `complete` — a
   * completed handshake has already erased everything `split()` did not return.
   */
  destroy(): void {
    if (this.#status === "complete" || this.#status === "destroyed") return;
    this.#symmetric.erase();
    this.#eraseSecrets();
    this.#status = "destroyed";
  }

  #requireTurn(expected: E2eeNoiseHandshakeStatus): void {
    if (this.#status === "complete" || this.#status === "destroyed") {
      noiseFailure("handshake_consumed");
    }
    if (this.#status !== expected) noiseFailure("out_of_sequence");
  }

  #advance(): void {
    this.#messageIndex += 1;
    if (this.#messageIndex >= this.#messages.length) {
      this.#status = "awaiting_split";
      return;
    }
    this.#status = this.#status === "awaiting_write" ? "awaiting_read" : "awaiting_write";
  }

  /**
   * Noise §5.3 `e`: a fresh ephemeral key pair, or the injected test-only secret
   * key. The public key is always derived from the secret key, so an injected
   * pair cannot disagree with itself.
   */
  #generateEphemeral(): NoiseKeyPair {
    const injected = this.#pendingEphemeralSecretKey;
    if (injected !== undefined) {
      // The derivation precedes the hand-off: clearing the pending slot first
      // would put the injected secret beyond the reach of `#eraseSecrets` while
      // a statement that can still fail runs, and the caller of this method
      // assigns the pair to `#e` with nothing fallible in between.
      const publicKey = e2eeX25519PublicKey(injected);
      this.#pendingEphemeralSecretKey = undefined;
      return { secretKey: injected, publicKey };
    }
    // §14.5: the CSPRNG is the primitive's, and it fails closed when the runtime
    // has no `crypto.getRandomValues` rather than falling back to anything.
    const keyPair = e2eeX25519KeyPair();
    return { secretKey: keyPair.secretKey, publicKey: keyPair.publicKey };
  }

  /**
   * Noise §5.3 DH tokens, resolved against THIS party's role — the same rule the
   * Noise specification states, where "if initiator" means the local party:
   * `ee` is `DH(e, re)`; `es` is `DH(e, rs)` for the initiator and `DH(s, re)`
   * for the responder; `se` is the mirror of `es`; `ss` is `DH(s, rs)`.
   *
   * §8.1 and §14.3: an all-zero shared secret — the invalid and low-order input
   * case — MUST abort the handshake, and the pinned primitive signals it by
   * throwing. That throw is not caught here; it leaves this module unchanged,
   * with the handshake destroyed by the caller of this method.
   */
  #mixDh(token: "ee" | "es" | "se" | "ss"): void {
    const initiator = this.#role === "initiator";
    let local: NoiseKeyPair | undefined;
    let remote: Uint8Array | undefined;
    switch (token) {
      case "ee":
        local = this.#e;
        remote = this.#re;
        break;
      case "es":
        local = initiator ? this.#e : this.#s;
        remote = initiator ? this.#rs : this.#re;
        break;
      case "se":
        local = initiator ? this.#s : this.#e;
        remote = initiator ? this.#re : this.#rs;
        break;
      case "ss":
        local = this.#s;
        remote = this.#rs;
        break;
    }
    // Unreachable for the two patterns above, which never name a key the
    // preceding tokens have not established; it is a guard against a pattern
    // table edit, not a runtime condition.
    if (local === undefined || remote === undefined) noiseFailure("out_of_sequence");
    const sharedSecret = e2eeX25519SharedSecret(local.secretKey, remote);
    try {
      this.#symmetric.mixKey(sharedSecret);
    } finally {
      // §9.5: the DH output is key material and `mixKey` can fail — on the HKDF
      // itself, or on the cipher key it hands over — so the erasure is a
      // `finally` rather than a statement the failure path skips.
      eraseBytes(sharedSecret);
    }
  }

  /** §6.5, §9.5: zero the private key material this object holds. Total. */
  #eraseSecrets(): void {
    eraseBytes(this.#e?.secretKey, this.#s?.secretKey, this.#pendingEphemeralSecretKey);
    this.#e = undefined;
    this.#s = undefined;
    this.#pendingEphemeralSecretKey = undefined;
  }
}
