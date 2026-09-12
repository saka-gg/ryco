import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { WorkspaceAccessPolicyLayer } from "../../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { AgentControlProjectPlans } from "../Services/AgentControlProjectPlans.ts";
import { AgentControlProjectPlansLive } from "./AgentControlProjectPlans.ts";

const NOW = "2026-08-18T00:00:00.000Z";

const project = (workspaceRoot: string) =>
  Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id: "project-1",
    title: "Project one",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  });

const thread = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: "thread-1",
  projectId: "project-1",
  title: "Thread one",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const makeLayer = (
  accessRoot: string,
  getSnapshot: () => Effect.Effect<OrchestrationShellSnapshot>,
) =>
  AgentControlProjectPlansLive.pipe(
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getShellSnapshot: getSnapshot,
      } as unknown as ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(WorkspaceAccessPolicyLayer(accessRoot)),
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("canonicalizes only existing authorized project roots without creating directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const accessRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ac-project-root-" });
      const existingRoot = `${accessRoot}/existing`;
      yield* fs.makeDirectory(existingRoot);
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ac-project-outside-" });
      const snapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: NOW,
      };
      const layer = makeLayer(accessRoot, () => Effect.succeed(snapshot));

      const prepared = yield* Effect.gen(function* () {
        const plans = yield* AgentControlProjectPlans;
        return yield* plans.prepareCreate({
          projectId: ProjectId.make("project-new"),
          title: "New project",
          workspaceRoot: existingRoot,
        });
      }).pipe(Effect.provide(layer));
      assert.strictEqual(prepared.workspaceRoot, yield* fs.realPath(existingRoot));
      assert.strictEqual(prepared.projectMetadataDir, ".ryco");

      const missingRoot = `${accessRoot}/missing`;
      const missing = yield* Effect.gen(function* () {
        const plans = yield* AgentControlProjectPlans;
        return yield* plans
          .prepareCreate({
            projectId: ProjectId.make("project-missing"),
            title: "Missing",
            workspaceRoot: missingRoot,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(missing.reason, "invalid-plan");
      assert.isFalse(yield* fs.exists(missingRoot));

      const outside = yield* Effect.gen(function* () {
        const plans = yield* AgentControlProjectPlans;
        return yield* plans
          .prepareCreate({
            projectId: ProjectId.make("project-outside"),
            title: "Outside",
            workspaceRoot: outsideRoot,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(outside.reason, "invalid-plan");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("captures revisions and exact thread targets, then rejects stale project plans", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const accessRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ac-project-state-" });
      let snapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 1,
        projects: [project(accessRoot)],
        threads: [
          thread,
          {
            ...thread,
            id: ThreadId.make("thread-archived"),
            title: "Archived thread",
            archivedAt: NOW,
          },
        ],
        updatedAt: NOW,
      };
      const layer = makeLayer(accessRoot, () => Effect.sync(() => snapshot));

      const plans = yield* Effect.gen(function* () {
        const service = yield* AgentControlProjectPlans;
        const update = yield* service.prepareUpdate({
          projectId: ProjectId.make("project-1"),
          expectedUpdatedAt: NOW,
          title: "Renamed",
        });
        const remove = yield* service.prepareRemove({
          projectId: ProjectId.make("project-1"),
          expectedUpdatedAt: NOW,
          force: true,
        });
        return { service, update, remove };
      }).pipe(Effect.provide(layer));

      assert.strictEqual(plans.update.before.title, "Project one");
      assert.strictEqual(plans.update.after.title, "Renamed");
      assert.deepStrictEqual(plans.remove.expectedThreadIds, [
        ThreadId.make("thread-1"),
        ThreadId.make("thread-archived"),
      ]);

      const noOp = yield* plans.service
        .prepareUpdate({
          projectId: ProjectId.make("project-1"),
          expectedUpdatedAt: NOW,
          title: "Project one",
        })
        .pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(noOp.reason, "invalid-plan");

      const outsideRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "ryco-ac-project-update-outside-",
      });
      const unauthorizedUpdate = yield* plans.service
        .prepareUpdate({
          projectId: ProjectId.make("project-1"),
          expectedUpdatedAt: NOW,
          workspaceRoot: outsideRoot,
        })
        .pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(unauthorizedUpdate.reason, "invalid-plan");

      const nonEmptyRemoval = yield* plans.service
        .prepareRemove({
          projectId: ProjectId.make("project-1"),
          expectedUpdatedAt: NOW,
        })
        .pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(nonEmptyRemoval.reason, "invalid-plan");

      snapshot = { ...snapshot, threads: [] };
      const staleRemoval = yield* plans.service
        .revalidate(plans.remove)
        .pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(staleRemoval.reason, "project-stale");

      snapshot = {
        ...snapshot,
        projects: [{ ...snapshot.projects[0]!, title: "Changed", updatedAt: `${NOW}-changed` }],
      };
      const staleUpdate = yield* plans.service
        .revalidate(plans.update)
        .pipe(Effect.provide(layer), Effect.flip);
      assert.strictEqual(staleUpdate.reason, "project-stale");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect(
  "captures project preferences and rejects stale edits with the shared revision guard",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "ryco-ac-preferences-" })
          .pipe(Effect.flatMap((path) => fs.realPath(path)));
        const snapshot = {
          snapshotSequence: 1,
          projects: [project(root)],
          threads: [],
          updatedAt: NOW,
        };
        yield* Effect.gen(function* () {
          const plans = yield* AgentControlProjectPlans;
          const update = yield* plans.prepareUpdate({
            projectId: ProjectId.make("project-1"),
            expectedUpdatedAt: NOW,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "test-model",
            },
            customSystemPrompt: "Keep changes focused.",
            scripts: [
              {
                id: "test",
                name: "Test",
                command: "bun run test",
                icon: "test",
                runOnWorktreeCreate: false,
              },
            ],
            preferredRemoteName: "origin",
          });
          assert.strictEqual(update.before.defaultModelSelection, null);
          assert.strictEqual(update.after.defaultModelSelection?.model, "test-model");
          assert.strictEqual(update.after.scripts?.[0]?.command, "bun run test");
          yield* plans.revalidate(update);
          snapshot.projects = [{ ...project(root), updatedAt: "2026-08-18T00:01:00.000Z" }];
          assert.strictEqual(
            (yield* plans.revalidate(update).pipe(Effect.flip)).reason,
            "project-stale",
          );
        }).pipe(Effect.provide(makeLayer(root, () => Effect.succeed(snapshot))));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
