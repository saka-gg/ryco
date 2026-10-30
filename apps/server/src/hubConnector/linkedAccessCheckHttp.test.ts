import { describe, expect, it } from "vite-plus/test";

import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import { makeLinkedAccessAsker } from "./linkedAccessCheckHttp.ts";

const proof = () => ({
  type: "auth" as const,
  peer: "node" as const,
  nodeId: "node_1",
  protocolMajor: 1,
  protocolMinor: 3,
  nonce: new Uint8Array(32).fill(1),
  signature: new Uint8Array(64).fill(2),
});

function asker(respond: () => Response) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const ask = makeLinkedAccessAsker({
    hubOrigin: "https://hub.example",
    identity: {
      createRelayAuthenticationFrame: async () => proof(),
    } as unknown as HubIdentityRuntimeShape,
    connector: {
      asIdentityOwner: <A>(operation: () => Promise<A>) => operation(),
    } as unknown as HubConnector,
    signal: new AbortController().signal,
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return respond();
    }) as unknown as typeof fetch,
  });
  return { ask, requests };
}

const subjects = [
  {
    accountId: "acct_1",
    enrollmentId: `enr_${"a".repeat(22)}` as never,
    clientFingerprint: "f".repeat(43),
  },
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("linked access check over HTTPS", () => {
  it("asks with a fresh node proof and reads one status per device", async () => {
    const { ask, requests } = asker(() =>
      json(200, { protocolVersion: 1, results: [{ status: "active", role: "operator" }] }),
    );

    expect(await ask(subjects)).toEqual({
      kind: "answered",
      results: [{ status: "active", role: "operator" }],
    });
    expect(requests).toEqual([
      {
        url: "https://hub.example/api/node/linked-access/check",
        body: {
          subjects,
          proof: {
            nodeId: "node_1",
            protocolMajor: 1,
            protocolMinor: 3,
            nonce: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
            signature: Buffer.from(new Uint8Array(64).fill(2)).toString("base64url"),
          },
        },
      },
    ]);
  });

  it("tells a Hub without the route apart from a failed or garbled answer", async () => {
    expect(await asker(() => new Response("Not found", { status: 404 })).ask(subjects)).toEqual({
      kind: "unsupported",
    });
    expect(await asker(() => json(404, { error: "not_found" })).ask(subjects)).toEqual({
      kind: "unsupported",
    });
    expect(await asker(() => json(503, { error: "busy" })).ask(subjects)).toEqual({
      kind: "failed",
    });
    expect(
      await asker(() =>
        json(200, { protocolVersion: 1, results: [{ status: "active", role: "admin" }] }),
      ).ask(subjects),
    ).toEqual({ kind: "failed" });
  });
});
