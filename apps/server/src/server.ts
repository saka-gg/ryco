import { LocalTaskServiceLive } from "./tasks/LocalTaskService.ts";
import { WorktreeNotesServiceLive } from "./notes/WorktreeNotesService.ts";
import { NodeUpdateServiceLive } from "./nodeUpdate/NodeUpdateService.ts";
import { DailyRecapQueryLive } from "./statistics/DailyRecapQuery.ts";
import { StorageServiceLive } from "./storage/StorageService.ts";
import { WorkspaceLifecycleLive } from "./workspace/WorkspaceLifecycle.ts";
import { WorkspaceChangeSummaryLive } from "./workspace/WorkspaceChangeSummary.ts";
import { ChatFoldersLive } from "./project/chatFolders.ts";
import { ProviderProtectedPathsLive } from "./storage/providerProtection.ts";
import { SessionImportLive } from "./imports/SessionImport.ts";
import { ThreadForkLive } from "./threadFork/Layers/ThreadFork.ts";
import { ThreadForkRepositoryLive } from "./persistence/Layers/ThreadForks.ts";
import { CompletionReturnRepositoryLive } from "./persistence/Layers/AgentControlCompletionReturns.ts";
import { ProviderEffectIntentRepositoryLive } from "./persistence/Layers/ProviderEffectIntents.ts";
import { RestartContinuationRepositoryLive } from "./persistence/Layers/RestartContinuations.ts";
import { RestartContinuationLive } from "./orchestration/Layers/RestartContinuation.ts";
import { CompletionReturnDeliveryLive } from "./agentControl/Layers/CompletionReturnDelivery.ts";
import { AgentControlWorkspacesLive } from "./agentControl/workspaceLifecycle.ts";
import { AutomationCentreLive } from "./agentControl/Layers/AutomationCentre.ts";
import { Duration, Effect, Layer } from "effect";
import { FetchHttpClient, HttpMiddleware, HttpRouter, HttpServer } from "effect/http";

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
  BROWSER_API_CORS_OPTIONS,
  serveStaticRequest,
} from "./http.ts";
import {
  installHttpStartupGate,
  isEarlyStaticAssetRequest,
  isEarlyStaticRequest,
} from "./httpStartupGate.ts";
import { recordDesktopStartupPhase, writeDesktopLifecycleFrame } from "./desktopLifecycle.ts";
import { DesktopParentLossShutdownLogLive } from "./desktopParentLifetime.ts";
import { ProjectAvatarStoreLive } from "./project/Layers/ProjectAvatarStore.ts";
import { fixPath } from "./os-jank.ts";
import { deviceWebsocketRpcRouteLayer, websocketRpcRouteLayer } from "./ws.ts";
import {
  installWebSocketCompressionPolicy,
  WEBSOCKET_PER_MESSAGE_DEFLATE,
} from "./webSocketCompression.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import { ContextHandoffInspectionLive } from "./orchestration/Layers/ContextHandoffInspection.ts";
import { DeviceServiceLive } from "./device/Layers/DeviceService.ts";
import { deviceFrameRouteLayer } from "./device/deviceFrameRoute.ts";
import {
  HubConnectorDeferredLive,
  startHubConnectorAfterServe,
} from "./hubConnector/HubConnectorDeferred.ts";
import { hubConnectorRoutesLayer } from "./hubConnector/http.ts";
import { desktopLocalIntroductionRoutesLayer } from "./hubConnector/localIntroductionHttp.ts";
import { desktopHubReachabilityRouteLayer } from "./hubConnector/desktopHubReachabilityHttp.ts";
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
import * as ForgejoApi from "./sourceControl/ForgejoApi.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { ThreadPriorityCandidateQueryLive } from "./threadPriority/ThreadPriorityCandidateQuery.ts";
import { ThreadPriorityCoordinatorLive } from "./threadPriority/ThreadPriorityCoordinator.ts";
import { ThreadPriorityRepositoryLive } from "./threadPriority/ThreadPriorityRepository.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import { WorktreeSetupTrackerLive } from "./project/Layers/WorktreeSetupTracker.ts";
import * as GitManager from "./git/GitManager.ts";
import { KeybindingsLive } from "./keybindings.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderSessionPrewarmLive } from "./orchestration/Layers/ProviderSessionPrewarm.ts";
import { ContextHandoffCoordinatorLive } from "./orchestration/Layers/ContextHandoffCoordinator.ts";
import { ContextHandoffServiceLive } from "./orchestration/contextHandoff/ContextHandoffService.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { ThreadPurgeReactorLive } from "./orchestration/Layers/ThreadPurgeReactor.ts";
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
import { CliProxyServiceLive } from "./cliProxy/CliProxyService.ts";
import { AdvertisedEndpointRegistryLive } from "./remote/AdvertisedEndpointRegistry.ts";
import { SleepInhibitorLive } from "./service/sleepInhibitor.ts";
import { StartupStallMonitorLive, trackStartupLayer } from "./startupStallMonitor.ts";
import {
  authBearerBootstrapRouteLayer,
  authBearerRotateRouteLayer,
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
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects.ts";
import { ProjectRelocationRepositoryLive } from "./persistence/Layers/ProjectRelocations.ts";
import { ProjectionWorktreeRepositoryLive } from "./persistence/Layers/ProjectionWorktrees.ts";
import { AgentControlAuditRepositoryLive } from "./persistence/Layers/AgentControlAudit.ts";
import { AgentControlOperationRepositoryLive } from "./persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "./persistence/Layers/AgentControlProposals.ts";
import { AgentControlExternalRepositoryLive } from "./persistence/Layers/AgentControlExternal.ts";
import { AgentControlAutomationRepositoryLive } from "./persistence/Layers/AgentControlAutomations.ts";
import { AgentControlMcpInstallationRepositoryLive } from "./persistence/Layers/AgentControlMcpInstallation.ts";
import { AgentControlMcpServerLive } from "./agentControl/Layers/AgentControlMcpServer.ts";
import { HtmlRenderLive } from "./htmlRender/HtmlRenderLive.ts";
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
import { AgentControlExternalTopologyLive } from "./agentControl/Layers/AgentControlExternalTopology.ts";
import { AgentControlExternalTaskServiceLive } from "./agentControl/Layers/AgentControlExternalTask.ts";
import { AgentControlExternalMcpServerLive } from "./agentControl/Layers/AgentControlExternalMcpServer.ts";
import { AgentControlAutomationServiceLive } from "./agentControl/Layers/AgentControlAutomation.ts";
import { AgentControlDiagnosticsServiceLive } from "./agentControl/Layers/AgentControlDiagnostics.ts";
import { AgentControlExternalInstallationServiceLive } from "./agentControl/Layers/AgentControlExternalInstallation.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { OrchestrationCommandApplicationLive } from "./orchestration/Layers/OrchestrationCommandApplication.ts";
import { UsageLimitRecoveryLive } from "./orchestration/Layers/UsageLimitRecovery.ts";
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

/**
 * How long HTTP shutdown waits for in-flight requests before it forces the
 * remaining connections closed (WebSocket clients that ignored the 1001 close
 * included). Well inside the desktop's 3 s SIGTERM→SIGKILL grace
 * (`DESKTOP_BACKEND_SIGTERM_GRACE_MS`), so the runtime finalizers sequenced
 * after the HTTP stage (restart hints, provider shutdown, SQLite close) still
 * run.
 */
const HTTP_GRACEFUL_SHUTDOWN_TIMEOUT = Duration.millis(750);

/**
 * Layers whose finalizers log shutdown progress. The first marker to run
 * starts the clock; each later one reports the time since.
 */
const makeShutdownClock = () => {
  let startedAt: number | undefined;
  return {
    marker: (phase: string) =>
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.suspend(() => {
            const now = performance.now();
            startedAt ??= now;
            return Effect.logInfo("shutdown phase", {
              phase,
              sinceShutdownMs: Math.round(now - startedAt),
            });
          }),
        ),
      ),
  };
};

const boundTcpPort = (address: HttpServer.HttpServer["Service"]["address"]): number | null =>
  typeof address === "string" || !("port" in address) ? null : address.port;

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
        gracefulShutdownTimeout: HTTP_GRACEFUL_SHUTDOWN_TIMEOUT,
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      // The platform binds the port here, long before `HttpRouter.serve`
      // attaches the request handlers; the gate holds what arrives meanwhile.
      let startupGate: ReturnType<typeof installHttpStartupGate> | undefined;
      const serverLayer = NodeHttpServer.layer(
        () => {
          const server = NodeHttp.createServer();
          // The desktop renderer talks over loopback, where compression is pure CPU;
          // device frames are H.264 and never negotiate it.
          installWebSocketCompressionPolicy(server, {
            skipDirectLoopback: config.mode === "desktop",
          });
          startupGate = installHttpStartupGate(server);
          return server;
        },
        {
          host: config.host,
          port: config.port,
          gracefulShutdownTimeout: HTTP_GRACEFUL_SHUTDOWN_TIMEOUT,
          websocket: { perMessageDeflate: WEBSOCKET_PER_MESSAGE_DEFLATE },
        },
      );
      // While the runtime graph builds (migrations, projector catch-up, read
      // model), the gate answers static-shell requests itself (same handler as
      // the router's catch-all route), so clients load the UI in parallel; API,
      // auth and WebSocket requests stay held. A desktop backend serves the
      // document too, so the renderer loads from `http-bound`. Other modes
      // serve assets only and keep `/` held: readiness probes such as the SSH
      // launcher's `wait_ready` poll it and must not report a server ready
      // before its router serves.
      const earlyStaticServingLayer = Layer.effectDiscard(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const gate = startupGate;
          if (gate !== undefined && !gate.isOpen()) {
            const servesEarly =
              config.mode === "desktop" ? isEarlyStaticRequest : isEarlyStaticAssetRequest;
            const handler = yield* NodeHttpServer.makeHandler(
              HttpMiddleware.cors(BROWSER_API_CORS_OPTIONS)(serveStaticRequest),
              { scope: yield* Effect.scope },
            );
            gate.setEarlyRequestHandler((request, response) => {
              if (!servesEarly(request)) return false;
              handler(request, response);
              return true;
            });
            yield* Effect.addFinalizer(() => Effect.sync(() => gate.setEarlyRequestHandler(null)));
          }
          const port = boundTcpPort(server.address);
          if (port !== null) writeDesktopLifecycleFrame({ type: "http-bound", port });
          recordDesktopStartupPhase("http-bound");
        }),
      );
      return earlyStaticServingLayer.pipe(Layer.provideMerge(serverLayer));
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
  Layer.provideMerge(ProviderCommandReactorLive),
  // Below the command reactor: its liveness sweep asks ingestion for history checks.
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderSessionPrewarmLive),
  Layer.provideMerge(ContextHandoffCoordinatorLive),
  Layer.provideMerge(ContextHandoffServiceLive),
  Layer.provideMerge(ContextHandoffRepositoryLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(ThreadPurgeReactorLive),
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
  Layer.provideMerge(CompletionReturnRepositoryLive),
  Layer.provideMerge(AgentControlProposalEventsLive),
  Layer.provideMerge(AgentControlPolicyLive),
  Layer.provideMerge(AgentControlProposalRepositoryLive),
  Layer.provideMerge(AgentControlOperationRepositoryLive),
  Layer.provideMerge(AgentControlAuditRepositoryLive),
  Layer.provideMerge(AgentControlExternalRepositoryLive),
  Layer.provideMerge(AgentControlAutomationRepositoryLive),
  Layer.provideMerge(AgentControlMcpInstallationRepositoryLive),
  // One process-wide external topology: the external integration surface, its
  // listener, and the Hub connector (which hands the process over before its
  // first relay connection) must all read the same value.
  Layer.provideMerge(AgentControlExternalTopologyLive),
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
  Layer.provide(ForgejoApi.layer),
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

// Named for startup attribution: auth keys and session state load before the router serves.
const AuthLayerLive = trackStartupLayer("auth.layer.build", ServerAuthLive).pipe(
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
  // With the one in-memory feed of first-send worktree setups, shared by every connection.
  Layer.provideMerge(Layer.mergeAll(TerminalLayerLive, WorktreeSetupTrackerLive)),
  Layer.provideMerge(AgentControlLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(ProjectionWorktreeRepositoryLive),
  // With the chat-promotion journal: written by "Turn into project…", settled at startup.
  Layer.provideMerge(
    Layer.mergeAll(ProjectionProjectRepositoryLive, ProjectRelocationRepositoryLive),
  ),
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
  CliProxyServiceLive,
).pipe(Layer.provideMerge(ServerSettingsLive));

const RuntimeCoreDependenciesLive = RuntimeCoreBaseWithSettingsLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(AdvertisedEndpointRegistryLive),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(AtlassianLayerLive),
);

const RuntimeBaseDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provideMerge(ChatAttachmentUploadsLive),
  Layer.provide(NetService.layer),
);

// Restart continuation reads settings, orchestration, the session directory,
// delegated returns and the provider intent ledger from the runtime dependencies;
// `ServerRuntimeStartupLive` resolves it to capture, note and continue restarted work.
const RuntimeDependenciesLive = RestartContinuationLive.pipe(
  Layer.provide(
    Layer.mergeAll(RestartContinuationRepositoryLive, ProviderEffectIntentRepositoryLive),
  ),
  Layer.provideMerge(RuntimeBaseDependenciesLive),
);

// The private Agent Control MCP listener joins the runtime services here:
// it consumes projections, proposals, provider snapshots, and the session
// registry from the runtime dependencies, and its endpoint never touches
// the public HTTP server, router, or any client-visible state.
const RuntimeServicesLive = Layer.mergeAll(
  DailyRecapQueryLive,
  WorktreeNotesServiceLive,
  StorageServiceLive.pipe(Layer.provide(ProviderProtectedPathsLive)),
  SessionImportLive,
  // Chat forks: recovery of unfinished forks once commands are admitted. The ledger is provided
  // beneath the services (below), so startup's orphan-chat sweep sees the chats forks still need.
  ThreadForkLive.pipe(Layer.provideMerge(ServerRuntimeStartupLive)),
  AutomationCentreLive.pipe(
    Layer.provideMerge(AgentControlActionValidatorLive),
    Layer.provideMerge(AgentControlProjectPlansLive),
    Layer.provideMerge(AgentControlWorkspacesLive),
  ),
  ServerRuntimeStartupLive,
  // Process-wide, so every WebSocket and relay connection shares one instance
  // (and one discovery cache) instead of building its own per connection.
  SourceControlDiscovery.layer,
  ProviderMaintenanceRunner.layer,
  // The node's own release and one-click update: one state for every connection, and the
  // boot report of an update that restarted this process.
  NodeUpdateServiceLive,
  ContextHandoffInspectionLive,
  AgentControlMcpServerLive.pipe(
    // HTML render tools exist only on the private listener; the external
    // endpoint below never sees this service.
    Layer.provide(HtmlRenderLive),
    Layer.provideMerge(AgentControlDiagnosticsServiceLive),
    Layer.provideMerge(AgentControlActionValidatorLive),
    Layer.provideMerge(AgentControlProjectPlansLive),
    Layer.provideMerge(AgentControlWorkspacesLive),
  ),
  AgentControlExternalMcpServerLive.pipe(
    Layer.provideMerge(AgentControlDiagnosticsServiceLive),
    Layer.provideMerge(AgentControlActionValidatorLive),
    Layer.provideMerge(AgentControlProjectPlansLive),
    Layer.provideMerge(AgentControlWorkspacesLive),
    Layer.provideMerge(
      AgentControlExternalTaskServiceLive.pipe(
        Layer.provideMerge(AgentControlActionValidatorLive),
        Layer.provideMerge(AgentControlProjectPlansLive),
        Layer.provideMerge(AgentControlWorkspacesLive),
      ),
    ),
  ),
  CompletionReturnDeliveryLive.pipe(
    Layer.provideMerge(ServerRuntimeStartupLive),
    Layer.provideMerge(OrchestrationCommandApplicationLive),
  ),
  UsageLimitRecoveryLive.pipe(
    Layer.provideMerge(ServerRuntimeStartupLive),
    Layer.provideMerge(OrchestrationCommandApplicationLive),
  ),
  AgentControlExecutionLive.pipe(
    Layer.provideMerge(ServerRuntimeStartupLive),
    Layer.provideMerge(AgentControlActionValidatorLive),
    Layer.provideMerge(AgentControlProjectPlansLive),
    Layer.provideMerge(AgentControlWorkspacesLive),
    Layer.provideMerge(OrchestrationCommandApplicationLive),
  ),
).pipe(
  // "No project" chat folders and the chats capability clients read from the server config.
  // Beneath the services so startup can clean up chats that never got a conversation.
  Layer.provideMerge(ChatFoldersLive),
  // The node's Tasks, beneath the services: the task RPCs and Agent Control (its tools, validator
  // and execution) share one instance, and with it one stream of task changes.
  Layer.provideMerge(LocalTaskServiceLive),
  // The chat fork ledger: read by the fork service and by startup's orphan-chat sweep.
  Layer.provideMerge(ThreadForkRepositoryLive),
  // One lifecycle authority for sidebar, Inbox, workspace management and Agent Control.
  Layer.provideMerge(WorkspaceLifecycleLive),
  // Delete dialog: what the work a checkout alone holds is about.
  Layer.provideMerge(WorkspaceChangeSummaryLive),
  Layer.provideMerge(RuntimeDependenciesLive),
  // One process-scoped manager is shared by control RPC, frame streaming,
  // provider tools, idle cleanup, and crash-recovery ownership.
  Layer.provideMerge(DeviceServiceLive),
);

const authRoutesLayer = Layer.mergeAll(
  authBearerBootstrapRouteLayer,
  authBearerRotateRouteLayer,
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
  desktopHubReachabilityRouteLayer,
).pipe(Layer.provide(browserApiCorsLayer));

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath({ inheritedFromDesktop: config.mode === "desktop" });

    // Built after `HttpRouter.serve` (see below), so the startup fiber only
    // logs readiness, publishes `ready` and opens the browser once request
    // handlers are attached.
    const httpServingLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        const port = boundTcpPort(server.address);
        if (port !== null) writeDesktopLifecycleFrame({ type: "http-serving", port });
        recordDesktopStartupPhase("http-serving");
        yield* startup.markHttpServing;
        // Process lock and key custody: built now that handlers are attached;
        // Hub routes wait for it rather than the whole server.
        yield* startHubConnectorAfterServe(config.hubConnector);
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
      httpServingLayer.pipe(
        Layer.provide(
          HttpRouter.serve(makeRoutesLayer, {
            disableLogger: !config.logWebSocketEvents,
          }).pipe(Layer.provideMerge(HubConnectorDeferredLive)),
        ),
      ),
      runtimeStateLayer,
      tailscaleServeLayer,
      SleepInhibitorLive,
    );

    // Shutdown runs these stages in reverse build order; the markers log how
    // long each took so slow finalizers can be attributed, after a line naming
    // the desktop app's loss when that is the cause. The startup stall
    // monitor is built before the HTTP bind and the runtime graph (migrations,
    // read model, provider hydration), so stalls in any of them are
    // attributed, but after observability so its warnings reach the server
    // log. The hydration layer provides the same value; memoization keeps it
    // to one monitor, owned here.
    const shutdownClock = makeShutdownClock();
    return DesktopParentLossShutdownLogLive.pipe(
      Layer.provideMerge(shutdownClock.marker("started")),
      Layer.provideMerge(serverApplicationLayer),
      Layer.provideMerge(shutdownClock.marker("http-drained")),
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(shutdownClock.marker("runtime-services-closed")),
      Layer.provideMerge(WorkspaceAccessPolicyLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provideMerge(StartupStallMonitorLive),
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
