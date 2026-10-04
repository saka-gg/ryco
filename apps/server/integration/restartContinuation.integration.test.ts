/**
 * Pins the graceful-shutdown invariant restart continuation relies on: the startup
 * layer stops the reactors before the provider service stops its sessions, so the
 * projection still names the in-flight turn after a graceful shutdown, exactly as it
 * does after a crash, and one startup capture path covers both.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CompletionReturnRepository } from "../src/persistence/Layers/AgentControlCompletionReturns.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProviderEffectIntentRepositoryLive } from "../src/persistence/Layers/ProviderEffectIntents.ts";
import {
  RestartContinuationRepository,
  RestartContinuationRepositoryLive,
} from "../src/persistence/Layers/RestartContinuations.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { makeRestartContinuationLayer } from "../src/orchestration/Layers/RestartContinuation.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { RestartContinuation } from "../src/orchestration/Services/RestartContinuation.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { ProviderSessionDirectory } from "../src/provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const PROJECT_ID = ProjectId.make("restart-project");
const THREAD_ID = ThreadId.make("restart-thread");

const nowIso = () => new Date().toISOString();

const seedRunningTurn = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const instanceId = defaultInstanceIdForDriver(PROVIDER);
    const model = DEFAULT_MODEL_BY_PROVIDER[PROVIDER] ?? DEFAULT_MODEL;
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("restart-project-create"),
      projectId: PROJECT_ID,
      title: "Restart project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { instanceId, model },
      createdAt: nowIso(),
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("restart-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Restart thread",
      modelSelection: { instanceId, model },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt: nowIso(),
    });
    // The turn starts and reports progress with a final assistant message, then the
    // process goes away mid-turn (no turn.completed).
    yield* harness.adapterHarness!.queueTurnResponseForNextSession({
      completeTurn: false,
      events: [
        {
          type: "turn.started",
          eventId: EventId.make("restart-turn-started"),
          provider: PROVIDER,
          createdAt: nowIso(),
          threadId: THREAD_ID,
          turnId: "restart-turn",
        },
        {
          type: "message.completed",
          eventId: EventId.make("restart-progress"),
          provider: PROVIDER,
          createdAt: nowIso(),
          threadId: THREAD_ID,
          turnId: "restart-turn",
          itemId: "restart-progress",
          detail: "Halfway through the migration.",
        },
      ],
    });
    yield* harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("restart-turn-start"),
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.make("restart-user-message"),
        role: "user",
        text: "Run the migration",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt: nowIso(),
    });
    return yield* harness.waitForThread(
      THREAD_ID,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session.activeTurnId !== null &&
        thread.latestTurn?.turnId === thread.session.activeTurnId &&
        thread.latestTurn.state === "completed",
    );
  });

const turnRows = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* sql<{ readonly status: string; readonly activeTurnId: string | null }>`
      SELECT status, active_turn_id AS "activeTurnId" FROM projection_thread_sessions
      WHERE thread_id = ${THREAD_ID}
    `;
    const turns = yield* sql<{ readonly turnId: string | null; readonly state: string }>`
      SELECT turn_id AS "turnId", state FROM projection_turns
      WHERE thread_id = ${THREAD_ID} AND turn_id IS NOT NULL ORDER BY row_id
    `;
    return { sessions, turns };
  }).pipe(Effect.provide(makeSqlitePersistenceLive(harness.dbPath)));

it.live(
  "keeps a gracefully stopped in-flight turn projected as running, and captures it",
  () =>
    Effect.gen(function* () {
      const first = yield* makeOrchestrationIntegrationHarness({ provider: PROVIDER });
      const running = yield* seedRunningTurn(first).pipe(Effect.ensuring(first.dispose));
      const turnId = running.session!.activeTurnId!;
      const before = yield* turnRows(first);

      const second = yield* makeOrchestrationIntegrationHarness({
        provider: PROVIDER,
        databasePath: first.dbPath,
      });
      yield* Effect.gen(function* () {
        const after = yield* turnRows(second);
        assert.deepStrictEqual(after.sessions, [{ status: "running", activeTurnId: turnId }]);
        assert.deepStrictEqual(after.turns, before.turns);
        assert.deepStrictEqual(after.turns, [{ turnId, state: "completed" }]);

        const captureLayer = makeRestartContinuationLayer().pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(OrchestrationEngineService, second.engine),
              Layer.succeed(ProjectionSnapshotQuery, second.snapshotQuery),
              Layer.succeed(ServerSettingsService, {
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  continueThreadsAfterRestart: true,
                }),
              } as unknown as ServerSettingsService["Service"]),
              Layer.succeed(ProviderSessionDirectory, {
                getBinding: (threadId: ThreadId) =>
                  Effect.succeed(
                    Option.some({
                      threadId,
                      provider: PROVIDER,
                      providerInstanceId: running.modelSelection.instanceId,
                      status: "running" as const,
                      resumeCursor: { cursor: "resume" },
                    }),
                  ),
              } as unknown as ProviderSessionDirectory["Service"]),
              Layer.succeed(CompletionReturnRepository, {
                get: () => Effect.succeed(undefined),
              } as unknown as CompletionReturnRepository["Service"]),
              ThreadBackgroundLiveness.layer,
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              RestartContinuationRepositoryLive,
              ProviderEffectIntentRepositoryLive,
              OrchestrationCommandReceiptRepositoryLive,
            ),
          ),
          Layer.provide(makeSqlitePersistenceLive(second.dbPath)),
        );
        yield* Effect.gen(function* () {
          const restart = yield* RestartContinuation;
          const repository = yield* RestartContinuationRepository;
          const snapshot = yield* second.snapshotQuery.getCommandReadModel();
          const captured = yield* restart.capture({ snapshot, liveThreadIds: new Set() });
          assert.deepStrictEqual(
            captured.map((row) => [row.threadId, row.sourceTurnId, row.status]),
            [[THREAD_ID, turnId, "pending"]],
          );
          const stored = Option.getOrUndefined(
            yield* repository.get({ threadId: THREAD_ID, sourceTurnId: turnId }),
          );
          assert.strictEqual(stored?.invalid === true ? null : stored?.record.kind, "in-flight");
        }).pipe(Effect.provide(captureLayer));
      }).pipe(Effect.ensuring(second.dispose));
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
