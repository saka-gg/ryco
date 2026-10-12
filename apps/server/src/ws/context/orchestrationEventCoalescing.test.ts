import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationEvent,
  OrchestrationGetSnapshotError,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Ref } from "effect";

import {
  makeOrchestrationEventCoalescer,
  orchestrationProgressFrameKey,
  orchestrationShellFrameKey,
} from "./orchestrationEventCoalescing.ts";

const threadId = ThreadId.make("thread-coalesce");

const makeEventBase = (sequence: number, eventId: string) => ({
  sequence,
  eventId: EventId.make(eventId),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: "2026-04-05T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const makeTaskProgressEvent = (
  sequence: number,
  taskId: string,
  detail: string,
): OrchestrationEvent => ({
  ...makeEventBase(sequence, `event-task-progress-${sequence}`),
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(`task-progress:${threadId}:${taskId}`),
      tone: "info",
      kind: "task.progress",
      summary: "Reasoning update",
      payload: { taskId, detail },
      turnId: null,
      createdAt: "2026-04-05T00:00:00.000Z",
    },
  },
});

const makeThreadDeletedEvent = (sequence: number): OrchestrationEvent => ({
  ...makeEventBase(sequence, `event-thread-deleted-${sequence}`),
  type: "thread.deleted",
  payload: {
    threadId,
    deletedAt: "2026-04-05T00:00:00.000Z",
  },
});

describe("orchestrationEventCoalescing", () => {
  it.effect("keeps matching activity ids from different threads independent", () =>
    Effect.gen(function* () {
      const offered: OrchestrationEvent[] = [];
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event) =>
          Effect.sync(() => {
            offered.push(event);
          }),
        windowMs: Number.MAX_SAFE_INTEGER,
      });
      const first = makeTaskProgressEvent(1, "same", "a");
      const second = {
        ...makeTaskProgressEvent(2, "same", "b"),
        aggregateId: ThreadId.make("another-thread"),
      };
      yield* coalescer.push(first);
      yield* coalescer.push(second);
      yield* coalescer.flush;
      assert.deepEqual(
        offered.map((event) => event.sequence),
        [1, 2],
      );
    }),
  );

  it("keeps distinct context-window activity ids independent", () => {
    const first = makeTaskProgressEvent(1, "one", "a");
    const second = makeTaskProgressEvent(2, "two", "b");
    if (first.type !== "thread.activity-appended" || second.type !== "thread.activity-appended")
      throw new Error("expected activities");
    const gauge = (event: typeof first): OrchestrationEvent => ({
      ...event,
      payload: {
        ...event.payload,
        activity: { ...event.payload.activity, kind: "context-window.updated" },
      },
    });
    assert.notEqual(
      orchestrationProgressFrameKey(gauge(first)),
      orchestrationProgressFrameKey(gauge(second)),
    );
  });

  it.effect("collapses progress bursts to the latest frame per key", () =>
    Effect.gen(function* () {
      const offered = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
      const coalescedSequences = yield* Ref.make<ReadonlyArray<number>>([]);
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event) => Ref.update(offered, (events) => [...events, event]).pipe(Effect.asVoid),
        onCoalesced: (sequence) => Ref.update(coalescedSequences, (seqs) => [...seqs, sequence]),
        windowMs: Number.MAX_SAFE_INTEGER,
      });

      for (let tick = 1; tick <= 50; tick += 1) {
        yield* coalescer.push(makeTaskProgressEvent(tick, "task-1", `tick-${tick}`));
      }

      assert.deepEqual(yield* Ref.get(offered), []);
      yield* coalescer.flush;

      const delivered = yield* Ref.get(offered);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.sequence, 50);
      assert.equal((yield* Ref.get(coalescedSequences)).length, 49);
    }),
  );

  it.effect("keeps distinct keys independent and delivers lifecycle frames immediately", () =>
    Effect.gen(function* () {
      const offered = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event) => Ref.update(offered, (events) => [...events, event]).pipe(Effect.asVoid),
        windowMs: Number.MAX_SAFE_INTEGER,
      });

      yield* coalescer.push(makeTaskProgressEvent(1, "task-1", "a"));
      yield* coalescer.push(makeTaskProgressEvent(2, "task-2", "a"));
      yield* coalescer.push(makeTaskProgressEvent(3, "task-1", "b"));
      // Lifecycle frame: must flush pending first, in sequence order.
      yield* coalescer.push(makeThreadDeletedEvent(4));

      const delivered = yield* Ref.get(offered);
      assert.deepEqual(
        delivered.map((event) => event.sequence),
        [2, 3, 4],
      );
    }),
  );

  it.effect("window 0 degrades to pass-through and preserves ordering", () =>
    Effect.gen(function* () {
      const offered = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event) => Ref.update(offered, (events) => [...events, event]).pipe(Effect.asVoid),
        windowMs: 0,
      });

      for (let tick = 1; tick <= 5; tick += 1) {
        yield* coalescer.push(makeTaskProgressEvent(tick, "task-1", `tick-${tick}`));
      }

      const delivered = yield* Ref.get(offered);
      assert.deepEqual(
        delivered.map((event) => event.sequence),
        [1, 2, 3, 4, 5],
      );
    }),
  );

  it.effect("preserves final-state equivalence with the uncoalesced frame stream", () =>
    Effect.gen(function* () {
      // The reducer the client applies: activities upsert by id, latest wins.
      const applyAll = (events: ReadonlyArray<OrchestrationEvent>) => {
        const byId = new Map<string, unknown>();
        for (const event of events) {
          if (event.type === "thread.activity-appended") {
            byId.set(event.payload.activity.id, event.payload.activity);
          }
        }
        return byId;
      };
      const uncoalesced = Array.from({ length: 60 }, (_, index) =>
        makeTaskProgressEvent(index + 1, "task-1", `tick-${index + 1}`),
      );
      uncoalesced.push(makeThreadDeletedEvent(61));

      const coalescedRef = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event) =>
          Ref.update(coalescedRef, (events) => [...events, event]).pipe(Effect.asVoid),
        windowMs: Number.MAX_SAFE_INTEGER,
      });
      for (const event of uncoalesced) {
        yield* coalescer.push(event);
      }
      yield* coalescer.flush;

      const delivered = yield* Ref.get(coalescedRef);
      assert.isBelow(delivered.length, uncoalesced.length);
      assert.deepEqual(applyAll(delivered), applyAll(uncoalesced));
    }),
  );

  it.effect("flushes through instead of dropping when the pending byte budget overflows", () =>
    Effect.gen(function* () {
      const offered = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
      const coalescedSequences = yield* Ref.make<ReadonlyArray<number>>([]);
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event) => Ref.update(offered, (events) => [...events, event]).pipe(Effect.asVoid),
        onCoalesced: (sequence) => Ref.update(coalescedSequences, (seqs) => [...seqs, sequence]),
        windowMs: Number.MAX_SAFE_INTEGER,
        maxPendingBytes: 1,
      });

      yield* coalescer.push(makeTaskProgressEvent(1, "task-1", "a"));
      yield* coalescer.push(makeTaskProgressEvent(2, "task-2", "a"));
      yield* coalescer.push(makeThreadDeletedEvent(3));

      const delivered = yield* Ref.get(offered);
      // Byte overflow flushes pending frames through; nothing is dropped.
      assert.deepEqual(
        delivered.map((event) => event.sequence),
        [1, 2, 3],
      );
      assert.equal((yield* Ref.get(coalescedSequences)).length, 0);
    }),
  );

  it.effect("propagates offer overflow so subscriptions still fail over to resync", () =>
    Effect.gen(function* () {
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: () => Effect.fail(new OrchestrationGetSnapshotError({ message: "overflow" })),
        windowMs: 0,
      });

      const result = yield* coalescer
        .push(makeTaskProgressEvent(1, "task-1", "a"))
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
    }),
  );

  it("never issues a coalesce key for append-only streaming message deltas", () => {
    const streamingMessage: OrchestrationEvent = {
      ...makeEventBase(1, "event-message-1"),
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: "message-1" as never,
        role: "assistant",
        text: "delta",
        turnId: null,
        streaming: true,
        createdAt: "2026-04-05T00:00:00.000Z",
        updatedAt: "2026-04-05T00:00:00.000Z",
      },
    };
    assert.equal(orchestrationProgressFrameKey(streamingMessage), null);
  });
  it.effect("collapses a thread's activity and message bursts for the shell, latest wins", () =>
    Effect.gen(function* () {
      const offered: OrchestrationEvent[] = [];
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event) =>
          Effect.sync(() => {
            offered.push(event);
          }),
        windowMs: Number.MAX_SAFE_INTEGER,
        keyOf: orchestrationShellFrameKey,
      });
      const toolActivity: OrchestrationEvent = {
        ...makeEventBase(2, "event-tool-completed-2"),
        type: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            id: EventId.make("tool-completed-1"),
            tone: "info",
            kind: "tool.completed",
            summary: "Ran a command",
            payload: {},
            turnId: null,
            createdAt: "2026-04-05T00:00:00.000Z",
          },
        },
      };
      yield* coalescer.push(makeTaskProgressEvent(1, "task", "a"));
      yield* coalescer.push(toolActivity);
      yield* coalescer.push(makeTaskProgressEvent(3, "task", "c"));
      // A structural thread event flushes what is held first, in order.
      yield* coalescer.push(makeThreadDeletedEvent(4));

      assert.deepEqual(
        offered.map((event) => event.sequence),
        [3, 4],
      );
      assert.isNull(orchestrationShellFrameKey(makeThreadDeletedEvent(5)));
      assert.isNotNull(orchestrationShellFrameKey(toolActivity));
      // Plan upserts only change the re-read row too: one key per thread.
      const planUpsert = {
        ...makeEventBase(6, "event-plan-6"),
        type: "thread.proposed-plan-upserted",
        payload: { threadId, proposedPlan: { id: "plan-1" } },
      } as unknown as OrchestrationEvent;
      assert.equal(
        orchestrationShellFrameKey(planUpsert),
        orchestrationShellFrameKey(toolActivity),
      );
    }),
  );
});
