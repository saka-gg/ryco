import { ThreadId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ThreadPriorityCandidateQuery,
  ThreadPriorityCandidateQueryLive,
} from "./ThreadPriorityCandidateQuery.ts";

const layer = it.layer(
  ThreadPriorityCandidateQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ThreadPriorityCandidateQuery", (it) => {
  it.effect("selects only active server-owned candidate metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, project_metadata_dir, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          'priority-project', 'Priority Project', '/secret/project/path', '.ryco', NULL, '[]',
          '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_worktrees (
          worktree_id, project_id, title, branch, worktree_path, origin, pr_number, issue_number,
          pr_title, issue_title, created_at, updated_at, manual_position, pr_state, issue_state
        ) VALUES (
          'priority-worktree', 'priority-project', 'Feature', 'feature/focus', '/secret/worktree',
          'pr', 42, 7, 'Ship AI Focus', 'Inbox sorting', '2026-08-25T00:00:00.000Z',
          '2026-08-25T00:00:00.000Z', 0, 'open', 'in-progress'
        )
      `;
      for (const [threadId, archivedAt, settledOverride, deletedAt] of [
        ["priority-active", null, null, null],
        ["priority-archived", "2026-08-25T02:00:00.000Z", null, null],
        ["priority-settled", null, "settled", null],
        ["priority-deleted", null, null, "2026-08-25T02:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            token_mode, branch, worktree_id, latest_turn_id, manual_position, created_at, updated_at,
            archived_at, settled_override, settled_at, pending_approval_count,
            pending_user_input_count, has_actionable_proposed_plan, deleted_at
          ) VALUES (
            ${threadId}, 'priority-project', ${threadId},
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', 'balanced',
            'fallback-branch', 'priority-worktree', 'priority-turn', 0,
            '2026-08-25T00:00:00.000Z', '2026-08-25T01:00:00.000Z', ${archivedAt},
            ${settledOverride},
            ${settledOverride === "settled" ? "2026-08-25T02:00:00.000Z" : null}, 1, 1, 0,
            ${deletedAt}
          )
        `;
      }
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('priority-message-old', 'priority-active', 'user', 'Older request', 0,
            '2026-08-25T00:10:00.000Z', '2026-08-25T00:10:00.000Z'),
          ('priority-message-new', 'priority-active', 'user', 'Latest approved request', 0,
            '2026-08-25T00:20:00.000Z', '2026-08-25T00:20:00.000Z'),
          ('priority-assistant', 'priority-active', 'assistant', 'Private assistant response', 0,
            '2026-08-25T00:30:00.000Z', '2026-08-25T00:30:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json
        ) VALUES
          ('priority-active', 'priority-turn', 'error', '2026-08-25T00:40:00.000Z', '[]'),
          ('priority-active', NULL, 'pending', '2026-08-25T00:50:00.000Z', '[]')
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, runtime_mode, token_mode, updated_at
        ) VALUES ('priority-active', 'running', 'full-access', 'balanced',
          '2026-08-25T01:00:00.000Z')
      `;

      const query = yield* ThreadPriorityCandidateQuery;
      const candidates = yield* query.listActive({
        autoSettleAfterDays: 7,
        nowMs: Date.parse("2026-08-25T03:00:00.000Z"),
      });
      assert.equal(candidates.length, 1);
      assert.deepEqual(candidates[0], {
        threadId: ThreadId.make("priority-active"),
        title: "priority-active",
        projectName: "Priority Project",
        branchName: "feature/focus",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T01:00:00.000Z",
        activityState: "running",
        hasPendingApproval: true,
        hasPendingUserInput: true,
        queueState: "queued-turn",
        hasLatestFailure: true,
        deliveryState: "known",
        pullRequest: { title: "Ship AI Focus", state: "open" },
        issue: { title: "Inbox sorting", state: "in-progress" },
        latestUserRequest: "Latest approved request",
      });
      assert.notInclude(JSON.stringify(candidates), "/secret/");
      assert.notInclude(JSON.stringify(candidates), "Private assistant response");
    }),
  );

  it.effect("leaves out threads the node's own rule settled, and only those", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, project_metadata_dir, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          'rule-project', 'Rule Project', '/rule/project', '.ryco', NULL, '[]',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      // Last activity ten days before "now" for all but the recent thread.
      for (const [threadId, settledOverride, pendingUserInput, latestUserMessageAt] of [
        ["rule-inactive", null, 0, "2026-08-15T00:00:00.000Z"],
        ["rule-kept-active", "active", 0, "2026-08-15T00:00:00.000Z"],
        ["rule-waiting-for-input", null, 1, "2026-08-15T00:00:00.000Z"],
        ["rule-recent", null, 0, "2026-08-24T00:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            token_mode, branch, worktree_id, latest_turn_id, manual_position, created_at,
            updated_at, archived_at, settled_override, settled_at, pending_approval_count,
            pending_user_input_count, has_actionable_proposed_plan, deleted_at,
            latest_user_message_at
          ) VALUES (
            ${threadId}, 'rule-project', ${threadId},
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', 'balanced',
            NULL, NULL, NULL, 0, '2026-08-01T00:00:00.000Z', ${latestUserMessageAt}, NULL,
            ${settledOverride}, NULL, 0, ${pendingUserInput}, 0, NULL, ${latestUserMessageAt}
          )
        `;
      }

      const query = yield* ThreadPriorityCandidateQuery;
      const listed = (autoSettleAfterDays: 7 | 14 | null) =>
        query
          .listActive({ autoSettleAfterDays, nowMs: Date.parse("2026-08-25T00:00:00.000Z") })
          .pipe(
            Effect.map((candidates) =>
              candidates
                .map((candidate) => candidate.threadId)
                .filter((threadId) => threadId.startsWith("rule-")),
            ),
          );

      assert.deepEqual(
        (yield* listed(7)).toSorted(),
        ["rule-kept-active", "rule-recent", "rule-waiting-for-input"].map((id) =>
          ThreadId.make(id),
        ),
      );
      assert.deepEqual(
        (yield* listed(14)).toSorted(),
        ["rule-inactive", "rule-kept-active", "rule-recent", "rule-waiting-for-input"].map((id) =>
          ThreadId.make(id),
        ),
      );
      assert.deepEqual(yield* listed(null), yield* listed(14));
    }),
  );
});
