import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@ryco/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { TEST_GIT_COMMIT_IDENTITY_CONFIG } from "../../vcs/testing/GitTestRepo.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { LocalDiagnosticsMetricsLive } from "../../observability/Services/LocalDiagnosticsMetrics.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import type { CheckpointStoreShape } from "../../checkpointing/Services/CheckpointStore.ts";
import { CheckpointInvariantError } from "../../checkpointing/Errors.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  ProviderAdapterRequestError,
  ProviderOperationTimeoutError,
  ProviderOperationUnsupportedError,
} from "../../provider/Errors.ts";
import { makeCheckpointRevertActivity } from "../checkpointRevertPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceAccessPolicyLayer } from "../../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
    () => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    startFreshSession: () => unsupported(),
    getSession: () => Effect.succeed(Option.none()),
    restoreSessionBinding: () => Effect.succeed(false),
    retireSessionBinding: () => Effect.succeed(false),
    stopSessionBinding: () => Effect.succeed("not-found"),
    listStaleSessionBindings: () => Effect.succeed([]),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    stopBackgroundTask: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly latestTurn: { readonly turnId: string } | null;
      readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
      readonly activities: ReadonlyArray<{ readonly kind: string }>;
    }>;
  }>,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function readAllEvents(engine: OrchestrationEngineShape) {
  return Effect.runPromise(
    Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
  );
}

type RevertActivityPayload = {
  readonly status: string;
  readonly reason?: string;
  readonly detail?: string;
};

/** Every recorded phase of one checkpoint revert, in event order. */
async function revertStatuses(engine: OrchestrationEngineShape, commandId: string) {
  return (await readAllEvents(engine)).flatMap((event) =>
    event.type === "thread.activity-appended" &&
    event.payload.activity.id === `checkpoint-revert:${commandId}`
      ? [(event.payload.activity.payload as RevertActivityPayload).status]
      : [],
  );
}

async function waitForRevertStatus(
  engine: OrchestrationEngineShape,
  commandId: string,
  status: string,
  timeoutMs = 15_000,
): Promise<RevertActivityPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = (await readAllEvents(engine)).findLast(
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.activity.id === `checkpoint-revert:${commandId}`,
    );
    const payload =
      match?.type === "thread.activity-appended"
        ? (match.payload.activity.payload as RevertActivityPayload)
        : undefined;
    if (payload?.status === status) return payload;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for revert ${commandId} to reach ${status}; last: ${JSON.stringify(payload)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  for (const [key, value] of TEST_GIT_COMMIT_IDENTITY_CONFIG) {
    runGit(cwd, ["config", key, value]);
  }
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | CheckpointReactor | CheckpointStore | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly gitStatusRefreshCalls?: Array<string>;
    /** Fault injection: wrap the services the reactor sees. */
    readonly wrapEngine?: (engine: OrchestrationEngineShape) => OrchestrationEngineShape;
    readonly wrapCheckpointStore?: (store: CheckpointStoreShape) => CheckpointStoreShape;
    readonly wrapSnapshotQuery?: (
      query: ProjectionSnapshotQueryShape,
    ) => ProjectionSnapshotQueryShape;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(
        Layer.succeed(ProjectAvatarStore, {
          write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
          read: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      ),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const baseProjectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const wrapSnapshotQuery = options?.wrapSnapshotQuery;
    const projectionSnapshotLayer = wrapSnapshotQuery
      ? Layer.effect(
          ProjectionSnapshotQuery,
          Effect.map(Effect.service(ProjectionSnapshotQuery), wrapSnapshotQuery),
        ).pipe(Layer.provide(baseProjectionSnapshotLayer))
      : baseProjectionSnapshotLayer;
    const wrapEngine = options?.wrapEngine;
    const engineLayer = wrapEngine
      ? Layer.effect(
          OrchestrationEngineService,
          Effect.map(Effect.service(OrchestrationEngineService), wrapEngine),
        ).pipe(Layer.provide(orchestrationLayer))
      : orchestrationLayer;
    const baseCheckpointStoreLayer = CheckpointStoreLive.pipe(
      Layer.provide(VcsDriverRegistry.layer),
    );
    const wrapCheckpointStore = options?.wrapCheckpointStore;
    const checkpointStoreLayer = wrapCheckpointStore
      ? Layer.effect(
          CheckpointStore,
          Effect.map(Effect.service(CheckpointStore), wrapCheckpointStore),
        ).pipe(Layer.provide(baseCheckpointStoreLayer))
      : baseCheckpointStoreLayer;

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "ryco-checkpoint-reactor-test-",
    });
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      streamStatus: () => Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(LocalDiagnosticsMetricsLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(
        WorkspaceEntriesLive.pipe(
          Layer.provide(WorkspacePathsLive),
          Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      provider,
      cwd,
      drain,
      reactor,
      createdAt,
    };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  /** Simulates ProviderRuntimeIngestion projecting turn.started and turn.completed. */
  const projectIngestedTurn = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    turnId: TurnId,
    phase: "started" | "completed",
    at: string,
  ) => {
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-ingested-${phase}-${turnId}`),
        threadId,
        session: {
          threadId,
          status: phase === "started" ? "running" : "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: phase === "started" ? turnId : null,
          lastError: null,
          updatedAt: at,
        },
        ...(phase === "completed"
          ? {
              turnOutcome: {
                turnId,
                state: "completed" as const,
                reason: "provider-turn-completed",
                completedAt: at,
              },
            }
          : {}),
        createdAt: at,
      }),
    );
  };

  it("keeps the released turn state and completedAt when the checkpoint capture lands later", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const turnId = asTurnId("turn-release-then-capture");
    await projectIngestedTurn(harness, turnId, "started", "2026-03-01T00:00:01.000Z");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-release-then-capture"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-03-01T00:00:01.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId,
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    // The release finalizes the turn before the capture runs.
    const releasedAt = "2026-03-01T00:00:05.000Z";
    await projectIngestedTurn(harness, turnId, "completed", releasedAt);
    // Engine dispatch projects synchronously, so the release is already visible.
    const readThread = async () =>
      (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect((await readThread())?.latestTurn).toMatchObject({
      turnId,
      state: "completed",
      completedAt: releasedAt,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-release-then-capture"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-03-01T00:00:09.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId,
      payload: { state: "completed" },
    });
    await waitForThread(harness.readModel, (entry) => entry.checkpoints.length === 1);
    const thread = await readThread();
    expect(thread?.latestTurn).toMatchObject({
      turnId,
      state: "completed",
      completedAt: releasedAt,
    });
    expect(thread?.checkpoints[0]).toMatchObject({ turnId, status: "ready" });
  });

  it("leaves a released turn completed when its checkpoint capture fails", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const turnId = asTurnId("turn-release-capture-fails");
    // No turn.started reaches the reactor, so there is no baseline and capture fails.
    await projectIngestedTurn(harness, turnId, "started", "2026-03-01T00:00:01.000Z");
    const releasedAt = "2026-03-01T00:00:05.000Z";
    await projectIngestedTurn(harness, turnId, "completed", releasedAt);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-capture-fails"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-03-01T00:00:09.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId,
      payload: { state: "completed" },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect(thread?.latestTurn).toMatchObject({
      turnId,
      state: "completed",
      completedAt: releasedAt,
    });
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-baseline"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "ryco-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: new Date().toISOString(),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
      targetTurnId: asTurnId("turn-1"),
      droppedTurnIds: [asTurnId("turn-2")],
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    await waitForRevertStatus(harness.engine, "cmd-revert-request", "completed");
    expect(await revertStatuses(harness.engine, "cmd-revert-request")).toEqual([
      "requested",
      "rolling-back",
      "restoring-files",
      "completed",
    ]);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
      targetTurnId: asTurnId("turn-claude-1"),
      droppedTurnIds: [asTurnId("turn-claude-2")],
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    // A second revert is only admitted once the first one finished.
    await waitForRevertStatus(harness.engine, "cmd-sequenced-revert-request-1", "completed");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
      targetTurnId: asTurnId("turn-1"),
      droppedTurnIds: [asTurnId("turn-2")],
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
      targetTurnId: null,
      droppedTurnIds: [asTurnId("turn-1")],
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
  });

  async function seedCheckpoints(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: { readonly completedAt?: ReadonlyArray<string>; readonly sessionStatus?: "ready" } = {},
  ) {
    const createdAt = new Date().toISOString();
    if (input.sessionStatus) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-seed-session"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: input.sessionStatus,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
    }
    for (const count of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-seed-diff-${count}`),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`turn-${count}`),
          completedAt: input.completedAt?.[count - 1] ?? createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), count),
          status: "ready",
          files: [],
          checkpointTurnCount: count,
          createdAt,
        }),
      );
    }
  }

  async function createNeighbour(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly worktreePath?: string | null;
      readonly running?: boolean;
      readonly lastActivityAt?: string;
    } = {},
  ) {
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.make("thread-2");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-2-create"),
        threadId,
        projectId: asProjectId("project-1"),
        title: "Neighbour",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: input.worktreePath ?? null,
        createdAt,
      }),
    );
    if (input.lastActivityAt) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-thread-2-diff"),
          threadId,
          turnId: asTurnId("turn-neighbour"),
          completedAt: input.lastActivityAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
          status: "ready",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        }),
      );
    }
    if (input.running) {
      await Effect.runPromise(markNeighbourRunning(harness.engine));
    }
    return threadId;
  }

  function markNeighbourRunning(engine: OrchestrationEngineShape) {
    const now = new Date().toISOString();
    return engine
      .dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-thread-2-running-${crypto.randomUUID()}`),
        threadId: ThreadId.make("thread-2"),
        session: {
          threadId: ThreadId.make("thread-2"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-neighbour-running"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      })
      .pipe(Effect.asVoid, Effect.orDie);
  }

  async function requestRevert(
    harness: Awaited<ReturnType<typeof createHarness>>,
    commandId: string,
    turnCount: number,
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make("thread-1"),
        turnCount,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  const readme = (cwd: string) => fs.readFileSync(path.join(cwd, "README.md"), "utf8");
  const ref = (count: number) => checkpointRefForThreadTurn(ThreadId.make("thread-1"), count);
  const hasReverted = async (engine: OrchestrationEngineShape) =>
    (await readAllEvents(engine)).some((event) => event.type === "thread.reverted");

  it("leaves files and history untouched when the provider rollback fails", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/rollback",
          detail: "boom",
        }),
      ),
    );

    await requestRevert(harness, "cmd-revert-provider-fails", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-provider-fails",
      "failed",
    );

    expect(activity.reason).toBe("provider-failed");
    // The adapter's own detail, not its internal "Provider adapter request failed" wrapper.
    expect(activity.detail).toBe(
      "Ryco could not rewind the agent's conversation. boom. Nothing was changed.",
    );
    expect(readme(harness.cwd)).toBe("v3\n");
    expect(gitRefExists(harness.cwd, ref(2))).toBe(true);
    expect(await hasReverted(harness.engine)).toBe(false);
  });

  it("says nothing was changed only once when the provider already says so", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "thread/rollback",
          detail:
            "Claude refused to rewind this conversation, so nothing was changed. Resume rejected",
        }),
      ),
    );

    await requestRevert(harness, "cmd-revert-claude-refused", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-claude-refused",
      "failed",
    );

    expect(activity.detail).toBe(
      "Ryco could not rewind the agent's conversation. Claude refused to rewind this conversation, so nothing was changed. Resume rejected.",
    );
  });

  it("never says nothing was changed when Ryco stopped waiting for the rewind itself", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderOperationTimeoutError({
          provider: "codex",
          operation: "conversation.rollback",
          timeoutMs: 150_000,
          detail:
            "Provider 'codex' did not confirm the conversation rewind within 150s; it may or may not have been applied.",
        }),
      ),
    );

    await requestRevert(harness, "cmd-revert-provider-times-out", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-provider-times-out",
      "interrupted",
    );

    expect(activity.reason).toBe("provider-failed");
    expect(activity.detail).toContain("it may or may not have been applied.");
    expect(activity.detail).toContain("The agent may already have forgotten the newer turns");
    expect(activity.detail).not.toContain("Nothing was changed");
    expect(readme(harness.cwd)).toBe("v3\n");
    expect(await hasReverted(harness.engine)).toBe(false);
  });

  it("marks the revert interrupted when the provider rollback dies midway", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.die(new Error("adapter crashed")),
    );

    await requestRevert(harness, "cmd-revert-provider-dies", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-provider-dies",
      "interrupted",
    );

    expect(activity.reason).toBe("provider-failed");
    expect(activity.detail).toContain("The agent may already have forgotten the newer turns");
    expect(activity.detail).not.toContain("adapter crashed");
    expect(readme(harness.cwd)).toBe("v3\n");
    expect(await hasReverted(harness.engine)).toBe(false);
  });

  it("does not call the provider when the rolling-back phase cannot be journaled", async () => {
    const harness = await createHarness({
      wrapEngine: (engine) =>
        Object.assign(Object.create(engine) as OrchestrationEngineShape, {
          dispatch: ((command, options) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "checkpoint.revert" &&
            (command.activity.payload as { status?: string }).status === "rolling-back"
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "journal unavailable",
                  }),
                )
              : engine.dispatch(command, options)) satisfies OrchestrationEngineShape["dispatch"],
        }),
    });
    await seedCheckpoints(harness, { sessionStatus: "ready" });

    await requestRevert(harness, "cmd-revert-journal-fails", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-journal-fails",
      "failed",
    );

    expect(activity.reason).toBe("internal-error");
    expect(activity.detail).toBe(
      "Ryco could not record the revert before rewinding the agent's conversation. Nothing was changed.",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(readme(harness.cwd)).toBe("v3\n");
  });

  it("still projects the revert when the checkpoint store fails after the provider rewound", async () => {
    let storeDown = false;
    const harness = await createHarness({
      wrapCheckpointStore: (store) => ({
        ...store,
        hasCheckpointRef: (input) =>
          storeDown
            ? Effect.fail(
                new CheckpointInvariantError({
                  operation: "hasCheckpointRef",
                  detail: "git is locked",
                }),
              )
            : store.hasCheckpointRef(input),
      }),
    });
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.sync(() => {
        storeDown = true;
      }),
    );

    await requestRevert(harness, "cmd-revert-store-fails", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-store-fails",
      "files-not-restored",
    );

    expect(await hasReverted(harness.engine)).toBe(true);
    expect(activity.reason).toBe("files-failed");
    expect(activity.detail).toContain("git is locked");
    expect(activity.detail).toContain("The checkout still contains changes from those turns.");
    expect(readme(harness.cwd)).toBe("v3\n");
  });

  // git restore rewrote README, then a later step (clean/reset) failed.
  const partlyRestoringStore = (store: CheckpointStoreShape): CheckpointStoreShape => ({
    ...store,
    restoreCheckpoint: (input) =>
      store.restoreCheckpoint(input).pipe(
        Effect.andThen(
          Effect.fail(
            new CheckpointInvariantError({
              operation: "restoreCheckpoint",
              detail: "git clean failed",
            }),
          ),
        ),
      ),
  });

  it("says files may be partly restored when a restore fails midway after the provider rewound", async () => {
    const harness = await createHarness({ wrapCheckpointStore: partlyRestoringStore });
    await seedCheckpoints(harness, { sessionStatus: "ready" });

    await requestRevert(harness, "cmd-revert-partial", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-partial",
      "files-not-restored",
    );

    expect(await hasReverted(harness.engine)).toBe(true);
    expect(activity.reason).toBe("files-failed");
    expect(activity.detail).toBe(
      "The agent forgot the discarded turns, but files may be only partly restored: git clean failed. Review them in Changes or with git before continuing.",
    );
    expect(readme(harness.cwd)).toBe("v2\n");
  });

  it("does not claim nothing changed when a files-only revert fails midway", async () => {
    const harness = await createHarness({ wrapCheckpointStore: partlyRestoringStore });
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "edited\n", "utf8");

    await requestRevert(harness, "cmd-revert-files-only-partial", 2);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-files-only-partial",
      "failed",
    );

    expect(activity.reason).toBe("files-failed");
    expect(activity.detail).toBe(
      "Files may be only partly restored: git clean failed. Review them in Changes or with git before continuing.",
    );
    expect(readme(harness.cwd)).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("rolls the provider back before restoring files", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    let readmeAtRollback: string | null = null;
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.sync(() => {
        readmeAtRollback = readme(harness.cwd);
      }),
    );

    await requestRevert(harness, "cmd-revert-ordering", 1);
    await waitForRevertStatus(harness.engine, "cmd-revert-ordering", "completed");

    expect(readmeAtRollback).toBe("v3\n");
    expect(readme(harness.cwd)).toBe("v2\n");
  });

  it("refuses providers that cannot roll back without touching files", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderOperationUnsupportedError({
          provider: "cursor",
          operation: "rollbackConversation",
          detail:
            "Cursor can't remove turns from its conversation, so this thread can't be reverted. Start a new thread to try a different approach.",
        }),
      ),
    );

    await requestRevert(harness, "cmd-revert-unsupported", 1);
    const activity = await waitForRevertStatus(harness.engine, "cmd-revert-unsupported", "failed");

    expect(activity.reason).toBe("provider-unsupported");
    expect(activity.detail).toContain("Cursor can't remove turns from its conversation");
    expect(readme(harness.cwd)).toBe("v3\n");
    expect(gitRefExists(harness.cwd, ref(2))).toBe(true);
  });

  it("refuses a revert while another thread is working in the same checkout", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    await createNeighbour(harness, { worktreePath: null, running: true });

    await requestRevert(harness, "cmd-revert-shared-busy", 1);
    const activity = await waitForRevertStatus(harness.engine, "cmd-revert-shared-busy", "failed");

    expect(activity.reason).toBe("shared-checkout");
    expect(activity.detail).toBe(
      'Nothing was changed. "Neighbour" is working in this checkout. Wait for it to finish, or give this thread its own worktree.',
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(readme(harness.cwd)).toBe("v3\n");
  });

  it("refuses when an idle neighbour changed the checkout after the target checkpoint", async () => {
    const base = Date.now() - 60_000;
    const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    const harness = await createHarness();
    await seedCheckpoints(harness, {
      sessionStatus: "ready",
      completedAt: [iso(0), iso(20_000)],
    });
    await createNeighbour(harness, { worktreePath: null, lastActivityAt: iso(10_000) });

    await requestRevert(harness, "cmd-revert-shared-newer", 1);
    const activity = await waitForRevertStatus(harness.engine, "cmd-revert-shared-newer", "failed");

    expect(activity.reason).toBe("shared-checkout");
    expect(activity.detail).toContain('"Neighbour" changed this checkout after checkpoint 1');
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(readme(harness.cwd)).toBe("v3\n");
  });

  it("proceeds when an idle neighbour's last activity predates the target checkpoint", async () => {
    const base = Date.now() - 60_000;
    const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    const harness = await createHarness();
    await seedCheckpoints(harness, {
      sessionStatus: "ready",
      completedAt: [iso(10_000), iso(20_000)],
    });
    await createNeighbour(harness, { worktreePath: null, lastActivityAt: iso(0) });

    await requestRevert(harness, "cmd-revert-shared-older", 1);
    await waitForRevertStatus(harness.engine, "cmd-revert-shared-older", "completed");

    expect(readme(harness.cwd)).toBe("v2\n");
  });

  it("proceeds while a neighbour works in a nested worktree", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    const nested = path.join(harness.cwd, ".ryco", "worktrees", "n");
    runGit(harness.cwd, ["worktree", "add", "-b", "nested", nested]);
    await createNeighbour(harness, { worktreePath: nested, running: true });

    await requestRevert(harness, "cmd-revert-nested", 1);
    await waitForRevertStatus(harness.engine, "cmd-revert-nested", "completed");

    expect(readme(harness.cwd)).toBe("v2\n");
    expect(fs.existsSync(path.join(nested, "README.md"))).toBe(true);
  });

  it("refuses a HEAD-fallback restore of checkpoint 0 in a shared checkout", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    runGit(harness.cwd, ["update-ref", "-d", ref(0)]);
    await createNeighbour(harness, {
      worktreePath: null,
      lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    await requestRevert(harness, "cmd-revert-head-shared", 0);
    const activity = await waitForRevertStatus(harness.engine, "cmd-revert-head-shared", "failed");

    expect(activity.reason).toBe("shared-checkout");
    expect(activity.detail).toContain("Checkpoint 0 is missing");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(readme(harness.cwd)).toBe("v3\n");
  });

  it("restores checkpoint 0 from HEAD when no other thread shares the checkout", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    runGit(harness.cwd, ["update-ref", "-d", ref(0)]);

    await requestRevert(harness, "cmd-revert-head-alone", 0);
    await waitForRevertStatus(harness.engine, "cmd-revert-head-alone", "completed");

    expect(readme(harness.cwd)).toBe("v1\n");
  });

  it("reports files-not-restored when the checkout becomes shared after the provider rewound", async () => {
    const harness = await createHarness();
    await seedCheckpoints(harness, { sessionStatus: "ready" });
    await createNeighbour(harness, { worktreePath: null });
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      markNeighbourRunning(harness.engine),
    );

    await requestRevert(harness, "cmd-revert-files-fail", 1);
    const activity = await waitForRevertStatus(
      harness.engine,
      "cmd-revert-files-fail",
      "files-not-restored",
    );

    expect(await hasReverted(harness.engine)).toBe(true);
    expect(activity.reason).toBe("shared-checkout");
    expect(activity.detail).toContain(
      "The agent forgot the discarded turns, but files were not restored:",
    );
    expect(activity.detail).toContain(
      "The checkout still contains changes from those turns. Review them in Changes or with git before continuing.",
    );
    expect(readme(harness.cwd)).toBe("v3\n");
    expect(gitRefExists(harness.cwd, ref(2))).toBe(false);

    // API-level recovery: once the checkout is no longer shared, reverting to the
    // current checkpoint restores files without another provider call.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.trash",
        commandId: CommandId.make("cmd-thread-2-delete"),
        threadId: ThreadId.make("thread-2"),
      }),
    );
    await requestRevert(harness, "cmd-revert-files-retry", 1);
    await waitForRevertStatus(harness.engine, "cmd-revert-files-retry", "completed");

    expect(readme(harness.cwd)).toBe("v2\n");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
  });

  it("reverts without a live provider session using the thread workspace", async () => {
    const harness = await createHarness({ hasSession: false });
    await seedCheckpoints(harness);

    await requestRevert(harness, "cmd-revert-no-session", 1);
    await waitForRevertStatus(harness.engine, "cmd-revert-no-session", "completed");

    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
      targetTurnId: asTurnId("turn-1"),
      droppedTurnIds: [asTurnId("turn-2")],
    });
    expect(readme(harness.cwd)).toBe("v2\n");
  });

  describe("startup recovery", () => {
    async function seedRevertActivity(
      harness: Awaited<ReturnType<typeof createHarness>>,
      input: {
        readonly threadId?: ThreadId;
        readonly revertRequestId: string;
        readonly status: "requested" | "rolling-back" | "restoring-files";
        readonly cwd?: string;
        readonly createdAt?: string;
      },
    ) {
      const createdAt = input.createdAt ?? new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`cmd-seed-${input.revertRequestId}`),
          threadId: input.threadId ?? ThreadId.make("thread-1"),
          activity: makeCheckpointRevertActivity({
            revertRequestId: CommandId.make(input.revertRequestId),
            turnCount: 1,
            fromTurnCount: 2,
            status: input.status,
            cwd: input.cwd,
            createdAt,
          }),
          createdAt,
        }),
      );
    }

    const revertedEventCount = async (engine: OrchestrationEngineShape) =>
      (await readAllEvents(engine)).filter((event) => event.type === "thread.reverted").length;

    it("does not finish a revert when the thread moved past it before the restart", async () => {
      const harness = await createHarness();
      await seedCheckpoints(harness, { sessionStatus: "ready" });
      await seedRevertActivity(harness, {
        revertRequestId: "cmd-recover-moved-on",
        status: "restoring-files",
        cwd: harness.cwd,
      });
      // The pending revert went stale and the user kept working: turn 3 landed.
      fs.writeFileSync(path.join(harness.cwd, "README.md"), "v4\n", "utf8");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-seed-diff-3"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-3"),
          completedAt: new Date(Date.now() + 1_000).toISOString(),
          checkpointRef: ref(3),
          status: "ready",
          files: [],
          checkpointTurnCount: 3,
          createdAt: new Date().toISOString(),
        }),
      );

      await Effect.runPromise(harness.reactor.recover());
      const activity = await waitForRevertStatus(
        harness.engine,
        "cmd-recover-moved-on",
        "interrupted",
      );

      expect(activity.reason).toBe("restart");
      expect(activity.detail).toContain("this thread changed afterwards");
      // Files may already have been restored before the crash; say so.
      expect(activity.detail).toContain("files may be partly restored");
      expect(activity.detail).not.toContain("Files and history were not changed");
      expect(await hasReverted(harness.engine)).toBe(false);
      expect(readme(harness.cwd)).toBe("v4\n");
      expect(gitRefExists(harness.cwd, ref(2))).toBe(true);
    });

    it("does not finish a revert when the thread gained a message without a new checkpoint", async () => {
      const harness = await createHarness();
      await seedCheckpoints(harness, { sessionStatus: "ready" });
      // A message stamped after the journal entry (a client clock running ahead),
      // whose turn produced no checkpoint before Ryco restarted.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-recover-new-message"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-after-revert"),
            role: "user",
            text: "keep going",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      await seedRevertActivity(harness, {
        revertRequestId: "cmd-recover-new-message",
        status: "restoring-files",
        cwd: harness.cwd,
      });
      fs.writeFileSync(path.join(harness.cwd, "README.md"), "in-flight edit\n", "utf8");

      await Effect.runPromise(harness.reactor.recover());
      const activity = await waitForRevertStatus(
        harness.engine,
        "cmd-recover-new-message",
        "interrupted",
      );

      expect(activity.detail).toContain("this thread changed afterwards");
      expect(await hasReverted(harness.engine)).toBe(false);
      expect(readme(harness.cwd)).toBe("in-flight edit\n");
      expect(gitRefExists(harness.cwd, ref(2))).toBe(true);
    });

    it("projects a stale revert the provider already finished without restoring files", async () => {
      const base = Date.now() - 30 * 60_000;
      const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();
      const harness = await createHarness();
      await seedCheckpoints(harness, {
        sessionStatus: "ready",
        completedAt: [iso(0), iso(60_000)],
      });
      await seedRevertActivity(harness, {
        revertRequestId: "cmd-recover-stale",
        status: "restoring-files",
        cwd: harness.cwd,
        createdAt: iso(120_000),
      });

      await Effect.runPromise(harness.reactor.recover());
      const activity = await waitForRevertStatus(
        harness.engine,
        "cmd-recover-stale",
        "files-not-restored",
      );

      // The agent already forgot turn 2, so the conversation must follow; the
      // checkout may hold newer work, so files are left alone.
      expect(activity.reason).toBe("restart");
      expect(activity.detail).toBe(
        "The agent forgot the discarded turns, but files may be only partly restored: Ryco stopped while restoring them too long ago to finish safely. Review them in Changes or with git before continuing.",
      );
      expect(await revertedEventCount(harness.engine)).toBe(1);
      expect(readme(harness.cwd)).toBe("v3\n");
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      const thread = await waitForThread(
        harness.readModel,
        (entry) => entry.checkpoints.length === 1,
      );
      expect(thread.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    });

    it("does not revert again when only the final status was lost", async () => {
      const harness = await createHarness();
      await seedCheckpoints(harness, { sessionStatus: "ready" });
      await seedRevertActivity(harness, {
        revertRequestId: "cmd-recover-projected",
        status: "restoring-files",
        cwd: harness.cwd,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.revert.complete",
          commandId: CommandId.make("cmd-recover-projected-complete"),
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
          droppedTurnIds: [asTurnId("turn-2")],
          createdAt: new Date().toISOString(),
        }),
      );

      await Effect.runPromise(harness.reactor.recover());
      const activity = await waitForRevertStatus(
        harness.engine,
        "cmd-recover-projected",
        "interrupted",
      );

      expect(activity.detail).toContain("The conversation was reverted to checkpoint 1");
      expect(await revertedEventCount(harness.engine)).toBe(1);
      expect(readme(harness.cwd)).toBe("v3\n");
    });

    it("keeps recovering other threads when one thread's recovery fails", async () => {
      let detailReadsFail = false;
      const harness = await createHarness({
        wrapSnapshotQuery: (query) => ({
          ...query,
          getThreadDetailById: (threadId) =>
            detailReadsFail && threadId === ThreadId.make("thread-1")
              ? Effect.fail(
                  new PersistenceSqlError({
                    operation: "getThreadDetailById",
                    detail: "database is locked",
                  }),
                )
              : query.getThreadDetailById(threadId),
        }),
      });
      await seedCheckpoints(harness, { sessionStatus: "ready" });
      await createNeighbour(harness, { worktreePath: "/tmp/ryco-unrelated-neighbour" });
      await seedRevertActivity(harness, {
        revertRequestId: "cmd-recover-broken",
        status: "restoring-files",
        cwd: harness.cwd,
      });
      await seedRevertActivity(harness, {
        threadId: ThreadId.make("thread-2"),
        revertRequestId: "cmd-recover-after-broken",
        status: "requested",
      });
      detailReadsFail = true;

      await Effect.runPromise(harness.reactor.recover());

      // thread-1 sorts first; its failure must not leave thread-2 pending.
      const failed = await waitForRevertStatus(
        harness.engine,
        "cmd-recover-after-broken",
        "failed",
      );
      expect(failed.reason).toBe("restart");
      const broken = await waitForRevertStatus(harness.engine, "cmd-recover-broken", "interrupted");
      expect(broken.reason).toBe("restart");
      expect(readme(harness.cwd)).toBe("v3\n");
    });

    it("finishes a revert that stopped while restoring files", async () => {
      const harness = await createHarness();
      await seedCheckpoints(harness, { sessionStatus: "ready" });
      await seedRevertActivity(harness, {
        revertRequestId: "cmd-recover-restoring",
        status: "restoring-files",
        cwd: harness.cwd,
      });

      await Effect.runPromise(harness.reactor.recover());
      await waitForRevertStatus(harness.engine, "cmd-recover-restoring", "completed");

      expect(await hasReverted(harness.engine)).toBe(true);
      expect(readme(harness.cwd)).toBe("v2\n");
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    });

    it("terminalizes reverts that stopped before or during the provider rollback", async () => {
      const harness = await createHarness();
      await seedCheckpoints(harness, { sessionStatus: "ready" });
      await createNeighbour(harness, { worktreePath: "/tmp/ryco-unrelated-neighbour" });
      await seedRevertActivity(harness, {
        revertRequestId: "cmd-recover-rolling-back",
        status: "rolling-back",
        cwd: harness.cwd,
      });
      await seedRevertActivity(harness, {
        threadId: ThreadId.make("thread-2"),
        revertRequestId: "cmd-recover-requested",
        status: "requested",
      });

      await Effect.runPromise(harness.reactor.recover());

      const interrupted = await waitForRevertStatus(
        harness.engine,
        "cmd-recover-rolling-back",
        "interrupted",
      );
      expect(interrupted.reason).toBe("restart");
      expect(interrupted.detail).toContain("Revert to checkpoint 1 again to finish.");
      const failed = await waitForRevertStatus(harness.engine, "cmd-recover-requested", "failed");
      expect(failed.reason).toBe("restart");
      expect(failed.detail).toBe("Ryco restarted before this revert started. Nothing was changed.");
      expect(readme(harness.cwd)).toBe("v3\n");
      expect(await hasReverted(harness.engine)).toBe(false);
    });
  });
});
