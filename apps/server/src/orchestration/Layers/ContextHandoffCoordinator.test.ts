import {
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ContextHandoffEndpointSnapshot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ServerProvider,
} from "@ryco/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ContextHandoffRepository,
  type ContextHandoffRecord,
  type ContextHandoffRepositoryShape,
  makeRequestedContextHandoffRecord,
} from "../../persistence/Services/ContextHandoffs.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { ProviderRuntimeBinding } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderAdapterRequestError,
  ProviderSessionDirectoryPersistenceError,
  type ProviderServiceError,
} from "../../provider/Errors.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import type { ProviderFreshSessionStartInput } from "../../provider/Services/ProviderService.ts";
import {
  ContextHandoffCoordinator,
  type ContextHandoffLaneControl,
} from "../Services/ContextHandoffCoordinator.ts";
import { ProviderSessionStartCancelledError } from "../threadLaneControl.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { STORAGE_FAILURE_DETAIL } from "../userFacingErrors.ts";
import {
  ContextHandoffService,
  type ContextHandoffServiceShape,
  type PreparedContextHandoffArtifact,
} from "../contextHandoff/ContextHandoffService.ts";
import {
  ModelManifest,
  BUNDLED_MODEL_MANIFEST,
  type ModelManifestData,
} from "../../provider/ModelManifest.ts";
import type { ContextHandoffInputBudget } from "@ryco/contracts";
import { ContextHandoffCoordinatorLive } from "./ContextHandoffCoordinator.ts";

const createdAt = "2026-08-04T00:00:00.000Z";
const handoffId = ContextHandoffId.make("handoff-coordinator");
const activityId = EventId.make("handoff-activity");
const targetMessageId = MessageId.make("target-message");
const sourceRuntimeSessionId = RuntimeSessionId.make("runtime-a1");
const targetRuntimeSessionId = RuntimeSessionId.make("runtime-b1");
const targetTurnId = TurnId.make("provider-turn-b1");

const sourceSelection = {
  instanceId: ProviderInstanceId.make("codex_work"),
  model: "gpt-5.6-sol",
};
const targetSelection = {
  instanceId: ProviderInstanceId.make("claude_work"),
  model: "claude-fable-5",
};

const sourceEndpoint: ContextHandoffEndpointSnapshot = {
  providerInstanceId: sourceSelection.instanceId,
  driverKind: ProviderDriverKind.make("codex"),
  providerDisplayName: "Codex Work",
  modelSlug: sourceSelection.model,
  modelDisplayName: "GPT-5.6 Sol",
};
const targetEndpoint: ContextHandoffEndpointSnapshot = {
  providerInstanceId: targetSelection.instanceId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  providerDisplayName: "Claude Work",
  modelSlug: targetSelection.model,
  modelDisplayName: "Fable 5",
};
const priorEndpoint: ContextHandoffEndpointSnapshot = {
  providerInstanceId: ProviderInstanceId.make("grok_work"),
  driverKind: ProviderDriverKind.make("grok"),
  providerDisplayName: "Grok Work",
  modelSlug: "grok-4.5",
  modelDisplayName: "Grok 4.5",
};

function providerSnapshot(
  endpoint: ContextHandoffEndpointSnapshot,
  model: { readonly name: string; readonly shortName?: string },
): ServerProvider {
  return {
    instanceId: endpoint.providerInstanceId,
    driver: endpoint.driverKind,
    ...(endpoint.providerDisplayName ? { displayName: endpoint.providerDisplayName } : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: createdAt,
    models: [
      {
        slug: endpoint.modelSlug,
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const providerSnapshots: ReadonlyArray<ServerProvider> = [
  providerSnapshot(sourceEndpoint, { name: "GPT-5.6 Sol" }),
  providerSnapshot(targetEndpoint, {
    name: "Claude Fable 5",
    shortName: "Fable 5",
  }),
  providerSnapshot(priorEndpoint, { name: "Grok 4.5" }),
];

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-handoff-coordinator"),
    projectId: ProjectId.make("project-handoff-coordinator"),
    title: "Context handoff coordinator",
    modelSelection: sourceSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    tokenMode: "balanced",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("source-message"),
        role: "assistant",
        text: "Canonical source history",
        turnId: TurnId.make("source-turn"),
        streaming: false,
        createdAt: "2026-08-03T23:59:59.000Z",
        updatedAt: "2026-08-03T23:59:59.000Z",
      },
      {
        id: targetMessageId,
        role: "user",
        text: "  Preserve this exact message 👩🏽‍💻  ",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    proposedPlans: [],
    activities: [
      {
        id: activityId,
        tone: "info",
        kind: "context-handoff",
        summary: "Context handoff requested",
        payload: {
          schemaVersion: 1,
          handoffId,
          mode: "full-context-fresh-session",
          status: "requested",
          targetMessageId,
          sourceSelection,
          targetSelection,
          sourceRuntimeSessionId,
        },
        turnId: null,
        createdAt,
      },
    ],
    checkpoints: [],
    session: {
      threadId: ThreadId.make("thread-handoff-coordinator"),
      status: "ready",
      providerName: "codex",
      providerInstanceId: sourceSelection.instanceId,
      runtimeSessionId: sourceRuntimeSessionId,
      runtimeMode: "full-access",
      tokenMode: "balanced",
      activeTurnId: null,
      lastError: null,
      updatedAt: createdAt,
    },
    ...overrides,
  };
}

function requestedRecord(): ContextHandoffRecord {
  return makeRequestedContextHandoffRecord({
    handoffId,
    threadId: ThreadId.make("thread-handoff-coordinator"),
    sourceSelection,
    targetSelection,
    sourceRuntimeSessionId,
    firstMessageId: targetMessageId,
    createdAt,
    updatedAt: createdAt,
  });
}

interface RepositoryHooks {
  /** 1-based `getById` calls that fail with a storage error. */
  readonly getByIdFailures?: ReadonlyArray<number>;
  /** Runs after a `getById` call has taken its snapshot, e.g. to simulate a concurrent writer. */
  readonly afterGetById?: (
    call: number,
    current: ContextHandoffRecord | undefined,
  ) => ContextHandoffRecord | undefined;
}

function makeRepository(initial?: ContextHandoffRecord, hooks: RepositoryHooks = {}) {
  let record = initial;
  let getByIdCalls = 0;
  const service: ContextHandoffRepositoryShape = {
    create: (input) =>
      Effect.sync(() => {
        if (record) return false;
        record = input;
        return true;
      }),
    getById: ({ handoffId: requestedId }) =>
      Effect.suspend(() => {
        const call = ++getByIdCalls;
        if (hooks.getByIdFailures?.includes(call)) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "ContextHandoffRepository.getById",
              detail: "Failed to execute ContextHandoffRepository.getById",
            }),
          );
        }
        const snapshot = record?.handoffId === requestedId ? Option.some(record) : Option.none();
        if (hooks.afterGetById) record = hooks.afterGetById(call, record);
        return Effect.succeed(snapshot);
      }),
    listByThread: () => Effect.succeed(record ? [record] : []),
    listRecoverable: () =>
      Effect.succeed(
        record && (record.status === "preparing" || record.status === "dispatching")
          ? [record]
          : [],
      ),
    compareAndSetStatus: (input) =>
      Effect.sync(() => {
        if (!record || record.status !== input.expectedStatus) return false;
        record = {
          ...record,
          status: input.nextStatus,
          targetRuntimeSessionId: input.targetRuntimeSessionId,
          acceptedProviderTurnId: input.acceptedProviderTurnId,
          error: input.error,
          updatedAt: input.updatedAt,
        };
        return true;
      }),
    storeContextIfEmpty: () => Effect.succeed(false),
    storeDeliveryArtifactIfEmpty: (input) =>
      Effect.sync(() => {
        if (!record || record.deliveryArtifact !== null) return false;
        record = {
          ...record,
          deliveryArtifact: input.deliveryArtifact,
          updatedAt: input.updatedAt,
        };
        return true;
      }),
  };
  return { service, get: () => record! };
}

const artifact: PreparedContextHandoffArtifact = {
  origin: "stored",
  document: {
    version: 1,
    mode: "full-context-fresh-session",
    thread: {
      id: ThreadId.make("thread-handoff-coordinator"),
      title: "Context handoff coordinator",
      branch: null,
      worktreePath: null,
    },
    provenance: { sources: [sourceEndpoint], target: targetEndpoint },
    messages: [],
    plans: [],
    tools: [],
    checkpoints: [],
    notices: [],
    subagents: [],
    priorHandoffs: [],
  },
  canonicalJson: "{}",
  digest: "a".repeat(64),
  entryCount: 0,
};

function sourceSession(): ProviderSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: sourceSelection.instanceId,
    runtimeSessionId: sourceRuntimeSessionId,
    status: "ready",
    runtimeMode: "full-access",
    tokenMode: "balanced",
    model: sourceSelection.model,
    threadId: ThreadId.make("thread-handoff-coordinator"),
    createdAt,
    updatedAt: createdAt,
  };
}

function turnStartEvent(): Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-start-requested" }
> {
  return {
    sequence: 4,
    eventId: EventId.make("turn-start-event"),
    type: "thread.turn-start-requested" as const,
    aggregateKind: "thread" as const,
    aggregateId: ThreadId.make("thread-handoff-coordinator"),
    commandId: CommandId.make("turn-start-command"),
    causationEventId: EventId.make("message-event"),
    correlationId: CommandId.make("turn-start-command"),
    metadata: {},
    occurredAt: createdAt,
    payload: {
      threadId: ThreadId.make("thread-handoff-coordinator"),
      messageId: targetMessageId,
      modelSelection: targetSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      tokenMode: "balanced" as const,
      contextHandoff: { handoffId, activityId, targetMessageId },
      createdAt,
    },
  };
}

function makeHarness(input?: {
  readonly manifestCurrent?: Effect.Effect<ModelManifestData>;
  readonly initialRecord?: ContextHandoffRecord;
  readonly thread?: OrchestrationThread;
  readonly sendFailure?: ProviderServiceError;
  readonly providerSnapshots?: ReadonlyArray<ServerProvider>;
  readonly artifactSources?: ReadonlyArray<ContextHandoffEndpointSnapshot>;
  readonly getThreadDetailById?: ProjectionSnapshotQueryShape["getThreadDetailById"];
  readonly getSession?: ProviderServiceShape["getSession"];
  readonly startFreshSessionFailure?: ProviderServiceError;
  readonly repositoryHooks?: RepositoryHooks;
}) {
  const repository = makeRepository(input?.initialRecord, input?.repositoryHooks);
  const thread = input?.thread ?? makeThread();
  const commands: OrchestrationCommand[] = [];
  const deliveryOrder: string[] = [];
  const preparedBudgets: Array<{
    [K in keyof ContextHandoffInputBudget]: ContextHandoffInputBudget[K] | undefined;
  }> = [];
  const dispatch = vi.fn((command: OrchestrationCommand) =>
    Effect.sync(() => {
      commands.push(command);
      return { sequence: commands.length };
    }),
  );
  const startFreshSession = vi.fn(
    (_threadId: ThreadId, freshInput: ProviderFreshSessionStartInput) =>
      Effect.suspend(() => {
        deliveryOrder.push("start");
        if (input?.startFreshSessionFailure) return Effect.fail(input.startFreshSessionFailure);
        return Effect.succeed({
          session: {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: targetSelection.instanceId,
            runtimeSessionId: freshInput.runtimeSessionId,
            status: "ready" as const,
            runtimeMode: "full-access" as const,
            tokenMode: "balanced" as const,
            model: targetSelection.model,
            threadId: thread.id,
            createdAt,
            updatedAt: createdAt,
          },
          previousBinding: {
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: sourceSelection.instanceId,
            runtimeSessionId: sourceRuntimeSessionId,
            runtimeMode: "full-access" as const,
            resumeCursor: { source: "resume-a1" },
          },
        });
      }),
  );
  const sendTurn = vi.fn((_input: ProviderSendTurnInput) =>
    Effect.sync(() => deliveryOrder.push("send")).pipe(
      Effect.flatMap(() =>
        input?.sendFailure
          ? Effect.fail(input.sendFailure)
          : Effect.succeed({ threadId: thread.id, turnId: targetTurnId }),
      ),
    ),
  );
  const stopSessionBinding = vi.fn((_binding: ProviderRuntimeBinding) =>
    Effect.succeed("stopped" as const),
  );
  const retireSessionBinding = vi.fn(() => Effect.succeed(true));
  const restoreSessionBinding = vi.fn((_binding: ProviderRuntimeBinding) =>
    Effect.sync(() => {
      deliveryOrder.push("restore");
      return true;
    }),
  );
  const stopSession = vi.fn((_input: { readonly threadId: ThreadId }) =>
    Effect.sync(() => {
      deliveryOrder.push("stop-session");
    }),
  );
  const contextService: ContextHandoffServiceShape = {
    buildAndStore: ({ source, target }) =>
      Effect.succeed({
        ...artifact,
        origin: "built",
        document: {
          ...artifact.document,
          provenance: { sources: input?.artifactSources ?? [source], target },
        },
      }),
    loadStoredContext: () => Effect.succeed(artifact),
    renderStoredContext: ({ currentMessage }) =>
      Effect.succeed({
        providerInput: `<context>${currentMessage}</context>`,
        renderedContext: artifact.document,
        renderedContextJson: "{}",
        contextChars: 2,
        inputChars: currentMessage.length + 19,
        includedEntryCount: 0,
        totalEntryCount: 0,
        truncated: false,
      }),
    prepareDeliveryArtifact: ({
      currentMessage,
      triggeringMessageId,
      preparedAt,
      maxInputChars,
      budgetSource,
      contextWindowTokens,
    }) =>
      Effect.sync(() => {
        preparedBudgets.push({ maxInputChars, budgetSource, contextWindowTokens });
        deliveryOrder.push("persist");
        return {
          artifactVersion: 1 as const,
          rendererVersion: 1 as const,
          renderedContext: artifact.document,
          providerInput: `<context>${currentMessage}</context>`,
          triggeringMessage: {
            messageId: triggeringMessageId,
            text: currentMessage,
          },
          renderedContextDigest: "b".repeat(64),
          providerInputDigest: "c".repeat(64),
          includedEntryCount: 0,
          totalEntryCount: 0,
          contextChars: 2,
          inputChars: currentMessage.length + 19,
          truncated: false,
          preparedAt,
        };
      }),
  };

  const dependencies = Layer.mergeAll(
    Layer.succeed(ModelManifest, {
      current: input?.manifestCurrent ?? Effect.succeed(BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
      refreshIfStale: Effect.succeed(BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Layer.succeed(ContextHandoffRepository, repository.service),
    Layer.succeed(ContextHandoffService, contextService),
    Layer.mock(OrchestrationEngineService)({
      bootSequence: 0,
      dispatch,
      streamDomainEvents: Stream.empty,
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById:
        input?.getThreadDetailById ?? (() => Effect.succeed(Option.some(thread))),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: sourceSelection,
            customSystemPrompt: null,
            customAvatarContentHash: null,
            preferredRemoteName: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          }),
        ),
    }),
    Layer.mock(ProviderService)({
      getInstanceInfo: (instanceId) =>
        Effect.succeed(
          instanceId === sourceSelection.instanceId
            ? {
                instanceId,
                driverKind: sourceEndpoint.driverKind,
                displayName: sourceEndpoint.providerDisplayName,
                enabled: true,
                continuationIdentity: {
                  driverKind: sourceEndpoint.driverKind,
                  continuationKey: "source",
                },
              }
            : {
                instanceId,
                driverKind: targetEndpoint.driverKind,
                displayName: targetEndpoint.providerDisplayName,
                enabled: true,
                continuationIdentity: {
                  driverKind: targetEndpoint.driverKind,
                  continuationKey: "target",
                },
              },
        ),
      getSession: input?.getSession ?? (() => Effect.succeed(Option.some(sourceSession()))),
      startFreshSession,
      sendTurn,
      stopSessionBinding,
      retireSessionBinding,
      restoreSessionBinding,
      stopSession,
      streamEvents: Stream.empty,
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed(input?.providerSnapshots ?? providerSnapshots),
      streamChanges: Stream.empty,
    }),
  );
  const layer = ContextHandoffCoordinatorLive.pipe(Layer.provide(dependencies));
  return {
    repository,
    commands,
    deliveryOrder,
    preparedBudgets,
    startFreshSession,
    sendTurn,
    stopSessionBinding,
    retireSessionBinding,
    restoreSessionBinding,
    stopSession,
    run: (effect: Effect.Effect<void, never, ContextHandoffCoordinator>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  };
}

describe("ContextHandoffCoordinator", () => {
  it("starts and sends once, persists acceptance, then projects the boundary and target", async () => {
    const harness = makeHarness();
    const event = turnStartEvent();
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(event);
        yield* coordinator.processTurnStart(event);
      }),
    );

    expect(harness.preparedBudgets[0]).toEqual({
      maxInputChars: 1_400_000,
      budgetSource: "manifest",
      contextWindowTokens: 1_000_000,
    });
    expect(harness.startFreshSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.deliveryOrder).toEqual(["persist", "start", "send"]);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: "<context>  Preserve this exact message 👩🏽‍💻  </context>",
      modelSelection: targetSelection,
    });
    expect(harness.repository.get()).toMatchObject({
      status: "consumed",
      targetRuntimeSessionId: harness.startFreshSession.mock.calls[0]?.[1].runtimeSessionId,
      acceptedProviderTurnId: targetTurnId,
      contextDigest: null,
    });
    const terminalActivity = harness.commands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "context-handoff" &&
        (command.activity.payload as { status?: string }).status === "consumed",
    );
    expect(terminalActivity).toBeDefined();
    expect(
      terminalActivity?.type === "thread.activity.append"
        ? terminalActivity.activity.payload
        : null,
    ).toMatchObject({
      sources: [{ modelSlug: "gpt-5.6-sol", modelDisplayName: "GPT-5.6 Sol" }],
      target: { modelSlug: "claude-fable-5", modelDisplayName: "Fable 5" },
      inspection: {
        completeEntryCount: 0,
        includedEntryCount: 0,
        completeDigest: "a".repeat(64),
        providerInputDigest: "c".repeat(64),
      },
    });
    expect(harness.commands.some((command) => command.type === "thread.meta.update")).toBe(true);
  });

  it("falls back to model slugs when a provider catalog entry is unavailable", async () => {
    const harness = makeHarness({ providerSnapshots: [] });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(turnStartEvent());
      }),
    );

    const terminalActivity = harness.commands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "context-handoff" &&
        (command.activity.payload as { status?: string }).status === "consumed",
    );
    expect(
      terminalActivity?.type === "thread.activity.append"
        ? terminalActivity.activity.payload
        : null,
    ).toMatchObject({
      sources: [{ modelSlug: "gpt-5.6-sol" }],
      target: { modelSlug: "claude-fable-5" },
    });
    expect(
      terminalActivity?.type === "thread.activity.append"
        ? (
            terminalActivity.activity.payload as {
              target?: { modelDisplayName?: string };
            }
          ).target?.modelDisplayName
        : undefined,
    ).toBeUndefined();
  });

  it("refreshes friendly labels for every source carried forward from prior handoffs", async () => {
    const harness = makeHarness({
      artifactSources: [
        {
          providerInstanceId: sourceEndpoint.providerInstanceId,
          driverKind: sourceEndpoint.driverKind,
          modelSlug: sourceEndpoint.modelSlug,
        },
        {
          providerInstanceId: priorEndpoint.providerInstanceId,
          driverKind: priorEndpoint.driverKind,
          modelSlug: priorEndpoint.modelSlug,
        },
      ],
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(turnStartEvent());
      }),
    );

    const terminalActivity = harness.commands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "context-handoff" &&
        (command.activity.payload as { status?: string }).status === "consumed",
    );
    expect(
      terminalActivity?.type === "thread.activity.append"
        ? terminalActivity.activity.payload
        : null,
    ).toMatchObject({
      sources: [
        {
          providerDisplayName: "Codex Work",
          modelDisplayName: "GPT-5.6 Sol",
        },
        {
          providerDisplayName: "Grok Work",
          modelDisplayName: "Grok 4.5",
        },
      ],
      target: {
        providerDisplayName: "Claude Work",
        modelDisplayName: "Fable 5",
      },
    });
  });

  it("marks an explicit failed boundary and restores the exact source on rejection", async () => {
    const sendFailure = new ProviderAdapterRequestError({
      provider: "claudeAgent",
      method: "sendTurn",
      detail: "target rejected the turn",
    });
    const harness = makeHarness({ sendFailure });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(turnStartEvent());
      }),
    );

    expect(harness.repository.get()).toMatchObject({
      status: "failed",
      error: "target rejected the turn",
    });
    expect(harness.restoreSessionBinding).toHaveBeenCalledTimes(1);
    expect(harness.stopSessionBinding).toHaveBeenCalledTimes(1);
    expect(harness.retireSessionBinding).toHaveBeenCalledTimes(1);
    expect(harness.restoreSessionBinding.mock.calls[0]?.[0]).toMatchObject({
      runtimeSessionId: sourceRuntimeSessionId,
      resumeCursor: { source: "resume-a1" },
    });
    expect(harness.commands.some((command) => command.type === "thread.meta.update")).toBe(false);
    expect(
      harness.commands.some(
        (command) =>
          command.type === "thread.activity.append" &&
          (command.activity.payload as { status?: string }).status === "failed",
      ),
    ).toBe(true);
  });

  it("never resends an ambiguous dispatch during recovery", async () => {
    const record: ContextHandoffRecord = {
      ...requestedRecord(),
      status: "dispatching",
      targetRuntimeSessionId,
      structuredContext: artifact.document,
      contextDigest: artifact.digest,
      updatedAt: "2026-08-04T00:00:01.000Z",
    };
    const harness = makeHarness({ initialRecord: record });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.recover();
      }),
    );

    expect(harness.startFreshSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.repository.get().status).toBe("delivery-uncertain");
    expect(
      harness.commands.some(
        (command) =>
          command.type === "thread.activity.append" &&
          (command.activity.payload as { status?: string }).status === "delivery-uncertain",
      ),
    ).toBe(true);
  });

  it("reconciles a durably accepted dispatch without resending", async () => {
    const record: ContextHandoffRecord = {
      ...requestedRecord(),
      status: "dispatching",
      targetRuntimeSessionId,
      structuredContext: artifact.document,
      contextDigest: artifact.digest,
      acceptedProviderTurnId: targetTurnId,
      updatedAt: "2026-08-04T00:00:01.000Z",
    };
    const harness = makeHarness({ initialRecord: record });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.recover();
      }),
    );

    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.repository.get()).toMatchObject({
      status: "consumed",
      acceptedProviderTurnId: targetTurnId,
    });
    expect(harness.commands.some((command) => command.type === "thread.meta.update")).toBe(true);
  });

  const turnStartFailureCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
    commands.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "provider.turn.start.failed",
    );

  /** Payloads appended for the decider's handoff activity id. */
  const handoffActivityPayloads = (commands: ReadonlyArray<OrchestrationCommand>) =>
    commands.flatMap((command) =>
      command.type === "thread.activity.append" &&
      command.activity.kind === "context-handoff" &&
      command.activity.id === activityId
        ? [command.activity.payload]
        : [],
    );

  it("reports a thread read failure before dispatch", async () => {
    const harness = makeHarness({
      getThreadDetailById: () =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "ProjectionThreads.getDetailById",
            detail: "Failed to execute ProjectionThreads.getDetailById",
          }),
        ),
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(turnStartEvent());
      }),
    );

    expect(harness.commands).toHaveLength(1);
    const failures = turnStartFailureCommands(harness.commands);
    expect(failures).toHaveLength(1);
    expect(
      failures[0]?.type === "thread.activity.append" ? failures[0].activity.payload : null,
    ).toMatchObject({ messageId: targetMessageId, detail: STORAGE_FAILURE_DETAIL });
    expect(harness.repository.get()).toBeUndefined();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("fails a preparing record when pre-dispatch reads fail and never re-dispatches it on recovery", async () => {
    let sessionReads = 0;
    const harness = makeHarness({
      getSession: () =>
        sessionReads++ === 0
          ? Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getBinding",
                detail: "Failed to read provider session binding",
              }),
            )
          : Effect.succeed(Option.some(sourceSession())),
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(turnStartEvent());
      }),
    );

    expect(harness.repository.get()).toMatchObject({
      status: "failed",
      error: STORAGE_FAILURE_DETAIL,
    });
    const failures = turnStartFailureCommands(harness.commands);
    expect(failures).toHaveLength(1);
    expect(
      failures[0]?.type === "thread.activity.append" ? failures[0].activity.payload : null,
    ).toMatchObject({ messageId: targetMessageId, detail: STORAGE_FAILURE_DETAIL });
    // The decider's `requested` activity is replaced, so the thread can hand off again.
    expect(handoffActivityPayloads(harness.commands)).toEqual([
      expect.objectContaining({
        handoffId,
        status: "failed",
        error: STORAGE_FAILURE_DETAIL,
        sources: [expect.objectContaining({ providerInstanceId: sourceSelection.instanceId })],
        target: expect.objectContaining({ providerInstanceId: targetSelection.instanceId }),
      }),
    ]);
    // No target epoch was reserved, so no runtime was touched.
    expect(harness.stopSessionBinding).not.toHaveBeenCalled();
    expect(harness.retireSessionBinding).not.toHaveBeenCalled();
    expect(harness.restoreSessionBinding).not.toHaveBeenCalled();

    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.recover();
      }),
    );
    expect(harness.startFreshSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("rolls back a reserved target epoch when failure finalization breaks before dispatch", async () => {
    // startFreshSession fails after the target epoch was reserved and projected
    // as `starting`; finalizeFailure then fails at its record read (call 2).
    const harness = makeHarness({
      startFreshSessionFailure: new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "session/start",
        detail: "target failed to start",
      }),
      repositoryHooks: { getByIdFailures: [2] },
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(turnStartEvent());
      }),
    );

    const reservedTarget = harness.repository.get().targetRuntimeSessionId;
    expect(reservedTarget).not.toBeNull();
    expect(harness.repository.get()).toMatchObject({
      status: "failed",
      error: STORAGE_FAILURE_DETAIL,
    });
    expect(harness.stopSessionBinding).toHaveBeenCalledTimes(1);
    expect(harness.stopSessionBinding.mock.calls[0]?.[0]).toMatchObject({
      providerInstanceId: targetSelection.instanceId,
      runtimeSessionId: reservedTarget,
    });
    expect(harness.retireSessionBinding).toHaveBeenCalledTimes(1);
    expect(harness.restoreSessionBinding).toHaveBeenCalledTimes(1);
    expect(harness.restoreSessionBinding.mock.calls[0]?.[0]).toMatchObject({
      providerInstanceId: sourceSelection.instanceId,
      runtimeSessionId: sourceRuntimeSessionId,
    });
    const sessions = harness.commands.flatMap((command) =>
      command.type === "thread.session.set" ? [command.session] : [],
    );
    expect(sessions.at(-1)).toMatchObject({
      providerInstanceId: sourceSelection.instanceId,
      runtimeSessionId: sourceRuntimeSessionId,
      status: "ready",
      lastError: null,
    });
    expect(handoffActivityPayloads(harness.commands)).toEqual([
      expect.objectContaining({ status: "failed", targetRuntimeSessionId: reservedTarget }),
    ]);
    expect(turnStartFailureCommands(harness.commands)).toHaveLength(1);

    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.recover();
      }),
    );
    expect(harness.startFreshSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("leaves a record that advanced concurrently to its owner and reports no start failure", async () => {
    let sessionReads = 0;
    const harness = makeHarness({
      getSession: () =>
        sessionReads++ === 0
          ? Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getBinding",
                detail: "Failed to read provider session binding",
              }),
            )
          : Effect.succeed(Option.some(sourceSession())),
      // The reporter reads `preparing` (call 2); another runner then moves the
      // record to `dispatching` before the reporter's compare-and-set.
      repositoryHooks: {
        afterGetById: (call, current) =>
          call === 2 && current
            ? { ...current, status: "dispatching", targetRuntimeSessionId }
            : current,
      },
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(turnStartEvent());
      }),
    );

    expect(harness.repository.get()).toMatchObject({ status: "dispatching", error: null });
    expect(turnStartFailureCommands(harness.commands)).toHaveLength(0);
    expect(handoffActivityPayloads(harness.commands)).toHaveLength(0);
    expect(harness.stopSessionBinding).not.toHaveBeenCalled();
    expect(harness.restoreSessionBinding).not.toHaveBeenCalled();
  });
});

describe("ContextHandoffCoordinator lane control", () => {
  const sessionSets = (commands: ReadonlyArray<OrchestrationCommand>) =>
    commands.flatMap((command) => (command.type === "thread.session.set" ? [command.session] : []));
  const terminalActivity = (commands: ReadonlyArray<OrchestrationCommand>) =>
    commands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "context-handoff" &&
        (command.activity.payload as { status?: string }).status === "failed",
    );
  const recordingControl = (
    deliveryOrder: string[],
    overrides: Partial<ContextHandoffLaneControl> = {},
  ): ContextHandoffLaneControl => ({
    guardStart: (effect) => effect,
    onDispatchStarted: Effect.sync(() => {
      deliveryOrder.push("dispatch-started");
    }),
    stopRequested: Effect.succeed(false),
    ...overrides,
  });

  it("announces dispatch once, after dispatching is persisted and before the turn is sent", async () => {
    const harness = makeHarness();
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(
          turnStartEvent(),
          recordingControl(harness.deliveryOrder),
        );
      }),
    );
    expect(harness.deliveryOrder).toEqual(["persist", "start", "dispatch-started", "send"]);
    expect(harness.repository.get()?.status).toBe("consumed");
  });

  it("does not announce dispatch when the target session fails to start", async () => {
    const harness = makeHarness({
      startFreshSessionFailure: new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "session/start",
        detail: "target unavailable",
      }),
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(
          turnStartEvent(),
          recordingControl(harness.deliveryOrder),
        );
      }),
    );
    expect(harness.deliveryOrder).not.toContain("dispatch-started");
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("recovery never announces dispatch", async () => {
    const harness = makeHarness({
      initialRecord: { ...requestedRecord(), status: "preparing" },
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.recover();
      }),
    );
    expect(harness.deliveryOrder).toEqual(["persist", "start", "send"]);
  });

  it("puts the source back stopped, never ready, when the user stopped the handoff turn", async () => {
    const harness = makeHarness({
      sendFailure: new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "session/prompt",
        detail: "session closed",
      }),
    });
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(
          turnStartEvent(),
          recordingControl(harness.deliveryOrder, { stopRequested: Effect.succeed(true) }),
        );
      }),
    );
    expect(harness.repository.get()).toMatchObject({
      status: "failed",
      error: "Stopped before the handoff turn was accepted.",
    });
    const finalSession = sessionSets(harness.commands).at(-1);
    expect(finalSession).toMatchObject({
      status: "stopped",
      providerInstanceId: sourceSelection.instanceId,
      runtimeSessionId: sourceRuntimeSessionId,
      lastError: null,
    });
    expect(
      sessionSets(harness.commands).some(
        (session) =>
          session.providerInstanceId === sourceSelection.instanceId && session.status === "ready",
      ),
    ).toBe(false);
    // The binding is restored for its resume cursor, then the source is stopped.
    expect(harness.deliveryOrder.slice(-2)).toEqual(["restore", "stop-session"]);
    const terminal = terminalActivity(harness.commands);
    expect(
      terminal?.type === "thread.activity.append"
        ? (terminal.activity.payload as { error?: string }).error
        : undefined,
    ).toBe("Stopped before the handoff turn was accepted.");
  });

  it("cancels the target start through the lane guard without sending the turn", async () => {
    const harness = makeHarness();
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(
          turnStartEvent(),
          recordingControl(harness.deliveryOrder, {
            guardStart: () =>
              Effect.fail(
                new ProviderSessionStartCancelledError({
                  threadId: "thread-handoff",
                  stopSequence: 9,
                  detail: "Stopped before the provider session started.",
                }),
              ),
          }),
        );
      }),
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.deliveryOrder).not.toContain("dispatch-started");
    expect(harness.repository.get()).toMatchObject({
      status: "failed",
      error: "Stopped before the handoff turn was accepted.",
    });
    expect(terminalActivity(harness.commands)).toBeDefined();
    expect(sessionSets(harness.commands).at(-1)).toMatchObject({
      status: "stopped",
      runtimeSessionId: sourceRuntimeSessionId,
    });
  });

  it("fails the dispatch without sending when a stop was noted before ownership", async () => {
    const harness = makeHarness();
    await harness.run(
      Effect.gen(function* () {
        const coordinator = yield* ContextHandoffCoordinator;
        yield* coordinator.processTurnStart(
          turnStartEvent(),
          recordingControl(harness.deliveryOrder, {
            onDispatchStarted: Effect.fail(
              new ProviderSessionStartCancelledError({
                threadId: "thread-handoff",
                stopSequence: 9,
                detail: "Stopped before the provider session started.",
              }),
            ),
          }),
        );
      }),
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.repository.get()).toMatchObject({
      status: "failed",
      error: "Stopped before the handoff turn was accepted.",
    });
    expect(sessionSets(harness.commands).at(-1)?.status).toBe("stopped");
  });
});

it("delivers with the default budget when manifest resolution defects", async () => {
  const harness = makeHarness({ manifestCurrent: Effect.die("unavailable") });
  await harness.run(
    Effect.gen(function* () {
      const coordinator = yield* ContextHandoffCoordinator;
      yield* coordinator.processTurnStart(turnStartEvent());
    }),
  );
  expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  expect(harness.preparedBudgets[0]).toEqual({
    maxInputChars: 120_000,
    budgetSource: "default",
    contextWindowTokens: null,
  });
});
