import { makeStorageService } from "../../storage/StorageService.ts";
import { canonicalStoragePath, recordCreatedWorktree } from "../../storage/lifecycle.ts";
import { makeWorkspaceAccessPolicy } from "../../workspace/Layers/WorkspaceAccessPolicy.ts";
import { runProcess } from "../../processRunner.ts";
import type { ServerConfigShape } from "../../config.ts";
import { DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";
import { storageLifecycleLock } from "../../storage/lifecycle.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalRequestId, EventId, RuntimeSessionId } from "@ryco/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import {
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Metric,
  Option,
  Queue,
  Semaphore,
  Stream,
} from "effect";
import { describe, expect, it } from "vite-plus/test";

import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationCommandAdmissionError } from "../Errors.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { makeCompletionReturnRepository } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { threadSettlementInput } from "../threadSettlementInput.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { metricNames } from "../../observability/Metrics.ts";
import { hasMetricSnapshot } from "../../observability/testMetricSnapshots.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

async function createOrchestrationSystem(databasePath?: string) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "ryco-orchestration-engine-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(
      databasePath ? makeSqlitePersistenceLive(databasePath) : SqlitePersistenceMemory,
    ),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    sql: await runtime.runPromise(Effect.service(SqlClient.SqlClient)),
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    readShell: () => runtime.runPromise(snapshotQuery.getShellSnapshot()),
    // Before any dispatch after a (re)start, this is exactly the engine's bootstrap model.
    commandReadModel: () => runtime.runPromise(snapshotQuery.getCommandReadModel()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

describe("OrchestrationEngine", () => {
  it("refuses queued turn activation beneath a checkout claimed by cleanup", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ryco-storage-admission-")),
    );
    const checkout = path.join(root, "checkout");
    const nested = path.join(checkout, "src");
    await fs.mkdir(nested, { recursive: true });
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("storage-project");
    const threadId = ThreadId.make("storage-thread");
    const createdAt = now();
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("storage-project-create"),
          projectId,
          title: "Fixture",
          workspaceRoot: root,
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("storage-thread-create"),
          threadId,
          projectId,
          title: "Fixture",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "fixture",
          worktreePath: nested,
          createdAt,
        }),
      );
      await system.run(storageLifecycleLock.take(1));
      const activated = system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("storage-turn-race"),
          threadId,
          message: {
            messageId: MessageId.make("storage-message"),
            role: "user",
            text: "fixture",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        }),
      );
      try {
        await system.run(
          system.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('fixture', ${checkout}, 'worktree', '{}', ${createdAt}, 'removing')`,
        );
      } finally {
        await system.run(storageLifecycleLock.release(1));
      }
      await expect(activated).rejects.toThrow("Checkout cleanup is pending or complete");
      expect((await system.readShell()).threads[0]?.latestTurn).toBeNull();
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("storage-meta-race"),
            threadId,
            worktreePath: nested,
          }),
        ),
      ).rejects.toThrow("Checkout cleanup is pending or complete");
    } finally {
      await system.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("protects an accepted archived turn before a paused reactor makes it visible in the shell", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ryco-storage-pending-")),
    );
    const repo = path.join(root, "repository");
    const checkout = path.join(root, "checkout");
    await fs.mkdir(repo);
    const git = (cwd: string, args: readonly string[]) =>
      runProcess("git", args, {
        cwd,
        timeoutMs: 10_000,
        maxBufferBytes: 256 * 1024,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["config", "user.name", "Fixture"]);
    await git(repo, ["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(repo, "tracked.txt"), "fixture");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "fixture"]);
    await git(repo, ["worktree", "add", "-b", "fixture", checkout]);
    // No ProviderCommandReactor is started: accepted intent remains durably queued.
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("pending-project");
    const threadId = ThreadId.make("pending-thread");
    const createdAt = now();
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("pending-project-create"),
          projectId,
          title: "Fixture",
          workspaceRoot: repo,
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("pending-thread-create"),
          threadId,
          projectId,
          title: "Fixture",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "fixture",
          worktreePath: checkout,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("pending-initial-message"),
          threadId,
          message: {
            messageId: MessageId.make("initial-message"),
            role: "user",
            text: "completed fixture history",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        }),
      );
      // Simulate the already-finished historical intent, before the delayed new acceptance.
      await system.run(
        system.sql`DELETE FROM projection_turns WHERE thread_id = ${threadId} AND state = 'pending'`,
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("pending-thread-archive"),
          threadId,
        }),
      );
      await system.run(recordCreatedWorktree(system.sql, repo, checkout));
      const policy = await Effect.runPromise(
        makeWorkspaceAccessPolicy(undefined).pipe(Effect.provide(NodeServices.layer)),
      );
      let removals = 0;
      const storage = makeStorageService({
        sql: system.sql,
        config: {
          stateDir: root,
          dbPath: path.join(root, "node.db"),
          attachmentsDir: path.join(root, "attachments"),
          logsDir: path.join(root, "logs"),
        } as ServerConfigShape,
        providerProtection: { resolve: () => [] },
        settings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        snapshots: { getShellSnapshot: () => Effect.tryPromise(() => system.readShell()) as never },
        providers: { listBindings: () => Effect.succeed([]) },
        terminals: { listDiagnostics: Effect.succeed([]) },
        policy,
        git: {
          listWorktreePaths: () => Effect.succeed([repo, checkout]),
          removeWorktree: () =>
            Effect.sync(() => {
              removals++;
            }),
        },
      });
      const entry = (await system.run(storage.scan())).entries.find(
        (item) => item.path === checkout,
      )!;
      expect(entry.eligible).toBe(true);
      const preview = await system.run(storage.preview("fixture-owner", [entry.id]));
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("pending-turn-accept"),
          threadId,
          message: {
            messageId: MessageId.make("pending-message"),
            role: "user",
            text: "resume archived work",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        }),
      );
      const shellThread = (await system.readShell()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      expect(shellThread.archivedAt).not.toBeNull();
      expect(shellThread.latestTurn).toBeNull();
      expect(
        await system.run(
          system.sql`SELECT thread_id FROM projection_turns WHERE state = 'pending'`,
        ),
      ).toHaveLength(1);
      const result = await system.run(storage.execute("fixture-owner", preview.token));
      expect(result.results[0]?.status).toBe("protected");
      expect(result.results[0]?.detail).toContain("accepted turn start");
      expect(removals).toBe(0);
      expect(await fs.readFile(path.join(checkout, "tracked.txt"), "utf8")).toBe("fixture");
    } finally {
      await system.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back rejected admission, keeps its receipt retryable and skips admission for accepted retries", async () => {
    const system = await createOrchestrationSystem();
    try {
      const sql = system.sql;
      await system.run(sql`CREATE TABLE synthetic_admission (marker TEXT)`);
      let allowed = false,
        admissions = 0;
      const admission = {
        admit: <A, E>(commit: Effect.Effect<A, E>) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                admissions++;
                yield* sql`INSERT INTO synthetic_admission VALUES ('binding')`;
                if (!allowed)
                  return yield* new OrchestrationCommandAdmissionError({
                    detail: "Synthetic admission changed",
                  });
                return yield* commit;
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", () =>
                Effect.fail(
                  new OrchestrationCommandAdmissionError({
                    detail: "Synthetic transaction failed",
                  }),
                ),
              ),
            ),
      };
      const command = {
        type: "project.create" as const,
        commandId: CommandId.make("admission-command"),
        projectId: ProjectId.make("admission-project"),
        title: "Synthetic admission",
        workspaceRoot: "/synthetic/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "fixture-model",
        },
        createdAt: now(),
      };
      expect((await system.run(Effect.exit(system.engine.dispatch(command, admission))))._tag).toBe(
        "Failure",
      );
      expect(await system.run(sql`SELECT * FROM synthetic_admission`)).toHaveLength(0);
      expect((await system.readModel()).projects).toHaveLength(0);
      allowed = true;
      const accepted = await system.run(system.engine.dispatch(command, admission));
      expect(await system.run(sql`SELECT * FROM synthetic_admission`)).toHaveLength(1);
      expect((await system.readModel()).projects).toHaveLength(1);
      allowed = false;
      expect(await system.run(system.engine.dispatch(command, admission))).toEqual(accepted);
      expect(admissions).toBe(2);
      expect(await system.run(sql`SELECT * FROM synthetic_admission`)).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });

  it("restores durable approval claims after closing and reopening the database", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-approval-restart-"));
    const database = path.join(directory, "state.sqlite");
    const projectId = ProjectId.make("approval-project");
    const threadId = ThreadId.make("approval-thread");
    const runtimeSessionId = RuntimeSessionId.make("approval-runtime");
    const createdAt = now();
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
    const command = {
      type: "thread.approval.respond" as const,
      commandId: CommandId.make("claim-before-restart"),
      threadId,
      requestId: ApprovalRequestId.make("provider-request"),
      decision: "accept" as const,
      createdAt,
      approvalIdentity: {
        requestEventId: EventId.make("callback-before-restart"),
        runtimeSessionId,
      },
    };
    let system = await createOrchestrationSystem(database);
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("approval-project-create"),
          projectId,
          title: "Approval",
          workspaceRoot: directory,
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("approval-thread-create"),
          threadId,
          projectId,
          title: "Approval",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("approval-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeSessionId,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("approval-open"),
          threadId,
          activity: {
            id: command.approvalIdentity.requestEventId,
            kind: "approval.requested",
            tone: "approval",
            summary: "Approval",
            turnId: null,
            payload: { requestId: command.requestId, requestKind: "command", runtimeSessionId },
            createdAt,
          },
          createdAt,
        }),
      );
      const receipt = await system.run(system.engine.dispatch(command));
      await system.dispose();
      system = await createOrchestrationSystem(database);
      expect(await system.run(system.engine.dispatch(command))).toEqual(receipt);
      await expect(
        system.run(
          system.engine.dispatch({
            ...command,
            commandId: CommandId.make("claim-after-restart"),
            decision: "decline",
          }),
        ),
      ).rejects.toThrow("already submitted");
    } finally {
      await system.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "restores durable question claims after closing and reopening the database (optional=%s)",
    async (nonBlocking) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-question-restart-"));
      const database = path.join(directory, "state.sqlite");
      const projectId = ProjectId.make("approval-project");
      const threadId = ThreadId.make("approval-thread");
      const runtimeSessionId = RuntimeSessionId.make("approval-runtime");
      const createdAt = now();
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
      const command = {
        type: "thread.user-input.respond" as const,
        commandId: CommandId.make("claim-before-restart"),
        threadId,
        requestId: ApprovalRequestId.make("provider-request"),
        answers: { answer: "Yes" },
        createdAt,
        userInputIdentity: {
          requestEventId: EventId.make("callback-before-restart"),
          runtimeSessionId,
        },
      };
      let system = await createOrchestrationSystem(database);
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("approval-project-create"),
            projectId,
            title: "Approval",
            workspaceRoot: directory,
            defaultModelSelection: modelSelection,
            createdAt,
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("approval-thread-create"),
            threadId,
            projectId,
            title: "Approval",
            modelSelection,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("approval-session"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeSessionId,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("approval-open"),
            threadId,
            activity: {
              id: command.userInputIdentity.requestEventId,
              kind: "user-input.requested",
              tone: "approval",
              summary: "Approval",
              turnId: null,
              payload: {
                requestId: command.requestId,
                requestKind: "command",
                runtimeSessionId,
                nonBlocking,
              },
              createdAt,
            },
            createdAt,
          }),
        );
        expect(
          (await system.readShell()).threads.find((thread) => thread.id === threadId)
            ?.hasPendingUserInput,
        ).toBe(!nonBlocking);
        const receipt = await system.run(system.engine.dispatch(command));
        await system.dispose();
        system = await createOrchestrationSystem(database);
        expect(
          (await system.readShell()).threads.find((thread) => thread.id === threadId)
            ?.hasPendingUserInput,
        ).toBe(!nonBlocking);
        expect(await system.run(system.engine.dispatch(command))).toEqual(receipt);
        await expect(
          system.run(
            system.engine.dispatch({
              ...command,
              commandId: CommandId.make("claim-after-restart"),
              answers: { answer: "No" },
            }),
          ),
        ).rejects.toThrow("already submitted");
      } finally {
        await system.dispose();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    let signalAppend!: () => void;
    let releaseAppend!: () => void;
    const appendEntered = new Promise<void>((resolve) => {
      signalAppend = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.promise(() => {
          signalAppend();
          return appendReleased;
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const savedEvent = {
                ...event,
                sequence: nextSequence,
              } as OrchestrationEvent;
              nextSequence += 1;
              return savedEvent;
            }),
          ),
        ),
      readFromSequence: () => Stream.empty,
      readThroughSequence: () => Stream.empty,
      latestSequence: Effect.succeed(7),
      readPage: (sequenceExclusive) =>
        Effect.succeed({
          events: [],
          nextSequence: sequenceExclusive,
          hasMore: false,
        }),
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
      hasEventAfter: () => Effect.succeed(false),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          searchThreadMessages: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
          projectEventInTransaction: () => Effect.succeed(Effect.void),
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const workspace = {
      threadId: "thread-bootstrap",
      cwd: "/tmp/project-bootstrap",
      worktreePath: null,
    };
    const beforeUpdate = engine.captureThreadWorkspace!(workspace)!;
    expect(beforeUpdate()).toBe(true);
    const dispatching = runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    await appendEntered;
    expect(beforeUpdate()).toBe(false);
    expect(engine.captureThreadWorkspace!(workspace)).toBeUndefined();
    releaseAppend();
    const result = await dispatching;
    expect(beforeUpdate()).toBe(false);
    expect(engine.captureThreadWorkspace!(workspace)!()).toBe(true);
    expect(
      engine.captureThreadWorkspace!({ ...workspace, cwd: "/synthetic/stale" }),
    ).toBeUndefined();
    expect(result.sequence).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  it("dispatches worktree title metadata updates", async () => {
    const createdAt = now();
    const changedAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-worktree-title");
    const worktreeId = WorktreeId.make("worktree-title");

    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-worktree-title-project-create"),
          projectId,
          title: "Worktree Title Project",
          workspaceRoot: "/tmp/project-worktree-title",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      );

      await system.run(
        engine.dispatch({
          type: "worktree.create",
          commandId: CommandId.make("cmd-worktree-title-create"),
          worktreeId,
          projectId,
          branch: "feature/title",
          worktreePath: "/tmp/project-worktree-title-feature",
          origin: "branch",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt,
        }),
      );

      await system.run(
        engine.dispatch({
          type: "worktree.meta.update",
          commandId: CommandId.make("cmd-worktree-title-update"),
          worktreeId,
          title: "Renamed Worktree",
          branch: "feature/renamed",
          changedAt,
        }),
      );

      const readModel = await system.readModel();
      expect(
        readModel.worktrees?.find((worktree) => worktree.worktreeId === worktreeId)?.title,
      ).toBe("Renamed Worktree");
      expect(
        readModel.worktrees?.find((worktree) => worktree.worktreeId === worktreeId)?.branch,
      ).toBe("feature/renamed");
    } finally {
      await system.dispose();
    }
  });

  it("dispatches worktree create with Jira work item metadata", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-jira-worktree");
    const worktreeId = WorktreeId.make("worktree-jira-kan-4");

    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-jira-worktree-project-create"),
          projectId,
          title: "Jira Worktree Project",
          workspaceRoot: "/tmp/project-jira-worktree",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      );

      await system.run(
        engine.dispatch({
          type: "worktree.create",
          commandId: CommandId.make("cmd-jira-worktree-create"),
          worktreeId,
          projectId,
          branch: "KAN-4-super-toll",
          worktreePath: "/tmp/project-jira-worktree/KAN-4-super-toll",
          origin: "issue",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          workItemProvider: "jira",
          workItemKey: "KAN-4",
          workItemTitle: "SUPER TOLL",
          workItemState: "open",
          workItemStateName: "Next to come",
          workItemUrl: "https://ryco-app.atlassian.net/browse/KAN-4",
          createdAt,
        }),
      );

      const readModel = await system.readModel();
      const worktree = readModel.worktrees?.find((entry) => entry.worktreeId === worktreeId);
      expect(worktree?.workItemProvider).toBe("jira");
      expect(worktree?.workItemKey).toBe("KAN-4");
      expect(worktree?.workItemState).toBe("open");
      expect(worktree?.workItemStateName).toBe("Next to come");
    } finally {
      await system.dispose();
    }
  });

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
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
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-thread-archive-message"),
        threadId: ThreadId.make("thread-archive"),
        message: {
          messageId: MessageId.make("message-thread-archive"),
          role: "user",
          text: "archive-ready",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, metricNames.orchestrationCommandAckDuration, {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, metricNames.orchestrationCommandsTotal, {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/ryco/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/ryco/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readThroughSequence(sequenceExclusive, sequenceInclusive) {
        return Stream.fromIterable(
          events.filter(
            (event) => event.sequence > sequenceExclusive && event.sequence <= sequenceInclusive,
          ),
        );
      },
      latestSequence: Effect.sync(() => events.at(-1)?.sequence ?? 0),
      readPage(sequenceExclusive, limit) {
        const pageEvents = events
          .filter((event) => event.sequence > sequenceExclusive)
          .slice(0, limit);
        return Effect.succeed({
          events: pageEvents,
          nextSequence:
            pageEvents.length === 0
              ? sequenceExclusive
              : pageEvents[pageEvents.length - 1]!.sequence,
          hasMore: events.some(
            (event) => event.sequence > (pageEvents.at(-1)?.sequence ?? sequenceExclusive),
          ),
        });
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "ryco-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(MockProjectAvatarStoreLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventInTransaction: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readThroughSequence(sequenceExclusive, sequenceInclusive) {
        return Stream.fromIterable(
          events.filter(
            (event) => event.sequence > sequenceExclusive && event.sequence <= sequenceInclusive,
          ),
        );
      },
      latestSequence: Effect.sync(() => events.at(-1)?.sequence ?? 0),
      readPage(sequenceExclusive, limit) {
        const pageEvents = events
          .filter((event) => event.sequence > sequenceExclusive)
          .slice(0, limit);
        return Effect.succeed({
          events: pageEvents,
          nextSequence:
            pageEvents.length === 0
              ? sequenceExclusive
              : pageEvents[pageEvents.length - 1]!.sequence,
          hasMore: events.some(
            (event) => event.sequence > (pageEvents.at(-1)?.sequence ?? sequenceExclusive),
          ),
        });
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventInTransaction: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-thread-sync-message"),
        threadId: ThreadId.make("thread-sync"),
        message: {
          messageId: MessageId.make("message-thread-sync"),
          role: "user",
          text: "sync-ready",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});

async function seedSidebarUndoSystem(databasePath?: string) {
  const system = await createOrchestrationSystem(databasePath);
  const projectId = ProjectId.make("undo-project");
  const threadId = ThreadId.make("undo-thread");
  const createdAt = "2020-01-01T00:00:00.000Z";
  const modelSelection = { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" };
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("undo-project-create"),
      projectId,
      title: "Synthetic Undo",
      workspaceRoot: "/tmp/ryco-synthetic-undo",
      defaultModelSelection: modelSelection,
      createdAt,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("undo-thread-create"),
      threadId,
      projectId,
      title: "Synthetic Undo",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
  // This system includes only the engine/projectors, with no provider reactors or drivers.
  await system.run(
    system.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("undo-synthetic-message"),
      threadId,
      message: {
        messageId: MessageId.make("undo-message"),
        role: "user",
        text: "Synthetic fixture",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.manual-position.set",
      commandId: CommandId.make("undo-position"),
      threadId,
      position: 17,
      changedAt: createdAt,
    }),
  );
  return { ...system, projectId, threadId };
}

function sidebarFields(
  thread: Pick<
    import("@ryco/contracts").OrchestrationReadModel["threads"][number],
    | "archivedAt"
    | "settledOverride"
    | "settledAt"
    | "snoozedUntil"
    | "snoozedAt"
    | "updatedAt"
    | "manualPosition"
  >,
) {
  return {
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    updatedAt: thread.updatedAt,
    manualPosition: thread.manualPosition,
  };
}

describe("server-owned sidebar undo", () => {
  it.each(["archive", "settle", "snooze"] as const)(
    "restores exact %s state, timestamps and manual ordering in the shell and durable projection",
    async (action) => {
      const system = await seedSidebarUndoSystem();
      try {
        if (action === "snooze")
          await system.run(
            system.engine.dispatch({
              type: "thread.settle",
              commandId: CommandId.make("undo-prior-settle"),
              threadId: system.threadId,
            }),
          );
        if (action === "settle")
          await system.run(
            system.engine.dispatch({
              type: "thread.snooze",
              commandId: CommandId.make("undo-prior-snooze"),
              threadId: system.threadId,
              snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          );
        const before = sidebarFields((await system.readModel()).threads[0]!);
        const original = {
          type: `thread.${action}` as const,
          commandId: CommandId.make("undo-original"),
          threadId: system.threadId,
          snoozedUntil: new Date(Date.now() + 7_200_000).toISOString(),
        };
        await system.run(system.engine.dispatch(original));
        const undo = {
          type: "thread.sidebar.undo" as const,
          commandId: CommandId.make("undo-restore"),
          threadId: system.threadId,
          undoCommandId: original.commandId,
        };
        const result = await system.run(system.engine.dispatch(undo));
        expect(sidebarFields((await system.readModel()).threads[0]!)).toEqual(before);
        expect(sidebarFields((await system.readShell()).threads[0]!)).toEqual(before);
        expect(await system.run(system.engine.dispatch(undo))).toEqual(result);
        await expect(
          system.run(system.engine.dispatch({ ...undo, commandId: CommandId.make("undo-again") })),
        ).rejects.toThrow("Undo expired or the thread changed");
      } finally {
        await system.dispose();
      }
    },
  );
  it.each(["thread", "project", "delete", "rapid", "wrong-thread", "failed-original"])(
    "refuses %s changes without overwriting authoritative state",
    async (change) => {
      const system = await seedSidebarUndoSystem();
      try {
        const commandId = CommandId.make("undo-original");
        if (change === "failed-original") {
          await expect(
            system.run(
              system.engine.dispatch({
                type: "thread.snooze",
                commandId,
                threadId: system.threadId,
                snoozedUntil: "2020-01-01T00:00:00.000Z",
              }),
            ),
          ).rejects.toThrow();
        } else
          await system.run(
            system.engine.dispatch({ type: "thread.settle", commandId, threadId: system.threadId }),
          );
        if (change === "thread")
          await system.run(
            system.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make("remote-rename"),
              threadId: system.threadId,
              title: "Remote change",
            }),
          );
        if (change === "project")
          await system.run(
            system.engine.dispatch({
              type: "project.meta.update",
              commandId: CommandId.make("remote-project"),
              projectId: system.projectId,
              title: "Remote project",
            }),
          );
        if (change === "delete")
          await system.run(
            system.engine.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("remote-delete"),
              threadId: system.threadId,
            }),
          );
        if (change === "rapid")
          await system.run(
            system.engine.dispatch({
              type: "thread.unsettle",
              commandId: CommandId.make("remote-unsettle"),
              threadId: system.threadId,
              reason: "user",
            }),
          );
        const before = await system.readModel();
        await expect(
          system.run(
            system.engine.dispatch({
              type: "thread.sidebar.undo",
              commandId: CommandId.make("stale-undo"),
              threadId: change === "wrong-thread" ? ThreadId.make("other-thread") : system.threadId,
              undoCommandId: commandId,
            }),
          ),
        ).rejects.toThrow("Undo expired or the thread changed");
        expect(await system.readModel()).toEqual(before);
      } finally {
        await system.dispose();
      }
    },
  );
  it("does not let a restarted server reuse an old receipt", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-sidebar-undo-restart-"));
    const database = path.join(directory, "state.sqlite");
    let system = await seedSidebarUndoSystem(database);
    try {
      await system.run(
        system.engine.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("before-restart"),
          threadId: system.threadId,
        }),
      );
      await system.dispose();
      const restarted = await createOrchestrationSystem(database);
      system = { ...restarted, projectId: system.projectId, threadId: system.threadId };
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.sidebar.undo",
            commandId: CommandId.make("after-restart"),
            threadId: system.threadId,
            undoCommandId: CommandId.make("before-restart"),
          }),
        ),
      ).rejects.toThrow("Undo expired or the thread changed");
      expect((await system.readModel()).threads[0]?.settledOverride).toBe("settled");
    } finally {
      await system.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

it("keeps undo receipts for rapid actions on different threads independent", async () => {
  const system = await seedSidebarUndoSystem();
  const otherId = ThreadId.make("undo-other-thread");
  const createdAt = "2020-01-01T00:00:00.000Z";
  try {
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("other-create"),
        threadId: otherId,
        projectId: system.projectId,
        title: "Other synthetic thread",
        modelSelection: { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    for (const threadId of [system.threadId, otherId])
      await system.run(
        system.engine.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle-${threadId}`),
          threadId,
        }),
      );
    for (const threadId of [system.threadId, otherId])
      await system.run(
        system.engine.dispatch({
          type: "thread.sidebar.undo",
          commandId: CommandId.make(`undo-${threadId}`),
          undoCommandId: CommandId.make(`settle-${threadId}`),
          threadId,
        }),
      );
    expect((await system.readModel()).threads.map((thread) => thread.settledOverride)).toEqual([
      null,
      null,
    ]);
  } finally {
    await system.dispose();
  }
});

it("keeps Snooze Undo usable during response streaming without rolling newer content or timestamps back", async () => {
  const system = await seedSidebarUndoSystem();
  try {
    await system.run(
      system.engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("streaming-snooze"),
        threadId: system.threadId,
        snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const updatedAt = new Date().toISOString();
    const messageId = MessageId.make("synthetic-response-progress");
    await system.run(
      system.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("response-progress"),
        threadId: system.threadId,
        messageId,
        delta: "Synthetic response progress",
        createdAt: updatedAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.sidebar.undo",
        commandId: CommandId.make("streaming-undo"),
        threadId: system.threadId,
        undoCommandId: CommandId.make("streaming-snooze"),
      }),
    );
    const thread = (await system.readModel()).threads[0]!;
    expect(thread).toMatchObject({
      snoozedUntil: null,
      snoozedAt: null,
      settledOverride: null,
      updatedAt,
      manualPosition: 17,
    });
    expect(thread.messages.find((message) => message.id === messageId)?.text).toBe(
      "Synthetic response progress",
    );
  } finally {
    await system.dispose();
  }
});

it.each([true, false])(
  "refuses sidebar Undo after cleanup claims the unchanged checkout (worktree: %s)",
  async (hasWorktree) => {
    const system = await seedSidebarUndoSystem();
    const checkout = hasWorktree ? "/tmp/ryco-synthetic-undo/checkout" : "/tmp/ryco-synthetic-undo";
    try {
      if (hasWorktree)
        await system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("undo-checkout"),
            threadId: system.threadId,
            worktreePath: checkout,
          }),
        );
      const archiveId = CommandId.make("undo-before-cleanup");
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: archiveId,
          threadId: system.threadId,
        }),
      );
      const before = sidebarFields((await system.readShell()).threads[0]!);
      const canonical = await canonicalStoragePath(checkout);
      await system.run(
        system.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('undo-cleanup', ${canonical}, 'worktree', '{}', '2026-01-01', 'removing')`,
      );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.sidebar.undo",
            commandId: CommandId.make("undo-after-cleanup"),
            undoCommandId: archiveId,
            threadId: system.threadId,
          }),
        ),
      ).rejects.toThrow("Checkout cleanup is pending or complete");
      expect(sidebarFields((await system.readShell()).threads[0]!)).toEqual(before);
    } finally {
      await system.dispose();
    }
  },
);

it("acquires an import settings lease before storage admission without blocking a queued settings writer", async () => {
  const system = await createOrchestrationSystem();
  const settings = Semaphore.makeUnsafe(1);
  const attempted = Deferred.makeUnsafe<void>();
  await system.run(settings.take(1));
  const publication = system.run(
    system.engine.dispatch(
      {
        type: "project.create",
        commandId: CommandId.make("ordered-admission"),
        projectId: ProjectId.make("ordered-project"),
        title: "Synthetic admission",
        workspaceRoot: "/synthetic/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("synthetic"),
          model: "synthetic",
        },
        createdAt: now(),
      },
      {
        withCommitLease: <A, E>(commit: Effect.Effect<A, E>) =>
          Deferred.succeed(attempted, undefined).pipe(Effect.andThen(settings.withPermit(commit))),
        admit: <A, E>(commit: Effect.Effect<A, E>) => commit,
      },
    ),
  );
  try {
    await system.run(Deferred.await(attempted));
    // This represents a settings writer already owning its semaphore. The
    // import must wait outside storage admission so the writer can finish.
    await system.run(
      storageLifecycleLock.withPermit(Effect.void).pipe(Effect.timeout("2 seconds")),
    );
  } finally {
    await system.run(settings.release(1));
    await publication;
    await system.dispose();
  }
});

it("keeps import publication retryable when storage cleanup blocks its project root", async () => {
  const system = await seedSidebarUndoSystem();
  const root = await canonicalStoragePath("/tmp/ryco-synthetic-undo");
  const command = {
    type: "thread.history.import" as const,
    commandId: CommandId.make("import-storage-admission"),
    threadId: ThreadId.make("synthetic-import"),
    projectId: system.projectId,
    title: "Synthetic import",
    modelSelection: { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdAt: now(),
    source: "codex" as const,
    archived: false,
    messages: [],
  };
  try {
    await system.run(
      system.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('import-blocked', ${root}, 'worktree', '{}', '2026-01-01', 'removed')`,
    );
    await expect(system.run(system.engine.dispatch(command))).rejects.toThrow(
      "Checkout cleanup is pending or complete",
    );
    expect(
      (await system.readShell()).threads.some((thread) => thread.id === command.threadId),
    ).toBe(false);
    await system.run(
      system.sql`UPDATE storage_owned_entries SET state = 'owned' WHERE id = 'import-blocked'`,
    );
    const accepted = await system.run(system.engine.dispatch(command));
    await system.run(
      system.sql`UPDATE storage_owned_entries SET state = 'removing' WHERE id = 'import-blocked'`,
    );
    expect(await system.run(system.engine.dispatch(command))).toEqual(accepted);
  } finally {
    await system.dispose();
  }
});

async function seedAttachedSidebarUndoSystem(threadPath: string | null) {
  const system = await seedSidebarUndoSystem();
  const worktreeId = WorktreeId.make("undo-id-only-tree");
  const checkout = "/tmp/ryco-synthetic-undo/id-only-checkout";
  try {
    await system.run(
      system.engine.dispatch({
        type: "worktree.create",
        commandId: CommandId.make("undo-id-only-create"),
        worktreeId,
        projectId: system.projectId,
        branch: "synthetic",
        worktreePath: checkout,
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: now(),
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.attach-to-worktree",
        commandId: CommandId.make("undo-id-only-attach"),
        threadId: system.threadId,
        worktreeId,
        attachedAt: now(),
      }),
    );
    // A normal metadata edit retains the ID association while changing its
    // legacy path, and gives both projections the same event timestamp.
    await system.run(
      system.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("legacy-checkout-path"),
        threadId: system.threadId,
        title: "Synthetic attached fixture",
        worktreePath: threadPath,
      }),
    );
    return { ...system, worktreeId, checkout };
  } catch (error) {
    await system.dispose();
    throw error;
  }
}

function storageGuardCommands(
  threadId: ThreadId,
  undoCommandId: CommandId,
): OrchestrationCommand[] {
  const message = {
    messageId: MessageId.make("blocked-message"),
    role: "user" as const,
    text: "Synthetic",
    attachments: [],
  };
  const at = now();
  return [
    {
      type: "thread.sidebar.undo",
      commandId: CommandId.make("undo-id-only"),
      undoCommandId,
      threadId,
    },
    {
      type: "thread.turn.start",
      commandId: CommandId.make("blocked-turn"),
      threadId,
      message,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at,
    },
    {
      type: "thread.turn.steer",
      commandId: CommandId.make("blocked-steer"),
      threadId,
      message,
      expectedTurnId: TurnId.make("synthetic-turn"),
      createdAt: at,
      requestedAt: at,
    },
    {
      type: "thread.goal.set",
      commandId: CommandId.make("blocked-goal"),
      threadId,
      objective: "Synthetic goal",
      status: "active",
      createdAt: at,
    },
  ];
}

it.each([
  { state: "removing", target: "attached" },
  { state: "removed", target: "attached" },
  { state: "removing", target: "project" },
  { state: "removed", target: "project" },
])(
  "refuses Undo and activation for an ID-only worktree or its effective cwd: %j",
  async ({ state, target }) => {
    const system = await seedAttachedSidebarUndoSystem(null);
    const archiveId = CommandId.make("undo-id-only-archive");
    try {
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: archiveId,
          threadId: system.threadId,
        }),
      );
      const before = (await system.readModel()).threads[0]!;
      expect(before.worktreePath).toBeNull();
      expect(before.worktreeId).toBe(system.worktreeId);
      const canonical = await canonicalStoragePath(
        target === "attached" ? system.checkout : "/tmp/ryco-synthetic-undo",
      );
      await system.run(
        system.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('undo-id-only', ${canonical}, 'worktree', '{}', '2026-01-01', ${state})`,
      );
      for (const command of storageGuardCommands(system.threadId, archiveId))
        await expect(system.run(system.engine.dispatch(command))).rejects.toThrow(
          "Checkout cleanup is pending or complete",
        );
      expect((await system.readModel()).threads[0]).toEqual(before);
    } finally {
      await system.dispose();
    }
  },
);

it.each([
  { state: "removing", target: "legacy" },
  { state: "removed", target: "legacy" },
  { state: "removing", target: "attached" },
  { state: "removed", target: "attached" },
])(
  "checks both paths of a mismatched attachment while preserving healthy Undo: %j",
  async ({ state, target }) => {
    const legacyPath = "/tmp/ryco-synthetic-undo/legacy-checkout";
    const system = await seedAttachedSidebarUndoSystem(legacyPath);
    const archiveId = CommandId.make("mismatch-archive");
    try {
      const original = (await system.readModel()).threads[0]!;
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("healthy-mismatch-archive"),
          threadId: system.threadId,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.sidebar.undo",
          commandId: CommandId.make("healthy-mismatch-undo"),
          undoCommandId: CommandId.make("healthy-mismatch-archive"),
          threadId: system.threadId,
        }),
      );
      expect(sidebarFields((await system.readModel()).threads[0]!)).toEqual(
        sidebarFields(original),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: archiveId,
          threadId: system.threadId,
        }),
      );
      const before = (await system.readModel()).threads[0]!;
      expect(before.worktreePath).toBe(legacyPath);
      expect(before.worktreeId).toBe(system.worktreeId);
      const canonical = await canonicalStoragePath(
        target === "legacy" ? legacyPath : system.checkout,
      );
      await system.run(
        system.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('undo-mismatch', ${canonical}, 'worktree', '{}', '2026-01-01', ${state})`,
      );
      for (const command of storageGuardCommands(system.threadId, archiveId))
        await expect(system.run(system.engine.dispatch(command))).rejects.toThrow(
          "Checkout cleanup is pending or complete",
        );
      expect((await system.readModel()).threads[0]).toEqual(before);
    } finally {
      await system.dispose();
    }
  },
);

const DELEGATION_PARENT_ID = ThreadId.make("delegation-parent");
const delegationAt = (seconds: number) =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000).toISOString();

type DelegationSystem = Awaited<ReturnType<typeof createOrchestrationSystem>>;
type DelegationReturnCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type DelegationReturnGuardFields = NonNullable<DelegationReturnCommand["delegationReturnGuard"]>;

// Engine commands only (no provider reactors): a parent with two completed turns,
// each bound to its own user message through projection_turns.pending_message_id.
async function seedDelegationParent(databasePath?: string) {
  const system = await createOrchestrationSystem(databasePath);
  try {
    const projectId = ProjectId.make("delegation-project");
    const threadId = DELEGATION_PARENT_ID;
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("delegation-project-create"),
        projectId,
        title: "Delegation fixture",
        workspaceRoot: "/tmp/ryco-delegation-fixture",
        defaultModelSelection: modelSelection,
        createdAt: delegationAt(0),
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("delegation-thread-create"),
        threadId,
        projectId,
        title: "Delegation parent",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: delegationAt(0),
      }),
    );
    for (const turn of [1, 2]) {
      const t = turn === 1 ? 1 : 10;
      const turnId = TurnId.make(`turn-${turn}`);
      const session = {
        threadId,
        status: "running" as const,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeSessionId: RuntimeSessionId.make("runtime-1"),
        runtimeMode: "full-access" as const,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: delegationAt(t + 1),
      };
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`start-${turn}`),
          threadId,
          message: {
            messageId: MessageId.make(`msg-${turn}`),
            role: "user",
            text: `Fixture ${turn}`,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: delegationAt(t),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`running-${turn}`),
          threadId,
          session,
          createdAt: delegationAt(t + 1),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`answer-${turn}`),
          threadId,
          messageId: MessageId.make(`answer-${turn}`),
          turnId,
          text: "Fixture answer",
          createdAt: delegationAt(t + 2),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`ready-${turn}`),
          threadId,
          session: {
            ...session,
            status: "ready",
            activeTurnId: null,
            updatedAt: delegationAt(t + 3),
          },
          // Mirrors ingestion: a provider turn.completed releases the turn with its outcome.
          turnOutcome: {
            turnId,
            state: "completed",
            reason: "provider-turn-completed",
            completedAt: delegationAt(t + 3),
          },
          createdAt: delegationAt(t + 3),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`diff-${turn}`),
          threadId,
          turnId,
          completedAt: delegationAt(t + 3),
          checkpointRef: CheckpointRef.make(`fixture-checkpoint-${turn}`),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make(`answer-${turn}`),
          checkpointTurnCount: turn,
          createdAt: delegationAt(t + 3),
        }),
      );
    }
    return system;
  } catch (error) {
    await system.dispose();
    throw error;
  }
}

function delegationRepository(system: DelegationSystem) {
  return system.run(
    makeCompletionReturnRepository.pipe(Effect.provideService(SqlClient.SqlClient, system.sql)),
  );
}

// Mirrors CompletionReturnDelivery's guard construction. If delegation-returns extracts a
// shared guard builder, call it here instead.
async function buildDelegatedReturn(
  system: DelegationSystem,
  overrides: Partial<DelegationReturnGuardFields> = {},
): Promise<DelegationReturnCommand> {
  const shell = (await system.readShell()).threads.find(
    (thread) => thread.id === DELEGATION_PARENT_ID,
  );
  if (!shell?.latestTurn || !shell.session) throw new Error("Delegation parent fixture missing");
  const repository = await delegationRepository(system);
  const turnId = shell.latestTurn.turnId;
  const turnMessageId = await system.run(repository.turnMessageId(DELEGATION_PARENT_ID, turnId));
  expect(turnMessageId).not.toBeNull();
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("delegation-return:child-1"),
    threadId: DELEGATION_PARENT_ID,
    delegationReturnGuard: {
      turnMessageId: turnMessageId!,
      latestUserMessageId: await system.run(repository.latestUserMessageId(DELEGATION_PARENT_ID)),
      projectId: shell.projectId,
      turnId,
      runtimeSessionId: shell.session.runtimeSessionId!,
      providerInstanceId: shell.session.providerInstanceId!,
      runtimeMode: shell.runtimeMode,
      worktreePath: shell.worktreePath,
      ...overrides,
    },
    message: {
      messageId: MessageId.make("delegation-result:child-1"),
      role: "user",
      text: "Fixture delegated result",
      attachments: [],
    },
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    ...(shell.tokenMode === undefined ? {} : { tokenMode: shell.tokenMode }),
    createdAt: delegationAt(30),
  };
}

describe("delegated return fence across restarts", () => {
  it("accepts a delegated return without a restart (fixture control)", async () => {
    const system = await seedDelegationParent();
    try {
      await system.run(system.engine.dispatch(await buildDelegatedReturn(system)));
      const repository = await delegationRepository(system);
      expect(await system.run(repository.latestUserMessageId(DELEGATION_PARENT_ID))).toBe(
        "delegation-result:child-1",
      );
    } finally {
      await system.dispose();
    }
  });

  it("accepts a delegated return to a parent whose latest user message predates a restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-delegation-restart-"));
    const database = path.join(directory, "state.sqlite");
    let system = await seedDelegationParent(database);
    try {
      await system.dispose();
      system = await createOrchestrationSystem(database);
      const model = await system.commandReadModel();
      const parent = model.threads.find((thread) => thread.id === DELEGATION_PARENT_ID)!;
      expect(parent.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
      const latestUserMessage = parent.messages.findLast((message) => message.role === "user");
      const repository = await delegationRepository(system);
      expect(await system.run(repository.latestUserMessageId(DELEGATION_PARENT_ID))).toBe("msg-2");
      expect(latestUserMessage?.id).toBe("msg-2");
      const [projected] = await system.run(
        system.sql<{ readonly latestUserMessageAt: string | null }>`
          SELECT latest_user_message_at AS "latestUserMessageAt"
          FROM projection_threads WHERE thread_id = ${DELEGATION_PARENT_ID}
        `,
      );
      expect(projected?.latestUserMessageAt).toBe(delegationAt(10));
      expect(threadSettlementInput(model, parent, delegationAt(30)).latestUserMessageAt).toBe(
        delegationAt(10),
      );
      expect(latestUserMessage?.createdAt).toBe(delegationAt(10));

      await expect(
        system.run(system.engine.dispatch(await buildDelegatedReturn(system))),
      ).resolves.toBeDefined();
    } finally {
      await system.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps rejecting a guard pinned to an older user message after a restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-delegation-fence-"));
    const database = path.join(directory, "state.sqlite");
    let system = await seedDelegationParent(database);
    try {
      await system.dispose();
      system = await createOrchestrationSystem(database);
      // After a restart the fence was weaker than before it. This is not reachable through
      // CompletionReturnDelivery, which re-reads the latest id from SQL, and a guard only
      // adds rejections.
      const command = await buildDelegatedReturn(system, {
        latestUserMessageId: MessageId.make("msg-1"),
        turnMessageId: MessageId.make("msg-1"),
      });
      expect(command.delegationReturnGuard?.turnId).toBe("turn-2");
      await expect(system.run(system.engine.dispatch(command))).rejects.toThrow(
        "Delegated result origin changed",
      );
    } finally {
      await system.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("usage limits across projections and restarts", () => {
  const limitThreadId = ThreadId.make("usage-limit-thread");
  const limitTurnId = TurnId.make("usage-limit-turn");
  const limitId = `usage-limit:${limitThreadId}:${limitTurnId}`;
  const claude = ProviderInstanceId.make("claudeAgent");
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 4, 10, 0, seconds)).toISOString();

  async function seedLimitedThread(databasePath: string) {
    const system = await createOrchestrationSystem(databasePath);
    const projectId = ProjectId.make("usage-limit-project");
    const modelSelection = { instanceId: claude, model: "claude-sonnet-4-5" };
    const session = (overrides: Record<string, unknown>) => ({
      threadId: limitThreadId,
      status: "running" as const,
      providerName: "claudeAgent",
      providerInstanceId: claude,
      runtimeSessionId: RuntimeSessionId.make("runtime-limit"),
      runtimeMode: "full-access" as const,
      activeTurnId: limitTurnId,
      lastError: null,
      updatedAt: at(2),
      ...overrides,
    });
    const commands: OrchestrationCommand[] = [
      {
        type: "project.create",
        commandId: CommandId.make("limit-project-create"),
        projectId,
        title: "Limits",
        workspaceRoot: "/tmp/ryco-usage-limit-fixture",
        defaultModelSelection: modelSelection,
        createdAt: at(0),
      },
      {
        type: "thread.create",
        commandId: CommandId.make("limit-thread-create"),
        threadId: limitThreadId,
        projectId,
        title: "Limited",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: at(0),
      },
      {
        type: "thread.turn.start",
        commandId: CommandId.make("limit-start"),
        threadId: limitThreadId,
        message: {
          messageId: MessageId.make("limit-message"),
          role: "user",
          text: "Work",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: at(1),
      },
      {
        type: "thread.session.set",
        commandId: CommandId.make("limit-running"),
        threadId: limitThreadId,
        session: session({}),
        createdAt: at(2),
      },
      {
        type: "thread.session.set",
        commandId: CommandId.make("limit-error"),
        threadId: limitThreadId,
        session: session({ status: "error", activeTurnId: null, lastError: "Limited" }),
        turnOutcome: { turnId: limitTurnId, state: "error", reason: "usage-limit" },
        createdAt: at(3),
      },
      {
        type: "thread.usage-limit.record",
        commandId: CommandId.make(`usage-limit-record:${limitId}`),
        threadId: limitThreadId,
        limitId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claude,
        turnId: limitTurnId,
        message: "Claude usage limit reached.",
        resetAt: at(50),
        createdAt: at(3),
      },
    ];
    for (const command of commands) {
      await system.run(system.engine.dispatch(command));
    }
    return system;
  }

  const resume = (commandId: string): OrchestrationCommand => ({
    type: "thread.turn.start",
    commandId: CommandId.make(commandId),
    threadId: limitThreadId,
    message: {
      messageId: MessageId.make(commandId),
      role: "user",
      text: "Continue where you left off.",
      attachments: [],
    },
    usageLimitResumeGuard: { limitId, origin: "auto" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: at(60),
  });

  it("projects the limit into shells, detail and the command model, and fences resumes after a restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-usage-limit-restart-"));
    const database = path.join(directory, "state.sqlite");
    let system = await seedLimitedThread(database);
    try {
      const shell = (await system.readShell()).threads.find((t) => t.id === limitThreadId);
      expect(shell?.usageLimit).toMatchObject({ limitId, resetAt: at(50), autoResume: null });
      const detail = (await system.readModel()).threads.find((t) => t.id === limitThreadId);
      expect(detail?.usageLimit?.limitId).toBe(limitId);

      await system.dispose();
      system = await createOrchestrationSystem(database);
      const hydrated = (await system.commandReadModel()).threads.find(
        (t) => t.id === limitThreadId,
      );
      expect(hydrated?.usageLimit?.limitId).toBe(limitId);

      await system.run(system.engine.dispatch(resume("usage-limit-resume-first")));
      await expect(
        system.run(system.engine.dispatch(resume("usage-limit-resume-second"))),
      ).rejects.toThrow("usage-limit resume is stale");
      const cleared = (await system.readShell()).threads.find((t) => t.id === limitThreadId);
      expect(cleared?.usageLimit ?? null).toBeNull();
    } finally {
      await system.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
