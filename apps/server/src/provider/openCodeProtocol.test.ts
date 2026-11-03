import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import type { OpenCodeApi } from "./openCodeApi.ts";
import {
  checkOpenCodeServerVersion,
  detectOpenCodeApi,
  detectOpenCodeServerApi,
  OPENCODE_REJECTED_PASSWORD_MESSAGE,
  OPENCODE_VERSION_CHECK_TIMEOUT_MESSAGE,
} from "./openCodeProtocol.ts";

const BASE_URL = "http://127.0.0.1:4096";
// Unknown paths serve the web app shell (recorded from 1.18.32 and 2.0.18 by t3code).
const SPA_HTML = '<!doctype html>\n<html lang="en">\n';

interface Recorded {
  readonly url: string;
  readonly authorization: string | null;
  readonly signal: AbortSignal | null | undefined;
}

type Route = () => Response;
type Fetch = NonNullable<Parameters<typeof detectOpenCodeApi>[0]["fetch"]>;

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error("expected a rejection");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const html = (status = 200) =>
  new Response(SPA_HTML, { status, headers: { "content-type": "text/html" } });
const empty = (status: number) => new Response(null, { status });

const V1_HEALTH = () => json({ healthy: true, version: "1.18.32" });
const V2_INFO = () =>
  json({ version: "2.2.0", pid: 2393556, urls: ["http://127.0.0.1:48771"], paths: {} });

/** A fake server keyed by path; unknown paths answer 404. */
function fakeServer(routes: Readonly<Record<string, Route>>) {
  const requests: Array<Recorded> = [];
  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      authorization: new Headers(init.headers).get("authorization"),
      signal: init.signal,
    });
    const route = routes[new URL(url).pathname];
    return route ? route() : empty(404);
  };
  return { fetch, requests, paths: () => requests.map((request) => new URL(request.url).pathname) };
}

const detect = (
  server: ReturnType<typeof fakeServer>,
  input: Partial<Parameters<typeof detectOpenCodeApi>[0]> = {},
) => detectOpenCodeApi({ baseUrl: BASE_URL, fetch: server.fetch, ...input });

describe("detectOpenCodeApi", () => {
  it("identifies a 1.x server by its health route without touching unknown paths", async () => {
    const server = fakeServer({ "/global/health": V1_HEALTH, "/api/info": html });
    await expect(detect(server)).resolves.toEqual({ generation: "v1" });
    expect(server.paths()).toEqual(["/global/health"]);
  });

  it("identifies a 2.x server on /api/info after its web app answers the health route", async () => {
    const server = fakeServer({ "/global/health": html, "/api/info": V2_INFO });
    await expect(detect(server)).resolves.toEqual({ generation: "v2", version: "2.2.0" });
    expect(server.paths()).toEqual(["/global/health", "/api/info"]);
  });

  it("normalises a v-prefixed 2.x version", async () => {
    const server = fakeServer({
      "/global/health": html,
      "/api/info": () => json({ version: "v2.3.1", pid: 7 }),
    });
    await expect(detect(server)).resolves.toEqual({ generation: "v2", version: "2.3.1" });
  });

  it("still asks /api/info when the health route reports 2.x", async () => {
    const server = fakeServer({
      "/global/health": () => json({ healthy: true, version: "2.2.0" }),
      "/api/info": V2_INFO,
    });
    await expect(detect(server)).resolves.toEqual({ generation: "v2", version: "2.2.0" });
    // A server that reports 2.x on the 1.x route but does not identify itself as 2.x stays on
    // the 1.x client, whose version check refuses it before any mutation.
    const impostor = fakeServer({
      "/global/health": () => json({ healthy: true, version: "2.2.0" }),
      "/api/info": html,
    });
    await expect(detect(impostor)).resolves.toEqual({ generation: "v1" });
  });

  it("classifies /api/info JSON by its version major", async () => {
    const server = fakeServer({
      "/global/health": html,
      "/api/info": () => json({ version: "1.18.32", pid: 1 }),
    });
    await expect(detect(server)).resolves.toEqual({ generation: "v1" });
  });

  it("fails closed for 3.x and unparseable versions on /api/info", async () => {
    const future = fakeServer({
      "/global/health": html,
      "/api/info": () => json({ version: "3.0.0", pid: 1 }),
    });
    await expect(detect(future)).rejects.toThrow(
      "OpenCode v3.0.0 is not supported by this Ryco release.",
    );
    const garbage = fakeServer({
      "/global/health": html,
      "/api/info": () => json({ version: "nightly", pid: 1 }),
    });
    await expect(detect(garbage)).rejects.toThrow('unrecognized version "nightly"');
  });

  it("falls back to 1.x for an HTML app shell, 404, 405 and JSON of another shape", async () => {
    for (const info of [
      html,
      () => empty(404),
      () => empty(405),
      () => json({ version: "2.2.0" }),
      () => json({ version: "2.2.0", pid: "1" }),
      () => new Response("{not json", { headers: { "content-type": "application/json" } }),
    ]) {
      const server = fakeServer({ "/global/health": html, "/api/info": info });
      await expect(detect(server)).resolves.toEqual({ generation: "v1" });
    }
  });

  it("does not trust JSON on a non-200 status", async () => {
    const server = fakeServer({
      "/global/health": html,
      "/api/info": () => json({ version: "2.2.0", pid: 1 }, 202),
    });
    await expect(detect(server)).resolves.toEqual({ generation: "v1" });
  });

  it("refuses a rejected password with fixed text that leaks neither URL nor credentials", async () => {
    const password = "hunter2-secret";
    for (const status of [401, 403]) {
      for (const routes of [
        { "/global/health": () => empty(status) },
        { "/global/health": html, "/api/info": () => json({ message: "denied" }, status) },
      ]) {
        const server = fakeServer(routes);
        const error = await rejection(detect(server, { serverPassword: password }));
        expect(error.message).toBe(OPENCODE_REJECTED_PASSWORD_MESSAGE);
        const authorization = server.requests[0]!.authorization!;
        for (const secret of [password, authorization.slice("Basic ".length), "127.0.0.1"]) {
          expect(error.message).not.toContain(secret);
        }
      }
    }
  });

  it("names any other status without the URL", async () => {
    const server = fakeServer({
      "/global/health": () => empty(500),
      "/api/info": () => empty(502),
    });
    await expect(detect(server)).rejects.toThrow("The OpenCode server returned HTTP 502.");
  });

  it("detects a 2.x server whose health route fails", async () => {
    // With its embedded web app disabled, OpenCode proxies unknown paths upstream; offline that
    // answers 500.
    const server = fakeServer({ "/global/health": () => empty(500), "/api/info": V2_INFO });
    await expect(detect(server)).resolves.toEqual({ generation: "v2", version: "2.2.0" });
  });

  it("asks /api/info first when 2.x is likely, and still identifies a 1.x server", async () => {
    const likely = { likelyGeneration: "v2" } as const;
    const v2 = fakeServer({ "/global/health": html, "/api/info": V2_INFO });
    await expect(detect(v2, likely)).resolves.toEqual({ generation: "v2", version: "2.2.0" });
    expect(v2.paths()).toEqual(["/api/info"]);

    for (const info of [html, () => empty(404), () => empty(500)]) {
      const v1 = fakeServer({ "/global/health": V1_HEALTH, "/api/info": info });
      await expect(detect(v1, likely)).resolves.toEqual({ generation: "v1" });
      expect(v1.paths()).toEqual(["/api/info", "/global/health"]);
    }

    // Neither route identifies the server: the /api/info status decides, as in the usual order.
    const shell = fakeServer({ "/global/health": html, "/api/info": () => empty(404) });
    await expect(detect(shell, likely)).resolves.toEqual({ generation: "v1" });
    const broken = fakeServer({ "/global/health": html, "/api/info": () => empty(502) });
    await expect(detect(broken, likely)).rejects.toThrow("The OpenCode server returned HTTP 502.");
  });

  it("asks a server of an expected generation on that generation's route only", async () => {
    // The other route is the server's catch-all, which can forward the password upstream, so it is
    // never asked, also when the expected route answers with something else.
    const both = { "/global/health": V1_HEALTH, "/api/info": V2_INFO };
    const cases = [
      ["v2", { ...both }, { generation: "v2", version: "2.2.0" }],
      // Not a 2.x answer: 1.x, which the caller refuses for a 2.x binary.
      ["v2", { ...both, "/api/info": html }, { generation: "v1" }],
      ["v2", { ...both, "/api/info": () => empty(404) }, { generation: "v1" }],
      ["v2", { ...both, "/api/info": () => empty(500) }, "The OpenCode server returned HTTP 500."],
      ["v1", { ...both }, { generation: "v1" }],
      // The 1.x client's strict health check names a 2xx answer that is not 1.x health.
      ["v1", { ...both, "/global/health": html }, { generation: "v1" }],
      [
        "v1",
        { ...both, "/global/health": () => empty(502) },
        "The OpenCode server returned HTTP 502.",
      ],
    ] as const;
    for (const [expectedGeneration, routes, outcome] of cases) {
      const server = fakeServer(routes);
      const detection = detect(server, { expectedGeneration, likelyGeneration: "v2" });
      if (typeof outcome === "string") {
        await expect(detection).rejects.toThrow(outcome);
      } else {
        await expect(detection).resolves.toEqual(outcome);
      }
      expect(server.paths()).toEqual([
        expectedGeneration === "v2" ? "/api/info" : "/global/health",
      ]);
    }
  });

  it("maps a network failure to fixed text", async () => {
    const fetch: Fetch = async (input) => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${String(input)}`);
    };
    const error = await rejection(detectOpenCodeApi({ baseUrl: BASE_URL, fetch }));
    expect(error.message).toBe("Couldn't reach the OpenCode server.");
  });

  it("names credentials in the URL, which Node's fetch refuses, without echoing them", async () => {
    const fetch: Fetch = async (input) => {
      throw new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${String(input)}`,
      );
    };
    const error = await rejection(
      detectOpenCodeApi({ baseUrl: "http://opencode:url-secret@127.0.0.1:4096", fetch }),
    );
    expect(error.message).toBe(
      "The OpenCode server URL includes credentials. Remove them and set the server password instead.",
    );
  });

  it("aborts with the caller's signal", async () => {
    const controller = new AbortController();
    const fetch: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        controller.abort();
      });
    await expect(
      detectOpenCodeApi({ baseUrl: BASE_URL, fetch, signal: controller.signal }),
    ).rejects.toThrow("Couldn't reach the OpenCode server.");
  });

  it("keeps a path prefix and drops trailing slashes", async () => {
    const server = fakeServer({ "/proxy/global/health": html, "/proxy/api/info": V2_INFO });
    await expect(detect(server, { baseUrl: "http://host.test/proxy//" })).resolves.toEqual({
      generation: "v2",
      version: "2.2.0",
    });
    expect(server.requests.map((request) => request.url)).toEqual([
      "http://host.test/proxy/global/health",
      "http://host.test/proxy/api/info",
    ]);
  });

  it("sends UTF-8 basic auth for a non-Latin-1 password and none without a password", async () => {
    const server = fakeServer({ "/global/health": V1_HEALTH });
    await detect(server, { serverPassword: "pässwörd✓" });
    expect(server.requests[0]!.authorization).toBe(
      `Basic ${Buffer.from("opencode:pässwörd✓", "utf8").toString("base64")}`,
    );
    const open = fakeServer({ "/global/health": V1_HEALTH });
    await detect(open, { serverPassword: "" });
    expect(open.requests[0]!.authorization).toBeNull();
  });

  it("cancels bodies it does not read", async () => {
    let cancelled = 0;
    const streamed = (status: number, contentType: string) => () =>
      new Response(
        new ReadableStream({
          pull: (controller) => controller.enqueue(new TextEncoder().encode(SPA_HTML)),
          cancel: () => {
            cancelled += 1;
          },
        }),
        { status, headers: { "content-type": contentType } },
      );
    const server = fakeServer({
      "/global/health": streamed(200, "text/html"),
      "/api/info": streamed(404, "application/json"),
    });
    await expect(detect(server)).resolves.toEqual({ generation: "v1" });
    expect(cancelled).toBe(2);
  });

  it("refuses a URL that is not http(s) before any request", async () => {
    const server = fakeServer({});
    await expect(detect(server, { baseUrl: "file:///tmp/opencode.sock" })).rejects.toThrow(
      "The OpenCode server URL is not a valid http:// or https:// URL.",
    );
    await expect(detect(server, { baseUrl: "not a url" })).rejects.toThrow("not a valid");
    expect(server.requests).toEqual([]);
  });

  it("detects a 2.x server over real HTTP with the global fetch", async () => {
    const seen: Array<string> = [];
    const server = createServer((request, response) => {
      seen.push(`${request.url} ${request.headers.authorization ?? "-"}`);
      if (request.url === "/api/info") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ version: "2.2.0", pid: process.pid, urls: [] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SPA_HTML.repeat(4_096));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await expect(
        detectOpenCodeApi({ baseUrl: `http://127.0.0.1:${port}/`, serverPassword: "pw" }),
      ).resolves.toEqual({ generation: "v2", version: "2.2.0" });
      const authorization = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
      expect(seen).toEqual([`/global/health ${authorization}`, `/api/info ${authorization}`]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/** A fetch that never answers and records the signal it was given. */
function hangingFetch() {
  const signals: Array<AbortSignal> = [];
  const fetch: Fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { fetch, signals };
}

describe("detectOpenCodeServerApi", () => {
  it("asks first for the route of the generation last detected at the same URL", async () => {
    const routes: Record<string, Route> = { "/global/health": html, "/api/info": V2_INFO };
    const server = fakeServer(routes);
    const run = async (baseUrl: string) => {
      const start = server.requests.length;
      const detection = await Effect.runPromise(
        detectOpenCodeServerApi({ baseUrl, fetch: server.fetch }),
      );
      return { detection, paths: server.paths().slice(start) };
    };
    const v2 = { generation: "v2", version: "2.2.0" };

    await expect(run("http://memo.test:4096")).resolves.toEqual({
      detection: v2,
      paths: ["/global/health", "/api/info"],
    });
    // Remembered per origin and path prefix, whatever the trailing slashes.
    await expect(run("http://memo.test:4096/")).resolves.toEqual({
      detection: v2,
      paths: ["/api/info"],
    });
    await expect(run("http://memo.test:4097")).resolves.toEqual({
      detection: v2,
      paths: ["/global/health", "/api/info"],
    });

    // The server changed generation: one extra request, then the usual order again.
    routes["/global/health"] = V1_HEALTH;
    routes["/api/info"] = html;
    await expect(run("http://memo.test:4096")).resolves.toEqual({
      detection: { generation: "v1" },
      paths: ["/api/info", "/global/health"],
    });
    await expect(run("http://memo.test:4096")).resolves.toEqual({
      detection: { generation: "v1" },
      paths: ["/global/health"],
    });
  });

  effectIt.effect("times out a server that never answers and aborts its request", () =>
    Effect.gen(function* () {
      const { fetch, signals } = hangingFetch();
      const fiber = yield* detectOpenCodeServerApi({ baseUrl: BASE_URL, fetch }).pipe(
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("4 seconds");
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error.operation).toBe("api.detect");
      expect(error.detail).toBe(OPENCODE_VERSION_CHECK_TIMEOUT_MESSAGE);
      expect(signals[0]!.aborted).toBe(true);
    }),
  );
});

describe("checkOpenCodeServerVersion", () => {
  effectIt.effect("times out a health check that never answers and aborts it", () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal> = [];
      const client = {
        global: {
          health: ({ signal }: { readonly signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signals.push(signal);
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        },
      } as unknown as OpenCodeApi;
      const fiber = yield* checkOpenCodeServerVersion(client).pipe(
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.operation).toBe("global.health");
      expect(error.detail).toBe(OPENCODE_VERSION_CHECK_TIMEOUT_MESSAGE);
      expect(signals[0]!.aborted).toBe(true);
    }),
  );
});
