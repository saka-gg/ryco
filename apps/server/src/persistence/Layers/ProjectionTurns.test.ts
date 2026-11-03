import {
  CheckpointRef,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { installRowWriteProbe } from "../../../scripts/sqliteRowWriteProbe.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionTurnRepository, type ProjectionTurnById } from "../Services/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive, sameProjectionTurnRow } from "./ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(ProjectionTurnRepositoryLive, ProjectionThreadRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const threadId = ThreadId.make("thread-turns");

const TURN: ProjectionTurnById = {
  threadId,
  turnId: TurnId.make("turn-1"),
  pendingMessageId: MessageId.make("message-user"),
  sourceProposedPlanThreadId: ThreadId.make("thread-plan"),
  sourceProposedPlanId: OrchestrationProposedPlanId.make("plan-1"),
  assistantMessageId: MessageId.make("message-assistant"),
  state: "running",
  requestedAt: "2026-08-01T00:00:00.000Z",
  startedAt: "2026-08-01T00:00:01.000Z",
  completedAt: null,
  checkpointTurnCount: 1,
  checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/1"),
  checkpointStatus: "ready",
  checkpointFiles: [{ path: "src/index.ts", kind: "modified", additions: 2, deletions: 1 }],
};

describe("sameProjectionTurnRow", () => {
  it("holds for equal rows, also when checkpointFiles are different arrays", () => {
    assert.isTrue(sameProjectionTurnRow(TURN, { ...TURN }));
    assert.isTrue(
      sameProjectionTurnRow(TURN, {
        ...TURN,
        checkpointFiles: TURN.checkpointFiles.map((file) => ({ ...file })),
      }),
    );
  });

  const changes: ReadonlyArray<[string, Partial<ProjectionTurnById>]> = [
    ["threadId", { threadId: ThreadId.make("thread-other") }],
    ["turnId", { turnId: TurnId.make("turn-other") }],
    ["pendingMessageId", { pendingMessageId: null }],
    ["sourceProposedPlanThreadId", { sourceProposedPlanThreadId: null }],
    ["sourceProposedPlanId", { sourceProposedPlanId: null }],
    ["assistantMessageId", { assistantMessageId: MessageId.make("message-other") }],
    ["state", { state: "completed" }],
    ["requestedAt", { requestedAt: "2026-08-01T00:00:00.001Z" }],
    ["startedAt", { startedAt: null }],
    ["completedAt", { completedAt: "2026-08-01T00:00:09.000Z" }],
    ["checkpointTurnCount", { checkpointTurnCount: 2 }],
    ["checkpointRef", { checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/2") }],
    ["checkpointStatus", { checkpointStatus: "missing" }],
    ["checkpointFiles", { checkpointFiles: [] }],
  ];
  for (const [field, change] of changes) {
    it(`fails when only ${field} differs`, () => {
      assert.isFalse(sameProjectionTurnRow(TURN, { ...TURN, ...change }));
    });
  }
});

layer("ProjectionTurnRepository.replaceByTurnId", (it) => {
  const seedThreadAndTurn = Effect.gen(function* () {
    const threads = yield* ProjectionThreadRepository;
    const turns = yield* ProjectionTurnRepository;
    yield* threads.upsert({
      threadId,
      projectId: ProjectId.make("project-turns"),
      title: "Turns",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurnId: TURN.turnId,
      goal: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
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
    });
    yield* turns.upsertByTurnId(TURN);
    return Option.getOrThrow(yield* turns.getByTurnId({ threadId, turnId: TURN.turnId }));
  });

  const latestCompletedTurnAt = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly completedAt: string | null }>`
      SELECT latest_completed_turn_at AS "completedAt" FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    return rows[0]?.completedAt ?? null;
  });

  const sequence = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly seq: number }>`
      SELECT seq FROM sqlite_sequence WHERE name = 'projection_turns'
    `;
    return rows[0]?.seq ?? 0;
  });

  it.effect("writes nothing for an unchanged row", () =>
    Effect.gen(function* () {
      const turns = yield* ProjectionTurnRepository;
      const stored = yield* seedThreadAndTurn;
      const turnWrites = yield* installRowWriteProbe({
        name: "replace_unchanged_turn",
        table: "projection_turns",
      });
      const sequenceBefore = yield* sequence;
      const completedAtBefore = yield* latestCompletedTurnAt;

      yield* turns.replaceByTurnId({ previous: stored, next: { ...stored } });

      assert.equal(yield* turnWrites, 0);
      // An upsert, even one that changes nothing, would advance the AUTOINCREMENT sequence.
      assert.equal(yield* sequence, sequenceBefore);
      assert.equal(yield* latestCompletedTurnAt, completedAtBefore);
    }),
  );

  it.effect("writes a changed row, and the 091 trigger moves latest_completed_turn_at", () =>
    Effect.gen(function* () {
      const turns = yield* ProjectionTurnRepository;
      const stored = yield* seedThreadAndTurn;
      const turnWrites = yield* installRowWriteProbe({
        name: "replace_changed_turn",
        table: "projection_turns",
      });
      const next = {
        ...stored,
        state: "completed" as const,
        completedAt: "2026-08-01T00:05:00.000Z",
      };

      yield* turns.replaceByTurnId({ previous: stored, next });

      assert.equal(yield* turnWrites, 1);
      assert.deepEqual(
        Option.getOrThrow(yield* turns.getByTurnId({ threadId, turnId: TURN.turnId })),
        next,
      );
      assert.equal(yield* latestCompletedTurnAt, "2026-08-01T00:05:00.000Z");
    }),
  );
});
