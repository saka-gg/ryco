import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vite-plus/test";

import { fingerprintNodePublicKey, formatNodePublicKeyFingerprint } from "./nodeIdentity.ts";
import {
  E2EE_AGREEMENT_KEY_FINGERPRINT_DOMAIN,
  E2EE_AGREEMENT_ALGORITHM,
  E2EE_CLIENT_IDENTITY_ALGORITHM,
  E2EE_CLIENT_KEY_FINGERPRINT_DOMAIN,
  E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX,
  E2EE_NODE_IDENTITY_ALGORITHM,
  E2EE_NODE_KEY_FINGERPRINT_DOMAIN,
  RelayE2eeValidationError,
  deriveE2eeAgreementPublicKey,
  e2eeBytesEqual,
  e2eeKeyFingerprint,
  formatE2eeKeyFingerprint,
  parseE2eeKeyFingerprint,
  generateE2eeAgreementKeyPair,
  e2eeSignatureMemoSizeForTests,
  resetE2eeSignatureMemoForTests,
  validateE2eeAgreementPublicKey,
  validateE2eeClientIdentityPublicKey,
  validateE2eeClientSignature,
  validateE2eeNodeIdentityPublicKey,
  validateE2eeNodeSignature,
  verifyE2eeSignature,
  warmE2eePrimitives,
} from "./relayE2eeKeys.ts";

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

// Deterministic §16.1-style test material. Never usable for a real endpoint: the
// Ed25519 key is the node-identity fixture key, whose seed is public in
// `nodeIdentity.test.ts`, and the P-256 key is derived from the same seed.
const NODE_PUBLIC_KEY = bytes("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
const CLIENT_PUBLIC_KEY = bytes(
  "047a593180860c4037c83c12749845c8ee1424dd297fadcb895e358255d2c7d2" +
    "b2a8ca25580f2626fe579062ff1b99ff91c24a0da06fb32b5be20148c9249f5650",
);
const AGREEMENT_PUBLIC_KEY = bytes(
  "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
);

const NODE_FINGERPRINT = "0156cdedee6f84797b28b7be83048194483cc17165b1ae7afe7bbc77eedf9b64";
const NODE_FINGERPRINT_DISPLAY = "SHA256:AVbN7e5vhHl7KLe-gwSBlEg8wXFlsa56_nu8d-7fm2Q";
const CLIENT_FINGERPRINT = "a9d61f1ad6753239898e6e6f262f2ec17f0498f2c33accc3b7448bfa5f0e8927";
const CLIENT_FINGERPRINT_DISPLAY = "SHA256:qdYfGtZ1MjmJjm5vJi8uwX8EmPLDOszDt0SL-l8OiSc";
const AGREEMENT_FINGERPRINT = "0f4004c97fa0df91b3cb19547a4e0b16f1b37b440f7cb630faf81291b37df779";
const AGREEMENT_FINGERPRINT_DISPLAY = "SHA256:D0AEyX-g35GzyxlUek4LFvGze0QPfLYw-vgSkbN993k";
// The identical 32 raw bytes fingerprinted under the agreement domain instead of
// the node-identity domain (§7.1).
const NODE_KEY_UNDER_AGREEMENT_DOMAIN =
  "2b32468407dd48cc05841f77a2da2ded78c39f3c1cb074a163cb327d50d72fb6";

// §14.3 / §7.1 rejection material, pinned as exact bytes.
const ED25519_NON_CANONICAL_PUBLIC_KEY = bytes(
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
);
const ED25519_SMALL_ORDER_PUBLIC_KEY = bytes(
  "0100000000000000000000000000000000000000000000000000000000000000",
);
const P256_KEY_COORDINATE_AT_PRIME = bytes(
  "04ffffffff00000001000000000000000000000000ffffffffffffffffffffffff" +
    "a8ca25580f2626fe579062ff1b99ff91c24a0da06fb32b5be20148c9249f5650",
);
const P256_KEY_OFF_CURVE = bytes(
  "047a593180860c4037c83c12749845c8ee1424dd297fadcb895e358255d2c7d2" +
    "b2a8ca25580f2626fe579062ff1b99ff91c24a0da06fb32b5be20148c9249f5651",
);
const P256_KEY_ZERO_COORDINATES = bytes(`04${"00".repeat(64)}`);
const P256_KEY_COMPRESSED_PREFIX = bytes(
  "027a593180860c4037c83c12749845c8ee1424dd297fadcb895e358255d2c7d2" +
    "b2a8ca25580f2626fe579062ff1b99ff91c24a0da06fb32b5be20148c9249f5650",
);

// One deterministic message signed under both algorithms, plus the encodings
// §7.1 refuses for each.
const MESSAGE = bytes("72656c61792d653265652d666978747572652d6d657373616765");
const ED25519_TEST_PUBLIC_KEY = bytes(
  "48075a597e721a156e2e0799de5cc0c5324dc6e7eaf1cdd46250868ec53215dd",
);
const ED25519_TEST_SIGNATURE = bytes(
  "02b5dbb1dcc45109d03b2f63fd0ca36555fde0d9a78ee211aca0ee522ec8542c" +
    "d14db26346925648fce3ad9890f419c2b682fe3f1c8af6931385c153f249430d",
);
const P256_RAW_SIGNATURE = bytes(
  "583a9ee443dd323ad8e7a2b546c30162a77200404f6f2eeed764f76cbc2ea2df" +
    "4c7b948f187957de6babf02f7d6ed1d82a90c7d8a59c36fb8b942e2465573a6d",
);
const P256_DER_SIGNATURE = bytes(
  "30440220583a9ee443dd323ad8e7a2b546c30162a77200404f6f2eeed764f76cbc2ea2df" +
    "02204c7b948f187957de6babf02f7d6ed1d82a90c7d8a59c36fb8b942e2465573a6d",
);
const P256_SIGNATURE_ZERO_R = bytes(
  `${"00".repeat(32)}4c7b948f187957de6babf02f7d6ed1d82a90c7d8a59c36fb8b942e2465573a6d`,
);
const P256_SIGNATURE_S_AT_ORDER = bytes(
  "583a9ee443dd323ad8e7a2b546c30162a77200404f6f2eeed764f76cbc2ea2df" +
    "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);
const P256_GROUP_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

describe("relay E2EE key material (§7.1)", () => {
  it("pins the three fingerprint domains and algorithm labels", () => {
    expect(E2EE_NODE_KEY_FINGERPRINT_DOMAIN).toBe("ryco.node-key.v1");
    expect(E2EE_CLIENT_KEY_FINGERPRINT_DOMAIN).toBe("ryco.client-key.v1");
    expect(E2EE_AGREEMENT_KEY_FINGERPRINT_DOMAIN).toBe("ryco.e2ee-agreement-key.v1");
    expect(E2EE_NODE_IDENTITY_ALGORITHM).toBe("ed25519");
    expect(E2EE_CLIENT_IDENTITY_ALGORITHM).toBe("p256");
    expect(E2EE_AGREEMENT_ALGORITHM).toBe("x25519");
    expect(E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX).toBe("SHA256:");
  });

  it("matches the deterministic fingerprint and display fixtures", () => {
    const node = e2eeKeyFingerprint("node-identity", NODE_PUBLIC_KEY);
    const client = e2eeKeyFingerprint("client-identity", CLIENT_PUBLIC_KEY);
    const agreement = e2eeKeyFingerprint("agreement", AGREEMENT_PUBLIC_KEY);
    expect(hex(node)).toBe(NODE_FINGERPRINT);
    expect(hex(client)).toBe(CLIENT_FINGERPRINT);
    expect(hex(agreement)).toBe(AGREEMENT_FINGERPRINT);
    expect(formatE2eeKeyFingerprint(node)).toBe(NODE_FINGERPRINT_DISPLAY);
    expect(formatE2eeKeyFingerprint(client)).toBe(CLIENT_FINGERPRINT_DISPLAY);
    expect(formatE2eeKeyFingerprint(agreement)).toBe(AGREEMENT_FINGERPRINT_DISPLAY);
    // Derived, not chosen: ⌈4 · 32 / 3⌉ characters after the prefix (§7.1).
    expect(NODE_FINGERPRINT_DISPLAY.length - E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX.length).toBe(43);
  });

  it("round-trips the display form and refuses every other spelling of it", () => {
    // §13.6 has the owner TYPE this value at the node CLI, so the parse is the
    // one place a display string becomes a record key. It must accept exactly
    // what the formatter emits and nothing else: two spellings of one digest
    // would let one record be named twice and the pairing-window discriminator
    // be matched against a value the owner did not read off their device.
    const fingerprint = e2eeKeyFingerprint("client-identity", CLIENT_PUBLIC_KEY);
    const display = formatE2eeKeyFingerprint(fingerprint);
    expect(hex(parseE2eeKeyFingerprint(display))).toBe(hex(fingerprint));

    const body = display.slice(E2EE_KEY_FINGERPRINT_DISPLAY_PREFIX.length);
    for (const rejected of [
      body,
      `sha256:${body}`,
      `SHA256:${body}=`,
      `SHA256:${body} `,
      `SHA256:${body.slice(0, -1)}`,
      `SHA256:${body}A`,
      // Standard base64's alphabet, which encodes the same digest differently.
      `SHA256:${body.replaceAll("-", "+").replaceAll("_", "/")}`,
    ]) {
      if (rejected === display) continue;
      expect(() => parseE2eeKeyFingerprint(rejected)).toThrow();
    }
  });

  it("refuses a display form whose trailing bits are not the encoder's padding", () => {
    // The last character carries only four significant bits of a 32-byte digest;
    // the other two are padding the encoder always writes as zero. A parser that
    // ignored them would accept four spellings of every fingerprint.
    const display = formatE2eeKeyFingerprint(e2eeKeyFingerprint("node-identity", NODE_PUBLIC_KEY));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = display[display.length - 1]!;
    const index = alphabet.indexOf(last);
    let refused = 0;
    for (const offset of [1, 2, 3]) {
      const candidate = `${display.slice(0, -1)}${alphabet[(index + offset) % 64]!}`;
      expect(() => parseE2eeKeyFingerprint(candidate)).toThrow();
      refused += 1;
    }
    expect(refused).toBe(3);
  });

  it("reuses the node-identity fingerprint definition unchanged", () => {
    // §7.1 defines `ryco.node-key.v1` as the existing construction. This module
    // restates it so the web and mobile clients can carry it without
    // `node:crypto`; the two MUST stay byte-identical, in raw and display form.
    const existing = fingerprintNodePublicKey({
      algorithm: "ed25519",
      publicKey: NODE_PUBLIC_KEY,
    });
    const e2ee = e2eeKeyFingerprint("node-identity", NODE_PUBLIC_KEY);
    expect(hex(e2ee)).toBe(hex(existing));
    expect(formatE2eeKeyFingerprint(e2ee)).toBe(formatNodePublicKeyFingerprint(existing));
  });

  it("separates the fingerprint domains over identical raw key bytes", () => {
    const asIdentity = e2eeKeyFingerprint("node-identity", NODE_PUBLIC_KEY);
    const asAgreement = e2eeKeyFingerprint("agreement", NODE_PUBLIC_KEY);
    expect(hex(asIdentity)).toBe(NODE_FINGERPRINT);
    expect(hex(asAgreement)).toBe(NODE_KEY_UNDER_AGREEMENT_DOMAIN);
    expect(hex(asIdentity)).not.toBe(hex(asAgreement));
  });

  it("copies accepted key bytes rather than aliasing the caller's buffer", () => {
    const input = Uint8Array.from(NODE_PUBLIC_KEY);
    const validated = validateE2eeNodeIdentityPublicKey(input);
    input.fill(0);
    expect(hex(validated)).toBe(hex(NODE_PUBLIC_KEY));
  });

  it("decodes Ed25519 identity keys strictly, not permissively", () => {
    expect(hex(validateE2eeNodeIdentityPublicKey(NODE_PUBLIC_KEY))).toBe(hex(NODE_PUBLIC_KEY));
    // A `y` coordinate equal to the field prime: a ZIP215-style decoder accepts
    // it, RFC 8032 does not. The first assertion is what proves the second one
    // is doing work rather than tracking the library default.
    expect(ed25519.utils.isValidPublicKey(ED25519_NON_CANONICAL_PUBLIC_KEY, true)).toBe(true);
    expect(() => validateE2eeNodeIdentityPublicKey(ED25519_NON_CANONICAL_PUBLIC_KEY)).toThrow(
      RelayE2eeValidationError,
    );
    expect(() => validateE2eeNodeIdentityPublicKey(new Uint8Array(31))).toThrow(
      RelayE2eeValidationError,
    );
    expect(() => validateE2eeNodeIdentityPublicKey(new Uint8Array(33))).toThrow(
      RelayE2eeValidationError,
    );
  });

  it("applies full P-256 point validation", () => {
    expect(hex(validateE2eeClientIdentityPublicKey(CLIENT_PUBLIC_KEY))).toBe(
      hex(CLIENT_PUBLIC_KEY),
    );
    for (const rejected of [
      P256_KEY_COMPRESSED_PREFIX,
      P256_KEY_COORDINATE_AT_PRIME,
      P256_KEY_OFF_CURVE,
      P256_KEY_ZERO_COORDINATES,
      new Uint8Array(64),
      new Uint8Array(33),
    ]) {
      expect(() => validateE2eeClientIdentityPublicKey(rejected)).toThrow(RelayE2eeValidationError);
    }
  });

  it("validates agreement keys by length alone", () => {
    expect(hex(validateE2eeAgreementPublicKey(AGREEMENT_PUBLIC_KEY))).toBe(
      hex(AGREEMENT_PUBLIC_KEY),
    );
    // No point validation exists for X25519; an all-zero key is well formed here
    // and is caught by the §8.6 all-zero shared-secret abort instead.
    expect(hex(validateE2eeAgreementPublicKey(new Uint8Array(32)))).toBe("00".repeat(32));
    expect(() => validateE2eeAgreementPublicKey(new Uint8Array(31))).toThrow(
      RelayE2eeValidationError,
    );
  });

  it("rejects signature encodings this protocol does not carry", () => {
    expect(hex(validateE2eeNodeSignature(ED25519_TEST_SIGNATURE))).toBe(
      hex(ED25519_TEST_SIGNATURE),
    );
    expect(() => validateE2eeNodeSignature(new Uint8Array(63))).toThrow(RelayE2eeValidationError);
    expect(hex(validateE2eeClientSignature(P256_RAW_SIGNATURE))).toBe(hex(P256_RAW_SIGNATURE));
    // ASN.1/DER is rejected on the wire (§7.1): it never has the raw length.
    expect(() => validateE2eeClientSignature(P256_DER_SIGNATURE)).toThrow(RelayE2eeValidationError);
    expect(() => validateE2eeClientSignature(P256_SIGNATURE_ZERO_R)).toThrow(
      RelayE2eeValidationError,
    );
    expect(() => validateE2eeClientSignature(P256_SIGNATURE_S_AT_ORDER)).toThrow(
      RelayE2eeValidationError,
    );
  });
});

describe("relay E2EE signature verification choke point (§14.3)", () => {
  const edVerification = {
    algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
    publicKey: ED25519_TEST_PUBLIC_KEY,
    message: MESSAGE,
    signature: ED25519_TEST_SIGNATURE,
  } as const;
  const p256Verification = {
    algorithm: E2EE_CLIENT_IDENTITY_ALGORITHM,
    publicKey: CLIENT_PUBLIC_KEY,
    message: MESSAGE,
    signature: P256_RAW_SIGNATURE,
  } as const;

  it("verifies the deterministic Ed25519 and P-256 fixtures", () => {
    expect(verifyE2eeSignature(edVerification)).toBe(true);
    expect(verifyE2eeSignature(p256Verification)).toBe(true);
  });

  it("remembers only a successful verdict, for exactly the bytes it was given", () => {
    resetE2eeSignatureMemoForTests();
    try {
      expect(verifyE2eeSignature(edVerification)).toBe(true);
      expect(e2eeSignatureMemoSizeForTests()).toBe(1);
      // Identical bytes in a different buffer are the same verdict.
      expect(verifyE2eeSignature({ ...edVerification, message: Uint8Array.from(MESSAGE) })).toBe(
        true,
      );
      expect(e2eeSignatureMemoSizeForTests()).toBe(1);

      const mutated = Uint8Array.from(MESSAGE);
      mutated[0] = (mutated[0]! ^ 0x01) & 0xff;
      expect(verifyE2eeSignature({ ...edVerification, message: mutated })).toBe(false);
      expect(verifyE2eeSignature({ ...edVerification, publicKey: NODE_PUBLIC_KEY })).toBe(false);
      // A failure is never remembered.
      expect(e2eeSignatureMemoSizeForTests()).toBe(1);
      // Validation still runs before any lookup: a remembered triple cannot
      // launder a malformed signature or a non-canonical key.
      expect(
        verifyE2eeSignature({ ...edVerification, signature: ED25519_TEST_SIGNATURE.subarray(1) }),
      ).toBe(false);
      expect(
        verifyE2eeSignature({ ...edVerification, publicKey: ED25519_NON_CANONICAL_PUBLIC_KEY }),
      ).toBe(false);
      // The same bytes under the other algorithm are a different key.
      expect(verifyE2eeSignature(p256Verification)).toBe(true);
      expect(e2eeSignatureMemoSizeForTests()).toBe(2);
    } finally {
      resetE2eeSignatureMemoForTests();
    }
  });

  it("bounds the remembered verdicts", () => {
    resetE2eeSignatureMemoForTests();
    try {
      for (let index = 0; index < 140; index += 1) {
        const secretKey = ed25519.utils.randomSecretKey();
        const message = Uint8Array.of(index);
        expect(
          verifyE2eeSignature({
            algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
            publicKey: ed25519.getPublicKey(secretKey),
            message,
            signature: ed25519.sign(message, secretKey),
          }),
        ).toBe(true);
      }
      expect(e2eeSignatureMemoSizeForTests()).toBe(128);
    } finally {
      resetE2eeSignatureMemoForTests();
    }
  });

  it("warms the handshake primitives once without throwing", () => {
    resetE2eeSignatureMemoForTests();
    try {
      warmE2eePrimitives();
      // The fixed RFC 8032 vector verified through the choke point.
      expect(e2eeSignatureMemoSizeForTests()).toBe(1);
      warmE2eePrimitives();
      expect(e2eeSignatureMemoSizeForTests()).toBe(1);
    } finally {
      resetE2eeSignatureMemoForTests();
    }
  });

  it("accepts either P-256 `s` value", () => {
    // §7.1: the protocol derives no uniqueness from signature bytes, so `lowS`
    // normalization MUST NOT be enforced on verification.
    const s = BigInt(`0x${hex(P256_RAW_SIGNATURE.subarray(32))}`);
    const flipped = Uint8Array.from(P256_RAW_SIGNATURE);
    const negated = (P256_GROUP_ORDER - s).toString(16).padStart(64, "0");
    flipped.set(bytes(negated), 32);
    expect(hex(flipped)).not.toBe(hex(P256_RAW_SIGNATURE));
    expect(verifyE2eeSignature({ ...p256Verification, signature: flipped })).toBe(true);
  });

  it("rejects a Ed25519 small-order public key and a non-canonical one", () => {
    // Both are values permissive verifiers admit; `zip215: false` does not.
    expect(
      verifyE2eeSignature({ ...edVerification, publicKey: ED25519_SMALL_ORDER_PUBLIC_KEY }),
    ).toBe(false);
    expect(
      verifyE2eeSignature({ ...edVerification, publicKey: ED25519_NON_CANONICAL_PUBLIC_KEY }),
    ).toBe(false);
  });

  it("rejects a mutated message, a substituted key, and a DER signature", () => {
    const mutated = Uint8Array.from(MESSAGE);
    mutated[0] = (mutated[0]! ^ 0x01) & 0xff;
    expect(verifyE2eeSignature({ ...edVerification, message: mutated })).toBe(false);
    expect(verifyE2eeSignature({ ...edVerification, publicKey: NODE_PUBLIC_KEY })).toBe(false);
    expect(verifyE2eeSignature({ ...p256Verification, message: mutated })).toBe(false);
    expect(verifyE2eeSignature({ ...p256Verification, signature: P256_DER_SIGNATURE })).toBe(false);
    expect(verifyE2eeSignature({ ...p256Verification, signature: P256_SIGNATURE_ZERO_R })).toBe(
      false,
    );
    expect(verifyE2eeSignature({ ...p256Verification, signature: P256_SIGNATURE_S_AT_ORDER })).toBe(
      false,
    );
  });

  it("rejects a signature presented under the wrong algorithm", () => {
    expect(
      verifyE2eeSignature({
        algorithm: E2EE_CLIENT_IDENTITY_ALGORITHM,
        publicKey: ED25519_TEST_PUBLIC_KEY,
        message: MESSAGE,
        signature: ED25519_TEST_SIGNATURE,
      }),
    ).toBe(false);
    expect(
      verifyE2eeSignature({
        algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
        publicKey: CLIENT_PUBLIC_KEY,
        message: MESSAGE,
        signature: P256_RAW_SIGNATURE,
      }),
    ).toBe(false);
  });

  it("never throws on peer-supplied bytes", () => {
    for (const length of [0, 1, 31, 32, 63, 64, 65, 96]) {
      expect(
        verifyE2eeSignature({
          algorithm: E2EE_NODE_IDENTITY_ALGORITHM,
          publicKey: new Uint8Array(length).fill(0xab),
          message: new Uint8Array(length),
          signature: new Uint8Array(length).fill(0xcd),
        }),
      ).toBe(false);
      expect(
        verifyE2eeSignature({
          algorithm: E2EE_CLIENT_IDENTITY_ALGORITHM,
          publicKey: new Uint8Array(length).fill(0xab),
          message: new Uint8Array(length),
          signature: new Uint8Array(length).fill(0xcd),
        }),
      ).toBe(false);
    }
  });

  it("compares public byte strings without reflecting them", () => {
    expect(e2eeBytesEqual(NODE_PUBLIC_KEY, Uint8Array.from(NODE_PUBLIC_KEY))).toBe(true);
    expect(e2eeBytesEqual(NODE_PUBLIC_KEY, AGREEMENT_PUBLIC_KEY)).toBe(false);
    expect(e2eeBytesEqual(NODE_PUBLIC_KEY, NODE_PUBLIC_KEY.subarray(0, 31))).toBe(false);

    const canary = "do-not-reflect-key-material";
    let error: unknown;
    try {
      formatE2eeKeyFingerprint(new TextEncoder().encode(canary));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(RelayE2eeValidationError);
    expect(String(error)).not.toContain(canary);
  });
});

describe("relay E2EE static agreement key generation (§6.2)", () => {
  it("produces a matching, protocol-valid X25519 pair on every call", () => {
    const first = generateE2eeAgreementKeyPair();
    const second = generateE2eeAgreementKeyPair();

    expect(Object.keys(first).toSorted()).toEqual(["publicKey", "secretKey"]);
    expect(first.secretKey).toHaveLength(32);
    expect(first.publicKey).toHaveLength(32);
    // The public half is exactly what §7.1 will accept in a §7.3 certificate.
    expect(validateE2eeAgreementPublicKey(first.publicKey)).toEqual(first.publicKey);
    expect(hex(deriveE2eeAgreementPublicKey(first.secretKey))).toBe(hex(first.publicKey));

    // Fresh material per call: §6.2 gives the node ONE active prekey, and a
    // generator that could repeat itself would make rotation meaningless.
    expect(hex(second.secretKey)).not.toBe(hex(first.secretKey));
    expect(hex(second.publicKey)).not.toBe(hex(first.publicKey));
  });

  it("agrees with the primitive both endpoints of a handshake will use", () => {
    const node = generateE2eeAgreementKeyPair();
    const client = generateE2eeAgreementKeyPair();
    expect(hex(x25519.getSharedSecret(node.secretKey, client.publicKey))).toBe(
      hex(x25519.getSharedSecret(client.secretKey, node.publicKey)),
    );
  });

  it("derives without copying, mutating, or zeroizing the caller's secret", () => {
    const pair = generateE2eeAgreementKeyPair();
    const before = hex(pair.secretKey);
    deriveE2eeAgreementPublicKey(pair.secretKey);
    // Custody owns the lifetime of the secret (§6.3); this function must not
    // erase a buffer the caller still needs to hand to its store.
    expect(hex(pair.secretKey)).toBe(before);
  });

  it("rejects anything that is not a 32-byte scalar, without reflecting it", () => {
    const canary = "do-not-reflect-agreement-secret";
    for (const invalid of [
      new Uint8Array(0),
      new Uint8Array(31),
      new Uint8Array(33),
      new TextEncoder().encode(canary),
    ]) {
      let error: unknown;
      try {
        deriveE2eeAgreementPublicKey(invalid);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(RelayE2eeValidationError);
      expect(String(error)).not.toContain(canary);
    }
    expect(() => deriveE2eeAgreementPublicKey(undefined as unknown as Uint8Array)).toThrow(
      RelayE2eeValidationError,
    );
  });

  it("never emits the degenerate material that would make every agreement fail", () => {
    const zero = hex(new Uint8Array(32));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pair = generateE2eeAgreementKeyPair();
      // §8.1/§14.3 abort the handshake on an all-zero shared secret. A generator
      // that could emit the zero scalar or the identity point would produce a
      // key that is durably stored and permanently unusable.
      expect(hex(pair.secretKey)).not.toBe(zero);
      expect(hex(pair.publicKey)).not.toBe(zero);
      expect(hex(e2eeKeyFingerprint("agreement", pair.publicKey))).toHaveLength(64);
    }
  });
});
