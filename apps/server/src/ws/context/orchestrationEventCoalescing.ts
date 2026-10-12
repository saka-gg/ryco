import { Effect, Semaphore } from "effect";
import { type OrchestrationEvent, OrchestrationGetSnapshotError } from "@ryco/contracts";

import { orchestrationEventBytes } from "./orchestrationStreamBatching.ts";

/**
 * Which live orchestration frames may be collapsed, and under what key.
 *
 * A key is only issued when the frame is an upsert whose later replacement
 * fully subsumes it, so dropping every frame but the latest per key leaves
 * client state identical:
 *
 * - `thread.activity-appended` for replaceable progress activities (task and
 *   tool progress heartbeats, streaming subagent messages): the client stores
 *   activities by id, latest wins, and these ids are stable per task/item.
 * - `thread.activity-appended` for `context-window.updated` gauges: only updates sharing an activity id can replace each other; the client
 *   retains distinct activity ids even when the projection prunes old gauges.
 * - `thread.proposed-plan-upserted`: plans are upserts keyed by plan id.
 *
 * Everything else — turn lifecycle, session state, diffs, reverts, user
 * messages (whose streaming deltas append text), approvals, project and
 * worktree events — returns null and is never coalesced, delayed, or dropped.
 */
export const orchestrationProgressFrameKey = (event: OrchestrationEvent): string | null => {
  if (event.aggregateKind !== "thread") {
    return null;
  }
  if (event.type === "thread.activity-appended") {
    const activity = event.payload.activity;
    if (activity.kind === "task.progress" || activity.kind === "tool.progress") {
      return JSON.stringify(["activity", event.aggregateId, activity.id]);
    }
    if (activity.kind === "agent.message") {
      const streaming = (activity.payload as { streaming?: unknown } | null)?.streaming;
      // Streaming agent-message upserts carry the full text so far; the final
      // (non-streaming) frame shares the id and replaces the pending state.
      if (streaming === true) {
        return JSON.stringify(["activity", event.aggregateId, activity.id]);
      }
      return null;
    }
    if (activity.kind === "context-window.updated") {
      return JSON.stringify(["activity", event.aggregateId, activity.id]);
    }
    return null;
  }
  if (event.type === "thread.proposed-plan-upserted") {
    return JSON.stringify(["plan", event.aggregateId, event.payload.proposedPlan.id]);
  }
  return null;
};

/**
 * Coalescing key for the shell stream. The shell turns every thread event into
 * a re-read of that thread's row, so the high-frequency thread events (activity
 * appends, including progress, streaming message deltas and plan upserts)
 * collapse to the latest per thread. Structural thread events (creation,
 * session and turn changes, deletion) and every project and worktree event
 * return null and pass through immediately, flushing held frames first so
 * sequence order holds.
 */
export const orchestrationShellFrameKey = (event: OrchestrationEvent): string | null => {
  if (event.aggregateKind !== "thread") {
    return null;
  }
  if (
    event.type === "thread.activity-appended" ||
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted"
  ) {
    return JSON.stringify(["thread-shell", event.aggregateId]);
  }
  return null;
};

export interface OrchestrationEventCoalescer {
  /**
   * Feed one live event. Progress-grade frames are held as latest-per-key;
   * every other frame flushes pending frames first (preserving sequence
   * order) and is then offered itself. Offers propagate overflow errors so a
   * failed queue still fails the subscription and forces resync.
   */
  readonly push: (event: OrchestrationEvent) => Effect.Effect<void, OrchestrationGetSnapshotError>;
  /** Flush all held frames in sequence order (flush tick, teardown). */
  readonly flush: Effect.Effect<void, OrchestrationGetSnapshotError>;
}

export const makeOrchestrationEventCoalescer = (input: {
  readonly offer: (
    event: OrchestrationEvent,
    eventBytes: number,
  ) => Effect.Effect<void, OrchestrationGetSnapshotError>;
  /** Told the sequence of each frame whose delivery is skipped (superseded). */
  readonly onCoalesced?: (sequence: number) => Effect.Effect<void>;
  /**
   * Maximum dwell time for held progress frames. A burst collapses to at most
   * one frame per key per window; `0` degrades to pass-through. A periodic
   * flush tick keeps the newest state visible even between bursts.
   */
  readonly windowMs: number;
  readonly maxKeys?: number;
  /** Byte ceiling on held frames; overflow flushes through, never drops. */
  readonly maxPendingBytes?: number;
  /**
   * Which frames may be held, and under what key; defaults to the
   * progress-grade frames of `orchestrationProgressFrameKey`.
   */
  readonly keyOf?: (event: OrchestrationEvent) => string | null;
}): Effect.Effect<OrchestrationEventCoalescer> =>
  Effect.gen(function* () {
    const maxKeys = Math.max(1, input.maxKeys ?? 128);
    const maxPendingBytes = Math.max(1, input.maxPendingBytes ?? 512 * 1024);
    const keyOf = input.keyOf ?? orchestrationProgressFrameKey;
    const semaphore = yield* Semaphore.make(1);
    const pending = new Map<string, OrchestrationEvent>();
    let pendingBytes = 0;
    let oldestPushedAtMs = 0;

    const emitPending = Effect.gen(function* () {
      if (pending.size === 0) {
        return;
      }
      const ordered = [...pending.values()].toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      pending.clear();
      pendingBytes = 0;
      oldestPushedAtMs = 0;
      yield* Effect.forEach(
        ordered,
        (event) =>
          input.offer(event, orchestrationEventBytes(event)).pipe(
            Effect.catch((error) =>
              // A failed offer means the subscription is already failing over
              // to resync; drop held state so nothing lingers behind it.
              Effect.sync(() => {
                pending.clear();
                pendingBytes = 0;
                oldestPushedAtMs = 0;
              }).pipe(Effect.andThen(Effect.fail(error))),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    const push = (event: OrchestrationEvent) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const key = keyOf(event);
          if (key === null) {
            yield* emitPending;
            yield* input.offer(event, orchestrationEventBytes(event));
            return;
          }

          const superseded = pending.get(key);
          if (superseded !== undefined) {
            pendingBytes = Math.max(0, pendingBytes - orchestrationEventBytes(superseded));
            if (input.onCoalesced) {
              yield* input.onCoalesced(superseded.sequence);
            }
          }
          pending.set(key, event);
          pendingBytes += orchestrationEventBytes(event);
          const now = Date.now();
          if (oldestPushedAtMs === 0) {
            oldestPushedAtMs = now;
          }

          const windowExpired = now - oldestPushedAtMs >= input.windowMs;
          if (
            input.windowMs <= 0 ||
            windowExpired ||
            pending.size > maxKeys ||
            pendingBytes > maxPendingBytes
          ) {
            yield* emitPending;
          }
        }),
      );

    const flush = semaphore.withPermit(emitPending);

    return { push, flush };
  });

export const isProgressGradeOrchestrationEvent = (event: OrchestrationEvent): boolean =>
  orchestrationProgressFrameKey(event) !== null;
