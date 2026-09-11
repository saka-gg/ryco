import { Cause, Effect, Metric, Option, Schema, Stream } from "effect";
import {
  AuthSessionId,
  CommandId,
  type DiagnosticsProviderProcess,
  EventId,
  type GitRunStackedActionInput,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectId,
  type ServerProvider,
  type ThreadId,
  SourceControlProviderError,
  WsRpcGroup,
  WorktreeId,
} from "@ryco/contracts";
import { RpcGroup } from "effect/unstable/rpc";

import { AgentControlProposalService } from "../agentControl/Services/AgentControlProposalService.ts";
import { ChatAttachmentUploads } from "../attachmentUpload.ts";
import { AgentControlExternalIntegrationService } from "../agentControl/Services/AgentControlExternalIntegration.ts";
import { AgentControlExternalInstallationService } from "../agentControl/Services/AgentControlExternalInstallation.ts";
import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery.ts";
import { resolveManagedWorktreesRoot, ServerConfig } from "../config.ts";
import { Diagnostics } from "../diagnostics/Services/Diagnostics.ts";
import { Keybindings } from "../keybindings.ts";
import { makeCodexMcpService } from "../mcp/CodexMcpService.ts";
import { makeCodexMcpAdapter } from "../mcp/adapters/CodexMcpAdapter.ts";
import { makeClaudeMcpAdapter } from "../mcp/adapters/ClaudeMcpAdapter.ts";
import { makeCopilotMcpAdapter } from "../mcp/adapters/CopilotMcpAdapter.ts";
import { makeCursorMcpAdapter } from "../mcp/adapters/CursorMcpAdapter.ts";
import { makeGrokMcpAdapter } from "../mcp/adapters/GrokMcpAdapter.ts";
import { makeOpenCodeMcpAdapter } from "../mcp/adapters/OpenCodeMcpAdapter.ts";
import { makeProviderMcpRegistry } from "../mcp/ProviderMcpRegistry.ts";
import { Open, resolveAvailableEditors } from "../open.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { ContextHandoffInspection } from "../orchestration/Services/ContextHandoffInspection.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { StatisticsQuery } from "../statistics/StatisticsQuery.ts";
import { UsageService, UsageServiceTest } from "../usage/UsageService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import { ServerLifecycleEvents } from "../serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { VcsProvisioningService } from "../vcs/VcsProvisioningService.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectFaviconResolver } from "../project/Services/ProjectFaviconResolver.ts";
import { ProjectAvatarStore } from "../project/Services/ProjectAvatarStore.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { resolveWorktreeCheckoutPath } from "../project/worktreeCheckoutPaths.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import { refreshWorktreeSourceControlState } from "../sourceControl/refreshWorktreeSourceControlState.ts";
import * as SourceControlDiscoveryLayer from "../sourceControl/SourceControlDiscovery.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import type { SourceControlProviderShape } from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { BootstrapCredentialService } from "../auth/Services/BootstrapCredentialService.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import type { RpcPrincipal } from "./RpcPrincipal.ts";
import { AtlassianConnectionService } from "../atlassian/AtlassianConnectionService.ts";
import { JiraWorkItemService } from "../atlassian/JiraWorkItemService.ts";
import { AdvertisedEndpointRegistry } from "../remote/Services/AdvertisedEndpointRegistry.ts";
import { LocalDiagnosticsMetrics } from "../observability/Services/LocalDiagnosticsMetrics.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";
import { ThreadPriorityCoordinator } from "../threadPriority/ThreadPriorityCoordinator.ts";

import { SOURCE_CONTROL_LINKED_REFRESH_DEBOUNCE_MS } from "./context/constants.ts";
import { toGitManagerError } from "./context/gitErrors.ts";
import { makeOrchestrationStreamHelpers } from "./context/orchestrationStreams.ts";
import { makeWorktreeOperations } from "./context/worktreeOperations.ts";

export { isThreadDetailEvent } from "./context/orchestrationEvents.ts";
export { toAuthAccessStreamEvent } from "./context/authEvents.ts";
export { toOpinionatedPluginRpcError } from "./context/gitErrors.ts";
export {
  PROVIDER_STATUS_DEBOUNCE_MS,
  ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
} from "./context/constants.ts";

function toDiagnosticsProviderProcess(provider: ServerProvider): DiagnosticsProviderProcess {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    enabled: provider.enabled,
    installed: provider.installed,
    status: provider.status,
    checkedAt: provider.checkedAt,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    ...(provider.message ? { message: provider.message } : {}),
  };
}

const guardedMethodAccess = (method: string): WsRpcAccess => {
  const access = rpcAccessFor(method);
  if (access === "viewer" || access === "authenticated" || access === "direct_owner") {
    throw new Error("RPC method uses the wrong authorization guard.");
  }
  return access;
};

export const makeWsRpcContext = (principal: RpcPrincipal) =>
  Effect.gen(function* () {
    const currentSessionId =
      principal.directSessionId ?? AuthSessionId.make(`relay-scope-${principal.scopeId}`);
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const statisticsQuery = yield* StatisticsQuery;
    const usageServiceOption = yield* Effect.serviceOption(UsageService);
    const usageService = Option.getOrElse(usageServiceOption, () => UsageServiceTest);
    const orchestrationEngine = yield* OrchestrationEngineService;
    const threadDeletionReactor = yield* ThreadDeletionReactor;
    // Most server route tests intentionally provide only the services used by
    // the RPC under test. Keep this additive capability optional at context
    // construction; production provides it in `makeServerWsRpcLayer`.
    const contextHandoffInspection = yield* Effect.serviceOption(ContextHandoffInspection);
    const threadPriorityCoordinator = yield* Effect.serviceOption(ThreadPriorityCoordinator);
    // Optional for the same route-test reason; production provides it in the
    // runtime layer and `makeServerWsRpcLayer`.
    const chatAttachmentUploads = yield* Effect.serviceOption(ChatAttachmentUploads);
    // Optional for the same route-test reason; production always provides it
    // through the runtime's Agent Control layer.
    const agentControlProposals = yield* Effect.serviceOption(AgentControlProposalService);
    const agentControlExternalIntegrations = yield* Effect.serviceOption(
      AgentControlExternalIntegrationService,
    );
    const agentControlExternalInstallations = yield* Effect.serviceOption(
      AgentControlExternalInstallationService,
    );
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitWorkflow = yield* GitWorkflowService;
    const vcsProvisioning = yield* VcsProvisioningService;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const terminalManager = yield* TerminalManager;
    const providerRegistry = yield* ProviderRegistry;
    // Optional for the same reason as ContextHandoffInspection: route tests
    // provide only the services their RPC under test needs. Production
    // always has ProviderService in the runtime environment.
    const providerService = yield* Effect.serviceOption(ProviderService);
    const providerRuntimeIngestion = yield* Effect.serviceOption(ProviderRuntimeIngestionService);
    const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const codexMcp = yield* makeCodexMcpService;
    const claudeMcp = yield* makeClaudeMcpAdapter();
    const copilotMcp = yield* makeCopilotMcpAdapter();
    const cursorMcp = yield* makeCursorMcpAdapter();
    const grokMcp = yield* makeGrokMcpAdapter();
    const openCodeMcp = yield* makeOpenCodeMcpAdapter();
    const mcpRegistry = yield* makeProviderMcpRegistry([
      makeCodexMcpAdapter(codexMcp),
      claudeMcp,
      copilotMcp,
      cursorMcp,
      grokMcp,
      openCodeMcp,
    ]);
    const startup = yield* ServerRuntimeStartup;
    const projectFaviconResolver = yield* Effect.serviceOption(ProjectFaviconResolver);
    const projectAvatarStore = yield* Effect.serviceOption(ProjectAvatarStore);
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;
    const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
    const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
    const serverEnvironment = yield* ServerEnvironment;
    const serverAuth = yield* ServerAuth;
    const sourceControlDiscovery = yield* SourceControlDiscoveryLayer.SourceControlDiscovery;
    const sourceControlRepositories = yield* SourceControlRepositoryService;
    const sourceControlRegistry =
      yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const textGeneration = yield* TextGeneration;
    const bootstrapCredentials = yield* BootstrapCredentialService;
    const sessions = yield* SessionCredentialService;
    const projectionWorktrees = yield* ProjectionWorktreeRepository;
    const atlassian = yield* AtlassianConnectionService;
    const workItems = yield* JiraWorkItemService;
    const diagnostics = yield* Diagnostics;
    const localDiagnosticsMetrics = yield* LocalDiagnosticsMetrics;
    const advertisedEndpointRegistry = yield* AdvertisedEndpointRegistry;
    const serverCommandId = (tag: string) => CommandId.make(`server:${tag}:${crypto.randomUUID()}`);
    const linkedSourceControlRefreshAtByProject = new Map<string, number>();

    const authorize = (access: WsRpcAccess, method: string) =>
      authorizeRpcPrincipal(principal, access, method);

    const withAccess = <A, E, R>(
      access: WsRpcAccess,
      method: string,
      effect: Effect.Effect<A, E, R>,
    ) => authorize(access, method).pipe(Effect.andThen(effect));

    const ownerEffect = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      withAccess(guardedMethodAccess(method), method, effect);

    const refreshLinkedWorktreeSourceControlStates = (input: {
      readonly cwd: string;
      readonly reason: string;
      readonly force?: boolean;
    }) =>
      Effect.gen(function* () {
        const projectOpt = yield* projectionSnapshotQuery
          .getActiveProjectByWorkspaceRoot(input.cwd)
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        if (Option.isNone(projectOpt)) return;

        const project = projectOpt.value;
        const key = `${project.id}:${input.cwd}`;
        const now = Date.now();
        const lastRefreshAt = linkedSourceControlRefreshAtByProject.get(key) ?? 0;
        if (!input.force && now - lastRefreshAt < SOURCE_CONTROL_LINKED_REFRESH_DEBOUNCE_MS) {
          return;
        }
        linkedSourceControlRefreshAtByProject.set(key, now);

        const worktrees = yield* projectionWorktrees
          .listByProjectId({ projectId: project.id })
          .pipe(Effect.catch(() => Effect.succeed([])));
        for (const worktree of worktrees) {
          if (worktree.archivedAt !== null) continue;
          if (worktree.prNumber === null && worktree.issueNumber === null) continue;
          yield* refreshWorktreeSourceControlState({
            worktreeId: worktree.worktreeId,
          }).pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
        }
      }).pipe(Effect.ignoreCause({ log: true }), Effect.asVoid);

    const refreshStateForLinkedReference = (input: {
      readonly cwd: string;
      readonly kind: "pr" | "issue";
      readonly reference: string;
    }) =>
      Effect.gen(function* () {
        const parsed = Number.parseInt(input.reference, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) return;
        const projectOpt = yield* projectionSnapshotQuery
          .getActiveProjectByWorkspaceRoot(input.cwd)
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        if (Option.isNone(projectOpt)) return;
        const linked = yield* projectionWorktrees.findActiveByLinkedNumber({
          projectId: projectOpt.value.id,
          kind: input.kind,
          number: parsed,
        });
        for (const worktreeId of linked) {
          yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkDetach,
          );
        }
      }).pipe(Effect.ignoreCause({ log: true }), Effect.asVoid);

    const attachLinkedIssuesToPrAction = (
      input: GitRunStackedActionInput,
    ): Effect.Effect<GitRunStackedActionInput> => {
      if (
        input.worktreeId === undefined ||
        (input.action !== "create_pr" && input.action !== "commit_push_pr")
      ) {
        return Effect.succeed(input);
      }

      return projectionWorktrees.getById({ worktreeId: input.worktreeId }).pipe(
        Effect.map((worktreeOpt) => {
          if (Option.isNone(worktreeOpt)) return input;
          const issueNumber = worktreeOpt.value.issueNumber;
          if (issueNumber === null) return input;
          return {
            ...input,
            linkedIssueNumbers: [...new Set([...(input.linkedIssueNumbers ?? []), issueNumber])],
          };
        }),
        Effect.catch(() => Effect.succeed(input)),
      );
    };

    const ownerStreamEffect = <A, E, R>(
      method: string,
      effect: Effect.Effect<Stream.Stream<A, E, R>, E, R>,
    ) => withAccess(guardedMethodAccess(method), method, effect);

    const ownerStream = <A, E, R>(method: string, stream: Stream.Stream<A, E, R>) =>
      Stream.unwrap(authorize(guardedMethodAccess(method), method).pipe(Effect.as(stream)));

    const directOwnerStreamEffect = <A, E, R>(
      method: string,
      effect: Effect.Effect<Stream.Stream<A, E, R>, E, R>,
    ) => withAccess("direct_owner", method, effect);

    const loadAuthAccessSnapshot = () =>
      Effect.all({
        pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
        clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
      });

    const appendSetupScriptActivity = (input: {
      readonly threadId: ThreadId;
      readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone: "info" | "error";
    }) =>
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("setup-script-activity"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });

    const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
      Schema.is(OrchestrationDispatchCommandError)(cause)
        ? cause
        : new OrchestrationDispatchCommandError({
            message: cause instanceof Error ? cause.message : fallbackMessage,
            cause,
          });

    const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
      const error = Cause.squash(cause);
      return Schema.is(OrchestrationDispatchCommandError)(error)
        ? error
        : new OrchestrationDispatchCommandError({
            message:
              error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
            cause,
          });
    };

    const dispatchBootstrapTurnStart = (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
      Effect.gen(function* () {
        const bootstrap = command.bootstrap;
        const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
        let createdThread = false;
        let targetProjectId = bootstrap?.createThread?.projectId;
        let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
        let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

        const cleanupCreatedThread = () =>
          createdThread
            ? orchestrationEngine
                .dispatch({
                  type: "thread.delete",
                  commandId: serverCommandId("bootstrap-thread-delete"),
                  threadId: command.threadId,
                })
                .pipe(Effect.ignoreCause({ log: true }))
            : Effect.void;

        const recordSetupScriptLaunchFailure = (input: {
          readonly error: unknown;
          readonly requestedAt: string;
          readonly worktreePath: string;
        }) => {
          const detail =
            input.error instanceof Error ? input.error.message : "Unknown setup failure.";
          return appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.failed",
            summary: "Setup script failed to start",
            createdAt: input.requestedAt,
            payload: {
              detail,
              worktreePath: input.worktreePath,
            },
            tone: "error",
          }).pipe(
            Effect.ignoreCause({ log: false }),
            Effect.flatMap(() =>
              Effect.logWarning("bootstrap turn start failed to launch setup script", {
                threadId: command.threadId,
                worktreePath: input.worktreePath,
                detail,
              }),
            ),
          );
        };

        const recordSetupScriptStarted = (input: {
          readonly requestedAt: string;
          readonly worktreePath: string;
          readonly scriptId: string;
          readonly scriptName: string;
          readonly terminalId: string;
        }) => {
          const payload = {
            scriptId: input.scriptId,
            scriptName: input.scriptName,
            terminalId: input.terminalId,
            worktreePath: input.worktreePath,
          };
          return Effect.all([
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: input.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.started",
              summary: "Setup script started",
              createdAt: new Date().toISOString(),
              payload,
              tone: "info",
            }),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  scriptId: input.scriptId,
                  terminalId: input.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        };

        const runSetupProgram = () =>
          bootstrap?.runSetupScript && targetWorktreePath
            ? (() => {
                const worktreePath = targetWorktreePath;
                const requestedAt = new Date().toISOString();
                return projectSetupScriptRunner
                  .runForThread({
                    threadId: command.threadId,
                    ...(targetProjectId ? { projectId: targetProjectId } : {}),
                    ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                    worktreePath,
                  })
                  .pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        recordSetupScriptLaunchFailure({
                          error,
                          requestedAt,
                          worktreePath,
                        }),
                      onSuccess: (setupResult) => {
                        if (setupResult.status !== "started") {
                          return Effect.void;
                        }
                        return recordSetupScriptStarted({
                          requestedAt,
                          worktreePath,
                          scriptId: setupResult.scriptId,
                          scriptName: setupResult.scriptName,
                          terminalId: setupResult.terminalId,
                        });
                      },
                    }),
                  );
              })()
            : Effect.void;

        const bootstrapProgram = Effect.gen(function* () {
          if (bootstrap?.createThread) {
            const created = yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: serverCommandId("bootstrap-thread-create"),
              threadId: command.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            });
            // The create event is an exact fence in the serialized command
            // stream. Drain every earlier deletion before setup or turn start
            // can acquire resources under the reused id.
            yield* threadDeletionReactor.drainThrough(created.sequence);
            createdThread = true;
          }

          if (bootstrap?.prepareWorktree) {
            const bootstrapProject = yield* projectionSnapshotQuery
              .getActiveProjectByWorkspaceRoot(bootstrap.prepareWorktree.projectCwd)
              .pipe(
                Effect.map(Option.getOrNull),
                Effect.mapError((cause) =>
                  toGitManagerError(
                    "git.bootstrapPrepareWorktree",
                    "Failed to load project for bootstrap worktree.",
                    cause,
                  ),
                ),
              );
            const worktree = yield* gitWorkflow.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              fetchOrigin: bootstrap.prepareWorktree.fetchOrigin,
              newRefName: bootstrap.prepareWorktree.branch,
              path: resolveWorktreeCheckoutPath({
                location: undefined,
                appWorktreesRoot: resolveManagedWorktreesRoot(config),
                projectId:
                  targetProjectId ?? bootstrapProject?.id ?? ProjectId.make("project-unknown"),
                workspaceRoot: bootstrap.prepareWorktree.projectCwd,
                projectMetadataDir: bootstrapProject?.projectMetadataDir,
                branchName:
                  bootstrap.prepareWorktree.branch ?? bootstrap.prepareWorktree.baseBranch,
              }),
            });
            targetWorktreePath = worktree.worktree.path;
            yield* orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: serverCommandId("bootstrap-thread-meta-update"),
              threadId: command.threadId,
              branch: worktree.worktree.refName,
              worktreePath: targetWorktreePath,
            });
            const worktreeProjectId = targetProjectId ?? bootstrapProject?.id;
            if (worktreeProjectId !== undefined) {
              const worktreeId = WorktreeId.make(`worktree-${crypto.randomUUID()}`);
              const createdAt = new Date().toISOString();
              yield* orchestrationEngine.dispatch({
                type: "worktree.create",
                commandId: serverCommandId("bootstrap-worktree-create"),
                worktreeId,
                projectId: worktreeProjectId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
                origin: "branch",
                prNumber: null,
                issueNumber: null,
                prTitle: null,
                issueTitle: null,
                createdAt,
              });
              yield* orchestrationEngine.dispatch({
                type: "thread.attach-to-worktree",
                commandId: serverCommandId("bootstrap-worktree-attach"),
                threadId: command.threadId,
                worktreeId,
                attachedAt: createdAt,
              });
            }
            yield* refreshGitStatus(targetWorktreePath);
          }

          yield* runSetupProgram();

          return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
        });

        return yield* bootstrapProgram.pipe(
          Effect.catchCause((cause) => {
            const dispatchError = toBootstrapDispatchCommandCauseError(cause);
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.fail(dispatchError);
            }
            return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
          }),
        );
      });

    const dispatchNormalizedCommand = (
      normalizedCommand: OrchestrationCommand,
    ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
      const dispatchEffect =
        normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
          ? dispatchBootstrapTurnStart(normalizedCommand)
          : orchestrationEngine.dispatch(normalizedCommand).pipe(
              Effect.tap(({ sequence }) =>
                normalizedCommand.type === "thread.create"
                  ? threadDeletionReactor.drainThrough(sequence)
                  : Effect.void,
              ),
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
              ),
            );

      return startup
        .enqueueCommand(dispatchEffect)
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
          ),
        );
    };

    const loadDiagnosticsMetrics = localDiagnosticsMetrics.snapshot;
    const loadAdvertisedEndpoints = advertisedEndpointRegistry.list;
    const loadDiagnosticsSnapshot = Effect.gen(function* () {
      const [providers, terminals, localMetrics, metricSnapshots] = yield* Effect.all([
        providerRegistry.getProviders,
        terminalManager.listDiagnostics,
        localDiagnosticsMetrics.snapshot,
        Metric.snapshot,
      ]);
      return yield* diagnostics.getSnapshot({
        providers: providers.map(toDiagnosticsProviderProcess),
        terminals,
        localMetrics,
        metricSnapshots,
      });
    });

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const providers = yield* providerRegistry.getProviders;
      const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
      const environment = yield* serverEnvironment.getDescriptor;
      const auth = yield* serverAuth.getDescriptor();
      const localMetrics = yield* loadDiagnosticsMetrics;

      return {
        environment,
        auth,
        cwd: config.cwd,
        ...(config.workspaceAccessRoot !== undefined
          ? { workspaceAccessRoot: config.workspaceAccessRoot }
          : {}),
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors: resolveAvailableEditors(),
        observability: {
          logsDirectoryPath: config.logsDir,
          localTracingEnabled: true,
          ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
          otlpTracesEnabled: config.otlpTracesUrl !== undefined,
          ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
          otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          localMetrics,
        },
        settings,
      };
    });

    const refreshGitStatus = (cwd: string) =>
      vcsStatusBroadcaster
        .refreshStatus(cwd)
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

    const { enrichOrchestrationEvents, makeReplayableShellStream, makeReplayableThreadStream } =
      makeOrchestrationStreamHelpers({
        orchestrationEngine,
        projectionSnapshotQuery,
        repositoryIdentityResolver,
        threadPriorityChanges: Option.match(threadPriorityCoordinator, {
          onNone: () => Stream.empty,
          onSome: (coordinator) => coordinator.changes,
        }),
      });

    const {
      dispatchWorktreeCommand,
      createWorktreeForProject,
      archiveWorktree,
      restoreWorktree,
      deleteWorktree,
      initializeGitForProject,
      reconcileAllWorktrees,
    } = makeWorktreeOperations({
      projectionSnapshotQuery,
      projectionWorktrees,
      gitWorkflow,
      vcsProvisioning,
      config,
      workspaceAccessPolicy,
      textGeneration,
      projectSetupScriptRunner,
      serverCommandId,
      dispatchNormalizedCommand,
      refreshGitStatus,
      appendSetupScriptActivity,
    });

    const workflowProviderUnavailableDetail = {
      listWorkflowRuns:
        "Workflow runs are only available for source control providers that expose CI status.",
      getWorkflowRunJobs:
        "Workflow jobs are only available for source control providers that expose CI status.",
      getWorkflowJobLog:
        "Workflow logs are only available for source control providers that expose CI status.",
      rerunWorkflow:
        "Workflow reruns are only available for source control providers that expose CI rerun actions.",
    } as const;

    type SourceControlWorkflowOperation = keyof typeof workflowProviderUnavailableDetail;

    const callSourceControlWorkflowMethod = <A>(input: {
      readonly cwd: string;
      readonly operation: SourceControlWorkflowOperation;
      readonly invoke: (
        provider: SourceControlProviderShape,
      ) => Effect.Effect<A, SourceControlProviderError> | undefined;
    }) =>
      sourceControlRegistry.resolve({ cwd: input.cwd }).pipe(
        Effect.flatMap((provider) => {
          const effect = input.invoke(provider);
          if (effect) return effect;
          return Effect.fail(
            new SourceControlProviderError({
              provider: provider.kind,
              operation: input.operation,
              detail: workflowProviderUnavailableDetail[input.operation],
            }),
          );
        }),
      );

    return {
      currentSessionId,
      projectionSnapshotQuery,
      statisticsQuery,
      usageService,
      orchestrationEngine,
      contextHandoffInspection,
      threadPriorityCoordinator,
      chatAttachmentUploads,
      agentControlProposals,
      agentControlExternalIntegrations,
      agentControlExternalInstallations,
      checkpointDiffQuery,
      keybindings,
      open,
      gitWorkflow,
      vcsProvisioning,
      vcsStatusBroadcaster,
      terminalManager,
      providerRegistry,
      providerService,
      providerRuntimeIngestion,
      providerMaintenanceRunner,
      config,
      lifecycleEvents,
      serverSettings,
      mcpRegistry,
      projectFaviconResolver,
      projectAvatarStore,
      workspaceEntries,
      workspaceFileSystem,
      sourceControlDiscovery,
      sourceControlRepositories,
      sourceControlRegistry,
      textGeneration,
      bootstrapCredentials,
      sessions,
      projectionWorktrees,
      atlassian,
      workItems,
      withAccess,
      ownerEffect,
      ownerStream,
      ownerStreamEffect,
      directOwnerStreamEffect,
      serverCommandId,
      refreshGitStatus,
      toGitManagerError,
      dispatchNormalizedCommand,
      dispatchWorktreeCommand,
      enrichOrchestrationEvents,
      makeReplayableShellStream,
      makeReplayableThreadStream,
      loadServerConfig,
      loadAdvertisedEndpoints,
      loadDiagnosticsMetrics,
      loadDiagnosticsSnapshot,
      recordThreadSnapshotDurationMs: localDiagnosticsMetrics.recordThreadSnapshotDurationMs,
      loadAuthAccessSnapshot,
      refreshLinkedWorktreeSourceControlStates,
      refreshStateForLinkedReference,
      attachLinkedIssuesToPrAction,
      createWorktreeForProject,
      archiveWorktree,
      restoreWorktree,
      deleteWorktree,
      initializeGitForProject,
      reconcileAllWorktrees,
      callSourceControlWorkflowMethod,
    };
  });

type EffectSuccess<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

export type WsRpcContext = EffectSuccess<ReturnType<typeof makeWsRpcContext>>;

export type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>;

export const defineWsHandlers = <const H extends Partial<WsRpcHandlers>>(handlers: H): H =>
  handlers;
