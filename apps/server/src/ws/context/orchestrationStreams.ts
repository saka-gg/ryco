import { Array as Arr, Effect, Fiber, Option, Queue, Ref, type Scope, Stream } from "effect";
import {
  type OrchestrationActivityPayloadMode,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellSnapshotDelivery,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationStubbedShellSnapshot,
  OrchestrationGetSnapshotError,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  type ProjectionSnapshotQueryShape,
  readSharedThreadShell,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type {
  OrchestrationEventHeader,
  OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
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
import {
  type ThreadEventRegistration,
  registerThreadEventSubscriber,
} from "./threadEventRouter.ts";
import { previewActivityAppendedEvent } from "../../orchestration/activityPayloadPreview.ts";
import { randomShortId } from "./branchNaming.ts";
import {
  makeOrchestrationEventCoalescer,
  orchestrationProgressFrameKey,
  orchestrationShellFrameKey,
} from "./orchestrationEventCoalescing.ts";
import { makeCachedJsonBytes, rechunkByBudget, tapArray } from "../streamBatching.ts";
import { dedupeBySequence } from "../../orchestration/sequenceOrderedStream.ts";
import { orchestrationEventBytes } from "./orchestrationStreamBatching.ts";
import { pageShellSnapshot } from "./shellSnapshotPages.ts";
import { makeShellThreadResendFilter } from "./shellThreadResendFilter.ts";

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

/**
 * The slim wire form of a thread event (`OrchestrationSlimThreadEvent`):
 * only what the client applies. Memoized per event object, so every
 * subscriber that asked for slim events shares one copy and one measurement.
 */
const slimThreadEvents = new WeakMap<OrchestrationEvent, SlimThreadEvent>();
export type SlimThreadEvent = OrchestrationEvent extends infer E
  ? E extends OrchestrationEvent
    ? Pick<E, "sequence" | "occurredAt" | "type" | "payload">
    : never
  : never;
export const toSlimThreadEvent = (event: OrchestrationEvent): SlimThreadEvent => {
  let slim = slimThreadEvents.get(event);
  if (slim === undefined) {
    slim = {
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      type: event.type,
      payload: event.payload,
    } as SlimThreadEvent;
    slimThreadEvents.set(event, slim);
  }
  return slim;
};
const slimThreadEventBytes = makeCachedJsonBytes<SlimThreadEvent>();
type ThreadEventItem =
  | { readonly kind: "event"; readonly event: OrchestrationEvent }
  | { readonly kind: "slim-event"; readonly event: SlimThreadEvent };

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
 * What the shell maps: a live domain event, or a replayed event without its payload (a resume
 * re-reads every row an event names, so it never needs the rest).
 */
export type ShellSourceEvent = OrchestrationEvent | OrchestrationEventHeader;

/**
 * Maps one domain event to the shell stream item it implies. Upserts re-read
 * the projected SQL row, so the row stays the source of truth and a replayed
 * old event sends the current state.
 */
export const toShellStreamEvent = (
  projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getThreadShellById" | "getSharedThreadShell" | "getWorktreeShellById"
  >,
  event: ShellSourceEvent,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
    case "project.avatar-set":
      return projectionSnapshotQuery
        .getProjectShellById(ProjectId.make(event.payload.projectId ?? event.aggregateId))
        .pipe(
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
          projectId: ProjectId.make(event.payload.projectId ?? event.aggregateId),
        }),
      );
    case "thread.deleted":
    case "thread.trashed":
      return Effect.succeed(
        Option.some({
          kind: "thread-removed" as const,
          sequence: event.sequence,
          threadId: ThreadId.make(event.payload.threadId ?? event.aggregateId),
        }),
      );
    case "worktree.relocated": {
      const query = projectionSnapshotQuery.getWorktreeShellById;
      const { sourcePath, destinationPath } = event.payload;
      if (!query || !sourcePath || !destinationPath) return Effect.succeed(Option.none());
      return query(WorktreeId.make(event.payload.worktreeId ?? event.aggregateId)).pipe(
        Effect.map((worktree) =>
          Option.map(worktree, (nextWorktree) => ({
            kind: "worktree-relocated" as const,
            sequence: event.sequence,
            worktree: nextWorktree,
            sourcePath,
            destinationPath,
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
      return getWorktreeShellById(
        WorktreeId.make(event.payload.worktreeId ?? event.aggregateId),
      ).pipe(
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
          worktreeId: WorktreeId.make(event.payload.worktreeId ?? event.aggregateId),
        }),
      );
    default:
      if (event.aggregateKind !== "thread") {
        return Effect.succeed(Option.none());
      }
      // One read of the node's shared thread list serves every subscriber of this change.
      return readSharedThreadShell(projectionSnapshotQuery, ThreadId.make(event.aggregateId)).pipe(
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
 * A snapshot as one `snapshot` item: archived threads as full shells. A
 * stubbed snapshot never takes this path (stubs travel paged only), so its
 * stubs are never silently dropped; this only strips the empty field.
 */
const withoutArchivedStubs = (
  snapshot: OrchestrationStubbedShellSnapshot,
): OrchestrationShellSnapshot => {
  if (snapshot.archivedThreadStubs === undefined) return snapshot;
  if (snapshot.archivedThreadStubs.length > 0) {
    throw new Error("A shell snapshot with archived stubs can only be sent paged");
  }
  const { archivedThreadStubs: _stubs, ...full } = snapshot;
  return full;
};

/**
 * Thread events the shell turns into a `thread-upserted` re-read of the row
 * (the default branch of `toShellStreamEvent`).
 */
const isThreadShellUpsertEvent = (event: ShellSourceEvent): boolean =>
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
    "getProjectShellById" | "getThreadShellById" | "getSharedThreadShell" | "getWorktreeShellById"
  >,
  events: Arr.NonEmptyReadonlyArray<ShellSourceEvent>,
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

/** A changed-since resume may send up to this share of the live threads (see `shellChangesSince`). */
export const SHELL_CHANGES_MAX_LIVE_THREAD_SHARE = 0.5;
/** ...and always this many. */
export const SHELL_CHANGES_MIN_THREADS = 64;

export const makeOrchestrationStreamHelpers = (deps: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly repositoryIdentityResolver: RepositoryIdentityResolverShape;
  /** Payload-free resume probe; without it resumption reads event pages. */
  readonly probeResume?: OrchestrationEventStoreShape["probeResume"];
  /** One thread's events through the stream index; without it thread replay scans global pages. */
  readonly readStreamEventsPage?: OrchestrationEventStoreShape["readStreamEventsPage"];
  /** Retention's replay floors; without it a resumed replay is never re-checked. */
  readonly readReplayFloor?: OrchestrationEventStoreShape["readReplayFloor"];
  /** Payload-free event pages; without it the shell's resume replay decodes whole events. */
  readonly readEventHeadersPage?: OrchestrationEventStoreShape["readEventHeadersPage"];
}) => {
  const { orchestrationEngine, projectionSnapshotQuery, repositoryIdentityResolver } = deps;

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

  type ReplayPageReader<Event = OrchestrationEvent> = (
    fromSequenceExclusive: number,
    limit: number,
  ) => Effect.Effect<
    {
      readonly events: ReadonlyArray<Event>;
      readonly nextSequence: number;
      readonly hasMore: boolean;
    },
    OrchestrationEventStoreError
  >;

  const makeBoundedReplayStream = <
    Event extends { readonly sequence: number } = OrchestrationEvent,
  >(input: {
    readonly snapshotSequence: number;
    readonly captureReplayUpperBound: Effect.Effect<Option.Option<number>>;
    readonly errorMessage: string;
    /** Pages to replay; the whole event log by default. */
    readonly readPage?: ReplayPageReader<Event>;
    /**
     * A resumed replay's floor: checked after each page is read and before it is sent. Retention
     * raises a floor in the transaction that removes events below it, so a floor still at or
     * below the resume point after a read means that page has no gap.
     */
    readonly replayFloor?: Effect.Effect<number, OrchestrationEventStoreError>;
  }): Stream.Stream<Event, OrchestrationGetSnapshotError> => {
    const readReplayPage: ReplayPageReader<Event> =
      input.readPage ??
      (((from: number, limit: number) =>
        orchestrationEngine.readEventsPage(from, limit)) as unknown as ReplayPageReader<Event>);
    const readPage = (
      fromSequenceExclusive: number,
    ): Stream.Stream<Event, OrchestrationGetSnapshotError> =>
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
          if (input.replayFloor !== undefined) {
            const floor = yield* input.replayFloor.pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({ message: input.errorMessage, cause }),
              ),
            );
            if (floor > input.snapshotSequence) {
              return yield* new OrchestrationGetSnapshotError({
                message: `${input.errorMessage}: events after the resume point were removed`,
              });
            }
          }
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
    stream: Stream.Stream<ShellSourceEvent, E, R>,
  ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
    stream.pipe(
      Stream.mapArrayEffect((events) => toShellStreamEvents(projectionSnapshotQuery, events)),
      Stream.filter((event): event is OrchestrationShellStreamEvent => event !== null),
    );

  /**
   * Wires one subscription's live feed: coalesces frames under `coalesceKey`
   * before enqueue, keeps a byte ledger over queued-but-undrained events, and
   * flushes held frames once their window elapses. The flush is a one-shot
   * timer armed when a frame is held, so a feed with nothing held (an idle
   * subscription) schedules no wakeups at all.
   */
  const runLiveFeed = (input: {
    readonly stream: WsReplayStreamKind;
    /**
     * Where live events come from: a stream the feed runs on its own fiber, or
     * a router the feed registers with (`registerThreadEventSubscriber`), whose
     * fiber calls `handle` for each event and `end` when its stream ended.
     */
    readonly liveEvents:
      | Stream.Stream<OrchestrationEvent>
      | ((
          handle: (event: OrchestrationEvent) => Effect.Effect<void, OrchestrationGetSnapshotError>,
          end: Effect.Effect<void>,
        ) => Effect.Effect<void, never, Scope.Scope>);
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

      // At most one flush is pending, armed by the frame the coalescer starts
      // holding and cleared as it fires (before the flush, so a frame held
      // while it runs arms the next). Nothing is armed while nothing is held.
      const scope = yield* Effect.scope;
      let flushArmed = false;
      let flushFiber: Fiber.Fiber<void> | undefined;
      const armFlush = Effect.suspend(() => {
        if (flushArmed || input.coalesceWindowMs <= 0) return Effect.void;
        flushArmed = true;
        const flushHeldFrames = Effect.sleep(input.coalesceWindowMs).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              flushArmed = false;
              return coalescer.flush;
            }),
          ),
          Effect.ignoreCause({ log: true }),
        );
        return Effect.forkIn(flushHeldFrames, scope).pipe(
          Effect.map((fiber) => {
            flushFiber = fiber;
          }),
        );
      });
      const push = (event: OrchestrationEvent) =>
        coalescer
          .push(event)
          .pipe(Effect.andThen(input.coalesceKey(event) === null ? Effect.void : armFlush));

      const endFeed = Effect.gen(function* () {
        if (flushFiber !== undefined) {
          yield* Fiber.interrupt(flushFiber).pipe(Effect.ignore);
        }
        yield* coalescer.flush.pipe(Effect.ignoreCause({ log: true }));
        yield* Queue.shutdown(input.liveQueue);
      });
      const handle = (event: OrchestrationEvent) => input.onEvent(event, push);
      if (typeof input.liveEvents === "function") {
        yield* Effect.addFinalizer(() => endFeed);
        yield* input.liveEvents(handle, endFeed);
      } else {
        yield* input.liveEvents.pipe(
          Stream.runForEach(handle),
          Effect.ensuring(endFeed),
          Effect.ignoreCause({ log: true }),
          Effect.forkScoped,
        );
      }
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
   * sequence lies within this log — a reset or foreign log restarts below it —
   * and no more than one replay page of what the subscription delivers has
   * happened since, beyond which a snapshot is the cheaper send. A thread is
   * judged on its own backlog, so an idle retained thread still resumes while
   * other threads stream. Its replay reads the thread's own stream when the
   * store offers that; otherwise it scans global pages, so that scan is bounded
   * as well. Compaction removes superseded progress events older than a day,
   * leaving holes; the store's probe anchors on the log's range because replay
   * from a hole reaches the same state (`EventLogCompaction`). The fallback
   * below, for stores without a probe, still requires the exact event: a hole
   * there costs a snapshot, never a wrong resume.
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

  /**
   * The shell's changes since `fromSequence` from the shared thread list's change index, when
   * it reaches back that far and the changed threads are at most
   * {@link SHELL_CHANGES_MAX_LIVE_THREAD_SHARE} of the live ones (more, and a snapshot costs
   * about the same in one paged send).
   */
  const shellChangesSince = (fromSequence: number) =>
    Effect.gen(function* () {
      const read = projectionSnapshotQuery.getShellChangesSince;
      if (read === undefined || !Number.isSafeInteger(fromSequence) || fromSequence <= 0) {
        return undefined;
      }
      // The position must be one of this log's (a reset or foreign log is not): the same
      // anchor the event-log resume checks, without counting anything after it.
      const probeResume = deps.probeResume;
      if (probeResume !== undefined) {
        const probe = yield* probeResume({ sequence: fromSequence, limit: 0 });
        if (!probe.anchored) return undefined;
      }
      const changes = yield* read(fromSequence);
      if (Option.isNone(changes)) return undefined;
      const limit = Math.max(
        SHELL_CHANGES_MIN_THREADS,
        changes.value.liveThreadCount * SHELL_CHANGES_MAX_LIVE_THREAD_SHARE,
      );
      return changes.value.threadCount <= limit ? changes.value : undefined;
      // Any failure, defects included, falls back to the event log or a snapshot.
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

  /**
   * A shell snapshot as the subscriber asked to receive it: one item, or pages.
   * Archived stubs only ever reach a paged subscriber (see `makeReplayableShellStream`).
   */
  const shellSnapshotItems = (
    snapshot: OrchestrationStubbedShellSnapshot,
    snapshotDelivery: OrchestrationShellSnapshotDelivery | undefined,
  ): Stream.Stream<OrchestrationShellStreamItem> =>
    snapshotDelivery === "paged"
      ? Stream.fromArrays(...pageShellSnapshot(snapshot))
      : Stream.make({ kind: "snapshot" as const, snapshot: withoutArchivedStubs(snapshot) });

  const makeReplayableShellStream = (
    fullSnapshot: Effect.Effect<OrchestrationShellSnapshot, OrchestrationGetSnapshotError>,
    options: {
      readonly resumeFromSequence?: number | undefined;
      readonly snapshotDelivery?: OrchestrationShellSnapshotDelivery | undefined;
      /**
       * The snapshot with archived stubs, for a subscriber that asked for
       * `archivedThreads: "stub"`. Used only with paged delivery: a single
       * `snapshot` item always lists archived threads as full shells.
       */
      readonly stubbedSnapshot?:
        | Effect.Effect<OrchestrationStubbedShellSnapshot, OrchestrationGetSnapshotError>
        | undefined;
    } = {},
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const snapshot: Effect.Effect<
          OrchestrationStubbedShellSnapshot,
          OrchestrationGetSnapshotError
        > =
          options.stubbedSnapshot !== undefined && options.snapshotDelivery === "paged"
            ? options.stubbedSnapshot
            : fullSnapshot;
        const resumeFromSequence = options.resumeFromSequence;
        // The rows changed since the client's position, however many events ago, when the
        // shared thread list's change index reaches back that far and they are fewer than a
        // snapshot would send; else the event log, within one page; else a snapshot.
        const changes =
          resumeFromSequence === undefined
            ? undefined
            : yield* shellChangesSince(resumeFromSequence);
        const resumed =
          resumeFromSequence !== undefined &&
          (changes !== undefined || (yield* canResumeAfter(resumeFromSequence)));
        const loadedSnapshot = resumed ? undefined : yield* snapshot;
        const snapshotSequence =
          loadedSnapshot?.snapshotSequence ??
          changes?.snapshotSequence ??
          (resumed ? resumeFromSequence : 0);
        const liveEvents = yield* orchestrationEngine.subscribeDomainEvents;
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
          liveEvents,
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

        const replayStream = makeBoundedReplayStream<ShellSourceEvent>({
          snapshotSequence,
          captureReplayUpperBound: replayBoundary.captureReplayUpperBound,
          errorMessage: "Failed to replay orchestration shell events",
          // Every replayed event re-reads the rows it names: its payload is never needed.
          ...(deps.readEventHeadersPage === undefined
            ? {}
            : { readPage: deps.readEventHeadersPage }),
          ...(resumed && deps.readReplayFloor !== undefined
            ? { replayFloor: deps.readReplayFloor({ aggregateKind: "log", streamId: "" }) }
            : {}),
        }).pipe(tapArray((events) => replayMetrics.recordReplayEvent(lastSequenceOf(events))));
        const liveStream = drainLiveQueue({ liveQueue, queuedBytesRef, replayMetrics });

        // Rows this client already has, or that only moved `updatedAt`, are not sent again.
        const keepRow = makeShellThreadResendFilter();
        const eventStream = Stream.concat(
          shellEventsFromDomainEvents(replayStream),
          shellEventsFromDomainEvents(liveStream),
        ).pipe(
          dedupeBySequence((event) => event.sequence, snapshotSequence),
          Stream.filter(keepRow),
          rechunkByBudget({ maxItems: ORCHESTRATION_SHELL_STREAM_CHUNK_MAX_ITEMS }),
        );
        const resumedItem: OrchestrationShellStreamItem = {
          kind: "resumed",
          fromSequence: changes === undefined ? snapshotSequence : resumeFromSequence!,
        };
        const headItems =
          loadedSnapshot !== undefined
            ? shellSnapshotItems(loadedSnapshot, options.snapshotDelivery)
            : changes === undefined
              ? Stream.make(resumedItem)
              : Stream.concat(
                  Stream.make(resumedItem),
                  Stream.fromIterable(changes.items.filter(keepRow)).pipe(
                    rechunkByBudget({ maxItems: ORCHESTRATION_SHELL_STREAM_CHUNK_MAX_ITEMS }),
                  ),
                );
        return Stream.concat(headItems, eventStream).pipe(Stream.ensuring(replayMetrics.reset));
      }),
    );

  const makeReplayableThreadStream = <
    Snapshot extends { readonly snapshotSequence: number },
    SnapshotError,
  >(
    snapshot: Effect.Effect<Snapshot, SnapshotError>,
    threadId: ThreadId,
    options: {
      readonly resumeFromSequence?: number | undefined;
      /** `"preview"`: live and replayed activity payloads are bounded like a window's. */
      readonly liveActivityPayloads?: OrchestrationActivityPayloadMode | undefined;
      /** `"slim"`: events go out as `slim-event` items (`OrchestrationSlimThreadEvent`). */
      readonly liveEventForm?: "full" | "slim" | undefined;
    } = {},
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
        const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(
          ORCHESTRATION_LIVE_QUEUE_MAX_EVENTS,
        );
        const overflowedRef = yield* Ref.make(false);
        // Bounds the replay by what the shared router has routed (see threadEventRouter.ts).
        // Captured once the router routed past the snapshot, then fixed (as in
        // `makeReplayBoundaryTracker`).
        let registration: ThreadEventRegistration | undefined;
        let replayUpperBound: number | undefined;
        const captureReplayUpperBound = Effect.sync((): Option.Option<number> => {
          if (replayUpperBound !== undefined) return Option.some(replayUpperBound);
          const routed = registration?.routedThrough() ?? 0;
          if (routed <= snapshotSequence) return Option.none();
          replayUpperBound = routed;
          return Option.some(routed);
        });
        const replayMetrics = yield* makeWsReplayMetrics({
          stream: "thread",
          subscriptionId: randomShortId(),
          snapshotSequence,
        });

        const isMatchingThreadEvent = (event: OrchestrationEvent) =>
          event.aggregateKind === "thread" &&
          event.aggregateId === threadId &&
          isThreadDetailEvent(event);

        const previewActivities = options.liveActivityPayloads === "preview";
        const slimEvents = options.liveEventForm === "slim";
        const threadEvents = <E, R>(stream: Stream.Stream<OrchestrationEvent, E, R>) =>
          stream.pipe(
            Stream.filter(isMatchingThreadEvent),
            Stream.map((event): ThreadEventItem => {
              const sent = previewActivities ? previewActivityAppendedEvent(event) : event;
              return slimEvents
                ? { kind: "slim-event", event: toSlimThreadEvent(sent) }
                : { kind: "event", event: sent };
            }),
          );

        const queuedBytesRef = yield* runLiveFeed({
          stream: "thread",
          liveEvents: (handle, end) =>
            registerThreadEventSubscriber(orchestrationEngine, threadId, {
              onEvent: handle,
              onEnd: end,
            }).pipe(
              Effect.map((registered) => {
                registration = registered;
              }),
            ),
          liveQueue,
          overflowedRef,
          replayMetrics,
          coalesceKey: orchestrationProgressFrameKey,
          coalesceWindowMs: ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS,
          // The router hands over only this thread's detail events.
          onEvent: (event, push) => push(event),
        });

        const readStreamEventsPage = deps.readStreamEventsPage;
        const replayStream = makeBoundedReplayStream({
          snapshotSequence,
          captureReplayUpperBound,
          errorMessage: "Failed to replay orchestration thread events",
          ...(resumed && deps.readReplayFloor !== undefined
            ? {
                replayFloor: deps.readReplayFloor({ aggregateKind: "thread", streamId: threadId }),
              }
            : {}),
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
            sizeOf: (item) =>
              item.kind === "event"
                ? orchestrationEventBytes(item.event)
                : slimThreadEventBytes(item.event),
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
