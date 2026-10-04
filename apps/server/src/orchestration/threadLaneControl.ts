/**
 * The start fence and turn ownership for the provider command reactor's
 * per-thread lanes.
 *
 * The reactor's consumer fiber calls `noteEvent` for every provider-intent
 * event *before* enqueueing it, so a Stop is recorded without waiting behind
 * a busy lane:
 *
 * - A session stop, or a user interrupt without `turnId`, cancels every
 *   start-capable lane item of the thread with a lower fence sequence: the
 *   start running now (through its cancel Deferred) and any queued one
 *   (checked when it begins).
 * - Any user interrupt also cancels in-flight restarts (runtime-mode,
 *   token-mode and goal items). A `turnId`-carrying interrupt never cancels a
 *   later pending turn start, so an agent (whose interrupts always carry a
 *   turn id) can never cancel a user's queued turn.
 * - Provider-originated events (`provider:` command ids) are ignored.
 *
 * A context-handoff lane item *owns a running turn* from the moment it
 * persists `dispatching` until it returns. A user stop or interrupt noted
 * during ownership reports `outOfBand: true`, so the reactor delivers its
 * provider-side action right away instead of queueing it behind the turn.
 *
 * All per-thread state lives in one Ref; every operation is one
 * `Ref.modify`, so registering a start is atomic with noting a stop.
 *
 * @module threadLaneControl
 */
import { type EventId, type OrchestrationEvent, type ThreadId } from "@ryco/contracts";
import { Cause, Deferred, Effect, Option, Ref, Schema } from "effect";

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.token-mode-set"
      | "thread.goal-updated"
      | "thread.goal-cleared"
      | "thread.turn-start-requested"
      | "thread.turn-steer-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

export const START_CANCELLED_DETAIL = "Stopped before the provider session started.";

export class ProviderSessionStartCancelledError extends Schema.TaggedError<ProviderSessionStartCancelledError>()(
  "ProviderSessionStartCancelledError",
  {
    threadId: Schema.String,
    stopSequence: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const isProviderSessionStartCancelled = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) && Schema.is(ProviderSessionStartCancelledError)(reason.error),
  );

/** A start that only the fence can cancel: a turn start, or a session restart. */
export type StartKind = "turn" | "restart";

/** The provider-side result of an out-of-band stop or interrupt. */
export type OutOfBandOutcome =
  | { readonly kind: "interrupted" }
  | { readonly kind: "nothing-live" }
  | {
      readonly kind: "stopped-after-interrupt-failure";
      readonly detail: string;
      readonly stopFailed?: string;
    }
  | { readonly kind: "stopped" }
  | { readonly kind: "stop-failed"; readonly detail: string };

interface StartFence {
  readonly threadId: ThreadId;
  readonly fenceSequence: number;
  readonly kind: StartKind;
}

interface CancelSignal {
  readonly eventId: EventId;
  readonly seq: number;
}

interface LaneState {
  readonly stopAllSeq: number;
  readonly stopAllEventId: EventId | null;
  readonly stopRestartsSeq: number;
  readonly stopRestartsEventId: EventId | null;
  readonly userStopSeq: number;
  readonly userStopEventId: EventId | null;
  readonly currentStart?: {
    readonly fenceSequence: number;
    readonly kind: StartKind;
    readonly cancel: Deferred.Deferred<CancelSignal>;
  };
  readonly owner?: { readonly fenceSequence: number; readonly stopRequested: boolean };
  readonly outOfBand: ReadonlyMap<EventId, Deferred.Deferred<OutOfBandOutcome>>;
  readonly cancelled: ReadonlySet<EventId>;
}

const EMPTY_LANE: LaneState = {
  stopAllSeq: 0,
  stopAllEventId: null,
  stopRestartsSeq: 0,
  stopRestartsEventId: null,
  userStopSeq: 0,
  userStopEventId: null,
  outOfBand: new Map(),
  cancelled: new Set(),
};

export interface ThreadLaneControl {
  /** Consumer-only, before enqueue. Returns whether a provider-side out-of-band action is needed. */
  readonly noteEvent: (
    event: ProviderIntentEvent,
  ) => Effect.Effect<{ readonly outOfBand: boolean }>;
  /**
   * Runs a start that a later stop cancels. Fails at once when a stop was already
   * noted. `effect` must be promptly interruptible (ProviderService starts are
   * detached, so they are).
   */
  readonly guardStart: <A, E, R>(
    at: StartFence,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSessionStartCancelledError, R>;
  /** Fails Cancelled (and records the cancelling event) when a stop already applies. */
  readonly failIfCancelled: (
    at: StartFence,
  ) => Effect.Effect<void, ProviderSessionStartCancelledError>;
  /** Whether a noted stop cancels this start. Records nothing. */
  readonly cancelsStart: (at: StartFence) => Effect.Effect<boolean>;
  /** Consumes the record that this stop/interrupt event cancelled a start. */
  readonly cancelledAStart: (threadId: ThreadId, eventId: EventId) => Effect.Effect<boolean>;
  /** Handoff: fails Cancelled if a user stop/interrupt was noted after the fence; else records ownership. */
  readonly beginTurnOwnership: (
    threadId: ThreadId,
    fenceSequence: number,
  ) => Effect.Effect<void, ProviderSessionStartCancelledError>;
  readonly endTurnOwnership: (threadId: ThreadId) => Effect.Effect<void>;
  /** A user stop or interrupt was noted after the fence (before or during ownership). */
  readonly stopRequestedSince: (
    threadId: ThreadId,
    fenceSequence: number,
  ) => Effect.Effect<boolean>;
  readonly registerOutOfBand: (
    threadId: ThreadId,
    eventId: EventId,
  ) => Effect.Effect<Deferred.Deferred<OutOfBandOutcome>>;
  readonly takeOutOfBand: (
    threadId: ThreadId,
    eventId: EventId,
  ) => Effect.Effect<Option.Option<Deferred.Deferred<OutOfBandOutcome>>>;
  /**
   * Drops the thread's state once nothing is in flight and every noted stop is at
   * or below `processedSequence`. A queued stop always has a higher sequence than
   * any processed item, so pruning never forgets a pending stop.
   */
  readonly prune: (threadId: ThreadId, processedSequence: number) => Effect.Effect<void>;
}

const isProviderOriginated = (event: ProviderIntentEvent): boolean =>
  event.commandId !== null && String(event.commandId).startsWith("provider:");

/** A session stop, or an interrupt that a user (not the provider) requested. */
export const isUserStopIntent = (event: ProviderIntentEvent): boolean =>
  (event.type === "thread.session-stop-requested" ||
    event.type === "thread.turn-interrupt-requested") &&
  !isProviderOriginated(event);

/** The event that cancels a start at `at`, if any. */
function cancellingSignal(lane: LaneState, at: StartFence): CancelSignal | null {
  if (at.kind === "turn") {
    return lane.stopAllSeq > at.fenceSequence && lane.stopAllEventId !== null
      ? { eventId: lane.stopAllEventId, seq: lane.stopAllSeq }
      : null;
  }
  return lane.stopRestartsSeq > at.fenceSequence && lane.stopRestartsEventId !== null
    ? { eventId: lane.stopRestartsEventId, seq: lane.stopRestartsSeq }
    : null;
}

const withCancelled = (lane: LaneState, eventId: EventId): LaneState => ({
  ...lane,
  cancelled: new Set(lane.cancelled).add(eventId),
});

const cancelledError = (threadId: ThreadId, stopSequence: number) =>
  new ProviderSessionStartCancelledError({
    threadId,
    stopSequence,
    detail: START_CANCELLED_DETAIL,
  });

export const makeThreadLaneControl: Effect.Effect<ThreadLaneControl> = Effect.gen(function* () {
  const lanes = yield* Ref.make(new Map<ThreadId, LaneState>());

  const modifyLane = <A>(threadId: ThreadId, f: (lane: LaneState) => readonly [A, LaneState]) =>
    Ref.modify(lanes, (current): [A, Map<ThreadId, LaneState>] => {
      const [result, nextLane] = f(current.get(threadId) ?? EMPTY_LANE);
      const next = new Map(current);
      next.set(threadId, nextLane);
      return [result, next];
    });

  const readLane = (threadId: ThreadId) =>
    Ref.get(lanes).pipe(Effect.map((current) => current.get(threadId) ?? EMPTY_LANE));

  const noteEvent: ThreadLaneControl["noteEvent"] = (event) => {
    if (!isUserStopIntent(event)) return Effect.succeed({ outOfBand: false });
    const threadId = event.payload.threadId;
    const seq = event.sequence;
    const stopsAll =
      event.type === "thread.session-stop-requested" ||
      (event.type === "thread.turn-interrupt-requested" && event.payload.turnId === undefined);
    return modifyLane(threadId, (lane) => {
      let next: LaneState = {
        ...lane,
        stopRestartsSeq: Math.max(lane.stopRestartsSeq, seq),
        stopRestartsEventId: seq >= lane.stopRestartsSeq ? event.eventId : lane.stopRestartsEventId,
        userStopSeq: Math.max(lane.userStopSeq, seq),
        userStopEventId: seq >= lane.userStopSeq ? event.eventId : lane.userStopEventId,
        ...(stopsAll
          ? {
              stopAllSeq: Math.max(lane.stopAllSeq, seq),
              stopAllEventId: seq >= lane.stopAllSeq ? event.eventId : lane.stopAllEventId,
            }
          : {}),
      };
      // Fire the running start when this event cancels it.
      let fire: Deferred.Deferred<CancelSignal> | null = null;
      const start = lane.currentStart;
      if (
        start !== undefined &&
        start.fenceSequence < seq &&
        (stopsAll || start.kind === "restart")
      ) {
        fire = start.cancel;
        next = withCancelled(next, event.eventId);
      }
      let outOfBand = false;
      if (lane.owner !== undefined && seq > lane.owner.fenceSequence) {
        next = { ...next, owner: { ...lane.owner, stopRequested: true } };
        outOfBand = true;
      }
      return [{ fire, outOfBand }, next] as const;
    }).pipe(
      Effect.tap(({ fire }) =>
        fire === null ? Effect.void : Deferred.succeed(fire, { eventId: event.eventId, seq }),
      ),
      Effect.map(({ outOfBand }) => ({ outOfBand })),
    );
  };

  const failIfCancelled: ThreadLaneControl["failIfCancelled"] = (at) =>
    modifyLane(at.threadId, (lane) => {
      const signal = cancellingSignal(lane, at);
      return signal === null
        ? ([null, lane] as const)
        : ([signal, withCancelled(lane, signal.eventId)] as const);
    }).pipe(
      Effect.flatMap((signal) =>
        signal === null ? Effect.void : Effect.fail(cancelledError(at.threadId, signal.seq)),
      ),
    );

  const cancelsStart: ThreadLaneControl["cancelsStart"] = (at) =>
    readLane(at.threadId).pipe(Effect.map((lane) => cancellingSignal(lane, at) !== null));

  const guardStart: ThreadLaneControl["guardStart"] = (at, effect) =>
    Effect.gen(function* () {
      const cancel = yield* Deferred.make<CancelSignal>();
      const cancelled = yield* modifyLane(at.threadId, (lane) => {
        const signal = cancellingSignal(lane, at);
        if (signal !== null) return [signal, withCancelled(lane, signal.eventId)] as const;
        return [
          null,
          { ...lane, currentStart: { fenceSequence: at.fenceSequence, kind: at.kind, cancel } },
        ] as const;
      });
      if (cancelled !== null) {
        return yield* Effect.fail(cancelledError(at.threadId, cancelled.seq));
      }
      const clear = modifyLane(at.threadId, (lane) => {
        if (lane.currentStart?.cancel !== cancel) return [undefined, lane] as const;
        const { currentStart: _cleared, ...rest } = lane;
        return [undefined, rest] as const;
      });
      return yield* effect.pipe(
        Effect.raceFirst(
          Deferred.await(cancel).pipe(
            Effect.flatMap(({ seq }) => Effect.fail(cancelledError(at.threadId, seq))),
          ),
        ),
        Effect.ensuring(clear),
      );
    });

  const cancelledAStart: ThreadLaneControl["cancelledAStart"] = (threadId, eventId) =>
    modifyLane(threadId, (lane) => {
      if (!lane.cancelled.has(eventId)) return [false, lane] as const;
      const cancelled = new Set(lane.cancelled);
      cancelled.delete(eventId);
      return [true, { ...lane, cancelled }] as const;
    });

  const beginTurnOwnership: ThreadLaneControl["beginTurnOwnership"] = (threadId, fenceSequence) =>
    modifyLane(threadId, (lane) => {
      if (lane.userStopSeq > fenceSequence && lane.userStopEventId !== null) {
        const signal = { eventId: lane.userStopEventId, seq: lane.userStopSeq };
        return [signal, withCancelled(lane, signal.eventId)] as const;
      }
      return [null, { ...lane, owner: { fenceSequence, stopRequested: false } }] as const;
    }).pipe(
      Effect.flatMap((signal) =>
        signal === null ? Effect.void : Effect.fail(cancelledError(threadId, signal.seq)),
      ),
    );

  const endTurnOwnership: ThreadLaneControl["endTurnOwnership"] = (threadId) =>
    modifyLane(threadId, (lane) => {
      const { owner: _owner, ...rest } = lane;
      return [undefined, rest] as const;
    });

  const stopRequestedSince: ThreadLaneControl["stopRequestedSince"] = (threadId, fenceSequence) =>
    // noteEvent raises userStopSeq for every user stop, including those that
    // flag the owner, so the sequence alone answers "since the fence".
    readLane(threadId).pipe(Effect.map((lane) => lane.userStopSeq > fenceSequence));

  const registerOutOfBand: ThreadLaneControl["registerOutOfBand"] = (threadId, eventId) =>
    Deferred.make<OutOfBandOutcome>().pipe(
      Effect.tap((outcome) =>
        modifyLane(threadId, (lane) => {
          const outOfBand = new Map(lane.outOfBand);
          outOfBand.set(eventId, outcome);
          return [undefined, { ...lane, outOfBand }] as const;
        }),
      ),
    );

  const takeOutOfBand: ThreadLaneControl["takeOutOfBand"] = (threadId, eventId) =>
    modifyLane(threadId, (lane) => {
      const outcome = lane.outOfBand.get(eventId);
      if (outcome === undefined) return [Option.none(), lane] as const;
      const outOfBand = new Map(lane.outOfBand);
      outOfBand.delete(eventId);
      return [Option.some(outcome), { ...lane, outOfBand }] as const;
    });

  const prune: ThreadLaneControl["prune"] = (threadId, processedSequence) =>
    Ref.update(lanes, (current) => {
      const lane = current.get(threadId);
      if (
        lane === undefined ||
        lane.owner !== undefined ||
        lane.currentStart !== undefined ||
        lane.outOfBand.size > 0 ||
        Math.max(lane.stopAllSeq, lane.stopRestartsSeq, lane.userStopSeq) > processedSequence
      ) {
        return current;
      }
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  return {
    noteEvent,
    guardStart,
    failIfCancelled,
    cancelsStart,
    cancelledAStart,
    beginTurnOwnership,
    endTurnOwnership,
    stopRequestedSince,
    registerOutOfBand,
    takeOutOfBand,
    prune,
  } satisfies ThreadLaneControl;
});
