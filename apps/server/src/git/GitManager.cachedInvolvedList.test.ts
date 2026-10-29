import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { detectSourceControlProviderFromRemoteUrl } from "@ryco/shared/sourceControl";

import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { SourceControlProviderShape } from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeGitManager } from "./GitManager.ts";

/** Checkouts by path; none exists on disk, the registry answers from this table. */
const remotes: Readonly<Record<string, string>> = {
  "/work/app": "git@github.com:acme/app.git",
  "/work/app-worktree": "git@github.com:acme/app.git",
  "/work/api": "https://github.com/acme/api.git",
  "/work/enterprise": "https://github.example.com/acme/tools.git",
  "/work/tools": "https://gitlab.com/acme/tools.git",
  "/work/docs": "https://gitlab.com/acme/docs.git",
};

const registry = SourceControlProviderRegistry.of({
  get: () => Effect.die("unused"),
  resolve: () => Effect.die("unused"),
  discover: Effect.succeed([]),
  detectProviderFromRemoteUrl: () => null,
  resolveHandle: ({ cwd }) => {
    const remoteUrl = remotes[cwd];
    const provider = remoteUrl ? detectSourceControlProviderFromRemoteUrl(remoteUrl) : null;
    return Effect.succeed(
      provider === null || remoteUrl === undefined
        ? { provider: { kind: "unknown" } as SourceControlProviderShape, context: null }
        : {
            provider: { kind: provider.kind } as SourceControlProviderShape,
            context: { provider, remoteName: "origin", remoteUrl },
          },
    );
  },
});

const managerLayer = Layer.mergeAll(
  Layer.succeed(SourceControlProviderRegistry, registry),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(TextGeneration)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  ServerSettingsService.layerTest(),
  NodeServices.layer,
);

const counting = () => {
  const loads: string[] = [];
  return {
    loads,
    load: (label: string) => Effect.sync(() => (loads.push(label), loads.length)),
  };
};

describe("GitManager.cachedInvolvedList", () => {
  it.effect("shares one host read across the host's checkouts until a mutation there", () =>
    Effect.gen(function* () {
      const manager = yield* makeGitManager();
      const { loads, load } = counting();
      const read = (cwd: string) =>
        manager.cachedInvolvedList({
          cwd,
          scope: "host",
          key: "review-requested",
          load: load(cwd),
          ttlMs: 240_000,
        });

      expect(yield* read("/work/app")).toBe(1);
      expect(yield* read("/work/api")).toBe(1);
      expect(yield* read("/work/enterprise")).toBe(2);

      // A merge through any checkout of github.com drops github.com's search only.
      yield* manager.invalidateRepositoryLists("/work/api");
      expect(yield* read("/work/app")).toBe(3);
      expect(yield* read("/work/enterprise")).toBe(2);
      expect(loads).toEqual(["/work/app", "/work/enterprise", "/work/app"]);
    }).pipe(Effect.provide(managerLayer)),
  );

  it.effect("leaves involvement reads alone on remote refreshes, which every poll runs", () =>
    Effect.gen(function* () {
      const manager = yield* makeGitManager();
      const { load } = counting();
      const read = (scope: "host" | "repository", cwd: string) =>
        manager.cachedInvolvedList({
          cwd,
          scope,
          key: "authored",
          load: load(cwd),
          ttlMs: 240_000,
        });

      expect(yield* read("host", "/work/app")).toBe(1);
      expect(yield* read("repository", "/work/tools")).toBe(2);
      yield* manager.invalidateRemoteStatus("/work/app");
      yield* manager.invalidateRemoteStatus("/work/tools");
      expect(yield* read("host", "/work/app")).toBe(1);
      expect(yield* read("repository", "/work/tools")).toBe(2);
    }).pipe(Effect.provide(managerLayer)),
  );

  it.effect("keys repository reads by repository, apart from the page's lists", () =>
    Effect.gen(function* () {
      const manager = yield* makeGitManager();
      const { load } = counting();
      const involved = (cwd: string) =>
        manager.cachedInvolvedList({
          cwd,
          scope: "repository",
          key: "same-key",
          load: load(cwd),
          ttlMs: 240_000,
        });

      expect(yield* involved("/work/tools")).toBe(1);
      expect(yield* involved("/work/docs")).toBe(2);
      expect(yield* involved("/work/app")).toBe(3);
      expect(yield* involved("/work/app-worktree")).toBe(3);
      // The page's list under the same key is a different entry.
      expect(
        yield* manager.cachedRepositoryList({
          cwd: "/work/tools",
          key: "same-key",
          load: load("page"),
        }),
      ).toBe(4);

      yield* manager.invalidateRepositoryLists("/work/tools");
      expect(yield* involved("/work/tools")).toBe(5);
      expect(yield* involved("/work/docs")).toBe(2);
    }).pipe(Effect.provide(managerLayer)),
  );

  it.effect("reads uncached for a checkout without a known host", () =>
    Effect.gen(function* () {
      const manager = yield* makeGitManager();
      const { load } = counting();
      const read = () =>
        manager.cachedInvolvedList({
          cwd: "/scratch",
          scope: "host",
          key: "k",
          load: load("/scratch"),
          ttlMs: 240_000,
        });
      expect(yield* read()).toBe(1);
      expect(yield* read()).toBe(2);
    }).pipe(Effect.provide(managerLayer)),
  );
});
