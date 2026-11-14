import {
  getAutoRuntimeModeUnavailableReason,
  getProviderInstanceModels,
  getProviderInteractionModeToggle,
  getProviderSupportsAskMode,
} from "@ryco/client-runtime/state/composer";
import {
  FOLLOW_UP_ON_ITS_WAY_REASON,
  followUpQueueRowOnItsWayReason,
  providerSteering,
  resolveQueuedMessageEditUnavailableReason,
  resolveFollowUpQueueEditState,
  resolveQueuedMessageSteerEligibility,
  type FollowUpQueueEdit,
  type FollowUpQueueRow,
} from "@ryco/client-runtime/state/message-queue";
import {
  deriveRevertTurnCountByUserMessageId,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  inferCheckpointTurnCountByTurnId,
  isLatestTurnSettled,
} from "@ryco/client-runtime/state/session";
import {
  buildThreadInbox,
  deriveUndoTurnCountByTurnId,
  threadForkBoundaryQuote,
  threadForkReplyExcerpt,
  type BuildThreadInboxInput,
  type ChatMessage,
  type FailedTurnNotice,
  type Thread,
  type ThreadInboxEntry,
  type ThreadInboxEnvironment,
  type ThreadInboxModel,
} from "@ryco/client-runtime/state/threads";
import type {
  ClaudeCacheObservation,
  EnvironmentId,
  MessageId,
  ProjectId,
  ServerProvider,
  ThreadId,
} from "@ryco/contracts";
import type { ChatFileUploadRecord } from "@ryco/client-runtime/state/composer";
import { DEFAULT_AGENT_TOKEN_MODE, type ModelSelection } from "@ryco/contracts/orchestration";
import {
  hasRetiredProjectMemory,
  REMOVED_PROJECT_MEMORY_MESSAGE,
} from "@ryco/shared/retiredFeatures";

import {
  isDraftComposerFileAttachment,
  type DraftComposerAttachment,
} from "../../lib/composerFiles";
import {
  isQueuedThreadMessageHeld,
  summarizeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "../../state/threadOutboxModel";
import type { useHomeEnvironments } from "../home/useHomeEnvironments";
import { claudeCacheSummaryLabel } from "./claudeCacheSummary";
import { listModelPickerEntries, type ModelPickerModel } from "./modelPickerModel";
import { buildSessionPolicyModel } from "./sessionPolicyModel";
import type { ThreadTitlePillGoal, ThreadTitlePillView } from "./threadContextSheetModel";
import type { buildThreadHeaderModel, ThreadHeaderModel } from "./threadHeaderModel";

/**
 * The thread screen's (`ThreadDetailScreen.tsx`) decisions that depend only on what they are
 * given: the screen keeps its state, effects and handlers, and calls these with what it read.
 */

export const NO_REVERT_TARGETS: ReadonlyMap<MessageId, number> = new Map();
export const SERVER_QUEUE_EDIT_IN_PROGRESS = "Save or cancel the message you are editing first.";
/** How long a rename's new title is shown before the node's own title, whatever it says. */
export const RENAME_ECHO_WAIT_MS = 15_000;
/** The clock the anchor's rows are built with: their positions do not depend on it. */
export const ANCHOR_ROWS_CLOCK = new Date(0).toISOString();
/** How long the message a link opened the thread at stays highlighted. */
export const MESSAGE_ANCHOR_HIGHLIGHT_MS = 2_500;

type HomeEnvironmentRow = ReturnType<typeof useHomeEnvironments>[number];

/** An action's failure, as its alert says it (kept out of the component for React Compiler). */
export function actionFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

/**
 * The thread's settlement model, evaluated at the current time but never
 * before `notBeforeMs` (the last scheduled evaluation). The clock is read here
 * rather than in the component: React Compiler would cache a render-time
 * `Date.now()` once per screen instance, so every input change would evaluate
 * settle, snooze and auto-settle against the time the screen opened.
 */
export function buildThreadSettlementModel(
  input: Omit<BuildThreadInboxInput, "nowMs">,
  notBeforeMs: number,
) {
  return buildThreadInbox({ ...input, nowMs: Math.max(notBeforeMs, Date.now()) });
}

/** This thread's machine as the inbox rules read it. */
export function threadSettlementEnvironment(
  environmentId: EnvironmentId,
  environmentRow: Pick<
    HomeEnvironmentRow,
    | "label"
    | "threadSettlementSupported"
    | "autoSettleAfterDays"
    | "connectionState"
    | "mutationReady"
    | "shellCurrent"
  >,
): ThreadInboxEnvironment {
  return {
    environmentId,
    label: environmentRow.label,
    threadSettlementSupported: environmentRow.threadSettlementSupported ?? "unknown",
    autoSettleAfterDays: environmentRow.autoSettleAfterDays,
    connected: environmentRow.connectionState === "connected",
    mutationReady: environmentRow.mutationReady ?? false,
    shellCurrent: environmentRow.shellCurrent ?? false,
  };
}

/** The thread's own inbox entry, whichever shelf it is on. */
export function firstThreadSettlementEntry(
  model: ThreadInboxModel | null,
): ThreadInboxEntry | null {
  return model?.active[0] ?? model?.settled[0] ?? model?.snoozed[0] ?? model?.hidden[0] ?? null;
}

/** What the header's Settle / Move to Active reads from the thread's inbox entry. */
export function threadHeaderSettlement(
  entry: ThreadInboxEntry,
): NonNullable<Parameters<typeof buildThreadHeaderModel>[0]["settlement"]> {
  return {
    attentionState: entry.lifecycle.classification === "settled" ? "settled" : "active",
    // A working task files: the node settles it when the work ends.
    canSettle: entry.lifecycle.eligibility.canSettle || entry.lifecycle.settleFiles === true,
    settlementBlocker: entry.lifecycle.settlementBlocker,
    mutationEnabled: entry.mutationEnabled,
    mutationBlocker: entry.mutationBlocker,
  };
}

/** The session's phase as the provider selection policy reads it. */
export function threadSessionPhase(
  status: string | undefined,
): "running" | "connecting" | "ready" | "disconnected" {
  return status === "running"
    ? "running"
    : status === "connecting"
      ? "connecting"
      : status === "ready"
        ? "ready"
        : "disconnected";
}

/** The access and mode pills' model for the thread on the composer's current selection. */
export function threadSessionPolicyModel(input: {
  readonly thread: Pick<Thread, "runtimeMode" | "interactionMode" | "archivedAt">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedModelSelection: ModelSelection | null;
  readonly threadProviderDriver: ServerProvider["driver"] | null;
}) {
  const { thread, providers, selectedModelSelection, threadProviderDriver } = input;
  return buildSessionPolicyModel({
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    interactionModeSupported: threadProviderDriver
      ? getProviderInteractionModeToggle(providers, threadProviderDriver)
      : true,
    askModeSupported: threadProviderDriver
      ? getProviderSupportsAskMode(providers, threadProviderDriver)
      : false,
    autoModeUnavailableReason: selectedModelSelection
      ? getAutoRuntimeModeUnavailableReason(
          getProviderInstanceModels(providers, selectedModelSelection.instanceId),
          selectedModelSelection.model,
        )
      : null,
    mutationBlockedReason: thread.archivedAt !== null ? "This task is archived." : null,
  });
}

/** The selected model's context limit, as the provider reports what the model holds. */
export function contextWindowModelLimitOf(
  providers: ReadonlyArray<ServerProvider> | undefined,
  selection: ModelSelection | null,
): number | null {
  return (
    providers
      ?.find((provider) => provider.instanceId === selection?.instanceId)
      ?.models.find((model) => model.slug === selection?.model)?.maxContextTokens ?? null
  );
}

/** The model's own context window option, when the selection sets one. */
export function contextWindowOptionOf(selection: ModelSelection | null) {
  return selection?.options?.find((option) => option.id === "contextWindow")?.value;
}

/** "Edit from here": each sent message's revert target (shared with web). */
export function revertTurnCountByUserMessageIdOf(
  messages: Thread["messages"] | undefined,
  turnDiffSummaries: Thread["turnDiffSummaries"] | undefined,
): ReadonlyMap<MessageId, number> {
  if (!messages || !turnDiffSummaries) return NO_REVERT_TARGETS;
  return deriveRevertTurnCountByUserMessageId({
    messages,
    turnDiffSummaryByAssistantMessageId: new Map(
      turnDiffSummaries.flatMap((summary) =>
        summary.assistantMessageId ? [[summary.assistantMessageId, summary] as const] : [],
      ),
    ),
    inferredCheckpointTurnCountByTurnId: inferCheckpointTurnCountByTurnId(turnDiffSummaries),
  });
}

/** "Undo file changes": the checkpoint before each reply's turn, by the reply's message id. */
export function undoTurnCountByReplyIdOf(
  turnDiffSummaries: Thread["turnDiffSummaries"],
): ReadonlyMap<MessageId, number> {
  const byTurnId = deriveUndoTurnCountByTurnId({
    turnDiffSummaries,
    inferredCheckpointTurnCountByTurnId: inferCheckpointTurnCountByTurnId(turnDiffSummaries),
  });
  return new Map(
    turnDiffSummaries.flatMap((summary) => {
      const turnCount = byTurnId.get(summary.turnId);
      return summary.assistantMessageId && turnCount !== undefined
        ? [[summary.assistantMessageId, turnCount] as const]
        : [];
    }),
  );
}

/**
 * Whether a queued message (the outbox's, or the node's entry with the modes it was queued with)
 * can steer the running turn now.
 */
export function threadQueuedMessageSteerEligibility(input: {
  readonly message: Pick<
    QueuedThreadMessage,
    "modelSelection" | "runtimeMode" | "interactionMode" | "tokenMode"
  >;
  readonly thread: Thread | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly mutationReady: boolean;
}) {
  const { message, thread, providers } = input;
  if (hasRetiredProjectMemory(message))
    return { allowed: false as const, reason: REMOVED_PROJECT_MEMORY_MESSAGE };
  const activeSelection = thread?.modelSelection;
  const providerInstanceId = thread?.session?.providerInstanceId ?? activeSelection?.instanceId;
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  return resolveQueuedMessageSteerEligibility({
    mutationReady: input.mutationReady,
    turnRunning: thread?.latestTurn?.state === "running",
    activeTurnId: thread?.session?.activeTurnId,
    supportsTurnSteering: providerSteering(provider) !== null,
    queuedModelSelection: message.modelSelection,
    activeModelSelection: activeSelection,
    queuedRuntimeMode: message.runtimeMode,
    activeRuntimeMode: thread?.runtimeMode,
    queuedInteractionMode: message.interactionMode,
    activeInteractionMode: thread?.interactionMode,
    queuedTokenMode: message.tokenMode,
    activeTokenMode: thread?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
  });
}

/** Why a queued row's Edit is unavailable before the press (the typed text is read at it). */
export function queuedRowEditUnavailableReason(
  row: FollowUpQueueRow,
  input: { readonly serverQueueEditActive: boolean; readonly composerAttachmentCount: number },
): string | null {
  if (row.source === "server" && input.serverQueueEditActive) {
    return SERVER_QUEUE_EDIT_IN_PROGRESS;
  }
  const onItsWay = followUpQueueRowOnItsWayReason(row);
  if (onItsWay !== null) return onItsWay;
  return resolveQueuedMessageEditUnavailableReason({
    deliveryStatus: undefined,
    steering: row.status === "steering",
    // The typed text is only known at press time (`editQueuedMessage`).
    composerHasContent: input.composerAttachmentCount > 0,
  });
}

/** Why an outbox message cannot be taken back into the composer, or null when it can. */
export function queuedMessageEditUnavailableReason(input: {
  /** Its add to the node's queue is on its way: it would come back as a second copy. */
  readonly moving: boolean;
  readonly steering: boolean;
  readonly composerHasContent: boolean;
}): string | null {
  return input.moving
    ? FOLLOW_UP_ON_ITS_WAY_REASON
    : resolveQueuedMessageEditUnavailableReason({
        deliveryStatus: undefined,
        steering: input.steering,
        composerHasContent: input.composerHasContent,
      });
}

/** The bytes the composer's attachments already take (a file to re-attach takes none). */
export function composerAttachmentsTotalBytes(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.type === "file" && attachment.uploadState === "needsReattach") return total;
    return total + attachment.sizeBytes;
  }, 0);
}

/** A model the picker lists and offers: a pick of anything else does nothing. */
export function modelPickerSelectionAvailable(
  modelPicker: ModelPickerModel | null,
  selection: ModelSelection,
): boolean {
  const entry = (modelPicker ? listModelPickerEntries(modelPicker) : []).find(
    (candidate) =>
      candidate.selection.instanceId === selection.instanceId &&
      candidate.selection.model === selection.model,
  );
  return entry !== undefined && !entry.disabled;
}

/** The failed turn's notice, unless it was dismissed for that turn. */
export function visibleFailedTurnNotice(
  notice: FailedTurnNotice | null,
  dismissedTurnId: string | null,
): FailedTurnNotice | null {
  return notice && notice.turnId !== dismissedTurnId ? notice : null;
}

/** The error banner leaves out what the failed-turn notice already says. */
export function threadErrorBannerMessage(
  visibleError: string | null,
  failedNotice: FailedTurnNotice | null,
): string | null {
  return failedNotice !== null && visibleError === failedNotice.detail ? null : visibleError;
}

/** What the floating status capsule over the composer says waits on the reader. */
export function floatingThreadAttention(input: {
  readonly approvals: number;
  readonly agentControlProposals: number;
  readonly userInputs: number;
  readonly secretRequests: number;
}): "approval" | "question" | null {
  return input.approvals > 0 || input.agentControlProposals > 0
    ? "approval"
    : input.userInputs > 0 || input.secretRequests > 0
      ? "question"
      : null;
}

/** The first delegated chat that waits on the reader, for the floating status. */
export function delegatedChildAttention<Id extends string>(
  rows: ReadonlyArray<{
    readonly tone: string;
    readonly childThreadId: Id | null;
    readonly label: string;
  }>,
): { readonly threadId: Id; readonly title: string } | null {
  const row = rows.find(
    (candidate) => candidate.tone === "attention" && candidate.childThreadId !== null,
  );
  return row?.childThreadId != null ? { threadId: row.childThreadId, title: row.label } : null;
}

/** The workspace tools the header menu offers for this thread. */
export function threadWorkspaceTools(input: {
  readonly headerModel: Pick<ThreadHeaderModel, "filesVisible" | "terminalVisible"> | null;
  readonly capabilities:
    | {
        readonly projectContentSearch?: boolean | undefined;
        readonly threadLocalServers?: boolean | undefined;
        readonly worktreeNotes?: boolean | undefined;
      }
    | undefined;
  readonly nodeBrowserAvailable: boolean;
  readonly hasProject: boolean;
  /** A real checkout (a project-less chat has no repository). */
  readonly hasCheckout: boolean;
  readonly deviceAvailability: { readonly kind: string } | null;
}) {
  const { headerModel, capabilities } = input;
  return {
    findInFiles: headerModel?.filesVisible === true && capabilities?.projectContentSearch === true,
    scripts: headerModel?.terminalVisible === true && input.hasProject,
    servers: capabilities?.threadLocalServers === true || input.nodeBrowserAvailable,
    notes: input.hasCheckout && capabilities?.worktreeNotes === true,
    devices:
      input.deviceAvailability !== null && input.deviceAvailability.kind !== "unsupported-platform",
  };
}

/** The thread has started: a turn, a message or a session. */
export function threadHasStarted(
  thread: Pick<Thread, "latestTurn" | "messages" | "session">,
): boolean {
  return thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null;
}

/** This device's outbox messages as rows of the queue the thread shows. */
export function localFollowUpQueueRows(
  messages: ReadonlyArray<QueuedThreadMessage>,
  input: {
    readonly steeringMessageIds: ReadonlySet<string>;
    readonly movingMessageId: string | null;
  },
) {
  return messages.map((message) => ({
    id: message.messageId,
    summary: hasRetiredProjectMemory(message)
      ? REMOVED_PROJECT_MEMORY_MESSAGE
      : summarizeQueuedThreadMessage(message),
    deliveryStatus: isQueuedThreadMessageHeld(message) ? ("failed" as const) : undefined,
    steering: input.steeringMessageIds.has(message.messageId),
    moving: message.messageId === input.movingMessageId,
  }));
}

/** The fork sheet's request for "Fork from here" on a reply of a turn. */
export function threadForkSheetRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly source: Pick<Thread, "title" | "messages"> | undefined;
  readonly message: ChatMessage;
  readonly turnId: NonNullable<ChatMessage["turnId"]>;
}) {
  const { environmentId, threadId, source, message } = input;
  return {
    environmentId,
    sourceThreadId: threadId,
    sourceTitle: source?.title ?? "",
    messageId: message.id,
    turnId: input.turnId,
    // A page-only turn, or a blank reply under a page, quotes what the turn published.
    excerpt: threadForkReplyExcerpt(threadForkBoundaryQuote(source?.messages ?? [], message.id)),
  };
}

/**
 * The composer's attachments with the tokens their uploads got (token metadata, never bytes),
 * or `current` itself when none changed.
 */
export function withUploadedFileTokens(
  current: ReadonlyArray<DraftComposerAttachment>,
  records: ReadonlyMap<string, ChatFileUploadRecord>,
): ReadonlyArray<DraftComposerAttachment> {
  let changed = false;
  const next = current.map((attachment) => {
    if (!isDraftComposerFileAttachment(attachment)) return attachment;
    const status = records.get(attachment.id)?.status;
    if (status?.kind !== "uploaded") return attachment;
    if (
      attachment.uploadToken === status.uploadToken &&
      attachment.expiresAt === status.expiresAt
    ) {
      return attachment;
    }
    changed = true;
    return { ...attachment, uploadToken: status.uploadToken, expiresAt: status.expiresAt };
  });
  return changed ? next : current;
}

/**
 * The plan the settled latest turn proposed and nobody implemented, while the chat can take a
 * turn (`canTakeTurn`): Implement is offered on it (the shared rule web's plan follow-up reads).
 */
export function actionableThreadPlanId(
  thread: Pick<Thread, "latestTurn" | "session" | "proposedPlans"> | undefined,
  canTakeTurn: boolean,
): string | null {
  const latestTurnSettled = thread
    ? isLatestTurnSettled(thread.latestTurn, thread.session ?? null)
    : false;
  const latestPlan =
    thread && latestTurnSettled
      ? findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null)
      : null;
  return latestPlan !== null && hasActionableProposedPlan(latestPlan) && canTakeTurn
    ? latestPlan.id
    : null;
}

/** The Claude cache line: null for other providers, "Unknown" before the first report. */
export function claudeCacheSummary(
  providerDriver: string | null,
  observation: ClaudeCacheObservation | undefined,
): string | null {
  return providerDriver !== "claudeAgent"
    ? null
    : observation
      ? claudeCacheSummaryLabel(observation)
      : "Unknown";
}

/**
 * The node's queued entry this screen edits, while it is this thread's: `active` while the edit
 * goes on, `ended` (with why) once its entry left the queue (sent, or removed elsewhere) or
 * changed meanwhile (an edit elsewhere, a Retry, a steer that came back).
 */
export function serverQueueEditView(input: {
  readonly edit: FollowUpQueueEdit | null;
  readonly threadKey: string;
  readonly queue: Parameters<typeof resolveFollowUpQueueEditState>[0]["queue"];
  readonly detailLoaded: boolean;
  /** The edit whose save is on its way. */
  readonly saving: FollowUpQueueEdit | null;
}) {
  const { edit } = input;
  const shown = edit !== null && edit.threadKey === input.threadKey ? edit : null;
  const state =
    shown === null
      ? null
      : resolveFollowUpQueueEditState({
          queue: input.queue,
          detailLoaded: input.detailLoaded,
          messageId: shown.messageId,
          revision: shown.revision,
          saving: input.saving === shown,
        });
  const endedState = state === "gone" || state === "changed" ? state : null;
  return {
    ended: endedState === null ? null : shown,
    endedState,
    active: state === "editing" ? shown : null,
  };
}

/** The header's title pill, once the header model has every label it shows. */
export function threadTitlePillView(input: {
  readonly title: string | null;
  readonly statusLabel: ThreadTitlePillView["statusLabel"] | null;
  readonly projectLabel: ThreadTitlePillView["projectLabel"] | null;
  readonly worktreeLabel: ThreadTitlePillView["worktreeLabel"] | null;
  readonly branchLabel: ThreadTitlePillView["branchLabel"];
  readonly goal: ThreadTitlePillGoal | null;
  readonly environmentId: EnvironmentId;
  readonly badgeProjectId: ProjectId | null;
  readonly badgeAvatar: string | null;
  readonly badgeName: string | null;
}): ThreadTitlePillView | null {
  const { title, statusLabel, projectLabel, worktreeLabel, badgeName } = input;
  return title === null ||
    statusLabel === null ||
    projectLabel === null ||
    worktreeLabel === null ||
    badgeName === null
    ? null
    : {
        title,
        statusLabel,
        projectLabel,
        worktreeLabel,
        branchLabel: input.branchLabel,
        goal: input.goal,
        badge: {
          environmentId: input.environmentId,
          projectId: input.badgeProjectId,
          customAvatarContentHash: input.badgeAvatar,
          name: badgeName,
        },
      };
}
