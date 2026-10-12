import { decodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { ensureKey, sign, hasKey, deleteKey } = vi.hoisted(() => ({
  ensureKey: vi.fn(),
  sign: vi.fn(),
  hasKey: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("@ryco/mobile-device-key", () => ({
  default: { ensureKey, sign, hasKey, deleteKey },
}));

import {
  getMobileDeviceIdentityPublicKey,
  getMobileDeviceKeyBacking,
  getMobileDeviceSigningKey,
  isMobileDeviceKeyAvailable,
  resetMobileDeviceKeyForTests,
} from "./deviceKey";

const UNAVAILABLE = "A hardware-backed device key is unavailable on this device.";

/** Base64 of an X9.63 uncompressed point with recognizable coordinates. */
function publicKeyBase64(): string {
  const point = new Uint8Array([
    0x04,
    ...Array.from({ length: 32 }, () => 0xa1),
    ...Array.from({ length: 32 }, () => 0xb2),
  ]);
  return btoa(String.fromCharCode(...point));
}

/** Base64 of a DER `SEQUENCE { INTEGER r, INTEGER s }` with short integers. */
function derSignatureBase64(): string {
  const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x07, 0x02, 0x01, 0x09]);
  return btoa(String.fromCharCode(...der));
}

beforeEach(() => {
  resetMobileDeviceKeyForTests();
  vi.clearAllMocks();
});

describe("hardware device key", () => {
  it("builds an ES256 signing key from a Secure Enclave public point", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "secure-enclave" });

    const key = await getMobileDeviceSigningKey();

    expect(key.algorithm).toBe("ES256");
    expect(key.publicJwk.kty).toBe("EC");
    expect(key.publicJwk.crv).toBe("P-256");
    expect([...decodeBase64Url(key.publicJwk.x!)]).toEqual(Array.from({ length: 32 }, () => 0xa1));
    expect([...decodeBase64Url(key.publicJwk.y!)]).toEqual(Array.from({ length: 32 }, () => 0xb2));
  });

  it("accepts a StrongBox-backed key", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "strongbox" });
    await expect(getMobileDeviceSigningKey()).resolves.toBeDefined();
  });

  it("accepts a proven Android TEE key and reports its lower assurance exactly", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "tee" });

    await expect(getMobileDeviceSigningKey()).resolves.toBeDefined();
    await expect(getMobileDeviceKeyBacking()).resolves.toBe("tee");
    expect(ensureKey).toHaveBeenCalledOnce();
  });

  it("converts the native DER signature to raw r ‖ s", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "secure-enclave" });
    sign.mockResolvedValue(derSignatureBase64());

    const key = await getMobileDeviceSigningKey();
    const signature = await key.sign(new TextEncoder().encode("signing-input"));

    // JWS ES256 requires exactly 64 raw bytes; returning DER here would produce
    // a proof the Hub rejects as a signature failure.
    expect(signature).toHaveLength(64);
    expect(signature[31]).toBe(0x07);
    expect(signature[63]).toBe(0x09);
  });

  it("fails closed when the platform reports no hardware backing", async () => {
    // This is the Simulator path: no enclave, so there must be no hosted
    // session at all rather than a software-key fallback.
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "unavailable" });

    await expect(getMobileDeviceSigningKey()).rejects.toThrow(UNAVAILABLE);
    await expect(isMobileDeviceKeyAvailable()).resolves.toBe(false);
  });

  it("fails closed with a bounded message when the enclave rejects", async () => {
    ensureKey.mockRejectedValue(new Error("SecKeyCreateRandomKey failed: -25293 at 0xdeadbeef"));

    const failure = await getMobileDeviceSigningKey().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toBe(UNAVAILABLE);
    expect(failure?.message).not.toContain("0xdeadbeef");
  });

  it("builds the key once and reuses it across calls", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "secure-enclave" });

    const first = await getMobileDeviceSigningKey();
    const second = await getMobileDeviceSigningKey();

    expect(first).toBe(second);
    expect(ensureKey).toHaveBeenCalledTimes(1);
  });

  it("does not memoize a failure, so a later attempt can still succeed", async () => {
    ensureKey.mockRejectedValueOnce(new Error("enclave busy"));
    await expect(getMobileDeviceSigningKey()).rejects.toThrow(UNAVAILABLE);

    ensureKey.mockResolvedValueOnce({ publicKey: publicKeyBase64(), backing: "secure-enclave" });
    await expect(getMobileDeviceSigningKey()).resolves.toBeDefined();
  });

  it("rejects a malformed public point rather than emitting a bad JWK", async () => {
    ensureKey.mockResolvedValue({
      publicKey: btoa(String.fromCharCode(...new Uint8Array(64).fill(0x04))),
      backing: "secure-enclave",
    });

    await expect(getMobileDeviceSigningKey()).rejects.toThrow(UNAVAILABLE);
  });

  it("surfaces the uncompressed public point the E2EE prekey certificate signs over", async () => {
    // `docs/relay-e2ee-protocol.md` §7.4 element 4 carries the X9.63 point
    // verbatim and §7.1 fingerprints it, so the JWK is not a substitute.
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "secure-enclave" });

    const point = await getMobileDeviceIdentityPublicKey();

    expect(point).toHaveLength(65);
    expect(point[0]).toBe(0x04);
    expect([...point.subarray(1, 33)]).toEqual(Array.from({ length: 32 }, () => 0xa1));
    expect([...point.subarray(33)]).toEqual(Array.from({ length: 32 }, () => 0xb2));
  });

  it("hands out a copy of the point, so a caller cannot corrupt the memoized key", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "secure-enclave" });

    const first = await getMobileDeviceIdentityPublicKey();
    first.fill(0);
    const second = await getMobileDeviceIdentityPublicKey();

    expect(second[0]).toBe(0x04);
    expect(ensureKey).toHaveBeenCalledTimes(1);
  });

  it("refuses the point on the same terms as the signing key", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "unavailable" });

    await expect(getMobileDeviceIdentityPublicKey()).rejects.toThrow(UNAVAILABLE);
  });

  it("exposes no export or extract path on the key", async () => {
    ensureKey.mockResolvedValue({ publicKey: publicKeyBase64(), backing: "secure-enclave" });

    const key = await getMobileDeviceSigningKey();

    expect(Object.keys(key).toSorted()).toEqual(["algorithm", "publicJwk", "sign"]);
    for (const member of ["d", "p", "q", "dp", "dq", "qi", "k", "oth"]) {
      expect(member in key.publicJwk).toBe(false);
    }
  });
});
