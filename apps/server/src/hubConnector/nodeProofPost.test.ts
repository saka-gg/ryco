import { describe, expect, it } from "vite-plus/test";

import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import { postWithNodeProof, serializeWithNodeProof, type NodeProof } from "./nodeProofPost.ts";

const makeProof = () => ({
  type: "auth" as const,
  peer: "node" as const,
  nodeId: "node_1" as NodeProof["nodeId"],
  protocolMajor: 1,
  protocolMinor: 3,
  nonce: new Uint8Array(32).fill(1),
  signature: new Uint8Array(64).fill(2),
});

const wiped = (proof: { nonce: Uint8Array; signature: Uint8Array }) =>
  proof.nonce.every((byte) => byte === 0) && proof.signature.every((byte) => byte === 0);

function deps(options: {
  readonly respond?: () => Promise<Response>;
  readonly proofFails?: boolean;
}) {
  const proofs: Array<ReturnType<typeof makeProof>> = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  return {
    proofs,
    requests,
    deps: {
      hubOrigin: "https://hub.example",
      identity: {
        createRelayAuthenticationFrame: async () => {
          if (options.proofFails) throw new Error("identity unavailable");
          const proof = makeProof();
          proofs.push(proof);
          return proof;
        },
      } as unknown as HubIdentityRuntimeShape,
      connector: {
        asIdentityOwner: <A>(operation: () => Promise<A>) => operation(),
      } as unknown as HubConnector,
      signal: new AbortController().signal,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return options.respond
          ? options.respond()
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
    },
  };
}

describe("node-proof POST", () => {
  it("sends the body with the encoded proof and returns the answer", async () => {
    const harness = deps({});
    const result = await postWithNodeProof(harness.deps, {
      path: "/api/node/x",
      body: { sequence: 4 },
    });
    expect(result).toEqual({ ok: true, value: { ok: true } });
    expect(harness.requests[0]!.url).toBe("https://hub.example/api/node/x");
    expect(JSON.parse(String(harness.requests[0]!.init.body))).toEqual({
      sequence: 4,
      proof: {
        nodeId: "node_1",
        protocolMajor: 1,
        protocolMinor: 3,
        nonce: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
        signature: Buffer.from(new Uint8Array(64).fill(2)).toString("base64url"),
      },
    });
    expect(harness.requests[0]!.init.redirect).toBe("error");
    expect(wiped(harness.proofs[0]!)).toBe(true);
  });

  it("keeps a non-JSON error status and wipes the proof", async () => {
    const harness = deps({ respond: async () => new Response("Not Found", { status: 404 }) });
    expect(await postWithNodeProof(harness.deps, { path: "/x", body: {} })).toEqual({
      ok: false,
      status: 404,
    });
    expect(wiped(harness.proofs[0]!)).toBe(true);
  });

  it("reports status 0 without a connection or without a proof, and wipes what it made", async () => {
    const offline = deps({ respond: () => Promise.reject(new Error("offline")) });
    expect(await postWithNodeProof(offline.deps, { path: "/x", body: {} })).toEqual({
      ok: false,
      status: 0,
    });
    expect(wiped(offline.proofs[0]!)).toBe(true);

    const noProof = deps({ proofFails: true });
    expect(await postWithNodeProof(noProof.deps, { path: "/x", body: {} })).toEqual({
      ok: false,
      status: 0,
    });
    expect(noProof.requests).toHaveLength(0);
  });

  it("wipes the proof when the body cannot be serialized", async () => {
    const proof = makeProof();
    expect(() => serializeWithNodeProof(proof, { size: 1n })).toThrow();
    expect(wiped(proof)).toBe(true);

    const harness = deps({});
    expect(await postWithNodeProof(harness.deps, { path: "/x", body: { size: 1n } })).toEqual({
      ok: false,
      status: 0,
    });
    expect(harness.requests).toHaveLength(0);
    expect(wiped(harness.proofs[0]!)).toBe(true);
  });
});
