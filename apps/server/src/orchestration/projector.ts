import { pendingRequestActivityInOrchestrationOrder } from "@ryco/shared/threadActivity";
import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationWorktreeShell,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import type { OrchestrationLatestTurn } from "@ryco/contracts";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationWorktreeShell as OrchestrationWorktreeShellSchema,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";
import { capThreadActivitiesPreservingMilestones } from "@ryco/shared/threadActivity";
import { checkpointStatusToTurnState, mergeReleasedTurn } from "@ryco/shared/turnFinalization";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import { resolveEventPullRequestTerminalAt } from "./pullRequestTerminalAt.ts";
import { withThreadLineage } from "./threadLineage.ts";
import { latestUserMessage } from "./userMessageOrder.ts";
import {
  MessageSentPayloadSchema,
  ProjectAvatarSetPayload,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadSnoozedPayload,
  ThreadUnsnoozedPayload,
  ThreadUsageLimitClearedPayload,
  ThreadUsageLimitSetPayload,
  ThreadTokenModeSetPayload,
  ThreadGoalUpdatedPayload,
  ThreadGoalClearedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnInterruptRequestedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadAttachedToWorktreePayload,
  ThreadStatusBucketOverriddenPayload,
  WorktreeArchivedPayload,
  WorktreeCreatedPayload,
  WorktreeDeletedPayload,
  WorktreeManualPositionSetPayload,
  WorktreeMetaUpdatedPayload,
  WorktreeRestoredPayload,
  WorktreeSourceControlStateUpdatedPayload,
} from "./Schemas.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
type WorktreePatch = Partial<Omit<OrchestrationWorktreeShell, "worktreeId" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;
const MAX_THREAD_ACTIVITIES = 500;

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function updateWorktree(
  worktrees: ReadonlyArray<OrchestrationWorktreeShell> | undefined,
  worktreeId: WorktreeId,
  patch: WorktreePatch,
): OrchestrationWorktreeShell[] {
  return (worktrees ?? []).map((worktree) =>
    worktree.worktreeId === worktreeId ? Object.assign({}, worktree, patch) : worktree,
  );
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

/**
 * Caps in-memory history without evicting the thread's first user message or the fence's
 * latest user message. The command model depends on both: some(user) (thread started →
 * context handoff, archive) and latestUserMessage (delegated-return fence: max createdAt,
 * ties by insertion order). Identical to slice(-MAX_THREAD_MESSAGES) whenever both anchors
 * lie within the newest window.
 */
function capThreadMessagesPreservingUserAnchors(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  let excess = messages.length - MAX_THREAD_MESSAGES;
  if (excess <= 0) return messages;
  const firstUserId = messages.find((message) => message.role === "user")?.id;
  const latestUserId = latestUserMessage(messages)?.id;
  return messages.filter((message) => {
    if (excess === 0 || message.id === firstUserId || message.id === latestUserId) return true;
    excess -= 1;
    return false;
  });
}

/**
 * Decides whether an item bound to a turn survives a revert. The legacy rule
 * keeps only turns with a retained checkpoint; the authoritative rule (events
 * that carry `latestTurn`) also keeps items of turns that are not dropped and
 * predate the kept boundary, which the hydrated command model has no
 * checkpoints for.
 */
type RevertTurnItemFilter = (item: {
  readonly turnId: string;
  readonly createdAt: string;
}) => boolean;

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  keepTurnItem: RevertTurnItemFilter,
  turnCount: number,
  /** Authoritative boundary: fallback candidates must not postdate it. Null keeps none. */
  boundaryAt?: string | null,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== null &&
      keepTurnItem({ turnId: message.turnId, createdAt: message.createdAt })
    ) {
      retainedMessageIds.add(message.id);
    }
  }
  const isFallbackCandidate = (message: OrchestrationMessage) =>
    (message.turnId === null ||
      keepTurnItem({ turnId: message.turnId, createdAt: message.createdAt })) &&
    (boundaryAt === undefined || (boundaryAt !== null && message.createdAt <= boundaryAt));

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          isFallbackCandidate(message),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          isFallbackCandidate(message),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainTurnItemsAfterRevert<
  T extends { readonly turnId: string | null; readonly createdAt: string },
>(items: ReadonlyArray<T>, keepTurnItem: RevertTurnItemFilter): ReadonlyArray<T> {
  return items.filter(
    (item) =>
      item.turnId === null || keepTurnItem({ turnId: item.turnId, createdAt: item.createdAt }),
  );
}

/** The latest-turn entry a revert to `checkpoint` leaves behind. */
export function latestTurnFromCheckpoint(
  checkpoint: OrchestrationCheckpointSummary,
): OrchestrationLatestTurn {
  return {
    turnId: checkpoint.turnId,
    state: checkpointStatusToTurnState(checkpoint.status),
    requestedAt: checkpoint.completedAt,
    startedAt: checkpoint.completedAt,
    completedAt: checkpoint.completedAt,
    assistantMessageId: checkpoint.assistantMessageId,
  };
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    worktrees: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            projectMetadataDir: payload.projectMetadataDir,
            defaultModelSelection: payload.defaultModelSelection,
            customSystemPrompt: payload.customSystemPrompt ?? null,
            customAvatarContentHash: null as string | null,
            preferredRemoteName: null as string | null,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.projectMetadataDir !== undefined
                    ? { projectMetadataDir: payload.projectMetadataDir }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.customSystemPrompt !== undefined
                    ? { customSystemPrompt: payload.customSystemPrompt }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  ...(payload.preferredRemoteName !== undefined
                    ? { preferredRemoteName: payload.preferredRemoteName }
                    : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.avatar-set":
      return decodeForEvent(ProjectAvatarSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  customAvatarContentHash: payload.contentHash,
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        // Re-creating a soft-deleted id replaces the whole thread, so lineage resets.
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          withThreadLineage(
            {
              id: payload.threadId,
              projectId: payload.projectId,
              title: payload.title,
              modelSelection: payload.modelSelection,
              runtimeMode: payload.runtimeMode,
              interactionMode: payload.interactionMode,
              tokenMode: payload.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
              branch: payload.branch,
              worktreePath: payload.worktreePath,
              worktreeId: null,
              manualStatusBucket: null,
              manualPosition: 0,
              latestTurn: null,
              goal: null,
              createdAt: payload.createdAt,
              updatedAt: payload.updatedAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              deletedAt: null,
              messages: [],
              activities: [],
              checkpoints: [],
              session: null,
            },
            payload.lineage ?? null,
          ),
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "worktree.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          WorktreeCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const worktree = yield* decodeForEvent(
          OrchestrationWorktreeShellSchema,
          {
            worktreeId: payload.worktreeId,
            projectId: payload.projectId,
            title: null,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            origin: payload.origin,
            prNumber: payload.prNumber,
            issueNumber: payload.issueNumber,
            prTitle: payload.prTitle,
            issueTitle: payload.issueTitle,
            workItemProvider: payload.workItemProvider ?? null,
            workItemKey: payload.workItemKey ?? null,
            workItemTitle: payload.workItemTitle ?? null,
            workItemState: payload.workItemState ?? null,
            workItemStateName: payload.workItemStateName ?? null,
            workItemUrl: payload.workItemUrl ?? null,
            prState: null,
            prIsDraft: null,
            prTerminalAt: null,
            issueState: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            manualPosition: 0,
          },
          event.type,
          "worktree",
        );
        const existing = nextBase.worktrees?.find(
          (entry) => entry.worktreeId === worktree.worktreeId,
        );
        return {
          ...nextBase,
          worktrees: existing
            ? (nextBase.worktrees ?? []).map((entry) =>
                entry.worktreeId === worktree.worktreeId ? worktree : entry,
              )
            : [...(nextBase.worktrees ?? []), worktree],
        };
      });

    case "worktree.archived":
      return decodeForEvent(WorktreeArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          worktrees: updateWorktree(nextBase.worktrees, payload.worktreeId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.archivedAt,
          }),
        })),
      );

    case "worktree.metaUpdated":
      return decodeForEvent(WorktreeMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          worktrees: updateWorktree(nextBase.worktrees, payload.worktreeId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            updatedAt: payload.changedAt,
          }),
        })),
      );

    case "worktree.sourceControlStateUpdated":
      return decodeForEvent(
        WorktreeSourceControlStateUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existing = nextBase.worktrees?.find(
            (worktree) => worktree.worktreeId === payload.worktreeId,
          );
          return {
            ...nextBase,
            worktrees: updateWorktree(nextBase.worktrees, payload.worktreeId, {
              ...(payload.prNumber !== undefined ? { prNumber: payload.prNumber } : {}),
              ...(payload.prTitle !== undefined ? { prTitle: payload.prTitle } : {}),
              prState: payload.prState,
              prIsDraft: payload.prIsDraft,
              prTerminalAt: resolveEventPullRequestTerminalAt(payload, existing),
              issueState: payload.issueState,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "worktree.restored":
      return decodeForEvent(WorktreeRestoredPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          worktrees: updateWorktree(nextBase.worktrees, payload.worktreeId, {
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            archivedAt: null,
            updatedAt: payload.restoredAt,
          }),
        })),
      );

    case "worktree.deleted":
      return decodeForEvent(WorktreeDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          worktrees: (nextBase.worktrees ?? []).filter(
            (worktree) => worktree.worktreeId !== payload.worktreeId,
          ),
        })),
      );

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "active",
            settledAt: null,
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "active",
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
            ...payload.restoredSidebarState,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            snoozedUntil: null,
            snoozedAt: null,
            settledAt: payload.settledAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: payload.updatedAt,
            ...payload.restoredSidebarState,
          }),
        })),
      );

    case "thread.usage-limit-set":
      return decodeForEvent(ThreadUsageLimitSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            usageLimit: payload.usageLimit,
            updatedAt: payload.usageLimit.updatedAt,
          }),
        })),
      );

    case "thread.usage-limit-cleared":
      return decodeForEvent(
        ThreadUsageLimitClearedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          // A clear for an older limit must not drop a newer one.
          if (thread?.usageLimit?.limitId !== payload.limitId) return nextBase;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              usageLimit: null,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.token-mode-set":
      return decodeForEvent(ThreadTokenModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            tokenMode: payload.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.goal-updated":
      return decodeForEvent(ThreadGoalUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            goal: payload.goal,
            updatedAt: payload.goal.updatedAt,
          }),
        })),
      );

    case "thread.goal-cleared":
      return decodeForEvent(ThreadGoalClearedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            goal: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.dispatchMode !== undefined ? { dispatchMode: payload.dispatchMode } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.dispatchMode !== undefined
                      ? { dispatchMode: message.dispatchMode }
                      : {}),
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = capThreadMessagesPreservingUserAnchors(messages);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );
        const normalizedSession: OrchestrationSession = {
          ...session,
          tokenMode: session.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        };
        // The decider decided which turn this release ends; apply it only to that turn.
        const released = payload.releasedTurn;
        const settledLatestTurn =
          released !== undefined &&
          thread.latestTurn !== null &&
          thread.latestTurn.turnId === released.turnId
            ? { ...thread.latestTurn, ...mergeReleasedTurn(thread.latestTurn, released) }
            : thread.latestTurn;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session: normalizedSession,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : settledLatestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-interrupt-requested":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnInterruptRequestedPayload,
          event.payload,
          event.type,
          "payload",
        );
        if (payload.turnId === undefined) {
          return nextBase;
        }
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (thread?.latestTurn?.turnId !== payload.turnId) {
          return nextBase;
        }

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            latestTurn: {
              ...thread.latestTurn,
              state: "interrupted",
              startedAt: thread.latestTurn.startedAt ?? payload.createdAt,
              completedAt: thread.latestTurn.completedAt ?? payload.createdAt,
            },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // A checkpoint never changes an existing turn's state: it only attaches checkpoint
        // fields. The state comes from the shared mapping only when the diff creates the
        // latest-turn entry (no entry for this turn yet).
        const sameTurn =
          thread.latestTurn !== null && thread.latestTurn.turnId === payload.turnId
            ? thread.latestTurn
            : null;
        const latestTurn =
          sameTurn !== null
            ? {
                ...sameTurn,
                startedAt: sameTurn.startedAt ?? payload.completedAt,
                completedAt:
                  sameTurn.state === "running"
                    ? sameTurn.completedAt
                    : (sameTurn.completedAt ?? payload.completedAt),
                assistantMessageId: payload.assistantMessageId,
              }
            : {
                turnId: payload.turnId,
                state: checkpointStatusToTurnState(payload.status),
                requestedAt: payload.completedAt,
                startedAt: payload.completedAt,
                completedAt: payload.completedAt,
                assistantMessageId: payload.assistantMessageId,
              };

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set<string>(
            checkpoints.map((checkpoint) => checkpoint.turnId),
          );

          // Events carrying `latestTurn` are authoritative (read from SQL by the
          // reactor). Legacy events and replays keep the count-based rule.
          const authoritative = payload.latestTurn !== undefined;
          let latestTurn: OrchestrationLatestTurn | null;
          let keepTurnItem: RevertTurnItemFilter;
          let boundaryAt: string | null | undefined;
          if (authoritative) {
            latestTurn = payload.latestTurn ?? null;
            if (latestTurn !== null) retainedTurnIds.add(latestTurn.turnId);
            const dropped = new Set<string>(payload.droppedTurnIds ?? []);
            const boundary = latestTurn?.completedAt ?? null;
            boundaryAt = boundary;
            keepTurnItem = (item) =>
              retainedTurnIds.has(item.turnId) ||
              (!dropped.has(item.turnId) && boundary !== null && item.createdAt <= boundary);
          } else {
            const latestCheckpoint = checkpoints.at(-1) ?? null;
            latestTurn =
              latestCheckpoint === null ? null : latestTurnFromCheckpoint(latestCheckpoint);
            keepTurnItem = (item) => retainedTurnIds.has(item.turnId);
            boundaryAt = undefined;
          }

          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            keepTurnItem,
            payload.turnCount,
            boundaryAt,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainTurnItemsAfterRevert(
            thread.proposedPlans,
            keepTurnItem,
          ).slice(-200);
          const activities = retainTurnItemsAfterRevert(thread.activities, keepTurnItem);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            pendingRequestActivityInOrchestrationOrder(payload.activity, event.sequence),
          ].toSorted(compareThreadActivities);
          const cappedActivities = capThreadActivitiesPreservingMilestones(
            activities,
            MAX_THREAD_ACTIVITIES,
          );

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities: cappedActivities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.attachedToWorktree":
      return decodeForEvent(
        ThreadAttachedToWorktreePayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            worktreeId: payload.worktreeId,
            updatedAt: payload.attachedAt,
          }),
        })),
      );

    case "thread.statusBucketOverridden":
      return decodeForEvent(
        ThreadStatusBucketOverriddenPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            manualStatusBucket: payload.bucket,
            updatedAt: payload.changedAt,
          }),
        })),
      );

    case "worktree.manualPositionSet":
      return decodeForEvent(
        WorktreeManualPositionSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          worktrees: updateWorktree(nextBase.worktrees, payload.worktreeId, {
            manualPosition: payload.position,
            updatedAt: payload.changedAt,
          }),
        })),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
