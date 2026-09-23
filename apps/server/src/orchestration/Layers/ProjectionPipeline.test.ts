import { messageTextJson, decodeMessageText } from "../../persistence/messageText.ts";
import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  RuntimeSessionId,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_EVENT_PROJECTORS,
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(MockProjectAvatarStoreLive),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("ryco-projection-pipeline-test-");

it("routes each event only to its explicit projection owners", () => {
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.message-sent"], [
    ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
    ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ]);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["worktree.created"], [
    ORCHESTRATION_PROJECTOR_NAMES.worktrees,
  ]);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.context-handoff-requested"], []);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.goal-updated"], [
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ]);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.turn-steer-requested"], []);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.turn-steer-accepted"], []);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.turn-steer-rejected"], []);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.settled"], ["projection.threads"]);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.unsettled"], ["projection.threads"]);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.snoozed"], ["projection.threads"]);
  assert.deepEqual(ORCHESTRATION_EVENT_PROJECTORS["thread.unsnoozed"], ["projection.threads"]);
  assert.equal(Object.keys(ORCHESTRATION_EVENT_PROJECTORS).length, 44);
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const settledAt = new Date(Date.parse(now) + 1_000).toISOString();
      yield* eventStore.append({
        type: "thread.settled",
        eventId: EventId.make("evt-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: settledAt,
        commandId: CommandId.make("cmd-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt,
          updatedAt: settledAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const settlementRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(settlementRows, [{ settledOverride: "settled", settledAt }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 4);
      }

      const snoozedUntil = new Date(Date.parse(now) + 3_600_000).toISOString();
      const snoozedEvent = yield* eventStore.append({
        type: "thread.snoozed",
        eventId: EventId.make("evt-snooze"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: settledAt,
        commandId: CommandId.make("cmd-snooze"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          snoozedAt: settledAt,
          snoozedUntil,
          updatedAt: settledAt,
        },
      });
      yield* projectionPipeline.projectEvent(snoozedEvent);
      yield* projectionPipeline.bootstrap;
      const snoozeRows =
        yield* sql`SELECT snoozed_until, snoozed_at, settled_override FROM projection_threads WHERE thread_id = 'thread-1'`;
      assert.deepEqual(snoozeRows, [
        { snoozed_until: snoozedUntil, snoozed_at: settledAt, settled_override: "active" },
      ]);
      const wakeEvent = yield* eventStore.append({
        type: "thread.unsnoozed",
        eventId: EventId.make("evt-wake"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: settledAt,
        commandId: CommandId.make("cmd-wake"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: ThreadId.make("thread-1"), updatedAt: settledAt },
      });
      yield* projectionPipeline.projectEvent(wakeEvent);
      assert.deepEqual(
        yield* sql`SELECT snoozed_until, snoozed_at FROM projection_threads WHERE thread_id = 'thread-1'`,
        [{ snoozed_until: null, snoozed_at: null }],
      );
    }),
  );

  it.effect("maintains user-input and latest-message summaries incrementally", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-incremental-summary");
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-incremental-summary-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-08-12T00:00:00.000Z",
        commandId: CommandId.make("cmd-incremental-summary-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-incremental-summary-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-incremental-summary"),
          title: "Incremental summary",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      });

      let activityIndex = 0;
      const appendActivity = (
        suffix: string,
        kind: string,
        detail: string | undefined = undefined,
      ) => {
        activityIndex += 1;
        const createdAt = new Date(
          Date.parse("2026-08-12T00:00:00.000Z") + activityIndex * 60_000,
        ).toISOString();
        return appendAndProject({
          type: "thread.activity-appended",
          eventId: EventId.make(`evt-incremental-summary-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make(`cmd-incremental-summary-${suffix}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-incremental-summary-${suffix}`),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-incremental-summary-${suffix}`),
              tone: kind === "user-input.requested" ? "info" : "error",
              kind,
              summary: kind,
              payload:
                detail === undefined
                  ? { requestId: "input-incremental-summary" }
                  : { requestId: "input-incremental-summary", detail },
              turnId: null,
              createdAt,
            },
          },
        });
      };

      yield* appendActivity("requested", "user-input.requested");
      yield* appendActivity("requested-again", "user-input.requested");
      yield* appendActivity(
        "transient-failure",
        "provider.user-input.respond.failed",
        "Provider timed out",
      );

      const pendingRows = yield* sql<{ readonly pendingUserInputCount: number }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(pendingRows, [{ pendingUserInputCount: 1 }]);

      yield* appendActivity(
        "stale-failure",
        "provider.user-input.respond.failed",
        "Unknown pending user-input request",
      );

      for (const [suffix, createdAt] of [
        ["newer", "2026-08-12T03:00:00.000Z"],
        ["older", "2026-08-12T02:00:00.000Z"],
      ] as const) {
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make(`evt-incremental-summary-message-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make(`cmd-incremental-summary-message-${suffix}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-incremental-summary-message-${suffix}`),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make(`message-incremental-summary-${suffix}`),
            role: "user",
            text: suffix,
            turnId: null,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      for (const [suffix, implementedAt, updatedAt] of [
        ["open", null, "2026-08-12T04:00:00.000Z"],
        ["implemented", "2026-08-12T05:00:00.000Z", "2026-08-12T05:00:00.000Z"],
      ] as const) {
        yield* appendAndProject({
          type: "thread.proposed-plan-upserted",
          eventId: EventId.make(`evt-incremental-summary-plan-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make(`cmd-incremental-summary-plan-${suffix}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-incremental-summary-plan-${suffix}`),
          metadata: {},
          payload: {
            threadId,
            proposedPlan: {
              id: "plan-incremental-summary",
              turnId: null,
              planMarkdown: "# Incremental plan",
              implementedAt,
              implementationThreadId: null,
              createdAt: "2026-08-12T04:00:00.000Z",
              updatedAt,
            },
          },
        });
        if (suffix === "open") {
          const actionableRows = yield* sql<{ readonly actionable: number }>`
            SELECT has_actionable_proposed_plan AS actionable
            FROM projection_threads
            WHERE thread_id = ${threadId}
          `;
          assert.deepEqual(actionableRows, [{ actionable: 1 }]);
        }
      }

      const summaryRows = yield* sql<{
        readonly latestUserMessageAt: string | null;
        readonly pendingUserInputCount: number;
        readonly hasActionableProposedPlan: number;
      }>`
        SELECT
          latest_user_message_at AS "latestUserMessageAt",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(summaryRows, [
        {
          latestUserMessageAt: "2026-08-12T03:00:00.000Z",
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
        },
      ]);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments-safe"),
            messageId: MessageId.make("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const later = new Date(Date.now() + 1_000).toISOString();

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.make("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 1_000).toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          projectId: ProjectId.make("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.make("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          projectId: ProjectId.make("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.make("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-rollback"),
            messageId: MessageId.make("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a thread is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.make("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-projection-attachments-revert-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes thread attachment directory when thread is deleted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.make("Thread Delete.Files");
      const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
      const otherThreadAttachmentId =
        "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-delete-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-delete-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-delete-files"),
          title: "Project Delete Files",
          workspaceRoot: "/tmp/project-delete-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-delete-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-delete-files"),
          title: "Thread Delete Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-delete-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-delete-files"),
          role: "user",
          text: "Delete",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "delete.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
      const otherThreadAttachmentPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
      yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
      assert.isTrue(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));

      yield* appendAndProject({
        type: "thread.deleted",
        eventId: EventId.make("evt-delete-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-delete-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-files-4"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: now,
        },
      });

      assert.isFalse(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-projection-attachments-replay-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("replay keeps files belonging to a later incarnation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-attachment-replay");
      const retriedThreadId = ThreadId.make("thread-attachment-retried");
      const deletedThreadId = ThreadId.make("thread-attachment-deleted");
      const retriedAttachmentPath = path.join(
        attachmentsDir,
        "thread-attachment-retried-00000000-0000-4000-8000-000000000001.png",
      );
      const deletedAttachmentPath = path.join(
        attachmentsDir,
        "thread-attachment-deleted-00000000-0000-4000-8000-000000000002.png",
      );
      const appendCreated = (threadId: ThreadId, suffix: string) =>
        eventStore.append({
          type: "thread.created",
          eventId: EventId.make(`event-attachment-create-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make(`command-attachment-create-${suffix}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`command-attachment-create-${suffix}`),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: `Thread ${suffix}`,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      const appendDeleted = (threadId: ThreadId, suffix: string) =>
        eventStore.append({
          type: "thread.deleted",
          eventId: EventId.make(`event-attachment-delete-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make(`command-attachment-delete-${suffix}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`command-attachment-delete-${suffix}`),
          metadata: {},
          payload: { threadId, deletedAt: now },
        });

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("event-attachment-replay-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("command-attachment-replay-project"),
        causationEventId: null,
        correlationId: CorrelationId.make("command-attachment-replay-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Attachment replay",
          workspaceRoot: "/tmp/project-attachment-replay",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* appendCreated(retriedThreadId, "retried-first");
      yield* appendDeleted(retriedThreadId, "retried");
      yield* appendCreated(retriedThreadId, "retried-second");
      yield* appendCreated(deletedThreadId, "deleted");
      yield* appendDeleted(deletedThreadId, "deleted");

      // Files are external to the event log. At replay time the retained file
      // already belongs to the later incarnation.
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(retriedAttachmentPath, "later incarnation");
      yield* fileSystem.writeFileString(deletedAttachmentPath, "deleted incarnation");

      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(retriedAttachmentPath));
      assert.isFalse(yield* exists(deletedAttachmentPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("ryco-projection-attachments-delete-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const now = new Date().toISOString();
      const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
      const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
      const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
      yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
      yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

      yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.make("evt-unsafe-thread-delete"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make(".."),
        occurredAt: now,
        commandId: CommandId.make("cmd-unsafe-thread-delete"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-unsafe-thread-delete"),
        metadata: {},
        payload: {
          threadId: ThreadId.make(".."),
          deletedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(attachmentsRootDir));
      assert.isTrue(yield* exists(attachmentsSentinelPath));
      assert.isTrue(yield* exists(stateDirSentinelPath));
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("replays a bootstrap backlog larger than the event store default limit", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-bootstrap-backlog");

      const sequenceRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const sequenceBeforeBacklog = sequenceRows[0]?.maxSequence ?? 0;
      const appendedEvents = yield* Effect.forEach(
        Array.from({ length: 1_001 }, (_, index) => index),
        (index) => {
          const eventId = EventId.make(`evt-bootstrap-backlog-${index}`);
          const commandId = CommandId.make(`cmd-bootstrap-backlog-${index}`);
          return eventStore.append({
            type: "project.created",
            eventId,
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.make(commandId),
            metadata: {},
            payload: {
              projectId,
              title: `Bootstrap backlog ${index}`,
              workspaceRoot: "/tmp/project-bootstrap-backlog",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
        },
      );
      const lastSequence = appendedEvents[appendedEvents.length - 1]!.sequence;

      yield* Effect.forEach(
        Object.values(ORCHESTRATION_PROJECTOR_NAMES),
        (projector) => {
          const lastAppliedSequence =
            projector === ORCHESTRATION_PROJECTOR_NAMES.projects
              ? sequenceBeforeBacklog
              : lastSequence;
          return sql`
            INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
            VALUES (${projector}, ${lastAppliedSequence}, ${now})
            ON CONFLICT (projector)
            DO UPDATE SET
              last_applied_sequence = excluded.last_applied_sequence,
              updated_at = excluded.updated_at
          `;
        },
        { discard: true },
      );

      yield* projectionPipeline.bootstrap;

      const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.projects}
      `;
      assert.deepEqual(stateRows, [{ lastAppliedSequence: lastSequence }]);
    }),
  );

  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          projectId: ProjectId.make("project-a"),
          title: "Thread A",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT ${messageTextJson(sql)} AS text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(
        messageRows.map((row) => ({ text: decodeMessageText(row.text) })),
        [{ text: "hello world" }],
      );

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          projectId: ProjectId.make("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.make("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.make("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.make("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.make("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-conflict-3-ready"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.500Z",
          commandId: CommandId.make("cmd-conflict-3-ready"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3-ready"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            session: {
              threadId: ThreadId.make("thread-conflict"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-02-26T13:00:02.500Z",
            },
          },
        });

        const interruptedLatestRows = yield* sql<{ readonly latestTurnId: string | null }>`
          SELECT latest_turn_id AS "latestTurnId"
          FROM projection_threads
          WHERE thread_id = 'thread-conflict'
        `;
        assert.deepEqual(interruptedLatestRows, [{ latestTurnId: "turn-interrupted" }]);

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.make("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            messageId: MessageId.make("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.make("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("clears stale pending approvals from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-approval"),
        occurredAt: "2026-02-26T12:30:00.000Z",
        commandId: CommandId.make("cmd-stale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-approval"),
          title: "Project Stale Approval",
          workspaceRoot: "/tmp/project-stale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:30:00.000Z",
          updatedAt: "2026-02-26T12:30:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:01.000Z",
        commandId: CommandId.make("cmd-stale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          projectId: ProjectId.make("project-stale-approval"),
          title: "Thread Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:30:01.000Z",
          updatedAt: "2026-02-26T12:30:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:02.000Z",
        commandId: CommandId.make("cmd-stale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-stale-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:03.000Z",
        commandId: CommandId.make("cmd-stale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-failed"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-stale-1",
              detail: "Unknown pending Codex approval request: approval-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:03.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-request-stale-1'
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-stale-1",
          status: "resolved",
          resolvedAt: "2026-02-26T12:30:03.000Z",
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 0 }]);
    }),
  );

  it.effect("ignores non-stale provider approval response failures", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-nonstale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:00.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Project Non-Stale Approval",
          workspaceRoot: "/tmp/project-nonstale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:45:00.000Z",
          updatedAt: "2026-02-26T12:45:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-nonstale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:01.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Thread Non-Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:45:01.000Z",
          updatedAt: "2026-02-26T12:45:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:02.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-nonstale-existing",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:03.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-existing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-existing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: TurnId.make("turn-nonstale-failure"),
            createdAt: "2026-02-26T12:45:03.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:04.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-missing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-missing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:04.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly turnId: string | null;
        readonly createdAt: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          turn_id AS "turnId",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id IN (
          'approval-request-nonstale-existing',
          'approval-request-nonstale-missing'
        )
        ORDER BY request_id
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-nonstale-existing",
          status: "pending",
          turnId: null,
          createdAt: "2026-02-26T12:45:02.000Z",
          resolvedAt: null,
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 1 }]);
    }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.make("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.make("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          projectId: ProjectId.make("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.make("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/thread-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.make("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.make("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/thread-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.make("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: true,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.make("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: true,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.make("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
      const keptText = yield* sql<{
        text: string;
        sequence: number;
      }>`SELECT ${messageTextJson(sql)} AS text, text_event_sequence AS sequence FROM projection_thread_messages WHERE message_id = 'assistant-keep'`;
      assert.equal(decodeMessageText(keptText[0]!.text), "kept");
      assert.isAbove(keptText[0]!.sequence, 0);
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM projection_message_chunks WHERE message_id IN ('assistant-keep', 'assistant-remove', 'user-remove')`)[0]
          ?.count,
        0,
      );
    }),
  );
});

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(MockProjectAvatarStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(MockProjectAvatarStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.make("thread-restart");
    const turnId = TurnId.make("turn-restart");
    const messageId = MessageId.make("message-restart");
    const sourcePlanThreadId = ThreadId.make("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.make("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.make("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "ryco-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "ryco-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-project"),
        projectId: ProjectId.make("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-scripts-project-create"),
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-scripts-project-update"),
        projectId: ProjectId.make("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: null,
        },
      ]);
    }),
  );

  it.effect("re-creating a deleted thread id starts from empty incarnation state", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-incarnation-retry");
      const threadId = ThreadId.make("thread-incarnation-retry");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };
      const createThread = (commandId: string, title: string) =>
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(commandId),
          threadId,
          projectId,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      const countRowsForThread = (table: string) =>
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM ${sql(table)}
          WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
      const incarnationTables = [
        "projection_thread_messages",
        "projection_thread_activities",
        "projection_thread_sessions",
        "projection_turns",
        "projection_thread_proposed_plans",
        "projection_pending_approvals",
        "projection_thread_user_input_requests",
      ];

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-incarnation-project"),
        projectId,
        title: "Incarnation retry project",
        workspaceRoot: "/tmp/project-incarnation-retry",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* createThread("cmd-incarnation-create-1", "First attempt");
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-incarnation-turn-1"),
        threadId,
        message: {
          messageId: MessageId.make("message-incarnation-1"),
          role: "user",
          text: "first attempt",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-incarnation-session-1"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeSessionId: RuntimeSessionId.make("incarnation-runtime-1"),
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-incarnation-1"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-incarnation-approval-1"),
        threadId,
        activity: {
          id: EventId.make("activity-incarnation-approval-1"),
          tone: "info",
          kind: "approval.requested",
          summary: "approval requested",
          payload: {
            requestId: "request-incarnation-approval-1",
            runtimeSessionId: "incarnation-runtime-1",
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-incarnation-user-input-1"),
        threadId,
        activity: {
          id: EventId.make("activity-incarnation-user-input-1"),
          tone: "info",
          kind: "user-input.requested",
          summary: "input requested",
          payload: {
            requestId: "request-incarnation-user-input-1",
            runtimeSessionId: "incarnation-runtime-1",
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make("cmd-incarnation-plan-1"),
        threadId,
        proposedPlan: {
          id: "plan-incarnation-1",
          turnId: null,
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      });

      for (const table of incarnationTables) {
        assert.isAbove(yield* countRowsForThread(table), 0, `${table} should be populated`);
      }

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-incarnation-delete"),
        threadId,
      });
      yield* createThread("cmd-incarnation-create-2", "Second attempt");

      const rows = yield* sql<{
        readonly title: string;
        readonly latestTurnId: string | null;
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
        readonly hasActionableProposedPlan: number;
        readonly deletedAt: string | null;
      }>`
        SELECT
          title,
          latest_turn_id AS "latestTurnId",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rows, [
        {
          title: "Second attempt",
          latestTurnId: null,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
          deletedAt: null,
        },
      ]);
      for (const table of incarnationTables) {
        assert.strictEqual(yield* countRowsForThread(table), 0, `${table} should be empty`);
      }
    }),
  );
});
