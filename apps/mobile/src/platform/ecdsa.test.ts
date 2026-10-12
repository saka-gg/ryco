import { decodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import { describe, expect, it } from "vite-plus/test";

import { derSignatureToRaw, ecPublicKeyJwk, uncompressedPointToJwk } from "./ecdsa";

/**
 * Build a DER `SEQUENCE { INTEGER r, INTEGER s }` from raw integer bytes.
 *
 * DER integers are signed, so a value whose top bit is set gets a `0x00` sign
 * byte — emitting one without it would not be valid DER, and the parser now
 * rejects that (as it must, so two encodings of one value cannot both pass).
 * Callers that pass an already-padded value are left alone.
 */
function derSignature(r: ReadonlyArray<number>, s: ReadonlyArray<number>): Uint8Array {
  const integer = (raw: ReadonlyArray<number>) => {
    const value = (raw[0]! & 0x80) === 0 ? raw : [0x00, ...raw];
    return [0x02, value.length, ...value];
  };
  const body = [...integer(r), ...integer(s)];
  const header = body.length < 0x80 ? [0x30, body.length] : [0x30, 0x81, body.length];
  return new Uint8Array([...header, ...body]);
}

/** A 32-byte big-endian integer whose bytes are all `fill` except a set prefix. */
function coordinate(fill: number, prefix: ReadonlyArray<number> = []): number[] {
  return [...prefix, ...Array.from({ length: 32 - prefix.length }, () => fill)];
}

describe("DER signature to raw r ‖ s", () => {
  it("converts a canonical 32-byte r and s", () => {
    const r = coordinate(0xaa);
    const s = coordinate(0xbb);

    const raw = derSignatureToRaw(derSignature(r, s));

    expect(raw).toHaveLength(64);
    expect([...raw.subarray(0, 32)]).toEqual(r);
    expect([...raw.subarray(32)]).toEqual(s);
  });

  it("left-pads an r that DER shortened by stripping leading zeros", () => {
    // DER omits leading zero bytes, so a small r arrives as fewer than 32 bytes
    // and must be restored to its left-padded 32-byte position.
    const raw = derSignatureToRaw(derSignature([0x01, 0x02], coordinate(0xbb)));

    expect(raw).toHaveLength(64);
    expect([...raw.subarray(0, 32)]).toEqual([...Array.from({ length: 30 }, () => 0), 0x01, 0x02]);
    expect([...raw.subarray(32)]).toEqual(coordinate(0xbb));
  });

  it("strips the DER sign-padding byte from a high-bit s", () => {
    // A value whose top bit is set gets a 0x00 prefix so DER reads it as
    // positive; that byte is encoding, not magnitude, and must not survive.
    const highBitS = coordinate(0x11, [0x80]);
    const raw = derSignatureToRaw(derSignature(coordinate(0xaa), [0x00, ...highBitS]));

    expect(raw).toHaveLength(64);
    expect([...raw.subarray(32)]).toEqual(highBitS);
  });

  it("handles sign padding on both integers at once", () => {
    const r = coordinate(0x22, [0xff]);
    const s = coordinate(0x33, [0x99]);

    const raw = derSignatureToRaw(derSignature([0x00, ...r], [0x00, ...s]));

    expect([...raw.subarray(0, 32)]).toEqual(r);
    expect([...raw.subarray(32)]).toEqual(s);
  });

  it("handles a single-byte integer", () => {
    const raw = derSignatureToRaw(derSignature([0x07], [0x09]));

    expect(raw).toHaveLength(64);
    expect(raw[31]).toBe(0x07);
    expect(raw[63]).toBe(0x09);
    expect([...raw.subarray(0, 31)]).toEqual(Array.from({ length: 31 }, () => 0));
  });

  it("accepts a long-form length header", () => {
    const raw = derSignatureToRaw(derSignature(coordinate(0xaa, [0x00]), coordinate(0xbb, [0x00])));
    expect(raw).toHaveLength(64);
  });

  it("rejects malformed DER rather than emitting a wrong signature", () => {
    expect(() => derSignatureToRaw(new Uint8Array([]))).toThrow(
      "Invalid ECDSA signature encoding.",
    );
    // Wrong outer tag.
    expect(() =>
      derSignatureToRaw(new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02])),
    ).toThrow("Invalid ECDSA signature encoding.");
    // Second element is not an INTEGER.
    expect(() =>
      derSignatureToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x03, 0x01, 0x02])),
    ).toThrow("Invalid ECDSA signature encoding.");
    // Declared sequence length does not match the buffer.
    expect(() =>
      derSignatureToRaw(new Uint8Array([0x30, 0x20, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02])),
    ).toThrow("Invalid ECDSA signature encoding.");
    // Trailing bytes after the sequence.
    expect(() =>
      derSignatureToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0xff])),
    ).toThrow("Invalid ECDSA signature encoding.");
    // Zero-length integer.
    expect(() =>
      derSignatureToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x00, 0x02, 0x01, 0x02, 0x00])),
    ).toThrow("Invalid ECDSA signature encoding.");
  });

  it("rejects an integer wider than the P-256 field", () => {
    // 33 significant bytes is not a valid P-256 scalar.
    const oversized = Array.from({ length: 33 }, () => 0x7f);
    expect(() => derSignatureToRaw(derSignature(oversized, coordinate(0xbb)))).toThrow(
      "Invalid ECDSA signature encoding.",
    );
  });
});

describe("public key to JWK", () => {
  it("converts an uncompressed point into a public-only JWK", () => {
    const x = coordinate(0xa1);
    const y = coordinate(0xb2);
    const point = new Uint8Array([0x04, ...x, ...y]);

    const jwk = uncompressedPointToJwk(point);

    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect([...decodeBase64Url(jwk.x!)]).toEqual(x);
    expect([...decodeBase64Url(jwk.y!)]).toEqual(y);
  });

  it("carries no private JWK members", () => {
    const jwk = uncompressedPointToJwk(
      new Uint8Array([0x04, ...coordinate(0xa1), ...coordinate(0xb2)]),
    );

    for (const member of ["d", "p", "q", "dp", "dq", "qi", "k", "oth"]) {
      expect(member in jwk).toBe(false);
    }
    expect(Object.keys(jwk).toSorted()).toEqual(["crv", "kty", "x", "y"]);
  });

  it("left-pads a coordinate the keystore returned short", () => {
    // Android reassembles coordinates from BigInteger affine values, which drop
    // leading zero bytes; trimming them would change the JWK thumbprint and
    // invalidate every proof after login.
    const shortX = new Uint8Array(31).fill(0x05);
    const jwk = ecPublicKeyJwk(shortX, new Uint8Array(coordinate(0xb2)));

    const decoded = decodeBase64Url(jwk.x!);
    expect(decoded).toHaveLength(32);
    expect(decoded[0]).toBe(0x00);
    expect([...decoded.subarray(1)]).toEqual([...shortX]);
  });

  it("strips a BigInteger sign-padding byte from a coordinate", () => {
    const x = coordinate(0xf0);
    const jwk = ecPublicKeyJwk(new Uint8Array([0x00, ...x]), new Uint8Array(coordinate(0xb2)));

    expect([...decodeBase64Url(jwk.x!)]).toEqual(x);
  });

  it("rejects a point with the wrong length", () => {
    expect(() => uncompressedPointToJwk(new Uint8Array(64).fill(0x04))).toThrow(
      "Invalid P-256 public key encoding.",
    );
    expect(() => uncompressedPointToJwk(new Uint8Array(66).fill(0x04))).toThrow(
      "Invalid P-256 public key encoding.",
    );
  });

  it("rejects a compressed or otherwise non-0x04 point", () => {
    const compressed = new Uint8Array([0x02, ...coordinate(0xa1), ...coordinate(0xb2)]);
    expect(() => uncompressedPointToJwk(compressed)).toThrow("Invalid P-256 public key encoding.");
  });

  it("rejects a coordinate wider than the P-256 field", () => {
    expect(() =>
      ecPublicKeyJwk(new Uint8Array(33).fill(0x7f), new Uint8Array(coordinate(0xb2))),
    ).toThrow("Invalid P-256 public key encoding.");
  });
});
