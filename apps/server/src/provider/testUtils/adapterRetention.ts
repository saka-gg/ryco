/**
 * Retention probe for provider adapter tests and `scripts/measure-adapter-retention.ts`: tracks
 * payload objects weakly and counts how many an adapter still keeps reachable after full GCs.
 *
 * Rules for a probe that gives no false residues:
 * 1. Create tracked payloads in a plain helper function, never as locals of an `Effect.gen`
 *    body or loop (a suspended generator frame keeps its last iteration's locals alive).
 * 2. Drain `adapter.streamEvents` without keeping events: runtime events carry `raw` payloads.
 * 3. Prove the adapter saw the payloads (count emitted events, or wait for a sentinel sent after
 *    the batch) before asserting.
 *
 * No test-runner imports, so `scripts/measure-adapter-retention.ts` uses it as well.
 *
 * @module provider/testUtils/adapterRetention
 */
import { deepStrictEqual } from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";

import type { ProviderRuntimeEvent, TurnId } from "@ryco/contracts";
import { Deferred, Effect, Stream } from "effect";

import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

let fullGc: (() => void) | undefined;

/** `globalThis.gc` under `--expose-gc`; otherwise turns the flag on at runtime for this isolate. */
export function forceFullGc(): void {
  if (!fullGc) {
    const exposed = (globalThis as { gc?: () => void }).gc;
    if (typeof exposed === "function") {
      fullGc = exposed;
    } else {
      v8.setFlagsFromString("--expose-gc");
      fullGc = vm.runInNewContext("gc") as () => void;
    }
  }
  fullGc();
}

/** Full GCs across macrotasks: a WeakRef target stays alive until the job that read it ends. */
export async function settleHeap(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await nextMacrotask();
    forceFullGc();
  }
}

export interface RetentionProbe {
  /** Unique, flat text of `length` chars (`String.repeat` shares ropes and under-reports). */
  readonly payload: (length?: number) => string;
  /** Tracks `value` weakly and returns it. */
  readonly track: <T extends object>(value: T) => T;
  readonly tracked: number;
  /** How many tracked values survive full GCs. */
  readonly reachable: () => Promise<number>;
}

export function makeRetentionProbe(): RetentionProbe {
  const refs: Array<WeakRef<object>> = [];
  return {
    payload: (length = 20_000) =>
      randomBytes(Math.ceil(length / 2))
        .toString("hex")
        .slice(0, length),
    track: (value) => {
      refs.push(new WeakRef(value));
      return value;
    },
    get tracked() {
      return refs.length;
    },
    reachable: async () => {
      await settleHeap();
      return refs.filter((ref) => ref.deref() !== undefined).length;
    },
  };
}

/** The snapshot holds exactly these turn ids, each with no items. */
export function assertTurnIdsOnly(
  snapshot: ProviderThreadSnapshot,
  expected: ReadonlyArray<TurnId>,
): void {
  deepStrictEqual(
    snapshot.turns.map((turn) => turn.id),
    [...expected],
  );
  for (const turn of snapshot.turns) deepStrictEqual(turn.items, []);
}

export interface RuntimeEventWaiter {
  /**
   * Completes once `times` events matching `matches` arrived. It registers when called, so call it
   * before the step that produces the events and yield the returned effect after it.
   */
  readonly expect: (
    matches: (event: ProviderRuntimeEvent) => boolean,
    times?: number,
  ) => Effect.Effect<void>;
}

/**
 * Drains an adapter's runtime events in a child fiber without keeping any: events carry the raw
 * provider payload, so a kept event would hold exactly what a retention check expects released.
 */
export const drainRuntimeEvents = <E, R>(
  events: Stream.Stream<ProviderRuntimeEvent, E, R>,
): Effect.Effect<RuntimeEventWaiter, never, R> =>
  Effect.gen(function* () {
    const waiters = new Set<{
      readonly matches: (event: ProviderRuntimeEvent) => boolean;
      remaining: number;
      readonly done: Deferred.Deferred<void>;
    }>();
    yield* Stream.runForEach(events, (event) =>
      Effect.sync(() => {
        for (const waiter of waiters) {
          if (!waiter.matches(event)) continue;
          waiter.remaining -= 1;
          if (waiter.remaining > 0) continue;
          waiters.delete(waiter);
          Deferred.doneUnsafe(waiter.done, Effect.void);
        }
      }),
    ).pipe(Effect.ignore, Effect.forkChild);
    return {
      expect: (matches, times = 1) => {
        const done = Deferred.makeUnsafe<void>();
        waiters.add({ matches, remaining: times, done });
        return Deferred.await(done);
      },
    };
  });
