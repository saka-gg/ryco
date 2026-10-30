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

function proof(input: { readonly environmentId: string; readonly challenge: Uint8Array }) {
  return ed25519.sign(encodeDirectRouteIdentityTranscript(input), secretKey);
}

describe("direct route identity proof", () => {
  it("encodes the domain, the direct id and the challenge, in that order", () => {
    const decoded = decode(encodeDirectRouteIdentityTranscript({ environmentId, challenge }));
    expect(decoded).toEqual([DIRECT_ROUTE_IDENTITY_TRANSCRIPT_DOMAIN, environmentId, challenge]);
  });

  it("accepts the node key's signature over this client's challenge for this machine", () => {
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        challenge,
        signature: proof({ environmentId, challenge }),
      }),
    ).toBe(true);
  });

  it("refuses another key, another challenge, another machine id and garbage", () => {
    const signature = proof({ environmentId, challenge });
    const otherKey = ed25519.getPublicKey(Uint8Array.from({ length: 32 }, () => 9));
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey: otherKey,
        environmentId,
        challenge,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        challenge: challenge.map((byte) => byte ^ 1),
        signature,
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId: "env_other",
        challenge,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        challenge,
        signature: new Uint8Array(64),
      }),
    ).toBe(false);
    expect(
      verifyDirectRouteIdentityProof({
        nodeIdentityPublicKey,
        environmentId,
        challenge: new Uint8Array(16),
        signature,
      }),
    ).toBe(false);
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
        challenge,
        signature: ed25519.sign(authTranscript, secretKey),
      }),
    ).toBe(false);
  });

  it("refuses to encode a challenge of the wrong length", () => {
    expect(() =>
      encodeDirectRouteIdentityTranscript({ environmentId, challenge: new Uint8Array(31) }),
    ).toThrow();
  });
});
