import {
  messageTextColumns,
  resolveMessageText,
  messageTextForSearch,
  messageSearchCandidate,
  MessageTextFromSql,
  decodeMessageText,
} from "../../persistence/messageText.ts";
import {
  CHECKPOINT_REVERT_ACTIVITY_KIND,
  ChatAttachment,
  DEFAULT_AGENT_TOKEN_MODE,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProjectShell,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationArchivedThreadStub,
  OrchestrationThread,
  OrchestrationThreadHistoryError,
  WorktreePullRequestLink,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationThreadMessageSearchResult,
  type OrchestrationThreadHistoryPage,
  type OrchestrationThreadHistoryPageInfo,
  type OrchestrationThreadWindowSnapshot,
  type OrchestrationThreadActivity,
  type OrchestrationActivityPayloadMode,
  EventId,
  OrchestrationThreadShell,
  ThreadPriorityProjectedRanking,
  OrchestrationWorktreeShell,
  ModelSelection,
  ProjectCustomSystemPrompt,
  ProjectId,
  ThreadId,
  ThreadGoal,
  TrimmedNonEmptyString,
  ThreadUsageLimit,
  TurnDispatchMode,
  WorktreeId,
} from "@ryco/contracts";
import { readWorktreePullRequestLinks } from "@ryco/shared/worktreePullRequests";
import { Clock, Deferred, Effect, Layer, Option, Schema, type Scope, Struct } from "effect";
import { backgroundWorkCheckpoint } from "@ryco/shared/backgroundWork";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

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
import { decodePersistedRepositoryIdentity } from "../../project/repositoryIdentityPersistence.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { readClientFor, SqliteReadClient } from "../../persistence/SqliteReadClient.ts";
import { pruneStaleContextWindowActivities } from "../contextWindowActivities.ts";
import { previewActivityPayload } from "../activityPayloadPreview.ts";
import {
  COMMAND_MODEL_OMITTED_PLAN_MARKDOWN,
  COMMAND_READ_MODEL_ACTIVITY_KINDS,
} from "../commandReadModelShape.ts";
import { projectionThreadLineage, withThreadLineage } from "../threadLineage.ts";
import {
  isPendingCheckpointRevertStatus,
  latestCheckpointRevert,
} from "../checkpointRevertPolicy.ts";
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
  type ProjectionThreadCheckpointHead,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeProjectedPriority = Schema.decodeUnknownSync(ThreadPriorityProjectedRanking);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    // Persisted by the repository identity sync; read raw and decoded leniently (a cache).
    repositoryIdentityJson: Schema.NullOr(Schema.String),
  }),
);
// The shell snapshot is built from rows and never decoded again as a whole, so its rows apply
// the wire schemas' normalizations themselves (trimmed strings), field by field. The test
// "builds shell snapshots that are already in their decoded form" guards this.
const ProjectionProjectShellDbRowSchema = ProjectionProjectDbRowSchema.mapFields(
  Struct.assign({
    title: OrchestrationProjectShell.fields.title,
    workspaceRoot: OrchestrationProjectShell.fields.workspaceRoot,
    customSystemPrompt: Schema.NullOr(ProjectCustomSystemPrompt),
    customAvatarContentHash: Schema.NullOr(TrimmedNonEmptyString),
    preferredRemoteName: Schema.NullOr(TrimmedNonEmptyString),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    assembledText: Schema.NullOr(MessageTextFromSql),
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
    usageLimit: Schema.NullOr(Schema.fromJsonString(ThreadUsageLimit)),
    latestCompletedTurnAt: Schema.NullOr(IsoDateTime),
  }),
);
const ProjectionThreadShellDbRowSchema = ProjectionThreadDbRowSchema.mapFields(
  Struct.assign({
    title: OrchestrationThreadShell.fields.title,
    branch: OrchestrationThreadShell.fields.branch,
    worktreePath: OrchestrationThreadShell.fields.worktreePath,
    // `ThreadLineage.relationship` without its non-empty check: `projectionThreadLineage`
    // turns an empty relationship into no lineage rather than a failed snapshot.
    lineageRelationship: Schema.NullOr(Schema.Trim.check(Schema.isMaxLength(64))),
  }),
);
const ProjectThreadWorkspaceRowSchema = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  branch: OrchestrationThreadShell.fields.branch,
  worktreePath: OrchestrationThreadShell.fields.worktreePath,
  worktreeId: Schema.NullOr(WorktreeId),
});
const PendingGoalSyncThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  goal: Schema.fromJsonString(ThreadGoal),
});
const ThreadKeyPageRequestSchema = Schema.Struct({
  afterCreatedAt: Schema.NullOr(Schema.String),
  afterThreadId: Schema.NullOr(Schema.String),
  includeArchived: Schema.Boolean,
  limit: NonNegativeInt,
});
const ThreadOrderKeyRowSchema = Schema.Struct({
  createdAt: Schema.String,
  threadId: ThreadId,
});
interface ShellScope {
  readonly projectIds?: ReadonlyArray<string> | undefined;
  readonly threadIds?: ReadonlyArray<string> | undefined;
  /** `"stub"`: archived threads become stubs, so their sessions and latest turns are not read. */
  readonly archivedThreads?: "stub" | undefined;
}
const ShellScopeRequest = Schema.UndefinedOr(
  Schema.Struct({
    projectIds: Schema.optional(Schema.Array(Schema.String)),
    threadIds: Schema.optional(Schema.Array(Schema.String)),
    archivedThreads: Schema.optional(Schema.Literal("stub")),
  }),
);
const ShellUpdatedAtRowSchema = Schema.Struct({
  updatedAt: Schema.NullOr(IsoDateTime),
});
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
/** A window activity row plus its stored payload size, read without parsing it. */
const ProjectionThreadActivityWindowDbRowSchema = ProjectionThreadActivityDbRowSchema.mapFields(
  Struct.assign({ payloadBytes: NonNegativeInt }),
);
/**
 * Payload budget for the activities of one thread window snapshot. Tool output
 * and diffs make activities 80-95 % of a window; without a byte bound 150 of
 * them reached 3-5 MiB on real threads, past the hosted relay's 4 MiB message
 * cap. Older activities stay reachable through history pagination.
 */
export const THREAD_WINDOW_ACTIVITY_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Keeps the newest rows (newest-first input) within both the count limit and
 * the payload byte budget. The newest row is always kept, so one oversized
 * activity still opens; anything older is reported through `hasMoreBefore`.
 */
export function takeNewestRowsWithinByteBudget<Row extends { readonly payloadBytes: number }>(
  rows: ReadonlyArray<Row>,
  limit: number,
  maxBytes: number,
): { readonly rows: ReadonlyArray<Row>; readonly hasMoreBefore: boolean } {
  const kept: Array<Row> = [];
  let bytes = 0;
  for (const row of rows) {
    if (kept.length >= limit) break;
    if (kept.length > 0 && bytes + row.payloadBytes > maxBytes) break;
    kept.push(row);
    bytes += row.payloadBytes;
  }
  return { rows: kept, hasMoreBefore: rows.length > kept.length };
}

type ProjectionActivityWindowRow = Schema.Schema.Type<
  typeof ProjectionThreadActivityWindowDbRowSchema
>;
type SentActivityRow = ProjectionActivityWindowRow & {
  readonly payloadPreview?: { readonly fullBytes: number };
};

/**
 * The activity rows as a window or page sends them. With previews each large
 * payload is bounded (`previewActivityPayload`) and `payloadBytes` becomes the
 * size actually sent, so the byte budget counts what crosses the connection and
 * one oversized activity can no longer exceed it on its own.
 */
export function toSentActivityRows(
  rows: ReadonlyArray<ProjectionActivityWindowRow>,
  mode: OrchestrationActivityPayloadMode | undefined,
): ReadonlyArray<SentActivityRow> {
  if (mode !== "preview") return rows;
  return rows.map((row) => {
    const preview = previewActivityPayload(row);
    return preview.truncated
      ? {
          ...row,
          payload: preview.payload,
          payloadBytes: preview.bytes,
          payloadPreview: { fullBytes: row.payloadBytes },
        }
      : row;
  });
}

const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionThreadSessionShellDbRowSchema = ProjectionThreadSessionDbRowSchema.mapFields(
  Struct.assign({
    providerName: OrchestrationSession.fields.providerName,
    lastError: OrchestrationSession.fields.lastError,
  }),
);
const ProjectionWorktreeDbRowSchema = OrchestrationWorktreeShell.mapFields(
  Struct.assign({
    prIsDraft: Schema.NullOr(Schema.Number),
    // NULL on rows written before links: derived from the flat `pr_*` columns.
    pullRequests: Schema.NullOr(Schema.fromJsonString(Schema.Array(WorktreePullRequestLink))),
  }),
);
function toWorktreeShell(
  row: Schema.Schema.Type<typeof ProjectionWorktreeDbRowSchema>,
): OrchestrationWorktreeShell {
  const { relocatedFromPath, ...worktree } = row;
  const prIsDraft = row.prIsDraft === null ? null : row.prIsDraft === 1;
  return {
    ...worktree,
    ...(relocatedFromPath ? { relocatedFromPath } : {}),
    prIsDraft,
    // Always emit the key: its presence tells clients this server tracks close times.
    prTerminalAt: row.prTerminalAt ?? null,
    // Always emit links: their presence tells clients this server tracks several.
    pullRequests:
      row.pullRequests ??
      readWorktreePullRequestLinks({ ...row, prIsDraft, pullRequests: undefined }),
  };
}
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
/** Checkpoint rows without `checkpoint_files_json`: nothing is decoded that no one reads. */
const ProjectionCheckpointHeadDbRowSchema = ProjectionCheckpoint.mapFields(Struct.omit(["files"]));
type ProjectionThreadRow = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
type ProjectionMessageRow = Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>;
type ProjectionPlanRow = Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>;
type ProjectionActivityRow = Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>;
type ProjectionCheckpointRow = Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>;
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  userMessageId: Schema.NullOr(MessageId),
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
  candidate: Schema.NullOr(Schema.String),
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
  assembledText: Schema.NullOr(MessageTextFromSql),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

/** The lifecycle kinds `derivePendingThreadRequests` reads (a subset of COMMAND_READ_MODEL_ACTIVITY_KINDS). */
const PENDING_REQUEST_ACTIVITY_KINDS = [
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
] as const;

const ThreadHistoryActivityKeyDbRowSchema = Schema.Struct({
  activityId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  kind: Schema.String,
  providerItemId: Schema.NullOr(Schema.String),
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

/** A shell as built: stubbed builds list archived threads apart. */
type BuiltShellSnapshot = OrchestrationShellSnapshot & {
  readonly archivedThreadStubs?: ReadonlyArray<OrchestrationArchivedThreadStub>;
};

/**
 * The projection's progress as a version: every projector's cursor and time, which advance in
 * the transaction that projects an event. `null` until every projector the shell reads has
 * recorded its progress, since such a projection has no sequence to compare.
 */
function projectionStateVersion(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): string | null {
  const recorded = new Set<string>(stateRows.map((row) => row.projector));
  if (!REQUIRED_SNAPSHOT_PROJECTORS.every((projector) => recorded.has(projector))) {
    return null;
  }
  return stateRows
    .map((row) => `${row.projector}:${row.lastAppliedSequence}:${row.updatedAt}`)
    .toSorted()
    .join(",");
}

/** The usable priority batches a shell's rankings come from, as a version. */
function priorityBatchVersion(
  rows: ReadonlyArray<{ readonly batchId: string; readonly usableUntil: string }>,
): string {
  return [...new Set(rows.map((row) => `${row.batchId}@${row.usableUntil}`))].toSorted().join(",");
}

/**
 * The projects' repository identities as a version. They are recorded outside the event log
 * (the event announcing a changed identity follows the write), and every write stamps its
 * project with the time of the check it records.
 */
function repositoryIdentityVersion(
  rows: ReadonlyArray<{ readonly projectId: string; readonly checkedAt: string }>,
): string {
  return rows
    .map((row) => `${row.projectId}@${row.checkedAt}`)
    .toSorted()
    .join(",");
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
    ...(row.userMessageId !== null ? { userMessageId: row.userMessageId } : {}),
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
    kind: row.kind,
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
    text: resolveMessageText(row),
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
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema> & {
    readonly payloadPreview?: { readonly fullBytes: number };
  },
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
  return Object.assign(
    activity,
    row.sequence === null ? {} : { sequence: row.sequence },
    row.payloadPreview === undefined ? {} : { payloadPreview: row.payloadPreview },
  );
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

/**
 * Lets concurrent callers share runs of `run`, without ever answering a caller with a result
 * whose run started before its call (read-your-writes holds for a caller that just dispatched):
 * a caller arriving while a run is in flight waits for the next run, which every caller arriving
 * meanwhile joins. K concurrent callers cost at most two runs instead of K.
 *
 * Runs are detached from the caller that started them, so an interrupted caller never fails the
 * callers sharing its run.
 */
export function coalesceConcurrentRuns<A, E>(
  run: () => Effect.Effect<A, E>,
): () => Effect.Effect<A, E> {
  return makeRunCoalescer(run).next;
}

interface RunCoalescer<A, E> {
  /** A run that starts after this call (see {@link coalesceConcurrentRuns}). */
  readonly next: () => Effect.Effect<A, E>;
  /** The run in flight, if any; it may have started before the caller's call. */
  readonly inFlight: () => Deferred.Deferred<A, E> | undefined;
  /**
   * The run in flight, else a new one. Only for a caller that already waited out a run in
   * flight at its call: runs never overlap, so every run in flight since started after it.
   */
  readonly inFlightOrNew: () => Effect.Effect<A, E>;
}

function makeRunCoalescer<A, E>(run: () => Effect.Effect<A, E>): RunCoalescer<A, E> {
  let running: Deferred.Deferred<A, E> | undefined;
  let queued: Deferred.Deferred<A, E> | undefined;
  const execute = (target: Deferred.Deferred<A, E>): Effect.Effect<void> =>
    Effect.exit(Effect.suspend(run)).pipe(
      Effect.flatMap((exit) => {
        const next = queued;
        queued = undefined;
        running = next;
        return Deferred.done(target, exit).pipe(
          Effect.andThen(next === undefined ? Effect.void : execute(next)),
        );
      }),
    );
  const start = (): Effect.Effect<A, E> => {
    const target = Deferred.makeUnsafe<A, E>();
    running = target;
    return execute(target).pipe(Effect.forkDetach, Effect.andThen(Deferred.await(target)));
  };
  return {
    next: () =>
      Effect.suspend(() => {
        if (queued !== undefined) return Deferred.await(queued);
        if (running === undefined) return start();
        const target = Deferred.makeUnsafe<A, E>();
        queued = target;
        return Deferred.await(target);
      }),
    inFlight: () => running,
    inFlightOrNew: () =>
      Effect.suspend(() => (running === undefined ? start() : Deferred.await(running))),
  };
}

/** The oldest shell the memo serves again, whatever its version says. */
export const SHELL_MEMO_MAX_AGE_MS = 2_000;
/** A memoized shell nobody asked for in this long is dropped. */
export const SHELL_MEMO_IDLE_EVICTION_MS = 30_000;

/**
 * A built shell and the version of every input it was built from. Two builds at the same version
 * produce the same snapshot; `null` means the build cannot name its version.
 */
export interface VersionedShell<A> {
  readonly snapshot: A;
  readonly version: string | null;
}

interface ShellMemo<A> {
  readonly snapshot: A;
  readonly version: string;
  readonly builtAt: number;
  lastUsedAt: number;
}

export interface CurrentShellMemo<A, E> {
  /** The current shell: the memoized one while it is exactly current, else a new build. */
  readonly read: () => Effect.Effect<A, E>;
  /** Whether a built shell is held, from its build until its idle eviction. */
  readonly holding: () => boolean;
}

/**
 * Serves the shell the last build produced again, without building, only while it is exactly
 * the current shell: the current version still equals the version it was built at, and it is at
 * most {@link SHELL_MEMO_MAX_AGE_MS} old. A fresh build would then produce the same snapshot at
 * the same sequence, so the events a subscriber replays after it are the ones a fresh build's
 * subscriber replays, and readiness still follows a current shell. Anything else builds through
 * {@link coalesceConcurrentRuns} and replaces the memo; a build without a version is never
 * served again.
 *
 * A read that finds a build already under way (a channel open warming the shell, say) waits it
 * out and checks again, instead of queueing behind it for a second build: that build is served
 * when it turns out to be the current shell, by the same version check after the wait.
 *
 * The memo is dropped {@link SHELL_MEMO_IDLE_EVICTION_MS} after its last use, by one timer at a
 * time. Every caller shares the served snapshot, so nobody may mutate it.
 */
export const makeCurrentShellMemo = <A, E, VersionError>(options: {
  readonly build: () => Effect.Effect<VersionedShell<A>, E>;
  /** The current version, cheap to read; a failed read counts as a change. */
  readonly readVersion: Effect.Effect<string | null, VersionError>;
}): Effect.Effect<CurrentShellMemo<A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let memo: ShellMemo<A> | undefined;
    let evicting = false;
    const evictWhenIdle: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        const current = memo;
        if (current === undefined) return;
        const idleMs = (yield* Clock.currentTimeMillis) - current.lastUsedAt;
        if (idleMs >= SHELL_MEMO_IDLE_EVICTION_MS) {
          memo = undefined;
          return;
        }
        yield* Effect.sleep(SHELL_MEMO_IDLE_EVICTION_MS - idleMs);
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          evicting = false;
        }),
      ),
    );
    const builds = makeRunCoalescer(() =>
      Effect.gen(function* () {
        const builtAt = yield* Clock.currentTimeMillis;
        const built = yield* options.build();
        memo =
          built.version === null
            ? undefined
            : { snapshot: built.snapshot, version: built.version, builtAt, lastUsedAt: builtAt };
        if (memo !== undefined && !evicting) {
          evicting = true;
          yield* Effect.forkIn(evictWhenIdle, scope);
        }
        return built.snapshot;
      }),
    );
    const currentVersion = options.readVersion.pipe(Effect.orElseSucceed(() => null));
    /** The memo, marked used, while it is exactly the current shell. */
    const currentMemo: Effect.Effect<ShellMemo<A> | undefined> = Effect.gen(function* () {
      const current = memo;
      if (current === undefined) return undefined;
      const now = yield* Clock.currentTimeMillis;
      if (now - current.builtAt > SHELL_MEMO_MAX_AGE_MS) return undefined;
      if ((yield* currentVersion) !== current.version) return undefined;
      current.lastUsedAt = now;
      return current;
    });
    return {
      read: () =>
        Effect.gen(function* () {
          const served = yield* currentMemo;
          if (served !== undefined) return served.snapshot;
          const inFlight = builds.inFlight();
          if (inFlight === undefined) return yield* builds.next();
          // Its outcome only matters through the memo it leaves; a failure is the next
          // build's to report.
          yield* Effect.exit(Deferred.await(inFlight));
          const built = yield* currentMemo;
          return built !== undefined ? built.snapshot : yield* builds.inFlightOrNew();
        }),
      holding: () => memo !== undefined,
    };
  });

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/** Every projection read, issued on `sql` (the main connection or the read worker). */
const makeProjectionSnapshotQueryOn = Effect.fn("makeProjectionSnapshotQueryOn")(function* (
  sql: SqlClient.SqlClient,
) {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  // Kept by triggers (migration 087) under the rule this used to evaluate per row: the latest
  // completed, non-inherited turn that is not the session's active turn, so prior completion
  // stays stable while the current turn emits commentary or tool updates.
  const latestCompletedTurnAt = sql.literal("latest_completed_turn_at");

  /** Current projected rankings, of every thread or of one. */
  const listThreadPriorityRows = (threadId?: ThreadId) => {
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
        ${threadId === undefined ? sql`` : sql`AND ranking.thread_id = ${threadId}`}
      ORDER BY ranking.thread_id ASC
    `;
  };
  /** The batches `listThreadPriorityRows` reads rankings from right now (one slot, indexed). */
  const listActivePriorityBatchRows = () => {
    const now = new Date().toISOString();
    return sql<{ readonly batchId: string; readonly usableUntil: string }>`
      SELECT batch.batch_id AS "batchId", batch.usable_until AS "usableUntil"
      FROM thread_priority_batches AS batch
      WHERE batch.usable_until > ${now}
        AND EXISTS (
          SELECT 1 FROM thread_priority_rankings AS ranking
          WHERE ranking.batch_id = batch.batch_id
        )
    `;
  };
  /** When each project's repository identity was last recorded (one row per project). */
  const listRepositoryIdentityCheckRows = () =>
    sql<{ readonly projectId: string; readonly checkedAt: string }>`
      SELECT project_id AS "projectId", repository_identity_checked_at AS "checkedAt"
      FROM projection_projects
      WHERE repository_identity_checked_at IS NOT NULL
    `;
  const decodeThreadPriorityRow = (
    row: Effect.Success<ReturnType<typeof listThreadPriorityRows>>[number],
  ) =>
    decodeProjectedPriority({
      tier: row.tier,
      confidence: row.confidence,
      reason: row.reason,
      inputFingerprint: row.inputFingerprint,
      batchId: row.batchId,
      modelSelection: JSON.parse(row.modelSelectionJson) as unknown,
      rankedAt: row.rankedAt,
      usableUntil: row.usableUntil,
    });
  const projectColumns = sql`
    project_id AS "projectId",
    kind,
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
    deleted_at AS "deletedAt",
    repository_identity_json AS "repositoryIdentityJson"
  `;
  const threadColumns = sql`
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
    ${latestCompletedTurnAt} AS "latestCompletedTurnAt",
    pending_approval_count AS "pendingApprovalCount",
    pending_user_input_count AS "pendingUserInputCount",
    has_actionable_proposed_plan AS "hasActionableProposedPlan",
    usage_limit_json AS "usageLimit",
    deleted_at AS "deletedAt",
    trashed_at AS "trashedAt",
    lineage_parent_thread_id AS "lineageParentThreadId",
    lineage_root_thread_id AS "lineageRootThreadId",
    lineage_relationship AS "lineageRelationship",
    lineage_source_message_id AS "lineageSourceMessageId",
    lineage_source_turn_id AS "lineageSourceTurnId"
  `;

  // Every row, deleted ones included: the command read model and the full snapshot need them.
  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT ${projectColumns}
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT ${threadColumns}
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  // The shell only ships live rows; filtering in SQL also skips the per-row
  // latestCompletedTurnAt subquery and the decode of every deleted thread.
  // A shell scope narrows the shell to some projects and/or threads (see getScopedShellSnapshot).
  // Ids travel as one JSON array parameter each; an absent list does not filter.
  const scopedThreadFilter = (scope: ShellScope | undefined, alias: string) =>
    sql`
      ${
        scope?.projectIds === undefined
          ? sql``
          : sql`AND ${sql.literal(alias)}.project_id IN (SELECT value FROM json_each(${JSON.stringify(scope.projectIds)}))`
      }
      ${
        scope?.threadIds === undefined
          ? sql``
          : sql`AND ${sql.literal(alias)}.thread_id IN (SELECT value FROM json_each(${JSON.stringify(scope.threadIds)}))`
      }
    `;
  // Session and latest-turn rows feed only full shells: a stubbed shell skips archived threads'.
  const fullShellThreadFilter = (scope: ShellScope | undefined, alias: string) =>
    scope?.archivedThreads === "stub" ? sql`AND ${sql.literal(alias)}.archived_at IS NULL` : sql``;
  // Projects (and their workspaces) in scope: the listed ones, else the scoped threads' ones.
  const scopedProjectFilter = (scope: ShellScope | undefined, column: string) =>
    scope?.projectIds !== undefined
      ? sql`AND ${sql.literal(column)} IN (SELECT value FROM json_each(${JSON.stringify(scope.projectIds)}))`
      : scope?.threadIds !== undefined
        ? sql`AND ${sql.literal(column)} IN (
            SELECT scoped.project_id FROM projection_threads scoped
            WHERE scoped.thread_id IN (SELECT value FROM json_each(${JSON.stringify(scope.threadIds)}))
          )`
        : sql``;

  const listActiveProjectShellRows = SqlSchema.findAll({
    Request: ShellScopeRequest,
    Result: ProjectionProjectShellDbRowSchema,
    execute: (scope) =>
      sql`
        SELECT ${projectColumns}
        FROM projection_projects
        WHERE deleted_at IS NULL
          ${scopedProjectFilter(scope, "projection_projects.project_id")}
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listActiveThreadShellRows = SqlSchema.findAll({
    Request: ShellScopeRequest,
    Result: ProjectionThreadShellDbRowSchema,
    execute: (scope) =>
      sql`
        SELECT ${threadColumns}
        FROM projection_threads
        WHERE deleted_at IS NULL
          ${scopedThreadFilter(scope, "projection_threads")}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  // One keyset page of live threads in the shell's order, so paging over every thread never
  // builds a whole shell per page.
  const listThreadKeyPageRows = SqlSchema.findAll({
    Request: ThreadKeyPageRequestSchema,
    Result: ThreadOrderKeyRowSchema,
    execute: (input) =>
      sql`
        SELECT created_at AS "createdAt", thread_id AS "threadId"
        FROM projection_threads
        WHERE deleted_at IS NULL
          ${input.includeArchived ? sql`` : sql`AND archived_at IS NULL`}
          ${
            input.afterCreatedAt === null || input.afterThreadId === null
              ? sql``
              : sql`AND (
                  created_at > ${input.afterCreatedAt}
                  OR (created_at = ${input.afterCreatedAt} AND thread_id > ${input.afterThreadId})
                )`
          }
        ORDER BY created_at ASC, thread_id ASC
        LIMIT ${input.limit}
      `,
  });

  // Where each live thread works: the five placement columns of the shell's live threads.
  const listActiveThreadWorkspaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectThreadWorkspaceRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "id",
          project_id AS "projectId",
          branch,
          worktree_path AS "worktreePath",
          worktree_id AS "worktreeId"
        FROM projection_threads
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  // The shell's updatedAt has always covered deleted rows too (a deletion bumps it), so it is
  // aggregated over whole tables instead of the live rows the shell ships.
  const readShellUpdatedAt = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ShellUpdatedAtRowSchema,
    execute: () =>
      sql`
        SELECT MAX(value) AS "updatedAt" FROM (
          SELECT MAX(updated_at) AS value FROM projection_projects
          UNION ALL SELECT MAX(updated_at) FROM projection_threads
          UNION ALL SELECT MAX(updated_at) FROM projection_worktrees
          UNION ALL SELECT MAX(archived_at) FROM projection_worktrees
          UNION ALL SELECT MAX(updated_at) FROM projection_thread_sessions
        )
      `,
  });

  // The latest-turn times of archived threads, which a stubbed shell does not read row by row
  // but still folds into `updatedAt`, so both shell forms carry the same version.
  const readArchivedLatestTurnUpdatedAt = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ShellUpdatedAtRowSchema,
    execute: () =>
      sql`
        SELECT NULLIF(
          MAX(
            COALESCE(MAX(turns.requested_at), ''),
            COALESCE(MAX(turns.started_at), ''),
            COALESCE(MAX(turns.completed_at), '')
          ),
          ''
        ) AS "updatedAt"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
      `,
  });

  // Boot recovery of goal synchronizations: only threads whose goal still awaits its provider.
  // `json_valid` guards `json_extract`, which fails the whole query on one malformed row.
  const listPendingGoalSyncThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingGoalSyncThreadRowSchema,
    execute: () =>
      sql`
        SELECT thread_id AS "threadId", goal_json AS "goal"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND goal_json IS NOT NULL
          AND CASE WHEN json_valid(goal_json)
            THEN json_extract(goal_json, '$.synchronization.state')
          END = 'pending'
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const worktreeColumns = sql`
    worktree_id AS "worktreeId",
    project_id AS "projectId",
    title,
    branch,
    worktree_path AS "worktreePath",
    (SELECT source_path FROM managed_worktree_relocations r
      WHERE r.worktree_id = projection_worktrees.worktree_id AND r.project_id = projection_worktrees.project_id
        AND r.destination_path = projection_worktrees.worktree_path AND r.state = 'complete') AS "relocatedFromPath",
    origin,
    pr_number AS "prNumber",
    issue_number AS "issueNumber",
    pr_title AS "prTitle",
    issue_title AS "issueTitle",
    pr_state AS "prState",
    pr_is_draft AS "prIsDraft",
    pr_terminal_at AS "prTerminalAt",
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
    checkout_removed_at AS "checkoutRemovedAt",
    checkout_removal_reason AS "checkoutRemovalReason",
    manual_position AS "manualPosition",
    pull_requests_json AS "pullRequests"
  `;

  const listWorktreeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorktreeDbRowSchema,
    execute: () =>
      sql`
        SELECT ${worktreeColumns}
        FROM projection_worktrees
        ORDER BY project_id ASC, manual_position ASC, created_at ASC, worktree_id ASC
      `,
  });

  const listActiveProjectWorktreeRows = SqlSchema.findAll({
    Request: ShellScopeRequest,
    Result: ProjectionWorktreeDbRowSchema,
    execute: (scope) =>
      sql`
        SELECT ${worktreeColumns}
        FROM projection_worktrees
        WHERE project_id IN (SELECT project_id FROM projection_projects WHERE deleted_at IS NULL)
          ${scopedProjectFilter(scope, "projection_worktrees.project_id")}
        ORDER BY project_id ASC, manual_position ASC, created_at ASC, worktree_id ASC
      `,
  });

  const listProjectWorktreeRows = SqlSchema.findAll({
    Request: ProjectIdLookupInput,
    Result: ProjectionWorktreeDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT ${worktreeColumns}
        FROM projection_worktrees
        WHERE project_id = ${projectId}
        ORDER BY manual_position ASC, created_at ASC, worktree_id ASC
      `,
  });

  const listProjectThreadWorkspaceRows = SqlSchema.findAll({
    Request: ProjectIdLookupInput,
    Result: ProjectThreadWorkspaceRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "id",
          project_id AS "projectId",
          branch,
          worktree_path AS "worktreePath",
          worktree_id AS "worktreeId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
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
          (SELECT source_path FROM managed_worktree_relocations r
            WHERE r.worktree_id = projection_worktrees.worktree_id AND r.project_id = projection_worktrees.project_id
              AND r.destination_path = projection_worktrees.worktree_path AND r.state = 'complete') AS "relocatedFromPath",
          origin,
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          pr_title AS "prTitle",
          issue_title AS "issueTitle",
          pr_state AS "prState",
          pr_is_draft AS "prIsDraft",
          pr_terminal_at AS "prTerminalAt",
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
          checkout_removed_at AS "checkoutRemovedAt",
          checkout_removal_reason AS "checkoutRemovalReason",
          manual_position AS "manualPosition",
          pull_requests_json AS "pullRequests"
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
          ${messageTextColumns(sql)},
          attachments_json AS "attachments",
          dispatch_mode AS "dispatchMode",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  // The command read model does not load full message history. It keeps two
  // user-message anchors per thread:
  // - first: the thread has accepted a user turn, so a provider/model change after
  //   a restart still takes the atomic context-handoff path;
  // - latest: the delegated-return fence (decider thread.turn.start) and the projector's
  //   message cap read latestUserMessage (orchestration/userMessageOrder.ts), the
  //   in-memory twin of latestUserMessageIdQuery. It MUST be the row
  //   CompletionReturnDelivery reads: projection_threads carries both ids, kept by triggers
  //   under the rules of firstUserMessageIdQuery and latestUserMessageIdQuery (migration 087).
  // Anchors are looked up by primary key and carry no text: the engine only needs their id,
  // role and order. Rows are ordered (created_at, rowid) like the latest-anchor rule, so a
  // thread's latest anchor is always its last row.
  const listUserMessageAnchorRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.turn_id AS "turnId",
          messages.role,
          '' AS text,
          NULL AS "assembledText",
          NULL AS "attachments",
          messages.dispatch_mode AS "dispatchMode",
          messages.is_streaming AS "isStreaming",
          messages.created_at AS "createdAt",
          messages.updated_at AS "updatedAt"
        FROM projection_threads threads
        JOIN projection_thread_messages messages
          ON messages.message_id IN (threads.first_user_message_id, threads.latest_user_message_id)
        ORDER BY messages.thread_id ASC, messages.created_at ASC, messages.rowid ASC
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

  // The command read model's plans: ids and timestamps only (see commandModelProposedPlan).
  const listCommandModelProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          ${COMMAND_MODEL_OMITTED_PLAN_MARKDOWN} AS "planMarkdown",
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

  const listCheckpointRevertActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activities.activity_id AS "activityId",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.tone,
          activities.kind,
          activities.summary,
          activities.payload_json AS "payload",
          activities.sequence,
          activities.created_at AS "createdAt"
        FROM projection_thread_activities AS activities
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = activities.thread_id
        WHERE activities.kind = ${CHECKPOINT_REVERT_ACTIVITY_KIND}
          AND threads.deleted_at IS NULL
        ORDER BY
          activities.thread_id ASC,
          activities.sequence ASC,
          activities.created_at ASC,
          activities.activity_id ASC
      `,
  });

  // One thread's revert journal: `thread_id = ?` keeps it on the thread index.
  const listThreadCheckpointRevertActivityRows = SqlSchema.findAll({
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
          AND kind = ${CHECKPOINT_REVERT_ACTIVITY_KIND}
      `,
  });

  // Idle-only command invariants need the lifecycle pairs that can block a
  // handoff even after restart, and a fork's provenance decides whether its next
  // turn hands off. Keep this intentionally narrow instead of hydrating
  // arbitrary activity history into the command read model: the kinds are the ones the live
  // projector keeps (commandReadModelShape.ts), so both models hold the same activities.
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
        WHERE kind IN ${sql.in(COMMAND_READ_MODEL_ACTIVITY_KINDS)}
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const sessionColumns = sql`
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
  `;

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT ${sessionColumns}
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listActiveThreadSessionShellRows = SqlSchema.findAll({
    Request: ShellScopeRequest,
    Result: ProjectionThreadSessionShellDbRowSchema,
    execute: (scope) =>
      sql`
        SELECT ${sessionColumns}
        FROM projection_thread_sessions
        WHERE thread_id IN (
          SELECT threads.thread_id FROM projection_threads threads
          WHERE threads.deleted_at IS NULL ${scopedThreadFilter(scope, "threads")}
            ${fullShellThreadFilter(scope, "threads")}
        )
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

  // Order these latest-turn joins by the thread key so SQLite scans threads
  // and directly looks up each latest turn, rather than scanning all turn history.
  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.pending_message_id AS "userMessageId",
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
        ORDER BY threads.thread_id ASC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: ShellScopeRequest,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: (scope) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.pending_message_id AS "userMessageId",
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
          ${scopedThreadFilter(scope, "threads")}
          ${fullShellThreadFilter(scope, "threads")}
        ORDER BY threads.thread_id ASC
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
          kind,
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
          deleted_at AS "deletedAt",
          repository_identity_json AS "repositoryIdentityJson"
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
          kind,
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
          deleted_at AS "deletedAt",
          repository_identity_json AS "repositoryIdentityJson"
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
          ${latestCompletedTurnAt} AS "latestCompletedTurnAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          usage_limit_json AS "usageLimit",
          deleted_at AS "deletedAt",
          trashed_at AS "trashedAt",
          lineage_parent_thread_id AS "lineageParentThreadId",
          lineage_root_thread_id AS "lineageRootThreadId",
          lineage_relationship AS "lineageRelationship",
          lineage_source_message_id AS "lineageSourceMessageId",
          lineage_source_turn_id AS "lineageSourceTurnId"
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
          ${messageTextColumns(sql)},
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
    execute: ({ likePattern, candidate, projectId, threadId, limit }) =>
      sql`
        SELECT
          messages.thread_id AS "threadId",
          messages.message_id AS "messageId",
          ${messageTextColumns(sql, "messages")},
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
          ${
            candidate === null
              ? sql``
              : sql`AND messages.message_id IN (
            SELECT ids.message_id
            FROM projection_message_search(${candidate}) AS candidates
            INNER JOIN projection_message_search_ids ids ON ids.search_id = candidates.rowid
            UNION ALL
            SELECT message_id FROM projection_thread_messages
            WHERE is_streaming <> 0 OR text_json IS NOT NULL
          )`
          }
          AND lower(${messageTextForSearch(sql, "messages")}) LIKE ${likePattern} ESCAPE '\\'
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

  // Recover bounded lifecycle evidence independently of the paginated transcript.
  // Only the current runtime epoch participates. Rank each independent field:
  // sparse progress must not erase a prior pause or foreground transition.
  const listBackgroundTaskEvidence = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) => sql`
      WITH sampled AS MATERIALIZED (
        -- Index range scan, bounded BEFORE any JSON parsing or window ranking.
        -- At most 1025 index entries and 4 KiB per payload (4 MiB + sentinel).
        SELECT activity_id, thread_id, turn_id, tone, kind, substr(summary, 1, 180) AS summary,
          CASE WHEN length(CAST(payload_json AS BLOB)) <= 4096 THEN payload_json ELSE '{}' END AS payload_json,
          length(CAST(payload_json AS BLOB)) > 4096 AS oversized, sequence, created_at
        FROM projection_thread_activities INDEXED BY idx_projection_thread_activities_thread_sequence_created_id
        WHERE thread_id = ${threadId}
        ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 1025
      ), bounded AS MATERIALIZED (
        SELECT * FROM sampled ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 1024
      ), scoped AS (
        SELECT a.*, json_extract(a.payload_json, '$.taskId') AS task_id,
          ROW_NUMBER() OVER (ORDER BY a.sequence DESC, a.created_at DESC, a.activity_id DESC) AS rank
        FROM bounded a
        JOIN projection_thread_sessions s ON s.thread_id = a.thread_id
        WHERE a.kind IN ('task.started', 'task.updated', 'task.progress', 'task.completed')
          AND json_extract(a.payload_json, '$.runtimeSessionId') = s.runtime_session_id
      ), fields AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY
            CASE WHEN kind = 'task.started' THEN 0 ELSE 1 END, rank) AS start_rank,
          ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY
            CASE WHEN json_type(payload_json, '$.status') = 'text' THEN 0 ELSE 1 END, rank) AS status_rank,
          ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY
            CASE WHEN json_type(payload_json, '$.isBackgrounded') IN ('true', 'false') THEN 0 ELSE 1 END, rank) AS background_rank,
          ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY
            CASE WHEN json_type(payload_json, '$.detail') = 'text' THEN 0 ELSE 1 END, rank) AS detail_rank
        FROM scoped WHERE task_id IS NOT NULL
      ), candidates AS (
        SELECT bg.task_id FROM fields bg
        JOIN fields status ON status.task_id = bg.task_id AND status.status_rank = 1
        JOIN fields started ON started.task_id = bg.task_id AND started.start_rank = 1
        WHERE bg.background_rank = 1
          AND json_extract(bg.payload_json, '$.isBackgrounded') = 1
          AND COALESCE(json_extract(bg.payload_json, '$.agentKind'), '') != 'agent'
          AND COALESCE(trim(json_extract(bg.payload_json, '$.agentId')), '') = ''
          AND COALESCE(json_extract(bg.payload_json, '$.taskType'), '') NOT IN ('plan', 'dream')
          AND (started.kind = 'task.started' OR json_extract(status.payload_json, '$.status') IN ('pending', 'running', 'waiting', 'idle'))
          AND (COALESCE(json_extract(status.payload_json, '$.status'), '') NOT IN
            ('completed', 'failed', 'stopped', 'cancelled', 'interrupted')
            OR COALESCE(json_extract(started.payload_json, '$.attempt'), 0) >
               COALESCE(json_extract(status.payload_json, '$.attempt'), 0))
        ORDER BY started.rank DESC LIMIT 101
      ), evidence AS (
      SELECT activity_id AS "activityId", thread_id AS "threadId", turn_id AS "turnId",
        tone, kind, substr(summary, 1, 180) AS summary,
        json_object('taskId', task_id,
          'runtimeSessionId', json_extract(payload_json, '$.runtimeSessionId'),
          'agentKind', json_extract(payload_json, '$.agentKind'),
          'agentId', json_extract(payload_json, '$.agentId'),
          'taskType', json_extract(payload_json, '$.taskType'),
          'attempt', json_extract(payload_json, '$.attempt'),
          'isBackgrounded', json(CASE json_extract(payload_json, '$.isBackgrounded') WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END),
          'canStop', json(CASE json_extract(payload_json, '$.canStop') WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END),
          'status', json_extract(payload_json, '$.status'),
          'detail', substr(COALESCE(json_extract(payload_json, '$.detail'), json_extract(payload_json, '$.title')), 1, 180)
        ) AS payload,
        sequence, created_at AS "createdAt", rank AS evidence_rank
      FROM fields WHERE (task_id IN (SELECT task_id FROM candidates)
        AND (start_rank = 1 OR status_rank = 1 OR background_rank = 1 OR detail_rank = 1))
        OR rank IN (
          -- Bounded terminal evidence also protects a recent delayed start
          -- whose completion was just outside the transcript page.
          SELECT rank FROM fields WHERE status_rank = 1
            AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'stopped', 'cancelled', 'interrupted')
            AND json_extract(payload_json, '$.agentKind') = 'background'
          ORDER BY rank LIMIT 100
        )
      UNION ALL
      SELECT 'background-work:evidence-omitted', ${threadId}, NULL, 'info', 'background-work.omitted',
        'Older background task details unavailable',
        json_object('runtimeSessionId', s.runtime_session_id),
        (SELECT sequence FROM sampled ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 1),
        (SELECT created_at FROM sampled ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 1), 0
      FROM projection_thread_sessions s WHERE s.thread_id = ${threadId} AND (
        EXISTS (SELECT 1 FROM bounded WHERE oversized = 1 AND kind LIKE 'task.%') OR (
          (SELECT count(*) FROM sampled) > 1024 AND NOT EXISTS (
            SELECT 1 FROM bounded WHERE kind = 'background-work.session-boundary'
              AND json_extract(payload_json, '$.runtimeSessionId') = s.runtime_session_id
          )
        )
      )) SELECT * FROM evidence ORDER BY evidence_rank DESC
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
          turns.pending_message_id AS "userMessageId",
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

  const listCheckpointHeadRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointHeadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
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
        ${messageTextColumns(sql)},
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
        ${messageTextColumns(sql)},
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
        ${messageTextColumns(sql)},
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

  // History repair reads. Arrays travel as one JSON parameter each; the message and activity
  // primary keys and the kind-leading activity index serve the id and kind branches.
  const listThreadHistoryRepairMessageRows = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: ThreadId,
      turnIdsJson: Schema.String,
      messageIdsJson: Schema.String,
    }),
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, turnIdsJson, messageIdsJson }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        ${messageTextColumns(sql)},
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND (
          turn_id IN (SELECT value FROM json_each(${turnIdsJson}))
          OR message_id IN (SELECT value FROM json_each(${messageIdsJson}))
        )
      ORDER BY created_at ASC, message_id ASC
    `,
  });

  const listThreadHistoryRepairActivityKeyRows = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: ThreadId,
      turnIdsJson: Schema.String,
      activityIdsJson: Schema.String,
      includeTurnless: Schema.Number,
    }),
    Result: ThreadHistoryActivityKeyDbRowSchema,
    execute: ({ threadId, turnIdsJson, activityIdsJson, includeTurnless }) => sql`
      SELECT
        activity_id AS "activityId",
        turn_id AS "turnId",
        kind,
        CASE
          WHEN json_valid(payload_json) AND json_type(payload_json, '$.providerItemId') = 'text'
            THEN json_extract(payload_json, '$.providerItemId')
          ELSE NULL
        END AS "providerItemId"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND (
          turn_id IN (SELECT value FROM json_each(${turnIdsJson}))
          OR activity_id IN (SELECT value FROM json_each(${activityIdsJson}))
          OR (${includeTurnless} = 1 AND turn_id IS NULL)
        )
    `,
  });

  const listThreadPendingRequestActivityRows = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) => sql`
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
      WHERE kind IN ${sql.in(PENDING_REQUEST_ACTIVITY_KINDS)}
        AND thread_id = ${threadId}
      ORDER BY sequence ASC, created_at ASC, activity_id ASC
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
        ${messageTextColumns(sql)},
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

  /**
   * Messages that may carry artifacts (`@ryco/shared/threadArtifacts`): assistant messages
   * with attachments, and any message with a handed-over one. A `"handoff":` key can only
   * appear unescaped as a stored attachment's own key, so the text match never misses one;
   * callers narrow the rows with the shared predicate.
   */
  const artifactMessageCondition = sql`
    attachments_json IS NOT NULL
    AND attachments_json <> '[]'
    AND (role = 'assistant' OR attachments_json LIKE '%"handoff":%')
  `;

  // The `"artifacts"` message filter.
  const listThreadArtifactMessageRowsBefore = SqlSchema.findAll({
    Request: CreatedAtHistoryBeforeQueryInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeId, limit }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        ${messageTextColumns(sql)},
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND ${artifactMessageCondition}
        AND (
          created_at < ${beforeCreatedAt}
          OR (created_at = ${beforeCreatedAt} AND message_id < ${beforeId})
        )
      ORDER BY created_at DESC, message_id DESC
      LIMIT ${limit}
    `,
  });

  const listThreadArtifactMessageRows = SqlSchema.findAll({
    Request: BoundedThreadHistoryQueryInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        ${messageTextColumns(sql)},
        attachments_json AS "attachments",
        dispatch_mode AS "dispatchMode",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND ${artifactMessageCondition}
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
        ${messageTextColumns(sql)},
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
        ${messageTextColumns(sql)},
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
    Result: ProjectionThreadActivityWindowDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT
        activity_id AS "activityId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payload",
        length(CAST(payload_json AS BLOB)) AS "payloadBytes",
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

  const getActivityPayloadRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, activityId: EventId }),
    Result: Schema.Struct({
      kind: Schema.String,
      payload: Schema.fromJsonString(Schema.Unknown),
      payloadBytes: NonNegativeInt,
    }),
    execute: ({ threadId, activityId }) => sql`
      SELECT
        activity.kind AS "kind",
        activity.payload_json AS "payload",
        length(CAST(activity.payload_json AS BLOB)) AS "payloadBytes"
      FROM projection_thread_activities AS activity
      INNER JOIN projection_threads AS thread
        ON thread.thread_id = activity.thread_id
      WHERE activity.thread_id = ${threadId}
        AND activity.activity_id = ${activityId}
        AND thread.deleted_at IS NULL
      LIMIT 1
    `,
  });

  const listThreadActivityRowsBefore = SqlSchema.findAll({
    Request: ActivityHistoryBeforeQueryInput,
    Result: ProjectionThreadActivityWindowDbRowSchema,
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
          length(CAST(payload_json AS BLOB)) AS "payloadBytes",
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
    return decodeThread(
      withThreadLineage(
        {
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
          usageLimit: input.threadRow.usageLimit ?? null,
          deletedAt: null,
          trashedAt: null,
          messages: input.messageRows.map(mapMessageRow),
          proposedPlans: input.proposedPlanRows.map(mapProposedPlanRow),
          activities:
            input.pruneContextActivities === false
              ? activities
              : pruneStaleContextWindowActivities(activities),
          checkpoints: input.checkpointRows.map(mapCheckpointRow),
          session: Option.isSome(input.sessionRow) ? mapSessionRow(input.sessionRow.value) : null,
        },
        projectionThreadLineage(input.threadRow),
      ),
    );
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
                  text: resolveMessageText(row),
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
                  ...(row.userMessageId !== null ? { userMessageId: row.userMessageId } : {}),
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

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                kind: row.kind,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: decodePersistedRepositoryIdentity(row.repositoryIdentityJson),
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
                withThreadLineage(
                  {
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
                    usageLimit: row.usageLimit ?? null,
                    deletedAt: row.deletedAt,
                    trashedAt: row.trashedAt,
                    messages: messagesByThread.get(row.threadId) ?? [],
                    proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                    activities: pruneStaleContextWindowActivities(
                      activitiesByThread.get(row.threadId) ?? [],
                    ),
                    checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                    session: sessionsByThread.get(row.threadId) ?? null,
                  },
                  projectionThreadLineage(row),
                ),
              );

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
          listUserMessageAnchorRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listUserMessageAnchors:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listUserMessageAnchors:decodeRows",
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
          listCommandModelProposedPlanRows(undefined).pipe(
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
            userMessageAnchorRows,
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
              const userMessageAnchorsByThread = new Map<string, OrchestrationMessage[]>();
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
                  kind: row.kind,
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
              for (let index = 0; index < userMessageAnchorRows.length; index += 1) {
                const row = userMessageAnchorRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                // SQL order keeps each thread's latest anchor last, where latestUserMessage finds it.
                const anchors = userMessageAnchorsByThread.get(row.threadId) ?? [];
                anchors.push(mapMessageRow(row));
                userMessageAnchorsByThread.set(row.threadId, anchors);
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
                threads.push(
                  withThreadLineage(
                    {
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
                      usageLimit: row.usageLimit ?? null,
                      deletedAt: row.deletedAt,
                      trashedAt: row.trashedAt,
                      messages: userMessageAnchorsByThread.get(row.threadId) ?? [],
                      proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                      activities: actionableActivitiesByThread.get(row.threadId) ?? [],
                      checkpoints: [],
                      session: sessionByThread.get(row.threadId) ?? null,
                    },
                    // Required after restart: the decider walks lineage for root and cycles.
                    projectionThreadLineage(row),
                  ),
                );
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

  // Background liveness lives in memory, outside the event log, so the shell's version names it.
  const backgroundLivenessVersion = () =>
    threadBackgroundLiveness
      .listLiveThreadIds()
      .toSorted()
      .map(
        (threadId) =>
          `${threadId}=${threadBackgroundLiveness.getThreadBackgroundLiveness(threadId)}`,
      )
      .join(",");
  /**
   * The version of every input a shell is built from: the projection's progress (every event's
   * rows), the usable priority batch, the recorded repository identities and background liveness
   * (see {@link makeCurrentShellMemo}).
   */
  const shellVersion = (
    stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
    priorityRows: ReadonlyArray<{ readonly batchId: string; readonly usableUntil: string }>,
    identityRows: ReadonlyArray<{ readonly projectId: string; readonly checkedAt: string }>,
  ): string | null => {
    const state = projectionStateVersion(stateRows);
    return state === null
      ? null
      : JSON.stringify([
          state,
          priorityBatchVersion(priorityRows),
          repositoryIdentityVersion(identityRows),
          backgroundLivenessVersion(),
        ]);
  };
  // Three small reads: the projection's cursors, the usable batch (its time is read per call)
  // and the projects' identity checks.
  const readShellVersion = Effect.suspend(() =>
    Effect.all([
      listProjectionStateRows(undefined),
      listActivePriorityBatchRows(),
      listRepositoryIdentityCheckRows(),
    ]),
  ).pipe(
    Effect.map(([stateRows, batchRows, identityRows]) =>
      shellVersion(stateRows, batchRows, identityRows),
    ),
  );

  // Pure SQL: repository identities are persisted (see project/repositoryIdentitySync.ts), so a
  // snapshot never waits on git. Rows are decoded once, with the wire normalizations applied per
  // field, and the assembled snapshot is not decoded again. The version is read in the same
  // transaction (and liveness in the same synchronous step) as the rows it describes.
  const buildVersionedShell = (scope: ShellScope | undefined) =>
    sql
      .withTransaction(
        Effect.all([
          listActiveProjectShellRows(scope).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveThreadShellRows(scope).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveProjectWorktreeRows(scope).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listWorktrees:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listWorktrees:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionShellRows(scope).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows(scope).pipe(
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
          readShellUpdatedAt(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:readUpdatedAt:query",
                "ProjectionSnapshotQuery.getShellSnapshot:readUpdatedAt:decodeRow",
              ),
            ),
          ),
          scope?.archivedThreads === "stub"
            ? readArchivedLatestTurnUpdatedAt(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:readArchivedUpdatedAt:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:readArchivedUpdatedAt:decodeRow",
                  ),
                ),
              )
            : Effect.succeed({ updatedAt: null }),
          listRepositoryIdentityCheckRows().pipe(
            Effect.mapError(
              toPersistenceSqlError(
                "ProjectionSnapshotQuery.getShellSnapshot:listRepositoryIdentityChecks",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.map(
          ([
            projectRows,
            threadRows,
            worktreeRows,
            sessionRows,
            latestTurnRows,
            stateRows,
            priorityRows,
            updatedAtRow,
            archivedUpdatedAtRow,
            identityRows,
          ]): VersionedShell<BuiltShellSnapshot> => {
            const stubArchived = scope?.archivedThreads === "stub";
            let updatedAt: string | null = updatedAtRow.updatedAt;
            if (archivedUpdatedAtRow.updatedAt !== null) {
              updatedAt = maxIso(updatedAt, archivedUpdatedAtRow.updatedAt);
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
            // Rankings live outside the event log. Without their time a
            // re-rank snapshot at an unchanged sequence reads as current to
            // the client and is dropped.
            for (const row of priorityRows) {
              updatedAt = maxIso(updatedAt, row.rankedAt);
            }

            const latestTurnByThread = new Map(
              latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
            );
            const sessionByThread = new Map(
              sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
            );
            const archivedThreadStubs: Array<OrchestrationArchivedThreadStub> = [];
            const fullShellRows = stubArchived
              ? threadRows.filter((row) => {
                  if (row.archivedAt === null) return true;
                  archivedThreadStubs.push({
                    id: row.threadId,
                    projectId: row.projectId,
                    title: row.title,
                    branch: row.branch,
                    worktreePath: row.worktreePath,
                    worktreeId: row.worktreeId ?? null,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                    archivedAt: row.archivedAt,
                    latestUserMessageAt: row.latestUserMessageAt,
                    lineage: projectionThreadLineage(row),
                  });
                  return false;
                })
              : threadRows;
            const scopedThreadIds = new Set<string>(fullShellRows.map((row) => row.threadId));
            const priorityByThread = new Map(
              priorityRows
                .filter((row) => scope === undefined || scopedThreadIds.has(row.threadId))
                .map((row) => [row.threadId, decodeThreadPriorityRow(row)]),
            );

            const snapshot: BuiltShellSnapshot = {
              snapshotSequence: computeSnapshotSequence(stateRows),
              projects: projectRows.map((row) =>
                mapProjectShellRow(
                  row,
                  decodePersistedRepositoryIdentity(row.repositoryIdentityJson),
                ),
              ),
              worktrees: worktreeRows.map(toWorktreeShell),
              ...(stubArchived ? { archivedThreadStubs } : {}),
              threads: fullShellRows.map((row): OrchestrationThreadShell => {
                const shell: OrchestrationThreadShell = withThreadLineage(
                  {
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
                    usageLimit: row.usageLimit ?? null,
                    session: sessionByThread.get(row.threadId) ?? null,
                    latestUserMessageAt: row.latestUserMessageAt,
                    latestCompletedTurnAt: row.latestCompletedTurnAt,
                    hasPendingApprovals: row.pendingApprovalCount > 0,
                    hasPendingUserInput: row.pendingUserInputCount > 0,
                    hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                    backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                      row.threadId,
                    ),
                  },
                  projectionThreadLineage(row),
                );
                const priority = priorityByThread.get(row.threadId);
                return priority === undefined ? shell : Object.assign(shell, { priority });
              }),
              updatedAt: updatedAt ?? new Date(0).toISOString(),
            };
            return { snapshot, version: shellVersion(stateRows, priorityRows, identityRows) };
          },
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
        Effect.tap(({ snapshot }) =>
          Effect.logDebug(
            scope?.projectIds === undefined && scope?.threadIds === undefined
              ? "startup shell snapshot query complete"
              : "scoped shell snapshot query complete",
            {
              projectCount: snapshot.projects.length,
              worktreeCount: snapshot.worktrees?.length ?? 0,
              threadCount: snapshot.threads.length,
              snapshotSequence: snapshot.snapshotSequence,
            },
          ),
        ),
        Effect.withSpan("ProjectionSnapshotQuery.buildShell", {
          attributes: {
            "shell.form":
              scope?.projectIds !== undefined || scope?.threadIds !== undefined
                ? "scoped"
                : scope?.archivedThreads === "stub"
                  ? "stubbed"
                  : "full",
          },
        }),
      );

  const buildVersionedShellSnapshot = () => buildVersionedShell(undefined);
  const buildVersionedStubbedShellSnapshot = () =>
    buildVersionedShell({ archivedThreads: "stub" }).pipe(
      Effect.map(({ snapshot, version }) => ({
        snapshot: { ...snapshot, archivedThreadStubs: snapshot.archivedThreadStubs ?? [] },
        version,
      })),
    );

  const getScopedShellSnapshot: NonNullable<
    ProjectionSnapshotQueryShape["getScopedShellSnapshot"]
  > = (scope) => buildVersionedShell(scope).pipe(Effect.map(({ snapshot }) => snapshot));

  // A caller inside a transaction holds the single connection: a shared build would wait for
  // that connection (a deadlock) or run on the caller's transaction, so it builds its own.
  // Everyone else gets the memoized shell while it is current, else a shared build: subscribers
  // refreshing on the same thread-priority batch, reconnecting clients, a channel open warming
  // the shell and server callers often ask at once or in quick succession. Each shell form has
  // its own memo and shares its own builds; scoped shells have neither.
  const sharedOutsideTransactions = <A, E>(
    build: () => Effect.Effect<VersionedShell<A>, E>,
  ): Effect.Effect<() => Effect.Effect<A, E>, never, Scope.Scope> =>
    makeCurrentShellMemo({ build, readVersion: readShellVersion }).pipe(
      Effect.map(
        (memo) => () =>
          Effect.serviceOption(sql.transactionService).pipe(
            Effect.flatMap((transaction) =>
              Option.isSome(transaction)
                ? build().pipe(Effect.map(({ snapshot }) => snapshot))
                : memo.read(),
            ),
          ),
      ),
    );
  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] =
    yield* sharedOutsideTransactions(buildVersionedShellSnapshot);
  const getStubbedShellSnapshot: NonNullable<
    ProjectionSnapshotQueryShape["getStubbedShellSnapshot"]
  > = yield* sharedOutsideTransactions(buildVersionedStubbedShellSnapshot);

  const listProjectShells: NonNullable<ProjectionSnapshotQueryShape["listProjectShells"]> = () =>
    listActiveProjectShellRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listProjectShells:query",
          "ProjectionSnapshotQuery.listProjectShells:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) =>
          mapProjectShellRow(row, decodePersistedRepositoryIdentity(row.repositoryIdentityJson)),
        ),
      ),
    );

  const getWorkspacePlacement: NonNullable<
    ProjectionSnapshotQueryShape["getWorkspacePlacement"]
  > = () =>
    sql
      .withTransaction(
        Effect.all([
          listActiveProjectShellRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getWorkspacePlacement:listProjects:query",
                "ProjectionSnapshotQuery.getWorkspacePlacement:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveProjectWorktreeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getWorkspacePlacement:listWorktrees:query",
                "ProjectionSnapshotQuery.getWorkspacePlacement:listWorktrees:decodeRows",
              ),
            ),
          ),
          listActiveThreadWorkspaceRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getWorkspacePlacement:listThreads:query",
                "ProjectionSnapshotQuery.getWorkspacePlacement:listThreads:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.map(([projectRows, worktreeRows, threads]) => ({
          projects: projectRows.map((row) =>
            mapProjectShellRow(row, decodePersistedRepositoryIdentity(row.repositoryIdentityJson)),
          ),
          worktrees: worktreeRows.map(toWorktreeShell),
          threads,
        })),
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.getWorkspacePlacement:query")(error),
        ),
      );

  const listThreadKeyPage: NonNullable<ProjectionSnapshotQueryShape["listThreadKeyPage"]> = (
    input,
  ) =>
    listThreadKeyPageRows({
      afterCreatedAt: input.after?.createdAt ?? null,
      afterThreadId: input.after?.threadId ?? null,
      includeArchived: input.includeArchived,
      limit: input.limit,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listThreadKeyPage:query",
          "ProjectionSnapshotQuery.listThreadKeyPage:decodeRows",
        ),
      ),
    );

  const listPendingGoalSyncThreads: NonNullable<
    ProjectionSnapshotQueryShape["listPendingGoalSyncThreads"]
  > = () =>
    sql
      .withTransaction(
        Effect.all([
          listPendingGoalSyncThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.listPendingGoalSyncThreads:query",
                "ProjectionSnapshotQuery.listPendingGoalSyncThreads:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.listPendingGoalSyncThreads:listProjectionState:query",
                "ProjectionSnapshotQuery.listPendingGoalSyncThreads:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.map(([rows, stateRows]) => ({
          snapshotSequence: computeSnapshotSequence(stateRows),
          threads: rows.flatMap((row) =>
            row.goal.synchronization?.state === "pending"
              ? [{ threadId: row.threadId, goal: row.goal }]
              : [],
          ),
        })),
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.listPendingGoalSyncThreads:query")(
                error,
              ),
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
        Effect.map(
          Option.map((row): OrchestrationProject => ({
            id: row.projectId,
            kind: row.kind,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            projectMetadataDir: row.projectMetadataDir,
            repositoryIdentity: decodePersistedRepositoryIdentity(row.repositoryIdentityJson),
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          })),
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
      Effect.map(
        Option.map((row) =>
          mapProjectShellRow(row, decodePersistedRepositoryIdentity(row.repositoryIdentityJson)),
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

      const checkpointRows = yield* listCheckpointHeadRowsByThread({
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
        checkpoints: checkpointRows.map((row): ProjectionThreadCheckpointHead => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
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
      const [threadRow, latestTurnRow, sessionRow, priorityRows] = yield* Effect.all([
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
        // An upsert replaces the client's shell row, so it carries the same
        // projected ranking the full snapshot does; leaving it out erased the
        // thread's priority until the next snapshot.
        listThreadPriorityRows(threadId).pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionSnapshotQuery.getThreadShellById:getPriority:query"),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      const priorityRow = priorityRows[0];
      return Option.some(
        withThreadLineage(
          {
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
            usageLimit: threadRow.value.usageLimit ?? null,
            session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
            latestUserMessageAt: threadRow.value.latestUserMessageAt,
            latestCompletedTurnAt: threadRow.value.latestCompletedTurnAt,
            hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
            hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
            hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
            backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
              threadRow.value.threadId,
            ),
            ...(priorityRow === undefined
              ? {}
              : { priority: decodeThreadPriorityRow(priorityRow) }),
          } satisfies OrchestrationThreadShell,
          projectionThreadLineage(threadRow.value),
        ),
      );
    });

  const listThreadPriorities: NonNullable<
    ProjectionSnapshotQueryShape["listThreadPriorities"]
  > = () =>
    listThreadPriorityRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSnapshotQuery.listThreadPriorities:query")),
      Effect.map((rows) =>
        rows.map((row) => ({
          threadId: ThreadId.make(row.threadId),
          priority: decodeThreadPriorityRow(row),
        })),
      ),
    );

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

  const getProjectWorkspaceRows: NonNullable<
    ProjectionSnapshotQueryShape["getProjectWorkspaceRows"]
  > = (projectId) =>
    sql
      .withTransaction(
        Effect.all([
          listProjectWorktreeRows({ projectId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getProjectWorkspaceRows:listWorktrees:query",
                "ProjectionSnapshotQuery.getProjectWorkspaceRows:listWorktrees:decodeRows",
              ),
            ),
          ),
          listProjectThreadWorkspaceRows({ projectId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getProjectWorkspaceRows:listThreads:query",
                "ProjectionSnapshotQuery.getProjectWorkspaceRows:listThreads:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.map(([worktreeRows, threads]) => ({
          worktrees: worktreeRows.map(toWorktreeShell),
          threads,
        })),
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.getProjectWorkspaceRows:query")(error),
        ),
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

  const getCompletedSideQuestionContext = (threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.all({
          messages: sql<{ role: string; text: string; assembledText: string | null }>`
        SELECT m.role, ${messageTextColumns(sql, "m", 64001)} FROM projection_thread_messages m
        JOIN projection_turns t ON t.thread_id = m.thread_id
          AND (t.turn_id = m.turn_id OR t.pending_message_id = m.message_id)
        WHERE m.thread_id = ${threadId} AND t.state = 'completed' AND m.is_streaming = 0
          AND NOT EXISTS (SELECT 1 FROM projection_thread_sessions s
            WHERE s.thread_id = t.thread_id AND s.active_turn_id = t.turn_id)
        ORDER BY m.created_at ASC, m.message_id ASC LIMIT 201
      `,
          activities: sql<{ kind: string; summary: string }>`
        SELECT a.kind, substr(a.summary, 1, 64001) AS summary FROM projection_thread_activities a
        JOIN projection_turns t ON t.thread_id = a.thread_id AND t.turn_id = a.turn_id
        WHERE a.thread_id = ${threadId} AND t.state = 'completed'
          AND NOT EXISTS (SELECT 1 FROM projection_thread_sessions s
            WHERE s.thread_id = t.thread_id AND s.active_turn_id = t.turn_id)
        ORDER BY a.created_at ASC, a.activity_id ASC LIMIT 201
      `,
        }),
      )
      .pipe(
        Effect.map(({ messages, activities }) => ({
          messages: messages.map((message) => ({
            role: message.role,
            text: (message.assembledText === null
              ? message.text
              : decodeMessageText(message.assembledText)
            ).slice(0, 64001),
          })),
          activities,
        })),
        Effect.mapError(
          toPersistenceSqlError("ProjectionSnapshotQuery.getCompletedSideQuestionContext"),
        ),
      );

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
        backgroundEvidenceRows,
        rawCheckpointRows,
        latestTurnRow,
        sessionRow,
        stateRows,
      ] = yield* sql
        .withTransaction(
          // Issued together: on the read worker every statement is a round trip,
          // so awaiting each reply in turn pays for all of them one after another.
          Effect.all(
            [
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
              listBackgroundTaskEvidence({ threadId: input.threadId }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadWindow:backgroundEvidence:query",
                    "ProjectionSnapshotQuery.getThreadWindow:backgroundEvidence:decodeRows",
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
            ],
            { concurrency: "unbounded" },
          ),
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
      const boundedActivities = takeNewestRowsWithinByteBudget(
        toSentActivityRows(rawActivityRows, input.activityPayloads),
        limits.activities,
        THREAD_WINDOW_ACTIVITY_MAX_PAYLOAD_BYTES,
      );
      const activityRows = boundedActivities.rows.toReversed();
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

      const evidence = new Map(
        backgroundEvidenceRows.map((row) => [row.activityId, mapActivityRow(row)]),
      );
      for (const activity of thread.activities) evidence.set(activity.id, activity);
      const orderedEvidence = [...evidence.values()].toSorted(
        (a, b) =>
          (a.sequence ?? -1) - (b.sequence ?? -1) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
      const checkpoint = backgroundWorkCheckpoint(orderedEvidence);
      // Read after the window: a cwd that moved since is the one the next turn runs in.
      const project =
        thread.worktreePath === null
          ? Option.getOrUndefined(
              yield* getActiveProjectRowById({ projectId: thread.projectId }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadWindow:getProject:query",
                    "ProjectionSnapshotQuery.getThreadWindow:getProject:decodeRow",
                  ),
                ),
              ),
            )
          : undefined;
      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [{ id: project.projectId, workspaceRoot: project.workspaceRoot }] : [],
      });
      return {
        snapshotSequence: computeSnapshotSequence(stateRows),
        thread: checkpoint ? { ...thread, activities: [...thread.activities, checkpoint] } : thread,
        ...(workspaceCwd ? { workspaceCwd } : {}),
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
            hasMoreBefore: boundedActivities.hasMoreBefore,
          }),
          checkpoints: checkpointHistoryPageInfo({
            threadId: input.threadId,
            rows: checkpointRows,
            hasMoreBefore: rawCheckpointRows.length > limits.checkpoints,
          }),
        },
      } satisfies OrchestrationThreadWindowSnapshot;
    });

  const getActivityPayload: ProjectionSnapshotQueryShape["getActivityPayload"] = (input) =>
    getActivityPayloadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getActivityPayload:query",
          "ProjectionSnapshotQuery.getActivityPayload:decodeRow",
        ),
      ),
    );

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
        const artifactsOnly = "messageFilter" in input && input.messageFilter === "artifacts";
        // Artifact messages carry page thumbnails: fewer of them per page.
        const pageLimit = artifactsOnly ? Math.min(limit, 50) : limit;
        const listRows = artifactsOnly
          ? listThreadArtifactMessageRowsBefore
          : listThreadMessageRowsBefore;
        const [threadRow, stateRows, rawRows, boundary] = yield* runTransaction(
          Effect.all([
            threadEffect,
            stateEffect,
            listRows({
              threadId: input.threadId,
              beforeCreatedAt: order.createdAt,
              beforeId: order.id,
              limit: pageLimit + 1,
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
        const rows = rawRows.slice(0, pageLimit).toReversed();
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
            hasMoreBefore: rawRows.length > pageLimit,
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
        // Byte-bounded like the window: 150 heavy tool outputs would pass the relay's message
        // cap. A page cut short by bytes still reports more, so paging continues from its edge.
        const bounded = takeNewestRowsWithinByteBudget(
          toSentActivityRows(rawRows, input.activityPayloads),
          limit,
          THREAD_WINDOW_ACTIVITY_MAX_PAYLOAD_BYTES,
        );
        const rows = bounded.rows.toReversed();
        return {
          collection: "activities",
          snapshotSequence: computeSnapshotSequence(stateRows),
          items: rows.map(mapActivityRow),
          page: activityHistoryPageInfo({
            threadId: input.threadId,
            rows,
            hasMoreBefore: bounded.hasMoreBefore,
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
    const normalizedQuery = query.toLowerCase();
    const likePattern = `%${escapeSqlLikePattern(normalizedQuery)}%`;
    return searchThreadMessageRows({
      likePattern,
      candidate: messageSearchCandidate(normalizedQuery),
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
          snippet: buildMessageSearchSnippet({ text: resolveMessageText(row), query }),
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

  const listThreadArtifactMessages: NonNullable<
    ProjectionSnapshotQueryShape["listThreadArtifactMessages"]
  > = (input) =>
    listThreadArtifactMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listThreadArtifactMessages:query",
          "ProjectionSnapshotQuery.listThreadArtifactMessages:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(mapMessageRow)),
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

  const getThreadHistoryRepairContext: NonNullable<
    ProjectionSnapshotQueryShape["getThreadHistoryRepairContext"]
  > = (input) =>
    sql
      .withTransaction(
        Effect.all([
          listThreadHistoryRepairMessageRows({
            threadId: input.threadId,
            turnIdsJson: JSON.stringify(input.turnIds),
            messageIdsJson: JSON.stringify(input.messageIds),
          }),
          listThreadHistoryRepairActivityKeyRows({
            threadId: input.threadId,
            turnIdsJson: JSON.stringify(input.turnIds),
            activityIdsJson: JSON.stringify(input.activityIds),
            includeTurnless: input.includeTurnlessActivities ? 1 : 0,
          }),
          listThreadPendingRequestActivityRows({ threadId: input.threadId }),
        ]),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadHistoryRepairContext:query",
            "ProjectionSnapshotQuery.getThreadHistoryRepairContext:decodeRows",
          ),
        ),
        Effect.map(([messageRows, activityKeyRows, requestRows]) => ({
          messages: messageRows.map(mapMessageRow),
          activityKeys: activityKeyRows.map((row) => ({
            id: row.activityId,
            turnId: row.turnId,
            kind: row.kind,
            providerItemId: row.providerItemId,
          })),
          requestActivities: requestRows.map(mapActivityRow),
        })),
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

  const listPendingCheckpointReverts: NonNullable<
    ProjectionSnapshotQueryShape["listPendingCheckpointReverts"]
  > = () =>
    listCheckpointRevertActivityRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listPendingCheckpointReverts:query",
          "ProjectionSnapshotQuery.listPendingCheckpointReverts:decodeRows",
        ),
      ),
      Effect.map((rows) => {
        const byThread = new Map<ThreadId, OrchestrationThreadActivity[]>();
        for (const row of rows) {
          const activities = byThread.get(row.threadId) ?? [];
          activities.push(mapActivityRow(row));
          byThread.set(row.threadId, activities);
        }
        return Array.from(byThread, ([threadId, activities]) => {
          const latest = latestCheckpointRevert(activities);
          return latest !== null && isPendingCheckpointRevertStatus(latest.payload.status)
            ? [{ threadId, activity: latest.activity, payload: latest.payload }]
            : [];
        }).flat();
      }),
    );

  const getLatestCheckpointRevert: NonNullable<
    ProjectionSnapshotQueryShape["getLatestCheckpointRevert"]
  > = (threadId) =>
    listThreadCheckpointRevertActivityRows({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getLatestCheckpointRevert:query",
          "ProjectionSnapshotQuery.getLatestCheckpointRevert:decodeRows",
        ),
      ),
      // Ordered by the same rule as every other journal reader.
      Effect.map((rows) => latestCheckpointRevert(rows.map(mapActivityRow))),
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
    getScopedShellSnapshot,
    getStubbedShellSnapshot,
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    listProjectShells,
    getWorkspacePlacement,
    listPendingGoalSyncThreads,
    listThreadKeyPage,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getThreadShellById,
    listThreadPriorities,
    getWorktreeShellById,
    getProjectWorkspaceRows,
    getThreadDetailById,
    getThreadWindow,
    getActivityPayload,
    getCompletedSideQuestionContext,
    getThreadHistoryPage,
    getThreadMessageById,
    listThreadArtifactMessages,
    listThreadMessagesByTurn,
    getThreadHistoryRepairContext,
    countThreadUserMessages,
    getThreadProposedPlanById,
    listThreadTaskPathRefs,
    listPendingCheckpointReverts,
    getLatestCheckpointRevert,
    searchThreadMessages,
  } satisfies ProjectionSnapshotQueryShape;
});

/**
 * Which connection a projection read runs on.
 *
 * The main connection is the single writer: one synchronous `node:sqlite` handle behind a
 * semaphore, so every read on it blocks the event loop for its SQL and queues behind (and in
 * front of) every write. Reads move to the read-only worker connection (SqliteReadClient) when
 * all of these hold:
 * - they are heavy or unbounded enough to matter (whole read models, full-text search, history
 *   pages), or they sit on the path a client waits on (a thread window must not queue behind a
 *   shell build or a streaming write), and run on behalf of a reader (an RPC, an MCP tool), not
 *   the engine;
 * - they need no read-your-writes beyond committed data: the worker sees every commit that
 *   precedes the read, and a caller inside a main-connection transaction keeps reading there
 *   (`readClientFor`), where its uncommitted rows are visible;
 * - they do not order themselves against the live event stream, or they take their own sequence
 *   inside one read transaction (`getSnapshot`, `getThreadWindow`), so the events after it replay
 *   in order from the main connection, which serializes that replay behind in-flight commits.
 * Engine hydration (`getCommandReadModel`), shell builds and the small lookups the decider and
 * reactors issue stay on the main connection.
 */
const READ_WORKER_METHODS = [
  "getSnapshot",
  "getThreadWindow",
  "getThreadHistoryPage",
  "searchThreadMessages",
] as const satisfies ReadonlyArray<keyof ProjectionSnapshotQueryShape>;

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const main = yield* makeProjectionSnapshotQueryOn(sql);
  const reader = yield* Effect.serviceOption(SqliteReadClient);
  if (Option.isNone(reader) || reader.value === sql) return main;
  const onReader = yield* makeProjectionSnapshotQueryOn(reader.value);
  type AnyRead = (...args: Array<never>) => Effect.Effect<unknown, ProjectionRepositoryError>;
  const routed = <K extends (typeof READ_WORKER_METHODS)[number]>(
    method: K,
  ): NonNullable<ProjectionSnapshotQueryShape[K]> => {
    const onMain = main[method] as AnyRead;
    const offMain = onReader[method] as AnyRead;
    const read = (...args: Array<never>) =>
      Effect.flatMap(readClientFor(sql), (client) =>
        client === sql ? onMain(...args) : offMain(...args),
      );
    return read as unknown as NonNullable<ProjectionSnapshotQueryShape[K]>;
  };
  return {
    ...main,
    getSnapshot: routed("getSnapshot"),
    getThreadWindow: routed("getThreadWindow"),
    getThreadHistoryPage: routed("getThreadHistoryPage"),
    searchThreadMessages: routed("searchThreadMessages"),
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
