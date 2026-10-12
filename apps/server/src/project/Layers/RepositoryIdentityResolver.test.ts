import { realpathSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";

import { runProcess } from "../../processRunner.ts";
import {
  GIT_PROCESS_LIMIT,
  governChildProcess,
  inBackgroundProcessLane,
  ProcessLaneRef,
  processGovernorStats,
} from "../../processGovernor.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { RepositoryIdentityResolver } from "../Services/RepositoryIdentityResolver.ts";
import {
  makeRepositoryIdentityResolver,
  RepositoryIdentityResolverLive,
} from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) =>
  normalizePathSeparators(realpathSync.native(value));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(() => runProcess("git", ["-C", cwd, ...args]));

const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver,
    makeRepositoryIdentityResolver({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(VcsProcess.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Ryco/ryco.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/ryco/ryco");
      expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(cwd));
      expect(identity?.displayName).toBe("ryco/ryco");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("ryco");
      expect(identity?.name).toBe("ryco");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = `${repoRoot}/packages/web`;

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:Ryco/ryco.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/ryco/ryco");
      expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(repoRoot));
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("prefers upstream over origin when both remotes are configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-upstream-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/ryco.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:Ryco/ryco.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.locator.remoteName).toBe("upstream");
      expect(identity?.canonicalKey).toBe("github.com/ryco/ryco");
      expect(identity?.displayName).toBe("ryco/ryco");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:Ryco/platform/ryco.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/ryco/platform/ryco");
      expect(identity?.displayName).toBe("ryco/platform/ryco");
      expect(identity?.owner).toBe("ryco");
      expect(identity?.name).toBe("ryco");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "ryco-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:Ryco/ryco.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/ryco/ryco");
        expect(refreshedIdentity?.name).toBe("ryco");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            makeRepositoryIdentityResolverTestLayer({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Ryco/ryco.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/ryco/ryco");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:Ryco/ryco-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/ryco/ryco");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/ryco/ryco-next");
      expect(refreshedIdentity?.displayName).toBe("ryco/ryco-next");
      expect(refreshedIdentity?.name).toBe("ryco-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeRepositoryIdentityResolverTestLayer({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );

  it.effect("populates all remotes in addition to the auto-picked locator", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-remotes-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:sak0a/ryco.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:Ryco/ryco.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      if (identity === null) {
        throw new Error("Expected repository identity to resolve.");
      }
      // Auto-pick prefers upstream over origin.
      expect(identity.locator.remoteName).toBe("upstream");
      const remotes = identity.remotes ?? [];
      const remoteNames = remotes.map((remote) => remote.name).toSorted();
      expect(remoteNames).toEqual(["origin", "upstream"]);
      const origin = remotes.find((remote) => remote.name === "origin");
      expect(origin?.ownerRepo).toBe("sak0a/ryco");
      expect(origin?.provider).toBe("github");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );
  it.effect("resolves roots whose path contains spaces", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-spaces-",
      });
      // The probe runs with the root as its cwd, not as a `-C` argument a shell could split.
      const cwd = `${parent}/Jane Doe/my project`;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Ryco/ryco.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("github.com/ryco/ryco");
      expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(cwd));
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("refresh bypasses a cached identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-refresh-",
      });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Ryco/before.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/ryco/before");
      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:Ryco/after.git"]);
      // Still cached for `resolve`; `refresh` probes again and updates the cache.
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/ryco/before");
      expect((yield* resolver.refresh!(cwd))?.canonicalKey).toBe("github.com/ryco/after");
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/ryco/after");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("probes through the governed git pool, in the caller's lane", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-governed-",
      });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Ryco/ryco.git"]);
      const admittedBefore =
        processGovernorStats().find((stats) => stats.pool === "git")?.admittedTotal ?? 0;

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.refresh!(cwd).pipe(
        Effect.provideService(ProcessLaneRef, "background"),
      );
      expect(identity?.canonicalKey).toBe("github.com/ryco/ryco");
      const admittedAfter =
        processGovernorStats().find((stats) => stats.pool === "git")?.admittedTotal ?? 0;
      // `rev-parse --show-toplevel` and `remote -v`, both admitted by the git pool.
      expect(admittedAfter - admittedBefore).toBe(2);
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("an interactive resolve never waits behind a background refresh of the same root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-repository-identity-lanes-",
      });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Ryco/ryco.git"]);
      const gitQueued = () =>
        processGovernorStats().find((stats) => stats.pool === "git")?.queued ?? 0;

      // Interactive children fill the git pool, so background work queues behind them.
      const blockers = yield* Effect.forEach(Array.from({ length: GIT_PROCESS_LIMIT }), () =>
        governChildProcess("git", Effect.never).pipe(Effect.forkChild),
      );
      const resolver = yield* RepositoryIdentityResolver;
      const refreshing = yield* resolver.refresh!(cwd).pipe(
        inBackgroundProcessLane,
        Effect.forkChild,
      );
      for (let index = 0; index < 100 && gitQueued() === 0; index++) yield* Effect.yieldNow;
      expect(gitQueued()).toBe(1);

      // The stream's `project.created` enrichment resolves the same root meanwhile.
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/ryco/ryco");
      expect(refreshing.pollUnsafe()).toBeUndefined();

      yield* Effect.forEach(blockers, Fiber.interrupt, { discard: true });
      expect((yield* Fiber.join(refreshing))?.canonicalKey).toBe("github.com/ryco/ryco");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );
});
