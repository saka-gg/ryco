import { sidebarUndo } from "../../state/sidebarUndo";
import { ClaudeCacheSheet } from "./ClaudeCacheSheet";
import { claudeCacheSummaryLabel } from "./claudeCacheSummary";
import { latestClaudeCacheObservation } from "@ryco/shared/claudeCacheReview";
import { mobileClaudeCacheReview } from "./claudeCacheReview";
import { mobileConfirmStopBackgroundWork } from "./stopBackgroundWork";
import { prewarmThreadProviderSession } from "./threadSessionPrewarm";
import { liveThreadModelSelectionSupported } from "./liveThreadModelSelection";
import { useLiveThreadModelSelection } from "./useLiveThreadModelSelection";
import {
  readServerFollowUpQueueWaiting,
  readThreadOutboxEnvironment,
  runOutboxDrain,
} from "../../state/use-thread-outbox-drain";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { captureReviewedSendReadiness } from "@ryco/client-runtime/state/composer";
import {
  hasRetiredProjectMemory,
  REMOVED_PROJECT_MEMORY_MESSAGE,
} from "@ryco/shared/retiredFeatures";
import { useStore as useZustandStore } from "zustand";
import { useAtomValue } from "@effect/atom-react";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import type { HostedDeliveryNotice } from "@ryco/client-runtime/authorization";
import { serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  createSideChatStore,
  parseSideQuestionCommand,
} from "@ryco/client-runtime/state/side-chat";
import {
  APPROVAL_REDIRECT_PLACEHOLDER,
  approvalRedirectTooSoon,
  declineApprovalsForRedirect,
  appendReturnedComposerPrompt,
  checkpointRevertUnsupportedMessage,
  deriveProviderSelectionPolicy,
  describeApprovalRedirectRefusal,
  getAutoRuntimeModeUnavailableReason,
  getProviderInstanceModels,
  getProviderInteractionModeToggle,
  getProviderSupportsAskMode,
  normalizeInteractionModeForProviderTarget,
  noteApprovalRedirectEnd,
  parseThreadGoalSlashCommand,
  pendingApprovalSourceFromStore,
  recordApprovalSightings,
  resolveApprovalRedirect,
  selectionAllowedAtSendBoundary,
  type ApprovalRedirectedTurns,
  type ApprovalRedirectRefusal,
  type ApprovalSightings,
  type ThreadGoalSlashCommand,
} from "@ryco/client-runtime/state/composer";
import { scopeProjectRef, scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  deriveClaudeFastModeNotice,
  deriveRevertTurnCountByUserMessageId,
  inferCheckpointTurnCountByTurnId,
  readCheckpointRevertPhase,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  revertKeptChangesDiscardedBy,
  selectConversationRevertSupported,
  selectFilesRevertSupported,
  subscribeCheckpointReverts,
  type PendingApproval,
  type PendingUserInput,
  type TimelineEntry,
} from "@ryco/client-runtime/state/session";
import {
  buildFollowUpQueueEditCommand,
  buildFollowUpQueueMoveCommand,
  buildFollowUpQueuePauseCommand,
  buildFollowUpQueueRemoveCommand,
  buildFollowUpQueueResumeCommand,
  buildFollowUpQueueRetryCommand,
  buildFollowUpQueueSteerCommand,
  buildQueuedMessageSteerCommand,
  collectQueuedMessageSteerOutcomes,
  deriveFollowUpQueueView,
  describeEndedFollowUpQueueEdit,
  FOLLOW_UP_ON_ITS_WAY_REASON,
  followUpQueueRowOnItsWayReason,
  getQueuedThreadKeys,
  indexTurnSteerRejections,
  resolveQueuedMessageEditUnavailableReason,
  resolveFollowUpQueueEditState,
  resolveQueuedMessageSteerEligibility,
  providerSteering,
  selectServerFollowUpQueueSupported,
  selectThreadFollowUpQueue,
  shouldQueueFollowUpOnServer,
  followUpQueueEditAttachments,
  followUpQueueEditOf,
  withoutFollowUpQueueEditAttachment,
  type FollowUpQueueCommand,
  type FollowUpQueueEdit,
  type FollowUpQueueRow,
  type PendingFollowUpAdd,
  type QueuedMessageSteerAttempt,
} from "@ryco/client-runtime/state/message-queue";
import {
  buildThreadInbox,
  type BuildThreadInboxInput,
  createThreadForkAttemptController,
  defaultThreadForkBaseRef,
  deriveForkableReplyMessageIds,
  deriveUndoTurnCountByTurnId,
  isArchivedThreadStub,
  readThreadForkApi,
  resolveThreadWorkspacePullRequestLink,
  CONTINUE_AFTER_FAILURE_PROMPT,
  failedTurnNotice,
  restartInterruptionNotice,
  threadForkBoundaryQuote,
  threadForkReplyExcerpt,
  type ChatMessage,
  type ProposedPlan,
} from "@ryco/client-runtime/state/threads";
import { isChatProject } from "@ryco/shared/projectKind";
import { listThreadLifecycleActions } from "@ryco/client-runtime/state/lifecycle";
import { goBackOrHome } from "../../navigation/goBackOrHome";
import { ThreadUsageLimitBanner } from "./ThreadUsageLimitBanner";
import { threadSnoozeWokeAt } from "@ryco/shared/threadSnooze";
import type { CommandId, ThreadForkResult } from "@ryco/contracts";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts/base-schemas";
import type { EnvironmentApi, ThreadGoal } from "@ryco/contracts";
import { DEFAULT_AGENT_TOKEN_MODE, type ModelSelection } from "@ryco/contracts/orchestration";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  composeOutgoingPrompt,
  deriveChatFileUploadSendBlock,
} from "@ryco/client-runtime/state/composer";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView } from "../../components/AppSymbol";
import { ensureEnvironmentApi, readRpcClient } from "../../connection/environmentApi";
import { getMobileHostedConnectionCoordinator } from "../../connection/hostedConnectionCoordinator";
import { useMobileHostedConnectionsStore } from "../../hostedHub/state";
import {
  loadOlderThreadMessages,
  loadThreadMessagesAround,
  retainThreadDetailSubscription,
} from "../../connection/threadDetail";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { useThreadConnectionRetarget } from "../../connection/useThreadConnectionRetarget";
import type {
  ComposerAttachmentSource,
  DraftComposerAttachment,
  DraftComposerFileAttachment,
} from "../../lib/composerFiles";
import {
  isDraftComposerFileAttachment,
  pickComposerAttachmentsFrom,
  readComposerFileBytes,
} from "../../lib/composerFiles";
import { convertPastedImagesToAttachments } from "../../lib/composerImages";
import { newCommandId, newMessageId, newThreadId } from "../../lib/ids";
import { runWhileBusy } from "../../lib/runWhileBusy";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  selectAgentControlProposalsForThread,
  useAgentControlStore,
} from "../../state/agentControlRuntime";
import { useAgentControlSync } from "../../state/agentControlSync";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useMessageQueueStore } from "../../state/messageQueueStore";
import {
  isClaudeResumeReviewEnabled,
  isStreamHapticsEnabled,
  usePreferences,
} from "../../state/preferencesStore";
import { useThreadStreamHaptics } from "./threadStreamHaptics";
import { FloatingThreadControl } from "./FloatingThreadControl";
import { ImageGalleryProvider } from "./ImageGalleryModal";
import {
  FLOATING_CONTROL_CLEARANCE,
  isFollowingLatest,
  showsFloatingThreadCapsule,
} from "./floatingThreadControlModel";
import {
  resolveThreadFeedLiveFollow,
  type ThreadFeedLiveFollowEvent,
} from "./threadFeedLiveFollow";
import { markSnoozeWokeSeen } from "../../state/snoozeWokeSeen";
import {
  useWsConnectionStatusForEnvironment,
  wsUiStateForEnvironment,
} from "../../rpc/wsConnectionState";
import {
  clearThreadOutboxSteering,
  endThreadOutboxSteer,
  enqueueThreadOutboxMessage,
  getThreadOutboxHold,
  getThreadOutboxMovingMessageId,
  holdThreadOutboxForInterrupt,
  isThreadOutboxDispatchPending,
  listThreadOutboxMessages,
  markThreadOutboxSteering,
  releaseThreadOutboxHold,
  removeThreadOutboxMessage,
  retryThreadOutboxMessage,
  retryThreadOutboxReview,
  subscribeThreadOutbox,
} from "../../state/threadOutbox";
import {
  buildQueuedThreadMessageFollowUpContent,
  dispatchFollowUpQueueCommand,
  queueThreadMessageOnServer,
  readServerFollowUpQueueSupported,
  useFollowUpQueuePendingStore,
} from "../../state/followUpQueue";
import { buildQueuedThreadMessageAttachments } from "../../state/queuedThreadMessageAttachments";
import type { QueuedThreadMessage } from "../../state/threadOutboxModel";
import {
  isQueuedThreadMessageHeld,
  modelSelectionsEqual,
  summarizeQueuedThreadMessage,
} from "../../state/threadOutboxModel";
import { useThreadTimeline } from "../../state/threadTimeline";
import {
  selectEnvironmentHydratedFromCacheAt,
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectSubscribedClaudeReviewState,
  selectThreadByRef,
  selectThreadDetailLoaded,
  selectThreadExistsByRef,
  selectThreadLiveDetailLoaded,
  selectWorkingDelegatedDescendants,
  useStore,
} from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useRepositoryStatus } from "../newTask/useNewTaskRepository";
import { NewTaskLaunchCard } from "../newTask/NewTaskLaunchCard";
import { useWorktreeLaunchStore } from "@ryco/client-runtime/state/worktree-setup";
import {
  deriveNewTaskLaunchView,
  discardNewTaskLaunch,
  newTaskLaunchKey,
  requeueNewTaskLaunch,
  setNewTaskLaunchEditing,
  retryNewTaskLaunch,
  useNewTaskLaunchStore,
} from "../newTask/newTaskLaunch";
import { createNewTaskLaunchDeps } from "../newTask/newTaskLaunchRuntime";
import { AgentControlProposalCard } from "./AgentControlProposalCard";
import {
  runEditFromHere,
  subscribeReturnedSentMessages,
  takeReturnedSentMessages,
} from "./editFromHere";
import { executeSendTurn } from "./executeSendTurn";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { useNotificationThreadAction } from "../../notifications/useNotificationThreadAction";
import { PendingUserInputCard } from "./PendingUserInputCard";
import {
  resolveOptionalAnswerRoute,
  sendOptionalAnswerAsMessage,
} from "@ryco/client-runtime/state/user-input";
import { SecretRequestCard } from "./SecretRequestCard";
import { mobileSecretRequestCards } from "./secretRequestCardModel";
import { sendThreadTurn } from "./sendThreadTurn";
import { runUndoFileChanges } from "./undoFileChanges";
import {
  clearThreadGoal,
  compactThreadNow,
  stopThreadSession,
  trashThread,
  interruptThreadTurn,
  renameThread,
  setThreadGoal,
  setThreadArchived,
  setThreadSettled,
  setThreadInteractionMode,
  setThreadRuntimeMode,
} from "./sessionActions";
import { answerThreadApproval, answerThreadUserInput } from "./threadRequestAnswers";
import { useThreadChecks } from "./useThreadChecks";
import { buildThreadTimelineRows, toggleFold, type TurnHtmlRender } from "./threadActivityFold";
import { HtmlRenderFullScreenProvider } from "./HtmlRenderFullScreen";
import { ThreadActivityFoldRow } from "./ThreadActivityFoldRow";
import { UserInputExchangeRow } from "./UserInputExchangeRow";
import {
  composerFileUploadEngine,
  useComposerFileUploadMaxBytes,
  useComposerFileUploadRecords,
} from "../../state/composerFileUpload";
import { buildModelPickerModel, listModelPickerEntries } from "./modelPickerModel";
import { buildSessionPolicyModel, resolveSessionPolicySelection } from "./sessionPolicyModel";
import { useThreadAgents } from "./ThreadAgentsSheet";
import { ThreadContextSheet } from "./ThreadContextSheet";
import { buildThreadParentLink, threadTitlePillGoal } from "./threadContextSheetModel";
import type { ThreadGoalActions } from "./ThreadGoalSection";
import {
  buildThreadHeaderMenu,
  flattenThreadHeaderMenu,
  resolveThreadRename,
  type ThreadHeaderMenuAction,
  type ThreadHeaderMenuActionId,
  type ThreadHeaderMenuSection,
} from "./threadHeaderMenuModel";
import { ThreadRenameSheet } from "./ThreadRenameSheet";
import { useTerminalHeaderActivity } from "../terminal/useTerminalHeaderActivity";
import { ThreadTitlePill } from "./ThreadTitlePill";
import { usePullRequestWatchControl } from "./usePullRequestWatchControl";
import { useThreadDevice } from "../devices/useThreadDevice";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { selectCompletionReturnsByChildThreadId } from "@ryco/client-runtime/state/agentControl";
import {
  isDelegatedThreadLineage,
  planThreadGoalCommand,
  type ThreadGoalCommandPlan,
} from "@ryco/client-runtime/state/threads";
import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { openTaskCapture } from "../tasks/taskCaptureStore";
import { useThreadWorkspaceRoot } from "../files/useThreadWorkspaceRoot";
import { ThreadComposer } from "./ThreadComposer";
import { SideChatCard } from "./SideChatCard";
import { deriveThreadCachedView } from "./threadCachedViewModel";
import {
  acknowledgeThreadDelivery,
  buildThreadDeliveryNotice,
  selectThreadDeliveryRecord,
} from "./threadDeliveryNoticeModel";
import { ThreadQueuedMessages } from "./ThreadQueuedMessages";
import { clearCancelledServerQueueEdit } from "./serverQueueEdit";
import type { ThreadComposerHandle } from "./ThreadComposer";
import { ThreadDevicePill } from "../devices/ThreadDevicePill";
import { buildThreadHeaderModel, findThreadWorktree } from "./threadHeaderModel";
import { ThreadMessage } from "./ThreadMessage";
import { ProposedPlanCard, type ProposedPlanCardActions } from "./ProposedPlanCard";
import {
  implementPlanHere,
  implementPlanInNewThread,
  planMarkdownExport,
  resolvePlanSavePath,
} from "./proposedPlanActions";
import { ContextHandoffMarkerRow } from "./ContextHandoffMarkerRow";
import { derivePendingComposerHandoff } from "./contextHandoffModel";
import { ForkDestinationSheet } from "./ForkDestinationSheet";
import { mobileForkSheetPorts } from "./forkActions";
import {
  buildForkSheetSource,
  initialForkSheetSelection,
  isThreadForkOffered,
} from "./forkDestinationModel";
import { ForkOriginRow } from "./ForkOriginRow";
import { useForkSheetState } from "./useForkSheetState";
import {
  createThreadListRowAnnotator,
  nextThreadMessageAnchorStep,
  resolveOpenThreadNavigation,
  type ThreadListRow,
} from "./threadTimelineList";

const NO_FORKABLE_MESSAGES: ReadonlySet<MessageId> = new Set();
const NO_PENDING_APPROVALS: PendingApproval[] = [];
const NO_REVERT_TARGETS: ReadonlyMap<MessageId, number> = new Map();
const NO_PENDING_FOLLOW_UPS: ReadonlyArray<PendingFollowUpAdd> = [];
const SERVER_QUEUE_EDIT_IN_PROGRESS = "Save or cancel the message you are editing first.";
/** How long the message a link opened the thread at stays highlighted. */
const MESSAGE_ANCHOR_HIGHLIGHT_MS = 2_500;

/**
 * The thread's settlement model, evaluated at the current time but never
 * before `notBeforeMs` (the last scheduled evaluation). The clock is read here
 * rather than in the component: React Compiler would cache a render-time
 * `Date.now()` once per screen instance, so every input change would evaluate
 * settle, snooze and auto-settle against the time the screen opened.
 */
/** An action's failure, as its alert says it (kept out of the component for React Compiler). */
/** Runs one plan implementation; a tap while one is on its way does nothing. */
async function guardPlanImplementation(
  inFlight: { current: boolean },
  run: () => Promise<void>,
): Promise<void> {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
    await run();
  } finally {
    inFlight.current = false;
  }
}

/** Resolves once the node's new thread reached this device (a few seconds at most). */
async function waitForThreadInStore(environmentId: EnvironmentId, threadId: ThreadId) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (selectThreadExistsByRef(useStore.getState(), scopeThreadRef(environmentId, threadId))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Sends what a `/goal` message asked for (a plan that changes something). */
async function sendGoalPlan(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  plan: Extract<ThreadGoalCommandPlan, { kind: "set" | "clear" }>,
): Promise<void> {
  const api = ensureEnvironmentApi(environmentId);
  if (plan.kind === "clear") await clearThreadGoal(api, threadId);
  else await setThreadGoal(api, threadId, plan.update, { startTurn: plan.startTurn });
}

function actionFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function buildThreadSettlementModel(
  input: Omit<BuildThreadInboxInput, "nowMs">,
  notBeforeMs: number,
) {
  return buildThreadInbox({ ...input, nowMs: Math.max(notBeforeMs, Date.now()) });
}

function TimelineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly entry: TimelineEntry;
  readonly turnHtmlRenders?: ReadonlyArray<TurnHtmlRender> | undefined;
  /** Present only on a reply that can be forked right now. */
  readonly onForkFromMessage?: ((message: ChatMessage) => void) | undefined;
  /** Present only on a sent message the thread can be rewound to before right now. */
  readonly onEditFromMessage?: ((message: ChatMessage) => void) | undefined;
  /** Present only on a reply whose turn's file changes can be undone right now. */
  readonly onUndoFileChangesOfReply?: ((reply: ChatMessage) => void) | undefined;
  /** The blank reply a page row stands in for; its fork starts from that reply. */
  readonly forkReply?: ChatMessage | undefined;
  readonly onOpenThread: (threadId: ThreadId, messageId: MessageId | null) => void;
  /** The message a link opened this thread at. */
  readonly highlighted?: boolean | undefined;
  /** This row's plan can be implemented now. */
  readonly planActionable?: boolean | undefined;
  readonly planActions?: ProposedPlanCardActions | undefined;
}) {
  const { entry, onForkFromMessage, onEditFromMessage, onUndoFileChangesOfReply, forkReply } =
    props;
  if (entry.kind === "message") {
    const message = (
      <ThreadMessage
        environmentId={props.environmentId}
        threadId={props.threadId}
        message={entry.message}
        turnHtmlRenders={props.turnHtmlRenders}
        onForkFromHere={
          onForkFromMessage ? () => onForkFromMessage(forkReply ?? entry.message) : undefined
        }
        onEditFromHere={onEditFromMessage ? () => onEditFromMessage(entry.message) : undefined}
        onUndoFileChanges={
          onUndoFileChangesOfReply
            ? () => onUndoFileChangesOfReply(forkReply ?? entry.message)
            : undefined
        }
      />
    );
    return props.highlighted ? <View className="bg-primary/10">{message}</View> : message;
  }
  if (entry.kind === "proposed-plan") {
    return (
      <ProposedPlanCard
        plan={entry.proposedPlan}
        actionable={props.planActionable === true}
        actions={props.planActions}
      />
    );
  }
  if (entry.kind === "context-compaction") {
    return (
      <View className="my-3 flex-row items-center gap-2 px-6">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-2xs uppercase tracking-wide text-foreground-muted">
          Context compacted
        </Text>
        <View className="h-px flex-1 bg-border" />
      </View>
    );
  }
  if (entry.kind === "context-handoff") {
    return <ContextHandoffMarkerRow marker={entry.marker} />;
  }
  if (entry.kind === "user-input-exchange") {
    return <UserInputExchangeRow exchange={entry.exchange} />;
  }
  if (entry.kind === "fork-origin") {
    return (
      <ForkOriginRow
        environmentId={props.environmentId}
        marker={entry.marker}
        onOpenSource={props.onOpenThread}
      />
    );
  }
  // Work entries never reach here — buildThreadTimelineRows folds them before
  // the list sees them. This is the remaining unknown-kind fallback.
  return null;
}

/**
 * The cached / degraded strip. Sits with ErrorBanner between the context bar
 * and the timeline, and carries the context bar's `mx-4` so the three read as
 * one column. Copy and tone are decided in threadCachedViewModel.ts. The quiet
 * restart interruption line uses it too.
 */
function ThreadCachedBanner(props: {
  readonly text: string;
  readonly tone: "info" | "warning";
  readonly testID?: string;
}) {
  const warning = props.tone === "warning";
  return (
    <View
      accessibilityRole="alert"
      testID={props.testID ?? "thread-cached-banner"}
      className={`mx-4 rounded-2xl px-3.5 py-3 ${warning ? "bg-warning-bg" : "bg-card"}`}
    >
      <Text
        className={`font-ryco-medium text-sm ${warning ? "text-warning" : "text-foreground-muted"}`}
      >
        {props.text}
      </Text>
    </View>
  );
}

/**
 * An action sent to this machine may not have arrived before its connection
 * dropped. Sits with the cached strip so it is seen where a retry would start;
 * copy and readiness come from threadDeliveryNoticeModel.ts.
 */
function ThreadDeliveryBanner(props: {
  readonly notice: HostedDeliveryNotice;
  readonly onContinue: () => void;
}) {
  const { notice } = props;
  return (
    <View
      accessibilityRole="alert"
      testID="thread-delivery-banner"
      className="mx-4 rounded-2xl bg-warning-bg px-3.5 py-3"
    >
      <Text className="font-ryco-bold text-sm text-warning">{notice.title}</Text>
      <Text className="mt-1 font-ryco-medium text-sm text-warning">{notice.description}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !notice.canAcknowledge }}
        disabled={!notice.canAcknowledge}
        onPress={props.onContinue}
        className={`mt-2 self-start rounded-full px-3 py-1.5 ${
          notice.canAcknowledge ? "bg-subtle-strong active:opacity-70" : "bg-subtle opacity-60"
        }`}
      >
        <Text className="font-ryco-bold text-sm text-foreground">{notice.actionLabel}</Text>
      </Pressable>
    </View>
  );
}

export function ThreadDetailScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Open scrolled to this message (and highlight it briefly), loading history around it. */
  readonly targetMessageId?: MessageId | null;
}) {
  const { environmentId, threadId } = props;
  const targetMessageId = props.targetMessageId ?? null;
  const [sideChatStore] = useState(createSideChatStore);
  const [dismissedFailedTurnId, setDismissedFailedTurnId] = useState<string | null>(null);
  const sideChatKey = JSON.stringify([environmentId, threadId]);
  const sideChat = useZustandStore(sideChatStore, (state) => state.chatsByThreadKey[sideChatKey]);
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const iconColor = String(useThemeColor("--color-icon"));
  // A 6-digit hex (global.css), so the fade under the header can append its alpha.
  const screenColor = String(useThemeColor("--color-screen"));
  const preferences = usePreferences();
  const [settlementNowMs, setSettlementNowMs] = useState(() => Date.now());
  const [sendError, setSendError] = useState<string | null>(null);
  const composerRef = useRef<ThreadComposerHandle>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [stagedModelSelection, setStagedModelSelection] = useState<ModelSelection | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerAttachment>>([]);
  // The attachments as they are now, for a redirect that waited on its declines.
  const attachmentsRef = useRef(attachments);
  useLayoutEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  const ownedUploadIds = useRef(new Set<string>());
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Live steer attempts by message id. Each is keyed by its request's commandId, so only that
  // request's own outcome ends it.
  const [steerAttempts, setSteerAttempts] = useState<
    ReadonlyMap<string, QueuedMessageSteerAttempt>
  >(() => new Map());
  const steeringMessageIds = useMemo(() => new Set(steerAttempts.keys()), [steerAttempts]);
  const steerAttemptsRef = useRef(steerAttempts);
  useEffect(() => {
    steerAttemptsRef.current = steerAttempts;
  }, [steerAttempts]);
  useEffect(
    () => () => {
      for (const [messageId, attempt] of steerAttemptsRef.current) {
        clearThreadOutboxSteering(messageId, attempt.commandId);
      }
    },
    [],
  );
  const [expandedFoldIds, setExpandedFoldIds] = useState<ReadonlySet<string>>(() => new Set());
  const serverConfig = useAtomValue(serverConfigAtom);
  // This screen renders one environment's content; its connection banner and
  // gating must track THAT node's socket, not whichever socket wrote the
  // global status last.
  const connectionUiState = wsUiStateForEnvironment(
    useWsConnectionStatusForEnvironment(environmentId),
  );

  // Retain the supervisor's thread-detail subscription while mounted, and make
  // this node authoritative for the active task.
  useEffect(() => {
    useStore.getState().setActiveEnvironmentId(environmentId);
    // The open view: provider history recovery follows it, never a prewarm.
    return retainThreadDetailSubscription(environmentId, threadId, { view: true });
  }, [environmentId, threadId]);

  // Wave 3a: opening a thread is the ONLY thing in the app that re-targets the
  // hosted connection. Not scroll, not inbox rendering, not prefetch — so this
  // call must stay the single caller of the hook. It returns the engine's
  // stated reason when the node cannot become the selection.
  const degradedReason = useThreadConnectionRetarget(environmentId);
  // Cache provenance for this environment. Deliberately NOT `connectionUiState`:
  // a demoted environment's socket slot is reset on dispose and then reads
  // "connecting" forever, which would render cached content as merely slow.
  const hydratedFromCacheAt = useStore((state) =>
    selectEnvironmentHydratedFromCacheAt(state, environmentId),
  );

  const built = useThreadTimeline(environmentId, threadId);
  useThreadStreamHaptics(
    `${environmentId}:${threadId}`,
    built?.timeline,
    isStreamHapticsEnabled(preferences),
  );
  // A task sent from New Task opens here before the node shows it: the launch
  // carries it (setup stages, failure, Retry, Edit task) until the thread has
  // messages of its own.
  const launchKey = newTaskLaunchKey(environmentId, threadId);
  const newTaskLaunch = useNewTaskLaunchStore((state) => state.launchesByKey[launchKey]);
  const worktreeLaunch = useWorktreeLaunchStore((state) => state.launchesByKey[launchKey]);
  const threadHasMessages = (built?.timeline.length ?? 0) > 0;
  // Capability-routed file attachments: capability + direct HTTP base enable the
  // streaming upload path; without either, only the legacy image dataUrl flow.
  const fileUploadMaxBytes = useComposerFileUploadMaxBytes(environmentId);
  const fileUploadRecords = useComposerFileUploadRecords();
  const sendBlock = useMemo(
    () =>
      deriveChatFileUploadSendBlock({
        attachmentIds: attachments.map((attachment) => attachment.id),
        getRecord: (attachmentId) => fileUploadRecords.get(attachmentId) ?? null,
        nowMs: Date.now(),
      }).blockReason,
    // Records drive the re-render while uploads progress; attachments drive it
    // when rows appear or leave.
    [attachments, fileUploadRecords],
  );
  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const sidebarThread = useStore((state) =>
    selectSidebarThreadSummaryByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const threadDetailLoaded = useStore((state) =>
    selectThreadDetailLoaded(state, scopeThreadRef(environmentId, threadId)),
  );
  // Live detail only: a read-cache hydration at launch does not count, so a notification action
  // never reads approvals or questions the node has not confirmed yet.
  const threadLiveDetailLoaded = useStore((state) =>
    selectThreadLiveDetailLoaded(state, scopeThreadRef(environmentId, threadId)),
  );
  const queuesByThreadKey = useMessageQueueStore((state) => state.queuesByThreadKey);
  const outboxMessages = useSyncExternalStore(
    subscribeThreadOutbox,
    listThreadOutboxMessages,
    listThreadOutboxMessages,
  );
  const queuedMessages = useMemo(
    () =>
      outboxMessages.filter(
        (message) => message.environmentId === environmentId && message.threadId === threadId,
      ),
    [environmentId, outboxMessages, threadId],
  );
  const outboxThreadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  // "Edit from here" of this thread, from the question until the node's verdict. Kept per
  // thread outside this screen, so leaving and coming back neither forgets nor ends it.
  const revertPhase = useSyncExternalStore(
    subscribeCheckpointReverts,
    () => readCheckpointRevertPhase(outboxThreadKey),
    () => readCheckpointRevertPhase(outboxThreadKey),
  );
  const revertBusy = revertPhase === "reverting";
  const queueHold = useSyncExternalStore(
    subscribeThreadOutbox,
    () => getThreadOutboxHold(outboxThreadKey),
    () => getThreadOutboxHold(outboxThreadKey),
  );
  // The outbox message whose add to the node's queue is on its way: no Edit or Steer until it
  // landed.
  const movingOutboxMessageId = useSyncExternalStore(
    subscribeThreadOutbox,
    () => getThreadOutboxMovingMessageId(outboxThreadKey),
    () => getThreadOutboxMovingMessageId(outboxThreadKey),
  );
  // A node that keeps follow-up queues itself (`capabilities.serverFollowUpQueue`): a send while
  // the thread is busy is queued there, and the queue shown is the node's, with adds on their
  // way and then this device's outbox (messages still moving there, or ones it cannot carry).
  const serverFollowUpQueue = useStore((state) =>
    selectThreadFollowUpQueue(state, scopeThreadRef(environmentId, threadId)),
  );
  const pendingFollowUps = useFollowUpQueuePendingStore(
    (state) => state.pendingByThreadKey[outboxThreadKey] ?? NO_PENDING_FOLLOW_UPS,
  );
  const localQueuedMessages = useMemo(
    () => new Map(queuedMessages.map((message) => [String(message.messageId), message])),
    [queuedMessages],
  );
  const queueView = useMemo(
    () =>
      deriveFollowUpQueueView({
        server: serverFollowUpQueue,
        pending: pendingFollowUps,
        local: queuedMessages.map((message) => ({
          id: message.messageId,
          summary: hasRetiredProjectMemory(message)
            ? REMOVED_PROJECT_MEMORY_MESSAGE
            : summarizeQueuedThreadMessage(message),
          deliveryStatus: isQueuedThreadMessageHeld(message) ? ("failed" as const) : undefined,
          steering: steeringMessageIds.has(message.messageId),
          moving: message.messageId === movingOutboxMessageId,
        })),
        localHold: queueHold,
      }),
    [
      movingOutboxMessageId,
      pendingFollowUps,
      queueHold,
      queuedMessages,
      serverFollowUpQueue,
      steeringMessageIds,
    ],
  );
  const [serverQueueEdit, setServerQueueEdit] = useState<FollowUpQueueEdit | null>(null);
  const [savingServerQueueEdit, setSavingServerQueueEdit] = useState<FollowUpQueueEdit | null>(
    null,
  );
  const shownServerQueueEdit =
    serverQueueEdit !== null && serverQueueEdit.threadKey === outboxThreadKey
      ? serverQueueEdit
      : null;
  // An edit whose entry left the queue (sent, or removed elsewhere), or changed meanwhile (an
  // edit elsewhere, a Retry, a steer that came back), is over: the composer keeps the text,
  // which a send then sends as a new message.
  const serverQueueEditState =
    shownServerQueueEdit === null
      ? null
      : resolveFollowUpQueueEditState({
          queue: serverFollowUpQueue,
          detailLoaded: threadDetailLoaded,
          messageId: shownServerQueueEdit.messageId,
          revision: shownServerQueueEdit.revision,
          saving: savingServerQueueEdit === shownServerQueueEdit,
        });
  const endedServerQueueEditState =
    serverQueueEditState === "gone" || serverQueueEditState === "changed"
      ? serverQueueEditState
      : null;
  const endedServerQueueEdit = endedServerQueueEditState === null ? null : shownServerQueueEdit;
  const activeServerQueueEdit = serverQueueEditState === "editing" ? shownServerQueueEdit : null;
  useEffect(() => {
    if (endedServerQueueEdit === null || endedServerQueueEditState === null) return;
    setServerQueueEdit((current) => (current === endedServerQueueEdit ? null : current));
    const notice = describeEndedFollowUpQueueEdit(endedServerQueueEditState);
    setSendError(`${notice.title}. ${notice.description}`);
  }, [endedServerQueueEdit, endedServerQueueEditState]);
  /** Sends one `thread.queue.*` change; the node's refusal shows in the error banner. */
  const runServerQueueCommand = useCallback(
    async (
      build: (base: {
        readonly commandId: CommandId;
        readonly threadId: ThreadId;
        readonly createdAt: string;
      }) => FollowUpQueueCommand | null,
    ): Promise<boolean> => {
      if (!readThreadOutboxEnvironment(environmentId).mutationReady) {
        setSendError("Reconnect to change queued messages.");
        return false;
      }
      const command = build({
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      });
      if (command === null) return false;
      setSendError(null);
      return dispatchFollowUpQueueCommand(environmentId, command).then(
        () => true,
        (error: unknown) => {
          setSendError(
            error instanceof Error ? error.message : "The node did not take the change.",
          );
          return false;
        },
      );
    },
    [environmentId, threadId],
  );
  const messageHistory = useStore(
    (state) =>
      state.environmentStateById[environmentId]?.threadHistoryByThreadId?.[threadId]?.messages,
  );
  const messageHistoryLoad = useStore(
    (state) =>
      state.environmentStateById[environmentId]?.threadHistoryLoadByThreadId?.[threadId]?.messages,
  );
  const loadOlderMessages = useCallback(() => {
    if (!messageHistory?.hasMoreBefore || messageHistoryLoad?.status === "loading") return;
    try {
      void loadOlderThreadMessages({
        environmentId,
        threadId,
        page: messageHistory,
      }).catch(() => undefined);
    } catch {
      // Demotion preserves `threadHistoryByThreadId`, so a cached thread still
      // advertises `hasMoreBefore` and the list happily calls this on scroll —
      // but with no client the pagination request throws SYNCHRONOUSLY, before
      // any promise exists for the `.catch` above to intercept. Scrolling a
      // cached thread to the top would crash the screen. There is nothing to
      // report: the banner already says the content is cached.
    }
  }, [environmentId, messageHistory, messageHistoryLoad?.status, threadId]);
  const project = useStore((state) =>
    thread
      ? (selectProjectByRef(state, scopeProjectRef(environmentId, thread.projectId)) ?? null)
      : null,
  );
  const { worktrees } = useHomeWorkspaceData();
  const environments = useHomeEnvironments();
  const pendingApprovals = built?.viewModel.pendingApprovals ?? NO_PENDING_APPROVALS;
  const pendingUserInputs = built?.viewModel.pendingUserInputs ?? [];
  const optionalUserInputs = built?.viewModel.optionalUserInputs ?? [];
  // When each pending approval was first on screen: a send declines only approvals shown long
  // enough to have been read.
  const approvalSightingsRef = useRef<ApprovalSightings>(new Map());
  useLayoutEffect(() => {
    approvalSightingsRef.current = recordApprovalSightings(
      approvalSightingsRef.current,
      pendingApprovals,
      Date.now(),
    );
  }, [pendingApprovals]);
  // Redirects that declined approvals but sent nothing: the next send on that turn steers.
  const [approvalRedirectedTurns, setApprovalRedirectedTurns] = useState<ApprovalRedirectedTurns>(
    () => new Map(),
  );
  const approvalRedirectedTurnId = approvalRedirectedTurns.get(threadId) ?? null;
  // Agent Control proposals share the web runtime state; mobile only syncs
  // while the server-side setting is enabled and renders the same queue.
  const agentControlEnabled = serverConfig?.settings.agentControl.enabled ?? false;
  useAgentControlSync(environmentId, agentControlEnabled);
  const agentControlQueue = useAgentControlStore(
    (state) => state.queueByEnvironmentId[environmentId] ?? null,
  );
  const agentControlProposals = useMemo(
    () =>
      agentControlEnabled && agentControlQueue !== null
        ? selectAgentControlProposalsForThread(agentControlQueue, threadId)
        : [],
    [agentControlEnabled, agentControlQueue, threadId],
  );
  // Proposals waiting on the reader sit with the other prompts over the composer; settled
  // receipts live in the context sheet, out of the conversation's way.
  const pendingAgentControlProposals = useMemo(
    () => agentControlProposals.filter((proposal) => proposal.status === "pending-user-approval"),
    [agentControlProposals],
  );
  const settledAgentControlProposals = useMemo(
    () => agentControlProposals.filter((proposal) => proposal.status !== "pending-user-approval"),
    [agentControlProposals],
  );
  const worktree = useMemo(
    () => (thread ? findThreadWorktree(thread, worktrees) : null),
    [thread, worktrees],
  );
  const workspaceRoot = useThreadWorkspaceRoot({ thread, worktree, project });
  const environmentRow =
    environments.find((environment) => environment.environmentId === environmentId) ?? null;
  const nodeLabel = environmentRow?.label ?? null;
  const launchView = useMemo(
    () =>
      deriveNewTaskLaunchView({
        launch: newTaskLaunch,
        worktreeLaunch,
        threadHasMessages,
        machineLabel: nodeLabel,
      }),
    [newTaskLaunch, nodeLabel, threadHasMessages, worktreeLaunch],
  );
  const settlementModel = useMemo(() => {
    if (!sidebarThread || !environmentRow) return null;
    return buildThreadSettlementModel(
      {
        projects: project ? [project] : [],
        worktrees,
        threads: [sidebarThread],
        environments: [
          {
            environmentId,
            label: environmentRow.label,
            threadSettlementSupported: environmentRow.threadSettlementSupported ?? "unknown",
            autoSettleAfterDays: environmentRow.autoSettleAfterDays,
            connected: environmentRow.connectionState === "connected",
            mutationReady: environmentRow.mutationReady ?? false,
            shellCurrent: environmentRow.shellCurrent ?? false,
          },
        ],
        localQueuedThreadKeys: getQueuedThreadKeys(queuesByThreadKey),
        autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
      },
      settlementNowMs,
    );
  }, [
    environmentId,
    environmentRow,
    preferences.sidebarAutoSettleAfterDays,
    project,
    queuesByThreadKey,
    settlementNowMs,
    sidebarThread,
    worktrees,
  ]);
  useEffect(() => {
    const nextEvaluationAtMs = settlementModel?.nextSettlementEvaluationAtMs ?? null;
    if (nextEvaluationAtMs === null) return;
    const delayMs = Math.min(2_147_483_647, Math.max(1, nextEvaluationAtMs - Date.now() + 1));
    const timer = setTimeout(() => setSettlementNowMs(Date.now()), delayMs);
    return () => clearTimeout(timer);
  }, [settlementModel?.nextSettlementEvaluationAtMs]);
  // Seeing a thread whose snooze ran out, or runs out while it is open (the
  // settlement clock re-reads at the wake), clears its Inbox "Woke" mark.
  const summarySnoozedUntil =
    sidebarThread && !isArchivedThreadStub(sidebarThread)
      ? (sidebarThread.snoozedUntil ?? null)
      : null;
  const summarySnoozedAt =
    sidebarThread && !isArchivedThreadStub(sidebarThread)
      ? (sidebarThread.snoozedAt ?? null)
      : null;
  useEffect(() => {
    const wokeAt = threadSnoozeWokeAt(
      { snoozedUntil: summarySnoozedUntil, snoozedAt: summarySnoozedAt },
      Math.max(settlementNowMs, Date.now()),
    );
    if (wokeAt !== null) markSnoozeWokeSeen(outboxThreadKey, wokeAt);
  }, [outboxThreadKey, settlementNowMs, summarySnoozedAt, summarySnoozedUntil]);
  const settlementEntry =
    settlementModel?.active[0] ??
    settlementModel?.settled[0] ??
    settlementModel?.snoozed[0] ??
    settlementModel?.hidden[0] ??
    null;
  // The inbox's own rule for whether this chat can be snoozed (the usage-limit banner's Snooze).
  const usageLimitSnoozeEligible = settlementEntry?.canSnooze === true;
  const cachedView = useMemo(
    () =>
      deriveThreadCachedView({
        hydratedFromCacheAt,
        degradedReason,
        // Wave 2's presence-sourced phrase, reused verbatim so the same node is
        // not described two ways on two screens.
        staleDetail: environmentRow?.staleDetail ?? null,
        hasMessages: (built?.timeline.length ?? 0) > 0,
      }),
    [built?.timeline.length, degradedReason, environmentRow?.staleDetail, hydratedFromCacheAt],
  );
  const deliveryRecord = useMobileHostedConnectionsStore((state) =>
    selectThreadDeliveryRecord(state.selectedNodes, environmentId),
  );
  const deliveryNotice = useMemo(() => buildThreadDeliveryNotice(deliveryRecord), [deliveryRecord]);
  // THIS environment's config (the active-environment atom nulls on switch): capabilities such
  // as forking and pull request watches are the node's own.
  const environmentServerConfig = useEnvironmentServerConfigs().get(environmentId) ?? null;
  const pullRequestWatchAvailable = environmentServerConfig?.pullRequestWatch?.available === true;
  const pullRequestWatches =
    sidebarThread && !isArchivedThreadStub(sidebarThread)
      ? sidebarThread.pullRequestWatches
      : undefined;
  const headerModel = useMemo(
    () =>
      thread
        ? buildThreadHeaderModel({
            thread,
            project,
            worktree,
            pullRequestUrl:
              sidebarThread && !isArchivedThreadStub(sidebarThread)
                ? resolveThreadWorkspacePullRequestLink(sidebarThread, worktree ?? null)?.url
                : null,
            nodeLabel,
            hasPendingApproval: pendingApprovals.length > 0,
            hasPendingUserInput: pendingUserInputs.length > 0,
            forcedOffline: cachedView.headerForcedOffline,
            pullRequestWatch: {
              available: pullRequestWatchAvailable,
              watches: pullRequestWatches,
            },
            ...(settlementEntry
              ? {
                  settlement: {
                    attentionState:
                      settlementEntry.lifecycle.classification === "settled" ? "settled" : "active",
                    // A working task files: the node settles it when the work ends.
                    canSettle:
                      settlementEntry.lifecycle.eligibility.canSettle ||
                      settlementEntry.lifecycle.settleFiles === true,
                    settlementBlocker: settlementEntry.lifecycle.settlementBlocker,
                    mutationEnabled: settlementEntry.mutationEnabled,
                    mutationBlocker: settlementEntry.mutationBlocker,
                  },
                }
              : {}),
          })
        : null,
    [
      cachedView.headerForcedOffline,
      nodeLabel,
      pendingApprovals.length,
      pendingUserInputs.length,
      project,
      pullRequestWatchAvailable,
      pullRequestWatches,
      settlementEntry,
      sidebarThread,
      thread,
      worktree,
    ],
  );

  // The capability gates key off the DRIVER, not the instance id, so resolve the
  // thread's provider instance through the server config first. A null/lagging
  // config (it is scoped to the active environment and nulls on switch) must not
  // hide the rail — the gates keep their upstream defaults, which is the same
  // thing web shows before its config arrives.
  // Memoized: `?? []` would allocate a fresh array every render and defeat both
  // memos below, recomputing the policy model on every keystroke in the composer.
  const providers = useMemo(() => serverConfig?.providers ?? [], [serverConfig]);
  const canonicalModelSelection = thread?.modelSelection ?? null;
  const selectedModelSelection = stagedModelSelection ?? canonicalModelSelection;
  // The model, effort and speed follow the selection the node stores, live with its other clients.
  const noteModelSelectionPicked = useLiveThreadModelSelection({
    environmentId,
    threadId,
    enabled: liveThreadModelSelectionSupported(serverConfig),
    serverModelSelection: canonicalModelSelection,
    composerModelSelection: selectedModelSelection,
    updateStaged: setStagedModelSelection,
    reportFailure: setSendError,
  });
  const sideChatReady = !cachedView.actionsDisabled && connectionUiState === "connected";
  useEffect(() => {
    if (!sideChatReady) sideChatStore.getState().disconnect(sideChatKey);
  }, [sideChatReady, sideChatKey, sideChatStore]);
  useEffect(() => () => sideChatStore.getState().clear(sideChatKey), [sideChatKey, sideChatStore]);

  const sendSideQuestion = () => {
    if (!sideChatReady) return;
    const api = readRpcClient(environmentId)?.textGeneration;
    if (!api) return;
    void sideChatStore.getState().ask(sideChatKey, {
      threadId,
      requestId: newMessageId(),
      api,
    });
  };

  const threadStarted = Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
  const canonicalProviderDriver = useMemo(() => {
    if (thread?.session?.provider) return thread.session.provider;
    if (!canonicalModelSelection) return null;
    return (
      providers.find((provider) => provider.instanceId === canonicalModelSelection.instanceId)
        ?.driver ?? null
    );
  }, [canonicalModelSelection, providers, thread?.session?.provider]);
  const sessionPhase =
    thread?.session?.status === "running"
      ? "running"
      : thread?.session?.status === "connecting"
        ? "connecting"
        : thread?.session?.status === "ready"
          ? "ready"
          : "disconnected";
  const providerSelectionPolicy = deriveProviderSelectionPolicy({
    threadStarted,
    canonicalProvider: canonicalProviderDriver,
    phase: sessionPhase,
    orchestrationStatus: thread?.session?.orchestrationStatus ?? null,
    isConnecting: connectionUiState === "connecting",
    isSendBusy: sendBusy,
    isPreparingWorktree: false,
    hasPendingApproval: pendingApprovals.length > 0,
    hasPendingUserInput: pendingUserInputs.length > 0,
    hasQueuedMessage: queueView.rows.length > 0,
    isRevertingCheckpoint: actionBusy || revertBusy,
    mutationAllowed: !cachedView.actionsDisabled,
    environmentAvailable: connectionUiState === "connected" && hydratedFromCacheAt === null,
    // Native mobile is the intended phone surface. Only the frozen web phone
    // tier is excluded from provider handoff.
    isPhoneTier: false,
  });
  const threadProviderDriver = useMemo(() => {
    const instanceId = selectedModelSelection?.instanceId;
    if (!instanceId) return null;
    return providers.find((provider) => provider.instanceId === instanceId)?.driver ?? null;
  }, [providers, selectedModelSelection?.instanceId]);
  // An optional question answered after its turn ended: a new message on the thread's own model
  // and modes, through the shared send engine, which starts the next turn.
  const sendOptionalAnswer = useCallback(
    async (userInput: PendingUserInput, answers: Record<string, string | string[]>) => {
      const current = selectThreadByRef(
        useStore.getState(),
        scopeThreadRef(environmentId, threadId),
      );
      if (!current) throw new Error("Thread is not loaded yet.");
      await sendOptionalAnswerAsMessage({
        api: ensureEnvironmentApi(environmentId),
        threadId,
        userInput,
        answers,
        attachments: [],
        thread: {
          title: current.title,
          modelSelection: current.modelSelection,
          runtimeMode: current.runtimeMode,
          interactionMode: current.interactionMode,
          tokenMode: current.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        },
        providerDriver: current.session?.provider ?? null,
        assertMutationReady: captureReviewedSendReadiness(
          environmentId,
          () => createMobileConnectionRegistry().driver.supervisor.read(environmentId),
          "The connection changed. Reconnect and send the answer again; your draft is kept.",
        ),
        newCommandId,
        newMessageId,
      });
    },
    [environmentId, threadId],
  );

  useEffect(() => {
    setStagedModelSelection(null);
  }, [environmentId, threadId]);

  useEffect(() => {
    if (
      stagedModelSelection &&
      canonicalModelSelection &&
      modelSelectionsEqual(stagedModelSelection, canonicalModelSelection)
    ) {
      setStagedModelSelection(null);
    }
  }, [canonicalModelSelection, stagedModelSelection]);

  const policyModel = useMemo(
    () =>
      thread
        ? buildSessionPolicyModel({
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
          })
        : null,
    [providers, selectedModelSelection, thread, threadProviderDriver],
  );

  const modelPicker = useMemo(
    () =>
      thread
        ? buildModelPickerModel({
            serverConfig,
            currentSelection: selectedModelSelection,
            lockedProviderKey:
              providerSelectionPolicy.mode === "continuation-only"
                ? (canonicalModelSelection?.instanceId ?? null)
                : null,
          })
        : null,
    [
      canonicalModelSelection?.instanceId,
      providerSelectionPolicy.mode,
      selectedModelSelection,
      serverConfig,
      thread,
    ],
  );
  const threadActivities = thread?.activities;
  const secretRequests = useMemo(
    () =>
      mobileSecretRequestCards({
        activities: threadActivities,
        nowMs: settlementNowMs,
        nodeSupports: environmentServerConfig?.environment.capabilities.secretRequests === true,
        role: environmentRow?.role,
        mutationReady: environmentRow?.mutationReady ?? false,
        promptsDisabled: cachedView.promptsDisabled,
      }),
    [
      cachedView.promptsDisabled,
      environmentRow?.mutationReady,
      environmentRow?.role,
      environmentServerConfig,
      settlementNowMs,
      threadActivities,
    ],
  );
  const pillFastEnabled = modelPicker?.pillFastEnabled === true;
  const fastModeNotice = useMemo(
    () =>
      threadProviderDriver === "claudeAgent" && selectedModelSelection
        ? deriveClaudeFastModeNotice({
            activities: threadActivities ?? [],
            instanceId: selectedModelSelection.instanceId,
            model: selectedModelSelection.model,
            fastRequested: pillFastEnabled,
          })
        : null,
    [pillFastEnabled, selectedModelSelection, threadActivities, threadProviderDriver],
  );
  const pendingHandoff = useMemo(
    () =>
      derivePendingComposerHandoff({
        activities: threadActivities ?? [],
        threadStarted,
        canonicalSelection: canonicalModelSelection,
        targetSelection: selectedModelSelection,
        serverConfig,
      }),
    [
      canonicalModelSelection,
      selectedModelSelection,
      serverConfig,
      threadActivities,
      threadStarted,
    ],
  );

  // "Fork from here": offered on the terminal reply of a completed turn while this node can fork
  // right now. Capability and chats availability come from THIS environment's config, not the
  // active-environment atom, which nulls on switch. So does the node's follow-up queue.
  const serverFollowUpQueueSupported = selectServerFollowUpQueueSupported(environmentServerConfig);
  // Subscribed, not read in render: a screen opened before its node connected
  // offers the fork as soon as the connection registers.
  const environmentApi = useEnvironmentApi(environmentId);
  const forkOffered = isThreadForkOffered({
    mutationReady: environmentRow?.mutationReady,
    actionsDisabled: cachedView.actionsDisabled,
    serverCapability: environmentServerConfig?.environment.capabilities.threadFork,
    forkApiAvailable: readThreadForkApi(environmentApi) !== null,
  });
  const threadMessages = thread?.messages;
  const threadLatestTurn = thread?.latestTurn;
  const threadSession = thread?.session;
  const forkableMessageIds = useMemo(
    () =>
      forkOffered && threadMessages
        ? deriveForkableReplyMessageIds({
            messages: threadMessages,
            latestTurn: threadLatestTurn,
            session: threadSession,
          })
        : NO_FORKABLE_MESSAGES,
    [forkOffered, threadLatestTurn, threadMessages, threadSession],
  );
  // A sheet opened on another thread (this screen retargeted by `navigate`) is dropped, not just
  // hidden; its attempt stays in the shared registry for the next "Fork from here".
  const [forkSheet, setForkSheet] = useForkSheetState({ environmentId, threadId });
  const closeForkSheet = useCallback(
    () => setForkSheet((current) => (current ? { ...current, visible: false } : current)),
    [setForkSheet],
  );
  // A slow stream still opens the fork (`arrived` false): the thread screen loads it.
  const onForked = useCallback(
    (result: ThreadForkResult) => {
      closeForkSheet();
      navigation.dispatch(
        StackActions.push("Thread", { environmentId, threadId: result.threadId }),
      );
    },
    [closeForkSheet, environmentId, navigation],
  );
  // Each opening drives the shared attempt for this reply: an unsettled one a closed sheet left
  // (same key, possibly still in flight) is continued, a fork created while no sheet showed it is
  // opened, else a fresh one starts.
  const openForkSheet = useCallback(
    (message: ChatMessage) => {
      if (!message.turnId) return;
      const state = useStore.getState();
      const source = selectThreadByRef(state, scopeThreadRef(environmentId, threadId));
      const sourceProject = source
        ? selectProjectByRef(state, scopeProjectRef(environmentId, source.projectId))
        : undefined;
      const sourceBranch = source?.branch ?? null;
      setForkSheet({
        visible: true,
        request: {
          environmentId,
          sourceThreadId: threadId,
          sourceTitle: source?.title ?? "",
          messageId: message.id,
          turnId: message.turnId,
          // A page-only turn, or a blank reply under a page, quotes what the turn published.
          excerpt: threadForkReplyExcerpt(
            threadForkBoundaryQuote(source?.messages ?? [], message.id),
          ),
        },
        controller: createThreadForkAttemptController({
          boundary: { environmentId, sourceThreadId: threadId, sourceMessageId: message.id },
          initialSelection: initialForkSheetSelection({
            isChat: isChatProject(sourceProject),
            sourceBranch,
          }),
          defaultBaseRef: defaultThreadForkBaseRef(sourceBranch),
          ports: mobileForkSheetPorts(environmentId),
          onForked,
        }),
      });
    },
    [environmentId, onForked, setForkSheet, threadId],
  );
  // Git is read for the project root, the checkout a new worktree is created from, and only
  // while the sheet is open. Chats never offer a worktree.
  const forkSheetVisible = forkSheet?.visible === true;
  const forkRepository = useRepositoryStatus(
    environmentId,
    forkSheetVisible && project && !isChatProject(project) ? project.cwd : null,
  );
  const forkTurnId = forkSheet?.request.turnId ?? null;
  const threadWorktreePath = thread?.worktreePath ?? null;
  const threadBranch = thread?.branch ?? null;
  const threadTurnDiffSummaries = thread?.turnDiffSummaries;
  const forkSheetSource = useMemo(
    () =>
      buildForkSheetSource({
        project,
        repository: forkRepository,
        serverConfig: environmentServerConfig,
        thread: threadTurnDiffSummaries
          ? {
              worktreePath: threadWorktreePath,
              branch: threadBranch,
              turnDiffSummaries: threadTurnDiffSummaries,
            }
          : null,
        turnId: forkTurnId,
      }),
    [
      environmentServerConfig,
      forkRepository,
      forkTurnId,
      project,
      threadBranch,
      threadTurnDiffSummaries,
      threadWorktreePath,
    ],
  );
  // "Edit from here": each sent message's revert target (shared with web), offered while the
  // thread is idle and the node takes mutations.
  const revertTurnCountByUserMessageId = useMemo(() => {
    if (!threadMessages || !threadTurnDiffSummaries) return NO_REVERT_TARGETS;
    return deriveRevertTurnCountByUserMessageId({
      messages: threadMessages,
      turnDiffSummaryByAssistantMessageId: new Map(
        threadTurnDiffSummaries.flatMap((summary) =>
          summary.assistantMessageId ? [[summary.assistantMessageId, summary] as const] : [],
        ),
      ),
      inferredCheckpointTurnCountByTurnId:
        inferCheckpointTurnCountByTurnId(threadTurnDiffSummaries),
    });
  }, [threadMessages, threadTurnDiffSummaries]);
  const revertOffered =
    revertPhase === null &&
    !sendBusy &&
    sessionPhase !== "running" &&
    connectionUiState === "connected" &&
    !cachedView.actionsDisabled;
  const editableMessageIds = useMemo(
    () =>
      revertOffered && revertTurnCountByUserMessageId.size > 0
        ? new Set(revertTurnCountByUserMessageId.keys())
        : NO_FORKABLE_MESSAGES,
    [revertOffered, revertTurnCountByUserMessageId],
  );
  const conversationRevertSupported = selectConversationRevertSupported(environmentServerConfig);
  // "Undo file changes": the checkpoint before each reply's turn, offered like "Edit from here"
  // on a node that restores files without rewinding the chat.
  const filesRevertOffered = revertOffered && selectFilesRevertSupported(environmentServerConfig);
  const undoTurnCountByReplyId = useMemo(() => {
    if (!filesRevertOffered || !threadTurnDiffSummaries) return NO_REVERT_TARGETS;
    const byTurnId = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: threadTurnDiffSummaries,
      inferredCheckpointTurnCountByTurnId:
        inferCheckpointTurnCountByTurnId(threadTurnDiffSummaries),
    });
    return new Map(
      threadTurnDiffSummaries.flatMap((summary) => {
        const turnCount = byTurnId.get(summary.turnId);
        return summary.assistantMessageId && turnCount !== undefined
          ? [[summary.assistantMessageId, turnCount] as const]
          : [];
      }),
    );
  }, [filesRevertOffered, threadTurnDiffSummaries]);
  const undoableMessageIds = useMemo(
    () =>
      undoTurnCountByReplyId.size > 0
        ? new Set(undoTurnCountByReplyId.keys())
        : NO_FORKABLE_MESSAGES,
    [undoTurnCountByReplyId],
  );
  // A link to another thread of this environment (a fork's source link), optionally at one of
  // its messages: back to it when it is the previous screen (pointing it at the message first),
  // otherwise pushed so Back returns here.
  const openThread = useCallback(
    (target: ThreadId, messageId: MessageId | null = null) => {
      const step = resolveOpenThreadNavigation({
        state: navigation.getState(),
        environmentId,
        threadId: target,
        messageId,
      });
      if (step.kind === "back") {
        if (step.anchor) {
          navigation.dispatch({
            ...CommonActions.setParams(step.anchor.params),
            source: step.anchor.routeKey,
          });
        }
        navigation.goBack();
        return;
      }
      navigation.dispatch(StackActions.push("Thread", step.params));
    },
    [environmentId, navigation],
  );

  const getSteerEligibility = useCallback(
    (
      message: Pick<
        QueuedThreadMessage,
        "modelSelection" | "runtimeMode" | "interactionMode" | "tokenMode"
      >,
    ) => {
      if (hasRetiredProjectMemory(message))
        return { allowed: false as const, reason: REMOVED_PROJECT_MEMORY_MESSAGE };
      const activeSelection = thread?.modelSelection;
      const providerInstanceId = thread?.session?.providerInstanceId ?? activeSelection?.instanceId;
      const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
      return resolveQueuedMessageSteerEligibility({
        // A cache-provenance thread reads `turnRunning` from a snapshot; a
        // steer dispatched against it targets a turn state the node may have
        // left long ago. Not mutation-ready until the live snapshot lands.
        mutationReady: connectionUiState === "connected" && hydratedFromCacheAt === null,
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
    },
    [connectionUiState, hydratedFromCacheAt, providers, thread],
  );

  const getSteerUnavailableReason = useCallback(
    (message: QueuedThreadMessage): string | null => {
      const eligibility = getSteerEligibility(message);
      return eligibility.allowed ? null : eligibility.reason;
    },
    [getSteerEligibility],
  );

  const endSteerAttempt = useCallback((messageId: string, commandId: string) => {
    clearThreadOutboxSteering(messageId, commandId);
    setSteerAttempts((current) => {
      if (current.get(messageId)?.commandId !== commandId) return current;
      const next = new Map(current);
      next.delete(messageId);
      return next;
    });
  }, []);

  const steerQueuedMessage = useCallback(
    async (message: QueuedThreadMessage) => {
      if (steerAttemptsRef.current.has(message.messageId)) return;
      // Its add to the node's queue is on its way: the node may send it, so a steer would be a
      // second copy.
      const eligibility =
        getThreadOutboxMovingMessageId(
          scopedThreadKey(scopeThreadRef(message.environmentId, message.threadId)),
        ) === message.messageId
          ? { allowed: false as const, reason: FOLLOW_UP_ON_ITS_WAY_REASON }
          : getSteerEligibility(message);
      if (!eligibility.allowed) {
        setSendError(eligibility.reason);
        return;
      }
      setSendError(null);
      // Minted first and marked before any await, so the outbox drain never sends it as a turn.
      const commandId = newCommandId();
      const attempt: QueuedMessageSteerAttempt = {
        commandId,
        expectedTurnId: eligibility.expectedTurnId,
        startedAt: new Date().toISOString(),
        explicit: true,
      };
      markThreadOutboxSteering(message.messageId, attempt);
      steerAttemptsRef.current = new Map(steerAttemptsRef.current).set(message.messageId, attempt);
      setSteerAttempts((current) => new Map(current).set(message.messageId, attempt));
      // Outside the try: React Compiler cannot lower a `||` inside a try/catch.
      const steerText =
        composeOutgoingPrompt({ prompt: message.text }) || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;
      try {
        const attachments = await buildQueuedThreadMessageAttachments(message);
        const requestedAt = new Date().toISOString();
        await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand(
          buildQueuedMessageSteerCommand({
            commandId,
            threadId,
            expectedTurnId: eligibility.expectedTurnId,
            messageId: MessageId.make(message.messageId),
            text: steerText,
            attachments,
            createdAt: message.createdAt,
            requestedAt,
          }),
        );
      } catch (error) {
        endSteerAttempt(message.messageId, commandId);
        setSendError(error instanceof Error ? error.message : "The steer request failed.");
      }
    },
    [endSteerAttempt, environmentId, getSteerEligibility, threadId],
  );

  // Accepted steers are projected into the running turn; a rejection of THIS attempt returns
  // the message to the queue (held for an explicit retry when the provider may have it).
  // Deferred rejections stay quiet: the row stays visibly queued.
  useEffect(() => {
    if (!thread || steerAttempts.size === 0) return;
    const outcomes = collectQueuedMessageSteerOutcomes({
      attempts: steerAttempts,
      projectedMessageIds: new Set(thread.messages.map((message) => String(message.id))),
      rejectionsByActivityId: indexTurnSteerRejections(thread.activities),
    });
    for (const messageId of outcomes.accepted) {
      removeThreadOutboxMessage(messageId);
      endSteerAttempt(messageId, steerAttempts.get(messageId)!.commandId);
    }
    for (const rejection of outcomes.rejected) {
      // Holds a message the provider may have received for an explicit retry.
      endThreadOutboxSteer(rejection);
      endSteerAttempt(rejection.messageId, rejection.attempt.commandId);
    }
    const failed = outcomes.rejected.findLast((rejection) => rejection.reason === "failed");
    if (failed) setSendError(failed.error);
  }, [endSteerAttempt, steerAttempts, thread]);

  /** A node's entry steers with the modes it was queued with, like an outbox message. */
  const getServerQueuedSteerEligibility = useCallback(
    (messageId: string) => {
      const entry = selectThreadFollowUpQueue(
        useStore.getState(),
        scopeThreadRef(environmentId, threadId),
      )?.entries.find((candidate) => candidate.messageId === messageId);
      if (!entry) return { allowed: false as const, reason: "This message is no longer queued." };
      return getSteerEligibility({
        modelSelection: entry.modelSelection,
        runtimeMode: entry.runtimeMode,
        interactionMode: entry.interactionMode,
        tokenMode: entry.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
      });
    },
    [environmentId, getSteerEligibility, threadId],
  );

  /** `thread.queue.steer`: the node sends the entry into the running turn, or keeps it queued. */
  const steerServerQueuedMessage = useCallback(
    async (messageId: MessageId) => {
      const eligibility = getServerQueuedSteerEligibility(messageId);
      if (!eligibility.allowed) {
        setSendError(eligibility.reason);
        return;
      }
      await runServerQueueCommand((base) =>
        buildFollowUpQueueSteerCommand({
          ...base,
          messageId,
          expectedTurnId: eligibility.expectedTurnId,
        }),
      );
    },
    [getServerQueuedSteerEligibility, runServerQueueCommand],
  );

  const getQueuedRowSteerUnavailableReason = (row: FollowUpQueueRow): string | null => {
    const onItsWay = followUpQueueRowOnItsWayReason(row);
    if (onItsWay !== null || row.source === "pending") return onItsWay;
    if (row.source === "server") {
      if (row.status === "failed") return "Retry this message before steering it.";
      const eligibility = getServerQueuedSteerEligibility(row.id);
      return eligibility.allowed ? null : eligibility.reason;
    }
    const message = localQueuedMessages.get(row.id);
    return message ? getSteerUnavailableReason(message) : null;
  };

  const steerQueuedRow = (row: FollowUpQueueRow) => {
    if (row.source === "server") {
      void steerServerQueuedMessage(MessageId.make(row.id));
      return;
    }
    const message = localQueuedMessages.get(row.id);
    if (message) void steerQueuedMessage(message);
  };

  const applyPolicy = useCallback((apply: () => Promise<void>) => {
    setSendError(null);
    return runWhileBusy(setPolicyBusy, async () => {
      try {
        await apply();
      } catch (error) {
        // Never fail silently: a policy change that did not land would otherwise
        // leave the pill showing a setting the node never received.
        setSendError(
          error instanceof Error ? error.message : "The session policy change did not apply.",
        );
      }
    });
  }, []);

  const stageModelSelection = useCallback(
    (next: ModelSelection) => {
      setStagedModelSelection(next);
      noteModelSelectionPicked();
      if (!thread) return;
      const targetProvider = providers.find((provider) => provider.instanceId === next.instanceId);
      const normalizedMode = normalizeInteractionModeForProviderTarget(
        thread.interactionMode,
        targetProvider?.supportsAskMode === true,
      );
      if (normalizedMode !== thread.interactionMode) {
        void applyPolicy(() =>
          setThreadInteractionMode(ensureEnvironmentApi(environmentId), threadId, normalizedMode),
        );
      }
    },
    [applyPolicy, environmentId, noteModelSelectionPicked, providers, thread, threadId],
  );

  // One lookup for the open thread only. See useThreadChecks for why the inbox
  // deliberately does not do this.
  const checks = useThreadChecks({
    environmentId,
    cwd: worktree?.worktreePath ?? thread?.worktreePath ?? null,
    prNumber: worktree?.prNumber ?? null,
  });

  const openReview = useCallback(
    () =>
      navigation.navigate("ThreadReview", {
        environmentId,
        threadId,
      }),
    [environmentId, navigation, threadId],
  );

  const openFiles = useCallback(
    () =>
      navigation.navigate("ThreadFiles", {
        environmentId,
        threadId,
      }),
    [environmentId, navigation, threadId],
  );

  // A steer on the running turn's provider stops the turn and sends the message next.
  const activeProviderSteering = providerSteering(
    providers.find(
      (entry) =>
        entry.instanceId ===
        (thread?.session?.providerInstanceId ?? thread?.modelSelection?.instanceId),
    ),
  );
  const openTerminal = useCallback(
    () =>
      navigation.navigate("ThreadTerminal", {
        environmentId,
        threadId,
      }),
    [environmentId, navigation, threadId],
  );
  const openDevice = useCallback(
    () => navigation.navigate("ThreadDevice", { environmentId, threadId }),
    [environmentId, navigation, threadId],
  );

  // A hardware keyboard opens the same tools as the header buttons, only while
  // they show (Command-Shift-F, -T and -R).
  useHardwareKeyboardCommand("review", headerModel?.reviewVisible ? openReview : undefined);
  useHardwareKeyboardCommand("files", headerModel?.filesVisible ? openFiles : undefined);
  useHardwareKeyboardCommand("terminal", headerModel?.terminalVisible ? openTerminal : undefined);

  const enqueueFileUpload = useCallback(
    (attachment: DraftComposerFileAttachment) => {
      ownedUploadIds.current.add(attachment.id);
      composerFileUploadEngine.enqueue({
        attachmentId: attachment.id,
        threadId,
        environmentId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        readBytes: () => readComposerFileBytes(attachment.readUri),
      });
    },
    [environmentId, threadId],
  );

  const pickAttachments = useCallback(
    async (source: ComposerAttachmentSource) => {
      setAttachmentError(null);
      const existingTotalBytes = attachments.reduce((total, attachment) => {
        if (attachment.type === "file" && attachment.uploadState === "needsReattach") return total;
        return total + attachment.sizeBytes;
      }, 0);
      const result = await pickComposerAttachmentsFrom(source, {
        existingCount: attachments.length,
        existingTotalBytes,
        fileUploadMaxBytes,
      });
      setAttachmentError(result.error);
      if (result.images.length > 0 || result.files.length > 0) {
        setAttachments((current) => [...current, ...result.images, ...result.files]);
      }
      for (const file of result.files) {
        enqueueFileUpload(file);
      }
    },
    [attachments, enqueueFileUpload, fileUploadMaxBytes],
  );

  // Rewinds to before a sent message (keeping the files or not). Its prompt and attachments
  // wait for the composer (`takeReturnedSentMessages`) once the node has rewound the thread.
  const editFromHere = useCallback(
    (message: ChatMessage) => {
      const turnCount = revertTurnCountByUserMessageId.get(message.id);
      if (turnCount === undefined || revertPhase !== null || !thread) return;
      const providerInstanceId =
        thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const threadRef = scopeThreadRef(environmentId, threadId);
      setSendError(null);
      void runEditFromHere({
        api: environmentApi ?? null,
        environmentId,
        threadId,
        threadKey: outboxThreadKey,
        message,
        turnCount,
        environmentUnavailable: connectionUiState !== "connected",
        turnInProgress: sessionPhase === "running" || sendBusy,
        providerRefusal: checkpointRevertUnsupportedMessage(
          providers.find((provider) => provider.instanceId === providerInstanceId),
        ),
        keepFilesAvailable: conversationRevertSupported,
        keptChangesTurnCount: revertKeptChangesDiscardedBy(thread.activities, turnCount),
        composerAttachments: attachments,
        fileUploadsSupported: fileUploadMaxBytes !== null,
        readThread: () => selectThreadByRef(useStore.getState(), threadRef),
        subscribe: (listener) => useStore.subscribe(listener),
      }).then((result) => {
        if (result.error) setSendError(result.error);
        // The revert's own row stays out of the timeline, so its note shows here.
        if (result.kind === "returned" && result.notice) {
          Alert.alert(result.notice.title, result.notice.detail);
        }
      });
    },
    [
      attachments,
      connectionUiState,
      conversationRevertSupported,
      environmentApi,
      environmentId,
      fileUploadMaxBytes,
      outboxThreadKey,
      providers,
      revertPhase,
      revertTurnCountByUserMessageId,
      sendBusy,
      sessionPhase,
      thread,
      threadId,
    ],
  );
  // Restores the files of a reply's turn to how they were before it, keeping the chat (or,
  // when the agent can forget turns and the user asks, reverting the thread too).
  const undoFileChanges = useCallback(
    (reply: ChatMessage) => {
      const turnCount = undoTurnCountByReplyId.get(reply.id);
      if (turnCount === undefined || revertPhase !== null || !thread) return;
      const providerInstanceId =
        thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const threadRef = scopeThreadRef(environmentId, threadId);
      setSendError(null);
      void runUndoFileChanges({
        api: environmentApi ?? null,
        environmentId,
        threadId,
        turnCount,
        environmentUnavailable: connectionUiState !== "connected",
        turnInProgress: sessionPhase === "running" || sendBusy,
        providerRefusal: checkpointRevertUnsupportedMessage(
          providers.find((provider) => provider.instanceId === providerInstanceId),
        ),
        keptChangesTurnCount: revertKeptChangesDiscardedBy(thread.activities, turnCount),
        readThread: () => selectThreadByRef(useStore.getState(), threadRef),
        subscribe: (listener) => useStore.subscribe(listener),
      }).then((result) => {
        if (result.error) setSendError(result.error);
        // The revert's own row stays out of the timeline, so its note shows here.
        if (result.notice) Alert.alert(result.notice.title, result.notice.detail);
      });
    },
    [
      connectionUiState,
      environmentApi,
      environmentId,
      providers,
      revertPhase,
      sendBusy,
      sessionPhase,
      thread,
      threadId,
      undoTurnCountByReplyId,
    ],
  );
  // Takes what "Edit from here" returned into the composer: right away, or once this thread's
  // screen is back if it was closed while the node reverted.
  const takeReturnedMessages = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const returned = takeReturnedSentMessages(outboxThreadKey);
    if (returned.length === 0) return;
    let text = composer.getText();
    const returnedAttachments: DraftComposerAttachment[] = [];
    for (const entry of returned) {
      text = appendReturnedComposerPrompt(text, entry.prompt);
      returnedAttachments.push(...entry.attachments);
    }
    composer.setText(text);
    if (returnedAttachments.length > 0) {
      setAttachments((current) => [...current, ...returnedAttachments]);
      for (const attachment of returnedAttachments) {
        if (attachment.type === "file") enqueueFileUpload(attachment);
      }
    }
    composer.focus();
  }, [enqueueFileUpload, outboxThreadKey]);
  useEffect(() => {
    takeReturnedMessages();
    return subscribeReturnedSentMessages(takeReturnedMessages);
  }, [takeReturnedMessages]);
  // Rows keep the handler they were rendered with (LegendList re-renders a row only when its
  // item changes), so they call through a ref that always holds the current one.
  const editFromHereRef = useRef(editFromHere);
  useEffect(() => {
    editFromHereRef.current = editFromHere;
  }, [editFromHere]);
  const onEditFromMessage = useCallback((message: ChatMessage) => {
    editFromHereRef.current(message);
  }, []);
  const undoFileChangesRef = useRef(undoFileChanges);
  useEffect(() => {
    undoFileChangesRef.current = undoFileChanges;
  }, [undoFileChanges]);
  const onUndoFileChangesOfReply = useCallback((reply: ChatMessage) => {
    undoFileChangesRef.current(reply);
  }, []);

  const pasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      const images = await convertPastedImagesToAttachments({
        uris,
        existingCount: attachments.length,
      });
      if (images.length === 0 && uris.length > 0) {
        setAttachmentError("The pasted image could not be attached.");
        return;
      }
      setAttachmentError(null);
      setAttachments((current) => [...current, ...images]);
    },
    [attachments.length],
  );

  const removeAttachment = useCallback((attachmentId: string) => {
    composerFileUploadEngine.release(attachmentId);
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const retryFileUpload = useCallback((attachmentId: string) => {
    composerFileUploadEngine.retry(attachmentId);
  }, []);

  const reattachFile = useCallback(
    (attachmentId: string) => {
      composerFileUploadEngine.release(attachmentId);
      setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
      void pickAttachments("files");
    },
    [pickAttachments],
  );

  // Sync uploaded tokens onto the rows so an enqueued outbox message persists
  // token metadata (never bytes) and the immediate dispatch path can read it.
  useEffect(() => {
    setAttachments((current) => {
      let changed = false;
      const next = current.map((attachment) => {
        if (!isDraftComposerFileAttachment(attachment)) return attachment;
        const status = fileUploadRecords.get(attachment.id)?.status;
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
    });
  }, [fileUploadRecords]);

  // Engine records are process-transient: drop the ones whose attachment left
  // the composer (removal, send clear, discard).
  useEffect(() => {
    const liveIds = new Set(attachments.map((attachment) => attachment.id));
    for (const attachmentId of ownedUploadIds.current) {
      if (!liveIds.has(attachmentId)) {
        composerFileUploadEngine.release(attachmentId);
        ownedUploadIds.current.delete(attachmentId);
      }
    }
  }, [attachments]);

  useEffect(() => {
    const ownedIds = ownedUploadIds.current;
    return () => {
      for (const attachmentId of ownedIds) composerFileUploadEngine.release(attachmentId);
      ownedIds.clear();
    };
  }, []);

  // Edit = take the message out of the outbox and put its text and attachments
  // back into the composer. Sending it again re-queues it while the turn runs.
  const editQueuedMessage = (messageId: string) => {
    const message = queuedMessages.find((entry) => entry.messageId === messageId);
    if (!message) return;
    // An add on its way to the node would come back as a second copy of the edited message.
    const unavailableReason =
      getThreadOutboxMovingMessageId(outboxThreadKey) === messageId
        ? FOLLOW_UP_ON_ITS_WAY_REASON
        : resolveQueuedMessageEditUnavailableReason({
            deliveryStatus: undefined,
            steering: steerAttemptsRef.current.has(messageId),
            composerHasContent: attachments.length > 0 || composerRef.current?.hasText() === true,
          });
    if (unavailableReason !== null) {
      setSendError(unavailableReason);
      return;
    }
    removeThreadOutboxMessage(messageId);
    setSendError(null);
    setAttachments([...message.attachments]);
    composerRef.current?.setText(message.text);
    composerRef.current?.focus();
  };

  // The node's entry: its text goes into the composer, and the next send saves it in place
  // (`thread.queue.edit` at the revision shown) instead of sending it. Its stored attachments
  // stay with it; ones added in the composer are added to it.
  const editServerQueuedEntry = (messageId: string) => {
    const entry = serverFollowUpQueue?.entries.find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!entry) return;
    const unavailableReason =
      activeServerQueueEdit !== null
        ? SERVER_QUEUE_EDIT_IN_PROGRESS
        : resolveQueuedMessageEditUnavailableReason({
            deliveryStatus: undefined,
            steering: entry.status === "steering",
            composerHasContent: attachments.length > 0 || composerRef.current?.hasText() === true,
          });
    if (unavailableReason !== null) {
      setSendError(unavailableReason);
      return;
    }
    setServerQueueEdit(followUpQueueEditOf(outboxThreadKey, entry));
    setSendError(null);
    composerRef.current?.setText(entry.text);
    composerRef.current?.focus();
  };

  const cancelServerQueueEdit = () => {
    setServerQueueEdit(null);
    clearCancelledServerQueueEdit({
      setText: (text) => composerRef.current?.setText(text),
      setAttachments,
      setAttachmentError,
    });
  };

  const editQueuedRow = (row: FollowUpQueueRow) => {
    if (row.source === "server") editServerQueuedEntry(row.id);
    else if (row.source === "local") editQueuedMessage(row.id);
  };

  const getQueuedRowEditUnavailableReason = (row: FollowUpQueueRow): string | null => {
    if (row.source === "server" && activeServerQueueEdit !== null) {
      return SERVER_QUEUE_EDIT_IN_PROGRESS;
    }
    const onItsWay = followUpQueueRowOnItsWayReason(row);
    if (onItsWay !== null) return onItsWay;
    return resolveQueuedMessageEditUnavailableReason({
      deliveryStatus: undefined,
      steering: row.status === "steering",
      // The typed text is only known at press time (`editQueuedMessage`).
      composerHasContent: attachments.length > 0,
    });
  };

  const removeQueuedRow = (row: FollowUpQueueRow) => {
    if (row.source === "server") {
      void runServerQueueCommand((base) =>
        buildFollowUpQueueRemoveCommand({ ...base, messageIds: [MessageId.make(row.id)] }),
      );
      return;
    }
    if (row.source !== "local") return;
    removeThreadOutboxMessage(row.id);
    const attempt = steerAttempts.get(row.id);
    if (attempt) endSteerAttempt(row.id, attempt.commandId);
  };

  // `/goal …`: set, pause, resume or clear the goal the agent pursues (`planThreadGoalCommand`).
  const runGoalCommand = async (
    command: ThreadGoalSlashCommand,
    attachmentCount: number,
  ): Promise<boolean> => {
    const plan = planThreadGoalCommand(command, {
      hasGoal: (thread?.goal ?? null) !== null,
      running: thread?.latestTurn?.state === "running",
    });
    if (plan.kind === "show") {
      setContextSheetFor(outboxThreadKey);
      return true;
    }
    if (plan.kind === "refuse") {
      setSendError(`${plan.title}. ${plan.message}`);
      return false;
    }
    if (attachmentCount > 0) {
      setSendError("A goal is text only. Remove the attachments first.");
      return false;
    }
    if (connectionUiState !== "connected") {
      setSendError("Reconnect to change the goal.");
      return false;
    }
    return runWhileBusy(setSendBusy, () =>
      sendGoalPlan(environmentId, threadId, plan).then(
        () => true,
        (error: unknown) => {
          setSendError(actionFailureMessage(error));
          return false;
        },
      ),
    );
  };

  const onSend = async (
    text: string,
    attachments: ReadonlyArray<DraftComposerAttachment>,
    options: {
      /**
       * A Reply tapped on a notification: a message of its own. It never edits a queued entry,
       * never declines waiting approvals, and leaves the composer's attachments alone.
       */
      readonly notificationReply?: boolean;
    } = {},
  ): Promise<boolean> => {
    const notificationReply = options.notificationReply === true;
    setSendError(null);
    if (notificationReply && (activeServerQueueEdit !== null || savingServerQueueEdit !== null)) {
      setSendError("The reply was not sent: a queued message is being edited here.");
      return false;
    }
    const goalCommand = notificationReply ? null : parseThreadGoalSlashCommand(text);
    if (goalCommand !== null) return runGoalCommand(goalCommand, attachments.length);
    const sideQuestion = notificationReply ? null : parseSideQuestionCommand(text);
    if (sideQuestion !== null) {
      if (attachments.length > 0) {
        setSendError("Side questions accept text only. Remove attachments first.");
        return false;
      }
      if (!selectedModelSelection) {
        setSendError("No model is configured for this project.");
        return false;
      }
      if (sideQuestion && sideChat?.failedQuestion) {
        setSendError("Restore or discard the unsent side question before asking again.");
        sideChatStore.getState().open(sideChatKey, selectedModelSelection);
        return false;
      }
      if (sideQuestion && (!sideChatReady || sideChat?.pending)) {
        setSendError(
          sideChat?.pending
            ? "Wait for the side answer or stop it first."
            : "Reconnect to ask a side question.",
        );
        return false;
      }
      sideChatStore.getState().open(sideChatKey, selectedModelSelection, sideQuestion || undefined);
      if (sideQuestion) sendSideQuestion();
      return true;
    }
    if (readCheckpointRevertPhase(outboxThreadKey) === "reverting") {
      // The node refuses turns until the revert ends, and the edited prompt is on its way back.
      setSendError("Wait for the revert to finish.");
      return false;
    }
    const state = useStore.getState();
    const currentThread = selectThreadByRef(state, scopeThreadRef(environmentId, threadId));
    if (!currentThread) {
      setSendError("Thread is not loaded yet.");
      return false;
    }
    const currentProject = selectProjectByRef(
      state,
      scopeProjectRef(environmentId, currentThread.projectId),
    );
    const canonicalSelection = currentThread.modelSelection ?? null;
    const modelSelection = stagedModelSelection ?? canonicalSelection;
    if (!modelSelection) {
      setSendError("No model is configured for this project.");
      return false;
    }

    const currentThreadStarted =
      currentThread.latestTurn !== null ||
      currentThread.messages.length > 0 ||
      currentThread.session !== null;
    if (
      canonicalSelection &&
      !selectionAllowedAtSendBoundary({
        threadStarted: currentThreadStarted,
        policy: providerSelectionPolicy,
        canonicalSelection,
        targetSelection: modelSelection,
      })
    ) {
      setSendError("Wait for this task to become idle before handing context to another provider.");
      return false;
    }

    const tokenMode = currentThread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;

    // Editing the node's queued entry: the send saves it in place, busy or not.
    if (activeServerQueueEdit !== null) {
      const edit = activeServerQueueEdit;
      // Saving from here on: the attachments it keeps are fixed (no drop replaces the edit
      // mid-save), and the revision this save raises is not someone else's change.
      setSavingServerQueueEdit(edit);
      return runWhileBusy(setSendBusy, async () => {
        const edited: QueuedThreadMessage = {
          environmentId,
          threadId,
          messageId: edit.messageId,
          commandId: newCommandId(),
          text,
          attachments,
          modelSelection,
          runtimeMode: currentThread.runtimeMode,
          interactionMode: currentThread.interactionMode,
          tokenMode,
          createdAt: new Date().toISOString(),
        };
        const content = await buildQueuedThreadMessageFollowUpContent(edited).catch(
          (error: unknown) => {
            setSendError(
              error instanceof Error ? error.message : "Could not save the queued message.",
            );
            return null;
          },
        );
        if (content === null) {
          setSavingServerQueueEdit((current) => (current === edit ? null : current));
          return false;
        }
        const saved = await runServerQueueCommand((base) =>
          buildFollowUpQueueEditCommand({
            ...base,
            entry: { messageId: edit.messageId, revision: edit.revision },
            content,
            keptAttachmentIds: edit.keptAttachmentIds,
          }),
        );
        setSavingServerQueueEdit((current) => (current === edit ? null : current));
        if (!saved) return false;
        setServerQueueEdit((current) => (current === edit ? null : current));
        setAttachments([]);
        setAttachmentError(null);
        return true;
      });
    }

    // A notification reply queues behind approvals still waiting: the turn they belong to is not
    // over, even where its row already reads completed (a provider that ends the message first).
    const threadBusy =
      currentThread.latestTurn?.state === "running" ||
      (notificationReply && pendingApprovals.length > 0);
    // Wave 3a: the socket opens one RTT before the live shell snapshot lands,
    // and until it does `threadBusy` is read from a CACHED latestTurn — the
    // same window wave 2's review closed for the outbox drain. A send inside
    // it must enqueue, never dispatch into a thread whose real turn state is
    // unknown; read provenance fresh from the store, not from a render.
    const deliveryReconciled =
      selectEnvironmentHydratedFromCacheAt(useStore.getState(), environmentId) === null;
    const connected = connectionUiState === "connected" && deliveryReconciled;
    // The node keeps this thread's queue: a busy send is queued there. Not while this device
    // still holds messages for it (they move first, in order), nor while the node is not ready
    // (the outbox holds it until it is, then moves it).
    const serverQueue = shouldQueueFollowUpOnServer({
      serverQueueSupported: readServerFollowUpQueueSupported(environmentId),
      serverThread: true,
      mutationReady: connected && readThreadOutboxEnvironment(environmentId).mutationReady,
      deviceQueueLength: listThreadOutboxMessages().filter(
        (message) => message.environmentId === environmentId && message.threadId === threadId,
      ).length,
      deviceDispatchPending: isThreadOutboxDispatchPending(outboxThreadKey),
    });
    // The node is about to send its own queue's head (its session still reads ready while that
    // turn starts), or an add of this device is on its way: the send queues behind them.
    const serverQueueWaiting = readServerFollowUpQueueWaiting(
      scopeThreadRef(environmentId, threadId),
    );
    // A message sent while approvals wait declines the ones on screen and steers the turn
    // (`resolveApprovalRedirect`, the decision the placeholder shows). Any other message queues
    // behind them as before.
    const approvalsAtSend = pendingApprovals;
    const redirectApprovals = async (message: QueuedThreadMessage) => {
      // A notification reply answers no approval: it queues behind them.
      if (notificationReply) return "queue" as const;
      const redirect = resolveApprovalRedirect({
        approvals: approvalsAtSend,
        runtimeSessionId: currentThread.session?.runtimeSessionId,
        activeTurnId: currentThread.session?.activeTurnId,
        steerAllowed: threadBusy && connected && getSteerEligibility(message).allowed,
        isSlashCommand: message.text.trimStart().startsWith("/"),
        questionPending: pendingUserInputs.length > 0,
        redirectedTurnId: approvalRedirectedTurnId,
      });
      const refuse = (refusal: ApprovalRedirectRefusal) => {
        const copy = describeApprovalRedirectRefusal(refusal);
        setSendError(`${copy.title}. ${copy.description}`);
        setApprovalRedirectedTurns((turns) =>
          noteApprovalRedirectEnd(turns, threadId, redirect, refusal),
        );
        return "refuse" as const;
      };
      if (redirect.kind === "none") return "queue" as const;
      if (redirect.kind === "decline") {
        if (approvalRedirectTooSoon(redirect, approvalSightingsRef.current)) {
          return refuse({ kind: "just-arrived" });
        }
        const outcome = await declineApprovalsForRedirect({
          redirect,
          decline: (approval) =>
            answerThreadApproval({ environmentId, threadId, approval, decision: "decline" }),
          source: pendingApprovalSourceFromStore(
            useStore,
            (state) =>
              selectThreadByRef(state, scopeThreadRef(environmentId, threadId))?.activities,
          ),
        });
        if (outcome.kind !== "declined") return refuse(outcome);
        // The editor is locked while sending, but an attachment can still be removed meanwhile.
        const current = attachmentsRef.current;
        if (
          current.length !== attachments.length ||
          current.some((attachment, index) => attachment.id !== attachments[index]?.id)
        ) {
          return refuse({ kind: "draft-changed", declined: outcome.declined });
        }
      }
      // This send carries the redirect; later ones on the turn queue again.
      setApprovalRedirectedTurns((turns) =>
        noteApprovalRedirectEnd(turns, threadId, redirect, null),
      );
      return "steer" as const;
    };

    return runWhileBusy(setSendBusy, async () => {
      const sent = await sendThreadTurn(
        {
          environmentId,
          threadId,
          text,
          attachments,
          modelSelection,
          runtimeMode: currentThread.runtimeMode,
          interactionMode: currentThread.interactionMode,
          tokenMode,
          threadBusy,
          connected,
          serverQueue,
          serverQueueWaiting,
        },
        {
          newMessageId,
          newCommandId,
          now: () => new Date().toISOString(),
          enqueue: enqueueThreadOutboxMessage,
          beforeEnqueue: redirectApprovals,
          steer: (message) => void steerQueuedMessage(message),
          queueOnServer: async (message, options) => {
            const queued = await queueThreadMessageOnServer(message);
            if (queued.kind === "refused") {
              setSendError(
                `Not queued. ${
                  queued.error instanceof Error
                    ? queued.error.message
                    : "The node did not queue the message."
                }`,
              );
              return false;
            }
            if (queued.kind === "unknown") {
              // No answer: the outbox keeps it under the same id and moves it to the node.
              runOutboxDrain();
              return true;
            }
            // A redirect that declined the waiting approvals steers the turn with it.
            const eligibility = options.steer ? getSteerEligibility(message) : null;
            if (eligibility?.allowed) {
              await runServerQueueCommand((base) =>
                buildFollowUpQueueSteerCommand({
                  ...base,
                  messageId: message.messageId,
                  expectedTurnId: eligibility.expectedTurnId,
                }),
              );
            }
            return true;
          },
          dispatch: () =>
            executeSendTurn({
              providerDriver: threadProviderDriver,
              sourceProviderDriver: currentThread.session?.provider ?? null,
              claudeCacheReview: mobileClaudeCacheReview,
              skipClaudeResumeReview: () => !isClaudeResumeReviewEnabled(),
              confirmStopBackgroundWork: mobileConfirmStopBackgroundWork,
              // The retained detail subscription already holds what the Claude
              // resume review reads; a send it clears skips the window read.
              readSubscribedClaudeReviewState: () =>
                selectSubscribedClaudeReviewState(
                  useStore.getState(),
                  scopeThreadRef(environmentId, threadId),
                ),
              assertMutationReady: captureReviewedSendReadiness(environmentId, () =>
                createMobileConnectionRegistry().driver.supervisor.read(environmentId),
              ),
              api: ensureEnvironmentApi(environmentId),
              thread: {
                threadId,
                isFirstMessage: currentThread.messages.length === 0,
                isServerThread: true,
                isLocalDraftThread: false,
                activeThreadBranch: currentThread.branch,
                worktreePath: currentThread.worktreePath,
                createdAt: currentThread.createdAt,
              },
              composer: {
                prompt: text,
                images: attachments,
                selectedModelSelection: modelSelection,
                selectedModel: modelSelection.model,
                hasSelectedModel: true,
              },
              project: {
                projectId: currentThread.projectId,
                projectCwd: currentProject?.cwd ?? "",
              },
              settings: {
                runtimeMode: currentThread.runtimeMode,
                interactionMode: currentThread.interactionMode,
                tokenMode,
              },
              title: currentThread.title,
              clearDraft: () => {},
              restoreDraft: () => {},
              setThreadError: (_id, error) => setSendError(error),
            }),
        },
      );
      // The composer clears its own text on success; the attachment rows live
      // here, so a delivered turn (dispatch or safe enqueue) clears them too. A notification
      // reply did not carry them.
      if (sent !== false && !notificationReply) {
        setAttachments([]);
        setAttachmentError(null);
      }
      return sent;
    });
  };

  const runAction = (action: () => Promise<void>, failureTitle = "Could not do that") =>
    runWhileBusy(setActionBusy, async () => {
      try {
        await action();
      } catch (error) {
        Alert.alert(failureTitle, actionFailureMessage(error));
      }
    });

  const runSidebarAction = (action: () => Promise<void>) =>
    runAction(action, "Could not update task");

  // Gated the same way the header is: a snapshot captured mid-turn preserves a
  // "running" latestTurn, and a cached thread rendering a live "Working…" fold
  // would contradict the Offline header two rows above it.
  const runningTurnId =
    !cachedView.headerForcedOffline && thread?.latestTurn?.state === "running"
      ? (thread.latestTurn.turnId ?? null)
      : null;

  const timelineRows = useMemo(
    () =>
      buildThreadTimelineRows({
        entries: built?.timeline ?? [],
        runningTurnId,
        expandedFoldIds,
        // Running folds deliberately use a stable "Working…" label. Sampling
        // the clock only when the timeline changes avoids rebuilding the whole
        // virtualized list every second for a duration that is not displayed.
        now: new Date().toISOString(),
      }),
    [built?.timeline, expandedFoldIds, runningTurnId],
  );

  // Anchoring to the message a link opened this thread at (a fork's link back to its reply):
  // load the history around it if needed, then scroll to it once and highlight it briefly.
  const listRef = useRef<LegendListRef>(null);
  // Running as the header says it (a turn or the session runs), gated like the "Working…" fold.
  const agentRunning =
    !cachedView.headerForcedOffline &&
    (thread?.latestTurn?.state === "running" || thread?.session?.status === "running");
  const runningSince = agentRunning
    ? (thread?.latestTurn?.startedAt ?? thread?.latestTurn?.requestedAt ?? "")
    : null;
  // Whether the feed follows its end as messages arrive (t3code's live follow): only the
  // reader's own drag stops it; reaching the end again, or "jump to latest", resumes it.
  // Kept per chat: a retargeted screen starts out following the new chat's end.
  const [follow, setFollow] = useState({ key: outboxThreadKey, following: true });
  const followingLatest = follow.key === outboxThreadKey ? follow.following : true;
  const setFollowingLatest = (following: boolean) => setFollow({ key: outboxThreadKey, following });
  const userScrollSession = useRef(false);
  const transitionFollow = (event: ThreadFeedLiveFollowEvent) => {
    const next = resolveThreadFeedLiveFollow(followingLatest, event);
    if (next !== followingLatest) setFollowingLatest(next);
  };
  const feedIsAtEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    return isFollowingLatest({
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
      contentHeight: contentSize.height,
    });
  };
  const onFeedScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) =>
    transitionFollow({
      type: "scroll",
      isAtEnd: feedIsAtEnd(event),
      userScrollSessionActive: userScrollSession.current,
    });
  const onFeedScrollBeginDrag = () => {
    userScrollSession.current = true;
    transitionFollow({ type: "user-scroll-begin" });
  };
  const onFeedScrollSettled = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    transitionFollow({
      type: "user-scroll-end",
      isAtEnd: feedIsAtEnd(event),
      userScrollSessionActive: userScrollSession.current,
    });
    userScrollSession.current = false;
  };
  const jumpToLatest = () => {
    transitionFollow({ type: "reset" });
    void listRef.current?.scrollToEnd({ animated: true });
  };

  const [messageAnchor, setMessageAnchor] = useState<{
    readonly messageId: MessageId;
    readonly index: number;
  } | null>(null);
  const anchorProgress = useRef<{
    readonly key: string;
    loadRequested: boolean;
    scrolled: boolean;
  } | null>(null);
  const historyReady = messageHistory !== undefined;
  useEffect(() => {
    if (targetMessageId === null) return;
    const key = `${environmentId}\u0000${threadId}\u0000${targetMessageId}`;
    if (anchorProgress.current?.key !== key) {
      anchorProgress.current = { key, loadRequested: false, scrolled: false };
    }
    const progress = anchorProgress.current;
    if (progress.scrolled) return;
    const step = nextThreadMessageAnchorStep({
      rows: timelineRows,
      messageId: targetMessageId,
      loadRequested: progress.loadRequested,
      historyReady,
    });
    if (step.kind === "load") {
      progress.loadRequested = true;
      try {
        void loadThreadMessagesAround({
          environmentId,
          threadId,
          messageId: targetMessageId,
        }).catch(() => undefined);
      } catch {
        // No live client (a cached thread): the list stays where it is.
      }
    } else if (step.kind === "scroll") {
      progress.scrolled = true;
      // Reading at a linked message, not following the end.
      setFollow({
        key: scopedThreadKey(scopeThreadRef(environmentId, threadId)),
        following: false,
      });
      setMessageAnchor({ messageId: targetMessageId, index: step.index });
    }
  }, [environmentId, historyReady, targetMessageId, threadId, timelineRows]);
  useEffect(() => {
    if (messageAnchor === null) return;
    // One frame late: the list has to have laid the row out before its index is a position.
    const frame = requestAnimationFrame(() => {
      void listRef.current?.scrollToIndex({
        index: messageAnchor.index,
        viewPosition: 0.3,
        animated: true,
      });
    });
    const timer = setTimeout(
      () => setMessageAnchor((current) => (current === messageAnchor ? null : current)),
      MESSAGE_ANCHOR_HIGHLIGHT_MS,
    );
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [messageAnchor]);

  // Fork eligibility and the anchored message live outside the timeline; they go onto the rows
  // so LegendList re-renders the rows they change (it never re-renders on a new renderItem).
  const [annotateRows] = useState(createThreadListRowAnnotator);
  // The plan the settled latest turn proposed and nobody implemented: Implement is offered on it
  // while the chat can take a turn (the shared rule web's plan follow-up reads).
  const latestTurnSettled = thread
    ? isLatestTurnSettled(thread.latestTurn, thread.session ?? null)
    : false;
  const latestPlan =
    thread && latestTurnSettled
      ? findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null)
      : null;
  const actionablePlanId =
    latestPlan !== null &&
    hasActionableProposedPlan(latestPlan) &&
    pendingUserInputs.length === 0 &&
    !cachedView.composerDisabled &&
    !actionBusy &&
    !sendBusy &&
    connectionUiState === "connected"
      ? latestPlan.id
      : null;
  // One object for every plan row: LegendList keeps mounted rows, so the row calls through it
  // into this render's handlers instead of holding an old closure.
  const planHandlersRef = useRef<ProposedPlanCardActions | null>(null);
  // One implementation at a time: a second tap before the node answers would send it twice.
  const planImplementing = useRef(false);
  const [planCardActions] = useState<ProposedPlanCardActions>(() => ({
    implement: (plan) => planHandlersRef.current?.implement(plan),
    implementInNewThread: (plan) => planHandlersRef.current?.implementInNewThread(plan),
    copy: (plan) => planHandlersRef.current?.copy(plan),
    save: (plan) => planHandlersRef.current?.save(plan),
    share: (plan) => planHandlersRef.current?.share(plan),
  }));
  const highlightedMessageId = messageAnchor?.messageId ?? null;
  const listRows = useMemo(
    () =>
      annotateRows(timelineRows, {
        forkableMessageIds,
        editableMessageIds,
        undoableMessageIds,
        highlightedMessageId,
        actionablePlanId,
      }),
    [
      actionablePlanId,
      annotateRows,
      editableMessageIds,
      forkableMessageIds,
      highlightedMessageId,
      timelineRows,
      undoableMessageIds,
    ],
  );

  const renderItem = ({ item }: LegendListRenderItemProps<ThreadListRow>) =>
    item.kind === "activity-fold" ? (
      <ThreadActivityFoldRow
        fold={item}
        environmentId={environmentId}
        threadId={threadId}
        onToggle={() => setExpandedFoldIds((current) => toggleFold(current, item))}
      />
    ) : (
      <TimelineRow
        environmentId={environmentId}
        threadId={threadId}
        entry={item.entry}
        turnHtmlRenders={item.turnHtmlRenders}
        onForkFromMessage={item.forkable ? openForkSheet : undefined}
        onEditFromMessage={item.editable ? onEditFromMessage : undefined}
        onUndoFileChangesOfReply={item.undoable ? onUndoFileChangesOfReply : undefined}
        forkReply={item.forkReply}
        highlighted={item.highlighted}
        planActionable={item.planActionable}
        planActions={planCardActions}
        onOpenThread={openThread}
      />
    );
  // An Approve, Deny or Reply tapped on this thread's notification, carried out by the same
  // handlers as the cards and the composer once the connection is ready for them.
  useNotificationThreadAction({
    threadRef: scopeThreadRef(environmentId, threadId),
    // The thread's live detail (its activities, where approvals and questions live), not its
    // shell row or what a read cache restored at launch.
    threadLoaded: thread !== undefined && thread !== null && threadLiveDetailLoaded,
    ready: (environmentRow?.mutationReady ?? false) && !cachedView.promptsDisabled,
    pendingApprovals,
    pendingUserInputs,
    composerDisabled: cachedView.composerDisabled,
    editingQueuedMessage: activeServerQueueEdit !== null || savingServerQueueEdit !== null,
    respond: async (approval, decision) => {
      // An earlier refusal no longer applies once this one is carried out.
      setSendError(null);
      await answerThreadApproval({ environmentId, threadId, approval, decision });
    },
    answer: async ({ userInput, answers }) => {
      setSendError(null);
      await answerThreadUserInput({ environmentId, threadId, userInput, answers });
    },
    send: (text) => onSend(text, [], { notificationReply: true }),
    refuse: setSendError,
  });
  const visibleError = sendError ?? thread?.error ?? null;
  // A restart release is an interruption, not a thread error (`thread.error` leaves it
  // out): a quiet line once the thread's own activities can tell whether the node
  // already explained it.
  const restartNotice = thread && threadDetailLoaded ? restartInterruptionNotice(thread) : null;
  // A failed last turn stays visible, with Continue, until a new turn starts or it is
  // dismissed for that turn; the error banner then leaves out what it already says.
  const failedNoticeDerived = thread && threadDetailLoaded ? failedTurnNotice(thread) : null;
  const failedNotice =
    failedNoticeDerived && failedNoticeDerived.turnId !== dismissedFailedTurnId
      ? failedNoticeDerived
      : null;
  const errorBannerMessage =
    failedNotice !== null && visibleError === failedNotice.detail ? null : visibleError;
  const hasPrompts =
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    optionalUserInputs.length > 0 ||
    secretRequests.requests.length > 0 ||
    pendingAgentControlProposals.length > 0;
  // While approvals wait on a turn this message could steer, a send declines them and
  // redirects it: the same decision the send makes, from the composer's current selection.
  const sendRedirectsApprovals =
    thread !== undefined &&
    selectedModelSelection !== null &&
    resolveApprovalRedirect({
      approvals: pendingApprovals,
      runtimeSessionId: thread.session?.runtimeSessionId,
      activeTurnId: thread.session?.activeTurnId,
      steerAllowed: getSteerEligibility({
        modelSelection: selectedModelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        tokenMode: thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
      }).allowed,
      // The placeholder only shows while the composer is empty.
      isSlashCommand: false,
      questionPending: pendingUserInputs.length > 0,
      redirectedTurnId: approvalRedirectedTurnId,
    }).kind === "decline";

  // Notices float under the header with the feed starting below them.
  const hasBanners = Boolean(
    cachedView.banner || deliveryNotice || errorBannerMessage || failedNotice || restartNotice,
  );
  const [bannerHeight, setBannerHeight] = useState(0);
  const feedTopInset = headerHeight + 6 + (hasBanners ? bannerHeight + 4 : 0);

  // What the floating status capsule over the composer says; the feed keeps room for it.
  const floatingAttention =
    pendingApprovals.length > 0 || pendingAgentControlProposals.length > 0
      ? ("approval" as const)
      : pendingUserInputs.length > 0 || secretRequests.requests.length > 0
        ? ("question" as const)
        : null;

  // ── Header: the title pill, its context sheet, and one ⋯ menu ─────────────────────────────
  // Which chat a sheet was opened for: the screen is reused when a link retargets it, and
  // another chat's sheets read as closed.
  const [contextSheetFor, setContextSheetFor] = useState<string | null>(null);
  const [cacheSheetFor, setCacheSheetFor] = useState<string | null>(null);
  const contextSheetVisible = contextSheetFor === outboxThreadKey;
  const cacheSheetVisible = cacheSheetFor === outboxThreadKey;
  const setContextSheetVisible = (open: boolean) =>
    setContextSheetFor(open ? outboxThreadKey : null);
  const setCacheSheetVisible = (open: boolean) => setCacheSheetFor(open ? outboxThreadKey : null);
  const threadAgents = useThreadAgents({
    environmentId,
    threadId,
    thread,
    environment: environmentRow,
    stopReady: (environmentRow?.mutationReady ?? false) && !cachedView.actionsDisabled,
    offline: cachedView.headerForcedOffline,
    agentControlProposals,
    onOpenThread: openThread,
  });
  const delegatedRows = useMemo(
    () => threadAgents.model.sections.find((section) => section.key === "delegated")?.rows ?? [],
    [threadAgents.model.sections],
  );
  // The first delegated chat that waits on the reader, for the floating status.
  const childAttentionRow = delegatedRows.find(
    (row) => row.tone === "attention" && row.childThreadId !== null,
  );
  const childAttention =
    childAttentionRow?.childThreadId != null
      ? { threadId: childAttentionRow.childThreadId, title: childAttentionRow.label }
      : null;
  const floatingCapsuleShown = showsFloatingThreadCapsule({
    runningSince,
    attention: floatingAttention,
    childAttention,
    agentsLive: threadAgents.entry?.live === true,
  });
  // A delegated chat links back to the chat that started it, with where its result stands.
  const threadLineage = thread?.lineage;
  const parentThreadId = isDelegatedThreadLineage(threadLineage)
    ? threadLineage.parentThreadId
    : null;
  const parentTitle = useStore((state) =>
    parentThreadId === null
      ? null
      : (selectThreadByRef(state, scopeThreadRef(environmentId, parentThreadId))?.title ?? null),
  );
  const parentLink = useMemo(
    () =>
      buildThreadParentLink({
        lineage: threadLineage,
        parentTitle,
        completionReturn:
          parentThreadId !== null && agentControlEnabled && agentControlQueue !== null
            ? selectCompletionReturnsByChildThreadId(
                selectAgentControlProposalsForThread(agentControlQueue, parentThreadId),
                parentThreadId,
              ).get(threadId)
            : undefined,
      }),
    [agentControlEnabled, agentControlQueue, parentThreadId, parentTitle, threadId, threadLineage],
  );
  const claudeCacheObservation = useMemo(
    () =>
      canonicalProviderDriver === "claudeAgent" && threadActivities
        ? latestClaudeCacheObservation(threadActivities)
        : undefined,
    [canonicalProviderDriver, threadActivities],
  );
  const cacheSummary =
    canonicalProviderDriver !== "claudeAgent"
      ? null
      : claudeCacheObservation
        ? claudeCacheSummaryLabel(claudeCacheObservation)
        : "Unknown";
  // Here, outside the sheet, so a change in flight outlives closing it.
  const pullRequestWatch = usePullRequestWatchControl({
    environmentId,
    threadId,
    watch: headerModel?.pullRequestWatch ?? null,
    ready: (environmentRow?.mutationReady ?? false) && !cachedView.actionsDisabled,
  });
  const { preview: devicePreview, threadState: threadDeviceState } = useThreadDevice(
    environmentId,
    threadId,
  );
  const projectId = thread?.projectId ?? null;
  const openProjectScreen =
    projectId === null
      ? undefined
      : () => navigation.navigate("Project", { environmentId, projectId });
  const openSourceControl =
    projectId === null || project === null || isChatProject(project)
      ? undefined
      : () =>
          navigation.navigate("ProjectSourceControl", {
            environmentId,
            projectId,
            ...(worktree?.id ? { worktreeId: worktree.id } : {}),
          });
  // The workspace tools of a real checkout (a project-less chat has no repository).
  const checkoutParams =
    openSourceControl === undefined || projectId === null
      ? null
      : { environmentId, projectId, ...(worktree?.id ? { worktreeId: worktree.id } : {}) };
  const serverCapabilities = environmentServerConfig?.environment.capabilities;
  const workspaceTools = {
    findInFiles:
      headerModel?.filesVisible === true && serverCapabilities?.projectContentSearch === true,
    scripts: headerModel?.terminalVisible === true && project !== null,
    servers:
      serverCapabilities?.threadLocalServers === true ||
      environmentServerConfig?.nodeBrowser?.available === true,
    notes: checkoutParams !== null && serverCapabilities?.worktreeNotes === true,
    devices:
      threadDeviceState !== null && threadDeviceState.availability.kind !== "unsupported-platform",
  };
  const openExplorer =
    checkoutParams === null
      ? undefined
      : () =>
          navigation.navigate("ProjectExplorer", {
            environmentId: checkoutParams.environmentId,
            projectId: checkoutParams.projectId,
          });
  const openPullRequest =
    projectId !== null && headerModel?.pullRequestNumber != null
      ? () =>
          navigation.navigate("ProjectPullRequest", {
            environmentId,
            projectId,
            number: String(headerModel.pullRequestNumber),
          })
      : undefined;
  const latestForkableReply = (threadMessages ?? []).findLast((message) =>
    forkableMessageIds.has(message.id),
  );
  const mutationBusy = actionBusy || cachedView.actionsDisabled;

  const stopTurn = () => {
    // Stop means stop: hold the queue before the turn can settle, and undo only if the
    // interrupt never reached the server. A node that keeps the follow-up queue holds its own
    // in the same batch.
    const held = holdThreadOutboxForInterrupt(
      outboxThreadKey,
      selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId))?.session
        ?.activeTurnId ?? null,
    );
    const holdQueue = serverFollowUpQueueSupported;
    void runAction(async () => {
      try {
        await interruptThreadTurn(ensureEnvironmentApi(environmentId), threadId, { holdQueue });
      } catch (error) {
        held.undo();
        throw error;
      }
      offerToStopDelegatedTasks(environmentId, threadId);
    });
  };
  const compactNow = () => {
    if (!headerModel?.compactAction || headerModel.compactAction.disabled) return;
    // Readiness is captured at the tap, as for a send: a connection that changes before the
    // turn is sent refuses it rather than compacting on another shell.
    const assertMutationReady = captureReviewedSendReadiness(
      environmentId,
      () => createMobileConnectionRegistry().driver.supervisor.read(environmentId),
      "The connection changed. Reconnect and try again.",
    );
    void runAction(() =>
      compactThreadNow(ensureEnvironmentApi(environmentId), threadId, assertMutationReady),
    );
  };
  const toggleSettlement = () => {
    const action = headerModel?.settlementAction;
    if (!action || action.disabled) return;
    void runSidebarAction(() =>
      setThreadSettled(
        ensureEnvironmentApi(environmentId),
        threadId,
        action.kind === "settle",
        (command) => sidebarUndo.dispatch({ environmentId, threadId }, command),
      ),
    );
  };
  const toggleArchive = () =>
    void runSidebarAction(async () => {
      const shouldArchive = thread?.archivedAt === null;
      await setThreadArchived(
        ensureEnvironmentApi(environmentId),
        threadId,
        shouldArchive,
        (command) =>
          command.type === "thread.archive"
            ? sidebarUndo.archive({ environmentId, threadId }, command.commandId, {
                currentRoute: () => {
                  const state = navigation.getState();
                  return state?.routes[state.index]?.key ?? null;
                },
                shouldLeave: () => navigation.canGoBack(),
                leave: async () => {
                  const state = navigation.getState();
                  const fallbackKey = state?.routes[state.index - 1]?.key ?? null;
                  navigation.goBack();
                  return fallbackKey;
                },
                reopen: () => navigation.navigate("Thread", { environmentId, threadId }),
              })
            : sidebarUndo.dispatch({ environmentId, threadId }, command),
      );
    });
  // Android has no native text prompt: its rename is a small sheet (kept per chat, like the others).
  const [renameSheetFor, setRenameSheetFor] = useState<string | null>(null);
  const renameSheetVisible = renameSheetFor === outboxThreadKey;
  const saveThreadTitle = (title: string) =>
    void runAction(() => renameThread(ensureEnvironmentApi(environmentId), threadId, title));
  const renameCurrentThread = () => {
    if (!headerModel) return;
    const current = headerModel.title;
    const save = (value: string | undefined) => {
      const title = resolveThreadRename(current, value);
      if (title !== null) saveThreadTitle(title);
    };
    if (Platform.OS === "ios") {
      Alert.prompt(
        "Rename chat",
        undefined,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Save", onPress: save },
        ],
        "plain-text",
        current,
      );
    } else {
      setRenameSheetFor(outboxThreadKey);
    }
  };
  const openSideChat = selectedModelSelection
    ? () => sideChatStore.getState().open(sideChatKey, selectedModelSelection)
    : undefined;

  const terminalSubtitle = useTerminalHeaderActivity(environmentId, threadId);
  const builtHeaderMenu = headerModel
    ? buildThreadHeaderMenu({
        model: headerModel,
        terminalSubtitle,
        sourceControlAvailable: openSourceControl !== undefined,
        deviceAvailable: devicePreview !== null,
        tools: workspaceTools,
        sideChatAvailable: openSideChat !== undefined,
        forkAvailable: latestForkableReply !== undefined,
        addTaskAvailable: thread !== undefined,
        promoteChatAvailable: thread !== undefined && project !== null && isChatProject(project),
        sessionStoppable:
          sidebarThread !== undefined &&
          listThreadLifecycleActions(sidebarThread).some((action) => action.id === "stop-session"),
        busy: mutationBusy,
      })
    : null;
  // The header model is rebuilt on every change to the thread (each streamed activity), but the
  // native header must only be rebuilt when what it shows changes: a new menu or pill while the
  // ⋯ menu is open can flicker or close it. So the menu is keyed on its content and the pill on
  // its four strings.
  const headerMenuSignature = builtHeaderMenu === null ? null : JSON.stringify(builtHeaderMenu);
  const headerMenu = useMemo(
    () =>
      headerMenuSignature === null
        ? null
        : (JSON.parse(headerMenuSignature) as ReadonlyArray<ThreadHeaderMenuSection>),
    [headerMenuSignature],
  );
  const goalRunning = thread?.latestTurn?.state === "running";
  const runGoalAction = (send: (api: EnvironmentApi) => Promise<void>) =>
    void runAction(() => send(ensureEnvironmentApi(environmentId)), "Could not update the goal");
  const clearGoal = () =>
    Alert.alert("Clear goal?", "The agent stops pursuing it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => runGoalAction((api) => clearThreadGoal(api, threadId)),
      },
    ]);
  const goalSheetActions = (goal: ThreadGoal): ThreadGoalActions => ({
    edit: () => {
      setContextSheetVisible(false);
      composerRef.current?.setText(`/goal ${goal.objective}`);
      composerRef.current?.focus();
    },
    pause: () => runGoalAction((api) => setThreadGoal(api, threadId, { status: "paused" })),
    resume: () =>
      runGoalAction((api) =>
        setThreadGoal(api, threadId, { status: "active" }, { startTurn: !goalRunning }),
      ),
    clear: clearGoal,
    // The last change again: a clear is cleared again, anything else is sent as it stands.
    retry: () =>
      goal.synchronization?.action === "clear"
        ? runGoalAction((api) => clearThreadGoal(api, threadId))
        : runGoalAction((api) =>
            setThreadGoal(
              api,
              threadId,
              {},
              { startTurn: goal.status === "active" && !goalRunning },
            ),
          ),
  });
  const pillTitle = headerModel?.title ?? null;
  const pillStatus = headerModel?.statusLabel ?? null;
  const pillProject = headerModel?.projectLabel ?? null;
  const pillWorktree = headerModel?.worktreeLabel ?? null;
  const pillGoal = threadTitlePillGoal(thread?.goal);
  const onHeaderMenuAction = (id: ThreadHeaderMenuActionId) => {
    switch (id) {
      case "files":
        return openFiles();
      case "terminal":
        return openTerminal();
      case "device":
        return openDevice();
      case "source-control":
        return openSourceControl?.();
      case "find-in-files":
        return navigation.navigate("ThreadFileSearch", { environmentId, threadId });
      case "scripts":
        return navigation.navigate("ThreadScripts", { environmentId, threadId });
      case "servers":
        return navigation.navigate("ThreadServers", { environmentId, threadId });
      case "devices":
        return navigation.navigate("ThreadDevices", { environmentId, threadId });
      case "notes":
        if (checkoutParams) navigation.navigate("ProjectNotes", checkoutParams);
        return;
      case "more-tools":
        // A submenu: its items run on their own.
        return;
      case "review":
        return openReview();
      case "pull-request":
        return openPullRequest?.();
      case "side-chat":
        return openSideChat?.();
      case "fork":
        if (latestForkableReply) openForkSheet(latestForkableReply);
        return;
      case "rename":
        return renameCurrentThread();
      case "turn-into-project":
        return navigation.navigate("ThreadPromoteChat", { environmentId, threadId });
      case "add-task":
        if (thread && headerModel) {
          openTaskCapture({
            environmentId,
            projectId: thread.projectId,
            link: { kind: "thread", threadId },
            linkLabel: `Chat: ${headerModel.title}`,
            openDetails: (taskEnvironmentId, taskId) =>
              navigation.navigate("TaskDetail", { environmentId: taskEnvironmentId, taskId }),
          });
        }
        return;
      case "copy-reference":
        if (headerModel) {
          copyTextWithHaptic(headerModel.copyReference.value, {
            target:
              headerModel.copyReference.kind === "pull-request" ? "pull request link" : "task ID",
          });
        }
        return;
      case "copy-task-id":
        if (headerModel) copyTextWithHaptic(headerModel.taskId, { target: "task ID" });
        return;
      case "stop":
        return stopTurn();
      case "compact":
        return compactNow();
      case "settlement":
        return toggleSettlement();
      case "archive":
        return toggleArchive();
      case "stop-session":
        return void runAction(
          () => stopThreadSession(ensureEnvironmentApi(environmentId), threadId),
          "Could not stop the session",
        );
      case "delete":
        return deleteCurrentThread();
    }
  };
  // A proposed plan's buttons (`ProposedPlanCard`): implement here or in a new chat, or take the
  // plan out as Markdown.
  const planTurnSettings = () =>
    thread
      ? {
          modelSelection: stagedModelSelection ?? thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          tokenMode: thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        }
      : null;
  const planSourceOf = (plan: ProposedPlan) => ({
    threadId,
    planId: plan.id,
    planMarkdown: plan.planMarkdown,
  });
  const planWorkspaceRoot = thread?.worktreePath ?? project?.cwd ?? null;
  const planIds = { newCommandId, newMessageId };
  const savePlan = (plan: ProposedPlan) => {
    const root = planWorkspaceRoot;
    if (!root) {
      Alert.alert("Can't save the plan", "This chat has no folder on its machine yet.");
      return;
    }
    const { filename, contents } = planMarkdownExport(plan.planMarkdown);
    const write = (typed: string | undefined) => {
      const relativePath = resolvePlanSavePath(typed);
      if (relativePath === null) {
        Alert.alert("Can't save there", "Use a path inside the chat's folder.");
        return;
      }
      void runAction(async () => {
        await ensureEnvironmentApi(environmentId).projects.writeFile({
          cwd: root,
          relativePath,
          contents,
        });
        Alert.alert("Plan saved", relativePath);
      }, "Could not save the plan");
    };
    if (Platform.OS === "ios") {
      Alert.prompt(
        "Save plan",
        "A path inside the chat's folder. A file already there is replaced.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Save", onPress: write },
        ],
        "plain-text",
        filename,
      );
    } else {
      // Android has no text prompt: it saves under the plan's own name, once confirmed.
      Alert.alert(
        "Save plan?",
        `As ${filename} in the chat's folder. A file already there is replaced.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Save", onPress: () => write(filename) },
        ],
      );
    }
  };
  const planHandlers: ProposedPlanCardActions = {
    implement: (plan) => {
      const settings = planTurnSettings();
      if (!settings || !thread) return;
      void runAction(
        () =>
          guardPlanImplementation(planImplementing, () =>
            implementPlanHere({
              api: ensureEnvironmentApi(environmentId),
              plan: planSourceOf(plan),
              titleSeed: thread.title,
              interactionMode: thread.interactionMode,
              setInteractionMode: (mode) =>
                setThreadInteractionMode(ensureEnvironmentApi(environmentId), threadId, mode),
              settings,
              ids: planIds,
            }),
          ),
        "Could not start the plan",
      );
    },
    implementInNewThread: (plan) => {
      const settings = planTurnSettings();
      if (!settings || !thread) return;
      const nextThreadId = newThreadId();
      void runAction(
        () =>
          guardPlanImplementation(planImplementing, async () => {
            await implementPlanInNewThread({
              api: ensureEnvironmentApi(environmentId),
              plan: planSourceOf(plan),
              newThreadId: nextThreadId,
              projectId: thread.projectId,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              settings,
              ids: planIds,
            });
            await waitForThreadInStore(environmentId, nextThreadId);
            navigation.navigate("Thread", { environmentId, threadId: nextThreadId });
          }),
        "Could not start the implementation chat",
      );
    },
    copy: (plan) =>
      copyTextWithHaptic(planMarkdownExport(plan.planMarkdown).contents, { target: "plan" }),
    save: savePlan,
    share: (plan) => {
      const { filename, contents } = planMarkdownExport(plan.planMarkdown);
      void Share.share({ message: contents, title: filename });
    },
  };
  useLayoutEffect(() => {
    planHandlersRef.current = planHandlers;
  });

  // Delete: the node trashes the chat and purges it shortly after, with its attachments and
  // terminal history.
  const deleteCurrentThread = () => {
    const title = headerModel?.title ?? "this chat";
    Alert.alert(
      `Delete "${title}"?`,
      "The chat, its attachments and its terminal history are removed for good.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void runAction(async () => {
              await trashThread(ensureEnvironmentApi(environmentId), threadId);
              goBackOrHome(navigation);
            }, "Could not delete the chat"),
        },
      ],
    );
  };

  const onHeaderMenuActionRef = useRef(onHeaderMenuAction);
  useLayoutEffect(() => {
    onHeaderMenuActionRef.current = onHeaderMenuAction;
  });

  useLayoutEffect(() => {
    const runMenuAction = (id: ThreadHeaderMenuActionId) => onHeaderMenuActionRef.current(id);
    const nativeMenuItem = (action: ThreadHeaderMenuAction) => ({
      type: "action" as const,
      label: action.title,
      icon: { type: "sfSymbol" as const, name: action.icon as never },
      ...(action.subtitle ? { description: action.subtitle } : {}),
      disabled: action.disabled ?? false,
      destructive: action.destructive ?? false,
      onPress: () => runMenuAction(action.id),
    });
    const androidMenuAction = (action: ThreadHeaderMenuAction): MenuAction => ({
      id: action.id,
      title: action.title,
      ...(action.subtitle ? { subtitle: action.subtitle } : {}),
      ...(action.children ? { subactions: action.children.map(androidMenuAction) } : {}),
      attributes: {
        disabled: action.disabled ?? false,
        destructive: action.destructive ?? false,
      },
    });
    const openContext = () => setContextSheetFor(outboxThreadKey);
    const pill =
      pillTitle === null || pillStatus === null || pillProject === null || pillWorktree === null
        ? null
        : {
            title: pillTitle,
            statusLabel: pillStatus,
            projectLabel: pillProject,
            worktreeLabel: pillWorktree,
            goal: pillGoal,
          };
    navigation.setOptions({
      title: pillTitle ?? "Task",
      headerTitle: pill ? () => <ThreadTitlePill model={pill} onPress={openContext} /> : undefined,
      ...(headerMenu === null
        ? { headerRight: undefined }
        : Platform.OS === "ios"
          ? {
              unstable_headerRightItems: (): NativeStackHeaderItem[] => [
                {
                  type: "menu",
                  label: "",
                  accessibilityLabel: "More chat actions",
                  icon: { type: "sfSymbol", name: "ellipsis" },
                  menu: {
                    items: headerMenu.map((section) => ({
                      type: "submenu" as const,
                      label: "",
                      inline: true,
                      items: section.actions.map((action) =>
                        action.children
                          ? {
                              type: "submenu" as const,
                              label: action.title,
                              icon: { type: "sfSymbol" as const, name: action.icon as never },
                              items: action.children.map((child) => nativeMenuItem(child)),
                            }
                          : nativeMenuItem(action),
                      ),
                    })),
                  },
                },
              ],
            }
          : {
              headerRight: () => (
                <MenuView
                  // One flat list: Android draws each inline group as an untitled submenu.
                  actions={flattenThreadHeaderMenu(headerMenu).map(androidMenuAction)}
                  onPressAction={({ nativeEvent }: NativeActionEvent) =>
                    runMenuAction(nativeEvent.event as ThreadHeaderMenuActionId)
                  }
                >
                  <View
                    accessibilityRole="button"
                    accessibilityLabel="More chat actions"
                    className="h-11 w-11 items-center justify-center rounded-full"
                  >
                    <SymbolView name="ellipsis" size={21} tintColor={iconColor} type="monochrome" />
                  </View>
                </MenuView>
              ),
            }),
    });
  }, [
    headerMenu,
    iconColor,
    navigation,
    outboxThreadKey,
    pillGoal,
    pillProject,
    pillStatus,
    pillTitle,
    pillWorktree,
  ]);

  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      style={{ flex: 1 }}
      className="bg-screen"
    >
      {/* One full-screen view for every page in the feed: it outlives the row that opened it. */}
      <HtmlRenderFullScreenProvider>
        <ImageGalleryProvider>
          <View className="min-h-0 flex-1">
            <LegendList
              ref={listRef}
              data={listRows}
              renderItem={renderItem}
              keyExtractor={(row) => row.id}
              alignItemsAtEnd
              initialScrollAtEnd
              // Following, the measured end is kept at once (animating estimates races row
              // measurement); reading back, the rows on screen stay put as others load.
              maintainScrollAtEnd={
                followingLatest
                  ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
                  : false
              }
              maintainVisibleContentPosition={!followingLatest}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              contentInsetAdjustmentBehavior="never"
              // The header floats over the feed: the first message starts under it (and under any
              // banner), and scrolls up beneath its glass.
              contentContainerStyle={{ paddingBottom: 10 }}
              scrollIndicatorInsets={{ top: feedTopInset }}
              // Room under the newest message whenever the floating status capsule shows.
              ListFooterComponent={
                floatingCapsuleShown ? (
                  <View style={{ height: FLOATING_CONTROL_CLEARANCE }} />
                ) : null
              }
              onStartReached={loadOlderMessages}
              onStartReachedThreshold={0.35}
              onScroll={onFeedScroll}
              onScrollBeginDrag={onFeedScrollBeginDrag}
              onScrollEndDrag={onFeedScrollSettled}
              onMomentumScrollEnd={onFeedScrollSettled}
              scrollEventThrottle={64}
              // A spacer the list measures (unlike contentContainerStyle padding), so following
              // the end and anchoring still add up.
              ListHeaderComponent={
                <>
                  <View style={{ height: feedTopInset }} />
                  {messageHistory?.hasMoreBefore || messageHistoryLoad?.status === "loading" ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={messageHistoryLoad?.status === "loading"}
                      onPress={loadOlderMessages}
                      className="items-center px-4 py-3"
                    >
                      <Text className="text-xs text-muted-foreground">
                        {messageHistoryLoad?.status === "loading"
                          ? "Loading earlier history…"
                          : messageHistoryLoad?.status === "error"
                            ? "Retry earlier history"
                            : "Load earlier history"}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              }
              ListEmptyComponent={
                launchView ? (
                  <NewTaskLaunchCard
                    view={launchView}
                    onRetry={() => {
                      let deps: ReturnType<typeof createNewTaskLaunchDeps>;
                      try {
                        deps = createNewTaskLaunchDeps(environmentId);
                      } catch {
                        // The machine is away: wait in the outbox and start once it is back.
                        requeueNewTaskLaunch(launchKey);
                        return;
                      }
                      retryNewTaskLaunch(launchKey, deps);
                    }}
                    onEdit={() => {
                      // Held from the tap on: the outbox must not start it under the edit.
                      setNewTaskLaunchEditing(launchKey, true);
                      navigation.dispatch(
                        StackActions.replace("NewTask", { editLaunchKey: launchKey }),
                      );
                    }}
                    onRemove={() => {
                      if (discardNewTaskLaunch(launchKey) && navigation.canGoBack())
                        navigation.goBack();
                    }}
                  />
                ) : (
                  <View className="px-4 py-16">
                    <EmptyState
                      variant="plain"
                      title={built ? (thread?.title ?? "Task") : "Loading task"}
                      detail={
                        cachedView.emptyStateDetail ??
                        (built
                          ? "No messages yet. Send one to get started."
                          : "Syncing the conversation from the node.")
                      }
                    />
                  </View>
                )
              }
            />
            {/* The header's glass floats over the feed: a fade under it keeps the title and
                the buttons readable while messages scroll beneath. */}
            <View
              pointerEvents="none"
              className="absolute left-0 right-0 top-0"
              style={{
                height: headerHeight + 20,
                experimental_backgroundImage: `linear-gradient(to bottom, ${screenColor} 0%, ${screenColor}f5 72%, ${screenColor}00 100%)`,
              }}
            />
            {hasBanners ? (
              <View
                pointerEvents="box-none"
                className="absolute left-0 right-0 gap-1"
                style={{ top: headerHeight + 4 }}
                onLayout={(event) => setBannerHeight(event.nativeEvent.layout.height)}
              >
                {cachedView.banner ? (
                  <ThreadCachedBanner text={cachedView.banner.text} tone={cachedView.banner.tone} />
                ) : null}
                {deliveryNotice ? (
                  <ThreadDeliveryBanner
                    notice={deliveryNotice}
                    onContinue={() =>
                      acknowledgeThreadDelivery(
                        getMobileHostedConnectionCoordinator(),
                        environmentId,
                      )
                    }
                  />
                ) : null}
                {errorBannerMessage ? <ErrorBanner message={errorBannerMessage} /> : null}
                {failedNotice ? (
                  <View
                    accessibilityRole="alert"
                    testID="thread-failed-turn-banner"
                    className="mx-4 gap-2 rounded-2xl bg-danger px-3.5 py-3"
                  >
                    <Text className="font-ryco-medium text-sm text-danger-foreground">
                      {failedNotice.title}
                    </Text>
                    {failedNotice.detail ? (
                      <Text className="text-xs text-foreground-muted" numberOfLines={4}>
                        {failedNotice.detail}
                      </Text>
                    ) : null}
                    <Text className="text-2xs text-foreground-tertiary">
                      To try another model, pick it in the composer first.
                    </Text>
                    <View className="flex-row gap-2">
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void onSend(CONTINUE_AFTER_FAILURE_PROMPT, [])}
                        className="rounded-full bg-foreground px-3 py-1.5 active:opacity-70"
                      >
                        <Text className="font-ryco-medium text-xs text-background">Continue</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setDismissedFailedTurnId(failedNotice.turnId)}
                        className="rounded-full border border-border px-3 py-1.5 active:opacity-70"
                      >
                        <Text className="font-ryco-medium text-xs text-foreground">Dismiss</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
                {restartNotice ? (
                  <ThreadCachedBanner
                    text={restartNotice}
                    tone="info"
                    testID="thread-restart-banner"
                  />
                ) : null}
              </View>
            ) : null}
            <FloatingThreadControl
              runningSince={runningSince}
              followingLatest={followingLatest}
              attention={floatingAttention}
              childAttention={childAttention}
              agents={threadAgents.entry}
              onJumpToLatest={jumpToLatest}
              onOpenThread={(target) => openThread(ThreadId.make(target))}
              onOpenAgents={threadAgents.open}
            />
          </View>
        </ImageGalleryProvider>
      </HtmlRenderFullScreenProvider>

      {hasPrompts ? (
        <ScrollView
          className="grow-0"
          style={{ maxHeight: "42%" }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingVertical: 4 }}
        >
          {pendingApprovals.map((approval) => (
            <PendingApprovalCard
              key={approval.requestId}
              environmentId={environmentId}
              threadId={threadId}
              approval={approval}
              disabled={cachedView.promptsDisabled}
            />
          ))}
          {[...pendingUserInputs, ...optionalUserInputs].map((userInput) => (
            <PendingUserInputCard
              key={userInput.userInputIdentity?.requestEventId ?? userInput.requestId}
              environmentId={environmentId}
              threadId={threadId}
              userInput={userInput}
              route={resolveOptionalAnswerRoute({ userInput, session: thread?.session })}
              onSendAsMessage={sendOptionalAnswer}
              disabled={cachedView.promptsDisabled}
            />
          ))}
          {secretRequests.requests.map((request) => (
            <SecretRequestCard
              key={request.requestId}
              environmentId={environmentId}
              threadId={threadId}
              request={request}
              disabledReason={secretRequests.access.reason}
            />
          ))}
          {pendingAgentControlProposals.map((proposal) => (
            <AgentControlProposalCard
              key={proposal.proposalId}
              environmentId={environmentId}
              proposal={proposal}
              disabled={cachedView.promptsDisabled}
            />
          ))}
        </ScrollView>
      ) : null}

      <ThreadQueuedMessages
        steerRestarts={activeProviderSteering === "restart"}
        rows={queueView.rows}
        localMessages={localQueuedMessages}
        hold={queueView.hold}
        onResume={() => {
          const hold = queueView.hold;
          if (queueView.holdSource === "server" && hold) {
            void runServerQueueCommand((base) =>
              buildFollowUpQueueResumeCommand({ ...base, hold }),
            );
            return;
          }
          releaseThreadOutboxHold(outboxThreadKey);
          runOutboxDrain();
        }}
        {...(queueView.rows.some((row) => row.source === "server")
          ? {
              onPause: () =>
                void runServerQueueCommand((base) => buildFollowUpQueuePauseCommand(base)),
            }
          : {})}
        onRetryReview={(messageId) => {
          retryThreadOutboxReview(messageId);
          runOutboxDrain();
        }}
        onRetryHeld={(messageId) => {
          retryThreadOutboxMessage(messageId);
          runOutboxDrain();
        }}
        onRetry={(row) =>
          void runServerQueueCommand((base) =>
            buildFollowUpQueueRetryCommand({ ...base, messageId: MessageId.make(row.id) }),
          )
        }
        getSteerUnavailableReason={getQueuedRowSteerUnavailableReason}
        onSteer={steerQueuedRow}
        onRemove={removeQueuedRow}
        getEditUnavailableReason={getQueuedRowEditUnavailableReason}
        onEdit={editQueuedRow}
        {...(serverFollowUpQueueSupported
          ? {
              onMove: (row: FollowUpQueueRow, direction: "up" | "down") =>
                void runServerQueueCommand((base) =>
                  buildFollowUpQueueMoveCommand({
                    ...base,
                    entries:
                      selectThreadFollowUpQueue(
                        useStore.getState(),
                        scopeThreadRef(environmentId, threadId),
                      )?.entries ?? [],
                    messageId: MessageId.make(row.id),
                    direction,
                  }),
                ),
            }
          : {})}
        editingId={activeServerQueueEdit?.messageId ?? null}
        {...(activeServerQueueEdit === null
          ? {}
          : {
              editingAttachments: followUpQueueEditAttachments(
                activeServerQueueEdit,
                serverFollowUpQueue?.entries.find(
                  (entry) => entry.messageId === activeServerQueueEdit.messageId,
                ),
              ),
              ...(savingServerQueueEdit === activeServerQueueEdit
                ? {}
                : {
                    onDropEditingAttachment: (attachmentId: string) =>
                      setServerQueueEdit((current) =>
                        current === activeServerQueueEdit
                          ? withoutFollowUpQueueEditAttachment(current, attachmentId)
                          : current,
                      ),
                  }),
            })}
        onCancelEdit={cancelServerQueueEdit}
      />

      {sideChat ? (
        <SideChatCard
          {...sideChat}
          serverConfig={serverConfig}
          disabled={!sideChatReady}
          onOpen={() => sideChatStore.getState().open(sideChatKey, sideChat.modelSelection)}
          onClose={() => sideChatStore.getState().close(sideChatKey)}
          onDraftChange={(text) => sideChatStore.getState().setDraft(sideChatKey, text)}
          onRestoreFailedQuestion={() =>
            sideChatStore.getState().restoreFailedQuestion(sideChatKey)
          }
          onDiscardFailedQuestion={() =>
            sideChatStore.getState().discardFailedQuestion(sideChatKey)
          }
          onModelChange={(selection) => sideChatStore.getState().setModel(sideChatKey, selection)}
          onSend={sendSideQuestion}
          onCancel={() => sideChatStore.getState().cancel(sideChatKey)}
          onClear={() => sideChatStore.getState().clear(sideChatKey)}
        />
      ) : null}

      {thread?.usageLimit ? (
        <ThreadUsageLimitBanner
          key={outboxThreadKey}
          environmentId={environmentId}
          thread={thread}
          dispatchAllowed={
            connectionUiState === "connected" &&
            (environmentRow?.mutationReady ?? false) &&
            !cachedView.actionsDisabled
          }
          canSnooze={usageLimitSnoozeEligible}
        />
      ) : null}

      <ThreadDevicePill environmentId={environmentId} threadId={threadId} onOpen={openDevice} />

      <ThreadComposer
        ref={composerRef}
        goalAvailable={thread !== undefined}
        onOpenSideChat={
          selectedModelSelection
            ? () => sideChatStore.getState().open(sideChatKey, selectedModelSelection)
            : undefined
        }
        onSend={onSend}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onPickAttachments={(source) => void pickAttachments(source)}
        onPasteImages={(uris) => void pasteImages(uris)}
        onRetryFileUpload={retryFileUpload}
        onReattachFile={reattachFile}
        attachmentError={attachmentError}
        sendBlock={sendBlock}
        fileUploadRecords={fileUploadRecords}
        // Nothing to send into until the node has created the launched task.
        disabled={cachedView.composerDisabled || (launchView !== null && !thread)}
        {...(sendRedirectsApprovals ? { placeholder: APPROVAL_REDIRECT_PLACEHOLDER } : {})}
        policyModel={policyModel}
        policyDisabled={policyBusy || cachedView.actionsDisabled}
        modelPicker={modelPicker}
        modelSelection={selectedModelSelection}
        fastModeNotice={fastModeNotice}
        {...(cacheSummary !== null ? { onOpenCacheInfo: () => setCacheSheetVisible(true) } : {})}
        onSelectModel={(selection) => {
          if (policyBusy || cachedView.actionsDisabled) return;
          const entry = (modelPicker ? listModelPickerEntries(modelPicker) : []).find(
            (candidate) =>
              candidate.selection.instanceId === selection.instanceId &&
              candidate.selection.model === selection.model,
          );
          if (entry && !entry.disabled) stageModelSelection(selection);
        }}
        onSelectRuntimeMode={(value) => {
          if (!policyModel || policyBusy || cachedView.actionsDisabled) return;
          const next = resolveSessionPolicySelection(policyModel.access, value);
          if (next)
            void applyPolicy(() =>
              setThreadRuntimeMode(ensureEnvironmentApi(environmentId), threadId, next),
            );
        }}
        onSelectInteractionMode={(value) => {
          if (!policyModel?.mode || policyBusy || cachedView.actionsDisabled) return;
          const next = resolveSessionPolicySelection(policyModel.mode, value);
          if (next)
            void applyPolicy(() =>
              setThreadInteractionMode(ensureEnvironmentApi(environmentId), threadId, next),
            );
        }}
        pendingHandoff={pendingHandoff}
        commandMenuContext={{
          environmentId,
          workspaceRoot,
          serverConfig,
          providerInstanceId: selectedModelSelection?.instanceId ?? null,
          currentThreadId: threadId,
        }}
        onComposerIntent={() =>
          void prewarmThreadProviderSession({
            environmentId,
            threadId,
            modelSelection: selectedModelSelection,
            mutationReady: environmentRow?.mutationReady ?? false,
          })
        }
      />

      {headerModel ? (
        <ThreadContextSheet
          goal={
            thread?.goal
              ? {
                  goal: thread.goal,
                  busy: mutationBusy,
                  actions: goalSheetActions(thread.goal),
                }
              : null
          }
          visible={contextSheetVisible}
          onClose={() => setContextSheetVisible(false)}
          environmentId={environmentId}
          model={headerModel}
          runningSince={runningSince}
          checks={checks}
          cacheSummary={cacheSummary}
          parent={parentLink}
          delegated={delegatedRows}
          agents={threadAgents.entry}
          pullRequestWatch={pullRequestWatch}
          agentControlReceipts={settledAgentControlProposals}
          actions={{
            openMachines: () => navigation.navigate("Connections"),
            openProject: openProjectScreen,
            openExplorer,
            openSourceControl,
            openFiles: headerModel.filesVisible ? openFiles : undefined,
            openTerminal: headerModel.terminalVisible ? openTerminal : undefined,
            openReview: headerModel.reviewVisible ? openReview : undefined,
            openPullRequest,
            openCacheInfo: cacheSummary === null ? undefined : () => setCacheSheetVisible(true),
            openAgents: threadAgents.open,
            openThread: (target) => openThread(ThreadId.make(target)),
          }}
        />
      ) : null}
      {headerModel ? (
        <ThreadRenameSheet
          visible={renameSheetVisible}
          currentTitle={headerModel.title}
          onClose={() => setRenameSheetFor(null)}
          onSave={saveThreadTitle}
        />
      ) : null}
      <ClaudeCacheSheet
        visible={cacheSheetVisible}
        observation={claudeCacheObservation}
        onClose={() => setCacheSheetVisible(false)}
      />
      {threadAgents.sheet}

      {forkSheet ? (
        <ForkDestinationSheet
          sheet={forkSheet}
          source={forkSheetSource}
          ready={forkOffered}
          onClose={closeForkSheet}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

/**
 * A Stop ends this chat's turn and the automatic return of its delegated results, but its
 * delegated tasks keep working. Offer to stop those too, deepest first, each like a Stop of
 * its own chat (its outbox holds).
 */
function offerToStopDelegatedTasks(environmentId: EnvironmentId, threadId: ThreadId): void {
  const working = selectWorkingDelegatedDescendants(
    useStore.getState(),
    scopeThreadRef(environmentId, threadId),
  );
  if (working.length === 0) return;
  const count = working.length;
  Alert.alert(
    "Stopped",
    count === 1
      ? "A task this chat delegated is still working."
      : `${count} tasks this chat delegated are still working.`,
    [
      { text: "Keep it running", style: "cancel" },
      {
        text: count === 1 ? "Stop it too" : "Stop them too",
        style: "destructive",
        onPress: () => {
          void (async () => {
            let failed = 0;
            for (const ref of working) {
              const held = holdThreadOutboxForInterrupt(
                scopedThreadKey(ref),
                selectThreadByRef(useStore.getState(), ref)?.session?.activeTurnId ?? null,
              );
              try {
                await interruptThreadTurn(ensureEnvironmentApi(ref.environmentId), ref.threadId);
              } catch {
                held.undo();
                failed += 1;
              }
            }
            if (failed > 0) {
              Alert.alert(
                failed === 1
                  ? "A task could not be stopped"
                  : `${failed} tasks could not be stopped`,
                "Open the task to stop it there.",
              );
            }
          })();
        },
      },
    ],
  );
}
