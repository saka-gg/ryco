import { describe, expect, it } from "vite-plus/test";

import { encodeBase64Url } from "./base64url.ts";
import {
  AUTHENTICATOR_TRANSPORTS,
  validatePasskeyAuthenticationOptions,
  validatePasskeyRegistrationOptions,
} from "./webauthn.ts";

/**
 * Pure fail-closed option codecs. The navigator ceremony that consumes these
 * decoded options lives in the web adapter (`apps/web/src/hostedHub/webauthn`),
 * whose test stubs `navigator.credentials`; this suite only exercises the
 * platform-neutral validation and decoding that must stay in front of the
 * platform seam, so it carries no navigator stubs.
 */

interface DecodedRequestOptions {
  readonly challenge: Uint8Array;
  readonly rpId?: string;
  readonly allowCredentials?: ReadonlyArray<{
    readonly id: Uint8Array;
    readonly type: string;
    readonly transports?: ReadonlyArray<string>;
  }>;
  readonly userVerification?: string;
}

interface DecodedCreationOptions {
  readonly challenge: Uint8Array;
  readonly rp: { readonly name: string; readonly id?: string };
  readonly user: { readonly id: Uint8Array; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: ReadonlyArray<{ readonly type: string; readonly alg: number }>;
}

function bytes(value: Uint8Array): number[] {
  return [...value];
}

describe("passkey authentication option codec", () => {
  it("decodes Hub JSON authentication options into the WebAuthn request shape", () => {
    const decoded = validatePasskeyAuthenticationOptions({
      challenge: encodeBase64Url(new Uint8Array([10, 11, 12])),
      rpId: "example.test",
      allowCredentials: [{ id: encodeBase64Url(new Uint8Array([13])), type: "public-key" }],
      userVerification: "required",
    }) as DecodedRequestOptions;

    expect(bytes(decoded.challenge)).toEqual([10, 11, 12]);
    expect(decoded.rpId).toBe("example.test");
    expect(decoded.allowCredentials).toHaveLength(1);
    expect(bytes(decoded.allowCredentials![0]!.id)).toEqual([13]);
    expect(decoded.allowCredentials![0]!.type).toBe("public-key");
    expect(decoded.userVerification).toBe("required");
  });

  it("rejects malformed options before the ceremony seam", () => {
    expect(() => validatePasskeyAuthenticationOptions({ challenge: "%%%" })).toThrow(
      "Invalid passkey options.",
    );
  });

  it.each([
    { challenge: encodeBase64Url(new Uint8Array([1])), allowCredentials: {} },
    {
      challenge: encodeBase64Url(new Uint8Array([1])),
      allowCredentials: [{ id: encodeBase64Url(new Uint8Array([2])), type: "password" }],
    },
    { challenge: encodeBase64Url(new Uint8Array([1])), timeout: -1 },
  ])("rejects malformed authentication option shapes", (options) => {
    expect(() => validatePasskeyAuthenticationOptions(options)).toThrow("Invalid passkey options.");
  });
});

describe("passkey registration option codec", () => {
  it("decodes Hub JSON registration options into the WebAuthn creation shape", () => {
    const decoded = validatePasskeyRegistrationOptions({
      challenge: encodeBase64Url(new Uint8Array([10, 11])),
      rp: { id: "example.test", name: "Ryco Hub" },
      user: {
        id: encodeBase64Url(new Uint8Array([12, 13])),
        name: "ada",
        displayName: "Ada",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    }) as DecodedCreationOptions;

    expect(bytes(decoded.challenge)).toEqual([10, 11]);
    expect(decoded.rp.id).toBe("example.test");
    expect(decoded.rp.name).toBe("Ryco Hub");
    expect(bytes(decoded.user.id)).toEqual([12, 13]);
    expect(decoded.user).toMatchObject({ name: "ada", displayName: "Ada" });
    expect(decoded.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
  });

  it.each([
    {
      challenge: encodeBase64Url(new Uint8Array([1])),
      rp: { name: "Ryco Hub" },
      user: { id: encodeBase64Url(new Uint8Array([2])), name: "ada", displayName: "Ada" },
      pubKeyCredParams: {},
    },
    {
      challenge: encodeBase64Url(new Uint8Array([1])),
      rp: { name: "Ryco Hub" },
      user: { id: encodeBase64Url(new Uint8Array([2])), name: "ada", displayName: "Ada" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: { id: "not-an-array" },
    },
  ])("rejects malformed registration option shapes", (options) => {
    expect(() => validatePasskeyRegistrationOptions(options)).toThrow("Invalid passkey options.");
  });

  it("bounds the accepted authenticator transports to the shared allow-list", () => {
    expect([...AUTHENTICATOR_TRANSPORTS].toSorted()).toEqual([
      "ble",
      "cable",
      "hybrid",
      "internal",
      "nfc",
      "smart-card",
      "usb",
    ]);
  });
});
