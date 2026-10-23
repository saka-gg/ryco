import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  applyProjectionStreamEvent,
  dumpNarrowWriteProjections,
  makeProjectionEventStream,
  maxPendingCounts,
  type ProjectionStreamEvent,
} from "../../../scripts/projectionEventStream.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadUserInputRequestRepositoryLive } from "../../persistence/Layers/ProjectionThreadUserInputRequests.ts";
import { ProjectionWorktreeRepositoryLive } from "../../persistence/Layers/ProjectionWorktrees.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import {
  LegacyReplaceProjectionTurnRepositoryLive,
  LegacyTouchProjectionThreadRepositoryLive,
} from "../../testing/legacyProjectionWrites.ts";
import { installRowWriteProbe } from "../../../scripts/sqliteRowWriteProbe.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  makeOrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const withPipelineDependencies = <E, R>(
  pipeline: Layer.Layer<OrchestrationProjectionPipeline, E, R>,
) =>
  pipeline.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-narrow-writes-" })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(MockProjectAvatarStoreLive),
    Layer.provideMerge(NodeServices.layer),
  );

const NarrowPipelineTestLayer = withPipelineDependencies(OrchestrationProjectionPipelineLive);

/**
 * The same projectors over repositories whose narrow writes are replaced by the full-row writes
 * they replaced. Every other repository is Live, as in `OrchestrationProjectionPipelineLive`.
 */
const FullRowPipelineTestLayer = withPipelineDependencies(
  Layer.effect(OrchestrationProjectionPipeline, makeOrchestrationProjectionPipeline()).pipe(
    Layer.provide(
      Layer.mergeAll(
        LegacyTouchProjectionThreadRepositoryLive,
        LegacyReplaceProjectionTurnRepositoryLive,
        ProjectionProjectRepositoryLive,
        ProjectionThreadMessageRepositoryLive,
        ProjectionThreadProposedPlanRepositoryLive,
        ProjectionThreadActivityRepositoryLive,
        ProjectionThreadSessionRepositoryLive,
        ProjectionThreadUserInputRequestRepositoryLive,
        ProjectionPendingApprovalRepositoryLive,
        ProjectionWorktreeRepositoryLive,
        ProjectionStateRepositoryLive,
      ),
    ),
  ),
);

let eventKey = 0;
const apply = (
  type: ProjectionStreamEvent["type"],
  aggregateId: string,
  occurredAt: string,
  payload: unknown,
) =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    const pipeline = yield* OrchestrationProjectionPipeline;
    yield* applyProjectionStreamEvent(
      store,
      pipeline,
      {
        label: type,
        type,
        aggregateKind: type === "project.created" ? "project" : "thread",
        aggregateId,
        occurredAt,
        payload,
      },
      `narrow-writes-${++eventKey}`,
    );
  });

const at = (seconds: number) =>
  new Date(Date.parse("2026-09-01T00:00:00.000Z") + seconds * 1000).toISOString();

const createThread = (threadId: string) =>
  apply("thread.created", threadId, at(0), {
    threadId,
    projectId: "project-narrow",
    title: "Narrow writes",
    modelSelection: { instanceId: "opencode", model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: at(0),
    updatedAt: at(0),
  });

const appendActivity = (
  threadId: string,
  input: { readonly id: string; readonly kind: string; readonly createdAt: string } & {
    readonly payload?: Record<string, unknown>;
    readonly tone?: string;
  },
) =>
  apply("thread.activity-appended", threadId, input.createdAt, {
    threadId,
    activity: {
      id: input.id,
      tone: input.tone ?? "tool",
      kind: input.kind,
      summary: input.kind,
      payload: input.payload ?? {
        itemType: "command_execution",
        status: "inProgress",
        providerItemId: "call-1",
      },
      turnId: null,
      createdAt: input.createdAt,
    },
  });

const sendMessage = (
  threadId: string,
  input: {
    readonly messageId: string;
    readonly role: "user" | "assistant" | "system";
    readonly turnId: string | null;
    readonly streaming: boolean;
    readonly createdAt: string;
    readonly occurredAt: string;
  },
) =>
  apply("thread.message-sent", threadId, input.occurredAt, {
    threadId,
    messageId: input.messageId,
    role: input.role,
    text: "delta",
    turnId: input.turnId,
    streaming: input.streaming,
    createdAt: input.createdAt,
    updatedAt: input.occurredAt,
  });

const setRunningSession = (
  threadId: string,
  turnId: string,
  occurredAt: string,
  releasedTurn?: Record<string, unknown>,
) =>
  apply("thread.session-set", threadId, occurredAt, {
    threadId,
    session: {
      threadId,
      status: "running",
      providerName: "opencode",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: occurredAt,
    },
    ...(releasedTurn ? { releasedTurn } : {}),
  });

const threadRow = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly updatedAt: string;
      readonly latestUserMessageAt: string | null;
      readonly pendingApprovalCount: number;
      readonly pendingUserInputCount: number;
    }>`
      SELECT
        updated_at AS "updatedAt",
        latest_user_message_at AS "latestUserMessageAt",
        pending_approval_count AS "pendingApprovalCount",
        pending_user_input_count AS "pendingUserInputCount"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    return rows[0];
  });

const turnRows = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly turnId: string;
      readonly state: string;
      readonly assistantMessageId: string | null;
      readonly checkpointTurnCount: number | null;
    }>`
      SELECT
        turn_id AS "turnId",
        state,
        assistant_message_id AS "assistantMessageId",
        checkpoint_turn_count AS "checkpointTurnCount"
      FROM projection_turns
      WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
      ORDER BY turn_id
    `;
  });

/** Counts writes that list a column a narrow write must not touch (`UPDATE OF` fires per SET). */
const probeOtherThreadColumns = (name: string, threadId: string) =>
  installRowWriteProbe({
    name,
    table: "projection_threads",
    columns: ["title", "model_selection_json", "latest_turn_id", "latest_user_message_at"],
    when: `NEW.thread_id = '${threadId}'`,
  });

const probeRowWrites = (name: string, table: string, threadId: string) =>
  installRowWriteProbe({ name, table, when: `NEW.thread_id = '${threadId}'` });

it.layer(NarrowPipelineTestLayer)("ProjectionPipeline narrow thread writes", (it) => {
  it.effect("an activity append rewrites only updated_at and the pending counters", () =>
    Effect.gen(function* () {
      const threadId = "thread-activity-columns";
      yield* createThread(threadId);
      const otherColumnWrites = yield* probeOtherThreadColumns("activity_columns", threadId);

      yield* appendActivity(threadId, {
        id: "activity-columns-1",
        kind: "tool.updated",
        createdAt: at(5),
      });

      assert.equal(yield* otherColumnWrites, 0);
      assert.equal((yield* threadRow(threadId))?.updatedAt, at(5));
    }),
  );

  it.effect("approval requests and resolutions move the pending counter narrowly", () =>
    Effect.gen(function* () {
      const threadId = "thread-approval-counter";
      yield* createThread(threadId);
      const otherColumnWrites = yield* probeOtherThreadColumns("approval_columns", threadId);

      yield* appendActivity(threadId, {
        id: "approval-counter-requested",
        kind: "approval.requested",
        tone: "approval",
        createdAt: at(2),
        payload: { requestId: "approval-counter", requestKind: "command", detail: "bun run test" },
      });
      assert.equal((yield* threadRow(threadId))?.pendingApprovalCount, 1);

      yield* appendActivity(threadId, {
        id: "approval-counter-resolved",
        kind: "approval.resolved",
        tone: "approval",
        createdAt: at(3),
        payload: { requestId: "approval-counter", decision: "accept" },
      });
      const row = yield* threadRow(threadId);
      assert.equal(row?.pendingApprovalCount, 0);
      assert.equal(row?.updatedAt, at(3));
      assert.equal(yield* otherColumnWrites, 0);
    }),
  );

  it.effect("a repeated activity with the same time writes no thread row", () =>
    Effect.gen(function* () {
      const threadId = "thread-repeated-activity";
      yield* createThread(threadId);
      const threadWrites = yield* probeRowWrites(
        "repeated_activity",
        "projection_threads",
        threadId,
      );

      // OpenCode's running tool updates all carry the tool's start time.
      yield* appendActivity(threadId, { id: "repeated-1", kind: "tool.updated", createdAt: at(4) });
      assert.equal(yield* threadWrites, 1);
      yield* appendActivity(threadId, { id: "repeated-2", kind: "tool.updated", createdAt: at(4) });
      yield* appendActivity(threadId, { id: "repeated-3", kind: "tool.updated", createdAt: at(4) });
      assert.equal(yield* threadWrites, 1);
    }),
  );

  it.effect("updated_at still follows the event time backwards, as before", () =>
    Effect.gen(function* () {
      const threadId = "thread-backwards";
      yield* createThread(threadId);
      yield* appendActivity(threadId, {
        id: "backwards-1",
        kind: "tool.updated",
        createdAt: at(10),
      });
      yield* appendActivity(threadId, {
        id: "backwards-2",
        kind: "tool.updated",
        createdAt: at(7),
      });
      assert.equal((yield* threadRow(threadId))?.updatedAt, at(7));
    }),
  );

  it.effect("an activity for an unknown thread creates no thread row", () =>
    Effect.gen(function* () {
      const threadId = "thread-never-created";
      yield* appendActivity(threadId, { id: "unknown-1", kind: "tool.updated", createdAt: at(1) });
      assert.isUndefined(yield* threadRow(threadId));
    }),
  );

  it.effect("the thread's own prompt still moves latest_user_message_at", () =>
    Effect.gen(function* () {
      const threadId = "thread-own-prompt";
      yield* createThread(threadId);
      yield* sendMessage(threadId, {
        messageId: "own-prompt-1",
        role: "user",
        turnId: null,
        streaming: false,
        createdAt: at(3),
        occurredAt: at(4),
      });
      const row = yield* threadRow(threadId);
      assert.equal(row?.latestUserMessageAt, at(3));
      assert.equal(row?.updatedAt, at(4));
    }),
  );

  it.effect("inherited prompts, replies and system messages move only updated_at", () =>
    Effect.gen(function* () {
      const threadId = "thread-inherited-prompt";
      yield* createThread(threadId);
      const otherColumnWrites = yield* probeOtherThreadColumns("inherited_columns", threadId);
      yield* sendMessage(threadId, {
        messageId: `${threadId}:inherited:source-prompt`,
        role: "user",
        turnId: null,
        streaming: false,
        createdAt: at(3),
        occurredAt: at(4),
      });
      assert.deepEqual(yield* threadRow(threadId), {
        updatedAt: at(4),
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
      });
      yield* sendMessage(threadId, {
        messageId: "inherited-reply",
        role: "assistant",
        turnId: null,
        streaming: true,
        createdAt: at(5),
        occurredAt: at(5),
      });
      yield* sendMessage(threadId, {
        messageId: "inherited-system",
        role: "system",
        turnId: null,
        streaming: false,
        createdAt: at(6),
        occurredAt: at(6),
      });
      assert.equal((yield* threadRow(threadId))?.updatedAt, at(6));
      assert.equal(yield* otherColumnWrites, 0);
    }),
  );

  it.effect("a user-input response claim moves only updated_at", () =>
    Effect.gen(function* () {
      const threadId = "thread-user-input-claim";
      yield* createThread(threadId);
      const otherColumnWrites = yield* probeOtherThreadColumns("user_input_columns", threadId);
      yield* apply("thread.user-input-response-requested", threadId, at(8), {
        threadId,
        requestId: "user-input-claim",
        answers: { answer: "yes" },
        createdAt: at(8),
      });
      assert.equal((yield* threadRow(threadId))?.updatedAt, at(8));
      assert.equal(yield* otherColumnWrites, 0);
    }),
  );
});

it.layer(NarrowPipelineTestLayer)("ProjectionPipeline narrow turn writes", (it) => {
  it.effect("streamed assistant deltas leave an unchanged turn row unwritten", () =>
    Effect.gen(function* () {
      const threadId = "thread-streamed-turn";
      yield* createThread(threadId);
      yield* setRunningSession(threadId, "turn-streamed", at(1));
      const turnWrites = yield* probeRowWrites("streamed_turn", "projection_turns", threadId);

      const delta = (seconds: number, streaming: boolean) =>
        sendMessage(threadId, {
          messageId: "streamed-reply",
          role: "assistant",
          turnId: "turn-streamed",
          streaming,
          createdAt: at(2),
          occurredAt: at(seconds),
        });
      // The first delta binds the reply to the turn; later ones change nothing in the row.
      yield* delta(2, true);
      assert.equal(yield* turnWrites, 1);
      yield* delta(3, true);
      yield* delta(4, true);
      assert.equal(yield* turnWrites, 1);
      // The final message completes the turn.
      yield* delta(5, false);
      assert.equal(yield* turnWrites, 2);
      assert.deepEqual(yield* turnRows(threadId), [
        {
          turnId: "turn-streamed",
          state: "completed",
          assistantMessageId: "streamed-reply",
          checkpointTurnCount: null,
        },
      ]);
    }),
  );

  it.effect("a repeated running session and a repeated interrupt write no turn row", () =>
    Effect.gen(function* () {
      const threadId = "thread-repeated-session";
      yield* createThread(threadId);
      yield* setRunningSession(threadId, "turn-repeated", at(1));
      const turnWrites = yield* probeRowWrites("repeated_session", "projection_turns", threadId);
      yield* setRunningSession(threadId, "turn-repeated", at(2));
      assert.equal(yield* turnWrites, 0);

      const interrupt = (seconds: number) =>
        apply("thread.turn-interrupt-requested", threadId, at(seconds), {
          threadId,
          turnId: "turn-repeated",
          createdAt: at(seconds),
        });
      yield* interrupt(3);
      assert.equal(yield* turnWrites, 1);
      yield* interrupt(4);
      assert.equal(yield* turnWrites, 1);
    }),
  );

  it.effect("every fresh turn row is still created, and a release still ends its turn", () =>
    Effect.gen(function* () {
      const threadId = "thread-fresh-turns";
      yield* createThread(threadId);
      yield* setRunningSession(threadId, "turn-a-session", at(1));
      yield* sendMessage(threadId, {
        messageId: "fresh-reply",
        role: "assistant",
        turnId: "turn-b-message",
        streaming: true,
        createdAt: at(2),
        occurredAt: at(2),
      });
      yield* apply("thread.turn-interrupt-requested", threadId, at(3), {
        threadId,
        turnId: "turn-c-interrupt",
        createdAt: at(3),
      });
      yield* apply("thread.turn-diff-completed", threadId, at(4), {
        threadId,
        turnId: "turn-d-diff",
        checkpointTurnCount: 1,
        checkpointRef: "refs/ryco/checkpoints/1",
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: at(4),
      });
      yield* setRunningSession(threadId, "turn-a-session", at(5), {
        turnId: "turn-b-message",
        state: "interrupted",
        completedAt: at(5),
        reason: "fixture",
      });
      assert.deepEqual(yield* turnRows(threadId), [
        {
          turnId: "turn-a-session",
          state: "running",
          assistantMessageId: null,
          checkpointTurnCount: null,
        },
        {
          turnId: "turn-b-message",
          state: "interrupted",
          assistantMessageId: "fresh-reply",
          checkpointTurnCount: null,
        },
        {
          turnId: "turn-c-interrupt",
          state: "interrupted",
          assistantMessageId: null,
          checkpointTurnCount: null,
        },
        {
          turnId: "turn-d-diff",
          state: "completed",
          assistantMessageId: null,
          checkpointTurnCount: 1,
        },
      ]);

      // A revert re-inserts the turns it keeps.
      yield* apply("thread.reverted", threadId, at(6), { threadId, turnCount: 1 });
      assert.deepEqual(
        (yield* turnRows(threadId)).map((turn) => turn.turnId),
        ["turn-d-diff"],
      );
    }),
  );
});

/**
 * Narrow writes against the full-row writes they replace, over seeded random streams. Both arms
 * run the same projectors, so this proves the repositories equivalent under realistic event
 * sequences, not the projector routing. The routing is pinned by the tests above, and by
 * `scripts/projection-narrow-writes-equivalence.ts`, which runs older server sources.
 */
it.effect("narrow writes leave the same rows as full-row writes on random streams", () =>
  Effect.gen(function* () {
    const runArm = <ROut, E>(
      layer: Layer.Layer<ROut, E>,
      stream: ReadonlyArray<ProjectionStreamEvent>,
    ) =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const dumps: string[] = [];
        let stepsWithPending = 0;
        for (const [index, event] of stream.entries()) {
          yield* applyProjectionStreamEvent(store, pipeline, event, `stream-${index}`);
          dumps.push(yield* dumpNarrowWriteProjections);
          const pending = yield* maxPendingCounts;
          if (pending.approvals > 0 || pending.userInputs > 0) stepsWithPending += 1;
        }
        return { dumps, stepsWithPending };
      }).pipe(Effect.provide(layer));

    for (let seed = 1; seed <= 20; seed++) {
      const stream = makeProjectionEventStream(seed, 120);
      const narrow = yield* runArm(NarrowPipelineTestLayer, stream);
      const fullRow = yield* runArm(FullRowPipelineTestLayer, stream);
      for (const [index, dump] of narrow.dumps.entries()) {
        if (dump !== fullRow.dumps[index]) {
          assert.deepEqual(
            JSON.parse(dump),
            JSON.parse(fullRow.dumps[index]!),
            `seed ${seed}, event ${index} (${stream[index]!.label})`,
          );
        }
      }
      assert.isAbove(narrow.stepsWithPending, 0, `seed ${seed} never held a pending request`);
    }
  }),
);
