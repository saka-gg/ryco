/**
 * pushSeal - `ryco-push-seal-v1`, the sealed box a push alert travels in
 * (`docs/push-alerts.md`).
 *
 * The node seals each alert to one device's static X25519 push key; the Hub
 * carries the blob without being able to open it; the device's notification
 * extension opens it with the private key it keeps in the shared keychain. The
 * extension reimplements `open` in Swift (CryptoKit), so the construction is
 * deliberately small and pinned by the vectors in `pushSeal.vectors.json`:
 *
 * 1. a fresh ephemeral X25519 pair `(e, E)`, `dh = X25519(e, R)` for the
 *    device key `R` (an all-zero `dh` is refused);
 * 2. `HKDF-SHA256(ikm = dh, salt = E ‖ R, info = "ryco push seal v1")`, 44
 *    bytes: a 32-byte key, then a 12-byte nonce (each key seals exactly one
 *    message, so a derived nonce never repeats);
 * 3. ChaCha20-Poly1305 over the plaintext, with associated data that binds the
 *    blob to the cleartext routing the Hub sees (environment, sequence,
 *    enrollment), so the Hub can neither move it to another device nor replay
 *    it under another sequence;
 * 4. blob = `0x01 ‖ E ‖ ciphertext ‖ tag`.
 *
 * @module pushSeal
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { e2eeX25519KeyPair, e2eeX25519PublicKey, e2eeX25519SharedSecret } from "./relayE2eeKeys.ts";

export const PUSH_SEAL_VERSION = 0x01;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INFO = utf8ToBytes("ryco push seal v1");
/** Version byte, ephemeral public key and tag around the ciphertext. */
export const PUSH_SEAL_OVERHEAD_BYTES = 1 + KEY_BYTES + TAG_BYTES;
/** The bytes of a push key id and a collapse id before base64url (22 characters each). */
export const PUSH_ID_BYTES = 16;

/** What the blob is bound to; both ends build it from the APNs payload's cleartext. */
export function pushSealAssociatedData(input: {
  readonly environmentId: string;
  readonly sequence: number;
  readonly enrollmentId: string;
}): Uint8Array {
  return utf8ToBytes(
    `ryco-push-v1\n${input.environmentId}\n${String(input.sequence)}\n${input.enrollmentId}`,
  );
}

function deriveKeyAndNonce(
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
) {
  const okm = hkdf(
    sha256,
    sharedSecret,
    concatBytes(ephemeralPublicKey, recipientPublicKey),
    INFO,
    KEY_BYTES + NONCE_BYTES,
  );
  return { key: okm.subarray(0, KEY_BYTES), nonce: okm.subarray(KEY_BYTES) };
}

/**
 * Seals `plaintext` to `recipientPublicKey`. `ephemeralSecretKey` exists for
 * the test vectors only; everything else lets a fresh key be drawn.
 */
export function sealPushPayload(input: {
  readonly recipientPublicKey: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly associatedData: Uint8Array;
  readonly ephemeralSecretKey?: Uint8Array;
}): Uint8Array {
  if (input.recipientPublicKey.byteLength !== KEY_BYTES) {
    throw new Error("A push key is 32 bytes.");
  }
  const ephemeral =
    input.ephemeralSecretKey === undefined
      ? e2eeX25519KeyPair()
      : {
          secretKey: input.ephemeralSecretKey,
          publicKey: e2eeX25519PublicKey(input.ephemeralSecretKey),
        };
  // Throws on an all-zero result: a low-order recipient key is refused.
  const sharedSecret = e2eeX25519SharedSecret(ephemeral.secretKey, input.recipientPublicKey);
  const { key, nonce } = deriveKeyAndNonce(
    sharedSecret,
    ephemeral.publicKey,
    input.recipientPublicKey,
  );
  const sealed = chacha20poly1305(key, nonce, input.associatedData).encrypt(input.plaintext);
  sharedSecret.fill(0);
  key.fill(0);
  if (input.ephemeralSecretKey === undefined) ephemeral.secretKey.fill(0);
  return concatBytes(Uint8Array.of(PUSH_SEAL_VERSION), ephemeral.publicKey, sealed);
}

/** The plaintext, or null when the blob is not a v1 seal to this key with this binding. */
export function openPushPayload(input: {
  readonly recipientSecretKey: Uint8Array;
  readonly sealed: Uint8Array;
  readonly associatedData: Uint8Array;
}): Uint8Array | null {
  const { sealed } = input;
  if (sealed.byteLength < PUSH_SEAL_OVERHEAD_BYTES || sealed[0] !== PUSH_SEAL_VERSION) return null;
  const ephemeralPublicKey = sealed.subarray(1, 1 + KEY_BYTES);
  try {
    const recipientPublicKey = e2eeX25519PublicKey(input.recipientSecretKey);
    const sharedSecret = e2eeX25519SharedSecret(input.recipientSecretKey, ephemeralPublicKey);
    const { key, nonce } = deriveKeyAndNonce(sharedSecret, ephemeralPublicKey, recipientPublicKey);
    const plaintext = chacha20poly1305(key, nonce, input.associatedData).decrypt(
      sealed.subarray(1 + KEY_BYTES),
    );
    sharedSecret.fill(0);
    key.fill(0);
    return plaintext;
  } catch {
    return null;
  }
}

/** A push key's id: the first 16 bytes of SHA-256 over the public key. */
export function pushKeyIdBytes(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey).subarray(0, PUSH_ID_BYTES);
}

/**
 * The APNs collapse id for one thread on one device: HMAC-SHA256 under the
 * registration's own salt, so the Hub sees a stable id per (device, thread)
 * and learns only that two alerts share a thread.
 */
export function pushCollapseIdBytes(input: {
  readonly salt: Uint8Array;
  readonly environmentId: string;
  readonly threadId: string;
}): Uint8Array {
  return hmac(
    sha256,
    input.salt,
    utf8ToBytes(`${input.environmentId}\n${input.threadId}`),
  ).subarray(0, PUSH_ID_BYTES);
}
