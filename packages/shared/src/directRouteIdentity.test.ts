import { ed25519 } from "@noble/curves/ed25519.js";
import { decode } from "cborg";
import { describe, expect, it } from "vite-plus/test";

import {
  DIRECT_ROUTE_IDENTITY_TRANSCRIPT_DOMAIN,
  encodeDirectRouteIdentityTranscript,
  verifyDirectRouteIdentityProof,
} from "./directRouteIdentity.ts";
import { encodeNodeAuthenticationTranscript } from "./nodeIdentity.ts";

const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const nodeIdentityPublicKey = ed25519.getPublicKey(secretKey);
const challenge = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const environmentId = "env_direct";
const origin = "https://studio.tail1.ts.net";

function proof(input: {
  readonly environmentId: string;
  readonly origin: string;
  readonly challenge: Uint8Array;
}) {
  return ed25519.sign(encodeDirectRouteIdentityTranscript(input), secretKey);
}

describe("direct route identity proof", () => {
  it("encodes the domain, the direct id, the contacted origin and the challenge, in that order", () => {
    const decoded = decode(
      encodeDirectRouteIdentityTranscript({ environmentId, origin, challenge }),
    );
    expect(decoded).toEqual([
      DIRECT_ROUTE_IDENTITY_TRANSCRIPT_DOMAIN,
      environmentId,
      origin,
      challenge,
    ]);
  });

  it("accepts the node key's signature over this client's challenge for this machine", () => {
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        origin,
        challenge,
        signature: proof({ environmentId, origin, challenge }),
      }),
    ).toBe(true);
  });

  it("refuses another key, another challenge, another machine id and garbage", () => {
    const signature = proof({ environmentId, origin, challenge });
    const otherKey = ed25519.getPublicKey(Uint8Array.from({ length: 32 }, () => 9));
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey: otherKey,
        environmentId,
        origin,
        challenge,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        origin,
        challenge: challenge.map((byte) => byte ^ 1),
        signature,
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId: "env_other",
        origin,
        challenge,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        origin,
        challenge,
        signature: new Uint8Array(64),
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        origin,
        challenge: new Uint8Array(16),
        signature,
      }),
    ).toBe(false);
  });

  it("refuses a proof made for another origin: a reused address cannot borrow it", () => {
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        origin: "http://100.64.0.9:3773",
        challenge,
        signature: proof({ environmentId, origin, challenge }),
      }),
    ).toBe(false);
    expect(() =>
      encodeDirectRouteIdentityTranscript({
        environmentId,
        origin: "https://studio.tail1.ts.net/path",
        challenge,
      }),
    ).toThrow();
  });

  it("never accepts a signature the node made for another transcript", () => {
    // A node auth proof over the same challenge bytes is not a route proof.
    const authTranscript = encodeNodeAuthenticationTranscript({
      hubOrigin: "https://hub.example",
      protocolMajor: 1,
      protocolMinor: 3,
      nodeId: `node_${"a".repeat(22)}`,
      activeKeyId: `nkey_${"b".repeat(22)}`,
      challengeExpiresAt: 1,
      challenge,
    });
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        origin,
        challenge,
        signature: ed25519.sign(authTranscript, secretKey),
      }),
    ).toBe(false);
  });

  it("refuses to encode a challenge of the wrong length", () => {
    expect(() =>
      encodeDirectRouteIdentityTranscript({ environmentId, origin, challenge: new Uint8Array(31) }),
    ).toThrow();
  });
});
