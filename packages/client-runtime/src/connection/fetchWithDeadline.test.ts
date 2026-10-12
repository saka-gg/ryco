import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HttpClientService, HttpRequestInit } from "../platform/index.ts";
import {
  ControlPlaneRequestTimeoutError,
  fetchWithDeadline,
  isAbortOrTimeoutError,
} from "./fetchWithDeadline.ts";

/** A fetch that never answers until its signal aborts, the way a browser fetch behaves. */
function hangingClient(seen: Array<AbortSignal | undefined>): HttpClientService {
  return {
    fetch: (_url: string, init?: HttpRequestInit) =>
      new Promise((_resolve, reject) => {
        seen.push(init?.signal);
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
      }),
  };
}

describe("fetchWithDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails a request that never answers once its deadline passes, aborting it", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const pending = fetchWithDeadline(hangingClient(seen), "https://node.test/api", {}, 5_000);
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(seen[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(ControlPlaneRequestTimeoutError);
    expect(isAbortOrTimeoutError(error)).toBe(true);
    // The abandoned request releases its connection.
    expect(seen[0]?.aborted).toBe(true);
  });

  it("covers the response body as well as its headers", async () => {
    let bodyRead: ((value: unknown) => void) | null = null;
    const client: HttpClientService = {
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((resolve, reject) => {
            bodyRead = resolve;
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        text: async () => "",
      }),
    };

    const response = await fetchWithDeadline(client, "https://node.test/api", {}, 1_000);
    const body = response.json().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(bodyRead).not.toBeNull();
    expect(await body).toBeInstanceOf(ControlPlaneRequestTimeoutError);
  });

  it("answers normally and clears its timer once the body is read", async () => {
    const client: HttpClientService = {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token: "t" }),
        text: async () => "",
      }),
    };

    const response = await fetchWithDeadline(client, "https://node.test/api", {}, 1_000);
    expect(await response.json()).toEqual({ token: "t" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases its caller even when the platform fetch ignores the abort signal", async () => {
    const deaf: HttpClientService = { fetch: () => new Promise(() => undefined) };
    const timedOut = fetchWithDeadline(deaf, "https://node.test/api", {}, 1_000).then(
      () => null,
      (error: unknown) => error,
    );
    const caller = new AbortController();
    const cancelled = fetchWithDeadline(
      deaf,
      "https://node.test/api",
      { signal: caller.signal },
      1_000,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    caller.abort();
    expect(((await cancelled) as Error).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timedOut).toBeInstanceOf(ControlPlaneRequestTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still lets the caller cancel early", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const caller = new AbortController();
    const outcome = fetchWithDeadline(
      hangingClient(seen),
      "https://node.test/api",
      { signal: caller.signal },
      5_000,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    caller.abort();
    const error = await outcome;
    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(ControlPlaneRequestTimeoutError);
    expect(seen[0]?.aborted).toBe(true);
  });
});
