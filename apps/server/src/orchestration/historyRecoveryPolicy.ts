/**
 * historyRecoveryPolicy - When provider history recovery reads a thread.
 *
 * Recovery runs when a client opens a thread and when the watched thread's
 * session settles (a turn ended, the session stopped or failed), never on a
 * timer. Reads are spaced per thread, and a failing thread backs off.
 *
 * @module historyRecoveryPolicy
 */
import type { OrchestrationEvent, ThreadId } from "@ryco/contracts";
import { Effect, type Scope, Stream } from "effect";

import type { HistoryRecoveryTrigger } from "./Services/ProviderRuntimeIngestion.ts";

/** After an attempt, reopening the thread reads again only after this long. */
export const HISTORY_RECOVERY_SUBSCRIBE_SPACING_MS = 5 * 60_000;
/** After an attempt, a settled session reads again only after this long. */
export const HISTORY_RECOVERY_SETTLED_SPACING_MS = 30_000;
/** The first retry after a failure; each further failure doubles it, up to the max. */
export const HISTORY_RECOVERY_FAILURE_BACKOFF_MS = 30_000;
export const HISTORY_RECOVERY_FAILURE_BACKOFF_MAX_MS = 15 * 60_000;

export interface HistoryRecoveryState {
  readonly attemptedAt: number;
  /** Consecutive failed attempts; 0 after a success. */
  readonly failures: number;
}

/** The gap a trigger must leave after the thread's last attempt. */
export function historyRecoverySpacingMs(
  state: HistoryRecoveryState,
  trigger: HistoryRecoveryTrigger,
): number {
  if (state.failures > 0) {
    return Math.min(
      HISTORY_RECOVERY_FAILURE_BACKOFF_MS * 2 ** (state.failures - 1),
      HISTORY_RECOVERY_FAILURE_BACKOFF_MAX_MS,
    );
  }
  return trigger === "subscribe"
    ? HISTORY_RECOVERY_SUBSCRIBE_SPACING_MS
    : HISTORY_RECOVERY_SETTLED_SPACING_MS;
}

/** A thread event saying its session stopped working: a turn ended, or it stopped or failed. */
export function settlesThreadSession(event: OrchestrationEvent | undefined): boolean {
  if (event?.type !== "thread.session-set") return false;
  const session = event.payload.session;
  return (
    session.activeTurnId === null &&
    (session.status === "ready" || session.status === "stopped" || session.status === "error")
  );
}

/** A thread subscription item: a snapshot, a resume marker or one event. */
export interface ThreadStreamItemLike {
  readonly kind: string;
  readonly event?: OrchestrationEvent;
}

/** Turns one thread subscription's history recovery on (`"active"`) or off (`"passive"`). */
export interface ThreadHistoryRecoveryControl {
  readonly setMode: (mode: "active" | "passive") => Effect.Effect<void>;
}

/** How many threads' latest mode changes a connection remembers for in-flight subscriptions. */
const MAX_REMEMBERED_HISTORY_RECOVERY_MODES = 64;

/**
 * One connection's thread subscriptions, by thread, so a mode change reaches
 * every subscription of that thread on the connection.
 *
 * A subscription's own request carries the mode the client wanted when it
 * sent it. A change the client sent after that request can still reach the
 * server before the subscription has registered (requests run concurrently),
 * so each thread's latest change is remembered in arrival order: a
 * subscription adopts it only when it arrived after the subscription's own
 * request. A change older than the request (one meant for a subscription that
 * has since ended, say) never overrides the mode the request carries.
 */
export const makeThreadHistoryRecoveryRegistry = () => {
  const controls = new Map<ThreadId, Set<ThreadHistoryRecoveryControl>>();
  const latestChanges = new Map<
    ThreadId,
    { readonly mode: "active" | "passive"; readonly order: number }
  >();
  // Orders subscription requests and mode changes by arrival.
  let arrivals = 0;
  return {
    /**
     * Call when the subscription request arrives (the handler builds its
     * stream then); the returned registration runs once the stream starts.
     */
    register: (threadId: ThreadId) => {
      const requestOrder = ++arrivals;
      return (control: ThreadHistoryRecoveryControl): Effect.Effect<void, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const threadControls = controls.get(threadId) ?? new Set();
            threadControls.add(control);
            controls.set(threadId, threadControls);
            const change = latestChanges.get(threadId);
            return change !== undefined && change.order > requestOrder ? change.mode : null;
          }),
          () =>
            Effect.sync(() => {
              const threadControls = controls.get(threadId);
              threadControls?.delete(control);
              if (threadControls?.size === 0) controls.delete(threadId);
            }),
        ).pipe(Effect.flatMap((mode) => (mode === null ? Effect.void : control.setMode(mode))));
    },
    setMode: (threadId: ThreadId, mode: "active" | "passive"): Effect.Effect<void> =>
      Effect.suspend(() => {
        // Bounded: a client cannot grow this by naming threads it never opens.
        latestChanges.delete(threadId);
        latestChanges.set(threadId, { mode, order: ++arrivals });
        if (latestChanges.size > MAX_REMEMBERED_HISTORY_RECOVERY_MODES) {
          const oldest = latestChanges.keys().next();
          if (!oldest.done) latestChanges.delete(oldest.value);
        }
        const threadControls = controls.get(threadId);
        if (threadControls === undefined) return Effect.void;
        return Effect.forEach([...threadControls], (control) => control.setMode(mode), {
          discard: true,
        });
      }),
  };
};

/**
 * Wraps a thread subscription with history recovery: one read when it opens,
 * then one whenever the watched session settles. The reads run in the
 * subscription's scope, so they end with it. The stream's arrays pass through
 * whole: a per-item tap would re-emit them one item at a time, which costs a
 * frame (and a transport ack) per event.
 *
 * A passive subscription (a sidebar prewarm, a retained idle thread) reads
 * nothing until `register`'s control turns it active, which then reads as an
 * opening subscription would; turned passive again, it stops reading.
 */
export const withThreadHistoryRecovery = <A extends ThreadStreamItemLike, E, R>(
  threadId: ThreadId,
  stream: Stream.Stream<A, E, R>,
  reconcile: (threadId: ThreadId, trigger: HistoryRecoveryTrigger) => Effect.Effect<void>,
  options: {
    readonly mode?: "active" | "passive";
    /** Receives the subscription's control; runs in its scope, so it can release with it. */
    readonly register?: (
      control: ThreadHistoryRecoveryControl,
    ) => Effect.Effect<void, never, Scope.Scope>;
  } = {},
): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      let active = options.mode !== "passive";
      const readOnOpen = Effect.forkIn(reconcile(threadId, "subscribe"), scope).pipe(Effect.asVoid);
      if (active) yield* readOnOpen;
      if (options.register !== undefined) {
        yield* options.register({
          setMode: (mode) =>
            Effect.suspend(() => {
              const turnedActive = mode === "active" && !active;
              active = mode === "active";
              return turnedActive ? readOnOpen : Effect.void;
            }),
        });
      }
      return stream.pipe(
        Stream.mapArrayEffect((items) =>
          active && items.some((item) => item.kind === "event" && settlesThreadSession(item.event))
            ? Effect.forkIn(reconcile(threadId, "session-settled"), scope).pipe(Effect.as(items))
            : Effect.succeed(items),
        ),
      );
    }),
  );
