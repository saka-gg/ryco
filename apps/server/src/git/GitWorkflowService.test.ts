import { assert, describe, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import os from "node:os";
import path from "node:path";

import { GitCommandError, GitManagerError, VcsProcessSpawnError } from "@ryco/contracts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: { readonly detect: VcsDriverRegistry.VcsDriverRegistryShape["detect"] }) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("reads a folder that no longer exists as no repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const gone = path.join(os.tmpdir(), `ryco-missing-${crypto.randomUUID()}`);
      const status = yield* workflow.localStatus({ cwd: gone });
      assert.strictEqual(status.isRepo, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          // Git cannot start in a missing working directory.
          detect: ({ cwd }) =>
            Effect.fail(
              new VcsProcessSpawnError({
                operation: "GitVcsDriver.detectRepository",
                command: "git rev-parse",
                cwd,
                cause: new Error("spawn git ENOENT"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("still fails status when detection fails in a folder that exists", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* Effect.flip(workflow.localStatus({ cwd: os.tmpdir() }));
      assert.instanceOf(result, GitManagerError);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) =>
            Effect.fail(
              new VcsProcessSpawnError({
                operation: "GitVcsDriver.detectRepository",
                command: "git rev-parse",
                cwd,
                cause: new Error("spawn git EACCES"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("refreshes no remote-tracking refs outside a Git repository", () => {
    const refreshRemoteTrackingRefs = vi.fn(() => Effect.succeed(true));
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: ({ cwd }) =>
            Effect.succeed(
              cwd === "/not-a-repo"
                ? null
                : ({
                    kind: cwd === "/jj" ? "jj" : "git",
                  } as unknown as VcsDriverRegistry.VcsDriverHandle),
            ),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(GitManager.GitManager)({ refreshRemoteTrackingRefs })),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.isFalse(yield* workflow.refreshRemoteTrackingRefs("/not-a-repo"));
      assert.isFalse(yield* workflow.refreshRemoteTrackingRefs("/jj"));
      assert.equal(refreshRemoteTrackingRefs.mock.calls.length, 0);

      assert.isTrue(yield* workflow.refreshRemoteTrackingRefs("/repo"));
      assert.deepStrictEqual(refreshRemoteTrackingRefs.mock.calls, [["/repo"]]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("treats deleted status paths as non-repositories after stale VCS detection", () => {
    const detect = vi.fn(() =>
      Effect.succeed({
        kind: "git",
        repository: {
          kind: "git",
          rootPath: missingCwd,
          metadataPath: null,
          freshness: {
            source: "live-local",
            observedAt: new Date(),
            expiresAt: null,
          },
        },
        driver: {},
      } as unknown as VcsDriverRegistry.VcsDriverHandle),
    );
    const missingCwd = path.join(
      os.tmpdir(),
      `ryco-missing-status-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const status = vi.fn(() =>
      Effect.fail(
        new GitManagerError({
          operation: "GitWorkflowService.status",
          detail: "cwd disappeared",
        }),
      ),
    );
    const remoteStatus = vi.fn(() =>
      Effect.fail(
        new GitManagerError({
          operation: "GitWorkflowService.remoteStatus",
          detail: "cwd disappeared",
        }),
      ),
    );
    const listRefs = vi.fn(() =>
      Effect.fail(
        new GitCommandError({
          operation: "GitWorkflowService.listRefs",
          command: "git branch",
          cwd: missingCwd,
          detail: "cwd disappeared",
        }),
      ),
    );

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect,
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          listRefs,
        }),
      ),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const fullStatus = yield* workflow.status({ cwd: missingCwd });
      const remote = yield* workflow.remoteStatus({ cwd: missingCwd });
      const refs = yield* workflow.listRefs({ cwd: missingCwd });

      assert.equal(fullStatus.isRepo, false);
      assert.equal(remote, null);
      assert.deepStrictEqual(refs.refs, []);
      assert.equal(detect.mock.calls.length, 3);
      assert.equal(remoteStatus.mock.calls.length, 1);
      assert.equal(status.mock.calls.length, 1);
      assert.equal(listRefs.mock.calls.length, 1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );
});
