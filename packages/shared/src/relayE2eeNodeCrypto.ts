import * as NodeCrypto from "node:crypto";

import {
  e2eeNativePrimitives,
  installE2eeNativePrimitives,
  type E2eeNativeChaCha20Poly1305,
  type E2eeNativePrimitives,
} from "./relayE2eeKeys.ts";

// Native `node:crypto` implementations of the relay E2EE primitives for the
// node (server) and desktop processes — docs/relay-e2ee-protocol.md §14.7.
//
// NODE ONLY. This is the one E2EE module that imports a Node built-in, and no
// module that ships to a browser or to Hermes imports it: the server and the
// desktop main process build the provider here and hand it to
// `installE2eeNativePrimitives` in the dependency-free `relayE2eeKeys`.
//
// DETECTION IS BY KNOWN ANSWER, AT FIRST USE. Each primitive is enabled the
// first time it is asked for, and only if the runtime reproduces a published
// test vector exactly and rejects the matching forgery. The desktop backend
// runs on Electron's BoringSSL, which carries X25519, Ed25519 and P-256 but no
// ChaCha20-Poly1305 in `node:crypto`; Bun likewise. A primitive whose self-test
// throws or disagrees is simply absent, and `relayE2eeKeys` then runs the
// pinned primitive, exactly as it does on every runtime without a provider.
//
// THE PINNED PRIMITIVE STAYS THE AUTHORITY. The dispatch functions in
// `relayE2eeKeys` and `relayE2eeSession` use a native result only where §14.7
// proves it equal to the pinned primitive's and ask the pinned primitive about
// everything else, so nothing here decides a rejection.

/**
 * Record size at and above which the native AEAD runs. Below it the pinned
 * primitive is faster: a native call pays a fixed cipher-context cost (about
 * 7 µs on Node 24) that the pure-JS cipher only overtakes at about 2 KiB.
 */
export const E2EE_NODE_NATIVE_AEAD_MIN_BYTES = 2_048;

// DER prefixes of the RFC 8410 PKCS#8 and SPKI encodings of a raw 32-byte
// X25519 or Ed25519 key, so a raw key enters `node:crypto` without a JWK
// round trip.
const X25519_PKCS8_PREFIX = hex("302e020100300506032b656e04220420");
const X25519_SPKI_PREFIX = hex("302a300506032b656e032100");
const ED25519_SPKI_PREFIX = hex("302a300506032b6570032100");

const RAW_KEY_BYTES = 32;
const AEAD_TAG_BYTES = 16;
const P256_COORDINATE_BYTES = 32;

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function concat(prefix: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.byteLength + key.byteLength);
  out.set(prefix, 0);
  out.set(key, prefix.byteLength);
  return out;
}

/** A fresh, unpooled `Uint8Array` copy of a Node buffer. */
function ownedCopy(buffer: Uint8Array): Uint8Array {
  return Uint8Array.from(buffer);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

// ─── raw implementations ─────────────────────────────────────────────────────

function x25519PrivateKey(secretKey: Uint8Array): NodeCrypto.KeyObject {
  const der = concat(X25519_PKCS8_PREFIX, secretKey);
  try {
    return NodeCrypto.createPrivateKey({
      key: Buffer.from(der.buffer),
      format: "der",
      type: "pkcs8",
    });
  } finally {
    // §9.5: the DER copy carries the secret scalar.
    der.fill(0);
  }
}

function nativeX25519PublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.byteLength !== RAW_KEY_BYTES) throw new RangeError("X25519 secret length");
  const spki = NodeCrypto.createPublicKey(x25519PrivateKey(secretKey)).export({
    format: "der",
    type: "spki",
  });
  return ownedCopy(spki.subarray(spki.byteLength - RAW_KEY_BYTES));
}

function nativeX25519SharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (secretKey.byteLength !== RAW_KEY_BYTES || publicKey.byteLength !== RAW_KEY_BYTES) {
    throw new RangeError("X25519 key length");
  }
  const shared = NodeCrypto.diffieHellman({
    privateKey: x25519PrivateKey(secretKey),
    publicKey: NodeCrypto.createPublicKey({
      key: Buffer.from(concat(X25519_SPKI_PREFIX, publicKey).buffer),
      format: "der",
      type: "spki",
    }),
  });
  try {
    return ownedCopy(shared);
  } finally {
    shared.fill(0);
  }
}

function nativeEd25519Verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (publicKey.byteLength !== RAW_KEY_BYTES) return false;
  const key = NodeCrypto.createPublicKey({
    key: Buffer.from(concat(ED25519_SPKI_PREFIX, publicKey).buffer),
    format: "der",
    type: "spki",
  });
  return NodeCrypto.verify(null, message, key, signature);
}

function nativeP256Verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (publicKey.byteLength !== 1 + 2 * P256_COORDINATE_BYTES || publicKey[0] !== 0x04) {
    return false;
  }
  const coordinate = (offset: number): string =>
    Buffer.from(publicKey.subarray(offset, offset + P256_COORDINATE_BYTES)).toString("base64url");
  const key = NodeCrypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: coordinate(1), y: coordinate(1 + P256_COORDINATE_BYTES) },
    format: "jwk",
  });
  return NodeCrypto.verify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, signature);
}

const nativeChaCha20Poly1305: E2eeNativeChaCha20Poly1305 = {
  minBytes: E2EE_NODE_NATIVE_AEAD_MIN_BYTES,
  seal(key, nonce, plaintext, aad) {
    const cipher = NodeCrypto.createCipheriv("chacha20-poly1305", key, nonce, {
      authTagLength: AEAD_TAG_BYTES,
    });
    cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
    const body = cipher.update(plaintext);
    const tail = cipher.final();
    const tag = cipher.getAuthTag();
    if (tail.byteLength !== 0 || tag.byteLength !== AEAD_TAG_BYTES) {
      throw new Error("ChaCha20-Poly1305 produced an unexpected shape.");
    }
    const out = new Uint8Array(body.byteLength + AEAD_TAG_BYTES);
    out.set(body, 0);
    out.set(tag, body.byteLength);
    if (out.byteLength !== plaintext.byteLength + AEAD_TAG_BYTES) {
      throw new Error("ChaCha20-Poly1305 produced an unexpected length.");
    }
    return out;
  },
  open(key, nonce, ciphertext, aad) {
    if (ciphertext.byteLength < AEAD_TAG_BYTES) throw new Error("ciphertext too short");
    const bodyLength = ciphertext.byteLength - AEAD_TAG_BYTES;
    const decipher = NodeCrypto.createDecipheriv("chacha20-poly1305", key, nonce, {
      authTagLength: AEAD_TAG_BYTES,
    });
    decipher.setAuthTag(ciphertext.subarray(bodyLength));
    decipher.setAAD(aad, { plaintextLength: bodyLength });
    // `update` releases plaintext before `final` has checked the tag. It is
    // unauthenticated until then, so a failed `final` erases it before the
    // throw reaches the dispatcher (§9.5), and only a tag-checked buffer of
    // exactly the expected length is returned.
    const body = decipher.update(ciphertext.subarray(0, bodyLength));
    const plaintext = new Uint8Array(bodyLength);
    try {
      plaintext.set(body, 0);
      const tail = decipher.final();
      if (tail.byteLength !== 0 || body.byteLength !== bodyLength) {
        throw new Error("ChaCha20-Poly1305 produced an unexpected shape.");
      }
      return plaintext;
    } catch (error) {
      plaintext.fill(0);
      throw error;
    } finally {
      body.fill(0);
    }
  },
};

// ─── known-answer self-tests ─────────────────────────────────────────────────

/** RFC 7748 §6.1: Alice's and Bob's keys and their shared secret. */
const X25519_KAT = {
  alicePrivate: hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"),
  alicePublic: hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"),
  bobPublic: hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"),
  shared: hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"),
};

/** RFC 8032 §7.1 TEST 2: one-byte message `0x72`. */
const ED25519_KAT = {
  publicKey: hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
  message: hex("72"),
  signature: hex(
    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  ),
};

/** RFC 6979 §A.2.5: P-256, SHA-256, message "sample". */
const P256_KAT = {
  publicKey: hex(
    "0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299",
  ),
  message: Uint8Array.from(Buffer.from("sample", "utf8")),
  signature: hex(
    "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
  ),
};

/** RFC 8439 §2.8.2: the AEAD construction test vector. */
const CHACHA20_POLY1305_KAT = {
  key: hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f"),
  nonce: hex("070000004041424344454647"),
  aad: hex("50515253c0c1c2c3c4c5c6c7"),
  plaintext: Uint8Array.from(
    Buffer.from(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
      "utf8",
    ),
  ),
  sealed: hex(
    "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116" +
      "1ae10b594f09e26a7e902ecbd0600691",
  ),
};

function flipLastBit(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[copy.byteLength - 1]! ^= 0x01;
  return copy;
}

/**
 * The raw implementations a provider is built from. The `node:crypto` set is
 * the only production one; tests substitute broken sets to prove that a
 * failed self-test leaves the pinned primitive in charge.
 */
export interface E2eeNativeImplementations {
  readonly x25519PublicKey: (secretKey: Uint8Array) => Uint8Array;
  readonly x25519SharedSecret: (secretKey: Uint8Array, publicKey: Uint8Array) => Uint8Array;
  readonly ed25519Verify: (
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
  ) => boolean;
  readonly p256Verify: (
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
  ) => boolean;
  readonly chacha20Poly1305: E2eeNativeChaCha20Poly1305;
}

/** The `node:crypto` implementations, before any self-test. */
export const E2EE_NODE_NATIVE_IMPLEMENTATIONS: E2eeNativeImplementations = {
  x25519PublicKey: nativeX25519PublicKey,
  x25519SharedSecret: nativeX25519SharedSecret,
  ed25519Verify: nativeEd25519Verify,
  p256Verify: nativeP256Verify,
  chacha20Poly1305: nativeChaCha20Poly1305,
};

function selfTestX25519(native: E2eeNativeImplementations): boolean {
  return (
    bytesEqual(native.x25519PublicKey(X25519_KAT.alicePrivate), X25519_KAT.alicePublic) &&
    bytesEqual(
      native.x25519SharedSecret(X25519_KAT.alicePrivate, X25519_KAT.bobPublic),
      X25519_KAT.shared,
    )
  );
}

function selfTestSignature(
  verify: E2eeNativeImplementations["ed25519Verify"],
  vector: {
    readonly publicKey: Uint8Array;
    readonly message: Uint8Array;
    readonly signature: Uint8Array;
  },
): boolean {
  const { publicKey, message, signature } = vector;
  return (
    verify(signature, message, publicKey) === true &&
    verify(flipLastBit(signature), message, publicKey) === false &&
    verify(signature, flipLastBit(message), publicKey) === false
  );
}

function selfTestChaCha20Poly1305(native: E2eeNativeImplementations): boolean {
  const aead = native.chacha20Poly1305;
  const { key, nonce, aad, plaintext, sealed } = CHACHA20_POLY1305_KAT;
  if (!bytesEqual(aead.seal(key, nonce, plaintext, aad), sealed)) return false;
  if (!bytesEqual(aead.open(key, nonce, sealed, aad), plaintext)) return false;
  for (const forged of [
    () => aead.open(key, nonce, flipLastBit(sealed), aad),
    () => aead.open(key, nonce, sealed, flipLastBit(aad)),
  ]) {
    try {
      forged();
      return false;
    } catch {
      // A forgery must fail; that is the passing branch.
    }
  }
  return true;
}

/**
 * Run a self-test once and remember the verdict. Any throw is a failed test:
 * a runtime that lacks the algorithm reports it by throwing.
 */
function detected<T>(selfTest: () => boolean, implementation: T): () => T | undefined {
  let verdict: boolean | undefined;
  return () => {
    if (verdict === undefined) {
      try {
        verdict = selfTest() === true;
      } catch {
        verdict = false;
      }
    }
    return verdict ? implementation : undefined;
  };
}

/** Which native primitives this runtime passed the self-test for. */
export interface E2eeNodeNativeSupport {
  readonly x25519: boolean;
  readonly ed25519: boolean;
  readonly p256: boolean;
  readonly chacha20Poly1305: boolean;
}

export interface E2eeNodeNativePrimitives extends E2eeNativePrimitives {
  /** Runs every outstanding self-test and reports the verdicts. */
  readonly support: () => E2eeNodeNativeSupport;
}

/**
 * Build a provider. Each member is a getter that runs its primitive's
 * known-answer self-test on first read and resolves to `undefined` for good if
 * the test fails or throws, so the dispatchers fall back to the pinned
 * primitive silently.
 */
export function makeE2eeNodeNativePrimitives(
  native: E2eeNativeImplementations = E2EE_NODE_NATIVE_IMPLEMENTATIONS,
): E2eeNodeNativePrimitives {
  const x25519 = detected(() => selfTestX25519(native), true);
  const ed25519 = detected(
    () => selfTestSignature(native.ed25519Verify, ED25519_KAT),
    native.ed25519Verify,
  );
  const p256 = detected(() => selfTestSignature(native.p256Verify, P256_KAT), native.p256Verify);
  const chacha = detected(() => selfTestChaCha20Poly1305(native), native.chacha20Poly1305);
  return {
    get x25519PublicKey() {
      return x25519() === undefined ? undefined : native.x25519PublicKey;
    },
    get x25519SharedSecret() {
      return x25519() === undefined ? undefined : native.x25519SharedSecret;
    },
    get ed25519Verify() {
      return ed25519();
    },
    get p256Verify() {
      return p256();
    },
    get chacha20Poly1305() {
      return chacha();
    },
    support: () => ({
      x25519: x25519() !== undefined,
      ed25519: ed25519() !== undefined,
      p256: p256() !== undefined,
      chacha20Poly1305: chacha() !== undefined,
    }),
  };
}

/**
 * Install the `node:crypto` provider for this process, once. Called by the
 * server's Hub connector and the desktop main process's Hub stack; a second
 * call keeps the provider already installed. Cheap: no self-test runs until a
 * primitive is first used.
 */
export function installE2eeNodeNativePrimitives(): void {
  if (e2eeNativePrimitives() !== undefined) return;
  installE2eeNativePrimitives(makeE2eeNodeNativePrimitives());
}
