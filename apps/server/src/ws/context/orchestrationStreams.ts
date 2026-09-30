import { Effect, Fiber, Option, PubSub, Queue, Ref, Stream } from "effect";
import {
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  OrchestrationGetSnapshotError,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { RepositoryIdentityResolverShape } from "../../project/Services/RepositoryIdentityResolver.ts";
import { approximateJsonBytes } from "../../observability/PerfInstrumentation.ts";
import {
  type WsReplayMetrics,
  type WsReplayStreamKind,
  makeWsReplayMetrics,
} from "../../wsReplayMetrics.ts";
import {
  ORCHESTRATION_LIVE_QUEUE_MAX_BYTES,
  ORCHESTRATION_LIVE_QUEUE_MAX_EVENTS,
  ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS,
  ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
} from "./constants.ts";
import { isThreadDetailEvent } from "./orchestrationEvents.ts";
import { randomShortId } from "./branchNaming.ts";
import { makeOrchestrationEventCoalescer } from "./orchestrationEventCoalescing.ts";

const makeLiveQueueOverflowError = (input: {
  readonly stream: WsReplayStreamKind;
  readonly sequence: number;
  readonly capacity: number;
  readonly reason: "count" | "bytes";
}) =>
  new OrchestrationGetSnapshotError({
    message: `Orchestration ${input.stream} live event queue overflowed; reconnect to resynchronize`,
    cause: new Error(
      `orchestration ${input.stream} live queue ${input.reason} overflow at sequence ${input.sequence} with capacity ${input.capacity}`,
    ),
  });

export const offerOrchestrationLiveEventOrFail = (input: {
  readonly stream: WsReplayStreamKind;
  readonly event: OrchestrationEvent;
  readonly liveQueue: Queue.Queue<OrchestrationEvent, OrchestrationGetSnapshotError>;
  readonly overflowedRef: Ref.Ref<boolean>;
  readonly replayMetrics: WsReplayMetrics;
  readonly capacity?: number;
  /** Byte ledger for queued-but-undrained events; see LIVE_QUEUE_MAX_BYTES. */
  readonly queuedBytesRef?: Ref.Ref<number>;
  readonly byteBudget?: number;
  /** Precomputed event size, so coalescing can share one measurement. */
  readonly eventBytes?: number;
}) =>
  Effect.gen(function* () {
    const capacity = input.capacity ?? ORCHESTRATION_LIVE_QUEUE_MAX_EVENTS;
    const byteBudget = input.byteBudget ?? ORCHESTRATION_LIVE_QUEUE_MAX_BYTES;
    const eventBytes =
      input.eventBytes ??
      (input.queuedBytesRef === undefined ? 0 : approximateJsonBytes(input.event));

    if (input.queuedBytesRef !== undefined) {
      const queuedBytes = yield* Ref.get(input.queuedBytesRef);
      if (queuedBytes + eventBytes > byteBudget) {
        yield* failLiveQueueWithOverflow(input, capacity, "bytes");
        return;
      }
    }

    if (Queue.offerUnsafe(input.liveQueue, input.event)) {
      if (input.queuedBytesRef !== undefined) {
        yield* Ref.update(input.queuedBytesRef, (bytes) => bytes + eventBytes);
      }
      yield* input.replayMetrics.recordLiveEnqueued(input.event.sequence);
      return;
    }

    yield* failLiveQueueWithOverflow(input, capacity, "count");
  });

const failLiveQueueWithOverflow = (
  input: {
    readonly stream: WsReplayStreamKind;
    readonly event: OrchestrationEvent;
    readonly liveQueue: Queue.Queue<OrchestrationEvent, OrchestrationGetSnapshotError>;
    readonly overflowedRef: Ref.Ref<boolean>;
    readonly replayMetrics: WsReplayMetrics;
  },
  capacity: number,
  reason: "count" | "bytes",
) =>
  Effect.gen(function* () {
    const shouldFail = yield* Ref.modify(input.overflowedRef, (overflowed) => [!overflowed, true]);
    if (!shouldFail) {
      return;
    }

    yield* input.replayMetrics.recordLiveOverflow(input.event.sequence, capacity);
    yield* Effect.logWarning("orchestration live stream queue overflow; forcing resync", {
      stream: input.stream,
      sequence: input.event.sequence,
      capacity,
      reason,
    });
    yield* Queue.fail(
      input.liveQueue,
      makeLiveQueueOverflowError({
        stream: input.stream,
        sequence: input.event.sequence,
        capacity,
        reason,
      }),
    );
  });

/** Releases one drained event's bytes from the live queue ledger. */
export const releaseQueuedEventBytes = (
  queuedBytesRef: Ref.Ref<number>,
  event: OrchestrationEvent,
) => Ref.update(queuedBytesRef, (bytes) => Math.max(0, bytes - approximateJsonBytes(event)));

/**
 * Raw, uncoalesced offer primitive for one thread-subscription live event:
 * records the live sequence, filters to the subscription's thread detail
 * events, and enqueues with overflow handling. Production streams compose the
 * coalescer in front of this (see `runLiveFeed`); tests use it directly.
 */
export const offerOrchestrationThreadLiveEventOrFail = (input: {
  readonly threadId: ThreadId;
  readonly event: OrchestrationEvent;
  readonly recordLiveSequence: (sequence: number) => Effect.Effect<void, never, never>;
  readonly liveQueue: Queue.Queue<OrchestrationEvent, OrchestrationGetSnapshotError>;
  readonly overflowedRef: Ref.Ref<boolean>;
  readonly replayMetrics: WsReplayMetrics;
  readonly capacity?: number;
  readonly queuedBytesRef?: Ref.Ref<number>;
  readonly byteBudget?: number;
  readonly eventBytes?: number;
}) =>
  Effect.gen(function* () {
    yield* input.recordLiveSequence(input.event.sequence);
    if (
      input.event.aggregateKind !== "thread" ||
      input.event.aggregateId !== input.threadId ||
      !isThreadDetailEvent(input.event)
    ) {
      return false;
    }

    yield* offerOrchestrationLiveEventOrFail({
      stream: "thread",
      event: input.event,
      liveQueue: input.liveQueue,
      overflowedRef: input.overflowedRef,
      replayMetrics: input.replayMetrics,
      ...(input.queuedBytesRef !== undefined ? { queuedBytesRef: input.queuedBytesRef } : {}),
      ...(input.byteBudget !== undefined ? { byteBudget: input.byteBudget } : {}),
      ...(input.eventBytes !== undefined ? { eventBytes: input.eventBytes } : {}),
      ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
    });
    return true;
  });

export const makeOrchestrationStreamHelpers = (deps: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly repositoryIdentityResolver: RepositoryIdentityResolverShape;
  readonly threadPriorityChanges?: Stream.Stream<void>;
}) => {
  const { orchestrationEngine, projectionSnapshotQuery, repositoryIdentityResolver } = deps;
  const threadPriorityChanges = deps.threadPriorityChanges ?? Stream.empty;

  const enrichProjectEvent = (
    event: OrchestrationEvent,
  ): Effect.Effect<OrchestrationEvent, never, never> => {
    switch (event.type) {
      case "project.created":
        return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
          Effect.map((repositoryIdentity) => ({
            ...event,
            payload: {
              ...event.payload,
              repositoryIdentity,
            },
          })),
        );
      case "project.meta-updated":
        return Effect.gen(function* () {
          const workspaceRoot =
            event.payload.workspaceRoot ??
            Option.match(
              yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId),
              {
                onNone: () => null,
                onSome: (project) => project.workspaceRoot,
              },
            ) ??
            null;
          if (workspaceRoot === null) {
            return event;
          }

          const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
          return {
            ...event,
            payload: {
              ...event.payload,
              repositoryIdentity,
            },
          } satisfies OrchestrationEvent;
        }).pipe(Effect.catch(() => Effect.succeed(event)));
      default:
        return Effect.succeed(event);
    }
  };

  const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
    Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

  const toShellStreamEvent = (
    event: OrchestrationEvent,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
        return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
          Effect.map((project) =>
            Option.map(project, (nextProject) => ({
              kind: "project-upserted" as const,
              sequence: event.sequence,
              project: nextProject,
            })),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
      case "project.deleted":
        return Effect.succeed(
          Option.some({
            kind: "project-removed" as const,
            sequence: event.sequence,
            projectId: event.payload.projectId,
          }),
        );
      case "thread.deleted":
        return Effect.succeed(
          Option.some({
            kind: "thread-removed" as const,
            sequence: event.sequence,
            threadId: event.payload.threadId,
          }),
        );
      case "worktree.created":
      case "worktree.archived":
      case "worktree.metaUpdated":
      case "worktree.restored": {
        const getWorktreeShellById = projectionSnapshotQuery.getWorktreeShellById;
        if (getWorktreeShellById === undefined) {
          return Effect.succeed(Option.none());
        }
        return getWorktreeShellById(WorktreeId.make(event.payload.worktreeId)).pipe(
          Effect.map((worktree) =>
            Option.map(worktree, (nextWorktree) => ({
              kind: "worktree-upserted" as const,
              sequence: event.sequence,
              worktree: nextWorktree,
            })),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
      }
      case "worktree.deleted":
        return Effect.succeed(
          Option.some({
            kind: "worktree-removed" as const,
            sequence: event.sequence,
            worktreeId: event.payload.worktreeId,
          }),
        );
      default:
        if (event.aggregateKind !== "thread") {
          return Effect.succeed(Option.none());
        }
        return projectionSnapshotQuery.getThreadShellById(ThreadId.make(event.aggregateId)).pipe(
          Effect.map((thread) =>
            Option.map(thread, (nextThread) => ({
              kind: "thread-upserted" as const,
              sequence: event.sequence,
              thread: nextThread,
            })),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
    }
  };

  const dedupeBySequence =
    <A>(getSequence: (item: A) => number, sequenceRef: Ref.Ref<number>) =>
    <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
      stream.pipe(
        Stream.filterEffect((item) =>
          Ref.modify(sequenceRef, (lastSequence) => {
            const nextSequence = getSequence(item);
            if (nextSequence <= lastSequence) {
              return [false, lastSequence] as const;
            }
            return [true, nextSequence] as const;
          }),
        ),
      );

  const makeReplayBoundaryTracker = (snapshotSequence: number) =>
    Effect.gen(function* () {
      const latestLiveSequence = yield* Ref.make(snapshotSequence);
      const replayUpperBound = yield* Ref.make<Option.Option<number>>(Option.none());

      const captureReplayUpperBound = Effect.gen(function* () {
        const existingUpperBound = yield* Ref.get(replayUpperBound);
        if (Option.isSome(existingUpperBound)) {
          return existingUpperBound;
        }

        const latestSequence = yield* Ref.get(latestLiveSequence);
        if (latestSequence <= snapshotSequence) {
          return Option.none<number>();
        }

        const upperBound = Option.some(latestSequence);
        yield* Ref.set(replayUpperBound, upperBound);
        return upperBound;
      });

      return {
        recordLiveSequence: (sequence: number) =>
          Ref.update(latestLiveSequence, (current) => Math.max(current, sequence)),
        captureReplayUpperBound,
      };
    });

  const makeBoundedReplayStream = (input: {
    readonly snapshotSequence: number;
    readonly captureReplayUpperBound: Effect.Effect<Option.Option<number>>;
    readonly errorMessage: string;
  }): Stream.Stream<OrchestrationEvent, OrchestrationGetSnapshotError> => {
    const readPage = (
      fromSequenceExclusive: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationGetSnapshotError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const upperBoundBeforeRead = yield* input.captureReplayUpperBound;
          if (
            Option.isSome(upperBoundBeforeRead) &&
            fromSequenceExclusive >= upperBoundBeforeRead.value
          ) {
            return Stream.empty;
          }

          const page = yield* orchestrationEngine
            .readEventsPage(fromSequenceExclusive, ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: input.errorMessage,
                    cause,
                  }),
              ),
            );
          const upperBound = Option.isSome(upperBoundBeforeRead)
            ? upperBoundBeforeRead
            : yield* input.captureReplayUpperBound;
          const replayEvents = Option.isSome(upperBound)
            ? page.events.filter((event) => event.sequence <= upperBound.value)
            : page.events;

          if (replayEvents.length === 0) {
            return Stream.empty;
          }

          const nextSequence = replayEvents[replayEvents.length - 1]?.sequence ?? page.nextSequence;
          const reachedUpperBound = Option.isSome(upperBound) && nextSequence >= upperBound.value;
          const reachedReplayEnd = !page.hasMore || page.nextSequence <= fromSequenceExclusive;
          const currentPageStream = Stream.fromIterable(replayEvents);
          return reachedUpperBound || reachedReplayEnd
            ? currentPageStream
            : Stream.concat(currentPageStream, readPage(page.nextSequence));
        }),
      );

    return readPage(input.snapshotSequence);
  };

  const shellEventsFromDomainEvents = <E, R>(
    stream: Stream.Stream<OrchestrationEvent, E, R>,
  ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
    stream.pipe(
      Stream.mapEffect(toShellStreamEvent),
      Stream.flatMap((event) =>
        Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
      ),
    );

  /**
   * Wires one subscription's live feed: coalesces progress-grade frames
   * before enqueue, keeps a byte ledger over queued-but-undrained events, and
   * runs the coalescer's flush tick for the feed's lifetime.
   */
  const runLiveFeed = (input: {
    readonly stream: WsReplayStreamKind;
    readonly liveSubscription: PubSub.Subscription<OrchestrationEvent>;
    readonly liveQueue: Queue.Queue<OrchestrationEvent, OrchestrationGetSnapshotError>;
    readonly overflowedRef: Ref.Ref<boolean>;
    readonly replayMetrics: WsReplayMetrics;
    readonly onEvent: (
      event: OrchestrationEvent,
      push: (event: OrchestrationEvent) => Effect.Effect<void, OrchestrationGetSnapshotError>,
    ) => Effect.Effect<void, OrchestrationGetSnapshotError>;
  }) =>
    Effect.gen(function* () {
      const queuedBytesRef = yield* Ref.make(0);
      const coalescer = yield* makeOrchestrationEventCoalescer({
        offer: (event, eventBytes) =>
          offerOrchestrationLiveEventOrFail({
            stream: input.stream,
            event,
            liveQueue: input.liveQueue,
            overflowedRef: input.overflowedRef,
            replayMetrics: input.replayMetrics,
            queuedBytesRef,
            eventBytes,
          }),
        onCoalesced: (sequence) => input.replayMetrics.recordCoalesced(sequence),
        windowMs: ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS,
      });
      const flushTickFiber = yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS).pipe(
            Effect.andThen(coalescer.flush),
          ),
        ).pipe(Effect.ignoreCause({ log: true })),
      );
      yield* Stream.fromSubscription(input.liveSubscription).pipe(
        Stream.runForEach((event) => input.onEvent(event, coalescer.push)),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Fiber.interrupt(flushTickFiber).pipe(Effect.ignore);
            yield* coalescer.flush.pipe(Effect.ignoreCause({ log: true }));
            yield* Queue.shutdown(input.liveQueue);
          }),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.forkScoped,
      );
      return queuedBytesRef;
    });

  /**
   * Can a client that last applied `fromSequence` catch up from the event log
   * rather than a snapshot — of the shell or of one thread? Only when that sequence names an event this log
   * still holds — a reset or foreign log restarts below it — and no more than one
   * replay page has happened since, beyond which a snapshot is the cheaper send.
   * The log is never pruned today; pruning must keep this answer truthful.
   */
  const canResumeAfter = (fromSequence: number) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(fromSequence) || fromSequence <= 0) return false;
      const anchor = yield* orchestrationEngine.readEventsPage(fromSequence - 1, 1);
      if (anchor.events[0]?.sequence !== fromSequence) return false;
      const missed = yield* orchestrationEngine.readEventsPage(
        fromSequence,
        ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
      );
      return !missed.hasMore;
    }).pipe(Effect.orElseSucceed(() => false));

  const makeReplayableShellStream = (
    snapshot: Effect.Effect<OrchestrationShellSnapshot, OrchestrationGetSnapshotError>,
    options: { readonly resumeFromSequence?: number | undefined } = {},
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const resumeFromSequence = options.resumeFromSequence;
        const resumed =
          resumeFromSequence !== undefined && (yield* canResumeAfter(resumeFromSequence));
        const loadedSnapshot = resumed ? undefined : yield* snapshot;
        const snapshotSequence =
          loadedSnapshot?.snapshotSequence ?? (resumed ? resumeFromSequence : 0);
        const liveSubscription = yield* orchestrationEngine.subscribeDomainEvents;
        const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(
          ORCHESTRATION_LIVE_QUEUE_MAX_EVENTS,
        );
        const lastSequenceRef = yield* Ref.make(snapshotSequence);
        const overflowedRef = yield* Ref.make(false);
        const replayBoundary = yield* makeReplayBoundaryTracker(snapshotSequence);
        const replayMetrics = yield* makeWsReplayMetrics({
          stream: "shell",
          subscriptionId: randomShortId(),
          snapshotSequence,
        });

        const queuedBytesRef = yield* runLiveFeed({
          stream: "shell",
          liveSubscription,
          liveQueue,
          overflowedRef,
          replayMetrics,
          onEvent: (event, push) =>
            Effect.gen(function* () {
              yield* replayBoundary.recordLiveSequence(event.sequence);
              yield* push(event);
            }),
        });

        const replayStream = makeBoundedReplayStream({
          snapshotSequence,
          captureReplayUpperBound: replayBoundary.captureReplayUpperBound,
          errorMessage: "Failed to replay orchestration shell events",
        }).pipe(Stream.tap((event) => replayMetrics.recordReplayEvent(event.sequence)));
        const liveStream = Stream.fromQueue(liveQueue).pipe(
          Stream.tap((event) => releaseQueuedEventBytes(queuedBytesRef, event)),
          Stream.tap((event) => replayMetrics.recordLiveDequeued(event.sequence)),
        );

        const eventStream = Stream.concat(
          shellEventsFromDomainEvents(replayStream),
          shellEventsFromDomainEvents(liveStream),
        ).pipe(dedupeBySequence((event) => event.sequence, lastSequenceRef));
        const prioritySnapshotStream = threadPriorityChanges.pipe(
          Stream.mapEffect(() => snapshot),
          Stream.map((nextSnapshot) => ({
            kind: "snapshot" as const,
            snapshot: nextSnapshot,
          })),
        );

        const head: OrchestrationShellStreamItem =
          loadedSnapshot === undefined
            ? { kind: "resumed", fromSequence: snapshotSequence }
            : { kind: "snapshot", snapshot: loadedSnapshot };
        return Stream.concat(
          Stream.make(head),
          Stream.merge(eventStream, prioritySnapshotStream),
        ).pipe(Stream.ensuring(replayMetrics.reset));
      }),
    );

  const makeReplayableThreadStream = <
    Snapshot extends { readonly snapshotSequence: number },
    SnapshotError,
  >(
    snapshot: Effect.Effect<Snapshot, SnapshotError>,
    threadId: ThreadId,
    options: { readonly resumeFromSequence?: number | undefined } = {},
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const resumeFromSequence = options.resumeFromSequence;
        const resumed =
          resumeFromSequence !== undefined && (yield* canResumeAfter(resumeFromSequence));
        const loadedSnapshot = resumed ? undefined : yield* snapshot;
        const snapshotSequence =
          loadedSnapshot?.snapshotSequence ?? (resumed ? resumeFromSequence : 0);
        const liveSubscription = yield* orchestrationEngine.subscribeDomainEvents;
        const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(
          ORCHESTRATION_LIVE_QUEUE_MAX_EVENTS,
        );
        const lastSequenceRef = yield* Ref.make(snapshotSequence);
        const overflowedRef = yield* Ref.make(false);
        const replayBoundary = yield* makeReplayBoundaryTracker(snapshotSequence);
        const replayMetrics = yield* makeWsReplayMetrics({
          stream: "thread",
          subscriptionId: randomShortId(),
          snapshotSequence,
        });

        const isMatchingThreadEvent = (event: OrchestrationEvent) =>
          event.aggregateKind === "thread" &&
          event.aggregateId === threadId &&
          isThreadDetailEvent(event);

        const threadEvents = <E, R>(stream: Stream.Stream<OrchestrationEvent, E, R>) =>
          stream.pipe(
            Stream.filter(isMatchingThreadEvent),
            Stream.map((event) => ({
              kind: "event" as const,
              event,
            })),
          );

        const queuedBytesRef = yield* runLiveFeed({
          stream: "thread",
          liveSubscription,
          liveQueue,
          overflowedRef,
          replayMetrics,
          onEvent: (event, push) =>
            Effect.gen(function* () {
              yield* replayBoundary.recordLiveSequence(event.sequence);
              if (!isMatchingThreadEvent(event)) {
                return;
              }
              yield* push(event);
            }),
        });

        const replayStream = makeBoundedReplayStream({
          snapshotSequence,
          captureReplayUpperBound: replayBoundary.captureReplayUpperBound,
          errorMessage: "Failed to replay orchestration thread events",
        }).pipe(Stream.tap((event) => replayMetrics.recordReplayEvent(event.sequence)));
        const liveStream = Stream.fromQueue(liveQueue).pipe(
          Stream.tap((event) => releaseQueuedEventBytes(queuedBytesRef, event)),
          Stream.tap((event) => replayMetrics.recordLiveDequeued(event.sequence)),
        );

        const eventStream = Stream.concat(
          threadEvents(replayStream),
          threadEvents(liveStream),
        ).pipe(dedupeBySequence((item) => item.event.sequence, lastSequenceRef));

        const head =
          loadedSnapshot === undefined
            ? { kind: "resumed" as const, fromSequence: snapshotSequence }
            : { kind: "snapshot" as const, snapshot: loadedSnapshot };
        return Stream.concat(Stream.make(head), eventStream).pipe(
          Stream.ensuring(replayMetrics.reset),
        );
      }),
    );

  return {
    enrichOrchestrationEvents,
    makeReplayableShellStream,
    makeReplayableThreadStream,
  };
};
