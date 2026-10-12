/**
 * Integration harness for chat forks: the real orchestration engine, projections and fork
 * ledger on SQLite, the real checkpoint store and Git driver on temporary repositories, the
 * real provider session directory, and the ThreadFork service with injectable native forkers.
 * Provider reactors are not running, so turns are seeded through engine commands.
 */
import { mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ChatAttachment,
  CheckpointRef,
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import type { DeepPartial } from "@ryco/shared/Struct";
import { Effect, FileSystem, Layer, ManagedRuntime, Option, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { CheckpointStoreLive } from "../checkpointing/Layers/CheckpointStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { ThreadForkRepositoryLive } from "../persistence/Layers/ThreadForks.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import {
  ThreadForkRepository,
  type ThreadForkRepositoryShape,
} from "../persistence/Services/ThreadForks.ts";
import { ChatFolders, type ChatFoldersShape } from "../project/chatFolders.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../project/Services/ProjectAvatarStore.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "../project/Services/ProjectSetupScriptRunner.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeGitVcsDriverCore } from "../vcs/GitVcsDriverCore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceAccessPolicyLive } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import {
  makeThreadForkLive,
  type ThreadForkNativeForkRequest,
  type ThreadForkTestOptions,
} from "./Layers/ThreadFork.ts";
import type { NativeForkOutcome, NativeForkUncertain } from "./nativeFork.ts";
import { ThreadFork } from "./Services/ThreadFork.ts";

/** Instances of every driver the tests fork from. */
export const FORK_TEST_PROVIDER_INSTANCES = {
  codex: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
  claude: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true, config: {} },
  opencode: { driver: ProviderDriverKind.make("opencode"), enabled: true, config: {} },
  copilot: { driver: ProviderDriverKind.make("copilot"), enabled: true, config: {} },
  cursor: { driver: ProviderDriverKind.make("cursor"), enabled: true, config: {} },
} as const;

export type ForkTestInstance = keyof typeof FORK_TEST_PROVIDER_INSTANCES;

export const forkTestModel = (instance: ForkTestInstance = "codex"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model: "fixture-model",
});

/** A stable history clock, well before any fork's own creation time. */
export const historyAt = (seconds: number) =>
  new Date(Date.parse("2026-10-01T10:00:00.000Z") + seconds * 1000).toISOString();

type GitWorkflowFns = Pick<
  GitWorkflowServiceShape,
  "createWorktree" | "removeWorktree" | "deleteBranch"
>;

export interface ForkHarnessOptions {
  readonly databasePath?: string;
  readonly settings?: DeepPartial<ServerSettings>;
  readonly service?: ThreadForkTestOptions;
  /** Wraps the real Git driver, e.g. to record or fail calls. */
  readonly gitWorkflow?: (git: GitWorkflowFns) => GitWorkflowFns;
  /** Offers chats rooted here. */
  readonly chatsRoot?: string;
  /** Wraps the filesystem the fork service sees (the rest of the harness keeps the real one). */
  readonly fileSystem?: (fileSystem: FileSystem.FileSystem) => FileSystem.FileSystem;
  /** Wraps the fork ledger the fork service sees; `harness.ledger` stays the real one. */
  readonly ledger?: (ledger: ThreadForkRepositoryShape) => ThreadForkRepositoryShape;
  /** Wraps the checkpoint store the fork service sees. */
  readonly checkpoints?: (store: CheckpointStoreShape) => CheckpointStoreShape;
  /** Replaces the setup-script runner (default: every project has no setup script). */
  readonly runSetupScript?: ProjectSetupScriptRunnerShape["runForThread"];
  /**
   * Provides a server startup that admits commands at once, so the live layer starts its
   * recovery sweep (every `service.recoverySweepInterval`) as it does in production.
   */
  readonly startup?: boolean;
}

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write is not used by fork tests"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const makeTestChatFolders = (root: string): ChatFoldersShape => ({
  capability: Effect.succeed({ available: true, root }),
  changes: Stream.empty,
  allocateChatFolder: ({ projectId }) =>
    Effect.promise(async () => {
      const folder = path.join(root, `chat-${projectId}`);
      await mkdir(folder, { recursive: true });
      return realpath(folder);
    }),
  ensureChatFolder: (folder) =>
    Effect.promise(async () => {
      const existed = await readdir(folder).then(
        () => true,
        () => false,
      );
      await mkdir(folder, { recursive: true });
      return { created: !existed };
    }),
  removeEmptyChatFolder: (folder) =>
    Effect.promise(() =>
      rmdir(folder).then(
        () => true,
        () => false,
      ),
    ),
  isInsideChatsRoot: (candidate) => Effect.succeed(candidate.startsWith(`${root}${path.sep}`)),
});

export async function createForkHarness(options: ForkHarnessOptions = {}) {
  const persistence =
    options.databasePath === undefined
      ? SqlitePersistenceMemory
      : makeSqlitePersistenceLive(options.databasePath);
  const platform = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "ryco-thread-fork-test-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionTurnRepositoryLive,
    ProjectionProjectRepositoryLive,
    ProjectionThreadRepositoryLive,
    ThreadForkRepositoryLive,
    ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntimeRepositoryLive)),
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
  );
  const vcs = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
  );
  const gitWorkflow = Layer.effect(
    GitWorkflowService,
    Effect.gen(function* () {
      const driver = yield* makeGitVcsDriverCore();
      const git: GitWorkflowFns = {
        createWorktree: driver.createWorktree,
        removeWorktree: driver.removeWorktree,
        deleteBranch: driver.deleteBranch,
      };
      return (options.gitWorkflow?.(git) ?? git) as unknown as GitWorkflowServiceShape;
    }),
  );
  const stubs = Layer.mergeAll(
    Layer.succeed(ProjectSetupScriptRunner, {
      runForThread:
        options.runSetupScript ?? (() => Effect.succeed({ status: "no-script" as const })),
    }),
    Layer.succeed(VcsStatusBroadcaster, {
      refreshStatus: () => Effect.succeed({}),
    } as unknown as VcsStatusBroadcaster["Service"]),
    ...(options.chatsRoot === undefined
      ? []
      : [Layer.succeed(ChatFolders, makeTestChatFolders(options.chatsRoot))]),
  );
  // What only the fork service sees: wrapped dependencies and a ready startup.
  const { fileSystem: wrapFileSystem, ledger: wrapLedger, checkpoints: wrapCheckpoints } = options;
  const serviceOnly = Layer.mergeAll(
    wrapFileSystem === undefined
      ? Layer.empty
      : Layer.effect(
          FileSystem.FileSystem,
          Effect.map(Effect.service(FileSystem.FileSystem), wrapFileSystem),
        ),
    wrapLedger === undefined
      ? Layer.empty
      : Layer.effect(
          ThreadForkRepository,
          Effect.map(Effect.service(ThreadForkRepository), wrapLedger),
        ),
    wrapCheckpoints === undefined
      ? Layer.empty
      : Layer.effect(CheckpointStore, Effect.map(Effect.service(CheckpointStore), wrapCheckpoints)),
    options.startup === true
      ? Layer.succeed(ServerRuntimeStartup, {
          awaitCommandReady: Effect.void,
          markHttpServing: Effect.void,
          enqueueCommand: (effect) => effect,
        })
      : Layer.empty,
  );
  const layer = makeThreadForkLive(options.service).pipe(
    Layer.provide(serviceOnly),
    Layer.provideMerge(gitWorkflow),
    Layer.provideMerge(WorkspaceAccessPolicyLive),
    Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(vcs))),
    Layer.provideMerge(stubs),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providerInstances: FORK_TEST_PROVIDER_INSTANCES,
        ...options.settings,
      } as DeepPartial<ServerSettings>),
    ),
    Layer.provideMerge(orchestration),
    Layer.provideMerge(persistence),
    Layer.provideMerge(platform),
  );
  const runtime = ManagedRuntime.make(layer);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    runtime.runPromise(effect);
  const services = await run(
    Effect.all({
      forks: Effect.service(ThreadFork),
      engine: Effect.service(OrchestrationEngineService),
      snapshots: Effect.service(ProjectionSnapshotQuery),
      ledger: Effect.service(ThreadForkRepository),
      directory: Effect.service(ProviderSessionDirectory),
      threadRows: Effect.service(ProjectionThreadRepository),
      checkpoints: Effect.service(CheckpointStore),
      config: Effect.service(ServerConfig),
      sql: Effect.service(SqlClient.SqlClient),
    }),
  );
  return {
    ...services,
    run,
    dispose: () => runtime.dispose(),
    ledgerRows: () =>
      run(
        services.sql<{
          readonly forkKey: string;
          readonly phase: string;
        }>`SELECT fork_key AS "forkKey", phase FROM thread_forks ORDER BY created_at, fork_key`,
      ),
    threadIds: () =>
      run(services.snapshots.getShellSnapshot()).then((snapshot) =>
        snapshot.threads.map((thread) => thread.id),
      ),
    shell: (threadId: ThreadId) =>
      run(services.snapshots.getThreadShellById(threadId)).then(Option.getOrUndefined),
    detail: (threadId: ThreadId) =>
      run(services.snapshots.getThreadDetailById(threadId)).then(Option.getOrUndefined),
  };
}

export type ForkHarness = Awaited<ReturnType<typeof createForkHarness>>;

export async function seedProject(
  harness: ForkHarness,
  input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly kind?: "project" | "chat";
  },
) {
  await harness.run(
    harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`seed-project-${input.projectId}`),
      projectId: input.projectId,
      kind: input.kind ?? "project",
      title: `Fixture ${input.projectId}`,
      workspaceRoot: input.workspaceRoot,
      defaultModelSelection: forkTestModel(),
      createdAt: historyAt(0),
    }),
  );
}

export async function seedThread(
  harness: ForkHarness,
  input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly instance?: ForkTestInstance;
    readonly worktreePath?: string | null;
    readonly branch?: string | null;
    readonly title?: string;
  },
) {
  await harness.run(
    harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`seed-thread-${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title ?? "Source thread",
      modelSelection: forkTestModel(input.instance),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt: historyAt(0),
    }),
  );
}

export interface SeededTurn {
  readonly turnId: TurnId;
  readonly promptId: MessageId;
  readonly replyId: MessageId;
  readonly commentaryId: MessageId | null;
}

/**
 * One completed turn the way a provider produces it: the prompt, an optional mid-turn
 * commentary, the final reply, the released turn and (optionally) its checkpoint.
 */
export async function seedCompletedTurn(
  harness: ForkHarness,
  input: {
    readonly threadId: ThreadId;
    readonly index: number;
    readonly instance?: ForkTestInstance;
    readonly commentary?: boolean;
    readonly checkpoint?: { readonly ref: CheckpointRef; readonly count: number };
    /** The provider's turn id (Claude: the prompt's transcript uuid). */
    readonly turnId?: string;
    readonly promptAttachments?: ReadonlyArray<ChatAttachment>;
    /** How the turn ends after its reply (default `completed`): a Stop, or a provider error. */
    readonly outcome?: "completed" | "interrupted" | "error";
  },
): Promise<SeededTurn> {
  const { threadId, index } = input;
  const t = index * 10;
  const instance = input.instance ?? "codex";
  const turnId = TurnId.make(input.turnId ?? `${threadId}-turn-${index}`);
  const promptId = MessageId.make(`${threadId}-prompt-${index}`);
  const replyId = MessageId.make(`${threadId}-reply-${index}`);
  const commentaryId = input.commentary ? MessageId.make(`${threadId}-commentary-${index}`) : null;
  const session = {
    threadId,
    status: "running" as const,
    providerName: FORK_TEST_PROVIDER_INSTANCES[instance].driver,
    providerInstanceId: ProviderInstanceId.make(instance),
    runtimeSessionId: RuntimeSessionId.make(`${threadId}-runtime`),
    runtimeMode: "full-access" as const,
    activeTurnId: turnId,
    lastError: null,
    updatedAt: historyAt(t + 1),
  };
  const dispatch = harness.engine.dispatch;
  await harness.run(
    dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`seed-start-${threadId}-${index}`),
      threadId,
      message: {
        messageId: promptId,
        role: "user",
        text: `Prompt ${index}`,
        attachments: input.promptAttachments ?? [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: historyAt(t),
    }),
  );
  await harness.run(
    dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`seed-running-${threadId}-${index}`),
      threadId,
      session,
      createdAt: historyAt(t + 1),
    }),
  );
  if (commentaryId !== null) {
    await harness.run(
      dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`seed-commentary-${threadId}-${index}`),
        threadId,
        messageId: commentaryId,
        turnId,
        text: `Commentary ${index}`,
        createdAt: historyAt(t + 2),
      }),
    );
  }
  await harness.run(
    dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(`seed-reply-${threadId}-${index}`),
      threadId,
      messageId: replyId,
      turnId,
      text: `Reply ${index}`,
      createdAt: historyAt(t + 3),
    }),
  );
  await harness.run(
    dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`seed-ready-${threadId}-${index}`),
      threadId,
      session: { ...session, status: "ready", activeTurnId: null, updatedAt: historyAt(t + 4) },
      turnOutcome: {
        turnId,
        state: input.outcome ?? "completed",
        reason: `provider-turn-${input.outcome ?? "completed"}`,
        completedAt: historyAt(t + 4),
      },
      createdAt: historyAt(t + 4),
    }),
  );
  if (input.checkpoint !== undefined) {
    await harness.run(
      dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(`seed-diff-${threadId}-${index}`),
        threadId,
        turnId,
        completedAt: historyAt(t + 4),
        checkpointRef: input.checkpoint.ref,
        status: "ready",
        files: [],
        assistantMessageId: replyId,
        checkpointTurnCount: input.checkpoint.count,
        createdAt: historyAt(t + 4),
      }),
    );
  }
  return { turnId, promptId, replyId, commentaryId };
}

/** Binds the source to a resumable native session, as a provider runtime would have. */
export async function seedNativeBinding(
  harness: ForkHarness,
  input: {
    readonly threadId: ThreadId;
    readonly instance: "codex" | "claude";
    readonly cwd: string;
    readonly nativeId: string;
  },
) {
  await harness.run(
    harness.directory.upsert({
      threadId: input.threadId,
      provider: FORK_TEST_PROVIDER_INSTANCES[input.instance].driver,
      providerInstanceId: ProviderInstanceId.make(input.instance),
      runtimeSessionId: RuntimeSessionId.make(`${input.threadId}-runtime`),
      status: "stopped",
      runtimeMode: "full-access",
      resumeCursor:
        input.instance === "codex"
          ? { threadId: input.nativeId }
          : { threadId: input.threadId, resume: input.nativeId, turnCount: 1 },
      runtimePayload: { cwd: input.cwd },
    }),
  );
}

export const forkTestIds = {
  project: ProjectId.make("fork-test-project"),
  source: ThreadId.make("fork-test-source"),
  checkpointRef: (ref: string) => CheckpointRef.make(ref),
};

/** A native forker that records its calls (and removals) and succeeds unless told otherwise. */
export function fakeNative(
  outcome: (
    request: ThreadForkNativeForkRequest,
  ) => Effect.Effect<NativeForkOutcome, NativeForkUncertain> = (request) =>
    Effect.succeed({
      kind: "forked",
      nativeThreadId: `copy-of-${request.plan.sourceNativeId}`,
      ownedCopy: { kind: "codex-thread", threadId: `copy-of-${request.plan.sourceNativeId}` },
    }),
) {
  const calls: ThreadForkNativeForkRequest[] = [];
  const removed: string[] = [];
  return {
    calls,
    removed,
    native: {
      fork: (request: ThreadForkNativeForkRequest) =>
        Effect.suspend(() => {
          calls.push(request);
          return outcome(request);
        }),
      removeCopy: (input: { readonly nativeThreadId: string }) =>
        Effect.sync(() => {
          removed.push(input.nativeThreadId);
        }),
    },
  };
}
