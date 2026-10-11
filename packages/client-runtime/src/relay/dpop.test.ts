import { describe, expect, it } from "vite-plus/test";

import { decodeBase64Url, encodeBase64Url } from "./base64url.ts";
import { createDpopProofSigner, type DpopProofContext, type DpopSigningKey } from "./dpop.ts";

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

const context: DpopProofContext = {
  now: () => 1_700_000_000_500,
  randomJti: () => "jti-fixed-canary",
  sha256,
};

/** A fake enclave key: records the signing input, returns a fixed signature. */
function fakeKey(overrides: Partial<DpopSigningKey> = {}): DpopSigningKey & {
  readonly signed: Uint8Array[];
} {
  const signed: Uint8Array[] = [];
  return {
    algorithm: "ES256",
    publicJwk: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    sign: async (input) => {
      signed.push(input);
      return new Uint8Array([1, 2, 3, 4]);
    },
    signed,
    ...overrides,
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))) as Record<string, unknown>;
}

describe("createDpopProofSigner", () => {
  it("builds htm/htu/iat/jti and omits ath on the mint (login) proof", async () => {
    const key = fakeKey();
    const proof = await createDpopProofSigner(key, context).sign({
      method: "post",
      url: "https://hub.example.test/api/auth/native/passkey/verify?trace=1#frag",
    });
    const [headerSegment, payloadSegment, signatureSegment] = proof.split(".");
    expect(decodeSegment(headerSegment!)).toEqual({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    });
    const payload = decodeSegment(payloadSegment!);
    expect(payload.htm).toBe("POST");
    // query and fragment are stripped from htu.
    expect(payload.htu).toBe("https://hub.example.test/api/auth/native/passkey/verify");
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.jti).toBe("jti-fixed-canary");
    expect("ath" in payload).toBe(false);
    // The signature is base64url of exactly the bytes the enclave returned, over
    // the header.payload signing input.
    expect(signatureSegment).toBe(encodeBase64Url(new Uint8Array([1, 2, 3, 4])));
    expect(new TextDecoder().decode(key.signed[0])).toBe(`${headerSegment}.${payloadSegment}`);
  });

  it("includes ath = base64url(sha256(token)) on authenticated proofs only", async () => {
    const key = fakeKey();
    const signer = createDpopProofSigner(key, context);
    const authenticated = await signer.sign({
      method: "GET",
      url: "https://hub.example.test/api/nodes",
      token: "native-token-canary",
    });
    const payload = decodeSegment(authenticated.split(".")[1]!);
    expect(payload.ath).toBe(
      encodeBase64Url(await sha256(new TextEncoder().encode("native-token-canary"))),
    );
    // ath is a digest, never the raw token; the token must not appear anywhere.
    expect(authenticated).not.toContain("native-token-canary");
  });

  it("rejects a non-asymmetric algorithm (alg:none / HS* JWS-confusion defense)", () => {
    for (const algorithm of ["none", "HS256", "HS512", "ES384", "PS256"]) {
      expect(() =>
        createDpopProofSigner(fakeKey({ algorithm: algorithm as never }), context),
      ).toThrow(/asymmetric/i);
    }
    // The allow-listed algorithms construct without throwing.
    expect(() => createDpopProofSigner(fakeKey({ algorithm: "ES256" }), context)).not.toThrow();
    expect(() => createDpopProofSigner(fakeKey({ algorithm: "RS256" }), context)).not.toThrow();
  });

  it("refuses a JWK that carries private key material", () => {
    for (const privateMember of ["d", "p", "q", "dp", "dq", "qi", "k"]) {
      expect(() =>
        createDpopProofSigner(
          fakeKey({
            publicJwk: {
              kty: "EC",
              crv: "P-256",
              x: "x",
              y: "y",
              [privateMember]: "secret",
            } as never,
          }),
          context,
        ),
      ).toThrow(/private key material/i);
    }
  });

  it("serializes only whitelisted public members, defeating a toJSON() private-key smuggle", async () => {
    // The member check sees only public own-properties, but a naive
    // JSON.stringify of the object would invoke toJSON() and emit `d`.
    const smuggling = {
      kty: "EC",
      crv: "P-256",
      x: "x-coordinate",
      y: "y-coordinate",
      toJSON() {
        return {
          kty: "EC",
          crv: "P-256",
          x: "x-coordinate",
          y: "y-coordinate",
          d: "PRIVATE-CANARY",
        };
      },
    };
    const proof = await createDpopProofSigner(
      fakeKey({ publicJwk: smuggling as never }),
      context,
    ).sign({ method: "GET", url: "https://hub.example.test/api/nodes" });
    // The private field never reaches the header; only the whitelisted public
    // members are serialized (the header copy has no toJSON to invoke).
    expect(proof).not.toContain("PRIVATE-CANARY");
    const header = decodeSegment(proof.split(".")[0]!);
    expect(header.jwk).toEqual({ kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" });
  });
});
