import { OrchestrationShellSnapshot, ProjectId, ThreadId, WorktreeId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlStatement from "effect/sql/Statement";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import {
  ProjectionSnapshotQuery,
  readProjectShells,
  readWorkspacePlacement,
  workspacePlacementOf,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  COMMAND_READ_MODEL_ACTIVITY_KINDS,
  coalesceConcurrentRuns,
  OrchestrationProjectionSnapshotQueryLive,
} from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.die("no git on reads") }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const MODEL = '{"instanceId":"codex","model":"gpt-5-codex"}';

const insertThread = (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly worktreeId?: string | null;
  readonly goalJson?: string | null;
  readonly lineage?: readonly [parent: string, root: string, relationship: string];
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, worktree_id, goal_json, created_at, updated_at, deleted_at,
        lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship
      ) VALUES (
        ${input.threadId}, ${input.projectId}, ${input.title ?? input.threadId}, ${MODEL},
        'full-access', 'default', ${input.branch ?? null}, ${input.worktreePath ?? null},
        ${input.worktreeId ?? null}, ${input.goalJson ?? null}, '2026-10-01T00:00:00.000Z',
        ${input.updatedAt ?? "2026-10-01T00:00:00.000Z"}, ${input.deletedAt ?? null},
        ${input.lineage?.[0] ?? null}, ${input.lineage?.[1] ?? null}, ${input.lineage?.[2] ?? null}
      )
    `;
  });

const goalJson = (requestId: string, state: "pending" | "failed", deferUntilTurn = false) =>
  JSON.stringify({
    objective: "Ship it",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    synchronization: {
      requestId,
      state,
      action: "set",
      ...(deferUntilTurn ? { deferUntilTurn } : {}),
    },
  });

layer("ProjectionSnapshotQuery shell reads", (it) => {
  it.effect("builds shell snapshots that are already in their decoded form", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      // Padded text the wire schemas trim: the per-row decode must normalize it, because the
      // assembled snapshot is no longer decoded again as a whole.
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, default_model_selection_json, scripts_json,
          custom_system_prompt, custom_avatar_content_hash, preferred_remote_name,
          created_at, updated_at, repository_identity_json
        ) VALUES (
          'decoded-project', 'project', '  Decoded  ', '  /tmp/decoded  ', ${MODEL}, '[]',
          '  Be brief  ', '  hash  ', '  upstream  ',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
          '{"canonicalKey":"github.com/acme/decoded","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://github.com/acme/decoded.git"}}'
        )
      `;
      yield* sql`
        INSERT INTO projection_worktrees (
          worktree_id, project_id, title, branch, worktree_path, origin, pr_number, pr_title,
          pr_state, pr_is_draft, created_at, updated_at
        ) VALUES (
          'decoded-worktree', 'decoded-project', '  Feature  ', 'feature', '/tmp/feature', 'pr',
          12, '  Add things  ', 'open', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;
      yield* insertThread({
        threadId: "decoded-thread",
        projectId: "decoded-project",
        title: "  Padded title  ",
        branch: "  feature  ",
        worktreePath: "  /tmp/feature  ",
        worktreeId: "decoded-worktree",
        goalJson: goalJson("goal-request", "failed"),
        lineage: ["decoded-parent", "decoded-parent", "  delegated  "],
      });
      yield* insertThread({ threadId: "decoded-parent", projectId: "decoded-project" });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, started_at,
          completed_at, checkpoint_files_json
        ) VALUES (
          'decoded-thread', 'decoded-turn', 'decoded-message', 'completed',
          '2026-10-01T00:01:00.000Z', '2026-10-01T00:01:01.000Z', '2026-10-01T00:02:00.000Z', '[]'
        )
      `;
      yield* sql`UPDATE projection_threads SET latest_turn_id = 'decoded-turn'
        WHERE thread_id = 'decoded-thread'`;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id, runtime_session_id,
          runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES (
          'decoded-thread', 'error', '  codex  ', 'codex', 'runtime-1', 'full-access', NULL,
          '  Provider exited  ', '2026-10-01T00:03:00.000Z'
        )
      `;

      const shell = yield* query.getShellSnapshot();
      assert.deepEqual(Schema.decodeUnknownSync(OrchestrationShellSnapshot)(shell), shell);
      // And the RPC layer can encode it as is.
      Schema.encodeUnknownSync(OrchestrationShellSnapshot)(shell);
      const thread = shell.threads.find((entry) => entry.id === "decoded-thread");
      assert.equal(thread?.title, "Padded title");
      assert.equal(thread?.lineage?.relationship, "delegated");
      assert.equal(thread?.session?.lastError, "Provider exited");
      assert.equal(thread?.latestTurn?.turnId, "decoded-turn");
      const project = shell.projects.find((entry) => entry.id === "decoded-project");
      assert.equal(project?.workspaceRoot, "/tmp/decoded");
      assert.equal(project?.customSystemPrompt, "Be brief");
      assert.equal(project?.repositoryIdentity?.canonicalKey, "github.com/acme/decoded");
      assert.deepEqual(project?.repositoryIdentity?.remotes, []);
      assert.equal(shell.worktrees?.[0]?.pullRequests?.[0]?.title, "Add things");
    }),
  );

  it.effect("reads only live rows yet keeps updatedAt covering deleted ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES
          ('live-rows-project', 'Live', '/tmp/live-rows', ${MODEL}, '[]',
            '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', NULL),
          ('deleted-rows-project', 'Deleted', '/tmp/deleted-rows', ${MODEL}, '[]',
            '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:01.000Z')
      `;
      yield* sql`
        INSERT INTO projection_worktrees (
          worktree_id, project_id, branch, worktree_path, origin, created_at, updated_at
        ) VALUES (
          'deleted-project-worktree', 'deleted-rows-project', 'main', NULL, 'main',
          '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'
        )
      `;
      yield* insertThread({ threadId: "live-row", projectId: "live-rows-project" });
      // The newest write anywhere is a deletion: the snapshot must still move past it.
      yield* insertThread({
        threadId: "deleted-row",
        projectId: "live-rows-project",
        updatedAt: "2099-01-01T00:00:00.000Z",
        deletedAt: "2099-01-01T00:00:00.000Z",
      });
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, runtime_mode, updated_at)
        VALUES ('deleted-row', 'stopped', 'full-access', '2026-10-02T00:00:00.000Z')
      `;

      const statements: string[] = [];
      const capture: SqlStatement.Transformer = (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile()[0]);
          return statement;
        });
      const shell = yield* query
        .getShellSnapshot()
        .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));

      assert.isTrue(shell.threads.some((thread) => thread.id === "live-row"));
      assert.isFalse(shell.threads.some((thread) => thread.id === "deleted-row"));
      assert.isFalse(shell.projects.some((project) => project.id === "deleted-rows-project"));
      assert.isFalse(
        (shell.worktrees ?? []).some(
          (worktree) => worktree.worktreeId === "deleted-project-worktree",
        ),
      );
      assert.equal(shell.updatedAt, "2099-01-01T00:00:00.000Z");
      // Deleted rows are filtered in SQL, not decoded and dropped in JS.
      const threadQuery = statements.find(
        (statement) =>
          statement.includes("FROM projection_threads") && statement.includes("goal_json"),
      );
      assert.match(threadQuery ?? "", /WHERE deleted_at IS NULL/);
      const sessionQuery = statements.find((statement) =>
        statement.includes("FROM projection_thread_sessions"),
      );
      assert.match(sessionQuery ?? "", /deleted_at IS NULL/);
    }),
  );

  it.effect("lists pending goal synchronizations without a shell snapshot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* insertThread({
        threadId: "goal-pending",
        projectId: "goal-project",
        goalJson: goalJson("request-pending", "pending"),
      });
      yield* insertThread({
        threadId: "goal-deferred",
        projectId: "goal-project",
        goalJson: goalJson("request-deferred", "pending", true),
      });
      yield* insertThread({
        threadId: "goal-failed",
        projectId: "goal-project",
        goalJson: goalJson("request-failed", "failed"),
      });
      yield* insertThread({
        threadId: "goal-deleted",
        projectId: "goal-project",
        goalJson: goalJson("request-deleted", "pending"),
        deletedAt: "2026-10-01T00:00:01.000Z",
      });
      // Malformed JSON elsewhere must not fail the whole recovery read.
      yield* insertThread({ threadId: "goal-malformed", projectId: "goal-project" });
      yield* sql`UPDATE projection_threads SET goal_json = '{oops' WHERE thread_id = 'goal-malformed'`;

      const listPending = query.listPendingGoalSyncThreads;
      assert.isDefined(listPending);
      if (listPending === undefined) return;
      const pending = yield* listPending();
      // Same creation time: ordered by thread id.
      assert.deepEqual(
        pending.threads.map((entry) => entry.threadId),
        [ThreadId.make("goal-deferred"), ThreadId.make("goal-pending")],
      );
      assert.equal(pending.threads[0]?.goal.synchronization?.deferUntilTurn, true);
      assert.equal(pending.threads[1]?.goal.synchronization?.requestId, "request-pending");
      const { snapshotSequence } = yield* query.getSnapshotSequence();
      assert.equal(pending.snapshotSequence, snapshotSequence);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM projection_threads WHERE project_id = 'goal-project'`;
        }).pipe(Effect.orDie),
      ),
    ),
  );

  it.effect("reads one project's workspaces and live threads for reconciliation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`
        INSERT INTO projection_worktrees (
          worktree_id, project_id, branch, worktree_path, origin, created_at, updated_at, archived_at
        ) VALUES
          ('rows-main', 'rows-project', 'main', NULL, 'main',
            '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', NULL),
          ('rows-archived', 'rows-project', 'old', '/tmp/rows-old', 'branch',
            '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:01.000Z'),
          ('rows-other', 'rows-other-project', 'main', NULL, 'main',
            '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', NULL)
      `;
      yield* insertThread({
        threadId: "rows-thread",
        projectId: "rows-project",
        branch: "topic",
        worktreePath: "/tmp/rows-topic",
      });
      yield* insertThread({
        threadId: "rows-deleted",
        projectId: "rows-project",
        deletedAt: "2026-10-03T00:00:01.000Z",
      });
      yield* insertThread({ threadId: "rows-foreign", projectId: "rows-other-project" });

      const getRows = query.getProjectWorkspaceRows;
      assert.isDefined(getRows);
      if (getRows === undefined) return;
      const rows = yield* getRows(ProjectId.make("rows-project"));
      // Same position and creation time: ordered by workspace id.
      assert.deepEqual(
        rows.worktrees.map((worktree) => worktree.worktreeId),
        [WorktreeId.make("rows-archived"), WorktreeId.make("rows-main")],
      );
      assert.deepEqual(rows.threads, [
        {
          id: ThreadId.make("rows-thread"),
          projectId: ProjectId.make("rows-project"),
          branch: "topic",
          worktreePath: "/tmp/rows-topic",
          worktreeId: null,
        },
      ]);
      const viaShell = yield* query.getWorktreeShellById!(WorktreeId.make("rows-main"));
      assert.deepEqual(Option.getOrNull(viaShell), rows.worktrees[1]);
    }),
  );

  it.effect("reads projects and workspace placement exactly as the shell snapshot has them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at, repository_identity_json
        ) VALUES
          ('placement-live', 'Live', '/tmp/placement-live', NULL, '[]',
            '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z', NULL,
            '{"canonicalKey":"github.com/acme/live","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"git@github.com:acme/live.git"},"rootPath":"/tmp/placement-live","remotes":[]}'),
          ('placement-deleted', 'Deleted', '/tmp/placement-deleted', NULL, '[]',
            '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:01.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_worktrees (
          worktree_id, project_id, branch, worktree_path, origin, created_at, updated_at, archived_at
        ) VALUES
          ('placement-main', 'placement-live', 'main', NULL, 'main',
            '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z', NULL),
          ('placement-archived', 'placement-live', 'old', '/tmp/placement-old', 'branch',
            '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:01.000Z'),
          ('placement-orphan', 'placement-deleted', 'main', NULL, 'main',
            '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z', NULL)
      `;
      yield* insertThread({
        threadId: "placement-thread",
        projectId: "placement-live",
        branch: "topic",
        worktreePath: "/tmp/placement-topic",
        worktreeId: "placement-main",
      });
      yield* insertThread({
        threadId: "placement-gone",
        projectId: "placement-live",
        deletedAt: "2026-10-04T00:00:01.000Z",
      });

      const shell = yield* query.getShellSnapshot();
      const projects = yield* query.listProjectShells!();
      assert.deepEqual(projects, shell.projects);
      assert.isTrue(projects.some((project) => project.id === "placement-live"));
      assert.isFalse(projects.some((project) => project.id === "placement-deleted"));
      assert.equal(
        projects.find((project) => project.id === "placement-live")?.repositoryIdentity
          ?.canonicalKey,
        "github.com/acme/live",
      );

      const placement = yield* query.getWorkspacePlacement!();
      assert.deepEqual(placement, workspacePlacementOf(shell));
      assert.deepEqual(
        placement.threads.find((thread) => thread.id === "placement-thread"),
        {
          id: ThreadId.make("placement-thread"),
          projectId: ProjectId.make("placement-live"),
          branch: "topic",
          worktreePath: "/tmp/placement-topic",
          worktreeId: WorktreeId.make("placement-main"),
        },
      );
      assert.isFalse(placement.threads.some((thread) => thread.id === "placement-gone"));
      assert.isFalse(
        placement.worktrees.some((worktree) => worktree.worktreeId === "placement-orphan"),
      );

      // Narrow test doubles fall back to the shell snapshot and get the same answer.
      const shellOnly = { getShellSnapshot: () => Effect.succeed(shell) };
      assert.deepEqual(yield* readProjectShells(shellOnly), projects);
      assert.deepEqual(yield* readWorkspacePlacement(shellOnly), placement);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM projection_threads WHERE project_id = 'placement-live'`;
          yield* sql`DELETE FROM projection_worktrees WHERE worktree_id LIKE 'placement-%'`;
          yield* sql`DELETE FROM projection_projects WHERE project_id LIKE 'placement-%'`;
        }).pipe(Effect.orDie),
      ),
    ),
  );

  it.effect("reads actionable and revert activities through the kind index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const capture: SqlStatement.Transformer = (statement) =>
        Effect.sync(() => {
          const compiled = statement.compile();
          if (compiled[0].includes("FROM projection_thread_activities")) statements.push(compiled);
          return statement;
        });
      yield* query
        .getCommandReadModel()
        .pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));
      const listReverts = query.listPendingCheckpointReverts;
      assert.isDefined(listReverts);
      if (listReverts === undefined) return;
      yield* listReverts().pipe(Effect.provideService(SqlStatement.CurrentTransformer, capture));

      const actionable = statements.find(([statement]) => statement.includes("kind IN"));
      assert.isDefined(actionable);
      assert.deepEqual(
        actionable?.[1].filter((param) => typeof param === "string"),
        [...COMMAND_READ_MODEL_ACTIVITY_KINDS],
      );
      const revert = statements.find(([statement]) => statement.includes("INNER JOIN"));
      assert.isDefined(revert);
      for (const [statement, params] of [actionable!, revert!]) {
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
          params,
        );
        assert.isTrue(
          plan.some((row) =>
            /SEARCH (projection_thread_activities|activities) USING (COVERING )?INDEX idx_projection_thread_activities_kind_order \(kind=\?\)/.test(
              row.detail,
            ),
          ),
          JSON.stringify(plan),
        );
        assert.isFalse(
          plan.some((row) => /SCAN (projection_thread_activities|activities)\b/.test(row.detail)),
          JSON.stringify(plan),
        );
      }
    }),
  );
});

it.effect("coalesces concurrent shell builds without serving a result older than the call", () =>
  Effect.gen(function* () {
    let runs = 0;
    const gates: Array<Deferred.Deferred<void>> = [];
    const coalesced = coalesceConcurrentRuns(() =>
      Effect.gen(function* () {
        runs += 1;
        const run = runs;
        const gate = yield* Deferred.make<void>();
        gates.push(gate);
        yield* Deferred.await(gate);
        if (run === 3) return yield* Effect.fail(`run ${run} failed`);
        return run;
      }),
    );
    /** Let forked fibers run until `count` runs have started. */
    const runsStarted = (count: number) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 100 && gates.length < count; attempt += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal(gates.length, count);
      });
    const settle = Effect.gen(function* () {
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
    });

    const first = yield* Effect.forkChild(coalesced());
    yield* runsStarted(1);
    // These arrive while run 1 is in flight: they share run 2, never run 1.
    const second = yield* Effect.forkChild(coalesced());
    const third = yield* Effect.forkChild(coalesced());
    yield* settle;
    assert.equal(runs, 1);
    // Interrupting the caller that started run 1 does not cancel it.
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(gates[0]!, undefined);
    yield* runsStarted(2);
    yield* Deferred.succeed(gates[1]!, undefined);
    assert.equal(yield* Fiber.join(second), 2);
    assert.equal(yield* Fiber.join(third), 2);
    assert.equal(runs, 2);

    // Failures reach every caller of the run, and the next call starts afresh.
    const failing = yield* Effect.forkChild(Effect.flip(coalesced()));
    yield* runsStarted(3);
    yield* Deferred.succeed(gates[2]!, undefined);
    assert.equal(yield* Fiber.join(failing), "run 3 failed");
    const fresh = yield* Effect.forkChild(coalesced());
    yield* runsStarted(4);
    yield* Deferred.succeed(gates[3]!, undefined);
    assert.equal(yield* Fiber.join(fresh), 4);
  }),
);

it.live("builds a shell inside a transaction without waiting for a shared build", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // The transaction holds the only connection while an outside caller's build is in flight
    // (blocked on that connection), then asks for a shell itself.
    const inTransaction = yield* Effect.forkChild(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return yield* query.getShellSnapshot();
        }),
      ),
    );
    yield* Deferred.await(entered);
    const outside = yield* Effect.forkChild(query.getShellSnapshot());
    for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);

    const inside = yield* Fiber.join(inTransaction).pipe(Effect.timeout("5 seconds"));
    assert.isArray(inside.projects);
    assert.isArray((yield* Fiber.join(outside).pipe(Effect.timeout("5 seconds"))).projects);
  }).pipe(
    Effect.provide(
      OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);
