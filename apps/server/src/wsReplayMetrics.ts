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

/**
 * How long a max-type aggregate (replay depth, lag, high-water) may report a
 * stale upper bound after the subscription that held it moved down, before
 * one rescan over the stream's subscriptions settles it.
 */
export const WS_REPLAY_METRICS_SETTLE_MS = 1_000;
/**
 * Up to this many subscriptions per stream a stale maximum is rescanned right
 * away: the rescan is as cheap as the bookkeeping, and the common case (a few
 * tabs) keeps exact gauges.
 */
const SYNC_SETTLE_MAX_SUBSCRIPTIONS = 8;

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
  replayDepth: number;
  latestLiveSequence: number;
  lastDrainedSequence: number;
  liveBufferDepth: number;
  liveBufferHighWater: number;
}

const replayLagOf = (state: ActiveReplayMetricState): number =>
  Math.max(0, state.latestLiveSequence - state.lastDrainedSequence);

/**
 * The maximum of a changing set of values, kept in O(1) per change. It counts
 * the members at the maximum; when the last of them moves down (or leaves),
 * the true maximum is unknown but strictly below `value`, so `value` stays as
 * an upper bound and `stale` asks for a rescan. A member that rises to or
 * above the stale bound is the maximum again, which settles it without one.
 */
export class RunningMax {
  value = 0;
  stale = false;
  private holders = 0;

  /** Moves one member from `previous` to `next`; `undefined` is absent. */
  update(previous: number | undefined, next: number | undefined): void {
    if (previous === next) return;
    if (next !== undefined && next >= this.value) {
      // `previous` is below `value` (or absent) here, so it held nothing.
      if (next > this.value || this.stale) {
        this.value = next;
        this.holders = 1;
        this.stale = false;
      } else {
        this.holders += 1;
      }
      return;
    }
    if (previous !== undefined && previous === this.value && !this.stale) {
      this.holders -= 1;
      if (this.holders === 0) this.stale = true;
    }
  }

  recompute(values: Iterable<number>): void {
    let value = 0;
    let holders = 0;
    for (const candidate of values) {
      if (candidate > value) {
        value = candidate;
        holders = 1;
      } else if (candidate === value) {
        holders += 1;
      }
    }
    this.value = value;
    this.holders = holders;
    this.stale = false;
  }
}

interface PublishedAggregate {
  replayDepth: number;
  replayLag: number;
  liveBufferDepth: number;
  liveBufferHighWater: number;
}

/**
 * One stream kind's running aggregate over its active subscriptions. The
 * buffer-depth sum is exact; the maxima rise exactly and settle downward
 * through one rescan per settle window, so a live event costs O(1) however
 * many subscriptions are open.
 */
class StreamReplayAggregate {
  readonly states = new Set<ActiveReplayMetricState>();
  liveBufferDepth = 0;
  readonly replayDepth = new RunningMax();
  readonly replayLag = new RunningMax();
  readonly liveBufferHighWater = new RunningMax();
  /** The pending delayed rescan, if any; one per stream at a time. */
  pendingSettle: object | undefined = undefined;

  get stale(): boolean {
    return this.replayDepth.stale || this.replayLag.stale || this.liveBufferHighWater.stale;
  }

  add(state: ActiveReplayMetricState): void {
    this.states.add(state);
    this.liveBufferDepth += state.liveBufferDepth;
    this.replayDepth.update(undefined, state.replayDepth);
    this.replayLag.update(undefined, replayLagOf(state));
    this.liveBufferHighWater.update(undefined, state.liveBufferHighWater);
  }

  /** Applies `mutate` to an active member and folds its deltas in. */
  change(state: ActiveReplayMetricState, mutate: () => void): void {
    if (!this.states.has(state)) {
      mutate();
      return;
    }
    const previousReplayDepth = state.replayDepth;
    const previousReplayLag = replayLagOf(state);
    const previousLiveBufferDepth = state.liveBufferDepth;
    const previousHighWater = state.liveBufferHighWater;
    mutate();
    this.liveBufferDepth += state.liveBufferDepth - previousLiveBufferDepth;
    this.replayDepth.update(previousReplayDepth, state.replayDepth);
    this.replayLag.update(previousReplayLag, replayLagOf(state));
    this.liveBufferHighWater.update(previousHighWater, state.liveBufferHighWater);
  }

  /** Removes a member once; a subscription that ends settles right away. */
  remove(state: ActiveReplayMetricState): void {
    if (!this.states.delete(state)) return;
    if (this.states.size === 0) {
      // Nothing left to aggregate: reset exactly so no residue outlives it.
      this.liveBufferDepth = 0;
      this.replayDepth.recompute([]);
      this.replayLag.recompute([]);
      this.liveBufferHighWater.recompute([]);
      return;
    }
    this.liveBufferDepth -= state.liveBufferDepth;
    this.replayDepth.update(state.replayDepth, undefined);
    this.replayLag.update(replayLagOf(state), undefined);
    this.liveBufferHighWater.update(state.liveBufferHighWater, undefined);
    this.settle();
  }

  /** Rescans only the maxima that went stale. */
  settle(): void {
    if (this.replayDepth.stale) {
      this.replayDepth.recompute(Array.from(this.states, (state) => state.replayDepth));
    }
    if (this.replayLag.stale) {
      this.replayLag.recompute(Array.from(this.states, replayLagOf));
    }
    if (this.liveBufferHighWater.stale) {
      this.liveBufferHighWater.recompute(
        Array.from(this.states, (state) => state.liveBufferHighWater),
      );
    }
  }
}

// Only active subscriptions are aggregated. Published metric labels are
// limited to the two stream kinds, so reconnects cannot grow the global
// metric registry.
const aggregatesByStream: Record<WsReplayStreamKind, StreamReplayAggregate> = {
  shell: new StreamReplayAggregate(),
  thread: new StreamReplayAggregate(),
};
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
    const aggregate = aggregatesByStream[stream];
    let published = publishedAggregates.get(stream);
    const isNew = published === undefined;
    if (published === undefined) {
      published = { replayDepth: 0, replayLag: 0, liveBufferDepth: 0, liveBufferHighWater: 0 };
      publishedAggregates.set(stream, published);
    }
    const updates: Array<Effect.Effect<void>> = [];
    if (isNew || published.replayDepth !== aggregate.replayDepth.value) {
      published.replayDepth = aggregate.replayDepth.value;
      updates.push(updateGauge(wsOrchestrationReplayDepth, attributes, published.replayDepth));
    }
    if (isNew || published.replayLag !== aggregate.replayLag.value) {
      published.replayLag = aggregate.replayLag.value;
      updates.push(updateGauge(wsOrchestrationReplayLag, attributes, published.replayLag));
    }
    if (isNew || published.liveBufferDepth !== aggregate.liveBufferDepth) {
      published.liveBufferDepth = aggregate.liveBufferDepth;
      updates.push(
        updateGauge(wsOrchestrationLiveBufferDepth, attributes, published.liveBufferDepth),
      );
    }
    if (isNew || published.liveBufferHighWater !== aggregate.liveBufferHighWater.value) {
      published.liveBufferHighWater = aggregate.liveBufferHighWater.value;
      updates.push(
        updateGauge(wsOrchestrationLiveBufferHighWater, attributes, published.liveBufferHighWater),
      );
    }
    if (updates.length === 0) return Effect.void;
    if (updates.length === 1) return updates[0]!;
    return Effect.all(updates, { discard: true });
  });

export const makeWsReplayMetrics = (input: {
  readonly stream: WsReplayStreamKind;
  readonly subscriptionId: string;
  readonly snapshotSequence: number;
}): Effect.Effect<WsReplayMetrics, never, Scope.Scope> =>
  Effect.gen(function* () {
    const snapshotSequence = normalizeSequence(input.snapshotSequence);
    const attributes = metricAttributes({ stream: input.stream });
    const aggregate = aggregatesByStream[input.stream];
    const scope = yield* Effect.scope;
    const state: ActiveReplayMetricState = {
      replayDepth: 0,
      latestLiveSequence: snapshotSequence,
      lastDrainedSequence: snapshotSequence,
      liveBufferDepth: 0,
      liveBufferHighWater: 0,
    };
    const publishAggregate = publishAggregateFor(input.stream, attributes);

    // One delayed rescan per stream at a time. It lives in this subscription's
    // scope, so it cannot outlive the subscription (or a test clock); this
    // subscription's own removal settles the stream if it is cut short.
    const settleLater = (token: object) =>
      Effect.sleep(WS_REPLAY_METRICS_SETTLE_MS).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            aggregate.settle();
            return publishAggregate;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (aggregate.pendingSettle === token) aggregate.pendingSettle = undefined;
          }),
        ),
      );

    /** Applies one change, publishes what moved, and schedules a settle when a maximum went stale. */
    const record = (mutate: () => void): Effect.Effect<void> =>
      Effect.suspend(() => {
        aggregate.change(state, mutate);
        if (aggregate.stale && aggregate.states.size <= SYNC_SETTLE_MAX_SUBSCRIPTIONS) {
          aggregate.settle();
        }
        if (!aggregate.stale || aggregate.pendingSettle !== undefined) return publishAggregate;
        const token = {};
        aggregate.pendingSettle = token;
        return Effect.andThen(publishAggregate, Effect.forkIn(settleLater(token), scope));
      });

    const reset = Effect.suspend(() => {
      aggregate.remove(state);
      return publishAggregate;
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => aggregate.add(state)),
      () => reset,
    );
    yield* publishAggregate;

    const markDrained = (sequence: number) => {
      state.lastDrainedSequence = Math.max(state.lastDrainedSequence, normalizeSequence(sequence));
    };
    const markLiveSequence = (sequence: number) => {
      state.latestLiveSequence = Math.max(state.latestLiveSequence, normalizeSequence(sequence));
    };

    return {
      recordReplayEvent: (sequence) =>
        record(() => {
          state.replayDepth = Math.max(0, normalizeSequence(sequence) - snapshotSequence);
          markDrained(sequence);
        }),
      recordLiveEnqueued: (sequence) =>
        record(() => {
          markLiveSequence(sequence);
          state.liveBufferDepth += 1;
          state.liveBufferHighWater = Math.max(state.liveBufferHighWater, state.liveBufferDepth);
        }),
      recordLiveDequeued: (sequence, count = 1) =>
        record(() => {
          state.liveBufferDepth = Math.max(0, state.liveBufferDepth - Math.max(0, count));
          markDrained(sequence);
        }),
      recordLiveOverflow: (sequence, capacity) =>
        Effect.andThen(
          updateGauge(wsOrchestrationLiveBufferOverflowsTotal, attributes, 1),
          record(() => {
            const normalizedCapacity = Math.max(0, Math.floor(capacity));
            markLiveSequence(sequence);
            state.liveBufferDepth = normalizedCapacity;
            state.liveBufferHighWater = Math.max(state.liveBufferHighWater, normalizedCapacity);
          }),
        ),
      recordCoalesced: (sequence) =>
        Effect.andThen(
          updateGauge(wsOrchestrationCoalescedFramesTotal, attributes, 1),
          record(() => markLiveSequence(sequence)),
        ),
      reset,
    };
  });
