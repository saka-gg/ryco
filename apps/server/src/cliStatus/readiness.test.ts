import { describe, expect, it } from "vite-plus/test";

import { describeServerReadiness, probeServerReadiness } from "./readiness.ts";

const runtime = { pid: 4242, port: 3773, origin: "http://127.0.0.1:3773" };
const ENVIRONMENT_ID = "env-1234";

const answering =
  (status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []) =>
  async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };

const failing = (name: string) => async () => {
  const error = new Error(name);
  error.name = name;
  throw error;
};

const probe = (overrides: Partial<Parameters<typeof probeServerReadiness>[0]>) =>
  probeServerReadiness({
    runtime,
    environmentId: `${ENVIRONMENT_ID}\n`,
    isRunning: async () => true,
    fetch: answering(200, { environmentId: ENVIRONMENT_ID }),
    ...overrides,
  });

describe("probeServerReadiness", () => {
  it("is ready only when this home's node answers with its own environment id", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const readiness = await probe({
      fetch: answering(200, { environmentId: ENVIRONMENT_ID, label: "box" }, seen),
    });
    expect(readiness).toEqual({ ready: true, reason: null, origin: runtime.origin });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:3773/.well-known/ryco/environment");
    // No credentials, no redirects, bounded.
    expect(seen[0]?.init.redirect).toBe("error");
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(seen[0]?.init.headers ?? {})).not.toMatch(/authorization|cookie/iu);
  });

  it("names each step that failed", async () => {
    expect(await probe({ runtime: undefined })).toMatchObject({
      ready: false,
      reason: "not-running",
      origin: null,
    });
    expect(await probe({ isRunning: async () => false })).toMatchObject({
      reason: "stale-runtime-file",
    });
    expect(await probe({ fetch: failing("TimeoutError") })).toMatchObject({
      reason: "starting",
    });
    expect(await probe({ fetch: answering(503, "starting") })).toMatchObject({
      reason: "starting",
    });
    expect(await probe({ fetch: failing("TypeError") })).toMatchObject({
      reason: "unreachable",
    });
    expect(await probe({ fetch: answering(404, "nope") })).toMatchObject({
      reason: "unreachable",
    });
    expect(await probe({ fetch: answering(200, "<html>") })).toMatchObject({
      reason: "unreachable",
    });
    expect(await probe({ fetch: answering(200, { environmentId: "someone-else" }) })).toMatchObject(
      { reason: "other-node" },
    );
    expect(await probe({ environmentId: undefined })).toMatchObject({ reason: "other-node" });
  });

  it("never sends a request outside plain http(s) without credentials", async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return new Response("{}");
    };
    for (const origin of ["file:///etc", "http://user:secret@127.0.0.1:3773", "not a url"]) {
      expect(await probe({ runtime: { ...runtime, origin }, fetch: counting })).toMatchObject({
        reason: "unreachable",
      });
    }
    expect(calls).toBe(0);
  });

  it("reads plainly", () => {
    expect(describeServerReadiness({ ready: true, reason: null, origin: runtime.origin })).toBe(
      "ready",
    );
    expect(
      describeServerReadiness({ ready: false, reason: "other-node", origin: runtime.origin }),
    ).toBe("not ready: another node answers on this home's port");
  });
});
