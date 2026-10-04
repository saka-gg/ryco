import { ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

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
