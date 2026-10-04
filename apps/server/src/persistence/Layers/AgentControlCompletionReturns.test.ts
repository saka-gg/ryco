import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageId, RuntimeSessionId, ThreadId, TurnId } from "@ryco/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vite-plus/test";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  CompletionReturnRepository,
  CompletionReturnRepositoryLive,
  type CompletionReturnRecord,
} from "./AgentControlCompletionReturns.ts";
import {
  completionFixture,
  completionFixtureTime,
} from "../../agentControl/completionReturnTestSupport.ts";

it("preserves return ownership and recovery state across closing and reopening the database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-return-restart-fixture-"));
  try {
    const connect = () =>
      CompletionReturnRepositoryLive.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(runMigrations()).pipe(
            Layer.provideMerge(
              NodeSqliteClient.layer({ filename: path.join(directory, "fixture.sqlite") }),
            ),
          ),
        ),
      );
    const initial = completionFixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CompletionReturnRepository;
        yield* repo.insert(initial);
        expect(
          yield* repo.save(initial, {
            ...initial,
            status: "dispatching",
            detail: "Dispatch claimed; inspect receipt on recovery.",
          }),
        ).toBe(true);
      }).pipe(Effect.provide(connect())),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CompletionReturnRepository;
        const restored = yield* repo.get(initial.childThreadId);
        expect(restored).toMatchObject({
          status: "dispatching",
          revision: 1,
          parentTurnId: initial.parentTurnId,
          parentRuntimeSessionId: initial.parentRuntimeSessionId,
          initialMessageId: initial.initialMessageId,
        });
        expect((yield* repo.listDue(initial.nextCheckAt)).length).toBe(1);
        expect(yield* repo.save(initial, { ...initial, status: "delivered" })).toBe(false);
      }).pipe(Effect.provide(connect())),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const memory = CompletionReturnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const run = <A, E>(effect: Effect.Effect<A, E, CompletionReturnRepository | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(memory)));
const fixtureAt = (seconds: number) =>
  new Date(Date.parse(completionFixtureTime) + seconds * 1000).toISOString();

it("claims a batch all-or-nothing: one stale revision rolls back every member", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const first = completionFixture();
      const second = completionFixture({ childThreadId: ThreadId.make("sibling") });
      yield* repo.insert(first);
      yield* repo.insert(second);
      expect(yield* repo.save(second, { ...second, detail: "Concurrent writer." })).toBe(true);
      const claim = (record: CompletionReturnRecord) =>
        [record, { ...record, status: "dispatching" as const }] as const;
      expect(yield* repo.claimBatch([claim(first), claim(second)])).toBe(false);
      expect(yield* repo.get(first.childThreadId)).toMatchObject({
        status: "waiting",
        revision: 0,
      });
      const current = (yield* repo.get(second.childThreadId))!;
      expect(yield* repo.claimBatch([claim(first), claim(current)])).toBe(true);
      expect((yield* repo.get(first.childThreadId))?.status).toBe("dispatching");
      expect((yield* repo.get(second.childThreadId))?.status).toBe("dispatching");
    }),
  ));

it("cancels only the owner's waiting or ready rows", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const waiting = completionFixture();
      const ready = completionFixture({ childThreadId: ThreadId.make("ready"), status: "ready" });
      const dispatching = completionFixture({
        childThreadId: ThreadId.make("dispatching"),
        status: "dispatching",
      });
      for (const record of [waiting, ready, dispatching]) yield* repo.insert(record);
      const cancel = (childThreadId: ThreadId, parentThreadId = waiting.parentThreadId) =>
        repo.cancelOwned({
          childThreadId,
          parentThreadId,
          detail: "Cancelled.",
          now: fixtureAt(1),
        });
      expect(yield* cancel(waiting.childThreadId, ThreadId.make("intruder"))).toBeNull();
      expect(yield* cancel(ThreadId.make("unknown"))).toBeNull();
      expect(yield* cancel(waiting.childThreadId)).toMatchObject({
        status: "cancelled",
        revision: 1,
      });
      expect((yield* cancel(ready.childThreadId))?.status).toBe("cancelled");
      expect((yield* cancel(dispatching.childThreadId))?.status).toBe("dispatching");
      expect((yield* repo.get(waiting.childThreadId))?.detail).toBe("Cancelled.");
    }),
  ));

it("attributes client stops to the preceding turn start and skips agent/provider interrupts", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const sql = yield* SqlClient.SqlClient;
      let sequence = 0;
      const append = (
        stream: string,
        type: string,
        commandId: string | null,
        actor = "client",
        payload: Record<string, unknown> = {},
      ) => {
        sequence += 1;
        return sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${sequence}`}, 'thread', ${stream}, ${sequence}, ${type}, ${fixtureAt(sequence)}, ${commandId}, NULL, NULL, ${actor}, ${JSON.stringify(payload)}, '{}')`;
      };
      yield* append("parent", "thread.turn-start-requested", "web:send", "client", {
        messageId: "user-message",
      });
      yield* append("parent", "thread.turn-interrupt-requested", "web:stop");
      yield* append("other", "thread.turn-start-requested", "web:other", "client", {
        messageId: "other-message",
      });
      yield* append("parent", "thread.turn-start-requested", "delegation-return:child", "client", {
        messageId: "delegation-result:child",
      });
      yield* append("parent", "thread.turn-interrupt-requested", "agent-control:op:interrupt");
      yield* append("parent", "thread.turn-interrupt-requested", "provider:reconcile", "provider");
      yield* append("parent", "thread.turn-interrupt-requested", null);
      expect(yield* repo.userStopAttributions(ThreadId.make("parent"), 0)).toEqual([
        {
          stopSequence: 2,
          startCommandId: "web:send",
          startMessageId: "user-message",
          startOccurredAt: fixtureAt(1),
        },
        {
          stopSequence: 7,
          startCommandId: "delegation-return:child",
          startMessageId: "delegation-result:child",
          startOccurredAt: fixtureAt(4),
        },
      ]);
      expect(
        (yield* repo.userStopAttributions(ThreadId.make("parent"), 2)).map(
          (stop) => stop.stopSequence,
        ),
      ).toEqual([7]);
      expect(yield* repo.firstEventSequence(ThreadId.make("parent"))).toBe(1);
      expect(yield* repo.firstEventSequence(ThreadId.make("missing"))).toBeNull();
    }),
  ));

it("reports the newest pending turn start and whether it already failed to start", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const sql = yield* SqlClient.SqlClient;
      const thread = ThreadId.make("parent");
      expect(yield* repo.pendingTurnStart(thread)).toBeNull();
      for (const messageId of ["older-pending", "newer-pending"])
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
          VALUES ('parent', NULL, ${messageId}, 'pending', ${completionFixtureTime}, '[]')`;
      expect(yield* repo.pendingTurnStart(thread)).toEqual({
        messageId: "newer-pending",
        startFailed: false,
      });
      expect(yield* repo.wakeStartState(thread, MessageId.make("newer-pending"))).toBe("pending");
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES ('failure', 'parent', 'error', 'provider.turn.start.failed', 'Failed', ${JSON.stringify({ messageId: "newer-pending" })}, ${completionFixtureTime})`;
      expect(yield* repo.pendingTurnStart(thread)).toEqual({
        messageId: "newer-pending",
        startFailed: true,
      });
      expect(yield* repo.wakeStartState(thread, MessageId.make("newer-pending"))).toBe("failed");
      expect(yield* repo.wakeStartState(thread, MessageId.make("absent"))).toBe("absent");
      yield* sql`UPDATE projection_turns SET turn_id = 'bound' WHERE pending_message_id = 'older-pending'`;
      expect(yield* repo.wakeStartState(thread, MessageId.make("older-pending"))).toBe("bound");
    }),
  ));

it("advances a settled return through the child's own delegation-wake turns only", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const sql = yield* SqlClient.SqlClient;
      const record = completionFixture();
      yield* repo.insert(record);
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES ('child', 'child-turn', 'child-initial', 'completed', ${completionFixtureTime}, '[]'),
          ('child', 'follow-up', 'user-follow-up', 'completed', ${completionFixtureTime}, '[]'),
          ('child', 'wake-turn', 'delegation-result:grandchild', 'completed', ${completionFixtureTime}, '[]')`;
      const observe = (turnId: string) =>
        repo.observe({
          childThreadId: record.childThreadId,
          runtimeSessionId: RuntimeSessionId.make("child-runtime"),
          observationEpoch: "process-1",
          backgroundPending: false,
          terminal: { turnId: TurnId.make(turnId), state: "completed" },
        });
      yield* observe("child-turn");
      expect((yield* repo.get(record.childThreadId))?.settled?.turnId).toBe("child-turn");
      yield* observe("follow-up");
      expect((yield* repo.get(record.childThreadId))?.settled?.turnId).toBe("child-turn");
      yield* observe("wake-turn");
      expect(yield* repo.get(record.childThreadId)).toMatchObject({
        settled: { turnId: "wake-turn", state: "completed" },
        delegationWakeTurns: 1,
      });
    }),
  ));

it("lists a parent's tasks with unsettled returns first", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      yield* repo.insert(
        completionFixture({
          childThreadId: ThreadId.make("done"),
          status: "delivered",
          updatedAt: fixtureAt(9),
        }),
      );
      yield* repo.insert(completionFixture({ childThreadId: ThreadId.make("open") }));
      yield* repo.insert(
        completionFixture({
          childThreadId: ThreadId.make("foreign"),
          parentThreadId: ThreadId.make("other"),
        }),
      );
      expect(
        (yield* repo.listForParent(ThreadId.make("parent"), 20)).map((row) => row.childThreadId),
      ).toEqual(["open", "done"]);
      expect(yield* repo.hasOutstandingDelegations(ThreadId.make("parent"))).toBe(true);
      expect(yield* repo.hasOutstandingDelegations(ThreadId.make("done"))).toBe(false);
    }),
  ));
