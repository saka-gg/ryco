/**
 * The goal continuation runtime (rules in `goalContinuation.ts`), loaded behind `import()` by
 * `GoalContinuationLive` once commands are ready.
 *
 * State is in memory on purpose: a continuation follows only a turn this process saw end, so a
 * restart forgets nothing it should act on. Each finished turn yields at most one continuation
 * (its command id is derived from the turn, and the receipt dedupes a replay).
 *
 * @module goalContinuationRuntime
 */
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ProviderDriverKind,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import { applicableUsageLimit } from "@ryco/shared/usageLimit";
import { Cause, Clock, Effect, Exit, Option, Stream } from "effect";

import { agentControlSupportForDriver } from "../agentControl/ProviderInjection.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationDispatchError } from "./Errors.ts";
import type { ServerWakeFenceShape } from "./Services/ServerWakeFence.ts";
import {
  GOAL_CHAIN_PAUSE_NOTICE,
  GOAL_CONTINUATION_GRACE_MS,
  GOAL_CONTINUATION_MAX_CHAIN,
  goalContinuationIds,
  goalContinuationPrompt,
  goalContinuationSourceTurn,
  goalPausingFailedTurn,
  pursuesGoal,
} from "./goalContinuation.ts";
import { isUserOriginatedCommandId } from "./commandOrigin.ts";
import { serverWakeGuard } from "./serverWake.ts";
import {
  buildThreadContinuationTurnStart,
  type ClientThreadTurnStartCommand,
} from "./threadContinuation.ts";
import { isThreadWaitWakeEvent } from "./threadWaitWakeEvents.ts";

/** Failed dispatches (not rejections) of one continuation before the goal pauses. */
const MAX_DISPATCH_FAILURES = 3;
/** How often a held continuation is looked at again when no event arrives. */
const HELD_RECHECK_MS = 5_000;
/** The wait after the first failed dispatch; each further failure waits four times longer. */
const DISPATCH_RETRY_MS = 5_000;
/** The shortest pause between passes, so a due candidate can never spin the loop. */
const MIN_PASS_DELAY_MS = 250;

export interface GoalContinuationDeps {
  readonly readShell: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;
  readonly fence: ServerWakeFenceShape;
  /** Client command application: the continuation is a guarded turn start like a person's. */
  readonly apply: (
    command: ClientThreadTurnStartCommand,
  ) => Effect.Effect<unknown, OrchestrationDispatchCommandError>;
  /** Internal commands (goal sync, activities). */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, OrchestrationDispatchError>;
  readonly agentControlEnabled: Effect.Effect<boolean>;
  /** Turns that ended before this time never continue (the process start). */
  readonly observedSinceMs: number;
}

interface Candidate {
  /** `continue`: start the next turn after `turnId`. `pause`: pause after the failed `turnId`. */
  readonly kind: "continue" | "pause";
  readonly turnId: TurnId;
  /** When the fence first let a continuation through, or the failure was first seen. */
  readySinceMs: number | null;
  /** When to look again if no event touches the thread first. */
  retryAtMs: number;
  /** After a failed dispatch: no new attempt before this, whatever events arrive. */
  backoffUntilMs: number;
  failures: number;
}

/** A continuation the decider accepted, until its turn starts or its start fails. */
interface SentContinuation {
  readonly sourceTurnId: TurnId;
  readonly messageId: MessageId;
}

/** A decider rejection settles the attempt; anything else may be retried. */
const isSettledRejection = (error: unknown): boolean => {
  const cause =
    error !== null && typeof error === "object" && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  const tag = (value: unknown) =>
    value !== null && typeof value === "object" && "_tag" in value
      ? (value as { readonly _tag?: unknown })._tag
      : undefined;
  const settled = (value: unknown) =>
    tag(value) === "OrchestrationCommandInvariantError" ||
    tag(value) === "OrchestrationCommandPreviouslyRejectedError";
  return settled(error) || settled(cause);
};

export const makeGoalContinuation = (deps: GoalContinuationDeps) => {
  const candidates = new Map<ThreadId, Candidate>();
  /** Continuations sent in a row per thread; a turn start that is not a server wake resets it. */
  const chains = new Map<ThreadId, number>();
  /**
   * The continuation each thread was last sent. Until its turn starts the shell still shows the
   * finished turn: the fence's pending-start rule holds it, this keeps it from being sent twice,
   * and a start that fails pauses the goal.
   */
  const sent = new Map<ThreadId, SentContinuation>();
  /** Threads read without a goal; only a goal update gives them one. Spares a read per event. */
  const goalless = new Set<ThreadId>();
  const dirty = new Set<ThreadId>();
  /** A person's Stop per thread, keyed by its event, so every Stop pauses on its own. */
  const stopped = new Map<ThreadId, string>();

  const forget = (threadId: ThreadId) => {
    candidates.delete(threadId);
    chains.delete(threadId);
    sent.delete(threadId);
  };

  /**
   * Whether the agent can end the loop itself: Agent Control is on and the thread's provider
   * gets the private tools (`ryco_update_thread`). Without them it would never stop.
   */
  const agentCanReport = (shell: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const driver = shell.session?.providerName ?? null;
      if (driver === null) return false;
      if (!agentControlSupportForDriver(driver as ProviderDriverKind).supported) return false;
      return yield* deps.agentControlEnabled;
    });

  /**
   * Pauses a goal the server pursues. Pinned to the goal's current sync request, so a person's
   * edit that is still being confirmed wins (the sync is rejected).
   */
  const pause = (
    shell: OrchestrationThreadShell,
    key: string,
    nowMs: number,
    notice?: { readonly summary: string; readonly detail: string },
  ) =>
    Effect.gen(function* () {
      const goal = shell.goal;
      if (!goal) return;
      const createdAt = new Date(nowMs).toISOString();
      const commandId = `goal-pause:${shell.id}:${key}`;
      const paused = yield* Effect.exit(
        deps.dispatch({
          type: "thread.goal.sync",
          commandId: CommandId.make(commandId),
          threadId: shell.id,
          ...(goal.synchronization === undefined
            ? {}
            : { expectedRequestId: goal.synchronization.requestId }),
          goal: { ...goal, status: "paused", updatedAt: createdAt },
          createdAt,
        }),
      );
      if (Exit.isFailure(paused)) {
        if (Cause.hasInterruptsOnly(paused.cause)) return yield* Effect.interrupt;
        return yield* Effect.logInfo("goal continuation could not pause a goal", {
          threadId: shell.id,
          cause: Cause.pretty(paused.cause),
        });
      }
      if (notice === undefined) return;
      yield* deps
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`${commandId}:notice`),
          threadId: shell.id,
          activity: {
            id: EventId.make(`${commandId}:notice`),
            tone: "info",
            kind: "goal.paused",
            summary: notice.summary,
            payload: { detail: notice.detail },
            turnId: shell.latestTurn?.turnId ?? null,
            createdAt,
          },
          createdAt,
        })
        .pipe(Effect.ignore);
    });

  type Attempt = "sent" | "rejected" | "failed" | "held";

  const dispatchContinuation = (shell: OrchestrationThreadShell, turnId: TurnId, nowMs: number) =>
    Effect.gen(function* () {
      const threadId = shell.id;
      // The pin first, then the idle check: a person's message accepted after the pin fails the
      // decider's guard, and one accepted before it shows as a pending start here.
      const latestUserMessageId = yield* deps.fence.latestUserMessageId(threadId);
      if ((yield* deps.fence.holdReason(shell, nowMs, "goal-continuation")) !== null) {
        return "held" as Attempt;
      }
      const { cold, budgetFull } = yield* deps.fence.coldStart(threadId, nowMs);
      if (cold && budgetFull) return "held" as Attempt;
      const ids = goalContinuationIds(threadId, turnId);
      const messageId = MessageId.make(ids.messageId);
      let reserved = false;
      let accepted = false;
      return yield* Effect.gen(function* () {
        if (cold) {
          reserved = yield* deps.fence.reserveColdSlot(threadId, messageId, nowMs);
          if (!reserved) return "held" as Attempt;
        }
        // Last before the dispatch: a journal read per attempt, never per held look.
        if (yield* deps.fence.reverting(threadId, nowMs)) return "held" as Attempt;
        const command = buildThreadContinuationTurnStart(shell, {
          commandId: CommandId.make(ids.commandId),
          messageId,
          text: goalContinuationPrompt(threadId),
          createdAt: new Date(nowMs).toISOString(),
          guards: {
            delegationReturnGuard: serverWakeGuard(shell, latestUserMessageId, "goal-continuation"),
          },
        });
        const exit = yield* Effect.exit(deps.apply(command));
        if (Exit.isSuccess(exit)) {
          accepted = true;
          sent.set(threadId, { sourceTurnId: turnId, messageId });
          if (cold) yield* deps.fence.noteColdWake(threadId, messageId, nowMs);
          return "sent" as Attempt;
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isSome(error) && isSettledRejection(error.value)) return "rejected" as Attempt;
        yield* Effect.logWarning("goal continuation dispatch failed", {
          threadId,
          cause: Cause.pretty(exit.cause),
        });
        return "failed" as Attempt;
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            reserved && !accepted ? deps.fence.releaseColdSlot(threadId, messageId) : Effect.void,
          ),
        ),
      );
    });

  const candidateFor = (threadId: ThreadId, kind: Candidate["kind"], turnId: TurnId) => {
    const current = candidates.get(threadId);
    if (current?.kind === kind && current.turnId === turnId) return current;
    const next: Candidate = {
      kind,
      turnId,
      readySinceMs: null,
      retryAtMs: 0,
      backoffUntilMs: 0,
      failures: 0,
    };
    candidates.set(threadId, next);
    return next;
  };

  const evaluate = (threadId: ThreadId, nowMs: number) =>
    Effect.gen(function* () {
      const read = yield* deps.readShell(threadId);
      if (Option.isNone(read)) return forget(threadId);
      const shell = read.value;
      if (shell.goal == null) {
        goalless.add(threadId);
        return forget(threadId);
      }
      if (!pursuesGoal(shell) || !(yield* agentCanReport(shell))) {
        candidates.delete(threadId);
        sent.delete(threadId);
        return;
      }

      // A continuation the decider accepted whose start then failed (or a Stop cancelled it)
      // leaves no turn behind: pause, so the goal does not sit there looking active.
      const last = sent.get(threadId);
      if (last !== undefined && shell.latestTurn?.turnId === last.sourceTurnId) {
        if ((yield* deps.fence.wakeStartState(threadId, last.messageId)) === "failed") {
          sent.delete(threadId);
          candidates.delete(threadId);
          return yield* pause(shell, `start-failed:${last.sourceTurnId}`, nowMs);
        }
      }

      // A failed turn pauses the goal after the grace, re-read: a usage limit is recorded just
      // after the turn ends, and then the limit's own resume carries on instead.
      const failedTurn = goalPausingFailedTurn(shell, {
        observedSinceMs: deps.observedSinceMs,
        usageLimited: applicableUsageLimit(shell) !== null,
      });
      if (failedTurn !== null) {
        const candidate = candidateFor(threadId, "pause", failedTurn);
        candidate.readySinceMs ??= nowMs;
        candidate.retryAtMs = candidate.readySinceMs + GOAL_CONTINUATION_GRACE_MS;
        if (nowMs < candidate.retryAtMs) return;
        candidates.delete(threadId);
        return yield* pause(shell, `failed:${failedTurn}`, nowMs);
      }

      const turnId = goalContinuationSourceTurn(shell, deps.observedSinceMs);
      if (turnId === null || turnId === last?.sourceTurnId) {
        candidates.delete(threadId);
        return;
      }
      const candidate = candidateFor(threadId, "continue", turnId);
      if (nowMs < candidate.backoffUntilMs) {
        candidate.retryAtMs = candidate.backoffUntilMs;
        return;
      }
      if ((yield* deps.fence.holdReason(shell, nowMs, "goal-continuation")) !== null) {
        candidate.readySinceMs = null;
        candidate.retryAtMs = nowMs + HELD_RECHECK_MS;
        return;
      }
      candidate.readySinceMs ??= nowMs;
      if (nowMs < candidate.readySinceMs + GOAL_CONTINUATION_GRACE_MS) {
        candidate.retryAtMs = candidate.readySinceMs + GOAL_CONTINUATION_GRACE_MS;
        return;
      }
      if ((chains.get(threadId) ?? 0) >= GOAL_CONTINUATION_MAX_CHAIN) {
        candidates.delete(threadId);
        return yield* pause(shell, `chain:${turnId}`, nowMs, GOAL_CHAIN_PAUSE_NOTICE);
      }
      const attempt = yield* dispatchContinuation(shell, turnId, nowMs);
      switch (attempt) {
        case "held":
          candidate.retryAtMs = nowMs + HELD_RECHECK_MS;
          return;
        case "sent":
          chains.set(threadId, (chains.get(threadId) ?? 0) + 1);
          candidates.delete(threadId);
          return;
        case "rejected":
          // The thread moved on (a message, an edit, a limit): its next clean turn decides again.
          candidates.delete(threadId);
          return;
        case "failed":
          candidate.failures += 1;
          if (candidate.failures >= MAX_DISPATCH_FAILURES) {
            candidates.delete(threadId);
            return yield* pause(shell, `dispatch:${turnId}`, nowMs);
          }
          candidate.backoffUntilMs = nowMs + DISPATCH_RETRY_MS * 4 ** (candidate.failures - 1);
          candidate.retryAtMs = candidate.backoffUntilMs;
          return;
      }
    });

  /** A person's Stop pauses the goal, so their next message does not quietly restart the loop. */
  const pauseAfterStop = (threadId: ThreadId, stopKey: string, nowMs: number) =>
    Effect.gen(function* () {
      candidates.delete(threadId);
      const read = yield* deps.readShell(threadId);
      if (Option.isNone(read)) return;
      const shell = read.value;
      if (!pursuesGoal(shell) || !(yield* agentCanReport(shell))) return;
      yield* pause(shell, `stop:${stopKey}`, nowMs);
    });

  /** Event intake: synchronous and I/O-free, so the event feed never waits on it. */
  const observe = (event: OrchestrationEvent): boolean => {
    if (event.aggregateKind !== "thread") return false;
    const threadId = event.aggregateId as ThreadId;
    switch (event.type) {
      case "thread.turn-start-requested":
        // A person's or an agent's own message starts a fresh run of automatic turns, also when
        // the thread's follow-up queue sends it; other server wakes (delegated results, pull
        // request updates, continuations) do not.
        if (
          event.payload.delegationReturnGuard === undefined ||
          event.payload.delegationReturnGuard.source === "follow-up-queue"
        ) {
          chains.delete(threadId);
        }
        return false;
      case "thread.goal-updated":
        goalless.delete(threadId);
        // A person's resume or edit starts a fresh run of automatic turns.
        if (event.payload.origin === "client") chains.delete(threadId);
        dirty.add(threadId);
        return true;
      case "thread.goal-cleared":
        goalless.add(threadId);
        forget(threadId);
        return false;
      case "thread.deleted":
        goalless.delete(threadId);
        forget(threadId);
        return false;
      case "thread.turn-interrupt-requested":
      case "thread.session-stop-requested":
        // Agent Control interrupts and the node's own stops do not count as a person's Stop.
        if (goalless.has(threadId) || event.commandId === null) return false;
        if (!isUserOriginatedCommandId(event.commandId)) return false;
        stopped.set(threadId, event.eventId);
        return true;
      default:
        if (goalless.has(threadId) || !isThreadWaitWakeEvent(event)) return false;
        dirty.add(threadId);
        return true;
    }
  };

  /**
   * One pass: Stops first, then every thread an event touched and every candidate that is due.
   * Returns how long to wait before the next pass when no event arrives, or null to wait for one.
   */
  const step = (nowMs: number) =>
    Effect.gen(function* () {
      const stops = [...stopped];
      stopped.clear();
      for (const [threadId, stopKey] of stops) {
        dirty.delete(threadId);
        yield* pauseAfterStop(threadId, stopKey, nowMs).pipe(Effect.catch(() => Effect.void));
      }
      const threadIds = new Set(dirty);
      dirty.clear();
      for (const [threadId, candidate] of candidates)
        if (candidate.retryAtMs <= nowMs) threadIds.add(threadId);
      for (const threadId of threadIds) {
        // One thread's failure never starves the others.
        yield* evaluate(threadId, nowMs).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("goal continuation check failed", {
                  threadId,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const candidate = candidates.get(threadId);
                      if (candidate !== undefined) candidate.retryAtMs = nowMs + HELD_RECHECK_MS;
                    }),
                  ),
                ),
          ),
        );
      }
      let nextMs: number | null = null;
      for (const candidate of candidates.values()) {
        const dueMs = Math.max(MIN_PASS_DELAY_MS, candidate.retryAtMs - nowMs);
        nextMs = nextMs === null ? dueMs : Math.min(nextMs, dueMs);
      }
      return nextMs;
    });

  return { observe, step, candidates, chains };
};

export type GoalContinuation = ReturnType<typeof makeGoalContinuation>;

/**
 * Runs the continuation: events mark threads, a pass handles them, and waiting continuations are
 * looked at again when their grace ends or every few seconds while the fence holds them.
 */
export const runGoalContinuation = (
  continuation: GoalContinuation,
  events: Stream.Stream<OrchestrationEvent>,
) =>
  Effect.gen(function* () {
    let signalled = false;
    let wake: (() => void) | undefined;
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        Effect.sync(() => {
          if (!continuation.observe(event)) return;
          signalled = true;
          wake?.();
        }),
      ),
    );
    const untilSignalled = Effect.callback<void>((resume) => {
      wake = () => resume(Effect.void);
      if (signalled) wake();
      return Effect.sync(() => {
        wake = undefined;
      });
    });
    return yield* Effect.forever(
      Effect.gen(function* () {
        signalled = false;
        const nextMs = yield* continuation.step(yield* Clock.currentTimeMillis);
        yield* nextMs === null ? untilSignalled : Effect.race(Effect.sleep(nextMs), untilSignalled);
      }),
    );
  }).pipe(Effect.scoped);
