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
} from "../../provider/Errors.ts";
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
  Duration,
  Effect,
  Equal,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { makeDrainableWorker } from "@ryco/shared/DrainableWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ContextHandoffCoordinator } from "../Services/ContextHandoffCoordinator.ts";
import { TURN_FINALIZATION_REASON } from "../turnFinalization.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { withProviderGoalPrompt } from "../../provider/goalMode.ts";
import {
  type ProviderFailureActivityInput,
  providerFailureActivityCommand,
} from "../providerFailureActivity.ts";
import { failureTag, userFacingFailureDetail } from "../userFacingErrors.ts";
import { classifyTurnSteerFailure } from "../turnSteerFailure.ts";

type ProviderIntentEvent = Extract<
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

const make = Effect.gen(function* () {
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
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

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

    if (pathEntryExists(worktreePath)) {
      const registeredPaths = yield* registeredWorktreePaths();
      if (!registeredPaths.includes(worktreeIdentity(worktreePath))) {
        return yield* failRecovery(
          `Refusing to use '${worktreePath}' because it exists but is not a registered worktree for '${repositoryRoot}'.`,
        );
      }
      return;
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
        return;
      }
      return yield* failRecovery(
        `Refusing to recreate worktree '${worktreePath}' because another filesystem entry now occupies that path.`,
      );
    }

    const recreated = yield* gitWorkflow.createWorktree({
      projectId: project.id,
      cwd: repositoryRoot,
      path: worktreePath,
      refName: branch,
      dependencyHydration: "none",
    });
    if (
      worktreeIdentity(recreated.worktree.path) !== worktreeIdentity(worktreePath) ||
      recreated.worktree.refName !== branch
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
    yield* gitWorkflow.invalidateStatus(worktreePath);
    yield* vcsStatusBroadcaster.refreshStatus(worktreePath).pipe(Effect.ignoreCause({ log: true }));
  }, Effect.scoped);

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly computerCatalogChanged?: boolean;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const project = yield* resolveProject(thread.projectId);
    yield* leaseThreadPath(thread, project);
    yield* ensureRecordedWorktreeAvailable(thread, project);

    const desiredRuntimeMode = thread.runtimeMode;
    const desiredTokenMode = thread.tokenMode ?? DEFAULT_TOKEN_MODE;
    const requestedModelSelection = options?.modelSelection;
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

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
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
      });

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
        !options?.computerCatalogChanged &&
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
                goal: { ...goal, synchronization: { ...request, state: "failed", error: detail } },
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
    readonly messageText: string;
    readonly preserveRuntime?: boolean;
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
    if (!input.preserveRuntime)
      yield* ensureSessionForThread(input.threadId, input.createdAt, {
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
   * Reports a turn start that did not reach the provider: logs the full cause,
   * records the short text on the session and appends the visible failure
   * activity. Never fails.
   */
  const reportTurnStartFailure = (input: {
    readonly event: TurnStartRequestedEvent;
    readonly cause: Cause.Cause<unknown>;
    readonly preserveActiveTurn: boolean;
  }): Effect.Effect<void> => {
    const { event, cause } = input;
    // Interrupt-only: no activity. Do not re-raise. A propagated interrupt ends the
    // DrainableWorker loop (packages/shared/src/DrainableWorker.ts) and stops the reactor.
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;
    const threadId = event.payload.threadId;
    const detail = userFacingFailureDetail(cause);
    const tag = failureTag(cause);
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ "orchestration.failure_tag": tag });
      yield* Effect.logWarning("provider command reactor failed to start turn", {
        threadId,
        messageId: event.payload.messageId,
        commandId: event.commandId,
        failureTag: tag,
        cause: Cause.pretty(cause),
      });
      if (!event.payload.delegationReturnGuard) {
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
      }
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        messageId: event.payload.messageId,
        summary: "Provider turn start failed",
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
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
  ) {
    // Essential reads fail the turn visibly through the boundary in
    // processTurnStartRequested. A deleted thread stays silent.
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
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

    const returnGuard = event.payload.delegationReturnGuard;
    const liveReturnSession = returnGuard
      ? yield* providerService
          .getSession(event.payload.threadId)
          .pipe(
            Effect.catchCause((cause) =>
              reportTurnStartFailure({ event, cause, preserveActiveTurn: true }).pipe(
                Effect.as(Option.none()),
              ),
            ),
          )
      : Option.none();
    if (
      returnGuard &&
      (Option.isNone(liveReturnSession) ||
        liveReturnSession.value.runtimeSessionId !== returnGuard.runtimeSessionId ||
        liveReturnSession.value.providerInstanceId !== returnGuard.providerInstanceId ||
        event.payload.contextHandoff !== undefined)
    ) {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        messageId: event.payload.messageId,
        summary: "Delegated return was not submitted",
        detail:
          "The originating runtime is no longer live. Inspect this result before sending it manually.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }
    const expectedReturnRuntime =
      returnGuard && Option.isSome(liveReturnSession)
        ? {
            provider: liveReturnSession.value.provider,
            providerInstanceId: returnGuard.providerInstanceId,
            runtimeSessionId: returnGuard.runtimeSessionId,
          }
        : undefined;

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
      yield* Effect.scoped(
        leaseThreadPath(thread, project).pipe(
          Effect.andThen(contextHandoffCoordinator.processTurnStart(event)),
        ),
      );
      return;
    }

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(returnGuard ? { preserveRuntime: true } : {}),
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

    const commitAcceptedModelSelection =
      event.payload.modelSelection !== undefined &&
      !Equal.equals(thread.modelSelection, event.payload.modelSelection)
        ? orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("accepted-model-selection"),
            threadId: event.payload.threadId,
            modelSelection: event.payload.modelSelection,
          })
        : Effect.void;

    // Submission failures may follow this request's own turn.started, so they
    // reset a running session (preserveActiveTurn: false), as before.
    yield* providerService.sendTurn(sendTurnRequest, expectedReturnRuntime).pipe(
      Effect.tap(() => commitAcceptedModelSelection),
      Effect.catchCause((cause) =>
        reportTurnStartFailure({ event, cause, preserveActiveTurn: false }),
      ),
      Effect.forkScoped,
    );
  });

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: TurnStartRequestedEvent,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }
    // One visible failure boundary for every preparation step. Nothing was
    // submitted yet, so a turn that is running belongs to someone else.
    yield* prepareAndSubmitTurnStart(event).pipe(
      Effect.catchCause((cause) =>
        reportTurnStartFailure({ event, cause, preserveActiveTurn: true }),
      ),
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    if (isProviderOriginatedCommandId(event.commandId)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
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

      const detail = userFacingFailureDetail(cause);
      return Effect.gen(function* () {
        yield* Effect.logWarning("provider command reactor failed to interrupt turn", {
          threadId: event.payload.threadId,
          failureTag: failureTag(cause),
          cause: Cause.pretty(cause),
        });
        const latestThread = yield* resolveThread(event.payload.threadId);
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

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) =>
            Cause.hasInterruptsOnly(stopCause)
              ? Effect.interrupt
              : Effect.logWarning(
                  "provider command reactor failed to stop session after interrupt failure",
                  {
                    threadId: event.payload.threadId,
                    cause: Cause.pretty(stopCause),
                    originalCause: Cause.pretty(cause),
                  },
                ),
          ),
        );

        const stoppedThread = yield* resolveThread(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          stoppedSession.activeTurnId === null ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
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
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processGoalUpdated = Effect.fn("processGoalUpdated")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-updated" }>,
  ) {
    if (event.payload.origin !== "client" || event.payload.goal.synchronization?.deferUntilTurn)
      return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (thread?.goal?.synchronization?.requestId !== event.payload.goal.synchronization?.requestId)
      return;
    const threadId = event.payload.threadId;
    yield* ensureSessionForThread(threadId, event.occurredAt).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
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
    const result = yield* reconcileThreadGoal(threadId);
    if (event.payload.goal.synchronization?.startTurn && result.goal?.status === "active") {
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

  const processTurnSteerRequested = Effect.fn("processTurnSteerRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-steer-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) return;
    const requestCommandId =
      event.commandId ?? CommandId.make(`event:${event.eventId}:turn-steer-request`);
    const resolve = (
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
    ) => {
      const commandBase = {
        type: "thread.turn.steer.resolve" as const,
        commandId: serverCommandId("turn-steer-resolve"),
        requestCommandId,
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

    yield* providerService
      .steerTurn({
        threadId: event.payload.threadId,
        expectedTurnId: event.payload.expectedTurnId,
        messageId: event.payload.message.messageId,
        ...(toNonEmptyProviderInput(event.payload.message.text)
          ? { input: toNonEmptyProviderInput(event.payload.message.text) }
          : {}),
        ...(event.payload.message.attachments.length > 0
          ? { attachments: event.payload.message.attachments }
          : {}),
      })
      .pipe(
        Effect.flatMap((result) =>
          resolve({
            status: "accepted",
            turnId: result.turnId,
            resolvedAt: new Date().toISOString(),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const classified = classifyTurnSteerFailure(cause, (failed) =>
              userFacingFailureDetail(failed, { fallback: "Provider rejected turn steering." }),
            );
            yield* Effect.logWarning("provider command reactor failed to steer turn", {
              threadId: event.payload.threadId,
              failureTag: failureTag(cause),
              reason: classified.reason,
              cause: Cause.pretty(cause),
            });
            yield* resolve({
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
    event: Extract<
      ProviderIntentEvent,
      {
        type: "thread.approval-response-requested" | "thread.user-input-response-requested";
      }
    >,
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
        ? providerService.respondToRequest({ ...key, ...runtime, decision: event.payload.decision })
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

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

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
        lastError: thread.session?.lastError ?? null,
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

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.token-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.goal-updated":
        yield* processGoalUpdated(event);
        return;
      case "thread.goal-cleared":
        yield* processGoalCleared(event);
        return;
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-steer-requested":
        yield* processTurnSteerRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processCallbackResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processCallbackResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "ProviderCommandReactor",
      capacity: 512,
    }),
    process: processDomainEventSafely,
  });

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.token-mode-set" ||
        event.type === "thread.goal-updated" ||
        event.type === "thread.goal-cleared" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-steer-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(Effect.orDie);
    for (const thread of snapshot.threads) {
      if (thread.goal?.synchronization?.state !== "pending") continue;
      // Deferred first-turn work is recovered by the normal turn lifecycle. It
      // must not bind to the previous provider ahead of a context handoff.
      if (thread.goal.synchronization.deferUntilTurn) continue;
      yield* worker.enqueue({
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
      });
    }
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provide(ProjectionPendingApprovalRepositoryLive),
  Layer.provide(ProjectionThreadUserInputRequestRepositoryLive),
);
