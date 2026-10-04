/**
 * RestartContinuation - what a server restart cut off, and the opt-in automatic
 * "continue" turn for it.
 *
 * Lifecycle: `recordShutdownHints` runs in the startup layer's finalizer (before the
 * reactors stop) on a graceful shutdown, for the provider sessions still live then. At startup, `capture` runs inside orphan
 * reconciliation before it clears pending requests, `publishCaptureEffects` after it,
 * and `dispatchPending` once the server is ready. Every effect logs and swallows
 * non-interrupt failures, so it can never fail startup or shutdown.
 *
 * @module RestartContinuation
 */
import type {
  MessageId,
  OrchestrationReadModel,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { RestartBackgroundWorkRecord } from "../../persistence/Layers/RestartContinuations.ts";
import type { RestartContinuationStatus } from "../restartContinuationPolicy.ts";

/** A ledger row this startup captured (newly inserted or already present). */
export interface CapturedRestartThread {
  readonly threadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly runtimeSessionId: RuntimeSessionId | null;
  readonly backgroundWork: RestartBackgroundWorkRecord;
  readonly status: RestartContinuationStatus;
  readonly reason: string | null;
}

export interface RestartContinuationDispatchInput {
  /**
   * Turn starts startup provider intent recovery just cancelled visibly ("send it
   * again"). Their threads are not continued: the user's own message comes first.
   */
  readonly cancelledTurnStarts?: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }>;
}

export interface RestartContinuationShape {
  /** Classifies and records every restart candidate. Reads pre-reconcile state. */
  readonly capture: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly liveThreadIds: ReadonlySet<ThreadId>;
  }) => Effect.Effect<ReadonlyArray<CapturedRestartThread>>;
  /** The background-work boundary, the stopped-work note and capture-time notices. */
  readonly publishCaptureEffects: (
    captured: ReadonlyArray<CapturedRestartThread>,
  ) => Effect.Effect<void>;
  /**
   * Graceful shutdown: which threads this process was still running (`liveThreadIds`, the
   * threads with a live provider session) or had live background work for. A thread
   * outside `liveThreadIds` gets no running-turn hint, whatever its projection says.
   */
  readonly recordShutdownHints: (input: {
    readonly liveThreadIds: ReadonlySet<ThreadId>;
  }) => Effect.Effect<void>;
  /** Sends at most one continuation per pending row; every processed row leaves pending. */
  readonly dispatchPending: (input?: RestartContinuationDispatchInput) => Effect.Effect<void>;
}

export class RestartContinuation extends Context.Service<
  RestartContinuation,
  RestartContinuationShape
>()("ryco/orchestration/Services/RestartContinuation") {}
