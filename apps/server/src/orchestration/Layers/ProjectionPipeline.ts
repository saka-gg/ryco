import { pendingRequestActivityInOrchestrationOrder } from "@ryco/shared/threadActivity";
import { ApprovalResponseIdentity, ApprovalResponseState } from "@ryco/contracts";
import { matchesApprovalAttempt, sameApprovalIdentity } from "../approvalResponses.ts";
import {
  ApprovalRequestId,
  type ChatAttachment,
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_PROJECT_METADATA_DIR,
  type OrchestrationEvent,
  type OrchestrationEventType,
  ThreadId,
} from "@ryco/contracts";
import { derivePendingThreadRequestState } from "@ryco/shared/threadActivity";
import { Effect, FileSystem, Layer, Option, Path, Stream, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadUserInputRequestRepository } from "../../persistence/Services/ProjectionThreadUserInputRequests.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionWorktreeRepository } from "../../persistence/Services/ProjectionWorktrees.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadUserInputRequestRepositoryLive } from "../../persistence/Layers/ProjectionThreadUserInputRequests.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionWorktreeRepositoryLive } from "../../persistence/Layers/ProjectionWorktrees.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  isServerPerfProfileEnabled,
  recordServerPerf,
} from "../../observability/PerfInstrumentation.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import {
  applyThreadShellSummaryTransition,
  pendingStateDelta,
  userInputActivityPendingState,
} from "../threadShellSummaryProjection.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
  worktrees: "projection.worktrees",
} as const;

export type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * Exhaustive routing table for durable orchestration events. Adding an event
 * type requires an explicit decision here, including an intentional empty
 * route for command/reactor-only events that do not alter a projection.
 */
export const ORCHESTRATION_EVENT_PROJECTORS = {
  "project.created": [ORCHESTRATION_PROJECTOR_NAMES.projects],
  "project.meta-updated": [ORCHESTRATION_PROJECTOR_NAMES.projects],
  "project.avatar-set": [ORCHESTRATION_PROJECTOR_NAMES.projects],
  "project.deleted": [ORCHESTRATION_PROJECTOR_NAMES.projects],
  "thread.created": [
    ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
    ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
    ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
    ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
    ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
    ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.deleted": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.archived": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.unarchived": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.meta-updated": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.runtime-mode-set": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.interaction-mode-set": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.token-mode-set": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.snoozed": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.unsnoozed": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.settled": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.unsettled": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.goal-updated": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.goal-cleared": [ORCHESTRATION_PROJECTOR_NAMES.threads],
  "thread.context-handoff-requested": [],
  "thread.turn-steer-requested": [],
  "thread.turn-steer-accepted": [],
  "thread.turn-steer-rejected": [],
  "thread.message-sent": [
    ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
    ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.turn-start-requested": [ORCHESTRATION_PROJECTOR_NAMES.threadTurns],
  "thread.turn-interrupt-requested": [
    ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.approval-response-requested": [
    ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.user-input-response-requested": [
    ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.checkpoint-revert-requested": [],
  "thread.reverted": [
    ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
    ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
    ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
    ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.session-stop-requested": [],
  "thread.session-set": [
    ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
    ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.proposed-plan-upserted": [
    ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.turn-diff-completed": [
    ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "thread.activity-appended": [
    ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
    ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
    ORCHESTRATION_PROJECTOR_NAMES.threads,
  ],
  "worktree.created": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "worktree.archived": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "worktree.metaUpdated": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "worktree.sourceControlStateUpdated": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "worktree.restored": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "worktree.deleted": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "thread.attachedToWorktree": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "thread.statusBucketOverridden": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "thread.manualPositionSet": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
  "worktree.manualPositionSet": [ORCHESTRATION_PROJECTOR_NAMES.worktrees],
} as const satisfies Record<OrchestrationEventType, ReadonlyArray<ProjectorName>>;

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: ProjectionEventContext,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface ProjectionEventContext {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
  readonly postCommitEffects: Array<Effect.Effect<void, unknown>>;
  pendingApprovalDelta: number;
  pendingUserInputDelta: number;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("unknown pending codex approval request")
  );
}

function derivePendingUserInputStatesFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): Map<ApprovalRequestId, { readonly isPending: boolean; readonly updatedAt: string }> {
  const states = new Map<
    ApprovalRequestId,
    { readonly isPending: boolean; readonly updatedAt: string }
  >();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    const isPending = userInputActivityPendingState({
      kind: activity.kind,
      detail,
    });
    if (isPending !== null) {
      states.set(requestId, { isPending, updatedAt: activity.createdAt });
    }
  }

  return states;
}

function bucketCount(count: number): string {
  if (count <= 0) return "0";
  if (count < 100) return "1-99";
  if (count < 1_000) return "100-999";
  if (count < 10_000) return "1000-9999";
  return "10000-plus";
}

function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  );

  let latestForTurn: ProjectionThreadProposedPlan | null = null;
  if (input.latestTurnId !== null) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const plan = sorted[index];
      if (plan?.turnId === input.latestTurnId) {
        latestForTurn = plan;
        break;
      }
    }
  }
  if (latestForTurn !== null) {
    return latestForTurn.implementedAt === null;
  }

  const latestPlan = sorted.at(-1) ?? null;
  return latestPlan !== null && latestPlan.implementedAt === null;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.id === undefined) {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      const relativePath = attachmentRelativePath(attachment);
      if (relativePath !== null) {
        relativePaths.add(relativePath);
      }
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: ProjectionEventContext,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionThreadUserInputRequestRepository =
      yield* ProjectionThreadUserInputRequestRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
    const projectionWorktreeRepository = yield* ProjectionWorktreeRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const projectAvatarStore = yield* ProjectAvatarStore;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            projectMetadataDir: event.payload.projectMetadataDir ?? DEFAULT_PROJECT_METADATA_DIR,
            defaultModelSelection: event.payload.defaultModelSelection,
            customSystemPrompt: event.payload.customSystemPrompt ?? null,
            customAvatarContentHash: null,
            preferredRemoteName: null,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.projectMetadataDir !== undefined
              ? { projectMetadataDir: event.payload.projectMetadataDir }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.customSystemPrompt !== undefined
              ? { customSystemPrompt: event.payload.customSystemPrompt }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            ...(event.payload.preferredRemoteName !== undefined
              ? { preferredRemoteName: event.payload.preferredRemoteName }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.avatar-set": {
          const existingAvatarRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingAvatarRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingAvatarRow.value,
            customAvatarContentHash: event.payload.contentHash,
            updatedAt: event.payload.updatedAt,
          });
          if (event.payload.contentHash === null) {
            _attachmentSideEffects.postCommitEffects.push(
              projectAvatarStore.remove(event.payload.projectId),
            );
          }
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          _attachmentSideEffects.postCommitEffects.push(
            projectAvatarStore.remove(event.payload.projectId),
          );
          return;
        }

        default:
          return;
      }
    });

    const recomputeThreadShellSummary = Effect.fn("recomputeThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      const perfEnabled = isServerPerfProfileEnabled();
      const startedAtMs = perfEnabled ? Date.now() : 0;
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const [messages, proposedPlans, activities, pendingApprovals] = yield* Effect.all([
        projectionThreadMessageRepository.listByThreadId({ threadId }),
        projectionThreadProposedPlanRepository.listByThreadId({ threadId }),
        projectionThreadActivityRepository.listByThreadId({ threadId }),
        projectionPendingApprovalRepository.listByThreadId({ threadId }),
      ]);

      const latestUserMessageAt =
        messages
          .filter((message) => message.role === "user")
          .map((message) => message.createdAt)
          .toSorted()
          .at(-1) ?? null;

      const pendingApprovalCount = pendingApprovals.filter(
        (approval) => approval.status === "pending",
      ).length;
      const pendingUserInputCount =
        derivePendingThreadRequestState(activities).pendingUserInputCount;
      const hasActionableProposedPlan = deriveHasActionableProposedPlan({
        latestTurnId: existingRow.value.latestTurnId,
        proposedPlans,
      });

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt,
        pendingApprovalCount,
        pendingUserInputCount,
        hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      });
      if (perfEnabled) {
        const totalRows =
          messages.length + proposedPlans.length + activities.length + pendingApprovals.length;
        yield* Effect.sync(() =>
          recordServerPerf(
            `server.orchestration.projection.threadShellSummary.rows.${bucketCount(totalRows)}.messages.${bucketCount(messages.length)}`,
            {
              count: 1,
              durationMs: Math.max(0, Date.now() - startedAtMs),
            },
          ),
        );
      }
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            tokenMode: event.payload.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            worktreeId: null,
            manualStatusBucket: null,
            manualPosition: 0,
            latestTurnId: null,
            goal: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          return;

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "active",
            settledAt: null,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "active",
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            snoozedUntil: null,
            snoozedAt: null,
            settledAt: event.payload.settledAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.token-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            tokenMode: event.payload.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.goal-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            goal: event.payload.goal,
            updatedAt: event.payload.goal.updatedAt,
          });
          return;
        }

        case "thread.goal-cleared": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            goal: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          // During replay the files on disk may already belong to a later
          // incarnation of this client-generated id. Only an unsuperseded
          // deletion is allowed to remove them.
          const recreatedLater = yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: event.payload.threadId,
            type: "thread.created",
            sequenceExclusive: event.sequence,
          });
          if (!recreatedLater) {
            attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.message-sent": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const summary = applyThreadShellSummaryTransition(
            existingRow.value,
            event.payload.role === "user" ? { latestUserMessageAt: event.payload.createdAt } : {},
          );
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...summary,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.proposed-plan-upserted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const hasActionableProposedPlan =
            yield* projectionThreadProposedPlanRepository.hasActionableForThread({
              threadId: event.payload.threadId,
              latestTurnId: existingRow.value.latestTurnId,
            });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...applyThreadShellSummaryTransition(existingRow.value, {
              hasActionableProposedPlan,
            }),
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.activity-appended":
        case "thread.approval-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...applyThreadShellSummaryTransition(existingRow.value, {
              pendingApprovalDelta: attachmentSideEffects.pendingApprovalDelta,
              pendingUserInputDelta: attachmentSideEffects.pendingUserInputDelta,
            }),
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const latestTurnId = event.payload.session.activeTurnId ?? existingRow.value.latestTurnId;
          const hasActionableProposedPlan =
            yield* projectionThreadProposedPlanRepository.hasActionableForThread({
              threadId: event.payload.threadId,
              latestTurnId,
            });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...applyThreadShellSummaryTransition(existingRow.value, {
              hasActionableProposedPlan,
            }),
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          // Keep the interrupted turn as the durable latest turn so reconnecting
          // clients can settle transcript-only subagents instead of resurrecting
          // them as live.
          const hasActionableProposedPlan =
            yield* projectionThreadProposedPlanRepository.hasActionableForThread({
              threadId: event.payload.threadId,
              latestTurnId: event.payload.turnId,
            });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...applyThreadShellSummaryTransition(existingRow.value, {
              hasActionableProposedPlan,
            }),
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const hasActionableProposedPlan =
            yield* projectionThreadProposedPlanRepository.hasActionableForThread({
              threadId: event.payload.threadId,
              latestTurnId: event.payload.turnId,
            });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...applyThreadShellSummaryTransition(existingRow.value, {
              hasActionableProposedPlan,
            }),
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* recomputeThreadShellSummary(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    });

    const applyWorktreesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorktreesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "worktree.created":
          yield* projectionWorktreeRepository.upsert({
            worktreeId: event.payload.worktreeId,
            projectId: event.payload.projectId,
            title: null,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            origin: event.payload.origin,
            prNumber: event.payload.prNumber,
            issueNumber: event.payload.issueNumber,
            prTitle: event.payload.prTitle,
            issueTitle: event.payload.issueTitle,
            prState: null,
            prIsDraft: null,
            issueState: null,
            workItemProvider: event.payload.workItemProvider ?? null,
            workItemKey: event.payload.workItemKey ?? null,
            workItemTitle: event.payload.workItemTitle ?? null,
            workItemState: event.payload.workItemState ?? null,
            workItemStateName: event.payload.workItemStateName ?? null,
            workItemUrl: event.payload.workItemUrl ?? null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            manualPosition: 0,
          });
          return;

        case "worktree.archived":
          yield* projectionWorktreeRepository.markArchived({
            worktreeId: event.payload.worktreeId,
            archivedAt: event.payload.archivedAt,
          });
          return;

        case "worktree.metaUpdated": {
          const existing = yield* projectionWorktreeRepository.getById({
            worktreeId: event.payload.worktreeId,
          });
          if (Option.isSome(existing)) {
            yield* projectionWorktreeRepository.upsert({
              ...existing.value,
              ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
              ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
              updatedAt: event.payload.changedAt,
            });
          }
          return;
        }

        case "worktree.sourceControlStateUpdated": {
          const existing = yield* projectionWorktreeRepository.getById({
            worktreeId: event.payload.worktreeId,
          });
          if (Option.isSome(existing)) {
            yield* projectionWorktreeRepository.upsert({
              ...existing.value,
              ...(event.payload.prNumber !== undefined ? { prNumber: event.payload.prNumber } : {}),
              ...(event.payload.prTitle !== undefined ? { prTitle: event.payload.prTitle } : {}),
              prState: event.payload.prState,
              prIsDraft: event.payload.prIsDraft,
              issueState: event.payload.issueState,
              updatedAt: event.payload.updatedAt,
            });
          }
          return;
        }

        case "worktree.restored":
          yield* projectionWorktreeRepository.markRestored({
            worktreeId: event.payload.worktreeId,
            restoredAt: event.payload.restoredAt,
          });
          if (event.payload.worktreePath !== undefined) {
            const existing = yield* projectionWorktreeRepository.getById({
              worktreeId: event.payload.worktreeId,
            });
            if (Option.isSome(existing)) {
              yield* projectionWorktreeRepository.upsert({
                ...existing.value,
                worktreePath: event.payload.worktreePath,
                archivedAt: null,
                updatedAt: event.payload.restoredAt,
              });
            }
          }
          return;

        case "worktree.deleted":
          yield* projectionWorktreeRepository.deleteById({
            worktreeId: event.payload.worktreeId,
          });
          return;

        case "thread.attachedToWorktree":
          yield* projectionThreadRepository.attachToWorktree({
            threadId: event.payload.threadId,
            worktreeId: event.payload.worktreeId,
          });
          return;

        case "thread.statusBucketOverridden":
          yield* projectionThreadRepository.setManualBucket({
            threadId: event.payload.threadId,
            bucket: event.payload.bucket,
          });
          return;

        case "thread.manualPositionSet":
          yield* projectionThreadRepository.setManualPosition({
            threadId: event.payload.threadId,
            position: event.payload.position,
          });
          return;

        case "worktree.manualPositionSet":
          yield* projectionWorktreeRepository.setManualPosition({
            worktreeId: event.payload.worktreeId,
            position: event.payload.position,
          });
          return;

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.message-sent": {
          const attachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : undefined;
          yield* projectionThreadMessageRepository.applyEvent(
            {
              messageId: event.payload.messageId,
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              role: event.payload.role,
              text: event.payload.text,
              ...(attachments !== undefined ? { attachments: [...attachments] } : {}),
              ...(event.payload.dispatchMode !== undefined
                ? { dispatchMode: event.payload.dispatchMode }
                : {}),
              isStreaming: event.payload.streaming,
              createdAt: event.payload.createdAt,
              updatedAt: event.payload.updatedAt,
            },
            event.sequence,
          );
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          // Retained bodies are compacted with a fence against pre-revert deltas.
          yield* Effect.forEach(
            keptRows,
            (row) =>
              projectionThreadMessageRepository.upsert(row, { eventSequence: event.sequence }),
            {
              concurrency: 1,
            },
          ).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* projectionThreadUserInputRequestRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.user-input-response-requested": {
          const row = yield* projectionThreadUserInputRequestRepository.getByRequestId({
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
          });
          if (
            Option.isSome(row) &&
            row.value.isPending &&
            sameApprovalIdentity(row.value.userInputIdentity, event.payload.userInputIdentity)
          ) {
            yield* projectionThreadUserInputRequestRepository.upsert({
              ...row.value,
              responseState: "submitting",
              ...(event.commandId ? { responseAttemptId: event.commandId } : {}),
              updatedAt: event.occurredAt,
            });
          }
          return;
        }

        case "thread.activity-appended": {
          const requestId = extractActivityRequestId(event.payload.activity.payload);
          const activityPayload =
            typeof event.payload.activity.payload === "object" &&
            event.payload.activity.payload !== null
              ? (event.payload.activity.payload as Record<string, unknown>)
              : null;
          const kind = event.payload.activity.kind;
          if (
            requestId !== null &&
            (kind.startsWith("user-input.") || kind === "provider.user-input.respond.failed")
          ) {
            const existing = yield* projectionThreadUserInputRequestRepository.getByRequestId({
              threadId: event.payload.threadId,
              requestId,
            });
            const row = Option.getOrUndefined(existing);
            const identity = Schema.is(ApprovalResponseIdentity)(activityPayload?.userInputIdentity)
              ? activityPayload.userInputIdentity
              : undefined;
            const responseState = Schema.is(ApprovalResponseState)(activityPayload?.responseState)
              ? activityPayload.responseState
              : undefined;
            const wasPending = row?.isPending ?? false;
            if (kind === "user-input.requested") {
              if (row && sameApprovalIdentity(row.userInputIdentity, identity)) return;
              const reused =
                row?.userInputIdentity?.runtimeSessionId === identity?.runtimeSessionId &&
                row !== undefined;
              if (wasPending && reused) return;
              yield* projectionThreadUserInputRequestRepository.upsert({
                requestId,
                threadId: event.payload.threadId,
                isPending: true,
                updatedAt: event.payload.activity.createdAt,
                ...(identity ? { userInputIdentity: identity } : {}),
                settlementRequiresIdentity: reused,
              });
              attachmentSideEffects.pendingUserInputDelta += pendingStateDelta(wasPending, true);
            } else if (kind !== "user-input.response.submitted" && row) {
              if (!wasPending) return;
              if (identity && !sameApprovalIdentity(row.userInputIdentity, identity)) return;
              if (
                typeof activityPayload?.responseAttemptId === "string" &&
                row.responseAttemptId !== activityPayload.responseAttemptId
              )
                return;
              if (
                kind === "user-input.resolved" &&
                (row.userInputIdentity?.runtimeSessionId !== activityPayload?.runtimeSessionId ||
                  (row.settlementRequiresIdentity && !identity))
              )
                return;
              if (
                kind === "provider.user-input.respond.failed" &&
                row.userInputIdentity &&
                (!sameApprovalIdentity(row.userInputIdentity, identity) ||
                  row.responseAttemptId !== activityPayload?.responseAttemptId)
              )
                return;
              const terminal =
                kind === "user-input.resolved" ||
                responseState === "invalidated" ||
                userInputActivityPendingState({
                  kind,
                  detail:
                    typeof activityPayload?.detail === "string" ? activityPayload.detail : null,
                }) === false;
              yield* projectionThreadUserInputRequestRepository.upsert({
                ...row,
                isPending: !terminal,
                ...(kind === "user-input.resolved"
                  ? { responseState: "settled" as const }
                  : responseState
                    ? { responseState }
                    : {}),
                updatedAt: event.payload.activity.createdAt,
              });
              attachmentSideEffects.pendingUserInputDelta += pendingStateDelta(
                wasPending,
                !terminal,
              );
            }
          }
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(pendingRequestActivityInOrchestrationOrder(event.payload.activity, event.sequence)
              .sequence !== undefined
              ? {
                  sequence: pendingRequestActivityInOrchestrationOrder(
                    event.payload.activity,
                    event.sequence,
                  ).sequence,
                }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          const userInputStates = derivePendingUserInputStatesFromActivities(keptRows);
          yield* projectionThreadUserInputRequestRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            userInputStates,
            ([requestId, state]) =>
              projectionThreadUserInputRequestRepository.upsert({
                requestId,
                threadId: event.payload.threadId,
                isPending: state.isPending,
                updatedAt: state.updatedAt,
              }),
            { concurrency: 1, discard: true },
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type === "thread.created") {
        yield* projectionThreadSessionRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        return;
      }
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeSessionId: event.payload.session.runtimeSessionId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        tokenMode: event.payload.session.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: event.payload.streaming
                ? existingTurn.value.state
                : existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed",
              completedAt: event.payload.streaming
                ? existingTurn.value.completedAt
                : (existingTurn.value.completedAt ?? event.payload.updatedAt),
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: event.payload.streaming ? "running" : "completed",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.streaming ? null : event.payload.updatedAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionPendingApprovalRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            threadId: event.payload.threadId,
            requestId,
          });
          const activityPayload =
            typeof event.payload.activity.payload === "object" &&
            event.payload.activity.payload !== null
              ? (event.payload.activity.payload as Record<string, unknown>)
              : {};
          const identity = Schema.is(ApprovalResponseIdentity)(activityPayload.approvalIdentity)
            ? activityPayload.approvalIdentity
            : undefined;
          const responseState = Schema.is(ApprovalResponseState)(activityPayload.responseState)
            ? activityPayload.responseState
            : undefined;
          if (
            event.payload.activity.kind === "approval.resolved" &&
            Option.isSome(existingRow) &&
            existingRow.value.approvalIdentity?.runtimeSessionId !==
              activityPayload.runtimeSessionId
          )
            return;
          if (
            event.payload.activity.kind === "provider.approval.respond.failed" &&
            responseState !== undefined
          ) {
            if (
              Option.isNone(existingRow) ||
              !matchesApprovalAttempt(
                existingRow.value,
                identity,
                typeof activityPayload.responseAttemptId === "string"
                  ? activityPayload.responseAttemptId
                  : undefined,
              )
            )
              return;
            // Settlement wins over any delayed failure from the same attempt.
            if (existingRow.value.status === "resolved") return;
            const invalidated = responseState === "invalidated";
            if (invalidated) attachmentSideEffects.pendingApprovalDelta -= 1;
            yield* projectionPendingApprovalRepository.upsert({
              ...existingRow.value,
              responseState,
              decision: invalidated ? null : existingRow.value.decision,
              status: invalidated ? "resolved" : "pending",
              resolvedAt: invalidated ? event.payload.activity.createdAt : null,
            });
            return;
          }
          if (event.payload.activity.kind === "approval.resolved") {
            if (Option.isSome(existingRow)) {
              if (existingRow.value.status === "resolved") return;
              if (
                identity !== undefined &&
                !sameApprovalIdentity(existingRow.value.approvalIdentity, identity)
              )
                return;
              if (existingRow.value.settlementRequiresIdentity && identity === undefined) return;
              if (
                typeof activityPayload.responseAttemptId === "string" &&
                existingRow.value.responseAttemptId !== activityPayload.responseAttemptId
              )
                return;
            }
            attachmentSideEffects.pendingApprovalDelta += pendingStateDelta(
              Option.isSome(existingRow) && existingRow.value.status === "pending",
              false,
            );
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              ...(Option.isSome(existingRow) ? existingRow.value : {}),
              responseState: "settled",
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            if (Option.isSome(existingRow) && existingRow.value.responseAttemptId) return;
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              attachmentSideEffects.pendingApprovalDelta -= 1;
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingThreadRequestState.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (
            Option.isSome(existingRow) &&
            sameApprovalIdentity(existingRow.value.approvalIdentity, identity)
          )
            return;
          // A new callback may reuse a provider-local id, but an unqualified late
          // provider settlement can no longer identify that callback unambiguously.
          const reusedInRuntime =
            Option.isSome(existingRow) &&
            existingRow.value.approvalIdentity?.runtimeSessionId === identity?.runtimeSessionId;
          if (reusedInRuntime && existingRow.value.status === "pending") return;
          attachmentSideEffects.pendingApprovalDelta += pendingStateDelta(
            Option.isSome(existingRow) && existingRow.value.status === "pending",
            true,
          );
          yield* projectionPendingApprovalRepository.upsert({
            ...(identity ? { approvalIdentity: identity } : {}),
            settlementRequiresIdentity: reusedInRuntime,
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionPendingApprovalRepository.upsert({
            ...existingRow.value,
            // A durable claim is not provider settlement. Pending counts remain unchanged.
            decision: event.payload.decision,
            ...(event.commandId ? { responseAttemptId: event.commandId } : {}),
            responseState: "submitting",
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.worktrees,
        apply: applyWorktreesProjection,
      },
    ];

    const applyProjectorsForEvent = Effect.fn("applyProjectorsForEvent")(function* (
      event: OrchestrationEvent,
      projectorsToAdvance: ReadonlyArray<ProjectorDefinition>,
    ) {
      const perfEnabled = isServerPerfProfileEnabled();
      const startedAtMs = perfEnabled ? Date.now() : 0;
      const attachmentSideEffects: ProjectionEventContext = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
        postCommitEffects: [],
        pendingApprovalDelta: 0,
        pendingUserInputDelta: 0,
      };

      const routedProjectorNames = new Set<ProjectorName>(
        ORCHESTRATION_EVENT_PROJECTORS[event.type],
      );
      const relevantProjectors = projectorsToAdvance.filter((projector) =>
        routedProjectorNames.has(projector.name),
      );

      for (const projector of relevantProjectors) {
        const projectorStartedAtMs = perfEnabled ? Date.now() : 0;
        yield* projector.apply(event, attachmentSideEffects);
        if (perfEnabled) {
          yield* Effect.sync(() =>
            recordServerPerf(
              `server.orchestration.projection.projector.${event.type}.${projector.name}`,
              {
                count: 1,
                durationMs: Math.max(0, Date.now() - projectorStartedAtMs),
              },
            ),
          );
        }
      }

      yield* projectionStateRepository.upsertMany(
        projectorsToAdvance.map((projector) => ({
          projector: projector.name,
          lastAppliedSequence: event.sequence,
          updatedAt: event.occurredAt,
        })),
      );

      if (perfEnabled) {
        yield* Effect.sync(() => {
          recordServerPerf(
            `server.orchestration.projection.routing.${event.type}.relevant.${relevantProjectors.length}.skipped.${projectorsToAdvance.length - relevantProjectors.length}`,
            {
              count: 1,
              durationMs: Math.max(0, Date.now() - startedAtMs),
            },
          );
          recordServerPerf(`server.orchestration.projection.cursor-batch.${event.type}`, {
            count: 1,
          });
        });
      }

      const postCommit: Effect.Effect<void> = Effect.all(
        [
          runAttachmentSideEffects(attachmentSideEffects).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ServerConfig, serverConfig),
          ),
          ...attachmentSideEffects.postCommitEffects,
        ],
        { concurrency: 1, discard: true },
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to apply projection post-commit side-effects", {
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
      return postCommit;
    });

    const bootstrapProjectors = Effect.gen(function* () {
      const stateRows = yield* projectionStateRepository.listAll();
      const lastAppliedByProjector = new Map<ProjectorName, number>(
        projectors.map((projector) => [projector.name, 0] as const),
      );
      for (const row of stateRows) {
        if (lastAppliedByProjector.has(row.projector as ProjectorName)) {
          lastAppliedByProjector.set(row.projector as ProjectorName, row.lastAppliedSequence);
        }
      }

      const replayFromSequence = Math.min(...lastAppliedByProjector.values());
      const replayThroughSequence = yield* eventStore.latestSequence;
      yield* Stream.runForEach(
        eventStore.readThroughSequence(replayFromSequence, replayThroughSequence),
        (event) =>
          Effect.gen(function* () {
            const projectorsToAdvance = projectors.filter(
              (projector) => event.sequence > (lastAppliedByProjector.get(projector.name) ?? 0),
            );
            if (projectorsToAdvance.length === 0) {
              return;
            }
            const postCommit = yield* sql.withTransaction(
              applyProjectorsForEvent(event, projectorsToAdvance),
            );
            for (const projector of projectorsToAdvance) {
              lastAppliedByProjector.set(projector.name, event.sequence);
            }
            yield* postCommit;
          }),
      );
    });

    const projectEventInTransaction: OrchestrationProjectionPipelineShape["projectEventInTransaction"] =
      (event) =>
        applyProjectorsForEvent(event, projectors).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ServerConfig, serverConfig),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      sql.withTransaction(projectEventInTransaction(event)).pipe(
        Effect.flatMap((postCommit) => postCommit),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = bootstrapProjectors.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
      projectEventInTransaction,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionThreadUserInputRequestRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionWorktreeRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
