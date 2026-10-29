import { assembledMessageText, decodeMessageText } from "../persistence/messageText.ts";
import {
  ThreadId,
  type OrchestrationLatestTurnState,
  type OrchestrationSessionStatus,
  type PullRequestState,
  type SidebarAutoSettleAfterDays,
  type ThreadSettlementOverride,
} from "@ryco/contracts";
import {
  classifyThreadSettlement,
  type ThreadSettlementInput,
} from "@ryco/shared/threadSettlement";
import { Context, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import type { ThreadPriorityCandidateInput } from "./threadPriorityPolicy.ts";

export interface ThreadPriorityCandidateQueryInput {
  /** The node's automatic settlement rule; a thread it settled is not a candidate. */
  readonly autoSettleAfterDays: SidebarAutoSettleAfterDays;
  readonly nowMs: number;
}

export interface ThreadPriorityCandidateQueryShape {
  readonly listActive: (
    input: ThreadPriorityCandidateQueryInput,
  ) => Effect.Effect<ReadonlyArray<ThreadPriorityCandidateInput>, PersistenceSqlError>;
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
  readonly interactionMode: string;
  readonly hasActionableProposedPlan: number;
  readonly settledOverride: string | null;
  readonly settledAt: string | null;
  readonly latestUserMessageAt: string | null;
  readonly latestTurnRequestedAt: string | null;
  readonly latestTurnStartedAt: string | null;
  readonly latestTurnCompletedAt: string | null;
  readonly worktreeArchivedAt: string | null;
  readonly worktreeUpdatedAt: string | null;
  readonly prNumber: number | null;
  readonly prTerminalAt: string | null;
}

/**
 * The settlement input the inbox judges a candidate by, from its projected
 * rows. A ready plan counts as pending input, as clients count it; pins are
 * client-local and never settle a thread, so they are left out.
 */
function candidateSettlementInput(
  row: CandidateRow,
  backgroundLiveness: "working" | "monitoring" | null,
  input: ThreadPriorityCandidateQueryInput,
): ThreadSettlementInput {
  const planReady = row.interactionMode === "plan" && row.hasActionableProposedPlan > 0;
  return {
    threadSettlementSupported: true,
    archivedAt: null,
    deletedAt: null,
    worktreeArchivedAt: row.worktreeArchivedAt,
    settledOverride: row.settledOverride as ThreadSettlementOverride | null,
    settledAt: row.settledAt,
    sessionStatus: row.sessionStatus as OrchestrationSessionStatus | null,
    latestTurnState: row.latestTurnState as OrchestrationLatestTurnState | null,
    latestTurnRequestedAt: row.latestTurnRequestedAt,
    latestTurnStartedAt: row.latestTurnStartedAt,
    latestTurnCompletedAt: row.latestTurnCompletedAt,
    latestUserMessageAt: row.latestUserMessageAt,
    hasPendingApprovals: row.pendingApprovalCount > 0,
    hasPendingUserInput: row.pendingUserInputCount > 0 || planReady,
    hasLocalQueuedMessage: false,
    deliveryUnknown: false,
    pinned: false,
    backgroundLiveness,
    prNumber: row.prNumber,
    prState: row.prState as PullRequestState | null,
    prTerminalAt: row.prTerminalAt,
    worktreeUpdatedAt: row.worktreeUpdatedAt,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    autoSettleAfterDays: input.autoSettleAfterDays,
    nowMs: input.nowMs,
  };
}

const makeThreadPriorityCandidateQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const liveness = yield* Effect.serviceOption(ThreadBackgroundLivenessService);
  const backgroundLivenessOf = (threadId: string) =>
    Option.isSome(liveness) ? liveness.value.getThreadBackgroundLiveness(threadId) : null;
  const selectRows = sql<CandidateRow>`
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
      ${assembledMessageText(sql, "message")} AS "latestUserRequestParts",
      thread.interaction_mode AS "interactionMode",
      thread.has_actionable_proposed_plan AS "hasActionableProposedPlan",
      thread.settled_override AS "settledOverride",
      thread.settled_at AS "settledAt",
      thread.latest_user_message_at AS "latestUserMessageAt",
      latest_turn.requested_at AS "latestTurnRequestedAt",
      latest_turn.started_at AS "latestTurnStartedAt",
      latest_turn.completed_at AS "latestTurnCompletedAt",
      worktree.archived_at AS "worktreeArchivedAt",
      worktree.updated_at AS "worktreeUpdatedAt",
      worktree.pr_number AS "prNumber",
      worktree.pr_terminal_at AS "prTerminalAt"
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
  `;
  // The node's own rule decides which threads its clients list as Settled; those
  // are not ranked, as manually settled ones never were.
  const listActive: ThreadPriorityCandidateQueryShape["listActive"] = (input) =>
    selectRows.pipe(
      Effect.map((rows) =>
        rows.filter(
          (row) =>
            classifyThreadSettlement(
              candidateSettlementInput(row, backgroundLivenessOf(row.threadId), input),
            ) === "active",
        ),
      ),
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
