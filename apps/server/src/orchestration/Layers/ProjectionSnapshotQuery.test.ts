import { encodeMessageTextFallback, messageTextForSearch } from "../../persistence/messageText.ts";
import { derivePendingThreadRequestState } from "@ryco/shared/threadActivity";
import {
  CheckpointRef,
  DEFAULT_AGENT_TOKEN_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  WorktreeId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlStatement from "effect/sql/Statement";

import { makeCompletionReturnRepository } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  takeNewestRowsWithinByteBudget,
  THREAD_WINDOW_ACTIVITY_MAX_PAYLOAD_BYTES,
} from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import {
  ProjectionSnapshotQuery,
  scopeShellSnapshot,
} from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const availableIdentity = {
  canonicalKey: "github.com/acme/available",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/available.git",
  },
  rootPath: "/tmp/available",
  remotes: [],
};

it.effect("serves persisted repository identities without probing git on any read path", () => {
  const resolveCalls: string[] = [];
  const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      // A stalled probe used to cost the shell its 1 s budget; nothing may call it now.
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: (cwd) =>
          Effect.suspend(() => {
            resolveCalls.push(cwd);
            return Effect.never;
          }),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    for (let index = 0; index < 12; index++) {
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, repository_identity_json
        ) VALUES (
          ${`project-${index}`}, ${`Project ${index}`},
          ${index === 0 ? "/tmp/available" : `/tmp/unavailable-${index}`},
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z',
          ${index === 0 ? JSON.stringify(availableIdentity) : index === 1 ? "{not json" : null}
        )
      `;
    }
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        'previous-thread', 'project-11', 'Previous conversation',
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
        '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
      )
    `;

    const shell = yield* query.getShellSnapshot();
    assert.equal(shell.projects.length, 12);
    assert.deepEqual(
      shell.projects.find((project) => project.id === "project-0")?.repositoryIdentity,
      availableIdentity,
    );
    // An unreadable cached value is treated as unknown, never as a failed snapshot.
    assert.isNull(shell.projects.find((project) => project.id === "project-1")?.repositoryIdentity);
    assert.isNull(
      shell.projects.find((project) => project.id === "project-11")?.repositoryIdentity,
    );
    assert.equal(shell.threads[0]?.title, "Previous conversation");

    const project = yield* query.getProjectShellById(ProjectId.make("project-0"));
    assert.equal(
      Option.getOrNull(project)?.repositoryIdentity?.canonicalKey,
      "github.com/acme/available",
    );
    const byRoot = yield* query.getActiveProjectByWorkspaceRoot("/tmp/available");
    assert.equal(
      Option.getOrNull(byRoot)?.repositoryIdentity?.canonicalKey,
      "github.com/acme/available",
    );
    const full = yield* query.getSnapshot();
    assert.equal(
      full.projects.find((entry) => entry.id === "project-0")?.repositoryIdentity?.canonicalKey,
      "github.com/acme/available",
    );
    assert.deepEqual(resolveCalls, []);
  }).pipe(Effect.provide(layer));
});

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("looks up latest turns by thread without scanning turn history", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      for (const threadId of ["latest-lookup-active", "latest-lookup-deleted"]) {
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, latest_turn_id, deleted_at
        ) VALUES (
          ${threadId}, 'latest-lookup-project', ${threadId},
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 'latest-lookup-turn-64',
          ${threadId.endsWith("deleted") ? "2026-09-12T00:00:00.000Z" : null}
        )`;
        yield* sql`WITH RECURSIVE history(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 64
        ) INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
        SELECT ${threadId}, 'latest-lookup-turn-' || n, 'completed',
          '2026-09-12T00:00:00.000Z', '2026-09-12T00:01:00.000Z', '[]' FROM history`;
      }
      const latestQueries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const capture: SqlStatement.Transformer = (statement) =>
        Effect.sync(() => {
          const compiled = statement.compile();
          if (compiled[0].includes("JOIN projection_turns turns")) latestQueries.push(compiled);
          return statement;
        });
      const shell = yield* query
        .getShellSnapshot()
        .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));
      yield* query
        .getCommandReadModel()
        .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));
      assert.equal(
        shell.threads.find((thread) => thread.id === "latest-lookup-active")?.latestTurn?.turnId,
        "latest-lookup-turn-64",
      );
      assert.isFalse(shell.threads.some((thread) => thread.id === "latest-lookup-deleted"));
      assert.equal(latestQueries.length, 2);
      for (const [statement, params] of latestQueries) {
        const rows = yield* sql.unsafe(statement, params);
        const previousRows = yield* sql.unsafe(
          statement.replace("ORDER BY threads.thread_id ASC", "ORDER BY turns.thread_id ASC"),
          params,
        );
        assert.deepEqual(rows, previousRows);
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
          params,
        );
        assert.isTrue(
          plan.some((row) => /SEARCH turns .*thread_id=\? AND turn_id=\?/.test(row.detail)),
          JSON.stringify(plan),
        );
        assert.isFalse(
          plan.some((row) => /SCAN turns/.test(row.detail)),
          JSON.stringify(plan),
        );
      }
      yield* sql`DELETE FROM projection_turns WHERE thread_id IN ('latest-lookup-active', 'latest-lookup-deleted')`;
      yield* sql`DELETE FROM projection_threads WHERE thread_id IN ('latest-lookup-active', 'latest-lookup-deleted')`;
    }),
  );

  it.effect(
    "walks the requested-at index backwards for completion recency, without sorting turns",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("completion-plan-fork");
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          ${threadId}, 'completion-plan-project', 'Completion plan',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
        )`;
        const insertTurn = (turnId: string, assistantMessageId: string, at: string) =>
          sql`INSERT INTO projection_turns (
            thread_id, turn_id, assistant_message_id, state, requested_at, started_at,
            completed_at, checkpoint_files_json
          ) VALUES (${threadId}, ${turnId}, ${assistantMessageId}, 'completed', ${at}, ${at}, ${at}, '[]')`;
        const recency = Effect.gen(function* () {
          const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId));
          const snapshot = yield* query.getShellSnapshot();
          const listed = snapshot.threads.find((thread) => thread.id === threadId);
          assert.equal(listed?.latestCompletedTurnAt, shell.latestCompletedTurnAt);
          return shell.latestCompletedTurnAt;
        });
        // A fork's inherited turn is its source's history, not completion of the fork.
        yield* insertTurn(
          "turn-inherited",
          `${threadId}:inherited:message-answer`,
          "2026-09-12T00:01:00.000Z",
        );
        assert.isNull(yield* recency);
        yield* insertTurn("turn-own", "message-own", "2026-09-12T00:02:00.000Z");
        assert.equal(yield* recency, "2026-09-12T00:02:00.000Z");

        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        const capture: SqlStatement.Transformer = (statement) =>
          Effect.sync(() => {
            const compiled = statement.compile();
            if (compiled[0].includes('AS "latestCompletedTurnAt"')) statements.push(compiled);
            return statement;
          });
        yield* query
          .getThreadShellById(threadId)
          .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));
        yield* query
          .getShellSnapshot()
          .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));
        yield* query
          .getCommandReadModel()
          .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));
        assert.isAtLeast(statements.length, 3);
        for (const [statement, params] of statements) {
          const plan = yield* sql.unsafe<{ id: number; parent: number; detail: string }>(
            `EXPLAIN QUERY PLAN ${statement}`,
            params,
          );
          // The shell is re-read for every thread event, per subscriber: recency is a
          // trigger-maintained column (migration 087), so no read touches the turn history.
          assert.isFalse(
            plan.some((row) => /\b(projection_turns|turns)\b/.test(row.detail)),
            JSON.stringify(plan),
          );
        }
        yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
      }),
  );

  it.effect(
    "keeps inbox completion recency stable during live turns in snapshots and shell updates",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("inbox-recency-thread");
        yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'inbox-recency-project', 'Inbox recency',
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
      )`;
        const assertRecency = (expected: string | null) =>
          Effect.gen(function* () {
            const shell = yield* query.getThreadShellById(threadId);
            assert.isTrue(Option.isSome(shell));
            if (Option.isSome(shell)) assert.equal(shell.value.latestCompletedTurnAt, expected);
            const snapshot = yield* query.getShellSnapshot();
            assert.equal(
              snapshot.threads.find((thread) => thread.id === threadId)?.latestCompletedTurnAt,
              expected,
            );
          });
        yield* assertRecency(null);
        yield* sql`INSERT INTO projection_turns (
        thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json
      ) VALUES
        (${threadId}, 'inbox-completed', 'completed', '2026-09-12T00:00:00.000Z', '2026-09-12T00:01:00.000Z', '[]'),
        (${threadId}, 'inbox-current', 'running', '2026-09-12T00:02:00.000Z', NULL, '[]'),
        ('other-inbox-thread', 'inbox-foreign', 'completed', '2026-09-12T00:03:00.000Z', '2026-09-12T00:04:00.000Z', '[]')`;
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES (${threadId}, 'running', 'inbox-current', '2026-09-12T00:02:00.000Z')`;
        yield* assertRecency("2026-09-12T00:01:00.000Z");
        // Commentary can mark a message/turn completed before the provider is done.
        yield* sql`UPDATE projection_turns SET state = 'completed', completed_at = '2026-09-12T00:03:00.000Z'
        WHERE thread_id = ${threadId} AND turn_id = 'inbox-current'`;
        yield* sql`UPDATE projection_threads SET updated_at = '2026-09-12T00:04:00.000Z' WHERE thread_id = ${threadId}`;
        yield* assertRecency("2026-09-12T00:01:00.000Z");
        yield* sql`UPDATE projection_thread_sessions SET status = 'ready', active_turn_id = NULL WHERE thread_id = ${threadId}`;
        for (const state of ["error", "interrupted"]) {
          yield* sql`UPDATE projection_turns SET state = ${state} WHERE thread_id = ${threadId} AND turn_id = 'inbox-current'`;
          yield* assertRecency("2026-09-12T00:01:00.000Z");
        }
        yield* sql`UPDATE projection_turns SET state = 'completed', completed_at = '2026-09-12T00:05:00.000Z'
        WHERE thread_id = ${threadId} AND turn_id = 'inbox-current'`;
        yield* assertRecency("2026-09-12T00:05:00.000Z");
        yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_turns WHERE thread_id IN (${threadId}, 'other-inbox-thread')`;
        yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
      }),
  );

  it.effect("side questions use only successful terminal turns scoped to their thread", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      for (const state of ["completed", "running", "interrupted", "error", "pending"]) {
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
          VALUES ('side-context-thread', ${`side-${state}`}, ${state}, '2026-09-12T00:00:00.000Z', '[]')`;
      }
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
        VALUES ('another-side-thread', 'foreign-completed', 'completed', '2026-09-12T00:00:00.000Z', '[]')`;
      for (const state of ["completed", "running", "interrupted", "error", "pending"]) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${`side-message-${state}`}, 'side-context-thread', ${`side-${state}`}, 'assistant', ${state}, 0, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES (${`side-activity-${state}`}, 'side-context-thread', ${`side-${state}`}, 'tool', 'tool', ${state}, '{}', '2026-09-12T00:00:00.000Z')`;
      }
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('side-streaming', 'side-context-thread', 'side-completed', 'assistant', 'partial', 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`;
      // A very long live turn must not displace or count against completed context.
      for (let index = 0; index < 220; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${`side-active-${index}`}, 'side-context-thread', 'side-running', 'assistant', 'active', 0, '2026-09-12T00:00:01.000Z', '2026-09-12T00:00:01.000Z')`;
      }
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('side-user', 'side-context-thread', NULL, 'user', 'original question', 0, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'),
               ('side-queued', 'side-context-thread', NULL, 'user', 'queued', 0, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')`;
      yield* sql`UPDATE projection_turns SET pending_message_id = 'side-user' WHERE turn_id = 'side-completed'`;
      // Non-streaming assistant items mark a turn completed before its lifecycle ends.
      yield* sql`UPDATE projection_turns SET state = 'completed' WHERE turn_id = 'side-running'`;
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES ('side-context-thread', 'running', 'side-running', '2026-09-12T00:00:01.000Z')`;
      const context = yield* query.getCompletedSideQuestionContext!(
        ThreadId.make("side-context-thread"),
      );
      assert.deepStrictEqual(
        context.messages.map((message) => message.text),
        ["original question", "completed"],
      );
      assert.deepStrictEqual(
        context.activities.map((activity) => activity.summary),
        ["completed"],
      );
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = 'side-context-thread'`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = 'side-context-thread'`;
      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = 'side-context-thread'`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id IN ('side-context-thread', 'another-side-thread')`;
    }),
  );

  it.effect("lists the newest pending checkpoint revert per live thread", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threads = ["revert-pending", "revert-terminal", "revert-deleted"] as const;
      for (const threadId of threads) {
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, deleted_at
        ) VALUES (
          ${threadId}, 'revert-project', ${threadId},
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z',
          ${threadId === "revert-deleted" ? "2026-09-12T00:00:00.000Z" : null}
        )`;
      }
      const insertRevert = (threadId: string, id: string, status: string, createdAt: string) =>
        sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES (${`checkpoint-revert:${threadId}-${id}`}, ${threadId}, NULL, 'info', 'checkpoint.revert', 'Revert',
            ${JSON.stringify({ schemaVersion: 1, revertRequestId: `${threadId}-${id}`, turnCount: 1, status, cwd: "/repo" })},
            ${createdAt})`;
      yield* insertRevert("revert-pending", "old", "completed", "2026-09-12T00:00:00.000Z");
      yield* insertRevert("revert-pending", "new", "restoring-files", "2026-09-12T00:01:00.000Z");
      yield* insertRevert("revert-terminal", "old", "rolling-back", "2026-09-12T00:00:00.000Z");
      yield* insertRevert("revert-terminal", "new", "failed", "2026-09-12T00:01:00.000Z");
      yield* insertRevert("revert-deleted", "gone", "requested", "2026-09-12T00:00:00.000Z");

      const pending = yield* query.listPendingCheckpointReverts!();

      assert.deepStrictEqual(
        pending.map((entry) => ({
          threadId: String(entry.threadId),
          id: String(entry.activity.id),
          status: entry.payload.status,
          cwd: entry.payload.cwd,
        })),
        [
          {
            threadId: "revert-pending",
            id: "checkpoint-revert:revert-pending-new",
            status: "restoring-files",
            cwd: "/repo",
          },
        ],
      );
      yield* sql`DELETE FROM projection_thread_activities WHERE kind = 'checkpoint.revert'`;
      yield* sql`DELETE FROM projection_threads WHERE thread_id IN ('revert-pending', 'revert-terminal', 'revert-deleted')`;
    }),
  );

  it.effect("reads one thread's newest checkpoint revert, whatever its status", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const insertRevert = (
        threadId: string,
        id: string,
        status: string,
        createdAt: string,
        sequence: number | null,
      ) =>
        sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES (${`checkpoint-revert:${threadId}-${id}`}, ${threadId}, NULL, 'info', 'checkpoint.revert', 'Revert',
            ${JSON.stringify({ schemaVersion: 1, revertRequestId: `${threadId}-${id}`, turnCount: 1, status })},
            ${sequence}, ${createdAt})`;
      // The sequenced entry is newer than an unsequenced one with a later timestamp.
      yield* insertRevert(
        "revert-own",
        "unsequenced",
        "requested",
        "2026-09-12T00:05:00.000Z",
        null,
      );
      yield* insertRevert("revert-own", "old", "rolling-back", "2026-09-12T00:00:00.000Z", 4);
      yield* insertRevert("revert-own", "new", "completed", "2026-09-12T00:01:00.000Z", 9);
      yield* insertRevert("revert-other", "pending", "requested", "2026-09-12T00:02:00.000Z", 12);
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES ('revert-own-tool', 'revert-own', NULL, 'tool', 'tool', 'Tool', '{}', 20, '2026-09-12T00:03:00.000Z')`;

      const own = yield* query.getLatestCheckpointRevert!(ThreadId.make("revert-own"));
      const none = yield* query.getLatestCheckpointRevert!(ThreadId.make("revert-none"));

      assert.deepStrictEqual(
        own === null ? null : { id: String(own.activity.id), status: own.payload.status },
        { id: "checkpoint-revert:revert-own-new", status: "completed" },
      );
      assert.equal(none, null);
      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id IN ('revert-own', 'revert-other')`;
    }),
  );

  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          settled_override,
          settled_at,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'settled',
          '2026-02-24T00:00:02.500Z',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          kind: "project",
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          projectMetadataDir: ".ryco",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          customAvatarContentHash: null,
          preferredRemoteName: null,
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          tokenMode: DEFAULT_AGENT_TOKEN_MODE,
          branch: null,
          worktreePath: null,
          worktreeId: null,
          manualStatusBucket: null,
          manualPosition: 0,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          goal: null,
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: "settled",
          settledAt: "2026-02-24T00:00:02.500Z",
          snoozedUntil: null,
          snoozedAt: null,
          usageLimit: null,
          deletedAt: null,
          trashedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [
                {
                  path: "README.md",
                  kind: "modified",
                  additions: 2,
                  deletions: 1,
                },
              ],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            tokenMode: DEFAULT_AGENT_TOKEN_MODE,
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          kind: "project",
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          projectMetadataDir: ".ryco",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          customSystemPrompt: null,
          customAvatarContentHash: null,
          preferredRemoteName: null,
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          tokenMode: DEFAULT_AGENT_TOKEN_MODE,
          branch: null,
          worktreePath: null,
          worktreeId: null,
          manualStatusBucket: null,
          manualPosition: 0,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          goal: null,
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: "settled",
          settledAt: "2026-02-24T00:00:02.500Z",
          snoozedUntil: null,
          snoozedAt: null,
          usageLimit: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            tokenMode: DEFAULT_AGENT_TOKEN_MODE,
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          latestCompletedTurnAt: null,
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          backgroundLiveness: null,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
        const thread = threadDetail.value;
        assert.equal(
          yield* snapshotQuery.countThreadUserMessages!(thread.id),
          thread.messages.filter((message) => message.role === "user").length,
        );
        for (const message of thread.messages) {
          const targeted = yield* snapshotQuery.getThreadMessageById!({
            threadId: thread.id,
            messageId: message.id,
          });
          assert.equal(targeted._tag, "Some");
          if (targeted._tag === "Some") assert.deepEqual(targeted.value, message);
          const wrongThread = yield* snapshotQuery.getThreadMessageById!({
            threadId: ThreadId.make("other-thread"),
            messageId: message.id,
          });
          assert.equal(wrongThread._tag, "None");
          // Messages recorded by this one's instant, a same-instant one included.
          const recordedBy = thread.messages.filter(
            (entry) => entry.role === "user" && entry.createdAt <= message.createdAt,
          );
          assert.equal(
            yield* snapshotQuery.countThreadUserMessages!(thread.id, {
              createdAtOrBefore: message.createdAt,
            }),
            recordedBy.length,
          );
          assert.equal(
            yield* snapshotQuery.countThreadUserMessages!(thread.id, {
              createdAtOrBefore: message.createdAt,
              excludingMessageId: message.id,
            }),
            recordedBy.filter((entry) => entry.id !== message.id).length,
          );
        }
      }
    }),
  );

  it.effect("searches active thread messages with project scoping and escaped wildcards", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-search-a',
            'Search A',
            '/tmp/search-a',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            NULL
          ),
          (
            'project-search-b',
            'Search B',
            '/tmp/search-b',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'thread-search-a',
            'project-search-a',
            'Authentication Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            NULL
          ),
          (
            'thread-search-b',
            'project-search-b',
            'Other Authentication Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            NULL
          ),
          (
            'thread-search-deleted',
            'project-search-a',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-search-a',
            'thread-search-a',
            NULL,
            'user',
            'Please inspect the authentication redirect flow and token cache.',
            0,
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'message-search-b',
            'thread-search-b',
            NULL,
            'assistant',
            'Authentication failures now return a stable retry message.',
            0,
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:03.000Z'
          ),
          (
            'message-search-wildcard',
            'thread-search-a',
            NULL,
            'assistant',
            'Literal 100% coverage is not required for this authentication fix.',
            0,
            '2026-03-01T00:00:04.000Z',
            '2026-03-01T00:00:04.000Z'
          ),
          (
            'message-search-deleted',
            'thread-search-deleted',
            NULL,
            'assistant',
            'authentication from deleted thread',
            0,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:05.000Z'
          )
      `;

      const allResults = yield* snapshotQuery.searchThreadMessages({
        query: "authentication",
        limit: 10,
      });
      assert.deepEqual(
        allResults.map((result) => result.messageId),
        [
          asMessageId("message-search-wildcard"),
          asMessageId("message-search-b"),
          asMessageId("message-search-a"),
        ],
      );
      assert.include(allResults[0]?.snippet ?? "", "authentication fix");
      assert.isDefined(allResults[0]?.historyCursor);

      const threadResults = yield* snapshotQuery.searchThreadMessages({
        query: "authentication",
        threadId: ThreadId.make("thread-search-b"),
        limit: 10,
      });
      assert.deepEqual(
        threadResults.map((result) => result.messageId),
        [asMessageId("message-search-b")],
      );

      const projectResults = yield* snapshotQuery.searchThreadMessages({
        query: "authentication",
        projectId: asProjectId("project-search-b"),
        limit: 10,
      });
      assert.deepEqual(
        projectResults.map((result) => result.threadId),
        [ThreadId.make("thread-search-b")],
      );

      const wildcardResults = yield* snapshotQuery.searchThreadMessages({
        query: "100%",
        limit: 10,
      });
      assert.deepEqual(
        wildcardResults.map((result) => result.messageId),
        [asMessageId("message-search-wildcard")],
      );

      // Compare the indexed path against the previous exact predicate over
      // punctuation, Unicode, JSON fallback bodies, and split streaming text.
      const bodies = [
        "Alpha_100% mixed CASE",
        "alphaX100x",
        "Ünicode 日本語 alpha",
        "before\0alpha after",
        "plain short",
        "foo\\bar",
        'quotes " AND OR',
        "😀alpha",
        "lone \ud800 alpha",
      ];
      for (const [index, body] of bodies.entries()) {
        yield* sql`INSERT INTO projection_thread_messages(message_id, thread_id, role, text, text_json, is_streaming, created_at, updated_at)
          VALUES(${`parity-${index}`}, 'thread-search-a', 'assistant', ${body}, ${encodeMessageTextFallback(body)}, 0, '2026-03-01T01:00:00.000Z', '2026-03-01T01:00:00.000Z')`;
      }
      yield* sql`INSERT INTO projection_thread_messages(message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES('parity-stream', 'thread-search-a', 'assistant', 'alp', 1, '2026-03-01T01:00:00.000Z', '2026-03-01T01:00:00.000Z')`;
      yield* sql`INSERT INTO projection_message_chunks(message_id, event_sequence, text_json) VALUES('parity-stream', 1, '"ha_100% streamed"')`;
      for (const query of [
        "alpha",
        "ALPHA_100%",
        "100%",
        "日本語",
        "Ünicode",
        "lo",
        "%",
        "_",
        "foo\\bar",
        "AND OR",
        "😀alpha",
        "before\0alpha",
        "missing-token",
        "uthent",
      ]) {
        const pattern = `%${query
          .trim()
          .toLowerCase()
          .replace(/[\\%_]/g, "\\$&")}%`;
        const expected = yield* sql<{ messageId: string }>`SELECT messages.message_id AS "messageId"
          FROM projection_thread_messages messages
          WHERE messages.thread_id = 'thread-search-a'
            AND lower(${messageTextForSearch(sql, "messages")}) LIKE ${pattern} ESCAPE '\\'
          ORDER BY messages.created_at DESC, messages.message_id DESC LIMIT 50`;
        const actual = yield* snapshotQuery.searchThreadMessages({
          query,
          threadId: ThreadId.make("thread-search-a"),
          limit: 50,
        });
        assert.deepEqual(
          actual.map((row) => row.messageId),
          expected.map((row) => row.messageId),
          query,
        );
      }
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            -- Never decoded for the context: no reader needs a checkpoint's file list.
            'not a file list'
          )
      `;

      yield* Effect.gen(function* () {
        const context = yield* snapshotQuery.getThreadCheckpointContext(
          ThreadId.make("thread-context"),
        );
        assert.equal(context._tag, "Some");
        if (context._tag === "Some") {
          assert.deepEqual(context.value, {
            threadId: ThreadId.make("thread-context"),
            projectId: asProjectId("project-context"),
            workspaceRoot: "/tmp/context-workspace",
            worktreePath: "/tmp/context-worktree",
            checkpoints: [
              {
                turnId: asTurnId("turn-1"),
                checkpointTurnCount: 1,
                checkpointRef: asCheckpointRef("checkpoint-a"),
                status: "ready",
                assistantMessageId: null,
                completedAt: "2026-03-02T00:00:04.000Z",
              },
              {
                turnId: asTurnId("turn-2"),
                checkpointTurnCount: 2,
                checkpointRef: asCheckpointRef("checkpoint-b"),
                status: "ready",
                assistantMessageId: null,
                completedAt: "2026-03-02T00:00:05.000Z",
              },
            ],
          });
        }
      }).pipe(
        // Later tests read every checkpoint, files included, so the bad row goes either way.
        Effect.ensuring(
          sql`DELETE FROM projection_turns WHERE thread_id = 'thread-context'`.pipe(Effect.orDie),
        ),
      );
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const cacheReviewWindow = yield* snapshotQuery.getThreadWindow!({
        threadId: ThreadId.make("thread-1"),
        limits: { messages: 1, activities: 1, proposedPlans: 1, checkpoints: 1 },
      });
      assert.equal(cacheReviewWindow.thread.latestTurn?.userMessageId, "message-user-2");

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
        assert.equal(threadDetail.value.latestTurn?.userMessageId, "message-user-2");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-user-first',
            'thread-1',
            'turn-completed',
            'user',
            'first user turn',
            0,
            '2026-04-03T00:00:04.000Z',
            '2026-04-03T00:00:04.000Z'
          ),
          (
            'message-user-second',
            'thread-1',
            'turn-running',
            'user',
            'second user turn',
            0,
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-approval-requested',
            'thread-1',
            'turn-running',
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-1"}',
            4,
            '2026-04-03T00:00:31.000Z'
          ),
          (
            'activity-runtime-note',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'Not needed by command invariants',
            '{}',
            5,
            '2026-04-03T00:00:32.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'activity-approval-stale', 'thread-1', 'turn-running', 'info',
          'provider.approval.respond.failed', 'Request no longer exists',
          '{"requestId":"approval-1","detail":"Unknown pending approval request"}',
          6, '2026-04-03T00:00:33.000Z'
        ), (
          'activity-input-requested', 'thread-1', 'turn-running', 'info',
          'user-input.requested', 'Question', '{"requestId":"input-1"}',
          7, '2026-04-03T00:00:34.000Z'
        ), (
          'activity-input-stale', 'thread-1', 'turn-running', 'info',
          'provider.user-input.respond.failed', 'Request no longer exists',
          '{"requestId":"input-1","detail":"Stale pending user-input request"}',
          8, '2026-04-03T00:00:35.000Z'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");
      // Intended: the command model hydrates the first AND latest user message anchors.
      assert.deepEqual(
        commandReadModel.threads[0]?.messages.map((message) => message.id),
        [asMessageId("message-user-first"), asMessageId("message-user-second")],
      );
      assert.deepEqual(
        commandReadModel.threads[0]?.activities.map((activity) => activity.id),
        [
          "activity-approval-requested",
          "activity-approval-stale",
          "activity-input-requested",
          "activity-input-stale",
        ].map(asEventId),
      );

      assert.equal(
        derivePendingThreadRequestState(commandReadModel.threads[0]!.activities)
          .hasPendingApprovals,
        false,
      );
      assert.equal(
        derivePendingThreadRequestState(commandReadModel.threads[0]!.activities)
          .hasPendingUserInput,
        false,
      );

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("hydrates first and latest user message anchors for the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* makeCompletionReturnRepository;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      const at = (second: number) => `2026-05-01T00:00:0${second}.000Z`;
      const expectedAnchors: Record<string, ReadonlyArray<string>> = {
        "t-many": ["m1", "m3"],
        "t-single": ["s1"],
        "t-none": [],
        // First by message_id among equal created_at, latest by insertion order (rowid).
        "t-tie": ["tie-a", "tie-b"],
        // First and latest resolve to the same row, which is hydrated once.
        "t-tie-same": ["tie2-a"],
      };
      for (const threadId of Object.keys(expectedAnchors)) {
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, latest_turn_id, deleted_at
        ) VALUES (
          ${threadId}, 'anchor-project', ${threadId},
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          ${at(0)}, ${at(0)}, NULL, NULL
        )`;
      }
      // Insert order sets rowid, which breaks created_at ties for the latest anchor.
      const messageRows: ReadonlyArray<
        readonly [threadId: string, messageId: string, role: "user" | "assistant", second: number]
      > = [
        ["t-many", "m1", "user", 1],
        ["t-many", "a1", "assistant", 2],
        ["t-many", "m2", "user", 3],
        ["t-many", "m3", "user", 5],
        ["t-many", "a3", "assistant", 6],
        ["t-single", "s1", "user", 1],
        ["t-single", "sa", "assistant", 2],
        ["t-none", "na", "assistant", 2],
        ["t-tie", "tie-c", "user", 4],
        ["t-tie", "tie-a", "user", 4],
        ["t-tie", "tie-b", "user", 4],
        ["t-tie-same", "tie2-b", "user", 4],
        ["t-tie-same", "tie2-c", "user", 4],
        ["t-tie-same", "tie2-a", "user", 4],
      ];
      for (const [threadId, messageId, role, second] of messageRows) {
        yield* sql`INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          ${messageId}, ${threadId}, NULL, ${role}, ${`text ${messageId}`}, 0,
          ${at(second)}, ${at(second)}
        )`;
      }

      const anchorQueries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const capture: SqlStatement.Transformer = (statement) =>
        Effect.sync(() => {
          const compiled = statement.compile();
          if (compiled[0].includes("threads.first_user_message_id")) {
            anchorQueries.push(compiled);
          }
          return statement;
        });
      const commandReadModel = yield* snapshotQuery
        .getCommandReadModel()
        .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));

      // A1: exactly the first and latest user message anchors, in order.
      assert.deepEqual(
        Object.fromEntries(
          commandReadModel.threads.map((thread) => [
            thread.id,
            thread.messages.map((message) => message.id),
          ]),
        ),
        expectedAnchors,
      );

      // A2: lockstep with CompletionReturnDelivery's latest-user-message read.
      assert.equal(commandReadModel.threads.length, Object.keys(expectedAnchors).length);
      for (const thread of commandReadModel.threads) {
        assert.equal(
          thread.messages.findLast((message) => message.role === "user")?.id ?? null,
          yield* repository.latestUserMessageId(thread.id),
          thread.id,
        );
      }

      // A3: anchors are primary-key lookups of the trigger-maintained ids (migration 087);
      // no read walks a thread's message history.
      assert.equal(anchorQueries.length, 1);
      const [anchorStatement, anchorParams] = anchorQueries[0]!;
      const plan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${anchorStatement}`,
        anchorParams,
      );
      const planText = JSON.stringify(plan);
      assert.isFalse(
        plan.some((row) => /SCAN messages\b/.test(row.detail)),
        planText,
      );
      assert.isTrue(
        plan.some((row) => /SEARCH messages .*\(message_id=\?\)/.test(row.detail)),
        planText,
      );
      // Anchors carry no text: the engine only needs their id, role and order.
      for (const thread of commandReadModel.threads) {
        for (const message of thread.messages) assert.equal(message.text, "");
      }

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
    }),
  );

  it.effect("reports the directory a thread's next turn runs in with its window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'project-cwd', 'Chat', '/chats/pelican', NULL, '[]',
          '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        )
        VALUES
          ('thread-root', 'project-cwd', 'Root', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', NULL, NULL, NULL,
           '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', NULL),
          ('thread-worktree', 'project-cwd', 'Worktree', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', 'feature', '/worktrees/pelican-feature', NULL,
           '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', NULL)
      `;
      const windowOf = (threadId: string) =>
        snapshotQuery.getThreadWindow!({
          threadId: ThreadId.make(threadId),
          limits: { messages: 1, activities: 1, proposedPlans: 1, checkpoints: 1 },
        });

      assert.equal((yield* windowOf("thread-root")).workspaceCwd, "/chats/pelican");
      assert.equal((yield* windowOf("thread-worktree")).workspaceCwd, "/worktrees/pelican-feature");
      // "Turn into project…" moves the chat's folder: the window follows the new root.
      yield* sql`
        UPDATE projection_projects SET workspace_root = '/projects/pelican'
        WHERE project_id = 'project-cwd'
      `;
      assert.equal((yield* windowOf("thread-root")).workspaceCwd, "/projects/pelican");

      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
    }),
  );

  it.effect("paginates message history to the most recent page for high-volume threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'project-paged',
            'Paged Project',
            '/tmp/paged-project',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-05-01T00:00:00.000Z',
            '2026-05-01T00:00:01.000Z',
            NULL
          )
        `;

      yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            latest_turn_id,
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'thread-paged',
            'project-paged',
            'Paged Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-05-01T00:00:02.000Z',
            '2026-05-01T00:00:03.000Z',
            NULL
          )
        `;

      const totalMessages = 1_000;
      const baseTime = Date.parse("2026-05-01T01:00:00.000Z");
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: totalMessages }, (_unused, index) => index),
          (index) => {
            const messageId = `message-${String(index).padStart(4, "0")}`;
            const createdAt = new Date(baseTime + index * 1_000).toISOString();
            return sql`
                INSERT INTO projection_thread_messages (
                  message_id,
                  thread_id,
                  turn_id,
                  role,
                  text,
                  is_streaming,
                  created_at,
                  updated_at
                )
                VALUES (
                  ${messageId},
                  'thread-paged',
                  'turn-paged',
                  'assistant',
                  ${`body ${index}`},
                  0,
                  ${createdAt},
                  ${createdAt}
                )
              `;
          },
          { discard: true },
        ),
      );

      const startedAt = Date.now();
      const threadWindow = yield* snapshotQuery.getThreadWindow!({
        threadId: ThreadId.make("thread-paged"),
        limits: {
          messages: 100,
          proposedPlans: 10,
          activities: 50,
          checkpoints: 10,
        },
      });
      const oldestMessageCursor = threadWindow.history.messages.oldestCursor;
      assert.isNotNull(oldestMessageCursor);
      const olderPage = yield* snapshotQuery.getThreadHistoryPage!({
        threadId: ThreadId.make("thread-paged"),
        collection: "messages",
        mode: { kind: "before", cursor: oldestMessageCursor! },
        limit: 100,
      });
      const aroundPage = yield* snapshotQuery.getThreadHistoryPage!({
        threadId: ThreadId.make("thread-paged"),
        collection: "messages",
        mode: { kind: "around", anchorId: asMessageId("message-0123") },
        limit: 21,
      });
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-paged"));
      const snapshot = yield* snapshotQuery.getSnapshot();
      const elapsedMs = Date.now() - startedAt;

      assert.isBelow(elapsedMs, 2_000);
      assert.equal(threadWindow.thread.messages.length, 100);
      assert.equal(threadWindow.thread.messages[0]?.id, asMessageId("message-0900"));
      assert.equal(threadWindow.thread.messages[99]?.id, asMessageId("message-0999"));
      assert.isTrue(threadWindow.history.messages.hasMoreBefore);
      assert.equal(olderPage.collection, "messages");
      if (olderPage.collection === "messages") {
        assert.equal(olderPage.items.length, 100);
        assert.equal(olderPage.items[0]?.id, asMessageId("message-0800"));
        assert.equal(olderPage.items[99]?.id, asMessageId("message-0899"));
        assert.isTrue(olderPage.page.hasMoreBefore);
      }
      assert.equal(aroundPage.collection, "messages");
      if (aroundPage.collection === "messages") {
        assert.equal(aroundPage.items.length, 21);
        assert.equal(aroundPage.items[10]?.id, asMessageId("message-0123"));
      }

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        const messages = threadDetail.value.messages;
        assert.equal(messages.length, totalMessages);
        assert.equal(messages[0]?.id, asMessageId("message-0000"));
        assert.equal(messages[messages.length - 1]?.id, asMessageId("message-0999"));
      }

      const snapshotThread = snapshot.threads.find(
        (thread) => thread.id === ThreadId.make("thread-paged"),
      );
      assert.ok(snapshotThread);
      assert.equal(snapshotThread?.messages.length, totalMessages);
      assert.equal(snapshotThread?.messages[0]?.id, asMessageId("message-0000"));
      assert.equal(
        snapshotThread?.messages[(snapshotThread?.messages.length ?? 0) - 1]?.id,
        asMessageId("message-0999"),
      );

      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'message-0900'`;
      const staleBoundaryError = yield* Effect.flip(
        snapshotQuery.getThreadHistoryPage!({
          threadId: ThreadId.make("thread-paged"),
          collection: "messages",
          mode: { kind: "before", cursor: oldestMessageCursor! },
          limit: 100,
        }),
      );
      assert.equal(staleBoundaryError._tag, "OrchestrationThreadHistoryError");
      if (staleBoundaryError._tag === "OrchestrationThreadHistoryError") {
        assert.equal(staleBoundaryError.reason, "stale-cursor");
      }
    }),
  );

  it.effect("pages only a thread's artifact messages behind its window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'project-artifacts', 'Artifacts', '/tmp/artifacts', NULL, '[]',
          '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        )
        VALUES (
          'thread-artifacts', 'project-artifacts', 'Artifacts',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
        )
      `;

      const attachment = (index: number) =>
        JSON.stringify([
          {
            type: "file",
            id: `file-${index}`,
            name: `page-${index}.html`,
            mimeType: "text/html",
            sizeBytes: 10,
            // One user message carries an artifact handed over from another thread.
            ...(index === 121
              ? { handoff: { threadId: "thread-parent", messageId: "message-source" } }
              : {}),
          },
        ]);
      const baseTime = Date.parse("2026-05-01T01:00:00.000Z");
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: 300 }, (_unused, index) => index),
          (index) => {
            const messageId = `message-${String(index).padStart(4, "0")}`;
            const createdAt = new Date(baseTime + index * 1_000).toISOString();
            // Every 40th message is an artifact; the ones beside it are not (a user
            // upload, an assistant message with no attachments left) unless handed over.
            const role = index % 40 === 1 ? "user" : "assistant";
            const attachments =
              index % 40 === 0 || index % 40 === 1
                ? attachment(index)
                : index % 40 === 2
                  ? "[]"
                  : null;
            return sql`
              INSERT INTO projection_thread_messages (
                message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
                created_at, updated_at
              )
              VALUES (
                ${messageId}, 'thread-artifacts', 'turn-artifacts', ${role}, ${`body ${index}`},
                ${attachments}, 0, ${createdAt}, ${createdAt}
              )
            `;
          },
          { discard: true },
        ),
      );

      const threadWindow = yield* snapshotQuery.getThreadWindow!({
        threadId: ThreadId.make("thread-artifacts"),
        limits: { messages: 100, proposedPlans: 10, activities: 10, checkpoints: 10 },
      });
      const windowCursor = threadWindow.history.messages.oldestCursor;
      assert.isNotNull(windowCursor);
      // The window holds messages 200-299; artifacts before it: 0, 40, 80, 120, 121, 160.
      const firstPage = yield* snapshotQuery.getThreadHistoryPage!({
        threadId: ThreadId.make("thread-artifacts"),
        collection: "messages",
        mode: { kind: "before", cursor: windowCursor! },
        limit: 3,
        messageFilter: "artifacts",
      });
      assert.equal(firstPage.collection, "messages");
      if (firstPage.collection !== "messages") return;
      assert.deepEqual(
        firstPage.items.map((message) => message.id),
        ["message-0120", "message-0121", "message-0160"].map(asMessageId),
      );
      assert.equal(firstPage.items[0]?.attachments?.[0]?.id, "file-120");
      assert.isTrue(firstPage.page.hasMoreBefore);

      const lastPage = yield* snapshotQuery.getThreadHistoryPage!({
        threadId: ThreadId.make("thread-artifacts"),
        collection: "messages",
        mode: { kind: "before", cursor: firstPage.page.oldestCursor! },
        limit: 3,
        messageFilter: "artifacts",
      });
      assert.equal(lastPage.collection, "messages");
      if (lastPage.collection !== "messages") return;
      assert.deepEqual(
        lastPage.items.map((message) => message.id),
        ["message-0000", "message-0040", "message-0080"].map(asMessageId),
      );
      assert.isFalse(lastPage.page.hasMoreBefore);

      const newest = yield* snapshotQuery.listThreadArtifactMessages!({
        threadId: ThreadId.make("thread-artifacts"),
        limit: 4,
      });
      assert.deepEqual(
        newest.map((message) => message.id),
        ["message-0280", "message-0240", "message-0200", "message-0160"].map(asMessageId),
      );
    }),
  );

  it.effect("bounds a window's activities by payload bytes and pages the rest", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'project-heavy', 'Heavy', '/tmp/heavy', NULL, '[]',
          '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        )
        VALUES
          ('thread-heavy', 'project-heavy', 'Heavy', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', NULL, NULL, NULL,
           '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', NULL)
      `;
      // Eight tool outputs of ~400 KiB: three would already pass the budget.
      const output = "x".repeat(400 * 1024);
      for (let index = 1; index <= 8; index++) {
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES (${`heavy-activity-${index}`}, 'thread-heavy', NULL, 'tool', 'tool.completed', 'Ran',
            ${JSON.stringify({ output })}, ${index}, ${`2026-05-01T00:00:0${index}.000Z`})`;
      }

      const window = yield* snapshotQuery.getThreadWindow!({
        threadId: ThreadId.make("thread-heavy"),
        limits: { messages: 150, activities: 150, proposedPlans: 30, checkpoints: 30 },
      });
      assert.deepEqual(
        window.thread.activities.map((activity) => activity.id),
        ["heavy-activity-7", "heavy-activity-8"],
      );
      assert.equal(window.history.activities.hasMoreBefore, true);
      assert.isAtMost(
        window.thread.activities.reduce(
          (total, activity) => total + JSON.stringify(activity.payload).length,
          0,
        ),
        THREAD_WINDOW_ACTIVITY_MAX_PAYLOAD_BYTES,
      );

      // Older history pages are bounded the same way, and paging continues from each page's edge.
      const pagedIds: Array<string> = [];
      let cursor = window.history.activities.oldestCursor;
      let pages = 0;
      while (cursor !== null) {
        const page = yield* snapshotQuery.getThreadHistoryPage!({
          threadId: ThreadId.make("thread-heavy"),
          collection: "activities",
          mode: { kind: "before", cursor },
          limit: 150,
        });
        assert.equal(page.collection, "activities");
        if (page.collection !== "activities") break;
        assert.isAtMost(page.items.length, 2);
        assert.isAtMost(
          page.items.reduce(
            (total, activity) => total + JSON.stringify(activity.payload).length,
            0,
          ),
          THREAD_WINDOW_ACTIVITY_MAX_PAYLOAD_BYTES,
        );
        pagedIds.unshift(...page.items.map((activity) => activity.id));
        pages += 1;
        cursor = page.page.hasMoreBefore ? page.page.oldestCursor : null;
      }
      assert.equal(pages, 3);
      assert.deepEqual(
        pagedIds,
        [1, 2, 3, 4, 5, 6].map((index) => `heavy-activity-${index}`),
      );

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
    }),
  );

  it.effect("serves bounded activity previews and the stored payload on request", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'project-preview', 'Preview', '/tmp/preview', NULL, '[]',
          '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        )
        VALUES
          ('thread-preview', 'project-preview', 'Preview', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', NULL, NULL, NULL,
           '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', NULL)
      `;
      // Eight heavy tool outputs, the newest alone 5 MiB: past the relay's 4 MiB message cap.
      const heavyPayload = (bytes: number) => ({
        itemType: "command_execution",
        status: "completed",
        data: {
          item: {
            command: "cat big.log",
            exitCode: 0,
            aggregatedOutput: "y".repeat(bytes),
            changes: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
          },
        },
      });
      for (let index = 1; index <= 8; index++) {
        const payload = heavyPayload(index === 8 ? 5 * 1024 * 1024 : 400 * 1024);
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES (${`preview-activity-${index}`}, 'thread-preview', NULL, 'tool', 'tool.completed', 'Ran',
            ${JSON.stringify(payload)}, ${index}, ${`2026-05-01T00:00:0${index}.000Z`})`;
      }
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES ('preview-activity-small', 'thread-preview', NULL, 'info', 'task.progress', 'Small',
          ${JSON.stringify({ summary: "still small" })}, 9, '2026-05-01T00:00:09.000Z')`;

      const limits = { messages: 150, activities: 150, proposedPlans: 30, checkpoints: 30 };
      const window = yield* snapshotQuery.getThreadWindow!({
        threadId: ThreadId.make("thread-preview"),
        limits,
        activityPayloads: "preview",
      });
      // Every activity fits once previewed, the 5 MiB one included.
      assert.deepEqual(
        window.thread.activities.map((activity) => activity.id),
        [1, 2, 3, 4, 5, 6, 7, 8]
          .map((index) => `preview-activity-${index}`)
          .concat(["preview-activity-small"]),
      );
      assert.equal(window.history.activities.hasMoreBefore, false);
      const windowBytes = window.thread.activities.reduce(
        (total, activity) => total + JSON.stringify(activity.payload).length,
        0,
      );
      assert.isAtMost(windowBytes, 9 * 8 * 1024);
      const newest = window.thread.activities.find(
        (activity) => activity.id === "preview-activity-8",
      )!;
      assert.isDefined(newest.payloadPreview);
      assert.isAbove(newest.payloadPreview!.fullBytes, 5 * 1024 * 1024);
      // The preview keeps what collapsed rows read: command, exit code, file stats.
      const item = (newest.payload as { data: { item: Record<string, unknown> } }).data.item;
      assert.equal(item.command, "cat big.log");
      assert.equal(item.exitCode, 0);
      assert.deepEqual(item.changes, [{ path: "src/a.ts", additions: 3, deletions: 1 }]);
      assert.isTrue(String(item.aggregatedOutput).startsWith("yyyy"));
      assert.isTrue(String(item.aggregatedOutput).endsWith("…"));
      const small = window.thread.activities.find(
        (activity) => activity.id === "preview-activity-small",
      )!;
      assert.isUndefined(small.payloadPreview);
      assert.deepEqual(small.payload, { summary: "still small" });

      // A client that does not ask for previews keeps today's full, byte-bounded window:
      // the 5 MiB activity does not fit behind the newest one.
      const full = yield* snapshotQuery.getThreadWindow!({
        threadId: ThreadId.make("thread-preview"),
        limits,
      });
      assert.deepEqual(
        full.thread.activities.map((activity) => activity.id),
        ["preview-activity-small"],
      );
      assert.isTrue(full.thread.activities.every((activity) => !activity.payloadPreview));

      // History pages preview the same way.
      const page = yield* snapshotQuery.getThreadHistoryPage!({
        threadId: ThreadId.make("thread-preview"),
        collection: "activities",
        mode: { kind: "before", cursor: full.history.activities.oldestCursor! },
        limit: 150,
        activityPayloads: "preview",
      });
      assert.equal(page.collection, "activities");
      if (page.collection === "activities") {
        assert.equal(page.items.length, 8);
        assert.isTrue(page.items.every((activity) => activity.payloadPreview !== undefined));
      }

      const stored = yield* snapshotQuery.getActivityPayload!({
        threadId: ThreadId.make("thread-preview"),
        activityId: asEventId("preview-activity-3"),
      });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.equal(stored.value.kind, "tool.completed");
        assert.deepEqual(stored.value.payload, heavyPayload(400 * 1024));
        assert.equal(stored.value.payloadBytes, JSON.stringify(heavyPayload(400 * 1024)).length);
      }
      const otherThread = yield* snapshotQuery.getActivityPayload!({
        threadId: ThreadId.make("thread-other"),
        activityId: asEventId("preview-activity-3"),
      });
      assert.isTrue(Option.isNone(otherThread));

      yield* sql`UPDATE projection_threads SET deleted_at = '2026-05-02T00:00:00.000Z'`;
      const deleted = yield* snapshotQuery.getActivityPayload!({
        threadId: ThreadId.make("thread-preview"),
        activityId: asEventId("preview-activity-3"),
      });
      assert.isTrue(Option.isNone(deleted));

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
    }),
  );

  it.effect("carries a thread's projected priority on its shell upsert", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'project-ranked', 'Ranked', '/tmp/ranked', NULL, '[]',
          '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        )
        VALUES
          ('thread-ranked', 'project-ranked', 'Ranked', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', NULL, NULL, NULL,
           '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', NULL),
          ('thread-unranked', 'project-ranked', 'Unranked', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', NULL, NULL, NULL,
           '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', NULL)
      `;
      const rankedAt = new Date(Date.now() - 1_000).toISOString();
      const usableUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
      yield* sql`
        INSERT INTO thread_priority_batches (
          slot, batch_id, input_fingerprint, model_selection_json, model_fingerprint,
          prompt_version, ranked_at, usable_until, checked_at
        ) VALUES (
          1, 'batch-1', 'fingerprint', '{"provider":"codex","model":"gpt-5-codex"}', 'model',
          'v1', ${rankedAt}, ${usableUntil}, ${rankedAt}
        )
      `;
      yield* sql`
        INSERT INTO thread_priority_rankings (
          thread_id, batch_id, tier, confidence, reason, input_fingerprint
        ) VALUES ('thread-ranked', 'batch-1', 'now', 'high', 'Waiting on you', 'thread-fp')
      `;

      const ranked = Option.getOrThrow(
        yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-ranked")),
      );
      assert.equal(ranked.priority?.tier, "now");
      assert.equal(ranked.priority?.batchId, "batch-1");
      const unranked = Option.getOrThrow(
        yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-unranked")),
      );
      assert.isUndefined(unranked.priority);
      // The ranking is part of the snapshot's version: a re-rank must not read
      // as "current" to a client holding the same event sequence.
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(snapshot.updatedAt, rankedAt);

      yield* sql`DELETE FROM thread_priority_rankings`;
      yield* sql`DELETE FROM thread_priority_batches`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
    }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );
});

it.effect("ProjectionSnapshotQuery exposes worktree prTerminalAt on every read path", () => {
  const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at
      ) VALUES (
        'project-pr-terminal', 'Project', '/tmp/project-pr-terminal',
        '{"provider":"codex","model":"gpt-5-codex"}', '[]',
        '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_worktrees (
        worktree_id, project_id, branch, worktree_path, origin, pr_number,
        pr_state, pr_terminal_at, created_at, updated_at
      ) VALUES
        (
          'worktree-merged', 'project-pr-terminal', 'feature/merged', '/tmp/merged', 'pr', 7,
          'merged', '2026-04-05T00:30:00.000Z',
          '2026-04-05T00:00:00.000Z', '2026-04-05T01:00:00.000Z'
        ),
        (
          'worktree-open', 'project-pr-terminal', 'feature/open', '/tmp/open', 'pr', 8,
          'open', NULL,
          '2026-04-05T00:00:01.000Z', '2026-04-05T01:00:00.000Z'
        )
    `;

    const byId = (worktrees: ReadonlyArray<{ worktreeId: string }> | undefined, id: string) =>
      worktrees?.find((worktree) => worktree.worktreeId === id) as
        | { readonly prTerminalAt?: string | null }
        | undefined;
    const assertExposed = (worktrees: ReadonlyArray<{ worktreeId: string }> | undefined) => {
      assert.equal(byId(worktrees, "worktree-merged")?.prTerminalAt, "2026-04-05T00:30:00.000Z");
      const open = byId(worktrees, "worktree-open");
      assert.isTrue(open !== undefined && "prTerminalAt" in open);
      assert.isNull(open?.prTerminalAt);
    };

    assertExposed((yield* snapshotQuery.getCommandReadModel()).worktrees);
    assertExposed((yield* snapshotQuery.getShellSnapshot()).worktrees);

    const getWorktreeShellById = snapshotQuery.getWorktreeShellById;
    assert.isDefined(getWorktreeShellById);
    if (getWorktreeShellById === undefined) return;
    const merged = yield* getWorktreeShellById(WorktreeId.make("worktree-merged"));
    const open = yield* getWorktreeShellById(WorktreeId.make("worktree-open"));
    assertExposed([Option.getOrThrow(merged), Option.getOrThrow(open)]);
  }).pipe(Effect.provide(layer));
});

it.effect("ProjectionSnapshotQuery exposes thread lineage on every read path", () => {
  const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at
      ) VALUES (
        'project-lineage', 'Project', '/tmp/project-lineage',
        '{"provider":"codex","model":"gpt-5-codex"}', '[]',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, branch, worktree_path, latest_turn_id,
        latest_user_message_at, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at,
        lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship,
        lineage_source_message_id, lineage_source_turn_id
      ) VALUES
        (
          'thread-lineage-root', 'project-lineage', 'Root',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-10-01T00:00:01.000Z', '2026-10-01T00:00:01.000Z', NULL, NULL,
          NULL, NULL, NULL, NULL, NULL
        ),
        (
          'thread-lineage-child', 'project-lineage', 'Child',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-10-01T00:00:02.000Z', '2026-10-01T00:00:02.000Z', NULL, NULL,
          'thread-lineage-root', 'thread-lineage-root', 'delegated', NULL, NULL
        ),
        (
          'thread-lineage-fork', 'project-lineage', 'Fork',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-10-01T00:00:03.000Z', '2026-10-01T00:00:03.000Z', NULL, NULL,
          'thread-lineage-child', 'thread-lineage-root', 'forked',
          'message-lineage-boundary', 'turn-lineage-boundary'
        )
    `;

    const rootId = ThreadId.make("thread-lineage-root");
    const childId = ThreadId.make("thread-lineage-child");
    const forkId = ThreadId.make("thread-lineage-fork");
    const expected = {
      parentThreadId: rootId,
      rootThreadId: rootId,
      relationship: "delegated",
    };
    // A fork's provenance must survive every read path (and so every re-upsert).
    const expectedFork = {
      parentThreadId: childId,
      rootThreadId: rootId,
      relationship: "forked",
      sourceMessageId: MessageId.make("message-lineage-boundary"),
      sourceTurnId: TurnId.make("turn-lineage-boundary"),
    };
    const assertExposed = (
      threads: ReadonlyArray<{ readonly id: ThreadId; readonly lineage?: unknown }>,
      surface: string,
    ) => {
      const child = threads.find((thread) => thread.id === childId);
      const root = threads.find((thread) => thread.id === rootId);
      const fork = threads.find((thread) => thread.id === forkId);
      assert.deepEqual(child?.lineage, expected, `${surface} child lineage`);
      assert.deepEqual(fork?.lineage, expectedFork, `${surface} fork lineage`);
      assert.isDefined(root, `${surface} root`);
      assert.notProperty(root, "lineage", `${surface} root has no lineage key`);
    };

    assertExposed((yield* snapshotQuery.getShellSnapshot()).threads, "getShellSnapshot");
    assertExposed((yield* snapshotQuery.getSnapshot()).threads, "getSnapshot");
    assertExposed((yield* snapshotQuery.getCommandReadModel()).threads, "getCommandReadModel");
    assertExposed(
      [
        Option.getOrThrow(yield* snapshotQuery.getThreadShellById(childId)),
        Option.getOrThrow(yield* snapshotQuery.getThreadShellById(rootId)),
        Option.getOrThrow(yield* snapshotQuery.getThreadShellById(forkId)),
      ],
      "getThreadShellById",
    );
    assertExposed(
      [
        Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(childId)),
        Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(rootId)),
        Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(forkId)),
      ],
      "getThreadDetailById",
    );
    const window = yield* snapshotQuery.getThreadWindow!({
      threadId: forkId,
      limits: { messages: 10, proposedPlans: 10, activities: 10, checkpoints: 10 },
    });
    assert.deepEqual(window.thread.lineage, expectedFork, "getThreadWindow fork lineage");
  }).pipe(Effect.provide(layer));
});

it("keeps the newest rows within both the count and the byte budget", () => {
  const rows = [400, 400, 400, 10].map((payloadBytes, index) => ({ id: index, payloadBytes }));
  assert.deepEqual(takeNewestRowsWithinByteBudget(rows, 10, 1_000), {
    rows: rows.slice(0, 2),
    hasMoreBefore: true,
  });
  assert.deepEqual(takeNewestRowsWithinByteBudget(rows, 10, 10_000), {
    rows,
    hasMoreBefore: false,
  });
  // The newest row always opens, however large.
  assert.deepEqual(takeNewestRowsWithinByteBudget([{ payloadBytes: 5_000 }], 10, 1_000), {
    rows: [{ payloadBytes: 5_000 }],
    hasMoreBefore: false,
  });
  assert.equal(takeNewestRowsWithinByteBudget(rows, 2, 10_000).hasMoreBefore, true);
});

projectionSnapshotLayer("scoped shell snapshots", (it) => {
  it.effect("equals the whole shell filtered to the scope", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_worktrees`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      for (const projectId of ["scope-p1", "scope-p2"]) {
        yield* sql`INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${projectId}, ${projectId}, ${`/tmp/${projectId}`}, '[]',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_worktrees (
          worktree_id, project_id, branch, origin, created_at, updated_at
        ) VALUES (${`${projectId}-wt`}, ${projectId}, 'main', 'main',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      }
      const threads: ReadonlyArray<readonly [string, string, string | null]> = [
        ["scope-t1", "scope-p1", null],
        ["scope-t2", "scope-p1", null],
        ["scope-t3", "scope-p2", null],
        ["scope-deleted", "scope-p2", "2026-10-02T00:00:00.000Z"],
      ];
      for (const [threadId, projectId, deletedAt] of threads) {
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, deleted_at
        ) VALUES (
          ${threadId}, ${projectId}, ${threadId}, '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
          ${deletedAt}
        )`;
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
          VALUES (${threadId}, 'idle', '2026-10-01T00:00:00.000Z')`;
      }
      const full = yield* query.getShellSnapshot();
      const scopes = [
        { projectIds: [ProjectId.make("scope-p1")] },
        { threadIds: [ThreadId.make("scope-t3"), ThreadId.make("scope-deleted")] },
        { projectIds: [ProjectId.make("scope-p1")], threadIds: [ThreadId.make("scope-t2")] },
        { threadIds: [] },
      ];
      for (const scope of scopes) {
        const scoped = yield* query.getScopedShellSnapshot!(scope);
        assert.deepEqual(scoped, scopeShellSnapshot(full, scope), JSON.stringify(scope));
      }
      assert.deepEqual(
        (yield* query.getScopedShellSnapshot!({
          threadIds: [ThreadId.make("scope-t3")],
        })).projects.map((project) => project.id),
        ["scope-p2"],
      );
    }),
  );
});
