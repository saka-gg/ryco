import type { RepositoryIdentity, RepositoryRemote } from "@ryco/contracts";
import { Cache, Duration, Effect, Exit, Layer } from "effect";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@ryco/shared/git";

import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../../observability/Metrics.ts";
import { READ_ONLY_GIT_ENV } from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  RepositoryIdentityProbeError,
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
  readonly allRemotes: ReadonlyMap<string, string>;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  const remotes = [...input.allRemotes.entries()].map(([name, url]) => {
    const provider = detectSourceControlProviderFromGitRemoteUrl(url);
    const canonical = normalizeGitRemoteUrl(url);
    const ownerRepo = canonical.split("/").slice(1).join("/");
    const remote: {
      name: string;
      url: string;
      provider?: string;
      ownerRepo?: string;
    } = {
      name,
      url,
    };
    if (provider) remote.provider = provider.kind;
    if (ownerRepo) remote.ownerRepo = ownerRepo;
    return remote satisfies RepositoryRemote;
  });

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
    remotes,
  };
}

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);
const GIT_IDENTITY_PROBE_TIMEOUT_MS = 1_000;

interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

/**
 * Identity probes run through `VcsProcess`: governed by the process-wide git pool in the caller's
 * lane (the persisted identity sync runs them in the background lane), counted in the git command
 * metrics, never through a shell. The root is the process cwd rather than a `-C <path>` argument:
 * on Windows `shell: true` split unquoted roots with spaces (`C:\Users\Jane Doe`) into two
 * arguments, so those projects never got an identity, and every probe paid an extra cmd.exe.
 *
 * Answers the probe's stdout, `null` when git answered "not a repository" (`notRepository`), and
 * fails with `RepositoryIdentityProbeError` when git could not answer: a timeout, a spawn failure
 * or any other non-zero exit (dubious ownership, a broken config). Callers must not persist the
 * failure as "no repository".
 */
const NOT_A_REPOSITORY = /not a git repository/i;

const makeGitIdentityProbe =
  (vcsProcess: VcsProcess.VcsProcessShape) =>
  (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly notRepository?: boolean } = {},
  ): Effect.Effect<string | null, RepositoryIdentityProbeError> =>
    vcsProcess
      .run({
        operation,
        command: "git",
        args,
        cwd,
        // Like the driver's read-only git: C locale, and no optional index lock that could race
        // an agent's `git add` in the same checkout.
        env: { LC_ALL: "C", LANG: "C", ...READ_ONLY_GIT_ENV },
        allowNonZeroExit: true,
        timeoutMs: GIT_IDENTITY_PROBE_TIMEOUT_MS,
      })
      .pipe(
        withMetrics({
          counter: gitCommandsTotal,
          timer: gitCommandDuration,
          attributes: { operation },
        }),
        Effect.mapError(
          (cause) => new RepositoryIdentityProbeError({ operation, detail: cause.message }),
        ),
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.succeed(result.stdout);
          // The C locale (env above) keeps git's message stable.
          if (options.notRepository === true && NOT_A_REPOSITORY.test(result.stderr)) {
            return Effect.succeed(null);
          }
          return Effect.fail(
            new RepositoryIdentityProbeError({
              operation,
              detail: result.stderr.trim() || `git exited with code ${result.exitCode}.`,
            }),
          );
        }),
      );

export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const probe = makeGitIdentityProbe(yield* VcsProcess.VcsProcess);
    const resolveRepositoryIdentityCacheKey = (cwd: string) =>
      probe("RepositoryIdentityResolver.showToplevel", cwd, ["rev-parse", "--show-toplevel"], {
        notRepository: true,
      }).pipe(
        Effect.map((stdout) => {
          const candidate = stdout?.trim() ?? "";
          return candidate.length > 0 ? candidate : null;
        }),
      );
    const resolveRepositoryIdentityFromCacheKey = (cacheKey: string) =>
      probe("RepositoryIdentityResolver.listRemotes", cacheKey, ["remote", "-v"]).pipe(
        Effect.map((stdout) => {
          if (stdout === null) return null;
          const allRemotes = parseRemoteFetchUrls(stdout);
          const remote = pickPrimaryRemote(allRemotes);
          return remote
            ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey, allRemotes })
            : null;
        }),
      );

    // Failures are never cached (`onFailure: Duration.zero`): the next lookup probes again.
    const workspaceRootCache = yield* Cache.makeWith<
      string,
      string | null,
      RepositoryIdentityProbeError
    >(resolveRepositoryIdentityCacheKey, {
      capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null
            ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    });
    const repositoryIdentityCache = yield* Cache.makeWith<
      string,
      RepositoryIdentity | null,
      RepositoryIdentityProbeError
    >(resolveRepositoryIdentityFromCacheKey, {
      capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null
            ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    });

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(
      function* (cwd) {
        const cacheKey = yield* Cache.get(workspaceRootCache, cwd);
        if (cacheKey === null) return null;
        return yield* Cache.get(repositoryIdentityCache, cacheKey);
      },
      Effect.catchTag("RepositoryIdentityProbeError", () => Effect.succeed(null)),
    );

    const refresh: NonNullable<RepositoryIdentityResolverShape["refresh"]> = Effect.fn(
      "RepositoryIdentityResolver.refresh",
    )(function* (cwd) {
      // Probed outside the caches, then stored. The persisted sync refreshes in the background
      // lane; a pending cache entry would make an interactive `resolve` of the same root (the
      // `project.created` stream enrichment) wait behind background git.
      const cacheKey = yield* resolveRepositoryIdentityCacheKey(cwd);
      yield* Cache.set(workspaceRootCache, cwd, cacheKey);
      if (cacheKey === null) return null;
      const identity = yield* resolveRepositoryIdentityFromCacheKey(cacheKey);
      yield* Cache.set(repositoryIdentityCache, cacheKey, identity);
      return identity;
    });

    return {
      resolve,
      refresh,
    } satisfies RepositoryIdentityResolverShape;
  },
);

// `VcsProcess.layer` is stateless (the git pool is process-wide); layer memoization shares the
// instance the server root already provides.
export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
).pipe(Layer.provide(VcsProcess.layer));
