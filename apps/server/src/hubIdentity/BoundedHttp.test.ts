import { describe, expect, it } from "vite-plus/test";

import { fetchBoundedJson } from "./BoundedHttp.ts";

const request = new Request("https://hub.example.com/bounded");
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function capturedFailure(
  fetchImplementation: FetchLike,
  options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {},
): Promise<unknown> {
  const marker = new Error("bounded failure");
  let failure: unknown;
  try {
    await fetchBoundedJson(
      fetchImplementation,
      request,
      { method: "GET" },
      (...input: readonly unknown[]) => {
        failure = input[0];
        throw marker;
      },
      options,
    );
  } catch (error) {
    expect(error).toBe(marker);
  }
  return failure;
}

describe("bounded HTTP", () => {
  it("preserves caller cancellation while enforcing its own deadline", async () => {
    const controller = new AbortController();
    const pending = fetchBoundedJson(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
      request,
      { method: "GET", signal: controller.signal },
      () => {
        throw new Error("bounded transport failure");
      },
    );
    controller.abort();
    await expect(pending).rejects.toThrow("bounded transport failure");
  });
  it("distinguishes transport interruption from an invalid completed response", async () => {
    expect(
      await capturedFailure(async () => {
        throw new Error("network canary");
      }),
    ).toEqual({ kind: "transport" });

    expect(
      await capturedFailure(
        async () =>
          new Response("not-json", { status: 503, headers: { "content-type": "text/plain" } }),
      ),
    ).toEqual({ kind: "invalid_response", status: 503 });
  });

  it("classifies abort and body-read failure as transport interruption", async () => {
    expect(
      await capturedFailure(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
        { timeoutMs: 1 },
      ),
    ).toEqual({ kind: "transport" });

    expect(
      await capturedFailure(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("body canary"));
              },
            }),
            { status: 200 },
          ),
      ),
    ).toEqual({ kind: "transport" });
  });

  it("classifies bounded response validation failures without reflecting content", async () => {
    expect(
      await capturedFailure(
        async () => new Response("{}", { headers: { "content-length": "invalid" } }),
      ),
    ).toEqual({ kind: "invalid_response", status: 200 });
    expect(await capturedFailure(async () => new Response(null))).toEqual({
      kind: "invalid_response",
      status: 200,
    });
    expect(
      await capturedFailure(async () => new Response("oversized"), { maxResponseBytes: 2 }),
    ).toEqual({ kind: "invalid_response", status: 200 });
  });

  it("returns a bounded valid response unchanged", async () => {
    await expect(
      fetchBoundedJson(
        async () => Response.json({ status: "ready" }, { status: 201 }),
        request,
        { method: "GET" },
        () => {
          throw new Error("unexpected failure");
        },
      ),
    ).resolves.toEqual({ ok: true, status: 201, value: { status: "ready" } });
  });
});
