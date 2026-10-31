/**
 * AgentWorkActivity - whether agents are working on this server, for sleep holds.
 *
 * The one owner of "are agents working". It reads only in-memory state: the engine's command
 * read model (running turns) and the background liveness registry (subagents, workflows,
 * background shells and watch loops that outlive their turn). Consumers hold the machine awake
 * from it: Desktop main through the private desktop pipe (`agentWorkHold.ts`).
 *
 * Every change re-derives the state from that authoritative state instead of folding events, so
 * a missed or reordered trigger cannot drift. The subscription to domain events is taken before
 * the first read and drained from the start (the engine's bus applies back-pressure, so a
 * subscriber that waits before draining would stall the engine), and a reconcile every
 * {@link AGENT_WORK_RECONCILE_INTERVAL_MS} bounds anything a trigger missed.
 *
 * Nothing is reported before the startup command gate opens: startup reconciliation settles
 * turns a previous process left "running", and those must not read as work. A server whose
 * startup failed reports nothing at all, and a failing recompute reports idle. Sleep is allowed
 * whenever this module cannot tell; an update or restart (`interruptible`) is not.
 *
 * One tracker serves the whole process: sleep holds (`agentWorkHold.ts`), the machine-wide busy
 * marker other Ryco processes read, and unattended updates.
 *
 * @module AgentWorkActivity
 */
import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationSession,
  ThreadId,
} from "@ryco/contracts";
import { deriveBackgroundWork } from "@ryco/shared/backgroundWork";
import { derivePendingThreadRequestState } from "@ryco/shared/threadActivity";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { restartCandidateShape } from "./restartContinuationPolicy.ts";
import { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";
import { findThreadInArray } from "./threadIndex.ts";

/** The hold lasts this long after work stops, so chained turns do not drop it between them. */
export const AGENT_WORK_RELEASE_DEBOUNCE_MS = 120_000;
/** Re-derive at least this often, so a missed trigger cannot pin a stale value. */
export const AGENT_WORK_RECONCILE_INTERVAL_MS = 60_000;
/** After a failed recompute, wait this long before the next one. */
const AGENT_WORK_FAILURE_BACKOFF_MS = 5_000;

export interface AgentWorkState {
  /** A turn is running, or background work outlived its turn, right now. */
  readonly working: boolean;
  /**
   * `working`, or it stopped less than {@link AGENT_WORK_RELEASE_DEBOUNCE_MS} ago. Sleep holds
   * follow this value.
   */
  readonly keepAwake: boolean;
}

export const IDLE_AGENT_WORK: AgentWorkState = { working: false, keepAwake: false };

/** The running-turn predicate the projector and provider turn liveness use. */
export function isTurnRunning(session: OrchestrationSession | null): boolean {
  return session !== null && session.status === "running" && session.activeTurnId !== null;
}

/** Any thread that is not deleted or trashed has a running turn, waiting turns included. */
export function hasRunningTurn(readModel: Pick<OrchestrationReadModel, "threads">): boolean {
  return readModel.threads.some(
    (thread) => thread.deletedAt === null && isTurnRunning(thread.session),
  );
}

/**
 * Any thread has live background work that its current runtime reported. The registry alone is
 * not enough: a trashed thread's provider is stopped but its exit is never ingested, and the
 * tasks of a replaced runtime stay recorded until the new runtime reports one. Neither is work.
 */
export function hasLiveBackgroundWork(
  readModel: Pick<OrchestrationReadModel, "threads">,
  liveness: Pick<
    ThreadBackgroundLivenessService["Service"],
    "listLiveThreadIds" | "listLiveTaskIds"
  >,
): boolean {
  return liveness.listLiveThreadIds().some((threadId) => {
    const thread = findThreadInArray(readModel.threads, threadId);
    return (
      thread !== undefined &&
      thread.deletedAt === null &&
      thread.session !== null &&
      liveness.listLiveTaskIds(threadId, thread.session.runtimeSessionId ?? null).length > 0
    );
  });
}

const isRequestActivity = (activity: { readonly kind: string }) =>
  activity.kind === "approval.requested" || activity.kind === "user-input.requested";

/**
 * Work an update or restart would interrupt beyond running turns: a thread whose provider session
 * is starting, or that waits on an approval or a (blocking) question. The server mirror of the
 * client's `INTERRUPTIBLE` rule (`@ryco/client-runtime` `interruptibleTurns.ts`: working,
 * approval, input, connecting); running turns and background work are `keepAwake`'s. Archived,
 * deleted and trashed threads never count, as on the client.
 */
export function hasInterruptibleWork(readModel: Pick<OrchestrationReadModel, "threads">): boolean {
  return readModel.threads.some((thread) => {
    if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
    if (thread.session?.status === "starting") return true;
    // Most threads never asked anything: a scan, before sorting a log that has requests.
    if (!thread.activities.some(isRequestActivity)) return false;
    const pending = derivePendingThreadRequestState(thread.activities);
    return pending.hasPendingApprovals || pending.hasPendingUserInput;
  });
}

const NOTHING_LIVE: ReadonlySet<ThreadId> = new Set<ThreadId>();
const BACKGROUND_WORK_HINT = { hasBackgroundWork: true, recordedAt: "" } as const;

/**
 * Any thread the next start would offer to continue (`RestartContinuation`'s capture, the same
 * `restartCandidateShape` with no session live yet): a session left starting or running, or with
 * an active turn whatever its status, and a settled thread whose current runtime still has
 * background tasks that the shutdown would record (`liveBackgroundThreadIds`, the liveness
 * registry). An unattended restart waits until there is none (`updateWindow.ts`), so it never
 * makes RestartContinuation start a turn nobody asked for.
 */
export function hasRestartContinuationCandidate(
  readModel: Pick<OrchestrationReadModel, "threads">,
  liveBackgroundThreadIds: ReadonlySet<string>,
): boolean {
  return readModel.threads.some((thread) => {
    const hint = liveBackgroundThreadIds.has(thread.id) ? BACKGROUND_WORK_HINT : undefined;
    const shape = restartCandidateShape(thread, NOTHING_LIVE, hint);
    if (shape === null) return false;
    if (shape.kind === "in-flight") return true;
    // As capture: a background-only thread counts only with tasks of its current runtime.
    const work = deriveBackgroundWork(thread.activities, thread.session?.runtimeSessionId);
    return work.tasks.length > 0 || work.detailsOmitted;
  });
}

/**
 * The domain events that can change what the two predicates above answer: `thread.session-set`
 * is the only writer of a thread's session, and deletion, trash and restore change `deletedAt`.
 */
export function isAgentWorkTrigger(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.session-set" ||
    event.type === "thread.deleted" ||
    event.type === "thread.trashed" ||
    event.type === "thread.untrashed"
  );
}

export interface AgentWorkStep {
  readonly state: AgentWorkState;
  /** When the release tail ends, while it runs. */
  readonly releaseAtMs: number | null;
  /** Recompute after this many milliseconds at the latest, to end the tail on time. */
  readonly wakeInMs: number | null;
}

/**
 * One recompute of the release tail. The tail starts at the recompute that first sees work
 * stopped: recomputes run on every change, so that is when the work ended. A wall clock that
 * jumped forward (a system sleep) ends the tail at once; one that jumped back never stretches
 * it past {@link AGENT_WORK_RELEASE_DEBOUNCE_MS}.
 */
export function stepAgentWork(input: {
  readonly working: boolean;
  readonly nowMs: number;
  readonly previous: { readonly working: boolean; readonly releaseAtMs: number | null };
}): AgentWorkStep {
  if (input.working) {
    return { state: { working: true, keepAwake: true }, releaseAtMs: null, wakeInMs: null };
  }
  const releaseAtMs = input.previous.working
    ? input.nowMs + AGENT_WORK_RELEASE_DEBOUNCE_MS
    : input.previous.releaseAtMs;
  if (releaseAtMs === null || releaseAtMs <= input.nowMs) {
    return { state: IDLE_AGENT_WORK, releaseAtMs: null, wakeInMs: null };
  }
  const wakeInMs = Math.min(releaseAtMs - input.nowMs, AGENT_WORK_RELEASE_DEBOUNCE_MS);
  return {
    state: { working: false, keepAwake: true },
    releaseAtMs: input.nowMs + wakeInMs,
    wakeInMs,
  };
}

export interface AgentWorkActivityShape {
  /** The last reported state; idle until the first report. */
  readonly current: Effect.Effect<AgentWorkState>;
  /**
   * The first report (made once the startup command gate is open), then every change. Nothing is
   * emitted before the first report, so a consumer never acts on a placeholder.
   */
  readonly changes: Stream.Stream<AgentWorkState>;
  /**
   * Whether an update or restart would interrupt something now, read from the model at the call
   * (a turn that started a moment ago counts before any report says so): a running turn,
   * background work, {@link hasInterruptibleWork}, or work that stopped (or a recompute that
   * failed) less than {@link AGENT_WORK_RELEASE_DEBOUNCE_MS} ago on the monotonic clock, so a
   * wall clock that moved never shortens or stretches it. True before the first report, when
   * the engine keeps no in-memory model, and when the read fails: whoever cannot tell must not
   * interrupt.
   */
  readonly interruptible: Effect.Effect<boolean>;
  /**
   * {@link interruptible}, or a thread the next start would offer to continue
   * ({@link hasRestartContinuationCandidate}): what a restart of this server must wait for. True
   * whenever `interruptible` is, and when the read fails.
   */
  readonly restartInterruptible: Effect.Effect<boolean>;
}

export class AgentWorkActivity extends Context.Service<AgentWorkActivity, AgentWorkActivityShape>()(
  "ryco/orchestration/AgentWorkActivity",
) {}

/**
 * The domain events that can change agent work, as wake-ups. The subscription is acquired in the
 * caller's fiber, so nothing published after this returns is missed.
 */
const agentWorkTriggers = (
  engine: OrchestrationEngineService["Service"],
): Effect.Effect<Stream.Stream<void>, never, Scope.Scope> =>
  engine.subscribeDomainEvents.pipe(
    Effect.map((events) =>
      events.pipe(
        Stream.filter(isAgentWorkTrigger),
        Stream.map(() => undefined),
      ),
    ),
  );

/** Whether two reports say the same; consumers report only changes. */
export const sameAgentWorkState = (left: AgentWorkState, right: AgentWorkState): boolean =>
  left.working === right.working && left.keepAwake === right.keepAwake;

export const makeAgentWorkActivity = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const liveness = yield* ThreadBackgroundLivenessService;
  const startup = yield* Effect.serviceOption(ServerRuntimeStartup);
  // `null` until the first report.
  const published = yield* SubscriptionRef.make<AgentWorkState | null>(null);
  // Wake-ups coalesce: one pending wake-up covers any number of changes, and offering never blocks.
  const wake = yield* Queue.sliding<void>(1);
  const signal = () => {
    Queue.offerUnsafe(wake, undefined);
  };

  // Subscribe before the first read, and drain from the start without waiting on anything.
  const triggers = yield* agentWorkTriggers(engine);
  yield* triggers.pipe(
    Stream.runForEach(() => Effect.sync(signal)),
    Effect.forkScoped,
  );
  const stopListening = liveness.onLiveThreadsChange(signal);
  yield* Effect.addFinalizer(() => Effect.sync(stopListening));

  if (engine.getReadModel === undefined) {
    yield* Effect.logDebug(
      "agent work: the engine exposes no in-memory model; turns count as idle",
    );
  }
  let previous: { working: boolean; releaseAtMs: number | null } = {
    working: false,
    releaseAtMs: null,
  };
  // When a recompute last saw work, saw it stop, or failed: `interruptible`'s tail, monotonic.
  let workSeenAtNanos: bigint | null = null;
  const noteWorkSeen = Effect.map(Clock.monotonicTimeNanos, (now) => {
    workSeenAtNanos = now;
  });

  const publish = (state: AgentWorkState) =>
    SubscriptionRef.get(published).pipe(
      Effect.flatMap((current) =>
        current !== null && sameAgentWorkState(current, state)
          ? Effect.void
          : SubscriptionRef.set(published, state),
      ),
    );

  const recompute = Effect.gen(function* () {
    // Only the engine's in-memory model: never a SQL read, so a recompute stays microseconds.
    const model = engine.getReadModel === undefined ? null : yield* engine.getReadModel();
    const working =
      model !== null && (hasRunningTurn(model) || hasLiveBackgroundWork(model, liveness));
    if (working || previous.working) yield* noteWorkSeen;
    const nowMs = yield* Clock.currentTimeMillis;
    const step = stepAgentWork({ working, nowMs, previous });
    previous = { working, releaseAtMs: step.releaseAtMs };
    yield* publish(step.state);
    return step.wakeInMs;
  });

  let failureLogged = false;
  const recomputeOrIdle = recompute.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        failureLogged = false;
      }),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.gen(function* () {
            if (!failureLogged) {
              failureLogged = true;
              yield* Effect.logError("agent work: recompute failed; reporting idle", {
                cause: Cause.pretty(cause),
              });
            }
            previous = { working: false, releaseAtMs: null };
            yield* noteWorkSeen;
            yield* publish(IDLE_AGENT_WORK);
            // Retry soon, or at the next change; triggers are state changes, never progress.
            return AGENT_WORK_FAILURE_BACKOFF_MS;
          }),
    ),
  );

  // One recompute, then wait for a wake-up, the end of the release tail, or the reconcile.
  const iteration = recomputeOrIdle.pipe(
    Effect.flatMap((wakeInMs) =>
      Queue.take(wake).pipe(
        Effect.timeoutOption(
          Duration.millis(
            Math.min(
              wakeInMs ?? AGENT_WORK_RECONCILE_INTERVAL_MS,
              AGENT_WORK_RECONCILE_INTERVAL_MS,
            ),
          ),
        ),
      ),
    ),
  );
  const startupReady = Option.isSome(startup) ? startup.value.awaitCommandReady : Effect.void;
  yield* Effect.forkScoped(
    startupReady.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("agent work: startup failed; not reporting agent work", {
                cause: Cause.pretty(cause),
              }),
        onSuccess: () => Effect.forever(iteration),
      }),
    ),
  );

  const readModel = engine.getReadModel;
  const tailNanos = BigInt(AGENT_WORK_RELEASE_DEBOUNCE_MS) * 1_000_000n;
  const interruptible = Effect.gen(function* () {
    if (readModel === undefined || (yield* SubscriptionRef.get(published)) === null) return true;
    const model = yield* readModel();
    // `previous.working`: work stopped since the last recompute, which has yet to start the tail.
    if (previous.working || hasRunningTurn(model) || hasLiveBackgroundWork(model, liveness)) {
      return true;
    }
    const now = yield* Clock.monotonicTimeNanos;
    if (workSeenAtNanos !== null && now - workSeenAtNanos < tailNanos) return true;
    return hasInterruptibleWork(model);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(true),
    ),
  );
  const restartInterruptible = Effect.gen(function* () {
    if (readModel === undefined || (yield* interruptible)) return true;
    const model = yield* readModel();
    return hasRestartContinuationCandidate(model, new Set(liveness.listLiveThreadIds()));
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(true),
    ),
  );
  return {
    current: SubscriptionRef.get(published).pipe(Effect.map((state) => state ?? IDLE_AGENT_WORK)),
    interruptible,
    restartInterruptible,
    changes: SubscriptionRef.changes(published).pipe(
      Stream.filter((state): state is AgentWorkState => state !== null),
    ),
  } satisfies AgentWorkActivityShape;
});

export const AgentWorkActivityLive = Layer.effect(AgentWorkActivity, makeAgentWorkActivity);
