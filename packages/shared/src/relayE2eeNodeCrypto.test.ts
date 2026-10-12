import { randomBytes } from "node:crypto";

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  E2EE_NODE_NATIVE_AEAD_MIN_BYTES,
  E2EE_NODE_NATIVE_IMPLEMENTATIONS,
  installE2eeNodeNativePrimitives,
  makeE2eeNodeNativePrimitives,
  type E2eeNativeImplementations,
} from "./relayE2eeNodeCrypto.ts";
import {
  E2EE_DIRECTION_CLIENT_TO_NODE,
  E2EE_DIRECTION_NODE_TO_CLIENT,
  E2EE_INNER_TYPE_RPC,
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  type E2eeDirection,
} from "./relayE2eeWire.ts";
import {
  e2eeNativePrimitives,
  e2eeX25519KeyPair,
  e2eeX25519PublicKey,
  e2eeX25519SharedSecret,
  installE2eeNativePrimitives,
  resetE2eeSignatureMemoForTests,
  verifyE2eeSignature,
  type E2eeNativePrimitives,
  type E2eeSignatureVerification,
} from "./relayE2eeKeys.ts";
import { E2eeRecordSession, e2eeSessionSecretsFromNoiseKeys } from "./relayE2eeSession.ts";

// §14.7: the native fast paths are admissible only if the dispatcher's answer
// is the pinned primitive's answer for every input — accept, reject, output
// bytes and error alike. Every test here computes the same operation twice,
// once with nothing installed (the pinned primitive alone) and once with the
// provider installed, and requires equality; the raw native result is
// recorded separately where the two DIFFER, because those are exactly the
// inputs the dispatcher's guards exist for.

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const bytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
const random = (length: number): Uint8Array => Uint8Array.from(randomBytes(length));

type Outcome = { readonly ok: string } | { readonly threw: string };

function outcome(run: () => unknown): Outcome {
  try {
    const value = run();
    return { ok: value instanceof Uint8Array ? hex(value) : String(value) };
  } catch (error) {
    return { threw: error instanceof Error ? `${error.constructor.name}: ${error.message}` : "?" };
  }
}

const provider = makeE2eeNodeNativePrimitives();

/** The operation with the pinned primitive alone, then through the provider. */
function pinnedAndDispatched(
  run: () => unknown,
  installed: E2eeNativePrimitives = provider,
): { pinned: Outcome; dispatched: Outcome } {
  installE2eeNativePrimitives(undefined);
  resetE2eeSignatureMemoForTests();
  const pinned = outcome(run);
  installE2eeNativePrimitives(installed);
  resetE2eeSignatureMemoForTests();
  const dispatched = outcome(run);
  return { pinned, dispatched };
}

function expectEquivalent(run: () => unknown, installed?: E2eeNativePrimitives): Outcome {
  const { pinned, dispatched } = pinnedAndDispatched(run, installed);
  expect(dispatched).toEqual(pinned);
  return pinned;
}

afterEach(() => {
  installE2eeNativePrimitives(undefined);
  resetE2eeSignatureMemoForTests();
});

describe("node:crypto self-tests", () => {
  it("passes every known-answer self-test on this Node runtime", () => {
    expect(makeE2eeNodeNativePrimitives().support()).toEqual({
      x25519: true,
      ed25519: true,
      p256: true,
      chacha20Poly1305: true,
    });
  });

  it("disables a primitive silently when its self-test throws or disagrees", () => {
    const broken: E2eeNativeImplementations = {
      x25519PublicKey: () => {
        throw new Error("Unknown curve");
      },
      x25519SharedSecret: E2EE_NODE_NATIVE_IMPLEMENTATIONS.x25519SharedSecret,
      // A verifier that accepts everything fails the forged-signature half.
      ed25519Verify: () => true,
      p256Verify: () => {
        throw new Error("Unsupported key type");
      },
      chacha20Poly1305: {
        minBytes: 0,
        seal: () => {
          throw new Error("Unknown cipher");
        },
        open: () => {
          throw new Error("Unknown cipher");
        },
      },
    };
    const disabled = makeE2eeNodeNativePrimitives(broken);
    expect(disabled.x25519PublicKey).toBeUndefined();
    expect(disabled.x25519SharedSecret).toBeUndefined();
    expect(disabled.ed25519Verify).toBeUndefined();
    expect(disabled.p256Verify).toBeUndefined();
    expect(disabled.chacha20Poly1305).toBeUndefined();
    expect(disabled.support()).toEqual({
      x25519: false,
      ed25519: false,
      p256: false,
      chacha20Poly1305: false,
    });

    // With every member disabled the dispatchers are the pinned primitives.
    const keyPair = x25519.keygen();
    const peer = x25519.keygen();
    installE2eeNativePrimitives(disabled);
    expect(hex(e2eeX25519PublicKey(keyPair.secretKey))).toBe(hex(keyPair.publicKey));
    expect(hex(e2eeX25519SharedSecret(keyPair.secretKey, peer.publicKey))).toBe(
      hex(x25519.getSharedSecret(keyPair.secretKey, peer.publicKey)),
    );
  });

  it("installs once and keeps the first provider", () => {
    installE2eeNativePrimitives(undefined);
    installE2eeNodeNativePrimitives();
    const first = e2eeNativePrimitives();
    expect(first).toBeDefined();
    installE2eeNodeNativePrimitives();
    expect(e2eeNativePrimitives()).toBe(first);
  });
});

// ─── X25519 ──────────────────────────────────────────────────────────────────

const P = 2n ** 255n - 19n;
const leBytes = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let rest = value;
  for (let index = 0; index < 32; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};
const withHighBit = (value: Uint8Array): Uint8Array => {
  const copy = Uint8Array.from(value);
  copy[31]! |= 0x80;
  return copy;
};

/** The five low-order u values on curve25519 and its twist (noble's blocklist). */
const LOW_ORDER_U = [
  0n,
  1n,
  P - 1n,
  325606250916557431795983626356110631294008115727848805560023387167927233504n,
  39382357235489614581723060781553021112529911719440698176882885853963445705823n,
];

describe("X25519 (§8.1, §14.3)", () => {
  it("matches the pinned primitive for random keys, including high-bit and non-canonical u", () => {
    for (let round = 0; round < 64; round += 1) {
      const secretKey = random(32);
      const publicKey = random(32);
      expectEquivalent(() => e2eeX25519PublicKey(secretKey));
      expectEquivalent(() => e2eeX25519SharedSecret(secretKey, publicKey));
      expectEquivalent(() => e2eeX25519SharedSecret(secretKey, withHighBit(publicKey)));
    }
    // Non-canonical encodings p ≤ u < 2^255 are reduced mod p by both.
    for (const u of [P, P + 1n, P + 2n, P + 9n, 2n ** 255n - 1n]) {
      const secretKey = random(32);
      const outcomeBoth = expectEquivalent(() => e2eeX25519SharedSecret(secretKey, leBytes(u)));
      if (u === P + 9n) expect("ok" in outcomeBoth).toBe(true);
    }
  });

  it("aborts with the pinned primitive's own error on every low-order input", () => {
    for (const u of LOW_ORDER_U) {
      // The canonical encoding, the same with the RFC 7748 masked bit set, and
      // the non-canonical u + p where that still fits in 255 bits.
      const encodings = [leBytes(u), withHighBit(leBytes(u))];
      if (u + P < 2n ** 255n) encodings.push(leBytes(u + P));
      for (const encoding of encodings) {
        const secretKey = random(32);
        expect(expectEquivalent(() => e2eeX25519SharedSecret(secretKey, encoding))).toEqual({
          threw: "Error: invalid private or public key received",
        });
      }
    }
  });

  it("re-runs the pinned primitive when native output is all zero, malformed, or throws", () => {
    const secretKey = random(32);
    const peer = x25519.keygen().publicKey;
    for (const native of [
      () => new Uint8Array(32),
      () => new Uint8Array(31).fill(1),
      () => {
        throw new Error("native failure");
      },
      () => "not bytes" as unknown as Uint8Array,
    ]) {
      const installed: E2eeNativePrimitives = {
        x25519SharedSecret: native,
        x25519PublicKey: native,
      };
      expectEquivalent(() => e2eeX25519SharedSecret(secretKey, peer), installed);
      expectEquivalent(() => e2eeX25519PublicKey(secretKey), installed);
      expectEquivalent(() => e2eeX25519SharedSecret(secretKey, new Uint8Array(32)), installed);
    }
  });

  it("generates key pairs whose public half is the pinned derivation", () => {
    installE2eeNativePrimitives(provider);
    for (let round = 0; round < 16; round += 1) {
      const pair = e2eeX25519KeyPair();
      expect(hex(pair.publicKey)).toBe(hex(x25519.getPublicKey(pair.secretKey)));
    }
  });

  it("rejects wrong-length inputs exactly as the pinned primitive does", () => {
    expectEquivalent(() => e2eeX25519PublicKey(random(31)));
    expectEquivalent(() => e2eeX25519SharedSecret(random(32), random(33)));
  });
});

// ─── Ed25519 ─────────────────────────────────────────────────────────────────

const ED_L = ed25519.Point.Fn.ORDER;
const Point = ed25519.Point;

function leToBigInt(value: Uint8Array): bigint {
  let out = 0n;
  for (let index = value.byteLength - 1; index >= 0; index -= 1) {
    out = (out << 8n) | BigInt(value[index]!);
  }
  return out;
}

function scalarBytes(value: bigint): Uint8Array {
  return leBytes(value);
}

/** An order-8 torsion point (the canonical encoding of Wycheproof's / RFC 8032 small-order set). */
const TORSION_8 = Point.fromBytes(
  bytes("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"),
);

/**
 * Sign so that the cofactored equation holds but the cofactorless one does
 * not: `R = [r]B + T` for a torsion `T`, `S = r + k·a`. Strict cofactored
 * verification (the pinned primitive) accepts; cofactorless verifiers
 * (OpenSSL, BoringSSL) reject. The §14.7 rule that a native `false` is never
 * final exists for exactly these inputs.
 */
function torsionSignature(message: Uint8Array): {
  publicKey: Uint8Array;
  signature: Uint8Array;
} {
  const seed = random(32);
  const { scalar, point } = ed25519.utils.getExtendedPublicKey(seed);
  const publicKey = point.toBytes();
  for (;;) {
    const r = leToBigInt(random(64)) % ED_L;
    const R = Point.BASE.multiply(r === 0n ? 1n : r).add(TORSION_8);
    const encodedR = R.toBytes();
    const k = leToBigInt(sha512(new Uint8Array([...encodedR, ...publicKey, ...message]))) % ED_L;
    // A torsion component that k annihilates gives an ordinary signature; retry.
    if (TORSION_8.multiplyUnsafe(k % 8n === 0n ? 8n : k % 8n).is0()) continue;
    const s = ((r === 0n ? 1n : r) + k * scalar) % ED_L;
    return { publicKey, signature: new Uint8Array([...encodedR, ...scalarBytes(s)]) };
  }
}

const verifyNode = (input: Omit<E2eeSignatureVerification, "algorithm">) => () =>
  verifyE2eeSignature({ algorithm: "ed25519", ...input });

describe("Ed25519 strict verification (§7.1, §14.3)", () => {
  it("matches the pinned verdict on random valid and mutated signatures", () => {
    for (let round = 0; round < 48; round += 1) {
      const { secretKey, publicKey } = ed25519.keygen();
      const message = random(round * 7);
      const signature = ed25519.sign(message, secretKey);
      expect(expectEquivalent(verifyNode({ publicKey, message, signature }))).toEqual({
        ok: "true",
      });
      const flipped = Uint8Array.from(signature);
      flipped[round % 64]! ^= 1 << (round % 8);
      expectEquivalent(verifyNode({ publicKey, message, signature: flipped }));
      expectEquivalent(verifyNode({ publicKey, message: random(round + 1), signature }));
    }
  });

  it("rejects the malleable S + L encoding, as the pinned primitive does", () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const message = random(40);
    const signature = ed25519.sign(message, secretKey);
    const s = leToBigInt(signature.subarray(32));
    for (const shifted of [s + ED_L, s + 2n * ED_L, ED_L, ED_L + 1n]) {
      if (shifted >= 2n ** 256n) continue;
      const malleated = new Uint8Array([...signature.subarray(0, 32), ...scalarBytes(shifted)]);
      expect(expectEquivalent(verifyNode({ publicKey, message, signature: malleated }))).toEqual({
        ok: "false",
      });
    }
  });

  it("accepts torsion-carrying signatures exactly when the pinned cofactored check does", () => {
    let nativeDisagreed = 0;
    for (let round = 0; round < 8; round += 1) {
      const message = random(24);
      const { publicKey, signature } = torsionSignature(message);
      expect(expectEquivalent(verifyNode({ publicKey, message, signature }))).toEqual({
        ok: "true",
      });
      if (!E2EE_NODE_NATIVE_IMPLEMENTATIONS.ed25519Verify(signature, message, publicKey)) {
        nativeDisagreed += 1;
      }
    }
    // The raw native verifier is cofactorless: it rejects these, and only the
    // fallback keeps the accepted set the pinned one.
    expect(nativeDisagreed).toBe(8);
  });

  it("rejects small-order public keys and non-canonical encodings even if native says true", () => {
    const acceptEverything: E2eeNativePrimitives = { ed25519Verify: () => true };
    const message = random(32);
    const { secretKey, publicKey } = ed25519.keygen();
    const signature = ed25519.sign(message, secretKey);
    // y ≥ p encodings of the public key and of R (the identity as y = p + 1).
    const nonCanonicalIdentity = leBytes(P + 1n);
    const yAtPrime = leBytes(P);
    const cases: Array<{ publicKey: Uint8Array; signature: Uint8Array }> = [
      // Small-order A: the identity and an order-8 point.
      { publicKey: Point.ZERO.toBytes(), signature },
      { publicKey: TORSION_8.toBytes(), signature },
      { publicKey: nonCanonicalIdentity, signature },
      { publicKey: yAtPrime, signature },
      // Non-canonical R.
      {
        publicKey,
        signature: new Uint8Array([...nonCanonicalIdentity, ...signature.subarray(32)]),
      },
      // x = 0 with the sign bit set (the -0 encoding of the identity's y = 1).
      {
        publicKey,
        signature: new Uint8Array([...withHighBit(leBytes(1n)), ...signature.subarray(32)]),
      },
      // S ≥ L.
      {
        publicKey,
        signature: new Uint8Array([...signature.subarray(0, 32), ...scalarBytes(ED_L)]),
      },
    ];
    for (const input of cases) {
      expect(expectEquivalent(verifyNode({ message, ...input }), acceptEverything)).toEqual({
        ok: "false",
      });
    }
  });

  it("keeps the verdict when native verification throws or returns a non-boolean", () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const message = random(32);
    const signature = ed25519.sign(message, secretKey);
    for (const native of [
      () => {
        throw new Error("Unsupported key type");
      },
      () => 1 as unknown as boolean,
      () => false,
    ]) {
      const installed: E2eeNativePrimitives = { ed25519Verify: native };
      expect(expectEquivalent(verifyNode({ publicKey, message, signature }), installed)).toEqual({
        ok: "true",
      });
    }
  });
});

// ─── P-256 ───────────────────────────────────────────────────────────────────

const P256_N = p256.Point.Fn.ORDER;
const beBytes = (value: bigint, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};
const beToBigInt = (value: Uint8Array): bigint =>
  value.reduce((accumulator, byte) => (accumulator << 8n) | BigInt(byte), 0n);

const verifyClient = (input: Omit<E2eeSignatureVerification, "algorithm">) => () =>
  verifyE2eeSignature({ algorithm: "p256", ...input });

describe("P-256 ECDSA verification (§7.1, §14.3)", () => {
  it("matches the pinned verdict on random, high-s, mutated and edge signatures", () => {
    for (let round = 0; round < 24; round += 1) {
      const { secretKey } = p256.keygen();
      const publicKey = p256.getPublicKey(secretKey, false);
      const message = random(round * 5);
      const signature = p256.sign(sha256(message), secretKey, { prehash: false });
      expect(expectEquivalent(verifyClient({ publicKey, message, signature }))).toEqual({
        ok: "true",
      });
      // §7.1 accepts either s; so must the dispatcher.
      const s = beToBigInt(signature.subarray(32));
      const highS = new Uint8Array([...signature.subarray(0, 32), ...beBytes(P256_N - s, 32)]);
      expect(expectEquivalent(verifyClient({ publicKey, message, signature: highS }))).toEqual({
        ok: "true",
      });
      const flipped = Uint8Array.from(signature);
      flipped[round % 64]! ^= 0x20;
      expectEquivalent(verifyClient({ publicKey, message, signature: flipped }));
      expectEquivalent(verifyClient({ publicKey, message: random(3), signature }));
      // r and s at the §7.1 range edges, and DER: rejected before any curve math.
      for (const edge of [
        new Uint8Array([...beBytes(0n, 32), ...signature.subarray(32)]),
        new Uint8Array([...beBytes(P256_N, 32), ...signature.subarray(32)]),
        new Uint8Array([...signature.subarray(0, 32), ...beBytes(P256_N - 1n, 32)]),
        p256.Signature.fromBytes(signature, "compact").toBytes("der"),
      ]) {
        expectEquivalent(verifyClient({ publicKey, message, signature: edge }));
      }
    }
  });

  it("keeps the pinned verdict when native verification throws or returns false", () => {
    const { secretKey } = p256.keygen();
    const publicKey = p256.getPublicKey(secretKey, false);
    const message = random(16);
    const signature = p256.sign(sha256(message), secretKey, { prehash: false });
    for (const native of [
      () => {
        throw new Error("Unsupported key");
      },
      () => false,
    ]) {
      expect(
        expectEquivalent(verifyClient({ publicKey, message, signature }), { p256Verify: native }),
      ).toEqual({ ok: "true" });
    }
  });
});

// ─── ChaCha20-Poly1305 ───────────────────────────────────────────────────────

const aead = E2EE_NODE_NATIVE_IMPLEMENTATIONS.chacha20Poly1305;

describe("ChaCha20-Poly1305 (§9.1)", () => {
  const sizes = [
    0,
    1,
    15,
    16,
    17,
    63,
    64,
    65,
    E2EE_NODE_NATIVE_AEAD_MIN_BYTES - 1,
    E2EE_NODE_NATIVE_AEAD_MIN_BYTES,
    E2EE_NODE_NATIVE_AEAD_MIN_BYTES + 1,
    65_536,
    262_144,
  ];

  it("seals byte-identically and opens identically for every size", () => {
    for (const size of sizes) {
      const key = random(32);
      const nonce = random(12);
      const aad = random(size % 97);
      const plaintext = random(size);
      const pinned = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
      expect(hex(aead.seal(key, nonce, plaintext, aad))).toBe(hex(pinned));
      expect(hex(aead.open(key, nonce, pinned, aad))).toBe(hex(plaintext));
    }
  });

  it("rejects every forgery the pinned primitive rejects", () => {
    const key = random(32);
    const nonce = random(12);
    const aad = random(45);
    const plaintext = random(4_096);
    const sealed = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
    const mutations: Array<[Uint8Array, Uint8Array, Uint8Array, Uint8Array]> = [];
    for (const index of [
      0,
      100,
      sealed.byteLength - 17,
      sealed.byteLength - 16,
      sealed.byteLength - 1,
    ]) {
      const copy = Uint8Array.from(sealed);
      copy[index]! ^= 0x01;
      mutations.push([key, nonce, copy, aad]);
    }
    const otherAad = Uint8Array.from(aad);
    otherAad[0]! ^= 0x80;
    const otherNonce = Uint8Array.from(nonce);
    otherNonce[11]! ^= 0x01;
    mutations.push([key, nonce, sealed, otherAad]);
    mutations.push([key, otherNonce, sealed, aad]);
    mutations.push([random(32), nonce, sealed, aad]);
    mutations.push([key, nonce, sealed.subarray(0, sealed.byteLength - 1), aad]);
    mutations.push([key, nonce, sealed.subarray(0, 15), aad]);
    for (const [k, n, c, a] of mutations) {
      expect(() => chacha20poly1305(k, n, a).decrypt(c)).toThrow();
      expect(() => aead.open(k, n, c, a)).toThrow();
    }
  });

  it("drives E2eeRecordSession to identical envelopes and plaintexts with and without native", async () => {
    const secrets = () =>
      e2eeSessionSecretsFromNoiseKeys({
        epochSecretC2N: new Uint8Array(32).fill(0x11),
        epochSecretN2C: new Uint8Array(32).fill(0x22),
        exporterSecret: new Uint8Array(32).fill(0x33),
      });
    const makeSession = (sendDirection: E2eeDirection) =>
      new E2eeRecordSession({
        secrets: secrets(),
        suite: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
        sessionBindingHash: new Uint8Array(32).fill(0x44),
        sendDirection,
        plaintextCeiling: 1_048_576,
      });
    const bodies = [0, 100, 2_046, 2_047, 2_048, 70_000, 262_144].map((size) => random(size));
    const run = async (installed: E2eeNativePrimitives | undefined) => {
      installE2eeNativePrimitives(installed);
      const node = makeSession(E2EE_DIRECTION_NODE_TO_CLIENT);
      const client = makeSession(E2EE_DIRECTION_CLIENT_TO_NODE);
      const envelopes: string[] = [];
      const opened: string[] = [];
      for (const body of bodies) {
        let envelope: Uint8Array | undefined;
        const result = await node.protect({
          innerType: E2EE_INNER_TYPE_RPC,
          body,
          admit: () => true,
          transmit: (sent) => {
            envelope = sent;
            return { kind: "sent" };
          },
        });
        expect(result.kind).toBe("protected");
        envelopes.push(hex(envelope!));
        const received = client.unprotect(envelope!);
        expect(received.kind).toBe("authenticated");
        if (received.kind === "authenticated") opened.push(hex(received.body));
      }
      // A forged tag on a native-sized record is fatal, as it is without native.
      let forged: Uint8Array | undefined;
      await node.protect({
        innerType: E2EE_INNER_TYPE_RPC,
        body: random(8_192),
        admit: () => true,
        transmit: (sent) => {
          forged = Uint8Array.from(sent);
          return { kind: "sent" };
        },
      });
      forged![forged!.byteLength - 1]! ^= 0x01;
      const rejected = client.unprotect(forged!);
      node.erase();
      client.erase();
      return { envelopes, opened, rejected };
    };
    const pinned = await run(undefined);
    const native = await run(provider);
    expect(native).toEqual(pinned);
    expect(pinned.rejected).toEqual({ kind: "fatal", reason: "authentication_failed" });
    expect(pinned.opened).toEqual(bodies.map(hex));
  });
});
