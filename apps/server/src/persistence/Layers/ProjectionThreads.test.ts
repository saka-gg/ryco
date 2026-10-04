import { ProjectId, ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { runMigrations } from "../Migrations.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const BASE_ROW = {
  threadId: ThreadId.make("thread-settlement"),
  projectId: ProjectId.make("project-1"),
  title: "Settlement",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  tokenMode: "balanced",
  branch: null,
  worktreePath: null,
  worktreeId: null,
  manualStatusBucket: null,
  manualPosition: 0,
  latestTurnId: null,
  goal: null,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
  lineageParentThreadId: null,
  lineageRootThreadId: null,
  lineageRelationship: null,
} as const;

layer("ProjectionThreadRepository settlement", (it) => {
  it.effect("round-trips and clears settlement state", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 52 });
      const repository = yield* ProjectionThreadRepository;

      yield* repository.upsert({
        ...BASE_ROW,
        settledOverride: "settled",
        settledAt: "2026-07-31T01:00:00.000Z",
      });
      const settled = yield* repository.getById({ threadId: BASE_ROW.threadId });
      assert.isTrue(Option.isSome(settled));
      if (Option.isSome(settled)) {
        assert.equal(settled.value.settledOverride, "settled");
        assert.equal(settled.value.settledAt, "2026-07-31T01:00:00.000Z");
      }

      yield* repository.upsert({
        ...BASE_ROW,
        settledOverride: "active",
        settledAt: null,
      });
      const active = yield* repository.getById({ threadId: BASE_ROW.threadId });
      assert.isTrue(Option.isSome(active));
      if (Option.isSome(active)) {
        assert.equal(active.value.settledOverride, "active");
        assert.isNull(active.value.settledAt);
      }
    }),
  );
});

layer("ProjectionThreadRepository lineage", (it) => {
  it.effect("round-trips lineage columns and overwrites them on upsert", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-lineage-child");
      const lineageColumns = {
        lineageParentThreadId: ThreadId.make("thread-lineage-parent"),
        lineageRootThreadId: ThreadId.make("thread-lineage-root"),
        lineageRelationship: "delegated",
      };

      yield* repository.upsert({ ...BASE_ROW, threadId, ...lineageColumns });
      const child = yield* repository.getById({ threadId });
      assert.isTrue(Option.isSome(child));
      if (Option.isSome(child)) {
        assert.equal(child.value.lineageParentThreadId, "thread-lineage-parent");
        assert.equal(child.value.lineageRootThreadId, "thread-lineage-root");
        assert.equal(child.value.lineageRelationship, "delegated");
      }

      const listed = yield* repository.listByProjectId({ projectId: BASE_ROW.projectId });
      const listedChild = listed.find((row) => row.threadId === threadId);
      assert.equal(listedChild?.lineageParentThreadId, "thread-lineage-parent");

      // A re-created id writes null lineage and must reset the columns.
      yield* repository.upsert({ ...BASE_ROW, threadId });
      const reset = yield* repository.getById({ threadId });
      assert.isTrue(Option.isSome(reset));
      if (Option.isSome(reset)) {
        assert.isNull(reset.value.lineageParentThreadId);
        assert.isNull(reset.value.lineageRootThreadId);
        assert.isNull(reset.value.lineageRelationship);
      }
    }),
  );
});
