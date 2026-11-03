/**
 * Direct HTTPS transport for GitHub reads, with the token gh already has.
 *
 * Every answer is the raw `{status, headers, body}` GitHub sent; `GitHubCli`
 * turns it into the stdout/stderr/exit gh would have printed for it
 * ({@link ghEquivalentOutput}) and runs the same decoders and error rules, so
 * both transports behave alike. Whenever no answer exists without guessing (no
 * credential, a proxy `fetch` would skip, the host unreachable, a GraphQL
 * endpoint elsewhere) the outcome is `Unavailable` and the caller runs its
 * exact gh call instead.
 *
 * Safety rules, each tested: a token is sent only to the HTTPS API root of the
 * host it was resolved for; redirects to another origin are never followed;
 * Effect's HTTP tracer is off (URLs carry SHAs and branch names) and our own
 * span carries the operation, never the path; answers are capped at 8 MiB.
 */
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { logOnceEvery } from "../logOnceEvery.ts";
import {
  ProcessLaneRef,
  ProcessPool,
  governWithPool,
  publishPoolGauges,
  type ProcessPoolStats,
} from "../processGovernor.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  makeGitHubCredentials,
  normalizeGitHubHost,
  type GitHubCredential,
  type GitHubCredentialUnavailable,
  type GitHubEnvironment,
} from "./gitHubCredentials.ts";
import {
  encodeGitHubGraphQlRequest,
  type GitHubGraphQlVariables,
} from "./gitHubPullRequestMutations.ts";

/** Per credential (T3 uses 8 for every host and account together). */
export const GITHUB_API_CONCURRENCY_PER_CREDENTIAL = 8;
/** Headers and body together; the same as a gh call's default timeout. */
export const GITHUB_API_TIMEOUT_MS = 30_000;
export const GITHUB_API_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** What `gh api` sends unless told otherwise. */
export const GITHUB_API_DEFAULT_VERSION = "2022-11-28";
export const GITHUB_API_ETAG_CAPACITY = 512;
export const GITHUB_API_ETAG_TTL_MS = 60 * 60_000;
/** Larger answers are not kept for revalidation, so the cache stays small (512 × 256 KiB at most). */
export const GITHUB_API_ETAG_MAX_BODY_CHARS = 256 * 1024;
/** A TLS, reset or connect-timeout failure keeps the host on gh this long. */
export const GITHUB_API_UNREACHABLE_TTL_MS = 5 * 60_000;
/** No DNS or no route (offline laptop): retried soon after the network returns. */
export const GITHUB_API_OFFLINE_TTL_MS = 30_000;
/** The GraphQL endpoint answered 404: it lives elsewhere (gh `api_host` setups). */
export const GITHUB_API_ENDPOINT_MISSING_TTL_MS = 60 * 60_000;
export const GITHUB_API_MAX_REDIRECTS = 3;
export const GITHUB_API_POOL_LABEL = "github-api";
/** Credential pools kept; idle ones beyond this are dropped oldest first. */
export const GITHUB_API_POOL_CAPACITY = 32;
const CIRCUIT_CAPACITY = 64;

export interface GitHubApiUrls {
  /** REST root, no trailing slash. */
  readonly rest: string;
  readonly graphql: string;
}

/** github.com and GHE.com serve the API from `api.<host>`; GitHub Enterprise Server under `/api`. */
export function gitHubApiUrls(host: string): GitHubApiUrls {
  if (host === "github.com") {
    return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" };
  }
  if (host.endsWith(".ghe.com")) {
    return { rest: `https://api.${host}`, graphql: `https://api.${host}/graphql` };
  }
  return { rest: `https://${host}/api/v3`, graphql: `https://${host}/api/graphql` };
}

/**
 * Where a host's API lives. Code-only (tests point it at a local fake GitHub);
 * never read from the environment, settings or flags, so no user input can
 * send a token anywhere else.
 */
export const GitHubApiEndpoints = Context.Reference<(host: string) => GitHubApiUrls>(
  "ryco/source-control/GitHubApiEndpoints",
  { defaultValue: () => gitHubApiUrls },
);

/** The environment tokens are read from: `process.env` in production, a literal in tests. */
export const GitHubApiEnvironment = Context.Reference<GitHubEnvironment>(
  "ryco/source-control/GitHubApiEnvironment",
  { defaultValue: () => process.env },
);

export interface GitHubApiAnswer {
  readonly status: number;
  /** Lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** REST only: the body came from the revalidation cache after a 304. */
  readonly notModified: boolean;
}

export type GitHubApiUnavailable = GitHubCredentialUnavailable | "unreachable" | "endpoint-missing";

export type GitHubApiOutcome =
  | { readonly _tag: "Answered"; readonly answer: GitHubApiAnswer }
  | { readonly _tag: "Unavailable"; readonly reason: GitHubApiUnavailable };

/** The only failure: GitHub accepted the connection and did not answer in time. */
export class GitHubApiTimeoutError extends Schema.TaggedError<GitHubApiTimeoutError>()(
  "GitHubApiTimeoutError",
  { host: Schema.String, operation: Schema.String },
) {
  override get message(): string {
    return `GitHub at ${this.host} did not answer ${this.operation} within ${GITHUB_API_TIMEOUT_MS / 1000} seconds.`;
  }
}

export interface GitHubApiShape {
  readonly graphql: (input: {
    readonly host: string;
    readonly operation: string;
    readonly query: string;
    readonly variables: GitHubGraphQlVariables;
  }) => Effect.Effect<GitHubApiOutcome, GitHubApiTimeoutError>;
  readonly rest: (input: {
    readonly host: string;
    readonly operation: string;
    /** Relative to the REST root, query string included (`repos/acme/web`). */
    readonly path: string;
    /** Default {@link GITHUB_API_DEFAULT_VERSION}. */
    readonly apiVersion?: string;
    /** Send `If-None-Match` and answer a 304 from the cache. */
    readonly revalidate?: boolean;
  }) => Effect.Effect<GitHubApiOutcome, GitHubApiTimeoutError>;
  /** Admission counts over every credential's pool (benchmarks, diagnostics). */
  readonly poolStats: () => ProcessPoolStats;
}

export class GitHubApi extends Context.Service<GitHubApi, GitHubApiShape>()(
  "ryco/source-control/GitHubApi",
) {}

// ── gh's output for an answer ────────────────────────────────────────

function parseObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** gh `pkg/cmd/api` parseErrorResponse: GitHub's message for an error body, or "". */
function ghServerError(status: number, body: string): string {
  const parsed = parseObject(body);
  if (parsed === null) return "";
  const message = typeof parsed.message === "string" ? parsed.message : "";
  const errors = parsed.errors;
  if (typeof errors === "string" && errors !== "") {
    return message !== "" ? `${errors} (${message})` : errors;
  }
  if (message !== "") return `${message} (HTTP ${status})`;
  if (!Array.isArray(errors)) return "";
  const messages = errors.flatMap((entry: unknown) => {
    if (typeof entry === "string") return [entry];
    if (typeof entry === "object" && entry !== null && "message" in entry) {
      return typeof entry.message === "string" ? [entry.message] : [];
    }
    return [];
  });
  return messages.join("\n");
}

/**
 * The exit code, stdout and stderr `gh api` prints for this answer, so the
 * gh path's decoders, partial-data rules and error normalizer apply unchanged:
 * the body on stdout; on a GraphQL `errors` list or an HTTP status above 299,
 * `gh: <GitHub's message>` (or `gh: HTTP <status>`) on stderr and exit 1.
 */
export function ghEquivalentOutput(
  answer: GitHubApiAnswer,
  kind: "graphql" | "rest",
): VcsProcess.VcsProcessOutput {
  const parsesErrors = kind === "graphql" || answer.status >= 400;
  let serverError = parsesErrors ? ghServerError(answer.status, answer.body) : "";
  if (serverError === "" && answer.status > 299) serverError = `HTTP ${answer.status}`;
  return {
    exitCode: (serverError === "" ? 0 : 1) as VcsProcess.VcsProcessOutput["exitCode"],
    stdout: answer.body,
    stderr: serverError === "" ? "" : `gh: ${serverError}\n`,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

// ── Paths and origins ────────────────────────────────────────────────

const hasControlCharacter = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** `.` and `..`, also percent-encoded (`%2e%2E`): URL parsing resolves both. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/iu;

/**
 * A REST path relative to the root. Anything that could name another origin
 * or climb out of the root (`//host`, a scheme, userinfo, backslashes, `..`)
 * is refused before a request exists.
 */
export function isSafeGitHubApiPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/")) return false;
  const [pathname = ""] = path.split(/[?#]/u, 1);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(pathname)) return false;
  if (/[@\\\s]/u.test(pathname) || hasControlCharacter(path)) return false;
  return !pathname.split("/").some((segment) => segment === "" || DOT_SEGMENT.test(segment));
}

/** `url` is on `root`'s origin and inside its path: the only place a token may go. */
export function isWithinGitHubApiRoot(url: string, root: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(root);
    const basePath = base.pathname.replace(/\/+$/u, "");
    return (
      target.origin === base.origin &&
      target.username === "" &&
      target.password === "" &&
      (target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))
    );
  } catch {
    return false;
  }
}

// ── Metrics ──────────────────────────────────────────────────────────

const requestsTotal = Metric.counter("ryco_github_api_requests_total", {
  description: "Direct GitHub API requests, by kind (rest, graphql), lane and outcome.",
  incremental: true,
});
const requestDuration = Metric.timer("ryco_github_api_request_duration", {
  description: "Duration of direct GitHub API requests (admission excluded), by kind.",
});
const fallbacksTotal = Metric.counter("ryco_github_api_fallbacks_total", {
  description: "GitHub reads that used gh because the direct API was unavailable, by reason.",
  incremental: true,
});
const rateLimitRemaining = Metric.gauge("ryco_github_api_rate_limit_remaining", {
  description: "GitHub's last reported remaining quota, by host and resource.",
});

export const gitHubApiMetricNames = {
  requestsTotal: "ryco_github_api_requests_total",
  requestDuration: "ryco_github_api_request_duration",
  fallbacksTotal: "ryco_github_api_fallbacks_total",
  rateLimitRemaining: "ryco_github_api_rate_limit_remaining",
} as const;

type RequestOutcomeLabel =
  | "ok"
  | "not_modified"
  | "rate_limited"
  | "unauthorized"
  | "not_found"
  | "failed"
  | "unreachable"
  | "timeout";

function outcomeLabel(answer: GitHubApiAnswer): RequestOutcomeLabel {
  if (answer.notModified) return "not_modified";
  if (answer.status === 401) return "unauthorized";
  if (
    answer.status === 429 ||
    (answer.status === 403 && answer.headers["x-ratelimit-remaining"] === "0")
  ) {
    return "rate_limited";
  }
  if (answer.status === 404) return "not_found";
  return answer.status >= 200 && answer.status < 300 ? "ok" : "failed";
}

// ── Transport ────────────────────────────────────────────────────────

/** No DNS answer or no route: the machine is offline, not GitHub unreachable. */
const OFFLINE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
]);

/** The first `code` string along an error's cause chain (`fetch failed` → undici → system). */
function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return "UNKNOWN";
}

type Exchange =
  | { readonly _tag: "Answer"; readonly answer: GitHubApiAnswer }
  | { readonly _tag: "Transport"; readonly code: string; readonly beforeAnswer: boolean };

const synthesized = (message: string): GitHubApiAnswer => ({
  status: 502,
  headers: {},
  body: JSON.stringify({ message }),
  notModified: false,
});

/** Reads at most `maxBytes`, then stops pulling (and so cancels) the body. */
const readCappedText = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  Effect.suspend(() => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    return stream.pipe(
      Stream.takeWhile((chunk) => {
        if (bytes + chunk.byteLength > maxBytes) {
          truncated = true;
          return false;
        }
        bytes += chunk.byteLength;
        chunks.push(chunk);
        return true;
      }),
      Stream.runDrain,
      Effect.map(() => {
        const joined = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { text: new TextDecoder().decode(joined), truncated };
      }),
    );
  });

interface PreparedRequest {
  readonly method: "GET" | "POST";
  readonly root: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface EtagEntry {
  readonly etag: string;
  readonly body: string;
  expiresAtMs: number;
}

const setBounded = <K, V>(map: Map<K, V>, key: K, value: V, capacity: number) => {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= capacity) break;
    map.delete(oldest);
  }
};

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const process = yield* VcsProcess.VcsProcess;
  const env = yield* GitHubApiEnvironment;
  const endpointsFor = yield* GitHubApiEndpoints;
  const credentials = yield* makeGitHubCredentials({ process, env });
  // Queue waits on the same clock as the circuits and ETag ages.
  const clock = yield* Clock.Clock;
  const clockMs = () => clock.currentTimeMillisUnsafe();

  // One lane-aware pool per credential; the gauges publish their sum.
  const pools = new Map<string, ProcessPool>();
  const retired = {
    admittedTotal: 0,
    queuedTotal: 0,
    interactive: 0,
    background: 0,
    maxQueueWaitMs: 0,
  };
  const poolStats = (): ProcessPoolStats => {
    let inFlight = 0;
    let queued = 0;
    let admittedTotal = retired.admittedTotal;
    let queuedTotal = retired.queuedTotal;
    let interactive = retired.interactive;
    let background = retired.background;
    let maxQueueWaitMs = retired.maxQueueWaitMs;
    for (const pool of pools.values()) {
      const stats = pool.stats();
      inFlight += stats.inFlight;
      queued += stats.queued;
      admittedTotal += stats.admittedTotal;
      queuedTotal += stats.queuedTotal;
      interactive += stats.admittedByLane.interactive;
      background += stats.admittedByLane.background;
      maxQueueWaitMs = Math.max(maxQueueWaitMs, stats.maxQueueWaitMs);
    }
    return {
      pool: GITHUB_API_POOL_LABEL,
      limit: GITHUB_API_CONCURRENCY_PER_CREDENTIAL,
      inFlight,
      queued,
      admittedTotal,
      queuedTotal,
      admittedByLane: { interactive, background },
      maxQueueWaitMs,
    };
  };
  const publish = () => publishPoolGauges(GITHUB_API_POOL_LABEL, poolStats());
  const poolFor = (fingerprint: string): ProcessPool => {
    const existing = pools.get(fingerprint);
    if (existing) {
      pools.delete(fingerprint);
      pools.set(fingerprint, existing);
      return existing;
    }
    const pool = new ProcessPool(
      GITHUB_API_POOL_LABEL,
      GITHUB_API_CONCURRENCY_PER_CREDENTIAL,
      clockMs,
      publish,
    );
    pools.set(fingerprint, pool);
    for (const [key, candidate] of pools) {
      if (pools.size <= GITHUB_API_POOL_CAPACITY) break;
      const stats = candidate.stats();
      if (stats.inFlight > 0 || stats.queued > 0) continue;
      retired.admittedTotal += stats.admittedTotal;
      retired.queuedTotal += stats.queuedTotal;
      retired.interactive += stats.admittedByLane.interactive;
      retired.background += stats.admittedByLane.background;
      retired.maxQueueWaitMs = Math.max(retired.maxQueueWaitMs, stats.maxQueueWaitMs);
      pools.delete(key);
    }
    return pool;
  };

  const unreachableUntil = new Map<string, number>();
  const endpointMissingUntil = new Map<string, number>();
  const etags = new Map<string, EtagEntry>();

  const circuitOpen = (circuit: Map<string, number>, host: string, nowMs: number) => {
    const until = circuit.get(host);
    if (until === undefined) return false;
    if (until > nowMs) return true;
    circuit.delete(host);
    return false;
  };

  const fallback = (reason: GitHubApiUnavailable): Effect.Effect<GitHubApiOutcome> =>
    Metric.update(Metric.withAttributes(fallbacksTotal, { reason }), 1).pipe(
      Effect.as({ _tag: "Unavailable", reason } as const),
    );

  /** One HTTP exchange, following same-origin redirects; the body is read here, capped. */
  const exchange = (prepared: PreparedRequest, authorization: string) =>
    Effect.gen(function* () {
      let url = prepared.url;
      let method = prepared.method;
      let body = prepared.body;
      for (let hop = 0; ; hop += 1) {
        // The one place a token is attached: only for a URL inside the credential host's root.
        if (!isWithinGitHubApiRoot(url, prepared.root)) {
          return yield* Effect.die(
            new Error("Refused to send a GitHub token outside its API root."),
          );
        }
        let request = HttpClientRequest.make(method)(url).pipe(
          HttpClientRequest.setHeaders({ ...prepared.headers, authorization }),
        );
        if (body !== undefined) {
          request = HttpClientRequest.bodyText(request, body, "application/json; charset=utf-8");
        }
        const sent = yield* httpClient.execute(request).pipe(
          Effect.map((response) => ({ _tag: "Response", response }) as const),
          Effect.catch((error) =>
            Effect.succeed({ _tag: "Transport", code: errorCode(error.reason) } as const),
          ),
        );
        if (sent._tag === "Transport") {
          return { _tag: "Transport", code: sent.code, beforeAnswer: true } satisfies Exchange;
        }
        const response = sent.response;
        const location = response.headers["location"];
        if ([301, 302, 303, 307, 308].includes(response.status) && location !== undefined) {
          // Drop the redirect's own body before deciding.
          yield* response.stream.pipe(Stream.take(1), Stream.runDrain, Effect.ignore);
          const next = (() => {
            try {
              return new URL(location, url).toString();
            } catch {
              return null;
            }
          })();
          if (next === null || !isWithinGitHubApiRoot(next, prepared.root)) {
            return {
              _tag: "Answer",
              answer: synthesized("GitHub redirected the request to another host"),
            } satisfies Exchange;
          }
          if (hop >= GITHUB_API_MAX_REDIRECTS) {
            return {
              _tag: "Answer",
              answer: synthesized("GitHub redirected the request too many times"),
            } satisfies Exchange;
          }
          if (response.status === 307 || response.status === 308) {
            url = next;
            continue;
          }
          if (method !== "GET") {
            // A 301/302/303 would turn the POST into a GET; gh would not get an answer either.
            return {
              _tag: "Answer",
              answer: synthesized(`GitHub answered HTTP ${response.status} to a POST`),
            } satisfies Exchange;
          }
          url = next;
          method = "GET";
          body = undefined;
          continue;
        }
        const read = yield* readCappedText(response.stream, GITHUB_API_MAX_RESPONSE_BYTES).pipe(
          Effect.map((text) => ({ _tag: "Text", ...text }) as const),
          Effect.catch((error) =>
            Effect.succeed(
              // A 304 (or 204) has no body at all.
              error.reason._tag === "EmptyBodyError"
                ? ({ _tag: "Text", text: "", truncated: false } as const)
                : ({ _tag: "Transport", code: errorCode(error.reason) } as const),
            ),
          ),
        );
        if (read._tag === "Transport") {
          return { _tag: "Transport", code: read.code, beforeAnswer: false } satisfies Exchange;
        }
        if (read.truncated) {
          return {
            _tag: "Answer",
            answer: synthesized(
              `GitHub's answer is longer than ${GITHUB_API_MAX_RESPONSE_BYTES / 1024 / 1024} MiB`,
            ),
          } satisfies Exchange;
        }
        return {
          _tag: "Answer",
          answer: {
            status: response.status,
            headers: { ...response.headers },
            body: read.text,
            notModified: false,
          },
        } satisfies Exchange;
      }
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );

  /** One admitted attempt under `credential`: a permit of its pool for the exchange only. */
  const attempt = (
    kind: "graphql" | "rest",
    host: string,
    operation: string,
    credential: GitHubCredential,
    prepare: (credential: GitHubCredential) => PreparedRequest,
  ) =>
    governWithPool(
      poolFor(credential.fingerprint),
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        const result = yield* exchange(
          prepare(credential),
          `token ${Redacted.value(credential.token)}`,
        ).pipe(Effect.timeoutOption(Duration.millis(GITHUB_API_TIMEOUT_MS)));
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAtMs;
        yield* Metric.update(
          Metric.withAttributes(requestDuration, { kind }),
          Duration.millis(elapsedMs),
        );
        return result;
      }),
    ).pipe(
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(new GitHubApiTimeoutError({ host, operation })),
      ),
    );

  const request = (input: {
    readonly kind: "graphql" | "rest";
    readonly host: string;
    readonly operation: string;
    readonly prepare: (urls: GitHubApiUrls, credential: GitHubCredential) => PreparedRequest;
    readonly onAnswer?: (
      answer: GitHubApiAnswer,
      credential: GitHubCredential,
    ) => Effect.Effect<GitHubApiAnswer>;
  }): Effect.Effect<GitHubApiOutcome, GitHubApiTimeoutError> =>
    Effect.gen(function* () {
      const host = normalizeGitHubHost(input.host);
      if (host === null) return yield* fallback("invalid-host");
      const lane = yield* ProcessLaneRef;
      const count = (outcome: RequestOutcomeLabel) =>
        Metric.update(Metric.withAttributes(requestsTotal, { kind: input.kind, lane, outcome }), 1);
      const nowMs = yield* Clock.currentTimeMillis;
      if (circuitOpen(unreachableUntil, host, nowMs)) return yield* fallback("unreachable");
      if (input.kind === "graphql" && circuitOpen(endpointMissingUntil, host, nowMs)) {
        return yield* fallback("endpoint-missing");
      }
      const resolved = yield* credentials.get(host);
      if (resolved._tag === "Unavailable") return yield* fallback(resolved.reason);

      const urls = endpointsFor(host);
      // Every attempt is counted once, by what it ended in.
      const run = (credential: GitHubCredential) =>
        attempt(input.kind, host, input.operation, credential, (current) =>
          input.prepare(urls, current),
        ).pipe(
          Effect.tapError(() => count("timeout")),
          Effect.flatMap((result) =>
            result._tag === "Answer" && input.onAnswer
              ? Effect.map(input.onAnswer(result.answer, credential), (answer) => ({
                  ...result,
                  answer,
                }))
              : Effect.succeed(result),
          ),
          Effect.tap((result) =>
            count(result._tag === "Answer" ? outcomeLabel(result.answer) : "unreachable"),
          ),
        );

      const first = resolved.credential;
      let result = yield* run(first);
      if (result._tag === "Answer" && result.answer.status === 401) {
        // The permit is already released: re-resolving may start gh. A new
        // token (after `gh auth refresh` or a switch) gets one more try.
        yield* credentials.invalidate(host);
        const next = yield* credentials.get(host);
        if (next._tag === "Available" && next.credential.fingerprint !== first.fingerprint) {
          result = yield* run(next.credential);
        }
      }

      if (result._tag === "Transport") {
        if (result.beforeAnswer) {
          const ttl = OFFLINE_CODES.has(result.code)
            ? GITHUB_API_OFFLINE_TTL_MS
            : GITHUB_API_UNREACHABLE_TTL_MS;
          setBounded(
            unreachableUntil,
            host,
            (yield* Clock.currentTimeMillis) + ttl,
            CIRCUIT_CAPACITY,
          );
          yield* logOnceEvery({
            key: `github-api.unreachable:${host}`,
            level: "Info",
            message: "GitHub's API could not be reached directly; reads use gh for now.",
            fields: { host, code: result.code, retryAfterMs: ttl },
          });
        }
        return yield* fallback("unreachable");
      }

      const answer = result.answer;
      if (input.kind === "graphql" && answer.status === 404) {
        setBounded(
          endpointMissingUntil,
          host,
          (yield* Clock.currentTimeMillis) + GITHUB_API_ENDPOINT_MISSING_TTL_MS,
          CIRCUIT_CAPACITY,
        );
        yield* logOnceEvery({
          key: `github-api.endpoint-missing:${host}`,
          level: "Info",
          message: "GitHub's GraphQL endpoint was not where expected; reads use gh for this host.",
          fields: { host },
        });
        return yield* fallback("endpoint-missing");
      }
      const remaining = Number(answer.headers["x-ratelimit-remaining"]);
      if (answer.headers["x-ratelimit-remaining"] !== undefined && Number.isFinite(remaining)) {
        yield* Metric.update(
          Metric.withAttributes(rateLimitRemaining, {
            host,
            resource: rateLimitResource(answer) ?? "unknown",
          }),
          remaining,
        );
      }
      yield* Effect.annotateCurrentSpan(rateLimitSpanAttributes(answer));
      return { _tag: "Answered", answer } satisfies GitHubApiOutcome;
    }).pipe(
      Effect.withSpan("GitHubApi.request", {
        attributes: {
          "github.kind": input.kind,
          "github.operation": input.operation,
          "github.host": input.host,
          "github.transport": "api",
        },
      }),
    );

  const graphql: GitHubApiShape["graphql"] = (input) =>
    request({
      kind: "graphql",
      host: input.host,
      operation: input.operation,
      prepare: (urls) => ({
        method: "POST",
        root: urls.graphql,
        url: urls.graphql,
        headers: {
          accept: "*/*",
          "user-agent": "Ryco",
          "x-github-api-version": GITHUB_API_DEFAULT_VERSION,
        },
        // The same bytes gh would read from stdin for `--input -`.
        body: encodeGitHubGraphQlRequest({ query: input.query, variables: input.variables }),
      }),
    });

  const rest: GitHubApiShape["rest"] = (input) => {
    if (!isSafeGitHubApiPath(input.path)) {
      return Effect.die(new Error("Refused an unsafe GitHub API path."));
    }
    const etagKey = (credential: GitHubCredential) =>
      `${credential.fingerprint}\u0000${credential.host}\u0000${input.path}`;
    const cachedEtag = (credential: GitHubCredential, nowMs: number) => {
      const entry = etags.get(etagKey(credential));
      if (entry === undefined) return undefined;
      if (entry.expiresAtMs > nowMs) return entry;
      etags.delete(etagKey(credential));
      return undefined;
    };
    return Effect.flatMap(Clock.currentTimeMillis, (startedAtMs) => {
      // The entry whose ETag this run's attempt sent: a 304 answers from it
      // even if other reads evicted it from the cache meanwhile.
      let sentEntry: EtagEntry | undefined;
      return request({
        kind: "rest",
        host: input.host,
        operation: input.operation,
        prepare: (urls, credential) => {
          const entry = input.revalidate ? cachedEtag(credential, startedAtMs) : undefined;
          sentEntry = entry;
          return {
            method: "GET",
            root: urls.rest,
            url: `${urls.rest}/${input.path}`,
            headers: {
              accept: "application/vnd.github+json",
              "user-agent": "Ryco",
              "x-github-api-version": input.apiVersion ?? GITHUB_API_DEFAULT_VERSION,
              ...(entry ? { "if-none-match": entry.etag } : {}),
            },
          };
        },
        onAnswer: (answer, credential) =>
          Effect.map(Clock.currentTimeMillis, (nowMs) => {
            if (!input.revalidate) return answer;
            const key = etagKey(credential);
            if (answer.status === 304) {
              // No If-None-Match was sent: an unexpected 304 stays an error, as in gh.
              if (sentEntry === undefined) return answer;
              const entry = sentEntry;
              entry.expiresAtMs = nowMs + GITHUB_API_ETAG_TTL_MS;
              setBounded(etags, key, entry, GITHUB_API_ETAG_CAPACITY);
              return { ...answer, status: 200, body: entry.body, notModified: true };
            }
            const etag = answer.headers["etag"];
            if (
              answer.status === 200 &&
              etag !== undefined &&
              answer.body.length <= GITHUB_API_ETAG_MAX_BODY_CHARS
            ) {
              setBounded(
                etags,
                key,
                { etag, body: answer.body, expiresAtMs: nowMs + GITHUB_API_ETAG_TTL_MS },
                GITHUB_API_ETAG_CAPACITY,
              );
            } else {
              etags.delete(key);
            }
            return answer;
          }),
      });
    });
  };

  return GitHubApi.of({ graphql, rest, poolStats });
});

/** The numeric `x-ratelimit-*` values and the resource, as span attributes. */
function rateLimitSpanAttributes(answer: GitHubApiAnswer): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    "http.response.status_code": answer.status,
    "github.not_modified": answer.notModified ? 1 : 0,
  };
  for (const name of ["limit", "remaining", "used", "reset"] as const) {
    const raw = answer.headers[`x-ratelimit-${name}`];
    const value = Number(raw);
    if (raw !== undefined && Number.isFinite(value)) attributes[`github.ratelimit.${name}`] = value;
  }
  const resource = rateLimitResource(answer);
  if (resource !== null) attributes["github.ratelimit.resource"] = resource;
  return attributes;
}

/** GitHub's quota bucket (`core`, `graphql`, `search`, …), only when it looks like one. */
function rateLimitResource(answer: GitHubApiAnswer): string | null {
  const resource = answer.headers["x-ratelimit-resource"];
  return resource !== undefined && /^[a-z_]{1,32}$/u.test(resource) ? resource : null;
}

export const layer: Layer.Layer<GitHubApi, never, HttpClient.HttpClient | VcsProcess.VcsProcess> =
  Layer.effect(GitHubApi, make);

/** Always `Unavailable("no-credential")`: every read takes its gh call (the CLI-only client). */
export const cliOnly: GitHubApiShape = {
  graphql: () => Effect.succeed({ _tag: "Unavailable", reason: "no-credential" }),
  rest: () => Effect.succeed({ _tag: "Unavailable", reason: "no-credential" }),
  poolStats: () => ({
    pool: GITHUB_API_POOL_LABEL,
    limit: GITHUB_API_CONCURRENCY_PER_CREDENTIAL,
    inFlight: 0,
    queued: 0,
    admittedTotal: 0,
    queuedTotal: 0,
    admittedByLane: { interactive: 0, background: 0 },
    maxQueueWaitMs: 0,
  }),
};

export const layerCliOnly: Layer.Layer<GitHubApi> = Layer.succeed(GitHubApi, cliOnly);
