import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  OrchestrationGetSnapshotError,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type OrchestrationWorktreeShell,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  EventLogCompactionLive,
  ONLINE_COMPACTION_PASS_OPTIONS,
} from "../../persistence/Layers/EventLogCompaction.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { EventLogCompaction } from "../../persistence/Services/EventLogCompaction.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { makeWsReplayMetrics } from "../../wsReplayMetrics.ts";
import { ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS } from "./constants.ts";
import {
  makeOrchestrationStreamHelpers,
  releaseQueuedEventBytes,
  offerOrchestrationLiveEventOrFail,
  offerOrchestrationThreadLiveEventOrFail,
  toShellStreamEvent,
} from "./orchestrationStreams.ts";

const LIVE_OVERFLOWS_METRIC_ID = "t3_ws_orchestration_live_buffer_overflows_total";

const metricNumberValue = (snapshot: Metric.Metric.Snapshot): number => {
  const state = snapshot.state as { readonly value?: unknown; readonly count?: unknown };
  if (typeof state.value === "number") {
    return state.value;
  }
  if (typeof state.count === "number") {
    return state.count;
  }
  if (typeof state.count === "bigint") {
    return Number(state.count);
  }
  return 0;
};

const sumMetricValue = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, id: string): number =>
  snapshots
    .filter((snapshot) => snapshot.id === id)
    .reduce((total, snapshot) => total + metricNumberValue(snapshot), 0);

const makeThreadDeletedEvent = (sequence: number, threadId: ThreadId): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-live-overflow-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-04-05T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.deleted",
  payload: {
    threadId,
    deletedAt: "2026-04-05T00:00:00.000Z",
  },
});

const makeThreadMessageEvent = (sequence: number, threadId: ThreadId): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-live-message-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-04-05T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make(`message-live-${sequence}`),
    role: "assistant",
    text: "hello",
    turnId: null,
    streaming: false,
    createdAt: "2026-04-05T00:00:00.000Z",
    updatedAt: "2026-04-05T00:00:00.000Z",
  },
});

describe("orchestrationStreams", () => {
  it.effect("tracks unrelated events without filling a thread live queue", () =>
    Effect.gen(function* () {
      const selectedThreadId = ThreadId.make("thread-selected");
      const unrelatedThreadId = ThreadId.make("thread-unrelated");
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(1);
      const overflowedRef = yield* Ref.make(false);
      const latestSequenceRef = yield* Ref.make(0);
      const replayMetrics = yield* makeWsReplayMetrics({
        stream: "thread",
        subscriptionId: "orchestration-stream-thread-prefilter-unit",
        snapshotSequence: 0,
      });
      const offer = (event: OrchestrationEvent) =>
        offerOrchestrationThreadLiveEventOrFail({
          threadId: selectedThreadId,
          event,
          recordLiveSequence: (sequence) => Ref.set(latestSequenceRef, sequence),
          liveQueue,
          overflowedRef,
          replayMetrics,
          capacity: 1,
        });

      yield* Effect.all(
        Array.from({ length: 1_000 }, (_, index) =>
          offer(makeThreadDeletedEvent(index + 1, unrelatedThreadId)),
        ),
        { discard: true },
      );
      yield* offer(makeThreadMessageEvent(1_001, selectedThreadId));

      assert.equal(yield* Ref.get(latestSequenceRef), 1_001);
      assert.equal(yield* Queue.size(liveQueue), 1);
      assert.equal(yield* Ref.get(overflowedRef), false);
      assert.equal((yield* Queue.take(liveQueue)).aggregateId, selectedThreadId);

      yield* replayMetrics.reset;
    }),
  );

  it.effect("fails live queues on overflow so subscriptions resync by reconnecting", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-live-overflow");
      const capacity = 1;
      const baselineOverflowCount = sumMetricValue(
        yield* Metric.snapshot,
        LIVE_OVERFLOWS_METRIC_ID,
      );
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(
        capacity,
      );
      const overflowedRef = yield* Ref.make(false);
      const replayMetrics = yield* makeWsReplayMetrics({
        stream: "shell",
        subscriptionId: "orchestration-stream-overflow-unit",
        snapshotSequence: 0,
      });

      yield* offerOrchestrationLiveEventOrFail({
        stream: "shell",
        event: makeThreadDeletedEvent(1, threadId),
        liveQueue,
        overflowedRef,
        replayMetrics,
        capacity,
      });
      yield* offerOrchestrationLiveEventOrFail({
        stream: "shell",
        event: makeThreadDeletedEvent(2, threadId),
        liveQueue,
        overflowedRef,
        replayMetrics,
        capacity,
      });

      const firstTake = yield* Queue.take(liveQueue).pipe(Effect.exit);
      const result =
        firstTake._tag === "Failure" ? firstTake : yield* Queue.take(liveQueue).pipe(Effect.exit);
      const overflowCount = sumMetricValue(yield* Metric.snapshot, LIVE_OVERFLOWS_METRIC_ID);

      assert.equal(yield* Ref.get(overflowedRef), true);
      assert.equal(overflowCount - baselineOverflowCount, 1);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        assert.instanceOf(error, OrchestrationGetSnapshotError);
        assert.include(error.message, "live event queue overflowed");
      }

      yield* replayMetrics.reset;
    }),
  );

  it.effect("fails the live queue when the byte budget trips so clients resync", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-byte-overflow");
      const baselineOverflowCount = sumMetricValue(
        yield* Metric.snapshot,
        LIVE_OVERFLOWS_METRIC_ID,
      );
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(4);
      const overflowedRef = yield* Ref.make(false);
      const queuedBytesRef = yield* Ref.make(0);
      const replayMetrics = yield* makeWsReplayMetrics({
        stream: "thread",
        subscriptionId: "orchestration-stream-byte-overflow-unit",
        snapshotSequence: 0,
      });
      const offer = (event: OrchestrationEvent) =>
        offerOrchestrationLiveEventOrFail({
          stream: "thread",
          event,
          liveQueue,
          overflowedRef,
          replayMetrics,
          queuedBytesRef,
          byteBudget: 512,
        });

      // One frame fits the 512-byte budget; the second trips it.
      yield* offer(makeThreadMessageEvent(1, threadId));
      assert.isAbove(yield* Ref.get(queuedBytesRef), 0);
      yield* offer(makeLargeActivityEvent(2, threadId, 256));

      const takeResult = yield* Queue.take(liveQueue).pipe(Effect.exit);
      const result =
        takeResult._tag === "Failure" ? takeResult : yield* Queue.take(liveQueue).pipe(Effect.exit);
      const overflowCount = sumMetricValue(yield* Metric.snapshot, LIVE_OVERFLOWS_METRIC_ID);

      assert.equal(yield* Ref.get(overflowedRef), true);
      assert.equal(overflowCount - baselineOverflowCount, 1);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        assert.instanceOf(error, OrchestrationGetSnapshotError);
        // The cause names the byte budget so operators can tell it from a
        // pure count overflow.
        assert.include(String(error.cause), "bytes overflow");
      }

      yield* replayMetrics.reset;
    }),
  );

  it.effect("releases queued bytes on drain so a healthy subscriber never trips the budget", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-byte-drain");
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, OrchestrationGetSnapshotError>(8);
      const overflowedRef = yield* Ref.make(false);
      const queuedBytesRef = yield* Ref.make(0);
      const replayMetrics = yield* makeWsReplayMetrics({
        stream: "thread",
        subscriptionId: "orchestration-stream-byte-drain-unit",
        snapshotSequence: 0,
      });
      const offer = (event: OrchestrationEvent) =>
        offerOrchestrationLiveEventOrFail({
          stream: "thread",
          event,
          liveQueue,
          overflowedRef,
          replayMetrics,
          queuedBytesRef,
          byteBudget: 4_096,
        });
      const bigEvent = makeLargeActivityEvent(1, threadId, 300);

      yield* offer(bigEvent);
      const queuedBeforeDrain = yield* Ref.get(queuedBytesRef);
      assert.isAbove(queuedBeforeDrain, 0);

      const drained = yield* Queue.take(liveQueue);
      yield* releaseQueuedEventBytes(queuedBytesRef, drained);
      assert.equal(yield* Ref.get(queuedBytesRef), 0);

      // The ledger is empty again, so further offers fit the same budget.
      yield* offer(bigEvent);
      assert.equal(yield* Ref.get(overflowedRef), false);
      assert.isAbove(yield* Ref.get(queuedBytesRef), 0);

      yield* replayMetrics.reset;
    }),
  );
});

describe("live feed flushing", () => {
  const threadId = ThreadId.make("thread-live-feed");
  const windowMs = ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS;

  /** Records the duration of every sleep scheduled on the test clock. */
  const withRecordedSleeps = <A, E, R>(
    body: (sleeps: ReadonlyArray<number>) => Effect.Effect<A, E, R>,
  ) =>
    TestClock.testClockWith((testClock) => {
      const sleeps: Array<number> = [];
      const recording: TestClock.TestClock = {
        ...testClock,
        sleep: (duration) => {
          sleeps.push(Duration.toMillis(duration));
          return testClock.sleep(duration);
        },
      };
      return body(sleeps).pipe(Effect.provideService(Clock.Clock, recording));
    });

  /** Lets every runnable fiber (and the microtasks behind it) run to quiescence. */
  const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

  /**
   * A thread subscription over an in-memory event feed. `delivered` receives
   * the sequence of each live event the subscriber is sent, in order.
   */
  const startThreadFeed = Effect.gen(function* () {
    const live = yield* PubSub.unbounded<OrchestrationEvent>();
    const helpers = makeOrchestrationStreamHelpers({
      orchestrationEngine: {
        subscribeDomainEvents: PubSub.subscribe(live),
        readEventsPage: (fromSequenceExclusive: number) =>
          Effect.succeed({ events: [], nextSequence: fromSequenceExclusive, hasMore: false }),
      } as unknown as OrchestrationEngineShape,
      projectionSnapshotQuery: {} as unknown as ProjectionSnapshotQueryShape,
      repositoryIdentityResolver: { resolve: () => Effect.succeed(null) },
    });
    const delivered = yield* Queue.unbounded<number | string>();
    yield* helpers
      .makeReplayableThreadStream(Effect.succeed({ snapshotSequence: 10 }), threadId)
      .pipe(
        Stream.runForEach((item) =>
          Queue.offer(delivered, item.kind === "event" ? item.event.sequence : item.kind),
        ),
        Effect.forkChild,
      );
    // The head is sent after the feed is wired to the live events.
    assert.equal(yield* Queue.take(delivered), "snapshot");
    return { live, delivered };
  });

  it.effect("schedules no timer while no frame is held", () =>
    withRecordedSleeps((sleeps) =>
      Effect.gen(function* () {
        const { live, delivered } = yield* startThreadFeed;
        yield* TestClock.adjust("10 seconds");
        yield* settle;
        assert.deepEqual(sleeps, []);

        // A frame that is never held passes straight through and arms nothing.
        yield* PubSub.publish(live, makeThreadMessageEvent(11, threadId));
        assert.equal(yield* Queue.take(delivered), 11);
        yield* TestClock.adjust("10 seconds");
        yield* settle;
        assert.deepEqual(sleeps, []);
        assert.equal(yield* Queue.size(delivered), 0);
      }),
    ),
  );

  it.effect("flushes a held frame once, when its window elapses", () =>
    withRecordedSleeps((sleeps) =>
      Effect.gen(function* () {
        const { live, delivered } = yield* startThreadFeed;
        yield* PubSub.publish(live, makeLargeActivityEvent(11, threadId, 0, "shared"));
        yield* settle;
        assert.deepEqual(sleeps, [windowMs]);

        yield* TestClock.adjust(windowMs - 1);
        yield* settle;
        assert.equal(yield* Queue.size(delivered), 0);
        yield* TestClock.adjust(1);
        assert.equal(yield* Queue.take(delivered), 11);

        // The flush is spent: nothing wakes the feed again until another frame is held.
        yield* TestClock.adjust("10 seconds");
        yield* settle;
        assert.equal(yield* Queue.size(delivered), 0);
        assert.deepEqual(sleeps, [windowMs]);
      }),
    ),
  );

  it.effect("arms a new flush for a frame held after the previous flush fired", () =>
    withRecordedSleeps((sleeps) =>
      Effect.gen(function* () {
        const { live, delivered } = yield* startThreadFeed;
        yield* PubSub.publish(live, makeLargeActivityEvent(11, threadId, 0, "shared"));
        yield* settle;
        yield* TestClock.adjust(windowMs);
        assert.equal(yield* Queue.take(delivered), 11);

        yield* PubSub.publish(live, makeLargeActivityEvent(12, threadId, 0, "shared"));
        yield* settle;
        assert.deepEqual(sleeps, [windowMs, windowMs]);
        yield* TestClock.adjust(windowMs);
        assert.equal(yield* Queue.take(delivered), 12);
      }),
    ),
  );

  it.effect("shares one pending flush across frames and keeps sequence order", () =>
    withRecordedSleeps((sleeps) =>
      Effect.gen(function* () {
        const { live, delivered } = yield* startThreadFeed;
        yield* PubSub.publish(live, makeLargeActivityEvent(11, threadId, 0, "first"));
        yield* PubSub.publish(live, makeLargeActivityEvent(12, threadId, 0, "second"));
        yield* settle;
        assert.deepEqual(sleeps, [windowMs]);
        assert.equal(yield* Queue.size(delivered), 0);

        // A frame that is never held releases the held ones first, without the timer.
        yield* PubSub.publish(live, makeThreadMessageEvent(13, threadId));
        assert.deepEqual(
          [
            yield* Queue.take(delivered),
            yield* Queue.take(delivered),
            yield* Queue.take(delivered),
          ],
          [11, 12, 13],
        );

        // The timer still fires, finds nothing held, and delivers nothing twice.
        yield* TestClock.adjust("10 seconds");
        yield* settle;
        assert.equal(yield* Queue.size(delivered), 0);
        assert.deepEqual(sleeps, [windowMs]);
      }),
    ),
  );
});

const makeLargeActivityEvent = (
  sequence: number,
  threadId: ThreadId,
  payloadChars: number,
  /** Frames sharing an activity key replace one another when coalesced. */
  activityKey: string | number = sequence,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-large-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-04-05T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(`task-progress:${threadId}:task-${activityKey}`),
      tone: "info",
      kind: "task.progress",
      summary: "Reasoning update",
      payload: { detail: "x".repeat(payloadChars) },
      turnId: null,
      createdAt: "2026-04-05T00:00:00.000Z",
    },
  },
});

describe("toShellStreamEvent", () => {
  const worktreeId = WorktreeId.make("worktree-pr");
  const mergedWorktree: OrchestrationWorktreeShell = {
    worktreeId,
    projectId: ProjectId.make("project-1"),
    title: null,
    branch: "feature/pr",
    worktreePath: "/tmp/project/pr",
    origin: "pr",
    prNumber: 12,
    issueNumber: null,
    prTitle: "Feature",
    issueTitle: null,
    prState: "merged",
    prIsDraft: false,
    prTerminalAt: "2026-04-05T00:00:00.000Z",
    issueState: null,
    workItemProvider: null,
    workItemKey: null,
    workItemTitle: null,
    workItemState: null,
    workItemStateName: null,
    workItemUrl: null,
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-05T00:00:01.000Z",
    archivedAt: null,
    manualPosition: 0,
  };
  const makeQuery = (worktree: Option.Option<OrchestrationWorktreeShell>) => ({
    getProjectShellById: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getWorktreeShellById: () => Effect.succeed(worktree),
  });
  const sourceControlEvent: OrchestrationEvent = {
    sequence: 7,
    eventId: EventId.make("event-source-control-7"),
    aggregateKind: "worktree",
    aggregateId: worktreeId,
    occurredAt: "2026-04-05T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "worktree.sourceControlStateUpdated",
    payload: {
      worktreeId,
      prState: "merged",
      prIsDraft: false,
      issueState: null,
      updatedAt: "2026-04-05T00:00:01.000Z",
    },
  };

  it.effect("streams source-control state changes as worktree upserts from the SQL row", () =>
    Effect.gen(function* () {
      const result = yield* toShellStreamEvent(
        makeQuery(Option.some(mergedWorktree)),
        sourceControlEvent,
      );
      assert.deepStrictEqual(
        result,
        Option.some({ kind: "worktree-upserted" as const, sequence: 7, worktree: mergedWorktree }),
      );
      const streamed = Option.getOrThrow(result);
      assert.equal(streamed.kind, "worktree-upserted");
      if (streamed.kind === "worktree-upserted") {
        assert.equal(streamed.worktree.prState, "merged");
        assert.equal(streamed.worktree.prTerminalAt, "2026-04-05T00:00:00.000Z");
      }
    }),
  );

  it.effect("drops the upsert when the worktree row is gone", () =>
    Effect.gen(function* () {
      const result = yield* toShellStreamEvent(makeQuery(Option.none()), sourceControlEvent);
      assert.isTrue(Option.isNone(result));
    }),
  );

  it.effect("streams a new project image as a project upsert from the SQL row", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const project = {
        id: projectId,
        customAvatarContentHash: "hash-2",
      } as unknown as OrchestrationProjectShell;
      const result = yield* toShellStreamEvent(
        {
          ...makeQuery(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.some(project)),
        },
        {
          sequence: 9,
          eventId: EventId.make("event-avatar-9"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-04-05T00:00:03.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.avatar-set",
          payload: { projectId, contentHash: "hash-2", updatedAt: "2026-04-05T00:00:03.000Z" },
        },
      );
      assert.deepStrictEqual(
        result,
        Option.some({ kind: "project-upserted" as const, sequence: 9, project }),
      );
    }),
  );

  it.effect("drops unmapped non-thread events", () =>
    Effect.gen(function* () {
      const result = yield* toShellStreamEvent(makeQuery(Option.some(mergedWorktree)), {
        sequence: 8,
        eventId: EventId.make("event-manual-position-8"),
        aggregateKind: "worktree",
        aggregateId: worktreeId,
        occurredAt: "2026-04-05T00:00:02.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "worktree.manualPositionSet",
        payload: {
          worktreeId,
          position: 3,
          changedAt: "2026-04-05T00:00:02.000Z",
        },
      });
      assert.isTrue(Option.isNone(result));
    }),
  );
});

describe("enrichOrchestrationEvents", () => {
  it.effect("adds the persisted repository identity to project meta updates, without git", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-enriched");
      const repositoryIdentity = {
        canonicalKey: "github.com/ryco/ryco",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:Ryco/ryco.git",
        },
        rootPath: "/repos/ryco",
        remotes: [],
      };
      const helpers = makeOrchestrationStreamHelpers({
        orchestrationEngine: {} as OrchestrationEngineShape,
        projectionSnapshotQuery: {
          getProjectShellById: (id: ProjectId) =>
            Effect.succeed(
              id === projectId
                ? Option.some({ id, repositoryIdentity } as unknown as OrchestrationProjectShell)
                : Option.none(),
            ),
        } as unknown as ProjectionSnapshotQueryShape,
        repositoryIdentityResolver: {
          resolve: () => Effect.die("project meta updates must not probe git"),
        },
      });
      const metaUpdated = (id: ProjectId, sequence: number): OrchestrationEvent => ({
        sequence,
        eventId: EventId.make(`event-meta-${sequence}`),
        aggregateKind: "project",
        aggregateId: id,
        occurredAt: "2026-10-12T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.meta-updated",
        payload: { projectId: id, updatedAt: "2026-10-12T00:00:00.000Z" },
      });

      const [enriched, unknown] = yield* helpers.enrichOrchestrationEvents([
        metaUpdated(projectId, 1),
        metaUpdated(ProjectId.make("project-gone"), 2),
      ]);
      assert.deepEqual(
        enriched?.type === "project.meta-updated" ? enriched.payload.repositoryIdentity : undefined,
        repositoryIdentity,
      );
      // A project that is gone keeps its event unchanged.
      assert.isTrue(
        unknown?.type === "project.meta-updated" && !("repositoryIdentity" in unknown.payload),
      );
    }),
  );

  it.effect("resolves a moved root inline until its identity is persisted again", () =>
    Effect.gen(function* () {
      const movedId = ProjectId.make("project-moved");
      const plainId = ProjectId.make("project-plain");
      const resolvedIdentity = {
        canonicalKey: "github.com/ryco/moved",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:Ryco/moved.git",
        },
        rootPath: "/repos/moved",
        remotes: [],
      };
      const resolved: Array<string> = [];
      const helpers = makeOrchestrationStreamHelpers({
        orchestrationEngine: {} as OrchestrationEngineShape,
        projectionSnapshotQuery: {
          // The move reset the persisted identity; the background sync has not recorded it yet.
          getProjectShellById: (id: ProjectId) =>
            Effect.succeed(
              Option.some({
                id,
                workspaceRoot: id === movedId ? "/repos/moved" : "/repos/plain",
                repositoryIdentity: null,
              } as unknown as OrchestrationProjectShell),
            ),
        } as unknown as ProjectionSnapshotQueryShape,
        repositoryIdentityResolver: {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolved.push(cwd);
              return cwd === "/repos/moved" ? resolvedIdentity : null;
            }),
        },
      });
      const metaUpdated = (
        id: ProjectId,
        sequence: number,
        workspaceRoot?: string,
      ): OrchestrationEvent => ({
        sequence,
        eventId: EventId.make(`event-moved-${sequence}`),
        aggregateKind: "project",
        aggregateId: id,
        occurredAt: "2026-10-12T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.meta-updated",
        payload: {
          projectId: id,
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
          updatedAt: "2026-10-12T00:00:00.000Z",
        },
      });

      const [moved, renamed] = yield* helpers.enrichOrchestrationEvents([
        metaUpdated(movedId, 1, "/repos/moved"),
        metaUpdated(plainId, 2),
      ]);
      assert.deepEqual(
        moved?.type === "project.meta-updated" ? moved.payload.repositoryIdentity : undefined,
        resolvedIdentity,
      );
      // An update that does not move the root never probes, even without a persisted identity.
      assert.isTrue(
        renamed?.type === "project.meta-updated" && renamed.payload.repositoryIdentity === null,
      );
      assert.deepEqual(resolved, ["/repos/moved"]);
    }),
  );
});

describe("resume across a compacted event log", () => {
  it.effect(
    "replays from a cursor whose event was compacted away instead of sending a snapshot",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-20T00:00:00.000Z"));
        const store = yield* OrchestrationEventStore;
        const compaction = yield* EventLogCompaction;
        const threadId = ThreadId.make("thread-compacted-resume");
        const occurredAt = "2026-10-01T00:00:00.000Z";
        const progress = (tick: number) =>
          store.append({
            type: "thread.activity-appended",
            eventId: EventId.make(`event-compacted-resume-progress-${tick}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId,
              activity: {
                id: EventId.make(`task-progress:${threadId}:task-1`),
                tone: "info",
                kind: "task.progress",
                summary: `tick ${tick}`,
                payload: { taskId: "task-1", summary: `tick ${tick}` },
                turnId: null,
                createdAt: occurredAt,
              },
            },
          });
        const message = (index: number) =>
          store.append({
            type: "thread.message-sent",
            eventId: EventId.make(`event-compacted-resume-message-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-compacted-resume-${index}`),
              role: "assistant",
              text: `message ${index}`,
              turnId: null,
              streaming: false,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
          });
        yield* message(0);
        const cursor = (yield* progress(1)).sequence;
        yield* progress(2);
        yield* message(1);
        yield* progress(3);

        const pass = yield* compaction.runPass({
          ...ONLINE_COMPACTION_PASS_OPTIONS,
          interBatchPauseMs: 0,
          idleRatio: 0,
          receipts: null,
        });
        assert.equal(pass.deletedEvents, 2);
        const remaining = yield* store.readStreamEventsPage({
          aggregateKind: "thread",
          streamId: threadId,
          fromSequenceExclusive: cursor,
          limit: 100,
        });
        // The cursor's own event is gone; so is the version after it.
        assert.deepEqual(
          remaining.events.map((event) => event.type),
          ["thread.message-sent", "thread.activity-appended"],
        );

        const live = yield* PubSub.unbounded<OrchestrationEvent>();
        const helpers = makeOrchestrationStreamHelpers({
          orchestrationEngine: {
            readEventsPage: store.readPage,
            subscribeDomainEvents: PubSub.subscribe(live),
          } as unknown as OrchestrationEngineShape,
          projectionSnapshotQuery: {
            getThreadShellById: (id: ThreadId) =>
              Effect.succeed(Option.some({ id } as unknown as OrchestrationThreadShell)),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getWorktreeShellById: () => Effect.succeed(Option.none()),
          } as unknown as ProjectionSnapshotQueryShape,
          repositoryIdentityResolver: { resolve: () => Effect.succeed(null) },
          ...(store.probeResume ? { probeResume: store.probeResume } : {}),
          readStreamEventsPage: store.readStreamEventsPage,
        });
        const items = yield* helpers
          .makeReplayableThreadStream(
            Effect.die("a compacted cursor must still resume, not load a snapshot"),
            threadId,
            { resumeFromSequence: cursor },
          )
          .pipe(
            Stream.take(1 + remaining.events.length),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        assert.deepEqual(items[0], { kind: "resumed", fromSequence: cursor });
        assert.deepEqual(
          items.slice(1).map((item) => ("event" in item ? item.event : null)),
          [...remaining.events],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(EventLogCompactionLive, OrchestrationEventStoreLive).pipe(
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      ),
  );
});
