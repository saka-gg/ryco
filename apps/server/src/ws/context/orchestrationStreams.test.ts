import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  OrchestrationGetSnapshotError,
  type OrchestrationEvent,
  type OrchestrationWorktreeShell,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { Cause, Effect, Metric, Option, Queue, Ref } from "effect";

import { makeWsReplayMetrics } from "../../wsReplayMetrics.ts";
import {
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

const makeLargeActivityEvent = (
  sequence: number,
  threadId: ThreadId,
  payloadChars: number,
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
      id: EventId.make(`task-progress:${threadId}:task-${sequence}`),
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
