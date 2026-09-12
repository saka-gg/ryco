import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DiagnosticsSnapshot,
  EnvironmentId,
  EventId,
  GitCommandError,
  KeybindingRule,
  MessageId,
  OpenError,
  type OrchestrationThreadShell,
  TerminalNotRunningError,
  TextGenerationError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ResolvedKeybindingRule,
  ThreadId,
  WorktreeId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import {
  Deferred,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  PubSub,
  Ref,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { vi } from "vite-plus/test";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

import type { ServerConfigShape } from "./config.ts";
import { deriveServerPaths, resolveManagedWorktreesRoot, ServerConfig } from "./config.ts";
import {
  ChatAttachmentUploads,
  type ChatAttachmentUploadsShape,
  ChatAttachmentUploadsLive,
  makeChatAttachmentUploads,
} from "./attachmentUpload.ts";
import { Diagnostics, type DiagnosticsShape } from "./diagnostics/Services/Diagnostics.ts";
import { makeRoutesLayer } from "./server.ts";
import * as WsTestClient from "./test/WsTestClient.ts";
import { ORCHESTRATION_LEGACY_REPLAY_MAX_EVENTS } from "./ws/context/constants.ts";
import { resolveStaticCacheControl } from "./http.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { attachmentRelativePath } from "./attachmentStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitManager, type GitManagerShape } from "./git/GitManager.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings.ts";
import { Open, type OpenShape } from "./open.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "./orchestration/Services/ThreadDeletionReactor.ts";
import { OrchestrationListenerCallbackError } from "./orchestration/Errors.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { StatisticsQuery, type StatisticsQueryShape } from "./statistics/StatisticsQuery.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import {
  ProjectionWorktreeRepository,
  type ProjectionWorktreeRepositoryShape,
} from "./persistence/Services/ProjectionWorktrees.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./provider/providerMaintenance.ts";
import { ServerLifecycleEvents, type ServerLifecycleEventsShape } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import {
  BrowserTraceCollector,
  type BrowserTraceCollectorShape,
} from "./observability/Services/BrowserTraceCollector.ts";
import { LocalDiagnosticsMetricsLive } from "./observability/Services/LocalDiagnosticsMetrics.ts";
import { AdvertisedEndpointRegistryLive } from "./remote/AdvertisedEndpointRegistry.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "./project/Services/ProjectSetupScriptRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "./project/Services/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "./project/Services/ProjectAvatarStore.ts";
import { makeDeviceServiceLayer } from "./device/Layers/DeviceService.ts";
import {
  ServerEnvironment,
  type ServerEnvironmentShape,
} from "./environment/Services/ServerEnvironment.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { WorkspaceAccessPolicyLayer } from "./workspace/Layers/WorkspaceAccessPolicy.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriver from "./vcs/VcsDriver.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import {
  AtlassianConnectionService,
  type AtlassianConnectionServiceShape,
} from "./atlassian/AtlassianConnectionService.ts";
import {
  JiraWorkItemService,
  type JiraWorkItemServiceShape,
} from "./atlassian/JiraWorkItemService.ts";
import { TextGeneration, type TextGenerationShape } from "./textGeneration/TextGeneration.ts";
import {
  HubConnectorService,
  type HubConnectorServiceShape,
} from "./hubConnector/HubConnectorLive.ts";
import {
  stubE2eeOperator,
  stubLocalIntroductionService,
  stubNativeNodeClaimService,
} from "./hubConnector/testUtils/e2eeOperatorStub.ts";

const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    threadSettlement: true,
    threadPriorityRanking: false,
  },
};

const makeDefaultDiagnosticsSnapshot = (): DiagnosticsSnapshot => {
  const now = new Date(0).toISOString();
  const resourceSample = {
    sampledAt: now,
    uptimeMs: 0,
    memory: {
      rssBytes: 0,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      arrayBuffersBytes: 0,
    },
    cpu: {
      userMicros: 0,
      systemMicros: 0,
      utilizationPercent: 0,
    },
    eventLoopDelayMs: 0,
  };
  return {
    generatedAt: now,
    serverStartedAt: now,
    uptimeMs: 0,
    limits: {
      traceRecordLimit: 0,
      resourceSampleLimit: 0,
      fileTailBytes: 0,
    },
    observability: {
      logsDirectoryPath: "/tmp/ryco-test/logs",
      serverLogPath: "/tmp/ryco-test/logs/server.log",
      serverTracePath: "/tmp/ryco-test/logs/server-trace.jsonl",
      providerEventLogPath: "/tmp/ryco-test/logs/provider/events.jsonl",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    resources: {
      current: resourceSample,
      history: [resourceSample],
    },
    liveProcesses: {
      server: {
        pid: process.pid,
        platform: process.platform,
        runtime: "bun",
        version: process.version,
        cwd: process.cwd(),
      },
      terminals: [],
      providers: [],
    },
    tracing: {
      retainedSpanCount: 0,
      recentSpans: [],
      slowestSpans: [],
      topSpanNames: [],
      durationBuckets: [],
      recentEvents: [],
    },
    failures: {
      latest: [],
      common: [],
    },
    client: {
      slowRpcAcks: [],
    },
    performance: {
      local: {
        turnQuiescenceAvgMs: null,
        checkpointDurationP95Ms: null,
        latestThreadSnapshotDurationMs: null,
        threadSnapshotDurationP95Ms: null,
        wsReconnectCount: 0,
        windowSampleCounts: {
          turnQuiescence: 0,
          checkpointDuration: 0,
          threadSnapshotDuration: 0,
        },
        capturedAt: now,
      },
      queues: {
        runtimeDepthTotal: 0,
        runtimeHighWaterMax: 0,
        replayDepthMax: 0,
        liveBufferDepthTotal: 0,
        liveBufferHighWaterMax: 0,
        liveBufferOverflowCount: 0,
        replayLagMax: 0,
        providerLogDroppedRecords: 0,
      },
      traceSink: null,
      snapshotCollectionDurationMs: 0,
    },
    warnings: [],
  };
};

const makeDefaultOrchestrationReadModel = () => {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

const makeDefaultOrchestrationThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => {
  const now = new Date().toISOString();
  return {
    id: defaultThreadId,
    projectId: defaultProjectId,
    title: "Default Thread",
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
};

const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const makeAuthTestLayer = () =>
  ServerAuthLive.pipe(Layer.provide(SqlitePersistenceMemory), Layer.provide(ServerSecretStoreLive));

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;
          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected TCP collector address"));
              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);
                      return;
                    }
                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    const runtime = ManagedRuntime.make(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "ryco-web",
          attributes: {
            "service.runtime": "ryco-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    );

    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void.pipe(Effect.withSpan(spanName))));
    } finally {
      yield* Effect.promise(() => runtime.dispose());
    }

    const request = yield* Effect.promise(() =>
      Promise.race([
        collector.firstRequest,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for OTLP trace export")), 1_000);
        }),
      ]),
    );

    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerRegistry?: Partial<ProviderRegistryShape>;
    serverSettings?: Partial<ServerSettingsShape>;
    open?: Partial<OpenShape>;
    vcsDriver?: Partial<VcsDriver.VcsDriverShape>;
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistryShape>;
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriverShape>;
    gitManager?: Partial<GitManagerShape>;
    sourceControlRepositoryService?: Partial<SourceControlRepositoryService.SourceControlRepositoryServiceShape>;
    vcsStatusBroadcaster?: Partial<VcsStatusBroadcaster.VcsStatusBroadcasterShape>;
    projectSetupScriptRunner?: Partial<ProjectSetupScriptRunnerShape>;
    terminalManager?: Partial<TerminalManagerShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    threadDeletionReactor?: Partial<ThreadDeletionReactorShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    statisticsQuery?: Partial<StatisticsQueryShape>;
    projectionWorktreeRepository?: Partial<ProjectionWorktreeRepositoryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    browserTraceCollector?: Partial<BrowserTraceCollectorShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
    serverEnvironment?: Partial<ServerEnvironmentShape>;
    repositoryIdentityResolver?: Partial<RepositoryIdentityResolverShape>;
    atlassianConnectionService?: Partial<AtlassianConnectionServiceShape>;
    jiraWorkItemService?: Partial<JiraWorkItemServiceShape>;
    textGeneration?: Partial<TextGenerationShape>;
    diagnostics?: Partial<DiagnosticsShape>;
    hubConnector?: Partial<HubConnectorServiceShape>;
    chatAttachmentUploads?: ChatAttachmentUploadsShape;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const config: ServerConfigShape = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "ryco-server",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...options?.config,
    };
    const layerConfig = Layer.succeed(ServerConfig, config);
    const defaultVcsDriver: VcsDriver.VcsDriverShape = {
      capabilities: {
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      },
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      detectRepository: () => Effect.succeed(null),
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      listRemotes: () =>
        Effect.succeed({
          remotes: [],
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      initRepository: () => Effect.void,
      ...options?.layers?.vcsDriver,
    };
    const vcsDriverRegistryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(defaultVcsDriver),
      detect: (input) =>
        defaultVcsDriver.detectRepository(input.cwd).pipe(
          Effect.flatMap((repository) =>
            repository
              ? Effect.succeed(repository)
              : defaultVcsDriver.isInsideWorkTree(input.cwd).pipe(
                  Effect.map((isInsideWorkTree) =>
                    isInsideWorkTree
                      ? {
                          kind: "git" as const,
                          rootPath: input.cwd,
                          metadataPath: null,
                          freshness: {
                            source: "live-local" as const,
                            observedAt: TEST_EPOCH,
                            expiresAt: Option.none(),
                          },
                        }
                      : null,
                  ),
                ),
          ),
          Effect.map((repository) =>
            repository
              ? ({
                  kind: repository.kind,
                  repository,
                  driver: defaultVcsDriver,
                } satisfies VcsDriverRegistry.VcsDriverHandle)
              : null,
          ),
        ),
      resolve: (input) =>
        Effect.succeed({
          kind:
            input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
          repository: {
            kind:
              input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
            rootPath: input.cwd,
            metadataPath: null,
            freshness: {
              source: "live-local",
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: defaultVcsDriver,
        }),
      ...options?.layers?.vcsDriverRegistry,
    });
    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      ...options?.layers?.gitVcsDriver,
    });
    const gitManagerLayer = Layer.mock(GitManager)({
      ...options?.layers?.gitManager,
    });
    const workspaceEntriesLayer = WorkspaceEntriesLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provide(WorkspaceAccessPolicyLayer(config.workspaceAccessRoot)),
      Layer.provideMerge(vcsDriverRegistryLayer),
    );
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspaceAccessPolicyLayer(config.workspaceAccessRoot),
      WorkspacePathsLive,
      workspaceEntriesLayer,
      WorkspaceFileSystemLive.pipe(
        Layer.provide(WorkspacePathsLive),
        Layer.provide(workspaceEntriesLayer),
      ),
      ProjectFaviconResolverLive,
    );
    const gitWorkflowLayer = GitWorkflowService.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitVcsDriverLayer),
      Layer.provideMerge(gitManagerLayer),
    );
    const vcsProvisioningLayer = VcsProvisioningService.layer.pipe(
      Layer.provide(vcsDriverRegistryLayer),
    );
    const vcsStatusBroadcasterLayer = options?.layers?.vcsStatusBroadcaster
      ? Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          ...options.layers.vcsStatusBroadcaster,
        })
      : VcsStatusBroadcaster.layer.pipe(Layer.provide(gitWorkflowLayer));

    const servedRoutesLayer = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HubConnectorService, {
            status: () => ({
              state: "disabled",
              transitionedAt: TEST_EPOCH.toString(),
              activeChannels: 0,
              queuedBytes: 0,
            }),
            resume: async () => undefined,
            enroll: async () => {
              throw new Error("not implemented in test");
            },
            identitySummary: async () => ({ enrolled: "none" as const }),
            leave: async () => ({
              state: "disabled" as const,
              transitionedAt: "1970-01-01T00:00:00.000Z",
              activeChannels: 0,
              queuedBytes: 0,
            }),
            readEnrollment: async () => null,
            cancelEnrollment: async () => {
              throw new Error("not implemented in test");
            },
            stop: async () => undefined,
            localIntroduction: stubLocalIntroductionService(),
            nativeNodeClaim: stubNativeNodeClaimService(),
            e2ee: stubE2eeOperator(),
            ...options?.layers?.hubConnector,
          }),
          Layer.mock(Keybindings)({
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
            ...options?.layers?.keybindings,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
          revalidateStale: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
          getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
            ),
          setProviderMaintenanceActionState: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          ...options?.layers?.providerRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mock(Open)({
          ...options?.layers?.open,
        }),
      ),
      Layer.provide(gitManagerLayer),
      Layer.provide(gitVcsDriverLayer),
      Layer.provide(gitWorkflowLayer),
      Layer.provide(vcsProvisioningLayer),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          ...options?.layers?.sourceControlRepositoryService,
        }),
      ),
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          get: () => Effect.die("not implemented in test"),
          detectProviderFromRemoteUrl: () => null,
          resolveHandle: () => Effect.die("not implemented in test"),
          resolve: () => Effect.die("not implemented in test"),
          discover: Effect.die("not implemented in test"),
        }),
      ),
      Layer.provide(
        Layer.mock(AtlassianConnectionService)({
          listConnections: Effect.succeed([]),
          startOAuth: () => Effect.die("not implemented in test"),
          saveManualBitbucketToken: () => Effect.die("not implemented in test"),
          saveManualJiraToken: () => Effect.die("not implemented in test"),
          disconnect: () => Effect.void,
          refresh: () => Effect.die("not implemented in test"),
          listResources: () => Effect.succeed([]),
          getProjectLink: () => Effect.succeed(null),
          saveProjectLink: () => Effect.die("not implemented in test"),
          ...options?.layers?.atlassianConnectionService,
        }),
      ),
      Layer.provide(
        Layer.mock(JiraWorkItemService)({
          listProjects: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
          search: () => Effect.succeed([]),
          get: () => Effect.die("not implemented in test"),
          addComment: () => Effect.die("not implemented in test"),
          editComment: () => Effect.die("not implemented in test"),
          update: () => Effect.die("not implemented in test"),
          listTransitions: () => Effect.succeed([]),
          transition: () => Effect.die("not implemented in test"),
          ...options?.layers?.jiraWorkItemService,
        }),
      ),
      Layer.provide(
        Layer.mock(TextGeneration)({
          generateCommitMessage: () => Effect.die("not implemented in test"),
          generatePrContent: () => Effect.die("not implemented in test"),
          generateBranchName: () => Effect.die("not implemented in test"),
          generateThreadTitle: () => Effect.die("not implemented in test"),
          generateIssueContent: () => Effect.die("not implemented in test"),
          ...options?.layers?.textGeneration,
        }),
      ),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager)({
          listDiagnostics: Effect.succeed([]),
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            readEventsPage: (fromSequenceExclusive) =>
              Effect.succeed({
                events: [],
                nextSequence: fromSequenceExclusive,
                hasMore: false,
              }),
            dispatch: () => Effect.succeed({ sequence: 0 }),
            streamDomainEvents: Stream.empty,
            subscribeDomainEvents: Effect.gen(function* () {
              const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
              return yield* PubSub.subscribe(pubsub);
            }),
            ...options?.layers?.orchestrationEngine,
          }),
          Layer.mock(ThreadDeletionReactor)({
            start: () => Effect.void,
            drainThrough: () => Effect.void,
            ...options?.layers?.threadDeletionReactor,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getCommandReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
            getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: [],
                updatedAt: new Date(0).toISOString(),
              }),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            searchThreadMessages: () => Effect.succeed([]),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getThreadCheckpointContext: () => Effect.succeed(Option.none()),
            ...options?.layers?.projectionSnapshotQuery,
          }),
          Layer.mock(StatisticsQuery)({
            getStatistics: () =>
              Effect.succeed({
                generatedAt: new Date(0).toISOString(),
                projects: [],
                models: [],
                dailyBuckets: [],
                worktrees: { created: 0, archived: 0, active: 0, openPrs: 0 },
                totals: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  totalTokens: 0,
                  turns: 0,
                  activeMs: 0,
                  toolUses: 0,
                  filesChanged: 0,
                  additions: 0,
                  deletions: 0,
                  commits: 0,
                  pushes: 0,
                  threads: 0,
                  projects: 0,
                },
                tokenAttribution: "per-turn-delta",
                recentPullRequests: [],
              }),
            ...options?.layers?.statisticsQuery,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProjectionWorktreeRepository)({
          upsert: () => Effect.void,
          getById: () => Effect.succeed(Option.none()),
          listByProjectId: () => Effect.succeed([]),
          findByOrigin: () => Effect.succeed(null),
          findByWorkItem: () => Effect.succeed(null),
          findActiveByLinkedNumber: () => Effect.succeed([]),
          markArchived: () => Effect.void,
          markRestored: () => Effect.void,
          updateMeta: () => Effect.void,
          deleteById: () => Effect.void,
          setManualPosition: () => Effect.void,
          ...options?.layers?.projectionWorktreeRepository,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
    );

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(
        Layer.mock(BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provide(
        Layer.mock(Diagnostics)({
          recordTraceRecords: () => undefined,
          getSnapshot: () => Effect.succeed(makeDefaultDiagnosticsSnapshot()),
          ...options?.layers?.diagnostics,
        }),
      ),
      Layer.provide(
        Layer.succeed(ProjectAvatarStore, {
          write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
          read: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      ),
      options?.layers?.chatAttachmentUploads
        ? Layer.provide(Layer.succeed(ChatAttachmentUploads, options.layers.chatAttachmentUploads))
        : Layer.provideMerge(ChatAttachmentUploadsLive),
      Layer.provideMerge(makeAuthTestLayer()),
      Layer.provideMerge(LocalDiagnosticsMetricsLive),
      Layer.provideMerge(AdvertisedEndpointRegistryLive),
      // Keep generic server tests off real SDKs and persistent boot ownership.
      Layer.provide(makeDeviceServiceLayer({ platform: "freebsd" })),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly origin: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const hashParams = new URLSearchParams(next.hash.startsWith("#") ? next.hash.slice(1) : "");
  const cookie = hashParams.get("cookie");
  const origin = hashParams.get("origin");
  next.hash = "";
  return {
    cookie,
    origin,
    url: next.toString(),
  };
};

const wsRpcProtocolLayer = (wsUrl: string) => {
  const { cookie, origin, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols,
        cookie || origin
          ? {
              headers: {
                ...(cookie ? { cookie } : {}),
                ...(origin ? { origin } : {}),
              },
            }
          : undefined,
      ) as unknown as globalThis.WebSocket,
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

const appendOriginToWsUrl = (url: string, origin: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  const hashParams = new URLSearchParams(next.hash.startsWith("#") ? next.hash.slice(1) : "");
  hashParams.set("origin", origin);
  next.hash = hashParams.toString();
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/bootstrap");
    const response = yield* Effect.promise(() =>
      fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...options?.headers,
        },
        body: JSON.stringify({
          credential,
        }),
      }),
    );
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
    };
    return {
      response,
      body,
      cookie: response.headers.get("set-cookie"),
    };
  });

const bootstrapBearerSession = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/bootstrap/bearer");
    const response = yield* Effect.promise(() =>
      fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          credential,
        }),
      }),
    );
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
      readonly sessionToken?: string;
      readonly error?: string;
    };
    return {
      response,
      body,
    };
  });

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, cookie } = yield* bootstrapBrowserSession(credential);
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected bootstrap session response to succeed, got ${response.status}`),
      );
    }

    if (!cookie) {
      return yield* Effect.fail(new Error("Expected bootstrap session response to set a cookie."));
    }

    return cookie.split(";")[0] ?? cookie;
  });

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* bootstrapBearerSession(credential);
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected bearer bootstrap response to succeed, got ${response.status}`),
      );
    }

    if (!body.sessionToken) {
      return yield* Effect.fail(
        new Error("Expected bearer bootstrap response to include a session token."),
      );
    }

    return body.sessionToken;
  });

const getAuthenticatedWebSocketToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
    const cookie = yield* getAuthenticatedSessionCookieHeader(credential);
    const response = yield* Effect.promise(() =>
      fetch(wsTokenUrl, {
        method: "POST",
        headers: {
          cookie,
        },
      }),
    );
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected websocket token response to succeed, got ${response.status}`),
      );
    }
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly token?: string;
    };
    if (!body.token) {
      return yield* Effect.fail(new Error("Expected websocket token response to include a token."));
    }
    return body.token;
  });

const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

const splitHeaderTokens = (value: string | null) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

const getWsServerUrl = (
  pathname = "",
  options?: { authenticated?: boolean; credential?: string },
) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const baseUrl = `ws://127.0.0.1:${address.port}${pathname}`;
    if (options?.authenticated === false) {
      return baseUrl;
    }
    const next = new URL(baseUrl);
    next.searchParams.set("wsToken", yield* getAuthenticatedWebSocketToken(options?.credential));
    return next.toString();
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("classifies static cache-control headers", () =>
    Effect.sync(() => {
      assert.equal(resolveStaticCacheControl("index.html"), "no-cache");
      assert.equal(
        resolveStaticCacheControl("assets/index-CkG8a2ff.js"),
        "public, max-age=31536000, immutable",
      );
      assert.equal(resolveStaticCacheControl("favicon.svg"), "no-cache");
    }),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-router-static-",
      });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-cache");
      assert.include(yield* response.text, "router-static-ok");
      const etag = response.headers.etag;
      assert.isDefined(etag);
      const cached = yield* HttpClient.get("/", { headers: { "if-none-match": etag! } });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.etag, etag);
      assert.equal(yield* cached.text, "");
      yield* fileSystem.writeFileString(indexPath, "<html>updated router content</html>");
      const updated = yield* HttpClient.get("/", { headers: { "if-none-match": etag! } });
      assert.equal(updated.status, 200);
      assert.notEqual(updated.headers.etag, etag);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves hashed static assets with immutable cache headers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-router-static-",
      });
      const assetsDir = path.join(staticDir, "assets");
      yield* fileSystem.makeDirectory(assetsDir);
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "<html></html>");
      yield* fileSystem.writeFileString(path.join(assetsDir, "index-CkG8a2ff.js"), "ok");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/assets/index-CkG8a2ff.js");
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
      assert.equal(yield* response.text, "ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(
        response.headers.get("location"),
        "http://127.0.0.1:5173/foo/bar?token=test-token",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves project favicon requests before the dev URL redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-router-project-favicon-",
      });
      yield* fileSystem.writeFileString(
        path.join(projectDir, "favicon.svg"),
        "<svg>router-project-favicon</svg>",
      );

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "private, max-age=3600");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.include(response.headers["content-security-policy"] ?? "", "sandbox");
      assert.equal(yield* response.text, "<svg>router-project-favicon</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the fallback project favicon when no icon exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-router-project-favicon-fallback-",
      });

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "private, max-age=3600");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.include(response.headers["content-security-policy"] ?? "", "sandbox");
      assert.include(yield* response.text, 'data-fallback="project-favicon"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the public environment descriptor without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/ryco/environment");
      const response = yield* Effect.promise(() => fetch(url));
      const body = (yield* Effect.promise(() =>
        response.json(),
      )) as typeof testEnvironmentDescriptor;

      assert.equal(response.status, 200);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports unauthenticated session state without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* Effect.promise(() => fetch(url));
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly authenticated: boolean;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
          readonly sessionMethods: ReadonlyArray<string>;
          readonly sessionCookieName: string;
        };
      };

      assert.equal(response.status, 200);
      assert.equal(body.authenticated, false);
      assert.equal(body.auth.policy, "desktop-managed-local");
      assert.deepEqual(body.auth.bootstrapMethods, ["desktop-bootstrap"]);
      assert.deepEqual(body.auth.sessionMethods, [
        "browser-session-cookie",
        "bearer-session-token",
      ]);
      assert.isTrue(body.auth.sessionCookieName.startsWith("ryco_session_"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("bootstraps a browser session and authenticates the session endpoint via cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const {
        response: bootstrapResponse,
        body: bootstrapBody,
        cookie: setCookie,
      } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.authenticated, true);
      assert.equal(bootstrapBody.sessionMethod, "browser-session-cookie");
      assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken);
      assert.isDefined(setCookie);

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* Effect.promise(() =>
        fetch(sessionUrl, {
          headers: {
            cookie: setCookie?.split(";")[0] ?? "",
          },
        }),
      );
      const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      };

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps a bearer session and authenticates the session endpoint via authorization header",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { response: bootstrapResponse, body: bootstrapBody } =
          yield* bootstrapBearerSession();

        assert.equal(bootstrapResponse.status, 200);
        assert.equal(bootstrapBody.authenticated, true);
        assert.equal(bootstrapBody.sessionMethod, "bearer-session-token");
        assert.equal(typeof bootstrapBody.sessionToken, "string");
        assert.isTrue((bootstrapBody.sessionToken?.length ?? 0) > 0);

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const sessionResponse = yield* Effect.promise(() =>
          fetch(sessionUrl, {
            headers: {
              authorization: `Bearer ${bootstrapBody.sessionToken ?? ""}`,
            },
          }),
        );
        const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
        };

        assert.equal(sessionResponse.status, 200);
        assert.equal(sessionBody.authenticated, true);
        assert.equal(sessionBody.sessionMethod, "bearer-session-token");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps Hub status and enrollment controls on the authenticated local listener", () =>
    Effect.gen(function* () {
      let enrollCalls = 0;
      let cancelCalls = 0;
      const status = {
        state: "awaiting_approval" as const,
        transitionedAt: "1970-01-01T00:00:00.000Z",
        activeChannels: 0,
        queuedBytes: 0,
      };
      yield* buildAppUnderTest({
        layers: {
          hubConnector: {
            status: () => status,
            enroll: async () => {
              enrollCalls += 1;
              return {
                status,
                deviceCode: "ABCD-EFGH",
                fingerprint: `SHA256:${"A".repeat(43)}`,
                label: "Test Node",
                platformOs: "darwin" as const,
                platformArch: "arm64" as const,
                clientVersion: "0.0.0",
                algorithm: "ed25519" as const,
                expiresAt: "1970-01-01T00:10:00.000Z",
                pollIntervalMs: 5_000,
              };
            },
            identitySummary: async () => ({ enrolled: "none" as const }),
            leave: async () => ({
              state: "disabled" as const,
              transitionedAt: "1970-01-01T00:00:00.000Z",
              activeChannels: 0,
              queuedBytes: 0,
            }),
            readEnrollment: async () => null,
            cancelEnrollment: async () => {
              cancelCalls += 1;
              return { ...status, state: "enrolling" as const };
            },
          },
        },
      });

      const statusUrl = yield* getHttpServerUrl("/api/hub/status");
      const enrollmentUrl = yield* getHttpServerUrl("/api/hub/enrollment");
      const cancellationUrl = yield* getHttpServerUrl("/api/hub/enrollment/cancel");
      const unauthorized = yield* Effect.promise(() => fetch(statusUrl));
      assert.equal(unauthorized.status, 401);

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const authorization = `Bearer ${bearerToken}`;
      const statusResponse = yield* Effect.promise(() =>
        fetch(statusUrl, {
          headers: { authorization },
        }),
      );
      assert.equal(statusResponse.status, 200);
      assert.deepEqual(yield* Effect.promise(() => statusResponse.json()), status);

      const enrollmentResponse = yield* Effect.promise(() =>
        fetch(enrollmentUrl, {
          method: "POST",
          headers: { authorization },
        }),
      );
      const enrollmentBody = (yield* Effect.promise(() => enrollmentResponse.json())) as {
        readonly deviceCode?: string;
        readonly fingerprint?: string;
      };
      assert.equal(enrollmentResponse.status, 201);
      assert.equal(enrollmentBody.deviceCode, "ABCD-EFGH");
      assert.equal(enrollmentBody.fingerprint, `SHA256:${"A".repeat(43)}`);
      assert.notProperty(enrollmentBody, "publicKey");
      assert.notProperty(enrollmentBody, "pollingSecret");
      assert.equal(enrollCalls, 1);

      const cancelResponse = yield* Effect.promise(() =>
        fetch(cancellationUrl, {
          method: "POST",
          headers: { authorization },
        }),
      );
      assert.equal(cancelResponse.status, 200);
      assert.equal(cancelCalls, 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues short-lived websocket tokens for authenticated bearer sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
      const wsTokenResponse = yield* Effect.promise(() =>
        fetch(wsTokenUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
        }),
      );
      const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
        readonly token: string;
        readonly expiresAt: string;
      };

      assert.equal(wsTokenResponse.status, 200);
      assert.equal(typeof wsTokenBody.token, "string");
      assert.isTrue(wsTokenBody.token.length > 0);
      assert.equal(typeof wsTokenBody.expiresAt, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "responds to remote auth websocket-token preflight requests with authorization CORS headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
        const response = yield* Effect.promise(() =>
          fetch(wsTokenUrl, {
            method: "OPTIONS",
            headers: {
              origin: "http://192.168.86.35:3773",
              "access-control-request-method": "POST",
              "access-control-request-headers": "authorization",
            },
          }),
        );

        assert.equal(response.status, 204);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-methods")), [
          "GET",
          "OPTIONS",
          "POST",
        ]);
        assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-headers")), [
          "authorization",
          "b3",
          "content-type",
          "traceparent",
        ]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote websocket-token auth failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
      const response = yield* Effect.promise(() =>
        fetch(wsTokenUrl, {
          method: "POST",
          headers: {
            origin: "http://192.168.86.35:3773",
          },
        }),
      );
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly error?: string;
      };

      assert.equal(response.status, 401);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(body.error, "Authentication required.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues authenticated one-time pairing credentials for additional clients", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly expiresAt: string;
      };

      assert.equal(response.status, 200);
      assert.equal(typeof body.credential, "string");
      assert.isTrue(body.credential.length > 0);
      assert.equal(typeof body.expiresAt, "string");

      const bootstrapResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(bootstrapResult.response.status, 200);

      const reusedResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(reusedResult.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects unauthenticated pairing credential requests", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token");
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists and revokes pairing links for owner sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const createdBody = (yield* createdResponse.json) as {
        readonly id: string;
        readonly credential: string;
      };

      const listResponse = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const listedLinks = (yield* listResponse.json) as ReadonlyArray<{
        readonly id: string;
        readonly credential: string;
      }>;

      const revokeUrl = yield* getHttpServerUrl("/api/auth/pairing-links/revoke");
      const revokeResponse = yield* Effect.promise(() =>
        fetch(revokeUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: createdBody.id }),
        }),
      );
      const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential);

      assert.equal(createdResponse.status, 200);
      assert.equal(listResponse.status, 200);
      assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id));
      assert.equal(revokeResponse.status, 200);
      assert.equal(revokedBootstrap.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credential requests from non-owner paired sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const ownerBody = (yield* ownerResponse.json) as {
        readonly credential: string;
      };
      assert.equal(ownerResponse.status, 200);

      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(ownerBody.credential);
      const pairedResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
      });
      const pairedBody = (yield* pairedResponse.json) as {
        readonly error: string;
      };

      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody.error, "Only owner sessions can create pairing credentials.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists paired clients and revokes other sessions while keeping the owner", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const ownerPairingResponse = yield* Effect.promise(() =>
        fetch(pairingTokenUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "Julius iPhone",
          }),
        }),
      );
      const ownerPairingBody = (yield* Effect.promise(() => ownerPairingResponse.json())) as {
        readonly credential: string;
        readonly label?: string;
      };
      assert.equal(ownerPairingResponse.status, 200);
      const pairedSessionBootstrap = yield* bootstrapBrowserSession(ownerPairingBody.credential, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        },
      });
      const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(";")[0];
      assert.isDefined(pairedSessionCookie);

      const pairedSessionCookieHeader = pairedSessionCookie ?? "";
      const listClientsUrl = yield* getHttpServerUrl("/api/auth/clients");
      const listBeforeResponse = yield* Effect.promise(() =>
        fetch(listClientsUrl, {
          headers: {
            cookie: ownerCookie,
          },
        }),
      );
      const clientsBefore = (yield* Effect.promise(() =>
        listBeforeResponse.json(),
      )) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly browser?: string;
        };
      }>;
      const pairedClientBefore = clientsBefore.find((entry) => !entry.current);
      const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId;

      const revokeOthersResponse = yield* HttpClient.post("/api/auth/clients/revoke-others", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const revokeOthersBody = (yield* revokeOthersResponse.json) as {
        readonly revokedCount: number;
      };

      const listAfterResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsAfter = (yield* listAfterResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;

      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookieHeader,
        },
      });
      const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
        readonly error: string;
      };

      assert.equal(listBeforeResponse.status, 200);
      assert.equal(ownerPairingBody.label, "Julius iPhone");
      assert.lengthOf(clientsBefore, 2);
      assert.isDefined(pairedSessionId);
      assert.isDefined(pairedClientBefore);
      assert.deepInclude(pairedClientBefore?.client, {
        label: "Julius iPhone",
        deviceType: "mobile",
        os: "iOS",
        browser: "Safari",
        ipAddress: "127.0.0.1",
      });
      assert.equal(revokeOthersResponse.status, 200);
      assert.equal(revokeOthersBody.revokedCount, 1);
      assert.equal(listAfterResponse.status, 200);
      assert.lengthOf(clientsAfter, 1);
      assert.equal(clientsAfter[0]?.current, true);
      assert.equal(pairedClientPairingResponse.status, 401);
      assert.equal(pairedClientPairingBody.error, "Unauthorized request.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revokes an individual paired client session", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };
      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
        pairingBody.credential,
      );

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;
      const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId;
      assert.isDefined(pairedSessionId);

      const revokeUrl = yield* getHttpServerUrl("/api/auth/clients/revoke");
      const revokeResponse = yield* Effect.promise(() =>
        fetch(revokeUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionId: pairedSessionId }),
        }),
      );
      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
      });

      assert.equal(revokeResponse.status, 200);
      assert.equal(pairedClientPairingResponse.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects reusing the same bootstrap credential after it has been exchanged", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const first = yield* bootstrapBrowserSession();
      const second = yield* bootstrapBrowserSession();

      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 401);
      assert.equal(
        (second.body as { readonly error?: string }).error,
        "Invalid bootstrap credential.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "does not accept session tokens via query parameters on authenticated HTTP routes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const projectDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "ryco-router-project-favicon-query-token-",
        });

        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");

        const response = yield* HttpClient.get(
          `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}&token=${encodeURIComponent(sessionToken)}`,
        );

        assert.equal(response.status, 401);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake with only a bootstrapped browser session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.isDefined(cookie);

      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const error = yield* Effect.flip(
        Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
      );

      assert.equal(error._tag, "RpcClientError");
      assertInclude(String(error), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects websocket rpc handshake when a session token is only provided via query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?token=${encodeURIComponent(sessionToken)}`;

        const error = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        );

        assert.equal(error._tag, "RpcClientError");
        assertInclude(String(error), "SocketOpenError");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "accepts websocket rpc handshake with a dedicated websocket token in the query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const bearerToken = yield* getAuthenticatedBearerSessionToken();
        const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
        const wsTokenResponse = yield* Effect.promise(() =>
          fetch(wsTokenUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearerToken}`,
            },
          }),
        );
        const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
          readonly token: string;
        };
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsToken=${encodeURIComponent(wsTokenBody.token)}`;

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(response.auth.policy, "desktop-managed-local");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake from unexpected browser origins", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = appendOriginToWsUrl(yield* getWsServerUrl("/ws"), "https://evil.example");
      const error = yield* Effect.flip(
        Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
      );

      assert.equal(error._tag, "RpcClientError");
      assertInclude(String(error), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake from same host origins on a different port", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = appendOriginToWsUrl(yield* getWsServerUrl("/ws"), "http://127.0.0.1");
      const error = yield* Effect.flip(
        Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
      );

      assert.equal(error._tag, "RpcClientError");
      assertInclude(String(error), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake from the same browser origin", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const origin = yield* getHttpServerUrl("");
      const wsUrl = appendOriginToWsUrl(yield* getWsServerUrl("/ws"), origin);
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`, {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "private, max-age=3600");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["content-type"], "application/octet-stream");
      assert.include(response.headers["content-disposition"] ?? "", "attachment");
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files for URL-encoded paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: "thread%20folder/message%20folder/file%20name.png",
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-encoded-ok");

      const response = yield* HttpClient.get(
        "/attachments/thread%20folder/message%20folder/file%20name.png",
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "private, max-age=3600");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(yield* response.text, "attachment-encoded-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  const makeUploadTestContext = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-upload-test-" });
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined).pipe(
      Effect.provide(NodeServices.layer),
    );
    yield* fileSystem.makeDirectory(derivedPaths.attachmentsDir, { recursive: true });
    const uploads = yield* makeChatAttachmentUploads({
      attachmentsDir: derivedPaths.attachmentsDir,
    }).pipe(Effect.provide(NodeServices.layer));
    const config = yield* buildAppUnderTest({
      config: { baseDir },
      layers: { chatAttachmentUploads: uploads },
    });
    return { config, uploads };
  });

  const postAttachmentUpload = (input: {
    readonly uploadToken: string;
    readonly cookie: string;
    readonly body?: HttpBody.HttpBody;
  }) =>
    HttpClient.post(`/attachments/upload?token=${encodeURIComponent(input.uploadToken)}`, {
      headers: {
        cookie: input.cookie,
        "content-type": "application/octet-stream",
      },
      ...(input.body ? { body: input.body } : {}),
    });

  it.effect("streams a chat file upload to disk and serves it back", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { config, uploads } = yield* makeUploadTestContext;
      const created = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      });
      const cookie = yield* getAuthenticatedSessionCookieHeader();

      const response = yield* postAttachmentUpload({
        uploadToken: created.uploadToken,
        cookie,
        body: HttpBody.uint8Array(new TextEncoder().encode("abc")),
      });
      assert.equal(response.status, 200);
      const payload = (yield* response.json) as {
        readonly attachmentTokenRef: string;
        readonly id: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
      };
      assert.equal(payload.attachmentTokenRef, created.uploadToken);
      assert.equal(payload.name, "notes.txt");
      assert.equal(payload.mimeType, "text/plain");
      assert.equal(payload.sizeBytes, 3);
      assert.isTrue(payload.id.endsWith("-txt"));

      const finalPath = `${config.attachmentsDir}/${payload.id}`;
      assert.equal(yield* fileSystem.readFileString(finalPath), "abc");
      assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), [payload.id]);
      assert.equal(
        attachmentRelativePath({
          type: "file",
          id: payload.id,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        }),
        payload.id,
      );

      const getResponse = yield* HttpClient.get(`/attachments/${payload.id}`, {
        headers: { cookie },
      });
      assert.equal(getResponse.status, 200);
      assert.equal(getResponse.headers["content-type"], "application/octet-stream");
      assert.include(getResponse.headers["content-disposition"] ?? "", "attachment");
      assert.equal(yield* getResponse.text, "abc");

      const reuseResponse = yield* postAttachmentUpload({
        uploadToken: created.uploadToken,
        cookie,
        body: HttpBody.uint8Array(new TextEncoder().encode("abc")),
      });
      assert.equal(reuseResponse.status, 409);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves streamed videos with their media type and seekable byte ranges", () =>
    Effect.gen(function* () {
      const { uploads } = yield* makeUploadTestContext;
      const created = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 10,
      });
      const cookie = yield* getAuthenticatedSessionCookieHeader();
      const response = yield* postAttachmentUpload({
        uploadToken: created.uploadToken,
        cookie,
        body: HttpBody.uint8Array(new TextEncoder().encode("0123456789")),
      });
      assert.equal(response.status, 200);
      const payload = (yield* response.json) as { id: string };
      const url = `/attachments/${payload.id}`;
      const full = yield* HttpClient.get(url, { headers: { cookie } });
      assert.equal(full.status, 200);
      assert.equal(full.headers["content-type"], "video/mp4");
      assert.equal(full.headers["content-disposition"], undefined);
      assert.equal(full.headers["accept-ranges"], "bytes");
      assert.equal(yield* full.text, "0123456789");
      for (const [range, contentRange, body] of [
        ["bytes=0-1", "bytes 0-1/10", "01"],
        ["bytes=7-", "bytes 7-9/10", "789"],
        ["bytes=-3", "bytes 7-9/10", "789"],
        ["bytes=8-100", "bytes 8-9/10", "89"],
      ]) {
        const partial = yield* HttpClient.get(url, { headers: { cookie, range: range! } });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers["content-range"], contentRange);
        assert.equal(partial.headers["content-type"], "video/mp4");
        assert.equal(yield* partial.text, body);
      }
      for (const range of ["bytes=10-", "bytes=-0", "bytes=5-3"]) {
        const invalid = yield* HttpClient.get(url, { headers: { cookie, range } });
        assert.equal(invalid.status, 416);
        assert.equal(invalid.headers["content-range"], "bytes */10");
      }
      const conditional = yield* HttpClient.get(url, {
        headers: { cookie, range: "bytes=0-1", "if-range": '"old-version"' },
      });
      assert.equal(conditional.status, 200);
      assert.equal(yield* conditional.text, "0123456789");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves audio attachments with native playback MIME and seekable byte ranges", () =>
    Effect.gen(function* () {
      const { uploads } = yield* makeUploadTestContext;
      const created = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "voice.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 10,
      });
      const cookie = yield* getAuthenticatedSessionCookieHeader();
      const response = yield* postAttachmentUpload({
        uploadToken: created.uploadToken,
        cookie,
        body: HttpBody.uint8Array(new TextEncoder().encode("0123456789")),
      });
      assert.equal(response.status, 200);
      const payload = (yield* response.json) as { id: string };
      const url = `/attachments/${payload.id}`;
      const full = yield* HttpClient.get(url, { headers: { cookie } });
      assert.equal(full.status, 200);
      assert.equal(full.headers["content-type"], "audio/mpeg");
      assert.equal(full.headers["content-disposition"], undefined);
      assert.equal(full.headers["accept-ranges"], "bytes");
      assert.equal(yield* full.text, "0123456789");
      const download = yield* HttpClient.get(`${url}?download=Narration.mp3`, {
        headers: { cookie },
      });
      assert.equal(download.headers["content-disposition"], 'attachment; filename="Narration.mp3"');
      assert.equal(
        (yield* HttpClient.get(`${url}?download=..%2Fsecret`, { headers: { cookie } })).status,
        400,
      );
      for (const [range, contentRange, body] of [
        ["bytes=0-1", "bytes 0-1/10", "01"],
        ["bytes=7-", "bytes 7-9/10", "789"],
        ["bytes=-3", "bytes 7-9/10", "789"],
        ["bytes=8-100", "bytes 8-9/10", "89"],
      ]) {
        const partial = yield* HttpClient.get(url, { headers: { cookie, range: range! } });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers["content-range"], contentRange);
        assert.equal(partial.headers["content-type"], "audio/mpeg");
        assert.equal(yield* partial.text, body);
      }
      for (const range of ["bytes=10-", "bytes=-0", "bytes=5-3"]) {
        const invalid = yield* HttpClient.get(url, { headers: { cookie, range } });
        assert.equal(invalid.status, 416);
        assert.equal(invalid.headers["content-range"], "bytes */10");
      }
      const conditional = yield* HttpClient.get(url, {
        headers: { cookie, range: "bytes=0-1", "if-range": '"old-version"' },
      });
      assert.equal(conditional.status, 200);
      assert.equal(yield* conditional.text, "0123456789");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports probed media dimensions on upload and attachment GET", () =>
    Effect.gen(function* () {
      const { uploads } = yield* makeUploadTestContext;
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const created = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "tiny.png",
        mimeType: "image/png",
        sizeBytes: pngBytes.byteLength,
      });
      const cookie = yield* getAuthenticatedSessionCookieHeader();

      const response = yield* postAttachmentUpload({
        uploadToken: created.uploadToken,
        cookie,
        body: HttpBody.uint8Array(new Uint8Array(pngBytes)),
      });
      assert.equal(response.status, 200);
      const payload = (yield* response.json) as {
        readonly id: string;
        readonly width?: number;
        readonly height?: number;
      };
      assert.equal(payload.width, 1);
      assert.equal(payload.height, 1);

      const getResponse = yield* HttpClient.get(`/attachments/${payload.id}`, {
        headers: { cookie },
      });
      assert.equal(getResponse.status, 200);
      assert.equal(getResponse.headers["x-attachment-width"], "1");
      assert.equal(getResponse.headers["x-attachment-height"], "1");
      assert.equal(getResponse.headers["x-attachment-width"], String(payload.width));
      assert.equal(getResponse.headers["x-attachment-height"], String(payload.height));

      const textUpload = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      });
      const textResponse = yield* postAttachmentUpload({
        uploadToken: textUpload.uploadToken,
        cookie,
        body: HttpBody.uint8Array(new TextEncoder().encode("abc")),
      });
      assert.equal(textResponse.status, 200);
      const textPayload = (yield* textResponse.json) as {
        readonly id: string;
        readonly width?: number;
        readonly height?: number;
      };
      assert.isUndefined(textPayload.width);
      assert.isUndefined(textPayload.height);

      const textGetResponse = yield* HttpClient.get(`/attachments/${textPayload.id}`, {
        headers: { cookie },
      });
      assert.equal(textGetResponse.status, 200);
      assert.isUndefined(textGetResponse.headers["x-attachment-width"]);
      assert.isUndefined(textGetResponse.headers["x-attachment-height"]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects oversized uploads and removes the staging file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { config, uploads } = yield* makeUploadTestContext;
      const created = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "big.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      });
      const cookie = yield* getAuthenticatedSessionCookieHeader();

      const response = yield* postAttachmentUpload({
        uploadToken: created.uploadToken,
        cookie,
        body: HttpBody.uint8Array(new TextEncoder().encode("0123456789")),
      });
      assert.equal(response.status, 413);
      assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects unknown upload tokens without staging a file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { config, uploads } = yield* makeUploadTestContext;
      yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      });
      const cookie = yield* getAuthenticatedSessionCookieHeader();

      const response = yield* postAttachmentUpload({
        uploadToken: "definitely-not-a-real-token",
        cookie,
        body: HttpBody.uint8Array(new TextEncoder().encode("abc")),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires authentication for attachment uploads", () =>
    Effect.gen(function* () {
      const { uploads } = yield* makeUploadTestContext;
      const created = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      });
      const response = yield* postAttachmentUpload({
        uploadToken: created.uploadToken,
        cookie: "session=invalid",
        body: HttpBody.uint8Array(new TextEncoder().encode("abc")),
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up staging files when the upload stream is interrupted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { config, uploads } = yield* makeUploadTestContext;
      const created = yield* uploads.create({
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 30,
      });
      const cookie = yield* getAuthenticatedSessionCookieHeader();

      const interrupted = yield* Effect.result(
        postAttachmentUpload({
          uploadToken: created.uploadToken,
          cookie,
          body: HttpBody.stream(
            Stream.concat(
              Stream.make(new TextEncoder().encode("partial-bytes")),
              Stream.fail(new Error("client aborted")),
            ),
          ),
        }),
      );
      assert.isTrue(interrupted._tag === "Failure" || interrupted._tag === "Success");

      const cleanupComplete = () =>
        fileSystem
          .readDirectory(config.attachmentsDir)
          .pipe(
            Effect.map(
              (entries) => entries.filter((entry) => entry.endsWith(".part")).length === 0,
            ),
          );
      const waitMillis = (millis: number) =>
        Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)));
      let clean = yield* cleanupComplete();
      for (let attempt = 0; attempt < 20 && !clean; attempt += 1) {
        yield* waitMillis(50);
        clean = yield* cleanupComplete();
      }
      assert.isTrue(clean);
      assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("proxies browser OTLP trace exports through the server", () =>
    Effect.gen(function* () {
      const upstreamRequests: Array<{
        readonly body: string;
        readonly contentType: string | null;
      }> = [];
      const localTraceRecords: Array<unknown> = [];
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "ryco-web" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "effect",
                  version: "4.0.0-beta.43",
                },
                spans: [
                  {
                    traceId: "11111111111111111111111111111111",
                    spanId: "2222222222222222",
                    parentSpanId: "3333333333333333",
                    name: "RpcClient.server.getSettings",
                    kind: 3,
                    startTimeUnixNano: "1000000",
                    endTimeUnixNano: "2000000",
                    attributes: [
                      {
                        key: "rpc.method",
                        value: { stringValue: "server.getSettings" },
                      },
                    ],
                    events: [
                      {
                        name: "http.request",
                        timeUnixNano: "1500000",
                        attributes: [
                          {
                            key: "http.status_code",
                            value: { intValue: "200" },
                          },
                        ],
                      },
                    ],
                    links: [],
                    status: {
                      code: "STATUS_CODE_OK",
                    },
                    flags: 1,
                  },
                ],
              },
            ],
          },
        ],
      };

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const NodeHttp = await import("node:http");

          return await new Promise<{
            readonly close: () => Promise<void>;
            readonly url: string;
          }>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              request.on("end", () => {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString("utf8"),
                  contentType: request.headers["content-type"] ?? null,
                });
                response.statusCode = 204;
                response.end();
              });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("Expected TCP collector address"));
                return;
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) => {
                      if (error) {
                        rejectClose(error);
                        return;
                      }
                      resolveClose();
                    });
                  }),
              });
            });
          });
        }),
        ({ close }) => Effect.promise(close),
      );

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() => {
                localTraceRecords.push(...records);
              }),
          },
        },
      });

      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          origin: "http://localhost:5733",
        },
        body: HttpBody.text(JSON.stringify(payload), "application/json"),
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(localTraceRecords, [
        {
          type: "otlp-span",
          name: "RpcClient.server.getSettings",
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          parentSpanId: "3333333333333333",
          sampled: true,
          kind: "client",
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
          durationMs: 1,
          attributes: {
            "rpc.method": "server.getSettings",
          },
          resourceAttributes: {
            "service.name": "ryco-web",
          },
          scope: {
            name: "effect",
            version: "4.0.0-beta.43",
            attributes: {},
          },
          events: [
            {
              name: "http.request",
              timeUnixNano: "1500000",
              attributes: {
                "http.status_code": "200",
              },
            },
          ],
          links: [],
          status: {
            code: "STATUS_CODE_OK",
          },
        },
      ]);
      assert.deepEqual(upstreamRequests, [
        {
          body: JSON.stringify(payload),
          contentType: "application/json",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("responds to browser OTLP trace preflight requests with CORS headers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/observability/v1/traces");
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:5733",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );

      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-methods")), [
        "GET",
        "OPTIONS",
        "POST",
      ]);
      assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-headers")), [
        "authorization",
        "b3",
        "content-type",
        "traceparent",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stores browser OTLP trace exports locally when no upstream collector is configured",
    () =>
      Effect.gen(function* () {
        const localTraceRecords: Array<unknown> = [];
        const payload = yield* makeBrowserOtlpPayload("client.test");
        const resourceSpan = payload.resourceSpans[0];
        const scopeSpan = resourceSpan?.scopeSpans[0];
        const span = scopeSpan?.spans[0];

        assert.notEqual(resourceSpan, undefined);
        assert.notEqual(scopeSpan, undefined);
        assert.notEqual(span, undefined);
        if (!resourceSpan || !scopeSpan || !span) {
          return;
        }

        yield* buildAppUnderTest({
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
          },
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204);
        assert.equal(localTraceRecords.length, 1);
        const record = localTraceRecords[0] as {
          readonly type: string;
          readonly name: string;
          readonly traceId: string;
          readonly spanId: string;
          readonly kind: string;
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly events: ReadonlyArray<unknown>;
          readonly links: ReadonlyArray<unknown>;
          readonly scope: {
            readonly name?: string;
            readonly attributes: Readonly<Record<string, unknown>>;
          };
          readonly resourceAttributes: Readonly<Record<string, unknown>>;
          readonly status?: {
            readonly code?: string;
          };
        };

        assert.equal(record.type, "otlp-span");
        assert.equal(record.name, span.name);
        assert.equal(record.traceId, span.traceId);
        assert.equal(record.spanId, span.spanId);
        assert.equal(record.kind, "internal");
        assert.deepEqual(record.attributes, {});
        assert.deepEqual(record.events, []);
        assert.deepEqual(record.links, []);
        assert.equal(record.scope.name, scopeSpan.scope.name);
        assert.deepEqual(record.scope.attributes, {});
        assert.equal(record.resourceAttributes["service.name"], "ryco-web");
        assert.equal(record.status?.code, String(span.status.code));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      const failureMessage = String(result.failure);
      assertTrue(
        failureMessage.includes("SocketOpenError") || failureMessage.includes("SocketCloseError"),
      );
      assertTrue(
        failureMessage.includes("Unauthorized") ||
          failureMessage.includes("An error occurred during Open"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects owner-only websocket RPC calls from paired client sessions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ryco-ws-client-role-",
      });
      yield* buildAppUnderTest();

      const createResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const created = (yield* createResponse.json) as {
        readonly credential: string;
      };
      const wsUrl = yield* getWsServerUrl("/ws", { credential: created.credential });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertInclude(String(result.failure), "Only owner sessions can call projects.searchEntries.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects paired client sessions dispatching orchestration commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ryco-ws-paired-dispatch-",
      });
      yield* buildAppUnderTest();

      const createResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const created = (yield* createResponse.json) as {
        readonly credential: string;
      };
      const wsUrl = yield* getWsServerUrl("/ws", { credential: created.credential });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "project.create",
            commandId: CommandId.make("cmd-paired-project-create"),
            projectId: ProjectId.make("project-paired-client"),
            title: "Paired Client Project",
            workspaceRoot: workspaceDir,
            createdAt: new Date().toISOString(),
          }),
        ),
      ).pipe(Effect.result);

      assertTrue(result._tag === "Failure");
      assertInclude(
        String(result.failure),
        "Only owner sessions can call orchestration.dispatchCommand.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const providers = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;
      const revalidateCalls = yield* Ref.make(0);

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
            revalidateStale: Ref.update(revalidateCalls, (count) => count + 1).pipe(
              Effect.as(providers),
            ),
            refresh: () => Effect.die("config subscriptions must not force provider refreshes"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const ws = yield* WsTestClient.connect(wsUrl);
          const sequence = yield* ws.trackPushSequence(WS_METHODS.subscribeServerConfig);
          return yield* sequence.waitForCount(2);
        }),
      );

      const [first, second] = events;
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(first.config.observability.logsDirectoryPath.endsWith("/logs"), true);
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { keybindings: [], issues: [] },
      });
      for (let attempt = 0; attempt < 50 && (yield* Ref.get(revalidateCalls)) === 0; attempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal(yield* Ref.get(revalidateCalls), 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const nextProviders = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(nextProviders),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.deepEqual(first.config.providers, []);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers: nextProviders },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: new Date().toISOString(), environment: testEnvironmentDescriptor },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const { welcome, ready } = yield* Effect.scoped(
          Effect.gen(function* () {
            const ws = yield* WsTestClient.connect(wsUrl);
            const welcome = yield* ws.awaitWelcome();
            const ready = yield* ws.awaitPush(
              WS_METHODS.subscribeServerLifecycle,
              (event) => event.type === "ready",
            );
            return { welcome, ready };
          }),
        );

        assert.equal(welcome.type, "welcome");
        assert.equal(welcome.sequence, 1);
        assert.equal(ready.type, "ready");
        assert.equal(ready.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const ws = yield* WsTestClient.connect(wsUrl);
          return yield* ws.rpc(WS_METHODS.projectsSearchEntries, {
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          });
        }),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries excludes gitignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ryco-ws-project-search-gitignored-",
      });
      yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
        "export const ignored = true;",
      );
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "tracked.ts"),
        "export const ok = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({
                paths: ["src/tracked.ts"],
                truncated: false,
                freshness: {
                  source: "live-local",
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "ignored-search-target",
            limit: 10,
          }),
        ),
      );

      assert.equal(response.entries.length, 0);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: "/definitely/not/a/real/workspace/path",
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectSearchEntriesError");
      assertInclude(
        result.failure.message,
        "Workspace root does not exist: /definitely/not/a/real/workspace/path",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      assert.match(response.version, /^sha256:[a-f0-9]{64}$/);
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes guarded project write conflicts with a typed reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ws-project-edit-" });
      const filePath = path.join(workspaceDir, "src", "app.ts");
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "export const value = 1;\n");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const opened = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "src/app.ts",
            });
            yield* fs.writeFileString(filePath, "export const value = 2;\n");
            return yield* client[WS_METHODS.projectsWriteFile]({
              cwd: workspaceDir,
              relativePath: "src/app.ts",
              contents: "export const value = 3;\n",
              expectedVersion: opened.version,
              encoding: opened.encoding,
              lineEnding: opened.lineEnding,
            }).pipe(Effect.result);
          }),
        ),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assert.equal(result.failure.reason, "conflict");
      assert.equal(yield* fs.readFileString(filePath), "export const value = 2;\n");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates a missing workspace root during websocket project.create dispatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ws-project-create-" });
      const missingWorkspaceRoot = path.join(parentDir, "nested", "new-project");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-missing-root"),
            projectId: ProjectId.make("project-create-missing-root"),
            title: "New Project",
            workspaceRoot: missingWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      const stat = yield* fs.stat(missingWorkspaceRoot);

      assert.isAtLeast(response.sequence, 0);
      assert.equal(stat.type, "Directory");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assert.equal(result.failure.reason, "failed");
      assert.equal(
        result.failure.message,
        "Workspace file path must stay within the project root.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const openError = new OpenError({ message: "Editor command not found: cursor" });
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: () => Effect.fail(openError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, openError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.succeed({
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
              }),
          },
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                refName: "main",
                upstreamRef: "origin/main",
              }),
            listRefs: () =>
              Effect.succeed({
                refs: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", refName: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createRef: (input) => Effect.succeed({ refName: input.refName }),
            switchRef: (input) => Effect.succeed({ refName: input.refName }),
          },
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const refreshedStatus = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRefreshStatus]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(refreshedStatus.isRepo, true);

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const refs = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsListRefs]({ cwd: "/tmp/repo" })),
      );
      assert.equal(refs.refs[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateWorktree]({
            cwd: "/tmp/repo",
            refName: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.refName, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateRef]({
            cwd: "/tmp/repo",
            refName: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsSwitchRef]({
            cwd: "/tmp/repo",
            refName: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates project worktrees from selected branches with a fresh Ryco branch", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: input.newRefName ?? input.refName,
              path: "/tmp/project-branch-worktree",
            },
          }),
      );

      const config = yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "ryco/12345678",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: { kind: "branch", branchName: "main" },
          }),
        ),
      );

      const createdWorktreeInput = createWorktree.mock.calls[0]?.[0];
      assert.equal(createdWorktreeInput?.cwd, "/tmp/project");
      assert.equal(createdWorktreeInput?.refName, "main");
      assert.match(createdWorktreeInput?.newRefName ?? "", /^ryco\/[0-9a-f]{8}$/);
      assert.match(
        createdWorktreeInput?.path ?? "",
        new RegExp(
          `^${config.worktreesDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/project-default/ryco-[0-9a-f]{8}__[a-z]{5}$`,
        ),
      );

      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      assert.equal(worktreeCreate?.origin, "branch");
      assert.equal(worktreeCreate?.branch, createdWorktreeInput?.newRefName);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates app-managed worktrees beneath a restricted workspace root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-server-restricted-worktrees-",
      });
      const canonicalWorkspaceAccessRoot = yield* fileSystem.realPath(workspaceAccessRoot);
      const projectRoot = path.join(canonicalWorkspaceAccessRoot, "project");
      yield* fileSystem.makeDirectory(projectRoot);
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) => {
          if (input.path === null) {
            return Effect.die("Expected an explicit worktree path");
          }
          return fileSystem.makeDirectory(input.path, { recursive: true }).pipe(
            Effect.orDie,
            Effect.as({
              worktree: {
                refName: input.newRefName ?? input.refName,
                path: input.path,
              },
            }),
          );
        },
      );

      const config = yield* buildAppUnderTest({
        config: {
          cwd: canonicalWorkspaceAccessRoot,
          workspaceAccessRoot: canonicalWorkspaceAccessRoot,
        },
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Restricted project",
                  workspaceRoot: projectRoot,
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: { kind: "branch", branchName: "main" },
          }),
        ),
      );

      const createdPath = createWorktree.mock.calls[0]?.[0].path;
      assert.isString(createdPath);
      assert.isTrue(
        createdPath!.startsWith(
          `${path.join(resolveManagedWorktreesRoot(config), defaultProjectId)}${path.sep}`,
        ),
      );
      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      assert.equal(worktreeCreate?.worktreePath, createdPath);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates project worktrees from pull requests using PR preparation", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "unexpected",
              path: "/tmp/unexpected",
            },
          }),
      );
      const preparePullRequestThread = vi.fn(
        (_input: Parameters<GitManagerShape["preparePullRequestThread"]>[0]) =>
          Effect.succeed({
            pullRequest: {
              number: 42,
              title: "Fix worktree creation",
              url: "https://example.com/pull/42",
              baseBranch: "main",
              headBranch: "feature/worktree-pr",
              state: "open" as const,
            },
            branch: "feature/worktree-pr",
            worktreePath: "/tmp/project-pr-worktree",
          }),
      );
      const refreshStatus = vi.fn((_: string) =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: true,
          isDefaultRef: false,
          refName: "feature/worktree-pr",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: true,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        }),
      );

      const config = yield* buildAppUnderTest({
        layers: {
          gitManager: {
            preparePullRequestThread,
          },
          gitVcsDriver: {
            createWorktree,
            listWorktreePaths: () => Effect.succeed([]),
            listLocalBranchNames: () => Effect.succeed([]),
          },
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          vcsStatusBroadcaster: {
            refreshStatus,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: { kind: "pr", number: 42 },
          }),
        ),
      );

      assert.equal(createWorktree.mock.calls.length, 0);
      assert.deepEqual(preparePullRequestThread.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        reference: "42",
        mode: "worktree",
        projectId: defaultProjectId,
        worktreeLocation: undefined,
        worktreesDir: path.join(config.worktreesDir, defaultProjectId),
      });

      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      const threadCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
          command.type === "thread.create",
      );
      assert.equal(worktreeCreate?.origin, "pr");
      assert.equal(worktreeCreate?.branch, "feature/worktree-pr");
      assert.equal(worktreeCreate?.worktreePath, "/tmp/project-pr-worktree");
      assert.equal(threadCreate?.worktreePath, "/tmp/project-pr-worktree");
      assert.equal(refreshStatus.mock.calls[0]?.[0], "/tmp/project-pr-worktree");
      assert.equal(worktreeCreate?.prNumber, 42);
      assert.equal(worktreeCreate?.prTitle, "Fix worktree creation");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates project worktrees from issues with a generated issue branch", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_input) =>
        Effect.succeed({ branch: "fix/generated-issue-branch" }),
      );
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: input.newRefName ?? input.refName,
              path: "/tmp/project-issue-worktree",
            },
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "issue/42-abc123",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          textGeneration: {
            generateBranchName,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: {
              kind: "issue",
              number: 42,
              title: "Fix broken reconnects",
              body: "Sessions should recover after restart.",
            },
          }),
        ),
      );

      const createdWorktreeInput = createWorktree.mock.calls[0]?.[0];
      assert.equal(createdWorktreeInput?.refName, "HEAD");
      assert.equal(createdWorktreeInput?.newRefName, "fix/generated-issue-branch");
      const branchGenerationInput = generateBranchName.mock.calls[0]?.[0];
      assert.equal(branchGenerationInput?.cwd, "/tmp/project");
      assert.equal(branchGenerationInput?.modelSelection, defaultModelSelection);
      assert.match(branchGenerationInput?.message ?? "", /Fix broken reconnects/);
      assert.match(branchGenerationInput?.message ?? "", /Sessions should recover after restart/);

      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      assert.equal(worktreeCreate?.origin, "issue");
      assert.equal(worktreeCreate?.branch, createdWorktreeInput?.newRefName);
      assert.equal(worktreeCreate?.issueNumber, 42);
      assert.equal(worktreeCreate?.issueTitle, "Fix broken reconnects");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates project worktrees from Jira work items", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_input) =>
        Effect.succeed({ branch: "super-toll" }),
      );
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: input.newRefName ?? input.refName,
              path: "/tmp/project-jira-worktree",
            },
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "KAN-4-super-toll",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          textGeneration: {
            generateBranchName,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: {
              kind: "workItem",
              provider: "jira",
              key: "KAN-4",
              title: "SUPER TOLL",
              state: "open",
              stateName: "Next to come",
              url: "https://ryco-app.atlassian.net/browse/KAN-4",
            },
          }),
        ),
      );

      const createdWorktreeInput = createWorktree.mock.calls[0]?.[0];
      assert.equal(createdWorktreeInput?.refName, "HEAD");
      assert.equal(createdWorktreeInput?.newRefName, "KAN-4-super-toll");
      const branchGenerationInput = generateBranchName.mock.calls[0]?.[0];
      assert.match(branchGenerationInput?.message ?? "", /KAN-4/);
      assert.match(branchGenerationInput?.message ?? "", /SUPER TOLL/);

      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      assert.equal(worktreeCreate?.origin, "issue");
      assert.equal(worktreeCreate?.issueNumber, null);
      assert.equal(worktreeCreate?.workItemProvider, "jira");
      assert.equal(worktreeCreate?.workItemKey, "KAN-4");
      assert.equal(worktreeCreate?.workItemTitle, "SUPER TOLL");
      assert.equal(worktreeCreate?.workItemState, "open");
      assert.equal(worktreeCreate?.workItemStateName, "Next to come");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates Jira work item worktrees from an existing branch", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_input) =>
        Effect.succeed({ branch: "should-not-be-used" }),
      );
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: input.newRefName ?? input.refName,
              path: "/tmp/project-jira-existing-branch-worktree",
            },
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature/KAN-4-existing",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          textGeneration: {
            generateBranchName,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: {
              kind: "workItem",
              provider: "jira",
              key: "KAN-4",
              title: "SUPER TOLL",
              state: "open",
              stateName: "Next to come",
              url: "https://ryco-app.atlassian.net/browse/KAN-4",
              branchSource: "existing",
              branchName: "feature/KAN-4-existing",
            },
          }),
        ),
      );

      const createdWorktreeInput = createWorktree.mock.calls[0]?.[0];
      assert.equal(createdWorktreeInput?.refName, "feature/KAN-4-existing");
      assert.equal(createdWorktreeInput?.newRefName, undefined);
      assert.equal(generateBranchName.mock.calls.length, 0);

      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      assert.equal(worktreeCreate?.branch, "feature/KAN-4-existing");
      assert.equal(worktreeCreate?.workItemProvider, "jira");
      assert.equal(worktreeCreate?.workItemKey, "KAN-4");
      assert.equal(worktreeCreate?.workItemTitle, "SUPER TOLL");
      assert.equal(worktreeCreate?.workItemState, "open");
      assert.equal(worktreeCreate?.workItemStateName, "Next to come");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uses branchName and baseBranch overrides when provided on issue intent", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: input.newRefName ?? input.refName,
              path: "/tmp/project-issue-worktree-override",
            },
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "custom/branch",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: {
              kind: "issue",
              number: 42,
              branchName: "custom/branch",
              baseBranch: "release/next",
            },
          }),
        ),
      );

      const createdWorktreeInput = createWorktree.mock.calls[0]?.[0];
      assert.equal(createdWorktreeInput?.refName, "release/next");
      assert.equal(createdWorktreeInput?.newRefName, "custom/branch");

      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      assert.equal(worktreeCreate?.origin, "issue");
      assert.equal(worktreeCreate?.branch, "custom/branch");
      assert.equal(worktreeCreate?.issueNumber, 42);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("falls back to deterministic issue branch when issue branch generation fails", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateBranchName",
            detail: "generation unavailable",
          }),
        ),
      );
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: input.newRefName ?? input.refName,
              path: "/tmp/project-issue-worktree-fallback",
            },
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "issue/42-abc123",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          textGeneration: {
            generateBranchName,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: { kind: "issue", number: 42 },
          }),
        ),
      );

      const createdWorktreeInput = createWorktree.mock.calls[0]?.[0];
      assert.equal(createdWorktreeInput?.refName, "HEAD");
      assert.equal(createdWorktreeInput?.newRefName, "issue/42-73475c");
      assert.notEqual(createdWorktreeInput?.newRefName, "custom/branch");
      assert.equal(generateBranchName.mock.calls.length, 1);

      const worktreeCreate = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "worktree.create" }> =>
          command.type === "worktree.create",
      );
      assert.equal(worktreeCreate?.origin, "issue");
      assert.equal(worktreeCreate?.branch, "issue/42-73475c");
      assert.equal(worktreeCreate?.issueNumber, 42);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up branch worktrees when orchestration dispatch fails", () =>
    Effect.gen(function* () {
      const removeWorktree = vi.fn(
        (_input: Parameters<GitVcsDriver.GitVcsDriverShape["removeWorktree"]>[0]) => Effect.void,
      );
      const deleteBranch = vi.fn(
        (_input: Parameters<GitVcsDriver.GitVcsDriverShape["deleteBranch"]>[0]) => Effect.void,
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree: (input) =>
              Effect.succeed({
                worktree: {
                  refName: input.newRefName ?? input.refName,
                  path: "/tmp/project-branch-cleanup-worktree",
                },
              }),
            removeWorktree,
            deleteBranch,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              command.type === "thread.create"
                ? Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: "domain-event",
                      detail: "thread create failed",
                    }),
                  )
                : Effect.succeed({ sequence: 1 }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: { kind: "branch", branchName: "main" },
          }),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      assert.deepEqual(removeWorktree.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        path: "/tmp/project-branch-cleanup-worktree",
        force: true,
      });
      assert.equal(deleteBranch.mock.calls[0]?.[0]?.cwd, "/tmp/project");
      assert.match(deleteBranch.mock.calls[0]?.[0]?.refName ?? "", /^ryco\/[0-9a-f]{8}$/);
      assert.equal(deleteBranch.mock.calls[0]?.[0]?.force, true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up owned prepared PR worktrees when orchestration dispatch fails", () =>
    Effect.gen(function* () {
      const removeWorktree = vi.fn(
        (_input: Parameters<GitVcsDriver.GitVcsDriverShape["removeWorktree"]>[0]) => Effect.void,
      );
      const deleteBranch = vi.fn(
        (_input: Parameters<GitVcsDriver.GitVcsDriverShape["deleteBranch"]>[0]) => Effect.void,
      );

      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 42,
                  title: "Fix worktree creation",
                  url: "https://example.com/pull/42",
                  baseBranch: "main",
                  headBranch: "feature/worktree-pr",
                  state: "open" as const,
                },
                branch: "feature/worktree-pr",
                worktreePath: "/tmp/project-pr-cleanup-worktree",
              }),
          },
          gitVcsDriver: {
            listWorktreePaths: () => Effect.succeed([]),
            listLocalBranchNames: () => Effect.succeed([]),
            removeWorktree,
            deleteBranch,
          },
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              command.type === "thread.create"
                ? Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: "domain-event",
                      detail: "thread create failed",
                    }),
                  )
                : Effect.succeed({ sequence: 1 }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: { kind: "pr", number: 42 },
          }),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      assert.deepEqual(removeWorktree.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        path: "/tmp/project-pr-cleanup-worktree",
        force: true,
      });
      assert.deepEqual(deleteBranch.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        refName: "feature/worktree-pr",
        force: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps reused prepared PR worktrees when orchestration dispatch fails", () =>
    Effect.gen(function* () {
      const removeWorktree = vi.fn(
        (_input: Parameters<GitVcsDriver.GitVcsDriverShape["removeWorktree"]>[0]) => Effect.void,
      );
      const deleteBranch = vi.fn(
        (_input: Parameters<GitVcsDriver.GitVcsDriverShape["deleteBranch"]>[0]) => Effect.void,
      );

      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 42,
                  title: "Fix worktree creation",
                  url: "https://example.com/pull/42",
                  baseBranch: "main",
                  headBranch: "feature/worktree-pr",
                  state: "open" as const,
                },
                branch: "feature/worktree-pr",
                worktreePath: "/tmp/project-pr-reused-worktree",
              }),
          },
          gitVcsDriver: {
            listWorktreePaths: () => Effect.succeed(["/tmp/project-pr-reused-worktree"]),
            listLocalBranchNames: () => Effect.succeed(["feature/worktree-pr"]),
            removeWorktree,
            deleteBranch,
          },
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              command.type === "thread.create"
                ? Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: "domain-event",
                      detail: "thread create failed",
                    }),
                  )
                : Effect.succeed({ sequence: 1 }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/project",
                  projectMetadataDir: ".ryco",
                  repositoryIdentity: null,
                  defaultModelSelection,
                  customSystemPrompt: null,
                  customAvatarContentHash: null,
                  preferredRemoteName: null,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeForProject]({
            projectId: defaultProjectId,
            intent: { kind: "pr", number: 42 },
          }),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(removeWorktree.mock.calls.length, 0);
      assert.equal(deleteBranch.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("deletes stale worktree records when the on-disk worktree is already gone", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-stale-worktree");
      const worktreeId = WorktreeId.make("worktree-stale-delete");
      const missingWorktreePath = "/tmp/ryco-missing-worktree-delete";
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      let removeWorktreeCalls = 0;

      yield* buildAppUnderTest({
        layers: {
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature/stale-delete",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          gitVcsDriver: {
            removeWorktree: () =>
              Effect.sync(() => {
                removeWorktreeCalls += 1;
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Stale Worktree Project",
                  workspaceRoot: "/tmp/ryco-stale-worktree-project",
                  defaultModelSelection: defaultModelSelection,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
          projectionWorktreeRepository: {
            getById: () =>
              Effect.succeed(
                Option.some({
                  worktreeId,
                  projectId,
                  title: null,
                  branch: "feature/stale-delete",
                  worktreePath: missingWorktreePath,
                  origin: "pr",
                  prNumber: 12,
                  issueNumber: null,
                  prTitle: null,
                  issueTitle: null,
                  prState: null,
                  prIsDraft: null,
                  issueState: null,
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                  archivedAt: null,
                  manualPosition: 0,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitDeleteWorktree]({
            worktreeId,
            deleteBranch: false,
          }),
        ),
      );

      assert.equal(removeWorktreeCalls, 0);
      assert.equal(dispatchedCommands.at(-1)?.type, "worktree.delete");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives stale worktree records when the requested branch is already gone", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-stale-branch");
      const worktreeId = WorktreeId.make("worktree-stale-archive");
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      let deleteBranchCalls = 0;

      const missingBranchError = new GitCommandError({
        operation: "GitVcsDriver.deleteBranch",
        command: "git branch -D feature/stale-archive",
        cwd: "/tmp/ryco-stale-branch-project",
        detail: "error: branch 'feature/stale-archive' not found.",
      });

      yield* buildAppUnderTest({
        layers: {
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature/stale-archive",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
          gitVcsDriver: {
            deleteBranch: () =>
              Effect.sync(() => {
                deleteBranchCalls += 1;
              }).pipe(Effect.andThen(Effect.fail(missingBranchError))),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Stale Branch Project",
                  workspaceRoot: "/tmp/ryco-stale-branch-project",
                  defaultModelSelection: defaultModelSelection,
                  scripts: [],
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                }),
              ),
          },
          projectionWorktreeRepository: {
            getById: () =>
              Effect.succeed(
                Option.some({
                  worktreeId,
                  projectId,
                  title: null,
                  branch: "feature/stale-archive",
                  worktreePath: null,
                  origin: "issue",
                  prNumber: null,
                  issueNumber: 34,
                  prTitle: null,
                  issueTitle: null,
                  prState: null,
                  prIsDraft: null,
                  issueState: null,
                  createdAt: "2026-05-10T00:00:00.000Z",
                  updatedAt: "2026-05-10T00:00:00.000Z",
                  archivedAt: null,
                  manualPosition: 0,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitArchiveWorktree]({
            worktreeId,
            deleteBranch: true,
          }),
        ),
      );

      assert.equal(deleteBranchCalls, 1);
      assert.equal(dispatchedCommands.at(-1)?.type, "worktree.archive");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.runStackedAction errors after refreshing git status", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "commit",
        command: "git commit",
        cwd: "/tmp/repo",
        detail: "nothing to commit",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature/demo",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            runStackedAction: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(Stream.runCollect, Effect.result),
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("completes websocket rpc git.pull before background git status refresh finishes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled" as const,
                refName: "main",
                upstreamRef: "origin/main",
              }),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sleep(Duration.seconds(2)).pipe(
                Effect.as({
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const startedAt = Date.now();
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.status, "pulled");
      assertTrue(elapsedMs < 1_000);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "completes websocket rpc git.runStackedAction before background git status refresh finishes",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const startedAt = Date.now();
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );
        const elapsedMs = Date.now() - startedAt;

        assertTrue(elapsedMs < 1_000);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "starts a background local git status refresh after a successful git.runStackedAction",
    () =>
      Effect.gen(function* () {
        const localRefreshStarted = yield* Deferred.make<void>();

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              localStatus: () =>
                Deferred.succeed(localRefreshStarted, undefined).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.succeed({
                      isRepo: true,
                      hasPrimaryRemote: true,
                      isDefaultRef: false,
                      refName: "feature/demo",
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    }),
                  ),
                ),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );

        yield* Deferred.await(localRefreshStarted);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.make("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-1"),
            threadId: ThreadId.make("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.make("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEventsPage]({
            fromSequenceExclusive: 0,
            limit: 1,
          }),
        ),
      );
      assert.deepEqual(replayResult.events, []);
      assert.equal(replayResult.nextSequence, 0);
      assert.equal(replayResult.hasMore, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration shell snapshot errors", () =>
    Effect.gen(function* () {
      const projectionError = new PersistenceSqlError({
        operation: "ProjectionSnapshotQuery.getShellSnapshot:test",
        detail: "failed to read projection shell snapshot",
      });
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () => Effect.fail(projectionError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(Stream.runCollect),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationGetSnapshotError");
      assertTrue(result.failure.cause instanceof Error);
      assert.include(result.failure.cause.message, projectionError.message);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("replays shell handoff events and dedupes overlapping live events", () =>
    Effect.gen(function* () {
      const now = "2026-04-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread-shell-handoff");
      const makeDeletedEvent = (sequence: number) =>
        ({
          sequence,
          eventId: EventId.make(`event-shell-handoff-${sequence}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.deleted",
          payload: {
            threadId,
            deletedAt: now,
          },
        }) satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;
      const replayedEvent = makeDeletedEvent(11);
      const liveEvent = makeDeletedEvent(12);
      const livePubSub = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEventsPage: (fromSequenceExclusive) => {
              assert.equal(fromSequenceExclusive, 10);
              return Effect.succeed({
                events: [replayedEvent],
                nextSequence: replayedEvent.sequence,
                hasMore: false,
              });
            },
            subscribeDomainEvents: Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(livePubSub);
              yield* PubSub.publish(livePubSub, replayedEvent);
              yield* PubSub.publish(livePubSub, liveEvent);
              return subscription;
            }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 10,
                projects: [],
                threads: [],
                updatedAt: now,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
            Stream.take(3),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          ),
        ),
      );

      assert.deepEqual(
        result.map((item) => (item.kind === "snapshot" ? "snapshot" : item.sequence)),
        ["snapshot", 11, 12],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("bounds shell replay to the captured live high-water sequence", () =>
    Effect.gen(function* () {
      const now = "2026-04-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread-shell-bounded-replay");
      const makeDeletedEvent = (sequence: number) =>
        ({
          sequence,
          eventId: EventId.make(`event-shell-bounded-replay-${sequence}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.deleted",
          payload: {
            threadId,
            deletedAt: now,
          },
        }) satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;
      const replayedEvent = makeDeletedEvent(11);
      const liveBoundaryEvent = makeDeletedEvent(12);
      const shouldNotReplayEvent = makeDeletedEvent(13);
      const livePubSub = yield* PubSub.unbounded<OrchestrationEvent>();
      const replayPageCursors: number[] = [];

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEventsPage: (fromSequenceExclusive) => {
              replayPageCursors.push(fromSequenceExclusive);
              if (fromSequenceExclusive === 10) {
                return Effect.succeed({
                  events: [replayedEvent],
                  nextSequence: replayedEvent.sequence,
                  hasMore: true,
                });
              }
              if (fromSequenceExclusive === replayedEvent.sequence) {
                return Effect.succeed({
                  events: [shouldNotReplayEvent],
                  nextSequence: shouldNotReplayEvent.sequence,
                  hasMore: false,
                });
              }
              return Effect.succeed({
                events: [],
                nextSequence: fromSequenceExclusive,
                hasMore: false,
              });
            },
            subscribeDomainEvents: Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(livePubSub);
              yield* PubSub.publish(livePubSub, liveBoundaryEvent);
              return subscription;
            }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 10,
                projects: [],
                threads: [],
                updatedAt: now,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
            Stream.take(3),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          ),
        ),
      );

      assert.deepEqual(replayPageCursors, [10, 11]);
      assert.deepEqual(
        result.map((item) => (item.kind === "snapshot" ? "snapshot" : item.sequence)),
        ["snapshot", 11, 12],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("replays thread handoff events and dedupes overlapping live events", () =>
    Effect.gen(function* () {
      const now = "2026-04-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread-detail-handoff");
      const makeActivityEvent = (sequence: number) =>
        ({
          sequence,
          eventId: EventId.make(`event-thread-handoff-${sequence}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-thread-handoff-${sequence}`),
              tone: "info",
              kind: "handoff.test",
              summary: `handoff event ${sequence}`,
              payload: {},
              turnId: null,
              sequence,
              createdAt: now,
            },
          },
        }) satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;
      const replayedEvent = makeActivityEvent(11);
      const liveEvent = makeActivityEvent(12);
      const livePubSub = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEventsPage: (fromSequenceExclusive) => {
              assert.equal(fromSequenceExclusive, 10);
              return Effect.succeed({
                events: [replayedEvent],
                nextSequence: replayedEvent.sequence,
                hasMore: false,
              });
            },
            subscribeDomainEvents: Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(livePubSub);
              yield* PubSub.publish(livePubSub, replayedEvent);
              yield* PubSub.publish(livePubSub, liveEvent);
              return subscription;
            }),
          },
          projectionSnapshotQuery: {
            getThreadDetailById: (requestedThreadId) =>
              Effect.succeed(
                requestedThreadId === threadId
                  ? Option.some({
                      ...makeDefaultOrchestrationReadModel().threads[0]!,
                      id: threadId,
                    })
                  : Option.none(),
              ),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 10 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
            Stream.take(3),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          ),
        ),
      );

      assert.deepEqual(
        result.map((item) => (item.kind === "snapshot" ? "snapshot" : item.event.sequence)),
        ["snapshot", 11, 12],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps a draining thread subscription alive beyond its cumulative byte budget", () =>
    Effect.gen(function* () {
      const now = "2026-04-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread-detail-handoff");
      const makeActivityEvent = (sequence: number) =>
        ({
          sequence,
          eventId: EventId.make(`event-thread-handoff-${sequence}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-thread-handoff-${sequence}`),
              tone: "info",
              kind: "handoff.test",
              summary: `handoff event ${sequence}`,
              payload: { detail: "x".repeat(512 * 1024) },
              turnId: null,
              sequence,
              createdAt: now,
            },
          },
        }) satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;
      const livePubSub = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEventsPage: (fromSequenceExclusive) =>
              Effect.succeed({
                events: [],
                nextSequence: fromSequenceExclusive,
                hasMore: false,
              }),
            subscribeDomainEvents: Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(livePubSub);
              return subscription;
            }),
          },
          projectionSnapshotQuery: {
            getThreadDetailById: (requestedThreadId) =>
              Effect.succeed(
                requestedThreadId === threadId
                  ? Option.some({
                      ...makeDefaultOrchestrationReadModel().threads[0]!,
                      id: threadId,
                    })
                  : Option.none(),
              ),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 10 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
            Stream.tap((item) => {
              const next = item.kind === "snapshot" ? 11 : item.event.sequence + 1;
              return next <= 22 ? PubSub.publish(livePubSub, makeActivityEvent(next)) : Effect.void;
            }),
            Stream.take(13),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          ),
        ),
      );

      assert.deepEqual(
        result.map((item) => (item.kind === "snapshot" ? "snapshot" : item.event.sequence)),
        ["snapshot", ...Array.from({ length: 12 }, (_, index) => index + 11)],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("caps legacy websocket rpc orchestration replay to one bounded page", () =>
    Effect.gen(function* () {
      let observedLimit: number | undefined;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: (fromSequenceExclusive, limit) => {
              assert.equal(fromSequenceExclusive, 7);
              observedLimit = limit;
              return Stream.empty;
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 7,
          }),
        ),
      );

      assert.deepEqual(replayResult, []);
      assert.equal(observedLimit, ORCHESTRATION_LEGACY_REPLAY_MAX_EVENTS);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration paginated replay", () =>
    Effect.gen(function* () {
      const now = "2026-04-05T00:00:00.000Z";
      const event = {
        sequence: 8,
        eventId: EventId.make("event-replay-page-8"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.deleted",
        payload: {
          threadId: defaultThreadId,
          deletedAt: now,
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEventsPage: (fromSequenceExclusive, limit) => {
              assert.equal(fromSequenceExclusive, 7);
              assert.equal(limit, 2);
              return Effect.succeed({
                events: [event],
                nextSequence: 8,
                hasMore: false,
              });
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEventsPage]({
            fromSequenceExclusive: 7,
            limit: 2,
          }),
        ),
      );

      assert.equal(replayResult.nextSequence, 8);
      assert.equal(replayResult.hasMore, false);
      assert.deepEqual(
        replayResult.events.map((item) => item.sequence),
        [8],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("enriches replayed project events with repository identity metadata", () =>
    Effect.gen(function* () {
      const repositoryIdentity = {
        canonicalKey: "github.com/rycotools/ryco",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:Ryco/ryco.git",
        },
        displayName: "Ryco/ryco",
        provider: "github",
        owner: "Ryco",
        name: "ryco",
        remotes: [],
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEventsPage: (fromSequenceExclusive, limit) => {
              assert.equal(fromSequenceExclusive, 0);
              assert.equal(limit, 1);
              return Effect.succeed({
                events: [
                  {
                    sequence: 1,
                    eventId: EventId.make("event-1"),
                    aggregateKind: "project",
                    aggregateId: defaultProjectId,
                    occurredAt: "2026-04-05T00:00:00.000Z",
                    commandId: null,
                    causationEventId: null,
                    correlationId: null,
                    metadata: {},
                    type: "project.created",
                    payload: {
                      projectId: defaultProjectId,
                      title: "Default Project",
                      workspaceRoot: "/tmp/default-project",
                      defaultModelSelection,
                      scripts: [],
                      createdAt: "2026-04-05T00:00:00.000Z",
                      updatedAt: "2026-04-05T00:00:00.000Z",
                    },
                  } satisfies Extract<OrchestrationEvent, { type: "project.created" }>,
                ],
                nextSequence: 1,
                hasMore: false,
              });
            },
          },
          repositoryIdentityResolver: {
            resolve: () => Effect.succeed(repositoryIdentity),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEventsPage]({
            fromSequenceExclusive: 0,
            limit: 1,
          }),
        ),
      );

      const replayedEvent = replayResult.events[0];
      assert.equal(replayedEvent?.type, "project.created");
      assert.deepEqual(
        replayedEvent && replayedEvent.type === "project.created"
          ? replayedEvent.payload.repositoryIdentity
          : null,
        repositoryIdentity,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops the provider session and closes thread terminals after archive", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      const sessionStopCommand = dispatchedCommands[1];
      assert.equal(sessionStopCommand?.type, "thread.session.stop");
      if (sessionStopCommand?.type === "thread.session.stop") {
        assert.equal(sessionStopCommand.threadId, threadId);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("checks session status before archiving removes the thread from active lookups", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-precheck");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();
      let archived = false;

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                if (command.type === "thread.archive") {
                  archived = true;
                }
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.sync(() => {
                effects.push(`query:thread-shell:${archived ? "archived" : "active"}`);
                return archived
                  ? Option.none()
                  : Option.some(
                      makeDefaultOrchestrationThreadShell({
                        id: threadId,
                        updatedAt: now,
                        session: {
                          threadId,
                          status: "ready",
                          providerName: "claudeAgent",
                          runtimeMode: "full-access",
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: now,
                        },
                      }),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-precheck"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "query:thread-shell:active",
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives without dispatching session stop when the thread has no session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-no-session");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, session: null })),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-no-session"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "archives without dispatching session stop when the thread session is already stopped",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-archive-stopped-session");
        const effects: string[] = [];
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const now = new Date().toISOString();

        yield* buildAppUnderTest({
          layers: {
            terminalManager: {
              close: (input) =>
                Effect.sync(() => {
                  effects.push(`terminal.close:${input.threadId}`);
                }),
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  effects.push(`dispatch:${command.type}`);
                  return { sequence: dispatchedCommands.length };
                }),
            },
            projectionSnapshotQuery: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some(
                    makeDefaultOrchestrationThreadShell({
                      id: threadId,
                      updatedAt: now,
                      session: {
                        threadId,
                        status: "stopped",
                        providerName: "claudeAgent",
                        runtimeMode: "full-access",
                        activeTurnId: null,
                        lastError: null,
                        updatedAt: now,
                      },
                    }),
                  ),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const dispatchResult = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.archive",
              commandId: CommandId.make("cmd-thread-archive-stopped-session"),
              threadId,
            }),
          ),
        );

        assert.equal(dispatchResult.sequence, 1);
        assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.archive"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-failure");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "simulated archive stop failure",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-failure"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop defects", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-defect");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.die(new Error("simulated archive stop defect"));
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-defect"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps first-send worktree turns on the server before dispatching turn start",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const refreshStatus = vi.fn((_: string) =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: "ryco/bootstrap-refName",
            hasWorkingTreeChanges: false,
            workingTree: {
              files: [],
              insertions: 0,
              deletions: 0,
            },
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          }),
        );
        const createWorktree = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
            Effect.succeed({
              worktree: {
                refName: "ryco/bootstrap-refName",
                path: "/tmp/bootstrap-worktree",
              },
            }),
        );
        const runForThread = vi.fn(
          (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
            Effect.succeed({
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-setup",
              cwd: "/tmp/bootstrap-worktree",
            }),
        );

        const config = yield* buildAppUnderTest({
          layers: {
            gitVcsDriver: {
              createWorktree,
            },
            vcsStatusBroadcaster: {
              refreshStatus,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start"),
              threadId: ThreadId.make("thread-bootstrap"),
              message: {
                messageId: MessageId.make("msg-bootstrap"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "ryco/bootstrap-refName",
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 7);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          [
            "thread.create",
            "thread.meta.update",
            "worktree.create",
            "thread.attach-to-worktree",
            "thread.activity.append",
            "thread.activity.append",
            "thread.turn.start",
          ],
        );
        const createdWorktreeInput = createWorktree.mock.calls[0]?.[0];
        assert.equal(createdWorktreeInput?.cwd, "/tmp/project");
        assert.equal(createdWorktreeInput?.refName, "main");
        assert.equal(createdWorktreeInput?.newRefName, "ryco/bootstrap-refName");
        assert.match(
          createdWorktreeInput?.path ?? "",
          new RegExp(
            `^${config.worktreesDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/project-default/ryco-bootstrap-refname__[a-z]{5}$`,
          ),
        );
        assert.deepEqual(runForThread.mock.calls[0]?.[0], {
          threadId: ThreadId.make("thread-bootstrap"),
          projectId: defaultProjectId,
          projectCwd: "/tmp/project",
          worktreePath: "/tmp/bootstrap-worktree",
        });
        assert.deepEqual(refreshStatus.mock.calls[0]?.[0], "/tmp/bootstrap-worktree");

        const setupActivities = dispatchedCommands.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
            command.type === "thread.activity.append",
        );
        assert.deepEqual(
          setupActivities.map((command) => command.activity.kind),
          ["setup-script.requested", "setup-script.started"],
        );
        const worktreeCommand = dispatchedCommands[2];
        assertTrue(worktreeCommand?.type === "worktree.create");
        if (worktreeCommand?.type === "worktree.create") {
          assert.equal(worktreeCommand.branch, "ryco/bootstrap-refName");
          assert.equal(worktreeCommand.worktreePath, "/tmp/bootstrap-worktree");
          assert.equal(worktreeCommand.projectId, defaultProjectId);
          assert.equal(dispatchedCommands[3]?.type, "thread.attach-to-worktree");
        }
        const finalCommand = dispatchedCommands[6];
        assertTrue(finalCommand?.type === "thread.turn.start");
        if (finalCommand?.type === "thread.turn.start") {
          assert.equal(finalCommand.bootstrap, undefined);
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records setup-script failures without aborting bootstrap turn start", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "ryco/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );
      const runForThread = vi.fn(
        (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
          Effect.fail(new Error("pty unavailable")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "ryco/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 6);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.meta.update",
          "worktree.create",
          "thread.attach-to-worktree",
          "thread.activity.append",
          "thread.turn.start",
        ],
      );
      const setupFailureActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.equal(setupFailureActivity?.activity.kind, "setup-script.failed");
      assert.deepEqual(setupFailureActivity?.activity.payload, {
        detail: "pty unavailable",
        worktreePath: "/tmp/bootstrap-worktree",
      });
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not misattribute setup activity dispatch failures as setup launch failures", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "ryco/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );
      const runForThread = vi.fn(
        (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
          Effect.succeed({
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: "setup-setup",
            cwd: "/tmp/bootstrap-worktree",
          }),
      );
      let setupActivityAppendAttempt = 0;

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              if (
                command.type === "thread.activity.append" &&
                command.activity.kind.startsWith("setup-script.")
              ) {
                setupActivityAppendAttempt += 1;
                if (setupActivityAppendAttempt === 2) {
                  return Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: "domain-event",
                      detail: "failed to append setup-script.started activity",
                    }),
                  );
                }
              }

              return Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              });
            },
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-activity-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-activity-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-activity-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "ryco/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 6);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.meta.update",
          "worktree.create",
          "thread.attach-to-worktree",
          "thread.activity.append",
          "thread.turn.start",
        ],
      );
      const setupActivities = dispatchedCommands.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.deepEqual(
        setupActivities.map((command) => command.activity.kind),
        ["setup-script.requested"],
      );
      assertTrue(
        setupActivities.every((command) => command.activity.kind !== "setup-script.failed"),
      );
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("fences deletion cleanup before a recreated thread can own resources", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      let nextSequence = 1;
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                trace.push(`dispatch:${command.type}`);
                return { sequence: nextSequence++ };
              }),
            readEvents: () => Stream.empty,
          },
          threadDeletionReactor: {
            drainThrough: (sequence) => Effect.sync(() => trace.push(`drain:${sequence}`)),
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.create",
            commandId: CommandId.make("cmd-direct-recreation-fence"),
            threadId: ThreadId.make("thread-direct-recreation-fence"),
            projectId: defaultProjectId,
            title: "Direct recreation",
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        ),
      );
      assert.deepEqual(trace, ["dispatch:thread.create", "drain:1"]);

      trace.length = 0;
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-recreation-fence"),
            threadId: ThreadId.make("thread-bootstrap-recreation-fence"),
            message: {
              messageId: MessageId.make("message-bootstrap-recreation-fence"),
              role: "user",
              text: "retry",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap recreation",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ),
      );
      assert.deepEqual(trace, ["dispatch:thread.create", "drain:2", "dispatch:thread.turn.start"]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("retries first send with the same thread id after partial bootstrap failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-bootstrap-partial-retry");
      const dispatched: OrchestrationCommand[] = [];
      let failFirstTurnStart = true;
      let nextSequence = 1;
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: (command) => {
              dispatched.push(command);
              if (command.type === "thread.turn.start" && failFirstTurnStart) {
                failFirstTurnStart = false;
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "provider admission failed",
                  }),
                );
              }
              return Effect.succeed({ sequence: nextSequence++ });
            },
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const makeFirstSend = (commandId: string, messageId: string) => ({
        type: "thread.turn.start" as const,
        commandId: CommandId.make(commandId),
        threadId,
        message: {
          messageId: MessageId.make(messageId),
          role: "user" as const,
          text: "retry",
          attachments: [],
        },
        modelSelection: defaultModelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        bootstrap: {
          createThread: {
            projectId: defaultProjectId,
            title: "Partial bootstrap retry",
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: null,
            worktreePath: null,
            createdAt,
          },
          runSetupScript: false,
        },
        createdAt,
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const first = yield* Effect.result(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand](
                makeFirstSend("cmd-bootstrap-partial-retry-1", "message-bootstrap-partial-retry-1"),
              ),
            );
            assertTrue(first._tag === "Failure");

            const second = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              makeFirstSend("cmd-bootstrap-partial-retry-2", "message-bootstrap-partial-retry-2"),
            );
            assert.equal(second.sequence, 4);
          }),
        ),
      );

      assert.deepEqual(
        dispatched.map((command) => ({
          type: command.type,
          threadId: "threadId" in command ? command.threadId : null,
        })),
        [
          { type: "thread.create", threadId },
          { type: "thread.turn.start", threadId },
          { type: "thread.delete", threadId },
          { type: "thread.create", threadId },
          { type: "thread.turn.start", threadId },
        ],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up created bootstrap threads when worktree creation defects", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.die(new Error("worktree exploded")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-defect"),
            threadId: ThreadId.make("thread-bootstrap-defect"),
            message: {
              messageId: MessageId.make("msg-bootstrap-defect"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "ryco/bootstrap-refName",
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "worktree exploded");
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
