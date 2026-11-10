/**
 * One domain-event subscription for every thread subscription of the server.
 *
 * Each thread subscription used to hold its own subscription to the engine's
 * domain events: every event woke every open thread window on every
 * connection, which then dropped all but its own thread's events, and a
 * subscriber that fell behind the bus read the missed range from the event
 * store on its own. The router holds one subscription per engine, runs while
 * at least one thread subscription is registered, and hands each thread
 * detail event only to that thread's subscribers.
 *
 * Replay boundary: a subscriber that registers when the router has routed
 * events through sequence `L` receives every event routed after that, all
 * above `L`, and every routed event is committed, so it is in the log. A
 * replay bounded by the router's routed sequence at any later moment (`U`,
 * see `routedThrough`) therefore misses nothing: events up to `U` are read
 * from the log, later ones arrive live, and the stream's sequence dedupe drops
 * those sent twice. Before the router routed anything above the snapshot,
 * the replay reads to the end of the log, exactly as a subscription that has
 * seen no live event did.
 *
 * @module threadEventRouter
 */
import type { OrchestrationEvent, OrchestrationGetSnapshotError, ThreadId } from "@ryco/contracts";
import { Effect, Fiber, Scope, Semaphore, Stream } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { isThreadDetailEvent } from "./orchestrationEvents.ts";

export interface ThreadEventSubscriber {
  /** Runs on the router's fiber for each of the thread's detail events; must not wait. */
  readonly onEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, OrchestrationGetSnapshotError>;
  /** The engine's event stream ended or failed: the subscriber must resynchronize. */
  readonly onEnd: Effect.Effect<void>;
}

export interface ThreadEventRegistration {
  /** The highest sequence the router has routed so far (0 before it routed any event). */
  readonly routedThrough: () => number;
}

interface RouterState {
  readonly lock: Semaphore.Semaphore;
  readonly subscribersByThread: Map<string, Set<ThreadEventSubscriber>>;
  subscriberCount: number;
  routedThrough: number;
  fiber: Fiber.Fiber<void> | undefined;
  /** Bumped per start, so a stopped run's finalizer leaves a newer run alone. */
  generation: number;
}

type DomainEventSource = Pick<OrchestrationEngineShape, "subscribeDomainEvents">;

const routers = new WeakMap<DomainEventSource, RouterState>();

/** Subscriptions the routers opened, per engine (tests and diagnostics). */
const startCounts = new WeakMap<DomainEventSource, number>();
export const threadEventRouterStartCount = (engine: DomainEventSource): number =>
  startCounts.get(engine) ?? 0;

const routerFor = (engine: DomainEventSource): RouterState => {
  let state = routers.get(engine);
  if (state === undefined) {
    state = {
      lock: Semaphore.makeUnsafe(1),
      subscribersByThread: new Map(),
      subscriberCount: 0,
      routedThrough: 0,
      fiber: undefined,
      generation: 0,
    };
    routers.set(engine, state);
  }
  return state;
};

const routeEvent = (state: RouterState, event: OrchestrationEvent) =>
  Effect.suspend(() => {
    if (event.sequence > state.routedThrough) state.routedThrough = event.sequence;
    if (event.aggregateKind !== "thread" || !isThreadDetailEvent(event)) return Effect.void;
    const subscribers = state.subscribersByThread.get(event.aggregateId);
    if (subscribers === undefined) return Effect.void;
    // A copy: a subscriber may leave (or a new one join) while this event is handed out.
    return Effect.forEach(
      [...subscribers],
      (subscriber) => subscriber.onEvent(event).pipe(Effect.ignoreCause({ log: true })),
      { discard: true },
    );
  });

const endAll = (state: RouterState) =>
  Effect.suspend(() => {
    const subscribers = [...state.subscribersByThread.values()].flatMap((set) => [...set]);
    return Effect.forEach(subscribers, (subscriber) => subscriber.onEnd, { discard: true });
  });

const start = (engine: DomainEventSource, state: RouterState) =>
  Effect.gen(function* () {
    const events = yield* engine.subscribeDomainEvents;
    // A new run starts after events no subscriber received live: until it
    // routes one, every replay reads to the end of the log.
    state.routedThrough = 0;
    startCounts.set(engine, (startCounts.get(engine) ?? 0) + 1);
    state.generation += 1;
    const generation = state.generation;
    state.fiber = yield* events.pipe(
      Stream.runForEach((event) => routeEvent(state, event)),
      Effect.ignoreCause({ log: true }),
      // The stream ended on its own (never while subscribers remain, normally):
      // every subscriber resynchronizes, and the next registration starts again.
      Effect.andThen(
        state.lock.withPermits(1)(
          Effect.suspend(() => {
            if (state.generation !== generation) return Effect.void;
            state.fiber = undefined;
            return endAll(state);
          }),
        ),
      ),
      Effect.forkDetach,
    );
  });

/**
 * Registers `subscriber` for `threadId`'s detail events for the lifetime of
 * the current scope. The router's subscription opens with the first
 * registration and closes with the last.
 */
export const registerThreadEventSubscriber = (
  engine: DomainEventSource,
  threadId: ThreadId,
  subscriber: ThreadEventSubscriber,
): Effect.Effect<ThreadEventRegistration, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = routerFor(engine);
    yield* Effect.acquireRelease(
      state.lock.withPermits(1)(
        Effect.gen(function* () {
          if (state.fiber === undefined) yield* start(engine, state);
          let subscribers = state.subscribersByThread.get(threadId);
          if (subscribers === undefined) {
            subscribers = new Set();
            state.subscribersByThread.set(threadId, subscribers);
          }
          subscribers.add(subscriber);
          state.subscriberCount += 1;
        }),
      ),
      () =>
        state.lock.withPermits(1)(
          Effect.gen(function* () {
            const subscribers = state.subscribersByThread.get(threadId);
            if (subscribers?.delete(subscriber)) {
              state.subscriberCount -= 1;
              if (subscribers.size === 0) state.subscribersByThread.delete(threadId);
            }
            if (state.subscriberCount > 0 || state.fiber === undefined) return;
            const fiber = state.fiber;
            state.fiber = undefined;
            state.generation += 1;
            yield* Fiber.interrupt(fiber);
          }),
        ),
    );
    return { routedThrough: () => state.routedThrough };
  });
