import type { EnvironmentId } from "@ryco/contracts";

import { getThreadsRuntimeConfiguration } from "./runtime.ts";
import { registerThreadStoreMutationBarrier } from "./store.ts";

/**
 * Upper bound on how long buffered events may wait when no animation frame
 * runs (a hidden document stops `requestAnimationFrame`).
 */
export const ENVIRONMENT_EVENT_BATCH_FALLBACK_DELAY_MS = 100;
/** Applies synchronously once this many events are buffered (replay bursts). */
export const ENVIRONMENT_EVENT_BATCH_MAX_PENDING = 512;

export interface EnvironmentEventBatcherDeps<Event> {
  /** Applies one environment's events in arrival order as a single batch. */
  readonly apply: (environmentId: EnvironmentId, events: ReadonlyArray<Event>) => void;
  readonly scheduleFrame?: (callback: () => void) => void;
  readonly scheduleFallback?: (callback: () => void, delayMs: number) => void;
  readonly fallbackDelayMs?: number;
  readonly maxPendingEvents?: number;
  /**
   * Flush before every thread-store mutation so buffered events keep their
   * order relative to snapshots, removals and shell events. Defaults to true.
   */
  readonly registerStoreBarrier?: boolean;
}

export interface EnvironmentEventBatcher<Event> {
  readonly enqueue: (environmentId: EnvironmentId, event: Event) => void;
  readonly flush: () => void;
  readonly hasPending: () => boolean;
  readonly dispose: () => void;
}

/**
 * Collapses a stream of per-environment events into at most one batch per
 * environment and animation frame. Each WebSocket message used to become its
 * own store commit (and its own round of derived UI sync); a frame batch turns
 * N commits into one while keeping the exact arrival order, including the
 * interleaving across environments.
 */
export function createEnvironmentEventBatcher<Event>(
  deps: EnvironmentEventBatcherDeps<Event>,
): EnvironmentEventBatcher<Event> {
  const scheduleFrame =
    deps.scheduleFrame ??
    ((callback: () => void) =>
      getThreadsRuntimeConfiguration().frameScheduler.scheduleFrame(callback));
  const scheduleFallback =
    deps.scheduleFallback ??
    ((callback: () => void, delayMs: number) => void setTimeout(callback, delayMs));
  const fallbackDelayMs = deps.fallbackDelayMs ?? ENVIRONMENT_EVENT_BATCH_FALLBACK_DELAY_MS;
  const maxPendingEvents = deps.maxPendingEvents ?? ENVIRONMENT_EVENT_BATCH_MAX_PENDING;

  let groups: Array<{ readonly environmentId: EnvironmentId; readonly events: Event[] }> = [];
  let pendingCount = 0;
  let scheduledGeneration = 0;
  let scheduled = false;
  let flushing = false;

  function cancelScheduledRun(): void {
    scheduled = false;
    scheduledGeneration += 1;
  }

  function flush(): void {
    // Re-entrant: applying a batch goes through store mutators, which run the
    // store barriers (this flush) again.
    if (flushing) return;
    if (pendingCount === 0) {
      // A run scheduled for events another flush already applied must not
      // leave `scheduled` set, or later events would never get a frame.
      cancelScheduledRun();
      return;
    }
    flushing = true;
    cancelScheduledRun();
    try {
      while (groups.length > 0) {
        const pending = groups;
        groups = [];
        pendingCount = 0;
        for (const group of pending) {
          try {
            deps.apply(group.environmentId, group.events);
          } catch (error) {
            // A flush can run inside an unrelated store mutation (as its
            // barrier): one bad batch must neither abort that mutation nor
            // drop the batches queued behind it. Report it instead (a deferred
            // rethrow would be fatal on React Native).
            console.error("[THREAD_EVENTS] applying an event batch failed", error);
          }
        }
      }
    } finally {
      flushing = false;
      // Events enqueued while applying were drained by the loop above; their
      // scheduled run has nothing left to do.
      if (pendingCount === 0) cancelScheduledRun();
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    const generation = ++scheduledGeneration;
    const run = () => {
      if (generation === scheduledGeneration) flush();
    };
    scheduleFrame(run);
    scheduleFallback(run, fallbackDelayMs);
  }

  function enqueue(environmentId: EnvironmentId, event: Event): void {
    const last = groups.at(-1);
    if (last !== undefined && last.environmentId === environmentId) {
      last.events.push(event);
    } else {
      groups.push({ environmentId, events: [event] });
    }
    pendingCount += 1;
    if (pendingCount >= maxPendingEvents) {
      flush();
      return;
    }
    schedule();
  }

  const unregisterBarrier =
    deps.registerStoreBarrier === false
      ? () => undefined
      : registerThreadStoreMutationBarrier(flush);

  return {
    enqueue,
    flush,
    hasPending: () => pendingCount > 0,
    dispose: () => {
      flush();
      unregisterBarrier();
    },
  };
}
