import { assert, describe, it } from "@effect/vitest";
import { EventId, MessageId, type OrchestrationEvent, ProjectId, ThreadId } from "@ryco/contracts";
import { Effect, Exit, Fiber, PubSub, Queue, Scope, Stream } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeOrchestrationStreamHelpers } from "./orchestrationStreams.ts";
import { registerThreadEventSubscriber, threadEventRouterStartCount } from "./threadEventRouter.ts";

const messageEvent = (sequence: number, threadId: ThreadId): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-11-10T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make(`message-${sequence}`),
    role: "assistant",
    text: "hello",
    turnId: null,
    streaming: false,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  },
});

const projectEvent = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "project",
  aggregateId: ProjectId.make("project-1"),
  occurredAt: "2026-11-10T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.deleted",
  payload: { projectId: ProjectId.make("project-1"), deletedAt: "2026-11-10T00:00:00.000Z" },
});

const makeEngine = Effect.gen(function* () {
  const live = yield* PubSub.unbounded<OrchestrationEvent>();
  let subscriptions = 0;
  const engine = {
    subscribeDomainEvents: Effect.map(PubSub.subscribe(live), (subscription) => {
      subscriptions += 1;
      return Stream.fromSubscription(subscription);
    }),
    readEventsPage: (fromSequenceExclusive: number) =>
      Effect.succeed({ events: [], nextSequence: fromSequenceExclusive, hasMore: false }),
  } as unknown as OrchestrationEngineShape;
  return { live, engine, subscriptions: () => subscriptions };
});

describe("threadEventRouter", () => {
  it.effect("hands each thread's events only to that thread's subscribers", () =>
    Effect.gen(function* () {
      const { live, engine } = yield* makeEngine;
      const threads = Array.from({ length: 30 }, (_, index) => ThreadId.make(`thread-${index}`));
      const received = new Map<string, Array<number>>();
      const delivered = yield* Queue.unbounded<number>();
      let wakeups = 0;
      const scope = yield* Scope.make();
      const registrations = yield* Effect.forEach(threads, (threadId) =>
        registerThreadEventSubscriber(engine, threadId, {
          onEvent: (event) =>
            Effect.sync(() => {
              wakeups += 1;
              received.set(threadId, [...(received.get(threadId) ?? []), event.sequence]);
              Queue.offerUnsafe(delivered, event.sequence);
            }),
          onEnd: Effect.void,
        }).pipe(Scope.provide(scope)),
      );
      // Thirty subscriptions share one engine subscription.
      assert.equal(threadEventRouterStartCount(engine), 1);

      yield* PubSub.publish(live, messageEvent(1, threads[3]!));
      yield* PubSub.publish(live, projectEvent(2));
      yield* PubSub.publish(live, messageEvent(3, threads[7]!));
      assert.deepEqual([yield* Queue.take(delivered), yield* Queue.take(delivered)], [1, 3]);

      assert.equal(wakeups, 2);
      assert.deepEqual(Object.fromEntries(received), { "thread-3": [1], "thread-7": [3] });
      // Every event moves the routed position, the project event included.
      assert.equal(registrations[0]!.routedThrough(), 3);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("closes its subscription with the last subscriber and opens a fresh one after", () =>
    Effect.gen(function* () {
      const { live, engine, subscriptions } = yield* makeEngine;
      const threadId = ThreadId.make("thread-a");
      const seen: Array<number> = [];
      const delivered = yield* Queue.unbounded<number>();
      const subscriber = {
        onEvent: (event: OrchestrationEvent) =>
          Effect.sync(() => {
            seen.push(event.sequence);
            Queue.offerUnsafe(delivered, event.sequence);
          }),
        onEnd: Effect.void,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* registerThreadEventSubscriber(engine, threadId, subscriber);
          yield* PubSub.publish(live, messageEvent(1, threadId));
          assert.equal(yield* Queue.take(delivered), 1);
          assert.equal(registration.routedThrough(), 1);
        }),
      );
      assert.equal(subscriptions(), 1);
      // Nothing is subscribed while nobody listens.
      yield* PubSub.publish(live, messageEvent(2, threadId));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* registerThreadEventSubscriber(engine, threadId, subscriber);
          // A new run has routed nothing: replays read to the end of the log.
          assert.equal(registration.routedThrough(), 0);
          yield* PubSub.publish(live, messageEvent(3, threadId));
          assert.equal(yield* Queue.take(delivered), 3);
        }),
      );
      assert.equal(subscriptions(), 2);
      // Event 2 was published while nobody listened: no subscription received it.
      assert.deepEqual(seen, [1, 3]);
    }),
  );

  it.effect("thread subscriptions on many threads open one engine subscription", () =>
    Effect.gen(function* () {
      const { live, engine, subscriptions } = yield* makeEngine;
      const helpers = makeOrchestrationStreamHelpers({
        orchestrationEngine: engine,
        projectionSnapshotQuery: {} as unknown as ProjectionSnapshotQueryShape,
        repositoryIdentityResolver: { resolve: () => Effect.succeed(null) },
      });
      const threads = Array.from({ length: 20 }, (_, index) => ThreadId.make(`thread-${index}`));
      const delivered = yield* Queue.unbounded<string>();
      const fibers = yield* Effect.forEach(threads, (threadId) =>
        helpers.makeReplayableThreadStream(Effect.succeed({ snapshotSequence: 10 }), threadId).pipe(
          Stream.runForEach((item) =>
            Queue.offer(
              delivered,
              item.kind === "event" ? `${threadId}:${item.event.sequence}` : item.kind,
            ),
          ),
          Effect.forkChild,
        ),
      );
      for (const _ of threads) assert.equal(yield* Queue.take(delivered), "snapshot");
      assert.equal(subscriptions(), 1);

      yield* PubSub.publish(live, messageEvent(11, threads[5]!));
      yield* PubSub.publish(live, messageEvent(12, threads[9]!));
      assert.equal(yield* Queue.take(delivered), "thread-5:11");
      assert.equal(yield* Queue.take(delivered), "thread-9:12");
      // Nothing else was delivered in between: the next item is the next event.
      yield* PubSub.publish(live, messageEvent(13, threads[5]!));
      assert.equal(yield* Queue.take(delivered), "thread-5:13");
      yield* Fiber.interruptAll(fibers);
    }),
  );
});
