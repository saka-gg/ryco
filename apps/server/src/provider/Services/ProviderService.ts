/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ThreadGoal,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSteerTurnInput,
  RuntimeSessionId,
  ProviderStopBackgroundTaskInput,
  ProviderStopSessionInput,
  ThreadId,
  TurnId,
  ProviderTurnStartResult,
  ProviderTurnSteerResult,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Option, Stream } from "effect";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities, ProviderThreadHistory } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";
import type { ProviderRuntimeBinding } from "./ProviderSessionDirectory.ts";

export type ProviderFreshSessionStartInput = Omit<
  ProviderSessionStartInput,
  "runtimeSessionId" | "resumeCursor" | "resumePolicy"
> & {
  readonly runtimeSessionId: RuntimeSessionId;
};

export interface ProviderFreshSessionStartResult {
  readonly session: ProviderSession;
  readonly previousBinding?: ProviderRuntimeBinding;
}

export type ProviderSessionBindingStopResult = "stopped" | "not-found" | "timed-out";

/** Payload-free runtime event metadata retained only in a small in-memory ring. */
export interface ProviderRuntimeEventSummary {
  readonly eventId: ProviderRuntimeEvent["eventId"];
  readonly type: ProviderRuntimeEvent["type"];
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly turnId: ProviderRuntimeEvent["turnId"] | null;
  readonly occurredAt: string;
}

/** What a compatible (non-fresh) start of a thread would resume, from its persisted binding. */
export interface ProviderResumeTarget {
  readonly providerInstanceId: ProviderInstanceId;
  /** The directory the native conversation last ran in, when recorded. */
  readonly cwd?: string;
  readonly hasResumeCursor: boolean;
}

/** Where the thread runs now, for {@link ProviderServiceShape.readThreadHistory}. */
export interface ProviderThreadHistoryReadInput {
  /** The thread's current working directory: its worktree, else its project's root. */
  readonly cwd?: string;
}

/** The last time a live runtime showed any activity, by `Clock` milliseconds. */
export interface ProviderRuntimeActivity {
  readonly threadId: ThreadId;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly lastActivityAtMs: number;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Read-only history recovery, stamped with the binding that authorized the read.
   *
   * A move (a chat turned into a project, a relocated worktree) leaves the binding's recorded
   * directory behind until the next start, and that folder may be gone. A conversation that
   * survives the move (`resumeSurvivesCwdChange`) is read in `input.cwd`, where the next start
   * resumes it; any other still lives in the recorded directory. The binding is never rewritten:
   * cwd-relocation detection (`readResumeTarget`) compares the recorded directory to the new one.
   */
  readonly readThreadHistory?: (
    threadId: ThreadId,
    input?: ProviderThreadHistoryReadInput,
  ) => Effect.Effect<
    Option.Option<{
      readonly binding: ProviderRuntimeBinding;
      readonly history: ProviderThreadHistory;
    }>,
    ProviderServiceError
  >;
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /** Start a fresh epoch and return the exact prior binding as a rollback token. */
  readonly startFreshSession: (
    threadId: ThreadId,
    input: ProviderFreshSessionStartInput,
  ) => Effect.Effect<ProviderFreshSessionStartResult, ProviderServiceError>;

  /**
   * The persisted binding's resume target, read without starting, recovering or
   * routing a runtime. None when the thread has no binding with an instance id.
   */
  readonly readResumeTarget?: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderResumeTarget>, ProviderServiceError>;

  /** Resolve only the adapter session matching the authoritative persisted binding. */
  readonly getSession: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderSession>, ProviderServiceError>;

  /** Restore a prior binding only while its exact instance/runtime is still live. */
  readonly restoreSessionBinding: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<boolean, ProviderServiceError>;

  /**
   * Retire an exact failed target epoch if it is still authoritative, clearing its
   * provider-native resume state. When it replaced a binding on its own instance (a
   * fresh start stops that runtime first), that binding is put back, stopped, with its
   * resume cursor and working directory: the conversation stays resumable without
   * reviving its runtime.
   */
  readonly retireSessionBinding: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<boolean, ProviderServiceError>;

  /** Stop one exact binding with a bounded deadline and queue timed-out cleanup. */
  readonly stopSessionBinding: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<ProviderSessionBindingStopResult, ProviderServiceError>;

  /** In-memory stale bindings awaiting a later bounded reaper retry. */
  readonly listStaleSessionBindings: () => Effect.Effect<ReadonlyArray<ProviderRuntimeBinding>>;

  /**
   * Send a provider turn. Recovers a dead runtime from its persisted resume
   * state. Fails `ProviderOperationTimeoutError` when the provider does not
   * accept the turn within the acceptance deadline (for `"completion"`
   * adapters, until their `turn.started`).
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /** Synchronize a goal and return the provider-confirmed state; false means unsupported. Inactive sessions fail. */
  readonly setThreadGoal?: (
    threadId: ThreadId,
    goal: ThreadGoal,
  ) => Effect.Effect<ThreadGoal | false, ProviderServiceError>;
  readonly getThreadGoal?: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadGoal | null | false, ProviderServiceError>;
  readonly clearThreadGoal?: (threadId: ThreadId) => Effect.Effect<boolean, ProviderServiceError>;

  /** Steer the exact active provider turn without creating a new turn. */
  readonly steerTurn: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn. Never recovers a runtime. Fails
   * `ProviderSessionNotFoundError` when no runtime is live for the thread.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop one live background task without interrupting the turn. Fails with
   * ProviderUnsupportedError when the routed adapter cannot stop tasks
   * individually.
   */
  readonly stopBackgroundTask: (
    input: ProviderStopBackgroundTaskInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Make the bound provider conversation forget its newest turns. Fails with
   * `ProviderOperationUnsupportedError` before any session recovery when the
   * provider cannot roll back, and persists the adapter's new resume cursor.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
    readonly targetTurnId: TurnId | null;
    readonly droppedTurnIds: ReadonlyArray<TurnId>;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  /**
   * The last provider activity per thread (runtime events, start, accepted
   * send, steer), from the process clock. In memory only; cleared on stop.
   */
  readonly listRuntimeActivity?: () => Effect.Effect<ReadonlyArray<ProviderRuntimeActivity>>;

  /** Newest-first bounded metadata only; never includes payload/raw/session data. */
  readonly readRecentEventSummaries?: (input: {
    readonly since: string;
    readonly limit: number;
    readonly threadId?: ThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
  }) => Effect.Effect<ReadonlyArray<ProviderRuntimeEventSummary>>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "ryco/provider/Services/ProviderService",
) {}
