import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../projectorNames.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-projection-follow-up-queue-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const CODEX = ProviderInstanceId.make("codex");
const createdAt = "2026-10-04T10:00:00.000Z";

const setup = (key: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const threadId = ThreadId.make(`thread-${key}`);
    const projectId = ProjectId.make(`project-${key}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${key}`),
      projectId,
      title: "Queue",
      workspaceRoot: `/tmp/project-queue-${key}`,
      defaultModelSelection: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${key}`),
      threadId,
      projectId,
      title: "Queue",
      modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    return { threadId, projectId };
  });

const add = (
  threadId: ThreadId,
  messageId: string,
  text: string,
  options: { readonly position?: "head" | "tail"; readonly at?: string } = {},
): OrchestrationCommand => ({
  type: "thread.queue.add",
  commandId: CommandId.make(`cmd-add-${threadId}-${messageId}-${options.at ?? "1"}`),
  threadId,
  entry: {
    messageId: MessageId.make(messageId),
    text,
    attachments: [],
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  ...(options.position === undefined ? {} : { position: options.position }),
  createdAt: options.at ?? "2026-10-04T10:01:00.000Z",
});

const entryRows = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly messageId: string;
      readonly position: number;
      readonly revision: number;
      readonly status: string;
    }>`
      SELECT message_id AS "messageId", position, revision, status
      FROM projection_thread_queue_entries WHERE thread_id = ${threadId}
      ORDER BY position ASC`;
  });

const holdRows = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly holdJson: string }>`
      SELECT hold_json AS "holdJson" FROM projection_thread_queue_holds
      WHERE thread_id = ${threadId}`;
  });

const threadUpdatedAt = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly updatedAt: string }>`
      SELECT updated_at AS "updatedAt" FROM projection_threads WHERE thread_id = ${threadId}`;
  });

/** The engine's own queue and the one a restarted engine reads back from SQL agree. */
const assertQueueRoundTrips = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const live = (yield* engine.getReadModel!()).threads.find((thread) => thread.id === threadId);
    const stored = (yield* query.getCommandReadModel()).threads.find(
      (thread) => thread.id === threadId,
    );
    assert.deepEqual(stored?.followUpQueue, live?.followUpQueue);
    return live?.followUpQueue;
  });

layer("follow-up queue projection", (it) => {
  it.effect("stores entries in order, summarizes them on the shell and leaves the thread row", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const { threadId } = yield* setup("store");
      const before = yield* threadUpdatedAt(threadId);

      const empty = Option.getOrThrow(yield* query.getThreadShellById(threadId));
      assert.isFalse("followUpQueueSummary" in empty);

      yield* engine.dispatch(add(threadId, "msg-b", "second"));
      yield* engine.dispatch(add(threadId, "msg-a", "x".repeat(300), { position: "head" }));
      yield* engine.dispatch(add(threadId, "msg-c", "third"));
      assert.deepEqual(
        (yield* entryRows(threadId)).map((row) => row.messageId),
        ["msg-a", "msg-b", "msg-c"],
      );
      // The queue is not thread activity.
      assert.deepEqual(yield* threadUpdatedAt(threadId), before);

      const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId));
      assert.deepEqual(shell.followUpQueueSummary, {
        count: 3,
        hold: null,
        headStatus: "queued",
        headPreview: "x".repeat(120),
      });
      const snapshot = yield* query.getShellSnapshot();
      assert.deepEqual(
        snapshot.threads.find((thread) => thread.id === threadId)?.followUpQueueSummary,
        shell.followUpQueueSummary,
      );

      // Thread detail and the thread window carry the entries.
      const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      assert.deepEqual(
        detail.followUpQueue?.entries.map((entry) => entry.messageId),
        ["msg-a", "msg-b", "msg-c"],
      );
      const window = yield* query.getThreadWindow!({
        threadId,
        limits: { messages: 50, proposedPlans: 10, activities: 50, checkpoints: 10 },
      });
      assert.deepEqual(window.thread.followUpQueue, detail.followUpQueue);
      yield* assertQueueRoundTrips(threadId);
    }),
  );

  it.effect("an add of an id already queued is accepted and changes nothing", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const { threadId } = yield* setup("idempotent");
      const first = yield* engine.dispatch(add(threadId, "msg-1", "hello"));
      // A second device's copy (another command id) and a retry of the same command.
      const second = yield* engine.dispatch(
        add(threadId, "msg-1", "hello again", { at: "2026-10-04T10:02:00.000Z" }),
      );
      const retry = yield* engine.dispatch(add(threadId, "msg-1", "hello"));
      assert.equal(second.sequence, first.sequence);
      assert.equal(retry.sequence, first.sequence);
      const queue = yield* assertQueueRoundTrips(threadId);
      assert.deepEqual(
        queue?.entries.map((entry) => [entry.messageId, entry.text]),
        [["msg-1", "hello"]],
      );
    }),
  );

  it.effect("edits, moves, removals, holds and releases project like the engine's model", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const { threadId } = yield* setup("changes");
      for (const id of ["msg-1", "msg-2", "msg-3"]) {
        yield* engine.dispatch(add(threadId, id, id));
      }
      yield* engine.dispatch({
        type: "thread.queue.edit",
        commandId: CommandId.make("cmd-edit"),
        threadId,
        messageId: MessageId.make("msg-2"),
        expectedRevision: 1,
        text: "edited",
        attachments: [],
        modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
        createdAt: "2026-10-04T10:03:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.queue.move",
        commandId: CommandId.make("cmd-move"),
        threadId,
        messageId: MessageId.make("msg-3"),
        beforeMessageId: MessageId.make("msg-1"),
        createdAt: "2026-10-04T10:04:00.000Z",
      });
      assert.deepEqual(
        (yield* entryRows(threadId)).map((row) => [row.messageId, row.revision]),
        [
          ["msg-3", 1],
          ["msg-1", 1],
          ["msg-2", 2],
        ],
      );
      yield* engine.dispatch({
        type: "thread.queue.hold",
        commandId: CommandId.make("cmd-pause"),
        threadId,
        createdAt: "2026-10-04T10:05:00.000Z",
      });
      const held = yield* assertQueueRoundTrips(threadId);
      assert.equal(held?.hold?.reason, "paused");
      assert.equal((yield* holdRows(threadId)).length, 1);

      yield* engine.dispatch({
        type: "thread.queue.remove",
        commandId: CommandId.make("cmd-remove"),
        threadId,
        messageIds: [MessageId.make("msg-1")],
        createdAt: "2026-10-04T10:06:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.queue.resume",
        commandId: CommandId.make("cmd-resume"),
        threadId,
        acknowledgeCauseKeys: held?.hold?.causeKeys ?? [],
        createdAt: "2026-10-04T10:07:00.000Z",
      });
      assert.deepEqual(yield* holdRows(threadId), []);
      const queue = yield* assertQueueRoundTrips(threadId);
      assert.deepEqual(
        queue?.entries.map((entry) => entry.messageId),
        ["msg-3", "msg-2"],
      );
      assert.equal(queue?.entries[1]?.text, "edited");
      assert.equal(queue?.hold, null);
    }),
  );

  it.effect("a queue dispatch sends the head and removes it in one batch", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const { threadId, projectId } = yield* setup("dispatch");
      yield* engine.dispatch(add(threadId, "msg-1", "first"));
      yield* engine.dispatch(add(threadId, "msg-2", "second"));
      const dispatch = (revision: number, commandId: string) =>
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId: MessageId.make("msg-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          delegationReturnGuard: {
            latestUserMessageId: null,
            projectId,
            runtimeMode: "full-access",
            worktreePath: null,
            source: "follow-up-queue",
          },
          queueDispatch: { messageId: MessageId.make("msg-1"), revision },
          createdAt: "2026-10-04T10:08:00.000Z",
        });

      // A dispatch derived from an older revision is refused and records nothing.
      const stale = yield* Effect.exit(dispatch(2, "queue-drain:stale"));
      assert.isTrue(Exit.isFailure(stale));
      assert.deepEqual(
        (yield* entryRows(threadId)).map((row) => row.messageId),
        ["msg-1", "msg-2"],
      );

      yield* dispatch(1, "queue-drain:ok");
      assert.deepEqual(
        (yield* entryRows(threadId)).map((row) => row.messageId),
        ["msg-2"],
      );
      const messages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_messages
        WHERE thread_id = ${threadId}`;
      assert.deepEqual(
        messages.map((row) => row.messageId),
        ["msg-1"],
      );
      // The entry ran with the modes it was queued with.
      const thread = Option.getOrThrow(yield* query.getThreadShellById(threadId));
      assert.equal(thread.runtimeMode, "approval-required");
      assert.equal(thread.followUpQueueSummary?.count, 1);
      yield* assertQueueRoundTrips(threadId);
    }),
  );

  it.effect("a person's Stop holds a non-empty queue in the same batch", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const { threadId } = yield* setup("stop");
      yield* engine.dispatch(add(threadId, "msg-1", "later"));
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-stop"),
        threadId,
        turnId: TurnId.make("turn-running"),
        holdQueue: true,
        createdAt: "2026-10-04T10:09:00.000Z",
      });
      const queue = yield* assertQueueRoundTrips(threadId);
      assert.deepEqual(queue?.hold, {
        reason: "interrupted",
        detail: null,
        causeKeys: ["interrupt:turn-running"],
        heldAt: "2026-10-04T10:09:00.000Z",
      });
    }),
  );

  it.effect("Trash pauses the queue and keeps its rows; deletion forgets them", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const { threadId } = yield* setup("trash");
      yield* engine.dispatch(add(threadId, "msg-1", "later"));
      yield* engine.dispatch({
        type: "thread.queue.hold",
        commandId: CommandId.make("cmd-pause-trash"),
        threadId,
        createdAt: "2026-10-04T10:05:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.trash",
        commandId: CommandId.make("cmd-trash"),
        threadId,
      });
      // Trash can be undone: the entries stay, held until a restore and Resume.
      assert.deepEqual(
        (yield* entryRows(threadId)).map((row) => row.messageId),
        ["msg-1"],
      );
      const held = yield* assertQueueRoundTrips(threadId);
      assert.equal(held?.hold?.reason, "paused");
      assert.equal(held?.hold?.causeKeys.length, 2);
      assert.equal((yield* holdRows(threadId)).length, 1);
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete"),
        threadId,
      });
      assert.deepEqual(yield* entryRows(threadId), []);
      assert.deepEqual(yield* holdRows(threadId), []);
    }),
  );

  it.effect("a projector added by the upgrade rebuilds the tables from the event log", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const { threadId } = yield* setup("replay");
      yield* engine.dispatch(add(threadId, "msg-1", "one"));
      yield* engine.dispatch(add(threadId, "msg-2", "two", { position: "head" }));
      yield* engine.dispatch({
        type: "thread.queue.hold",
        commandId: CommandId.make("cmd-pause-replay"),
        threadId,
        createdAt: "2026-10-04T10:05:00.000Z",
      });
      const entries = yield* entryRows(threadId);
      const holds = yield* holdRows(threadId);

      yield* sql`DELETE FROM projection_thread_queue_entries`;
      yield* sql`DELETE FROM projection_thread_queue_holds`;
      yield* sql`DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadFollowUpQueues}`;
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* entryRows(threadId), entries);
      assert.deepEqual(yield* holdRows(threadId), holds);

      // Replaying again over the rebuilt tables changes nothing either.
      yield* sql`DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadFollowUpQueues}`;
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* entryRows(threadId), entries);
      assert.deepEqual(yield* holdRows(threadId), holds);
    }),
  );
});
