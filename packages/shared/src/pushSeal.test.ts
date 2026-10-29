// @effect-diagnostics nodeBuiltinImport:off - An independent implementation of the construction, from Node's crypto.
import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import {
  openPushPayload,
  pushCollapseIdBytes,
  pushKeyIdBytes,
  pushSealAssociatedData,
  PUSH_SEAL_OVERHEAD_BYTES,
  sealPushPayload,
} from "./pushSeal.ts";
import { e2eeX25519KeyPair, e2eeX25519PublicKey } from "./relayE2eeKeys.ts";
import pinned from "./pushSeal.vectors.json" with { type: "json" };

const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const fromBase64Url = (value: string) => Uint8Array.from(Buffer.from(value, "base64url"));
const toBase64Url = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const utf8 = (value: string) => new TextEncoder().encode(value);

// RFC 8410 DER prefixes for raw X25519 keys.
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** The construction from its description, on Node's own primitives. */
function sealWithNodeCrypto(input: {
  readonly recipientPublicKey: Uint8Array;
  readonly ephemeralSecretKey: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly associatedData: Uint8Array;
}): Uint8Array {
  const ephemeralPrivate = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, input.ephemeralSecretKey]),
    format: "der",
    type: "pkcs8",
  });
  const ephemeralPublic = createPublicKey(ephemeralPrivate)
    .export({ format: "der", type: "spki" })
    .subarray(X25519_SPKI_PREFIX.byteLength);
  const recipient = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, input.recipientPublicKey]),
    format: "der",
    type: "spki",
  });
  const sharedSecret = diffieHellman({ privateKey: ephemeralPrivate, publicKey: recipient });
  const okm = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.concat([ephemeralPublic, input.recipientPublicKey]),
      "ryco push seal v1",
      44,
    ),
  );
  const cipher = createCipheriv("chacha20-poly1305", okm.subarray(0, 32), okm.subarray(32), {
    authTagLength: 16,
  });
  cipher.setAAD(input.associatedData, { plaintextLength: input.plaintext.byteLength });
  return Uint8Array.from(
    Buffer.concat([
      Buffer.of(1),
      ephemeralPublic,
      cipher.update(input.plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
  );
}

describe("ryco-push-seal-v1", () => {
  it.each(pinned.vectors.map((vector) => [vector.name, vector] as const))(
    "reproduces the pinned vector %s",
    (_name, vector) => {
      const recipientPublicKey = fromHex(vector.recipientPublicKey);
      expect(toBase64Url(e2eeX25519PublicKey(fromHex(vector.recipientSecretKey)))).toBe(
        toBase64Url(recipientPublicKey),
      );
      const associatedData = pushSealAssociatedData(vector);
      expect(Buffer.from(associatedData).toString("hex")).toBe(vector.associatedData);
      const sealed = sealPushPayload({
        recipientPublicKey,
        plaintext: utf8(vector.plaintext),
        associatedData,
        ephemeralSecretKey: fromHex(vector.ephemeralSecretKey),
      });
      expect(toBase64Url(sealed)).toBe(vector.sealed);
      const opened = openPushPayload({
        recipientSecretKey: fromHex(vector.recipientSecretKey),
        sealed: fromBase64Url(vector.sealed),
        associatedData,
      });
      expect(opened === null ? null : new TextDecoder().decode(opened)).toBe(vector.plaintext);
      expect(toBase64Url(pushKeyIdBytes(recipientPublicKey))).toBe(vector.keyId);
      expect(
        toBase64Url(
          pushCollapseIdBytes({
            salt: fromHex(vector.collapseSalt),
            environmentId: vector.environmentId,
            threadId: vector.threadId,
          }),
        ),
      ).toBe(vector.collapseId);
    },
  );

  it.each(pinned.vectors.map((vector) => [vector.name, vector] as const))(
    "matches an independent implementation on Node's crypto for %s",
    (_name, vector) => {
      expect(
        toBase64Url(
          sealWithNodeCrypto({
            recipientPublicKey: fromHex(vector.recipientPublicKey),
            ephemeralSecretKey: fromHex(vector.ephemeralSecretKey),
            plaintext: utf8(vector.plaintext),
            associatedData: fromHex(vector.associatedData),
          }),
        ),
      ).toBe(vector.sealed);
    },
  );

  it("draws a fresh ephemeral key for every seal", () => {
    const recipient = e2eeX25519KeyPair();
    const associatedData = pushSealAssociatedData({
      environmentId: "env_a",
      sequence: 1,
      enrollmentId: "enr_a",
    });
    const first = sealPushPayload({
      recipientPublicKey: recipient.publicKey,
      plaintext: utf8("same"),
      associatedData,
    });
    const second = sealPushPayload({
      recipientPublicKey: recipient.publicKey,
      plaintext: utf8("same"),
      associatedData,
    });
    expect(first.byteLength).toBe(PUSH_SEAL_OVERHEAD_BYTES + 4);
    expect(toBase64Url(first)).not.toBe(toBase64Url(second));
    for (const sealed of [first, second]) {
      const opened = openPushPayload({
        recipientSecretKey: recipient.secretKey,
        sealed,
        associatedData,
      });
      expect(opened === null ? null : new TextDecoder().decode(opened)).toBe("same");
    }
  });

  it("refuses a blob moved to another device, sequence or node, or tampered with", () => {
    const vector = pinned.vectors[0]!;
    const recipientSecretKey = fromHex(vector.recipientSecretKey);
    const sealed = fromBase64Url(vector.sealed);
    const bound = { ...vector };
    for (const associatedData of [
      pushSealAssociatedData({ ...bound, enrollmentId: "enr_SomeoneElse000000000000" }),
      pushSealAssociatedData({ ...bound, sequence: bound.sequence + 1 }),
      pushSealAssociatedData({ ...bound, environmentId: "env_other" }),
    ]) {
      expect(openPushPayload({ recipientSecretKey, sealed, associatedData })).toBeNull();
    }
    const associatedData = pushSealAssociatedData(bound);
    const flipped = Uint8Array.from(sealed);
    flipped[flipped.length - 1]! ^= 1;
    expect(openPushPayload({ recipientSecretKey, sealed: flipped, associatedData })).toBeNull();
    const otherVersion = Uint8Array.from(sealed);
    otherVersion[0] = 2;
    expect(
      openPushPayload({ recipientSecretKey, sealed: otherVersion, associatedData }),
    ).toBeNull();
    expect(
      openPushPayload({ recipientSecretKey, sealed: sealed.subarray(0, 40), associatedData }),
    ).toBeNull();
    expect(
      openPushPayload({
        recipientSecretKey: e2eeX25519KeyPair().secretKey,
        sealed,
        associatedData,
      }),
    ).toBeNull();
  });

  it("refuses a low-order recipient key", () => {
    expect(() =>
      sealPushPayload({
        recipientPublicKey: new Uint8Array(32),
        plaintext: utf8("x"),
        associatedData: utf8("y"),
      }),
    ).toThrow();
  });
});
