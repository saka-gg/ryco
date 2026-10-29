/**
 * A local fake GitHub API (`node:http` on 127.0.0.1) for tests and the
 * transport benchmark. It records every request and answers from a handler;
 * nothing here ever talks to the real GitHub.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { Effect } from "effect";

import type { GitHubApiUrls } from "./gitHubApi.ts";

export interface FakeGitHubRequest {
  readonly method: string;
  /** Path and query, as sent. */
  readonly url: string;
  /** Lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeGitHubResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** A string is sent as is; anything else as JSON. */
  readonly body?: unknown;
  /** Send this many bytes of `x` instead of `body` (oversized answers). */
  readonly bodyBytes?: number;
  /** Delay before answering. */
  readonly delayMs?: number;
  /** Send the status and headers, then never finish the body. */
  readonly stallAfterHeaders?: boolean;
}

export type FakeGitHubHandler = (
  request: FakeGitHubRequest,
) => FakeGitHubResponse | Promise<FakeGitHubResponse>;

export interface FakeGitHub {
  readonly origin: string;
  readonly requests: ReadonlyArray<FakeGitHubRequest>;
  /** Resolves once `count` requests in total have arrived. */
  readonly waitForRequests: (count: number) => Promise<void>;
  /** Endpoints laid out like GitHub Enterprise Server (`/api/v3`, `/api/graphql`). */
  readonly urls: GitHubApiUrls;
  readonly close: () => Promise<void>;
}

const flatHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]],
    ),
  );

export async function startFakeGitHub(handler: FakeGitHubHandler): Promise<FakeGitHub> {
  const requests: FakeGitHubRequest[] = [];
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request: FakeGitHubRequest = {
        method: incoming.method ?? "GET",
        url: incoming.url ?? "/",
        headers: flatHeaders(incoming.headers),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(request);
      for (const waiter of waiters.splice(0)) {
        if (requests.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
      void Promise.resolve(handler(request)).then(async (response) => {
        if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
        if (outgoing.destroyed) return;
        const body =
          response.bodyBytes !== undefined
            ? Buffer.alloc(response.bodyBytes, "x")
            : response.body === undefined
              ? Buffer.alloc(0)
              : Buffer.from(
                  typeof response.body === "string" ? response.body : JSON.stringify(response.body),
                );
        outgoing.writeHead(response.status ?? 200, {
          "content-type": "application/json; charset=utf-8",
          ...response.headers,
        });
        if (response.stallAfterHeaders) {
          outgoing.flushHeaders();
          outgoing.write(" ");
          return;
        }
        outgoing.end(body);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    waitForRequests: (count) =>
      requests.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve })),
    urls: { rest: `${origin}/api/v3`, graphql: `${origin}/api/graphql` },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** {@link startFakeGitHub} for the scope of an Effect test. */
export const fakeGitHub = (handler: FakeGitHubHandler) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeGitHub(handler)),
    (server) => Effect.promise(() => server.close()),
  );
