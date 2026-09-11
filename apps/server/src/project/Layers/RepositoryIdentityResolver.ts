import type { RepositoryIdentity, RepositoryRemote } from "@ryco/contracts";
import { Cache, Duration, Effect, Exit, Layer } from "effect";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@ryco/shared/git";

import { runProcess } from "../../processRunner.ts";
import {
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

async function resolveRepositoryIdentityCacheKey(cwd: string): Promise<string | null> {
  try {
    const topLevelResult = await runProcess("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      allowNonZeroExit: true,
      timeoutMs: GIT_IDENTITY_PROBE_TIMEOUT_MS,
    });
    if (topLevelResult.timedOut || topLevelResult.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.stdout.trim();
    if (candidate.length > 0) {
      return candidate;
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveRepositoryIdentityFromCacheKey(
  cacheKey: string,
): Promise<RepositoryIdentity | null> {
  try {
    const remoteResult = await runProcess("git", ["-C", cacheKey, "remote", "-v"], {
      allowNonZeroExit: true,
      timeoutMs: GIT_IDENTITY_PROBE_TIMEOUT_MS,
    });
    if (remoteResult.timedOut || remoteResult.code !== 0) {
      return null;
    }

    const allRemotes = parseRemoteFetchUrls(remoteResult.stdout);
    const remote = pickPrimaryRemote(allRemotes);
    return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey, allRemotes }) : null;
  } catch {
    return null;
  }
}

export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const workspaceRootCache = yield* Cache.makeWith<string, string | null>(
      (cwd) => Effect.promise(() => resolveRepositoryIdentityCacheKey(cwd)),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );
    const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
      (cacheKey) => Effect.promise(() => resolveRepositoryIdentityFromCacheKey(cacheKey)),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(function* (cwd) {
      const cacheKey = yield* Cache.get(workspaceRootCache, cwd);
      if (cacheKey === null) return null;
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    });

    return {
      resolve,
    } satisfies RepositoryIdentityResolverShape;
  },
);

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
);
