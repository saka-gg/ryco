import * as NodeServices from "@effect/platform-node/NodeServices";
import { realpath } from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationProjectShell,
} from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { ServerConfig } from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  assertWorktreeSetupComplete,
  withWorktreeSetupOwnership,
} from "../project/worktreeSetupState.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeGitVcsDriverCore } from "../vcs/GitVcsDriverCore.ts";
import { resolveBootstrapPreferences } from "../ws/context/bootstrapPreferences.ts";
import {
  acquireStorageSettingsLease,
  hasWorktreeCreationLease,
  storageLifecycleLock,
} from "./lifecycle.ts";
import { mintStorageCleanupClaim } from "./cleanupClaim.ts";
import { measureDirectory, type WorktreeIdentity } from "./filesystem.ts";

it.layer(
  Layer.mergeAll(
    NodeSqliteClient.layerMemory(),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "ryco-bootstrap-ownership-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
)("project bootstrap and cleanup ownership", (it) => {
  it.effect(
    "uses one project snapshot through checkout policy and records only completed setup",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-combined-bootstrap-" });
        const root = yield* Effect.promise(() => realpath(temporary));
        const repo = path.join(root, "repository");
        const checkoutRoot = path.join(root, "checkouts");
        yield* fs.makeDirectory(repo);
        const base = yield* makeGitVcsDriverCore();
        const git = (args: readonly string[]) =>
          base.execute({ operation: "fixture", cwd: repo, args, timeoutMs: 10_000 });
        yield* git(["init", "--initial-branch=main"]);
        yield* git(["config", "user.name", "Integration fixture"]);
        yield* git(["config", "user.email", "fixture@example.invalid"]);
        yield* fs.writeFileString(path.join(repo, "tracked.txt"), "retain\n");
        // This URL cannot hydrate: the project's none policy must win over node recursive.
        yield* fs.writeFileString(
          path.join(repo, ".gitmodules"),
          '[submodule "fixture"]\npath = modules/fixture\nurl = /nonexistent/fixture\n',
        );
        yield* fs.writeFileString(path.join(repo, "ryco.json"), "{}");
        yield* git(["add", "."]);
        yield* git(["commit", "-m", "fixture"]);

        const projectId = ProjectId.make("combined-project");
        const project = {
          id: projectId,
          workspaceRoot: repo,
          defaultModelSelection: null,
        } as OrchestrationProjectShell;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("explicit-comparison-provider"),
          model: "explicit-comparison-model",
          options: [{ id: "fastMode", value: true }],
        };
        const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          worktreeRoot: checkoutRoot,
          worktreeSubmodules: "recursive",
          projectWorktreeSubmodules: { [projectId]: "none" },
          runSetupScript: true,
          projectPreferences: {
            [projectId]: { worktreeBranchPrefix: "comparison/tasks", runSetupScript: false },
          },
        });
        let settingsReads = 0;
        const resolved = yield* resolveBootstrapPreferences({
          bootstrap: {
            requireWorktree: true,
            createThread: {
              projectId,
              title: "Comparison",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            },
            prepareWorktree: { projectCwd: repo, baseBranch: "main" },
          },
          settings: { getSettings: Effect.sync(() => (settingsReads++, settings)) },
          projects: {
            getProjectShellById: () => Effect.succeed(Option.some(project)),
            getActiveProjectByWorkspaceRoot: () => Effect.die("Unexpected second project lookup"),
          },
          workspaceAccess: { assertExistingPath: ({ path }) => Effect.succeed(path) },
        });
        assert.equal(settingsReads, 1);
        assert.isFalse(resolved.runSetupScript);
        assert.deepEqual(resolved.choices.modelSelection, modelSelection);
        const branch = `${resolved.choices.worktreeBranchPrefix}/destination-one`;
        const destination = path.join(
          checkoutRoot,
          path.basename(repo),
          branch.replaceAll("/", "-"),
        );
        const operations: string[] = [];
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              operations.push(input.operation);
              if (input.operation === "GitVcsDriver.createWorktree") {
                const target = input.args.at(-2)!;
                assert.isTrue(hasWorktreeCreationLease(target));
                assert.equal(
                  (yield* sql`SELECT id FROM storage_owned_entries WHERE path = ${target}`.pipe(
                    Effect.orDie,
                  )).length,
                  0,
                );
              }
              return yield* base.execute(input);
            }),
        }).pipe(
          Effect.provideService(ServerSettingsService, {
            getSettings: Effect.die("Checkout must reuse the authorized settings snapshot"),
          } as never),
        );
        const created = yield* driver.createWorktree({
          cwd: repo,
          path: null,
          refName: "main",
          newRefName: branch,
          projectId,
          settingsSnapshot: resolved.settings,
        });
        assert.equal(created.worktree.path, destination);
        assert.equal(created.submoduleInitialization?.mode, "none");
        assert.equal(created.submoduleInitialization?.source, "project");
        assert.notInclude(operations, "GitVcsDriver.createWorktree.initializeSubmodules");
        assert.isFalse(hasWorktreeCreationLease(destination));
        const rows = yield* sql<{
          id: string;
          state: string;
          repository_path: string;
          identity_json: string;
        }>`
        SELECT id, state, repository_path, identity_json FROM storage_owned_entries WHERE path = ${destination}`;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.state, "owned");
        assert.equal(rows[0]!.repository_path, repo);
        assert.isNotNull(JSON.parse(rows[0]!.identity_json));
        yield* assertWorktreeSetupComplete(config.stateDir, destination);
        // Model a completed, merged change that no longer owns any submodule declaration.
        // The earlier creation assertions still prove that project policy skipped hydration.
        yield* base.execute({
          operation: "fixture.remove-submodules",
          cwd: destination,
          args: ["rm", ".gitmodules"],
          timeoutMs: 10_000,
        });
        yield* base.execute({
          operation: "fixture.commit",
          cwd: destination,
          args: ["commit", "-m", "complete submodule removal"],
          timeoutMs: 10_000,
        });
        yield* git(["merge", "--ff-only", branch]);
        const measured = yield* Effect.promise(() =>
          measureDirectory(
            destination,
            { remaining: 30_000, deadline: Date.now() + 3000 },
            new Set(),
            true,
          ),
        );
        const settingsLease = yield* storageLifecycleLock.withPermit(
          Effect.sync(acquireStorageSettingsLease),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => settingsLease.release()));
        const identity = JSON.parse(rows[0]!.identity_json) as WorktreeIdentity;
        const quarantine = path.join(path.dirname(destination), ".cleanup-held-owner");
        yield* sql`UPDATE storage_owned_entries SET state = 'removing', identity_json = ${JSON.stringify({ ...identity, quarantinePath: quarantine })} WHERE id = ${rows[0]!.id}`;
        const claim = yield* mintStorageCleanupClaim(sql, {
          id: rows[0]!.id,
          repository: repo,
          candidate: destination,
          quarantine,
          fingerprint: measured.fingerprint!,
          identity,
          lease: settingsLease,
        });
        const cleanup = {
          quarantinePath: quarantine,
          fingerprint: measured.fingerprint!,
          identity,
          claim,
        };
        // A second core's private cleanup mode must honor another live setup owner.
        yield* withWorktreeSetupOwnership(config.stateDir, destination, () =>
          Effect.gen(function* () {
            const refused = yield* base
              .removeWorktree({ cwd: repo, path: destination, cleanup })
              .pipe(Effect.flip);
            assert.include(refused.detail, "owned by another active");
            assert.isTrue(yield* fs.exists(destination));
            assert.isFalse(yield* fs.exists(cleanup.quarantinePath));
          }),
        );

        // After owner release, this eligible merged checkout accepts the authentic claim.
        yield* base.removeWorktree({ cwd: repo, path: destination, cleanup });
        assert.isFalse(yield* fs.exists(destination));
        assert.isFalse(yield* fs.exists(quarantine));
        assert.include(yield* base.listWorktreePaths(repo), destination);
        assert.include(yield* base.listLocalBranchNames(repo), branch);

        // A failed branch policy leaves its registered checkout protected, not cleanup-owned.
        yield* fs.writeFileString(path.join(repo, "ryco.json"), "{malformed");
        yield* git(["add", "ryco.json"]);
        yield* git(["commit", "-m", "invalid branch setup"]);
        const incomplete = path.join(checkoutRoot, "incomplete");
        const outcome = yield* Effect.exit(
          driver.createWorktree({
            cwd: repo,
            path: incomplete,
            refName: "main",
            newRefName: "comparison/incomplete",
            projectId,
            settingsSnapshot: { ...resolved.settings, projectWorktreeSubmodules: {} },
          }),
        );
        assert.equal(outcome._tag, "Failure");
        assert.isTrue(yield* fs.exists(incomplete));
        assert.equal(
          (yield* sql`SELECT id FROM storage_owned_entries WHERE path = ${incomplete}`).length,
          0,
        );
        assert.isFalse(hasWorktreeCreationLease(incomplete));
        assert.equal(
          (yield* Effect.exit(assertWorktreeSetupComplete(config.stateDir, incomplete)))._tag,
          "Failure",
        );
        const failedManifest = yield* Effect.promise(() =>
          measureDirectory(
            incomplete,
            { remaining: 30_000, deadline: Date.now() + 3000 },
            new Set(),
            true,
          ),
        );
        const protectedResult = yield* base
          .removeWorktree({
            cwd: repo,
            path: incomplete,
            cleanup: {
              ...cleanup,
              quarantinePath: path.join(checkoutRoot, ".cleanup-incomplete"),
              fingerprint: failedManifest.fingerprint!,
            },
          })
          .pipe(Effect.flip);
        assert.include(protectedResult.detail, "incomplete setup");
        assert.isTrue(yield* fs.exists(incomplete));
      }),
  );
});
