import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeDirectRouteIdentityTranscript } from "@ryco/shared/directRouteIdentity";
import { describe, expect, it } from "vite-plus/test";

import { decodeBase64Url, encodeBase64Url } from "../relay/base64url.ts";
import {
  proveDirectRouteIdentity,
  type DirectRouteIdentityProofAnswer,
} from "./directRouteIdentity.ts";

const nodeSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
const nodeKey = encodeBase64Url(ed25519.getPublicKey(nodeSecret));
const DIRECT_ID = "env-direct";
const BASE = "https://studio.tail1234.ts.net";

/** A node at the address: signs whatever challenge arrives, for `environmentId`, with `secret`. */
const node =
  (secret = nodeSecret, environmentId = DIRECT_ID) =>
  async ({
    challenge,
  }: {
    readonly challenge: string;
  }): Promise<DirectRouteIdentityProofAnswer> => ({
    kind: "signed",
    signature: encodeBase64Url(
      ed25519.sign(
        encodeDirectRouteIdentityTranscript({
          environmentId,
          challenge: decodeBase64Url(challenge),
        }),
        secret,
      ),
    ),
  });

describe("proveDirectRouteIdentity", () => {
  it("proves an address that signs this client's challenge with the linked key", async () => {
    const challenges: string[] = [];
    const answer = node();
    const outcome = await proveDirectRouteIdentity({
      httpBaseUrl: BASE,
      environmentId: DIRECT_ID,
      nodeIdentityPublicKey: nodeKey,
      requestProof: (request) => {
        expect(request.httpBaseUrl).toBe(BASE);
        challenges.push(request.challenge);
        return answer(request);
      },
    });
    expect(outcome).toBe("proven");
    expect(decodeBase64Url(challenges[0]!).byteLength).toBe(32);
  });

  it("draws a fresh challenge every time, so an earlier answer cannot be replayed", async () => {
    const challenges: string[] = [];
    let recorded: DirectRouteIdentityProofAnswer | undefined;
    const record = node();
    // An impostor that saw one real proof and replays it.
    const replaying = async (request: { readonly challenge: string }) => {
      challenges.push(request.challenge);
      recorded ??= await record(request);
      return recorded;
    };
    const first = await proveDirectRouteIdentity({
      httpBaseUrl: BASE,
      environmentId: DIRECT_ID,
      nodeIdentityPublicKey: nodeKey,
      requestProof: replaying,
    });
    const second = await proveDirectRouteIdentity({
      httpBaseUrl: BASE,
      environmentId: DIRECT_ID,
      nodeIdentityPublicKey: nodeKey,
      requestProof: replaying,
    });
    expect([first, second]).toEqual(["proven", "refused"]);
    expect(challenges[0]).not.toBe(challenges[1]);
  });

  it("refuses another machine's key, a proof for another direct id, and junk", async () => {
    const otherSecret = Uint8Array.from({ length: 32 }, () => 77);
    for (const requestProof of [
      node(otherSecret),
      node(nodeSecret, "env-other"),
      async () => ({ kind: "signed", signature: "%%%" }) as const,
      async () => ({ kind: "signed", signature: encodeBase64Url(new Uint8Array(64)) }) as const,
      async () => ({ kind: "refused" }) as const,
    ]) {
      expect(
        await proveDirectRouteIdentity({
          httpBaseUrl: BASE,
          environmentId: DIRECT_ID,
          nodeIdentityPublicKey: nodeKey,
          requestProof,
        }),
      ).toBe("refused");
    }
    expect(
      await proveDirectRouteIdentity({
        httpBaseUrl: BASE,
        environmentId: DIRECT_ID,
        nodeIdentityPublicKey: "not base64url!",
        requestProof: node(),
      }),
    ).toBe("refused");
  });

  it("reports an address that did not answer as unreachable, not refused", async () => {
    expect(
      await proveDirectRouteIdentity({
        httpBaseUrl: BASE,
        environmentId: DIRECT_ID,
        nodeIdentityPublicKey: nodeKey,
        requestProof: async () => ({ kind: "unreachable" }),
      }),
    ).toBe("unreachable");
  });
});
