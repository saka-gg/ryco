import {
  ChatAttachment,
  DEFAULT_AGENT_TOKEN_MODE,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadHistoryError,
  Worktree,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadMessageSearchResult,
  type OrchestrationThreadHistoryPage,
  type OrchestrationThreadHistoryPageInfo,
  type OrchestrationThreadWindowSnapshot,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ThreadPriorityProjectedRanking,
  type OrchestrationWorktreeShell,
  ModelSelection,
  ProjectId,
  type RepositoryIdentity,
  ThreadId,
  ThreadGoal,
  TurnDispatchMode,
  WorktreeId,
} from "@ryco/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { pruneStaleContextWindowActivities } from "../contextWindowActivities.ts";
import {
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  type ActivityCursorOrder,
  type CheckpointCursorOrder,
  type CreatedAtCursorOrder,
} from "../threadHistoryCursor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeProjectedPriority = Schema.decodeUnknownSync(ThreadPriorityProjectedRanking);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    dispatchMode: Schema.NullOr(TurnDispatchMode),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    goal: Schema.NullOr(Schema.fromJsonString(ThreadGoal)),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionWorktreeDbRowSchema = Worktree.mapFields(
  Struct.assign({
    prIsDraft: Schema.NullOr(Schema.Number),
  }),
);
function toWorktreeShell(
  row: Schema.Schema.Type<typeof ProjectionWorktreeDbRowSchema>,
): OrchestrationWorktreeShell {
  return {
    ...row,
    prIsDraft: row.prIsDraft === null ? null : row.prIsDraft === 1,
  };
}
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
type ProjectionThreadRow = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
type ProjectionMessageRow = Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>;
type ProjectionPlanRow = Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>;
type ProjectionActivityRow = Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>;
type ProjectionCheckpointRow = Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>;
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const WorktreeIdLookupInput = Schema.Struct({
  worktreeId: WorktreeId,
});
const ThreadMessageSearchQueryInput = Schema.Struct({
  likePattern: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  limit: NonNegativeInt,
});
const BoundedThreadHistoryQueryInput = Schema.Struct({
  threadId: ThreadId,
  limit: NonNegativeInt,
});
const CreatedAtHistoryBeforeQueryInput = BoundedThreadHistoryQueryInput.mapFields(
  Struct.assign({
    beforeCreatedAt: IsoDateTime,
    beforeId: Schema.String,
  }),
);
const ActivityHistoryBeforeQueryInput = CreatedAtHistoryBeforeQueryInput.mapFields(
  Struct.assign({
    beforeSequence: Schema.NullOr(NonNegativeInt),
  }),
);
const CheckpointHistoryBeforeQueryInput = BoundedThreadHistoryQueryInput.mapFields(
  Struct.assign({
    beforeCheckpointTurnCount: NonNegativeInt,
    beforeId: Schema.String,
  }),
);
const MessageHistoryAnchorQueryInput = BoundedThreadHistoryQueryInput.mapFields(
  Struct.assign({
    anchorMessageId: MessageId,
  }),
);
const HistoryBoundaryRowSchema = Schema.Struct({ id: Schema.String });
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadMessageSearchRowSchema = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
  ORCHESTRATION_PROJECTOR_NAMES.worktrees,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildMessageSearchSnippet(input: {
  readonly text: string;
  readonly query: string;
  readonly maxLength?: number;
}): string {
  const maxLength = input.maxLength ?? 180;
  const normalizedQuery = input.query.trim().toLowerCase();
  const normalizedText = input.text.toLowerCase();
  const matchIndex = normalizedQuery.length > 0 ? normalizedText.indexOf(normalizedQuery) : -1;
  const contextLength = Math.floor(maxLength / 2);
  const start =
    matchIndex <= contextLength ? 0 : Math.max(0, matchIndex - Math.floor(contextLength / 2));
  const end = Math.min(input.text.length, start + maxLength);
  const snippet = input.text.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "..." : "";
  const suffix = end < input.text.length ? "..." : "";
  return `${prefix}${snippet}${suffix}`;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    ...(row.runtimeSessionId !== null ? { runtimeSessionId: row.runtimeSessionId } : {}),
    runtimeMode: row.runtimeMode,
    tokenMode: row.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    projectMetadataDir: row.projectMetadataDir,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    customSystemPrompt: row.customSystemPrompt ?? null,
    customAvatarContentHash: row.customAvatarContentHash ?? null,
    preferredRemoteName: row.preferredRemoteName ?? null,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMessageRow(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): OrchestrationMessage {
  const message = {
    id: row.messageId,
    role: row.role,
    text: row.text,
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return Object.assign(
    message,
    row.attachments === null ? {} : { attachments: row.attachments },
    row.dispatchMode === null ? {} : { dispatchMode: row.dispatchMode },
  );
}

function mapActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  const activity = {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
  return row.sequence === null ? activity : Object.assign(activity, { sequence: row.sequence });
}

function mapCheckpointRow(
  row: Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>,
): OrchestrationCheckpointSummary {
  return {
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
    files: row.files,
    assistantMessageId: row.assistantMessageId,
    completedAt: row.completedAt,
  };
}

function createdAtHistoryPageInfo(input: {
  readonly threadId: ThreadId;
  readonly collection: "messages" | "proposedPlans";
  readonly rows: ReadonlyArray<{
    readonly createdAt: string;
    readonly id: string;
  }>;
  readonly hasMoreBefore: boolean;
}): OrchestrationThreadHistoryPageInfo {
  const cursorFor = (row: { readonly createdAt: string; readonly id: string }) =>
    encodeThreadHistoryCursor({
      threadId: input.threadId,
      collection: input.collection,
      order: { createdAt: row.createdAt, id: row.id },
    });
  return {
    oldestCursor: input.rows[0] ? cursorFor(input.rows[0]) : null,
    newestCursor: input.rows.at(-1) ? cursorFor(input.rows.at(-1)!) : null,
    hasMoreBefore: input.hasMoreBefore,
  };
}

function activityHistoryPageInfo(input: {
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<ProjectionActivityRow>;
  readonly hasMoreBefore: boolean;
}): OrchestrationThreadHistoryPageInfo {
  const cursorFor = (row: ProjectionActivityRow) =>
    encodeThreadHistoryCursor({
      threadId: input.threadId,
      collection: "activities",
      order: {
        sequence: row.sequence,
        createdAt: row.createdAt,
        id: row.activityId,
      },
    });
  return {
    oldestCursor: input.rows[0] ? cursorFor(input.rows[0]) : null,
    newestCursor: input.rows.at(-1) ? cursorFor(input.rows.at(-1)!) : null,
    hasMoreBefore: input.hasMoreBefore,
  };
}

function checkpointHistoryPageInfo(input: {
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<ProjectionCheckpointRow>;
  readonly hasMoreBefore: boolean;
}): OrchestrationThreadHistoryPageInfo {
  const cursorFor = (row: ProjectionCheckpointRow) =>
    encodeThreadHistoryCursor({
      threadId: input.threadId,
      collection: "checkpoints",
      order: { checkpointTurnCount: row.checkpointTurnCount, id: row.turnId },
    });
  return {
    oldestCursor: input.rows[0] ? cursorFor(input.rows[0]) : null,
    newestCursor: input.rows.at(-1) ? cursorFor(input.rows.at(-1)!) : null,
    hasMoreBefore: input.hasMoreBefore,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
  const repositoryIdentityResolutionConcurrency = 4;
  const listThreadPriorityRows = () => {
    const now = new Date().toISOString();
    return sql<{
      readonly threadId: string;
      readonly tier: ThreadPriorityProjectedRanking["tier"];
      readonly confidence: ThreadPriorityProjectedRanking["confidence"];
      readonly reason: string;
      readonly inputFingerprint: string;
      readonly batchId: string;
      readonly modelSelectionJson: string;
      readonly rankedAt: string;
      readonly usableUntil: string;
    }>`
      SELECT
        ranking.thread_id AS "threadId",
        ranking.tier,
        ranking.confidence,
        ranking.reason,
        ranking.input_fingerprint AS "inputFingerprint",
        batch.batch_id AS "batchId",
        batch.model_selection_json AS "modelSelectionJson",
        batch.ranked_at AS "rankedAt",
        batch.usable_until AS "usableUntil"
      FROM thread_priority_rankings AS ranking
      INNER JOIN thread_priority_batches AS batch ON batch.batch_id = ranking.batch_id
      WHERE batch.usable_until > ${now}
      ORDER BY ranking.thread_id ASC
    `;
  };
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
      readonly timeoutMs?: number;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map<string, RepositoryIdentity | null>();
    const resolveIdentities = Effect.forEach(
      uniqueWorkspaceRoots,
      (workspaceRoot) =>
        repositoryIdentityResolver.resolve(workspaceRoot).pipe(
          Effect.tap((identity) =>
            Effect.sync(() => {
              repositoryIdentityByWorkspaceRoot.set(workspaceRoot, identity);
            }),
          ),
        ),
      { concurrency: repositoryIdentityResolutionConcurrency, discard: true },
    );
    // Git enrichment is optional. A slow/offline filesystem must not hide the
    // persisted catalog, and the budget covers all roots rather than each batch.
    yield* options?.timeoutMs === undefined
      ? resolveIdentities
      : resolveIdentities.pipe(Effect.timeoutOption(options.timeoutMs));

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          project_metadata_dir AS "projectMetadataDir",
          default_model_selection_json AS "defaultModelSelection",
          custom_system_prompt AS "customSystemPrompt",
          custom_avatar_content_hash AS "customAvatarContentHash",
          preferred_remote_name AS "preferredRemoteName",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          token_mode AS "tokenMode",
          branch,
          worktree_path AS "worktreePath",
          worktree_id AS "worktreeId",
          manual_status_bucket AS "manualStatusBucket",
          manual_position AS "manualPosition",
          latest_turn_id AS "latestTurnId",
          goal_json AS "goal",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listWorktreeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorktreeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          title,
          branch,
          worktree_path AS "worktreePath",
          origin,
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          pr_title AS "prTitle",
          issue_title AS "issueTitle",
          pr_state AS "prState",
          pr_is_draft AS "prIsDraft",
          issue_state AS "issueState",
          work_item_provider AS "workItemProvider",
          work_item_key AS "workItemKey",
          work_item_title AS "workItemTitle",
          work_item_state AS "workItemState",
          work_item_state_name AS "workItemStateName",
          work_item_url AS "workItemUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          manual_position AS "manualPosition"
        FROM projection_worktrees
        ORDER BY project_id ASC, manual_position ASC, created_at ASC, worktree_id ASC
      `,
  });

  const getWorktreeRowById = SqlSchema.findOneOption({
    Request: WorktreeIdLookupInput,
    Result: ProjectionWorktreeDbRowSchema,
    execute: ({ worktreeId }) =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          title,
          branch,
          worktree_path AS "worktreePath",
          origin,
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          pr_title AS "prTitle",
          issue_title AS "issueTitle",
          pr_state AS "prState",
          pr_is_draft AS "prIsDraft",
          issue_state AS "issueState",
          work_item_provider AS "workItemProvider",
          work_item_key AS "workItemKey",
          work_item_title AS "workItemTitle",
          work_item_state AS "workItemState",
          work_item_state_name AS "workItemStateName",
          work_item_url AS "workItemUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          manual_position AS "manualPosition"
        FROM projection_worktrees
        WHERE worktree_id = ${worktreeId}
        LIMIT 1
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          dispatch_mode AS "dispatchMode",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  // The command read model does not need full message history, but it must
  // retain whether a thread has already accepted a user turn. Otherwise a
  // process restart makes an established thread look new and a provider/model
  // change bypasses the atomic context-handoff path.
  const listFirstUserMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.turn_id AS "turnId",
          messages.role,
          messages.text,
          messages.attachments_json AS "attachments",
          messages.dispatch_mode AS "dispatchMode",
          messages.is_streaming AS "isStreaming",
          messages.created_at AS "createdAt",
          messages.updated_at AS "updatedAt"
        FROM projection_thread_messages messages
        WHERE messages.role = 'user'
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_messages earlier
            WHERE earlier.thread_id = messages.thread_id
              AND earlier.role = 'user'
              AND (
                earlier.created_at < messages.created_at
                OR (
                  earlier.created_at = messages.created_at
                  AND earlier.message_id < messages.message_id
                )
              )
          )
        ORDER BY messages.thread_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  // Idle-only command invariants need the lifecycle pairs that can block a
  // handoff even after restart. Keep this intentionally narrow instead of
  // hydrating arbitrary activity history into the command read model.
  const listActionableThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE kind IN (
          'approval.requested',
          'approval.resolved',
          'provider.approval.respond.failed',
          'user-input.requested',
          'user-input.resolved',
          'provider.user-input.respond.failed',
          'context-handoff'
        )
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_session_id AS "runtimeSessionId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          token_mode AS "tokenMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          project_metadata_dir AS "projectMetadataDir",
          default_model_selection_json AS "defaultModelSelection",
          custom_system_prompt AS "customSystemPrompt",
          custom_avatar_content_hash AS "customAvatarContentHash",
          preferred_remote_name AS "preferredRemoteName",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          project_metadata_dir AS "projectMetadataDir",
          default_model_selection_json AS "defaultModelSelection",
          custom_system_prompt AS "customSystemPrompt",
          custom_avatar_content_hash AS "customAvatarContentHash",
          preferred_remote_name AS "preferredRemoteName",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          token_mode AS "tokenMode",
          branch,
          worktree_path AS "worktreePath",
          worktree_id AS "worktreeId",
          manual_status_bucket AS "manualStatusBucket",
          manual_position AS "manualPosition",
          latest_turn_id AS "latestTurnId",
          goal_json AS "goal",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          dispatch_mode AS "dispatchMode",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const searchThreadMessageRows = SqlSchema.findAll({
    Request: ThreadMessageSearchQueryInput,
    Result: ProjectionThreadMessageSearchRowSchema,
    execute: ({ likePattern, projectId, threadId, limit }) =>
      sql`
        SELECT
          messages.thread_id AS "threadId",
          messages.message_id AS "messageId",
          messages.text,
          messages.created_at AS "createdAt",
          messages.updated_at AS "updatedAt"
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND projects.deleted_at IS NULL
          AND messages.role IN ('user', 'assistant')
          AND (${projectId} IS NULL OR threads.project_id = ${projectId})
          AND (${threadId} IS NULL OR messages.thread_id = ${threadId})
          AND lower(messages.text) LIKE ${likePattern} ESCAPE '\\'
        ORDER BY messages.created_at DESC, messages.message_id DESC
        LIMIT ${limit}
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  // Payload-only projection for task rows: the linkage bundle (runHandles,
  // outputFile) rides exclusively on task.* kinds, so path authorization
  // never needs messages, plans, or checkpoints.
  const listThreadTaskPayloadRows = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: Schema.Struct({ payload: Schema.fromJsonString(Schema.Unknown) }),
    execute: ({ threadId }) =>
      sql`
        SELECT payload_json AS "payload"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind LIKE 'task.%'
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_session_id AS "runtimeSessionId",
          runtime_mode AS "runtimeMode",
          token_mode AS "tokenMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const listNewestThreadMessageRows = SqlSchema.findAll({
    Request: BoundedThreadHistoryQueryInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC, message_id DESC
      LIMIT ${limit}
    `,
  });

  // Turn-scoped and single-message reads for ingestion/turn-start hot paths:
  // these avoid hydrating every message of a thread when one turn (or one
  // row) is all the caller needs.
  const getThreadMessageRowById = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: ThreadId,
      messageId: MessageId,
    }),
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, messageId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND message_id = ${messageId}
      LIMIT 1
    `,
  });

  const listThreadMessageRowsByTurn = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: ThreadId,
      turnId: TurnId,
      limit: NonNegativeInt,
    }),
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, turnId, limit }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND turn_id = ${turnId}
      ORDER BY created_at DESC, message_id DESC
      LIMIT ${limit}
    `,
  });

  const countThreadUserMessageRows = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: Schema.Struct({ userMessages: NonNegativeInt }),
    execute: ({ threadId }) => sql`
      SELECT COUNT(*) AS "userMessages"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'user'
    `,
  });

  const listThreadMessageRowsBefore = SqlSchema.findAll({
    Request: CreatedAtHistoryBeforeQueryInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeId, limit }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND (
          created_at < ${beforeCreatedAt}
          OR (created_at = ${beforeCreatedAt} AND message_id < ${beforeId})
        )
      ORDER BY created_at DESC, message_id DESC
      LIMIT ${limit}
    `,
  });

  const getThreadMessageAnchorRow = SqlSchema.findOneOption({
    Request: MessageHistoryAnchorQueryInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, anchorMessageId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND message_id = ${anchorMessageId}
      LIMIT 1
    `,
  });

  const listThreadMessageRowsAfter = SqlSchema.findAll({
    Request: CreatedAtHistoryBeforeQueryInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeId, limit }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND (
          created_at > ${beforeCreatedAt}
          OR (created_at = ${beforeCreatedAt} AND message_id > ${beforeId})
        )
      ORDER BY created_at ASC, message_id ASC
      LIMIT ${limit}
    `,
  });

  const listNewestThreadProposedPlanRows = SqlSchema.findAll({
    Request: BoundedThreadHistoryQueryInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC, plan_id DESC
      LIMIT ${limit}
    `,
  });

  const listThreadProposedPlanRowsBefore = SqlSchema.findAll({
    Request: CreatedAtHistoryBeforeQueryInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeId, limit }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
        AND (
          created_at < ${beforeCreatedAt}
          OR (created_at = ${beforeCreatedAt} AND plan_id < ${beforeId})
        )
      ORDER BY created_at DESC, plan_id DESC
      LIMIT ${limit}
    `,
  });

  // Plan finalization only needs the row it replaces (prior timestamps), so
  // it reads one plan row instead of every proposed plan of the thread.
  const getThreadProposedPlanRowById = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: ThreadId,
      planId: Schema.String,
    }),
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId, planId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
        AND plan_id = ${planId}
      LIMIT 1
    `,
  });

  const listNewestThreadActivityRows = SqlSchema.findAll({
    Request: BoundedThreadHistoryQueryInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT
        activity_id AS "activityId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payload",
        sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
      ORDER BY
        CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
        sequence DESC,
        created_at DESC,
        activity_id DESC
      LIMIT ${limit}
    `,
  });

  const listThreadActivityRowsBefore = SqlSchema.findAll({
    Request: ActivityHistoryBeforeQueryInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, beforeSequence, beforeCreatedAt, beforeId, limit }) => {
      const beforeSequenceBucket = beforeSequence === null ? 0 : 1;
      return sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND (
            CASE WHEN sequence IS NULL THEN 0 ELSE 1 END < ${beforeSequenceBucket}
            OR (
              CASE WHEN sequence IS NULL THEN 0 ELSE 1 END = ${beforeSequenceBucket}
              AND (
                (${beforeSequence} IS NULL AND (
                  created_at < ${beforeCreatedAt}
                  OR (created_at = ${beforeCreatedAt} AND activity_id < ${beforeId})
                ))
                OR (${beforeSequence} IS NOT NULL AND (
                  sequence < ${beforeSequence}
                  OR (sequence = ${beforeSequence} AND (
                    created_at < ${beforeCreatedAt}
                    OR (created_at = ${beforeCreatedAt} AND activity_id < ${beforeId})
                  ))
                ))
              )
            )
          )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT ${limit}
      `;
    },
  });

  const listNewestCheckpointRows = SqlSchema.findAll({
    Request: BoundedThreadHistoryQueryInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId",
        checkpoint_turn_count AS "checkpointTurnCount",
        checkpoint_ref AS "checkpointRef",
        checkpoint_status AS "status",
        checkpoint_files_json AS "files",
        assistant_message_id AS "assistantMessageId",
        completed_at AS "completedAt"
      FROM projection_turns
      WHERE thread_id = ${threadId}
        AND checkpoint_turn_count IS NOT NULL
      ORDER BY checkpoint_turn_count DESC, turn_id DESC
      LIMIT ${limit}
    `,
  });

  const listCheckpointRowsBefore = SqlSchema.findAll({
    Request: CheckpointHistoryBeforeQueryInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, beforeCheckpointTurnCount, beforeId, limit }) => sql`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId",
        checkpoint_turn_count AS "checkpointTurnCount",
        checkpoint_ref AS "checkpointRef",
        checkpoint_status AS "status",
        checkpoint_files_json AS "files",
        assistant_message_id AS "assistantMessageId",
        completed_at AS "completedAt"
      FROM projection_turns
      WHERE thread_id = ${threadId}
        AND checkpoint_turn_count IS NOT NULL
        AND (
          checkpoint_turn_count < ${beforeCheckpointTurnCount}
          OR (
            checkpoint_turn_count = ${beforeCheckpointTurnCount}
            AND turn_id < ${beforeId}
          )
        )
      ORDER BY checkpoint_turn_count DESC, turn_id DESC
      LIMIT ${limit}
      `,
  });

  const getMessageHistoryBoundary = SqlSchema.findOneOption({
    Request: CreatedAtHistoryBeforeQueryInput,
    Result: HistoryBoundaryRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeId }) => sql`
      SELECT message_id AS id
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND message_id = ${beforeId}
        AND created_at = ${beforeCreatedAt}
      LIMIT 1
    `,
  });

  const getProposedPlanHistoryBoundary = SqlSchema.findOneOption({
    Request: CreatedAtHistoryBeforeQueryInput,
    Result: HistoryBoundaryRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeId }) => sql`
      SELECT plan_id AS id
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
        AND plan_id = ${beforeId}
        AND created_at = ${beforeCreatedAt}
      LIMIT 1
    `,
  });

  const getActivityHistoryBoundary = SqlSchema.findOneOption({
    Request: ActivityHistoryBeforeQueryInput,
    Result: HistoryBoundaryRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeId, beforeSequence }) => sql`
      SELECT activity_id AS id
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND activity_id = ${beforeId}
        AND created_at = ${beforeCreatedAt}
        AND (
          (sequence IS NULL AND ${beforeSequence} IS NULL)
          OR sequence = ${beforeSequence}
        )
      LIMIT 1
    `,
  });

  const getCheckpointHistoryBoundary = SqlSchema.findOneOption({
    Request: CheckpointHistoryBeforeQueryInput,
    Result: HistoryBoundaryRowSchema,
    execute: ({ threadId, beforeCheckpointTurnCount, beforeId }) => sql`
      SELECT turn_id AS id
      FROM projection_turns
      WHERE thread_id = ${threadId}
        AND turn_id = ${beforeId}
        AND checkpoint_turn_count = ${beforeCheckpointTurnCount}
      LIMIT 1
    `,
  });

  const decodeThreadFromProjectionRows = (input: {
    readonly threadRow: ProjectionThreadRow;
    readonly messageRows: ReadonlyArray<ProjectionMessageRow>;
    readonly proposedPlanRows: ReadonlyArray<ProjectionPlanRow>;
    readonly activityRows: ReadonlyArray<ProjectionActivityRow>;
    readonly checkpointRows: ReadonlyArray<ProjectionCheckpointRow>;
    readonly latestTurnRow: Option.Option<
      Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>
    >;
    readonly sessionRow: Option.Option<
      Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>
    >;
    readonly pruneContextActivities?: boolean;
  }) => {
    const activities = input.activityRows.map(mapActivityRow);
    return decodeThread({
      id: input.threadRow.threadId,
      projectId: input.threadRow.projectId,
      title: input.threadRow.title,
      modelSelection: input.threadRow.modelSelection,
      runtimeMode: input.threadRow.runtimeMode,
      interactionMode: input.threadRow.interactionMode,
      tokenMode: input.threadRow.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
      branch: input.threadRow.branch,
      worktreePath: input.threadRow.worktreePath,
      worktreeId: input.threadRow.worktreeId ?? null,
      manualStatusBucket: input.threadRow.manualStatusBucket ?? null,
      manualPosition: input.threadRow.manualPosition ?? 0,
      latestTurn: Option.isSome(input.latestTurnRow)
        ? mapLatestTurn(input.latestTurnRow.value)
        : null,
      goal: input.threadRow.goal,
      createdAt: input.threadRow.createdAt,
      updatedAt: input.threadRow.updatedAt,
      archivedAt: input.threadRow.archivedAt,
      settledOverride: input.threadRow.settledOverride,
      settledAt: input.threadRow.settledAt,
      snoozedUntil: input.threadRow.snoozedUntil ?? null,
      snoozedAt: input.threadRow.snoozedAt ?? null,
      deletedAt: null,
      messages: input.messageRows.map(mapMessageRow),
      proposedPlans: input.proposedPlanRows.map(mapProposedPlanRow),
      activities:
        input.pruneContextActivities === false
          ? activities
          : pruneStaleContextWindowActivities(activities),
      checkpoints: input.checkpointRows.map(mapCheckpointRow),
      session: Option.isSome(input.sessionRow) ? mapSessionRow(input.sessionRow.value) : null,
    });
  };

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listWorktreeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listWorktrees:query",
                "ProjectionSnapshotQuery.getSnapshot:listWorktrees:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            worktreeRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of worktreeRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  ...(row.runtimeSessionId !== null
                    ? { runtimeSessionId: row.runtimeSessionId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  tokenMode: row.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                {
                  includeDeleted: true,
                },
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                tokenMode: row.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
                branch: row.branch,
                worktreePath: row.worktreePath,
                worktreeId: row.worktreeId ?? null,
                manualStatusBucket: row.manualStatusBucket ?? null,
                manualPosition: row.manualPosition ?? 0,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                goal: row.goal,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                settledOverride: row.settledOverride,
                settledAt: row.settledAt,
                snoozedUntil: row.snoozedUntil ?? null,
                snoozedAt: row.snoozedAt ?? null,
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: pruneStaleContextWindowActivities(
                  activitiesByThread.get(row.threadId) ?? [],
                ),
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                worktrees: worktreeRows.map(toWorktreeShell),
                threads,
                updatedAt: updatedAt ?? new Date(0).toISOString(),
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
              ),
            ),
          ),
          listWorktreeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listWorktrees:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listWorktrees:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
              ),
            ),
          ),
          listFirstUserMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listFirstUserMessages:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listFirstUserMessages:decodeRows",
              ),
            ),
          ),
          listActionableThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listActionableThreadActivities:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listActionableThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            worktreeRows,
            threadRows,
            firstUserMessageRows,
            actionableActivityRows,
            proposedPlanRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.sync(() => {
              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const worktrees: OrchestrationWorktreeShell[] = [];
              const threads: OrchestrationThread[] = [];
              const firstUserMessageByThread = new Map<string, OrchestrationMessage>();
              const actionableActivitiesByThread = new Map<
                string,
                Array<OrchestrationThreadActivity>
              >();

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  projectMetadataDir: row.projectMetadataDir,
                  defaultModelSelection: row.defaultModelSelection,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < worktreeRows.length; index += 1) {
                const row = worktreeRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                worktrees.push(toWorktreeShell(row));
              }
              for (let index = 0; index < firstUserMessageRows.length; index += 1) {
                const row = firstUserMessageRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                firstUserMessageByThread.set(row.threadId, {
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
              }
              for (let index = 0; index < actionableActivityRows.length; index += 1) {
                const row = actionableActivityRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.createdAt);
                const activities = actionableActivitiesByThread.get(row.threadId) ?? [];
                activities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                actionableActivitiesByThread.set(row.threadId, activities);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const sessionByThread = new Map<string, OrchestrationSession>();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(row.threadId, mapSessionRow(row));
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  tokenMode: row.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  worktreeId: row.worktreeId ?? null,
                  manualStatusBucket: row.manualStatusBucket ?? null,
                  manualPosition: row.manualPosition ?? 0,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  goal: row.goal,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  snoozedUntil: row.snoozedUntil ?? null,
                  snoozedAt: row.snoozedAt ?? null,
                  deletedAt: row.deletedAt,
                  messages: firstUserMessageByThread.has(row.threadId)
                    ? [firstUserMessageByThread.get(row.threadId)!]
                    : [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  activities: actionableActivitiesByThread.get(row.threadId) ?? [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                worktrees,
                threads,
                updatedAt: updatedAt ?? new Date(0).toISOString(),
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listWorktreeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listWorktrees:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listWorktrees:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
          listThreadPriorityRows().pipe(
            Effect.mapError(
              toPersistenceSqlError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadPriorityRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            worktreeRows,
            sessionRows,
            latestTurnRows,
            stateRows,
            priorityRows,
          ]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of worktreeRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                if (row.archivedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.archivedAt);
                }
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { timeoutMs: 1_000 },
              );
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const activeProjectIds = new Set(
                projectRows.filter((row) => row.deletedAt === null).map((row) => row.projectId),
              );
              const priorityByThread = new Map(
                priorityRows.map((row) => [
                  row.threadId,
                  decodeProjectedPriority({
                    tier: row.tier,
                    confidence: row.confidence,
                    reason: row.reason,
                    inputFingerprint: row.inputFingerprint,
                    batchId: row.batchId,
                    modelSelection: JSON.parse(row.modelSelectionJson) as unknown,
                    rankedAt: row.rankedAt,
                    usableUntil: row.usableUntil,
                  }),
                ]),
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: projectRows
                  .filter((row) => row.deletedAt === null)
                  .map((row) =>
                    mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                  ),
                worktrees: worktreeRows
                  .filter((row) => activeProjectIds.has(row.projectId))
                  .map(toWorktreeShell),
                threads: threadRows
                  .filter((row) => row.deletedAt === null)
                  .map((row): OrchestrationThreadShell => {
                    const shell: OrchestrationThreadShell = {
                      id: row.threadId,
                      projectId: row.projectId,
                      title: row.title,
                      modelSelection: row.modelSelection,
                      runtimeMode: row.runtimeMode,
                      interactionMode: row.interactionMode,
                      tokenMode: row.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
                      branch: row.branch,
                      worktreePath: row.worktreePath,
                      worktreeId: row.worktreeId ?? null,
                      manualStatusBucket: row.manualStatusBucket ?? null,
                      manualPosition: row.manualPosition ?? 0,
                      latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                      goal: row.goal,
                      createdAt: row.createdAt,
                      updatedAt: row.updatedAt,
                      archivedAt: row.archivedAt,
                      settledOverride: row.settledOverride,
                      settledAt: row.settledAt,
                      snoozedUntil: row.snoozedUntil ?? null,
                      snoozedAt: row.snoozedAt ?? null,
                      session: sessionByThread.get(row.threadId) ?? null,
                      latestUserMessageAt: row.latestUserMessageAt,
                      hasPendingApprovals: row.pendingApprovalCount > 0,
                      hasPendingUserInput: row.pendingUserInputCount > 0,
                      hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                      backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                        row.threadId,
                      ),
                    };
                    const priority = priorityByThread.get(row.threadId);
                    return priority === undefined ? shell : Object.assign(shell, { priority });
                  }),
                updatedAt: updatedAt ?? new Date(0).toISOString(),
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
        Effect.tap((snapshot) =>
          Effect.logDebug("startup shell snapshot query complete", {
            projectCount: snapshot.projects.length,
            worktreeCount: snapshot.worktrees?.length ?? 0,
            threadCount: snapshot.threads.length,
            snapshotSequence: snapshot.snapshotSequence,
          }),
        ),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map((row): ProjectionSnapshotCounts => ({
        projectCount: row.projectCount,
        threadCount: row.threadCount,
      })),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    projectMetadataDir: option.value.projectMetadataDir,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({
        threadId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({
        threadId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map((row): OrchestrationCheckpointSummary => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
      });
    });

  const listThreadTaskPathRefs: NonNullable<
    ProjectionSnapshotQueryShape["listThreadTaskPathRefs"]
  > = (threadId) =>
    listThreadTaskPayloadRows({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listThreadTaskPathRefs:query",
          "ProjectionSnapshotQuery.listThreadTaskPathRefs:decodeRows",
        ),
      ),
      Effect.map((rows) => {
        const scriptPaths = new Set<string>();
        const outputPaths = new Set<string>();
        for (const row of rows) {
          const payload = row.payload;
          if (payload === null || typeof payload !== "object") {
            continue;
          }
          const record = payload as Record<string, unknown>;
          const runHandles = record.runHandles;
          if (runHandles !== null && typeof runHandles === "object") {
            const scriptPath = (runHandles as { scriptPath?: unknown }).scriptPath;
            if (typeof scriptPath === "string") {
              scriptPaths.add(scriptPath);
            }
          }
          if (typeof record.outputFile === "string") {
            outputPaths.add(record.outputFile);
          }
        }
        return { scriptPaths: [...scriptPaths], outputPaths: [...outputPaths] };
      }),
    );

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, latestTurnRow, sessionRow] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        tokenMode: threadRow.value.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        worktreeId: threadRow.value.worktreeId ?? null,
        manualStatusBucket: threadRow.value.manualStatusBucket ?? null,
        manualPosition: threadRow.value.manualPosition ?? 0,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        goal: threadRow.value.goal,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        snoozedUntil: threadRow.value.snoozedUntil ?? null,
        snoozedAt: threadRow.value.snoozedAt ?? null,
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
          threadRow.value.threadId,
        ),
      } satisfies OrchestrationThreadShell);
    });

  const getWorktreeShellById: NonNullable<ProjectionSnapshotQueryShape["getWorktreeShellById"]> = (
    worktreeId,
  ) =>
    getWorktreeRowById({ worktreeId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getWorktreeShellById:query",
          "ProjectionSnapshotQuery.getWorktreeShellById:decodeRow",
        ),
      ),
      Effect.map(Option.map(toWorktreeShell)),
    );

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.gen(function* () {
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      return Option.some(
        yield* decodeThreadFromProjectionRows({
          threadRow: threadRow.value,
          messageRows,
          proposedPlanRows,
          activityRows,
          checkpointRows,
          latestTurnRow,
          sessionRow,
        }).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadWindow: ProjectionSnapshotQueryShape["getThreadWindow"] = (input) =>
    Effect.gen(function* () {
      const limits = {
        messages: Math.min(input.limits.messages, 200),
        proposedPlans: Math.min(input.limits.proposedPlans, 50),
        activities: Math.min(input.limits.activities, 200),
        checkpoints: Math.min(input.limits.checkpoints, 50),
      };
      const [
        threadRow,
        rawMessageRows,
        rawProposedPlanRows,
        rawActivityRows,
        rawCheckpointRows,
        latestTurnRow,
        sessionRow,
        stateRows,
      ] = yield* sql
        .withTransaction(
          Effect.all([
            getActiveThreadRowById({ threadId: input.threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:getThread:query",
                  "ProjectionSnapshotQuery.getThreadWindow:getThread:decodeRow",
                ),
              ),
            ),
            listNewestThreadMessageRows({
              threadId: input.threadId,
              limit: limits.messages + 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:listMessages:query",
                  "ProjectionSnapshotQuery.getThreadWindow:listMessages:decodeRows",
                ),
              ),
            ),
            listNewestThreadProposedPlanRows({
              threadId: input.threadId,
              limit: limits.proposedPlans + 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:listPlans:query",
                  "ProjectionSnapshotQuery.getThreadWindow:listPlans:decodeRows",
                ),
              ),
            ),
            listNewestThreadActivityRows({
              threadId: input.threadId,
              limit: limits.activities + 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:listActivities:query",
                  "ProjectionSnapshotQuery.getThreadWindow:listActivities:decodeRows",
                ),
              ),
            ),
            listNewestCheckpointRows({
              threadId: input.threadId,
              limit: limits.checkpoints + 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getThreadWindow:listCheckpoints:decodeRows",
                ),
              ),
            ),
            getLatestTurnRowByThread({ threadId: input.threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:getLatestTurn:query",
                  "ProjectionSnapshotQuery.getThreadWindow:getLatestTurn:decodeRow",
                ),
              ),
            ),
            getThreadSessionRowByThread({ threadId: input.threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:getSession:query",
                  "ProjectionSnapshotQuery.getThreadWindow:getSession:decodeRow",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadWindow:listProjectionState:query",
                  "ProjectionSnapshotQuery.getThreadWindow:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]),
        )
        .pipe(
          Effect.mapError((error) =>
            isPersistenceError(error)
              ? error
              : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadWindow:transaction")(error),
          ),
        );

      if (Option.isNone(threadRow)) {
        return yield* new OrchestrationThreadHistoryError({
          reason: "thread-not-found",
          threadId: input.threadId,
        });
      }

      const messageRows = rawMessageRows.slice(0, limits.messages).toReversed();
      const proposedPlanRows = rawProposedPlanRows.slice(0, limits.proposedPlans).toReversed();
      const activityRows = rawActivityRows.slice(0, limits.activities).toReversed();
      const checkpointRows = rawCheckpointRows.slice(0, limits.checkpoints).toReversed();
      const thread = yield* decodeThreadFromProjectionRows({
        threadRow: threadRow.value,
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
        pruneContextActivities: false,
      }).pipe(
        Effect.mapError(
          toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadWindow:decodeThread"),
        ),
      );

      return {
        snapshotSequence: computeSnapshotSequence(stateRows),
        thread,
        history: {
          messages: createdAtHistoryPageInfo({
            threadId: input.threadId,
            collection: "messages",
            rows: messageRows.map((row) => ({
              createdAt: row.createdAt,
              id: row.messageId,
            })),
            hasMoreBefore: rawMessageRows.length > limits.messages,
          }),
          proposedPlans: createdAtHistoryPageInfo({
            threadId: input.threadId,
            collection: "proposedPlans",
            rows: proposedPlanRows.map((row) => ({
              createdAt: row.createdAt,
              id: row.planId,
            })),
            hasMoreBefore: rawProposedPlanRows.length > limits.proposedPlans,
          }),
          activities: activityHistoryPageInfo({
            threadId: input.threadId,
            rows: activityRows,
            hasMoreBefore: rawActivityRows.length > limits.activities,
          }),
          checkpoints: checkpointHistoryPageInfo({
            threadId: input.threadId,
            rows: checkpointRows,
            hasMoreBefore: rawCheckpointRows.length > limits.checkpoints,
          }),
        },
      } satisfies OrchestrationThreadWindowSnapshot;
    });

  const getThreadHistoryPage: ProjectionSnapshotQueryShape["getThreadHistoryPage"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(
        input.limit,
        input.collection === "messages" || input.collection === "activities" ? 200 : 50,
      );
      const runTransaction = <A, E>(effect: Effect.Effect<A, E>, operation: string) =>
        sql
          .withTransaction(effect)
          .pipe(
            Effect.mapError((error) =>
              isPersistenceError(error) || Schema.is(OrchestrationThreadHistoryError)(error)
                ? error
                : toPersistenceSqlError(operation)(error),
            ),
          );
      const ensureThread = (threadRow: Option.Option<ProjectionThreadRow>) =>
        Option.isSome(threadRow)
          ? Effect.succeed(threadRow.value)
          : Effect.fail(
              new OrchestrationThreadHistoryError({
                reason: "thread-not-found",
                threadId: input.threadId,
                collection: input.collection,
              }),
            );
      const ensureBoundary = (boundary: Option.Option<{ readonly id: string }>) =>
        Option.isSome(boundary)
          ? Effect.void
          : Effect.fail(
              new OrchestrationThreadHistoryError({
                reason: "stale-cursor",
                threadId: input.threadId,
                collection: input.collection,
              }),
            );
      const stateEffect = listProjectionStateRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadHistoryPage:listProjectionState:query",
            "ProjectionSnapshotQuery.getThreadHistoryPage:listProjectionState:decodeRows",
          ),
        ),
      );
      const threadEffect = getActiveThreadRowById({
        threadId: input.threadId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadHistoryPage:getThread:query",
            "ProjectionSnapshotQuery.getThreadHistoryPage:getThread:decodeRow",
          ),
        ),
      );

      if (input.mode.kind === "around") {
        const anchorId = input.mode.anchorId;
        const [stateRows, anchorRow, olderRows, newerRows] = yield* runTransaction(
          Effect.gen(function* () {
            const [threadRow, stateRows, anchorRow] = yield* Effect.all([
              threadEffect,
              stateEffect,
              getThreadMessageAnchorRow({
                threadId: input.threadId,
                anchorMessageId: anchorId,
                limit: 1,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadHistoryPage:getAnchor:query",
                    "ProjectionSnapshotQuery.getThreadHistoryPage:getAnchor:decodeRow",
                  ),
                ),
              ),
            ]);
            yield* ensureThread(threadRow);
            if (Option.isNone(anchorRow)) {
              return yield* new OrchestrationThreadHistoryError({
                reason: "stale-cursor",
                threadId: input.threadId,
                collection: "messages",
              });
            }
            const anchor = anchorRow.value;
            const [olderRows, newerRows] = yield* Effect.all([
              listThreadMessageRowsBefore({
                threadId: input.threadId,
                beforeCreatedAt: anchor.createdAt,
                beforeId: anchor.messageId,
                limit: limit + 1,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadHistoryPage:listOlderMessages:query",
                    "ProjectionSnapshotQuery.getThreadHistoryPage:listOlderMessages:decodeRows",
                  ),
                ),
              ),
              listThreadMessageRowsAfter({
                threadId: input.threadId,
                beforeCreatedAt: anchor.createdAt,
                beforeId: anchor.messageId,
                limit,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadHistoryPage:listNewerMessages:query",
                    "ProjectionSnapshotQuery.getThreadHistoryPage:listNewerMessages:decodeRows",
                  ),
                ),
              ),
            ]);
            return [stateRows, anchor, olderRows, newerRows] as const;
          }),
          "ProjectionSnapshotQuery.getThreadHistoryPage:aroundTransaction",
        );
        const desiredOlderCount = Math.floor((limit - 1) / 2);
        let olderCount = Math.min(olderRows.length, desiredOlderCount);
        const newerCount = Math.min(newerRows.length, limit - 1 - olderCount);
        olderCount = Math.min(olderRows.length, limit - 1 - newerCount);
        const selectedOlderRows = olderRows.slice(0, olderCount).toReversed();
        const selectedRows = [...selectedOlderRows, anchorRow, ...newerRows.slice(0, newerCount)];
        return {
          collection: "messages",
          snapshotSequence: computeSnapshotSequence(stateRows),
          items: selectedRows.map(mapMessageRow),
          page: createdAtHistoryPageInfo({
            threadId: input.threadId,
            collection: "messages",
            rows: selectedRows.map((row) => ({
              createdAt: row.createdAt,
              id: row.messageId,
            })),
            hasMoreBefore: olderRows.length > olderCount,
          }),
        } satisfies OrchestrationThreadHistoryPage;
      }

      const decodedCursor = decodeThreadHistoryCursor(input.mode.cursor, {
        threadId: input.threadId,
        collection: input.collection,
      });
      if (!decodedCursor.ok) {
        return yield* new OrchestrationThreadHistoryError({
          reason: decodedCursor.reason,
          threadId: input.threadId,
          collection: input.collection,
        });
      }

      if (input.collection === "messages") {
        const order = decodedCursor.order as CreatedAtCursorOrder;
        const [threadRow, stateRows, rawRows, boundary] = yield* runTransaction(
          Effect.all([
            threadEffect,
            stateEffect,
            listThreadMessageRowsBefore({
              threadId: input.threadId,
              beforeCreatedAt: order.createdAt,
              beforeId: order.id,
              limit: limit + 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadHistoryPage:listMessages:query",
                  "ProjectionSnapshotQuery.getThreadHistoryPage:listMessages:decodeRows",
                ),
              ),
            ),
            getMessageHistoryBoundary({
              threadId: input.threadId,
              beforeCreatedAt: order.createdAt,
              beforeId: order.id,
              limit: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadHistoryPage:getMessageBoundary:query",
                  "ProjectionSnapshotQuery.getThreadHistoryPage:getMessageBoundary:decodeRow",
                ),
              ),
            ),
          ]),
          "ProjectionSnapshotQuery.getThreadHistoryPage:messagesTransaction",
        );
        yield* ensureThread(threadRow);
        yield* ensureBoundary(boundary);
        const rows = rawRows.slice(0, limit).toReversed();
        return {
          collection: "messages",
          snapshotSequence: computeSnapshotSequence(stateRows),
          items: rows.map(mapMessageRow),
          page: createdAtHistoryPageInfo({
            threadId: input.threadId,
            collection: "messages",
            rows: rows.map((row) => ({
              createdAt: row.createdAt,
              id: row.messageId,
            })),
            hasMoreBefore: rawRows.length > limit,
          }),
        } satisfies OrchestrationThreadHistoryPage;
      }

      if (input.collection === "proposedPlans") {
        const order = decodedCursor.order as CreatedAtCursorOrder;
        const [threadRow, stateRows, rawRows, boundary] = yield* runTransaction(
          Effect.all([
            threadEffect,
            stateEffect,
            listThreadProposedPlanRowsBefore({
              threadId: input.threadId,
              beforeCreatedAt: order.createdAt,
              beforeId: order.id,
              limit: limit + 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadHistoryPage:listPlans:query",
                  "ProjectionSnapshotQuery.getThreadHistoryPage:listPlans:decodeRows",
                ),
              ),
            ),
            getProposedPlanHistoryBoundary({
              threadId: input.threadId,
              beforeCreatedAt: order.createdAt,
              beforeId: order.id,
              limit: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadHistoryPage:getPlanBoundary:query",
                  "ProjectionSnapshotQuery.getThreadHistoryPage:getPlanBoundary:decodeRow",
                ),
              ),
            ),
          ]),
          "ProjectionSnapshotQuery.getThreadHistoryPage:plansTransaction",
        );
        yield* ensureThread(threadRow);
        yield* ensureBoundary(boundary);
        const rows = rawRows.slice(0, limit).toReversed();
        return {
          collection: "proposedPlans",
          snapshotSequence: computeSnapshotSequence(stateRows),
          items: rows.map(mapProposedPlanRow),
          page: createdAtHistoryPageInfo({
            threadId: input.threadId,
            collection: "proposedPlans",
            rows: rows.map((row) => ({
              createdAt: row.createdAt,
              id: row.planId,
            })),
            hasMoreBefore: rawRows.length > limit,
          }),
        } satisfies OrchestrationThreadHistoryPage;
      }

      if (input.collection === "activities") {
        const order = decodedCursor.order as ActivityCursorOrder;
        const [threadRow, stateRows, rawRows, boundary] = yield* runTransaction(
          Effect.all([
            threadEffect,
            stateEffect,
            listThreadActivityRowsBefore({
              threadId: input.threadId,
              beforeCreatedAt: order.createdAt,
              beforeId: order.id,
              beforeSequence: order.sequence,
              limit: limit + 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadHistoryPage:listActivities:query",
                  "ProjectionSnapshotQuery.getThreadHistoryPage:listActivities:decodeRows",
                ),
              ),
            ),
            getActivityHistoryBoundary({
              threadId: input.threadId,
              beforeCreatedAt: order.createdAt,
              beforeId: order.id,
              beforeSequence: order.sequence,
              limit: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadHistoryPage:getActivityBoundary:query",
                  "ProjectionSnapshotQuery.getThreadHistoryPage:getActivityBoundary:decodeRow",
                ),
              ),
            ),
          ]),
          "ProjectionSnapshotQuery.getThreadHistoryPage:activitiesTransaction",
        );
        yield* ensureThread(threadRow);
        yield* ensureBoundary(boundary);
        const rows = rawRows.slice(0, limit).toReversed();
        return {
          collection: "activities",
          snapshotSequence: computeSnapshotSequence(stateRows),
          items: rows.map(mapActivityRow),
          page: activityHistoryPageInfo({
            threadId: input.threadId,
            rows,
            hasMoreBefore: rawRows.length > limit,
          }),
        } satisfies OrchestrationThreadHistoryPage;
      }

      const order = decodedCursor.order as CheckpointCursorOrder;
      const [threadRow, stateRows, rawRows, boundary] = yield* runTransaction(
        Effect.all([
          threadEffect,
          stateEffect,
          listCheckpointRowsBefore({
            threadId: input.threadId,
            beforeCheckpointTurnCount: order.checkpointTurnCount,
            beforeId: order.id,
            limit: limit + 1,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadHistoryPage:listCheckpoints:query",
                "ProjectionSnapshotQuery.getThreadHistoryPage:listCheckpoints:decodeRows",
              ),
            ),
          ),
          getCheckpointHistoryBoundary({
            threadId: input.threadId,
            beforeCheckpointTurnCount: order.checkpointTurnCount,
            beforeId: order.id,
            limit: 1,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadHistoryPage:getCheckpointBoundary:query",
                "ProjectionSnapshotQuery.getThreadHistoryPage:getCheckpointBoundary:decodeRow",
              ),
            ),
          ),
        ]),
        "ProjectionSnapshotQuery.getThreadHistoryPage:checkpointsTransaction",
      );
      yield* ensureThread(threadRow);
      yield* ensureBoundary(boundary);
      const rows = rawRows.slice(0, limit).toReversed();
      return {
        collection: "checkpoints",
        snapshotSequence: computeSnapshotSequence(stateRows),
        items: rows.map(mapCheckpointRow),
        page: checkpointHistoryPageInfo({
          threadId: input.threadId,
          rows,
          hasMoreBefore: rawRows.length > limit,
        }),
      } satisfies OrchestrationThreadHistoryPage;
    });

  const searchThreadMessages: ProjectionSnapshotQueryShape["searchThreadMessages"] = (input) => {
    const query = input.query.trim();
    if (query.length === 0) {
      return Effect.succeed([]);
    }

    const limit = Math.min(Math.max(1, input.limit), 50);
    const likePattern = `%${escapeSqlLikePattern(query.toLowerCase())}%`;
    return searchThreadMessageRows({
      likePattern,
      projectId: input.projectId ?? null,
      threadId: input.threadId ?? null,
      limit,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.searchThreadMessages:query",
          "ProjectionSnapshotQuery.searchThreadMessages:decodeRows",
        ),
      ),
      Effect.map((rows): OrchestrationThreadMessageSearchResult[] =>
        rows.map((row) => ({
          threadId: row.threadId,
          messageId: row.messageId,
          snippet: buildMessageSearchSnippet({ text: row.text, query }),
          timestamp: row.createdAt,
          historyCursor: encodeThreadHistoryCursor({
            threadId: row.threadId,
            collection: "messages",
            order: { createdAt: row.createdAt, id: row.messageId },
          }),
        })),
      ),
    );
  };

  const getThreadMessageById: NonNullable<ProjectionSnapshotQueryShape["getThreadMessageById"]> = (
    input,
  ) =>
    getThreadMessageRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadMessageById:query",
          "ProjectionSnapshotQuery.getThreadMessageById:decodeRow",
        ),
      ),
      Effect.map(Option.map(mapMessageRow)),
    );

  const listThreadMessagesByTurn: NonNullable<
    ProjectionSnapshotQueryShape["listThreadMessagesByTurn"]
  > = (input) =>
    listThreadMessageRowsByTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listThreadMessagesByTurn:query",
          "ProjectionSnapshotQuery.listThreadMessagesByTurn:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(mapMessageRow)),
    );

  const countThreadUserMessages: NonNullable<
    ProjectionSnapshotQueryShape["countThreadUserMessages"]
  > = (threadId) =>
    countThreadUserMessageRows({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.countThreadUserMessages:query",
          "ProjectionSnapshotQuery.countThreadUserMessages:decodeRow",
        ),
      ),
      Effect.map((row) => row.userMessages),
    );

  const getThreadProposedPlanById: NonNullable<
    ProjectionSnapshotQueryShape["getThreadProposedPlanById"]
  > = (input) =>
    getThreadProposedPlanRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadProposedPlanById:query",
          "ProjectionSnapshotQuery.getThreadProposedPlanById:decodeRow",
        ),
      ),
      Effect.map(
        Option.map((row) => ({
          id: row.planId,
          createdAt: row.createdAt,
          implementedAt: row.implementedAt,
          implementationThreadId: row.implementationThreadId,
        })),
      ),
    );

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getThreadShellById,
    getWorktreeShellById,
    getThreadDetailById,
    getThreadWindow,
    getThreadHistoryPage,
    getThreadMessageById,
    listThreadMessagesByTurn,
    countThreadUserMessages,
    getThreadProposedPlanById,
    listThreadTaskPathRefs,
    searchThreadMessages,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
