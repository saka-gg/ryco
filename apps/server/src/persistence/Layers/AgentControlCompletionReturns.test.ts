import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandId, MessageId, RuntimeSessionId, ThreadId, TurnId } from "@ryco/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vite-plus/test";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  CompletionReturnRepository,
  CompletionReturnRepositoryLive,
  cancelOwnedCompletionReturn,
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

it("retries the owner's cancel once after a concurrent write and reports a second loss", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const record = completionFixture();
      yield* repo.insert(record);
      // A concurrent writer (the delivery worker re-saving the row) wins between each of the
      // first `races` reads and the cancel's revision CAS.
      const racing = (races: number) => {
        let reads = 0;
        const cancel = cancelOwnedCompletionReturn({
          get: (childThreadId: ThreadId) =>
            repo.get(childThreadId).pipe(
              Effect.tap((current) => {
                reads += 1;
                return current && reads <= races
                  ? repo.save(current, { ...current, detail: `Concurrent write ${reads}.` })
                  : Effect.void;
              }),
            ),
          save: repo.save,
        });
        return cancel({
          childThreadId: record.childThreadId,
          parentThreadId: record.parentThreadId,
          detail: "Cancelled.",
          now: fixtureAt(1),
        }).pipe(Effect.map((result) => ({ result, reads })));
      };
      const lostTwice = yield* racing(2);
      expect(lostTwice.reads).toBe(3);
      expect(lostTwice.result).toMatchObject({
        status: "waiting",
        detail: "Concurrent write 2.",
        revision: 2,
      });
      const retried = yield* racing(1);
      expect(retried.reads).toBe(2);
      expect(retried.result).toMatchObject({ status: "cancelled", revision: 4 });
      expect(yield* repo.get(record.childThreadId)).toMatchObject({
        status: "cancelled",
        detail: "Cancelled.",
        revision: 4,
      });
    }),
  ));

it("detects a user stop of a cohort turn and skips agent and provider interrupts", () =>
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
      // Agent Control and provider stops of a wake never count.
      yield* append("quiet", "thread.turn-start-requested", "delegation-return:x", "client", {
        messageId: "delegation-result:x",
      });
      yield* append("quiet", "thread.turn-interrupt-requested", "agent-control:op:interrupt");
      yield* append("quiet", "thread.turn-interrupt-requested", "provider:reconcile", "provider");
      // A client stop without a turn id, attributed to the wake started at sequence 4.
      yield* append("parent", "thread.turn-interrupt-requested", null);
      const stopped = (
        threadId: string,
        input: {
          readonly since?: number;
          readonly delegating?: string;
          readonly wakesSince?: string;
        },
      ) =>
        repo.cohortUserStop({
          threadId: ThreadId.make(threadId),
          sinceSequence: input.since ?? 0,
          delegatingMessageId:
            input.delegating === undefined ? null : MessageId.make(input.delegating),
          wakesSince: input.wakesSince ?? fixtureAt(1000),
        });
      expect(yield* stopped("parent", { delegating: "user-message" })).toBe(true);
      expect(yield* stopped("parent", { delegating: "user-message", since: 2 })).toBe(false);
      expect(yield* stopped("parent", { delegating: "other-message" })).toBe(false);
      expect(yield* stopped("parent", { wakesSince: fixtureAt(4) })).toBe(true);
      expect(yield* stopped("parent", { wakesSince: fixtureAt(5) })).toBe(false);
      expect(yield* stopped("quiet", { wakesSince: fixtureAt(0) })).toBe(false);
      expect(
        yield* repo.turnStartSequence(ThreadId.make("parent"), MessageId.make("user-message")),
      ).toBe(1);
      expect(
        yield* repo.turnStartSequence(ThreadId.make("parent"), MessageId.make("missing")),
      ).toBeNull();
      expect(yield* repo.firstEventSequence(ThreadId.make("parent"))).toBe(1);
      expect(yield* repo.firstEventSequence(ThreadId.make("missing"))).toBeNull();
    }),
  ));

it("finds a matching stop among any number of unrelated stops, oldest or newest", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const sql = yield* SqlClient.SqlClient;
      let sequence = 0;
      const append = (type: string, commandId: string, payload: Record<string, unknown> = {}) => {
        sequence += 1;
        return sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${sequence}`}, 'thread', 'parent', ${sequence}, ${type}, ${fixtureAt(sequence)}, ${commandId}, NULL, NULL, 'client', ${JSON.stringify(payload)}, '{}')`;
      };
      // The delegating turn's stop comes first, a wake's stop last, 60 unrelated ones between.
      yield* append("thread.turn-start-requested", "web:send", { messageId: "delegating" });
      yield* append("thread.turn-interrupt-requested", "web:stop");
      for (let index = 0; index < 60; index += 1) {
        yield* append("thread.turn-start-requested", "web:send", { messageId: `other-${index}` });
        yield* append("thread.turn-interrupt-requested", "web:stop");
      }
      const wakeAt = fixtureAt(sequence + 1);
      yield* append("thread.turn-start-requested", "delegation-return:child", {
        messageId: "delegation-result:child",
      });
      yield* append("thread.turn-interrupt-requested", "web:stop");
      const stopped = (delegating: string | null, wakesSince: string) =>
        repo.cohortUserStop({
          threadId: ThreadId.make("parent"),
          sinceSequence: 0,
          delegatingMessageId: delegating === null ? null : MessageId.make(delegating),
          wakesSince,
        });
      expect(yield* stopped("delegating", fixtureAt(10_000))).toBe(true);
      expect(yield* stopped(null, wakeAt)).toBe(true);
      expect(yield* stopped("never-started", fixtureAt(10_000))).toBe(false);
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

it("advances a settled return only through wake turns that directly follow it", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const sql = yield* SqlClient.SqlClient;
      const record = completionFixture();
      yield* repo.insert(record);
      // Start order (row_id): initial, own wake, someone else's follow-up, a later own wake.
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES ('child', 'child-turn', 'child-initial', 'completed', ${completionFixtureTime}, '[]'),
          ('child', 'wake-turn', 'delegation-result:grandchild', 'completed', ${completionFixtureTime}, '[]'),
          ('child', 'follow-up', 'user-follow-up', 'completed', ${completionFixtureTime}, '[]'),
          ('child', 'wake-turn-2', 'delegation-result:grandchild-2', 'completed', ${completionFixtureTime}, '[]')`;
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
      // The follow-up sits between the settled wake and this one: never skip over it.
      yield* observe("wake-turn-2");
      expect(yield* repo.get(record.childThreadId)).toMatchObject({
        settled: { turnId: "wake-turn" },
        delegationWakeTurns: 1,
      });
      const between = (after: string, before: string | null) =>
        repo.nonWakeTurnBetween(
          record.childThreadId,
          TurnId.make(after),
          before === null ? null : TurnId.make(before),
        );
      expect(yield* between("child-turn", "wake-turn")).toBe(false);
      expect(yield* between("wake-turn", "wake-turn-2")).toBe(true);
      expect(yield* between("child-turn", null)).toBe(true);
      expect(yield* between("follow-up", null)).toBe(false);
    }),
  ));

it("finds the newest delegation wake a chat received through a batch", () =>
  run(
    Effect.gen(function* () {
      const repo = yield* CompletionReturnRepository;
      const parent = ThreadId.make("child");
      const delivered = (childThreadId: string, wake: string | null, dispatchedAt: string) =>
        completionFixture({
          childThreadId: ThreadId.make(childThreadId),
          parentThreadId: parent,
          status: "delivered",
          capture: {
            kind: "result",
            outcome: "completed",
            capturedAt: completionFixtureTime,
            section: "Section",
          },
          batch:
            wake === null
              ? null
              : {
                  commandId: CommandId.make(`delegation-return:${wake}`),
                  messageId: MessageId.make(`delegation-result:${wake}`),
                  anchorChildThreadId: ThreadId.make(childThreadId),
                  childThreadIds: [ThreadId.make(childThreadId)],
                  attempt: 0,
                  replays: 0,
                  dispatchedAt,
                  cold: false,
                },
        });
      expect(yield* repo.latestDeliveredWake(parent)).toBeNull();
      yield* repo.insert(delivered("older", "older", fixtureAt(1)));
      yield* repo.insert(delivered("newer", "newer", fixtureAt(5)));
      // Acknowledged with ryco_task_status: no batch, so no wake.
      yield* repo.insert(delivered("acked", null, fixtureAt(9)));
      yield* repo.insert({
        ...delivered("claimed", "claimed", fixtureAt(9)),
        status: "dispatching",
      });
      expect(yield* repo.latestDeliveredWake(parent)).toBe("delegation-result:newer");
      expect(yield* repo.latestDeliveredWake(ThreadId.make("parent"))).toBeNull();
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
