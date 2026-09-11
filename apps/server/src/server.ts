import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { ChatAttachmentUploadsLive } from "./attachmentUpload.ts";
import {
  attachmentUploadRouteLayer,
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  projectAvatarUploadRouteLayer,
  projectAvatarServeRouteLayer,
  serverEnvironmentRouteLayer,
  legacyServerEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
} from "./http.ts";
import { ProjectAvatarStoreLive } from "./project/Layers/ProjectAvatarStore.ts";
import { fixPath } from "./os-jank.ts";
import { deviceWebsocketRpcRouteLayer, websocketRpcRouteLayer } from "./ws.ts";
import { DeviceServiceLive } from "./device/Layers/DeviceService.ts";
import { deviceFrameRouteLayer } from "./device/deviceFrameRoute.ts";
import { HubConnectorLive } from "./hubConnector/HubConnectorLive.ts";
import { hubConnectorRoutesLayer } from "./hubConnector/http.ts";
import { desktopLocalIntroductionRoutesLayer } from "./hubConnector/localIntroductionHttp.ts";
import { desktopNativeNodeClaimRoutesLayer } from "./hubConnector/desktopNativeNodeClaimHttp.ts";
import { OpenLive } from "./open.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime.ts";
import { ContextHandoffRepositoryLive } from "./persistence/Layers/ContextHandoffs.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import { ProviderEventLoggersLive } from "./provider/Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { OpenCodeRuntimeLive } from "./provider/opencodeRuntime.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as ForgejoApi from "./sourceControl/ForgejoApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { ThreadPriorityCandidateQueryLive } from "./threadPriority/ThreadPriorityCandidateQuery.ts";
import { ThreadPriorityCoordinatorLive } from "./threadPriority/ThreadPriorityCoordinator.ts";
import { ThreadPriorityRepositoryLive } from "./threadPriority/ThreadPriorityRepository.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import * as GitManager from "./git/GitManager.ts";
import { KeybindingsLive } from "./keybindings.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { ContextHandoffCoordinatorLive } from "./orchestration/Layers/ContextHandoffCoordinator.ts";
import { ContextHandoffServiceLive } from "./orchestration/contextHandoff/ContextHandoffService.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { WorkspaceAccessPolicyLive } from "./workspace/Layers/WorkspaceAccessPolicy.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment.ts";
import { UsageServiceLive } from "./usage/UsageService.ts";
import { AdvertisedEndpointRegistryLive } from "./remote/AdvertisedEndpointRegistry.ts";
import {
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
} from "./auth/http.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import * as AtlassianConnectionService from "./atlassian/AtlassianConnectionService.ts";
import * as JiraWorkItemService from "./atlassian/JiraWorkItemService.ts";
import { AtlassianConnectionRepositoryLive } from "./persistence/Layers/AtlassianConnections.ts";
import { AtlassianResourceRepositoryLive } from "./persistence/Layers/AtlassianResources.ts";
import { ProjectAtlassianLinkRepositoryLive } from "./persistence/Layers/ProjectAtlassianLinks.ts";
import { ProjectionWorktreeRepositoryLive } from "./persistence/Layers/ProjectionWorktrees.ts";
import { AgentControlAuditRepositoryLive } from "./persistence/Layers/AgentControlAudit.ts";
import { AgentControlOperationRepositoryLive } from "./persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "./persistence/Layers/AgentControlProposals.ts";
import { AgentControlExternalRepositoryLive } from "./persistence/Layers/AgentControlExternal.ts";
import { AgentControlAutomationRepositoryLive } from "./persistence/Layers/AgentControlAutomations.ts";
import { AgentControlMcpInstallationRepositoryLive } from "./persistence/Layers/AgentControlMcpInstallation.ts";
import { AgentControlMcpServerLive } from "./agentControl/Layers/AgentControlMcpServer.ts";
import { AgentControlOperationStoreLive } from "./agentControl/Layers/AgentControlOperationStore.ts";
import { AgentControlPolicyLive } from "./agentControl/Layers/AgentControlPolicy.ts";
import { AgentControlProposalEventsLive } from "./agentControl/Layers/AgentControlProposalEvents.ts";
import { AgentControlProposalServiceLive } from "./agentControl/Layers/AgentControlProposalService.ts";
import { AgentControlProposalStoreLive } from "./agentControl/Layers/AgentControlProposalStore.ts";
import { AgentControlSessionRegistryLive } from "./agentControl/Layers/AgentControlSessionRegistry.ts";
import { AgentControlActionValidatorLive } from "./agentControl/Layers/AgentControlActionValidator.ts";
import { AgentControlExecutionLive } from "./agentControl/Layers/AgentControlExecution.ts";
import { AgentControlProjectPlansLive } from "./agentControl/Layers/AgentControlProjectPlans.ts";
import { AgentControlExternalIntegrationServiceLive } from "./agentControl/Layers/AgentControlExternalIntegration.ts";
import { AgentControlExternalTaskServiceLive } from "./agentControl/Layers/AgentControlExternalTask.ts";
import { AgentControlExternalMcpServerLive } from "./agentControl/Layers/AgentControlExternalMcpServer.ts";
import { AgentControlAutomationServiceLive } from "./agentControl/Layers/AgentControlAutomation.ts";
import { AgentControlDiagnosticsServiceLive } from "./agentControl/Layers/AgentControlDiagnostics.ts";
import { AgentControlExternalInstallationServiceLive } from "./agentControl/Layers/AgentControlExternalInstallation.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { OrchestrationCommandApplicationLive } from "./orchestration/Layers/OrchestrationCommandApplication.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
} from "./orchestration/http.ts";
import { NetService } from "@ryco/shared/Net";
import { disableTailscaleServe, ensureTailscaleServe } from "@ryco/tailscale";

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY.ts"));
      return BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY.ts"));
      return NodePTY.layer;
    }
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.host,
        port: config.port,
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ProjectAvatarStoreLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return ProjectAvatarStoreLive({ dataDir: config.stateDir });
  }),
);

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(ContextHandoffCoordinatorLive),
  Layer.provideMerge(ContextHandoffServiceLive),
  Layer.provideMerge(ContextHandoffRepositoryLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const RuntimeFeatureLayerLive = Layer.mergeAll(
  ReactorLayerLive,
  ThreadPriorityCoordinatorLive,
).pipe(
  Layer.provideMerge(ThreadPriorityCandidateQueryLive),
  Layer.provideMerge(ThreadPriorityRepositoryLive),
  Layer.provideMerge(TextGeneration.layer),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggersLive` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

// Agent Control: policy, proposal/operation facades over their dedicated
// repositories, the proposal change feed, and the owner-facing approval
// lifecycle service (consumed by the `agentControl.*` WS RPCs). The feature
// defaults to disabled and every entry point fails closed; only the expiry
// sweep runs unconditionally so stale proposals converge to `expired` even
// while the feature is off. The internal provider-session MCP surface is
// composed separately: the in-memory session registry rides low in the
// runtime chain so provider drivers can reach it (`AgentControlSessionRegistryLayerLive`
// below), and the private loopback listener lifecycle joins the runtime
// services beside `ServerRuntimeStartupLive`.
const AgentControlAutomationLayerLive = AgentControlAutomationServiceLive.pipe(
  Layer.provideMerge(AgentControlExternalIntegrationServiceLive),
);

const AgentControlExternalInstallationLayerLive = AgentControlExternalInstallationServiceLive.pipe(
  Layer.provideMerge(AgentControlExternalIntegrationServiceLive),
  Layer.provideMerge(AgentControlMcpInstallationRepositoryLive),
);

const AgentControlLayerLive = Layer.mergeAll(
  AgentControlProposalServiceLive,
  AgentControlOperationStoreLive,
  AgentControlAutomationLayerLive,
  AgentControlExternalInstallationLayerLive,
).pipe(
  Layer.provideMerge(AgentControlProposalStoreLive),
  Layer.provideMerge(AgentControlProposalEventsLive),
  Layer.provideMerge(AgentControlPolicyLive),
  Layer.provideMerge(AgentControlProposalRepositoryLive),
  Layer.provideMerge(AgentControlOperationRepositoryLive),
  Layer.provideMerge(AgentControlAuditRepositoryLive),
  Layer.provideMerge(AgentControlExternalRepositoryLive),
  Layer.provideMerge(AgentControlAutomationRepositoryLive),
  Layer.provideMerge(AgentControlMcpInstallationRepositoryLive),
);

// In-memory credential/lease authority for the internal provider-session
// MCP surface. Deliberately a leaf: provider drivers resolve it from
// ambient context at instance construction, and the MCP listener layer
// publishes its private endpoint into it. `AgentControlPolicyLive` is the
// same layer reference as inside `AgentControlLayerLive`, so memoization
// builds it once.
const AgentControlSessionRegistryLayerLive = AgentControlSessionRegistryLive.pipe(
  Layer.provide(AgentControlPolicyLive),
);

const VcsDriverRegistryLayerLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const SourceControlProviderRegistryLayerLive = SourceControlProviderRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AzureDevOpsCli.layer,
      BitbucketApi.layer,
      ForgejoApi.layer,
      GitHubCli.layer,
      GitLabCli.layer,
    ),
  ),
  Layer.provideMerge(AtlassianConnectionRepositoryLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerSecretStoreLive),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const GitManagerLayerLive = GitManager.layer.pipe(
  Layer.provideMerge(ProjectSetupScriptRunnerLive),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(TextGeneration.layer),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitVcsDriver.layer),
);

const GitWorkflowLayerLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
);

const SourceControlRepositoryServiceLayerLive = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provide(WorkspaceAccessPolicyLive),
);

const VcsLayerLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
  Layer.provideMerge(GitWorkflowLayerLive),
  Layer.provideMerge(SourceControlRepositoryServiceLayerLive),
  Layer.provideMerge(VcsStatusBroadcaster.layer.pipe(Layer.provide(GitWorkflowLayerLive))),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
);

const TerminalLayerLive = TerminalManagerLive.pipe(
  Layer.provide(PtyAdapterLive),
  Layer.provide(WorkspaceAccessPolicyLive),
);

const WorkspaceEntriesLayerLive = WorkspaceEntriesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceAccessPolicyLive),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const WorkspaceFileSystemLayerLive = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspaceAccessPolicyLive,
  WorkspacePathsLive,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

const AuthLayerLive = ServerAuthLive.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerSecretStoreLive),
);

const AtlassianLayerLive = Layer.mergeAll(
  AtlassianConnectionService.layer,
  JiraWorkItemService.layer,
).pipe(
  Layer.provideMerge(AtlassianConnectionRepositoryLive),
  Layer.provideMerge(AtlassianResourceRepositoryLive),
  Layer.provideMerge(ProjectAtlassianLinkRepositoryLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerSecretStoreLive),
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const RuntimeCoreBaseDependenciesLive = RuntimeFeatureLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(VcsLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(AgentControlLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(ProjectionWorktreeRepositoryLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ProviderRegistryLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
  // Below the instance registry so driver `create()` (which runs inside
  // registry reconcile fibers) sees the Agent Control session registry in
  // its ambient context; also merged upward for the MCP listener layer.
  Layer.provideMerge(AgentControlSessionRegistryLayerLive),
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  Layer.provideMerge(ProviderEventLoggersLive),
  // Remote-refreshable provider model metadata (bundled fallback). Provided
  // at the same level as the event loggers so driver `create()` sees it.
  Layer.provideMerge(ModelManifest.layer),
  // `OpenCodeDriver.create()` yields `OpenCodeRuntime`; previously the old
  // `ProviderRegistryLive` pulled `OpenCodeRuntimeLive` in for itself, but
  // the rewritten registry reads snapshots off the instance registry and
  // no longer transitively provides it. Exposing it at the runtime level
  // keeps a single Live for all opencode consumers.
  Layer.provideMerge(OpenCodeRuntimeLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(ProjectAvatarStoreLayerLive),
);

const RuntimeCoreBaseWithSettingsLive = Layer.mergeAll(
  RuntimeCoreBaseDependenciesLive,
  UsageServiceLive,
).pipe(Layer.provideMerge(ServerSettingsLive));

const RuntimeCoreDependenciesLive = RuntimeCoreBaseWithSettingsLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(AdvertisedEndpointRegistryLive),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(AtlassianLayerLive),
);

const RuntimeDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provideMerge(ChatAttachmentUploadsLive),
  Layer.provide(NetService.layer),
);

// The private Agent Control MCP listener joins the runtime services here:
// it consumes projections, proposals, provider snapshots, and the session
// registry from the runtime dependencies, and its endpoint never touches
// the public HTTP server, router, or any client-visible state.
const RuntimeServicesLive = Layer.mergeAll(
  ServerRuntimeStartupLive,
  AgentControlMcpServerLive.pipe(
    Layer.provideMerge(AgentControlDiagnosticsServiceLive),
    Layer.provideMerge(AgentControlActionValidatorLive),
    Layer.provideMerge(AgentControlProjectPlansLive),
  ),
  AgentControlExternalMcpServerLive.pipe(
    Layer.provideMerge(AgentControlDiagnosticsServiceLive),
    Layer.provideMerge(AgentControlActionValidatorLive),
    Layer.provideMerge(AgentControlProjectPlansLive),
    Layer.provideMerge(
      AgentControlExternalTaskServiceLive.pipe(
        Layer.provideMerge(AgentControlActionValidatorLive),
        Layer.provideMerge(AgentControlProjectPlansLive),
      ),
    ),
  ),
  AgentControlExecutionLive.pipe(
    Layer.provideMerge(ServerRuntimeStartupLive),
    Layer.provideMerge(AgentControlActionValidatorLive),
    Layer.provideMerge(AgentControlProjectPlansLive),
    Layer.provideMerge(OrchestrationCommandApplicationLive),
  ),
).pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
  // One process-scoped manager is shared by control RPC, frame streaming,
  // provider tools, idle cleanup, and crash-recovery ownership.
  Layer.provideMerge(DeviceServiceLive),
);

const authRoutesLayer = Layer.mergeAll(
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
);

const projectAssetRoutesLayer = Layer.mergeAll(
  projectFaviconRouteLayer,
  projectAvatarUploadRouteLayer,
  projectAvatarServeRouteLayer,
);

export const makeRoutesLayer = Layer.mergeAll(
  authRoutesLayer,
  attachmentsRouteLayer,
  attachmentUploadRouteLayer,
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
  otlpTracesProxyRouteLayer,
  projectAssetRoutesLayer,
  serverEnvironmentRouteLayer,
  legacyServerEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
  deviceWebsocketRpcRouteLayer,
  deviceFrameRouteLayer,
  hubConnectorRoutesLayer,
  desktopLocalIntroductionRoutesLayer,
  desktopNativeNodeClaimRoutesLayer,
).pipe(Layer.provide(browserApiCorsLayer));

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath({ inheritedFromDesktop: config.mode === "desktop" });

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const state = makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          });
        }),
        () => clearPersistedServerRuntimeState(config.serverRuntimeStatePath),
      ),
    );
    const tailscaleServeLayer = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({
                    servePort: configured.servePort,
                  }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }).pipe(Layer.provide(HubConnectorLive)),
      httpListeningLayer,
      runtimeStateLayer,
      tailscaleServeLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(WorkspaceAccessPolicyLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  any,
  ServerConfig
>;
