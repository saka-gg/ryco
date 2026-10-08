import { ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../Services/ProjectionThreads.ts";
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
  trashedAt: null,
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

const USAGE_LIMIT = {
  limitId: "usage-limit:thread-limited:turn-1",
  provider: "claudeAgent",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  turnId: TurnId.make("turn-1"),
  message: "Claude usage limit reached.",
  limitedAt: "2026-07-31T01:00:00.000Z",
  resetAt: "2026-07-31T06:00:00.000Z",
  autoResume: null,
  updatedAt: "2026-07-31T01:00:00.000Z",
} as ProjectionThread["usageLimit"];

layer("ProjectionThreadRepository usage limits", (it) => {
  it.effect("round-trips usage_limit_json and clears it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-limited");
      yield* repository.upsert({ ...BASE_ROW, threadId, usageLimit: USAGE_LIMIT });
      const limited = yield* repository.getById({ threadId });
      assert.isTrue(Option.isSome(limited));
      if (Option.isSome(limited)) assert.deepEqual(limited.value.usageLimit, USAGE_LIMIT);

      yield* repository.upsert({ ...BASE_ROW, threadId, usageLimit: null });
      const cleared = yield* repository.getById({ threadId });
      if (Option.isSome(cleared)) assert.isNull(cleared.value.usageLimit);
    }),
  );

  it.effect("lists only live limited threads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const row = (id: string, overrides: Partial<ProjectionThread> = {}) =>
        repository.upsert({
          ...BASE_ROW,
          threadId: ThreadId.make(id),
          usageLimit: USAGE_LIMIT,
          ...overrides,
        });
      yield* row("live-limited", { updatedAt: "2026-07-31T02:00:00.000Z" });
      yield* row("archived-limited", { archivedAt: "2026-07-31T02:00:00.000Z" });
      yield* row("deleted-limited", { deletedAt: "2026-07-31T02:00:00.000Z" });
      yield* row("cleared", { usageLimit: null });
      yield* row("older-limited", { updatedAt: "2026-07-31T00:30:00.000Z" });

      const ids = yield* repository.listUsageLimitedThreadIds();
      assert.deepEqual(
        ids.filter((id) => id !== "thread-limited"),
        [ThreadId.make("older-limited"), ThreadId.make("live-limited")],
      );
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

layer("ProjectionThreadRepository trash", (it) => {
  it.effect("keeps trash state across upserts and lists only recoverable threads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
          created_at, updated_at, deleted_at)
        VALUES (${BASE_ROW.projectId}, 'Project', '/tmp/project', '[]',
          '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', NULL)
      `;
      const trashedAt = "2026-08-02T00:00:00.000Z";
      yield* repository.upsert({
        ...BASE_ROW,
        threadId: ThreadId.make("thread-trashed"),
        archivedAt: "2026-08-01T00:00:00.000Z",
        deletedAt: trashedAt,
        trashedAt,
      });
      // Permanently deleted (including legacy deletions): never listed as recoverable.
      yield* repository.upsert({
        ...BASE_ROW,
        threadId: ThreadId.make("thread-deleted"),
        deletedAt: trashedAt,
        trashedAt: null,
      });
      yield* repository.upsert({ ...BASE_ROW, threadId: ThreadId.make("thread-live") });

      const trashed = yield* repository.getById({ threadId: ThreadId.make("thread-trashed") });
      assert.isTrue(Option.isSome(trashed));
      if (Option.isSome(trashed)) {
        // A later `...existingRow` upsert must not turn Trash into a permanent deletion.
        yield* repository.upsert({ ...trashed.value, title: "Renamed while in Trash" });
      }
      const listed = yield* repository.listTrashed({ limit: 10 });
      assert.deepEqual(
        listed.map((row) => ({
          threadId: row.threadId,
          title: row.title,
          projectTitle: row.projectTitle,
          archivedAt: row.archivedAt,
          trashedAt: row.trashedAt,
        })),
        [
          {
            threadId: ThreadId.make("thread-trashed"),
            title: "Renamed while in Trash",
            projectTitle: "Project",
            archivedAt: "2026-08-01T00:00:00.000Z",
            trashedAt,
          },
        ],
      );
    }),
  );

  it.effect("reports the owning project's kind so a trashed chat reads as No project", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const chatProjectId = ProjectId.make("project-chat-trash");
      yield* sql`
        INSERT INTO projection_projects (project_id, kind, title, workspace_root, scripts_json,
          created_at, updated_at, deleted_at)
        VALUES (${chatProjectId}, 'chat', 'Plan the offsite', '/chats/plan', '[]',
          '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', NULL)
      `;
      const trashedAt = "2026-08-03T00:00:00.000Z";
      yield* repository.upsert({
        ...BASE_ROW,
        threadId: ThreadId.make("thread-chat-trashed"),
        projectId: chatProjectId,
        deletedAt: trashedAt,
        trashedAt,
      });
      yield* repository.upsert({
        ...BASE_ROW,
        threadId: ThreadId.make("thread-orphan-trashed"),
        projectId: ProjectId.make("project-record-gone"),
        deletedAt: trashedAt,
        trashedAt,
      });

      const listed = yield* repository.listTrashed({ limit: 10 });
      const kindOf = (threadId: string) =>
        listed.find((row) => row.threadId === threadId)?.projectKind;
      assert.strictEqual(kindOf("thread-chat-trashed"), "chat");
      assert.isNull(kindOf("thread-orphan-trashed"));
    }),
  );
});
