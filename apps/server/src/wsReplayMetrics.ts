import { Effect, Metric, Scope } from "effect";

import { metricAttributes } from "./observability/Metrics.ts";

export type WsReplayStreamKind = "shell" | "thread";

export const wsReplayMetricNames = {
  replayDepth: "t3_ws_orchestration_replay_depth",
  liveBufferDepth: "t3_ws_orchestration_live_buffer_depth",
  liveBufferHighWater: "t3_ws_orchestration_live_buffer_high_water",
  liveBufferOverflowsTotal: "t3_ws_orchestration_live_buffer_overflows_total",
  replayLag: "t3_ws_orchestration_replay_lag",
  coalescedFramesTotal: "t3_ws_orchestration_coalesced_frames_total",
} as const;

export const wsOrchestrationReplayDepth = Metric.gauge(wsReplayMetricNames.replayDepth, {
  description:
    "Current persisted orchestration event replay depth for a replayable WebSocket subscription.",
});

export const wsOrchestrationLiveBufferDepth = Metric.gauge(wsReplayMetricNames.liveBufferDepth, {
  description:
    "Current live orchestration event buffer depth for a replayable WebSocket subscription.",
});

export const wsOrchestrationLiveBufferHighWater = Metric.gauge(
  wsReplayMetricNames.liveBufferHighWater,
  {
    description:
      "Highest observed live orchestration event buffer depth for a replayable WebSocket subscription.",
  },
);

export const wsOrchestrationLiveBufferOverflowsTotal = Metric.counter(
  wsReplayMetricNames.liveBufferOverflowsTotal,
  {
    description:
      "Total live orchestration event buffer overflows that forced replayable WebSocket subscription resync.",
    incremental: true,
  },
);

export const wsOrchestrationReplayLag = Metric.gauge(wsReplayMetricNames.replayLag, {
  description:
    "Sequence lag between the latest live event observed and the latest replay/live event drained by a replayable WebSocket subscription.",
});

export const wsOrchestrationCoalescedFramesTotal = Metric.counter(
  wsReplayMetricNames.coalescedFramesTotal,
  {
    description:
      "Total progress-grade live frames skipped by pre-broadcast coalescing (latest-per-key frames superseded before enqueue).",
    incremental: true,
  },
);

export interface WsReplayMetrics {
  /** Records drained replay events; a batch passes its highest sequence. */
  readonly recordReplayEvent: (sequence: number) => Effect.Effect<void>;
  readonly recordLiveEnqueued: (sequence: number) => Effect.Effect<void>;
  /** Records `count` (default 1) drained live events ending at `sequence`. */
  readonly recordLiveDequeued: (sequence: number, count?: number) => Effect.Effect<void>;
  readonly recordLiveOverflow: (sequence: number, capacity: number) => Effect.Effect<void>;
  /**
   * Counts a superseded progress frame without advancing the drain watermark.
   * Older queued events still contribute to lag until the consumer drains them.
   */
  readonly recordCoalesced: (sequence: number) => Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

/**
 * Plain mutable counters: every update runs on the subscription's own fiber,
 * so publishing an aggregate reads numbers instead of running one effect per
 * field per active subscription.
 */
interface ActiveReplayMetricState {
  readonly stream: WsReplayStreamKind;
  replayDepth: number;
  latestLiveSequence: number;
  lastDrainedSequence: number;
  liveBufferDepth: number;
  liveBufferHighWater: number;
}

interface PublishedAggregate {
  replayDepth: number;
  replayLag: number;
  liveBufferDepth: number;
  liveBufferHighWater: number;
}

// Only active subscriptions live here. Published metric labels are limited to
// the two stream kinds, so reconnects cannot grow the global metric registry.
const activeReplayMetricStates = new Map<string, ActiveReplayMetricState>();
// The last values written per metric registry and stream kind, so an aggregate
// that did not move costs no gauge write.
const publishedAggregatesByRegistry = new WeakMap<
  object,
  Map<WsReplayStreamKind, PublishedAggregate>
>();

const normalizeSequence = (sequence: number): number =>
  Number.isFinite(sequence) ? Math.max(0, Math.floor(sequence)) : 0;

const updateGauge = (
  metric: Metric.Metric<number, unknown>,
  attributes: ReadonlyArray<[string, string]>,
  value: number,
) => Metric.update(Metric.withAttributes(metric, attributes), value);

const computeAggregate = (stream: WsReplayStreamKind): PublishedAggregate => {
  const aggregate: PublishedAggregate = {
    replayDepth: 0,
    replayLag: 0,
    liveBufferDepth: 0,
    liveBufferHighWater: 0,
  };
  for (const state of activeReplayMetricStates.values()) {
    if (state.stream !== stream) continue;
    aggregate.liveBufferDepth += state.liveBufferDepth;
    aggregate.replayDepth = Math.max(aggregate.replayDepth, state.replayDepth);
    aggregate.liveBufferHighWater = Math.max(
      aggregate.liveBufferHighWater,
      state.liveBufferHighWater,
    );
    aggregate.replayLag = Math.max(
      aggregate.replayLag,
      Math.max(0, state.latestLiveSequence - state.lastDrainedSequence),
    );
  }
  return aggregate;
};

const publishAggregateFor = (
  stream: WsReplayStreamKind,
  attributes: ReadonlyArray<[string, string]>,
) =>
  Effect.flatMap(Metric.MetricRegistry, (registry) => {
    let publishedAggregates = publishedAggregatesByRegistry.get(registry);
    if (publishedAggregates === undefined) {
      publishedAggregates = new Map();
      publishedAggregatesByRegistry.set(registry, publishedAggregates);
    }
    const next = computeAggregate(stream);
    const previous = publishedAggregates.get(stream);
    publishedAggregates.set(stream, next);
    const updates: Array<Effect.Effect<void>> = [];
    if (previous?.replayDepth !== next.replayDepth) {
      updates.push(updateGauge(wsOrchestrationReplayDepth, attributes, next.replayDepth));
    }
    if (previous?.replayLag !== next.replayLag) {
      updates.push(updateGauge(wsOrchestrationReplayLag, attributes, next.replayLag));
    }
    if (previous?.liveBufferDepth !== next.liveBufferDepth) {
      updates.push(updateGauge(wsOrchestrationLiveBufferDepth, attributes, next.liveBufferDepth));
    }
    if (previous?.liveBufferHighWater !== next.liveBufferHighWater) {
      updates.push(
        updateGauge(wsOrchestrationLiveBufferHighWater, attributes, next.liveBufferHighWater),
      );
    }
    return updates.length === 0 ? Effect.void : Effect.all(updates, { discard: true });
  });

export const makeWsReplayMetrics = (input: {
  readonly stream: WsReplayStreamKind;
  readonly subscriptionId: string;
  readonly snapshotSequence: number;
}): Effect.Effect<WsReplayMetrics, never, Scope.Scope> =>
  Effect.gen(function* () {
    const snapshotSequence = normalizeSequence(input.snapshotSequence);
    const attributes = metricAttributes({ stream: input.stream });
    const state: ActiveReplayMetricState = {
      stream: input.stream,
      replayDepth: 0,
      latestLiveSequence: snapshotSequence,
      lastDrainedSequence: snapshotSequence,
      liveBufferDepth: 0,
      liveBufferHighWater: 0,
    };
    const publishAggregate = publishAggregateFor(input.stream, attributes);

    const reset = Effect.sync(() => {
      if (activeReplayMetricStates.get(input.subscriptionId) === state) {
        activeReplayMetricStates.delete(input.subscriptionId);
      }
    }).pipe(Effect.andThen(publishAggregate));

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        activeReplayMetricStates.set(input.subscriptionId, state);
      }),
      () => reset,
    );
    yield* publishAggregate;

    const markDrained = (sequence: number) => {
      state.lastDrainedSequence = Math.max(state.lastDrainedSequence, normalizeSequence(sequence));
    };

    return {
      recordReplayEvent: (sequence) =>
        Effect.suspend(() => {
          state.replayDepth = Math.max(0, normalizeSequence(sequence) - snapshotSequence);
          markDrained(sequence);
          return publishAggregate;
        }),
      recordLiveEnqueued: (sequence) =>
        Effect.suspend(() => {
          state.latestLiveSequence = Math.max(
            state.latestLiveSequence,
            normalizeSequence(sequence),
          );
          state.liveBufferDepth += 1;
          state.liveBufferHighWater = Math.max(state.liveBufferHighWater, state.liveBufferDepth);
          return publishAggregate;
        }),
      recordLiveDequeued: (sequence, count = 1) =>
        Effect.suspend(() => {
          state.liveBufferDepth = Math.max(0, state.liveBufferDepth - Math.max(0, count));
          markDrained(sequence);
          return publishAggregate;
        }),
      recordLiveOverflow: (sequence, capacity) =>
        Effect.suspend(() => {
          const normalizedCapacity = Math.max(0, Math.floor(capacity));
          state.latestLiveSequence = Math.max(
            state.latestLiveSequence,
            normalizeSequence(sequence),
          );
          state.liveBufferDepth = normalizedCapacity;
          state.liveBufferHighWater = Math.max(state.liveBufferHighWater, normalizedCapacity);
          return Effect.all(
            [updateGauge(wsOrchestrationLiveBufferOverflowsTotal, attributes, 1), publishAggregate],
            { discard: true },
          );
        }),
      recordCoalesced: (sequence) =>
        Effect.suspend(() => {
          state.latestLiveSequence = Math.max(
            state.latestLiveSequence,
            normalizeSequence(sequence),
          );
          return Effect.all(
            [updateGauge(wsOrchestrationCoalescedFramesTotal, attributes, 1), publishAggregate],
            { discard: true },
          );
        }),
      reset,
    };
  });
