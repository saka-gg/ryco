// Adapted from pingdotgg/t3code packages/provider-testing/src/replayGate.ts
// (91992bd5d464d6a01b2a5c1e7926e68ad09ea40e). Copyright (c) 2026 T3 Tools Inc. MIT; see
// THIRD_PARTY_NOTICES.md.
/**
 * Gates control interleaving in a replay: the replay parks before the first inbound entry with a
 * gated label until the test releases it, so a test can steer or stop while a turn is
 * mid-stream. They run on the live clock; nothing here is a timer.
 *
 * @module provider/testUtils/replay/replayGate
 */
import { Deferred, Effect } from "effect";

export interface ReplayGate {
  /** Parks while `label` is gated and not released; returns at once for any other label. */
  readonly beforeEmit: (label: string | undefined) => Effect.Effect<void>;
  /** Completes once the replay is parked at (or has passed) `label`. */
  readonly reached: (label: string) => Effect.Effect<void>;
  /** Lets the replay past `label`; false when it was already released. */
  readonly release: (label: string) => Effect.Effect<boolean>;
  /** Releases every label. Harness disposal runs it, so no parked replay outlives a test. */
  readonly releaseAll: Effect.Effect<void>;
}

/** A gate that never parks. */
export const openReplayGate: ReplayGate = {
  beforeEmit: () => Effect.void,
  reached: (label) => Effect.die(new Error(`Replay gate has no label '${label}'.`)),
  release: () => Effect.succeed(false),
  releaseAll: Effect.void,
};

interface GateState {
  readonly reached: Deferred.Deferred<void>;
  readonly released: Deferred.Deferred<void>;
}

/** A gate on `labels`; a duplicate label is a defect. */
export const makeReplayGate = (labels: ReadonlyArray<string>): Effect.Effect<ReplayGate> =>
  Effect.gen(function* () {
    const states = new Map<string, GateState>();
    for (const label of labels) {
      if (states.has(label)) {
        return yield* Effect.die(new Error(`Duplicate replay gate label '${label}'.`));
      }
      states.set(label, {
        reached: yield* Deferred.make<void>(),
        released: yield* Deferred.make<void>(),
      });
    }
    const stateOf = (label: string) => {
      const state = states.get(label);
      return state === undefined
        ? Effect.die(new Error(`Replay gate has no label '${label}'.`))
        : Effect.succeed(state);
    };

    return {
      beforeEmit: (label) => {
        const state = label === undefined ? undefined : states.get(label);
        return state === undefined
          ? Effect.void
          : Deferred.succeed(state.reached, undefined).pipe(
              Effect.andThen(Deferred.await(state.released)),
            );
      },
      reached: (label) =>
        stateOf(label).pipe(Effect.flatMap((state) => Deferred.await(state.reached))),
      release: (label) =>
        stateOf(label).pipe(Effect.flatMap((state) => Deferred.succeed(state.released, undefined))),
      releaseAll: Effect.forEach(
        states.values(),
        (state) => Deferred.succeed(state.released, undefined),
        { discard: true },
      ),
    } satisfies ReplayGate;
  });
