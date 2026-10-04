import {
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderEffectIntentRepositoryLive } from "./ProviderEffectIntents.ts";
import { ProviderEffectIntentRepository } from "../Services/ProviderEffectIntents.ts";

const layer = it.layer(
  ProviderEffectIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const at = "2026-10-04T00:00:00.000Z";

function event(
  sequence: number,
  type: OrchestrationEvent["type"],
  payload: unknown,
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: (payload as { threadId: ThreadId }).threadId,
    occurredAt: at,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

const turnStart = (sequence: number, threadId: ThreadId, messageId: string, handoff?: string) =>
  event(sequence, "thread.turn-start-requested", {
    threadId,
    messageId: MessageId.make(messageId),
    runtimeMode: "full-access",
    interactionMode: "default",
    tokenMode: "balanced",
    ...(handoff
      ? {
          contextHandoff: {
            handoffId: ContextHandoffId.make(handoff),
            activityId: EventId.make(`activity-${handoff}`),
            targetMessageId: MessageId.make(messageId),
          },
        }
      : {}),
    createdAt: at,
  });

const steer = (sequence: number, threadId: ThreadId, messageId: string) =>
  event(sequence, "thread.turn-steer-requested", {
    threadId,
    expectedTurnId: TurnId.make("turn-1"),
    message: { messageId: MessageId.make(messageId), role: "user", text: "steer", attachments: [] },
    createdAt: at,
    requestedAt: at,
  });

const stop = (sequence: number, threadId: ThreadId) =>
  event(sequence, "thread.session-stop-requested", { threadId, createdAt: at });

const activity = (sequence: number, threadId: ThreadId, kind: string, payload: unknown) =>
  event(sequence, "thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.make(`activity-${sequence}`),
      tone: "error",
      kind,
      summary: "Activity",
      payload,
      turnId: null,
      createdAt: at,
    },
  });

const sessionSet = (sequence: number, threadId: ThreadId, status: "running" | "stopped") =>
  event(sequence, "thread.session-set", {
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
      runtimeMode: "full-access",
      activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
      lastError: null,
      updatedAt: at,
    },
  });

const openSequences = Effect.gen(function* () {
  const repository = yield* ProviderEffectIntentRepository;
  return (yield* repository.listOpen()).map((row) => row.sequence);
});

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_effect_intents`;
});

layer("ProviderEffectIntentRepository", (it) => {
  it.effect("settles only matching rows recorded before the outcome", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* ProviderEffectIntentRepository;
      for (const requested of [
        turnStart(1, threadA, "m1"),
        turnStart(2, threadA, "m2"),
        turnStart(3, threadB, "m1"),
        steer(4, threadA, "m1"),
        turnStart(6, threadA, "m1"),
      ]) {
        yield* repository.applyEvent(requested);
      }
      yield* repository.applyEvent(
        activity(5, threadA, "provider.turn.start.failed", { messageId: "m1" }),
      );
      // Only the start of m1 on thread A before sequence 5: not thread B, not the steer,
      // not m2, not the later start of m1.
      assert.deepStrictEqual(yield* openSequences, [2, 3, 4, 6]);

      yield* repository.applyEvent(
        event(7, "thread.turn-steer-rejected", {
          threadId: threadA,
          messageId: MessageId.make("m1"),
          expectedTurnId: TurnId.make("turn-1"),
          error: "rejected",
          resolvedAt: at,
        }),
      );
      assert.deepStrictEqual(yield* openSequences, [2, 3, 6]);

      yield* repository.applyEvent(
        event(8, "thread.deleted", { threadId: threadB, deletedAt: at }),
      );
      assert.deepStrictEqual(yield* openSequences, [2, 6]);
    }),
  );

  it.effect("settles handoff starts by handoff and session stops by thread", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* ProviderEffectIntentRepository;
      yield* repository.applyEvent(turnStart(1, threadA, "m1", "handoff-1"));
      yield* repository.applyEvent(turnStart(2, threadA, "m2", "handoff-2"));
      yield* repository.applyEvent(stop(3, threadA));
      yield* repository.applyEvent(stop(4, threadB));
      yield* repository.applyEvent(
        activity(5, threadA, "context-handoff", {
          schemaVersion: 1,
          handoffId: "handoff-1",
          mode: "full-context-fresh-session",
          status: "failed",
          targetMessageId: "m1",
          sourceSelection: { instanceId: "codex", model: "gpt" },
          targetSelection: { instanceId: "codex", model: "gpt" },
          sources: [{ providerInstanceId: "codex", driverKind: "codex", modelSlug: "gpt" }],
          target: { providerInstanceId: "codex", driverKind: "codex", modelSlug: "gpt" },
          error: "failed",
        }),
      );
      assert.deepStrictEqual(yield* openSequences, [2, 3, 4]);

      yield* repository.applyEvent(activity(6, threadA, "provider.session.stop.failed", {}));
      assert.deepStrictEqual(yield* openSequences, [2, 4]);
      yield* repository.applyEvent(sessionSet(7, threadB, "stopped"));
      assert.deepStrictEqual(yield* openSequences, [2]);
    }),
  );

  it.effect("binds only dispatched turn starts to a running session", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* ProviderEffectIntentRepository;
      yield* repository.applyEvent(turnStart(1, threadA, "m1"));
      yield* repository.applyEvent(turnStart(2, threadA, "m2"));
      yield* repository.applyEvent(turnStart(3, threadA, "m3", "handoff-3"));
      yield* repository.markDispatched({ sequence: 1, dispatchedAt: at });
      yield* repository.applyEvent(sessionSet(4, threadA, "running"));
      // Never-dispatched rows and handoff rows (never marked dispatched) stay.
      assert.deepStrictEqual(yield* openSequences, [2, 3]);
    }),
  );

  it.effect("keeps the first dispatch time and records idempotently", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* ProviderEffectIntentRepository;
      yield* repository.applyEvent(turnStart(1, threadA, "m1"));
      yield* repository.applyEvent(turnStart(1, threadA, "m1"));
      yield* repository.markDispatched({ sequence: 1, dispatchedAt: "2026-10-04T00:00:01.000Z" });
      yield* repository.markDispatched({ sequence: 1, dispatchedAt: "2026-10-04T00:00:02.000Z" });
      yield* repository.markDispatched({ sequence: 99, dispatchedAt: at });
      const row = yield* repository.get({ sequence: 1 });
      assert.deepStrictEqual(
        Option.map(row, (value) => value.dispatchedAt),
        Option.some("2026-10-04T00:00:01.000Z"),
      );
      assert.deepStrictEqual(
        Option.map(row, ({ kind, messageId, handoffId, recordedAt, recoveryAttempts }) => ({
          kind,
          messageId,
          handoffId,
          recordedAt,
          recoveryAttempts,
        })),
        Option.some({
          kind: "turn-start" as const,
          messageId: MessageId.make("m1"),
          handoffId: null,
          recordedAt: at,
          recoveryAttempts: 0,
        }),
      );
      assert.isTrue(Option.isNone(yield* repository.get({ sequence: 2 })));
    }),
  );

  it.effect("lists open rows in sequence order and counts recovery attempts", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* ProviderEffectIntentRepository;
      yield* repository.applyEvent(stop(9, threadA));
      yield* repository.applyEvent(turnStart(3, threadA, "m3"));
      yield* repository.applyEvent(steer(5, threadB, "m5"));
      assert.deepStrictEqual(yield* openSequences, [3, 5, 9]);

      assert.strictEqual(yield* repository.noteRecoveryAttempt({ sequence: 5 }), 1);
      assert.strictEqual(yield* repository.noteRecoveryAttempt({ sequence: 5 }), 2);
      assert.strictEqual(yield* repository.noteRecoveryAttempt({ sequence: 99 }), 0);

      yield* repository.settle({ sequence: 5 });
      assert.deepStrictEqual(yield* openSequences, [3, 9]);
    }),
  );

  it.effect("issues no SQL for untracked, non-settling events", () =>
    Effect.gen(function* () {
      yield* reset;
      const repository = yield* ProviderEffectIntentRepository;
      // A missing table would fail any statement; drop it to prove nothing runs.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE provider_effect_intents RENAME TO provider_effect_intents_hidden`;
      const exit = yield* Effect.exit(
        repository.applyEvent(
          event(1, "thread.turn-interrupt-requested", { threadId: threadA, createdAt: at }),
        ),
      );
      yield* sql`ALTER TABLE provider_effect_intents_hidden RENAME TO provider_effect_intents`;
      assert.strictEqual(exit._tag, "Success");
    }),
  );
});
