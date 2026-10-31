import type { ThreadId } from "@ryco/contracts";
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CodexSettings,
  ProviderDriverKind,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@ryco/contracts";
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { CheckpointStoreLive } from "../src/checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../src/checkpointing/Services/CheckpointStore.ts";
import { TextGeneration, type TextGenerationShape } from "../src/textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { ContextHandoffRepositoryLive } from "../src/persistence/Layers/ContextHandoffs.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { ContextHandoffRepository } from "../src/persistence/Services/ContextHandoffs.ts";
import {
  makeAdapterRegistryMock,
  type KindAdapterMap,
} from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import type { ProviderAdapterShape } from "../src/provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../src/provider/Errors.ts";
import type { ReplayGate } from "../src/provider/testUtils/replay/replayGate.ts";
import type { ReplayError } from "../src/provider/testUtils/replay/replayMatch.ts";
import { raceReplayFailure } from "../src/provider/testUtils/replay/replayPeer.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapter } from "../src/provider/Layers/CodexAdapter.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../src/provider/Services/ProviderRegistry.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { CheckpointReactorLive } from "../src/orchestration/Layers/CheckpointReactor.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadSessionModelSelections from "../src/orchestration/ThreadSessionModelSelections.ts";
import { RuntimeReceiptBusTest } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { ProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../src/orchestration/Services/ThreadDeletionReactor.ts";
import { ThreadGitMetadataReactor } from "../src/orchestration/Services/ThreadGitMetadataReactor.ts";
import { ThreadPurgeReactor } from "../src/orchestration/Services/ThreadPurgeReactor.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ContextHandoffCoordinatorLive } from "../src/orchestration/Layers/ContextHandoffCoordinator.ts";
import { ContextHandoffServiceLive } from "../src/orchestration/contextHandoff/ContextHandoffService.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import { WorkspaceEntriesLive } from "../src/workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceAccessPolicyLayer } from "../src/workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspacePathsLive } from "../src/workspace/Layers/WorkspacePaths.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../src/vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../src/vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../src/git/GitWorkflowService.ts";
import { assertWorktreeSetupComplete } from "../src/project/worktreeSetupState.ts";
import { LocalDiagnosticsMetricsLive } from "../src/observability/Services/LocalDiagnosticsMetrics.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

const initializeGitWorkspace = Effect.fn(function* (cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  runGit(cwd, ["config", "commit.gpgsign", "false"]);
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  yield* fileSystem.writeFileString(join(cwd, "README.md"), "v1\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
});

export function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

class WaitForTimeoutError extends Schema.TaggedError<WaitForTimeoutError>()("WaitForTimeoutError", {
  description: Schema.String,
}) {
  override get message(): string {
    return `Timed out waiting for ${this.description}`;
  }
}

/** Read when the wait times out, so it can say where a replay stands then. */
type WaitForDescription = string | (() => string);

const DEFAULT_WAIT_TIMEOUT_MS = 40_000;

function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: WaitForDescription,
  timeoutMs?: number,
): Effect.Effect<A, never>;
function waitFor<A, B extends A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => value is B,
  description: WaitForDescription,
  timeoutMs?: number,
): Effect.Effect<B, never>;
function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: WaitForDescription,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);

  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({
      schedule: retrySchedule,
      times: maxRetries,
      while: (error) => error === RETRY_SIGNAL,
    }),
    Effect.mapError((error) =>
      error === RETRY_SIGNAL
        ? new WaitForTimeoutError({
            description: typeof description === "string" ? description : description(),
          })
        : error,
    ),
    Effect.orDie,
  );
}

class OrchestrationHarnessRuntimeError extends Schema.TaggedError<OrchestrationHarnessRuntimeError>()(
  "OrchestrationHarnessRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const tryRuntimePromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationHarnessRuntimeError({ operation, cause }),
  });

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly adapterHarnesses: ReadonlyArray<TestProviderAdapterHarness>;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly checkpointStore: CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly contextHandoffRepository: ContextHandoffRepository["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    threadId: ThreadId,
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly waitForReceipt: {
    (
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    <Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
  };
  /**
   * Waits until a replay is parked at (or past) the gate `label`. Like the other waits, it fails
   * at once with a replay failure and times out naming where each replay stands.
   */
  readonly waitForReplayGate: (
    gate: ReplayGate,
    label: string,
    timeoutMs?: number,
  ) => Effect.Effect<void, never>;
  /** Replays behind the factory-built adapters; tests `assertConsumed` them before dispose. */
  readonly replays: ReadonlyArray<IntegrationAdapterReplay>;
  /** Releases replay gates, then shuts down. Never fails on an incomplete replay. */
  readonly dispose: Effect.Effect<void, never>;
  /**
   * Fails with the first replay failure. Run it after `dispose`: frames the adapter writes while
   * stopping are matched too (against trailing optional entries), and nothing else reports them.
   */
  readonly assertNoLateReplayFrames: Effect.Effect<void, ReplayError>;
}

/** A replayed provider behind a factory-built adapter. */
export interface IntegrationAdapterReplay {
  /** Completed with the first replay failure; every harness wait fails with it at once. */
  readonly failure: Deferred.Deferred<ReplayError>;
  readonly assertConsumed: Effect.Effect<void, ReplayError>;
  /** Where the replay stands, for wait timeouts. */
  readonly describePosition: () => string;
  /** Releases parked gates; disposal runs it. */
  readonly releaseAll?: Effect.Effect<void>;
}

export interface IntegrationAdapter {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly replay?: IntegrationAdapterReplay;
}

/**
 * Builds the adapter for one driver kind inside the harness runtime, in place of the fake test
 * adapter: the real adapter over a replay transport, or (for `realCodex`) over the real CLI.
 * `kind` is known up front, so the harness fakes only the kinds no factory covers.
 */
export interface IntegrationAdapterFactory {
  readonly kind: ProviderDriverKind;
  readonly make: (context: {
    readonly rootDir: string;
    readonly workspaceDir: string;
  }) => Effect.Effect<
    IntegrationAdapter,
    never,
    | Scope.Scope
    | ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | ServerSettingsService
  >;
}

/** The real Codex adapter with default settings: it spawns the `codex` on PATH. */
export const realCodexAdapterFactory: IntegrationAdapterFactory = {
  kind: ProviderDriverKind.make("codex"),
  make: () =>
    makeCodexAdapter(Schema.decodeSync(CodexSettings)({})).pipe(
      Effect.map((adapter) => ({ adapter })),
    ),
};

interface MakeOrchestrationIntegrationHarnessOptions {
  readonly provider?: ProviderDriverKind;
  readonly providers?: ReadonlyArray<ProviderDriverKind>;
  /** Shorthand for `adapterFactories: [realCodexAdapterFactory]`. */
  readonly realCodex?: boolean;
  /** Real adapters for these kinds; every other requested kind keeps a fake test adapter. */
  readonly adapterFactories?: ReadonlyArray<IntegrationAdapterFactory>;
  /** Reopen an existing database file (a restart), instead of a fresh one. */
  readonly databasePath?: string;
}

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const provider =
      options?.provider ?? options?.providers?.[0] ?? ProviderDriverKind.make("codex");
    const adapterFactories = [
      ...(options?.realCodex === true ? [realCodexAdapterFactory] : []),
      ...(options?.adapterFactories ?? []),
    ];
    const factoryKinds = new Set(adapterFactories.map((factory) => factory.kind));
    const adapterHarnesses = yield* Effect.forEach(
      (options?.providers ?? [provider]).filter((driverKind) => !factoryKinds.has(driverKind)),
      (driverKind) =>
        makeTestProviderAdapterHarness({
          provider: driverKind,
          ...(options?.providers ? { turnIdPrefix: String(driverKind) } : {}),
        }),
    );
    const adapterHarness = adapterHarnesses[0] ?? null;
    const replays: Array<IntegrationAdapterReplay> = [];
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ryco-orchestration-integration-",
    });
    const workspaceDir = path.join(rootDir, "workspace");
    const derivedPaths = yield* deriveServerPaths(rootDir, undefined).pipe(
      Effect.provideService(Path.Path, path),
    );
    const stateDir = derivedPaths.stateDir;
    const dbPath = options?.databasePath ?? derivedPaths.dbPath;
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* initializeGitWorkspace(workspaceDir);

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
      write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
      read: () => Effect.succeed(null),
      remove: () => Effect.void,
    });
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(MockProjectAvatarStoreLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    // Factory adapters build with the runtime, so they live as long as it does.
    const adapterRegistryLayer = Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const adapterMap: KindAdapterMap = {};
        for (const harness of adapterHarnesses) {
          adapterMap[harness.provider] = harness.adapter;
        }
        for (const factory of adapterFactories) {
          const built = yield* factory.make({ rootDir, workspaceDir });
          adapterMap[factory.kind] = built.adapter;
          if (built.replay) replays.push(built.replay);
        }
        return makeAdapterRegistryMock(adapterMap);
      }),
    );
    const providerEventLoggersLayer = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(adapterRegistryLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(providerEventLoggersLayer),
    );

    const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistry.layer));
    const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;
    const runtimeServicesLayer = Layer.mergeAll(
      projectionSnapshotQueryLayer,
      orchestrationLayer.pipe(Layer.provide(projectionSnapshotQueryLayer)),
      ProjectionCheckpointRepositoryLive,
      ProjectionPendingApprovalRepositoryLive,
      checkpointStoreLayer,
      providerLayer,
      RuntimeReceiptBusTest,
    ).pipe(
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadSessionModelSelections.layer),
    );
    const serverSettingsLayer = ServerSettingsService.layerTest();
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const gitWorkflowLayer = Layer.mock(GitWorkflowService)({
      assertWorktreeSetupComplete: (checkoutPath) =>
        assertWorktreeSetupComplete(stateDir, checkoutPath),
      renameBranch: (input: Parameters<GitVcsDriver.GitVcsDriverShape["renameBranch"]>[0]) =>
        Effect.succeed({ branch: input.newBranch }),
    });
    const textGenerationLayer = Layer.succeed(TextGeneration, {
      generateBranchName: () => Effect.succeed({ branch: "update" }),
      generateThreadTitle: () => Effect.succeed({ title: "New thread" }),
    } as unknown as TextGenerationShape);
    const contextHandoffRepositoryLayer = ContextHandoffRepositoryLive;
    const contextHandoffServiceLayer = ContextHandoffServiceLive.pipe(
      Layer.provideMerge(contextHandoffRepositoryLayer),
    );
    const providerRegistryLayer = Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed([]),
      streamChanges: Stream.empty,
    });
    const contextHandoffCoordinatorLayer = ContextHandoffCoordinatorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(contextHandoffServiceLayer),
      Layer.provideMerge(contextHandoffRepositoryLayer),
      Layer.provideMerge(providerRegistryLayer),
    );
    const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(contextHandoffCoordinatorLayer),
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(gitWorkflowLayer),
      Layer.provideMerge(textGenerationLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const checkpointReactorLayer = CheckpointReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(LocalDiagnosticsMetricsLive),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
          streamStatus: () => Stream.empty,
        }),
      ),
      Layer.provideMerge(
        WorkspaceEntriesLive.pipe(
          Layer.provide(WorkspacePathsLive),
          Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
          Layer.provideMerge(VcsDriverRegistry.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(VcsProcess.layer),
    );
    const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
      Layer.provideMerge(contextHandoffCoordinatorLayer),
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(providerCommandReactorLayer),
      Layer.provideMerge(checkpointReactorLayer),
      Layer.provideMerge(
        Layer.succeed(ThreadDeletionReactor, {
          start: () => Effect.void,
          drainThrough: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ThreadPurgeReactor, {
          start: () => Effect.void,
          awaitStartupSweep: Effect.succeed(null),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ThreadGitMetadataReactor, {
          start: () => Effect.void,
          drain: Effect.void,
        }),
      ),
    );
    const layer = Layer.empty.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(orchestrationReactorLayer),
      Layer.provideMerge(contextHandoffRepositoryLayer),
      Layer.provideMerge(LocalDiagnosticsMetricsLive),
      Layer.provide(persistenceLayer),
      Layer.provideMerge(RepositoryIdentityResolverLive),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);
    const checkpointStore = yield* tryRuntimePromise("load CheckpointStore service", () =>
      runtime.runPromise(Effect.service(CheckpointStore)),
    ).pipe(Effect.orDie);
    const checkpointRepository = yield* tryRuntimePromise(
      "load ProjectionCheckpointRepository service",
      () => runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
    ).pipe(Effect.orDie);
    const pendingApprovalRepository = yield* tryRuntimePromise(
      "load ProjectionPendingApprovalRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
    ).pipe(Effect.orDie);
    const contextHandoffRepository = yield* tryRuntimePromise(
      "load ContextHandoffRepository service",
      () => runtime.runPromise(Effect.service(ContextHandoffRepository)),
    ).pipe(Effect.orDie);
    const runtimeReceiptBus = yield* tryRuntimePromise("load RuntimeReceiptBus service", () =>
      runtime.runPromise(Effect.service(RuntimeReceiptBus)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    yield* tryRuntimePromise("start OrchestrationReactor", () =>
      runtime.runPromise(reactor.start().pipe(Scope.provide(scope))),
    ).pipe(Effect.orDie);
    const receiptHistory = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
    yield* Stream.runForEach(runtimeReceiptBus.streamEventsForTest, (receipt) =>
      Ref.update(receiptHistory, (history) => [...history, receipt]).pipe(Effect.asVoid),
    ).pipe(Effect.forkIn(scope));
    yield* Effect.sleep(10);

    /** A replay mismatch fails a wait at once, with the diff, instead of after its timeout. */
    const raceReplays = <A>(wait: Effect.Effect<A, never>): Effect.Effect<A, never> =>
      replays
        .reduce<Effect.Effect<A, ReplayError>>(
          (current, replay) => current.pipe(raceReplayFailure(replay.failure)),
          wait,
        )
        .pipe(Effect.orDie);
    const withReplayPositions = (description: string) => () =>
      replays.length === 0
        ? description
        : `${description}; ${replays.map((replay) => replay.describePosition()).join("; ")}`;

    const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
      threadId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        snapshotQuery
          .getSnapshot()
          .pipe(
            Effect.map(
              (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
            ),
          ),
        (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
        withReplayPositions(`projected thread '${threadId}'`),
        timeoutMs,
      ).pipe(raceReplays) as Effect.Effect<OrchestrationThread, never>;

    const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
        ),
        (events) => events.some(predicate),
        withReplayPositions("domain event"),
        timeoutMs,
      ).pipe(raceReplays);

    const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
      threadId,
      requestId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        pendingApprovalRepository
          .getByRequestId({ threadId, requestId: ApprovalRequestId.make(requestId) })
          .pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => null,
                onSome: (value) => ({
                  status: value.status,
                  decision: value.decision,
                  resolvedAt: value.resolvedAt,
                }),
              }),
            ),
          ),
        (
          row,
        ): row is {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        } => row !== null && predicate(row),
        withReplayPositions(`pending approval '${requestId}'`),
        timeoutMs,
      ).pipe(raceReplays) as Effect.Effect<
        {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        },
        never
      >;

    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    function waitForReceipt<Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ) {
      const readMatchingReceipt = Ref.get(receiptHistory).pipe(
        Effect.map((history) => history.find(predicate)),
      );

      return waitFor(
        readMatchingReceipt,
        (receipt): receipt is OrchestrationRuntimeReceipt => receipt !== undefined,
        withReplayPositions("runtime receipt"),
        timeoutMs,
      ).pipe(raceReplays);
    }

    const waitForReplayGate: OrchestrationIntegrationHarness["waitForReplayGate"] = (
      gate,
      label,
      timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    ) =>
      gate.reached(label).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.die(
              new WaitForTimeoutError({
                description: withReplayPositions(`replay gate '${label}'`)(),
              }),
            ),
        }),
        raceReplays,
      );

    const assertNoLateReplayFrames = Effect.forEach(
      replays,
      (replay) =>
        Deferred.poll(replay.failure).pipe(
          Effect.flatMap((failed) =>
            Option.isSome(failed) ? Effect.flatMap(failed.value, Effect.fail) : Effect.void,
          ),
        ),
      { discard: true },
    );

    let disposed = false;
    const dispose = Effect.gen(function* () {
      if (disposed) {
        return;
      }
      disposed = true;
      // A replay parked at a gate must not hold up shutdown.
      yield* Effect.forEach(replays, (replay) => replay.releaseAll ?? Effect.void, {
        discard: true,
      });

      const shutdown = Effect.gen(function* () {
        const closeScopeExit = yield* Effect.exit(Scope.close(scope, Exit.void));
        const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

        const failureCause = Exit.isFailure(closeScopeExit)
          ? closeScopeExit.cause
          : Exit.isFailure(disposeRuntimeExit)
            ? disposeRuntimeExit.cause
            : null;

        if (failureCause) {
          return yield* Effect.failCause(failureCause);
        }
      });

      yield* shutdown;
    });

    return {
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness,
      adapterHarnesses,
      engine,
      snapshotQuery,
      providerService,
      checkpointStore,
      checkpointRepository,
      pendingApprovalRepository,
      contextHandoffRepository,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      waitForReceipt,
      waitForReplayGate,
      replays,
      dispose,
      assertNoLateReplayFrames,
    } satisfies OrchestrationIntegrationHarness;
  });
