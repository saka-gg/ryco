import { ProjectionPendingApprovalRepository } from "./persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionThreadUserInputRequestRepository } from "./persistence/Services/ProjectionThreadUserInputRequests.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  DEFAULT_MODEL,
  type OrchestrationReadModel,
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Metric,
  Option,
  PubSub,
  Ref,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "./config.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { metricNames } from "./observability/Metrics.ts";
import { hasMetricSnapshot } from "./observability/testMetricSnapshots.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "./provider/Services/ProviderSessionDirectory.ts";
import { ProviderAdapterRequestError } from "./provider/Errors.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import {
  getAutoBootstrapDefaultModelSelection,
  launchStartupHeartbeat,
  makeCommandGate,
  reconcileOrphanedProviderSessions,
  resolveAutoBootstrapWelcomeTargets,
  resolveWelcomeBase,
  ServerRuntimeStartupError,
  validateRestrictedWorkspaceSnapshot,
} from "./serverRuntimeStartup.ts";
import { WorkspaceAccessPolicyLayer } from "./workspace/Layers/WorkspaceAccessPolicy.ts";

const startupWorkspaceSnapshot = (input: {
  readonly projectRoot: string;
  readonly worktreePath?: string;
}): OrchestrationReadModel =>
  ({
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("startup-project"),
        title: "Startup project",
        workspaceRoot: input.projectRoot,
        defaultModelSelection: getAutoBootstrapDefaultModelSelection(),
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    worktrees:
      input.worktreePath === undefined
        ? []
        : [
            {
              worktreeId: WorktreeId.make("startup-worktree"),
              projectId: ProjectId.make("startup-project"),
              branch: "feature/startup",
              worktreePath: input.worktreePath,
              origin: "branch",
              prNumber: null,
              issueNumber: null,
              prTitle: null,
              issueTitle: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              archivedAt: null,
              manualPosition: 0,
            },
          ],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as OrchestrationReadModel;

const orphanedSessionThread = (input: {
  readonly id: string;
  readonly status: "starting" | "running" | "ready" | "stopped" | "error";
  readonly activeTurnId?: TurnId | null;
}) => ({
  id: ThreadId.make(input.id),
  archivedAt: null,
  deletedAt: null,
  activities: [] as OrchestrationThreadActivity[],
  session: {
    threadId: ThreadId.make(input.id),
    status: input.status,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeTurnId: input.activeTurnId ?? null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

const runOrphanedSessionReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof orphanedSessionThread>>;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
  readonly directory: Pick<ProviderSessionDirectoryShape, "getBinding" | "upsert">;
  readonly stopSessionBinding?: ProviderServiceShape["stopSessionBinding"];
  readonly dispatch: OrchestrationEngineShape["dispatch"];
}) =>
  reconcileOrphanedProviderSessions.pipe(
    Effect.provideService(ProjectionPendingApprovalRepository, {
      upsert: () => Effect.void,
      listByThreadId: () => Effect.succeed([]),
      deleteByRequestId: () => Effect.void,
      deleteByThreadId: () => Effect.void,
      getByRequestId: ({ threadId, requestId }) =>
        Effect.succeed(
          Option.some({
            threadId,
            requestId,
            status: "pending",
            approvalIdentity: {
              requestEventId: EventId.make("callback"),
              runtimeSessionId: RuntimeSessionId.make("test-live-runtime"),
            },
            decision: null,
            turnId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: null,
          }),
        ),
    } as ProjectionPendingApprovalRepository["Service"]),
    Effect.provideService(ProjectionThreadUserInputRequestRepository, {
      upsert: () => Effect.void,
      deleteByThreadId: () => Effect.void,
      getByRequestId: ({ threadId, requestId }) =>
        Effect.succeed(
          Option.some({
            threadId,
            requestId,
            isPending: true,
            userInputIdentity: {
              requestEventId: EventId.make("callback"),
              runtimeSessionId: RuntimeSessionId.make("test-live-runtime"),
            },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
    } as ProjectionThreadUserInputRequestRepository["Service"]),
    Effect.provideService(ProjectionSnapshotQuery, {
      getCommandReadModel: () =>
        Effect.succeed({ threads: input.threads } as unknown as OrchestrationReadModel),
    } as unknown as ProjectionSnapshotQueryShape),
    Effect.provideService(ProviderSessionDirectory, {
      ...input.directory,
    } as unknown as ProviderSessionDirectoryShape),
    Effect.provideService(ProviderService, {
      listSessions: () =>
        Effect.succeed(
          (input.liveThreadIds ?? []).map(
            (threadId) =>
              ({ threadId, runtimeSessionId: RuntimeSessionId.make("test-live-runtime") }) as never,
          ),
        ),
      stopSessionBinding: input.stopSessionBinding ?? (() => Effect.succeed("not-found" as const)),
    } as unknown as ProviderServiceShape),
    Effect.provideService(OrchestrationEngineService, {
      dispatch: input.dispatch,
    } as unknown as OrchestrationEngineShape),
  );

it("uses the canonical Codex default for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("repairs orphaned provider sessions while preserving resumable binding state", () => {
  const orphan = orphanedSessionThread({
    id: "thread-startup-orphan",
    status: "running",
    activeTurnId: TurnId.make("turn-startup-orphan"),
  });
  const starting = orphanedSessionThread({
    id: "thread-startup-starting",
    status: "starting",
  });
  const live = orphanedSessionThread({
    id: "thread-startup-live",
    status: "running",
    activeTurnId: TurnId.make("turn-startup-live"),
  });
  const ready = orphanedSessionThread({ id: "thread-startup-ready", status: "ready" });
  const dispatches: OrchestrationCommand[] = [];
  const stoppedBindings: ProviderRuntimeBinding[] = [];
  const upserts: ProviderRuntimeBinding[] = [];
  const bindingByThread = new Map<ThreadId, ProviderRuntimeBinding>([
    [
      orphan.id,
      {
        threadId: orphan.id,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        resumeCursor: { cursor: "resume-orphan" },
        runtimePayload: { activeTurnId: "stale", unrelated: "preserve-me" },
      },
    ],
    [
      starting.id,
      {
        threadId: starting.id,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "stopped",
        resumeCursor: { cursor: "resume-starting" },
        runtimePayload: { unrelated: "also-preserve-me" },
      },
    ],
  ]);

  return runOrphanedSessionReconciliation({
    threads: [orphan, starting, live, ready],
    liveThreadIds: [live.id],
    directory: {
      getBinding: (threadId) => {
        const binding = bindingByThread.get(threadId);
        return Effect.succeed(binding === undefined ? Option.none() : Option.some(binding));
      },
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
    },
    stopSessionBinding: (binding) =>
      Effect.sync(() => stoppedBindings.push(binding)).pipe(
        Effect.andThen(
          binding.threadId === starting.id
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session.stop",
                  detail: "provider process already exited",
                }),
              )
            : Effect.succeed("not-found" as const),
        ),
      ),
    dispatch: (command) =>
      Effect.sync(() => dispatches.push(command)).pipe(Effect.as({ sequence: dispatches.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          stoppedBindings.map((binding) => binding.threadId),
          [orphan.id, starting.id],
        );
        assert.deepStrictEqual(
          upserts.map((binding) => ({
            threadId: binding.threadId,
            status: binding.status,
            resumeCursor: binding.resumeCursor,
            runtimePayload: binding.runtimePayload,
          })),
          [
            {
              threadId: orphan.id,
              status: "stopped",
              resumeCursor: { cursor: "resume-orphan" },
              runtimePayload: { activeTurnId: null, unrelated: "preserve-me" },
            },
            {
              threadId: starting.id,
              status: "stopped",
              resumeCursor: { cursor: "resume-starting" },
              runtimePayload: { activeTurnId: null, unrelated: "also-preserve-me" },
            },
          ],
        );
        assert.deepStrictEqual(
          dispatches.map((command) => ({
            type: command.type,
            threadId: "threadId" in command ? command.threadId : null,
            status: command.type === "thread.session.set" ? command.session.status : undefined,
            activeTurnId:
              command.type === "thread.session.set" ? command.session.activeTurnId : undefined,
          })),
          [
            {
              type: "thread.turn.interrupt",
              threadId: orphan.id,
              status: undefined,
              activeTurnId: undefined,
            },
            {
              type: "thread.session.set",
              threadId: orphan.id,
              status: "error",
              activeTurnId: null,
            },
            {
              type: "thread.session.set",
              threadId: starting.id,
              status: "error",
              activeTurnId: null,
            },
          ],
        );
        for (const command of dispatches) {
          if (command.type === "thread.session.set") {
            assert.match(command.session.lastError ?? "", /did not survive a server restart/);
          }
        }
      }),
    ),
  );
});

it.effect("retries a failed orphan projection and continues after a persistent failure", () => {
  const transient = orphanedSessionThread({ id: "thread-orphan-transient", status: "running" });
  const persistent = orphanedSessionThread({ id: "thread-orphan-persistent", status: "running" });
  const later = orphanedSessionThread({ id: "thread-orphan-later", status: "running" });
  const attempted: ThreadId[] = [];
  let transientAttempts = 0;
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated startup reconciliation failure",
  });

  return runOrphanedSessionReconciliation({
    threads: [transient, persistent, later],
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
    },
    dispatch: (command) => {
      if (command.type !== "thread.session.set") {
        return Effect.die("unexpected command");
      }
      attempted.push(command.threadId);
      if (command.threadId === transient.id && transientAttempts++ === 0) {
        return Effect.fail(failure);
      }
      return command.threadId === persistent.id
        ? Effect.fail(failure)
        : Effect.succeed({ sequence: attempted.length });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(attempted, [
          transient.id,
          transient.id,
          persistent.id,
          persistent.id,
          later.id,
        ]);
      }),
    ),
  );
});

it.effect("restricted startup rejects active project roots outside the workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const accessRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-restricted-startup-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-outside-startup-" });

      const error = yield* validateRestrictedWorkspaceSnapshot(
        startupWorkspaceSnapshot({ projectRoot: outsideRoot }),
      ).pipe(Effect.provide(WorkspaceAccessPolicyLayer(accessRoot)), Effect.flip);

      assert.equal(error.reason, "startup");
      assert.match(error.message, /fresh --base-dir/);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("restricted startup accepts active projects and worktrees inside the workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const accessRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-restricted-startup-" });
      const projectRoot = `${accessRoot}/project`;
      const worktreePath = `${accessRoot}/.ryco/worktrees/project/feature`;
      yield* fs.makeDirectory(projectRoot, { recursive: true });
      yield* fs.makeDirectory(worktreePath, { recursive: true });

      yield* validateRestrictedWorkspaceSnapshot(
        startupWorkspaceSnapshot({ projectRoot, worktreePath }),
      ).pipe(Effect.provide(WorkspaceAccessPolicyLayer(accessRoot)));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("unrestricted startup preserves existing out-of-root state", () =>
  Effect.scoped(
    validateRestrictedWorkspaceSnapshot(
      startupWorkspaceSnapshot({ projectRoot: "/outside/project" }),
    ).pipe(
      Effect.provide(
        WorkspaceAccessPolicyLayer(undefined).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  ),
);

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* makeCommandGate();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate();
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          message: "startup failed",
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "startup failed");
    }),
  ),
);

it.effect("enqueueCommand rejects new work when the startup gate is full", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate({ maxPendingCommands: 1 });
      const releaseQueuedCommand = yield* Deferred.make<void, never>();

      yield* commandGate
        .enqueueCommand(Deferred.await(releaseQueuedCommand))
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* commandGate.enqueueCommand(Effect.void).pipe(Effect.flip);
      assert.equal(error.reason, "busy");

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.startupCommandGateEnqueuesTotal, {
          outcome: "busy",
          maxPendingCommands: "1",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.startupCommandGateQueueHighWater, {
          maxPendingCommands: "1",
        }),
        true,
      );
    }),
  ),
);

it.effect("enqueueCommand times out queued work when startup readiness never arrives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate({
        maxPendingCommands: 1,
        readyTimeoutMs: 1,
      });

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Effect.succeed("unused"))
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1));

      const error = yield* Fiber.join(queuedCommandFiber).pipe(Effect.flip);
      assert.equal(error.reason, "timeout");

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.startupCommandGateEnqueuesTotal, {
          outcome: "timeout",
          maxPendingCommands: "1",
        }),
        true,
      );
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("enqueueCommand measures queued readiness timeouts from enqueue time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate({
        maxPendingCommands: 2,
        readyTimeoutMs: 1,
      });

      const firstQueuedCommandFiber = yield* commandGate
        .enqueueCommand(Effect.succeed("first-unused"))
        .pipe(Effect.forkScoped);
      const secondQueuedCommandFiber = yield* commandGate
        .enqueueCommand(Effect.succeed("second-unused"))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1));

      const firstError = yield* Fiber.join(firstQueuedCommandFiber).pipe(Effect.flip);
      const secondError = yield* Fiber.join(secondQueuedCommandFiber).pipe(Effect.flip);

      assert.equal(firstError.reason, "timeout");
      assert.equal(secondError.reason, "timeout");
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          searchThreadMessages: () => Effect.succeed([]),
        }),
        Effect.provideService(AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: getAutoBootstrapDefaultModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        searchThreadMessages: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readEventsPage: (fromSequenceExclusive) =>
          Effect.succeed({
            events: [],
            nextSequence: fromSequenceExclusive,
            hasMore: false,
          }),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
          return yield* PubSub.subscribe(pubsub);
        }),
      } satisfies OrchestrationEngineShape),
      Effect.provide(Layer.merge(ServerSettingsService.layerTest(), NodeServices.layer)),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const targets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        searchThreadMessages: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readEventsPage: (fromSequenceExclusive) =>
          Effect.succeed({
            events: [],
            nextSequence: fromSequenceExclusive,
            hasMore: false,
          }),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
          return yield* PubSub.subscribe(pubsub);
        }),
      } satisfies OrchestrationEngineShape),
      Effect.provide(
        Layer.merge(
          ServerSettingsService.layerTest({ defaultAgentTokenMode: "aggressive" }),
          NodeServices.layer,
        ),
      ),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    const commands = yield* Ref.get(dispatchCalls);
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["project.create", "thread.create"],
    );
    assert.deepInclude(commands[1], { type: "thread.create", tokenMode: "aggressive" });
  }),
);

it.effect("clears orphaned requests in inactive sessions but preserves live callbacks", () => {
  const stale = orphanedSessionThread({ id: "stale-input", status: "ready" });
  const live = orphanedSessionThread({ id: "live-input", status: "running" });
  for (const thread of [stale, live]) {
    for (const kind of ["approval", "user-input"]) {
      thread.activities.push({
        id: EventId.make(`${thread.id}-${kind}`),
        kind: `${kind}.requested`,
        payload: { requestId: `${thread.id}-${kind}` },
        tone: "info",
        summary: "Input needed",
        turnId: TurnId.make("old-turn"),
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  const commands: OrchestrationCommand[] = [];
  return runOrphanedSessionReconciliation({
    threads: [stale, live],
    liveThreadIds: [live.id],
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
    },
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          commands.map((command) =>
            command.type === "thread.activity.append" ? command.threadId : null,
          ),
          [stale.id, stale.id],
        );
        assert.deepStrictEqual(
          commands.map((command) =>
            command.type === "thread.activity.append" ? command.activity.kind : command.type,
          ),
          ["provider.approval.respond.failed", "provider.user-input.respond.failed"],
        );
      }),
    ),
  );
});
