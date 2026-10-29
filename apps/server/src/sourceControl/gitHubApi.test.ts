import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Logger, Metric, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { inBackgroundProcessLane, processGovernorMetricNames } from "../processGovernor.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubApi from "./gitHubApi.ts";
import { fakeGitHub } from "./gitHubApiTestServer.ts";

const SENTINEL = "ghp_TEST_SENTINEL";

const ghOutput = (stdout: string, exitCode = 0): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

/** A `VcsProcess` that answers `gh auth token` from `tokens` (one per call, the last repeats). */
const ghTokens = (tokens: ReadonlyArray<string>) => {
  const calls: VcsProcess.VcsProcessInput[] = [];
  const process: VcsProcess.VcsProcessShape = {
    withProcess: () => Effect.die("not used"),
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        const token = tokens[Math.min(calls.length, tokens.length) - 1];
        return token === undefined ? ghOutput("", 1) : ghOutput(`${token}\n`);
      }),
  };
  return { process, calls };
};

const makeApi = (options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly urls: GitHubApi.GitHubApiUrls;
  readonly process?: VcsProcess.VcsProcessShape;
}) =>
  GitHubApi.make.pipe(
    Effect.provideService(GitHubApi.GitHubApiEnvironment, options.env),
    Effect.provideService(GitHubApi.GitHubApiEndpoints, () => options.urls),
    Effect.provideService(VcsProcess.VcsProcess, options.process ?? ghTokens([]).process),
    Effect.provide(FetchHttpClient.layer),
  );

const answered = (outcome: GitHubApi.GitHubApiOutcome): GitHubApi.GitHubApiAnswer => {
  assert.strictEqual(outcome._tag, "Answered", JSON.stringify(outcome));
  return (outcome as Extract<GitHubApi.GitHubApiOutcome, { _tag: "Answered" }>).answer;
};

const metricValue = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number => {
  const snapshot = snapshots.find(
    (item) =>
      item.id === id &&
      Object.entries(attributes).every(([key, value]) => item.attributes?.[key] === value),
  );
  const state = snapshot?.state as
    | { readonly value?: unknown; readonly count?: unknown }
    | undefined;
  if (typeof state?.value === "number") return state.value;
  return typeof state?.count === "number" ? state.count : 0;
};

const graphqlQuery = { query: "query { viewer { login } }", variables: { owner: "acme" } };

describe("gitHubApiUrls", () => {
  it("maps github.com, GHE.com and GitHub Enterprise Server hosts", () => {
    assert.deepStrictEqual(GitHubApi.gitHubApiUrls("github.com"), {
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
    });
    assert.deepStrictEqual(GitHubApi.gitHubApiUrls("octo.ghe.com"), {
      rest: "https://api.octo.ghe.com",
      graphql: "https://api.octo.ghe.com/graphql",
    });
    assert.deepStrictEqual(GitHubApi.gitHubApiUrls("ghes.example:8443"), {
      rest: "https://ghes.example:8443/api/v3",
      graphql: "https://ghes.example:8443/api/graphql",
    });
  });
});

describe("ghEquivalentOutput", () => {
  const printed = (status: number, body: unknown, kind: "graphql" | "rest") => {
    const output = GitHubApi.ghEquivalentOutput(
      {
        status,
        headers: {},
        body: typeof body === "string" ? body : JSON.stringify(body),
        notModified: false,
      },
      kind,
    );
    return { exitCode: Number(output.exitCode), stderr: output.stderr };
  };

  it("prints what `gh api` prints for the same answer", () => {
    assert.deepStrictEqual(printed(200, { data: {} }, "graphql"), { exitCode: 0, stderr: "" });
    assert.deepStrictEqual(
      printed(
        200,
        { data: null, errors: [{ message: "First" }, { message: "Second" }] },
        "graphql",
      ),
      { exitCode: 1, stderr: "gh: First\nSecond\n" },
    );
    assert.deepStrictEqual(printed(404, { message: "Not Found" }, "rest"), {
      exitCode: 1,
      stderr: "gh: Not Found (HTTP 404)\n",
    });
    assert.deepStrictEqual(printed(502, "<html>", "rest"), {
      exitCode: 1,
      stderr: "gh: HTTP 502\n",
    });
    assert.deepStrictEqual(
      printed(403, { message: "API rate limit exceeded for user ID 1." }, "graphql"),
      { exitCode: 1, stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n" },
    );
    // A REST success body is never parsed for errors.
    assert.deepStrictEqual(printed(200, { errors: ["not an error"] }, "rest"), {
      exitCode: 0,
      stderr: "",
    });
  });
});

describe("GitHubApi requests", () => {
  it.effect("sends GraphQL with gh's headers and body, and the token only to its host", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub(() => ({
        body: { data: { viewer: { login: "octo" } } },
        headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-resource": "graphql" },
      }));
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      const answer = answered(
        yield* api.graphql({ host: "github.com", operation: "test", ...graphqlQuery }),
      );
      assert.strictEqual(answer.status, 200);
      assert.include(answer.body, "octo");
      assert.lengthOf(server.requests, 1);
      const request = server.requests[0]!;
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, "/api/graphql");
      assert.strictEqual(request.headers.authorization, `token ${SENTINEL}`);
      assert.strictEqual(request.headers["x-github-api-version"], "2022-11-28");
      assert.strictEqual(request.headers.accept, "*/*");
      assert.strictEqual(request.headers["user-agent"], "Ryco");
      assert.strictEqual(request.headers["content-type"], "application/json; charset=utf-8");
      assert.isUndefined(request.headers["graphql-features"]);
      assert.isUndefined(request.headers.traceparent);
      assert.deepStrictEqual(JSON.parse(request.body), graphqlQuery);
    }),
  );

  it.effect("sends REST reads with the requested API version", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub(() => ({ body: { full_name: "acme/web" } }));
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      answered(
        yield* api.rest({
          host: "github.com",
          operation: "test",
          path: "repos/acme/web?per_page=1&q=author:@me",
          apiVersion: "2026-03-10",
        }),
      );
      const request = server.requests[0]!;
      assert.strictEqual(request.method, "GET");
      assert.strictEqual(request.url, "/api/v3/repos/acme/web?per_page=1&q=author:@me");
      assert.strictEqual(request.headers["x-github-api-version"], "2026-03-10");
      assert.strictEqual(request.headers.accept, "application/vnd.github+json");
    }),
  );

  it.effect("refuses a path that could leave the API root, before any request", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub(() => ({ body: {} }));
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      for (const path of [
        "//evil.example/x",
        "/repos/acme/web",
        "https://evil.example/x",
        "user@evil.example/x",
        "repos/../../x",
        "repos\\..\\x",
        "repos/acme//web",
        // URL parsing resolves percent-encoded dot segments like plain ones.
        "repos/%2e%2e/%2E%2e/x",
        "repos/acme/%2e",
      ]) {
        const exit = yield* Effect.exit(api.rest({ host: "github.com", operation: "test", path }));
        assert.isTrue(Exit.isFailure(exit), path);
      }
      assert.lengthOf(server.requests, 0);
      assert.isFalse(GitHubApi.isSafeGitHubApiPath("repos/%2E%2e/x"));
      assert.isTrue(GitHubApi.isSafeGitHubApiPath("repos/acme/web.js/pulls?q=a%2e@me"));
      assert.isTrue(
        GitHubApi.isWithinGitHubApiRoot(`${server.urls.rest}/repos/a/b`, server.urls.rest),
      );
      assert.isFalse(GitHubApi.isWithinGitHubApiRoot(`${server.origin}/graphql`, server.urls.rest));
      assert.isFalse(
        GitHubApi.isWithinGitHubApiRoot("https://evil.example/api/v3/x", server.urls.rest),
      );
    }),
  );

  it.effect("follows a same-origin redirect and refuses one to another host", () =>
    Effect.gen(function* () {
      const elsewhere = yield* fakeGitHub(() => ({ body: { stolen: true } }));
      const server = yield* fakeGitHub((request) => {
        if (request.url === "/api/v3/repos/old/name") {
          return { status: 307, headers: { location: "/api/v3/repositories/1" } };
        }
        if (request.url === "/api/v3/repos/moved/away") {
          return { status: 301, headers: { location: `${elsewhere.urls.rest}/repos/moved/away` } };
        }
        return { body: { id: 1 } };
      });
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });

      const followed = answered(
        yield* api.rest({ host: "github.com", operation: "test", path: "repos/old/name" }),
      );
      assert.strictEqual(followed.status, 200);
      assert.deepStrictEqual(
        server.requests.map((request) => request.url),
        ["/api/v3/repos/old/name", "/api/v3/repositories/1"],
      );

      const refused = answered(
        yield* api.rest({ host: "github.com", operation: "test", path: "repos/moved/away" }),
      );
      assert.strictEqual(refused.status, 502);
      assert.include(refused.body, "another host");
      assert.lengthOf(elsewhere.requests, 0);
    }),
  );

  it.effect("answers 502 instead of handing a decoder a cut body", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub(() => ({
        bodyBytes: GitHubApi.GITHUB_API_MAX_RESPONSE_BYTES + 1024 * 1024,
      }));
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      const answer = answered(
        yield* api.graphql({ host: "github.com", operation: "test", ...graphqlQuery }),
      );
      assert.strictEqual(answer.status, 502);
      assert.include(answer.body, "longer than 8 MiB");
    }),
  );

  it.effect("times out a host that sends headers and then stalls, and frees the slot", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub(() => ({ stallAfterHeaders: true }));
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      const fiber = yield* api
        .graphql({ host: "github.com", operation: "stall", ...graphqlQuery })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => server.waitForRequests(1));
      assert.strictEqual(api.poolStats().inFlight, 1);
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubApiTimeoutError");
      assert.strictEqual(api.poolStats().inFlight, 0);
    }),
  );

  it.effect("retries a refused gh token once with the new one, and only when it changed", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub((request) =>
        request.headers.authorization === "token ghp_new"
          ? { body: { data: {} } }
          : { status: 401, body: { message: "Bad credentials" } },
      );
      const rotating = ghTokens(["ghp_old", "ghp_new"]);
      const api = yield* makeApi({ env: {}, urls: server.urls, process: rotating.process });
      const answer = answered(
        yield* api.graphql({ host: "github.com", operation: "test", ...graphqlQuery }),
      );
      assert.strictEqual(answer.status, 200);
      assert.deepStrictEqual(
        server.requests.map((request) => request.headers.authorization),
        ["token ghp_old", "token ghp_new"],
      );

      const stale = yield* fakeGitHub(() => ({
        status: 401,
        body: { message: "Bad credentials" },
      }));
      const same = ghTokens(["ghp_same"]);
      const refusing = yield* makeApi({ env: {}, urls: stale.urls, process: same.process });
      const refused = answered(
        yield* refusing.graphql({ host: "github.com", operation: "test", ...graphqlQuery }),
      );
      assert.strictEqual(refused.status, 401);
      assert.lengthOf(stale.requests, 1);
      assert.lengthOf(same.calls, 2);
    }),
  );

  it.effect("keeps a host whose GraphQL endpoint is missing on gh for an hour", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub(() => ({ status: 404, body: { message: "Not Found" } }));
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      const ask = api.graphql({ host: "github.com", operation: "test", ...graphqlQuery });
      assert.deepStrictEqual(yield* ask, { _tag: "Unavailable", reason: "endpoint-missing" });
      yield* TestClock.adjust("59 minutes");
      assert.deepStrictEqual(yield* ask, { _tag: "Unavailable", reason: "endpoint-missing" });
      assert.lengthOf(server.requests, 1);
      yield* TestClock.adjust("2 minutes");
      yield* ask;
      assert.lengthOf(server.requests, 2);
    }),
  );

  it.effect(
    "uses gh after a transport failure: 5 minutes after a refusal, 30 seconds offline",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        let code = "ECONNREFUSED";
        const failingFetch = (() => {
          calls += 1;
          return Promise.reject(new TypeError("fetch failed", { cause: { code } }));
        }) as unknown as typeof globalThis.fetch;
        const api = yield* makeApi({
          env: { GH_TOKEN: SENTINEL },
          urls: { rest: "http://127.0.0.1:9/api/v3", graphql: "http://127.0.0.1:9/api/graphql" },
        });
        const ask = api
          .graphql({ host: "github.com", operation: "test", ...graphqlQuery })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, failingFetch));
        assert.deepStrictEqual(yield* ask, { _tag: "Unavailable", reason: "unreachable" });
        yield* TestClock.adjust("4 minutes");
        assert.deepStrictEqual(yield* ask, { _tag: "Unavailable", reason: "unreachable" });
        assert.strictEqual(calls, 1);
        yield* TestClock.adjust("61 seconds");
        code = "ENOTFOUND";
        yield* ask;
        assert.strictEqual(calls, 2);
        yield* TestClock.adjust("31 seconds");
        yield* ask;
        assert.strictEqual(calls, 3);
      }),
  );

  it.effect("falls back when a real connection is refused", () =>
    Effect.gen(function* () {
      const closed = yield* fakeGitHub(() => ({ body: {} }));
      const urls = closed.urls;
      yield* Effect.promise(() => closed.close());
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls });
      assert.deepStrictEqual(
        yield* api.graphql({ host: "github.com", operation: "test", ...graphqlQuery }),
        { _tag: "Unavailable", reason: "unreachable" },
      );
    }),
  );

  it.effect("admits interactive requests at once while background ones queue per credential", () =>
    Effect.gen(function* () {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      const server = yield* fakeGitHub(async () => {
        await released;
        return { body: { data: {} } };
      });
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      const ask = api.graphql({ host: "github.com", operation: "test", ...graphqlQuery });
      const background = yield* Effect.forEach(Array.from({ length: 9 }), () =>
        ask.pipe(inBackgroundProcessLane, Effect.forkChild),
      );
      yield* Effect.promise(() => server.waitForRequests(8));
      assert.include(api.poolStats(), { inFlight: 8, queued: 1 });
      const interactive = yield* ask.pipe(Effect.forkChild);
      yield* Effect.promise(() => server.waitForRequests(9));
      assert.include(api.poolStats(), { inFlight: 9, queued: 1 });
      const busy = yield* Metric.snapshot;
      assert.strictEqual(
        metricValue(busy, processGovernorMetricNames.inFlight, { pool: "github-api" }),
        9,
      );
      assert.strictEqual(
        metricValue(busy, processGovernorMetricNames.queued, { pool: "github-api" }),
        1,
      );

      release();
      yield* Effect.forEach([...background, interactive], Fiber.join);
      const stats = api.poolStats();
      assert.include(stats, { inFlight: 0, queued: 0, admittedTotal: 10, queuedTotal: 1 });
      assert.deepStrictEqual(stats.admittedByLane, { interactive: 1, background: 9 });
      const idle = yield* Metric.snapshot;
      assert.strictEqual(
        metricValue(idle, processGovernorMetricNames.inFlight, { pool: "github-api" }),
        0,
      );
      assert.strictEqual(
        metricValue(idle, processGovernorMetricNames.queued, { pool: "github-api" }),
        0,
      );
    }),
  );

  it.effect("revalidates REST reads with ETags per credential", () =>
    Effect.gen(function* () {
      const server = yield* fakeGitHub((request) =>
        request.headers["if-none-match"] === '"abc"'
          ? { status: 304, headers: { etag: '"abc"' } }
          : { headers: { etag: '"abc"' }, body: { allow_squash_merge: true } },
      );
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      const read = api.rest({
        host: "github.com",
        operation: "test",
        path: "repos/acme/web",
        revalidate: true,
      });
      const notModifiedBefore = metricValue(
        yield* Metric.snapshot,
        GitHubApi.gitHubApiMetricNames.requestsTotal,
        {
          outcome: "not_modified",
        },
      );
      const first = answered(yield* read);
      assert.isFalse(first.notModified);
      const second = answered(yield* read);
      assert.isTrue(second.notModified);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body, first.body);
      assert.strictEqual(server.requests[1]!.headers["if-none-match"], '"abc"');
      assert.strictEqual(
        metricValue(yield* Metric.snapshot, GitHubApi.gitHubApiMetricNames.requestsTotal, {
          outcome: "not_modified",
        }),
        notModifiedBefore + 1,
      );

      // Another credential never sends this one's validator.
      const other = yield* makeApi({ env: { GH_TOKEN: "ghp_other" }, urls: server.urls });
      yield* other.rest({
        host: "github.com",
        operation: "test",
        path: "repos/acme/web",
        revalidate: true,
      });
      assert.isUndefined(server.requests[2]!.headers["if-none-match"]);
    }),
  );

  it.effect("answers a 304 from the entry it revalidated, even after the cache dropped it", () =>
    Effect.gen(function* () {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let count = 0;
      const server = yield* fakeGitHub(async () => {
        count += 1;
        if (count === 1) return { headers: { etag: '"v1"' }, body: { version: 1 } };
        if (count === 2) {
          await gate;
          return { status: 304, headers: { etag: '"v1"' } };
        }
        // A concurrent read whose answer carries no validator drops the cached entry.
        release();
        return { body: { version: 2 } };
      });
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      const read = api.rest({
        host: "github.com",
        operation: "test",
        path: "repos/acme/web",
        revalidate: true,
      });
      answered(yield* read);
      const revalidating = yield* read.pipe(Effect.forkChild);
      yield* Effect.promise(() => server.waitForRequests(2));
      assert.strictEqual(JSON.parse(answered(yield* read).body).version, 2);

      const notModified = answered(yield* Fiber.join(revalidating));
      assert.strictEqual(server.requests[1]!.headers["if-none-match"], '"v1"');
      assert.isTrue(notModified.notModified);
      assert.strictEqual(notModified.status, 200);
      assert.strictEqual(JSON.parse(notModified.body).version, 1);
    }),
  );

  it.effect("never lets a token reach logs, spans, errors or metrics", () => {
    const logged: unknown[] = [];
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const logger = Logger.layer([
      Logger.make((options) => {
        logged.push({ message: options.message, cause: String(options.cause) });
      }),
    ]);
    return Effect.gen(function* () {
      const server = yield* fakeGitHub((request) =>
        request.body.includes("unauthorized")
          ? { status: 401, body: { message: "Bad credentials" } }
          : request.body.includes("stall")
            ? { stallAfterHeaders: true }
            : { status: 500, body: { message: "Server Error" } },
      );
      const api = yield* makeApi({ env: { GH_TOKEN: SENTINEL }, urls: server.urls });
      // A host of its own, so this test's first transport failure is logged.
      const host = "leak.ghe.com";
      const ask = (query: string) => api.graphql({ host, operation: "leak", query, variables: {} });
      const exits: unknown[] = [];
      exits.push(yield* Effect.exit(ask("unauthorized")));
      exits.push(yield* Effect.exit(ask("server error")));
      const stalled = yield* ask("stall").pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => server.waitForRequests(3));
      yield* TestClock.adjust("31 seconds");
      exits.push(yield* Fiber.join(stalled));
      const offline = yield* makeApi({
        env: { GH_TOKEN: SENTINEL },
        urls: { rest: "http://127.0.0.1:9/api/v3", graphql: "http://127.0.0.1:9/api/graphql" },
      });
      exits.push(
        yield* offline
          .graphql({ host, operation: "leak", query: "q", variables: {} })
          .pipe(
            Effect.provideService(FetchHttpClient.Fetch, (() =>
              Promise.reject(
                new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
              )) as unknown as typeof globalThis.fetch),
            Effect.exit,
          ),
      );
      const metrics = yield* Metric.snapshot;
      const everything = JSON.stringify({
        logged,
        spans: spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
        exits: exits.map((exit) => String(exit)),
        exitJson: exits,
        metrics,
      });
      assert.isAbove(spans.length, 0);
      assert.isAbove(logged.length, 0);
      assert.include(everything, "GitHubApiTimeoutError");
      assert.notInclude(everything, "SENTINEL");
    }).pipe(Effect.withTracer(tracer), Effect.provide(logger));
  });
});
