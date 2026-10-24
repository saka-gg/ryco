/**
 * The fence every server wake passes before it is dispatched: a queued turn start the server
 * sends on its own (a delegated result, a pull request watch update). One instance per process,
 * so its pending-start sightings and its cold-start budget are shared by every wake source.
 *
 * The decider fences the dispatch itself (`delegationReturnGuard`); this fence decides whether
 * a wake should be tried at all, from what the decider cannot see: pending turn starts, the
 * revert journal and live provider sessions.
 */
import type { MessageId, OrchestrationThreadShell, ThreadId } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { WakeStartState } from "../../persistence/serverWakeQueries.ts";

/** Why a thread cannot take a wake now. Every reason ends on its own; callers wait and retry. */
export type ServerWakeHold = "usage-limited" | "busy";

export type ServerWakeFenceError = ProjectionRepositoryError;

export interface ServerWakeFenceShape {
  /**
   * A usage limit first (only the user's resume or the auto-resume may clear it, and an
   * accepted turn start would), then the shared queued-turn idle rule plus a pending start
   * first seen by this process less than `QUEUED_TURN_START_GRACE_MS` ago. Process time, so a
   * stale pending row left by a restart stops blocking and client clock skew cannot open it.
   */
  readonly holdReason: (
    shell: OrchestrationThreadShell,
    nowMs: number,
  ) => Effect.Effect<ServerWakeHold | null, ServerWakeFenceError>;
  /**
   * A pending checkpoint revert: the decider rejects every turn start until it ends. Reads the
   * thread's revert journal, so callers check it last, right before a dispatch.
   */
  readonly reverting: (
    threadId: ThreadId,
    nowMs: number,
  ) => Effect.Effect<boolean, ServerWakeFenceError>;
  /**
   * Whether a wake would start the thread's session (no live provider session; a failed read
   * counts as cold), and whether the cold-start budget looks full right now. A peek that spares
   * later reads; `reserveColdSlot` takes the slot. Slots are counted per thread.
   */
  readonly coldStart: (
    threadId: ThreadId,
    nowMs: number,
  ) => Effect.Effect<{ readonly cold: boolean; readonly budgetFull: boolean }>;
  /**
   * Takes a cold-start slot for the wake `messageId` before it is dispatched; false when the
   * budget is full. Atomic across callers. Every wake source's reservation on a thread is kept
   * on its own, so one caller giving its reservation back never frees another's.
   */
  readonly reserveColdSlot: (
    threadId: ThreadId,
    messageId: MessageId,
    nowMs: number,
  ) => Effect.Effect<boolean>;
  /**
   * The cold wake `messageId` was accepted (its reservation, if any, becomes this): its slot is
   * released when its start binds or fails, or `COLD_WAKE_GRACE_MS` after `sinceMs` (the apply
   * that started it). An accepted wake is counted even past the budget: its start runs.
   */
  readonly noteColdWake: (
    threadId: ThreadId,
    messageId: MessageId,
    sinceMs: number,
  ) => Effect.Effect<void>;
  /** Gives back a reservation whose wake was not accepted; a no-op once it was noted. */
  readonly releaseColdSlot: (threadId: ThreadId, messageId: MessageId) => Effect.Effect<void>;
  /**
   * Releases the accepted slots whose start bound or failed, and every slot or reservation past
   * its grace. `coldStart` and `reserveColdSlot` also run it on their own when the budget is
   * full, so no wake source depends on another one's schedule.
   */
  readonly releaseColdSlots: (nowMs: number) => Effect.Effect<void, ServerWakeFenceError>;
  readonly wakeStartState: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<WakeStartState, ServerWakeFenceError>;
  /** The id the wake's guard pins (`latestUserMessageIdQuery`, the decider's own order). */
  readonly latestUserMessageId: (
    threadId: ThreadId,
  ) => Effect.Effect<MessageId | null, ServerWakeFenceError>;
}

export class ServerWakeFence extends Context.Service<ServerWakeFence, ServerWakeFenceShape>()(
  "ryco/orchestration/Services/ServerWakeFence",
) {}
