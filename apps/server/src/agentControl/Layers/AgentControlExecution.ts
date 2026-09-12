import { ServerSettingsService } from "../../serverSettings.ts";
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
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import { Cause, Duration, Effect, Layer, Option, Stream } from "effect";

import { resolveManagedWorktreesRoot, ServerConfig } from "../../config.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveWorktreeCheckoutPath } from "../../project/worktreeCheckoutPaths.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { ignoreAlreadyMissingGitResource } from "../../ws/context/gitErrors.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import {
  assertSafeAgentControlDeviceUrl,
  isAgentControlDevicePlan,
  resolveAgentControlDeviceArtifact,
} from "../deviceControl.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import {
  AgentControlExecution,
  type AgentControlExecutionShape,
} from "../Services/AgentControlExecution.ts";
import { AgentControlOperationStore } from "../Services/AgentControlOperationStore.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";

const TARGET_WAIT_TIMEOUT_MS = 60_000;
const TARGET_POLL_INTERVAL_MS = 100;
const RECOVERY_SCAN_LIMIT = 100;

export interface AgentControlExecutionLiveOptions {
  readonly disableBackground?: boolean;
}

const unique = <T>(items: ReadonlyArray<T>): Array<T> => [...new Set(items)];

const isProjectAction = (proposal: AgentControlProposal): boolean =>
  proposal.plan.kind === "createProject" ||
  proposal.plan.kind === "updateProject" ||
  proposal.plan.kind === "removeProject";

class AgentControlDeviceExecutionError extends Error {
  readonly code: AgentControlErrorCode;
  readonly retryable: boolean;

  constructor(code: AgentControlErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

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

const branchFor = (operationId: AgentControlOperationId, index: number): string =>
  `ryco/agent-control-${operationSlug(operationId)}-${index + 1}`;

const messageIdFor = (operationId: AgentControlOperationId, step: string): MessageId =>
  MessageId.make(`message-agent-control-${operationSlug(operationId)}-${step}`);

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
  ...(operation.state.compensation === undefined
    ? {}
    : { compensation: operation.state.compensation }),
});

const completedResult = (
  operation: AgentControlOperation,
  detail?: string,
): AgentControlResultEnvelope => ({
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
  ...(detail ? { detail } : {}),
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
    const operations = yield* AgentControlOperationStore;
    const proposalEvents = yield* AgentControlProposalEvents;
    const validator = yield* AgentControlActionValidator;
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    const automations = yield* Effect.serviceOption(AgentControlAutomationService);
    const commandApplication = yield* OrchestrationCommandApplication;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const git = yield* GitWorkflowService;
    const workspaceAccess = yield* WorkspaceAccessPolicy;
    const deviceService = yield* Effect.serviceOption(DeviceService);
    const config = yield* ServerConfig;
    const startup = yield* ServerRuntimeStartup;
    const managedWorktreesRoot = resolveManagedWorktreesRoot(config);

    const loadThread = (threadId: ThreadId) =>
      projections.getThreadShellById(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error("Target thread is unavailable.")),
            onSome: Effect.succeed,
          }),
        ),
      );

    const waitForIdle = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        while (Date.now() - startedAt < TARGET_WAIT_TIMEOUT_MS) {
          const thread = yield* loadThread(threadId);
          if (thread.archivedAt !== null) {
            return yield* Effect.fail(new Error("Target thread became archived."));
          }
          if (thread.session?.status !== "running" || thread.session.activeTurnId === null) {
            return thread;
          }
          yield* Effect.sleep(Duration.millis(TARGET_POLL_INTERVAL_MS));
        }
        return yield* Effect.fail(
          new Error("Timed out waiting for the target thread to become idle."),
        );
      });

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
          if (cleaned._tag === "Failure") cleanupCompleted = false;
        }

        for (const owned of state.resources.ownedWorktrees.toReversed()) {
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
          command: ClientOrchestrationCommand,
          updateState?: (state: AgentControlOperationState) => AgentControlOperationState,
        ) =>
          Effect.gen(function* () {
            const result = yield* commandApplication.apply(command);
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

        if (isAgentControlDevicePlan(proposal.plan)) {
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

          const run = async (): Promise<void> => {
            switch (plan.kind) {
              case "deviceBoot": {
                const result = await service.manager.boot(plan.udid);
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
                await service.manager.attach(plan.threadId, plan.udid);
                service.manager.requestOpenPane(plan.threadId, plan.udid, "agent-tool");
                return;
              case "deviceDetach":
                await service.manager.detach(plan.threadId);
                return;
              case "deviceInstall": {
                const snapshot = await Effect.runPromise(projections.getShellSnapshot());
                const project = snapshot.projects.find(
                  (candidate) => candidate.id === plan.projectId,
                );
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
                : service.manager.withAgentActivity(plan.threadId, action),
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
            defaultModelSelection: null,
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
            ...(plan.after.defaultModelSelection === undefined
              ? {}
              : { defaultModelSelection: plan.after.defaultModelSelection }),
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

        if (proposal.plan.kind === "changeSettings") {
          if (operation.state.completedSteps.includes("settings-updated")) return operation;
          if (Option.isNone(settingsService))
            return yield* Effect.fail(new Error("Settings service unavailable."));
          const change = proposal.plan.change;
          const settings = yield* settingsService.value.getSettings;
          const key =
            change.kind === "legacyTokenStreaming"
              ? "enableLegacyTokenStreaming"
              : "enableProviderUpdateChecks";
          if (settings[key] !== change.before)
            return yield* Effect.fail(
              new Error("Settings changed after the request was prepared."),
            );
          yield* settingsService.value.updateSettings({ [key]: change.after });
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

          const snapshot = yield* projections.getShellSnapshot();
          for (const threadId of plannedThreadIds) {
            const existing = yield* projections.getThreadShellById(threadId);
            if (Option.isSome(existing)) {
              return yield* Effect.fail(new Error("Planned thread identifier is unavailable."));
            }
          }
          const prepared = [] as Array<{
            readonly index: number;
            readonly project: (typeof snapshot.projects)[number];
            readonly threadId: ThreadId;
            readonly worktreeId: WorktreeId;
            readonly branch: string;
            readonly checkoutPath: string;
            readonly baseRef: string;
          }>;

          // Entire batch preflight completes before any thread command is dispatched.
          for (const [index, entry] of entries.entries()) {
            if (entry.envMode !== "worktree") continue;
            const project = snapshot.projects.find((candidate) => candidate.id === entry.projectId);
            if (!project) return yield* Effect.fail(new Error("Requested project is unavailable."));
            const branch = branchFor(operation.operationId, index);
            const checkoutPath = resolveWorktreeCheckoutPath({
              location: undefined,
              appWorktreesRoot: managedWorktreesRoot,
              projectId: project.id,
              workspaceRoot: project.workspaceRoot,
              projectMetadataDir: project.projectMetadataDir,
              branchName: branch,
            });
            const baseRef = entry.baseRef ?? "HEAD";
            yield* preflightAgentControlWorktreeCheckout({
              cwd: project.workspaceRoot,
              checkoutPath,
              baseRef,
              workspaceAccess,
              git,
            });
            prepared.push({
              index,
              project,
              threadId: plannedThreadIds[index]!,
              worktreeId: worktreeIdFor(operation.operationId, index),
              branch,
              checkoutPath,
              baseRef,
            });
          }

          for (const worktree of prepared) {
            const created = yield* git.createWorktree({
              cwd: worktree.project.workspaceRoot,
              refName: worktree.baseRef,
              newRefName: worktree.branch,
              path: worktree.checkoutPath,
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
            const createdAt = new Date().toISOString();
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
              createdAt,
            });
          }

          for (const [index, entry] of entries.entries()) {
            const project = snapshot.projects.find((candidate) => candidate.id === entry.projectId);
            if (!project) return yield* Effect.fail(new Error("Requested project is unavailable."));
            const threadId = plannedThreadIds[index]!;
            const worktree = prepared.find((candidate) => candidate.index === index);
            const createdAt = new Date().toISOString();
            yield* validator.revalidateExecution(proposal);
            yield* dispatch(
              `thread-created:${index}`,
              {
                type: "thread.create",
                commandId: commandIdFor(operation.operationId, `thread-create-${index}`),
                threadId,
                projectId: project.id,
                title: entry.title,
                modelSelection: entry.modelSelection,
                runtimeMode: entry.runtimeMode,
                interactionMode: "default",
                branch: worktree?.branch ?? null,
                worktreePath: worktree?.checkoutPath ?? null,
                createdAt,
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
            }
            yield* dispatch(`turn-started:${index}`, {
              type: "thread.turn.start",
              commandId: commandIdFor(operation.operationId, `turn-start-${index}`),
              threadId,
              message: {
                messageId: messageIdFor(operation.operationId, `create-${index}`),
                role: "user",
                text: entry.prompt,
                attachments: [],
              },
              modelSelection: entry.modelSelection,
              runtimeMode: entry.runtimeMode,
              interactionMode: "default",
              createdAt,
            });
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
          const expectedTarget =
            proposal.principal.kind === "provider-session"
              ? proposal.principal.targetSnapshots?.find(
                  (snapshot) => snapshot.threadId === plan.threadId,
                )
              : undefined;
          const messageId = messageIdFor(operation.operationId, "send-message");
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
                  const subscription = yield* engine.subscribeDomainEvents;
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
                  return yield* Stream.fromSubscription(subscription).pipe(
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
            const idle = yield* waitForIdle(plan.threadId);
            yield* validator.revalidateExecution(proposal, { allowTurnAdvance: true });
            yield* dispatch("turn-queued", {
              type: "thread.turn.start",
              commandId: commandIdFor(operation.operationId, "turn-queue"),
              threadId: plan.threadId,
              message: {
                messageId,
                role: "user",
                text: plan.text,
                attachments: [],
              },
              modelSelection: idle.modelSelection,
              runtimeMode: idle.runtimeMode,
              interactionMode: idle.interactionMode,
              ...(idle.tokenMode === undefined ? {} : { tokenMode: idle.tokenMode }),
              createdAt: new Date().toISOString(),
            });
          }
          yield* checkpoint({ ...operation.state, delivery });
          return operation;
        }

        if (proposal.plan.kind === "interruptThread") {
          const plan = proposal.plan;
          const target = yield* loadThread(plan.threadId);
          const expectedTarget =
            proposal.principal.kind === "provider-session"
              ? proposal.principal.targetSnapshots?.find(
                  (snapshot) => snapshot.threadId === plan.threadId,
                )
              : undefined;
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
          const settled = yield* Effect.gen(function* () {
            const startedAt = Date.now();
            while (Date.now() - startedAt < TARGET_WAIT_TIMEOUT_MS) {
              const current = yield* loadThread(plan.threadId);
              const activeTurnId = current.session?.activeTurnId ?? null;
              if (current.session?.status !== "running" || activeTurnId !== requestedTurnId) {
                return current;
              }
              yield* Effect.sleep(Duration.millis(TARGET_POLL_INTERVAL_MS));
            }
            return yield* Effect.fail(new Error("Timed out waiting for interrupt settlement."));
          });
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
              isProjectAction(executing) ||
              executing.plan.kind === "changeSettings" ||
              executing.plan.kind === "createAutomation" ||
              executing.plan.kind === "updateAutomation" ||
              executing.plan.kind === "cancelAutomation"
                ? boundedCauseMessage(
                    validation.cause,
                    "The approved plan no longer passes current server validation.",
                  )
                : "The approved plan no longer passes current server validation.",
            retryable: true,
            ...(isAgentControlDevicePlan(executing.plan)
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
          const compensated = yield* compensate(durable).pipe(
            Effect.catch(() => Effect.succeed(durable)),
          );
          const deviceFailure = isAgentControlDevicePlan(executing.plan)
            ? Cause.squash(outcome.cause)
            : null;
          yield* settleProposalFailure(executing, compensated, {
            revalidation: false,
            message: isProjectAction(executing)
              ? boundedCauseMessage(
                  outcome.cause,
                  "The approved project action failed during execution.",
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

    const recoverIncomplete: AgentControlExecutionShape["recoverIncomplete"] = Effect.gen(
      function* () {
        const recoverable = yield* operations.listRecoverable();
        for (const operation of recoverable) {
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
              const result = completedResult({ ...operation, state });
              const completed = yield* operations.transition({
                operationId: operation.operationId,
                expectedStatus: "running",
                nextStatus: "completed",
                actor: "executor",
                attempt: operation.attempt,
                state,
                result,
                updatedAt: new Date().toISOString(),
              });
              yield* proposals.settleExecution({
                proposalId: proposal.proposalId,
                result: completedResult(completed),
                now: new Date().toISOString(),
              });
              continue;
            }
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
