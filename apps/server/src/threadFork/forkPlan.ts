/**
 * Builds the `thread.fork.create` publication from a resolved boundary.
 *
 * Inherited items get fork-owned ids (`forkInheritance.ts`), keep their timestamps and order,
 * and keep their turn ids; attachments are rewritten to fork-owned copies. Only display-only
 * activities of inherited turns are copied: request lifecycles (approvals, user input), context
 * handoffs, checkpoints, setup scripts, session/runtime and subagent/task lifecycles would
 * reopen requests, block turns or fake state in the fork.
 *
 * The parts that depend on how the run went (checkout, provider context, notices) are an
 * explicit outcome: build once at acceptance with the planned outcome, then
 * `finalizeForkPublication` with the actual one before dispatch.
 *
 * Pure and deterministic for a given input: no clocks, no ids minted here.
 */
import {
  type AgentTokenMode,
  type ChatAttachment,
  type CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadForkCheckout,
  type ThreadForkCreateCommand,
  type ThreadForkHandoffReason,
  type ThreadForkProviderContext,
  type ThreadId,
  type TurnId,
  type WorktreeId,
} from "@ryco/contracts";
import { truncateUnicodeSafe } from "@ryco/shared/String";

import { inheritedChatAttachment, isPersistableChatAttachment } from "../attachmentStore.ts";
import { inheritedItemId } from "../orchestration/forkInheritance.ts";
import { compareHistoryOrder, type ForkBoundary, type ForkBoundaryTurn } from "./forkBoundary.ts";
import type { ThreadForkAttachmentCopy } from "./forkLedger.ts";

/** Activity kinds copied from inherited turns. Each is display-only on the server. */
export const FORK_INHERITED_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed",
  "turn.plan.updated",
]);

export const FORK_MAX_INHERITED_ACTIVITIES = 2000;
export const FORK_MAX_INHERITED_PLANS = 200;
export const FORK_MAX_NOTICES = 8;
/** Shown once, whether an attachment had no valid copy id or its file could not be linked. */
export const FORK_SKIPPED_ATTACHMENTS_NOTICE = "Some attachments could not be carried over.";
const FORK_NOTICE_MAX_CHARS = 500;
const FORK_TITLE_MAX_CHARS = 200;
const FORK_TITLE_SUFFIX = " (fork)";

/** `<source title> (fork)`, the source title shortened to fit. */
export function forkThreadTitle(sourceTitle: string): string {
  const base = sourceTitle.trim() || "Untitled";
  return `${truncateUnicodeSafe(base, FORK_TITLE_MAX_CHARS - FORK_TITLE_SUFFIX.length).trimEnd()}${FORK_TITLE_SUFFIX}`;
}

/** The parts of a publication decided by the run, not by the boundary. */
export interface ForkPublicationOutcome {
  readonly checkout: ThreadForkCheckout;
  /** `current-checkout` only: the source's workspace the fork attaches to (null: none). */
  readonly sourceWorktreeId: WorktreeId | null;
  readonly providerContext: ThreadForkProviderContext;
  /** Required when `providerContext` is `handoff`. */
  readonly handoffReason?: ThreadForkHandoffReason | undefined;
  /** Notices of the run (e.g. an uncertain native fork), shown after the history notices. */
  readonly notices: ReadonlyArray<string>;
}

export interface ForkPublicationInput {
  readonly forkThreadId: ThreadId;
  readonly commandId: CommandId;
  /** The fork's project: the source's, or the new chat's. */
  readonly projectId: ProjectId;
  /** Server time of acceptance: the thread's creation and provenance time. */
  readonly createdAt: string;
  readonly source: {
    readonly threadId: ThreadId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly tokenMode?: AgentTokenMode | undefined;
  };
  readonly boundary: ForkBoundary;
  /** The source's turn rows: link inherited prompts to the turn they started. */
  readonly turns: ReadonlyArray<ForkBoundaryTurn>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly outcome: ForkPublicationOutcome;
}

export interface ForkPublication {
  readonly command: ThreadForkCreateCommand;
  /** Attachment files to link before publication, deduplicated by source id. */
  readonly attachments: ReadonlyArray<ThreadForkAttachmentCopy>;
  /** What the history could not carry over; part of the command's notices. */
  readonly historyNotices: ReadonlyArray<string>;
}

/** The `limit` newest items by `(createdAt, id)`, oldest first. */
function newest<T extends { readonly createdAt: string; readonly id: string }>(
  items: ReadonlyArray<T>,
  limit: number,
): ReadonlyArray<T> {
  const sorted = items.toSorted(compareHistoryOrder);
  return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
}

function boundedNotices(notices: ReadonlyArray<string>): ReadonlyArray<string> {
  const bounded = notices
    .map((notice) => truncateUnicodeSafe(notice.trim(), FORK_NOTICE_MAX_CHARS).trim())
    .filter((notice) => notice.length > 0);
  return [...new Set(bounded)].slice(0, FORK_MAX_NOTICES);
}

export function buildForkPublication(input: ForkPublicationInput): ForkPublication {
  const { forkThreadId, boundary } = input;
  const sourceThreadId = input.source.threadId;
  const forkId = (sourceItemId: string) =>
    inheritedItemId({ forkThreadId, sourceThreadId, sourceItemId });
  const historyNotices: string[] = [];

  const promptTurnIds = new Map<string, TurnId>();
  for (const turn of input.turns) {
    if (turn.turnId !== null && turn.pendingMessageId !== null) {
      promptTurnIds.set(turn.pendingMessageId, turn.turnId);
    }
  }

  const attachmentCopies = new Map<string, ThreadForkAttachmentCopy>();
  let droppedAttachments = 0;
  const inheritAttachments = (attachments: ReadonlyArray<ChatAttachment> | undefined) => {
    if (attachments === undefined) return undefined;
    const inherited: ChatAttachment[] = [];
    for (const attachment of attachments) {
      const copy = inheritedChatAttachment(attachment, forkThreadId);
      if (copy === null) {
        droppedAttachments++;
        continue;
      }
      if (isPersistableChatAttachment(attachment) && copy.id !== undefined) {
        attachmentCopies.set(attachment.id, { source: attachment, attachmentId: copy.id });
      }
      inherited.push(copy);
    }
    return inherited;
  };

  const messages = boundary.inheritedMessages.map((message): OrchestrationMessage => {
    const attachments = inheritAttachments(message.attachments);
    return {
      id: MessageId.make(forkId(message.id)),
      role: message.role,
      text: message.text,
      ...(attachments !== undefined ? { attachments } : {}),
      ...(message.dispatchMode !== undefined ? { dispatchMode: message.dispatchMode } : {}),
      turnId:
        message.turnId ??
        (message.role === "user" ? (promptTurnIds.get(message.id) ?? null) : null),
      streaming: false,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  });
  if (droppedAttachments > 0) {
    historyNotices.push(FORK_SKIPPED_ATTACHMENTS_NOTICE);
  }

  const inheritedTurns = new Set<string>(boundary.inheritedTurnIds);
  // The fork's projection creates a row only for a turn with an inherited reply, and that row
  // reads as completed. Turns that were interrupted or failed in the source keep that outcome
  // there, so a fork of the fork refuses them as boundaries exactly like the source does.
  const repliedTurns = new Set<string>(
    messages.flatMap((message) =>
      message.role === "assistant" && message.turnId !== null ? [message.turnId] : [],
    ),
  );
  const sourceTurnStates = new Map<string, ForkBoundaryTurn["state"]>(
    input.turns.flatMap((turn) => (turn.turnId === null ? [] : [[turn.turnId, turn.state]])),
  );
  const inheritedTurnOutcomes = boundary.inheritedTurnIds.flatMap((turnId) => {
    const state = sourceTurnStates.get(turnId);
    return repliedTurns.has(turnId) && (state === "interrupted" || state === "error")
      ? [{ turnId, state }]
      : [];
  });
  const boundaryCreatedAt = boundary.boundaryMessage.createdAt;
  const boundaryCompletedAt = boundary.boundaryMessage.updatedAt;
  const plans = input.proposedPlans.filter((plan) =>
    plan.turnId !== null ? inheritedTurns.has(plan.turnId) : plan.createdAt <= boundaryCreatedAt,
  );
  const keptPlans = newest(plans, FORK_MAX_INHERITED_PLANS);
  if (keptPlans.length < plans.length) {
    historyNotices.push("Older proposed plans were not carried over.");
  }
  const proposedPlans = keptPlans.map((plan): OrchestrationProposedPlan => {
    // An implementation that happened after the boundary is not part of the fork's history.
    const implemented = plan.implementedAt !== null && plan.implementedAt <= boundaryCompletedAt;
    return {
      id: forkId(plan.id),
      turnId: plan.turnId,
      planMarkdown: plan.planMarkdown,
      implementedAt: implemented ? plan.implementedAt : null,
      implementationThreadId: implemented ? plan.implementationThreadId : null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  });

  const activities = input.activities.filter(
    (activity) =>
      activity.turnId !== null &&
      inheritedTurns.has(activity.turnId) &&
      FORK_INHERITED_ACTIVITY_KINDS.has(activity.kind),
  );
  const keptActivities = newest(activities, FORK_MAX_INHERITED_ACTIVITIES);
  if (keptActivities.length < activities.length) {
    historyNotices.push("Older tool activity was not carried over.");
  }
  // Provider sequence numbers belong to the source's sessions; without one, inherited activity
  // orders by time ahead of the fork's own sequenced activity.
  const inheritedActivities = keptActivities.map((activity): OrchestrationThreadActivity => ({
    id: EventId.make(forkId(activity.id)),
    tone: activity.tone,
    kind: activity.kind,
    summary: activity.summary,
    payload: activity.payload,
    turnId: activity.turnId,
    createdAt: activity.createdAt,
  }));

  const draft: ThreadForkCreateCommand = {
    type: "thread.fork.create",
    commandId: input.commandId,
    threadId: forkThreadId,
    projectId: input.projectId,
    title: forkThreadTitle(input.source.title),
    modelSelection: input.source.modelSelection,
    runtimeMode: input.source.runtimeMode,
    interactionMode: input.source.interactionMode,
    ...(input.source.tokenMode !== undefined ? { tokenMode: input.source.tokenMode } : {}),
    branch: null,
    worktreePath: null,
    createdAt: input.createdAt,
    sourceThreadId,
    sourceMessageId: boundary.boundaryMessage.id,
    sourceTurnId: boundary.turnId,
    worktreeId: null,
    newWorktree: null,
    messages,
    proposedPlans,
    activities: inheritedActivities,
    forked: {
      schemaVersion: 1,
      sourceThreadId,
      sourceMessageId: boundary.boundaryMessage.id,
      sourceTurnId: boundary.turnId,
      sourceTitle: input.source.title.trim() || "Untitled",
      inheritedMessageCount: messages.length,
      ...(inheritedTurnOutcomes.length > 0 ? { inheritedTurnOutcomes } : {}),
      providerContext: input.outcome.providerContext,
      checkout: input.outcome.checkout,
      notices: [],
    },
  };
  return {
    command: finalizeForkPublication(draft, input.outcome, historyNotices),
    attachments: [...attachmentCopies.values()],
    historyNotices,
  };
}

/**
 * Drops the attachments whose fork-owned copy was never linked (the source file was missing or
 * changed), so the published history never references a file that does not exist. Attachments
 * without a stored file are kept.
 */
export function withoutUnlinkedAttachments(
  command: ThreadForkCreateCommand,
  unlinkedAttachmentIds: ReadonlySet<string>,
): ThreadForkCreateCommand {
  if (unlinkedAttachmentIds.size === 0) return command;
  const isUnlinked = (attachment: ChatAttachment) =>
    isPersistableChatAttachment(attachment) && unlinkedAttachmentIds.has(attachment.id);
  return {
    ...command,
    messages: command.messages.map((message) =>
      message.attachments?.some(isUnlinked)
        ? {
            ...message,
            attachments: message.attachments.filter((attachment) => !isUnlinked(attachment)),
          }
        : message,
    ),
  };
}

/**
 * Applies the run's outcome to a publication: where the thread lives, which workspace it
 * attaches to, the worktree record a new checkout needs, and the provenance's provider context
 * and notices. Everything inherited is left as built.
 */
export function finalizeForkPublication(
  command: ThreadForkCreateCommand,
  outcome: ForkPublicationOutcome,
  historyNotices: ReadonlyArray<string>,
): ThreadForkCreateCommand {
  const { checkout } = outcome;
  const placement =
    checkout.kind === "current-checkout"
      ? {
          branch: checkout.branch,
          worktreePath: checkout.worktreePath,
          worktreeId: outcome.sourceWorktreeId,
          newWorktree: null,
        }
      : checkout.kind === "new-worktree"
        ? {
            branch: checkout.branch,
            worktreePath: checkout.worktreePath,
            worktreeId: checkout.worktreeId,
            newWorktree: {
              worktreeId: checkout.worktreeId,
              branch: checkout.branch,
              worktreePath: checkout.worktreePath,
            },
          }
        : // A chat runs in its project's folder.
          { branch: null, worktreePath: null, worktreeId: null, newWorktree: null };
  const { handoffReason: _previousReason, ...forked } = command.forked;
  return {
    ...command,
    ...placement,
    forked: {
      ...forked,
      providerContext: outcome.providerContext,
      ...(outcome.providerContext === "handoff" && outcome.handoffReason !== undefined
        ? { handoffReason: outcome.handoffReason }
        : {}),
      checkout,
      notices: boundedNotices([...historyNotices, ...outcome.notices]),
    },
  };
}
