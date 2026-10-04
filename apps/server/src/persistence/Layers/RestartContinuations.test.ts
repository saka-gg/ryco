import { MessageId, ProviderInstanceId, RuntimeSessionId, ThreadId, TurnId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  RestartContinuationRepository,
  RestartContinuationRepositoryLive,
  type RestartContinuationRecord,
  type RestartContinuationRow,
} from "./RestartContinuations.ts";

const layer = it.layer(
  RestartContinuationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");

function record(overrides: Partial<RestartContinuationRecord> = {}): RestartContinuationRecord {
  return {
    version: 1,
    kind: "in-flight",
    threadId,
    sourceTurnId: turnId,
    latestUserMessageId: MessageId.make("message-1"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
      options: [{ id: "fastMode", value: true }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeSessionId: RuntimeSessionId.make("runtime-1"),
    backgroundWork: {
      tasks: [{ id: "task-1", title: "Tail logs" }],
      omitted: 2,
      detailsOmitted: false,
    },
    capturedAt: "2026-10-04T10:10:00.000Z",
    lastObservedAt: "2026-10-04T10:05:00.000Z",
    ...overrides,
  };
}

const pending = (value: RestartContinuationRecord): RestartContinuationRow => ({
  record: value,
  status: "pending",
  reason: null,
  settledAt: null,
});

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM restart_continuations`;
  yield* sql`DELETE FROM restart_shutdown_hints`;
  yield* sql`DELETE FROM orchestration_events`;
  yield* sql`DELETE FROM projection_turns`;
  yield* sql`DELETE FROM projection_thread_sessions`;
});

let streamVersion = 0;
const appendEvent = (input: {
  readonly type: string;
  readonly actorKind?: string;
  readonly payload: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    streamVersion += 1;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${`event-${streamVersion}`}, 'thread', ${threadId}, ${streamVersion}, ${input.type},
        '2026-10-04T10:00:00.000Z', ${`command-${streamVersion}`}, ${input.actorKind ?? "client"},
        ${JSON.stringify({ threadId, ...input.payload })}, '{}'
      )
    `;
  });

const signals = (turnMessageId: string | null = "message-1") =>
  Effect.flatMap(Effect.service(RestartContinuationRepository), (repository) =>
    repository.sourceTurnSignals({
      threadId,
      turnId,
      turnMessageId: turnMessageId === null ? null : MessageId.make(turnMessageId),
    }),
  );

layer("RestartContinuationRepository", (it) => {
  it.effect("inserts once and keeps the first row", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* RestartContinuationRepository;
      assert.isTrue(yield* repository.insertIfAbsent(pending(record())));
      assert.isFalse(
        yield* repository.insertIfAbsent({
          record: record({ lastObservedAt: "2026-10-04T10:09:00.000Z" }),
          status: "skipped",
          reason: "disabled",
          settledAt: "2026-10-04T10:10:00.000Z",
        }),
      );
      const stored = yield* repository.get({ threadId, sourceTurnId: turnId });
      assert.deepStrictEqual(Option.getOrUndefined(stored), {
        record: record(),
        status: "pending",
        reason: null,
        settledAt: null,
      });
    }),
  );

  it.effect("lists pending rows most recently observed first and settles only pending rows", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* RestartContinuationRepository;
      const older = record({
        threadId: ThreadId.make("thread-b"),
        lastObservedAt: "2026-10-04T09:00:00.000Z",
      });
      const newer = record({
        threadId: ThreadId.make("thread-a"),
        lastObservedAt: "2026-10-04T10:00:00.000Z",
      });
      const tie = record({
        threadId: ThreadId.make("thread-c"),
        lastObservedAt: "2026-10-04T10:00:00.000Z",
      });
      for (const value of [older, newer, tie]) yield* repository.insertIfAbsent(pending(value));
      yield* repository.insertIfAbsent({
        record: record({ threadId: ThreadId.make("thread-settled") }),
        status: "skipped",
        reason: "disabled",
        settledAt: "2026-10-04T10:00:00.000Z",
      });

      const listed = yield* repository.listPending(10);
      assert.deepStrictEqual(
        listed.map((row): string | null => (row.invalid ? null : row.record.threadId)),
        ["thread-a", "thread-c", "thread-b"],
      );
      assert.strictEqual((yield* repository.listPending(1)).length, 1);

      const settle = (status: "dispatched" | "failed") =>
        repository.settle({
          threadId: ThreadId.make("thread-a"),
          sourceTurnId: turnId,
          status,
          reason: null,
          settledAt: "2026-10-04T10:11:00.000Z",
        });
      assert.isTrue(yield* settle("dispatched"));
      assert.isFalse(yield* settle("failed"));
      const settled = yield* repository.get({
        threadId: ThreadId.make("thread-a"),
        sourceTurnId: turnId,
      });
      assert.strictEqual(Option.getOrUndefined(settled)?.status, "dispatched");
    }),
  );

  it.effect("decodes a legacy model selection and reports corrupt records as invalid", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* RestartContinuationRepository;
      const legacy = {
        ...record(),
        modelSelection: { provider: "codex", model: "gpt-5" },
      };
      yield* sql`
        INSERT INTO restart_continuations (
          thread_id, source_turn_id, kind, status, captured_at, last_observed_at, record_json
        )
        VALUES (${threadId}, ${turnId}, 'in-flight', 'pending', ${legacy.capturedAt},
          ${legacy.lastObservedAt}, ${JSON.stringify(legacy)})
      `;
      yield* sql`
        INSERT INTO restart_continuations (
          thread_id, source_turn_id, kind, status, captured_at, last_observed_at, record_json
        )
        VALUES ('thread-corrupt', 'turn-corrupt', 'in-flight', 'pending', ${legacy.capturedAt},
          '2026-10-04T08:00:00.000Z', '{"version":1')
      `;
      const listed = yield* repository.listPending(10);
      const first = listed[0];
      assert.isTrue(first !== undefined && first.invalid !== true);
      if (first !== undefined && first.invalid !== true) {
        assert.strictEqual(first.record.modelSelection.instanceId, "codex");
        assert.strictEqual(first.record.modelSelection.model, "gpt-5");
      }
      assert.deepStrictEqual(listed[1], {
        invalid: true,
        threadId: ThreadId.make("thread-corrupt"),
        sourceTurnId: TurnId.make("turn-corrupt"),
        status: "pending",
        reason: null,
      });
    }),
  );

  it.effect("reads user interrupts, unresolved steers and computer use from the event log", () =>
    Effect.gen(function* () {
      yield* reset;
      assert.deepStrictEqual(yield* signals(), {
        interruptRequested: false,
        unresolvedSteer: false,
        computerUse: false,
      });

      yield* appendEvent({
        type: "thread.turn-interrupt-requested",
        actorKind: "provider",
        payload: { turnId },
      });
      yield* appendEvent({
        type: "thread.turn-interrupt-requested",
        payload: { turnId: "turn-other" },
      });
      assert.isFalse((yield* signals()).interruptRequested);
      yield* appendEvent({ type: "thread.turn-interrupt-requested", payload: { turnId } });
      assert.isTrue((yield* signals()).interruptRequested);

      yield* appendEvent({
        type: "thread.turn-steer-requested",
        payload: { expectedTurnId: turnId, message: { messageId: "steer-1" } },
      });
      assert.isTrue((yield* signals()).unresolvedSteer);
      yield* appendEvent({
        type: "thread.turn-steer-accepted",
        payload: { messageId: "steer-1", expectedTurnId: turnId, turnId },
      });
      assert.isFalse((yield* signals()).unresolvedSteer);
      yield* appendEvent({
        type: "thread.turn-steer-requested",
        payload: { expectedTurnId: turnId, message: { messageId: "steer-2" } },
      });
      yield* appendEvent({
        type: "thread.turn-steer-rejected",
        payload: { messageId: "steer-2", expectedTurnId: turnId },
      });
      assert.isFalse((yield* signals()).unresolvedSteer);

      yield* appendEvent({
        type: "thread.turn-start-requested",
        payload: { messageId: "message-1" },
      });
      assert.isFalse((yield* signals()).computerUse);
      yield* appendEvent({
        type: "thread.turn-start-requested",
        payload: { messageId: "message-2", computerUse: { mode: "chat", generation: "g-1" } },
      });
      assert.isFalse((yield* signals()).computerUse);
      assert.isTrue((yield* signals("message-2")).computerUse);
      assert.isFalse((yield* signals(null)).computerUse);
    }),
  );

  it.effect("finds an unbound turn start of a message", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* RestartContinuationRepository;
      const exists = (messageId: string) =>
        repository.pendingTurnStartExists({ threadId, messageId: MessageId.make(messageId) });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${threadId}, NULL, 'message-pending', 'pending', '2026-10-04T10:00:00.000Z', '[]'),
          (${threadId}, 'turn-bound', 'message-bound', 'running', '2026-10-04T10:00:00.000Z', '[]')
      `;
      assert.isTrue(yield* exists("message-pending"));
      assert.isFalse(yield* exists("message-bound"));
      assert.isFalse(yield* exists("message-missing"));
    }),
  );

  it.effect("records running sessions and live background work as shutdown hints", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* RestartContinuationRepository;
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES ('thread-running', 'running', 'turn-r', '2026-10-04T10:00:00.000Z'),
          ('thread-ready', 'ready', NULL, '2026-10-04T10:00:00.000Z'),
          ('thread-starting', 'starting', NULL, '2026-10-04T10:00:00.000Z')
      `;
      yield* repository.recordShutdownHints({
        liveBackgroundThreadIds: ["thread-ready", "thread-running"],
        recordedAt: "2026-10-04T10:20:00.000Z",
      });
      assert.deepStrictEqual(yield* repository.listShutdownHints(), [
        {
          threadId: ThreadId.make("thread-ready"),
          hasBackgroundWork: true,
          recordedAt: "2026-10-04T10:20:00.000Z",
        },
        {
          threadId: ThreadId.make("thread-running"),
          hasBackgroundWork: true,
          recordedAt: "2026-10-04T10:20:00.000Z",
        },
        {
          threadId: ThreadId.make("thread-starting"),
          hasBackgroundWork: false,
          recordedAt: "2026-10-04T10:20:00.000Z",
        },
      ]);

      yield* repository.recordShutdownHints({
        liveBackgroundThreadIds: [],
        recordedAt: "2026-10-04T10:30:00.000Z",
      });
      yield* repository.clearShutdownHints("2026-10-04T10:20:00.000Z");
      assert.deepStrictEqual(
        (yield* repository.listShutdownHints()).map((hint) => [
          hint.threadId,
          hint.hasBackgroundWork,
        ]),
        [
          ["thread-running", true],
          ["thread-starting", false],
        ],
      );
    }),
  );

  it.effect("prunes only old settled rows", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* RestartContinuationRepository;
      yield* repository.insertIfAbsent(pending(record({ threadId: ThreadId.make("pending") })));
      for (const [id, settledAt] of [
        ["old", "2026-08-01T00:00:00.000Z"],
        ["recent", "2026-10-01T00:00:00.000Z"],
      ] as const) {
        yield* repository.insertIfAbsent({
          record: record({ threadId: ThreadId.make(id) }),
          status: "dispatched",
          reason: null,
          settledAt,
        });
      }
      yield* repository.pruneSettled("2026-09-04T00:00:00.000Z");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM restart_continuations ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.threadId),
        ["pending", "recent"],
      );
    }),
  );
});
