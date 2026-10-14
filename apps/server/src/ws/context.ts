import { makeClientWorkspaceUse } from "../workspace/clientWorkspaceUse.ts";
import { LocalTaskService } from "../tasks/LocalTaskService.ts";
import { WorktreeNotesService } from "../notes/WorktreeNotesService.ts";
import { DailyRecapQuery } from "../statistics/DailyRecapQuery.ts";
import { ProviderSessionPrewarm } from "../orchestration/Services/ProviderSessionPrewarm.ts";
import { StorageService } from "../storage/StorageService.ts";
import { storagePathBlocker } from "../storage/lifecycle.ts";
import { WorkspaceLifecycle } from "../workspace/WorkspaceLifecycle.ts";
import { WorkspaceChangeSummary } from "../workspace/WorkspaceChangeSummary.ts";
import { SessionImport } from "../imports/SessionImport.ts";
import { ThreadFork } from "../threadFork/Services/ThreadFork.ts";
import { AutomationCentre } from "../agentControl/Services/AutomationCentre.ts";
import {
  Cause,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Metric,
  Option,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type AuthIssueLinkedDirectAccessInput,
  AuthRpcError,
  AuthSessionId,
  USAGE_CONTRACT_VERSION,
  CommandId,
  type DiagnosticsProviderProcess,
  type GitRunStackedActionInput,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectId,
  type ServerChatsCapability,
  type ServerProvider,
  SourceControlProviderError,
  WORKTREE_SETUP_CANCELLED_MESSAGE,
  WsRpcGroup,
  WorktreeId,
} from "@ryco/contracts";
import { RpcGroup } from "effect/rpc";
import { issueLinkedDirectAccess } from "../auth/linkedDirectAccess.ts";

import { AgentControlProposalService } from "../agentControl/Services/AgentControlProposalService.ts";
import { ChatAttachmentUploads } from "../attachmentUpload.ts";
import { AgentControlExternalIntegrationService } from "../agentControl/Services/AgentControlExternalIntegration.ts";
import { AgentControlExternalInstallationService } from "../agentControl/Services/AgentControlExternalInstallation.ts";
import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery.ts";
import { ServerConfig } from "../config.ts";
import { Diagnostics } from "../diagnostics/Services/Diagnostics.ts";
import { Keybindings } from "../keybindings.ts";
import { ignoreCauseLogOnceEvery, logOnceEvery } from "../logOnceEvery.ts";
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
import { CliProxyService, CliProxyServiceUnavailable } from "../cliProxy/CliProxyService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ModelManifest } from "../provider/ModelManifest.ts";
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
import { resolveConfiguredWorktreeRoot } from "../project/worktreeRoot.ts";
import { ChatFolders, sameChatsCapability } from "../project/chatFolders.ts";
import { resolveWorktreeCheckoutPath } from "../project/worktreeCheckoutPaths.ts";
import { resolveBootstrapPreferences } from "./context/bootstrapPreferences.ts";
import {
  type ChatBootstrapDependencies,
  classifyChatBootstrapFailure,
  type PreparedChatProject,
  prepareChatProject,
  releasePreparedChatFolder,
} from "./context/chatBootstrap.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectRelocationRepository } from "../persistence/Services/ProjectRelocations.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import {
  type KnownPullRequestState,
  refreshWorktreeSourceControlState,
  WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS,
  WORKTREE_PULL_REQUEST_SWEEP_DISCOVERY_INTERVAL_MS,
} from "../sourceControl/refreshWorktreeSourceControlState.ts";
import { inBackgroundProcessLane } from "../processGovernor.ts";
import {
  readWorktreePullRequestLinks,
  selectCurrentPullRequestLink,
} from "@ryco/shared/worktreePullRequests";
import * as SourceControlDiscoveryLayer from "../sourceControl/SourceControlDiscovery.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import {
  requireChangeRequestCapability,
  type SourceControlProviderShape,
} from "../sourceControl/SourceControlProvider.ts";
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
import { makeAppendSetupScriptActivity } from "./context/managedCheckout.ts";
import { makeWorktreeOperations } from "./context/worktreeOperations.ts";
import {
  watchSetupScriptTerminal,
  worktreeCreationProgress,
} from "./context/worktreeSetupProgress.ts";
import { WorktreeSetupTracker } from "../project/Services/WorktreeSetupTracker.ts";
import { setupProjectScript } from "@ryco/shared/projectScripts";
import { makeWorktreeSetupTracker } from "../project/Layers/WorktreeSetupTracker.ts";

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
  if (
    access === "viewer" ||
    access === "authenticated" ||
    access === "direct_owner" ||
    access === "relay_native"
  ) {
    throw new Error("RPC method uses the wrong authorization guard.");
  }
  return access;
};

export const makeWsRpcContext = (principal: RpcPrincipal) =>
  Effect.gen(function* () {
    const clientWorkspaceUse = yield* makeClientWorkspaceUse;
    const currentSessionId =
      principal.directSessionId ?? AuthSessionId.make(`relay-scope-${principal.scopeId}`);
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const statisticsQuery = yield* StatisticsQuery;
    const usageServiceOption = yield* Effect.serviceOption(UsageService);
    const usageService = Option.getOrElse(usageServiceOption, () => UsageServiceTest);
    const cliProxyService = Option.getOrElse(
      yield* Effect.serviceOption(CliProxyService),
      () => CliProxyServiceUnavailable,
    );
    const orchestrationEngine = yield* OrchestrationEngineService;
    const threadDeletionReactor = yield* ThreadDeletionReactor;
    // Most server route tests intentionally provide only the services used by
    // the RPC under test. Keep this additive capability optional at context
    // construction; production provides it in `makeServerWsRpcLayer`.
    const contextHandoffInspection = yield* Effect.serviceOption(ContextHandoffInspection);
    const threadPriorityCoordinator = yield* Effect.serviceOption(ThreadPriorityCoordinator);
    const orchestrationEventStore = yield* Effect.serviceOption(OrchestrationEventStore);
    // Optional for the same route-test reason; production provides it in the
    // runtime layer and `makeServerWsRpcLayer`.
    const chatAttachmentUploads = yield* Effect.serviceOption(ChatAttachmentUploads);
    // Optional for the same route-test reason; production provides it with the
    // orchestration engine. Without it the engine still deduplicates replays,
    // only after normalization.
    const commandReceipts = Option.getOrUndefined(
      yield* Effect.serviceOption(OrchestrationCommandReceiptRepository),
    );
    // Optional for the same route-test reason; production always provides it
    // through the runtime's Agent Control layer.
    const sessionImport = yield* Effect.serviceOption(SessionImport);
    // Optional for the same route-test reason; production provides it in the runtime services.
    const threadFork = yield* Effect.serviceOption(ThreadFork);
    const automationCentre = yield* Effect.serviceOption(AutomationCentre);
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
    // Optional for the same route-test reason; production provides the shared
    // tracker. A test without it gets one private to this context.
    const worktreeSetupTrackerOption = yield* Effect.serviceOption(WorktreeSetupTracker);
    const worktreeSetupTracker = Option.isSome(worktreeSetupTrackerOption)
      ? worktreeSetupTrackerOption.value
      : yield* makeWorktreeSetupTracker;
    const providerRegistry = yield* ProviderRegistry;
    const modelManifest = yield* Effect.serviceOption(ModelManifest);
    // Optional for the same reason as ContextHandoffInspection: route tests
    // provide only the services their RPC under test needs. Production
    // always has ProviderService in the runtime environment.
    const providerService = yield* Effect.serviceOption(ProviderService);
    const providerRuntimeIngestion = yield* Effect.serviceOption(ProviderRuntimeIngestionService);
    const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const storageService = yield* Effect.serviceOption(StorageService);
    // Optional for the route-test reason above; production provides it with the runtime.
    const workspaceLifecycle = yield* Effect.serviceOption(WorkspaceLifecycle);
    const workspaceChangeSummary = yield* Effect.serviceOption(WorkspaceChangeSummary);
    const localTaskService = yield* Effect.serviceOption(LocalTaskService);
    const worktreeNotesService = yield* Effect.serviceOption(WorktreeNotesService);
    const dailyRecapQuery = yield* Effect.serviceOption(DailyRecapQuery);
    // Optional: route tests without the orchestration runtime answer "skipped".
    const sessionPrewarm = yield* Effect.serviceOption(ProviderSessionPrewarm);
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
    const projectionProjects = yield* Effect.serviceOption(ProjectionProjectRepository);
    const projectionThreads = yield* Effect.serviceOption(ProjectionThreadRepository);
    // Optional for the route-test reason above; without it the node offers no chats.
    const chatFolders = yield* Effect.serviceOption(ChatFolders);
    // Optional for the same route-test reason: the chat-promotion journal and the Git driver for
    // a promoted project's first commit.
    const projectRelocations = yield* Effect.serviceOption(ProjectRelocationRepository);
    // Storage admission (the fence turn, session and terminal starts pass), for promotion to judge
    // its destination. Absent only where persistence is, as for the journal above.
    const storageAdmission = Option.map(
      yield* Effect.serviceOption(SqlClient.SqlClient),
      (sql) => (canonicalPath: string) => storagePathBlocker(sql, canonicalPath),
    );
    const gitDriver = Option.getOrUndefined(yield* Effect.serviceOption(GitVcsDriver));
    const projectFaviconResolver = yield* Effect.serviceOption(ProjectFaviconResolver);
    const projectAvatarStore = yield* Effect.serviceOption(ProjectAvatarStore);
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const fileSystem = yield* FileSystem.FileSystem;
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
    const chatBootstrap: ChatBootstrapDependencies = {
      chatFolders: Option.getOrUndefined(chatFolders),
      projects: projectionSnapshotQuery,
      projectRecords: Option.getOrUndefined(projectionProjects),
      dispatch: orchestrationEngine.dispatch,
      serverCommandId,
    };
    const linkedSourceControlRefreshAtByProject = new Map<string, number>();
    const LINKED_SOURCE_CONTROL_SWEEP_CONCURRENCY = 2;
    // Refreshes rerun on every source-control read: one stack per workspace, then summaries.
    const sourceControlRefreshFailureLog = (worktreeId: WorktreeId) => ({
      key: `sourceControl.refresh:${worktreeId}`,
      message: "Source control refresh failed",
      fields: { worktreeId },
    });
    type KnownPullRequestRow = {
      readonly number: number;
      readonly state: KnownPullRequestState["state"];
      readonly isDraft?: boolean | undefined;
    };

    const authorize = (access: WsRpcAccess, method: string) =>
      authorizeRpcPrincipal(principal, access, method);

    const withAccess = <A, E, R>(
      access: WsRpcAccess,
      method: string,
      effect: Effect.Effect<A, E, R>,
    ) => authorize(access, method).pipe(Effect.andThen(effect));

    const ownerEffect = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      withAccess(guardedMethodAccess(method), method, effect);

    /**
     * Finds the pull request a checkout's branch has now: from its ref summary
     * (HEAD, config and the repository's change request index, cached), not a
     * full git status per swept workspace.
     */
    const discoverPullRequest = (cwd: string) =>
      gitWorkflow.refSummary(cwd).pipe(Effect.map((summary) => summary.pr));

    /**
     * Which workspaces a source-control call's `cwd` speaks for: every one of a
     * project when it is the project root, or exactly the one checked out there.
     */
    const resolveSourceControlRefreshScope = (cwd: string) =>
      Effect.gen(function* () {
        const projectOpt = yield* projectionSnapshotQuery
          .getActiveProjectByWorkspaceRoot(cwd)
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        if (Option.isSome(projectOpt)) {
          return { projectId: projectOpt.value.id, checkout: null } as const;
        }
        const checkoutOpt = yield* projectionWorktrees
          .findActiveByWorktreePath({ worktreePath: cwd })
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        return Option.isSome(checkoutOpt)
          ? ({ projectId: checkoutOpt.value.projectId, checkout: checkoutOpt.value } as const)
          : null;
      });

    /**
     * Pull request states already in hand for `cwd`'s repository: the rows a
     * list just returned plus the repository's change request index.
     */
    const knownPullRequestStatesFor =
      (rows: ReadonlyArray<KnownPullRequestRow> | undefined) => (cwd: string) =>
        gitWorkflow.indexedPullRequestStates(cwd).pipe(
          Effect.map((indexed) => {
            const known = new Map<number, KnownPullRequestState>(indexed);
            for (const row of rows ?? []) {
              known.set(row.number, { state: row.state, isDraft: row.isDraft ?? null });
            }
            return known;
          }),
        );

    /**
     * One forge request for the states of every pull request a sweep would re-read one by
     * one (`gh pr view` each), where the host can batch them. Empty when it cannot or fails:
     * the refreshes then read as before.
     */
    const batchedPullRequestStates = (
      cwd: string,
      worktrees: ReadonlyArray<Parameters<typeof readWorktreePullRequestLinks>[0]>,
    ) =>
      Effect.gen(function* () {
        const numbers = new Set<number>();
        for (const worktree of worktrees) {
          const links = readWorktreePullRequestLinks(worktree);
          const current = selectCurrentPullRequestLink(links);
          for (const link of links) {
            if (link.dismissedAt) continue;
            const finished = link.state === "merged" || link.state === "closed";
            if (finished && link.number !== current?.number) continue;
            numbers.add(link.number);
          }
        }
        if (numbers.size < 2) return new Map<number, KnownPullRequestState>();
        const provider = yield* sourceControlRegistry.resolve({ cwd });
        if (!provider.getPullRequestStates) return new Map<number, KnownPullRequestState>();
        const states = yield* provider.getPullRequestStates({ cwd, numbers: [...numbers] });
        return new Map<number, KnownPullRequestState>(
          [...states].map(([number, state]) => [
            number,
            {
              state: state.state,
              isDraft: state.isDraft,
              reported: {
                terminalAt: state.terminalAt ? DateTime.formatIso(state.terminalAt) : null,
              },
            },
          ]),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          logOnceEvery({
            key: `sourceControl.pullRequestStates:${cwd}`,
            message: "Batched pull request state read failed",
            cause,
          }).pipe(Effect.as(new Map<number, KnownPullRequestState>())),
        ),
      );

    const refreshLinkedWorktreeSourceControlStates = (input: {
      readonly cwd: string;
      readonly reason: string;
      readonly force?: boolean;
      /**
       * After a merge, close or reopen from Ryco: discover now (not on the
       * interval), trust that pull request, and, for a single checkout, wait
       * for the refresh so the link lands before git status reports the change.
       */
      readonly lifecycle?: { readonly pullRequestNumber: number | null } | undefined;
      /** Change requests the triggering read just returned for this repository. */
      readonly knownPullRequests?: ReadonlyArray<KnownPullRequestRow> | undefined;
    }) => {
      const sweep = Effect.gen(function* () {
        const scope = yield* resolveSourceControlRefreshScope(input.cwd);
        if (scope === null) return;

        const key = `${scope.projectId}:${input.cwd}`;
        const now = Date.now();
        const lastRefreshAt = linkedSourceControlRefreshAtByProject.get(key) ?? 0;
        if (!input.force && now - lastRefreshAt < SOURCE_CONTROL_LINKED_REFRESH_DEBOUNCE_MS) {
          return;
        }
        linkedSourceControlRefreshAtByProject.set(key, now);

        const worktrees = scope.checkout
          ? [scope.checkout]
          : yield* projectionWorktrees
              .listByProjectId({ projectId: scope.projectId })
              .pipe(Effect.catch(() => Effect.succeed([])));
        const refreshed: Array<(typeof worktrees)[number]> = [];
        for (const worktree of worktrees) {
          if (worktree.archivedAt !== null || worktree.worktreePath === null) continue;
          // Recorded as removed (by Ryco or found missing on disk): nothing to refresh.
          if (worktree.checkoutRemovedAt) continue;
          // Nothing linked and nothing to discover (the main checkout shows the
          // project's default branch, not a workspace's pull request).
          if (
            readWorktreePullRequestLinks(worktree).length === 0 &&
            worktree.issueNumber === null &&
            worktree.origin === "main"
          ) {
            continue;
          }
          refreshed.push(worktree);
        }
        const refreshIds = refreshed.map((worktree) => worktree.worktreeId);
        // The checkout on screen refreshes promptly; a project-wide sweep over
        // every other workspace less often; a lifecycle action now.
        const intervalMs = input.lifecycle
          ? 0
          : scope.checkout
            ? WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS
            : WORKTREE_PULL_REQUEST_SWEEP_DISCOVERY_INTERVAL_MS;
        // A project-wide sweep reads the states its links need in one request.
        const batched =
          input.lifecycle || scope.checkout || refreshIds.length === 0
            ? new Map<number, KnownPullRequestState>()
            : yield* batchedPullRequestStates(input.cwd, refreshed);
        const knownStates = (cwd: string) =>
          knownPullRequestStatesFor(input.knownPullRequests)(cwd).pipe(
            Effect.map((known) => (batched.size === 0 ? known : new Map([...known, ...batched]))),
          );
        const refresh = (worktreeId: WorktreeId) =>
          refreshWorktreeSourceControlState({
            worktreeId,
            discoverPullRequest,
            discoveryIntervalMs: intervalMs,
            linkRefreshIntervalMs: intervalMs,
            // A lifecycle action reads live; otherwise states in hand spare forge calls.
            ...(input.lifecycle ? {} : { knownPullRequestStates: knownStates }),
            actedOnPullRequestNumber: input.lifecycle?.pullRequestNumber ?? undefined,
          }).pipe(ignoreCauseLogOnceEvery(sourceControlRefreshFailureLog(worktreeId)));
        if (input.lifecycle && scope.checkout) {
          yield* Effect.forEach(refreshIds, refresh, { concurrency: "unbounded", discard: true });
        } else if (refreshIds.length > 0) {
          // One bounded sweep, never a fiber (and forge call) per workspace at once.
          yield* Effect.forEach(refreshIds, refresh, {
            concurrency: LINKED_SOURCE_CONTROL_SWEEP_CONCURRENCY,
            discard: true,
          });
        }
      }).pipe(Effect.ignoreCause({ log: true }), Effect.asVoid);
      // A lifecycle action waits for its checkout's refresh. Anything else (a list or search
      // read) answers at once: scope resolution, the sweep and its forge calls run detached in
      // the background process lane, never on the read's response path.
      return input.lifecycle
        ? sweep
        : sweep.pipe(inBackgroundProcessLane, Effect.forkDetach, Effect.asVoid);
    };

    const refreshStateForLinkedReference = (input: {
      readonly cwd: string;
      readonly kind: "pr" | "issue";
      readonly reference: string;
    }) =>
      Effect.gen(function* () {
        const parsed = Number.parseInt(input.reference, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) return;
        const scope = yield* resolveSourceControlRefreshScope(input.cwd);
        if (scope === null) return;
        const linked = yield* projectionWorktrees.findActiveByLinkedNumber({
          projectId: scope.projectId,
          kind: input.kind,
          number: parsed,
        });
        if (linked.length === 0) return;
        yield* Effect.forEach(
          linked,
          (worktreeId) =>
            refreshWorktreeSourceControlState({ worktreeId, discoverPullRequest }).pipe(
              ignoreCauseLogOnceEvery(sourceControlRefreshFailureLog(worktreeId)),
            ),
          { concurrency: LINKED_SOURCE_CONTROL_SWEEP_CONCURRENCY, discard: true },
        ).pipe(inBackgroundProcessLane, Effect.forkDetach);
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

    const appendSetupScriptActivity = makeAppendSetupScriptActivity(orchestrationEngine.dispatch);

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
        if (bootstrap?.requireWorktree) {
          const create = bootstrap.createThread;
          const prepare = bootstrap.prepareWorktree;
          if (!create || !prepare?.branch || create.worktreePath !== null) {
            return yield* Effect.fail(
              new OrchestrationDispatchCommandError({
                message: "This launch requires a fresh thread and an isolated Git worktree.",
              }),
            );
          }
          // The preference resolver below reads the selected project once and
          // binds its authorized root to this cwd before any mutation.
        }
        const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
        let createdThread = false;
        let targetProjectId = bootstrap?.createThread?.projectId;
        let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
        let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;
        let shouldRunSetupScript = bootstrap?.runSetupScript ?? false;
        let targetWorktreeId: WorktreeId | null = null;
        let preparedChat: PreparedChatProject | undefined;
        // A first send that prepares a worktree publishes its stages live, so
        // the sending client can show them instead of a generic "working".
        const setupProgress =
          bootstrap?.prepareWorktree && bootstrap.createThread
            ? yield* worktreeSetupTracker.begin({
                threadId: command.threadId,
                baseRef: bootstrap.prepareWorktree.baseBranch,
                ...(bootstrap.prepareWorktree.branch
                  ? { branch: bootstrap.prepareWorktree.branch }
                  : {}),
                fetchOrigin: bootstrap.prepareWorktree.fetchOrigin === true,
              })
            : null;
        // Set once a setup-script watcher owns releasing the progress feed.
        let setupProgressHandedToScript = false;
        const worktreeSetupCancelledError = () =>
          new OrchestrationDispatchCommandError({ message: WORKTREE_SETUP_CANCELLED_MESSAGE });

        const cleanupCreatedThread = () =>
          Effect.gen(function* () {
            if (!createdThread) return;
            if (bootstrap?.requireWorktree) {
              const live = yield* projectionSnapshotQuery.getThreadShellById(command.threadId).pipe(
                Effect.map(Option.getOrNull),
                Effect.catchCause(() => Effect.succeed(null)),
              );
              // A cancelled setup can race a replacement task under the same id.
              // Failure cleanup must never delete that replacement's data.
              if (
                !live ||
                live.projectId !== targetProjectId ||
                live.createdAt !== bootstrap.createThread?.createdAt ||
                live.worktreeId !== targetWorktreeId
              )
                return;
            }
            yield* orchestrationEngine
              .dispatch({
                type: "thread.delete",
                commandId: serverCommandId("bootstrap-thread-delete"),
                threadId: command.threadId,
              })
              .pipe(Effect.ignoreCause({ log: true }));
          });

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
          shouldRunSetupScript && targetWorktreePath
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
                        }).pipe(
                          Effect.andThen(
                            setupProgress?.stage("setup-script", { status: "failed" }) ??
                              Effect.void,
                          ),
                        ),
                      onSuccess: (setupResult) => {
                        if (setupResult.status !== "started") {
                          return (
                            setupProgress?.stage("setup-script", { status: "skipped" }) ??
                            Effect.void
                          );
                        }
                        return recordSetupScriptStarted({
                          requestedAt,
                          worktreePath,
                          scriptId: setupResult.scriptId,
                          scriptName: setupResult.scriptName,
                          terminalId: setupResult.terminalId,
                        }).pipe(
                          Effect.andThen(
                            setupProgress
                              ? Effect.gen(function* () {
                                  yield* setupProgress.stage("setup-script", {
                                    status: "running",
                                    detail: setupResult.scriptName,
                                  });
                                  yield* setupProgress.setCheckout({
                                    setupTerminalId: setupResult.terminalId,
                                  });
                                  setupProgressHandedToScript = true;
                                  yield* watchSetupScriptTerminal({
                                    handle: setupProgress,
                                    terminalManager,
                                    threadId: command.threadId,
                                    terminalId: setupResult.terminalId,
                                  });
                                })
                              : Effect.void,
                          ),
                        );
                      },
                    }),
                  );
              })()
            : (setupProgress?.stage("setup-script", { status: "skipped" }) ?? Effect.void);

        const bootstrapProgram = Effect.gen(function* () {
          // A chat's project must exist before preferences resolve against it.
          if (bootstrap?.createChatProject && bootstrap.createThread) {
            preparedChat = yield* prepareChatProject(chatBootstrap, {
              chat: bootstrap.createChatProject,
              createThread: bootstrap.createThread,
            });
          }
          const resolved = yield* resolveBootstrapPreferences({
            bootstrap,
            settings: serverSettings,
            projects: projectionSnapshotQuery,
            workspaceAccess: workspaceAccessPolicy,
          });
          const { settings, project: bootstrapProject, choices } = resolved;
          shouldRunSetupScript = resolved.runSetupScript;
          if (setupProgress) {
            // Named from the start, so the stage row reads the same before and
            // while it runs; a setup that will not run one says so up front.
            const setupScript =
              shouldRunSetupScript && bootstrapProject
                ? setupProjectScript(bootstrapProject.scripts)
                : null;
            yield* setupProgress.stage(
              "setup-script",
              setupScript ? { detail: setupScript.name } : { status: "skipped" },
            );
          }
          if (bootstrap?.prepareWorktree && bootstrapProject) targetProjectId = bootstrapProject.id;
          // A thread created after its worktree starts on that worktree's branch
          // and path, with no follow-up metadata update.
          const createBootstrapThread = (checkout?: {
            readonly branch: string;
            readonly worktreePath: string;
          }) =>
            Effect.gen(function* () {
              if (!bootstrap?.createThread) return;
              const created = yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: choices.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                ...(bootstrap.createThread.tokenMode === undefined
                  ? {}
                  : { tokenMode: bootstrap.createThread.tokenMode }),
                branch: checkout?.branch ?? bootstrap.createThread.branch,
                worktreePath: checkout?.worktreePath ?? bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              // The create event is an exact fence in the serialized command
              // stream. Drain every earlier deletion before setup or turn start
              // can acquire resources under the reused id.
              yield* threadDeletionReactor.drainThrough(created.sequence);
              createdThread = true;
            });

          // Publishing a draft's thread promotes it on every connected client.
          // Finish checkout preparation first: a Git failure must leave the draft
          // intact instead of creating/deleting it and clearing the user's prompt.
          if (!bootstrap?.prepareWorktree) yield* createBootstrapThread();

          if (bootstrap?.prepareWorktree) {
            if (setupProgress && (yield* setupProgress.cancelRequested)) {
              return yield* Effect.fail(worktreeSetupCancelledError());
            }
            const worktree = yield* gitWorkflow.createWorktree({
              ...(setupProgress ? { progress: worktreeCreationProgress(setupProgress) } : {}),
              settingsSnapshot: settings,
              projectId: targetProjectId ?? bootstrapProject?.id,
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              fetchOrigin: bootstrap.prepareWorktree.fetchOrigin,
              newRefName: bootstrap.prepareWorktree.branch,
              path: yield* resolveWorktreeCheckoutPath({
                location: undefined,
                appWorktreesRoot: yield* resolveConfiguredWorktreeRoot({
                  settings,
                  projectId: targetProjectId ?? bootstrapProject?.id,
                  config,
                  policy: workspaceAccessPolicy,
                }).pipe(
                  Effect.mapError((cause) =>
                    toGitManagerError("git.bootstrapPrepareWorktree", cause.message, cause),
                  ),
                ),
                projectId:
                  targetProjectId ?? bootstrapProject?.id ?? ProjectId.make("project-unknown"),
                workspaceRoot: bootstrap.prepareWorktree.projectCwd,
                projectMetadataDir: bootstrapProject?.projectMetadataDir,
                projectTitle: bootstrapProject?.title,
                initialName: bootstrap?.createThread?.title,
                fallbackName: command.message.text,
                branchName:
                  bootstrap.prepareWorktree.branch ?? bootstrap.prepareWorktree.baseBranch,
              }),
            });
            if (
              bootstrap.requireWorktree &&
              worktree.worktree.path === bootstrap.prepareWorktree.projectCwd
            ) {
              return yield* Effect.fail(
                new OrchestrationDispatchCommandError({
                  message:
                    "An isolated worktree is required before running setup or starting this model turn.",
                }),
              );
            }
            targetWorktreePath = worktree.worktree.path;
            if (setupProgress) {
              yield* setupProgress.stage("checkout", { status: "done", percent: 100 });
              yield* setupProgress.setCheckout({
                branch: worktree.worktree.refName,
                worktreePath: worktree.worktree.path,
              });
              // Publishing the thread promotes the draft on every client, so a
              // cancel is honoured only before that: the checkout is removed
              // again and the draft keeps the message.
              if (!(yield* setupProgress.markUncancellable)) {
                const projectCwd = bootstrap.prepareWorktree.projectCwd;
                yield* gitWorkflow
                  .removeWorktree({ cwd: projectCwd, path: worktree.worktree.path, force: true })
                  .pipe(Effect.ignoreCause({ log: true }));
                if (bootstrap.prepareWorktree.branch) {
                  yield* gitWorkflow
                    .deleteBranch({
                      cwd: projectCwd,
                      refName: worktree.worktree.refName,
                      force: true,
                    })
                    .pipe(Effect.ignoreCause({ log: true }));
                }
                return yield* Effect.fail(worktreeSetupCancelledError());
              }
            }
            if (bootstrap.createThread) {
              yield* createBootstrapThread({
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
            } else {
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
            }
            const worktreeProjectId = targetProjectId ?? bootstrapProject?.id;
            if (worktreeProjectId !== undefined) {
              const worktreeId = WorktreeId.make(`worktree-${crypto.randomUUID()}`);
              targetWorktreeId = worktreeId;
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

          if (
            bootstrap?.requireWorktree &&
            (!targetWorktreePath || targetWorktreePath === targetProjectCwd)
          ) {
            return yield* Effect.fail(
              new OrchestrationDispatchCommandError({
                message: "An isolated worktree is required before starting this model turn.",
              }),
            );
          }
          if (bootstrap?.requireWorktree) {
            const liveThread = yield* projectionSnapshotQuery
              .getThreadShellById(command.threadId)
              .pipe(
                Effect.map(Option.getOrNull),
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to verify batch thread after setup."),
                ),
              );
            if (
              !liveThread ||
              liveThread.projectId !== targetProjectId ||
              liveThread.worktreePath !== targetWorktreePath ||
              liveThread.worktreeId !== targetWorktreeId ||
              liveThread.createdAt !== bootstrap.createThread?.createdAt
            ) {
              return yield* Effect.fail(
                new OrchestrationDispatchCommandError({
                  message:
                    "The batch setup was cancelled or its workspace changed. The model turn was not started.",
                }),
              );
            }
          }
          if (!setupProgress) return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          yield* setupProgress.stage("agent", { status: "running" });
          const started = yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          yield* setupProgress.stage("agent", { status: "done" });
          yield* setupProgress.finish("done");
          if (!setupProgressHandedToScript) yield* setupProgress.release;
          return started;
        });

        const settleSetupProgress = (cause: Cause.Cause<unknown>, message: string) =>
          setupProgress
            ? Effect.gen(function* () {
                const cancelled =
                  Cause.hasInterruptsOnly(cause) || message === WORKTREE_SETUP_CANCELLED_MESSAGE;
                yield* setupProgress.finish(
                  cancelled ? "cancelled" : "failed",
                  cancelled ? undefined : message,
                );
                yield* setupProgress.release;
              })
            : Effect.void;

        return yield* bootstrapProgram.pipe(
          Effect.catchCause((cause) => {
            const dispatchError = toBootstrapDispatchCommandCauseError(cause);
            if (Cause.hasInterruptsOnly(cause)) {
              return settleSetupProgress(cause, dispatchError.message).pipe(
                Effect.andThen(Effect.fail(dispatchError)),
              );
            }
            const chatProjectId = bootstrap?.createChatProject?.projectId;
            return settleSetupProgress(cause, dispatchError.message).pipe(
              Effect.andThen(cleanupCreatedThread()),
              Effect.andThen(
                Effect.suspend(() =>
                  preparedChat
                    ? releasePreparedChatFolder(chatBootstrap, preparedChat)
                    : Effect.void,
                ),
              ),
              // Once cleanup settled: a chat retired meanwhile needs a fresh id, not a retry.
              Effect.andThen(
                chatProjectId === undefined
                  ? Effect.succeed(dispatchError)
                  : classifyChatBootstrapFailure(chatBootstrap, chatProjectId, dispatchError),
              ),
              Effect.flatMap(Effect.fail),
            );
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

    /** Runs a mutation once startup admits commands, exactly as `dispatchNormalizedCommand`. */
    const enqueueStartupCommand = startup.enqueueCommand;

    const loadDiagnosticsMetrics = localDiagnosticsMetrics.snapshot;
    const loadAdvertisedEndpoints = advertisedEndpointRegistry.list;
    // Hub-linked direct access: reads the channel's device at call time, after
    // `relay_native` admitted the request.
    const issueLinkedDirectAccessForChannel = (input: AuthIssueLinkedDirectAccessInput) =>
      Effect.gen(function* () {
        const [environment, endpoints] = yield* Effect.all([
          serverEnvironment.getDescriptor,
          advertisedEndpointRegistry.list,
        ]);
        const issued = yield* issueLinkedDirectAccess({
          authority: principal.relayAuthority?.() ?? { trustSource: "none" },
          deviceLabel: input.deviceLabel,
          environment,
          endpoints,
          bootstrapCredentials,
        }).pipe(Effect.orDie);
        if (issued === null) {
          return yield* new AuthRpcError({
            message: "This channel no longer identifies a native device.",
            status: 403,
          });
        }
        return issued;
      });
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
      const chats = Option.isSome(chatFolders) ? yield* chatFolders.value.capability : undefined;

      return {
        environment,
        auth,
        cwd: config.cwd,
        ...(config.workspaceAccessRoot !== undefined
          ? { workspaceAccessRoot: config.workspaceAccessRoot }
          : {}),
        ...(chats !== undefined ? { chats } : {}),
        usageContractVersion: USAGE_CONTRACT_VERSION,
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
          // Browsers export spans only to a server that has a use for them.
          browserTracesEnabled:
            config.otlpTracesUrl !== undefined || config.browserTracesEnabled === true,
          ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
          otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          localMetrics,
        },
        settings,
      };
    });

    /**
     * Full config snapshots for each chats-capability change after the one a subscriber already
     * received, e.g. when the Chats folder setting moves the root into a Git repository.
     */
    const streamChatsConfigSnapshots = (received: ServerChatsCapability | undefined) =>
      Option.match(chatFolders, {
        onNone: () => Stream.empty,
        onSome: (folders) =>
          Stream.concat(Stream.make(received), folders.changes).pipe(
            Stream.changesWith((left, right) => sameChatsCapability(left, right)),
            Stream.drop(1),
            // A failed reload skips this update instead of ending the subscriber's config stream.
            Stream.mapEffect(() =>
              loadServerConfig.pipe(
                Effect.map(Option.some),
                Effect.catch((cause) =>
                  Effect.logWarning("chats config snapshot skipped", { cause }).pipe(
                    Effect.as(Option.none()),
                  ),
                ),
              ),
            ),
            Stream.filter(Option.isSome),
            Stream.map(({ value: config }) => ({
              version: 1 as const,
              type: "snapshot" as const,
              config,
            })),
          ),
      });

    /**
     * Wait, bounded, until cleanup for every thread deletion committed so far has run (provider
     * sessions stopped, terminals closed). Earlier processes cleaned up their own deletions.
     */
    const settleThreadDeletionCleanup = projectionSnapshotQuery.getSnapshotSequence().pipe(
      Effect.flatMap(({ snapshotSequence }) =>
        snapshotSequence > orchestrationEngine.bootSequence
          ? threadDeletionReactor.drainThrough(snapshotSequence)
          : Effect.void,
      ),
      Effect.timeout(Duration.seconds(10)),
      Effect.ignoreCause({ log: true }),
    );

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
        ...Option.match(orchestrationEventStore, {
          onNone: () => ({}),
          onSome: (eventStore) => ({
            ...(eventStore.probeResume ? { probeResume: eventStore.probeResume } : {}),
            readStreamEventsPage: eventStore.readStreamEventsPage,
          }),
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
      serverSettings,
      projectionSnapshotQuery,
      projectionWorktrees,
      gitWorkflow,
      vcsProvisioning,
      gitDriver,
      config,
      workspaceAccessPolicy,
      textGeneration,
      projectSetupScriptRunner,
      serverCommandId,
      dispatchNormalizedCommand,
      refreshGitStatus,
      appendSetupScriptActivity,
      workspaceLifecycle,
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
        // Hosts the capability matrix lists without CI fail before the provider loads.
        Effect.tap((provider) =>
          requireChangeRequestCapability(provider.kind, { operation: input.operation }),
        ),
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
      storageService,
      workspaceLifecycle,
      workspaceChangeSummary,
      storagePrincipalKey: `${principal.transport}:${principal.scopeId}:${crypto.randomUUID()}`,
      currentSessionId,
      projectionSnapshotQuery,
      statisticsQuery,
      usageService,
      cliProxyService,
      orchestrationEngine,
      contextHandoffInspection,
      threadPriorityCoordinator,
      chatAttachmentUploads,
      sessionImport,
      threadFork,
      automationCentre,
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
      worktreeSetupTracker,
      providerRegistry,
      modelManifest,
      providerService,
      providerRuntimeIngestion,
      providerMaintenanceRunner,
      dailyRecapQuery,
      sessionPrewarm,
      localTaskService,
      worktreeNotesService,
      config,
      lifecycleEvents,
      serverSettings,
      mcpRegistry,
      projectionProjects,
      projectionThreads,
      chatFolders,
      projectRelocations,
      storageAdmission,
      gitDriver,
      projectFaviconResolver,
      projectAvatarStore,
      workspaceEntries,
      workspaceFileSystem,
      clientWorkspaceUse,
      fileSystem,
      workspaceAccessPolicy,
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
      settleThreadDeletionCleanup,
      refreshGitStatus,
      toGitManagerError,
      commandReceipts,
      dispatchNormalizedCommand,
      enqueueStartupCommand,
      dispatchWorktreeCommand,
      enrichOrchestrationEvents,
      makeReplayableShellStream,
      makeReplayableThreadStream,
      loadServerConfig,
      streamChatsConfigSnapshots,
      loadAdvertisedEndpoints,
      issueLinkedDirectAccessForChannel,
      loadDiagnosticsMetrics,
      loadDiagnosticsSnapshot,
      recordThreadSnapshotDurationMs: localDiagnosticsMetrics.recordThreadSnapshotDurationMs,
      loadAuthAccessSnapshot,
      refreshLinkedWorktreeSourceControlStates,
      refreshStateForLinkedReference,
      discoverPullRequest,
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
