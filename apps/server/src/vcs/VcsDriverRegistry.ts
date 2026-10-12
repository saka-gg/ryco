import { stat } from "node:fs/promises";
import nodePath from "node:path";

import { Cache, Context, Duration, Effect, Exit, Layer } from "effect";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@ryco/contracts";
import { VcsUnsupportedOperationError } from "@ryco/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
/** A folder that is not a repository may become one (`git init`); recheck soon. */
const NEGATIVE_DETECTION_CACHE_TTL = Duration.seconds(2);
/**
 * A detected repository is kept much longer: every read revalidates it with a
 * stat of the checkout's `.git` (file or directory), whose identity changes
 * when the checkout is removed, re-cloned or re-initialized.
 */
const POSITIVE_DETECTION_CACHE_TTL = Duration.minutes(2);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriverShape;
}

export interface VcsDriverRegistryShape {
  readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriverShape, VcsError>;
  readonly detect: (
    input: VcsDriverResolveInput,
  ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
  readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
}

export class VcsDriverRegistry extends Context.Service<VcsDriverRegistry, VcsDriverRegistryShape>()(
  "ryco/vcs/VcsDriverRegistry",
) {}

const unsupported = (operation: string, kind: VcsDriverKind, detail: string) =>
  new VcsUnsupportedOperationError({
    operation,
    kind,
    detail,
  });

interface CachedDetection {
  readonly handle: VcsDriverHandle | null;
  /** Identity of `<root>/.git` when detected; null when absent or not a repository. */
  readonly gitPathIdentity: string | null;
}

/** Device, inode and kind of the checkout's `.git`, or null when it cannot be read. */
const readGitPathIdentity = (rootPath: string) =>
  Effect.promise(() =>
    stat(nodePath.join(rootPath, ".git")).then(
      (stats) => `${stats.dev}:${stats.ino}:${stats.isDirectory() ? "d" : "f"}`,
      () => null,
    ),
  );

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return {
      cwd: key,
      requestedKind: "auto",
    };
  }
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.fn("makeVcsDriverRegistry")(function* () {
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriverShape();
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriverShape>> = {
    git,
  };

  const get: VcsDriverRegistryShape["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        unsupported("VcsDriverRegistry.get", kind, `No ${kind} VCS driver is registered.`),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriverShape,
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    return yield* detectWithDriver("git", git, input.cwd);
  });

  const detectionCache = yield* Cache.makeWith<string, CachedDetection, VcsError>(
    (key) =>
      detectResolvedKind(parseDetectionCacheKey(key)).pipe(
        Effect.flatMap((handle): Effect.Effect<CachedDetection> =>
          handle === null
            ? Effect.succeed({ handle, gitPathIdentity: null })
            : readGitPathIdentity(handle.repository.rootPath).pipe(
                Effect.map((gitPathIdentity) => ({ handle, gitPathIdentity })),
              ),
        ),
      ),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? exit.value.handle !== null && exit.value.gitPathIdentity !== null
            ? POSITIVE_DETECTION_CACHE_TTL
            : NEGATIVE_DETECTION_CACHE_TTL
          : Duration.zero,
    },
  );

  const detect: VcsDriverRegistryShape["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = yield* projectConfig.resolveKind(input);
      const key = detectionCacheKey({ cwd: input.cwd, requestedKind });
      const cached = yield* Cache.get(detectionCache, key);
      if (cached.handle === null || cached.gitPathIdentity === null) {
        return cached.handle;
      }
      const rootPath = cached.handle.repository.rootPath;
      const currentIdentity = yield* readGitPathIdentity(rootPath);
      // A folder below the root that gained its own `.git` (a nested `git init`)
      // is a different repository now.
      const nestedIdentity =
        currentIdentity === cached.gitPathIdentity && nodePath.resolve(input.cwd) !== rootPath
          ? yield* readGitPathIdentity(input.cwd)
          : null;
      if (
        currentIdentity === cached.gitPathIdentity &&
        (nestedIdentity === null || nestedIdentity === currentIdentity)
      ) {
        return cached.handle;
      }
      yield* Cache.invalidate(detectionCache, key);
      return (yield* Cache.get(detectionCache, key)).handle;
    },
  );

  const resolve: VcsDriverRegistryShape["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* unsupported(
        "VcsDriverRegistry.resolve",
        requestedKind === "auto" ? "unknown" : requestedKind,
        requestedKind === "auto"
          ? `No supported VCS repository was detected at ${input.cwd}.`
          : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      );
    },
  );

  return VcsDriverRegistry.of({
    get,
    detect,
    resolve,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make()).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
