/**
 * The token the GitHub CLI would use for a host, for the direct API transport.
 *
 * Both transports must act as one identity, so viewer-dependent answers
 * (`viewerViewedState`, `@me`) and permissions match: the token comes from
 * gh's own environment variables in gh's order, else from
 * `gh auth token --hostname <host>`. Whenever they could differ, the host is
 * reported unavailable and stays on gh.
 *
 * Tokens live only as `Redacted` values here and in the one header write of
 * `gitHubApi.ts`: never in logs, spans, metrics, errors or cache keys (those
 * use {@link gitHubCredentialFingerprint}).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";

import { Cache, Clock, Duration, Effect, Exit, Redacted } from "effect";

import { logOnceEvery } from "../logOnceEvery.ts";
import { ProcessLaneRef } from "../processGovernor.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

/** A resolved token is re-read in the background once it is this old; reads keep using it meanwhile. */
export const GITHUB_TOKEN_REFRESH_AFTER_MS = 4 * 60_000;
/** A token nobody read for this long is resolved again before use. */
export const GITHUB_TOKEN_MAX_AGE = Duration.hours(1);
/** No login, no gh, an empty answer or a timeout: asked again after this. */
export const GITHUB_TOKEN_MISSING_TTL = Duration.seconds(10);
/** `gh auth token` needs gh 2.17 or later; an older gh is asked again after this. */
export const GITHUB_GH_TOO_OLD_TTL = Duration.minutes(10);
export const GITHUB_CREDENTIAL_CAPACITY = 32;
export const GITHUB_AUTH_TOKEN_TIMEOUT_MS = 10_000;

export type GitHubTokenEnvironmentName =
  | "GH_TOKEN"
  | "GITHUB_TOKEN"
  | "GH_ENTERPRISE_TOKEN"
  | "GITHUB_ENTERPRISE_TOKEN";

export type GitHubCredentialSource = "env" | "gh";

export interface GitHubCredential {
  /** Normalized: lower-case `host[:port]`. */
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  readonly envName?: GitHubTokenEnvironmentName;
  /** 16 hex of sha256(host, NUL, token): keys pools and ETags without holding the token. */
  readonly fingerprint: string;
}

export type GitHubCredentialUnavailable =
  /** gh has no login for the host (or printed nothing usable). */
  | "no-credential"
  /** gh is not installed. */
  | "gh-missing"
  /** gh predates `gh auth token`. */
  | "gh-too-old"
  /** `gh auth token` timed out or failed to run for another reason. */
  | "gh-failed"
  /** An enterprise token is in the environment but `GH_HOST` names another host (or none). */
  | "env-token-other-host"
  /** A proxy is configured that this runtime's `fetch` would not use. */
  | "proxy"
  /** Not a plain `host[:port]`. */
  | "invalid-host";

export type GitHubCredentialLookup =
  | { readonly _tag: "Available"; readonly credential: GitHubCredential }
  | { readonly _tag: "Unavailable"; readonly reason: GitHubCredentialUnavailable };

export type GitHubEnvironment = Readonly<Record<string, string | undefined>>;

/** What decides whether `fetch` reads proxy variables itself. */
export interface GitHubFetchRuntime {
  readonly bun: string | undefined;
  readonly node: string | undefined;
  readonly execArgv: ReadonlyArray<string>;
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/u;
/** Visible ASCII only: a token with whitespace or control characters cannot be a header value. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/u;

/** Trimmed, lower-cased `host[:port]`, or null when it is not one. */
export function normalizeGitHubHost(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  return HOST_PATTERN.test(normalized) ? normalized : null;
}

/** Hosts gh gives `GH_TOKEN`: github.com and GHE.com data residency (`*.ghe.com`). */
export function isGitHubDotComHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

const firstToken = (
  env: GitHubEnvironment,
  names: ReadonlyArray<GitHubTokenEnvironmentName>,
): { readonly token: string; readonly name: GitHubTokenEnvironmentName } | null => {
  for (const name of names) {
    const token = env[name]?.trim();
    if (token) return { token, name };
  }
  return null;
};

/**
 * gh's environment token for `host`, in gh's order. An enterprise token goes
 * only to the host `GH_HOST` names: the remote URL picks the host, and a
 * hostile one must not receive it. With an enterprise token set and `GH_HOST`
 * naming another host, or unset, the answer is `env-token-other-host` and the
 * host stays on gh. (`gh auth token` would print that same environment token
 * for the host, so asking it would not avoid the exposure.)
 */
export function gitHubEnvironmentToken(
  host: string,
  env: GitHubEnvironment,
):
  | { readonly token: string; readonly name: GitHubTokenEnvironmentName }
  | "env-token-other-host"
  | null {
  if (isGitHubDotComHost(host)) return firstToken(env, ["GH_TOKEN", "GITHUB_TOKEN"]);
  const enterprise = firstToken(env, ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
  if (enterprise === null) return null;
  const pinned = env.GH_HOST === undefined ? null : normalizeGitHubHost(env.GH_HOST);
  return pinned === host ? enterprise : "env-token-other-host";
}

/** The one credential fingerprint (pools, ETags, rate-limit scopes): 16 hex, not reversible. */
export function gitHubCredentialFingerprint(host: string, token: string): string {
  return createHash("sha256")
    .update(host)
    .update("\u0000")
    .update(token)
    .digest("hex")
    .slice(0, 16);
}

export const currentGitHubFetchRuntime = (): GitHubFetchRuntime => ({
  bun: process.versions.bun,
  node: process.versions.node,
  execArgv: process.execArgv,
});

/** Node's `fetch` reads `HTTPS_PROXY` under `NODE_USE_ENV_PROXY=1` from 24.5 and 22.21. */
function nodeFetchCanUseEnvProxy(version: string | undefined): boolean {
  const [major = 0, minor = 0] = (version ?? "").split(".").map((part) => Number(part));
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

/**
 * True when a proxy is set that this runtime's `fetch` would not use. gh (Go)
 * sends https requests through `HTTPS_PROXY`; Node's `fetch` ignores it unless
 * `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) on a Node that supports it.
 * Bun's `fetch` reads it itself. `ALL_PROXY` is read by neither gh nor `fetch`,
 * so it changes neither transport.
 */
export function gitHubFetchIgnoresProxy(
  env: GitHubEnvironment,
  runtime: GitHubFetchRuntime = currentGitHubFetchRuntime(),
): boolean {
  const proxied = Boolean(env.HTTPS_PROXY?.trim() || env.https_proxy?.trim());
  if (!proxied || runtime.bun !== undefined) return false;
  const nodeOptions = (env.NODE_OPTIONS ?? "").split(/\s+/u);
  const enabled =
    env.NODE_USE_ENV_PROXY === "1" ||
    runtime.execArgv.includes("--use-env-proxy") ||
    nodeOptions.includes("--use-env-proxy");
  return !(enabled && nodeFetchCanUseEnvProxy(runtime.node));
}

export interface GitHubCredentialsShape {
  /** Never fails: `Unavailable` means "use gh for this call". */
  readonly get: (host: string) => Effect.Effect<GitHubCredentialLookup>;
  /** Forgets the host's gh token (after GitHub refused it). */
  readonly invalidate: (host: string) => Effect.Effect<void>;
}

interface Resolution {
  readonly lookup: GitHubCredentialLookup;
  readonly resolvedAtMs: number;
}

const unavailable = (reason: GitHubCredentialUnavailable): GitHubCredentialLookup => ({
  _tag: "Unavailable",
  reason,
});

const isSpawnNotFound = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if (!("_tag" in error) || error._tag !== "VcsProcessSpawnError") return false;
  const cause = "cause" in error ? error.cause : undefined;
  if (typeof cause === "object" && cause !== null && "reason" in cause) {
    const reason = cause.reason;
    if (typeof reason === "object" && reason !== null && "_tag" in reason) {
      return reason._tag === "NotFound";
    }
  }
  return /\benoent\b/iu.test(String(cause));
};

/** A directory that exists, so a spawn ENOENT means gh is missing, not a removed worktree. */
function stableWorkingDirectory(): string {
  const home = os.homedir();
  return home && existsSync(home) ? home : os.tmpdir();
}

export const makeGitHubCredentials = Effect.fn("makeGitHubCredentials")(function* (input: {
  readonly process: VcsProcess.VcsProcessShape;
  /** `process.env` in production; a literal in tests. */
  readonly env: GitHubEnvironment;
  readonly runtime?: GitHubFetchRuntime;
}) {
  const runtime = input.runtime ?? currentGitHubFetchRuntime();

  const fromGh = (host: string): Effect.Effect<Resolution> =>
    input.process
      .run({
        operation: "GitHubCredentials.lookup",
        command: "gh",
        args: ["auth", "token", "--hostname", host],
        cwd: stableWorkingDirectory(),
        // gh never prints request traces, prompts or colours here.
        env: { GH_DEBUG: "", DEBUG: "", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        allowNonZeroExit: true,
        timeoutMs: GITHUB_AUTH_TOKEN_TIMEOUT_MS,
      })
      .pipe(
        Effect.map((output): GitHubCredentialLookup => {
          if (output.exitCode !== 0) {
            return unavailable(
              /unknown command "token"/u.test(output.stderr) ? "gh-too-old" : "no-credential",
            );
          }
          const token = output.stdout.trim();
          if (!TOKEN_PATTERN.test(token)) return unavailable("no-credential");
          return {
            _tag: "Available",
            credential: {
              host,
              token: Redacted.make(token),
              source: "gh",
              fingerprint: gitHubCredentialFingerprint(host, token),
            },
          };
        }),
        // Only the classification survives; the error never carries stdout.
        Effect.catch((error) =>
          Effect.succeed(unavailable(isSpawnNotFound(error) ? "gh-missing" : "gh-failed")),
        ),
        Effect.tap((lookup) =>
          lookup._tag === "Unavailable" && lookup.reason === "gh-too-old"
            ? logOnceEvery({
                key: "github-api.gh-too-old",
                level: "Info",
                message:
                  "The GitHub CLI is too old for `gh auth token`; GitHub reads keep using gh. Update gh to 2.17 or later.",
              })
            : Effect.void,
        ),
        Effect.flatMap((lookup) =>
          Effect.map(Clock.currentTimeMillis, (resolvedAtMs): Resolution => ({
            lookup,
            resolvedAtMs,
          })),
        ),
        // One cheap child per host every few minutes, admitted at once: an
        // interactive read that joins a lookup a background read started must
        // never wait behind the background forge queue.
        Effect.provideService(ProcessLaneRef, "interactive"),
      );

  const cache = yield* Cache.makeWith(fromGh, {
    capacity: GITHUB_CREDENTIAL_CAPACITY,
    timeToLive: (exit) => {
      if (!Exit.isSuccess(exit)) return GITHUB_TOKEN_MISSING_TTL;
      const lookup = exit.value.lookup;
      if (lookup._tag === "Available") return GITHUB_TOKEN_MAX_AGE;
      return lookup.reason === "gh-too-old" ? GITHUB_GH_TOO_OLD_TTL : GITHUB_TOKEN_MISSING_TTL;
    },
  });
  const refreshing = new Set<string>();
  // Hosts whose last background refresh failed to run: not retried before this time.
  const refreshRetryAtMs = new Map<string, number>();

  const environmentCredential = (
    host: string,
    found: { readonly token: string; readonly name: GitHubTokenEnvironmentName },
  ): GitHubCredentialLookup =>
    TOKEN_PATTERN.test(found.token)
      ? {
          _tag: "Available",
          credential: {
            host,
            token: Redacted.make(found.token),
            source: "env",
            envName: found.name,
            fingerprint: gitHubCredentialFingerprint(host, found.token),
          },
        }
      : unavailable("no-credential");

  const get: GitHubCredentialsShape["get"] = (rawHost) =>
    Effect.gen(function* () {
      const host = normalizeGitHubHost(rawHost);
      if (host === null) return unavailable("invalid-host");
      if (gitHubFetchIgnoresProxy(input.env, runtime)) {
        yield* logOnceEvery({
          key: "github-api.proxy",
          level: "Info",
          message:
            "A proxy is set that Node's fetch does not use; GitHub reads keep using gh. Set NODE_USE_ENV_PROXY=1 to read GitHub directly through the proxy.",
        });
        return unavailable("proxy");
      }
      // Read on every call (cheap) and never cached, as gh reads them per call.
      const fromEnv = gitHubEnvironmentToken(host, input.env);
      if (fromEnv === "env-token-other-host") return unavailable("env-token-other-host");
      if (fromEnv !== null) return environmentCredential(host, fromEnv);

      const resolved = yield* Cache.get(cache, host);
      if (resolved.lookup._tag === "Available" && !refreshing.has(host)) {
        const nowMs = yield* Clock.currentTimeMillis;
        const dueAtMs = Math.max(
          resolved.resolvedAtMs + GITHUB_TOKEN_REFRESH_AFTER_MS,
          refreshRetryAtMs.get(host) ?? 0,
        );
        if (nowMs >= dueAtMs) {
          // Served at once; one detached lookup replaces it, with gh's answer
          // even when that is "no login", so a logout or `gh auth switch`
          // lands on the next read. A `gh auth token` that timed out or did
          // not start says nothing about the token: it stays, and the refresh
          // is tried again after the miss TTL.
          refreshing.add(host);
          yield* fromGh(host).pipe(
            Effect.flatMap((next) => {
              if (next.lookup._tag === "Unavailable" && next.lookup.reason === "gh-failed") {
                return Effect.sync(() => {
                  refreshRetryAtMs.delete(host);
                  refreshRetryAtMs.set(
                    host,
                    next.resolvedAtMs + Duration.toMillis(GITHUB_TOKEN_MISSING_TTL),
                  );
                  if (refreshRetryAtMs.size > GITHUB_CREDENTIAL_CAPACITY) {
                    const oldest = refreshRetryAtMs.keys().next().value;
                    if (oldest !== undefined) refreshRetryAtMs.delete(oldest);
                  }
                });
              }
              refreshRetryAtMs.delete(host);
              return Cache.set(cache, host, next);
            }),
            Effect.ensuring(Effect.sync(() => refreshing.delete(host))),
            Effect.forkDetach,
          );
        }
      }
      return resolved.lookup;
    });

  const invalidate: GitHubCredentialsShape["invalidate"] = (rawHost) => {
    const host = normalizeGitHubHost(rawHost);
    return host === null ? Effect.void : Cache.invalidate(cache, host);
  };

  return { get, invalidate } satisfies GitHubCredentialsShape;
});
