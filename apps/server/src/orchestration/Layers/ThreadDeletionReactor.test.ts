import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, PubSub, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  type ProjectionProject,
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../../persistence/Services/ProjectionThreads.ts";

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

/** Projection rows the reactor reads when deciding whether a chat project is now empty. */
const projectionLayer = (input?: {
  readonly projects?: ReadonlyArray<ProjectionProject>;
  readonly threads?: ReadonlyArray<ProjectionThread>;
}) =>
  Layer.mergeAll(
    Layer.succeed(ProjectionProjectRepository, {
      getById: ({ projectId }: { projectId: ProjectId }) =>
        Effect.succeed(
          Option.fromNullishOr(input?.projects?.find((project) => project.projectId === projectId)),
        ),
    } as unknown as ProjectionProjectRepositoryShape),
    Layer.succeed(ProjectionThreadRepository, {
      getById: ({ threadId }: { threadId: ThreadId }) =>
        Effect.succeed(
          Option.fromNullishOr(input?.threads?.find((thread) => thread.threadId === threadId)),
        ),
      listByProjectId: ({ projectId }: { projectId: ProjectId }) =>
        Effect.succeed(input?.threads?.filter((thread) => thread.projectId === projectId) ?? []),
    } as unknown as ProjectionThreadRepositoryShape),
  );

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
            Layer.provide(projectionLayer()),
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
            Layer.provide(projectionLayer()),
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

describe("ThreadDeletionReactor chat projects", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const chatProjectId = ProjectId.make("project-chat");

  const projectRow = (overrides: Partial<ProjectionProject> = {}): ProjectionProject => ({
    projectId: chatProjectId,
    kind: "chat",
    title: "Chat",
    workspaceRoot: "/chats/2026-01-01-chat-0123abcd",
    projectMetadataDir: ".ryco",
    defaultModelSelection: null,
    customSystemPrompt: null,
    customAvatarContentHash: null,
    preferredRemoteName: null,
    scripts: [],
    createdAt: now,
    updatedAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  });

  const threadRow = (
    threadId: string,
    overrides: Partial<ProjectionThread> = {},
  ): ProjectionThread => ({
    threadId: ThreadId.make(threadId),
    projectId: chatProjectId,
    title: "Chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: now,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: now,
    trashedAt: null,
    lineageParentThreadId: null,
    lineageRootThreadId: null,
    lineageRelationship: null,
    ...overrides,
  });

  const removal = (
    type: "thread.deleted" | "thread.trashed",
    threadId: string,
    sequence = 1,
  ): OrchestrationEvent =>
    ({
      sequence,
      eventId: EventId.make(`event-${type}-${threadId}`),
      aggregateKind: "thread",
      aggregateId: ThreadId.make(threadId),
      type,
      occurredAt: now,
      commandId: CommandId.make(`command-${type}-${threadId}`),
      causationEventId: null,
      correlationId: CorrelationId.make(`command-${type}-${threadId}`),
      metadata: {},
      payload:
        type === "thread.deleted"
          ? { threadId: ThreadId.make(threadId), deletedAt: now }
          : { threadId: ThreadId.make(threadId), trashedAt: now, updatedAt: now },
    }) as OrchestrationEvent;

  /** Publish one removal and report the commands the reactor dispatched for it. */
  const dispatchedFor = (input: {
    readonly event: OrchestrationEvent;
    readonly projects: ReadonlyArray<ProjectionProject>;
    readonly threads: ReadonlyArray<ProjectionThread>;
  }) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const dispatched: OrchestrationCommand[] = [];
          const layer = ThreadDeletionReactorLive.pipe(
            Layer.provide(
              Layer.succeed(ProviderService, {
                stopSession: () => Effect.void,
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
                dispatch: (command: OrchestrationCommand) =>
                  Effect.sync(() => {
                    dispatched.push(command);
                    return { sequence: 100 };
                  }),
              } as unknown as OrchestrationEngineShape),
            ),
            Layer.provide(projectionLayer({ projects: input.projects, threads: input.threads })),
          );
          yield* Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            yield* PubSub.publish(events, input.event);
            yield* reactor.drainThrough(input.event.sequence).pipe(Effect.timeout("1 second"));
          }).pipe(Effect.provide(layer));
          return dispatched;
        }),
      ),
    );

  it("deletes the chat project, guarded, once its last thread is deleted permanently", async () => {
    const dispatched = await dispatchedFor({
      event: removal("thread.deleted", "thread-last"),
      projects: [projectRow()],
      threads: [threadRow("thread-last"), threadRow("thread-earlier")],
    });
    expect(dispatched).toEqual([
      {
        type: "project.delete",
        commandId: CommandId.make("server:chat-project-retire:event-thread.deleted-thread-last"),
        projectId: chatProjectId,
        expectedUpdatedAt: "2026-01-02T00:00:00.000Z",
        expectedThreadIds: [],
      },
    ]);
  });

  it("keeps the chat while another thread is live or recoverable from Trash", async () => {
    for (const sibling of [
      threadRow("thread-live", { deletedAt: null }),
      threadRow("thread-trashed", { trashedAt: now }),
    ]) {
      const dispatched = await dispatchedFor({
        event: removal("thread.deleted", "thread-last"),
        projects: [projectRow()],
        threads: [threadRow("thread-last"), sibling],
      });
      expect(dispatched).toEqual([]);
    }
  });

  it("ignores Trash, regular projects, deleted chats and rolled-back first sends", async () => {
    const cases = [
      {
        event: removal("thread.trashed", "thread-last"),
        projects: [projectRow()],
        threads: [threadRow("thread-last", { trashedAt: now })],
      },
      {
        event: removal("thread.deleted", "thread-last"),
        projects: [projectRow({ kind: "project" })],
        threads: [threadRow("thread-last")],
      },
      {
        event: removal("thread.deleted", "thread-last"),
        projects: [projectRow({ deletedAt: now })],
        threads: [threadRow("thread-last")],
      },
      {
        // The bootstrap rolls back a never-used thread; the chat stays for the retry.
        event: removal("thread.deleted", "thread-last"),
        projects: [projectRow()],
        threads: [threadRow("thread-last", { latestUserMessageAt: null })],
      },
    ];
    for (const input of cases) {
      expect(await dispatchedFor(input)).toEqual([]);
    }
  });
});
