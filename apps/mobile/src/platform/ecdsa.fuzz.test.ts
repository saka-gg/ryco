import { decodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import { describe, expect, it } from "vite-plus/test";

import { derSignatureToRaw, uncompressedPointToJwk } from "./ecdsa";

/**
 * Differential checks against the platform's own P-256 implementation
 * (Web Crypto), which is independent of the code under test.
 *
 * ECDSA is randomized, so two signatures over the same message differ and
 * cannot be compared byte for byte. Instead Web Crypto produces the raw
 * `r ‖ s` form directly; the test re-encodes that as DER and requires the
 * decoder to recover the original bytes exactly. That is precisely the
 * property the Hub's signature check depends on, since
 * `createDpopProofSigner` base64url-encodes whatever the signing key returns.
 *
 * `node:crypto` is deliberately not used: the mobile tsconfig has no Node
 * types, so importing it fails typecheck.
 */

/** Minimal DER encoder for a `SEQUENCE { INTEGER r, INTEGER s }`. */
function encodeDerSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = [...bytes.subarray(start)];
    // DER integers are signed: prepend 0x00 when the top bit would read negative.
    const value = (trimmed[0]! & 0x80) === 0 ? trimmed : [0x00, ...trimmed];
    return [0x02, value.length, ...value];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

async function generateKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

describe("ECDSA conversions against the platform implementation", () => {
  it("recovers the exact raw r ‖ s from DER across many random signatures", async () => {
    const { privateKey } = await generateKey();
    const lengths = new Set<number>();

    for (let index = 0; index < 300; index += 1) {
      const message = crypto.getRandomValues(new Uint8Array(32));
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, message),
      );
      const der = encodeDerSignature(raw);
      lengths.add(der.length);

      const decoded = derSignatureToRaw(der);

      expect(decoded).toHaveLength(64);
      expect([...decoded]).toEqual([...raw]);
    }

    // More than one DER length proves the sign-padding and short-integer
    // branches were both exercised rather than one lucky shape.
    expect(lengths.size).toBeGreaterThan(1);
  });

  it("matches the platform's JWK export exactly for many random keys", async () => {
    for (let index = 0; index < 100; index += 1) {
      const { publicKey } = await generateKey();
      const reference = (await crypto.subtle.exportKey("jwk", publicKey)) as {
        x: string;
        y: string;
      };
      const point = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));

      const jwk = uncompressedPointToJwk(point);

      // Exactness matters: the JWK thumbprint binds the session, so any
      // difference in coordinate padding breaks every proof after login.
      expect(jwk.x).toBe(reference.x);
      expect(jwk.y).toBe(reference.y);
      expect(decodeBase64Url(jwk.x!)).toHaveLength(32);
      expect(decodeBase64Url(jwk.y!)).toHaveLength(32);
    }
  });

  it("rejects every truncation of a valid DER signature", async () => {
    const { privateKey } = await generateKey();
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
    );
    const der = encodeDerSignature(raw);

    for (let cut = 1; cut < der.length; cut += 1) {
      expect(() => derSignatureToRaw(der.subarray(0, cut))).toThrow();
    }
  });

  it("rejects a valid DER signature with a trailing byte appended", async () => {
    const { privateKey } = await generateKey();
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
    );

    expect(() => derSignatureToRaw(new Uint8Array([...encodeDerSignature(raw), 0x00]))).toThrow();
  });
});

describe("non-canonical encodings fail closed", () => {
  // Malformed native output must be rejected rather than coerced, so two
  // encodings of one value can never both be honoured.
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<number>]> = [
    [
      "BER long-form length where DER requires short form",
      [0x30, 0x81, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01],
    ],
    ["negative r (high bit set)", [0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01]],
    ["redundant leading zero on r", [0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01]],
    ["zero scalar r", [0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01]],
    ["negative s", [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x80]],
    ["zero scalar s", [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x00]],
  ];

  for (const [name, bytes] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => derSignatureToRaw(new Uint8Array(bytes))).toThrow(
        "Invalid ECDSA signature encoding.",
      );
    });
  }
});
