import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { mulberry32 } from "../../../scripts/projectionEventStream.ts";
import { installRowWriteProbe } from "../../../scripts/sqliteRowWriteProbe.ts";
import { legacyThreadTouch } from "../../testing/legacyProjectionWrites.ts";
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
  lineageSourceMessageId: null,
  lineageSourceTurnId: null,
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

  it.effect("round-trips fork provenance on every read and resets it on re-creation", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-lineage-fork");
      const forkColumns = {
        lineageParentThreadId: ThreadId.make("thread-lineage-source"),
        lineageRootThreadId: ThreadId.make("thread-lineage-source"),
        lineageRelationship: "forked",
        lineageSourceMessageId: MessageId.make("message-lineage-boundary"),
        lineageSourceTurnId: TurnId.make("turn-lineage-boundary"),
      };

      yield* repository.upsert({ ...BASE_ROW, threadId, ...forkColumns });
      // Every later projection rewrites the row from a read: provenance must survive it.
      const read = yield* repository.getById({ threadId });
      assert.isTrue(Option.isSome(read));
      if (Option.isSome(read)) {
        yield* repository.upsert({ ...read.value, title: "Renamed fork" });
      }
      const fork = yield* repository.getById({ threadId });
      assert.deepInclude(Option.getOrThrow(fork), { ...forkColumns, title: "Renamed fork" });
      const listed = yield* repository.listByProjectId({ projectId: BASE_ROW.projectId });
      assert.deepInclude(
        listed.find((row) => row.threadId === threadId),
        forkColumns,
      );

      yield* repository.upsert({ ...BASE_ROW, threadId });
      const reset = Option.getOrThrow(yield* repository.getById({ threadId }));
      assert.isNull(reset.lineageSourceMessageId);
      assert.isNull(reset.lineageSourceTurnId);
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

const rawThreadRow = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<Record<string, unknown>>`
      SELECT * FROM projection_threads WHERE thread_id = ${threadId}
    `;
    return rows[0];
  });

/** A row with a distinctive value in every column `upsert` writes. */
const DISTINCT_ROW: ProjectionThread = {
  ...BASE_ROW,
  title: "Distinct",
  interactionMode: "plan",
  tokenMode: "aggressive",
  branch: "feature/narrow-writes",
  worktreePath: "/tmp/worktrees/narrow-writes",
  worktreeId: WorktreeId.make("worktree-narrow"),
  manualStatusBucket: "review",
  manualPosition: 7.5,
  latestTurnId: TurnId.make("turn-distinct"),
  goal: {
    objective: "Write less",
    status: "active",
    tokenBudget: 1000,
    tokensUsed: 10,
    timeUsedSeconds: 3,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  },
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  archivedAt: "2026-08-01T00:00:00.000Z",
  settledOverride: "settled",
  settledAt: "2026-08-01T00:00:00.000Z",
  snoozedUntil: "2026-08-05T00:00:00.000Z",
  snoozedAt: "2026-08-01T00:00:00.000Z",
  latestUserMessageAt: "2026-07-31T00:00:01.000Z",
  pendingApprovalCount: 1,
  pendingUserInputCount: 2,
  hasActionableProposedPlan: 1,
  usageLimit: USAGE_LIMIT,
  deletedAt: "2026-08-02T00:00:00.000Z",
  trashedAt: "2026-08-02T00:00:00.000Z",
  lineageParentThreadId: ThreadId.make("thread-parent"),
  lineageRootThreadId: ThreadId.make("thread-root"),
  lineageRelationship: "forked",
  lineageSourceMessageId: MessageId.make("message-boundary"),
  lineageSourceTurnId: TurnId.make("turn-boundary"),
};

layer("ProjectionThreadRepository touch", (it) => {
  it.effect("sets updated_at and moves the pending counters without rewriting other columns", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-touch-columns");
      yield* repository.upsert({ ...DISTINCT_ROW, threadId });
      const before = yield* rawThreadRow(threadId);
      const otherColumnWrites = yield* installRowWriteProbe({
        name: "touch_other_columns",
        table: "projection_threads",
        columns: ["title", "project_id", "model_selection_json", "latest_turn_id", "goal_json"],
      });

      yield* repository.touch({
        threadId,
        updatedAt: "2026-08-03T00:00:00.000Z",
        pendingApprovalDelta: 1,
        pendingUserInputDelta: 2,
      });

      assert.deepEqual(yield* rawThreadRow(threadId), {
        ...before,
        updated_at: "2026-08-03T00:00:00.000Z",
        pending_approval_count: 2,
        pending_user_input_count: 4,
      });
      assert.equal(yield* otherColumnWrites, 0);
    }),
  );

  it.effect("clamps the pending counters at 0", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-touch-clamp");
      yield* repository.upsert({
        ...BASE_ROW,
        threadId,
        pendingApprovalCount: 1,
        pendingUserInputCount: 0,
      });
      yield* repository.touch({
        threadId,
        updatedAt: "2026-08-03T00:00:00.000Z",
        pendingApprovalDelta: -3,
        pendingUserInputDelta: -1,
      });
      const row = Option.getOrThrow(yield* repository.getById({ threadId }));
      assert.equal(row.pendingApprovalCount, 0);
      assert.equal(row.pendingUserInputCount, 0);
      assert.equal(row.updatedAt, "2026-08-03T00:00:00.000Z");
    }),
  );

  it.effect("leaves a missing thread missing", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-touch-missing");
      yield* repository.touch({
        threadId,
        updatedAt: "2026-08-03T00:00:00.000Z",
        pendingApprovalDelta: 1,
        pendingUserInputDelta: 0,
      });
      assert.isUndefined(yield* rawThreadRow(threadId));
    }),
  );

  it.effect("writes nothing when the row already holds the result", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-touch-unchanged");
      yield* repository.upsert({ ...BASE_ROW, threadId, pendingApprovalCount: 0 });
      const writes = yield* installRowWriteProbe({
        name: "touch_unchanged",
        table: "projection_threads",
        when: `NEW.thread_id = '${threadId}'`,
      });

      // Same time, no deltas; and a delta that clamps back to the same count.
      yield* repository.touch({
        threadId,
        updatedAt: BASE_ROW.updatedAt,
        pendingApprovalDelta: 0,
        pendingUserInputDelta: 0,
      });
      yield* repository.touch({
        threadId,
        updatedAt: BASE_ROW.updatedAt,
        pendingApprovalDelta: -1,
        pendingUserInputDelta: 0,
      });
      assert.equal(yield* writes, 0);

      yield* repository.touch({
        threadId,
        updatedAt: "2026-08-03T00:00:00.000Z",
        pendingApprovalDelta: 0,
        pendingUserInputDelta: 0,
      });
      assert.equal(yield* writes, 1);
    }),
  );

  it.effect("matches the read, transition and full-row upsert it replaces", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const times = [
        "2026-08-01T00:00:00.000Z",
        "2026-08-02T00:00:00.000Z",
        "2026-08-03T00:00:00.000Z",
      ] as const;
      const narrow = ThreadId.make("thread-touch-narrow");
      const legacy = ThreadId.make("thread-touch-legacy");
      for (let seed = 1; seed <= 50; seed++) {
        const random = mulberry32(seed);
        const count = () => Math.floor(random() * 4);
        const pick = <T>(values: ReadonlyArray<T>): T =>
          values[Math.floor(random() * values.length)]!;
        const start = {
          ...DISTINCT_ROW,
          updatedAt: pick(times),
          pendingApprovalCount: count(),
          pendingUserInputCount: count(),
        };
        yield* repository.upsert({ ...start, threadId: narrow });
        yield* repository.upsert({ ...start, threadId: legacy });
        for (let step = 0; step < 4; step++) {
          const input = {
            updatedAt: pick(times),
            pendingApprovalDelta: Math.floor(random() * 5) - 2,
            pendingUserInputDelta: Math.floor(random() * 5) - 2,
          };
          yield* repository.touch({ ...input, threadId: narrow });
          yield* legacyThreadTouch(repository)({ ...input, threadId: legacy });
          const { thread_id: _narrowId, ...narrowRow } = (yield* rawThreadRow(narrow))!;
          const { thread_id: _legacyId, ...legacyRow } = (yield* rawThreadRow(legacy))!;
          assert.deepEqual(narrowRow, legacyRow, `seed ${seed}, step ${step}`);
        }
      }
    }),
  );
});
