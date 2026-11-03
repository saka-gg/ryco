import { describe, expect, it } from "vite-plus/test";

import type { HubConnector } from "../hubConnector/HubConnector.ts";
import type { HubIdentityRuntimeShape } from "../hubConnector/HubIdentityRuntime.ts";
import { makeAttentionSignalSender } from "./attentionSignalHttp.ts";

const proof = () => ({
  type: "auth" as const,
  peer: "node" as const,
  nodeId: "node_1",
  protocolMajor: 1,
  protocolMinor: 3,
  nonce: new Uint8Array(32).fill(1),
  signature: new Uint8Array(64).fill(2),
});

function sender(respond: (body: unknown) => Response) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const send = makeAttentionSignalSender({
    hubOrigin: "https://hub.example",
    identity: {
      createRelayAuthenticationFrame: async () => proof(),
    } as unknown as HubIdentityRuntimeShape,
    connector: {
      asIdentityOwner: <A>(operation: () => Promise<A>) => operation(),
    } as unknown as HubConnector,
    signal: new AbortController().signal,
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url, body });
      return respond(body);
    }) as unknown as typeof fetch,
  });
  return { send, requests };
}

const signal = {
  sequence: 42,
  issuedAt: 1_000,
  deliveries: [
    {
      enrollmentId: "enr_device00000000000000000" as never,
      sealed: "A".repeat(80),
      collapseId: "B".repeat(22),
    },
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("attention signal over HTTPS", () => {
  it("posts the signal with a fresh node proof and reads the per-device results", async () => {
    const { send, requests } = sender(() =>
      json(200, {
        protocolVersion: 1,
        sequence: 42,
        results: [{ enrollmentId: "enr_device00000000000000000", status: "sent" }],
      }),
    );
    const outcome = await send(signal);
    expect(outcome.kind).toBe("delivered");
    expect(requests[0]!.url).toBe("https://hub.example/api/node/attention/signal");
    expect(requests[0]!.body).toMatchObject({
      sequence: 42,
      proof: { nodeId: "node_1", protocolMajor: 1, protocolMinor: 3 },
    });
  });

  it("tells an older Hub, a refusal and a failure apart", async () => {
    expect((await sender(() => new Response("Not Found", { status: 404 })).send(signal)).kind).toBe(
      "unsupported",
    );
    expect((await sender(() => json(403, { error: "forbidden" })).send(signal)).kind).toBe(
      "refused",
    );
    expect((await sender(() => json(503, { error: "busy" })).send(signal)).kind).toBe("failed");
    // An answer for another sequence is not this signal's answer.
    expect(
      (
        await sender(() => json(200, { protocolVersion: 1, sequence: 41, results: [] })).send(
          signal,
        )
      ).kind,
    ).toBe("failed");
  });
});
