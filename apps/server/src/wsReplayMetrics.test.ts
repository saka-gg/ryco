import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Metric } from "effect";
import { TestClock } from "effect/testing";

import { makeWsReplayMetrics, RunningMax, WS_REPLAY_METRICS_SETTLE_MS } from "./wsReplayMetrics.ts";

const findGaugeValue = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number | undefined => {
  const snapshot = snapshots.find(
    (item) =>
      item.id === id &&
      Object.entries(attributes).every(([key, value]) => item.attributes?.[key] === value),
  );
  const state = snapshot?.state as
    | { readonly value?: unknown; readonly count?: unknown }
    | undefined;
  if (typeof state?.value === "number") {
    return state.value;
  }
  if (typeof state?.count === "number") {
    return state.count;
  }
  if (typeof state?.count === "bigint") {
    return Number(state.count);
  }
  return undefined;
};

describe("wsReplayMetrics", () => {
  it.effect("records replay depth, live buffer depth, high-water, and lag", () =>
    Effect.gen(function* () {
      const attributes = {
        stream: "shell",
      };
      const metrics = yield* makeWsReplayMetrics({
        stream: "shell",
        subscriptionId: "ws-replay-metrics-unit",
        snapshotSequence: 10,
      });

      yield* metrics.recordLiveEnqueued(12);
      yield* metrics.recordReplayEvent(11);
      yield* metrics.recordLiveDequeued(12);
      yield* metrics.recordLiveOverflow(13, 4);

      const snapshots = yield* Metric.snapshot;
      assert.equal(findGaugeValue(snapshots, "t3_ws_orchestration_replay_depth", attributes), 1);
      assert.equal(
        findGaugeValue(snapshots, "t3_ws_orchestration_live_buffer_depth", attributes),
        4,
      );
      assert.equal(
        findGaugeValue(snapshots, "t3_ws_orchestration_live_buffer_high_water", attributes),
        4,
      );
      assert.equal(
        findGaugeValue(snapshots, "t3_ws_orchestration_live_buffer_overflows_total", attributes),
        1,
      );
      assert.equal(findGaugeValue(snapshots, "t3_ws_orchestration_replay_lag", attributes), 1);

      yield* metrics.reset;
      const resetSnapshots = yield* Metric.snapshot;
      assert.equal(
        findGaugeValue(resetSnapshots, "t3_ws_orchestration_replay_depth", attributes),
        0,
      );
      assert.equal(
        findGaugeValue(resetSnapshots, "t3_ws_orchestration_live_buffer_high_water", attributes),
        0,
      );
    }),
  );

  it.effect("counts coalesced frames and keeps replay lag honest for superseded sequences", () =>
    Effect.gen(function* () {
      const attributes = {
        stream: "thread",
      };
      const metrics = yield* makeWsReplayMetrics({
        stream: "thread",
        subscriptionId: "ws-replay-coalesced-unit",
        snapshotSequence: 10,
      });

      // Live events 11..13 enqueued and drained; 14 and 15 superseded before
      // enqueue (coalesced); 16 enqueued but not yet drained.
      yield* metrics.recordLiveEnqueued(13);
      yield* metrics.recordLiveDequeued(13);
      yield* metrics.recordCoalesced(14);
      yield* metrics.recordCoalesced(15);
      yield* metrics.recordLiveEnqueued(16);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        findGaugeValue(snapshots, "t3_ws_orchestration_coalesced_frames_total", attributes),
        2,
      );
      // Coalescing must not advance the consumer watermark past undrained events.
      assert.equal(findGaugeValue(snapshots, "t3_ws_orchestration_replay_lag", attributes), 3);

      yield* metrics.reset;
    }),
  );

  it.effect("publishes bounded per-stream aggregates across active subscriptions", () =>
    Effect.gen(function* () {
      const first = yield* makeWsReplayMetrics({
        stream: "thread",
        subscriptionId: "ws-replay-aggregate-first",
        snapshotSequence: 10,
      });
      const second = yield* makeWsReplayMetrics({
        stream: "thread",
        subscriptionId: "ws-replay-aggregate-second",
        snapshotSequence: 20,
      });

      yield* first.recordLiveEnqueued(11);
      yield* first.recordLiveEnqueued(12);
      yield* second.recordLiveEnqueued(21);

      const activeSnapshots = yield* Metric.snapshot;
      assert.equal(
        findGaugeValue(activeSnapshots, "t3_ws_orchestration_live_buffer_depth", {
          stream: "thread",
        }),
        3,
      );
      assert.equal(
        activeSnapshots.filter(
          (snapshot) =>
            snapshot.id === "t3_ws_orchestration_live_buffer_depth" &&
            snapshot.attributes?.stream === "thread",
        ).length,
        1,
      );

      yield* first.reset;
      assert.equal(
        findGaugeValue(yield* Metric.snapshot, "t3_ws_orchestration_live_buffer_depth", {
          stream: "thread",
        }),
        1,
      );

      yield* second.reset;
      assert.equal(
        findGaugeValue(yield* Metric.snapshot, "t3_ws_orchestration_live_buffer_depth", {
          stream: "thread",
        }),
        0,
      );
    }),
  );

  it.effect("removes active state when the registration scope is interrupted", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const attributes = { stream: "shell" };
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const metrics = yield* makeWsReplayMetrics({
            stream: "shell",
            subscriptionId: "ws-replay-interrupted-registration",
            snapshotSequence: 0,
          });
          yield* metrics.recordLiveEnqueued(1);
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(ready);
      assert.equal(
        findGaugeValue(yield* Metric.snapshot, "t3_ws_orchestration_live_buffer_depth", attributes),
        1,
      );

      yield* Fiber.interrupt(fiber);
      assert.equal(
        findGaugeValue(yield* Metric.snapshot, "t3_ws_orchestration_live_buffer_depth", attributes),
        0,
      );
    }),
  );
  it.effect("drains a batch of live events with one dequeue record", () =>
    Effect.gen(function* () {
      const attributes = { stream: "thread" };
      const metrics = yield* makeWsReplayMetrics({
        stream: "thread",
        subscriptionId: "ws-replay-batch-dequeue",
        snapshotSequence: 10,
      });

      yield* metrics.recordLiveEnqueued(11);
      yield* metrics.recordLiveEnqueued(12);
      yield* metrics.recordLiveEnqueued(13);
      yield* metrics.recordLiveDequeued(13, 3);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        findGaugeValue(snapshots, "t3_ws_orchestration_live_buffer_depth", attributes),
        0,
      );
      assert.equal(findGaugeValue(snapshots, "t3_ws_orchestration_replay_lag", attributes), 0);
      assert.equal(
        findGaugeValue(snapshots, "t3_ws_orchestration_live_buffer_high_water", attributes),
        3,
      );

      yield* metrics.reset;
    }),
  );

  it("keeps a running maximum that rises exactly and settles downward on rescan", () => {
    const max = new RunningMax();
    max.update(undefined, 3);
    max.update(undefined, 5);
    max.update(undefined, 5);
    assert.equal(max.value, 5);
    max.update(5, 1);
    assert.deepEqual([max.value, max.stale], [5, false]);
    max.update(5, 2);
    // The true maximum (3) is unknown without a rescan; 5 stays as an upper bound.
    assert.deepEqual([max.value, max.stale], [5, true]);
    max.update(2, 7);
    assert.deepEqual([max.value, max.stale], [7, false]);
    max.recompute([3, 1, 2]);
    assert.deepEqual([max.value, max.stale], [3, false]);
  });

  it.effect("settles stale maxima once per window with many subscriptions", () =>
    Effect.gen(function* () {
      const attributes = { stream: "thread" };
      const subscriptions = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          makeWsReplayMetrics({
            stream: "thread",
            subscriptionId: `ws-replay-many-${index}`,
            snapshotSequence: 0,
          }),
      );
      for (const [index, metrics] of subscriptions.entries()) {
        yield* metrics.recordLiveEnqueued(index + 1);
      }
      const lagOf = () =>
        Metric.snapshot.pipe(
          Effect.map((snapshots) =>
            findGaugeValue(snapshots, "t3_ws_orchestration_replay_lag", attributes),
          ),
        );
      const depthOf = () =>
        Metric.snapshot.pipe(
          Effect.map((snapshots) =>
            findGaugeValue(snapshots, "t3_ws_orchestration_live_buffer_depth", attributes),
          ),
        );
      assert.equal(yield* lagOf(), 20);
      assert.equal(yield* depthOf(), 20);
      // The subscription holding the maximum drains: the sum is exact at once,
      // the maximum settles within one window.
      yield* subscriptions[19]!.recordLiveDequeued(20);
      assert.equal(yield* depthOf(), 19);
      assert.equal(yield* lagOf(), 20);
      yield* TestClock.adjust(WS_REPLAY_METRICS_SETTLE_MS);
      assert.equal(yield* lagOf(), 19);
      for (const metrics of subscriptions) yield* metrics.reset;
      assert.equal(yield* lagOf(), 0);
      assert.equal(yield* depthOf(), 0);
    }).pipe(Effect.scoped),
  );
});
