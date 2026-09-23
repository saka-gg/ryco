import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const at = "2026-09-01T00:00:00.000Z";
const threadId = ThreadId.make("chunk-thread");
const projectId = ProjectId.make("chunk-project");
const messageId = MessageId.make("chunk-message");
const turnId = TurnId.make("chunk-turn");
const event = (
  id: string,
  input: Pick<OrchestrationEvent, "type" | "payload">,
): Omit<OrchestrationEvent, "sequence"> => ({
  ...input,
  eventId: EventId.make(id),
  aggregateKind: input.type === "project.created" ? "project" : "thread",
  aggregateId: input.type === "project.created" ? projectId : threadId,
  occurredAt: at,
  commandId: CommandId.make(id),
  causationEventId: null,
  correlationId: CommandId.make(id),
  metadata: {},
});
const message = (id: string, text: string, streaming = true) =>
  event(id, {
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId,
      turnId,
      text,
      streaming,
      role: "assistant",
      createdAt: at,
      updatedAt: at,
    },
  });
const first = message("delta-1", "cross-");
const second = message("delta-2", "boundary\0\ud83d");
const third = message("delta-3", "\ude80 café\ud800");
const expected = "cross-boundary\0🚀 café\ud800";

it.effect(
  "recovers file-backed streaming text, unchanged events, snapshot/history and full rebuild",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const makeLayer = () =>
        Layer.mergeAll(
          OrchestrationProjectionPipelineLive,
          OrchestrationProjectionSnapshotQueryLive,
        ).pipe(
          Layer.provideMerge(OrchestrationEventStoreLive),
          Layer.provide(ThreadBackgroundLiveness.layer),
          Layer.provide(RepositoryIdentityResolverLive),
          Layer.provide(
            Layer.succeed(ProjectAvatarStore, {
              write: () => Effect.die("unused"),
              read: () => Effect.succeed(null),
              remove: () => Effect.void,
            }),
          ),
          Layer.provideMerge(makeSqlitePersistenceLive(config.dbPath)),
        );
      const check = (text: string, streaming: boolean) =>
        Effect.gen(function* () {
          const query = yield* ProjectionSnapshotQuery;
          const one = Option.getOrThrow(
            yield* query.getThreadMessageById!({ threadId, messageId }),
          );
          assert.equal(one.text, text);
          assert.equal(one.streaming, streaming);
          const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
          assert.equal(detail.messages[0]?.text, text);
          assert.equal((yield* query.getSnapshot()).threads[0]?.messages[0]?.text, text);
          assert.equal(
            (yield* query.listThreadMessagesByTurn!({ threadId, turnId, limit: 10 }))[0]?.text,
            text,
          );
          const window = yield* query.getThreadWindow!({
            threadId,
            limits: { messages: 10, activities: 10, proposedPlans: 10, checkpoints: 10 },
          });
          assert.equal(window.thread.messages[0]?.text, text);
          const around = yield* query.getThreadHistoryPage!({
            threadId,
            collection: "messages",
            mode: { kind: "around", anchorId: messageId },
            limit: 10,
          });
          assert.equal(around.collection, "messages");
          if (around.collection === "messages") assert.equal(around.items[0]?.text, text);
          const matches = yield* query.searchThreadMessages({
            query: "cross-boundary",
            limit: 10,
            threadId,
          });
          assert.equal(matches[0]?.messageId, messageId);
        });
      yield* Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        yield* store.append(
          event("project", {
            type: "project.created",
            payload: {
              projectId,
              title: "Fixture",
              workspaceRoot: config.cwd,
              defaultModelSelection: null,
              scripts: [],
              createdAt: at,
              updatedAt: at,
            },
          }),
        );
        yield* store.append(
          event("thread", {
            type: "thread.created",
            payload: {
              threadId,
              projectId,
              title: "Fixture",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: at,
              updatedAt: at,
            },
          }),
        );
        yield* store.append(first);
        yield* store.append(second);
        yield* pipeline.bootstrap;
        yield* check("cross-boundary\0\ud83d", true);
        // Durable event beyond the projection cursor simulates restart after the
        // event append committed, before projection caught up.
        yield* store.append(third);
      }).pipe(Effect.provide(makeLayer()));

      yield* Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        yield* pipeline.bootstrap;
        yield* pipeline.bootstrap;
        yield* check(expected, true);
        const events = yield* Stream.runCollect(store.readAll());
        assert.deepEqual(
          events.slice(-3).map((entry) => ({
            id: entry.eventId,
            sequence: entry.sequence,
            payload: entry.payload,
          })),
          [first, second, third].map((entry, index) => ({
            id: entry.eventId,
            sequence: index + 3,
            payload: entry.payload,
          })),
        );
        // Duplicate event identity is rejected by the unchanged durable event store.
        assert.equal((yield* store.append(third).pipe(Effect.result))._tag, "Failure");
        // Older pages must assemble an unfinished body too, without disturbing
        // the ordering/cursor of a newer, independently persisted message.
        yield* pipeline.projectEvent(
          yield* store.append(
            event("later", {
              type: "thread.message-sent",
              payload: {
                threadId,
                messageId: MessageId.make("later-message"),
                turnId: null,
                role: "assistant",
                text: "later",
                streaming: false,
                createdAt: "2026-09-01T00:00:01.000Z",
                updatedAt: "2026-09-01T00:00:01.000Z",
              },
            }),
          ),
        );
        const query = yield* ProjectionSnapshotQuery;
        const latest = yield* query.getThreadWindow!({
          threadId,
          limits: { messages: 1, activities: 1, proposedPlans: 1, checkpoints: 1 },
        });
        assert.equal(latest.thread.messages[0]?.id, "later-message");
        const older = yield* query.getThreadHistoryPage!({
          threadId,
          collection: "messages",
          mode: { kind: "before", cursor: latest.history.messages.oldestCursor! },
          limit: 10,
        });
        assert.equal(older.collection, "messages");
        if (older.collection === "messages") assert.equal(older.items[0]?.text, expected);
        const complete = yield* store.append(message("final", "", false));
        yield* pipeline.projectEvent(complete);
        yield* pipeline.projectEvent(complete);
        yield* check(expected, false);
        // Reset only the message projector and its rows: reconstruct from events.
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_state WHERE projector = 'projection.thread-messages'`;
        yield* pipeline.bootstrap;
        yield* check(expected, false);
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM projection_message_chunks`)[0]?.count,
          0,
        );
        yield* pipeline.projectEvent(yield* store.append(message("resumed", " resumed")));
        // Soft deletion retains durable history but hides it from active snapshots.
        const deleted = yield* store.append(
          event("delete", { type: "thread.deleted", payload: { threadId, deletedAt: at } }),
        );
        yield* pipeline.projectEvent(deleted);
        assert.isTrue(
          Option.isNone(yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(threadId)),
        );
        yield* pipeline.projectEvent(
          yield* store.append(
            event("recreated", {
              type: "thread.created",
              payload: {
                threadId,
                projectId,
                title: "Recreated",
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
                runtimeMode: "full-access",
                branch: null,
                worktreePath: null,
                createdAt: at,
                updatedAt: at,
              },
            }),
          ),
        );
        assert.deepEqual(
          Option.getOrThrow(yield* query.getThreadDetailById(threadId)).messages,
          [],
        );
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM projection_message_chunks`)[0]?.count,
          0,
        );
      }).pipe(Effect.provide(makeLayer()));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "ryco-message-chunks-restart-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
