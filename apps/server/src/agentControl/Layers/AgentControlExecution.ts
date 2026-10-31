import { resolveProjectPreferences } from "../../project/projectPreferences.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { CompletionReturnRepository } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { WorkspaceLifecycle } from "../../workspace/WorkspaceLifecycle.ts";
import { workspacePlanLifecycleAction } from "../workspaceLifecycle.ts";
import { AGENT_CONTROL_MESSAGE_ID_PREFIX, DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";
import { buildGeneratedWorktreeBranchName } from "@ryco/shared/git";
import { agentSentMessageId } from "@ryco/shared/interThreadMessage";
import { setupProjectScript } from "@ryco/shared/projectScripts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { hasDelegationLimits } from "../../orchestration/delegationLimits.ts";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  AGENT_CONTROL_ERROR_CODES,
  AgentControlOperationId,
  CommandId,
  MessageId,
  ThreadId,
  WorktreeId,
  type AgentControlExecutionReceipt,
  type AgentControlErrorCode,
  type AgentControlOperation,
  type AgentControlOperationState,
  type AgentControlProposal,
  type AgentControlResultEnvelope,
  type ChatAttachment,
  type ClientOrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerSettings,
  type SourceControlSetPullRequestWatchResult,
  type ThreadDelegatedCreateCommand,
  type ThreadQueueAddCommand,
  type ThreadTurnStartCommand,
} from "@ryco/contracts";
import { Cause, Duration, Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import { delegationSlotHold } from "../../orchestration/delegationSlotHold.ts";
import { isThreadSessionWakeEvent } from "../../orchestration/threadWaitWakeEvents.ts";
import {
  ProjectionSnapshotQuery,
  readProjectShells,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveConfiguredWorktreeRoot } from "../../project/worktreeRoot.ts";
import { resolveWorktreeCheckoutPath } from "../../project/worktreeCheckoutPaths.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { ignoreAlreadyMissingGitResource } from "../../ws/context/gitErrors.ts";
import { threadWakeSource, waitUntil } from "../eventDrivenWait.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { legacyTokenStreamingEnabled } from "../settingsControl.ts";
import { copyArtifactsToThread, resolveThreadArtifacts } from "../artifactHandoff.ts";
import { LocalTaskService } from "../../tasks/LocalTaskService.ts";
import { PullRequestWatchService } from "../../sourceControl/PullRequestWatchService.ts";
import { copyTaskFilesToThread, deleteTaskFileCopies } from "../../tasks/taskFiles.ts";
import { extractThreadReferences } from "@ryco/shared/threadMentions";
import {
  assertSafeAgentControlDeviceUrl,
  isAgentControlDevicePlan,
  resolveAgentControlDeviceArtifact,
} from "../deviceControl.ts";
import {
  AgentControlActionValidator,
  agentControlTargetSnapshots,
} from "../Services/AgentControlActionValidator.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import {
  AgentControlExecution,
  type AgentControlExecutionShape,
} from "../Services/AgentControlExecution.ts";
import { AgentControlOperationStore } from "../Services/AgentControlOperationStore.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";

const TARGET_WAIT_TIMEOUT_MS = 60_000;
/** Minimum spacing of woken target checks: the interval of the poll the waits replaced. */
const TARGET_WAKE_SPACING_MS = 100;
const RECOVERY_SCAN_LIMIT = 100;

export interface AgentControlExecutionLiveOptions {
  readonly disableBackground?: boolean;
}

const unique = <T>(items: ReadonlyArray<T>): Array<T> => [...new Set(items)];

const isProjectAction = (proposal: AgentControlProposal): boolean =>
  proposal.plan.kind === "createProject" ||
  proposal.plan.kind === "updateProject" ||
  proposal.plan.kind === "removeProject" ||
  proposal.plan.kind === "workspaceLifecycle";

/** Actions whose failure the agent reads in the node's own words (what to do about it). */
const explainsFailure = (proposal: AgentControlProposal): boolean =>
  isProjectAction(proposal) ||
  proposal.plan.kind === "pullRequestWatch" ||
  proposal.plan.kind === "worktreeHandoff";

class AgentControlDeviceExecutionError extends Error {
  readonly code: AgentControlErrorCode;
  readonly retryable: boolean;

  constructor(code: AgentControlErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** What the agent reads once its watch request ran: what is watched now and how it stands. */
const pullRequestWatchNote = (
  proposal: AgentControlProposal,
  plan: Extract<AgentControlProposal["plan"], { kind: "pullRequestWatch" }>,
  result: SourceControlSetPullRequestWatchResult,
): string => {
  const watch = result.watch;
  // The chat Ryco wakes may be another one than the caller's (`threadId`).
  const own =
    proposal.principal.kind === "provider-session" && proposal.principal.threadId === plan.threadId;
  const note =
    watch === null
      ? result.now
      : plan.watching
        ? `Watching #${watch.number} (${watch.url}). Now: ${result.now} ${
            own
              ? "Ryco wakes this chat on the next change, so end your turn when you are done."
              : `Ryco wakes chat ${plan.threadId} on the next change.`
          }`
        : `${own ? "This chat" : `Chat ${plan.threadId}`} no longer gets #${watch.number}'s news; the user's Auto-fix CI keeps watching its checks. Now: ${result.now}`;
  // A result message is never blank nor padded (the operation state would not encode).
  return note.slice(0, 2_000).trim() || (plan.watching ? "Watching." : "Not watching.");
};

const boundedCauseMessage = (cause: Cause.Cause<unknown>, fallback: string): string => {
  const failure = Cause.squash(cause);
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message.slice(0, 2_000);
  }
  return fallback;
};

const deviceRevalidationErrorCode = (cause: Cause.Cause<unknown>): AgentControlErrorCode => {
  const failure = Cause.squash(cause);
  if (
    typeof failure !== "object" ||
    failure === null ||
    !("_tag" in failure) ||
    failure._tag !== "AgentControlPlanValidationError" ||
    !("reason" in failure)
  ) {
    return AGENT_CONTROL_ERROR_CODES.deviceStaleState;
  }
  if (failure.reason === "thread-unavailable") {
    return AGENT_CONTROL_ERROR_CODES.deviceUnavailable;
  }
  if (failure.reason === "invalid-plan") {
    return AGENT_CONTROL_ERROR_CODES.deviceUnsupportedPlatform;
  }
  return AGENT_CONTROL_ERROR_CODES.deviceStaleState;
};

const operationSlug = (operationId: AgentControlOperationId): string =>
  operationId.replaceAll(/[^a-zA-Z0-9-]/g, "-").slice(0, 24);

const commandIdFor = (operationId: AgentControlOperationId, step: string): CommandId =>
  CommandId.make(`agent-control:${operationId}:${step}`);

const threadIdFor = (operationId: AgentControlOperationId, index: number): ThreadId =>
  ThreadId.make(`thread-agent-control-${operationSlug(operationId)}-${index + 1}`);

const worktreeIdFor = (operationId: AgentControlOperationId, index: number): WorktreeId =>
  WorktreeId.make(`worktree-agent-control-${operationSlug(operationId)}-${index + 1}`);

const branchFor = (operationId: AgentControlOperationId, index: number, prefix: string): string =>
  buildGeneratedWorktreeBranchName(
    `agent-control-${operationSlug(operationId)}-${index + 1}`,
    prefix,
  );

const messageIdFor = (operationId: AgentControlOperationId, step: string): MessageId =>
  MessageId.make(`${AGENT_CONTROL_MESSAGE_ID_PREFIX}${operationSlug(operationId)}-${step}`);

export const preflightAgentControlWorktreeCheckout = (input: {
  readonly cwd: string;
  readonly checkoutPath: string;
  readonly baseRef: string;
  readonly workspaceAccess: Pick<WorkspaceAccessPolicyShape, "assertPath">;
  readonly git: Pick<GitWorkflowServiceShape, "listRefs">;
  readonly checkoutExists?: (checkoutPath: string) => boolean;
}) =>
  Effect.gen(function* () {
    const authorizedPath = yield* input.workspaceAccess.assertPath({
      path: input.checkoutPath,
      operation: "AgentControlExecution.preflightWorktree",
    });
    if (path.resolve(authorizedPath) !== path.resolve(input.checkoutPath)) {
      return yield* Effect.fail(new Error("Planned worktree checkout path was changed by policy."));
    }
    if ((input.checkoutExists ?? existsSync)(authorizedPath)) {
      return yield* Effect.fail(new Error("Planned worktree checkout already exists."));
    }
    if (input.baseRef === "HEAD") return;
    const refs = yield* input.git.listRefs({
      cwd: input.cwd,
      query: input.baseRef,
      limit: 200,
    });
    if (!refs.refs.some((ref) => ref.name === input.baseRef)) {
      return yield* Effect.fail(new Error("Requested worktree base ref is unavailable."));
    }
  });

const appendStep = (state: AgentControlOperationState, step: string): AgentControlOperationState =>
  state.completedSteps.includes(step)
    ? state
    : { ...state, completedSteps: [...state.completedSteps, step] };

const executionReceipt = (operation: AgentControlOperation): AgentControlExecutionReceipt => ({
  operationId: operation.operationId,
  ...(operation.state.completedSteps.some((step) => step.startsWith("workspace-"))
    ? {
        workspaceLifecycle: {
          completedSteps: operation.state.completedSteps.filter((step) =>
            step.startsWith("workspace-"),
          ),
        },
      }
    : {}),
  commands: operation.state.commandReceipts,
  affectedThreadIds: operation.state.resources.threadIds,
  affectedProjectIds: operation.state.resources.projectIds ?? [],
  affectedAutomationIds: operation.state.resources.automationIds ?? [],
  ...(operation.state.resources.automationRunId === undefined
    ? {}
    : { automationRunId: operation.state.resources.automationRunId }),
  ...(operation.state.device === undefined ? {} : { device: operation.state.device }),
  worktreeIds: operation.state.resources.worktreeIds,
  ...(operation.state.delivery === undefined ? {} : { delivery: operation.state.delivery }),
  ...(operation.state.interrupt === undefined ? {} : { interrupt: operation.state.interrupt }),
  ...(operation.state.worktreeHandoff === undefined
    ? {}
    : { worktreeHandoff: operation.state.worktreeHandoff }),
  ...(operation.state.compensation === undefined
    ? {}
    : { compensation: operation.state.compensation }),
});

const completedResult = (operation: AgentControlOperation): AgentControlResultEnvelope => ({
  outcome: "completed",
  createdThreadIds:
    operation.actionKind === "createThreads" || operation.actionKind === "automationRun"
      ? operation.state.resources.threadIds
      : undefined,
  createdProjectIds:
    operation.actionKind === "createProject"
      ? (operation.state.resources.projectIds ?? [])
      : undefined,
  execution: executionReceipt(operation),
  // What the agent reads about the outcome (a watch's answer), when the action recorded one.
  ...(operation.state.note === undefined ? {} : { detail: operation.state.note }),
  completedAt: new Date().toISOString(),
});

const failedResult = (
  operation: AgentControlOperation,
  input: {
    readonly revalidation: boolean;
    readonly message: string;
    readonly retryable: boolean;
    readonly code?: AgentControlErrorCode;
  },
): AgentControlResultEnvelope => ({
  outcome: "failed",
  error: {
    code:
      input.code ??
      (input.revalidation
        ? AGENT_CONTROL_ERROR_CODES.revalidationFailed
        : AGENT_CONTROL_ERROR_CODES.executionFailed),
    message: input.message.slice(0, 2_000),
    retryable: input.retryable,
  },
  execution: executionReceipt(operation),
  failedAt: new Date().toISOString(),
});

export const makeAgentControlExecution = (options?: AgentControlExecutionLiveOptions) =>
  Effect.gen(function* () {
    const proposals = yield* AgentControlProposalStore;
    const completionReturns = yield* Effect.serviceOption(CompletionReturnRepository);
    const operations = yield* AgentControlOperationStore;
    const proposalEvents = yield* AgentControlProposalEvents;
    const validator = yield* AgentControlActionValidator;
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    const setupScriptRunner = yield* Effect.serviceOption(ProjectSetupScriptRunner);
    const automations = yield* Effect.serviceOption(AgentControlAutomationService);
    const commandApplication = yield* OrchestrationCommandApplication;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const git = yield* GitWorkflowService;
    // The branch-name fence of a worktree handoff (its remotes, refs it would shadow).
    const gitDriver = yield* Effect.serviceOption(GitVcsDriver);
    const workspaceLifecycleOption = yield* Effect.serviceOption(WorkspaceLifecycle);
    const workspaceAccess = yield* WorkspaceAccessPolicy;
    const deviceService = yield* Effect.serviceOption(DeviceService);
    const localTasks = yield* Effect.serviceOption(LocalTaskService);
    // Required, not optional: provided beneath the runtime services (`server.ts`), so a layer
    // placed where execution cannot see it fails to compile instead of failing every watch.
    const pullRequestWatches = yield* PullRequestWatchService;
    const config = yield* ServerConfig;

    /** Applies an agent's watch change: idempotent, so a replay finds it applied. */
    const setPullRequestWatch = (
      proposal: AgentControlProposal,
      plan: Extract<AgentControlProposal["plan"], { kind: "pullRequestWatch" }>,
    ) =>
      pullRequestWatches
        .setWatch({
          threadId: plan.threadId,
          number: plan.number,
          url: plan.url,
          news: plan.watching,
          origin: "agent",
        })
        .pipe(
          Effect.map((result) => pullRequestWatchNote(proposal, plan, result)),
          Effect.mapError((error) => new Error(error.detail)),
        );
    const startup = yield* ServerRuntimeStartup;

    /** A heartbeat's run logic, loaded on its first run or recovery (`heartbeatRuns.ts`). */
    const heartbeatRuns = Effect.promise(() => import("../heartbeatRuns.ts"));
    /** An agent's move of its own chat into a worktree (`worktreeHandoffRuns.ts`), on first use. */
    const worktreeHandoffRuns = Effect.promise(() => import("../worktreeHandoffRuns.ts"));
    const queuedIn = (threadId: ThreadId) =>
      engine.getReadModel === undefined
        ? Effect.succeed([])
        : Effect.map(
            engine.getReadModel(),
            (model) => findThreadInArray(model.threads, threadId)?.followUpQueue?.entries ?? [],
          );

    const loadThread = (threadId: ThreadId) =>
      projections.getThreadShellById(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error("Target thread is unavailable.")),
            onSome: Effect.succeed,
          }),
        ),
      );

    /**
     * Waits until `settled` accepts the target thread, re-reading it whenever its session or
     * archive state changes (or it is deleted), and at least every 5 s otherwise.
     */
    const waitForThread = (
      threadId: ThreadId,
      settled: (thread: OrchestrationThreadShell) => Effect.Effect<boolean, Error>,
      timeoutMessage: string,
    ) =>
      waitUntil({
        sources: [threadWakeSource(engine, [threadId], isThreadSessionWakeEvent)],
        timeoutMs: TARGET_WAIT_TIMEOUT_MS,
        wakeSpacingMs: TARGET_WAKE_SPACING_MS,
        check: Effect.gen(function* () {
          const thread = yield* loadThread(threadId);
          return { done: yield* settled(thread), value: thread };
        }),
      }).pipe(
        Effect.flatMap(({ value, timedOut }) =>
          timedOut ? Effect.fail(new Error(timeoutMessage)) : Effect.succeed(value),
        ),
      );

    const settleProposalFailure = (
      proposal: AgentControlProposal,
      operation: AgentControlOperation,
      input: {
        readonly revalidation: boolean;
        readonly message: string;
        readonly retryable: boolean;
        readonly code?: AgentControlErrorCode;
      },
    ) =>
      Effect.gen(function* () {
        const result = failedResult(operation, input);
        let terminalOperation = operation;
        if (operation.status === "running" || operation.status === "compensating") {
          terminalOperation = yield* operations.transition({
            operationId: operation.operationId,
            expectedStatus: operation.status,
            nextStatus: "failed",
            actor: "executor",
            attempt: operation.attempt,
            state: operation.state,
            result,
            updatedAt: new Date().toISOString(),
          });
        } else if (operation.status === "pending") {
          terminalOperation = yield* operations.transition({
            operationId: operation.operationId,
            expectedStatus: "pending",
            nextStatus: "cancelled",
            actor: "system",
            attempt: operation.attempt,
            state: operation.state,
            result,
            updatedAt: new Date().toISOString(),
          });
        }
        if (proposal.status === "executing") {
          yield* proposals
            .settleExecution({
              proposalId: proposal.proposalId,
              result: failedResult(terminalOperation, input),
              now: new Date().toISOString(),
            })
            .pipe(Effect.ignore);
        }
      });

    const compensate = (operation: AgentControlOperation) =>
      Effect.gen(function* () {
        let current = operation;
        if (current.status === "running") {
          current = yield* operations.transition({
            operationId: current.operationId,
            expectedStatus: "running",
            nextStatus: "compensating",
            actor: "executor",
            attempt: current.attempt,
            state: {
              ...current.state,
              compensation: { attempted: true, completed: false },
            },
            result: null,
            updatedAt: new Date().toISOString(),
          });
        }

        let cleanupCompleted = true;
        // A created thread that never ran is rolled back. One that holds any work is archived
        // instead (its conversation is kept: Trash now means deletion after a short grace
        // period), and its checkout is then never force-removed.
        let preservedConversations = false;
        const state = current.state;
        for (const threadId of state.resources.ownedThreadIds.toReversed()) {
          const existing = yield* projections
            .getThreadShellById(threadId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isNone(existing)) continue;
          const cleaned = yield* Effect.exit(
            commandApplication.apply({
              type: "thread.delete",
              commandId: commandIdFor(current.operationId, `compensate-thread-${threadId}`),
              threadId,
            }),
          );
          if (cleaned._tag === "Success") continue;
          preservedConversations = true;
          cleanupCompleted = false;
          if (existing.value.archivedAt !== null) continue;
          yield* Effect.exit(
            commandApplication.apply({
              type: "thread.archive",
              commandId: commandIdFor(current.operationId, `compensate-archive-${threadId}`),
              threadId,
            }),
          );
        }

        for (const owned of preservedConversations
          ? []
          : state.resources.ownedWorktrees.toReversed()) {
          const getWorktree = projections.getWorktreeShellById;
          if (getWorktree === undefined) {
            cleanupCompleted = false;
            continue;
          }
          const projected = yield* getWorktree(owned.worktreeId).pipe(
            Effect.catch(() => Effect.succeed(Option.none())),
          );
          if (
            Option.isSome(projected) &&
            (projected.value.projectId !== owned.projectId ||
              projected.value.branch !== owned.branch ||
              projected.value.worktreePath !== owned.checkoutPath)
          ) {
            cleanupCompleted = false;
            continue;
          }

          const project = yield* projections
            .getProjectShellById(owned.projectId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isNone(project)) {
            cleanupCompleted = false;
            continue;
          }
          const listedPaths = yield* git
            .listWorktreePaths(project.value.workspaceRoot)
            .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
          const ownsMaterializedPath = listedPaths.some(
            (candidate) => path.resolve(candidate) === path.resolve(owned.checkoutPath),
          );
          if (ownsMaterializedPath) {
            const removed = yield* Effect.exit(
              workspaceAccess
                .assertExistingPath({
                  path: owned.checkoutPath,
                  operation: "AgentControlExecution.compensate",
                })
                .pipe(
                  Effect.flatMap((authorizedPath) =>
                    ignoreAlreadyMissingGitResource(
                      git.removeWorktree({
                        cwd: project.value.workspaceRoot,
                        path: authorizedPath,
                        force: true,
                      }),
                      {
                        operation: "AgentControlExecution.compensate",
                        action: "remove-worktree",
                        target: authorizedPath,
                      },
                    ),
                  ),
                  Effect.flatMap(() =>
                    ignoreAlreadyMissingGitResource(
                      git.deleteBranch({
                        cwd: project.value.workspaceRoot,
                        refName: owned.branch,
                        force: true,
                      }),
                      {
                        operation: "AgentControlExecution.compensate",
                        action: "delete-branch",
                        target: owned.branch,
                      },
                    ),
                  ),
                ),
            );
            if (removed._tag === "Failure") cleanupCompleted = false;
          }

          if (Option.isSome(projected)) {
            const deleted = yield* Effect.exit(
              commandApplication.apply({
                type: "worktree.delete",
                commandId: commandIdFor(
                  current.operationId,
                  `compensate-worktree-${owned.worktreeId}`,
                ),
                worktreeId: owned.worktreeId,
                deletedAt: new Date().toISOString(),
                deletedBranch: ownsMaterializedPath,
              }),
            );
            if (deleted._tag === "Failure") cleanupCompleted = false;
          }
        }

        current = yield* operations.checkpoint({
          operationId: current.operationId,
          expectedStatus: "compensating",
          attempt: current.attempt,
          state: {
            ...current.state,
            compensation: { attempted: true, completed: cleanupCompleted },
          },
          updatedAt: new Date().toISOString(),
        });
        return current;
      });

    /**
     * The checkout path of a worktree an operation will create, checked before anything is made
     * (delegated worktrees and handoffs alike): the setup it needs, the path policy, the base ref.
     */
    const planWorktreeCheckout = (input: {
      readonly project: OrchestrationProjectShell;
      readonly settings: ServerSettings;
      readonly branch: string;
      readonly initialName: string;
      readonly baseRef: string;
      readonly runSetupScript: boolean;
    }) =>
      Effect.gen(function* () {
        const { project } = input;
        if (
          input.runSetupScript &&
          Option.isNone(setupScriptRunner) &&
          setupProjectScript(project.scripts ?? [])
        )
          return yield* Effect.fail(
            new Error("Project setup is unavailable. Retry when the server is ready."),
          );
        const checkoutPath = yield* resolveWorktreeCheckoutPath({
          location: undefined,
          appWorktreesRoot: yield* resolveConfiguredWorktreeRoot({
            settings: input.settings,
            projectId: project.id,
            config,
            policy: workspaceAccess,
          }),
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
          projectMetadataDir: project.projectMetadataDir,
          projectTitle: project.title,
          initialName: input.initialName,
          branchName: input.branch,
        });
        yield* preflightAgentControlWorktreeCheckout({
          cwd: project.workspaceRoot,
          checkoutPath,
          baseRef: input.baseRef,
          workspaceAccess,
          git,
        });
        return checkoutPath;
      });

    const runAction = (proposal: AgentControlProposal, initial: AgentControlOperation) =>
      Effect.gen(function* () {
        let operation = initial;

        const checkpoint = (nextState: AgentControlOperationState) =>
          operations
            .checkpoint({
              operationId: operation.operationId,
              expectedStatus: operation.status === "compensating" ? "compensating" : "running",
              attempt: operation.attempt,
              state: nextState,
              updatedAt: new Date().toISOString(),
            })
            .pipe(Effect.tap((next) => Effect.sync(() => (operation = next))));

        const dispatch = (
          step: string,
          request:
            | ClientOrchestrationCommand
            | ThreadDelegatedCreateCommand
            /** A turn start whose attachments the server already stored (handed-over artifacts). */
            | { readonly stored: ThreadTurnStartCommand }
            /** A follow-up the node queues as the agent's (`author` is server-only). */
            | { readonly queued: ThreadQueueAddCommand },
          updateState?: (state: AgentControlOperationState) => AgentControlOperationState,
        ) =>
          Effect.gen(function* () {
            const command =
              "stored" in request ? request.stored : "queued" in request ? request.queued : request;
            const result = yield* "stored" in request
              ? commandApplication.applyInternal(request.stored)
              : "queued" in request
                ? commandApplication.applyInternal(request.queued)
                : request.type === "thread.delegated.create"
                  ? commandApplication.applyInternal(request)
                  : commandApplication.apply(request);
            const state = updateState?.(operation.state) ?? operation.state;
            yield* checkpoint(
              appendStep(
                {
                  ...state,
                  commandReceipts: [
                    ...state.commandReceipts,
                    {
                      commandId: command.commandId,
                      commandType: command.type,
                      sequence: result.sequence,
                    },
                  ],
                },
                step,
              ),
            );
            return result;
          });

        /**
         * Creates a planned worktree, then records it as the operation's own (the durable
         * ownership point compensation removes) and creates its workspace record.
         */
        const createOwnedWorktree = (worktree: {
          readonly index: number;
          readonly settings: ServerSettings;
          readonly project: OrchestrationProjectShell;
          readonly worktreeId: WorktreeId;
          readonly branch: string;
          readonly checkoutPath: string;
          readonly baseRef: string;
          readonly fetchOrigin?: boolean;
        }) =>
          Effect.gen(function* () {
            const created = yield* git.createWorktree({
              settingsSnapshot: worktree.settings,
              projectId: worktree.project.id,
              cwd: worktree.project.workspaceRoot,
              refName: worktree.baseRef,
              newRefName: worktree.branch,
              path: worktree.checkoutPath,
              ...(worktree.fetchOrigin === true ? { fetchOrigin: true } : {}),
            });
            const authorizedCreatedPath = yield* workspaceAccess.assertExistingPath({
              path: created.worktree.path,
              operation: "AgentControlExecution.createWorktree",
            });
            if (path.resolve(authorizedCreatedPath) !== path.resolve(worktree.checkoutPath)) {
              return yield* Effect.fail(new Error("Created worktree path did not match its plan."));
            }

            // This is the durable ownership point. No dependent thread step
            // runs before the exact id/project/branch/path evidence is stored.
            yield* checkpoint({
              ...operation.state,
              completedSteps: unique([
                ...operation.state.completedSteps,
                `worktree-owned:${worktree.index}`,
              ]),
              resources: {
                ...operation.state.resources,
                worktreeIds: unique([
                  ...operation.state.resources.worktreeIds,
                  worktree.worktreeId,
                ]),
                ownedWorktrees: [
                  ...operation.state.resources.ownedWorktrees,
                  {
                    worktreeId: worktree.worktreeId,
                    projectId: worktree.project.id,
                    branch: worktree.branch,
                    checkoutPath: authorizedCreatedPath,
                  },
                ],
              },
            });
            yield* dispatch(`worktree-created:${worktree.index}`, {
              type: "worktree.create",
              commandId: commandIdFor(operation.operationId, `worktree-create-${worktree.index}`),
              worktreeId: worktree.worktreeId,
              projectId: worktree.project.id,
              branch: worktree.branch,
              worktreePath: authorizedCreatedPath,
              origin: "manual",
              prNumber: null,
              issueNumber: null,
              prTitle: null,
              issueTitle: null,
              workItemProvider: null,
              workItemKey: null,
              workItemTitle: null,
              workItemState: null,
              workItemStateName: null,
              workItemUrl: null,
              createdAt: new Date().toISOString(),
            });
            return authorizedCreatedPath;
          });

        /** Starts the project's setup script for a thread in its new worktree, and records it. */
        const launchSetupScript = (
          index: number,
          input: {
            readonly threadId: ThreadId;
            readonly projectId: string;
            readonly projectCwd: string;
            readonly worktreePath: string;
          },
        ) =>
          Option.isNone(setupScriptRunner)
            ? Effect.succeed({ status: "no-script" as const })
            : setupScriptRunner.value
                .runForThread(input)
                .pipe(
                  Effect.tap(() =>
                    checkpoint(appendStep(operation.state, `setup-launched:${index}`)),
                  ),
                );

        if (proposal.plan.kind === "worktreeHandoff") {
          const { runWorktreeHandoff } = yield* worktreeHandoffRuns;
          yield* runWorktreeHandoff(
            {
              settings: settingsService,
              projects: readProjectShells(projections),
              loadThread,
              git,
              gitDriver,
              ids: { commandIdFor, messageIdFor, worktreeIdFor },
              operation: () => operation,
              checkpoint,
              appendStep,
              dispatch,
              planWorktreeCheckout,
              createOwnedWorktree,
              launchSetupScript,
              resolvePreferences: resolveProjectPreferences,
            },
            proposal.plan,
            // A Stop of the turn that asked (or a newer turn) before the move rolls it back.
            proposal.principal,
          );
          return operation;
        }

        if (
          isAgentControlDevicePlan(proposal.plan) ||
          proposal.plan.kind === "deviceControlConsent"
        ) {
          const plan = proposal.plan;
          if (Option.isNone(deviceService)) {
            return yield* Effect.fail(
              new AgentControlDeviceExecutionError(
                AGENT_CONTROL_ERROR_CODES.deviceUnsupportedPlatform,
                "iOS Simulator device control is unavailable.",
              ),
            );
          }
          const service = deviceService.value;
          yield* checkpoint({
            ...operation.state,
            resources: {
              ...operation.state.resources,
              threadIds: unique([...operation.state.resources.threadIds, plan.threadId]),
              projectIds: unique([...(operation.state.resources.projectIds ?? []), plan.projectId]),
            },
            device: {
              actionKind: plan.kind,
              threadId: plan.threadId,
              projectId: plan.projectId,
              providerInstanceId: plan.providerInstanceId,
              udid: plan.udid,
            },
          });
          yield* validator.revalidateExecution(proposal);
          if (plan.kind === "deviceControlConsent") {
            // The user's consent is the whole effect: the routine input it allows
            // runs directly through ryco_device. Nothing touches the device here.
            yield* checkpoint(appendStep(operation.state, "device-consent-granted"));
            return operation;
          }

          const run = async (): Promise<void> => {
            switch (plan.kind) {
              case "deviceBoot": {
                // Up while the thread's provider turn runs; an approval that
                // lands after the turn ended holds nothing and the grace starts.
                const result = await service.manager.holdForAgentTurn(
                  plan.threadId,
                  plan.udid,
                  () => service.manager.boot(plan.udid),
                );
                if (result.kind === "boot-limit-reached") {
                  throw new AgentControlDeviceExecutionError(
                    AGENT_CONTROL_ERROR_CODES.deviceBootLimitReached,
                    "The Ryco-owned Simulator boot limit was reached.",
                    true,
                  );
                }
                return;
              }
              case "deviceAttach":
                // The agent's attachment is metadata; its turn keeps the device up.
                await service.manager.holdForAgentTurn(plan.threadId, plan.udid, () =>
                  service.manager.attach(plan.threadId, plan.udid, "agent"),
                );
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              case "deviceDetach":
                await service.manager.detach(plan.threadId);
                return;
              case "deviceInstall": {
                const projects = await Effect.runPromise(readProjectShells(projections));
                const project = projects.find((candidate) => candidate.id === plan.projectId);
                if (!project) {
                  throw new AgentControlDeviceExecutionError(
                    AGENT_CONTROL_ERROR_CODES.deviceStaleState,
                    "The approved project workspace is unavailable.",
                    true,
                  );
                }
                const artifact = await Effect.runPromise(
                  resolveAgentControlDeviceArtifact({
                    workspaceRoot: project.workspaceRoot,
                    artifactPath: plan.artifactPath,
                    workspaceAccess,
                  }),
                ).catch(() => {
                  throw new AgentControlDeviceExecutionError(
                    AGENT_CONTROL_ERROR_CODES.deviceInvalidInput,
                    "The approved application artifact no longer resolves inside the project workspace.",
                  );
                });
                await service.manager.install(plan.udid, artifact);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-install");
                return;
              }
              case "deviceLaunch":
                await service.manager.launch(plan.udid, plan.bundleId);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-launch");
                return;
              case "deviceOpenUrl":
                try {
                  assertSafeAgentControlDeviceUrl(plan.url);
                } catch {
                  throw new AgentControlDeviceExecutionError(
                    AGENT_CONTROL_ERROR_CODES.deviceInvalidInput,
                    "The approved URL no longer meets device-control policy.",
                  );
                }
                await service.manager.openUrl(plan.udid, plan.url);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              case "deviceTap": {
                await service.manager.tap(plan.udid, plan.x, plan.y);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              }
              case "deviceSwipe":
                await service.manager.swipe(plan.udid, {
                  fromX: plan.fromX,
                  fromY: plan.fromY,
                  toX: plan.toX,
                  toY: plan.toY,
                  durationMs: plan.durationMs,
                });
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              case "devicePressButton":
                await service.manager.pressButton(plan.udid, plan.button);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              case "deviceStartRecording":
                await service.manager.startRecording(plan.udid);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              case "deviceStopRecording":
                await service.manager.stopRecording(plan.udid);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              case "deviceShutdown":
                await service.manager.shutdown(plan.udid);
                return;
            }
          };

          const action = () => run();
          yield* Effect.tryPromise({
            try: () =>
              plan.kind === "deviceBoot" ||
              plan.kind === "deviceAttach" ||
              plan.kind === "deviceDetach" ||
              plan.kind === "deviceShutdown"
                ? action()
                : // Approved actions may run after their turn: never join a later one.
                  service.manager.withAgentActivity(plan.threadId, action, {
                    udid: plan.udid,
                    joinLateTurn: false,
                  }),
            catch: (cause) =>
              cause instanceof AgentControlDeviceExecutionError
                ? cause
                : new AgentControlDeviceExecutionError(
                    plan.kind === "deviceAttach"
                      ? AGENT_CONTROL_ERROR_CODES.deviceAttachTimeout
                      : plan.kind === "deviceStartRecording" || plan.kind === "deviceStopRecording"
                        ? AGENT_CONTROL_ERROR_CODES.deviceRecordingFailed
                        : AGENT_CONTROL_ERROR_CODES.deviceOperationFailed,
                    plan.kind === "deviceAttach"
                      ? "The approved Simulator attachment failed."
                      : "The approved Simulator action failed.",
                  ),
          });
          yield* checkpoint(appendStep(operation.state, "device-action-completed"));
          return operation;
        }

        if (proposal.plan.kind === "workspaceLifecycle") {
          const plan = proposal.plan;
          const expected = plan.expected;
          if (!expected.worktreeId || !expected.branch)
            return yield* Effect.fail(new Error("Registered workspace required."));
          yield* checkpoint({
            ...operation.state,
            resources: {
              ...operation.state.resources,
              projectIds: [plan.projectId],
              worktreeIds: [expected.worktreeId],
              threadIds: expected.sessions.map((s) => s.threadId),
            },
          });
          yield* validator.revalidateExecution(proposal);
          // These checkpoints are intent/completion evidence, never permission to replay
          // a filesystem effect after an uncertain crash boundary.
          yield* checkpoint(appendStep(operation.state, "workspace-preflight-verified"));
          // The shared lifecycle service performs the change with the same preflight,
          // session shutdown, fencing and history-preserving rules as the UI.
          yield* checkpoint(appendStep(operation.state, "workspace-checkout-started"));
          if (Option.isNone(workspaceLifecycleOption))
            return yield* Effect.fail(new Error("Workspace lifecycle management is unavailable."));
          const lifecycleResult = yield* workspaceLifecycleOption.value.applyCurrent({
            worktreeId: expected.worktreeId,
            action: workspacePlanLifecycleAction(plan),
            deleteBranch: plan.deleteBranch,
            operationKey: operation.operationId,
          });
          if (lifecycleResult.outcome !== "completed")
            return yield* Effect.fail(new Error(lifecycleResult.message));
          yield* checkpoint(appendStep(operation.state, "workspace-checkout-completed"));
          yield* checkpoint(appendStep(operation.state, "workspace-record-started"));
          if (plan.action === "delete") {
            // Only reachable with no referencing conversations (see workspacePlanBlockers).
            yield* dispatch("workspace-record-completed", {
              type: "worktree.delete",
              commandId: commandIdFor(operation.operationId, "workspace-record"),
              worktreeId: expected.worktreeId,
              deletedAt: new Date().toISOString(),
              deletedBranch: plan.deleteBranch,
            });
          } else {
            yield* checkpoint(appendStep(operation.state, "workspace-record-completed"));
          }
          yield* git.invalidateStatus(expected.projectRoot);
          return operation;
        }

        if (proposal.plan.kind === "createProject") {
          const plan = proposal.plan;
          yield* checkpoint({
            ...operation.state,
            resources: {
              ...operation.state.resources,
              projectIds: unique([...(operation.state.resources.projectIds ?? []), plan.projectId]),
            },
          });
          yield* validator.revalidateExecution(proposal);
          yield* dispatch("project-created", {
            type: "project.create",
            commandId: commandIdFor(operation.operationId, "project-create"),
            projectId: plan.projectId,
            title: plan.title,
            workspaceRoot: plan.workspaceRoot,
            projectMetadataDir: plan.projectMetadataDir,
            createWorkspaceRootIfMissing: false,
            createdAt: new Date().toISOString(),
          });
          return operation;
        }

        if (proposal.plan.kind === "updateProject") {
          const plan = proposal.plan;
          yield* checkpoint({
            ...operation.state,
            resources: {
              ...operation.state.resources,
              projectIds: unique([...(operation.state.resources.projectIds ?? []), plan.projectId]),
            },
          });
          yield* validator.revalidateExecution(proposal);
          yield* dispatch("project-metadata-updated", {
            type: "project.meta.update",
            commandId: commandIdFor(operation.operationId, "project-update"),
            projectId: plan.projectId,
            expectedUpdatedAt: plan.before.updatedAt,
            ...(plan.after.customSystemPrompt === undefined
              ? {}
              : { customSystemPrompt: plan.after.customSystemPrompt }),
            ...(plan.after.scripts === undefined ? {} : { scripts: plan.after.scripts }),
            ...(plan.after.preferredRemoteName === undefined
              ? {}
              : { preferredRemoteName: plan.after.preferredRemoteName }),
            ...(plan.after.title === plan.before.title ? {} : { title: plan.after.title }),
            ...(plan.after.workspaceRoot === plan.before.workspaceRoot
              ? {}
              : { workspaceRoot: plan.after.workspaceRoot }),
          });
          return operation;
        }

        if (proposal.plan.kind === "removeProject") {
          const plan = proposal.plan;
          yield* checkpoint({
            ...operation.state,
            resources: {
              ...operation.state.resources,
              projectIds: unique([...(operation.state.resources.projectIds ?? []), plan.projectId]),
              threadIds: unique([
                ...operation.state.resources.threadIds,
                ...plan.expectedThreadIds,
              ]),
            },
          });
          yield* validator.revalidateExecution(proposal);
          // The authoritative project command only unlinks Ryco projection
          // records (and, with force, the exact revalidated thread records).
          // No filesystem API is used anywhere in this branch.
          yield* dispatch("project-removed", {
            type: "project.delete",
            commandId: commandIdFor(operation.operationId, "project-remove"),
            projectId: plan.projectId,
            ...(plan.force ? { force: true } : {}),
            expectedUpdatedAt: plan.expected.updatedAt,
            expectedThreadIds: plan.expectedThreadIds,
          });
          return operation;
        }

        if (proposal.plan.kind === "deleteLocalTask") {
          if (operation.state.completedSteps.includes("local-task-deleted")) return operation;
          if (Option.isNone(localTasks))
            return yield* Effect.fail(new Error("Tasks are unavailable on this node."));
          yield* validator.revalidateExecution(proposal);
          yield* localTasks.value
            .remove({
              taskId: proposal.plan.taskId,
              expectedRevision: proposal.plan.expectedRevision,
            })
            .pipe(Effect.mapError((error) => new Error(error.message)));
          yield* checkpoint(appendStep(operation.state, "local-task-deleted"));
          return operation;
        }

        if (proposal.plan.kind === "pullRequestWatch") {
          const plan = proposal.plan;
          // Idempotent: a step replayed after a restart answers with the watch as it is.
          if (operation.state.completedSteps.includes("pull-request-watch-set")) return operation;
          const note = yield* setPullRequestWatch(proposal, plan);
          yield* checkpoint(
            appendStep(
              {
                ...operation.state,
                resources: {
                  ...operation.state.resources,
                  threadIds: unique([...operation.state.resources.threadIds, plan.threadId]),
                },
                note,
              },
              "pull-request-watch-set",
            ),
          );
          return operation;
        }

        if (proposal.plan.kind === "changeSettings") {
          if (operation.state.completedSteps.includes("settings-updated")) return operation;
          if (Option.isNone(settingsService))
            return yield* Effect.fail(new Error("Settings service unavailable."));
          const change = proposal.plan.change;
          const settings = yield* settingsService.value.getSettings;
          // The legacy token switch maps onto `responseStreamingMode` through the patch alias.
          const [current, patch] =
            change.kind === "legacyTokenStreaming"
              ? [
                  legacyTokenStreamingEnabled(settings),
                  { enableLegacyTokenStreaming: change.after },
                ]
              : [settings.enableProviderUpdateChecks, { enableProviderUpdateChecks: change.after }];
          if (current !== change.before)
            return yield* Effect.fail(
              new Error("Settings changed after the request was prepared."),
            );
          yield* settingsService.value.updateSettings(patch);
          yield* checkpoint({
            ...operation.state,
            completedSteps: unique([...operation.state.completedSteps, "settings-updated"]),
          });
          return operation;
        }

        if (
          proposal.plan.kind === "createAutomation" ||
          proposal.plan.kind === "updateAutomation" ||
          proposal.plan.kind === "cancelAutomation"
        ) {
          if (Option.isNone(automations)) {
            return yield* Effect.fail(new Error("Automation execution is unavailable."));
          }
          const automation = yield* automations.value.applyLifecycle(proposal);
          yield* checkpoint({
            ...operation.state,
            completedSteps: unique([...operation.state.completedSteps, "automation-lifecycle"]),
            resources: {
              ...operation.state.resources,
              automationIds: unique([
                ...(operation.state.resources.automationIds ?? []),
                automation.automationId,
              ]),
            },
          });
          return operation;
        }

        // A heartbeat's run queues its prompt in its chat instead of creating one.
        if (
          proposal.plan.kind === "automationRun" &&
          proposal.plan.execution.target !== undefined
        ) {
          const plan = proposal.plan;
          yield* checkpoint({
            ...operation.state,
            resources: {
              ...operation.state.resources,
              automationIds: unique([
                ...(operation.state.resources.automationIds ?? []),
                plan.automationId,
              ]),
              automationRunId: plan.runId,
            },
          });
          const { runHeartbeat } = yield* heartbeatRuns;
          yield* runHeartbeat(
            {
              messageId: (step) => messageIdFor(operation.operationId, step),
              commandId: (step) => commandIdFor(operation.operationId, step),
              loadThread,
              queuedIn,
              coalesced: Effect.asVoid(
                checkpoint(appendStep(operation.state, "automation-coalesced")),
              ),
              queue: (queued) => Effect.asVoid(dispatch("automation-queued", { queued })),
            },
            plan,
          );
          return operation;
        }

        if (proposal.plan.kind === "createThreads" || proposal.plan.kind === "automationRun") {
          const entries =
            proposal.plan.kind === "createThreads"
              ? proposal.plan.entries
              : [proposal.plan.execution];
          const plannedThreadIds = entries.map((_, index) =>
            threadIdFor(operation.operationId, index),
          );
          yield* checkpoint({
            ...operation.state,
            completedSteps: unique([...operation.state.completedSteps, "planned-thread-ids"]),
            resources: {
              ...operation.state.resources,
              threadIds: unique([...operation.state.resources.threadIds, ...plannedThreadIds]),
              ...(proposal.plan.kind === "automationRun"
                ? {
                    automationIds: unique([
                      ...(operation.state.resources.automationIds ?? []),
                      proposal.plan.automationId,
                    ]),
                    automationRunId: proposal.plan.runId,
                  }
                : {}),
            },
          });

          // Entries past the request's cap wait for a free slot; without a cap all start at once.
          const maxConcurrent =
            proposal.plan.kind === "createThreads" ? proposal.plan.maxConcurrent : undefined;
          // Provenance only (spec D4/D5): never authority; automation runs are not children.
          const delegatedParentThreadId =
            proposal.plan.kind === "createThreads" && proposal.principal.kind === "provider-session"
              ? proposal.principal.threadId
              : null;

          const projects = yield* readProjectShells(projections);
          for (const threadId of plannedThreadIds) {
            const existing = yield* projections.getThreadShellById(threadId);
            if (Option.isSome(existing)) {
              return yield* Effect.fail(new Error("Planned thread identifier is unavailable."));
            }
          }
          const prepared = [] as Array<{
            readonly index: number;
            readonly project: (typeof projects)[number];
            readonly threadId: ThreadId;
            readonly worktreeId: WorktreeId;
            readonly branch: string;
            readonly checkoutPath: string;
            readonly baseRef: string;
            readonly runSetupScript: boolean;
          }>;

          const worktreeSettings = Option.isSome(settingsService)
            ? yield* settingsService.value.getSettings
            : DEFAULT_SERVER_SETTINGS;

          // Entire batch preflight completes before any thread command is dispatched.
          for (const [index, entry] of entries.entries()) {
            if (entry.envMode !== "worktree") continue;
            const project = projects.find((candidate) => candidate.id === entry.projectId);
            if (!project) return yield* Effect.fail(new Error("Requested project is unavailable."));
            const effective = resolveProjectPreferences({ settings: worktreeSettings, project });
            const branch = branchFor(
              operation.operationId,
              index,
              effective.worktreeBranchPrefix.value,
            );
            const baseRef = entry.baseRef ?? "HEAD";
            const checkoutPath = yield* planWorktreeCheckout({
              project,
              settings: worktreeSettings,
              branch,
              initialName: entry.title,
              baseRef,
              runSetupScript: effective.runSetupScript.value,
            });
            prepared.push({
              index,
              project,
              threadId: plannedThreadIds[index]!,
              worktreeId: worktreeIdFor(operation.operationId, index),
              branch,
              checkoutPath,
              baseRef,
              runSetupScript: effective.runSetupScript.value,
            });
          }

          for (const worktree of prepared) {
            yield* createOwnedWorktree({ ...worktree, settings: worktreeSettings });
          }

          for (const [index, entry] of entries.entries()) {
            const project = projects.find((candidate) => candidate.id === entry.projectId);
            if (!project) return yield* Effect.fail(new Error("Requested project is unavailable."));
            const threadId = plannedThreadIds[index]!;
            const worktree = prepared.find((candidate) => candidate.index === index);
            const createdAt = new Date().toISOString();
            const tokenMode = entry.tokenMode ?? worktreeSettings.defaultAgentTokenMode;
            yield* validator.revalidateExecution(proposal);
            const createFields = {
              commandId: commandIdFor(operation.operationId, `thread-create-${index}`),
              threadId,
              projectId: project.id,
              title: entry.title,
              modelSelection: entry.modelSelection,
              runtimeMode: entry.runtimeMode,
              interactionMode: "default" as const,
              tokenMode,
              branch: worktree?.branch ?? null,
              worktreePath: worktree?.checkoutPath ?? null,
              createdAt,
            };
            // The decider owns lineage: it rejects a parent deleted after revalidation.
            yield* dispatch(
              `thread-created:${index}`,
              delegatedParentThreadId === null
                ? { type: "thread.create", ...createFields }
                : {
                    type: "thread.delegated.create",
                    ...createFields,
                    parentThreadId: delegatedParentThreadId,
                    // Checked again by the decider, which serializes every create, so concurrent
                    // requests cannot overshoot a budget the validator saw room in.
                    ...(hasDelegationLimits(worktreeSettings.agentControl.delegation)
                      ? { delegationLimits: worktreeSettings.agentControl.delegation }
                      : {}),
                  },
              (state) => ({
                ...state,
                resources: {
                  ...state.resources,
                  ownedThreadIds: unique([...state.resources.ownedThreadIds, threadId]),
                },
              }),
            );
            if (worktree) {
              yield* dispatch(`thread-attached:${index}`, {
                type: "thread.attach-to-worktree",
                commandId: commandIdFor(operation.operationId, `thread-attach-${index}`),
                threadId,
                worktreeId: worktree.worktreeId,
                attachedAt: createdAt,
              });
              // Checkout preparation (including feature-specific submodules) must
              // finish before setup. Required plan model/env inputs stay explicit.
              if (worktree.runSetupScript && Option.isSome(setupScriptRunner)) {
                yield* validator.revalidateExecution(proposal);
                yield* launchSetupScript(index, {
                  threadId,
                  projectId: project.id,
                  projectCwd: project.workspaceRoot,
                  worktreePath: worktree.checkoutPath,
                });
              }
            }
            if ("returnToOrigin" in entry && entry.returnToOrigin) {
              const origin = proposal.principal;
              if (
                origin.kind !== "provider-session" ||
                !origin.turnId ||
                !origin.runtimeSessionId ||
                Option.isNone(completionReturns)
              ) {
                return yield* Effect.fail(
                  new Error(
                    "Completion return requires an exact provider turn and durable return service.",
                  ),
                );
              }
              const parent = yield* loadThread(origin.threadId);
              // Persist before starting the child: even an immediate completion
              // or a lost start receipt must retain the initial message binding.
              yield* completionReturns.value.insert({
                childThreadId: threadId,
                initialMessageId: messageIdFor(operation.operationId, `create-${index}`),
                parentThreadId: origin.threadId,
                parentTurnId: origin.turnId,
                childTurnId: null,
                proposalId: proposal.proposalId,
                projectId: parent.projectId,
                parentRuntimeSessionId: origin.runtimeSessionId,
                parentProviderInstanceId: origin.providerInstanceId,
                parentRuntimeMode: parent.runtimeMode,
                parentWorktreePath: parent.worktreePath,
                status: "waiting",
                detail: "Waiting for the initial child turn and settled output/background work.",
                revision: 0,
                createdAt,
                updatedAt: createdAt,
                nextCheckAt: createdAt,
                settled: null,
                command: null,
              });
            }
            // The parent's own artifacts this entry hands over, copied under the child's ids
            // (re-checked: a revert since validation may have dropped them).
            const artifactIds =
              proposal.plan.kind === "createThreads"
                ? (proposal.plan.entries[index]?.artifacts ?? [])
                : [];
            const handedOver =
              delegatedParentThreadId !== null && artifactIds.length > 0
                ? yield* resolveThreadArtifacts(
                    projections,
                    delegatedParentThreadId,
                    artifactIds,
                  ).pipe(
                    Effect.flatMap((artifacts) =>
                      copyArtifactsToThread({
                        attachmentsDir: config.attachmentsDir,
                        sourceThreadId: delegatedParentThreadId,
                        targetThreadId: threadId,
                        artifacts,
                      }),
                    ),
                    Effect.mapError((error) => new Error(error.detail)),
                  )
                : [];
            const localTaskId =
              proposal.plan.kind === "createThreads"
                ? proposal.plan.entries[index]?.localTaskId
                : undefined;
            const threadReferences =
              localTaskId === undefined ? [] : extractThreadReferences(entry.prompt, threadId);
            const turnStart = {
              type: "thread.turn.start" as const,
              commandId: commandIdFor(operation.operationId, `turn-start-${index}`),
              threadId,
              message: {
                messageId: messageIdFor(operation.operationId, `create-${index}`),
                role: "user" as const,
                text: entry.prompt,
                attachments: [],
              },
              modelSelection: entry.modelSelection,
              runtimeMode: entry.runtimeMode,
              interactionMode: "default" as const,
              tokenMode,
              // A task's chat links the chats its task links to, as a sent message would.
              ...(threadReferences.length > 0 ? { threadReferences } : {}),
              createdAt,
            };
            // Past the request's cap the same first message (same id, so a completion return
            // still binds to it) waits, held, in the child's own follow-up queue, at the child's
            // own modes; the slot runtime releases it when an earlier task stops working.
            const sendFirstMessage = (attachments: ReadonlyArray<ChatAttachment>) =>
              maxConcurrent !== undefined && index >= maxConcurrent
                ? dispatch(`turn-queued:${index}`, {
                    queued: {
                      type: "thread.queue.add",
                      // The turn start's id: a task's start ledger reads this command's receipt.
                      commandId: turnStart.commandId,
                      threadId,
                      author: "agent",
                      entry: {
                        messageId: turnStart.message.messageId,
                        text: entry.prompt,
                        attachments,
                        modelSelection: entry.modelSelection,
                        runtimeMode: entry.runtimeMode,
                        interactionMode: "default",
                        tokenMode,
                        ...(threadReferences.length > 0 ? { threadReferences } : {}),
                      },
                      hold: delegationSlotHold(proposal.proposalId, maxConcurrent),
                      createdAt,
                    },
                  })
                : dispatch(
                    `turn-started:${index}`,
                    attachments.length === 0
                      ? turnStart
                      : {
                          stored: { ...turnStart, message: { ...turnStart.message, attachments } },
                        },
                  );
            if (localTaskId !== undefined) {
              // The chat starts as the task's: recorded under the task first (a replay after a
              // restart finds the same start), then given copies of the task's files.
              if (Option.isNone(localTasks))
                return yield* Effect.fail(new Error("Tasks are unavailable on this node."));
              const tasks = localTasks.value;
              const reservation = yield* tasks
                .reserveDelegation(
                  { taskId: localTaskId, command: turnStart },
                  { branch: worktree?.branch ?? null },
                )
                .pipe(Effect.mapError((error) => new Error(error.message)));
              const copies = yield* copyTaskFilesToThread({
                taskFilesDir: config.taskFilesDir,
                attachmentsDir: config.attachmentsDir,
                threadId,
                files: reservation.files,
              }).pipe(
                Effect.tapError((error) =>
                  tasks
                    .markDelegationFailed(turnStart.commandId, error.message)
                    .pipe(Effect.ignore),
                ),
                Effect.mapError((error) => new Error(error.message)),
              );
              yield* sendFirstMessage(copies.attachments).pipe(
                Effect.tapError((error) =>
                  tasks
                    .markDelegationFailed(
                      turnStart.commandId,
                      error instanceof Error && error.message
                        ? error.message
                        : "The chat could not be started.",
                    )
                    .pipe(
                      Effect.flatMap((failed) =>
                        failed
                          ? deleteTaskFileCopies({
                              attachmentsDir: config.attachmentsDir,
                              threadId,
                              attachmentIds: copies.createdIds,
                            })
                          : Effect.void,
                      ),
                      Effect.ignore,
                    ),
                ),
              );
              yield* tasks.markDelegated(turnStart.commandId).pipe(Effect.ignore);
              continue;
            }
            yield* sendFirstMessage(handedOver);
          }
          return operation;
        }

        if (proposal.plan.kind !== "sendMessage" && proposal.plan.kind !== "interruptThread") {
          if (proposal.plan.kind !== "updateThread") {
            return yield* Effect.fail(new Error("Unsupported Agent Control action."));
          }
        }

        yield* checkpoint({
          ...operation.state,
          resources: {
            ...operation.state.resources,
            threadIds: unique([...operation.state.resources.threadIds, proposal.plan.threadId]),
          },
        });

        if (proposal.plan.kind === "sendMessage") {
          const plan = proposal.plan;
          const target = yield* loadThread(plan.threadId);
          const expectedTarget = agentControlTargetSnapshots(proposal.principal).find(
            (snapshot) => snapshot.threadId === plan.threadId,
          );
          // The id names the sending chat, so the target shows who wrote it.
          const messageId = MessageId.make(
            agentSentMessageId({
              operationSlug: operationSlug(operation.operationId),
              senderThreadId:
                proposal.principal.kind === "provider-session" ? proposal.principal.threadId : null,
            }),
          );
          let delivery: "queued" | "steered" | "queued-after-steer-fallback" = "queued";
          let shouldQueue = plan.delivery === "queue";

          if (plan.delivery === "steer") {
            const activeTurnId = expectedTarget?.activeTurnId ?? null;
            if (
              activeTurnId !== null &&
              (target.session?.status !== "running" || target.session.activeTurnId !== activeTurnId)
            ) {
              return yield* Effect.fail(
                new Error("The approved steer target changed before dispatch."),
              );
            }
            if (target.session?.status !== "running" || activeTurnId === null) {
              shouldQueue = true;
              delivery = "queued-after-steer-fallback";
            } else {
              const resolution = yield* Effect.scoped(
                Effect.gen(function* () {
                  const events = yield* engine.subscribeDomainEvents;
                  yield* dispatch("turn-steer-requested", {
                    type: "thread.turn.steer",
                    commandId: commandIdFor(operation.operationId, "turn-steer"),
                    threadId: plan.threadId,
                    expectedTurnId: activeTurnId,
                    message: {
                      messageId,
                      role: "user",
                      text: plan.text,
                      attachments: [],
                    },
                    createdAt: new Date().toISOString(),
                    requestedAt: new Date().toISOString(),
                  });
                  return yield* events.pipe(
                    Stream.filter(
                      (event) =>
                        (event.type === "thread.turn-steer-accepted" ||
                          event.type === "thread.turn-steer-rejected") &&
                        event.payload.threadId === plan.threadId &&
                        event.payload.messageId === messageId,
                    ),
                    Stream.runHead,
                    Effect.timeoutOption(Duration.seconds(30)),
                    Effect.map(Option.flatten),
                  );
                }),
              );
              if (Option.isNone(resolution)) {
                return yield* Effect.fail(new Error("Timed out waiting for steer settlement."));
              }
              if (resolution.value.type === "thread.turn-steer-accepted") {
                delivery = "steered";
                shouldQueue = false;
              } else {
                delivery = "queued-after-steer-fallback";
                shouldQueue = true;
              }
            }
          }

          if (shouldQueue) {
            // The thread's own follow-up queue: visible and editable in the chat, sent by the
            // node's drain at the next idle moment, after the person's own follow-ups, and held
            // like them. The operation ends once the message is queued.
            yield* validator.revalidateExecution(proposal, { allowTurnAdvance: true });
            const current = yield* loadThread(plan.threadId);
            const createdAt = new Date().toISOString();
            yield* dispatch("follow-up-queued", {
              queued: {
                type: "thread.queue.add",
                commandId: commandIdFor(operation.operationId, "follow-up-queue"),
                threadId: plan.threadId,
                author: "agent",
                // Its chat's agent may edit or remove it later (`ryco_queue_*`).
                ...(proposal.principal.kind === "provider-session"
                  ? { queuedBy: proposal.principal.threadId }
                  : {}),
                entry: {
                  messageId,
                  text: plan.text,
                  attachments: [],
                  modelSelection: current.modelSelection,
                  runtimeMode: current.runtimeMode,
                  interactionMode: current.interactionMode,
                  ...(current.tokenMode === undefined ? {} : { tokenMode: current.tokenMode }),
                },
                createdAt,
              },
            });
          }
          yield* checkpoint({ ...operation.state, delivery });
          return operation;
        }

        if (proposal.plan.kind === "interruptThread") {
          const plan = proposal.plan;
          const target = yield* loadThread(plan.threadId);
          const expectedTarget = agentControlTargetSnapshots(proposal.principal).find(
            (snapshot) => snapshot.threadId === plan.threadId,
          );
          const requestedTurnId = plan.turnId ?? expectedTarget?.activeTurnId ?? null;
          if (
            requestedTurnId === null ||
            target.session?.status !== "running" ||
            target.session.activeTurnId !== requestedTurnId
          ) {
            return yield* Effect.fail(
              new Error("The approved interrupt target changed before dispatch."),
            );
          }
          yield* dispatch("turn-interrupt-requested", {
            type: "thread.turn.interrupt",
            commandId: commandIdFor(operation.operationId, "turn-interrupt"),
            threadId: plan.threadId,
            ...(requestedTurnId === null ? {} : { turnId: requestedTurnId }),
            createdAt: new Date().toISOString(),
          });
          const settled = yield* waitForThread(
            plan.threadId,
            (current) =>
              Effect.succeed(
                current.session?.status !== "running" ||
                  (current.session.activeTurnId ?? null) !== requestedTurnId,
              ),
            "Timed out waiting for interrupt settlement.",
          );
          yield* checkpoint({
            ...operation.state,
            interrupt: {
              requestedTurnId,
              settledStatus: settled.session?.status ?? "idle",
              settledActiveTurnId: settled.session?.activeTurnId ?? null,
            },
          });
          return operation;
        }

        const plan = proposal.plan;
        if (plan.title !== undefined || plan.modelSelection !== undefined) {
          yield* dispatch("thread-title-updated", {
            type: "thread.meta.update",
            commandId: commandIdFor(operation.operationId, "thread-title"),
            threadId: plan.threadId,
            ...(plan.title === undefined ? {} : { title: plan.title }),
            ...(plan.modelSelection === undefined ? {} : { modelSelection: plan.modelSelection }),
          });
        }
        if (plan.runtimeMode !== undefined) {
          yield* dispatch("thread-runtime-mode-set", {
            type: "thread.runtime-mode.set",
            commandId: commandIdFor(operation.operationId, "runtime-mode"),
            threadId: plan.threadId,
            runtimeMode: plan.runtimeMode,
            createdAt: new Date().toISOString(),
          });
        }
        if (plan.interactionMode !== undefined) {
          yield* dispatch("thread-interaction-mode-set", {
            type: "thread.interaction-mode.set",
            commandId: commandIdFor(operation.operationId, "interaction-mode"),
            threadId: plan.threadId,
            interactionMode: plan.interactionMode,
            createdAt: new Date().toISOString(),
          });
        }
        if (plan.tokenMode !== undefined) {
          yield* dispatch("thread-token-mode-set", {
            type: "thread.token-mode.set",
            commandId: commandIdFor(operation.operationId, "token-mode"),
            threadId: plan.threadId,
            tokenMode: plan.tokenMode,
            createdAt: new Date().toISOString(),
          });
        }
        if (plan.persistentGoal !== undefined) {
          yield* dispatch(
            plan.persistentGoal === null ? "thread-goal-cleared" : "thread-goal-updated",
            plan.persistentGoal === null
              ? {
                  type: "thread.goal.clear",
                  commandId: commandIdFor(operation.operationId, "thread-goal-clear"),
                  threadId: plan.threadId,
                  createdAt: new Date().toISOString(),
                }
              : {
                  type: "thread.goal.set",
                  commandId: commandIdFor(operation.operationId, "thread-goal-set"),
                  threadId: plan.threadId,
                  objective: plan.persistentGoal,
                  createdAt: new Date().toISOString(),
                },
          );
        }
        if (plan.goalStatus !== undefined) {
          // The same goal update a person makes, so a native goal is synced to its provider.
          yield* dispatch("thread-goal-status", {
            type: "thread.goal.set",
            commandId: commandIdFor(operation.operationId, "thread-goal-status"),
            threadId: plan.threadId,
            status: plan.goalStatus,
            createdAt: new Date().toISOString(),
          });
        }
        if (plan.archived !== undefined) {
          const current = yield* loadThread(plan.threadId);
          const isArchived = current.archivedAt !== null;
          if (plan.archived !== isArchived) {
            yield* dispatch(plan.archived ? "thread-archived" : "thread-unarchived", {
              type: plan.archived ? "thread.archive" : "thread.unarchive",
              commandId: commandIdFor(
                operation.operationId,
                plan.archived ? "thread-archive" : "thread-unarchive",
              ),
              threadId: plan.threadId,
            });
          }
        }
        return operation;
      });

    const executeApproved: AgentControlExecutionShape["executeApproved"] = (proposalId) =>
      Effect.gen(function* () {
        const found = yield* proposals.getById(proposalId);
        if (Option.isNone(found) || found.value.status !== "approved") return;
        const executing = yield* proposals.beginExecution({
          proposalId,
          actor: "executor",
          now: new Date().toISOString(),
        });
        const created = yield* operations.createForProposal({
          proposal: executing,
          now: new Date().toISOString(),
        });
        if (created.operation.status !== "pending") return;
        let operation = yield* operations.transition({
          operationId: created.operation.operationId,
          expectedStatus: "pending",
          nextStatus: "running",
          actor: "executor",
          attempt: created.operation.attempt + 1,
          state: created.operation.state,
          result: null,
          updatedAt: new Date().toISOString(),
        });

        if (computeAgentControlPlanDigest(executing.plan) !== executing.planDigest) {
          yield* settleProposalFailure(executing, operation, {
            revalidation: true,
            message: "The approved plan digest no longer matches its immutable payload.",
            retryable: false,
          });
          return;
        }

        const validation = yield* Effect.exit(validator.revalidateExecution(executing));
        if (validation._tag === "Failure") {
          yield* settleProposalFailure(executing, operation, {
            revalidation: true,
            message:
              explainsFailure(executing) ||
              executing.plan.kind === "changeSettings" ||
              executing.plan.kind === "deleteLocalTask" ||
              executing.plan.kind === "deviceControlConsent" ||
              executing.plan.kind === "createAutomation" ||
              executing.plan.kind === "updateAutomation" ||
              executing.plan.kind === "cancelAutomation"
                ? boundedCauseMessage(
                    validation.cause,
                    "The approved plan no longer passes current server validation.",
                  )
                : "The approved plan no longer passes current server validation.",
            retryable: true,
            ...(isAgentControlDevicePlan(executing.plan) ||
            executing.plan.kind === "deviceControlConsent"
              ? { code: deviceRevalidationErrorCode(validation.cause) }
              : {}),
          });
          return;
        }

        const outcome = yield* Effect.exit(runAction(executing, operation));
        if (outcome._tag === "Failure") {
          const durable = yield* operations
            .getByProposalId(executing.proposalId)
            .pipe(Effect.map(Option.getOrElse(() => operation)));
          const compensated =
            executing.plan.kind === "workspaceLifecycle"
              ? durable
              : yield* compensate(durable).pipe(Effect.catch(() => Effect.succeed(durable)));
          const deviceFailure =
            isAgentControlDevicePlan(executing.plan) ||
            executing.plan.kind === "deviceControlConsent"
              ? Cause.squash(outcome.cause)
              : null;
          yield* settleProposalFailure(executing, compensated, {
            revalidation: false,
            message: explainsFailure(executing)
              ? boundedCauseMessage(
                  outcome.cause,
                  isProjectAction(executing)
                    ? "The approved project action failed during execution."
                    : "The approved Agent Control action failed during execution.",
                )
              : "The approved Agent Control action failed during execution.",
            retryable:
              deviceFailure instanceof AgentControlDeviceExecutionError
                ? deviceFailure.retryable
                : false,
            ...(deviceFailure instanceof AgentControlDeviceExecutionError
              ? { code: deviceFailure.code, message: deviceFailure.message }
              : {}),
          });
          return;
        }
        operation = outcome.value;
        const result = completedResult(operation);
        operation = yield* operations.transition({
          operationId: operation.operationId,
          expectedStatus: "running",
          nextStatus: "completed",
          actor: "executor",
          attempt: operation.attempt,
          state: operation.state,
          result,
          updatedAt: new Date().toISOString(),
        });
        yield* proposals.settleExecution({
          proposalId,
          result: completedResult(operation),
          now: new Date().toISOString(),
        });
      }).pipe(
        // Concurrent acceptance events/scans intentionally race at the CAS.
        // The winner executes; every loser quietly observes the durable state.
        Effect.catchTags({
          AgentControlInvalidTransitionError: () => Effect.void,
          AgentControlProposalExpiredError: () => Effect.void,
          AgentControlDisabledError: () => Effect.void,
        }),
        Effect.catchCause((cause) =>
          Effect.logError("Agent Control executor failed", {
            proposalId,
            cause: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failure",
          }),
        ),
      );

    /** Completes a running operation whose outcome recovery established, and settles it. */
    const completeRecovered = (
      proposal: AgentControlProposal,
      operation: AgentControlOperation,
      state: AgentControlOperationState,
    ) =>
      operations
        .transition({
          operationId: operation.operationId,
          expectedStatus: "running",
          nextStatus: "completed",
          actor: "executor",
          attempt: operation.attempt,
          state,
          result: completedResult({ ...operation, state }),
          updatedAt: new Date().toISOString(),
        })
        .pipe(
          Effect.flatMap((completed) =>
            proposals.settleExecution({
              proposalId: proposal.proposalId,
              result: completedResult(completed),
              now: new Date().toISOString(),
            }),
          ),
        );

    const recoverIncomplete: AgentControlExecutionShape["recoverIncomplete"] = Effect.gen(
      function* () {
        const recoverable = yield* operations.listRecoverable();
        for (let operation of recoverable) {
          const proposalOption = yield* proposals.getById(operation.proposalId);
          if (Option.isNone(proposalOption)) continue;
          const proposal = proposalOption.value;
          if (
            operation.status === "running" &&
            (proposal.plan.kind === "createAutomation" ||
              proposal.plan.kind === "updateAutomation" ||
              proposal.plan.kind === "cancelAutomation") &&
            Option.isSome(automations)
          ) {
            const replayed = yield* Effect.exit(automations.value.applyLifecycle(proposal));
            if (replayed._tag === "Success") {
              const state = {
                ...operation.state,
                completedSteps: unique([...operation.state.completedSteps, "automation-lifecycle"]),
                resources: {
                  ...operation.state.resources,
                  automationIds: unique([
                    ...(operation.state.resources.automationIds ?? []),
                    replayed.value.automationId,
                  ]),
                },
              };
              yield* completeRecovered(proposal, operation, state);
              continue;
            }
          }
          // Deleted, and only the checkpoint was lost: the task being gone is the outcome.
          if (
            operation.status === "running" &&
            proposal.plan.kind === "deleteLocalTask" &&
            Option.isSome(localTasks)
          ) {
            const gone = yield* localTasks.value.get(proposal.plan.taskId).pipe(
              Effect.as(false),
              Effect.catch((error) => Effect.succeed(error.reason === "not-found")),
            );
            if (gone) {
              const state = {
                ...operation.state,
                completedSteps: unique([...operation.state.completedSteps, "local-task-deleted"]),
              };
              yield* completeRecovered(proposal, operation, state);
              continue;
            }
          }
          // A watch change a restart cut off is applied again: the same change answers with the
          // watch as it is, so the receipt tells the agent what really happened. One recorded
          // before the restart only lost its completion: its answer stands, with no host read.
          if (operation.status === "running" && proposal.plan.kind === "pullRequestWatch") {
            if (operation.state.completedSteps.includes("pull-request-watch-set")) {
              yield* completeRecovered(proposal, operation, operation.state);
              continue;
            }
            const plan = proposal.plan;
            const replayed = yield* Effect.exit(
              validator
                .revalidateExecution(proposal)
                .pipe(Effect.andThen(setPullRequestWatch(proposal, plan))),
            );
            if (replayed._tag === "Success") {
              yield* completeRecovered(
                proposal,
                operation,
                appendStep({ ...operation.state, note: replayed.value }, "pull-request-watch-set"),
              );
            } else {
              yield* settleProposalFailure(proposal, operation, {
                revalidation: false,
                message: boundedCauseMessage(
                  replayed.cause,
                  "The pull request watch change was interrupted by a restart.",
                ),
                retryable: true,
              });
            }
            continue;
          }
          // A heartbeat run whose prompt was queued (or coalesced) before a restart has done its
          // work: the entry is in the chat's queue and the drain sends it. Counting it failed
          // would pause an unattended schedule for nothing. So has one whose queue add committed
          // although the restart lost its checkpoint: its message is queued, or already sent.
          if (
            operation.status === "running" &&
            proposal.plan.kind === "automationRun" &&
            proposal.plan.execution.target !== undefined
          ) {
            if (
              operation.state.completedSteps.includes("automation-queued") ||
              operation.state.completedSteps.includes("automation-coalesced")
            ) {
              yield* completeRecovered(proposal, operation, operation.state);
              continue;
            }
            const { heartbeatRunReachedChat } = yield* heartbeatRuns;
            const reached = yield* heartbeatRunReachedChat(
              {
                messageId: (step) => messageIdFor(operation.operationId, step),
                queuedIn,
                sentMessage: (threadId, messageId) =>
                  projections.getThreadMessageById === undefined
                    ? Effect.succeed(Option.none())
                    : projections
                        .getThreadMessageById({ threadId, messageId })
                        .pipe(Effect.orElseSucceed(() => Option.none())),
              },
              proposal.plan,
            );
            if (reached) {
              yield* completeRecovered(
                proposal,
                operation,
                appendStep(operation.state, "automation-queued"),
              );
              continue;
            }
          }
          // A handoff that gave its worktree up for the move: finished when the chat points at
          // the worktree (the move stands), else the worktree is the operation's again and the
          // compensation below removes it.
          if (
            operation.status === "running" &&
            proposal.plan.kind === "worktreeHandoff" &&
            operation.state.completedSteps.includes("handoff-bind-started")
          ) {
            const resumed = yield* Effect.exit(runAction(proposal, operation));
            if (resumed._tag === "Success") {
              yield* completeRecovered(proposal, resumed.value, resumed.value.state);
              continue;
            }
            operation = Option.getOrElse(
              yield* operations.getByProposalId(proposal.proposalId),
              () => operation,
            );
          }
          if (proposal.plan.kind === "workspaceLifecycle") {
            yield* settleProposalFailure(proposal, operation, {
              revalidation: false,
              message:
                "Workspace lifecycle execution was interrupted. No deletion was replayed. Inspect the workspace and completed steps; a started step without completion has an unknown outcome. Prepare a new approved plan for remaining work.",
              retryable: false,
            });
            continue;
          }
          if (operation.status === "pending") {
            yield* settleProposalFailure(proposal, operation, {
              revalidation: false,
              message: "Execution stopped before its first durable step and was not replayed.",
              retryable: true,
            });
            continue;
          }
          const compensated = yield* compensate(operation).pipe(
            Effect.catch(() => Effect.succeed(operation)),
          );
          yield* settleProposalFailure(proposal, compensated, {
            revalidation: false,
            message:
              "Execution was interrupted by server restart; verified owned resources were cleaned up conservatively.",
            retryable: true,
          });
        }

        // Close the narrow crash window between proposal execution CAS and
        // durable operation insertion, and finish the equally narrow window
        // between a terminal operation write and proposal settlement. No
        // action command is replayed during either repair.
        const active = yield* proposals.listActive({ limit: RECOVERY_SCAN_LIMIT });
        for (const proposal of active) {
          if (proposal.status !== "executing") continue;
          const operation = yield* operations.getByProposalId(proposal.proposalId);
          if (Option.isNone(operation)) {
            yield* proposals.settleExecution({
              proposalId: proposal.proposalId,
              result: {
                outcome: "failed",
                error: {
                  code: AGENT_CONTROL_ERROR_CODES.executionFailed,
                  message:
                    "Execution stopped before durable ownership was established and was not replayed.",
                  retryable: true,
                },
                failedAt: new Date().toISOString(),
              },
              now: new Date().toISOString(),
            });
            continue;
          }
          if (
            (operation.value.status === "completed" ||
              operation.value.status === "failed" ||
              operation.value.status === "cancelled") &&
            operation.value.result !== null
          ) {
            yield* proposals.settleExecution({
              proposalId: proposal.proposalId,
              result: operation.value.result,
              now: new Date().toISOString(),
            });
          }
        }
      },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Agent Control recovery failed", {
          cause: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failure",
        }),
      ),
    );

    const scanApproved = proposals.listActive({ limit: RECOVERY_SCAN_LIMIT }).pipe(
      Effect.flatMap((active) =>
        Effect.forEach(
          active,
          (proposal) =>
            proposal.status === "approved" ? executeApproved(proposal.proposalId) : Effect.void,
          { concurrency: 4, discard: true },
        ),
      ),
      Effect.catchCause(() => Effect.void),
    );

    if (options?.disableBackground !== true) {
      const subscription = yield* proposalEvents.subscribe;
      yield* Effect.forkScoped(
        startup.awaitCommandReady.pipe(
          Effect.andThen(recoverIncomplete),
          Effect.andThen(scanApproved),
          Effect.andThen(
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.proposal.status === "approved"),
              Stream.runForEach((event) => executeApproved(event.proposal.proposalId)),
            ),
          ),
        ),
      );
    }

    return { executeApproved, recoverIncomplete } satisfies AgentControlExecutionShape;
  });

export const makeAgentControlExecutionLive = (options?: AgentControlExecutionLiveOptions) =>
  Layer.effect(AgentControlExecution, makeAgentControlExecution(options));

export const AgentControlExecutionLive = makeAgentControlExecutionLive();
