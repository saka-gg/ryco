import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSteerTurnInput,
  ProviderTurnSteerResult,
  ProviderTurnStartResult,
} from "@ryco/contracts";
import {
  ApprovalRequestId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { it, assert, vi } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Metric,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderOperationTimeoutError,
  ProviderOperationUnsupportedError,
  ProviderSessionNotFoundError,
  ProviderTurnNotSteerableError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderRollbackInput,
  ProviderThreadHistory,
} from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive, type ProviderServiceLiveOptions } from "./ProviderService.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { metricNames } from "../../observability/Metrics.ts";
import { hasMetricSnapshot } from "../../observability/testMetricSnapshots.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettingsService.layerTest();

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

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

function makeFakeCodexAdapter(
  provider: ProviderDriverKind = CODEX_DRIVER,
  options: {
    readonly startSessionEffect?: (
      input: ProviderSessionStartInput,
      makeSession: (input: ProviderSessionStartInput) => ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterError>;
    /** "none" omits the capability, which ProviderService treats as unsupported. */
    readonly conversationRollback?: "native" | "none";
    /** Defaults to native for Codex only. */
    readonly turnSteering?: "native" | "unsupported";
    readonly turnSubmission?: "acceptance" | "completion";
    /** Defaults to true for Codex only, as the real adapters declare. */
    readonly resumeSurvivesCwdChange?: boolean;
  } = {},
) {
  const turnSteering =
    options.turnSteering ?? (provider === CODEX_DRIVER ? "native" : "unsupported");
  const resumeSurvivesCwdChange = options.resumeSurvivesCwdChange ?? provider === CODEX_DRIVER;
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const makeSession = (input: ProviderSessionStartInput): ProviderSession => {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider,
      ...(input.providerInstanceId !== undefined
        ? { providerInstanceId: input.providerInstanceId }
        : {}),
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      ...(input.runtimeSessionId !== undefined ? { runtimeSessionId: input.runtimeSessionId } : {}),
      resumeCursor: input.resumeCursor ?? {
        opaque: `resume-${String(input.threadId)}`,
      },
      cwd: input.cwd ?? process.cwd(),
      createdAt: now,
      updatedAt: now,
    };
    sessions.set(session.threadId, session);
    return session;
  };

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    options.startSessionEffect
      ? options.startSessionEffect(input, makeSession)
      : Effect.sync(() => makeSession(input)),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      }).pipe(
        Effect.tap((turn) =>
          Effect.sync(() => {
            const session = sessions.get(input.threadId);
            if (session) {
              sessions.set(input.threadId, {
                ...session,
                status: "running",
                activeTurnId: turn.turnId,
              });
            }
          }),
        ),
      );
    },
  );

  const steerTurn = vi.fn(
    (input: ProviderSteerTurnInput): Effect.Effect<ProviderTurnSteerResult, ProviderAdapterError> =>
      Effect.succeed({ threadId: input.threadId, turnId: input.expectedTurnId }),
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn((threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.delete(threadId);
    }),
  );

  const listSessions = vi.fn((): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn((threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _input: ProviderRollbackInput,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const readThreadHistory = vi.fn(
    (_input: {
      readonly threadId: ThreadId;
      readonly resumeCursor: unknown;
      readonly cwd?: string;
    }): Effect.Effect<ProviderThreadHistory, ProviderAdapterError> =>
      Effect.succeed({ messages: [], items: [], completedTurnIds: [], failedTurnIds: [] }),
  );

  const stopAll = vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.clear();
    }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      turnSteering,
      ...(options.conversationRollback === "none"
        ? {}
        : { conversationRollback: "native" as const }),
      ...(options.turnSubmission ? { turnSubmission: options.turnSubmission } : {}),
      resumeSurvivesCwdChange,
    },
    startSession,
    sendTurn,
    ...(turnSteering === "native" ? { steerTurn } : {}),
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    readThreadHistory,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    const runtimeSessionId = sessions.get(event.threadId)?.runtimeSessionId;
    Effect.runSync(
      PubSub.publish(runtimeEventPubSub, {
        ...event,
        ...(runtimeSessionId !== undefined ? { runtimeSessionId } : {}),
      } as unknown as ProviderRuntimeEvent),
    );
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  const removeSession = (threadId: ThreadId): void => {
    sessions.delete(threadId);
  };

  return {
    adapter,
    emit,
    updateSession,
    removeSession,
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    readThreadHistory,
    rollbackThread,
    stopAll,
  };
}

function makeStandaloneProviderServiceLayer(
  adapters: ReadonlyArray<ReturnType<typeof makeFakeCodexAdapter>>,
  options?: ProviderServiceLiveOptions,
) {
  const registry = makeAdapterRegistryMock(
    Object.fromEntries(adapters.map((adapter) => [adapter.adapter.provider, adapter.adapter])),
  );
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  return Layer.mergeAll(
    makeProviderServiceLive(options).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    ),
    directoryLayer,
    runtimeRepositoryLayer,
  );
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER, { conversationRollback: "none" });
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistryShape = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive rejects provider starts beyond per-instance admission capacity",
  () =>
    Effect.gen(function* () {
      const firstStartEntered = yield* Deferred.make<void, never>();
      const releaseFirstStart = yield* Deferred.make<void, never>();
      const codex = makeFakeCodexAdapter(CODEX_DRIVER, {
        startSessionEffect: (input, makeSession) =>
          input.threadId === asThreadId("thread-admission-blocked")
            ? Effect.gen(function* () {
                yield* Deferred.succeed(firstStartEntered, undefined);
                yield* Deferred.await(releaseFirstStart);
                return makeSession(input);
              })
            : Effect.sync(() => makeSession(input)),
      });
      const registry = makeAdapterRegistryMock({
        [CODEX_DRIVER]: codex.adapter,
      });
      const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive({
        providerStartupAdmission: {
          maxConcurrentStartsPerInstance: 1,
          maxPendingStartsPerInstance: 1,
        },
      }).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const firstStartFiber = yield* provider
          .startSession(asThreadId("thread-admission-blocked"), {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId: asThreadId("thread-admission-blocked"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(firstStartEntered);

        const failure = yield* provider
          .startSession(asThreadId("thread-admission-rejected"), {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId: asThreadId("thread-admission-rejected"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.flip);

        assert.instanceOf(failure, ProviderValidationError);
        assert.include(failure.issue, "Provider startup admission is busy");
        assert.equal(codex.startSession.mock.calls.length, 1);

        yield* Deferred.succeed(releaseFirstStart, undefined);
        const firstSession = yield* Fiber.join(firstStartFiber);
        assert.equal(firstSession.threadId, asThreadId("thread-admission-blocked"));

        const snapshots = yield* Metric.snapshot;
        assert.equal(
          hasMetricSnapshot(snapshots, metricNames.providerStartupAdmissionTotal, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            outcome: "busy",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, metricNames.providerStartupQueueHighWater, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
          }),
          true,
        );
      }).pipe(Effect.scoped, Effect.provide(providerLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistryShape = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
      const serverSettingsLayer = ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistryShape = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
      yield* sleep(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        runtimeSessionId: RuntimeSessionId.make("runtime-canonical-thread-segment"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: new Date().toISOString(),
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* sleep(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-service-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-service-restart-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
          targetTurnId: asTurnId("turn-kept"),
          droppedTurnIds: [asTurnId("turn-dropped")],
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.deepEqual(rollbackCall?.[1], {
        numTurns: 1,
        targetTurnId: asTurnId("turn-kept"),
        droppedTurnIds: [asTurnId("turn-dropped")],
      });

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      const fileAttachment = {
        type: "file" as const,
        id: "thread-1-file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      };
      const turnWithFile = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "review this",
        attachments: [fileAttachment],
      });
      assert.equal(turnWithFile.turnId, TurnId.make("turn-thread-1"));
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      assert.deepEqual(routing.codex.sendTurn.mock.calls[0]?.[0].attachments, [fileAttachment]);

      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 2);

      yield* provider.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        messageId: MessageId.make("message-steer-1"),
        input: "Use this additional constraint",
        attachments: [],
      });
      assert.equal(routing.codex.steerTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
        targetTurnId: null,
        droppedTurnIds: [],
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
        targetTurnId: null,
        droppedTurnIds: [asTurnId("turn-1")],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.deepEqual(rollbackCall?.[1], {
        numTurns: 1,
        targetTurnId: null,
        droppedTurnIds: [asTurnId("turn-1")],
      });
    }),
  );

  it.effect("refuses rollback for providers without native rollback before any recovery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-rollback-unsupported");
      yield* provider.startSession(threadId, {
        provider: CURSOR_DRIVER,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.cursor.stopSession(threadId);
      routing.cursor.startSession.mockClear();
      routing.cursor.rollbackThread.mockClear();

      const exit = yield* Effect.exit(
        provider.rollbackConversation({
          threadId,
          numTurns: 1,
          targetTurnId: null,
          droppedTurnIds: [asTurnId("turn-1")],
        }),
      );

      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
      assert.instanceOf(error, ProviderOperationUnsupportedError);
      assert.include(
        (error as ProviderOperationUnsupportedError).message,
        "can't remove turns from its conversation, so this thread can't be reverted.",
      );
      assert.equal(routing.cursor.startSession.mock.calls.length, 0);
      assert.equal(routing.cursor.rollbackThread.mock.calls.length, 0);
    }),
  );

  it.effect("persists the adapter's post-rollback resume cursor", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-rollback-cursor");
      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const rewoundCursor = { resume: "session-1", rewind: { at: "assistant-1" } };
      routing.codex.rollbackThread.mockImplementationOnce((rolledBackThreadId) =>
        Effect.sync(() => {
          routing.codex.updateSession(rolledBackThreadId, (existing) => ({
            ...existing,
            resumeCursor: rewoundCursor,
          }));
          return { threadId: rolledBackThreadId, turns: [] as const };
        }),
      );

      yield* provider.rollbackConversation({
        threadId,
        numTurns: 1,
        targetTurnId: asTurnId("turn-1"),
        droppedTurnIds: [asTurnId("turn-2")],
      });

      const persisted = yield* runtimeRepository.getByThreadId({ threadId });
      assert.isTrue(Option.isSome(persisted));
      if (Option.isSome(persisted)) {
        assert.deepEqual(persisted.value.resumeCursor, rewoundCursor);
      }
    }),
  );

  it.effect("serializes a recovering sendTurn behind an in-flight rollback", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-rollback-lock");
      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const sent = yield* Deferred.make<void>();
      routing.codex.rollbackThread.mockImplementationOnce((rolledBackThreadId) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return { threadId: rolledBackThreadId, turns: [] as const };
        }),
      );

      const rollingBack = yield* provider
        .rollbackConversation({
          threadId,
          numTurns: 1,
          targetTurnId: null,
          droppedTurnIds: [asTurnId("turn-1")],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // The runtime dies mid-rollback; the next send must recover only after it.
      routing.codex.removeSession(threadId);
      const sending = yield* provider.sendTurn({ threadId, input: "after rollback" }).pipe(
        Effect.tap(() => Deferred.succeed(sent, undefined)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(sent));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(rollingBack);
      yield* Fiber.join(sending);
      assert.isTrue(yield* Deferred.isDone(sent));
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("reads a stopped thread's resume target without starting a runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-resume-target");
      assert.deepEqual(yield* provider.readResumeTarget!(threadId), Option.none());

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-resume-target",
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();

      assert.deepEqual(
        yield* provider.readResumeTarget!(threadId),
        Option.some({
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project-resume-target",
          hasResumeCursor: true,
        }),
      );
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
    }),
  );

  // "Turn into project…" moves the chat folder away; until the next start the stopped binding
  // still records it, and a stored read spawned there failed on every reconcile.
  it.effect("reads a moved thread's stored history where it runs now, keeping its record", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const chatFolder = "/tmp/chats/2026-10-08-plan-history";
      const projectFolder = "/tmp/code/plan-history";
      const startStopped = (
        threadId: ThreadId,
        driver: ProviderDriverKind,
        providerInstanceId: ProviderInstanceId,
      ) =>
        provider
          .startSession(threadId, {
            provider: driver,
            providerInstanceId,
            threadId,
            cwd: chatFolder,
            runtimeMode: "full-access",
          })
          .pipe(Effect.andThen(provider.stopSession({ threadId })));

      // Codex resumes after a move, so its history is read where the next start resumes it.
      const codexThread = asThreadId("thread-history-moved-codex");
      yield* startStopped(codexThread, CODEX_DRIVER, codexInstanceId);
      routing.codex.readThreadHistory.mockClear();
      assert.equal(
        Option.isSome(yield* provider.readThreadHistory!(codexThread, { cwd: projectFolder })),
        true,
      );
      assert.equal(routing.codex.readThreadHistory.mock.calls[0]?.[0].cwd, projectFolder);
      yield* provider.readThreadHistory!(codexThread);
      assert.equal(routing.codex.readThreadHistory.mock.calls[1]?.[0].cwd, chatFolder);
      // The record is untouched, so the next turn still detects the move.
      assert.deepEqual(Option.getOrUndefined(yield* provider.readResumeTarget!(codexThread)), {
        providerInstanceId: codexInstanceId,
        cwd: chatFolder,
        hasResumeCursor: true,
      });

      // A conversation that does not survive a move still lives in the recorded folder.
      const claudeThread = asThreadId("thread-history-moved-claude");
      yield* startStopped(claudeThread, CLAUDE_AGENT_DRIVER, claudeAgentInstanceId);
      // Later routing tests count the shared Claude adapter's starts from zero.
      routing.claude.startSession.mockClear();
      routing.claude.stopSession.mockClear();
      routing.claude.readThreadHistory.mockClear();
      yield* provider.readThreadHistory!(claudeThread, { cwd: projectFolder });
      assert.equal(routing.claude.readThreadHistory.mock.calls[0]?.[0].cwd, chatFolder);
    }),
  );

  // A rewind marker the adapter cleared on a completed turn must not survive in
  // the binding: recovery would truncate the conversation at the old rewind point.
  const rewoundCursor = { resume: "session-rewound", rewind: { at: "assistant-1" }, turnCount: 1 };
  const settledCursor = { resume: "session-rewound", resumeSessionAt: "assistant-2", turnCount: 2 };

  it.effect("persists the live resume cursor when a turn completes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-cursor-after-turn");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-cursor",
        runtimeMode: "full-access",
        resumeCursor: rewoundCursor,
      });
      yield* provider.sendTurn({ threadId, input: "after the revert", attachments: [] });
      routing.codex.updateSession(threadId, (existing) => ({
        ...existing,
        status: "ready",
        activeTurnId: undefined,
        resumeCursor: settledCursor,
      }));

      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-cursor-after-turn"),
        provider: CODEX_DRIVER,
        createdAt: new Date().toISOString(),
        threadId,
        turnId: asTurnId(`turn-${threadId}`),
        payload: { state: "completed" },
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const persisted = yield* runtimeRepository.getByThreadId({ threadId });
        if (
          Option.isSome(persisted) &&
          JSON.stringify(persisted.value.resumeCursor) === JSON.stringify(settledCursor)
        ) {
          break;
        }
        yield* sleep(5);
      }

      // The runtime dies without a graceful stop; recovery must use the settled cursor.
      routing.codex.removeSession(threadId);
      routing.codex.startSession.mockClear();
      yield* provider.sendTurn({ threadId, input: "after a crash", attachments: [] });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.deepEqual(routing.codex.startSession.mock.calls[0]?.[0].resumeCursor, settledCursor);
    }),
  );

  it.effect("persists the live resume cursor when a session is stopped", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-cursor-on-stop");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-cursor",
        runtimeMode: "full-access",
        resumeCursor: rewoundCursor,
      });
      routing.codex.updateSession(threadId, (existing) => ({
        ...existing,
        resumeCursor: settledCursor,
      }));

      yield* provider.stopSession({ threadId });

      const persisted = yield* runtimeRepository.getByThreadId({ threadId });
      assert.isTrue(Option.isSome(persisted));
      if (Option.isSome(persisted)) {
        assert.equal(persisted.value.status, "stopped");
        assert.deepEqual(persisted.value.resumeCursor, settledCursor);
      }
    }),
  );

  it.effect("reports a rollback as done when only the binding write after it fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-rollback-binding-write");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      routing.codex.rollbackThread.mockImplementationOnce((rolledBackThreadId) =>
        Effect.sync(() => {
          // The adapter has already forgotten the turns when the bookkeeping fails.
          routing.codex.listSessions.mockImplementationOnce(() =>
            Effect.die(new Error("session listing failed")),
          );
          return { threadId: rolledBackThreadId, turns: [] as const };
        }),
      );

      const exit = yield* Effect.exit(
        provider.rollbackConversation({
          threadId,
          numTurns: 1,
          targetTurnId: asTurnId("turn-1"),
          droppedTurnIds: [asTurnId("turn-2")],
        }),
      );

      assert.isTrue(Exit.isSuccess(exit));
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("filters an active session that conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.isSuccess(exit), true);
      if (Exit.isSuccess(exit)) {
        assert.equal(
          exit.value.some((session) => session.threadId === threadId),
          false,
        );
      }
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("does not recover a lost runtime to answer a pending question", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("question-lost-runtime"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("question-lost-runtime"),
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.respondToUserInput.mockClear();
      const result = yield* Effect.result(
        provider.respondToUserInput({
          threadId: session.threadId,
          requestId: asRequestId("expired-question"),
          answers: { answer: "Yes" },
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.respondToUserInput.mock.calls.length, 0);
    }),
  );

  it.effect("rejects an old question identity while a replacement runtime is active", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("question-replacement"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("question-replacement"),
        runtimeMode: "full-access",
      });
      routing.codex.respondToUserInput.mockClear();
      const result = yield* Effect.result(
        provider.respondToUserInput({
          threadId: session.threadId,
          requestId: asRequestId("reused-question"),
          expectedRuntimeSessionId: RuntimeSessionId.make("old-runtime"),
          answers: { answer: "Old" },
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(routing.codex.respondToUserInput.mock.calls.length, 0);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-service-start-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-service-cwd-"));
        const dbPath = path.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        fs.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* sleep(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* sleep(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* sleep(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* sleep(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
        targetTurnId: null,
        droppedTurnIds: [asTurnId("turn-1")],
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.providerTurnsTotal, {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.providerTurnsTotal, {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.providerTurnsTotal, {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.providerTurnsTotal, {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, metricNames.providerSessionsTotal, {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, metricNames.providerTurnsTotal, {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, metricNames.providerTurnDuration, {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );

  it.effect("starts a fresh epoch without explicit or persisted resume state", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-fresh-no-resume");

      const source = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { opaque: "must-not-leak" },
      });
      const targetRuntimeSessionId = RuntimeSessionId.make("runtime-fresh-no-resume");
      fanout.codex.startSession.mockClear();

      const fresh = yield* provider.startFreshSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
        runtimeSessionId: targetRuntimeSessionId,
      });

      assert.equal(fresh.previousBinding?.runtimeSessionId, source.runtimeSessionId);
      assert.equal(fresh.session.runtimeSessionId, targetRuntimeSessionId);
      const startInput = fanout.codex.startSession.mock.calls[0]?.[0];
      assert.equal(startInput?.resumePolicy, "fresh");
      assert.equal(startInput?.resumeCursor, undefined);
    }),
  );

  it.effect("routes only the authoritative epoch while source and target coexist", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-duplicate-epoch-routing");
      const source = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      fanout.codex.stopSession.mockClear();
      fanout.codex.sendTurn.mockClear();
      fanout.claude.sendTurn.mockClear();

      const target = yield* provider.startFreshSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
        runtimeSessionId: RuntimeSessionId.make("runtime-duplicate-target"),
      });

      assert.equal(target.previousBinding?.runtimeSessionId, source.runtimeSessionId);
      assert.equal(fanout.codex.stopSession.mock.calls.length, 0);
      const current = yield* provider.getSession(threadId);
      assert.equal(Option.isSome(current), true);
      if (Option.isSome(current)) {
        assert.equal(current.value.provider, CLAUDE_AGENT_DRIVER);
        assert.equal(current.value.runtimeSessionId, target.session.runtimeSessionId);
      }

      yield* provider.sendTurn({ threadId, input: "target turn", attachments: [] });
      assert.equal(fanout.claude.sendTurn.mock.calls.length, 1);
      assert.equal(fanout.codex.sendTurn.mock.calls.length, 0);
    }),
  );

  it.effect("restores only a still-live exact source binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-exact-binding-rollback");
      const source = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const target = yield* provider.startFreshSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
        runtimeSessionId: RuntimeSessionId.make("runtime-rollback-target"),
      });
      assert.equal(target.previousBinding?.runtimeSessionId, source.runtimeSessionId);
      assert.equal(target.previousBinding !== undefined, true);
      if (!target.previousBinding) {
        return;
      }

      assert.equal(yield* provider.restoreSessionBinding(target.previousBinding), true);
      const restored = yield* provider.getSession(threadId);
      assert.equal(Option.isSome(restored), true);
      if (Option.isSome(restored)) {
        assert.equal(restored.value.provider, CODEX_DRIVER);
        assert.equal(restored.value.runtimeSessionId, source.runtimeSessionId);
      }

      yield* provider.stopSessionBinding(target.previousBinding);
      assert.equal(yield* provider.restoreSessionBinding(target.previousBinding), false);
    }),
  );

  it.effect("retires a failed same-instance target and puts back the binding it replaced", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-retire-failed-target");
      const sourceResumeCursor = { opaque: "source-resume" };
      const chatFolder = "/tmp/chats/2026-10-08-plan-0a1b2c3d";
      const source = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: chatFolder,
        runtimeMode: "full-access",
        resumeCursor: sourceResumeCursor,
      });
      // A relocation handoff: a fresh session on the same instance in the moved folder.
      const target = yield* provider.startFreshSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/code/plan",
        runtimeMode: "full-access",
        runtimeSessionId: RuntimeSessionId.make("runtime-failed-same-instance-target"),
      });
      assert.equal(target.previousBinding?.runtimeSessionId, source.runtimeSessionId);
      if (!target.previousBinding || !target.session.runtimeSessionId) {
        return;
      }
      const targetBinding = {
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        runtimeSessionId: target.session.runtimeSessionId,
        runtimeMode: "full-access" as const,
      };

      assert.equal(yield* provider.stopSessionBinding(targetBinding), "stopped");
      // The fresh start stopped the source runtime, so it cannot be restored as a live one.
      assert.equal(yield* provider.restoreSessionBinding(target.previousBinding), false);
      assert.equal(yield* provider.retireSessionBinding(targetBinding), true);

      // The source conversation is resumable again, from the folder it ran in, so a retry
      // detects the move again; its runtime is not revived.
      const restored = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(restored?.runtimeSessionId, source.runtimeSessionId);
      assert.equal(restored?.status, "stopped");
      assert.deepEqual(restored?.resumeCursor, sourceResumeCursor);
      assert.equal(Option.isNone(yield* provider.getSession(threadId)), true);
      assert.deepEqual(Option.getOrUndefined(yield* provider.readResumeTarget!(threadId)), {
        providerInstanceId: codexInstanceId,
        cwd: chatFolder,
        hasResumeCursor: true,
      });

      fanout.codex.startSession.mockClear();
      const restartedSource = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      // The target's resume state never leaks; the source's resumes.
      assert.deepEqual(
        fanout.codex.startSession.mock.calls[0]?.[0].resumeCursor,
        sourceResumeCursor,
      );
      assert.notEqual(restartedSource.runtimeSessionId, target.session.runtimeSessionId);

      assert.equal(yield* provider.retireSessionBinding(targetBinding), false);
      const current = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(current?.runtimeSessionId, restartedSource.runtimeSessionId);
    }),
  );

  it.effect("retires a failed target on another instance without leaking its resume state", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-retire-failed-cross-instance-target");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const target = yield* provider.startFreshSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
        runtimeSessionId: RuntimeSessionId.make("runtime-failed-cross-instance-target"),
      });
      const targetBinding = {
        threadId,
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        runtimeSessionId: target.session.runtimeSessionId!,
        runtimeMode: "full-access" as const,
      };
      assert.equal(yield* provider.stopSessionBinding(targetBinding), "stopped");
      assert.equal(yield* provider.retireSessionBinding(targetBinding), true);

      const retired = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(retired?.runtimeSessionId, target.session.runtimeSessionId);
      assert.equal(retired?.status, "stopped");
      assert.equal(retired?.resumeCursor, null);
      assert.equal(retired?.runtimePayload, null);
    }),
  );
});

it.live("ProviderServiceLive fails a same-instance fresh replacement when stop times out", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const providerLayer = makeStandaloneProviderServiceLayer([codex], {
      staleSessionStopTimeoutMs: 10,
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-same-instance-timeout");
      const source = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      codex.stopSession.mockImplementation(() => Effect.never);

      const failure = yield* Effect.flip(
        provider.startFreshSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
          runtimeSessionId: RuntimeSessionId.make("runtime-same-instance-target"),
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "did not stop within 10ms");
      assert.equal(codex.startSession.mock.calls.length, 1);
      const current = yield* provider.getSession(threadId);
      assert.equal(Option.isSome(current), true);
      if (Option.isSome(current)) {
        assert.equal(current.value.runtimeSessionId, source.runtimeSessionId);
      }
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("ProviderServiceLive puts back what an abandoned same-instance fresh start replaced", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const codex = makeFakeCodexAdapter(CODEX_DRIVER, {
      startSessionEffect: (input, makeSession) =>
        input.resumePolicy === "fresh"
          ? Deferred.await(gate).pipe(Effect.as(makeSession(input)))
          : Effect.sync(() => makeSession(input)),
    });
    const providerLayer = makeStandaloneProviderServiceLayer([codex]);

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-abandoned-fresh-start");
      const sourceResumeCursor = { opaque: "source-resume" };
      const source = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/chats/2026-10-08-plan-0a1b2c3d",
        runtimeMode: "full-access",
        resumeCursor: sourceResumeCursor,
      });
      // The user stops the thread while the fresh session is still starting.
      const starting = yield* Effect.forkChild(
        provider.startFreshSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/code/plan",
          runtimeMode: "full-access",
          runtimeSessionId: RuntimeSessionId.make("runtime-abandoned-fresh-target"),
        }),
      );
      yield* sleep(20);
      yield* Fiber.interrupt(starting);
      const stopsBefore = codex.stopSession.mock.calls.length;
      yield* Deferred.succeed(gate, undefined);

      // The start completes after nobody waits for it, and is undone: its runtime is stopped.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (codex.stopSession.mock.calls.length > stopsBefore) break;
        yield* sleep(10);
      }
      assert.isAbove(codex.stopSession.mock.calls.length, stopsBefore);
      let restored = Option.getOrUndefined(yield* directory.getBinding(threadId));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (restored?.runtimeSessionId === source.runtimeSessionId) break;
        yield* sleep(10);
        restored = Option.getOrUndefined(yield* directory.getBinding(threadId));
      }
      assert.equal(restored?.runtimeSessionId, source.runtimeSessionId);
      assert.equal(restored?.status, "stopped");
      assert.deepEqual(restored?.resumeCursor, sourceResumeCursor);
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("ProviderServiceLive queues and retries bounded stale binding cleanup", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const providerLayer = makeStandaloneProviderServiceLayer([codex, claude], {
      staleSessionStopTimeoutMs: 10,
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-stale-cleanup-retry");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const target = yield* provider.startFreshSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
        runtimeSessionId: RuntimeSessionId.make("runtime-stale-cleanup-target"),
      });
      assert.equal(target.previousBinding !== undefined, true);
      if (!target.previousBinding) {
        return;
      }

      codex.stopSession.mockImplementation(() => Effect.never);
      assert.equal(yield* provider.stopSessionBinding(target.previousBinding), "timed-out");
      assert.deepEqual(yield* provider.listStaleSessionBindings(), [target.previousBinding]);
      assert.equal(
        hasMetricSnapshot(yield* Metric.snapshot, metricNames.providerStaleStopTimeoutsTotal, {
          provider: CODEX_DRIVER,
        }),
        true,
      );

      codex.stopSession.mockImplementation((staleThreadId) =>
        Effect.sync(() => codex.removeSession(staleThreadId)),
      );
      assert.equal(yield* provider.stopSessionBinding(target.previousBinding), "stopped");
      assert.deepEqual(yield* provider.listStaleSessionBindings(), []);
      const current = yield* provider.getSession(threadId);
      assert.equal(Option.isSome(current), true);
      if (Option.isSome(current)) {
        assert.equal(current.value.runtimeSessionId, target.session.runtimeSessionId);
      }
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("rejects an adapter session that reports a different runtime epoch", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            runtimeSessionId: RuntimeSessionId.make("runtime-adapter-mismatch"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-adapter-runtime-mismatch"), {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId: asThreadId("thread-adapter-runtime-mismatch"),
          runtimeMode: "full-access",
          runtimeSessionId: RuntimeSessionId.make("runtime-requested"),
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Adapter runtime mismatch");
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: ProviderDriverKind.make("codex"),
            ...(input.runtimeSessionId !== undefined
              ? { runtimeSessionId: input.runtimeSessionId }
              : {}),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

it.effect("goal operations distinguish unsupported providers from inactive sessions", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("goal-inactive-session");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(yield* provider.clearThreadGoal!(threadId), false);
      codex.removeSession(threadId);
      const failure = yield* Effect.flip(provider.clearThreadGoal!(threadId));
      assert.equal(failure._tag, "ProviderSessionNotFoundError");
    }).pipe(Effect.provide(makeStandaloneProviderServiceLayer([codex])));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects stale background stop identity before routing and forwards the displayed attempt",
  () => {
    const fake = makeFakeCodexAdapter();
    const stop = vi.fn((_threadId: ThreadId, _taskId: string, _expected?: unknown) => Effect.void);
    const providerLayer = makeStandaloneProviderServiceLayer([
      { ...fake, adapter: { ...fake.adapter, stopBackgroundTask: stop } },
    ]);
    return Effect.gen(function* () {
      const service = yield* ProviderService;
      const threadId = asThreadId("background-stop-identity");
      const session = yield* service.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const stale = yield* service
        .stopBackgroundTask({
          threadId,
          taskId: "reused-task",
          expected: { runtimeSessionId: RuntimeSessionId.make("replaced-runtime"), attempt: 0 },
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stale));
      assert.lengthOf(stop.mock.calls, 0);
      const expected = { runtimeSessionId: session.runtimeSessionId!, attempt: 3 };
      yield* service.stopBackgroundTask({ threadId, taskId: "reused-task", expected });
      assert.deepEqual(stop.mock.calls, [[threadId, "reused-task", expected]]);
      // Existing API clients retain their previous behavior.
      yield* service.stopBackgroundTask({ threadId, taskId: "legacy-task" });
      assert.equal(stop.mock.calls[1]?.[1], "legacy-task");
    }).pipe(Effect.provide(providerLayer.pipe(Layer.provideMerge(NodeServices.layer))));
  },
);

it.live("ProviderServiceLive routes steering to a Claude-shaped adapter and defers refusals", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER, { turnSteering: "native" });
    const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
    const providerLayer = makeStandaloneProviderServiceLayer([codex, claude, cursor]);

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const claudeThread = asThreadId("thread-claude-steer");
      yield* provider.startSession(claudeThread, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId: claudeThread,
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: claudeThread,
        input: "work",
        attachments: [],
      });
      const steered = yield* provider.steerTurn({
        threadId: claudeThread,
        expectedTurnId: turn.turnId,
        messageId: MessageId.make("message-claude-steer"),
        input: "also this",
        attachments: [],
      });
      assert.equal(steered.turnId, turn.turnId);
      assert.equal(claude.steerTurn.mock.calls.length, 1);

      const mismatch = yield* Effect.flip(
        provider.steerTurn({
          threadId: claudeThread,
          expectedTurnId: TurnId.make("turn-ended-earlier"),
          messageId: MessageId.make("message-claude-late"),
          input: "late",
          attachments: [],
        }),
      );
      assert.isTrue(Schema.is(ProviderTurnNotSteerableError)(mismatch));
      if (Schema.is(ProviderTurnNotSteerableError)(mismatch)) {
        assert.equal(mismatch.reason, "turn-ended");
        assert.include(mismatch.detail, "stays queued");
      }
      assert.equal(claude.steerTurn.mock.calls.length, 1);

      const cursorThread = asThreadId("thread-cursor-steer");
      yield* provider.startSession(cursorThread, {
        provider: CURSOR_DRIVER,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId: cursorThread,
        runtimeMode: "full-access",
      });
      const cursorTurn = yield* provider.sendTurn({
        threadId: cursorThread,
        input: "work",
        attachments: [],
      });
      const unsupported = yield* Effect.flip(
        provider.steerTurn({
          threadId: cursorThread,
          expectedTurnId: cursorTurn.turnId,
          messageId: MessageId.make("message-cursor-steer"),
          input: "also this",
          attachments: [],
        }),
      );
      assert.isTrue(Schema.is(ProviderTurnNotSteerableError)(unsupported));
      if (Schema.is(ProviderTurnNotSteerableError)(unsupported)) {
        assert.equal(unsupported.reason, "unsupported");
        assert.equal(
          unsupported.detail,
          "Cursor can't steer a running turn. The message stays queued.",
        );
      }

      claude.removeSession(claudeThread);
      const inactive = yield* Effect.flip(
        provider.steerTurn({
          threadId: claudeThread,
          expectedTurnId: turn.turnId,
          messageId: MessageId.make("message-claude-gone"),
          input: "gone",
          attachments: [],
        }),
      );
      assert.isTrue(Schema.is(ProviderSessionNotFoundError)(inactive));
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("provider operation deadlines", () => {
  const timeouts = {
    sessionStartMs: 1_000,
    turnAcceptanceMs: 500,
    controlRequestMs: 300,
  } as const;
  const startInput = (threadId: ThreadId) => ({
    provider: CODEX_DRIVER,
    providerInstanceId: codexInstanceId,
    threadId,
    runtimeMode: "full-access" as const,
  });
  const withService = <A, E>(
    adapters: ReadonlyArray<ReturnType<typeof makeFakeCodexAdapter>>,
    body: Effect.Effect<A, E, ProviderService | ProviderSessionDirectory>,
    options?: ProviderServiceLiveOptions,
  ) =>
    body.pipe(
      Effect.provide(
        makeStandaloneProviderServiceLayer(adapters, {
          operationTimeouts: timeouts,
          ...options,
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  /** Polls until ProviderService processed the runtime event (it crosses a real async boundary). */
  const eventProcessed = (threadId: ThreadId, eventId: EventId) =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const events = yield* provider.readRecentEventSummaries!({
          since: "1970-01-01T00:00:00.000Z",
          threadId,
          limit: 50,
        });
        if (events.some((event) => event.eventId === eventId)) return true;
        yield* sleep(1);
      }
      return false;
    });
  /** Emits probe events until one is processed: the adapter's event subscription is live. */
  const awaitEventSubscription = (
    codex: ReturnType<typeof makeFakeCodexAdapter>,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const eventId = asEventId(`subscription-probe-${attempt}`);
        codex.emit({
          type: "content.delta",
          eventId,
          provider: CODEX_DRIVER,
          createdAt: new Date().toISOString(),
          threadId,
          turnId: "subscription-probe",
          payload: { streamKind: "assistant_text", delta: "" },
        });
        if (yield* eventProcessed(threadId, eventId)) return;
      }
      assert.fail("the adapter event subscription never delivered a probe event");
    });
  const expectTimeout = (
    error: unknown,
    operation: ProviderOperationTimeoutError["operation"],
  ): ProviderOperationTimeoutError => {
    assert.instanceOf(error, ProviderOperationTimeoutError);
    const timeout = error as ProviderOperationTimeoutError;
    assert.equal(timeout.operation, operation);
    return timeout;
  };

  it.effect("fails a session start that never finishes at the start deadline", () => {
    const codex = makeFakeCodexAdapter(CODEX_DRIVER, {
      startSessionEffect: () => Effect.never,
    });
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const starting = yield* provider
          .startSession(asThreadId("start-never"), startInput(asThreadId("start-never")))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.sessionStartMs));
        const error = expectTimeout(yield* Fiber.join(starting).pipe(Effect.flip), "session.start");
        assert.equal(
          error.detail,
          "Provider 'codex' did not finish starting within 1s. Ryco stopped waiting; send the message again to retry.",
        );
      }),
    );
  });

  it.effect(
    "bounds a start that cannot be interrupted and fails the next start for that thread at its own deadline",
    () => {
      const release = Effect.runSync(Deferred.make<void>());
      const codex = makeFakeCodexAdapter(CODEX_DRIVER, {
        startSessionEffect: (input, makeSession) =>
          input.threadId === asThreadId("zombie-start")
            ? Effect.uninterruptible(Deferred.await(release)).pipe(Effect.as(makeSession(input)))
            : Effect.sync(() => makeSession(input)),
      });
      return withService(
        [codex],
        Effect.gen(function* () {
          const provider = yield* ProviderService;
          const threadId = asThreadId("zombie-start");
          const first = yield* provider
            .startSession(threadId, startInput(threadId))
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(timeouts.sessionStartMs));
          expectTimeout(yield* Fiber.join(first).pipe(Effect.flip), "session.start");

          const second = yield* provider
            .startSession(threadId, startInput(threadId))
            .pipe(Effect.forkChild({ startImmediately: true }));
          // Another thread is not held behind the zombie start.
          const other = yield* provider.startSession(
            asThreadId("other-thread"),
            startInput(asThreadId("other-thread")),
          );
          assert.equal(other.threadId, asThreadId("other-thread"));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(timeouts.sessionStartMs));
          const blocked = expectTimeout(
            yield* Fiber.join(second).pipe(Effect.flip),
            "session.start",
          );
          assert.include(blocked.detail, "a previous start for this thread is still shutting down");
          assert.equal(codex.startSession.mock.calls.length, 2);
          yield* Deferred.succeed(release, undefined);
        }),
      );
    },
  );

  it.effect("stops a runtime whose start finished after the caller stopped waiting", () => {
    const release = Effect.runSync(Deferred.make<void>());
    const codex = makeFakeCodexAdapter(CODEX_DRIVER, {
      startSessionEffect: (input, makeSession) =>
        input.runtimeSessionId === RuntimeSessionId.make("late-runtime")
          ? Effect.uninterruptible(
              Effect.sync(() => makeSession(input)).pipe(Effect.tap(() => Deferred.await(release))),
            )
          : Effect.sync(() => makeSession(input)),
    });
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("late-start");
        const original = yield* provider.startSession(threadId, startInput(threadId));
        const restarting = yield* provider
          .startSession(threadId, {
            ...startInput(threadId),
            runtimeSessionId: RuntimeSessionId.make("late-runtime"),
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.sessionStartMs));
        expectTimeout(yield* Fiber.join(restarting).pipe(Effect.flip), "session.start");
        yield* Deferred.succeed(release, undefined);
        // The abandoned start finishes in the background and stops its own runtime.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (codex.stopSession.mock.calls.length >= 2) break;
          yield* Effect.yieldNow;
        }
        assert.isTrue(Option.isNone(yield* provider.getSession(threadId)));
        assert.deepEqual(yield* codex.listSessions(), []);
        const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
        assert.equal(binding.status, "stopped");
        assert.equal(binding.runtimeSessionId, original.runtimeSessionId);
        // The replaced runtime keeps its resume cursor for the next start.
        assert.deepEqual(binding.resumeCursor, original.resumeCursor);
      }),
    );
  });

  it.effect("interrupts only a live runtime and never recovers one to interrupt it", () => {
    const codex = makeFakeCodexAdapter();
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("interrupt-no-recovery");
        yield* provider.startSession(threadId, startInput(threadId));
        codex.removeSession(threadId);
        codex.startSession.mockClear();
        const error = yield* provider.interruptTurn({ threadId }).pipe(Effect.flip);
        assert.instanceOf(error, ProviderSessionNotFoundError);
        assert.equal(codex.startSession.mock.calls.length, 0);
        assert.equal(codex.interruptTurn.mock.calls.length, 0);
        const unbound = yield* provider
          .interruptTurn({ threadId: asThreadId("never-bound") })
          .pipe(Effect.flip);
        assert.instanceOf(unbound, ProviderSessionNotFoundError);
      }),
    );
  });

  it.effect("fails an interrupt the provider never answers at the control deadline", () => {
    const codex = makeFakeCodexAdapter();
    codex.interruptTurn.mockImplementation(() => Effect.never);
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("interrupt-never");
        yield* provider.startSession(threadId, startInput(threadId));
        const interrupting = yield* provider
          .interruptTurn({ threadId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.controlRequestMs));
        expectTimeout(yield* Fiber.join(interrupting).pipe(Effect.flip), "turn.interrupt");
      }),
    );
  });

  it.effect(
    "fails a stop the provider never confirms, keeps retrying it and marks the binding stopped",
    () => {
      const codex = makeFakeCodexAdapter();
      return withService(
        [codex],
        Effect.gen(function* () {
          const provider = yield* ProviderService;
          const directory = yield* ProviderSessionDirectory;
          const threadId = asThreadId("stop-never");
          const session = yield* provider.startSession(threadId, startInput(threadId));
          codex.stopSession.mockImplementation(() => Effect.never);
          const stopping = yield* provider
            .stopSession({ threadId })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(timeouts.controlRequestMs));
          expectTimeout(yield* Fiber.join(stopping).pipe(Effect.flip), "session.stop");
          const stale = yield* provider.listStaleSessionBindings();
          assert.deepEqual(
            stale.map((binding) => [binding.threadId, binding.runtimeSessionId]),
            [[threadId, session.runtimeSessionId]],
          );
          assert.equal(Option.getOrThrow(yield* directory.getBinding(threadId)).status, "stopped");
        }),
      );
    },
  );

  it.effect("keeps retrying a stop the provider rejected, not only one that timed out", () => {
    const codex = makeFakeCodexAdapter();
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("stop-rejected");
        const session = yield* provider.startSession(threadId, startInput(threadId));
        codex.stopSession.mockImplementationOnce(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: CODEX_DRIVER,
              method: "session/stop",
              detail: "stop rejected",
            }),
          ),
        );
        const error = yield* provider.stopSession({ threadId }).pipe(Effect.flip);
        assert.instanceOf(error, ProviderAdapterRequestError);
        // The binding is stopped, so the idle sweep skips it; the stale retry does not.
        assert.equal(Option.getOrThrow(yield* directory.getBinding(threadId)).status, "stopped");
        const stale = yield* provider.listStaleSessionBindings();
        assert.deepEqual(
          stale.map((binding) => [binding.threadId, binding.runtimeSessionId]),
          [[threadId, session.runtimeSessionId]],
        );
        // The retry stops the exact runtime that is still live, then forgets it.
        assert.equal(yield* provider.stopSessionBinding(stale[0]!), "stopped");
        assert.deepEqual(yield* codex.listSessions(), []);
        assert.deepEqual(yield* provider.listStaleSessionBindings(), []);
      }),
    );
  });

  it.effect(
    "stops the new runtime when a start is abandoned while it still cleans up the replaced one",
    () => {
      const codex = makeFakeCodexAdapter();
      const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      return withService(
        [codex, claude],
        Effect.gen(function* () {
          const provider = yield* ProviderService;
          const directory = yield* ProviderSessionDirectory;
          const threadId = asThreadId("abandoned-during-cleanup");
          const original = yield* provider.startSession(threadId, startInput(threadId));
          // Stopping the replaced runtime outlasts the start deadline.
          codex.stopSession.mockImplementation(() => Effect.never);
          const replacing = yield* provider
            .startSession(threadId, {
              provider: CLAUDE_AGENT_DRIVER,
              providerInstanceId: claudeAgentInstanceId,
              threadId,
              runtimeMode: "full-access",
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(timeouts.sessionStartMs));
          expectTimeout(yield* Fiber.join(replacing).pipe(Effect.flip), "session.start");
          for (let attempt = 0; attempt < 50; attempt += 1) {
            if (claude.stopSession.mock.calls.length > 0) break;
            yield* Effect.yieldNow;
          }
          // The new runtime did not outlive the start that nobody waits for.
          assert.deepEqual(yield* claude.listSessions(), []);
          const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
          assert.equal(binding.providerInstanceId, claudeAgentInstanceId);
          assert.equal(binding.status, "stopped");
          // The replaced runtime is left to the reaper's stale retry.
          assert.include(
            (yield* provider.listStaleSessionBindings()).map((stale) => stale.runtimeSessionId),
            original.runtimeSessionId,
          );
        }),
      );
    },
  );

  it.effect("bounds a rollback whose provider never confirms the rewind", () => {
    const codex = makeFakeCodexAdapter();
    codex.rollbackThread.mockImplementation(() => Effect.never);
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("rollback-never");
        yield* provider.startSession(threadId, startInput(threadId));
        const rolling = yield* provider
          .rollbackConversation({ threadId, numTurns: 1, targetTurnId: null, droppedTurnIds: [] })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(
          Duration.millis(timeouts.sessionStartMs + timeouts.controlRequestMs),
        );
        const error = expectTimeout(
          yield* Fiber.join(rolling).pipe(Effect.flip),
          "conversation.rollback",
        );
        assert.include(error.detail, "it may or may not have been applied");
        // The abandoned rollback released the thread's start lock.
        const other = yield* provider.startSession(threadId, startInput(threadId));
        assert.equal(other.threadId, threadId);
      }),
    );
  });

  it.effect("bounds a binding restore that waits behind a start that never finishes", () => {
    const release = Effect.runSync(Deferred.make<void>());
    const codex = makeFakeCodexAdapter(CODEX_DRIVER, {
      startSessionEffect: (input, makeSession) =>
        input.runtimeSessionId === RuntimeSessionId.make("zombie-runtime")
          ? Effect.uninterruptible(Deferred.await(release)).pipe(Effect.as(makeSession(input)))
          : Effect.sync(() => makeSession(input)),
    });
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("restore-behind-zombie");
        const original = yield* provider.startSession(threadId, startInput(threadId));
        const zombie = yield* provider
          .startSession(threadId, {
            ...startInput(threadId),
            runtimeSessionId: RuntimeSessionId.make("zombie-runtime"),
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.sessionStartMs));
        expectTimeout(yield* Fiber.join(zombie).pipe(Effect.flip), "session.start");
        // The zombie still holds the thread's start lock.
        const restoring = yield* provider
          .restoreSessionBinding({
            threadId,
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            runtimeSessionId: original.runtimeSessionId!,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.controlRequestMs));
        const error = expectTimeout(yield* Fiber.join(restoring).pipe(Effect.flip), "session.lock");
        assert.include(error.detail, "still finishing a previous start for this thread");
        yield* Deferred.succeed(release, undefined);
      }),
    );
  });

  it.effect(
    "waits for a completion-style turn past the acceptance deadline once it started",
    () => {
      const codex = makeFakeCodexAdapter(CODEX_DRIVER, { turnSubmission: "completion" });
      const finish = Effect.runSync(Deferred.make<void>());
      codex.sendTurn.mockImplementation((input) =>
        Effect.gen(function* () {
          codex.emit({
            type: "turn.started",
            eventId: asEventId("completion-turn-started"),
            provider: CODEX_DRIVER,
            createdAt: new Date().toISOString(),
            threadId: input.threadId,
            turnId: "completion-turn",
            payload: {},
          });
          yield* Deferred.await(finish);
          return { threadId: input.threadId, turnId: asTurnId("completion-turn") };
        }),
      );
      return withService(
        [codex],
        Effect.gen(function* () {
          const provider = yield* ProviderService;
          const threadId = asThreadId("completion-accepted");
          yield* provider.startSession(threadId, startInput(threadId));
          yield* awaitEventSubscription(codex, threadId);
          const sending = yield* provider
            .sendTurn({ threadId, input: "long turn" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          // turn.started must be processed before the deadline is reached.
          assert.isTrue(yield* eventProcessed(threadId, asEventId("completion-turn-started")));
          assert.equal(codex.sendTurn.mock.calls.length, 1);
          yield* TestClock.adjust(Duration.millis(timeouts.turnAcceptanceMs * 2));
          assert.isUndefined(sending.pollUnsafe());
          yield* Deferred.succeed(finish, undefined);
          const turn = yield* Fiber.join(sending);
          assert.equal(turn.turnId, asTurnId("completion-turn"));
        }),
      );
    },
  );

  it.effect(
    "fails a completion-style turn that never starts and interrupts it in the background",
    () => {
      const codex = makeFakeCodexAdapter(CODEX_DRIVER, { turnSubmission: "completion" });
      const interrupted = Effect.runSync(Deferred.make<void>());
      codex.sendTurn.mockImplementation(() =>
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      );
      return withService(
        [codex],
        Effect.gen(function* () {
          const provider = yield* ProviderService;
          const threadId = asThreadId("completion-never-started");
          yield* provider.startSession(threadId, startInput(threadId));
          const sending = yield* provider
            .sendTurn({ threadId, input: "never starts" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(timeouts.turnAcceptanceMs));
          expectTimeout(yield* Fiber.join(sending).pipe(Effect.flip), "turn.start");
          yield* Deferred.await(interrupted);
        }),
      );
    },
  );

  it.effect("fails an acceptance-style turn at the deadline and cancels the call", () => {
    const codex = makeFakeCodexAdapter();
    const interrupted = Effect.runSync(Deferred.make<void>());
    codex.sendTurn.mockImplementation(() =>
      Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
    );
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("acceptance-never");
        yield* provider.startSession(threadId, startInput(threadId));
        const sending = yield* provider
          .sendTurn({ threadId, input: "hangs" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.turnAcceptanceMs));
        const error = expectTimeout(yield* Fiber.join(sending).pipe(Effect.flip), "turn.start");
        assert.include(error.detail, "did not accept the turn within 0.5s");
        // The call gets one more acceptance window to answer late, then is cut.
        assert.isFalse(yield* Deferred.isDone(interrupted));
        yield* TestClock.adjust(Duration.millis(timeouts.turnAcceptanceMs));
        yield* Deferred.await(interrupted);
        // Without a turn id there is nothing to interrupt precisely; nothing else is touched.
        assert.equal(codex.interruptTurn.mock.calls.length, 0);
      }),
    );
  });

  it.effect("interrupts the exact turn of an acceptance-style send that answers late", () => {
    const codex = makeFakeCodexAdapter();
    const accept = Effect.runSync(Deferred.make<void>());
    codex.sendTurn.mockImplementation((input) =>
      Deferred.await(accept).pipe(
        Effect.as({ threadId: input.threadId, turnId: asTurnId("late-turn") }),
      ),
    );
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("acceptance-late");
        yield* provider.startSession(threadId, startInput(threadId));
        const sending = yield* provider
          .sendTurn({ threadId, input: "answers late" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.turnAcceptanceMs));
        expectTimeout(yield* Fiber.join(sending).pipe(Effect.flip), "turn.start");
        // The provider accepted the request after Ryco stopped waiting.
        yield* Deferred.succeed(accept, undefined);
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (codex.interruptTurn.mock.calls.length > 0) break;
          yield* Effect.yieldNow;
        }
        assert.deepEqual(codex.interruptTurn.mock.calls, [[threadId, asTurnId("late-turn")]]);
      }),
    );
  });

  it.effect("tracks runtime activity from events and clears it on stop", () => {
    const codex = makeFakeCodexAdapter();
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("activity-thread");
        const session = yield* provider.startSession(threadId, startInput(threadId));
        const started = yield* provider.listRuntimeActivity!();
        assert.deepEqual(
          started.map((entry) => [entry.threadId, entry.runtimeSessionId]),
          [[threadId, session.runtimeSessionId]],
        );
        yield* awaitEventSubscription(codex, threadId);
        const subscribedAt = (yield* provider.listRuntimeActivity!())[0]!.lastActivityAtMs;
        yield* TestClock.adjust(Duration.millis(5_000));
        codex.emit({
          type: "content.delta",
          eventId: asEventId("activity-delta"),
          provider: CODEX_DRIVER,
          createdAt: new Date().toISOString(),
          threadId,
          turnId: "activity-turn",
          payload: { streamKind: "assistant_text", delta: "hi" },
        });
        assert.isTrue(yield* eventProcessed(threadId, asEventId("activity-delta")));
        const latest = (yield* provider.listRuntimeActivity!())[0]!.lastActivityAtMs;
        assert.equal(latest - subscribedAt, 5_000);
        yield* provider.stopSession({ threadId });
        assert.deepEqual(yield* provider.listRuntimeActivity!(), []);
      }),
    );
  });

  it.effect("returns timed-out for a stale stop that cannot be interrupted", () => {
    const codex = makeFakeCodexAdapter();
    const release = Effect.runSync(Deferred.make<void>());
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("stale-stop-zombie");
        const session = yield* provider.startSession(threadId, startInput(threadId));
        codex.stopSession.mockImplementation(() => Effect.uninterruptible(Deferred.await(release)));
        const stopping = yield* provider
          .stopSessionBinding({
            threadId,
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            runtimeSessionId: session.runtimeSessionId!,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(2_000));
        assert.equal(yield* Fiber.join(stopping), "timed-out");
        yield* Deferred.succeed(release, undefined);
      }),
    );
  });

  it.effect("fails an approval response the provider never acknowledges", () => {
    const codex = makeFakeCodexAdapter();
    codex.respondToRequest.mockImplementation(() => Effect.never);
    return withService(
      [codex],
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("respond-never");
        yield* provider.startSession(threadId, startInput(threadId));
        const responding = yield* provider
          .respondToRequest({ threadId, requestId: asRequestId("req-never"), decision: "accept" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(timeouts.controlRequestMs));
        expectTimeout(yield* Fiber.join(responding).pipe(Effect.flip), "request.respond");
      }),
    );
  });
});
