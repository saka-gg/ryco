/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  BackgroundTaskStopIdentity,
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSteerTurnInput,
  ThreadId,
  ProviderTurnSteerResult,
  ProviderTurnStartResult,
  TurnId,
  ThreadGoal,
  MessageId,
} from "@ryco/contracts";
import type { Effect } from "effect";
import type { Stream } from "effect";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";
export type ProviderTurnSteeringMode = "native" | "unsupported";
export type ProviderConversationRollbackMode = "native" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether the model of a live session can change.
   *
   * - `"in-session"`: the adapter applies `sendTurn.modelSelection` to the live session.
   * - `"unsupported"`: the live session cannot change model. Ryco rejects a turn that
   *   requests a model other than the session's known model, and never restarts a
   *   session to change model.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Native in-flight turn steering support. Missing is treated as unsupported. */
  readonly turnSteering?: ProviderTurnSteeringMode;
  /**
   * Whether the provider can make its conversation forget turns. Missing is
   * treated as unsupported: Ryco refuses a checkpoint revert before touching
   * the session or any files.
   */
  readonly conversationRollback?: ProviderConversationRollbackMode;
  /**
   * How long `sendTurn` runs. Missing is treated as `"acceptance"`.
   *
   * - `"acceptance"`: `sendTurn` resolves once the provider accepted the turn.
   * - `"completion"`: `sendTurn` spans the whole turn; acceptance is the adapter's
   *   `turn.started`, which MUST be emitted before the long-running call. Ryco's
   *   turn-acceptance deadline then covers only the time until that event.
   */
  readonly turnSubmission?: ProviderTurnSubmissionMode;
  /**
   * Whether a native conversation can be resumed after the thread's working
   * directory moved (a chat turned into a project, a changed workspace root,
   * a relocated worktree). Missing is treated as `false`: Ryco then starts a
   * fresh native session in the new directory and carries the conversation
   * over with a context handoff instead of resuming the old one there.
   */
  readonly resumeSurvivesCwdChange?: boolean;
}

export type ProviderTurnSubmissionMode = "acceptance" | "completion";

/**
 * A precise rollback target. Turn ids are orchestration turn ids, which equal
 * provider turn ids (Claude prompt uuid, Codex native turn id).
 */
export interface ProviderRollbackInput {
  /** Number of turns to drop from the end of the conversation (>= 1). */
  readonly numTurns: number;
  /** The newest kept turn, or null when reverting to checkpoint 0. */
  readonly targetTurnId: TurnId | null;
  /** Dropped turns, oldest first. */
  readonly droppedTurnIds: ReadonlyArray<TurnId>;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

/** Immutable, completed provider turns suitable for repairing a missed stream. */
export interface ProviderThreadHistory {
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly turnId: TurnId;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: string;
  }>;
  readonly items: ReadonlyArray<ProviderRuntimeEvent>;
  readonly completedTurnIds: ReadonlyArray<TurnId>;
  readonly failedTurnIds: ReadonlyArray<TurnId>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Add user input to the exact active turn without starting a new turn. */
  readonly steerTurn?: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Stop one live background task without interrupting the turn. Optional:
   * only providers whose runtime tracks individually stoppable tasks
   * implement it; callers must feature-detect.
   */
  // Implementations must validate expected identity again at the native call
  // boundary: routing and invocation can straddle a runtime replacement.
  readonly stopBackgroundTask?: (
    threadId: ThreadId,
    taskId: string,
    expected?: BackgroundTaskStopIdentity,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;
  /** Read stored history without resuming, acquiring a writer, or starting a turn. */
  readonly readThreadHistory?: (input: {
    readonly threadId: ThreadId;
    readonly resumeCursor: unknown;
    readonly cwd?: string;
  }) => Effect.Effect<ProviderThreadHistory, TError>;

  /**
   * Make the provider conversation forget the newest turns. Only called when
   * `capabilities.conversationRollback === "native"`.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    input: ProviderRollbackInput,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /** Native thread-goal integration. Providers without it use prompt injection. */
  readonly setThreadGoal?: (
    threadId: ThreadId,
    goal: ThreadGoal,
  ) => Effect.Effect<ThreadGoal, TError>;
  readonly getThreadGoal?: (threadId: ThreadId) => Effect.Effect<ThreadGoal | null, TError>;
  readonly clearThreadGoal?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
