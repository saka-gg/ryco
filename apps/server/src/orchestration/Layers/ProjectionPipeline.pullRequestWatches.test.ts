import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type ThreadPullRequestWatch,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { pullRequestWatchUpdateCommandId } from "../pullRequestWatchUpdates.ts";
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
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-projection-pr-watches-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const watchId = "github.com/o/r#12";

const watch = (
  worktreeId: WorktreeId,
  overrides: Partial<ThreadPullRequestWatch> = {},
): ThreadPullRequestWatch => ({
  watchId,
  number: 12,
  url: "https://github.com/o/r/pull/12",
  provider: "github",
  worktreeId,
  revision: 1,
  startedAt: "2026-10-04T10:05:00.000Z",
  startedBy: "user",
  runtimeMode: "full-access",
  worktreePath: null,
  headSha: "abc1234",
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: "2026-10-04T10:05:00.000Z",
  remarkIds: [],
  outsideRemarks: 0,
  conflicting: false,
  wakes: 0,
  news: true,
  requiredChecks: null,
  failingChecks: 2,
  autoFix: {
    status: "fixing",
    pauseReason: null,
    attempts: 1,
    lastHandledHeadSha: "abc1234",
    fixRequestedAt: "2026-10-04T10:06:00.000Z",
  },
  delivery: null,
  beforeWake: null,
  lastChangeAt: "2026-10-04T10:06:00.000Z",
  ...overrides,
});

const setup = (key: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const createdAt = "2026-10-04T10:00:00.000Z";
    const threadId = ThreadId.make(`thread-${key}`);
    const projectId = ProjectId.make(`project-${key}`);
    const worktreeId = WorktreeId.make(`worktree-${key}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${key}`),
      projectId,
      title: "Watch",
      workspaceRoot: `/tmp/project-watch-${key}`,
      defaultModelSelection: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "worktree.create",
      commandId: CommandId.make(`cmd-worktree-${key}`),
      worktreeId,
      projectId,
      branch: "feature/watch",
      worktreePath: null,
      origin: "branch",
      prNumber: 12,
      issueNumber: null,
      prTitle: null,
      issueTitle: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${key}`),
      threadId,
      projectId,
      title: "Watch",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    return { threadId, projectId, worktreeId };
  });

const threadRow = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly updatedAt: string }>`
      SELECT updated_at AS "updatedAt" FROM projection_threads WHERE thread_id = ${threadId}`;
  });

const watchRow = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly watchesJson: string;
      readonly summaryJson: string;
      readonly activeCount: number;
    }>`
      SELECT watches_json AS "watchesJson", summary_json AS "summaryJson",
        active_count AS "activeCount"
      FROM projection_thread_pull_request_watches WHERE thread_id = ${threadId}`;
  });

layer("pull request watch projection", (it) => {
  it.effect(
    "stores full state and a shell summary, leaves the thread row alone, and hydrates the engine",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        const { threadId, worktreeId } = yield* setup("store");
        const [before] = yield* threadRow(threadId);

        // An unwatched thread's shell has no watch key at all.
        const unwatched = yield* query.getThreadShellById(threadId);
        assert.isTrue(Option.isSome(unwatched));
        assert.isFalse("pullRequestWatches" in Option.getOrThrow(unwatched));

        yield* engine.dispatch({
          type: "thread.pull-request-watch.update",
          commandId: pullRequestWatchUpdateCommandId({ threadId, watchId, revision: 1 }),
          threadId,
          watchId,
          expectedRevision: null,
          expectedStartedAt: null,
          next: watch(worktreeId),
          createdAt: "2026-10-04T10:06:00.000Z",
        });

        const [row] = yield* watchRow(threadId);
        assert.equal(row?.activeCount, 1);
        assert.deepEqual(JSON.parse(row!.watchesJson).active, [watch(worktreeId)]);
        // The summary carries no progress internals (check ids, remark watermark, head handled).
        assert.notInclude(row!.summaryJson, "remarksThrough");
        assert.notInclude(row!.summaryJson, "lastHandledHeadSha");
        // Watch progress is not thread activity.
        assert.deepEqual(yield* threadRow(threadId), [before!]);

        const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId));
        assert.deepEqual(shell.pullRequestWatches, {
          active: [
            {
              watchId,
              number: 12,
              url: "https://github.com/o/r/pull/12",
              worktreeId,
              startedAt: "2026-10-04T10:05:00.000Z",
              startedBy: "user",
              news: true,
              autoFix: { status: "fixing", pauseReason: null, attempts: 1, maxAttempts: 3 },
              headSha: "abc1234",
              failingChecks: 2,
              passed: false,
              conflicting: false,
              delivering: false,
              lastChangeAt: "2026-10-04T10:06:00.000Z",
            },
          ],
          ended: [],
        });
        const snapshot = yield* query.getShellSnapshot();
        assert.deepEqual(
          snapshot.threads.find((thread) => thread.id === threadId)?.pullRequestWatches,
          shell.pullRequestWatches,
        );

        // A restarted engine decides on the full state, read back from the table.
        const readModel = yield* query.getCommandReadModel();
        assert.deepEqual(
          readModel.threads.find((thread) => thread.id === threadId)?.pullRequestWatchState,
          { active: [watch(worktreeId)], ended: [] },
        );
      }),
  );

  it.effect("drops the row when the thread is deleted for good", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const { threadId, worktreeId } = yield* setup("delete");
      yield* engine.dispatch({
        type: "thread.pull-request-watch.update",
        commandId: pullRequestWatchUpdateCommandId({ threadId, watchId, revision: 1 }),
        threadId,
        watchId,
        expectedRevision: null,
        expectedStartedAt: null,
        next: watch(worktreeId),
        createdAt: "2026-10-04T10:06:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.trash",
        commandId: CommandId.make("cmd-trash-delete"),
        threadId,
      });
      const [trashed] = yield* watchRow(threadId);
      // Trash ends the watch (it stays listed as ended), deletion forgets the row.
      assert.equal(trashed?.activeCount, 0);
      assert.equal(JSON.parse(trashed!.summaryJson).ended[0].reason, "trashed");
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete"),
        threadId,
      });
      assert.deepEqual(yield* watchRow(threadId), []);
    }),
  );

  it.effect("Undo of a settle starts its watches again", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const { threadId, worktreeId } = yield* setup("undo");
      yield* engine.dispatch({
        type: "thread.pull-request-watch.update",
        commandId: pullRequestWatchUpdateCommandId({ threadId, watchId, revision: 1 }),
        threadId,
        watchId,
        expectedRevision: null,
        expectedStartedAt: null,
        next: watch(worktreeId),
        createdAt: "2026-10-04T10:06:00.000Z",
      });
      const settleCommandId = CommandId.make("cmd-settle-undo");
      yield* engine.dispatch({ type: "thread.settle", commandId: settleCommandId, threadId });
      assert.equal((yield* watchRow(threadId))[0]?.activeCount, 0);

      yield* engine.dispatch({
        type: "thread.sidebar.undo",
        commandId: CommandId.make("cmd-undo-settle"),
        threadId,
        undoCommandId: settleCommandId,
      });
      assert.equal((yield* watchRow(threadId))[0]?.activeCount, 1);
      const readModel = yield* query.getCommandReadModel();
      const state = readModel.threads.find(
        (thread) => thread.id === threadId,
      )?.pullRequestWatchState;
      assert.equal(state?.active[0]?.revision, 2);
      assert.deepEqual(state?.ended, []);
    }),
  );

  it.effect("a projector added by the upgrade rebuilds the table from the event log", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const { threadId, worktreeId } = yield* setup("replay");
      yield* engine.dispatch({
        type: "thread.pull-request-watch.update",
        commandId: pullRequestWatchUpdateCommandId({ threadId, watchId, revision: 1 }),
        threadId,
        watchId,
        expectedRevision: null,
        expectedStartedAt: null,
        next: watch(worktreeId, { news: false }),
        createdAt: "2026-10-04T10:06:00.000Z",
      });
      const before = yield* watchRow(threadId);

      yield* sql`DELETE FROM projection_thread_pull_request_watches`;
      yield* sql`DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadPullRequestWatches}`;
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* watchRow(threadId), before);
    }),
  );

  it.effect("an update with a wake commits the watch and the queued turn together", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const { threadId, projectId, worktreeId } = yield* setup("wake");
      const messageId = MessageId.make(`pull-request-watch:${threadId}:wake-1`);
      yield* engine.dispatch({
        type: "thread.pull-request-watch.update",
        commandId: pullRequestWatchUpdateCommandId({ threadId, watchId, revision: 1 }),
        threadId,
        watchId,
        expectedRevision: null,
        expectedStartedAt: null,
        next: watch(worktreeId, {
          autoFix: null,
          delivery: { messageId, kind: "news", sentAt: "2026-10-04T10:06:00.000Z" },
        }),
        wake: {
          messageId,
          text: "Ryco pull request update: checks failed.",
          guard: {
            latestUserMessageId: null,
            projectId,
            runtimeMode: "full-access",
            worktreePath: null,
          },
        },
        createdAt: "2026-10-04T10:06:00.000Z",
      });
      const messages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_messages
        WHERE thread_id = ${threadId}`;
      assert.deepEqual(
        messages.map((row) => row.messageId),
        [messageId],
      );
      const pendingTurns = yield* sql<{ readonly state: string }>`
        SELECT state FROM projection_turns WHERE thread_id = ${threadId}`;
      assert.deepEqual(
        pendingTurns.map((row) => row.state),
        ["pending"],
      );
      const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId));
      assert.isTrue(shell.pullRequestWatches?.active[0]?.delivering);
    }),
  );
});
