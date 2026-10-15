import { Array as Arr, Deferred, Effect, Fiber, Option, PubSub, Queue, Ref, Stream } from "effect";
import {
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellSnapshotDelivery,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadPriorityEntry,
  OrchestrationGetSnapshotError,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import type { RepositoryIdentityResolverShape } from "../../project/Services/RepositoryIdentityResolver.ts";
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
  ORCHESTRATION_SHELL_STREAM_CHUNK_MAX_ITEMS,
  ORCHESTRATION_SHELL_THREAD_COALESCE_WINDOW_MS,
  ORCHESTRATION_STREAM_CHUNK_MAX_BYTES,
  ORCHESTRATION_THREAD_RESUME_MAX_SCAN_EVENTS,
} from "./constants.ts";
import { isThreadDetailEvent } from "./orchestrationEvents.ts";
import { randomShortId } from "./branchNaming.ts";
import { readSharedThreadShell } from "./sharedThreadShellReads.ts";
import {
  makeOrchestrationEventCoalescer,
  orchestrationProgressFrameKey,
  orchestrationShellFrameKey,
} from "./orchestrationEventCoalescing.ts";
import { rechunkByBudget, tapArray } from "../streamBatching.ts";
import { orchestrationEventBytes } from "./orchestrationStreamBatching.ts";
import { pageShellSnapshot } from "./shellSnapshotPages.ts";

/**
 * One shared load for the subscribers a thread-priority ranking woke together.
 * It is joinable only until its read begins: every subscriber that joins heard
 * of its ranking before the read, so the shared result includes that ranking.
 * A ranking heard later starts a new load.
 */
interface PriorityLoadFlight<A> {
  reading: boolean;
  readonly result: Deferred.Deferred<A, OrchestrationGetSnapshotError>;
}

// Keyed by the projection query service, which every connection of a server
// shares, so subscribers on different connections join the same load.
const prioritySnapshotFlights = new WeakMap<
  object,
  PriorityLoadFlight<OrchestrationShellSnapshot>
>();
const priorityEntryFlights = new WeakMap<
  object,
  PriorityLoadFlight<ReadonlyArray<OrchestrationThreadPriorityEntry>>
>();

/** Joins the open load in `flights` for `key`, or starts one that later callers can join. */
const joinPriorityLoad = <A>(
  flights: WeakMap<object, PriorityLoadFlight<A>>,
  key: object,
  load: Effect.Effect<A, OrchestrationGetSnapshotError>,
): Effect.Effect<A, OrchestrationGetSnapshotError> =>
  Effect.gen(function* () {
    const flight = flights.get(key);
    if (flight !== undefined && !flight.reading) {
      return yield* Deferred.await(flight.result);
    }
    const next: PriorityLoadFlight<A> = {
      reading: false,
      result: yield* Deferred.make<A, OrchestrationGetSnapshotError>(),
    };
    flights.set(key, next);
    // Detached: a subscriber that disconnects must not strand the others.
    // The yield lets the other subscribers the same ranking woke join first.
    yield* Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.sync(() => {
          next.reading = true;
        }),
      ),
      Effect.andThen(load),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(next.result, exit)),
      Effect.forkDetach,
    );
    return yield* Deferred.await(next.result);
  });

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
      (input.queuedBytesRef === undefined ? 0 : orchestrationEventBytes(input.event));

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
) => releaseQueuedEventsBytes(queuedBytesRef, [event]);

/** Releases one drained batch's bytes from the live queue ledger in one update. */
export const releaseQueuedEventsBytes = (
  queuedBytesRef: Ref.Ref<number>,
  events: ReadonlyArray<OrchestrationEvent>,
) => {
  let released = 0;
  for (const event of events) released += orchestrationEventBytes(event);
  return Ref.update(queuedBytesRef, (bytes) => Math.max(0, bytes - released));
};

const lastSequenceOf = (events: Arr.NonEmptyReadonlyArray<{ readonly sequence: number }>) => {
  let sequence = events[0].sequence;
  for (const event of events) sequence = Math.max(sequence, event.sequence);
  return sequence;
};

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

/**
 * Maps one domain event to the shell stream item it implies. Upserts re-read
 * the projected SQL row, so the row stays the source of truth and a replayed
 * old event sends the current state.
 */
export const toShellStreamEvent = (
  projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getThreadShellById" | "getWorktreeShellById"
  >,
  event: OrchestrationEvent,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
    case "project.avatar-set":
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
    case "thread.trashed":
      return Effect.succeed(
        Option.some({
          kind: "thread-removed" as const,
          sequence: event.sequence,
          threadId: event.payload.threadId,
        }),
      );
    case "worktree.relocated": {
      const query = projectionSnapshotQuery.getWorktreeShellById;
      if (!query) return Effect.succeed(Option.none());
      return query(event.payload.worktreeId).pipe(
        Effect.map((worktree) =>
          Option.map(worktree, (nextWorktree) => ({
            kind: "worktree-relocated" as const,
            sequence: event.sequence,
            worktree: nextWorktree,
            sourcePath: event.payload.sourcePath,
            destinationPath: event.payload.destinationPath,
          })),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
    }
    case "worktree.created":
    case "worktree.archived":
    case "worktree.metaUpdated":
    case "worktree.sourceControlStateUpdated":
    case "worktree.restored":
    case "worktree.checkoutRemoved":
    case "worktree.checkoutRestored": {
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
      // Shared by every shell subscriber mapping this event (see sharedThreadShellReads.ts).
      return readSharedThreadShell(
        projectionSnapshotQuery,
        ThreadId.make(event.aggregateId),
        event.sequence,
      ).pipe(
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

/**
 * Thread events the shell turns into a `thread-upserted` re-read of the row
 * (the default branch of `toShellStreamEvent`).
 */
const isThreadShellUpsertEvent = (event: OrchestrationEvent): boolean =>
  event.aggregateKind === "thread" &&
  event.type !== "thread.deleted" &&
  event.type !== "thread.trashed";

/**
 * Maps one drained batch of domain events to shell stream items, in sequence
 * order. Thread upserts re-read the row, so within a batch only the last
 * upsert-class event per thread is read and sent, at that event's position:
 * the row it reads already reflects every earlier event of the batch, and any
 * later removal of the thread still follows it. Dropped items are `null`.
 */
export const toShellStreamEvents = (
  projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getThreadShellById" | "getWorktreeShellById"
  >,
  events: Arr.NonEmptyReadonlyArray<OrchestrationEvent>,
): Effect.Effect<Arr.NonEmptyReadonlyArray<OrchestrationShellStreamEvent | null>> => {
  const lastUpsertIndexByThread = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (isThreadShellUpsertEvent(event)) lastUpsertIndexByThread.set(event.aggregateId, index);
  }
  const kept =
    lastUpsertIndexByThread.size === 0
      ? events
      : events.filter(
          (event, index) =>
            !isThreadShellUpsertEvent(event) ||
            lastUpsertIndexByThread.get(event.aggregateId) === index,
        );
  // The batch's last event is always kept, so `kept` is never empty.
  return Effect.forEach(kept, (event) =>
    toShellStreamEvent(projectionSnapshotQuery, event).pipe(Effect.map(Option.getOrNull)),
  ) as Effect.Effect<Arr.NonEmptyReadonlyArray<OrchestrationShellStreamEvent | null>>;
};

export const makeOrchestrationStreamHelpers = (deps: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly repositoryIdentityResolver: RepositoryIdentityResolverShape;
  readonly threadPriorityChanges?: Stream.Stream<void>;
  /** Payload-free resume probe; without it resumption reads event pages. */
  readonly probeResume?: OrchestrationEventStoreShape["probeResume"];
  /** One thread's events through the stream index; without it thread replay scans global pages. */
  readonly readStreamEventsPage?: OrchestrationEventStoreShape["readStreamEventsPage"];
}) => {
  const { orchestrationEngine, projectionSnapshotQuery, repositoryIdentityResolver } = deps;
  const threadPriorityChanges = deps.threadPriorityChanges ?? Stream.empty;

  const enrichProjectEvent = (
    event: OrchestrationEvent,
  ): Effect.Effect<OrchestrationEvent, never, never> => {
    switch (event.type) {
      case "project.created":
        // A replayed creation reads the identity the project row persisted; only a project the
        // identity sync has not recorded yet resolves its root (through the cached resolver).
        return Effect.gen(function* () {
          const project = yield* projectionSnapshotQuery.getProjectShellById(
            event.payload.projectId,
          );
          const persisted = Option.isSome(project)
            ? (project.value.repositoryIdentity ?? null)
            : null;
          const repositoryIdentity =
            persisted ?? (yield* repositoryIdentityResolver.resolve(event.payload.workspaceRoot));
          return {
            ...event,
            payload: {
              ...event.payload,
              repositoryIdentity,
            },
          } satisfies OrchestrationEvent;
        }).pipe(Effect.catch(() => Effect.succeed(event)));
      case "project.meta-updated":
        // The persisted identity: no `git` on the event path for ordinary meta updates (titles,
        // scripts, the identity sync's own announcements). A moved root resets it until the sync
        // records and announces the new one, so the move itself resolves the root through the
        // cached resolver, like `project.created`, instead of regrouping the project twice.
        return Effect.gen(function* () {
          const project = yield* projectionSnapshotQuery.getProjectShellById(
            event.payload.projectId,
          );
          if (Option.isNone(project)) {
            return event;
          }
          const persisted = project.value.repositoryIdentity ?? null;
          const repositoryIdentity =
            persisted === null && event.payload.workspaceRoot !== undefined
              ? yield* repositoryIdentityResolver.resolve(project.value.workspaceRoot)
              : persisted;
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

  /**
   * Drops items at or below the last sequence sent. The state lives in the
   * closure: each subscription builds its own pipeline.
   */
  const dedupeBySequence =
    <A>(getSequence: (item: A) => number, initialSequence: number) =>
    <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> => {
      let lastSequence = initialSequence;
      return stream.pipe(
        Stream.filter((item) => {
          const nextSequence = getSequence(item);
          if (nextSequence <= lastSequence) return false;
          lastSequence = nextSequence;
          return true;
        }),
      );
    };

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

  type ReplayPageReader = (
    fromSequenceExclusive: number,
    limit: number,
  ) => Effect.Effect<
    {
      readonly events: ReadonlyArray<OrchestrationEvent>;
      readonly nextSequence: number;
      readonly hasMore: boolean;
    },
    OrchestrationEventStoreError
  >;

  const makeBoundedReplayStream = (input: {
    readonly snapshotSequence: number;
    readonly captureReplayUpperBound: Effect.Effect<Option.Option<number>>;
    readonly errorMessage: string;
    /** Pages to replay; the whole event log by default. */
    readonly readPage?: ReplayPageReader;
  }): Stream.Stream<OrchestrationEvent, OrchestrationGetSnapshotError> => {
    const readReplayPage: ReplayPageReader =
      input.readPage ?? ((from, limit) => orchestrationEngine.readEventsPage(from, limit));
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

          const page = yield* readReplayPage(
            fromSequenceExclusive,
            ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
          ).pipe(
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
      Stream.mapArrayEffect((events) => toShellStreamEvents(projectionSnapshotQuery, events)),
      Stream.filter((event): event is OrchestrationShellStreamEvent => event !== null),
    );

  /**
   * Wires one subscription's live feed: coalesces frames under `coalesceKey`
   * before enqueue, keeps a byte ledger over queued-but-undrained events, and
   * runs the coalescer's flush tick for the feed's lifetime.
   */
  const runLiveFeed = (input: {
    readonly stream: WsReplayStreamKind;
    readonly liveSubscription: PubSub.Subscription<OrchestrationEvent>;
    readonly liveQueue: Queue.Queue<OrchestrationEvent, OrchestrationGetSnapshotError>;
    readonly overflowedRef: Ref.Ref<boolean>;
    readonly replayMetrics: WsReplayMetrics;
    readonly coalesceKey: (event: OrchestrationEvent) => string | null;
    readonly coalesceWindowMs: number;
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
        windowMs: input.coalesceWindowMs,
        keyOf: input.coalesceKey,
      });
      const flushTickFiber = yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(input.coalesceWindowMs).pipe(Effect.andThen(coalescer.flush)),
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
   * Drains the live queue in whole batches: everything queued while the
   * previous chunk awaited its acknowledgement leaves as one chunk, and the
   * byte ledger and metrics are settled once per batch.
   */
  const drainLiveQueue = (input: {
    readonly liveQueue: Queue.Queue<OrchestrationEvent, OrchestrationGetSnapshotError>;
    readonly queuedBytesRef: Ref.Ref<number>;
    readonly replayMetrics: WsReplayMetrics;
  }) =>
    Stream.fromQueue(input.liveQueue).pipe(
      tapArray((events) =>
        releaseQueuedEventsBytes(input.queuedBytesRef, events).pipe(
          Effect.andThen(
            input.replayMetrics.recordLiveDequeued(lastSequenceOf(events), events.length),
          ),
        ),
      ),
    );

  /**
   * Can a client that last applied `fromSequence` catch up from the event log
   * rather than a snapshot — of the shell or of one thread? Only when that
   * sequence names an event this log still holds — a reset or foreign log
   * restarts below it — and no more than one replay page of what the
   * subscription delivers has happened since, beyond which a snapshot is the
   * cheaper send. A thread is judged on its own backlog, so an idle retained
   * thread still resumes while other threads stream. Its replay reads the
   * thread's own stream when the store offers that; otherwise it scans global
   * pages, so that scan is bounded as well. The log is never pruned today;
   * pruning must keep this answer truthful.
   */
  const canResumeAfter = (fromSequence: number, scope?: { readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(fromSequence) || fromSequence <= 0) return false;
      const probeResume = deps.probeResume;
      if (probeResume !== undefined) {
        // A thread replayed through its own stream never touches the rest of
        // the log, so only the anchor matters globally (a limit of zero keeps
        // that count from reading anything past the first row).
        const scansGlobalLog = scope === undefined || deps.readStreamEventsPage === undefined;
        const globalLimit =
          scope === undefined
            ? ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT
            : scansGlobalLog
              ? ORCHESTRATION_THREAD_RESUME_MAX_SCAN_EVENTS
              : 0;
        const probe = yield* probeResume({
          sequence: fromSequence,
          limit: globalLimit,
          ...(scope === undefined
            ? {}
            : {
                stream: {
                  aggregateKind: "thread" as const,
                  streamId: scope.threadId,
                  limit: ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
                },
              }),
        });
        if (!probe.anchored || (scansGlobalLog && probe.eventsAfter > globalLimit)) return false;
        return (
          scope === undefined ||
          (probe.streamEventsAfter !== null &&
            probe.streamEventsAfter <= ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT)
        );
      }
      const anchor = yield* orchestrationEngine.readEventsPage(fromSequence - 1, 1);
      if (anchor.events[0]?.sequence !== fromSequence) return false;
      const missed = yield* orchestrationEngine.readEventsPage(
        fromSequence,
        ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
      );
      return !missed.hasMore;
    }).pipe(Effect.orElseSucceed(() => false));

  /** Every thread's current ranking, when the projection can list them on their own. */
  const loadThreadPriorityEntries =
    projectionSnapshotQuery.listThreadPriorities === undefined
      ? undefined
      : projectionSnapshotQuery.listThreadPriorities().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load thread priorities",
                cause,
              }),
          ),
        );

  /** A shell snapshot as the subscriber asked to receive it: one item, or pages. */
  const shellSnapshotItems = (
    snapshot: OrchestrationShellSnapshot,
    snapshotDelivery: OrchestrationShellSnapshotDelivery | undefined,
  ): Stream.Stream<OrchestrationShellStreamItem> =>
    snapshotDelivery === "paged"
      ? Stream.fromArrays(...pageShellSnapshot(snapshot))
      : Stream.make({ kind: "snapshot" as const, snapshot });

  /**
   * The shell items a thread-priority ranking sends a subscriber. A client
   * that takes deltas gets the rankings alone (dozens of rows); any other
   * client gets a full snapshot, which every client understands. Every shell
   * subscriber hears a ranking at the same moment, so they join one load.
   */
  const priorityStream = (
    snapshot: Effect.Effect<OrchestrationShellSnapshot, OrchestrationGetSnapshotError>,
    threadPriorities: "delta" | undefined,
    snapshotDelivery: OrchestrationShellSnapshotDelivery | undefined,
  ): Stream.Stream<OrchestrationShellStreamItem, OrchestrationGetSnapshotError> => {
    const loadPriorities = loadThreadPriorityEntries;
    if (threadPriorities === "delta" && loadPriorities !== undefined) {
      return threadPriorityChanges.pipe(
        Stream.mapEffect(() =>
          joinPriorityLoad(priorityEntryFlights, projectionSnapshotQuery, loadPriorities),
        ),
        Stream.map((priorities) => ({ kind: "thread-priorities" as const, priorities })),
      );
    }
    return threadPriorityChanges.pipe(
      Stream.mapEffect(() =>
        joinPriorityLoad(prioritySnapshotFlights, projectionSnapshotQuery, snapshot),
      ),
      Stream.flatMap((nextSnapshot) => shellSnapshotItems(nextSnapshot, snapshotDelivery)),
    );
  };

  /**
   * A resumed client keeps the shell it had, and a ranking made while it was
   * away is no event it replays: a client that takes deltas gets the current
   * rankings right after the resume marker. A failed read only skips it.
   */
  const resumedPriorityItems = (
    threadPriorities: "delta" | undefined,
  ): Stream.Stream<OrchestrationShellStreamItem> => {
    const loadPriorities = loadThreadPriorityEntries;
    if (threadPriorities !== "delta" || loadPriorities === undefined) return Stream.empty;
    return Stream.unwrap(
      loadPriorities.pipe(
        Effect.map((priorities): Stream.Stream<OrchestrationShellStreamItem> =>
          Stream.make({ kind: "thread-priorities" as const, priorities }),
        ),
        Effect.catch(() => Effect.succeed(Stream.empty)),
      ),
    );
  };

  const makeReplayableShellStream = (
    snapshot: Effect.Effect<OrchestrationShellSnapshot, OrchestrationGetSnapshotError>,
    options: {
      readonly resumeFromSequence?: number | undefined;
      readonly threadPriorities?: "delta" | undefined;
      readonly snapshotDelivery?: OrchestrationShellSnapshotDelivery | undefined;
    } = {},
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
          coalesceKey: orchestrationShellFrameKey,
          coalesceWindowMs: ORCHESTRATION_SHELL_THREAD_COALESCE_WINDOW_MS,
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
        }).pipe(tapArray((events) => replayMetrics.recordReplayEvent(lastSequenceOf(events))));
        const liveStream = drainLiveQueue({ liveQueue, queuedBytesRef, replayMetrics });

        const eventStream = Stream.concat(
          shellEventsFromDomainEvents(replayStream),
          shellEventsFromDomainEvents(liveStream),
        ).pipe(
          dedupeBySequence((event) => event.sequence, snapshotSequence),
          rechunkByBudget({ maxItems: ORCHESTRATION_SHELL_STREAM_CHUNK_MAX_ITEMS }),
        );
        const priorityItems = priorityStream(
          snapshot,
          options.threadPriorities,
          options.snapshotDelivery,
        );

        const resumedItem: OrchestrationShellStreamItem = {
          kind: "resumed",
          fromSequence: snapshotSequence,
        };
        const headItems =
          loadedSnapshot === undefined
            ? Stream.concat(
                Stream.make(resumedItem),
                resumedPriorityItems(options.threadPriorities),
              )
            : shellSnapshotItems(loadedSnapshot, options.snapshotDelivery);
        return Stream.concat(headItems, Stream.merge(eventStream, priorityItems)).pipe(
          Stream.ensuring(replayMetrics.reset),
        );
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
          resumeFromSequence !== undefined &&
          (yield* canResumeAfter(resumeFromSequence, { threadId }));
        const loadedSnapshot = resumed ? undefined : yield* snapshot;
        const snapshotSequence =
          loadedSnapshot?.snapshotSequence ?? (resumed ? resumeFromSequence : 0);
        const liveSubscription = yield* orchestrationEngine.subscribeDomainEvents;
        const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(
          ORCHESTRATION_LIVE_QUEUE_MAX_EVENTS,
        );
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
          coalesceKey: orchestrationProgressFrameKey,
          coalesceWindowMs: ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS,
          onEvent: (event, push) =>
            Effect.gen(function* () {
              yield* replayBoundary.recordLiveSequence(event.sequence);
              if (!isMatchingThreadEvent(event)) {
                return;
              }
              yield* push(event);
            }),
        });

        const readStreamEventsPage = deps.readStreamEventsPage;
        const replayStream = makeBoundedReplayStream({
          snapshotSequence,
          captureReplayUpperBound: replayBoundary.captureReplayUpperBound,
          errorMessage: "Failed to replay orchestration thread events",
          ...(readStreamEventsPage === undefined
            ? {}
            : {
                readPage: (fromSequenceExclusive: number, limit: number) =>
                  readStreamEventsPage({
                    aggregateKind: "thread",
                    streamId: threadId,
                    fromSequenceExclusive,
                    limit,
                  }),
              }),
        }).pipe(tapArray((events) => replayMetrics.recordReplayEvent(lastSequenceOf(events))));
        const liveStream = drainLiveQueue({ liveQueue, queuedBytesRef, replayMetrics });

        const eventStream = Stream.concat(
          threadEvents(replayStream),
          threadEvents(liveStream),
        ).pipe(
          dedupeBySequence((item) => item.event.sequence, snapshotSequence),
          rechunkByBudget({
            maxItems: ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
            maxBytes: ORCHESTRATION_STREAM_CHUNK_MAX_BYTES,
            sizeOf: (item) => orchestrationEventBytes(item.event),
          }),
        );

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
