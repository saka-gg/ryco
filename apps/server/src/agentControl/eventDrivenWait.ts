/**
 * The shared subscribe-before-read wait of Agent Control.
 *
 * `ryco_wait_threads`, the executor's idle and interrupt settlement and the
 * external `ryco_wait_for_task` used to poll their reads every 100-500 ms.
 * They now re-check when one of their change feeds reports a relevant item,
 * and otherwise only every {@link AGENT_CONTROL_WAIT_RECHECK_MS} as a safety
 * net for changes no feed reports (Agent Control disabled, an integration
 * expiring, an event the wake filter misses).
 *
 * Invariants:
 *
 * 1. **Subscribe before the first read.** Every source subscribes in the
 *    caller's fiber before the first check, so a relevant commit after a check
 *    begins is either in that check's reads or wakes the next round. The
 *    orchestration engine publishes after commit and projection, so the re-read
 *    sees the event's effect.
 * 2. **Decide only from fresh reads.** Items only wake the wait; the check reads
 *    current state. A lost or spurious wake costs latency, never a wrong result.
 * 3. **Drain continuously.** Each source drains its feed in one fiber for the
 *    whole wait, also while a check runs, so a waiter never holds back a
 *    back-pressured publisher (the engine's bounded event bus). The drainer only
 *    raises a coalescing wake signal, which is cleared immediately before each
 *    check: a wake that lands during a check triggers the next one.
 * 4. **Bounded check rate.** The first wake after a quiet period checks at once;
 *    further wakes within the wake spacing of a woken check coalesce into one
 *    trailing check. Each adopter spaces woken checks by the interval of the poll
 *    it replaced (default {@link AGENT_CONTROL_WAIT_WAKE_SPACING_MS}, the
 *    `ryco_wait_threads` poll), so a busy feed never checks more often, and a
 *    burst never settles later, than that poll did. An isolated settle still
 *    wakes within one scheduler turn.
 * 5. **The last check is at or after the deadline.** `timeoutMs: 0` performs
 *    exactly one check and subscribes to nothing.
 * 6. **Effect `Clock`, not `Date.now()`,** so `TestClock` drives deadlines and
 *    fallbacks deterministically.
 * 7. **Self-scoped.** Subscriptions and drainers are released when `waitUntil`
 *    returns, fails or is interrupted, before the caller builds its result.
 *
 * @module agentControl/eventDrivenWait
 */
import type { OrchestrationEvent } from "@ryco/contracts";
import { Clock, Duration, Effect, Exit, Latch, Scope, Stream } from "effect";
import type { PubSub } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { isThreadWaitWakeEvent } from "../orchestration/threadWaitWakeEvents.ts";

/**
 * Safety-net re-check interval: bounds the latency of anything no wake source
 * reports (Agent Control disabled, integration expiry, a missed classification).
 */
export const AGENT_CONTROL_WAIT_RECHECK_MS = 5_000;

/** Default minimum spacing of woken checks: the interval of the `ryco_wait_threads` poll. */
export const AGENT_CONTROL_WAIT_WAKE_SPACING_MS = 500;

/** A change feed that can end a wait. */
export interface WaitWakeSource {
  /**
   * Subscribes now, in the caller's fiber, then drains the feed in a fiber
   * forked into the caller's scope, running `wake` for every batch that holds
   * a relevant item.
   */
  readonly start: (wake: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
}

/** Wakes on relevant items of a live stream; `subscribe` must subscribe when it runs. */
export const wakeOnStream = <A>(
  subscribe: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>,
  relevant: (item: A) => boolean,
): WaitWakeSource => ({
  start: (wake) =>
    Effect.gen(function* () {
      // The subscription lives exactly as long as its drainer. A drainer that stops early (a
      // throwing filter) releases its feed at once, so it never holds back a back-pressured
      // publisher for the rest of the wait.
      const feedScope = yield* Scope.fork(yield* Effect.scope);
      const items = yield* subscribe.pipe(Scope.provide(feedScope));
      yield* Stream.runForEachArray(items, (batch) =>
        batch.some(relevant) ? wake : Effect.void,
      ).pipe(
        // A broken filter must not end the wait: it falls back to its re-check interval.
        Effect.catchDefect((defect) =>
          Effect.logWarning("Agent Control wait stopped watching a change feed", { defect }),
        ),
        Effect.ensuring(Scope.close(feedScope, Exit.void)),
        Effect.forkScoped,
      );
    }),
});

/** Wakes on relevant items of a PubSub subscription acquired by `subscribe`. */
export const wakeOnSubscription = <A>(
  subscribe: Effect.Effect<PubSub.Subscription<A>, never, Scope.Scope>,
  relevant: (item: A) => boolean,
): WaitWakeSource => wakeOnStream(Effect.map(subscribe, Stream.fromSubscription), relevant);

/**
 * Wakes on the orchestration events of `threadIds` that `relevant` accepts.
 * The only consumer of `subscribeDomainEvents` in this module: adapt this one
 * function if the engine's subscription shape changes.
 */
export const threadWakeSource = (
  events: Pick<OrchestrationEngineShape, "subscribeDomainEvents">,
  threadIds: Iterable<string>,
  relevant: (event: OrchestrationEvent) => boolean = isThreadWaitWakeEvent,
): WaitWakeSource => {
  const ids = new Set(threadIds);
  return wakeOnSubscription(
    events.subscribeDomainEvents,
    (event: OrchestrationEvent) =>
      event.aggregateKind === "thread" && ids.has(event.aggregateId) && relevant(event),
  );
};

export interface WaitCheck<A> {
  readonly done: boolean;
  readonly value: A;
}

export interface WaitOutcome<A> {
  /** The last check's value. */
  readonly value: A;
  /** The deadline passed before a check reported done. */
  readonly timedOut: boolean;
}

/**
 * Runs `check` until it reports done or `timeoutMs` passes. Every source
 * subscribes before the first check; afterwards the check re-runs when a source
 * wakes the wait, or after `recheckMs` without a wake. See the module comment
 * for the invariants.
 */
export const waitUntil = <A, E, R>(input: {
  readonly sources: ReadonlyArray<WaitWakeSource>;
  readonly check: Effect.Effect<WaitCheck<A>, E, R>;
  readonly timeoutMs: number;
  readonly recheckMs?: number;
  /** Minimum spacing of woken checks: pass the interval of the poll the wait replaced. */
  readonly wakeSpacingMs?: number;
}): Effect.Effect<WaitOutcome<A>, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + Math.max(0, input.timeoutMs);
      const recheckMs = Math.max(1, input.recheckMs ?? AGENT_CONTROL_WAIT_RECHECK_MS);
      const spacingMs = Math.max(0, input.wakeSpacingMs ?? AGENT_CONTROL_WAIT_WAKE_SPACING_MS);
      const woken = yield* Latch.make(false);
      const wake = Effect.asVoid(woken.open);
      // A zero timeout is a single check that nothing can wake: it subscribes to nothing.
      if (input.timeoutMs > 0) {
        yield* Effect.forEach(input.sources, (source) => source.start(wake), { discard: true });
      }
      let lastWokenCheckAt = Number.NEGATIVE_INFINITY;
      while (true) {
        // Cleared before the reads: a wake that lands during the check stays raised.
        yield* woken.close;
        const current = yield* input.check;
        if (current.done) return { value: current.value, timedOut: false };
        const checkedAt = yield* Clock.currentTimeMillis;
        if (checkedAt >= deadline) return { value: current.value, timedOut: true };
        yield* Effect.race(
          Effect.sleep(Duration.millis(Math.min(recheckMs, deadline - checkedAt))),
          woken.await,
        );
        if (!woken.isOpen()) continue;
        // Woken: coalesce a burst into one trailing check per spacing interval.
        const wokenAt = yield* Clock.currentTimeMillis;
        const earliest = Math.min(lastWokenCheckAt + spacingMs, deadline);
        if (wokenAt < earliest) yield* Effect.sleep(Duration.millis(earliest - wokenAt));
        lastWokenCheckAt = Math.max(wokenAt, earliest);
      }
    }),
  );
