import { ProjectionPendingApprovalRepository } from "./persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionThreadUserInputRequestRepository } from "./persistence/Services/ProjectionThreadUserInputRequests.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ContextHandoffId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
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
import { classifyThreadSettlement } from "@ryco/shared/threadSettlement";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { assert, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Metric,
  Option,
  PubSub,
  Ref,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { canonicalJson, sha256Hex } from "./canonicalJson.ts";
import { ServerConfig } from "./config.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { Keybindings } from "./keybindings.ts";
import { Open } from "./open.ts";
import { AdvertisedEndpointRegistry } from "./remote/Services/AdvertisedEndpointRegistry.ts";
import { HttpServer } from "effect/http";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { WorkspaceAccessPolicy } from "./workspace/Services/WorkspaceAccessPolicy.ts";
import { CompletionReturnRepository } from "./persistence/Layers/AgentControlCompletionReturns.ts";
import { ContextHandoffRepositoryLive } from "./persistence/Layers/ContextHandoffs.ts";
import {
  ContextHandoffRepository,
  type ContextHandoffRecord,
  type ContextHandoffRepositoryShape,
  makeRequestedContextHandoffRecord,
} from "./persistence/Services/ContextHandoffs.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { ProviderEffectIntentRepositoryLive } from "./persistence/Layers/ProviderEffectIntents.ts";
import {
  RestartContinuationRepository,
  RestartContinuationRepositoryLive,
} from "./persistence/Layers/RestartContinuations.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "./project/Services/ProjectAvatarStore.ts";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { RestartContinuationLive } from "./orchestration/Layers/RestartContinuation.ts";
import {
  CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR,
  ContextHandoffArtifactError,
  ContextHandoffService,
  ContextHandoffServiceLive,
  type ContextHandoffServiceShape,
} from "./orchestration/contextHandoff/ContextHandoffService.ts";
import { ORPHANED_TURN_TERMINAL_STATE } from "./orchestration/restartReconciliation.ts";
import { threadShellSettlementInput } from "./orchestration/threadSettlementInput.ts";
import * as ThreadBackgroundLiveness from "./orchestration/ThreadBackgroundLiveness.ts";
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
  launchStartupHeartbeat,
  makeCommandGate,
  makeServerRuntimeStartup,
  reconcileOrphanedProviderSessions,
  resolveAutoBootstrapWelcomeTargets,
  startOrchestrationRuntime,
  resolveWelcomeBase,
  ServerRuntimeStartupError,
  validateRestrictedWorkspaceSnapshot,
} from "./serverRuntimeStartup.ts";
import { WorkspaceAccessPolicyLayer } from "./workspace/Layers/WorkspaceAccessPolicy.ts";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor.ts";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper.ts";
import { ProviderInstanceBootGate } from "./provider/Services/ProviderInstanceBootGate.ts";
import {
  RestartContinuation,
  type RestartContinuationShape,
} from "./orchestration/Services/RestartContinuation.ts";

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
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
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
  readonly runningLatestTurnId?: TurnId;
  readonly sessionUpdatedAt?: string;
  readonly threadUpdatedAt?: string;
  readonly lastError?: string;
}) => ({
  id: ThreadId.make(input.id),
  updatedAt: input.threadUpdatedAt ?? "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  activities: [] as OrchestrationThreadActivity[],
  latestTurn:
    input.runningLatestTurnId === undefined
      ? null
      : {
          turnId: input.runningLatestTurnId,
          state: "running" as const,
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
  session: {
    threadId: ThreadId.make(input.id),
    status: input.status,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeTurnId: input.activeTurnId ?? null,
    lastError: input.lastError ?? null,
    updatedAt: input.sessionUpdatedAt ?? "2026-01-01T00:00:00.000Z",
  },
});

/** Reconcile tests run with restart continuation off: it captures nothing. */
const restartContinuationOff: RestartContinuationShape = {
  capture: () => Effect.succeed([]),
  publishCaptureEffects: () => Effect.void,
  recordShutdownHints: () => Effect.void,
  dispatchPending: () => Effect.void,
};

/** Context handoff stand-ins for startups whose threads never handed off. */
const noContextHandoffs = {
  repository: {
    listByThread: () => Effect.succeed([]),
  } as unknown as ContextHandoffRepositoryShape,
  service: {} as unknown as ContextHandoffServiceShape,
};

/** A handoff of `threadId` that failed with the digest error, as earlier versions recorded it. */
const digestFailedHandoff = (threadId: ThreadId, structuredContext: unknown = null) => ({
  ...makeRequestedContextHandoffRecord({
    handoffId: ContextHandoffId.make(`handoff-${threadId}`),
    threadId,
    sourceSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    targetSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5" },
    sourceRuntimeSessionId: RuntimeSessionId.make(`${threadId}-runtime`),
    firstMessageId: MessageId.make(`${threadId}-message`),
    createdAt: "2026-01-01T00:03:00.000Z",
    updatedAt: "2026-01-01T00:03:00.000Z",
  }),
  status: "failed" as const,
  structuredContext,
  contextDigest: structuredContext === null ? null : sha256Hex(canonicalJson(structuredContext)),
  error: CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR,
});

const runOrphanedSessionReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof orphanedSessionThread>>;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
  readonly listSessionsFails?: boolean;
  readonly onReadModel?: () => void;
  /** Serve the engine's in-memory read model instead of the SQL one. */
  readonly engineReadModel?: boolean;
  readonly directory: Pick<ProviderSessionDirectoryShape, "getBinding" | "upsert">;
  readonly stopSessionBinding?: ProviderServiceShape["stopSessionBinding"];
  readonly dispatch: OrchestrationEngineShape["dispatch"];
  /** The threads' context handoffs; only `verifiedHandoffIds` pass the stored-context check. */
  readonly handoffs?: ReadonlyArray<ContextHandoffRecord>;
  readonly verifiedHandoffIds?: ReadonlyArray<ContextHandoffId>;
}) =>
  reconcileOrphanedProviderSessions.pipe(
    Effect.provideService(ContextHandoffRepository, {
      ...noContextHandoffs.repository,
      listByThread: ({ threadId }) =>
        Effect.succeed((input.handoffs ?? []).filter((record) => record.threadId === threadId)),
    }),
    Effect.provideService(ContextHandoffService, {
      ...noContextHandoffs.service,
      loadStoredContext: ({ handoffId }) =>
        input.verifiedHandoffIds?.includes(handoffId)
          ? Effect.succeed({} as never)
          : Effect.fail(
              new ContextHandoffArtifactError({
                handoffId,
                reason: "digest-mismatch",
                message: CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR,
              }),
            ),
    }),
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
        Effect.sync(() => {
          input.onReadModel?.();
          return { threads: input.threads } as unknown as OrchestrationReadModel;
        }),
    } as unknown as ProjectionSnapshotQueryShape),
    Effect.provideService(ProviderSessionDirectory, {
      ...input.directory,
    } as unknown as ProviderSessionDirectoryShape),
    Effect.provideService(ProviderService, {
      listSessions: () =>
        input.listSessionsFails
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "session.list",
                detail: "inventory unavailable",
              }),
            )
          : Effect.succeed(
              (input.liveThreadIds ?? []).map(
                (threadId) =>
                  ({
                    threadId,
                    runtimeSessionId: RuntimeSessionId.make("test-live-runtime"),
                  }) as never,
              ),
            ),
      stopSessionBinding: input.stopSessionBinding ?? (() => Effect.succeed("not-found" as const)),
    } as unknown as ProviderServiceShape),
    Effect.provideService(OrchestrationEngineService, {
      dispatch: input.dispatch,
      ...(input.engineReadModel
        ? {
            getReadModel: () =>
              Effect.succeed({ threads: input.threads } as unknown as OrchestrationReadModel),
          }
        : {}),
    } as unknown as OrchestrationEngineShape),
    Effect.provideService(RestartContinuation, restartContinuationOff),
  );

it.effect("repairs from the engine's in-memory read model instead of hydrating SQL again", () => {
  const orphan = orphanedSessionThread({
    id: "thread-engine-model-orphan",
    status: "running",
    activeTurnId: TurnId.make("turn-engine-model-orphan"),
  });
  const dispatches: OrchestrationCommand[] = [];
  let sqlReads = 0;
  return runOrphanedSessionReconciliation({
    threads: [orphan],
    engineReadModel: true,
    onReadModel: () => {
      sqlReads += 1;
    },
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
    },
    dispatch: (command) =>
      Effect.sync(() => {
        dispatches.push(command);
        return { sequence: dispatches.length };
      }),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.equal(sqlReads, 0);
        assert.isTrue(
          dispatches.some(
            (command) => command.type === "thread.session.set" && command.threadId === orphan.id,
          ),
        );
      }),
    ),
  );
});

it.effect("repairs orphaned provider sessions while preserving resumable binding state", () => {
  const orphan = orphanedSessionThread({
    id: "thread-startup-orphan",
    status: "running",
    activeTurnId: TurnId.make("turn-startup-orphan"),
    // Output kept arriving after the session last changed.
    threadUpdatedAt: "2026-01-01T00:07:00.000Z",
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
            // One session-set per orphan: no separate provider interrupt.
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
            // A restart is not new activity: it never wakes a snoozed thread.
            assert.strictEqual(command.wakesSnoozed, false);
          }
        }
        const orphanCommand = dispatches[0];
        // The turn ends when work was last observed, not at boot.
        assert.deepStrictEqual(
          orphanCommand?.type === "thread.session.set" ? orphanCommand.turnOutcome : undefined,
          {
            turnId: TurnId.make("turn-startup-orphan"),
            state: "interrupted",
            reason: "startup-orphaned-session",
            completedAt: "2026-01-01T00:07:00.000Z",
          },
        );
        const startingCommand = dispatches[1];
        assert.deepStrictEqual(
          startingCommand?.type === "thread.session.set"
            ? startingCommand.turnOutcome?.state
            : undefined,
          "interrupted",
        );
        assert.isUndefined(
          startingCommand?.type === "thread.session.set"
            ? startingCommand.turnOutcome?.turnId
            : "unexpected",
        );
      }),
    ),
  );
});

it.effect("settles stale running turns behind released sessions at startup", () => {
  const behindReady = orphanedSessionThread({
    id: "thread-stale-ready",
    status: "ready",
    runningLatestTurnId: TurnId.make("turn-stale-ready"),
    sessionUpdatedAt: "2026-01-01T00:05:00.000Z",
  });
  const behindError = orphanedSessionThread({
    id: "thread-stale-error",
    status: "error",
    runningLatestTurnId: TurnId.make("turn-stale-error"),
    sessionUpdatedAt: "2026-01-01T00:06:00.000Z",
  });
  const behindStopped = orphanedSessionThread({
    id: "thread-stale-stopped",
    status: "stopped",
    runningLatestTurnId: TurnId.make("turn-stale-stopped"),
  });
  // Orphans (running session) and live threads are not stale-turn repairs.
  const orphan = orphanedSessionThread({
    id: "thread-stale-orphan",
    status: "running",
    activeTurnId: TurnId.make("turn-orphan"),
    runningLatestTurnId: TurnId.make("turn-orphan"),
  });
  const settled = orphanedSessionThread({ id: "thread-settled", status: "ready" });
  const dispatches: OrchestrationCommand[] = [];
  let readModelLoads = 0;

  return runOrphanedSessionReconciliation({
    threads: [behindReady, behindError, behindStopped, orphan, settled],
    onReadModel: () => {
      readModelLoads += 1;
    },
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
    },
    dispatch: (command) =>
      Effect.sync(() => dispatches.push(command)).pipe(Effect.as({ sequence: dispatches.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.strictEqual(readModelLoads, 1);
        assert.isFalse(dispatches.some((command) => command.type === "thread.turn.interrupt"));
        const sessionSets = dispatches.flatMap((command) =>
          command.type === "thread.session.set" ? [command] : [],
        );
        assert.deepStrictEqual(
          sessionSets.map((command) => ({
            threadId: command.threadId,
            status: command.session.status,
            turnOutcome: command.turnOutcome,
          })),
          [
            {
              threadId: behindReady.id,
              status: "ready",
              turnOutcome: {
                turnId: TurnId.make("turn-stale-ready"),
                state: "interrupted",
                reason: "startup-stale-turn",
                completedAt: "2026-01-01T00:05:00.000Z",
              },
            },
            {
              threadId: behindError.id,
              status: "error",
              turnOutcome: {
                turnId: TurnId.make("turn-stale-error"),
                state: "error",
                reason: "startup-stale-turn",
                completedAt: "2026-01-01T00:06:00.000Z",
              },
            },
            {
              threadId: behindStopped.id,
              status: "stopped",
              turnOutcome: {
                turnId: TurnId.make("turn-stale-stopped"),
                state: "interrupted",
                reason: "startup-stale-turn",
                completedAt: "2026-01-01T00:00:00.000Z",
              },
            },
            {
              threadId: orphan.id,
              status: "error",
              turnOutcome: {
                turnId: TurnId.make("turn-orphan"),
                state: "interrupted",
                reason: "startup-orphaned-session",
                completedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
        );
        // The stale-turn repair re-sends the unchanged session.
        assert.deepStrictEqual(sessionSets[0]?.session, behindReady.session);
      }),
    ),
  );
});

it.effect("settles stale running turns even when the provider inventory fails", () => {
  const behindReady = orphanedSessionThread({
    id: "thread-stale-inventory",
    status: "ready",
    runningLatestTurnId: TurnId.make("turn-stale-inventory"),
  });
  const orphan = orphanedSessionThread({
    id: "thread-orphan-inventory",
    status: "running",
    activeTurnId: TurnId.make("turn-orphan-inventory"),
  });
  const dispatches: OrchestrationCommand[] = [];
  return runOrphanedSessionReconciliation({
    threads: [behindReady, orphan],
    listSessionsFails: true,
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
    },
    dispatch: (command) =>
      Effect.sync(() => dispatches.push(command)).pipe(Effect.as({ sequence: dispatches.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        // Without an inventory, orphans cannot be told from live sessions and are left alone.
        assert.deepStrictEqual(
          dispatches.map((command) => [
            command.type,
            "threadId" in command ? command.threadId : null,
          ]),
          [["thread.session.set", behindReady.id]],
        );
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

it.effect(
  "puts a session a handoff left in the digest error back to rest when its context verifies",
  () => {
    const sessionUpdatedAt = "2026-01-01T00:04:00.000Z";
    const digestError = (id: string) =>
      orphanedSessionThread({
        id,
        status: "error",
        lastError: CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR,
        sessionUpdatedAt,
        threadUpdatedAt: "2026-01-01T00:05:00.000Z",
      });
    const repaired = digestError("thread-handoff-digest");
    // Its stored document still fails the check: the error stands.
    const unverified = digestError("thread-handoff-digest-unverified");
    const live = digestError("thread-handoff-digest-live");
    const providerError = orphanedSessionThread({
      id: "thread-provider-error",
      status: "error",
      lastError: "The provider crashed.",
    });
    const handoffs = [repaired, unverified, live, providerError].map((thread) =>
      digestFailedHandoff(thread.id),
    );
    const verifiedHandoffIds = [repaired, live, providerError].map((thread) =>
      ContextHandoffId.make(`handoff-${thread.id}`),
    );
    const boot = () => {
      const dispatches: OrchestrationCommand[] = [];
      return runOrphanedSessionReconciliation({
        threads: [repaired, unverified, live, providerError],
        liveThreadIds: [live.id],
        directory: {
          getBinding: () => Effect.succeed(Option.none()),
          upsert: () => Effect.void,
        },
        handoffs,
        verifiedHandoffIds,
        dispatch: (command) =>
          Effect.sync(() => dispatches.push(command)).pipe(
            Effect.as({ sequence: dispatches.length }),
          ),
      }).pipe(Effect.as(dispatches));
    };

    return Effect.gen(function* () {
      const first = yield* boot();
      assert.deepStrictEqual(first, [
        {
          type: "thread.session.set",
          commandId: CommandId.make(
            `server:startup-handoff-digest-repair:${repaired.id}:${sessionUpdatedAt}`,
          ),
          threadId: repaired.id,
          // Stopped without the error, still dated at its own last update: no new activity.
          session: { ...repaired.session, status: "stopped", lastError: null },
          wakesSnoozed: false,
          createdAt: (first[0] as { readonly createdAt: string }).createdAt,
        },
      ]);
      // A retried boot sends the same command, which the engine answers from its receipt.
      assert.deepStrictEqual(
        (yield* boot()).map((command) => command.commandId),
        [first[0]!.commandId],
      );
    });
  },
);

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
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_MODEL,
              },
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
        bootSequence: 0,
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

it.effect(
  "resolveAutoBootstrapWelcomeTargets creates a project and thread on the node default when missing",
  () =>
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
          bootSequence: 0,
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
            ServerSettingsService.layerTest({
              defaultAgentTokenMode: "aggressive",
              initialModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-node-default",
              },
            }),
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
      assert.deepNestedInclude(commands[1], { "modelSelection.model": "gpt-node-default" });
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

it.effect(
  "starts reactors, then reconciles orphaned sessions, then recovers provider intents",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const summary = {
        replayed: 0,
        cancelledTurnStarts: [],
        rejectedSteers: 0,
        retriedSessionStops: 0,
        handoffsAbandoned: 0,
        settledWithoutOutcome: 0,
      };
      const reactorScope = yield* Scope.make("sequential");
      const result = yield* startOrchestrationRuntime(reactorScope).pipe(
        Effect.provideService(OrchestrationReactor, {
          start: () => Effect.sync(() => void calls.push("start")),
          recoverProviderIntents: () =>
            Effect.sync(() => {
              calls.push("recover");
              return summary;
            }),
        }),
        Effect.provideService(ProviderSessionReaper, {
          start: () => Effect.sync(() => void calls.push("reaper")),
        } as unknown as ProviderSessionReaper["Service"]),
        Effect.provideService(ProjectionPendingApprovalRepository, {
          getByRequestId: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionPendingApprovalRepository["Service"]),
        Effect.provideService(ProjectionThreadUserInputRequestRepository, {
          getByRequestId: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionThreadUserInputRequestRepository["Service"]),
        Effect.provideService(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.succeed({ threads: [] } as unknown as OrchestrationReadModel),
        } as unknown as ProjectionSnapshotQueryShape),
        Effect.provideService(ProviderSessionDirectory, {} as ProviderSessionDirectoryShape),
        Effect.provideService(ProviderService, {
          listSessions: () => Effect.sync(() => (calls.push("reconcile"), [])),
        } as unknown as ProviderServiceShape),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: () => Effect.die("unused"),
        } as unknown as OrchestrationEngineShape),
        Effect.provideService(RestartContinuation, restartContinuationOff),
        Effect.provideService(ContextHandoffRepository, noContextHandoffs.repository),
        Effect.provideService(ContextHandoffService, noContextHandoffs.service),
      );
      yield* Scope.close(reactorScope, Exit.void);
      assert.strictEqual(result, summary);
      assert.deepStrictEqual(
        calls.filter((call) => call !== "reaper"),
        ["start", "reconcile", "recover"],
      );
      assert.isTrue(calls.indexOf("reaper") < calls.indexOf("reconcile"));
    }),
);

// ── restart continuation through the real startup ─────────────────────────

const emptyIntentRecovery = {
  replayed: 0,
  cancelledTurnStarts: [],
  rejectedSteers: 0,
  retriedSessionStops: 0,
  handoffsAbandoned: 0,
  settledWithoutOutcome: 0,
};

/** Everything `makeServerRuntimeStartup` needs besides orchestration and restart state. */
const startupShellStubs = (input: {
  readonly settings: ServerSettingsService["Service"];
  readonly reactorStart?: OrchestrationReactor["Service"]["start"];
  readonly listSessions?: ProviderServiceShape["listSessions"];
}) =>
  Layer.mergeAll(
    Layer.succeed(ServerSettingsService, input.settings),
    Layer.succeed(Keybindings, { start: Effect.void } as unknown as Keybindings["Service"]),
    Layer.succeed(ServerLifecycleEvents, {
      publish: () => Effect.succeed({} as never),
    } as unknown as ServerLifecycleEvents["Service"]),
    Layer.succeed(ServerEnvironment, {
      getDescriptor: Effect.succeed({ environmentId: "test-environment" } as never),
    } as unknown as ServerEnvironment["Service"]),
    Layer.succeed(WorkspaceAccessPolicy, {
      isRestricted: false,
    } as unknown as WorkspaceAccessPolicy["Service"]),
    Layer.succeed(OrchestrationReactor, {
      start: input.reactorStart ?? (() => Effect.void),
      recoverProviderIntents: () => Effect.succeed(emptyIntentRecovery),
    }),
    Layer.succeed(ProviderSessionReaper, {
      start: () => Effect.void,
    } as unknown as ProviderSessionReaper["Service"]),
    Layer.succeed(ProviderService, {
      listSessions: input.listSessions ?? (() => Effect.succeed([])),
      stopSessionBinding: () => Effect.succeed("not-found" as const),
    } as unknown as ProviderServiceShape),
    Layer.succeed(AnalyticsService, {
      record: () => Effect.void,
    } as unknown as AnalyticsService["Service"]),
    Layer.succeed(ServerAuth, {
      issueStartupPairingUrl: (baseUrl: string) => Effect.succeed(baseUrl),
    } as unknown as ServerAuth["Service"]),
    Layer.succeed(Open, { openBrowser: () => Effect.void } as unknown as Open["Service"]),
    // Only read by headless startup output.
    Layer.succeed(HttpServer.HttpServer, {} as unknown as HttpServer.HttpServer["Service"]),
    Layer.succeed(
      AdvertisedEndpointRegistry,
      {} as unknown as AdvertisedEndpointRegistry["Service"],
    ),
  );

const waitUntil = <A, E, R>(read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep(Duration.millis(10));
    }
    return yield* Effect.die("condition not reached");
  });

/**
 * The real orchestration, restart ledger, restart continuation and context handoff store behind
 * a real startup, with provider, settings and shell stubs. Records every command the continuation
 * sends.
 */
const restartStartupLayer = (input: {
  readonly continueThreadsAfterRestart: boolean;
  readonly bindings: Map<string, ProviderRuntimeBinding>;
  readonly commands: OrchestrationCommand[];
  readonly listSessions?: ProviderServiceShape["listSessions"];
}) => {
  const settings = {
    start: Effect.void,
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      continueThreadsAfterRestart: input.continueThreadsAfterRestart,
    }),
  } as unknown as ServerSettingsService["Service"];
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ContextHandoffServiceLive.pipe(Layer.provideMerge(ContextHandoffRepositoryLive)),
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("not implemented"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RestartContinuationRepositoryLive),
    Layer.provideMerge(ProviderEffectIntentRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-startup-restart-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const restartFakes = Layer.mergeAll(
    Layer.succeed(ProviderSessionDirectory, {
      getBinding: (id: ThreadId) => Effect.succeed(Option.fromNullishOr(input.bindings.get(id))),
      upsert: (binding: ProviderRuntimeBinding) =>
        Effect.sync(() => void input.bindings.set(binding.threadId, binding)),
    } as unknown as ProviderSessionDirectoryShape),
    Layer.succeed(CompletionReturnRepository, {
      get: () => Effect.succeed(undefined),
    } as unknown as CompletionReturnRepository["Service"]),
  );
  const recordingEngine = Layer.effect(
    OrchestrationEngineService,
    Effect.map(Effect.service(OrchestrationEngineService), (engine): OrchestrationEngineShape => ({
      ...engine,
      dispatch: (command, dispatchOptions) => {
        input.commands.push(command);
        return engine.dispatch(command, dispatchOptions);
      },
    })),
  );
  return RestartContinuationLive.pipe(
    Layer.provide(recordingEngine),
    Layer.provideMerge(
      startupShellStubs({
        settings,
        ...(input.listSessions ? { listSessions: input.listSessions } : {}),
      }),
    ),
    Layer.provideMerge(restartFakes),
    Layer.provideMerge(orchestration),
  );
};

/** A project and a thread whose turn the provider was running (the pre-restart projection). */
const seedRunningRestartThread = (input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly instanceId: ProviderInstanceId;
  readonly createProject: boolean;
  readonly at: (secondsAgo: number) => string;
  readonly secondsAgo: number;
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const { threadId: id, turnId: turn, instanceId, at } = input;
    if (input.createProject) {
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("restart-project"),
        projectId: ProjectId.make("restart-project"),
        title: "Restart",
        workspaceRoot: "/tmp/ryco-startup-restart",
        defaultModelSelection: { instanceId, model: "gpt-5" },
        createdAt: at(input.secondsAgo + 20),
      });
    }
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${id}-create`),
      threadId: id,
      projectId: ProjectId.make("restart-project"),
      title: id,
      modelSelection: { instanceId, model: "gpt-5" },
      interactionMode: "default",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: at(input.secondsAgo + 20),
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`${id}-start`),
      threadId: id,
      message: {
        messageId: MessageId.make(`${id}-message`),
        role: "user",
        text: "Work",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at(input.secondsAgo + 10),
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${id}-running`),
      threadId: id,
      session: {
        threadId: id,
        status: "running",
        providerName: "codex",
        providerInstanceId: instanceId,
        runtimeSessionId: RuntimeSessionId.make(`${id}-runtime`),
        runtimeMode: "full-access",
        activeTurnId: turn,
        lastError: null,
        updatedAt: at(input.secondsAgo),
      },
      createdAt: at(input.secondsAgo),
    });
  });

it.live(
  "captures before reconcile and continues only after the HTTP listener is up",
  () => {
    const threadId = ThreadId.make("restart-orphan");
    const turnId = TurnId.make("restart-orphan-turn");
    const approvalThreadId = ThreadId.make("restart-approval");
    const instanceId = ProviderInstanceId.make("codex");
    const continuationCommands: OrchestrationCommand[] = [];
    const bindings = new Map<string, ProviderRuntimeBinding>([
      [
        threadId,
        {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          status: "running",
          resumeCursor: { cursor: "resume" },
        },
      ],
    ]);
    const layer = restartStartupLayer({
      continueThreadsAfterRestart: true,
      bindings,
      commands: continuationCommands,
    });

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const repository = yield* RestartContinuationRepository;
      const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();
      const seeds = [
        [threadId, turnId],
        [approvalThreadId, TurnId.make("restart-approval-turn")],
      ] as const;
      for (const [index, [id, turn]] of seeds.entries()) {
        yield* seedRunningRestartThread({
          threadId: id,
          turnId: turn,
          instanceId,
          createProject: index === 0,
          at,
          secondsAgo: 40,
        });
      }
      // A final progress message completes the turn row mid-turn (the SQL shape).
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("restart-progress"),
        threadId,
        messageId: MessageId.make("restart-progress"),
        text: "Halfway there",
        turnId,
        createdAt: at(30),
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("restart-approval"),
        threadId: approvalThreadId,
        activity: {
          id: EventId.make("restart-approval"),
          kind: "approval.requested",
          tone: "approval",
          summary: "Approve the command",
          payload: {
            requestId: "restart-approval-request",
            requestKind: "command",
            runtimeSessionId: `${approvalThreadId}-runtime`,
          },
          turnId: TurnId.make("restart-approval-turn"),
          createdAt: at(30),
        },
        createdAt: at(30),
      });

      const turnStarts = () =>
        continuationCommands.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
            command.type === "thread.turn.start",
        );
      const rowOf = (id: ThreadId, turn: TurnId) =>
        repository
          .get({ threadId: id, sourceTurnId: turn })
          .pipe(Effect.map((row) => Option.getOrUndefined(row)));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const startup = yield* makeServerRuntimeStartup;
          yield* startup.awaitCommandReady;
          const approvalRow = yield* rowOf(approvalThreadId, TurnId.make("restart-approval-turn"));
          // Reconcile cleared the request in the same pass; capture saw it first.
          assert.deepInclude(approvalRow, { status: "skipped", reason: "pending-request" });
          assert.deepInclude(yield* rowOf(threadId, turnId), { status: "pending" });

          yield* Effect.sleep(Duration.millis(50));
          assert.deepStrictEqual(turnStarts(), []);

          yield* startup.markHttpServing;
          yield* waitUntil(
            Effect.sync(() => turnStarts().length),
            (count) => count > 0,
          );
          const row = yield* waitUntil(
            rowOf(threadId, turnId),
            (value) => value?.status !== "pending",
          );
          assert.deepInclude(row, { status: "dispatched" });
          const starts = turnStarts();
          assert.strictEqual(starts.length, 1);
          assert.strictEqual(starts[0]?.threadId, threadId);
          // The fence expects exactly what reconciliation left on the turn.
          assert.strictEqual(
            starts[0]?.restartContinuationGuard?.expectedLatestTurnState,
            ORPHANED_TURN_TERMINAL_STATE,
          );
        }),
      );
    }).pipe(Effect.provide(layer));
  },
  30_000,
);

it.live(
  "treats a restart as no new activity: old work still settles and snoozed work stays snoozed",
  () => {
    const staleId = ThreadId.make("restart-stale");
    const snoozedId = ThreadId.make("restart-snoozed");
    const instanceId = ProviderInstanceId.make("codex");
    const layer = restartStartupLayer({
      continueThreadsAfterRestart: false,
      bindings: new Map(),
      commands: [],
    });
    const eightDays = 8 * 24 * 3_600;

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();
      // The process died mid-turn eight days ago and has been down since.
      yield* seedRunningRestartThread({
        threadId: staleId,
        turnId: TurnId.make("restart-stale-turn"),
        instanceId,
        createProject: true,
        at,
        secondsAgo: eightDays,
      });
      // A finished thread whose idle session still read `running` when it was snoozed.
      const snoozedTurnId = TurnId.make("restart-snoozed-turn");
      yield* seedRunningRestartThread({
        threadId: snoozedId,
        turnId: snoozedTurnId,
        instanceId,
        createProject: false,
        at,
        secondsAgo: 120,
      });
      const idleSession = {
        threadId: snoozedId,
        providerName: "codex",
        providerInstanceId: instanceId,
        runtimeSessionId: RuntimeSessionId.make(`${snoozedId}-runtime`),
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
      };
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("restart-snoozed-turn-done"),
        threadId: snoozedId,
        session: { ...idleSession, status: "ready", updatedAt: at(100) },
        turnOutcome: { turnId: snoozedTurnId, state: "completed", reason: "test" },
        createdAt: at(100),
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("restart-snoozed-status-ping"),
        threadId: snoozedId,
        session: { ...idleSession, status: "running", updatedAt: at(90) },
        createdAt: at(90),
      });
      const snoozedUntil = at(-3_600);
      yield* engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("restart-snooze"),
        threadId: snoozedId,
        snoozedUntil,
      });

      const boot = Effect.scoped(
        Effect.gen(function* () {
          const startup = yield* makeServerRuntimeStartup;
          yield* startup.awaitCommandReady;
        }),
      );
      yield* boot;
      // A second boot finds nothing left to reconcile or explain.
      yield* boot;

      const shellOf = (threadId: ThreadId) =>
        snapshots.getThreadShellById(threadId).pipe(Effect.map(Option.getOrThrow));
      const stale = yield* shellOf(staleId);
      assert.strictEqual(stale.session?.status, "error");
      assert.strictEqual(stale.latestTurn?.state, ORPHANED_TURN_TERMINAL_STATE);
      assert.isBelow(
        Date.parse(stale.latestTurn?.completedAt ?? ""),
        Date.now() - 7 * 24 * 3_600_000,
      );
      const nowIso = new Date().toISOString();
      assert.strictEqual(
        classifyThreadSettlement({
          ...threadShellSettlementInput(stale, nowIso),
          autoSettleAfterDays: 7,
        }),
        "settled",
      );

      const snoozed = yield* shellOf(snoozedId);
      assert.strictEqual(snoozed.session?.status, "error");
      assert.strictEqual(snoozed.snoozedUntil, snoozedUntil);
      assert.strictEqual(snoozed.settledOverride, "active");
      // Clients derive the same: the release is not dated after the snooze.
      assert.isTrue(isThreadSnoozed(snoozed, Date.now()));
      const events = Array.from(yield* Stream.runCollect(engine.readEvents(0)));
      assert.isFalse(events.some((event) => event.type === "thread.unsnoozed"));

      // One explanation for the cut-off turn; the idle thread had no turn to cut off.
      const notices = (threadId: ThreadId) =>
        snapshots.getThreadDetailById(threadId).pipe(
          Effect.map(Option.getOrThrow),
          Effect.map((thread) =>
            thread.activities
              .filter((activity) => activity.kind === "restart.continuation-skipped")
              .map((activity) => activity.summary),
          ),
        );
      assert.deepStrictEqual(yield* notices(staleId), [
        "Interrupted by a server restart. Send a message to continue.",
      ]);
      assert.deepStrictEqual(yield* notices(snoozedId), []);
    }).pipe(Effect.provide(layer));
  },
  30_000,
);

it.live(
  "puts a snoozed thread a handoff left in the digest error back to rest, once and quietly",
  () => {
    const repairedId = ThreadId.make("handoff-digest-repaired");
    const providerErrorId = ThreadId.make("handoff-provider-error");
    const instanceId = ProviderInstanceId.make("codex");
    const layer = restartStartupLayer({
      continueThreadsAfterRestart: false,
      bindings: new Map(),
      commands: [],
    });
    // Stored as earlier versions wrote it: the title keeps whitespace that decoding trims, which
    // the old check digested after decoding and refused.
    const storedDocument = {
      version: 1,
      mode: "full-context-fresh-session",
      thread: { id: repairedId, title: "Digest repair ", branch: null, worktreePath: null },
      provenance: {
        sources: [{ providerInstanceId: instanceId, driverKind: "codex", modelSlug: "gpt-5" }],
        target: { providerInstanceId: "claude", driverKind: "claudeAgent", modelSlug: "fable" },
      },
      messages: [],
      plans: [],
      tools: [],
      checkpoints: [],
      notices: [],
      subagents: [],
      priorHandoffs: [],
    };

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const handoffs = yield* ContextHandoffRepository;
      const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("handoff-digest-project"),
        projectId: ProjectId.make("handoff-digest-project"),
        title: "Handoff digest",
        workspaceRoot: "/projects/handoff-digest",
        defaultModelSelection: { instanceId, model: "gpt-5" },
        createdAt: at(900),
      });
      const failedSessionAt = at(600);
      for (const [threadId, lastError] of [
        [repairedId, CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR],
        [providerErrorId, "The provider crashed."],
      ] as const) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}-create`),
          threadId,
          projectId: ProjectId.make("handoff-digest-project"),
          title: threadId,
          modelSelection: { instanceId, model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: at(900),
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`${threadId}-failed`),
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            providerInstanceId: instanceId,
            runtimeSessionId: RuntimeSessionId.make(`${threadId}-runtime`),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError,
            updatedAt: failedSessionAt,
          },
          wakesSnoozed: false,
          createdAt: failedSessionAt,
        });
      }
      assert.isTrue(yield* handoffs.create(digestFailedHandoff(repairedId, storedDocument)));
      // The user snoozed the failed thread before the node was updated.
      const snoozedUntil = at(-3_600);
      yield* engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("handoff-digest-snooze"),
        threadId: repairedId,
        snoozedUntil,
      });

      const boot = Effect.scoped(
        Effect.gen(function* () {
          const startup = yield* makeServerRuntimeStartup;
          yield* startup.awaitCommandReady;
        }),
      );
      yield* boot;
      yield* boot;

      const shellOf = (threadId: ThreadId) =>
        snapshots.getThreadShellById(threadId).pipe(Effect.map(Option.getOrThrow));
      const repaired = yield* shellOf(repairedId);
      assert.deepInclude(repaired.session, {
        status: "stopped",
        lastError: null,
        runtimeSessionId: RuntimeSessionId.make(`${repairedId}-runtime`),
        updatedAt: failedSessionAt,
      });
      assert.strictEqual(repaired.snoozedUntil, snoozedUntil);
      assert.isTrue(isThreadSnoozed(repaired, Date.now()));
      // A genuine provider error is the thread's own and stays.
      assert.deepInclude((yield* shellOf(providerErrorId)).session, {
        status: "error",
        lastError: "The provider crashed.",
      });
      // The failed handoff stays failed; the next model change prepares a new one.
      assert.deepInclude(
        Option.getOrThrow(
          yield* handoffs.getById({ handoffId: ContextHandoffId.make(`handoff-${repairedId}`) }),
        ),
        { status: "failed" },
      );

      const events = Array.from(yield* Stream.runCollect(engine.readEvents(0)));
      assert.isFalse(events.some((event) => event.type === "thread.unsnoozed"));
      // The second boot found nothing left to repair.
      assert.deepStrictEqual(
        events
          .filter((event) => event.commandId?.startsWith("server:startup-handoff-digest-repair:"))
          .map((event) => [event.type, event.aggregateId]),
        [["thread.session-set", repairedId]],
      );
    }).pipe(Effect.provide(layer));
  },
  30_000,
);

it.live(
  "hints only the sessions it runs at a graceful shutdown, never an orphan it did not reconcile",
  () => {
    const orphanId = ThreadId.make("restart-unreconciled");
    const orphanTurnId = TurnId.make("restart-unreconciled-turn");
    const liveId = ThreadId.make("restart-live");
    const liveTurnId = TurnId.make("restart-live-turn");
    const instanceId = ProviderInstanceId.make("codex");
    let inventoryCalls = 0;
    const layer = restartStartupLayer({
      continueThreadsAfterRestart: true,
      bindings: new Map(),
      commands: [],
      // The startup inventory fails, so reconcile (and capture) never runs; at shutdown
      // the provider reports the one session this process started.
      listSessions: () => {
        inventoryCalls += 1;
        return inventoryCalls === 1
          ? Effect.die(new Error("inventory unavailable"))
          : Effect.succeed([
              {
                threadId: liveId,
                runtimeSessionId: RuntimeSessionId.make("restart-live-runtime"),
              } as never,
            ]);
      },
    });

    return Effect.gen(function* () {
      const repository = yield* RestartContinuationRepository;
      const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();
      // An earlier process crashed three hours ago mid-turn.
      yield* seedRunningRestartThread({
        threadId: orphanId,
        turnId: orphanTurnId,
        instanceId,
        createProject: true,
        at,
        secondsAgo: 3 * 3_600,
      });
      // This process runs a turn of its own.
      yield* seedRunningRestartThread({
        threadId: liveId,
        turnId: liveTurnId,
        instanceId,
        createProject: false,
        at,
        secondsAgo: 5,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const startup = yield* makeServerRuntimeStartup;
          yield* startup.awaitCommandReady;
          assert.isTrue(
            Option.isNone(
              yield* repository.get({
                threadId: orphanId,
                sourceTurnId: orphanTurnId,
              }),
            ),
          );
        }),
      );

      // Graceful shutdown: the orphan still projects running but gets no fresh hint.
      assert.deepStrictEqual(
        (yield* repository.listShutdownHints()).map((hint) => hint.threadId),
        [liveId],
      );
    }).pipe(Effect.provide(layer));
  },
  30_000,
);

const shutdownOrderLayer = (input: {
  readonly order: string[];
  readonly recordShutdownHints: RestartContinuationShape["recordShutdownHints"];
}) =>
  Layer.mergeAll(
    startupShellStubs({
      settings: {
        start: Effect.void,
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as unknown as ServerSettingsService["Service"],
      reactorStart: () =>
        Effect.addFinalizer(() => Effect.sync(() => input.order.push("reactors"))),
    }),
    Layer.succeed(RestartContinuation, {
      ...restartContinuationOff,
      recordShutdownHints: input.recordShutdownHints,
    }),
    Layer.succeed(ProjectionSnapshotQuery, {
      getCommandReadModel: () =>
        Effect.succeed({
          projects: [],
          worktrees: [],
          threads: [],
        } as unknown as OrchestrationReadModel),
      getCounts: () => Effect.succeed({ threadCount: 0, projectCount: 0 }),
    } as unknown as ProjectionSnapshotQueryShape),
    Layer.succeed(ProviderSessionDirectory, {} as ProviderSessionDirectoryShape),
    Layer.succeed(OrchestrationEngineService, {} as unknown as OrchestrationEngineShape),
    Layer.succeed(ContextHandoffRepository, noContextHandoffs.repository),
    Layer.succeed(ContextHandoffService, noContextHandoffs.service),
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-startup-order-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.live("records shutdown hints before the reactors stop", () => {
  const order: string[] = [];
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const startup = yield* makeServerRuntimeStartup;
        yield* startup.awaitCommandReady;
      }),
    );
    assert.deepStrictEqual(order, ["hints", "reactors"]);
  }).pipe(
    Effect.provide(
      shutdownOrderLayer({
        order,
        recordShutdownHints: () => Effect.sync(() => void order.push("hints")),
      }),
    ),
  );
});

it.live("opens the command gate without hydrating the SQL command read model", () => {
  const order: string[] = [];
  let engineReads = 0;
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const startup = yield* makeServerRuntimeStartup;
        yield* startup.awaitCommandReady;
      }),
    );
    // Unrestricted workspaces validate nothing; the orphan repair reads the engine's model.
    assert.equal(engineReads, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("the engine already holds this model"),
          getCounts: () => Effect.succeed({ threadCount: 0, projectCount: 0 }),
        } as unknown as ProjectionSnapshotQueryShape),
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () =>
            Effect.sync(() => {
              engineReads += 1;
              return {
                projects: [],
                worktrees: [],
                threads: [],
              } as unknown as OrchestrationReadModel;
            }),
        } as unknown as OrchestrationEngineShape),
      ).pipe(
        Layer.provideMerge(shutdownOrderLayer({ order, recordShutdownHints: () => Effect.void })),
      ),
    ),
  );
});

it.live(
  "cuts a hanging shutdown-hint write off after two seconds",
  () => {
    const order: string[] = [];
    return Effect.gen(function* () {
      const startedAt = Date.now();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const startup = yield* makeServerRuntimeStartup;
          yield* startup.awaitCommandReady;
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      assert.isAtLeast(elapsedMs, 1_900);
      assert.isBelow(elapsedMs, 6_000);
      assert.deepStrictEqual(order, ["reactors"]);
    }).pipe(Effect.provide(shutdownOrderLayer({ order, recordShutdownHints: () => Effect.never })));
  },
  15_000,
);

it.live("releases deferred provider driver construction once the HTTP listener serves", () => {
  const released: string[] = [];
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const startup = yield* makeServerRuntimeStartup;
        yield* startup.awaitCommandReady;
        assert.deepStrictEqual(released, []);
        yield* startup.markHttpServing;
        assert.deepStrictEqual(released, ["provider-instances"]);
      }),
    );
  }).pipe(
    Effect.provide(
      shutdownOrderLayer({ order: [], recordShutdownHints: () => Effect.void }).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderInstanceBootGate, {
            release: Effect.sync(() => void released.push("provider-instances")),
            awaitInitialReconcile: Effect.void,
          }),
        ),
      ),
    ),
  );
});
