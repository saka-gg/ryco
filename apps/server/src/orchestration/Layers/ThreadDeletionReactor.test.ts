import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, PubSub, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("ThreadDeletionReactor recreation fence", () => {
  it("waits for earlier deletion cleanup before releasing a new incarnation", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const now = "2026-01-01T00:00:00.000Z";
          const threadId = ThreadId.make("thread-recreation-fence");
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const cleanupStarted = yield* Deferred.make<void>();
          const releaseCleanup = yield* Deferred.make<void>();
          const stops: ThreadId[] = [];

          const deletedEvent = {
            sequence: 1,
            eventId: EventId.make("event-delete-1"),
            aggregateKind: "thread",
            aggregateId: threadId,
            type: "thread.deleted",
            occurredAt: now,
            commandId: CommandId.make("command-delete-1"),
            causationEventId: null,
            correlationId: CorrelationId.make("command-delete-1"),
            metadata: {},
            payload: { threadId, deletedAt: now },
          } satisfies OrchestrationEvent;
          const createdEvent = {
            sequence: 2,
            eventId: EventId.make("event-create-2"),
            aggregateKind: "thread",
            aggregateId: threadId,
            type: "thread.created",
            occurredAt: now,
            commandId: CommandId.make("command-create-2"),
            causationEventId: null,
            correlationId: CorrelationId.make("command-create-2"),
            metadata: {},
            payload: {
              threadId,
              projectId: ProjectId.make("project-recreation-fence"),
              title: "Retried thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          } satisfies OrchestrationEvent;

          const layer = ThreadDeletionReactorLive.pipe(
            Layer.provide(
              Layer.succeed(ProviderService, {
                stopSession: ({
                  threadId: stoppedThreadId,
                }: Parameters<ProviderServiceShape["stopSession"]>[0]) =>
                  Effect.gen(function* () {
                    stops.push(stoppedThreadId);
                    yield* Deferred.succeed(cleanupStarted, undefined);
                    yield* Deferred.await(releaseCleanup);
                  }),
              } as unknown as ProviderServiceShape),
            ),
            Layer.provide(
              Layer.succeed(TerminalManager, {
                close: () => Effect.void,
              } as unknown as TerminalManagerShape),
            ),
            Layer.provide(
              Layer.succeed(OrchestrationEngineService, {
                streamDomainEvents: Stream.fromPubSub(events),
                subscribeDomainEvents: PubSub.subscribe(events),
              } as unknown as OrchestrationEngineShape),
            ),
          );

          yield* Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            yield* PubSub.publish(events, deletedEvent);
            yield* Deferred.await(cleanupStarted).pipe(Effect.timeout("1 second"));
            yield* PubSub.publish(events, createdEvent);

            const drained = yield* Effect.forkChild(reactor.drainThrough(createdEvent.sequence));
            yield* Effect.yieldNow;
            expect(drained.pollUnsafe()).toBeUndefined();

            yield* Deferred.succeed(releaseCleanup, undefined);
            yield* Fiber.join(drained).pipe(Effect.timeout("1 second"));
            expect(stops).toEqual([threadId]);
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
  });
});

describe("ThreadDeletionReactor trash versus permanent deletion", () => {
  it("stops the session on Trash but keeps terminal history; only deletion removes it", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const now = "2026-01-01T00:00:00.000Z";
          const threadId = ThreadId.make("thread-trash-history");
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const stops: ThreadId[] = [];
          const closes: Array<{ threadId: string; deleteHistory?: boolean | undefined }> = [];
          const base = {
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            causationEventId: null,
            metadata: {},
          } as const;
          const trashed = {
            ...base,
            sequence: 1,
            eventId: EventId.make("event-trash"),
            type: "thread.trashed",
            commandId: CommandId.make("command-trash"),
            correlationId: CorrelationId.make("command-trash"),
            payload: { threadId, trashedAt: now, updatedAt: now },
          } satisfies OrchestrationEvent;
          const deleted = {
            ...base,
            sequence: 2,
            eventId: EventId.make("event-delete"),
            type: "thread.deleted",
            commandId: CommandId.make("command-delete"),
            correlationId: CorrelationId.make("command-delete"),
            payload: { threadId, deletedAt: now },
          } satisfies OrchestrationEvent;

          const layer = ThreadDeletionReactorLive.pipe(
            Layer.provide(
              Layer.succeed(ProviderService, {
                stopSession: ({
                  threadId: stopped,
                }: Parameters<ProviderServiceShape["stopSession"]>[0]) =>
                  Effect.sync(() => void stops.push(stopped)),
              } as unknown as ProviderServiceShape),
            ),
            Layer.provide(
              Layer.succeed(TerminalManager, {
                close: (input: { threadId: string; deleteHistory?: boolean }) =>
                  Effect.sync(() => void closes.push(input)),
              } as unknown as TerminalManagerShape),
            ),
            Layer.provide(
              Layer.succeed(OrchestrationEngineService, {
                streamDomainEvents: Stream.fromPubSub(events),
                subscribeDomainEvents: PubSub.subscribe(events),
              } as unknown as OrchestrationEngineShape),
            ),
          );

          yield* Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            yield* PubSub.publish(events, trashed);
            yield* reactor.drainThrough(trashed.sequence).pipe(Effect.timeout("1 second"));
            expect(stops).toEqual([threadId]);
            expect(closes).toEqual([{ threadId, deleteHistory: false }]);
            yield* PubSub.publish(events, deleted);
            yield* reactor.drainThrough(deleted.sequence).pipe(Effect.timeout("1 second"));
            expect(closes.at(-1)).toEqual({ threadId, deleteHistory: true });
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
  });
});
