import { assembledMessageText, decodeMessageText } from "../persistence/messageText.ts";
import { ThreadId } from "@ryco/contracts";
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import type { ThreadPriorityCandidateInput } from "./threadPriorityPolicy.ts";

export interface ThreadPriorityCandidateQueryShape {
  readonly listActive: Effect.Effect<
    ReadonlyArray<ThreadPriorityCandidateInput>,
    PersistenceSqlError
  >;
}

export class ThreadPriorityCandidateQuery extends Context.Service<
  ThreadPriorityCandidateQuery,
  ThreadPriorityCandidateQueryShape
>()("ryco/threadPriority/ThreadPriorityCandidateQuery") {}

interface CandidateRow {
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string | null;
  readonly branchName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionStatus: string | null;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly hasQueuedTurn: number;
  readonly latestTurnState: string | null;
  readonly prTitle: string | null;
  readonly prState: string | null;
  readonly issueTitle: string | null;
  readonly issueState: string | null;
  readonly latestUserRequest: string | null;
  readonly latestUserRequestParts: string | null;
}

const makeThreadPriorityCandidateQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listActive = sql<CandidateRow>`
    SELECT
      thread.thread_id AS "threadId",
      thread.title,
      project.title AS "projectName",
      COALESCE(worktree.branch, thread.branch) AS "branchName",
      thread.created_at AS "createdAt",
      thread.updated_at AS "updatedAt",
      session.status AS "sessionStatus",
      thread.pending_approval_count AS "pendingApprovalCount",
      thread.pending_user_input_count AS "pendingUserInputCount",
      EXISTS (
        SELECT 1 FROM projection_turns AS pending_turn
        WHERE pending_turn.thread_id = thread.thread_id AND pending_turn.state = 'pending'
      ) AS "hasQueuedTurn",
      latest_turn.state AS "latestTurnState",
      worktree.pr_title AS "prTitle",
      worktree.pr_state AS "prState",
      COALESCE(worktree.issue_title, worktree.work_item_title) AS "issueTitle",
      COALESCE(worktree.issue_state, worktree.work_item_state) AS "issueState",
      message.text AS "latestUserRequest",
      ${assembledMessageText(sql, "message")} AS "latestUserRequestParts"
    FROM projection_threads AS thread
    INNER JOIN projection_projects AS project ON project.project_id = thread.project_id
    LEFT JOIN projection_thread_sessions AS session ON session.thread_id = thread.thread_id
    LEFT JOIN projection_turns AS latest_turn
      ON latest_turn.thread_id = thread.thread_id AND latest_turn.turn_id = thread.latest_turn_id
    LEFT JOIN projection_worktrees AS worktree ON worktree.worktree_id = thread.worktree_id
    LEFT JOIN projection_thread_messages AS message ON message.message_id = (
      SELECT candidate.message_id FROM projection_thread_messages AS candidate
      WHERE candidate.thread_id = thread.thread_id AND candidate.role = 'user'
      ORDER BY candidate.created_at DESC, candidate.message_id DESC LIMIT 1
    )
    WHERE thread.deleted_at IS NULL
      AND thread.archived_at IS NULL
      AND project.deleted_at IS NULL
      AND COALESCE(thread.settled_override, 'active') <> 'settled'
      AND (thread.snoozed_until IS NULL OR julianday(thread.snoozed_until) <= julianday('now'))
    ORDER BY thread.updated_at DESC, thread.thread_id ASC
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): ThreadPriorityCandidateInput => ({
        threadId: ThreadId.make(row.threadId),
        title: row.title,
        projectName: row.projectName,
        branchName: row.branchName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        activityState:
          row.sessionStatus === "running" || row.sessionStatus === "starting"
            ? "running"
            : row.sessionStatus === "stopped" || row.sessionStatus === "interrupted"
              ? "stopped"
              : "idle",
        hasPendingApproval: row.pendingApprovalCount > 0,
        hasPendingUserInput: row.pendingUserInputCount > 0,
        queueState: row.hasQueuedTurn > 0 ? "queued-turn" : "none",
        hasLatestFailure: row.latestTurnState === "error" || row.sessionStatus === "error",
        deliveryState: "known",
        pullRequest:
          row.prTitle === null ? null : { title: row.prTitle, state: row.prState ?? "unknown" },
        issue:
          row.issueTitle === null
            ? null
            : { title: row.issueTitle, state: row.issueState ?? "unknown" },
        latestUserRequest:
          row.latestUserRequestParts === null
            ? row.latestUserRequest
            : decodeMessageText(row.latestUserRequestParts),
      })),
    ),
    Effect.mapError(toPersistenceSqlError("ThreadPriorityCandidateQuery.listActive")),
  );
  return { listActive } satisfies ThreadPriorityCandidateQueryShape;
});

export const ThreadPriorityCandidateQueryLive = Layer.effect(
  ThreadPriorityCandidateQuery,
  makeThreadPriorityCandidateQuery,
);
