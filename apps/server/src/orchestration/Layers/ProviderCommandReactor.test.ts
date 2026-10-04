import { execFileSync } from "node:child_process";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { canonicalStoragePath } from "../../storage/lifecycle.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionThreadUserInputRequestRepository } from "../../persistence/Services/ProjectionThreadUserInputRequests.ts";
import { ProjectionThreadUserInputRequestRepositoryLive } from "../../persistence/Layers/ProjectionThreadUserInputRequests.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import type { ApprovalResponseIdentity } from "@ryco/contracts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import {
  CheckpointRef,
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@ryco/contracts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionNotFoundError,
  ProviderTurnNotSteerableError,
} from "../../provider/Errors.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { STORAGE_FAILURE_DETAIL } from "../userFacingErrors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ContextHandoffCoordinator,
  type ContextHandoffCoordinatorShape,
} from "../Services/ContextHandoffCoordinator.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | ProjectionThreadUserInputRequestRepository
    | ProjectionPendingApprovalRepository
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly getSession?: ProviderServiceShape["getSession"];
    readonly worktreeBranchPrefix?: string;
    readonly setThreadGoal?: NonNullable<ProviderServiceShape["setThreadGoal"]>;
    readonly getThreadGoal?: NonNullable<ProviderServiceShape["getThreadGoal"]>;
    readonly clearThreadGoal?: NonNullable<ProviderServiceShape["clearThreadGoal"]>;
    readonly pendingGoal?: boolean;
    readonly startReactor?: boolean;
    readonly baseDir?: string;
    readonly workspaceRoot?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly interruptTurnEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly stopSessionEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    /** Simulates adapter model normalization for `session.model` (undefined = unknown). */
    readonly sessionModel?: (model: string) => string | undefined;
    readonly steerTurn?: ProviderServiceShape["steerTurn"];
    /** Wraps the reactor's projection query, e.g. to arm one-shot read failures. */
    readonly decorateSnapshotQuery?: (
      live: ProjectionSnapshotQueryShape,
    ) => ProjectionSnapshotQueryShape;
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ryco-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const normalizeSessionModel = input?.sessionModel ?? ((model: string) => model);
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeSessionId: RuntimeSessionId.make(`runtime-${sessionIndex}`),
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...(normalizeSessionModel(inputModelSelection?.model ?? modelSelection.model)
          ? { model: normalizeSessionModel(inputModelSelection?.model ?? modelSelection.model) }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn((_: unknown, _expectedRuntime?: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => input?.interruptTurnEffect?.() ?? Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((stopInput: unknown) =>
      (input?.stopSessionEffect?.() ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const threadId =
              typeof stopInput === "object" && stopInput !== null && "threadId" in stopInput
                ? (stopInput as { threadId?: ThreadId }).threadId
                : undefined;
            if (!threadId) {
              return;
            }
            const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
            if (index >= 0) {
              runtimeSessions.splice(index, 1);
            }
          }),
        ),
      ),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const listWorktreePaths = vi.fn<GitWorkflowServiceShape["listWorktreePaths"]>(() =>
      Effect.succeed<readonly string[]>([]),
    );
    const listLocalBranchNames = vi.fn<GitWorkflowServiceShape["listLocalBranchNames"]>(() =>
      Effect.succeed(["ryco/1234abcd", "feature/workspace", "feature/recovered"]),
    );
    const pruneWorktrees = vi.fn<GitWorkflowServiceShape["pruneWorktrees"]>(() => Effect.void);
    const createWorktree = vi.fn<GitWorkflowServiceShape["createWorktree"]>(
      (input: Parameters<GitWorkflowServiceShape["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            path: input.path ?? path.join(input.cwd, input.refName.replaceAll("/", "-")),
            refName: input.newRefName ?? input.refName,
          },
        }),
    );
    const assertWorktreeSetupComplete = vi.fn<
      GitWorkflowServiceShape["assertWorktreeSetupComplete"]
    >((_checkoutPath: string) => Effect.void);
    const invalidateStatus = vi.fn(() => Effect.void);
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
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
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const processContextHandoff = vi.fn<ContextHandoffCoordinatorShape["processTurnStart"]>(
      (_event) => Effect.void,
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      ...(input?.setThreadGoal ? { setThreadGoal: input.setThreadGoal } : {}),
      ...(input?.getThreadGoal ? { getThreadGoal: input.getThreadGoal } : {}),
      ...(input?.clearThreadGoal ? { clearThreadGoal: input.clearThreadGoal } : {}),
      startSession: startSession as ProviderServiceShape["startSession"],
      startFreshSession: () => unsupported(),
      getSession: input?.getSession ?? (() => Effect.succeed(Option.none())),
      restoreSessionBinding: () => Effect.succeed(false),
      retireSessionBinding: () => Effect.succeed(false),
      stopSessionBinding: () => Effect.succeed("not-found"),
      listStaleSessionBindings: () => Effect.succeed([]),
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: input?.steerTurn ?? (() => unsupported()),
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      stopBackgroundTask: () => Effect.die(new Error("Unsupported provider call in test")) as never,
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

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
    const liveProjectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    // Only the reactor resolves this service; the engine has its own query layer.
    const decorateSnapshotQuery = input?.decorateSnapshotQuery;
    const projectionSnapshotLayer = decorateSnapshotQuery
      ? Layer.effect(
          ProjectionSnapshotQuery,
          Effect.map(Effect.service(ProjectionSnapshotQuery), decorateSnapshotQuery),
        ).pipe(Layer.provide(liveProjectionSnapshotLayer))
      : liveProjectionSnapshotLayer;
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(
        ProjectionThreadUserInputRequestRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
      ),
      Layer.provideMerge(
        ProjectionPendingApprovalRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        Layer.succeed(ContextHandoffCoordinator, {
          processTurnStart: processContextHandoff,
          recover: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService)({
          createWorktree,
          assertWorktreeSetupComplete,
          invalidateStatus,
          listLocalBranchNames,
          listWorktreePaths,
          pruneWorktrees,
          renameBranch,
        } satisfies Partial<GitWorkflowServiceShape>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          worktreeBranchPrefix: input?.worktreeBranchPrefix ?? "ryco",
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const approvals = await runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: input?.workspaceRoot ?? "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    if (input?.pendingGoal) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.goal.set",
          commandId: CommandId.make("pending-before-restart"),
          threadId: ThreadId.make("thread-1"),
          objective: "Recover delivery",
          createdAt: now,
        }),
      );
    }
    const startReactor = () => Effect.runPromise(reactor.start().pipe(Scope.provide(scope!)));
    if (input?.startReactor !== false) await startReactor();

    return {
      engine,
      sql: await runtime.runPromise(Effect.service(SqlClient.SqlClient)),
      run: <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect),
      startReactor,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      readShell: () => Effect.runPromise(snapshotQuery.getShellSnapshot()),
      readQuestion: (requestId: string) =>
        runtime!.runPromise(
          Effect.flatMap(ProjectionThreadUserInputRequestRepository, (repo) =>
            repo.getByRequestId({
              threadId: ThreadId.make("thread-1"),
              requestId: ApprovalRequestId.make(requestId),
            }),
          ),
        ),
      readApproval: (requestId: string) =>
        Effect.runPromise(
          approvals.getByRequestId({
            threadId: ThreadId.make("thread-1"),
            requestId: ApprovalRequestId.make(requestId),
          }),
        ),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      createWorktree,
      assertWorktreeSetupComplete,
      invalidateStatus,
      listLocalBranchNames,
      listWorktreePaths,
      pruneWorktrees,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      processContextHandoff,
      runtimeSessions,
      stateDir,
      drain,
    };
  }

  // delegation-returns §4.14: a delegated wake is a normal queued turn start. It goes through
  // ensureSessionForThread (create or resume) and is never fenced on the origin runtime.
  const startOriginatingTurn = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId,
    createdAt: string,
  ) => {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("origin-start"),
        threadId,
        message: {
          messageId: MessageId.make("origin-message"),
          role: "user",
          text: "Fixture origin",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("origin-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make("runtime-1"),
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("origin-complete"),
        threadId,
        messageId: MessageId.make("origin-answer"),
        turnId: TurnId.make("turn-1"),
        text: "Fixture answer",
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("origin-idle"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make("runtime-1"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        // What ingestion sends for the provider's turn.completed; a release without
        // a provider verdict fails closed and would block the delegated return.
        turnOutcome: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          reason: "provider-turn-completed",
          completedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("origin-settled"),
        threadId,
        turnId: TurnId.make("turn-1"),
        completedAt: createdAt,
        checkpointRef: CheckpointRef.make("fixture-checkpoint"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
  };
  const dispatchDelegatedWake = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId,
    createdAt: string,
  ) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("delegation-return:child-1"),
        threadId,
        message: {
          messageId: MessageId.make("delegation-result:child-1"),
          role: "user",
          text: "Fixture result",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
        delegationReturnGuard: {
          latestUserMessageId: MessageId.make("origin-message"),
          projectId: ProjectId.make("project-1"),
          runtimeMode: "approval-required",
          worktreePath: null,
        },
      }),
    );
  for (const liveRuntime of [null, "replacement-runtime"]) {
    it(`submits a delegated wake through the normal session path when the live runtime is ${liveRuntime}`, async () => {
      let liveSession: ProviderSession | undefined;
      const harness = await createHarness({
        getSession: () => Effect.succeed(Option.fromNullishOr(liveSession)),
      });
      const createdAt = new Date().toISOString();
      const threadId = ThreadId.make("thread-1");
      await startOriginatingTurn(harness, threadId, createdAt);
      if (liveRuntime === null) {
        // Restart or reaper: no provider runtime for the parent.
        harness.runtimeSessions.splice(0);
      } else {
        liveSession = {
          ...harness.runtimeSessions[0]!,
          runtimeSessionId: RuntimeSessionId.make(liveRuntime),
        };
        harness.runtimeSessions.splice(0, 1, liveSession);
      }
      harness.sendTurn.mockClear();
      harness.startSession.mockClear();
      await dispatchDelegatedWake(harness, threadId, createdAt);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]).toHaveLength(1);
      if (liveRuntime === null) expect(harness.startSession).toHaveBeenCalledTimes(1);
      expect(
        (await harness.readModel()).threads[0]?.activities.some(
          (entry) => entry.summary === "Delegated return was not submitted",
        ),
      ).toBe(false);
    });
  }
  it("records the session lastError when a delegated wake fails to start", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.make("thread-1");
    await startOriginatingTurn(harness, threadId, createdAt);
    harness.sendTurn.mockImplementationOnce(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "wake start failed",
          }),
        ) as never,
    );
    await dispatchDelegatedWake(harness, threadId, createdAt);
    await waitFor(
      async () =>
        (await harness.readModel()).threads[0]?.activities.some(
          (entry) =>
            entry.kind === "provider.turn.start.failed" &&
            (entry.payload as { messageId?: string } | null)?.messageId ===
              "delegation-result:child-1",
        ) ?? false,
    );
    await harness.drain();
    expect((await harness.readModel()).threads[0]?.session?.lastError).toBe("wake start failed");
  });
  it("keeps Claude native compaction exact even with a prompt-managed goal", async () => {
    const harness = await createHarness({
      threadModelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
      ),
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("compact-goal"),
        threadId: ThreadId.make("thread-1"),
        objective: "Keep improving the fixture",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("native-compact"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("native-compact-message"),
          role: "user",
          text: "/compact",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "/compact" });
  });

  it("recovers pending goal delivery when the reactor starts", async () => {
    const now = new Date().toISOString();
    const native = {
      objective: "Recover delivery",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    const setThreadGoal = vi.fn(() => Effect.succeed(native));
    const harness = await createHarness({ pendingGoal: true, setThreadGoal });
    await waitFor(
      async () => (await harness.readModel()).threads[0]?.goal?.synchronization === undefined,
    );
    expect(setThreadGoal).toHaveBeenCalledOnce();
    expect((await harness.readModel()).threads[0]?.goal).toEqual(native);
  });

  it("binds an atomic goal to the provider selected by its first turn", async () => {
    const now = new Date().toISOString();
    const native = {
      objective: "Finish the migration",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    const setThreadGoal = vi.fn(() => Effect.succeed(native));
    const harness = await createHarness({ setThreadGoal });
    const selection = { instanceId: ProviderInstanceId.make("codex_work"), model: "gpt-5-codex" };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("atomic-goal-start"),
        threadId: ThreadId.make("thread-1"),
        goal: { objective: native.objective },
        modelSelection: selection,
        message: {
          messageId: asMessageId("atomic-goal-message"),
          role: "user",
          text: native.objective,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({ modelSelection: selection });
    expect(setThreadGoal).toHaveBeenCalledTimes(1);
    expect((await harness.readModel()).threads[0]?.goal).toEqual(native);
  });

  it("confirms goals from the native response and resumes with a provider turn", async () => {
    const now = new Date().toISOString();
    const canonical = {
      objective: "Finish the migration",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 123,
      timeUsedSeconds: 45,
      createdAt: now,
      updatedAt: now,
    };
    const setThreadGoal = vi.fn(() => Effect.succeed(canonical));
    const harness = await createHarness({
      setThreadGoal,
      getThreadGoal: () => Effect.succeed(canonical),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("set-native-goal"),
        threadId: ThreadId.make("thread-1"),
        objective: canonical.objective,
        startTurn: true,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect((await harness.readModel()).threads[0]?.goal).toEqual(canonical);
    expect(setThreadGoal).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: `Continue pursuing this goal: ${canonical.objective}`,
    });
  });

  it("marks provider failures visibly and does not claim a clear succeeded", async () => {
    const fail = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/goal/clear",
          detail: "Provider disconnected",
        }),
      );
    const harness = await createHarness({ clearThreadGoal: fail });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("set-reminder"),
        threadId: ThreadId.make("thread-1"),
        objective: "Keep working",
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(
      async () =>
        (await harness.readModel()).threads[0]?.goal?.synchronization?.state === "unsupported",
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.clear",
        commandId: CommandId.make("clear-fails"),
        threadId: ThreadId.make("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(
      async () => (await harness.readModel()).threads[0]?.goal?.synchronization?.state === "failed",
    );
    const goal = (await harness.readModel()).threads[0]?.goal;
    expect(goal).toMatchObject({
      objective: "Keep working",
      synchronization: { action: "clear", state: "failed", error: "Provider disconnected" },
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("reconciles a native goal before sending without overwriting its status", async () => {
    const now = new Date().toISOString();
    const native = {
      objective: "Already achieved",
      status: "complete" as const,
      tokenBudget: 1000,
      tokensUsed: 700,
      timeUsedSeconds: 50,
      createdAt: now,
      updatedAt: now,
    };
    const setThreadGoal = vi.fn(() => Effect.succeed(native));
    const harness = await createHarness({
      getThreadGoal: () => Effect.succeed(native),
      setThreadGoal,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("reconcile-goal"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("reconcile-message"),
          role: "user",
          text: "What changed?",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect((await harness.readModel()).threads[0]?.goal).toEqual(native);
    expect(setThreadGoal).not.toHaveBeenCalled();
  });

  it("rejects a legacy memory command before any provider submission", async () => {
    const harness = await createHarness();
    const legacy = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("retired-memory"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("legacy-memory"),
        role: "user" as const,
        text: "Original prompt",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt: new Date().toISOString(),
      projectMemory: { projectId: "project-1", references: [] },
    };
    await expect(Effect.runPromise(harness.engine.dispatch(legacy as never))).rejects.toThrow();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("refuses delayed goal recovery after cleanup claims or removes a checkout", async () => {
    const harness = await createHarness({ startReactor: false });
    const checkout = await canonicalStoragePath(path.join(harness.stateDir, "missing-checkout"));
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("goal-storage-path"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature",
        worktreePath: checkout,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("goal-before-cleanup"),
        threadId: ThreadId.make("thread-1"),
        objective: "Keep real work",
        startTurn: false,
        createdAt,
      }),
    );
    await harness.run(
      harness.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('goal-guard', ${checkout}, 'worktree', '{}', ${createdAt}, 'removing')`,
    );
    await harness.startReactor();
    await harness.drain();
    expect(harness.createWorktree).not.toHaveBeenCalled();
    expect(harness.listLocalBranchNames).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    for (const state of ["removing", "removed"]) {
      await harness.run(
        harness.sql`UPDATE storage_owned_entries SET state = ${state} WHERE id = 'goal-guard'`,
      );
      await expect(
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.goal.set",
            commandId: CommandId.make(`goal-after-${state}`),
            threadId: ThreadId.make("thread-1"),
            objective: "Keep real work",
            startTurn: false,
            createdAt,
          }),
        ),
      ).rejects.toThrow("Checkout cleanup is pending or complete");
    }
  });

  it("recreates a missing recorded worktree before starting the provider session", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-worktree-recovery-"));
    const harness = await createHarness({ baseDir });
    const worktreePath = path.join(baseDir, "worktrees", "feature-recovered");
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-record-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/recovered",
        worktreePath,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-worktree"),
          role: "user",
          text: "continue in the recorded worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.listLocalBranchNames).toHaveBeenCalledWith("/tmp/provider-project");
    expect(harness.pruneWorktrees).toHaveBeenCalledWith("/tmp/provider-project");
    expect(harness.createWorktree).toHaveBeenCalledWith({
      projectId: ProjectId.make("project-1"),
      cwd: "/tmp/provider-project",
      path: worktreePath,
      refName: "feature/recovered",
      dependencyHydration: "none",
    });
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({ cwd: worktreePath });
    expect(
      harness.pruneWorktrees.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    ).toBeLessThan(harness.createWorktree.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
    expect(
      harness.createWorktree.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    ).toBeLessThan(harness.startSession.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  it("refuses a retained incomplete worktree checkout on the second provider turn, including after driver restart", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-incomplete-recovery-"));
    const repo = path.join(baseDir, "repo");
    fs.mkdirSync(repo);
    const localGit = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    localGit("init");
    fs.writeFileSync(path.join(repo, "ryco.json"), "malformed JSON");
    localGit("add", "ryco.json");
    localGit(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "invalid branch config",
    );
    localGit("branch", "feature/recovered");
    const h = await createHarness({ baseDir, workspaceRoot: repo });
    const worktreePath = path.join(baseDir, "worktrees", "recovered");
    const makeGitRuntime = () =>
      ManagedRuntime.make(
        GitVcsDriver.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      );
    const gitRuntime = makeGitRuntime();
    const restartedRuntime = makeGitRuntime();
    try {
      const driver = await gitRuntime.runPromise(Effect.service(GitVcsDriver.GitVcsDriver));
      h.createWorktree.mockImplementation(driver.createWorktree);
      h.listWorktreePaths.mockImplementation(() => driver.listWorktreePaths(repo));
      h.listLocalBranchNames.mockImplementation(() => driver.listLocalBranchNames(repo));
      h.pruneWorktrees.mockImplementation(() => driver.pruneWorktrees(repo));
      h.assertWorktreeSetupComplete.mockImplementation(driver.assertWorktreeSetupComplete);
      await Effect.runPromise(
        h.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("record-incomplete"),
          threadId: ThreadId.make("thread-1"),
          branch: "feature/recovered",
          worktreePath,
        }),
      );
      const start = (attempt: number) =>
        Effect.runPromise(
          h.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`incomplete-turn-${attempt}`),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: asMessageId(`incomplete-message-${attempt}`),
              role: "user",
              text: "continue",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: new Date().toISOString(),
          }),
        );
      const failures = async () =>
        (await h.readModel()).threads[0]?.activities.filter((a) =>
          a.summary.includes("Provider turn start failed"),
        ).length ?? 0;
      await start(1);
      await waitFor(async () => (await failures()) === 1);
      expect(h.createWorktree).toHaveBeenCalledTimes(1);
      expect(h.startSession).not.toHaveBeenCalled();
      expect(await Effect.runPromise(driver.listWorktreePaths(repo))).toContain(
        fs.realpathSync(worktreePath),
      );
      // A new core instance must observe durable state, not an in-memory flag.
      const restartedDriver = await restartedRuntime.runPromise(
        Effect.service(GitVcsDriver.GitVcsDriver),
      );
      h.assertWorktreeSetupComplete.mockImplementation(restartedDriver.assertWorktreeSetupComplete);
      await start(2);
      await waitFor(async () => (await failures()) === 2);
      expect(h.createWorktree).toHaveBeenCalledTimes(1);
      expect(h.startSession).not.toHaveBeenCalled();
      expect(h.sendTurn).not.toHaveBeenCalled();
      await expect(
        Effect.runPromise(
          restartedDriver.createWorktree({
            cwd: repo,
            path: worktreePath,
            refName: "feature/recovered",
          }),
        ),
      ).rejects.toThrow("incomplete setup");
      // Fixing configuration alone does not silently adopt the retained checkout.
      fs.writeFileSync(path.join(worktreePath, "ryco.json"), "{}");
      await expect(
        Effect.runPromise(restartedDriver.assertWorktreeSetupComplete(worktreePath)),
      ).rejects.toThrow("incomplete setup");
      // Explicit removal preserves the branch. Recreate with an explicit project
      // policy after fixing the invalid branch file; no ordinary checkout is hydrated.
      await Effect.runPromise(
        restartedDriver.removeWorktree({ cwd: repo, path: worktreePath, force: true }),
      );
      const completed = await Effect.runPromise(
        restartedDriver.createWorktree({
          cwd: repo,
          path: worktreePath,
          refName: "feature/recovered",
          projectId: ProjectId.make("project-1"),
          settingsSnapshot: {
            ...DEFAULT_SERVER_SETTINGS,
            projectWorktreeSubmodules: { "project-1": "none" },
          },
        }),
      );
      expect(completed.submoduleInitialization?.mode).toBe("none");
      await Effect.runPromise(restartedDriver.assertWorktreeSetupComplete(worktreePath));
    } finally {
      await restartedRuntime.dispose();
      await gitRuntime.dispose();
    }
  });

  it("accepts a registered worktree through a symlinked parent directory", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-worktree-alias-"));
    const harness = await createHarness({ baseDir });
    const actualPath = path.join(baseDir, "actual");
    const aliasPath = path.join(baseDir, "alias");
    fs.mkdirSync(actualPath);
    fs.symlinkSync(actualPath, aliasPath, "dir");
    harness.listWorktreePaths.mockReturnValue(Effect.succeed([fs.realpathSync(actualPath)]));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-record-alias-worktree"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/alias",
        worktreePath: aliasPath,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-alias-worktree"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-alias"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({ cwd: aliasPath });
    expect(harness.createWorktree).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing directory that is not a registered worktree", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-worktree-collision-"));
    const harness = await createHarness({ baseDir });
    const occupiedPath = path.join(baseDir, "worktrees", "occupied");
    fs.mkdirSync(occupiedPath, { recursive: true });
    fs.writeFileSync(path.join(occupiedPath, "keep.txt"), "keep\n");
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-record-occupied-worktree"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/recovered",
        worktreePath: occupiedPath,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-occupied-worktree"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-occupied-worktree"),
          role: "user",
          text: "do not overwrite this directory",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads[0]?.activities.some((activity) =>
          activity.summary.includes("Provider turn start failed"),
        ) ?? false
      );
    });
    expect(harness.pruneWorktrees).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(occupiedPath, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("fails safely when the recorded worktree branch no longer exists", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-worktree-branch-missing-"));
    const harness = await createHarness({ baseDir });
    harness.listLocalBranchNames.mockReturnValue(Effect.succeed([]));
    const worktreePath = path.join(baseDir, "worktrees", "deleted-branch");
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-record-deleted-worktree-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/deleted",
        worktreePath,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-deleted-worktree-branch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-deleted-worktree-branch"),
          role: "user",
          text: "continue after branch deletion",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads[0]?.activities.some((activity) =>
          activity.summary.includes("Provider turn start failed"),
        ) ?? false
      );
    });
    expect(harness.pruneWorktrees).not.toHaveBeenCalled();
    expect(harness.createWorktree).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("retries thread title generation after a transient failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Please investigate reconnect failures after restar...";
    let attempts = 0;
    harness.generateThreadTitle.mockReturnValue(
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "text generation timed out",
              }),
            )
          : Effect.succeed({ title: "Generated title" });
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    }, 8_000);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
    expect(attempts).toBe(2);
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it.each([
    { prefix: "ryco", temporaryBranch: "ryco/1234abcd", expectedPrefix: "ryco/" },
    { prefix: "team/tasks", temporaryBranch: "team/tasks/1234abcd", expectedPrefix: "team/tasks/" },
    { prefix: "", temporaryBranch: "1234abcd", expectedPrefix: "feature/" },
    { prefix: "team/tasks", temporaryBranch: "ryco/1234abcd", expectedPrefix: "ryco/" },
  ])(
    "generates a first-turn branch for $temporaryBranch with prefix '$prefix'",
    async ({ prefix, temporaryBranch, expectedPrefix }) => {
      const harness = await createHarness({ worktreeBranchPrefix: prefix });
      harness.listLocalBranchNames.mockReturnValue(Effect.succeed([temporaryBranch]));
      const now = new Date().toISOString();
      const worktreeId = WorktreeId.make("worktree-generated-branch");

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "worktree.create",
          commandId: CommandId.make("cmd-generated-branch-worktree"),
          worktreeId,
          projectId: asProjectId("project-1"),
          branch: temporaryBranch,
          worktreePath: "/tmp/provider-project-worktree",
          origin: "branch",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.attach-to-worktree",
          commandId: CommandId.make("cmd-generated-branch-attach"),
          threadId: ThreadId.make("thread-1"),
          worktreeId,
          attachedAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-thread-branch"),
          threadId: ThreadId.make("thread-1"),
          branch: temporaryBranch,
          worktreePath: "/tmp/provider-project-worktree",
        }),
      );

      harness.generateBranchName.mockImplementation((input: unknown) =>
        Effect.succeed({
          branch:
            typeof input === "object" &&
            input !== null &&
            "modelSelection" in input &&
            typeof input.modelSelection === "object" &&
            input.modelSelection !== null &&
            "model" in input.modelSelection &&
            typeof input.modelSelection.model === "string"
              ? `feature/${input.modelSelection.model}`
              : "feature/generated",
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-branch-model"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-branch-model"),
            role: "user",
            text: "Add a safer reconnect backoff.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
      await waitFor(() => harness.refreshStatus.mock.calls.length >= 1);
      expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
        message: "Add a safer reconnect backoff.",
      });
      expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
      const renamedBranch = (
        harness.renameBranch.mock.calls[0]?.[0] as { newBranch?: string } | undefined
      )?.newBranch;
      expect(renamedBranch).toBeTruthy();
      expect(renamedBranch?.startsWith(expectedPrefix)).toBe(true);
      await waitFor(async () => {
        const readModel = await harness.readModel();
        return (
          readModel.worktrees?.find((worktree) => worktree.worktreeId === worktreeId)?.branch ===
          renamedBranch
        );
      });
    },
  );

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("commits an options-only selection only after the provider accepts the turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-options-only-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-options-only-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const acceptedSelection = createModelSelection(
      ProviderInstanceId.make("codex"),
      "gpt-5-codex",
      [{ id: "reasoningEffort", value: "high" }],
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-options-only-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-options-only-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: acceptedSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return readModel.threads[0]?.modelSelection.options?.[0]?.value === "high";
    });
    const readModel = await harness.readModel();
    expect(readModel.threads[0]?.modelSelection).toEqual(acceptedSelection);
    expect(harness.processContextHandoff).not.toHaveBeenCalled();
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(thread?.session?.runtimeSessionId).toBe(RuntimeSessionId.make("runtime-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("routes a compatible Codex instance change through the handoff coordinator", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(() => harness.processContextHandoff.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.processContextHandoff.mock.calls[0]?.[0].payload.contextHandoff).toMatchObject({
      targetMessageId: "user-message-compatible-codex-2",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.modelSelection.instanceId).toBe(ProviderInstanceId.make("codex"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/workspace",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("routes cross-driver changes through the handoff coordinator without mutating the source", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.processContextHandoff.mock.calls.length === 1);

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(thread?.modelSelection.instanceId).toBe(ProviderInstanceId.make("codex"));
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
        messageId: "user-message-stopped-provider-switch",
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("stops and durably settles the expected session when provider interrupt fails", async () => {
    const harness = await createHarness({
      interruptTurnEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.interrupt",
            detail: "provider session disappeared",
          }),
        ),
      stopSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "session.stop",
            detail: "provider process already exited",
          }),
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-failure"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return thread?.session?.status === "stopped";
    });

    // Session settlement is persisted before the failure activity. Wait for
    // the entire command handler before asserting its durable side effects.
    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(thread?.session).toMatchObject({
      status: "stopped",
      activeTurnId: null,
      lastError: "provider session disappeared",
    });
    expect(thread?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "interrupted",
    });
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
    ).toMatchObject({
      summary: "Provider turn interrupt failed",
      payload: { detail: "provider session disappeared" },
    });
    expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
  });

  it("does not overwrite a session that naturally settled while interrupt was failing", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const completedAt = "2026-01-01T00:00:01.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.interruptTurn.mockImplementation(() =>
      harness.engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-natural-completion"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
          createdAt: completedAt,
        })
        .pipe(
          Effect.catchCause((cause) => Effect.die(cause)),
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread.interrupt",
                detail: "provider session disappeared",
              }),
            ),
          ),
        ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );
    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(thread?.session).toMatchObject({
      status: "ready",
      activeTurnId: null,
      lastError: null,
      updatedAt: completedAt,
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
    ).toBe(false);
  });

  it("does not echo provider-originated turn interrupts back to the provider", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-provider-interrupt"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-provider-interrupt"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(
          "provider:evt-turn-aborted:thread-turn-interrupt:turn-provider-interrupt",
        ),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-provider-interrupt"),
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
        messageId: "user-message-missing-instance",
      },
    });
  });

  type ReactorHarness = Awaited<ReturnType<typeof createHarness>>;

  const dispatchTurnStart = (
    harness: ReactorHarness,
    messageId: string,
    modelSelection?: ModelSelection,
  ) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${messageId}`),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId(messageId),
          role: "user",
          text: messageId,
          attachments: [],
        },
        ...(modelSelection ? { modelSelection } : {}),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

  const readThread = async (harness: ReactorHarness) =>
    (await harness.readModel()).threads.find((entry) => entry.id === ThreadId.make("thread-1"));

  const failureDetail = (activity: { readonly payload: unknown } | undefined) =>
    (activity?.payload as { readonly detail?: string } | undefined)?.detail;

  const turnStartFailures = async (harness: ReactorHarness, messageId?: string) =>
    ((await readThread(harness))?.activities ?? []).filter(
      (activity) =>
        activity.kind === "provider.turn.start.failed" &&
        (messageId === undefined ||
          (activity.payload as { readonly messageId?: string }).messageId === messageId),
    );

  const storageFailure = () =>
    new PersistenceSqlError({
      operation: "ProjectionThreads.getById",
      detail: "Failed to execute ProjectionThreads.getById",
    });

  /** Arms one-shot failures for the reactor's projection reads. */
  function makeReadFailureHooks() {
    const armed: {
      threadShell?: Effect.Effect<never, PersistenceSqlError>;
      message?: Effect.Effect<never, PersistenceSqlError>;
      userMessageCount?: Effect.Effect<never, PersistenceSqlError>;
      projectShell?: Effect.Effect<never, PersistenceSqlError>;
    } = {};
    const take = (key: keyof typeof armed) => {
      const failure = armed[key];
      delete armed[key];
      return failure;
    };
    const decorateSnapshotQuery = (
      live: ProjectionSnapshotQueryShape,
    ): ProjectionSnapshotQueryShape => ({
      ...live,
      getThreadShellById: (threadId) => take("threadShell") ?? live.getThreadShellById(threadId),
      getThreadMessageById: (messageInput) =>
        take("message") ??
        (live.getThreadMessageById
          ? live.getThreadMessageById(messageInput)
          : Effect.die("getThreadMessageById is not implemented")),
      countThreadUserMessages: (threadId) =>
        take("userMessageCount") ??
        (live.countThreadUserMessages
          ? live.countThreadUserMessages(threadId)
          : Effect.die("countThreadUserMessages is not implemented")),
      getProjectShellById: (projectId) =>
        take("projectShell") ?? live.getProjectShellById(projectId),
    });
    return { armed, decorateSnapshotQuery };
  }

  it("does not restart a session whose model is unknown when the client resends the agent default", async () => {
    const agentDefault = { instanceId: ProviderInstanceId.make("codex"), model: "default" };
    const harness = await createHarness({
      sessionModelSwitch: "unsupported",
      sessionModel: (model) => (model === "default" ? undefined : model),
      threadModelSelection: agentDefault,
    });

    await dispatchTurnStart(harness, "agent-default-1", agentDefault);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await dispatchTurnStart(harness, "agent-default-2", agentDefault);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(await turnStartFailures(harness)).toHaveLength(0);
    expect((await readThread(harness))?.session?.runtimeSessionId).toBe("runtime-1");
  });

  it("rejects a genuine model switch on a session that cannot switch models, without restarting", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });

    await dispatchTurnStart(harness, "model-switch-1");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await dispatchTurnStart(harness, "model-switch-2", {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.1-codex",
    });
    await waitFor(async () => (await turnStartFailures(harness, "model-switch-2")).length === 1);
    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    const failures = await turnStartFailures(harness);
    expect(failures).toHaveLength(1);
    const detail = failureDetail(failures[0]);
    expect(detail).toContain("cannot switch");
    expect(detail).toContain("Start a new thread");
    const session = (await readThread(harness))?.session;
    expect(session?.runtimeSessionId).toBe("runtime-1");
    expect(session?.lastError).toBe(detail);
  });

  it("applies an in-session model switch on the next turn without restarting", async () => {
    const harness = await createHarness();

    await dispatchTurnStart(harness, "in-session-switch-1");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await dispatchTurnStart(harness, "in-session-switch-2", {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.1-codex",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: { model: "gpt-5.1-codex" },
    });
  });

  it("shows a short storage message instead of a raw cause when session start fails", async () => {
    const harness = await createHarness();
    harness.startSession.mockImplementationOnce(
      () =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "ProviderSessionDirectory.upsert",
            detail: "Failed to execute ProviderSessionDirectory.upsert",
          }),
        ) as never,
    );

    await dispatchTurnStart(harness, "storage-start");
    await waitFor(async () => (await turnStartFailures(harness, "storage-start")).length === 1);

    const detail = failureDetail((await turnStartFailures(harness))[0]);
    expect(detail).toBe(STORAGE_FAILURE_DETAIL);
    expect(detail).not.toContain("PersistenceSqlError");
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("bounds steer rejection text and falls back for defects", async () => {
    const steerTurn = vi
      .fn<ProviderServiceShape["steerTurn"]>()
      .mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/steer",
            detail: "x".repeat(1_500),
          }),
        ),
      )
      .mockImplementationOnce(() => Effect.die(new Error("boom")));
    const harness = await createHarness({ steerTurn });
    const now = new Date().toISOString();
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("steer-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make("runtime-1"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    for (const id of ["steer-long", "steer-defect"]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer",
          commandId: CommandId.make(id),
          threadId,
          expectedTurnId: asTurnId("turn-1"),
          message: { messageId: asMessageId(id), role: "user", text: id, attachments: [] },
          createdAt: now,
          requestedAt: now,
        }),
      );
    }

    const steerErrors = async () =>
      new Map(
        ((await readThread(harness))?.activities ?? [])
          .filter((activity) => activity.kind === "provider.turn.steer.failed")
          .map((activity) => {
            const payload = activity.payload as {
              readonly messageId: string;
              readonly error: string;
            };
            return [payload.messageId, payload.error] as const;
          }),
      );
    await waitFor(async () => (await steerErrors()).size === 2);

    const errors = await steerErrors();
    const bounded = errors.get("steer-long")!;
    expect(bounded.length).toBeLessThanOrEqual(1_000);
    expect(bounded).toBe(bounded.trim());
    expect(errors.get("steer-defect")).toBe("Provider rejected turn steering.");
  });

  it("defers steers the provider cannot take and fails real provider errors", async () => {
    const steerTurn = vi
      .fn<ProviderServiceShape["steerTurn"]>()
      .mockImplementationOnce(() =>
        Effect.fail(
          new ProviderTurnNotSteerableError({
            provider: "claudeAgent",
            threadId: "thread-1",
            turnId: "turn-1",
            reason: "busy",
            detail: "Claude is waiting for an approval or answer. The message stays queued.",
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: "codex", threadId: "thread-1" }),
        ),
      )
      .mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/steer",
            detail: "steer exploded",
          }),
        ),
      );
    const harness = await createHarness({ steerTurn });
    const now = new Date().toISOString();
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("steer-deferral-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make("runtime-1"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    for (const id of ["steer-busy", "steer-gone", "steer-error"]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer",
          commandId: CommandId.make(id),
          threadId,
          expectedTurnId: asTurnId("turn-1"),
          message: { messageId: asMessageId(id), role: "user", text: id, attachments: [] },
          createdAt: now,
          requestedAt: now,
        }),
      );
      await waitFor(async () =>
        ((await readThread(harness))?.activities ?? []).some(
          (activity) => activity.id === `turn-steer-rejected:${id}`,
        ),
      );
    }

    const rejections = new Map(
      ((await readThread(harness))?.activities ?? [])
        .filter((activity) => activity.kind === "provider.turn.steer.failed")
        .map((activity) => {
          const payload = activity.payload as {
            readonly messageId: string;
            readonly error: string;
            readonly reason: string;
          };
          return [payload.messageId, { ...payload, tone: activity.tone }] as const;
        }),
    );
    expect(rejections.get("steer-busy")).toMatchObject({
      reason: "deferred",
      tone: "info",
      error: "Claude is waiting for an approval or answer. The message stays queued.",
    });
    expect(rejections.get("steer-gone")).toMatchObject({ reason: "deferred", tone: "info" });
    expect(rejections.get("steer-gone")?.error).not.toContain("Unknown");
    expect(rejections.get("steer-error")).toMatchObject({
      reason: "failed",
      tone: "error",
      error: "steer exploded",
    });
  });
  it("interrupted turn preparation appends no failure and keeps the reactor alive", async () => {
    const harness = await createHarness();
    harness.startSession.mockImplementationOnce(() => Effect.interrupt as never);

    await dispatchTurnStart(harness, "interrupted-preparation");
    await harness.drain();
    expect(await turnStartFailures(harness)).toHaveLength(0);
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await dispatchTurnStart(harness, "after-interrupt");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(await turnStartFailures(harness)).toHaveLength(0);
  });

  it("surfaces a thread read failure during turn start", async () => {
    const hooks = makeReadFailureHooks();
    const harness = await createHarness({ decorateSnapshotQuery: hooks.decorateSnapshotQuery });

    await dispatchTurnStart(harness, "thread-read-1");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    hooks.armed.threadShell = Effect.fail(storageFailure());
    await dispatchTurnStart(harness, "thread-read-2");
    await waitFor(async () => (await turnStartFailures(harness, "thread-read-2")).length === 1);
    await harness.drain();

    const failure = (await turnStartFailures(harness, "thread-read-2"))[0];
    expect(failure?.payload).toMatchObject({ detail: STORAGE_FAILURE_DETAIL });
    expect((await readThread(harness))?.session).toMatchObject({
      status: "ready",
      lastError: STORAGE_FAILURE_DETAIL,
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a concurrently started turn running when turn-start preparation fails", async () => {
    const hooks = makeReadFailureHooks();
    const harness = await createHarness({ decorateSnapshotQuery: hooks.decorateSnapshotQuery });
    const threadId = ThreadId.make("thread-1");

    await dispatchTurnStart(harness, "concurrent-1");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // The decider rejects a turn start while a turn is active, so the
    // concurrent turn (for example a wake turn) starts inside the failing read.
    const wakeAt = new Date().toISOString();
    hooks.armed.threadShell = harness.engine
      .dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("concurrent-wake-turn"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make("runtime-1"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-wake"),
          lastError: null,
          updatedAt: wakeAt,
        },
        createdAt: wakeAt,
      })
      .pipe(Effect.orDie, Effect.andThen(Effect.fail(storageFailure())));
    await dispatchTurnStart(harness, "concurrent-2");
    await waitFor(async () => (await turnStartFailures(harness, "concurrent-2")).length === 1);
    await harness.drain();

    expect((await readThread(harness))?.session).toMatchObject({
      status: "running",
      activeTurnId: "turn-wake",
      lastError: null,
    });
    expect(await turnStartFailures(harness, "concurrent-2")).toHaveLength(1);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("surfaces a message read failure during turn start", async () => {
    const hooks = makeReadFailureHooks();
    const harness = await createHarness({ decorateSnapshotQuery: hooks.decorateSnapshotQuery });

    hooks.armed.message = Effect.fail(storageFailure());
    await dispatchTurnStart(harness, "message-read");
    await waitFor(async () => (await turnStartFailures(harness, "message-read")).length === 1);

    expect((await turnStartFailures(harness, "message-read"))[0]?.payload).toMatchObject({
      detail: STORAGE_FAILURE_DETAIL,
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  /**
   * Gives thread-1 the default title and a temporary worktree branch, so a
   * first turn generates both a title and a branch.
   */
  async function enableFirstTurnGeneration(harness: ReactorHarness) {
    const now = new Date().toISOString();
    const threadId = ThreadId.make("thread-1");
    const worktreeId = WorktreeId.make("worktree-first-turn-generation");
    const temporaryBranch = "ryco/1234abcd";
    const worktreePath = "/tmp/provider-project-first-turn-worktree";
    harness.listLocalBranchNames.mockReturnValue(Effect.succeed([temporaryBranch]));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "worktree.create",
        commandId: CommandId.make("cmd-first-turn-generation-worktree"),
        worktreeId,
        projectId: asProjectId("project-1"),
        branch: temporaryBranch,
        worktreePath,
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.attach-to-worktree",
        commandId: CommandId.make("cmd-first-turn-generation-attach"),
        threadId,
        worktreeId,
        attachedAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-first-turn-generation-meta"),
        threadId,
        title: "New thread",
        branch: temporaryBranch,
        worktreePath,
      }),
    );
  }

  it("generates a title and branch on a readable first turn (control for the read-failure cases)", async () => {
    const harness = await createHarness({ worktreeBranchPrefix: "ryco" });
    await enableFirstTurnGeneration(harness);

    await dispatchTurnStart(harness, "generation-control");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(
      () =>
        harness.generateThreadTitle.mock.calls.length === 1 &&
        harness.generateBranchName.mock.calls.length === 1,
    );
    expect(await turnStartFailures(harness)).toHaveLength(0);
  });

  it("still sends the turn when the first-turn message count cannot be read", async () => {
    const hooks = makeReadFailureHooks();
    const harness = await createHarness({
      decorateSnapshotQuery: hooks.decorateSnapshotQuery,
      worktreeBranchPrefix: "ryco",
    });
    await enableFirstTurnGeneration(harness);

    hooks.armed.userMessageCount = Effect.fail(storageFailure());
    await dispatchTurnStart(harness, "count-read");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    expect(hooks.armed.userMessageCount).toBeUndefined();
    expect(await turnStartFailures(harness)).toHaveLength(0);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.generateBranchName).not.toHaveBeenCalled();
  });

  it("still sends a first turn when the project read for title and branch generation fails", async () => {
    // Session start and the send request read the project first; the third
    // read of the turn is the generation block's.
    let countProjectReads = false;
    let projectReads = 0;
    const generationProjectRead = 3;
    const harness = await createHarness({
      worktreeBranchPrefix: "ryco",
      decorateSnapshotQuery: (live) => ({
        ...live,
        getProjectShellById: (projectId) =>
          countProjectReads && ++projectReads === generationProjectRead
            ? Effect.fail(storageFailure())
            : live.getProjectShellById(projectId),
      }),
    });
    await enableFirstTurnGeneration(harness);

    countProjectReads = true;
    await dispatchTurnStart(harness, "generation-project-read");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    expect(projectReads).toBeGreaterThanOrEqual(generationProjectRead);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(await turnStartFailures(harness)).toHaveLength(0);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.generateBranchName).not.toHaveBeenCalled();
  });

  it("surfaces a project read failure on the context-handoff branch", async () => {
    const hooks = makeReadFailureHooks();
    const harness = await createHarness({ decorateSnapshotQuery: hooks.decorateSnapshotQuery });

    await dispatchTurnStart(harness, "handoff-read-1", {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    hooks.armed.projectShell = Effect.fail(storageFailure());
    await dispatchTurnStart(harness, "handoff-read-2", {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: "gpt-5-codex",
    });
    await waitFor(async () => (await turnStartFailures(harness, "handoff-read-2")).length === 1);
    await harness.drain();

    expect((await turnStartFailures(harness, "handoff-read-2"))[0]?.payload).toMatchObject({
      detail: STORAGE_FAILURE_DETAIL,
    });
    expect(harness.processContextHandoff).not.toHaveBeenCalled();
  });

  async function prepareApproval() {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("approval-safety-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeSessionId: RuntimeSessionId.make("approval-runtime-1"),
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
        type: "thread.activity.append",
        commandId: CommandId.make("approval-safety-request"),
        threadId,
        activity: {
          id: EventId.make("approval-safety-request"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-safety",
            requestKind: "command",
            runtimeSessionId: "approval-runtime-1",
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      }),
    );
    const identity: ApprovalResponseIdentity = {
      requestEventId: EventId.make("approval-safety-request"),
      runtimeSessionId: RuntimeSessionId.make("approval-runtime-1"),
    };
    const respond = (
      id: string,
      decision: "accept" | "decline" = "accept",
      approvalIdentity = identity,
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make(id),
          threadId,
          requestId: asApprovalRequestId("approval-safety"),
          approvalIdentity,
          decision,
          createdAt,
        }),
      );
    const activity = (id: string, kind: string, payload: Record<string, unknown>) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`command:${id}`),
          threadId,
          activity: {
            id: EventId.make(id),
            kind,
            tone: "info",
            summary: kind,
            payload: {
              requestId: "approval-safety",
              runtimeSessionId: "approval-runtime-1",
              ...payload,
            },
            turnId: null,
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        }),
      );
    return { ...harness, respond, activity, identity };
  }

  async function prepareQuestion() {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("question-safety-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeSessionId: RuntimeSessionId.make("question-runtime-1"),
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
        type: "thread.activity.append",
        commandId: CommandId.make("question-safety-request"),
        threadId,
        activity: {
          id: EventId.make("question-safety-request"),
          tone: "approval",
          kind: "user-input.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "question-safety",
            requestKind: "command",
            runtimeSessionId: "question-runtime-1",
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      }),
    );
    const identity: ApprovalResponseIdentity = {
      requestEventId: EventId.make("question-safety-request"),
      runtimeSessionId: RuntimeSessionId.make("question-runtime-1"),
    };
    const respond = (id: string, answer = "Yes", userInputIdentity = identity) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(id),
          threadId,
          requestId: asApprovalRequestId("question-safety"),
          userInputIdentity,
          answers: { answer },
          createdAt,
        }),
      );
    const activity = (id: string, kind: string, payload: Record<string, unknown>) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`command:${id}`),
          threadId,
          activity: {
            id: EventId.make(id),
            kind,
            tone: "info",
            summary: kind,
            payload: {
              requestId: "question-safety",
              runtimeSessionId: "question-runtime-1",
              ...payload,
            },
            turnId: null,
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        }),
      );
    return { ...harness, respond, activity, identity };
  }

  it("question safety: proven validation failure permits correction before delivery", async () => {
    const harness = await prepareQuestion();
    harness.respondToUserInput.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "respondToUserInput",
          detail: "Invalid answer",
          userInputResponseNotSent: true,
        }),
      ),
    );
    await harness.respond("malformed-answer");
    await harness.drain();
    expect(Option.getOrUndefined(await harness.readQuestion("question-safety"))).toMatchObject({
      isPending: true,
      responseState: "retryable",
    });
    await harness.respond("corrected-answer", "Corrected");
    await harness.drain();
    expect(harness.respondToUserInput).toHaveBeenCalledTimes(2);
    expect(Option.getOrUndefined(await harness.readQuestion("question-safety"))).toMatchObject({
      isPending: false,
      responseState: "settled",
    });
  });

  it("question safety: duplicate commands claim one response and never replay an unknown outcome", async () => {
    const harness = await prepareQuestion();
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "respondToUserInput",
          detail: "Connection dropped after write",
        }),
      ),
    );
    const results = await Promise.allSettled([
      harness.respond("question-first"),
      harness.respond("question-second"),
    ]);
    await harness.drain();
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(harness.respondToUserInput).toHaveBeenCalledTimes(1);
    expect(Option.getOrUndefined(await harness.readQuestion("question-safety"))).toMatchObject({
      isPending: true,
      responseState: "uncertain",
    });
    await harness.respond("question-first");
    await expect(harness.respond("question-retry")).rejects.toThrow("already submitted");
    await harness.drain();
    expect(harness.respondToUserInput).toHaveBeenCalledTimes(1);
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === "user-input.resolved",
      ),
    ).toBe(false);
  });

  it.each(["settled", "expired"])(
    "question safety: %s callback rejects late answers and source replay",
    async (state) => {
      const harness = await prepareQuestion();
      await harness.activity(
        "question-terminal",
        state === "settled" ? "user-input.resolved" : "provider.user-input.respond.failed",
        {
          userInputIdentity: harness.identity,
          ...(state === "expired"
            ? { responseState: "invalidated", detail: "Stale pending user-input request" }
            : { answers: { answer: "Yes" } }),
        },
      );
      await expect(harness.respond("late-answer")).rejects.toThrow("no longer pending");
      await expect(
        harness.activity("question-safety-request", "user-input.requested", {}),
      ).rejects.toThrow("already observed");
      await harness.drain();
      expect(harness.respondToUserInput).not.toHaveBeenCalled();
      expect((await harness.readShell()).threads[0]?.hasPendingUserInput).toBe(false);
    },
  );

  it("question safety: old displayed answers cannot reach a replacement runtime reusing the provider id", async () => {
    const harness = await prepareQuestion();
    const threadId = ThreadId.make("thread-1");
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("replacement-runtime"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          runtimeSessionId: RuntimeSessionId.make("question-runtime-2"),
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.activity("replacement-question", "user-input.requested", {
      runtimeSessionId: "question-runtime-2",
    });
    await expect(harness.respond("old-screen-answer")).rejects.toThrow("identity");
    await expect(
      harness.activity("old-settlement", "user-input.resolved", {
        userInputIdentity: harness.identity,
      }),
    ).rejects.toThrow("runtime identity");
    await harness.respond("new-screen-answer", "New answer", {
      requestEventId: EventId.make("replacement-question"),
      runtimeSessionId: RuntimeSessionId.make("question-runtime-2"),
    });
    await harness.drain();
    expect(harness.respondToUserInput.mock.calls.map(([input]) => input)).toEqual([
      {
        threadId,
        requestId: "question-safety",
        answers: { answer: "New answer" },
        expectedRuntimeSessionId: "question-runtime-2",
      },
    ]);
    expect(Option.getOrUndefined(await harness.readQuestion("question-safety"))).toMatchObject({
      isPending: false,
      responseState: "settled",
    });
  });

  it("approval safety: distinct simultaneous commands forward only the winning decision", async () => {
    const harness = await prepareApproval();
    const results = await Promise.allSettled([
      harness.respond("approval-first", "accept"),
      harness.respond("approval-second", "decline"),
    ]);
    await harness.drain();
    expect(harness.respondToRequest.mock.calls.map(([input]) => input.decision)).toEqual([
      "accept",
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    await harness.respond("approval-first", "accept");
    await harness.drain();
    expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
  });

  it("approval safety: ambiguous provider failure stays unresolved and cannot be replayed", async () => {
    const harness = await prepareApproval();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "approval.respond",
          detail: "Connection lost after sending the decision",
        }),
      ),
    );
    await harness.respond("approval-ambiguous");
    await waitFor(
      async () =>
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) => activity.kind === "provider.approval.respond.failed",
        ) ?? false,
    );
    expect(
      (await harness.readModel()).threads[0]?.activities.find(
        (activity) => activity.kind === "provider.approval.respond.failed",
      )?.payload,
    ).toMatchObject({
      detail: "Connection lost after sending the decision",
      responseState: "uncertain",
    });
    expect.soft((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(true);
    await expect.soft(harness.respond("approval-ambiguous-retry")).rejects.toThrow();
    await harness.drain();
    expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
  });

  it("approval safety: dispatch acknowledgement does not imply provider settlement", async () => {
    const harness = await prepareApproval();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.respondToRequest.mockImplementation(() => Effect.promise(() => pending));
    try {
      await harness.respond("approval-in-flight");
      await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
      expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(true);
    } finally {
      release?.();
      await harness.drain();
    }
  });

  it("approval safety: exact command retry is already idempotent", async () => {
    const harness = await prepareApproval();
    const first = await harness.respond("approval-same-command");
    const retry = await harness.respond("approval-same-command");
    await harness.drain();
    expect(retry).toEqual(first);
    expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
  });

  it("approval safety: only a proven pre-send failure permits a new attempt", async () => {
    const harness = await prepareApproval();
    harness.respondToRequest.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "approval.respond",
          detail: "Validation rejected before sending",
          approvalResponseNotSent: true,
        }),
      ),
    );
    await harness.respond("safe-failure");
    await waitFor(
      async () =>
        (await harness.readModel()).threads[0]?.activities.some(
          (a) => a.kind === "provider.approval.respond.failed",
        ) ?? false,
    );
    expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(true);
    await harness.respond("safe-retry", "decline");
    await harness.drain();
    expect(harness.respondToRequest.mock.calls.map(([input]) => input.decision)).toEqual([
      "accept",
      "decline",
    ]);
    expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(false);
    await expect(
      harness.activity("late-failure", "provider.approval.respond.failed", {
        approvalIdentity: harness.identity,
        responseAttemptId: "safe-failure",
        responseState: "retryable",
      }),
    ).rejects.toThrow("Stale approval response failure");
    expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(false);
  });

  it("approval safety: source runtime is validated instead of rebinding old callbacks", async () => {
    const harness = await prepareApproval();
    await expect(
      harness.activity("old-open", "approval.requested", {
        runtimeSessionId: "old-runtime",
        requestKind: "command",
      }),
    ).rejects.toThrow("Stale approval runtime");
    await expect(
      harness.activity("old-resolved", "approval.resolved", {
        runtimeSessionId: "old-runtime",
        decision: "decline",
      }),
    ).rejects.toThrow("Stale approval runtime");
    await expect(
      harness.activity("missing-runtime", "approval.requested", {
        runtimeSessionId: undefined,
        requestKind: "command",
      }),
    ).rejects.toThrow("Stale approval runtime");
    await harness.respond("current-runtime-response");
    await harness.drain();
    expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
  });

  it("approval safety: reused provider ids require distinct callback identity and qualified settlement", async () => {
    const harness = await prepareApproval();
    await expect(
      harness.activity("overlapping-open", "approval.requested", { requestKind: "command" }),
    ).rejects.toThrow("still pending");
    await harness.respond("first-instance");
    await harness.drain();
    await harness.activity("second-open", "approval.requested", { requestKind: "command" });
    const secondIdentity = { ...harness.identity, requestEventId: EventId.make("second-open") };
    await expect(
      harness.activity("old-callback-invalidation", "provider.approval.respond.failed", {
        approvalIdentity: harness.identity,
        responseAttemptId: "first-instance",
        responseState: "invalidated",
        detail: "Stale pending approval request: old callback expired",
      }),
    ).rejects.toThrow("Stale approval response failure");

    await expect(harness.respond("stale-response", "decline")).rejects.toThrow("identity changed");
    await expect(
      harness.activity("late-first-settlement", "approval.resolved", {
        approvalIdentity: harness.identity,
        responseAttemptId: "first-instance",
        decision: "accept",
      }),
    ).rejects.toThrow("Stale or ambiguous");
    await expect(
      harness.activity("unqualified-settlement", "approval.resolved", { decision: "accept" }),
    ).rejects.toThrow("Stale or ambiguous");
    expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(true);
    await harness.respond("second-instance", "decline", secondIdentity);
    await harness.drain();
    expect(harness.respondToRequest.mock.calls.map(([input]) => input.decision)).toEqual([
      "accept",
      "decline",
    ]);
    await expect(
      harness.activity("duplicate-settlement", "approval.resolved", {
        approvalIdentity: secondIdentity,
        responseAttemptId: "second-instance",
        decision: "accept",
      }),
    ).rejects.toThrow("Stale or ambiguous");
    expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(false);
    await expect(
      harness.activity("second-open", "approval.requested", { requestKind: "command" }),
    ).resolves.toBeDefined(); // exact command receipt
    await expect(harness.respond("second-again", "accept", secondIdentity)).rejects.toThrow();
  });

  it("approval safety: missing and stopped sessions cannot open new callbacks", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const open = (id: string, runtimeSessionId?: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(id),
          threadId,
          activity: {
            id: EventId.make(id),
            kind: "approval.requested",
            tone: "approval",
            summary: "Approval",
            turnId: null,
            payload: {
              requestId: "no-session",
              requestKind: "command",
              ...(runtimeSessionId ? { runtimeSessionId } : {}),
            },
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        }),
      );
    await expect(open("without-session")).rejects.toThrow("active session");
    for (const runtimeSessionId of [undefined, RuntimeSessionId.make("stopped-runtime")]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`stopped:${runtimeSessionId}`),
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "codex",
            ...(runtimeSessionId ? { runtimeSessionId } : {}),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        }),
      );
      await expect(open(`stopped-open:${runtimeSessionId}`, runtimeSessionId)).rejects.toThrow(
        "active session",
      );
    }
    expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(false);
  });

  it("approval safety: a qualified late provider settlement may finish a stopped runtime", async () => {
    const harness = await prepareApproval();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("stop-before-settlement"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          runtimeSessionId: RuntimeSessionId.make("approval-runtime-1"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.activity("late-authoritative", "approval.resolved", {
      approvalIdentity: harness.identity,
      decision: "decline",
    });
    expect((await harness.readShell()).threads[0]?.hasPendingApprovals).toBe(false);
    expect(harness.respondToRequest).not.toHaveBeenCalled();
  });

  it("approval safety: an authoritative provider decision wins over a delayed local acknowledgement", async () => {
    const harness = await prepareApproval();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.respondToRequest.mockImplementation(() => Effect.promise(() => pending));
    try {
      await harness.respond("local-attempt");
      await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
      await harness.activity("provider-winner", "approval.resolved", { decision: "decline" });
    } finally {
      release();
      await harness.drain();
    }
    const settlements = (await harness.readModel()).threads[0]?.activities.filter(
      (activity) => activity.kind === "approval.resolved",
    );
    expect(settlements).toHaveLength(1);
    expect(settlements?.[0]?.payload).toMatchObject({ decision: "decline" });
    await expect(harness.respond("late-retry", "accept")).rejects.toThrow("no longer pending");
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeSessionId: RuntimeSessionId.make("approval-runtime-legacy-test"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("forward-approval-open"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("forward-approval-open"),
          kind: "approval.requested",
          tone: "approval",
          summary: "Approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
            runtimeSessionId: "approval-runtime-legacy-test",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        approvalIdentity: {
          requestEventId: EventId.make("forward-approval-open"),
          runtimeSessionId: RuntimeSessionId.make("approval-runtime-legacy-test"),
        },
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
      expectedRuntimeSessionId: "approval-runtime-legacy-test",
    });
  });

  it.each(["pending", "resolved", "expired"])(
    "only forwards answers for a pending question: %s",
    async (state) => {
      const harness = await createHarness();
      const now = new Date().toISOString();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-user-input"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeSessionId: RuntimeSessionId.make("question-test-runtime"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("question-open"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("question-open"),
            kind: "user-input.requested",
            tone: "info",
            summary: "Question",
            payload: {
              requestId: "user-input-request-1",
              runtimeSessionId: "question-test-runtime",
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        }),
      );
      if (state !== "pending") {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("question-close"),
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("question-close"),
              kind:
                state === "resolved" ? "user-input.resolved" : "provider.user-input.respond.failed",
              tone: "info",
              summary: "Question closed",
              payload: {
                requestId: "user-input-request-1",
                runtimeSessionId: "question-test-runtime",
                userInputIdentity: {
                  requestEventId: "question-open",
                  runtimeSessionId: "question-test-runtime",
                },
                detail: "Stale pending user-input request",
              },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
        await expect(
          Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.user-input.respond",
              commandId: CommandId.make("stale-answer"),
              threadId: ThreadId.make("thread-1"),
              requestId: asApprovalRequestId("user-input-request-1"),
              answers: { sandbox_mode: "workspace-write" },
              createdAt: now,
            }),
          ),
        ).rejects.toThrow("no longer pending");
        expect(harness.respondToUserInput).not.toHaveBeenCalled();
        return;
      }

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make("cmd-user-input-respond"),
          threadId: ThreadId.make("thread-1"),
          requestId: asApprovalRequestId("user-input-request-1"),
          userInputIdentity: {
            requestEventId: EventId.make("question-open"),
            runtimeSessionId: RuntimeSessionId.make("question-test-runtime"),
          },
          answers: {
            sandbox_mode: "workspace-write",
          },
          createdAt: now,
        }),
      );

      await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
      expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
        threadId: "thread-1",
        requestId: "user-input-request-1",
        expectedRuntimeSessionId: "question-test-runtime",
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
    },
  );

  it("normalizes stale Codex approval callbacks without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "item/requestApproval/decision",
          detail: "Unknown pending Codex approval request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeSessionId: RuntimeSessionId.make("approval-runtime-legacy-test"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
            runtimeSessionId: "approval-runtime-legacy-test",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        approvalIdentity: {
          requestEventId: EventId.make("activity-approval-requested"),
          runtimeSessionId: RuntimeSessionId.make("approval-runtime-legacy-test"),
        },
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
    expect(Option.getOrUndefined(await harness.readApproval("approval-request-1"))).toMatchObject({
      status: "resolved",
      responseState: "invalidated",
      decision: null,
    });
  });

  it.each(["missing-callback", "lost-runtime"])(
    "expires %s user-input failures without faking a submitted answer",
    async (reason) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      harness.respondToUserInput.mockImplementation(() =>
        Effect.fail(
          reason === "lost-runtime"
            ? new ProviderSessionNotFoundError({ threadId: ThreadId.make("thread-1") })
            : new ProviderAdapterRequestError({
                provider: ProviderDriverKind.make("claudeAgent"),
                method: "item/tool/respondToUserInput",
                detail: "Unknown pending user-input request: user-input-request-1",
              }),
        ),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-user-input-error"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "claudeAgent",
            runtimeSessionId: RuntimeSessionId.make("question-test-runtime"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-user-input-requested"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-1",
              runtimeSessionId: "question-test-runtime",
              questions: [
                {
                  id: "sandbox_mode",
                  header: "Sandbox",
                  question: "Which mode should be used?",
                  options: [
                    {
                      label: "workspace-write",
                      description: "Allow workspace writes only",
                    },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make("cmd-user-input-respond-stale"),
          threadId: ThreadId.make("thread-1"),
          requestId: asApprovalRequestId("user-input-request-1"),
          userInputIdentity: {
            requestEventId: EventId.make("activity-user-input-requested"),
            runtimeSessionId: RuntimeSessionId.make("question-test-runtime"),
          },
          answers: {
            sandbox_mode: "workspace-write",
          },
          createdAt: now,
        }),
      );

      await waitFor(async () => {
        const readModel = await harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        if (!thread) return false;
        return thread.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        );
      });

      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread).toBeDefined();

      const failureActivity = thread?.activities.find(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
      expect(failureActivity).toBeDefined();
      expect(failureActivity?.payload).toMatchObject({
        requestId: "user-input-request-1",
        detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
      });

      const resolvedActivity = thread?.activities.find(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
      );
      expect(resolvedActivity).toBeUndefined();
    },
  );

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  describe("turn finalization", () => {
    const threadId = ThreadId.make("thread-1");

    const readThread = async (harness: Awaited<ReturnType<typeof createHarness>>) =>
      (await harness.readModel()).threads.find((entry) => entry.id === threadId);

    const readReleasedTurns = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
      const events = await Effect.runPromise(
        Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        ),
      );
      return events.flatMap((event) =>
        event.type === "thread.session-set" && event.payload.releasedTurn
          ? [event.payload.releasedTurn]
          : [],
      );
    };

    /** Simulates ingestion projecting the provider's turn.started for `turnId`. */
    const projectRunningTurn = (
      harness: Awaited<ReturnType<typeof createHarness>>,
      turnId: TurnId,
      overrides: { readonly lastError?: string | null } = {},
    ) =>
      Effect.gen(function* () {
        const thread = yield* Effect.promise(() => readThread(harness));
        const session = thread?.session;
        if (!session) {
          return yield* Effect.die(new Error("expected a bound session"));
        }
        const now = new Date().toISOString();
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`ingested-turn-started-${turnId}`),
          threadId,
          session: {
            ...session,
            status: "running",
            activeTurnId: turnId,
            lastError: overrides.lastError ?? null,
            updatedAt: now,
          },
          createdAt: now,
        });
      });

    /** The harness's sendTurn mock is typed as infallible; failing sends are cast to it. */
    const asFailingSend = <A, E>(effect: Effect.Effect<A, E>) => effect as never;

    const startTurn = (harness: Awaited<ReturnType<typeof createHarness>>, messageId: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-start-${messageId}`),
          threadId,
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text: "finalize me",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );

    it("labels a started turn error when the provider send fails afterwards", async () => {
      const harness = await createHarness();
      const turnId = asTurnId("turn-started-then-failed");
      harness.sendTurn.mockImplementationOnce(() =>
        asFailingSend(
          projectRunningTurn(harness, turnId).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "cursor",
                  method: "session/prompt",
                  detail: "prompt failed after start",
                }),
              ),
            ),
          ),
        ),
      );

      await startTurn(harness, "user-message-started-then-failed");
      await waitFor(async () =>
        Boolean(
          (await readThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.turn.start.failed",
          ),
        ),
      );
      await harness.drain();

      const thread = await readThread(harness);
      expect(thread?.latestTurn).toMatchObject({ turnId, state: "error" });
      expect(thread?.latestTurn?.completedAt).not.toBeNull();
      expect(thread?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: "prompt failed after start",
      });
      expect(await readReleasedTurns(harness)).toEqual([
        expect.objectContaining({ turnId, state: "error", reason: "turn-start-failed" }),
      ]);
    });

    it("keeps an error session that ingestion already set from the adapter terminal", async () => {
      const harness = await createHarness();
      const turnId = asTurnId("turn-adapter-terminal-first");
      harness.sendTurn.mockImplementationOnce(() =>
        asFailingSend(
          Effect.gen(function* () {
            yield* projectRunningTurn(harness, turnId);
            const session = (yield* Effect.promise(() => readThread(harness)))?.session;
            const now = new Date().toISOString();
            // Ingestion projected the adapter's turn.completed{failed} first.
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("ingested-turn-failed"),
              threadId,
              session: {
                ...session!,
                status: "error",
                activeTurnId: null,
                lastError: "adapter reported failure",
                updatedAt: now,
              },
              turnOutcome: {
                turnId,
                state: "error",
                reason: "provider-turn-completed",
                completedAt: now,
              },
              createdAt: now,
            });
            return yield* Effect.fail(
              new ProviderAdapterRequestError({
                provider: "cursor",
                method: "session/prompt",
                detail: "prompt failed after start",
              }),
            );
          }),
        ),
      );

      await startTurn(harness, "user-message-adapter-terminal-first");
      await waitFor(async () =>
        Boolean(
          (await readThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.turn.start.failed",
          ),
        ),
      );
      await harness.drain();

      const thread = await readThread(harness);
      expect(thread?.session?.status).toBe("error");
      expect(thread?.latestTurn).toMatchObject({ turnId, state: "error" });
    });

    it("labels a running turn interrupted when a runtime mode change replaces the session", async () => {
      const harness = await createHarness();
      const turnId = asTurnId("turn-replaced-session");
      await startTurn(harness, "user-message-replaced-session");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(projectRunningTurn(harness, turnId));

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-mode-mid-turn"),
          threadId,
          runtimeMode: "full-access",
          createdAt: new Date().toISOString(),
        }),
      );
      await waitFor(() => harness.startSession.mock.calls.length === 2);
      await harness.drain();

      const thread = await readThread(harness);
      expect(thread?.session).toMatchObject({ activeTurnId: null, runtimeMode: "full-access" });
      expect(thread?.latestTurn).toMatchObject({ turnId, state: "interrupted" });
      expect(await readReleasedTurns(harness)).toEqual([
        expect.objectContaining({ turnId, state: "interrupted", reason: "session-replaced" }),
      ]);
    });

    it("labels a running turn interrupted when the user stops a session with a stale error", async () => {
      const harness = await createHarness();
      const turnId = asTurnId("turn-user-stopped");
      await startTurn(harness, "user-message-user-stopped");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(
        projectRunningTurn(harness, turnId, { lastError: "stale provider warning" }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-session-stop-mid-turn"),
          threadId,
          createdAt: new Date().toISOString(),
        }),
      );
      await waitFor(() => harness.stopSession.mock.calls.length === 1);
      await harness.drain();

      const thread = await readThread(harness);
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.latestTurn).toMatchObject({ turnId, state: "interrupted" });
      expect(await readReleasedTurns(harness)).toEqual([
        expect.objectContaining({ turnId, state: "interrupted", reason: "session-stopped" }),
      ]);
    });
  });
});
