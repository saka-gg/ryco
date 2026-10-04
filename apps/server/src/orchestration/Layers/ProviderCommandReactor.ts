import * as SqlClient from "effect/unstable/sql/SqlClient";
import { acquireStoragePathUseLease } from "../../storage/lifecycle.ts";
import { isClaudeNativeCompaction } from "../../provider/claudeNativeCompaction.ts";
import { computerToolInstructions } from "../../computer/tools/computerGuidance.ts";
import type { ComputerTurnIntent } from "@ryco/contracts";
import { stageComputerTurn, computerTurnPlan } from "../../computer/computerTurnLifecycle.ts";
import { parseComputerInvocation } from "@ryco/shared/computerInvocation";
import {
  hasRetiredProjectMemory,
  REMOVED_PROJECT_MEMORY_MESSAGE,
} from "@ryco/shared/retiredFeatures";
import { ProjectionThreadUserInputRequestRepository } from "../../persistence/Services/ProjectionThreadUserInputRequests.ts";
import { ProjectionThreadUserInputRequestRepositoryLive } from "../../persistence/Layers/ProjectionThreadUserInputRequests.ts";
import {
  ProviderSessionNotFoundError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterSessionClosedError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { ProviderEffectIntentRepository } from "../../persistence/Services/ProviderEffectIntents.ts";
import type { ProviderEffectIntentRow } from "../../persistence/Services/ProviderEffectIntents.ts";
import { ProviderEffectIntentRepositoryLive } from "../../persistence/Layers/ProviderEffectIntents.ts";
import { PersistenceDecodeError } from "../../persistence/Errors.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import {
  deliveryStateOf,
  isTrackedProviderIntentEvent,
  MAX_PROVIDER_INTENT_RECOVERY_ATTEMPTS,
  providerIntentFailureIds,
  providerIntentKindOf,
  providerIntentRecoveryIds,
  recoveryCopy,
  type TrackedProviderIntentEvent,
} from "../providerEffectIntents.ts";
import { matchesApprovalAttempt, questionAsCallback } from "../approvalResponses.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import type { ApprovalResponseState } from "@ryco/contracts";
import { lstatSync, realpathSync } from "node:fs";
import nodePath from "node:path";

import {
  type ChatAttachment,
  type ThreadGoal,
  CommandId,
  DEFAULT_AGENT_TOKEN_MODE,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  ProviderDriverKind,
  type OrchestrationThreadShell,
  type ProjectId,
  type OrchestrationSession,
  type OrchestrationTurnOutcome,
  ThreadId,
  type ProviderInteractionMode,
  type ProviderSession,
  type RuntimeMode,
  type AgentTokenMode,
  type TurnId,
  type TurnSteerRejectionReason,
  type WorktreeId,
} from "@ryco/contracts";
import {
  buildGeneratedWorktreeBranchName,
  extractTemporaryWorktreeBranchPrefix,
} from "@ryco/shared/git";
import {
  Cache,
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { makeKeyedSerialExecutor } from "@ryco/shared/KeyedSerialExecutor";
import { makeKeyedSerialWorker } from "@ryco/shared/KeyedSerialWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { resolveProviderOperationTimeouts } from "../../provider/providerOperationPolicy.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import {
  ProviderService,
  type ProviderRuntimeActivity,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ContextHandoffCoordinator } from "../Services/ContextHandoffCoordinator.ts";
import { TURN_FINALIZATION_REASON } from "../turnFinalization.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
  type ProviderIntentRecoverySummary,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { withProviderGoalPrompt } from "../../provider/goalMode.ts";
import {
  type ProviderFailureActivityInput,
  providerFailureActivityCommand,
  providerNoticeActivityCommand,
} from "../providerFailureActivity.ts";
import {
  classifyTurnLiveness,
  TURN_LOST_DETAIL,
  turnLivenessApplies,
  type TurnLivenessVerdict,
  unresponsiveTurnDetail,
} from "../providerTurnLiveness.ts";
import {
  isProviderSessionStartCancelled,
  makeThreadLaneControl,
  type OutOfBandOutcome,
  type ProviderIntentEvent,
  START_CANCELLED_DETAIL,
  type StartKind,
} from "../threadLaneControl.ts";
import {
  failureTag,
  userFacingFailureDetail,
  UNEXPECTED_FAILURE_DETAIL,
} from "../userFacingErrors.ts";
import { classifyTurnSteerFailure } from "../turnSteerFailure.ts";

type CallbackResponseEvent = Extract<
  ProviderIntentEvent,
  { type: "thread.approval-response-requested" | "thread.user-input-response-requested" }
>;

type LifecycleIntentEvent = Exclude<ProviderIntentEvent, CallbackResponseEvent>;

type StopIntentEvent = Extract<
  ProviderIntentEvent,
  { type: "thread.turn-interrupt-requested" | "thread.session-stop-requested" }
>;

type LivenessVerdict = Extract<TurnLivenessVerdict, { kind: "lost" | "unresponsive" }>;

/** One item of a thread's lifecycle lane. */
type LaneItem =
  | {
      readonly kind: "event";
      readonly event: LifecycleIntentEvent;
      /** Sequence a stop must exceed to cancel this item; 0 for synthetic recovery. */
      readonly fenceSequence: number;
      readonly recovery?: true;
      /** An earlier process committed this event (startup intent recovery). */
      readonly priorProcess?: true;
    }
  | {
      readonly kind: "liveness";
      readonly threadId: ThreadId;
      readonly verdict: LivenessVerdict;
    };

interface OutOfBandJob {
  readonly event: StopIntentEvent;
  readonly outcome: Deferred.Deferred<OutOfBandOutcome>;
}

const isCallbackResponseEvent = (event: ProviderIntentEvent): event is CallbackResponseEvent =>
  event.type === "thread.approval-response-requested" ||
  event.type === "thread.user-input-response-requested";

const isProviderIntentEvent = (event: OrchestrationEvent): event is ProviderIntentEvent =>
  event.type === "thread.runtime-mode-set" ||
  event.type === "thread.token-mode-set" ||
  event.type === "thread.goal-updated" ||
  event.type === "thread.goal-cleared" ||
  event.type === "thread.turn-start-requested" ||
  event.type === "thread.turn-steer-requested" ||
  event.type === "thread.turn-interrupt-requested" ||
  event.type === "thread.approval-response-requested" ||
  event.type === "thread.user-input-response-requested" ||
  event.type === "thread.session-stop-requested";

export interface ProviderCommandReactorOptions {
  /** How often running turns are checked for liveness. Default 60 s. */
  readonly livenessSweepIntervalMs?: number;
  /** Silence on a live turn before one "unresponsive" notice. Default from the operator env, else 15 min. */
  readonly unresponsiveAfterMs?: number;
  /** Synthetic startup recoveries allowed to start sessions at once. Default 4. */
  readonly maxConcurrentRecoveries?: number;
  /** Total outstanding lifecycle items across all threads. Default 1024. */
  readonly lifecycleCapacity?: number;
}

const DEFAULT_LIVENESS_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_RECOVERIES = 4;
/** setTimeout's ceiling; larger sweep intervals only ever matter to the classifier. */
const MAX_TIMER_MS = 2_147_483_647;

type TurnStartRequestedEvent = Extract<
  ProviderIntentEvent,
  { type: "thread.turn-start-requested" }
>;

// Git canonicalizes registered paths, while saved paths can contain symlinked parents.
function worktreeIdentity(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return nodePath.resolve(path);
  }
}

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const isProviderOriginatedCommandId = (commandId: CommandId | null): boolean =>
  commandId !== null && String(commandId).startsWith("provider:");

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_TOKEN_MODE: AgentTokenMode = DEFAULT_AGENT_TOKEN_MODE;
const DEFAULT_THREAD_TITLE = "New thread";

function pathEntryExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return Schema.is(ProviderAdapterRequestError)(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

const makeProviderCommandReactor = Effect.fnUntraced(function* (
  options?: ProviderCommandReactorOptions,
) {
  const storageSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const leaseThreadPath = (
    thread: OrchestrationThreadShell,
    project: OrchestrationProjectShell | undefined,
  ) =>
    Effect.gen(function* () {
      const candidate = thread.worktreePath ?? project?.workspaceRoot;
      if (!candidate || Option.isNone(storageSql)) return;
      const release = yield* acquireStoragePathUseLease(storageSql.value, candidate).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: providerErrorLabel(String(thread.modelSelection.instanceId)),
              method: "session.start",
              detail:
                cause instanceof Error ? cause.message : "Cannot establish checkout readiness.",
            }),
        ),
      );
      yield* Effect.addFinalizer(() => release);
    });
  const approvals = yield* ProjectionPendingApprovalRepository;
  const questions = yield* ProjectionThreadUserInputRequestRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const contextHandoffCoordinator = yield* ContextHandoffCoordinator;
  const providerEffectIntents = yield* ProviderEffectIntentRepository;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const livenessSweepIntervalMs = Math.max(
    1,
    options?.livenessSweepIntervalMs ?? DEFAULT_LIVENESS_SWEEP_INTERVAL_MS,
  );
  const unresponsiveAfterMs =
    options?.unresponsiveAfterMs ??
    resolveProviderOperationTimeouts({ env: process.env }).unresponsiveAfterMs;
  const laneControl = yield* makeThreadLaneControl;
  // Serializes recreating one missing worktree across threads that record it.
  const worktreeLocks = yield* makeKeyedSerialExecutor<string>();
  // Startup goal recovery would otherwise burst into provider startup admission.
  const recoveryPermits = yield* Semaphore.make(
    Math.max(1, options?.maxConcurrentRecoveries ?? DEFAULT_MAX_CONCURRENT_RECOVERIES),
  );

  const appendProviderFailureActivity = (input: ProviderFailureActivityInput) =>
    orchestrationEngine.dispatch(providerFailureActivityCommand(input));

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    /** How the turn this session-set releases ended, when this caller knows. */
    readonly turnOutcome?: OrchestrationTurnOutcome | undefined;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      ...(input.turnOutcome ? { turnOutcome: input.turnOutcome } : {}),
      createdAt: input.createdAt,
    });

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
    /**
     * Set for failures before anything was submitted. A turn that is running
     * then belongs to someone else (a wake turn, a goal resume, a
     * provider-originated turn), so its session must not be reset.
     */
    readonly preserveActiveTurn: boolean;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    if (input.preserveActiveTurn && session.status === "running" && session.activeTurnId !== null) {
      return;
    }
    // Bind the error only to the turn this request started (its user message), never to
    // whatever turn happens to be running, so a failed send cannot mislabel another turn.
    const started =
      thread.latestTurn?.state === "running" && thread.latestTurn.userMessageId === input.messageId
        ? thread.latestTurn
        : undefined;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        // Keep an error status that ingestion already set from the adapter's terminal.
        status:
          session.status === "stopped" ? "stopped" : session.status === "error" ? "error" : "ready",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      turnOutcome: started
        ? {
            turnId: started.turnId,
            state: "error",
            reason: TURN_FINALIZATION_REASON.turnStartFailed,
            completedAt: new Date().toISOString(),
          }
        : undefined,
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Targeted message reads for the turn-start path. Callers fall back to the
   * full detail load when a query double does not implement the narrow
   * methods, so behavior is identical either way.
   */
  const resolveTurnStartMessage = (threadId: ThreadId, messageId: MessageId) => {
    const targeted = projectionSnapshotQuery.getThreadMessageById;
    if (targeted) {
      return targeted({ threadId, messageId }).pipe(Effect.map(Option.getOrUndefined));
    }
    return projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map(
        Option.match({
          onNone: () => undefined,
          onSome: (thread) => thread.messages.find((entry) => entry.id === messageId),
        }),
      ),
    );
  };

  const resolveUserMessageCount = (threadId: ThreadId) => {
    const targeted = projectionSnapshotQuery.countThreadUserMessages;
    if (targeted) {
      return targeted(threadId);
    }
    return projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map(
        Option.match({
          onNone: () => 0,
          onSome: (thread) => thread.messages.filter((entry) => entry.role === "user").length,
        }),
      ),
    );
  };

  const ensureRecordedWorktreeAvailable = Effect.fn("ensureRecordedWorktreeAvailable")(function* (
    thread: OrchestrationThreadShell,
    project: OrchestrationProjectShell | undefined,
  ) {
    yield* leaseThreadPath(thread, project);
    if (thread.worktreePath === null) {
      return;
    }
    if (!project) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(thread.modelSelection.instanceId)),
        method: "thread.turn.start",
        detail: `Cannot verify worktree '${thread.worktreePath}' because project '${thread.projectId}' is unavailable.`,
      });
    }

    const repositoryRoot = nodePath.resolve(project.workspaceRoot);
    const worktreePath = nodePath.resolve(thread.worktreePath);
    if (pathEntryExists(worktreePath)) yield* gitWorkflow.assertWorktreeSetupComplete(worktreePath);
    if (worktreeIdentity(worktreePath) === worktreeIdentity(repositoryRoot)) {
      return;
    }

    const registeredWorktreePaths = () =>
      gitWorkflow
        .listWorktreePaths(repositoryRoot)
        .pipe(Effect.map((paths) => paths.map(worktreeIdentity)));
    const failRecovery = (detail: string) =>
      new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(thread.modelSelection.instanceId)),
        method: "thread.turn.start",
        detail,
      });

    // Threads that record the same missing worktree recreate it once: the
    // re-checks run under the path's lock, so the second thread sees the
    // recreated, registered worktree and returns.
    const recreated = yield* worktreeLocks.withLock(
      worktreeIdentity(worktreePath),
      Effect.gen(function* () {
        if (pathEntryExists(worktreePath)) {
          const registeredPaths = yield* registeredWorktreePaths();
          if (!registeredPaths.includes(worktreeIdentity(worktreePath))) {
            return yield* failRecovery(
              `Refusing to use '${worktreePath}' because it exists but is not a registered worktree for '${repositoryRoot}'.`,
            );
          }
          return false;
        }

        const branch = thread.branch;
        if (branch === null) {
          return yield* failRecovery(
            `Cannot recreate missing worktree '${worktreePath}' because the thread has no recorded branch.`,
          );
        }

        const localBranches = yield* gitWorkflow.listLocalBranchNames(repositoryRoot);
        if (!localBranches.includes(branch)) {
          return yield* failRecovery(
            `Cannot recreate missing worktree '${worktreePath}' because branch '${branch}' no longer exists.`,
          );
        }

        yield* gitWorkflow.pruneWorktrees(repositoryRoot);

        // Another process may have recreated the path while the stale metadata was pruned.
        if (pathEntryExists(worktreePath)) {
          const registeredPaths = yield* registeredWorktreePaths();
          if (registeredPaths.includes(worktreeIdentity(worktreePath))) {
            yield* gitWorkflow.assertWorktreeSetupComplete(worktreePath);
            return false;
          }
          return yield* failRecovery(
            `Refusing to recreate worktree '${worktreePath}' because another filesystem entry now occupies that path.`,
          );
        }

        const created = yield* gitWorkflow.createWorktree({
          projectId: project.id,
          cwd: repositoryRoot,
          path: worktreePath,
          refName: branch,
          dependencyHydration: "none",
        });
        if (
          worktreeIdentity(created.worktree.path) !== worktreeIdentity(worktreePath) ||
          created.worktree.refName !== branch
        ) {
          return yield* failRecovery(
            `Worktree recovery returned unexpected metadata for '${worktreePath}' and branch '${branch}'.`,
          );
        }

        const changedAt = new Date().toISOString();
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("worktree-recovered"),
          threadId: thread.id,
          branch,
          worktreePath,
        });
        if (thread.worktreeId !== undefined && thread.worktreeId !== null) {
          yield* orchestrationEngine.dispatch({
            type: "worktree.meta.update",
            commandId: serverCommandId("worktree-recovered-meta"),
            worktreeId: thread.worktreeId,
            branch,
            changedAt,
          });
        }
        return true;
      }),
    );
    if (!recreated) return;
    yield* gitWorkflow.invalidateStatus(worktreePath);
    yield* vcsStatusBroadcaster.refreshStatus(worktreePath).pipe(Effect.ignoreCause({ log: true }));
  }, Effect.scoped);

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options: {
      /** The lane item's fence: a later Stop cancels this start. */
      readonly fenceSequence: number;
      readonly kind: StartKind;
      readonly modelSelection?: ModelSelection;
      readonly computerCatalogChanged?: boolean;
    },
  ) {
    const startFence = { threadId, fenceSequence: options.fenceSequence, kind: options.kind };
    yield* laneControl.failIfCancelled(startFence);
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const project = yield* resolveProject(thread.projectId);
    yield* leaseThreadPath(thread, project);
    yield* ensureRecordedWorktreeAvailable(thread, project);

    const desiredRuntimeMode = thread.runtimeMode;
    const desiredTokenMode = thread.tokenMode ?? DEFAULT_TOKEN_MODE;
    const requestedModelSelection = options.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!Schema.is(ProviderDriverKind)(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const customSystemPrompt = project?.customSystemPrompt?.trim() || undefined;

    // Fenced: a Stop cancels the start (pending or in flight). The start is
    // detached inside ProviderService, so cancelling it returns at once.
    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      laneControl.guardStart(
        startFence,
        providerService.startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
          tokenMode: desiredTokenMode,
          ...(customSystemPrompt !== undefined ? { customSystemPrompt } : {}),
        }),
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined || session.runtimeSessionId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id or runtime session id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeSessionId: session.runtimeSessionId,
            runtimeMode: desiredRuntimeMode,
            tokenMode: desiredTokenMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          // A no-op when nothing runs (first start, turn start). When a turn was running,
          // the replacement killed it, whichever old-runtime terminal wins the race.
          turnOutcome: {
            state: "interrupted",
            reason: TURN_FINALIZATION_REASON.sessionReplaced,
            completedAt: createdAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const currentThreadSessionTokenMode = thread.session?.tokenMode ?? DEFAULT_TOKEN_MODE;
      const activeSessionTokenMode = activeSession?.tokenMode ?? DEFAULT_TOKEN_MODE;
      const tokenModeChanged =
        desiredTokenMode !== currentThreadSessionTokenMode ||
        desiredTokenMode !== activeSessionTokenMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      // A model change never restarts a session. "in-session" adapters apply
      // sendTurn.modelSelection to the live session. A session that cannot
      // switch rejects a *known* change. An unknown active model (undefined)
      // is never a change.
      const activeModel = activeSession?.model;
      if (
        sessionModelSwitch === "unsupported" &&
        requestedModelSelection !== undefined &&
        !instanceChanged &&
        activeModel !== undefined &&
        requestedModelSelection.model !== activeModel
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `This provider session cannot switch from model '${activeModel}' to '${requestedModelSelection.model}'. Start a new thread to use '${requestedModelSelection.model}'.`,
        });
      }
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !options.computerCatalogChanged &&
        !runtimeModeChanged &&
        !tokenModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      // Every restart resumes the active native session explicitly.
      const resumeCursor = activeSession?.resumeCursor ?? undefined;
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        currentTokenMode: thread.session?.tokenMode,
        activeTokenMode: activeSession?.tokenMode,
        desiredTokenMode,
        tokenModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        sessionModelSwitch,
        instanceChanged,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        tokenMode: restartedSession.tokenMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  }, Effect.scoped);

  const reconcileThreadGoal = Effect.fn("reconcileThreadGoal")(function* (threadId: ThreadId) {
    const thread = yield* resolveThread(threadId);
    const goal = thread?.goal ?? null;
    const request = goal?.synchronization;
    const now = new Date().toISOString();
    if (goal && request && request.state !== "unsupported") {
      const synchronize = Effect.gen(function* () {
        if (request.action === "clear") {
          yield* providerService.clearThreadGoal?.(threadId) ?? Effect.succeed(false as const);
          yield* orchestrationEngine.dispatch({
            type: "thread.goal.provider-clear",
            commandId: serverCommandId("goal-clear-confirmed"),
            threadId,
            expectedRequestId: request.requestId,
            createdAt: now,
          });
          return { goal: null, native: true };
        }
        const result = yield* (
          providerService.setThreadGoal?.(threadId, goal) ?? Effect.succeed(false as const)
        );
        const confirmed: ThreadGoal =
          result === false
            ? { ...goal, synchronization: { ...request, state: "unsupported" } }
            : result;
        yield* orchestrationEngine.dispatch({
          type: "thread.goal.sync",
          commandId: serverCommandId("goal-confirmed"),
          threadId,
          goal: confirmed,
          expectedRequestId: request.requestId,
          createdAt: now,
        });
        return { goal: confirmed, native: result !== false };
      });
      return yield* synchronize.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
            const latest = yield* resolveThread(threadId);
            if (latest?.goal?.synchronization?.requestId !== request.requestId)
              return yield* Effect.failCause(cause);
            const detail = userFacingFailureDetail(cause);
            yield* orchestrationEngine
              .dispatch({
                type: "thread.goal.sync",
                commandId: serverCommandId("goal-failed"),
                threadId,
                expectedRequestId: request.requestId,
                goal: {
                  ...goal,
                  synchronization: { ...request, state: "failed", error: detail },
                },
                createdAt: now,
              })
              .pipe(Effect.catchCause(() => Effect.void));
            yield* appendProviderFailureActivity({
              threadId,
              kind: "provider.goal.update.failed",
              summary: "Goal change could not be confirmed",
              detail,
              turnId: null,
              createdAt: now,
            });
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    }
    const nativeGoal = yield* (
      providerService.getThreadGoal?.(threadId) ?? Effect.succeed(false as const)
    );
    if (nativeGoal === false) {
      if (goal && !goal.synchronization) {
        const reminder: ThreadGoal = {
          ...goal,
          synchronization: {
            requestId: serverCommandId("goal-reminder"),
            state: "unsupported",
            action: "set",
          },
        };
        yield* orchestrationEngine.dispatch({
          type: "thread.goal.sync",
          commandId: serverCommandId("goal-reminder-confirmed"),
          threadId,
          goal: reminder,
          createdAt: now,
        });
        return { goal: reminder, native: false };
      }
      return { goal, native: false };
    }
    if (nativeGoal !== null) {
      yield* orchestrationEngine.dispatch({
        type: "thread.goal.sync",
        commandId: serverCommandId("goal-reconciled"),
        threadId,
        goal: nativeGoal,
        createdAt: now,
      });
    } else if (goal !== null) {
      yield* orchestrationEngine.dispatch({
        type: "thread.goal.provider-clear",
        commandId: serverCommandId("goal-reconciled-clear"),
        threadId,
        createdAt: now,
      });
    }
    return { goal: nativeGoal, native: true };
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly fenceSequence: number;
    readonly messageText: string;
    readonly computerUse?: ComputerTurnIntent;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: ProviderInteractionMode;
    readonly tokenMode?: AgentTokenMode;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const previousComputerPlan = computerTurnPlan(input.threadId);
    const previousAssistantText =
      input.computerUse && previousComputerPlan?.createdAt
        ? yield* projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
            Effect.map(
              Option.match({
                onNone: () => undefined,
                onSome: (detail) =>
                  detail.messages
                    .filter(
                      (entry) =>
                        entry.role === "assistant" &&
                        !entry.streaming &&
                        entry.createdAt >= previousComputerPlan.createdAt! &&
                        entry.createdAt < input.createdAt,
                    )
                    .at(-1)?.text,
              }),
            ),
          )
        : undefined;
    const computerCatalogChanged =
      Boolean(computerTurnPlan(input.threadId)) !== Boolean(input.computerUse);
    stageComputerTurn(
      input.threadId,
      input.computerUse
        ? {
            intent: input.computerUse,
            text: input.messageText,
            runtimeMode: thread.runtimeMode,
            label: thread.title,
            createdAt: input.createdAt,
            ...(previousAssistantText ? { previousAssistantText } : {}),
          }
        : undefined,
    );
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      fenceSequence: input.fenceSequence,
      kind: "turn",
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      computerCatalogChanged,
    });
    const { goal, native } = yield* reconcileThreadGoal(input.threadId);
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = withProviderGoalPrompt({
      message: toNonEmptyProviderInput(
        input.computerUse
          ? (parseComputerInvocation(input.messageText)?.prompt ?? input.messageText)
          : input.messageText,
      ),
      goal: native ? null : goal,
    });
    const normalizedAttachments = input.attachments ?? [];
    const project = yield* resolveProject(thread.projectId);
    const customSystemPrompt = project?.customSystemPrompt?.trim() || undefined;
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    const nativeCompaction =
      activeSession?.provider === "claudeAgent" &&
      !input.computerUse &&
      isClaudeNativeCompaction({ input: input.messageText, attachments: normalizedAttachments });
    return {
      threadId: input.threadId,
      ...(nativeCompaction ? { input: "/compact" } : {}),
      ...(!nativeCompaction && normalizedInput
        ? {
            input: input.computerUse
              ? `${computerToolInstructions()}\n\n${normalizedInput}`
              : normalizedInput,
          }
        : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      tokenMode: input.tokenMode ?? thread.tokenMode ?? DEFAULT_TOKEN_MODE,
      ...(customSystemPrompt !== undefined ? { customSystemPrompt } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly worktreeId: WorktreeId | null;
    readonly messageText: string;
    readonly computerUse?: ComputerTurnIntent;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection, worktreeBranchPrefix } =
        yield* serverSettingsService.getSettings;
      const originalPrefix = extractTemporaryWorktreeBranchPrefix(oldBranch, worktreeBranchPrefix);
      if (originalPrefix === null) return;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch, originalPrefix);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({
        cwd,
        oldBranch,
        newBranch: targetBranch,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      if (input.worktreeId !== null) {
        yield* orchestrationEngine.dispatch({
          type: "worktree.meta.update",
          commandId: serverCommandId("worktree-branch-rename-meta"),
          worktreeId: input.worktreeId,
          branch: renamed.branch,
          changedAt: new Date().toISOString(),
        });
      }
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly computerUse?: ComputerTurnIntent;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  /**
   * The exact live runtime of a thread, or `unknown` when ProviderService could
   * not tell (a directory or adapter lookup failed). Only a successful lookup that
   * finds nothing means "no live runtime".
   */
  const readLiveRuntime = (threadId: ThreadId) =>
    providerService.getSession(threadId).pipe(
      Effect.map((live) => ({ known: true as const, live: Option.getOrUndefined(live) })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor could not read the live runtime", {
              threadId,
              failureTag: failureTag(cause),
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ known: false as const, live: undefined })),
      ),
    );

  /**
   * Settles the projection after a Stop cancelled a session start. Status follows
   * liveness: if the exact projected runtime is still live, keep it (a starting
   * or running status becomes `ready`); otherwise `stopped`. `lastError` is kept.
   * A turn that the projected runtime is still running was never killed by the
   * cancelled start (it had not replaced the runtime yet), and a runtime whose
   * liveness is unknown is not claimed stopped: both keep the session as it is,
   * and the interrupt's own lane item interrupts the turn.
   * With `force`, always dispatches (it acknowledges a local dispatch, even when
   * no session was projected yet); without it, only an inconsistent projection
   * is corrected.
   */
  const settleSessionAfterCancelledStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
    input: { readonly force: boolean },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) return;
    const session = thread.session;
    const { known, live } = yield* readLiveRuntime(threadId);
    const liveMatches =
      live !== undefined &&
      session !== null &&
      session.runtimeSessionId !== undefined &&
      live.runtimeSessionId === session.runtimeSessionId;
    if (session !== null && (!known || (liveMatches && session.activeTurnId !== null))) {
      if (!input.force) return;
      // Acknowledge the cancelled dispatch without releasing anyone's turn.
      const now = new Date().toISOString();
      return yield* setThreadSession({
        threadId,
        session: { ...session, updatedAt: now },
        createdAt: now,
      });
    }
    if (!input.force) {
      const inconsistent =
        session !== null &&
        (session.status === "starting" ||
          session.status === "running" ||
          (!liveMatches && session.status !== "stopped"));
      if (!inconsistent) return;
    }
    const status: OrchestrationSession["status"] =
      liveMatches && session !== null
        ? session.status === "starting" || session.status === "running"
          ? "ready"
          : session.status
        : "stopped";
    const now = new Date().toISOString();
    yield* setThreadSession({
      threadId,
      session: {
        ...(session ?? {
          threadId,
          providerName: null,
          runtimeMode: thread.runtimeMode,
          tokenMode: thread.tokenMode ?? DEFAULT_TOKEN_MODE,
          lastError: null,
        }),
        threadId,
        status,
        activeTurnId: null,
        updatedAt: now,
      },
      turnOutcome: {
        state: "interrupted",
        reason: TURN_FINALIZATION_REASON.turnStartCancelled,
        completedAt: now,
      },
      createdAt: now,
    });
  });

  /** A Stop cancelled this turn start: settle the session and say so, as info. */
  const settleCancelledTurnStart = Effect.fnUntraced(function* (event: TurnStartRequestedEvent) {
    yield* settleSessionAfterCancelledStart(event.payload.threadId, { force: true });
    yield* orchestrationEngine.dispatch(
      providerNoticeActivityCommand({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.cancelled",
        summary: "Turn start cancelled",
        payload: {
          detail: START_CANCELLED_DETAIL,
          messageId: event.payload.messageId,
          reason: "stopped-before-start",
        },
        turnId: null,
        createdAt: new Date().toISOString(),
      }),
    );
  });

  /**
   * Reports a turn start that did not reach the provider: logs the full cause,
   * records the short text on the session and appends the visible failure
   * activity. A start that a Stop cancelled (the cancel error itself, or any
   * failure after a session stop or turn-less interrupt noted past this start's
   * fence) is settled as cancelled instead. Never fails.
   */
  const reportTurnStartFailure = (input: {
    readonly event: TurnStartRequestedEvent;
    readonly fenceSequence: number;
    readonly cause: Cause.Cause<unknown>;
    readonly preserveActiveTurn: boolean;
  }): Effect.Effect<void> => {
    const { event, cause } = input;
    // Interrupt-only: no activity, and not re-raised (the lane logs and continues).
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;
    const threadId = event.payload.threadId;
    const detail = userFacingFailureDetail(cause);
    const tag = failureTag(cause);
    return Effect.gen(function* () {
      // Before any other classification: a user's Stop is never a failure.
      const cancelled =
        isProviderSessionStartCancelled(cause) ||
        (yield* laneControl.cancelsStart({
          threadId,
          fenceSequence: input.fenceSequence,
          kind: "turn",
        }));
      if (cancelled) {
        yield* Effect.logInfo("provider command reactor cancelled a turn start after a stop", {
          threadId,
          messageId: event.payload.messageId,
          failureTag: tag,
        });
        return yield* settleCancelledTurnStart(event);
      }
      yield* Effect.annotateCurrentSpan({ "orchestration.failure_tag": tag });
      yield* Effect.logWarning("provider command reactor failed to start turn", {
        threadId,
        messageId: event.payload.messageId,
        commandId: event.commandId,
        failureTag: tag,
        cause: Cause.pretty(cause),
      });
      // Delegated wakes included: they cold-start sessions, so a failed wake must leave
      // lastError on the parent like any other turn start.
      yield* setThreadSessionErrorOnTurnStartFailure({
        threadId,
        messageId: event.payload.messageId,
        detail,
        createdAt: event.payload.createdAt,
        preserveActiveTurn: input.preserveActiveTurn,
      }).pipe(
        Effect.catchCause((sessionCause) =>
          Effect.logWarning(
            "provider command reactor failed to record turn start failure on the session",
            { threadId, cause: Cause.pretty(sessionCause) },
          ),
        ),
      );
      // One command, so a retry dedups on its receipt. If both attempts fail, the
      // intent row stays open and the next boot reports the start.
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        messageId: event.payload.messageId,
        summary: "Provider turn start failed",
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
      }).pipe(Effect.retry(Schedule.recurs(1)));
    }).pipe(
      Effect.catchCause((recoveryCause) =>
        Effect.logWarning("provider command reactor failed to recover turn start failure", {
          eventType: event.type,
          threadId,
          cause: Cause.pretty(recoveryCause),
          originalCause: Cause.pretty(cause),
        }),
      ),
    );
  };

  const prepareAndSubmitTurnStart = Effect.fn("prepareAndSubmitTurnStart")(function* (
    event: TurnStartRequestedEvent,
    fenceSequence: number,
  ) {
    const threadId = event.payload.threadId;
    const turnFence = { threadId, fenceSequence, kind: "turn" as const };
    // Essential reads fail the turn visibly through the boundary in
    // processTurnStartRequested. A deleted thread stays silent: no outcome can
    // be shown, so its intent is settled explicitly.
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return yield* providerEffectIntents.settle({ sequence: event.sequence });
    }
    if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        messageId: event.payload.messageId,
        summary: "Provider turn start rejected",
        detail: `Thread already has active turn '${thread.session.activeTurnId}'. Queuing overlapping turns is not supported; wait for the active turn to finish before starting another.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const message = yield* resolveTurnStartMessage(event.payload.threadId, event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        messageId: event.payload.messageId,
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    // Best-effort: the count only gates first-turn title and branch generation.
    const isFirstUserMessageTurn = yield* resolveUserMessageCount(event.payload.threadId).pipe(
      Effect.map((count) => count === 1),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(
              "provider command reactor could not count user messages; skipping first-turn generation",
              { threadId: event.payload.threadId, cause: Cause.pretty(cause) },
            ).pipe(Effect.as(false)),
      ),
    );

    if (hasRetiredProjectMemory(event.payload)) {
      return yield* Effect.fail(new Error(REMOVED_PROJECT_MEMORY_MESSAGE));
    }

    // A delegated wake is a normal queued turn start: ensureSessionForThread creates or
    // resumes the session. The decider requires an unchanged model selection, so a handoff
    // is unreachable here; keep the defensive check (never hand off on untrusted input).
    if (event.payload.delegationReturnGuard && event.payload.contextHandoff !== undefined) {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        messageId: event.payload.messageId,
        summary: "Delegated return was not submitted",
        detail:
          "A delegated result cannot start a model handoff. Inspect this result before sending it manually.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    if (event.payload.contextHandoff !== undefined) {
      // Handoff owns a separate session-start path. Its current human request
      // must replace (or clear) the previous turn's Computer catalog too.
      stageComputerTurn(event.payload.threadId, undefined);
      if (event.payload.computerUse)
        stageComputerTurn(event.payload.threadId, {
          intent: event.payload.computerUse,
          text: message.text,
          runtimeMode: thread.runtimeMode,
          label: thread.title,
          createdAt: event.payload.createdAt,
        });
      const project = yield* resolveProject(thread.projectId);
      yield* ensureRecordedWorktreeAvailable(thread, project);
      // The lane item stays busy for the whole handoff, which keeps the thread's
      // later items in order. Stop and interrupt reach the provider out of band
      // while it owns the running turn, and settle in order afterwards.
      yield* Effect.scoped(
        leaseThreadPath(thread, project).pipe(
          Effect.andThen(
            contextHandoffCoordinator.processTurnStart(event, {
              guardStart: (effect) => laneControl.guardStart(turnFence, effect),
              onDispatchStarted: laneControl.beginTurnOwnership(threadId, fenceSequence),
              stopRequested: laneControl.stopRequestedSince(threadId, fenceSequence),
            }),
          ),
        ),
      ).pipe(Effect.ensuring(laneControl.endTurnOwnership(threadId)));
      return;
    }

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      fenceSequence,
      messageText: message.text,
      ...(event.payload.computerUse ? { computerUse: event.payload.computerUse } : {}),
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      tokenMode: event.payload.tokenMode,
      createdAt: event.payload.createdAt,
    });

    if (isFirstUserMessageTurn) {
      // Title and branch generation are best-effort and must never fail a turn
      // whose session is already started.
      yield* Effect.gen(function* () {
        const project = yield* resolveProject(thread.projectId);
        const generationCwd =
          resolveThreadWorkspaceCwd({
            thread,
            projects: project ? [project] : [],
          }) ?? process.cwd();
        const generationInput = {
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        };

        yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
          threadId: event.payload.threadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          worktreeId: thread.worktreeId ?? null,
          ...generationInput,
        }).pipe(Effect.forkScoped);

        if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
          yield* maybeGenerateThreadTitleForFirstTurn({
            threadId: event.payload.threadId,
            cwd: generationCwd,
            ...generationInput,
          }).pipe(Effect.forkScoped);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider command reactor skipped first-turn generation", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }

    const commitAcceptedModelSelection: Effect.Effect<unknown, OrchestrationDispatchError> =
      event.payload.modelSelection !== undefined &&
      !Equal.equals(thread.modelSelection, event.payload.modelSelection)
        ? orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("accepted-model-selection"),
            threadId: event.payload.threadId,
            modelSelection: event.payload.modelSelection,
          })
        : Effect.void;

    // A Stop that arrived while the session was prepared ends the turn here,
    // before anything is submitted.
    yield* laneControl.failIfCancelled(turnFence);

    // Submission failures may follow this request's own turn.started, so they
    // reset a running session (preserveActiveTurn: false), as before. A turn the
    // provider accepted is never reported as a failed start: the model-selection
    // commit after it only logs. The thread's fence state is retained until the
    // send settles, so a failure after a Stop is still recognised as a cancel.
    const send = Effect.suspend(() => providerService.sendTurn(sendTurnRequest)).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          reportTurnStartFailure({ event, fenceSequence, cause, preserveActiveTurn: false }),
        onSuccess: () =>
          commitAcceptedModelSelection.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning(
                    "provider command reactor failed to commit accepted model selection",
                    { threadId, cause: Cause.pretty(cause) },
                  ),
            ),
          ),
      }),
    );
    const releaseFenceState = yield* laneControl.retain(threadId);
    // Marked immediately before the provider call: from here the provider may
    // have received the turn, so recovery reports it as unconfirmed, not unsent.
    // A failed mark is a start failure before anything was submitted.
    yield* providerEffectIntents
      .markDispatched({ sequence: event.sequence, dispatchedAt: new Date().toISOString() })
      .pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            reportTurnStartFailure({ event, fenceSequence, cause, preserveActiveTurn: true }),
          onSuccess: () => send,
        }),
        Effect.ensuring(releaseFenceState),
        Effect.forkScoped,
      );
  });

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: TurnStartRequestedEvent,
    fenceSequence: number,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledRecently(key)) {
      return;
    }
    // One visible failure boundary for every preparation step. Nothing was
    // submitted yet, so a turn that is running belongs to someone else.
    yield* prepareAndSubmitTurnStart(event, fenceSequence).pipe(
      Effect.catchCause((cause) =>
        reportTurnStartFailure({ event, fenceSequence, cause, preserveActiveTurn: true }),
      ),
    );
  });

  type InterruptEvent = Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>;

  const appendInterruptFailure = (event: InterruptEvent, detail: string) =>
    appendProviderFailureActivity({
      threadId: event.payload.threadId,
      kind: "provider.turn.interrupt.failed",
      summary: "Provider turn interrupt failed",
      detail,
      turnId: event.payload.turnId ?? null,
      createdAt: event.payload.createdAt,
    });

  /** The stop an interrupt failure escalated to failed as well. */
  const appendEscalatedStopFailure = (event: InterruptEvent, stopFailed: string | undefined) =>
    stopFailed === undefined
      ? Effect.void
      : appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.session.stop.failed",
          summary: "Provider session stop failed",
          detail: stopFailed,
          turnId: null,
          createdAt: event.payload.createdAt,
        });

  /**
   * The projection write after an interrupt failed and the session was stopped:
   * session `stopped` with the failure text, and the interrupt failure activity.
   * Skips sessions that settled on their own meanwhile. With `alwaysReport` (the
   * out-of-band path, whose handoff may already have projected its source
   * `stopped`), the failures are shown whatever the projection says.
   */
  const projectInterruptFailure = Effect.fnUntraced(function* (
    event: InterruptEvent,
    detail: string,
    options?: { readonly alwaysReport?: boolean; readonly stopFailed?: string | undefined },
  ) {
    const stoppedThread = yield* resolveThread(event.payload.threadId);
    const stoppedSession = stoppedThread?.session;
    if (
      !stoppedSession ||
      stoppedSession.status === "stopped" ||
      stoppedSession.status === "ready" ||
      stoppedSession.activeTurnId === null ||
      (event.payload.turnId !== undefined && stoppedSession.activeTurnId !== event.payload.turnId)
    ) {
      if (options?.alwaysReport) {
        yield* appendInterruptFailure(event, detail);
        yield* appendEscalatedStopFailure(event, options.stopFailed);
      }
      return;
    }

    yield* setThreadSession({
      threadId: event.payload.threadId,
      session: {
        ...stoppedSession,
        status: "stopped",
        activeTurnId: null,
        lastError: detail,
        updatedAt: event.payload.createdAt,
      },
      turnOutcome: {
        turnId: stoppedSession.activeTurnId,
        state: "interrupted",
        reason: TURN_FINALIZATION_REASON.interruptFailed,
        completedAt: event.payload.createdAt,
      },
      createdAt: event.payload.createdAt,
    });
    yield* appendInterruptFailure(event, detail);
    yield* appendEscalatedStopFailure(event, options?.stopFailed);
  });

  /**
   * No runtime was live to interrupt: release the projected turn as interrupted.
   * Not a failure; nothing to report.
   */
  const settleAfterInterruptWithoutRuntime = Effect.fnUntraced(function* (event: InterruptEvent) {
    const thread = yield* resolveThread(event.payload.threadId);
    const session = thread?.session;
    if (!session || session.status === "stopped") return;
    yield* setThreadSession({
      threadId: event.payload.threadId,
      session: {
        ...session,
        status: "stopped",
        activeTurnId: null,
        updatedAt: event.payload.createdAt,
      },
      turnOutcome: {
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
        state: "interrupted",
        reason: TURN_FINALIZATION_REASON.interruptWithoutRuntime,
        completedAt: event.payload.createdAt,
      },
      createdAt: event.payload.createdAt,
    });
  });

  const isSessionNotFound = (cause: Cause.Cause<unknown>): boolean =>
    cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) && Schema.is(ProviderSessionNotFoundError)(reason.error),
    );

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: InterruptEvent,
  ) {
    if (isProviderOriginatedCommandId(event.commandId)) {
      return;
    }
    const threadId = event.payload.threadId;

    // The provider side already ran out of band (the lane was busy with a
    // handoff turn); this in-order item only settles the projection.
    const outOfBand = yield* laneControl.takeOutOfBand(threadId, event.eventId);
    if (Option.isSome(outOfBand)) {
      const outcome = yield* Deferred.await(outOfBand.value);
      switch (outcome.kind) {
        case "interrupted":
          // Ingestion or the handoff's own success path settles the turn.
          return;
        case "nothing-live":
          return yield* settleAfterInterruptWithoutRuntime(event);
        case "interrupt-failed-turn-not-current":
          // As in lane: the targeted turn already ended; nothing to settle or show.
          return;
        case "stopped-after-interrupt-failure":
          // Always shown: the handoff may already have projected its source stopped.
          return yield* projectInterruptFailure(event, outcome.detail, {
            alwaysReport: true,
            stopFailed: outcome.stopFailed,
          });
        case "stop-failed":
          // Only an unexpected out-of-band failure reports this for an interrupt.
          return yield* appendInterruptFailure(event, outcome.detail);
        case "stopped":
          return;
      }
    }

    // This interrupt cancelled a start, whose item already settled the projection.
    // It still interrupts whatever runtime is live: the cancelled start may not
    // have replaced the running turn's runtime yet. ProviderService never
    // recovers a runtime to interrupt it, so nothing dead is resurrected.
    const cancelledAStart = yield* laneControl.cancelledAStart(threadId, event.eventId);

    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      // The cancelled start found no live runtime and settled the session stopped.
      if (cancelledAStart) return;
      return yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }
      if (isSessionNotFound(cause)) {
        return settleAfterInterruptWithoutRuntime(event);
      }

      const detail = userFacingFailureDetail(cause);
      return Effect.gen(function* () {
        yield* Effect.logWarning("provider command reactor failed to interrupt turn", {
          threadId,
          failureTag: failureTag(cause),
          cause: Cause.pretty(cause),
        });
        const latestThread = yield* resolveThread(threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          latestSession.activeTurnId === null ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        // Bounded inside ProviderService.
        yield* providerService.stopSession({ threadId }).pipe(
          Effect.catchCause((stopCause) =>
            Cause.hasInterruptsOnly(stopCause)
              ? Effect.interrupt
              : Effect.logWarning(
                  "provider command reactor failed to stop session after interrupt failure",
                  {
                    threadId,
                    cause: Cause.pretty(stopCause),
                    originalCause: Cause.pretty(cause),
                  },
                ),
          ),
        );

        yield* projectInterruptFailure(event, detail);
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    // ProviderService never recovers a runtime to interrupt it.
    yield* providerService
      .interruptTurn({ threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processGoalUpdated = Effect.fn("processGoalUpdated")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-updated" }>,
    fenceSequence: number,
  ) {
    if (event.payload.origin !== "client" || event.payload.goal.synchronization?.deferUntilTurn)
      return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (thread?.goal?.synchronization?.requestId !== event.payload.goal.synchronization?.requestId)
      return;
    const threadId = event.payload.threadId;
    const session = yield* ensureSessionForThread(threadId, event.occurredAt, {
      fenceSequence,
      kind: "restart",
    }).pipe(
      Effect.map(() => "ready" as const),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          // A Stop cancelled the start: the goal stays pending, and the next
          // session start reconciles it.
          if (isProviderSessionStartCancelled(cause)) {
            yield* settleSessionAfterCancelledStart(threadId, { force: false });
            return "cancelled" as const;
          }
          const goal = thread?.goal;
          if (goal?.synchronization) {
            yield* orchestrationEngine.dispatch({
              type: "thread.goal.sync",
              commandId: serverCommandId("goal-session-failed"),
              threadId,
              expectedRequestId: goal.synchronization.requestId,
              goal: {
                ...goal,
                synchronization: {
                  ...goal.synchronization,
                  state: "failed",
                  error: userFacingFailureDetail(cause),
                },
              },
              createdAt: new Date().toISOString(),
            });
          }
          return yield* Effect.failCause(cause);
        }),
      ),
    );
    if (session === "cancelled") return;
    const result = yield* reconcileThreadGoal(threadId);
    if (event.payload.goal.synchronization?.startTurn && result.goal?.status === "active") {
      // A Stop noted while the goal was reconciled wins: no new agent turn after it.
      if (yield* laneControl.cancelsStart({ threadId, fenceSequence, kind: "restart" })) return;
      const sessions = yield* providerService.listSessions();
      if (sessions.some((session) => session.threadId === threadId && session.status === "running"))
        return;
      const current = yield* resolveThread(threadId);
      if (!current || current.goal?.synchronization?.state === "pending") return;
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("goal-resume-turn"),
        threadId,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text: `Continue pursuing this goal: ${result.goal.objective}`,
          attachments: [],
        },
        runtimeMode: current.runtimeMode,
        interactionMode: current.interactionMode,
        createdAt: new Date().toISOString(),
      });
    }
  });

  // Older persisted client clear events are still accepted during replay.
  const processGoalCleared = Effect.fn("processGoalCleared")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-cleared" }>,
  ) {
    if (event.payload.origin !== "client") return;
    yield* (
      providerService.clearThreadGoal?.(event.payload.threadId) ?? Effect.succeed(false as const)
    );
  });

  type SteerEvent = Extract<ProviderIntentEvent, { type: "thread.turn-steer-requested" }>;

  /** The steer request a resolution answers; shared by live resolution and recovery. */
  const steerRequestCommandId = (event: SteerEvent): CommandId =>
    event.commandId ?? CommandId.make(`event:${event.eventId}:turn-steer-request`);

  /**
   * Resolves a steer request. A rejection makes the decider append the visible
   * `provider.turn.steer.failed` activity; either outcome settles the intent.
   */
  const resolveSteer = (
    event: SteerEvent,
    resolution:
      | {
          readonly status: "accepted";
          readonly turnId: TurnId;
          readonly resolvedAt: string;
        }
      | {
          readonly status: "rejected";
          readonly error: string;
          readonly reason: TurnSteerRejectionReason;
          readonly resolvedAt: string;
        },
    commandId: CommandId = serverCommandId("turn-steer-resolve"),
  ) => {
    const commandBase = {
      type: "thread.turn.steer.resolve" as const,
      commandId,
      requestCommandId: steerRequestCommandId(event),
      threadId: event.payload.threadId,
      expectedTurnId: event.payload.expectedTurnId,
      message: event.payload.message,
      createdAt: event.payload.createdAt,
      requestedAt: event.payload.requestedAt,
    };
    if (resolution.status === "accepted") {
      return orchestrationEngine.dispatch({ ...commandBase, resolution });
    }
    return orchestrationEngine.dispatch({ ...commandBase, resolution });
  };

  const processTurnSteerRequested = Effect.fn("processTurnSteerRequested")(function* (
    event: SteerEvent,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledRecently(key)) return;
    const steer = Effect.suspend(() =>
      providerService.steerTurn({
        threadId: event.payload.threadId,
        expectedTurnId: event.payload.expectedTurnId,
        messageId: event.payload.message.messageId,
        ...(toNonEmptyProviderInput(event.payload.message.text)
          ? { input: toNonEmptyProviderInput(event.payload.message.text) }
          : {}),
        ...(event.payload.message.attachments.length > 0
          ? { attachments: event.payload.message.attachments }
          : {}),
      }),
    );

    // Marked immediately before the provider call, as for a turn start.
    yield* providerEffectIntents
      .markDispatched({ sequence: event.sequence, dispatchedAt: new Date().toISOString() })
      .pipe(
        Effect.andThen(steer),
        Effect.flatMap((result) =>
          resolveSteer(event, {
            status: "accepted",
            turnId: result.turnId,
            resolvedAt: new Date().toISOString(),
          }),
        ),
        Effect.catchCause((cause) =>
          // Shutdown: the intent stays open and the next boot reports it.
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.gen(function* () {
                const classified = classifyTurnSteerFailure(cause, (failed) =>
                  userFacingFailureDetail(failed, { fallback: "Provider rejected turn steering." }),
                );
                yield* Effect.logWarning("provider command reactor failed to steer turn", {
                  threadId: event.payload.threadId,
                  failureTag: failureTag(cause),
                  reason: classified.reason,
                  cause: Cause.pretty(cause),
                });
                yield* resolveSteer(event, {
                  status: "rejected",
                  error: classified.error,
                  reason: classified.reason,
                  resolvedAt: new Date().toISOString(),
                });
              }),
        ),
        Effect.forkScoped,
      );
  });

  const processCallbackResponseRequested = Effect.fn("processCallbackResponseRequested")(function* (
    event: CallbackResponseEvent,
  ) {
    const isApproval = event.type === "thread.approval-response-requested";
    const kind = isApproval ? "approval" : "user-input";
    const label = isApproval ? "Approval" : "Question";
    const identity =
      event.type === "thread.approval-response-requested"
        ? event.payload.approvalIdentity
        : event.payload.userInputIdentity;
    const identityPayload = identity
      ? isApproval
        ? { approvalIdentity: identity }
        : { userInputIdentity: identity }
      : {};
    const key = { threadId: event.payload.threadId, requestId: event.payload.requestId };
    const claim = isApproval
      ? yield* approvals.getByRequestId(key)
      : Option.map(yield* questions.getByRequestId(key), questionAsCallback);
    if (
      Option.isNone(claim) ||
      claim.value.status !== "pending" ||
      claim.value.responseState !== "submitting" ||
      !matchesApprovalAttempt(claim.value, identity, event.commandId)
    )
      return;
    const fail = (detail: string, responseState: ApprovalResponseState) =>
      appendProviderFailureActivity({
        ...key,
        kind: `provider.${kind}.respond.failed`,
        summary: `Provider ${label.toLowerCase()} response failed`,
        detail,
        turnId: null,
        createdAt: new Date().toISOString(),
        ...identityPayload,
        ...(event.commandId ? { responseAttemptId: event.commandId } : {}),
        responseState,
      });
    const thread = yield* resolveThread(key.threadId);
    if (
      !thread?.session ||
      thread.session.status === "stopped" ||
      thread.session.runtimeSessionId !== identity?.runtimeSessionId
    ) {
      return yield* fail(stalePendingRequestDetail(kind, key.requestId), "invalidated");
    }
    const runtime = identity?.runtimeSessionId
      ? { expectedRuntimeSessionId: identity.runtimeSessionId }
      : {};
    const respond =
      event.type === "thread.approval-response-requested"
        ? providerService.respondToRequest({
            ...key,
            ...runtime,
            decision: event.payload.decision,
          })
        : providerService.respondToUserInput({
            ...key,
            ...runtime,
            answers: event.payload.answers,
          });
    yield* respond.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          const stale =
            (isApproval
              ? isUnknownPendingApprovalRequestError(cause)
              : isUnknownPendingUserInputRequestError(cause)) ||
            cause.reasons.some(
              (reason) =>
                Cause.isFailReason(reason) &&
                (Schema.is(ProviderSessionNotFoundError)(reason.error) ||
                  (!isApproval &&
                    (Schema.is(ProviderAdapterSessionNotFoundError)(reason.error) ||
                      Schema.is(ProviderAdapterSessionClosedError)(reason.error)))),
            );
          // Only explicit adapter evidence of non-delivery permits another attempt.
          // A transport error remains claimed, including optional question steers.
          const requestError = findProviderAdapterRequestError(cause);
          const retryable = isApproval
            ? requestError?.approvalResponseNotSent === true
            : requestError?.userInputResponseNotSent === true;
          return Effect.logWarning(`provider command reactor failed to deliver ${kind} response`, {
            threadId: key.threadId,
            requestId: key.requestId,
            failureTag: failureTag(cause),
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.andThen(
              fail(
                stale
                  ? stalePendingRequestDetail(kind, key.requestId)
                  : userFacingFailureDetail(cause),
                stale ? "invalidated" : retryable ? "retryable" : "uncertain",
              ),
            ),
          );
        },
        onSuccess: () =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: serverCommandId(`${kind}-settled`),
            threadId: key.threadId,
            activity: {
              id: EventId.make(`${kind}-settled:${event.commandId}`),
              kind: `${kind}.resolved`,
              tone: "info",
              summary: `${label} response delivered`,
              payload: {
                requestId: key.requestId,
                ...identityPayload,
                runtimeSessionId: identity?.runtimeSessionId,
                responseAttemptId: event.commandId,
                ...(event.type === "thread.approval-response-requested"
                  ? { decision: event.payload.decision }
                  : { answers: event.payload.answers }),
              },
              turnId: null,
              createdAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
          }),
      }),
    );
  });

  /**
   * The provider has nothing left to stop: no runtime (gone with an earlier
   * process, or reaped) or no persisted binding at all, which `stopSession`
   * reports as a validation error.
   */
  const isNothingLeftToStop = (cause: Cause.Cause<unknown>): boolean =>
    cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) &&
        (Schema.is(ProviderSessionNotFoundError)(reason.error) ||
          Schema.is(ProviderAdapterSessionNotFoundError)(reason.error) ||
          Schema.is(ProviderAdapterSessionClosedError)(reason.error) ||
          Schema.is(ProviderValidationError)(reason.error)),
    );

  /**
   * The user's Stop: stops the provider session and always projects `stopped`,
   * so the thread never stays busy. A failed stop is shown. The live path stamps
   * the request's time; startup recovery of an earlier process's stop stamps the
   * recovery time (`at: "now"`). Idempotent, so recovery may retry it.
   */
  const stopThreadSession = Effect.fn("stopThreadSession")(function* (input: {
    readonly event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>;
    readonly at: "requested" | "now";
  }) {
    const { event } = input;
    const threadId = event.payload.threadId;
    let stopFailure: string | undefined;
    // The provider stop already ran out of band (the lane was busy with a
    // handoff turn); this in-order item only settles the projection.
    const outOfBand = yield* laneControl.takeOutOfBand(threadId, event.eventId);
    if (Option.isSome(outOfBand)) {
      const outcome = yield* Deferred.await(outOfBand.value);
      if (outcome.kind === "stop-failed") stopFailure = outcome.detail;
    }

    const thread = yield* resolveThread(threadId);
    if (!thread) {
      // No outcome can be shown for a thread that is gone.
      return yield* providerEffectIntents.settle({ sequence: event.sequence });
    }

    const now = input.at === "now" ? new Date().toISOString() : event.payload.createdAt;
    if (Option.isNone(outOfBand) && thread.session && thread.session.status !== "stopped") {
      // Bounded inside ProviderService; a timed-out stop is retried by the reaper.
      const stopExit = yield* Effect.exit(providerService.stopSession({ threadId: thread.id }));
      if (Exit.isFailure(stopExit)) {
        if (Cause.hasInterruptsOnly(stopExit.cause)) return yield* stopExit;
        if (isNothingLeftToStop(stopExit.cause)) {
          yield* Effect.logDebug("provider command reactor found no provider session to stop", {
            threadId,
            failureTag: failureTag(stopExit.cause),
          });
        } else {
          yield* Effect.logWarning("provider command reactor failed to stop session", {
            threadId,
            failureTag: failureTag(stopExit.cause),
            cause: Cause.pretty(stopExit.cause),
          });
          stopFailure = userFacingFailureDetail(stopExit.cause);
        }
      }
    }
    if (stopFailure !== undefined) {
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.session.stop.failed",
        summary: "Provider session stop failed",
        detail: stopFailure,
        turnId: null,
        createdAt: now,
      });
    }

    // Always settled: the user asked for the stop, so the thread never stays busy.
    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        tokenMode: thread.session?.tokenMode ?? DEFAULT_TOKEN_MODE,
        activeTurnId: null,
        lastError: stopFailure ?? thread.session?.lastError ?? null,
        updatedAt: now,
      },
      // The user stopped the session; a carried-over lastError must not label the turn.
      turnOutcome: {
        state: "interrupted",
        reason: TURN_FINALIZATION_REASON.sessionStopped,
        completedAt: now,
      },
      createdAt: now,
    });
  });

  /**
   * A runtime-mode or token-mode restart that did not complete. A Stop cancel
   * only settles the projection. Any other failure is reported visibly, and the
   * session is projected stopped when no live runtime matches it any more.
   */
  const reportRestartFailure = (
    event: Extract<
      ProviderIntentEvent,
      { type: "thread.runtime-mode-set" | "thread.token-mode-set" }
    >,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void, never> => {
    const threadId = event.payload.threadId;
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
    if (isProviderSessionStartCancelled(cause)) {
      return settleSessionAfterCancelledStart(threadId, { force: false }).pipe(
        Effect.catchCause((settleCause) =>
          Effect.logWarning("provider command reactor failed to settle a cancelled restart", {
            threadId,
            cause: Cause.pretty(settleCause),
          }),
        ),
      );
    }
    const detail = userFacingFailureDetail(cause);
    return Effect.gen(function* () {
      yield* Effect.logWarning("provider command reactor failed to restart provider session", {
        threadId,
        eventType: event.type,
        failureTag: failureTag(cause),
        cause: Cause.pretty(cause),
      });
      const now = new Date().toISOString();
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.session.restart.failed",
        summary: "Provider session restart failed",
        detail,
        turnId: null,
        createdAt: now,
      });
      const thread = yield* resolveThread(threadId);
      const session = thread?.session;
      if (!session || session.status === "stopped") return;
      const { known, live } = yield* readLiveRuntime(threadId);
      // Unknown liveness is not "gone": leave the session as it is.
      if (!known || (live !== undefined && live.runtimeSessionId === session.runtimeSessionId))
        return;
      yield* setThreadSession({
        threadId,
        session: {
          ...session,
          status: "stopped",
          activeTurnId: null,
          lastError: detail,
          updatedAt: now,
        },
        turnOutcome: {
          state: "interrupted",
          reason: TURN_FINALIZATION_REASON.sessionReplaced,
          completedAt: now,
        },
        createdAt: now,
      });
    }).pipe(
      Effect.catchCause((reportCause) =>
        Effect.logWarning("provider command reactor failed to report a restart failure", {
          threadId,
          cause: Cause.pretty(reportCause),
          originalCause: Cause.pretty(cause),
        }),
      ),
    );
  };

  const processModeChange = Effect.fn("processModeChange")(function* (
    event: Extract<
      ProviderIntentEvent,
      { type: "thread.runtime-mode-set" | "thread.token-mode-set" }
    >,
    fenceSequence: number,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread?.session || thread.session.status === "stopped") {
      return;
    }
    const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
    yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
      fenceSequence,
      kind: "restart",
      ...(cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {}),
    }).pipe(Effect.catchCause((cause) => reportRestartFailure(event, cause)));
  });

  const annotateIntentEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration.event_type": event.type,
        "orchestration.thread_id": event.payload.threadId,
        ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
      });
      yield* increment(orchestrationEventsProcessedTotal, {
        eventType: event.type,
      });
    });

  const processLifecycleEvent = Effect.fn("processLifecycleEvent")(function* (
    event: LifecycleIntentEvent,
    fenceSequence: number,
    options: { readonly priorProcess?: true } = {},
  ) {
    yield* annotateIntentEvent(event);
    switch (event.type) {
      case "thread.runtime-mode-set":
      case "thread.token-mode-set":
        yield* processModeChange(event, fenceSequence);
        return;
      case "thread.goal-updated":
        yield* processGoalUpdated(event, fenceSequence);
        return;
      case "thread.goal-cleared":
        yield* processGoalCleared(event);
        return;
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event, fenceSequence);
        return;
      case "thread.turn-steer-requested":
        yield* processTurnSteerRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* stopThreadSession({ event, at: options.priorProcess ? "now" : "requested" });
        return;
    }
  });

  // Turn liveness bookkeeping, owned by the sweep: the previous suspicion per
  // thread, and the turn already reported unresponsive.
  const livenessSuspects = new Map<ThreadId, TurnLivenessVerdict>();
  const livenessWarned = new Map<ThreadId, TurnId>();

  /**
   * Classifies one thread's turn. The live-runtime lookup runs only for a running
   * turn whose runtime has an activity record. A `null` verdict means liveness is
   * unknown (the lookup failed): never act on it, and keep any suspicion as is.
   */
  const classifyThreadLiveness = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly activity: ProviderRuntimeActivity | null;
    readonly previous: TurnLivenessVerdict | null;
  }) {
    const nowMs = yield* Clock.currentTimeMillis;
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session ?? null;
    const activity = input.activity;
    if (!turnLivenessApplies({ session, activity })) {
      return { verdict: { kind: "not-applicable" } as TurnLivenessVerdict, session };
    }
    const { known, live } = yield* readLiveRuntime(input.threadId);
    if (!known) return { verdict: null, session };
    const verdict = classifyTurnLiveness({
      session,
      hasPendingRequest: Boolean(thread?.hasPendingApprovals || thread?.hasPendingUserInput),
      backgroundLiveness: thread?.backgroundLiveness,
      liveRuntimeSessionId: live?.runtimeSessionId ?? null,
      activity,
      previous: input.previous,
      alreadyWarned:
        session?.activeTurnId != null &&
        livenessWarned.get(input.threadId) === session.activeTurnId,
      nowMs,
      sweepIntervalMs: livenessSweepIntervalMs,
      unresponsiveAfterMs,
    });
    return { verdict, session };
  });

  /** Runs in the thread's lifecycle lane: acts only if the verdict still holds. */
  const applyLivenessVerdict = Effect.fnUntraced(function* (
    threadId: ThreadId,
    verdict: LivenessVerdict,
  ) {
    const activities = yield* providerService.listRuntimeActivity?.() ?? Effect.succeed([]);
    const { verdict: current, session } = yield* classifyThreadLiveness({
      threadId,
      activity: activities.find((entry) => entry.threadId === threadId) ?? null,
      previous: verdict,
    });
    if (
      current === null ||
      session === null ||
      current.kind !== verdict.kind ||
      current.runtimeSessionId !== verdict.runtimeSessionId ||
      current.turnId !== verdict.turnId
    ) {
      return;
    }
    const now = new Date().toISOString();
    if (current.kind === "lost") {
      livenessSuspects.delete(threadId);
      yield* setThreadSession({
        threadId,
        session: {
          ...session,
          status: "error",
          activeTurnId: null,
          lastError: TURN_LOST_DETAIL,
          updatedAt: now,
        },
        turnOutcome: {
          turnId: current.turnId,
          state: "error",
          reason: TURN_FINALIZATION_REASON.providerRuntimeLost,
          completedAt: now,
        },
        createdAt: now,
      });
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.lost",
        summary: "Provider turn lost",
        detail: TURN_LOST_DETAIL,
        turnId: current.turnId,
        createdAt: now,
      });
      return;
    }
    if (current.kind === "unresponsive") {
      livenessWarned.set(threadId, current.turnId);
      yield* orchestrationEngine.dispatch(
        providerNoticeActivityCommand({
          threadId,
          kind: "provider.turn.unresponsive",
          summary: "Provider is quiet",
          payload: {
            detail: unresponsiveTurnDetail(current.silentForMs),
            turnId: current.turnId,
            runtimeSessionId: current.runtimeSessionId,
            lastActivityAt: new Date(current.lastActivityAtMs).toISOString(),
            thresholdMs: unresponsiveAfterMs,
          },
          turnId: current.turnId,
          createdAt: now,
        }),
      );
    }
  });

  /**
   * A failure that escaped a tracked handler becomes a visible outcome, which
   * settles its intent. An intent already handed to the provider is left to the
   * provider's outcome (or to the next boot's "unconfirmed"): a failure here
   * cannot prove the provider never received it. Never fails; if the outcome
   * cannot be appended, the intent stays open for the next boot.
   */
  const surfaceIntentFailure = (
    event: TrackedProviderIntentEvent,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const row = yield* providerEffectIntents.get({ sequence: event.sequence });
      if (Option.isNone(row)) return;
      const threadId = event.payload.threadId;
      if (row.value.dispatchedAt !== null) {
        return yield* Effect.logWarning(
          "provider command reactor left a dispatched intent to its provider outcome",
          { threadId, eventType: event.type, sequence: event.sequence },
        );
      }
      const detail = userFacingFailureDetail(cause);
      const ids = providerIntentFailureIds(event.sequence);
      const createdAt = new Date().toISOString();
      switch (event.type) {
        case "thread.turn-start-requested":
          return yield* appendProviderFailureActivity({
            threadId,
            kind: "provider.turn.start.failed",
            messageId: event.payload.messageId,
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt,
            ...ids,
          });
        case "thread.turn-steer-requested": {
          // It never reached the provider: a session that ended defers it (the message stays
          // queued and is sent next), anything else is a visible failure.
          const classified = classifyTurnSteerFailure(cause, () => detail);
          return yield* resolveSteer(
            event,
            {
              status: "rejected",
              error: classified.error,
              reason: classified.reason,
              resolvedAt: createdAt,
            },
            ids.commandId,
          );
        }
        case "thread.session-stop-requested":
          return yield* appendProviderFailureActivity({
            threadId,
            kind: "provider.session.stop.failed",
            summary: "Provider session stop failed",
            detail,
            turnId: null,
            createdAt,
            ...ids,
          });
      }
    }).pipe(
      Effect.catchCause((surfaceCause) =>
        Cause.hasInterruptsOnly(surfaceCause)
          ? Effect.interrupt
          : Effect.logWarning("provider command reactor could not surface an intent failure", {
              eventType: event.type,
              sequence: event.sequence,
              cause: Cause.pretty(surfaceCause),
            }),
      ),
    );

  /**
   * The one per-item failure wrapper of the lifecycle lanes. Interrupt-only
   * causes (from inner fibers) are logged and not re-raised; their intents stay
   * open for the next boot. Any other failure of a tracked request is surfaced
   * visibly before it is logged.
   */
  const processLaneItemSafely = (item: LaneItem) => {
    const run =
      item.kind === "event"
        ? processLifecycleEvent(
            item.event,
            item.fenceSequence,
            item.priorProcess ? { priorProcess: true } : {},
          )
        : applyLivenessVerdict(item.threadId, item.verdict);
    const threadId = item.kind === "event" ? item.event.payload.threadId : item.threadId;
    const guarded =
      item.kind === "event" && item.recovery ? recoveryPermits.withPermits(1)(run) : run;
    return guarded.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logDebug("provider command reactor lane item was interrupted", {
              itemKind: item.kind,
              threadId,
            })
          : (item.kind === "event" && isTrackedProviderIntentEvent(item.event)
              ? surfaceIntentFailure(item.event, cause)
              : Effect.void
            ).pipe(
              Effect.andThen(
                Effect.logWarning("provider command reactor failed to process event", {
                  eventType: item.kind === "event" ? item.event.type : "liveness-check",
                  threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
      ),
      Effect.andThen(
        item.kind === "event" ? laneControl.prune(threadId, item.fenceSequence) : Effect.void,
      ),
    );
  };

  const processCallbackSafely = (event: CallbackResponseEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* annotateIntentEvent(event);
      yield* processCallbackResponseRequested(event);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logDebug("provider command reactor callback item was interrupted", {
              threadId: event.payload.threadId,
            })
          : Effect.logWarning("provider command reactor failed to process event", {
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /**
   * A user stop or interrupt for a thread whose lane owns a running handoff turn.
   * Performs only the provider side (bounded) and records the outcome; the
   * in-order lane item settles the projection afterwards.
   */
  const runOutOfBandControl = (job: OutOfBandJob): Effect.Effect<void> => {
    const threadId = job.event.payload.threadId;
    // Built only when it runs: an escalation is conditional.
    const stop = Effect.suspend(() => providerService.stopSession({ threadId })).pipe(Effect.exit);
    const resolveOutcome: Effect.Effect<OutOfBandOutcome> = Effect.gen(function* () {
      if (job.event.type === "thread.turn-interrupt-requested") {
        const interruptExit = yield* Effect.exit(providerService.interruptTurn({ threadId }));
        if (Exit.isSuccess(interruptExit)) return { kind: "interrupted" } as const;
        if (isSessionNotFound(interruptExit.cause)) return { kind: "nothing-live" } as const;
        const detail = userFacingFailureDetail(interruptExit.cause);
        yield* Effect.logWarning("provider command reactor failed to interrupt a handoff turn", {
          threadId,
          failureTag: failureTag(interruptExit.cause),
          cause: Cause.pretty(interruptExit.cause),
        });
        // The in-lane rule: an interrupt aimed at a turn that is no longer the
        // active one never escalates to stopping the whole session.
        // When the projection cannot be read, the user's Stop still escalates.
        const targetTurnId = job.event.payload.turnId;
        if (targetTurnId !== undefined) {
          const latest = yield* resolveThread(threadId).pipe(
            Effect.map((thread) => ({ known: true as const, thread })),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.succeed({ known: false as const, thread: undefined }),
            ),
          );
          if (latest.known && latest.thread?.session?.activeTurnId !== targetTurnId) {
            return { kind: "interrupt-failed-turn-not-current", detail } as const;
          }
        }
        const stopExit = yield* stop;
        return {
          kind: "stopped-after-interrupt-failure",
          detail,
          ...(Exit.isFailure(stopExit)
            ? { stopFailed: userFacingFailureDetail(stopExit.cause) }
            : {}),
        } as const;
      }
      const stopExit = yield* stop;
      return Exit.isSuccess(stopExit)
        ? ({ kind: "stopped" } as const)
        : ({ kind: "stop-failed", detail: userFacingFailureDetail(stopExit.cause) } as const);
    });
    return resolveOutcome.pipe(
      Effect.flatMap((outcome) => Deferred.succeed(job.outcome, outcome)),
      // Completes the outcome exactly once, even on a defect or interrupt.
      Effect.onExit(() =>
        Deferred.succeed(job.outcome, { kind: "stop-failed", detail: UNEXPECTED_FAILURE_DETAIL }),
      ),
      Effect.asVoid,
    );
  };

  const lifecycleLanes = yield* makeKeyedSerialWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "ProviderCommandReactor.lifecycle",
      capacity: Math.max(1, options?.lifecycleCapacity ?? 1024),
    }),
    process: (_threadId: ThreadId, item: LaneItem) => processLaneItemSafely(item),
  });
  const callbackLanes = yield* makeKeyedSerialWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "ProviderCommandReactor.callback",
      capacity: 512,
    }),
    process: (_threadId: ThreadId, event: CallbackResponseEvent) => processCallbackSafely(event),
  });
  const outOfBandLanes = yield* makeKeyedSerialWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "ProviderCommandReactor.out-of-band",
      capacity: 256,
    }),
    process: (_threadId: ThreadId, job: OutOfBandJob) => runOutOfBandControl(job),
  });

  /**
   * The single per-thread entry point for live and synthetic provider-intent
   * events. Stop intent is recorded before enqueueing, so it never waits behind
   * a busy lane.
   */
  const routeProviderIntentEvent = (
    event: ProviderIntentEvent,
    route: {
      readonly fenceSequence?: number;
      readonly recovery?: true;
      readonly priorProcess?: true;
    } = {},
  ): Effect.Effect<void> => {
    const threadId = event.payload.threadId;
    // Pure deliveries to one exact runtime: they cannot overtake into the wrong
    // runtime (identity is checked), and must not queue behind a turn waiting on them.
    if (isCallbackResponseEvent(event)) {
      return callbackLanes.enqueue(threadId, event);
    }
    return Effect.gen(function* () {
      // Once per process: startup intent recovery and the live subscription may
      // both deliver a request committed while the reactor was subscribing.
      if (
        isTrackedProviderIntentEvent(event) &&
        (yield* hasHandledRecently(`route:${event.eventId}`))
      ) {
        return;
      }
      const { outOfBand } = yield* laneControl.noteEvent(event);
      if (
        outOfBand &&
        (event.type === "thread.turn-interrupt-requested" ||
          event.type === "thread.session-stop-requested")
      ) {
        const outcome = yield* laneControl.registerOutOfBand(threadId, event.eventId);
        yield* outOfBandLanes.enqueue(threadId, { event, outcome });
      }
      yield* lifecycleLanes.enqueue(threadId, {
        kind: "event",
        event,
        fenceSequence: route.fenceSequence ?? event.sequence,
        ...(route.recovery ? { recovery: true as const } : {}),
        ...(route.priorProcess ? { priorProcess: true as const } : {}),
      });
    });
  };

  const sweepLiveness: ProviderCommandReactorShape["sweepLiveness"] = Effect.gen(function* () {
    const activities = yield* providerService.listRuntimeActivity?.() ?? Effect.succeed([]);
    const seen = new Set<ThreadId>();
    for (const activity of activities) {
      const threadId = activity.threadId;
      seen.add(threadId);
      // A busy lane may be restarting or stopping the runtime right now.
      if (!(yield* lifecycleLanes.isIdle(threadId))) continue;
      const { verdict } = yield* classifyThreadLiveness({
        threadId,
        activity,
        previous: livenessSuspects.get(threadId) ?? null,
      });
      // Unknown this sweep: keep the suspicion for the next one.
      if (verdict === null) continue;
      switch (verdict.kind) {
        case "suspect-lost":
          livenessSuspects.set(threadId, verdict);
          break;
        case "lost":
        case "unresponsive":
          livenessSuspects.set(threadId, verdict);
          yield* lifecycleLanes.enqueue(threadId, { kind: "liveness", threadId, verdict });
          break;
        default:
          livenessSuspects.delete(threadId);
      }
    }
    // Forget threads whose runtime is gone from the activity map, and warnings
    // for turns that are no longer active.
    for (const threadId of livenessSuspects.keys()) {
      if (!seen.has(threadId)) livenessSuspects.delete(threadId);
    }
    for (const [threadId, turnId] of livenessWarned) {
      const thread = yield* resolveThread(threadId);
      if (thread?.session?.activeTurnId !== turnId) livenessWarned.delete(threadId);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("provider command reactor liveness sweep failed", {
            cause: Cause.pretty(cause),
          }),
    ),
    Effect.withSpan("ProviderCommandReactor.sweepLiveness"),
  );

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = (event: OrchestrationEvent) =>
      isProviderIntentEvent(event) ? routeProviderIntentEvent(event) : Effect.void;

    // Subscribed synchronously: every request committed after this point is
    // delivered live, and startup intent recovery replays the ones before it.
    const subscription = yield* orchestrationEngine.subscribeDomainEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromSubscription(subscription), processEvent),
    );
    yield* Effect.forkScoped(
      sweepLiveness.pipe(
        Effect.repeat(
          Schedule.spaced(Duration.millis(Math.min(livenessSweepIntervalMs, MAX_TIMER_MS))),
        ),
        Effect.delay(Duration.millis(Math.min(livenessSweepIntervalMs, MAX_TIMER_MS))),
      ),
    );
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(Effect.orDie);
    for (const thread of snapshot.threads) {
      if (thread.goal?.synchronization?.state !== "pending") continue;
      // Deferred first-turn work is recovered by the normal turn lifecycle. It
      // must not bind to the previous provider ahead of a context handoff.
      if (thread.goal.synchronization.deferUntilTurn) continue;
      // Fence 0: any stop or interrupt this process observes cancels it before it runs.
      yield* routeProviderIntentEvent(
        {
          sequence: snapshot.snapshotSequence,
          eventId: EventId.make(crypto.randomUUID()),
          type: "thread.goal-updated",
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: thread.goal.updatedAt,
          commandId: CommandId.make(thread.goal.synchronization.requestId),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId: thread.id, goal: thread.goal, origin: "client" },
        },
        { fenceSequence: 0, recovery: true },
      );
    }
  });

  /**
   * The request event of an intent row, or undefined when it is unreadable:
   * missing at its sequence, a different event, or undecodable.
   */
  const readIntentEvent = (row: ProviderEffectIntentRow) =>
    orchestrationEngine.readEventsPage(row.sequence - 1, 1).pipe(
      Effect.map(({ events }): TrackedProviderIntentEvent | undefined => {
        const event = events[0];
        return event !== undefined &&
          event.sequence === row.sequence &&
          isTrackedProviderIntentEvent(event) &&
          providerIntentKindOf(event.type) === row.kind
          ? event
          : undefined;
      }),
      Effect.catch((error) =>
        Schema.is(PersistenceDecodeError)(error) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );

  const isTerminalDispatchError = (error: unknown): boolean =>
    Schema.is(OrchestrationCommandInvariantError)(error) ||
    Schema.is(OrchestrationCommandPreviouslyRejectedError)(error);

  /**
   * One recovery outcome: deterministic ids, retried once. A decider rejection
   * is terminal (the row is settled and logged); any other failure keeps the row
   * for the next boot. Settling after a success is idempotent: the outcome event
   * normally settled the row already, and a receipt replay commits no event.
   */
  const commitRecoveryOutcome = (
    row: ProviderEffectIntentRow,
    outcome: Effect.Effect<unknown, OrchestrationDispatchError>,
  ) =>
    outcome.pipe(
      Effect.retry({ times: 1, while: (error) => !isTerminalDispatchError(error) }),
      Effect.as("committed" as const),
      Effect.catch((error) =>
        isTerminalDispatchError(error)
          ? Effect.logWarning("provider intent recovery outcome was rejected; settling", {
              threadId: row.threadId,
              kind: row.kind,
              sequence: row.sequence,
              detail: error.message,
            }).pipe(Effect.as("rejected" as const))
          : Effect.fail(error),
      ),
      Effect.tap(() => providerEffectIntents.settle({ sequence: row.sequence })),
    );

  /** The visible end of a prior-process turn start; never re-sent. */
  const cancelTurnStart = (input: {
    readonly row: ProviderEffectIntentRow;
    readonly messageId: MessageId;
    readonly delegatedReturn: boolean;
    readonly deliveryState: "not-sent" | "uncertain";
  }) => {
    const copy = recoveryCopy({
      kind: "turn-start",
      deliveryState: input.deliveryState,
      delegatedReturn: input.delegatedReturn,
    });
    return commitRecoveryOutcome(
      input.row,
      appendProviderFailureActivity({
        threadId: input.row.threadId,
        kind: "provider.turn.start.failed",
        messageId: input.messageId,
        summary: copy.summary,
        detail: copy.detail,
        deliveryState: input.deliveryState,
        turnId: null,
        createdAt: new Date().toISOString(),
        ...providerIntentRecoveryIds(input.row.sequence),
      }),
    );
  };

  const recoverIntents: ProviderCommandReactorShape["recoverIntents"] = () =>
    Effect.gen(function* () {
      const bootSequence = orchestrationEngine.bootSequence;
      const cancelledTurnStarts: Array<
        ProviderIntentRecoverySummary["cancelledTurnStarts"][number]
      > = [];
      const counts = {
        replayed: 0,
        rejectedSteers: 0,
        retriedSessionStops: 0,
        handoffsAbandoned: 0,
        settledWithoutOutcome: 0,
      };
      const settleWithoutOutcome = (row: ProviderEffectIntentRow, reason: string) =>
        Effect.logWarning("provider intent recovery settled an intent without an outcome", {
          threadId: row.threadId,
          kind: row.kind,
          sequence: row.sequence,
          reason,
        }).pipe(
          Effect.andThen(providerEffectIntents.settle({ sequence: row.sequence })),
          Effect.tap(() =>
            Effect.sync(() => {
              counts.settledWithoutOutcome += 1;
            }),
          ),
        );

      const recoverRow = Effect.fnUntraced(function* (row: ProviderEffectIntentRow) {
        const event = yield* readIntentEvent(row);
        if (row.sequence > bootSequence) {
          // Committed by this process before the reactor subscribed: deliver it
          // through the live entry, whose dedup absorbs a live copy.
          if (event === undefined) {
            return yield* Effect.logWarning("provider intent recovery could not read an event", {
              threadId: row.threadId,
              sequence: row.sequence,
            });
          }
          yield* routeProviderIntentEvent(event);
          counts.replayed += 1;
          return;
        }

        const attempts = yield* providerEffectIntents.noteRecoveryAttempt({
          sequence: row.sequence,
        });
        if (attempts > MAX_PROVIDER_INTENT_RECOVERY_ATTEMPTS) {
          yield* Effect.logError("provider intent recovery gave up on an intent", {
            threadId: row.threadId,
            kind: row.kind,
            sequence: row.sequence,
            attempts,
          });
          return yield* settleWithoutOutcome(row, "recovery-attempts-exhausted");
        }
        if ((yield* resolveThread(row.threadId)) === undefined) {
          return yield* settleWithoutOutcome(row, "thread-missing");
        }
        const deliveryState = deliveryStateOf(row.dispatchedAt);

        switch (row.kind) {
          case "turn-start": {
            const turnStart = event?.type === "thread.turn-start-requested" ? event : undefined;
            const messageId = turnStart?.payload.messageId ?? row.messageId;
            if (messageId === null) return yield* settleWithoutOutcome(row, "event-unreadable");
            if (turnStart?.payload.contextHandoff !== undefined) {
              const result = yield* contextHandoffCoordinator.abandonUnstartedTurnStart(
                turnStart,
                recoveryCopy({ kind: "turn-start", deliveryState, delegatedReturn: false }).detail,
              );
              if (result === "owned") return yield* settleWithoutOutcome(row, "handoff-owned");
              if (result === "abandoned") {
                counts.handoffsAbandoned += 1;
                cancelledTurnStarts.push({ threadId: row.threadId, messageId, deliveryState });
                return;
              }
            }
            yield* cancelTurnStart({
              row,
              messageId,
              delegatedReturn: turnStart?.payload.delegationReturnGuard !== undefined,
              // An unreadable request cannot prove it was never sent.
              deliveryState: turnStart === undefined ? "uncertain" : deliveryState,
            });
            cancelledTurnStarts.push({
              threadId: row.threadId,
              messageId,
              deliveryState: turnStart === undefined ? "uncertain" : deliveryState,
            });
            return;
          }
          case "turn-steer": {
            if (event?.type !== "thread.turn-steer-requested") {
              return yield* settleWithoutOutcome(row, "event-unreadable");
            }
            yield* commitRecoveryOutcome(
              row,
              resolveSteer(
                event,
                {
                  status: "rejected",
                  error: recoveryCopy({ kind: "turn-steer", deliveryState, delegatedReturn: false })
                    .detail,
                  // Only a steer that provably never reached the provider defers
                  // (stays queued, sent next). One that may have reached it fails
                  // visibly so the client does not silently send it twice.
                  reason: deliveryState === "not-sent" ? "deferred" : "failed",
                  resolvedAt: new Date().toISOString(),
                },
                providerIntentRecoveryIds(row.sequence).commandId,
              ),
            );
            counts.rejectedSteers += 1;
            return;
          }
          case "session-stop": {
            if (event?.type !== "thread.session-stop-requested") {
              return yield* settleWithoutOutcome(row, "event-unreadable");
            }
            // Idempotent: retried through the thread's lane, so it orders with the
            // thread's other startup work and its fence cancels startup restarts.
            yield* routeProviderIntentEvent(event, { priorProcess: true });
            counts.retriedSessionStops += 1;
            return;
          }
        }
      });

      const rows = yield* providerEffectIntents.listOpen().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("provider intent recovery could not list open intents", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as([] as ReadonlyArray<ProviderEffectIntentRow>)),
        ),
      );
      for (const row of rows) {
        yield* recoverRow(row).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("provider intent recovery kept an intent for the next boot", {
                  threadId: row.threadId,
                  kind: row.kind,
                  sequence: row.sequence,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      }
      const summary: ProviderIntentRecoverySummary = { ...counts, cancelledTurnStarts };
      yield* Effect.logInfo("provider intent recovery finished", {
        open: rows.length,
        bootSequence,
        replayed: summary.replayed,
        cancelledTurnStarts: summary.cancelledTurnStarts.length,
        rejectedSteers: summary.rejectedSteers,
        retriedSessionStops: summary.retriedSessionStops,
        handoffsAbandoned: summary.handoffsAbandoned,
        settledWithoutOutcome: summary.settledWithoutOutcome,
      });
      return summary;
    }).pipe(Effect.withSpan("ProviderCommandReactor.recoverIntents"));

  return {
    start,
    recoverIntents,
    // Forked sendTurn and steer stay untracked, as before.
    drain: Effect.all([lifecycleLanes.drain, callbackLanes.drain, outOfBandLanes.drain], {
      discard: true,
    }),
    sweepLiveness,
  } satisfies ProviderCommandReactorShape;
});

/** The reactor without its intent ledger, for tests that decorate the repository. */
export const makeProviderCommandReactorLayer = (options?: ProviderCommandReactorOptions) =>
  Layer.effect(ProviderCommandReactor, makeProviderCommandReactor(options)).pipe(
    Layer.provide(ProjectionPendingApprovalRepositoryLive),
    Layer.provide(ProjectionThreadUserInputRequestRepositoryLive),
  );

export const makeProviderCommandReactorLive = (options?: ProviderCommandReactorOptions) =>
  makeProviderCommandReactorLayer(options).pipe(Layer.provide(ProviderEffectIntentRepositoryLive));

export const ProviderCommandReactorLive = makeProviderCommandReactorLive();
