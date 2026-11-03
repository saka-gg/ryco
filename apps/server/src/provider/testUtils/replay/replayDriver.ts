// Partly adapted from pingdotgg/t3code packages/effect-codex-app-server/src/replay.ts
// (91992bd5d464d6a01b2a5c1e7926e68ad09ea40e). Copyright (c) 2026 T3 Tools Inc. MIT; see
// THIRD_PARTY_NOTICES.md.
/**
 * Plays one transcript segment over a transport. The line-JSON peer (`replayPeer.ts`) and the
 * Claude SDK query (`claudeReplayQuery.ts`) both run this driver, so every replay parks, matches,
 * fails and reports the same way. A transport only says how an inbound entry reaches the client
 * (`deliver`), how the process ends (`finish`) and how it dies on a failure (`onFail`).
 *
 * One fiber owns the replay: it delivers inbound entries (parking at gates) until the transcript
 * expects an outbound frame, then matches the next item the client wrote. Items written while the
 * replay is parked wait their turn, as they would in a real pipe.
 *
 * @module provider/testUtils/replay/replayDriver
 */
import { Deferred, Effect, Option, Queue, type Scope } from "effect";

import type { ReplayGate } from "./replayGate.ts";
import {
  ReplayIncompleteError,
  type ReplayCursor,
  type ReplayError,
  type ReplayInboundStep,
} from "./replayMatch.ts";

export type ReplayEmitStep = ReplayInboundStep & { readonly type: "emit" };
export type ReplayExitStep = ReplayInboundStep & { readonly type: "exit" };

export interface ReplayCursorRunOptions<Item> {
  readonly cursor: ReplayCursor;
  readonly scenario: string;
  /** 1-based process number, for errors. */
  readonly spawn: number;
  /** Names the process in positions: `spawn #2`, `query #2`. */
  readonly name: string;
  readonly gate: ReplayGate;
  /** Completed with the first failure; the processes of one replay share it. */
  readonly failure: Deferred.Deferred<ReplayError>;
  /** What the client wrote, in order. */
  readonly outbound: Queue.Dequeue<Item>;
  readonly frameOf: (item: Item) => unknown;
  /** The transport's state, read on every step: `running` while the process takes entries. */
  readonly state: () => string;
  /** Hands an inbound entry to the client; fails when the entry cannot be delivered. */
  readonly deliver: (step: ReplayEmitStep) => Effect.Effect<void, ReplayError>;
  /** Ends the process as the transcript recorded; fails when the exit is a replay failure. */
  readonly finish: (step: ReplayExitStep) => Effect.Effect<void, ReplayError>;
  /** Told how each outbound item matched, after a mismatch was recorded. */
  readonly matched?: (item: Item, error: ReplayError | undefined) => void;
  /** Stops the transport on a failure, as a dying process does; runs for every failure. */
  readonly onFail: (error: ReplayError) => Effect.Effect<void>;
}

export interface ReplayCursorRun {
  /** Records a failure (the first one wins), completes `failure` and stops the transport. */
  readonly fail: (error: ReplayError) => Effect.Effect<void>;
  /** Fails with this process's failure, or with the entries the scenario never reached. */
  readonly assertConsumed: Effect.Effect<void, ReplayError>;
  /** Where the replay stands, for timeouts. */
  readonly describePosition: () => string;
}

/** Starts the replay fiber in the current scope. */
export const runReplayCursor = <Item>(
  options: ReplayCursorRunOptions<Item>,
): Effect.Effect<ReplayCursorRun, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { cursor, scenario, spawn, gate, outbound, state } = options;
    // The loops below read state other fibers and callbacks change, so they read it through
    // functions.
    const running = () => state() === "running";
    let ownFailure: ReplayError | undefined;
    const failed = () => ownFailure !== undefined;
    let parkedAt: string | undefined;

    const fail = (error: ReplayError) =>
      Effect.gen(function* () {
        ownFailure ??= error;
        yield* Deferred.succeed(options.failure, error);
        yield* options.onFail(error);
      });

    const drainInbound = Effect.gen(function* () {
      while (running()) {
        const step = cursor.peekInbound();
        if (step === undefined) return;
        if (step.type === "exit") {
          cursor.takeInbound();
          return yield* options.finish(step);
        }
        parkedAt = step.label;
        yield* gate.beforeEmit(step.label);
        parkedAt = undefined;
        // Stopped while parked: the entry was never delivered.
        if (!running()) return;
        cursor.takeInbound();
        yield* options.deliver(step);
      }
    }).pipe(Effect.catch(fail));

    const match = (item: Item) =>
      Effect.gen(function* () {
        const error = cursor.matchOutbound(options.frameOf(item));
        if (error !== undefined) yield* fail(error);
        options.matched?.(item, error);
      });

    yield* Effect.gen(function* () {
      while (!failed()) {
        yield* drainInbound;
        yield* match(yield* Queue.take(outbound));
      }
    }).pipe(Effect.forkScoped);
    // Added after the fork, so it runs before the replay fiber is interrupted: an item the
    // client wrote while stopping is still matched (an armed optional entry) or reported, even
    // when the fiber was not scheduled to take it before the scope closed.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        while (!failed()) {
          const item = yield* Queue.poll(outbound);
          if (Option.isNone(item)) return;
          yield* match(item.value);
        }
      }),
    );

    const describePosition = () => {
      const where = `replay '${scenario}' ${options.name}`;
      if (ownFailure !== undefined) return `${where}: failed with ${ownFailure._tag}`;
      if (parkedAt !== undefined) return `${where}: parked at gate '${parkedAt}'`;
      const waiting = cursor.describeWaiting();
      const current = state();
      return current === "running" ? `${where}: ${waiting}` : `${where}: ${current} at ${waiting}`;
    };

    const assertConsumed = Effect.gen(function* () {
      if (ownFailure !== undefined) return yield* ownFailure;
      const remainingLabels = cursor.remainingLabels();
      if (remainingLabels.length > 0) {
        return yield* new ReplayIncompleteError({
          scenario,
          spawn,
          cursor: cursor.position(),
          remainingLabels: [...remainingLabels],
        });
      }
    });

    return { fail, assertConsumed, describePosition } satisfies ReplayCursorRun;
  });
