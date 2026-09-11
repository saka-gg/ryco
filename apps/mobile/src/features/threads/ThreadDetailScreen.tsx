import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
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
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  deriveProviderSelectionPolicy,
  getProviderInteractionModeToggle,
  getProviderSupportsAskMode,
  normalizeInteractionModeForProviderTarget,
  selectionAllowedAtSendBoundary,
} from "@ryco/client-runtime/state/composer";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { TimelineEntry } from "@ryco/client-runtime/state/session";
import {
  buildQueuedMessageSteerCommand,
  getQueuedThreadKeys,
  resolveQueuedMessageSteerEligibility,
} from "@ryco/client-runtime/state/message-queue";
import { buildThreadInbox } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId, type ModelSelection } from "@ryco/contracts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  deriveChatFileUploadSendBlock,
} from "@ryco/client-runtime/state/composer";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView } from "../../components/AppSymbol";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import {
  loadOlderThreadMessages,
  retainThreadDetailSubscription,
} from "../../connection/threadDetail";
import { useThreadConnectionRetarget } from "../../connection/useThreadConnectionRetarget";
import type { DraftComposerAttachment, DraftComposerFileAttachment } from "../../lib/composerFiles";
import {
  isDraftComposerFileAttachment,
  pickComposerAttachments,
  readComposerFileBytes,
} from "../../lib/composerFiles";
import { convertPastedImagesToAttachments } from "../../lib/composerImages";
import { newCommandId, newMessageId } from "../../lib/ids";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  selectAgentControlProposalsForThread,
  useAgentControlStore,
} from "../../state/agentControlRuntime";
import { useAgentControlSync } from "../../state/agentControlSync";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useMessageQueueStore } from "../../state/messageQueueStore";
import { usePreferences } from "../../state/preferencesStore";
import {
  useWsConnectionStatusForEnvironment,
  wsUiStateForEnvironment,
} from "../../rpc/wsConnectionState";
import {
  enqueueThreadOutboxMessage,
  listThreadOutboxMessages,
  removeThreadOutboxMessage,
  subscribeThreadOutbox,
} from "../../state/threadOutbox";
import { buildQueuedThreadMessageAttachments } from "../../state/queuedThreadMessageAttachments";
import type { QueuedThreadMessage } from "../../state/threadOutboxModel";
import { modelSelectionsEqual } from "../../state/threadOutboxModel";
import { useThreadTimeline } from "../../state/threadTimeline";
import {
  selectEnvironmentHydratedFromCacheAt,
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  useStore,
} from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { AgentControlProposalCard } from "./AgentControlProposalCard";
import { executeSendTurn } from "./executeSendTurn";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { sendThreadTurn } from "./sendThreadTurn";
import {
  interruptThreadTurn,
  renameThread,
  setThreadArchived,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  setThreadSettled,
} from "./sessionActions";
import { useThreadChecks } from "./useThreadChecks";
import { buildThreadTimelineRows, toggleFold, type ThreadTimelineRow } from "./threadActivityFold";
import { ThreadActivityFoldRow } from "./ThreadActivityFoldRow";
import {
  composerFileUploadEngine,
  useComposerFileUploadMaxBytes,
  useComposerFileUploadRecords,
} from "../../state/composerFileUpload";
import {
  applyModelOption,
  buildModelPickerModel,
  resolveModelPickerSelection,
} from "./modelPickerModel";
import { ModelPickerSheet } from "./ModelPickerSheet";
import { buildSessionPolicyModel, resolveSessionPolicySelection } from "./sessionPolicyModel";
import { SessionPolicySheet } from "./SessionPolicySheet";
import { ThreadActionsSheet } from "./ThreadActionsSheet";
import { ThreadComposer } from "./ThreadComposer";
import { deriveThreadCachedView } from "./threadCachedViewModel";
import { ThreadQueuedMessages } from "./ThreadQueuedMessages";
import { ThreadContextBar } from "./ThreadContextBar";
import {
  buildThreadHeaderModel,
  findThreadWorktree,
  type ThreadHeaderModel,
} from "./threadHeaderModel";
import { ThreadMessage } from "./ThreadMessage";
import { proposedPlanPresentation } from "./threadPresentation";
import { ContextHandoffMarkerRow } from "./ContextHandoffMarkerRow";
import { derivePendingContextHandoff } from "./contextHandoffModel";

function TimelineRow(props: { readonly entry: TimelineEntry }) {
  const { entry } = props;
  if (entry.kind === "message") {
    return <ThreadMessage message={entry.message} />;
  }
  if (entry.kind === "proposed-plan") {
    const presentation = proposedPlanPresentation();
    return (
      <View className={`mx-4 my-2 rounded-2xl p-4 ${presentation.containerClassName}`}>
        <Text
          className={`text-xs font-ryco-bold uppercase tracking-wide ${presentation.labelClassName}`}
        >
          Proposed plan
        </Text>
        <Text className="mt-1 font-sans text-sm text-foreground" selectable>
          {entry.proposedPlan.planMarkdown}
        </Text>
      </View>
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
  // Work entries never reach here — buildThreadTimelineRows folds them before
  // the list sees them. This is the remaining unknown-kind fallback.
  return null;
}

/**
 * The cached / degraded strip. Sits with ErrorBanner between the context bar
 * and the timeline, and carries the context bar's `mx-4` so the three read as
 * one column. Copy and tone are decided in threadCachedViewModel.ts.
 */
function ThreadCachedBanner(props: { readonly text: string; readonly tone: "info" | "warning" }) {
  const warning = props.tone === "warning";
  return (
    <View
      accessibilityRole="alert"
      testID="thread-cached-banner"
      className={`mx-4 mb-1 rounded-2xl border px-3.5 py-3 ${
        warning ? "border-warning-border bg-warning-bg" : "border-border bg-card-translucent"
      }`}
    >
      <Text
        className={`font-ryco-medium text-sm ${warning ? "text-warning" : "text-foreground-muted"}`}
      >
        {props.text}
      </Text>
    </View>
  );
}

function HeaderActions(props: {
  readonly model: ThreadHeaderModel;
  readonly iconColor: string;
  readonly onReview: () => void;
  readonly onFiles: () => void;
  readonly onMore: () => void;
}) {
  return (
    <View className="flex-row items-center gap-1">
      {props.model.reviewVisible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Review changes"
          onPress={props.onReview}
          className="h-11 items-center justify-center rounded-full px-3 active:bg-subtle-strong"
        >
          <Text className="text-sm font-ryco-bold text-foreground">Review</Text>
        </Pressable>
      ) : null}
      {props.model.filesVisible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open files"
          onPress={props.onFiles}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle-strong"
        >
          <SymbolView name="folder" size={21} tintColor={props.iconColor} type="monochrome" />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More task actions"
        onPress={props.onMore}
        className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle-strong"
      >
        <SymbolView name="ellipsis" size={21} tintColor={props.iconColor} type="monochrome" />
      </Pressable>
    </View>
  );
}

export function ThreadDetailScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const iconColor = String(useThemeColor("--color-icon"));
  const preferences = usePreferences();
  const [settlementNowMs, setSettlementNowMs] = useState(() => Date.now());
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [policyVisible, setPolicyVisible] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [modelVisible, setModelVisible] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [stagedModelSelection, setStagedModelSelection] = useState<ModelSelection | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerAttachment>>([]);
  const ownedUploadIds = useRef(new Set<string>());
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [steeringMessageIds, setSteeringMessageIds] = useState<ReadonlySet<string>>(
    () => new Set(),
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
    return retainThreadDetailSubscription(environmentId, threadId);
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
  const pendingApprovals = built?.viewModel.pendingApprovals ?? [];
  const pendingUserInputs = built?.viewModel.pendingUserInputs ?? [];
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
  const worktree = useMemo(
    () => (thread ? findThreadWorktree(thread, worktrees) : null),
    [thread, worktrees],
  );
  const environmentRow =
    environments.find((environment) => environment.environmentId === environmentId) ?? null;
  const nodeLabel = environmentRow?.label ?? null;
  const settlementModel = useMemo(() => {
    if (!sidebarThread || !environmentRow) return null;
    return buildThreadInbox({
      projects: project ? [project] : [],
      worktrees,
      threads: [sidebarThread],
      environments: [
        {
          environmentId,
          label: environmentRow.label,
          threadSettlementSupported: environmentRow.threadSettlementSupported ?? false,
          connected: environmentRow.connectionState === "connected",
          mutationReady: environmentRow.mutationReady ?? false,
          shellCurrent: environmentRow.shellCurrent ?? false,
        },
      ],
      localQueuedThreadKeys: getQueuedThreadKeys(queuesByThreadKey),
      autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays ?? null,
      nowMs: Math.max(settlementNowMs, Date.now()),
    });
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
  const settlementEntry =
    settlementModel?.active[0] ??
    settlementModel?.settled[0] ??
    settlementModel?.snoozed[0] ??
    null;
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
  const headerModel = useMemo(
    () =>
      thread
        ? buildThreadHeaderModel({
            thread,
            project,
            worktree,
            nodeLabel,
            hasPendingApproval: pendingApprovals.length > 0,
            hasPendingUserInput: pendingUserInputs.length > 0,
            forcedOffline: cachedView.headerForcedOffline,
            ...(settlementEntry
              ? {
                  settlement: {
                    attentionState:
                      settlementEntry.lifecycle.classification === "snoozed"
                        ? "active"
                        : settlementEntry.lifecycle.classification,
                    canSettle: settlementEntry.lifecycle.eligibility.canSettle,
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
      settlementEntry,
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
  const canonicalModelSelection = thread?.modelSelection ?? project?.defaultModelSelection ?? null;
  const selectedModelSelection = stagedModelSelection ?? canonicalModelSelection;
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
    hasQueuedMessage: queuedMessages.length > 0,
    isRevertingCheckpoint: actionBusy,
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
            mutationBlockedReason: thread.archivedAt !== null ? "This task is archived." : null,
          })
        : null,
    [providers, thread, threadProviderDriver],
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
            query: modelQuery,
          })
        : null,
    [
      canonicalModelSelection?.instanceId,
      modelQuery,
      providerSelectionPolicy.mode,
      selectedModelSelection,
      serverConfig,
      thread,
    ],
  );
  const pendingContextHandoff = useMemo(
    () =>
      selectedModelSelection
        ? derivePendingContextHandoff({
            threadStarted,
            canonicalSelection: canonicalModelSelection,
            targetSelection: selectedModelSelection,
            serverConfig,
          })
        : null,
    [canonicalModelSelection, selectedModelSelection, serverConfig, threadStarted],
  );

  const getSteerEligibility = useCallback(
    (message: QueuedThreadMessage) => {
      const activeSelection = thread?.modelSelection ?? project?.defaultModelSelection;
      const providerInstanceId = thread?.session?.providerInstanceId ?? activeSelection?.instanceId;
      const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
      return resolveQueuedMessageSteerEligibility({
        // A cache-provenance thread reads `turnRunning` from a snapshot; a
        // steer dispatched against it targets a turn state the node may have
        // left long ago. Not mutation-ready until the live snapshot lands.
        mutationReady: connectionUiState === "connected" && hydratedFromCacheAt === null,
        turnRunning: thread?.latestTurn?.state === "running",
        activeTurnId: thread?.session?.activeTurnId,
        supportsTurnSteering: provider?.supportsTurnSteering === true,
        queuedModelSelection: message.modelSelection,
        activeModelSelection: activeSelection,
        queuedRuntimeMode: message.runtimeMode,
        activeRuntimeMode: thread?.runtimeMode,
        queuedInteractionMode: message.interactionMode,
        activeInteractionMode: thread?.interactionMode,
        queuedTokenMode: message.tokenMode,
        activeTokenMode: thread?.tokenMode ?? "balanced",
      });
    },
    [connectionUiState, hydratedFromCacheAt, project?.defaultModelSelection, providers, thread],
  );

  const getSteerUnavailableReason = useCallback(
    (message: QueuedThreadMessage): string | null => {
      const eligibility = getSteerEligibility(message);
      return eligibility.allowed ? null : eligibility.reason;
    },
    [getSteerEligibility],
  );

  const steerQueuedMessage = useCallback(
    async (message: QueuedThreadMessage) => {
      const eligibility = getSteerEligibility(message);
      if (!eligibility.allowed) {
        setSendError(eligibility.reason);
        return;
      }
      setSendError(null);
      setSteeringMessageIds((current) => new Set(current).add(message.messageId));
      try {
        const attachments = await buildQueuedThreadMessageAttachments(message);
        const requestedAt = new Date().toISOString();
        await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand(
          buildQueuedMessageSteerCommand({
            commandId: newCommandId(),
            threadId,
            expectedTurnId: eligibility.expectedTurnId,
            messageId: MessageId.make(message.messageId),
            text: message.text.trim() || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            attachments,
            createdAt: message.createdAt,
            requestedAt,
          }),
        );
      } catch (error) {
        setSteeringMessageIds((current) => {
          const next = new Set(current);
          next.delete(message.messageId);
          return next;
        });
        setSendError(error instanceof Error ? error.message : "The steer request failed.");
      }
    },
    [environmentId, getSteerEligibility, threadId],
  );

  useEffect(() => {
    if (!thread || steeringMessageIds.size === 0) return;
    const projectedIds = new Set(thread.messages.map((message) => String(message.id)));
    const rejected = new Map<string, string>();
    for (const activity of thread.activities) {
      if (activity.kind !== "provider.turn.steer.failed" || !activity.payload) continue;
      const payload = activity.payload as {
        messageId?: unknown;
        error?: unknown;
      };
      if (typeof payload.messageId === "string") {
        rejected.set(
          payload.messageId,
          typeof payload.error === "string" ? payload.error : "The provider rejected steering.",
        );
      }
    }
    let rejectionMessage: string | null = null;
    for (const messageId of steeringMessageIds) {
      if (projectedIds.has(messageId)) {
        removeThreadOutboxMessage(messageId);
      } else if (rejected.has(messageId)) {
        rejectionMessage = rejected.get(messageId) ?? null;
      }
    }
    setSteeringMessageIds((current) => {
      const next = new Set(current);
      for (const messageId of current) {
        if (projectedIds.has(messageId) || rejected.has(messageId)) next.delete(messageId);
      }
      return next.size === current.size ? current : next;
    });
    if (rejectionMessage) setSendError(rejectionMessage);
  }, [steeringMessageIds, thread]);

  const applyPolicy = useCallback(async (apply: () => Promise<void>) => {
    setPolicyBusy(true);
    setSendError(null);
    try {
      await apply();
    } catch (error) {
      // Never fail silently: a policy change that did not land would otherwise
      // leave the pill showing a setting the node never received.
      setSendError(
        error instanceof Error ? error.message : "The session policy change did not apply.",
      );
    } finally {
      setPolicyBusy(false);
    }
  }, []);

  const stageModelSelection = useCallback(
    (next: ModelSelection) => {
      setStagedModelSelection(next);
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
    [applyPolicy, environmentId, providers, thread, threadId],
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

  useLayoutEffect(() => {
    navigation.setOptions({
      title: headerModel?.title ?? "Task",
      headerRight: headerModel
        ? () => (
            <HeaderActions
              model={headerModel}
              iconColor={iconColor}
              onReview={openReview}
              onFiles={openFiles}
              onMore={() => {
                setActionError(null);
                setActionsVisible(true);
              }}
            />
          )
        : undefined,
    });
  }, [headerModel, iconColor, navigation, openFiles, openReview]);

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

  const pickAttachments = useCallback(async () => {
    setAttachmentError(null);
    const existingTotalBytes = attachments.reduce((total, attachment) => {
      if (attachment.type === "file" && attachment.uploadState === "needsReattach") return total;
      return total + attachment.sizeBytes;
    }, 0);
    const result = await pickComposerAttachments({
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
  }, [attachments, enqueueFileUpload, fileUploadMaxBytes]);

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
      void pickAttachments();
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

  const onSend = async (
    text: string,
    attachments: ReadonlyArray<DraftComposerAttachment>,
  ): Promise<boolean> => {
    setSendError(null);
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
    const canonicalSelection =
      currentThread.modelSelection ?? currentProject?.defaultModelSelection ?? null;
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

    const tokenMode = currentThread.tokenMode ?? "balanced";
    const threadBusy = currentThread.latestTurn?.state === "running";
    // Wave 3a: the socket opens one RTT before the live shell snapshot lands,
    // and until it does `threadBusy` is read from a CACHED latestTurn — the
    // same window wave 2's review closed for the outbox drain. A send inside
    // it must enqueue, never dispatch into a thread whose real turn state is
    // unknown; read provenance fresh from the store, not from a render.
    const deliveryReconciled =
      selectEnvironmentHydratedFromCacheAt(useStore.getState(), environmentId) === null;
    const connected = connectionUiState === "connected" && deliveryReconciled;

    setSendBusy(true);
    try {
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
        },
        {
          newMessageId,
          newCommandId,
          now: () => new Date().toISOString(),
          enqueue: enqueueThreadOutboxMessage,
          dispatch: () =>
            executeSendTurn({
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
                defaultModel: currentProject?.defaultModelSelection?.model ?? modelSelection.model,
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
      // here, so a delivered turn (dispatch or safe enqueue) clears them too.
      if (sent !== false) {
        setAttachments([]);
        setAttachmentError(null);
      }
      return sent;
    } finally {
      setSendBusy(false);
    }
  };

  const runAction = async (action: () => Promise<void>, closeAfter = true) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
      if (closeAfter) setActionsVisible(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The task action failed.");
    } finally {
      setActionBusy(false);
    }
  };

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

  const renderItem = ({ item }: LegendListRenderItemProps<ThreadTimelineRow>) =>
    item.kind === "activity-fold" ? (
      <ThreadActivityFoldRow
        fold={item}
        onToggle={() => setExpandedFoldIds((current) => toggleFold(current, item))}
      />
    ) : (
      <TimelineRow entry={item.entry} />
    );
  const visibleError = sendError ?? thread?.error ?? null;
  const hasPrompts =
    pendingApprovals.length > 0 || pendingUserInputs.length > 0 || agentControlProposals.length > 0;

  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      style={{ flex: 1, paddingTop: headerHeight }}
      className="bg-screen"
    >
      {headerModel ? (
        <ThreadContextBar
          environmentId={environmentId}
          model={headerModel}
          checks={checks}
          onPress={() => {
            setActionError(null);
            setActionsVisible(true);
          }}
        />
      ) : null}
      {cachedView.banner ? (
        <ThreadCachedBanner text={cachedView.banner.text} tone={cachedView.banner.tone} />
      ) : null}
      {visibleError ? <ErrorBanner message={visibleError} /> : null}

      <LegendList
        data={timelineRows}
        renderItem={renderItem}
        keyExtractor={(row) => row.id}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd={{
          animated: true,
          on: { dataChange: true, itemLayout: true },
        }}
        maintainVisibleContentPosition
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingVertical: 10 }}
        onStartReached={loadOlderMessages}
        onStartReachedThreshold={0.35}
        ListHeaderComponent={
          messageHistory?.hasMoreBefore || messageHistoryLoad?.status === "loading" ? (
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
          ) : null
        }
        ListEmptyComponent={
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
        }
      />

      {hasPrompts ? (
        <ScrollView
          className="grow-0 border-t border-border"
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
          {pendingUserInputs.map((userInput) => (
            <PendingUserInputCard
              key={userInput.requestId}
              environmentId={environmentId}
              threadId={threadId}
              userInput={userInput}
              disabled={cachedView.promptsDisabled}
            />
          ))}
          {agentControlProposals.map((proposal) => (
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
        messages={queuedMessages}
        steeringIds={steeringMessageIds}
        getSteerUnavailableReason={getSteerUnavailableReason}
        onSteer={(message) => void steerQueuedMessage(message)}
        onRemove={(messageId) => {
          removeThreadOutboxMessage(messageId);
          setSteeringMessageIds((current) => {
            if (!current.has(messageId)) return current;
            const next = new Set(current);
            next.delete(messageId);
            return next;
          });
        }}
      />

      <ThreadComposer
        onSend={onSend}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onPickAttachments={() => void pickAttachments()}
        onPasteImages={(uris) => void pasteImages(uris)}
        onRetryFileUpload={retryFileUpload}
        onReattachFile={reattachFile}
        attachmentError={attachmentError}
        sendBlock={sendBlock}
        fileUploadRecords={fileUploadRecords}
        disabled={cachedView.composerDisabled}
        policyLabel={policyModel?.pillLabel}
        policyIcon={policyModel?.pillIcon}
        policyCaution={policyModel?.pillTone === "caution"}
        policyAccessibilityLabel={policyModel?.pillAccessibilityLabel}
        // `policyDisabled` gates both rail pills. The labels stay readable —
        // they are the thread's own configuration — but neither sheet can be
        // opened, because every write behind them goes through
        // ensureEnvironmentApi, which THROWS when the environment has no
        // connection. Disabling the pressables is the fix; catching the throw
        // would only turn a crash into an internal error string.
        policyDisabled={policyBusy || cachedView.actionsDisabled}
        onOpenPolicy={policyModel ? () => setPolicyVisible(true) : undefined}
        modelLabel={modelPicker?.pillLabel}
        modelProviderDriver={modelPicker?.pillProviderDriver}
        modelAccessibilityLabel={modelPicker?.pillAccessibilityLabel}
        modelReasoningLabel={modelPicker?.pillReasoningLabel}
        modelFastEnabled={modelPicker?.pillFastEnabled}
        onOpenModel={modelPicker ? () => setModelVisible(true) : undefined}
        pendingContextHandoff={pendingContextHandoff}
      />

      {modelPicker ? (
        <ModelPickerSheet
          visible={modelVisible}
          model={modelPicker}
          query={modelQuery}
          onChangeQuery={setModelQuery}
          onClose={() => {
            setModelVisible(false);
            setModelQuery("");
          }}
          onSelectOption={(optionId, value) => {
            // Options ride on the ModelSelection, so changing reasoning or fast
            // mode is the same write as changing the model itself.
            const current = selectedModelSelection;
            if (!current) return;
            const capabilities =
              modelPicker.groups.flatMap((group) => group.entries).find((entry) => entry.selected)
                ?.capabilities ?? null;
            const next = applyModelOption(current, capabilities, optionId, value);
            stageModelSelection(next);
          }}
          onSelect={(key) => {
            const next = resolveModelPickerSelection(modelPicker, key);
            if (!next) return;
            setModelVisible(false);
            setModelQuery("");
            stageModelSelection(next);
          }}
        />
      ) : null}

      {policyModel ? (
        <SessionPolicySheet
          visible={policyVisible}
          model={policyModel}
          onClose={() => setPolicyVisible(false)}
          onSelectRuntimeMode={(value) => {
            const next = resolveSessionPolicySelection(policyModel.access, value);
            if (!next) return;
            void applyPolicy(() =>
              setThreadRuntimeMode(ensureEnvironmentApi(environmentId), threadId, next),
            );
          }}
          onSelectInteractionMode={(value) => {
            if (!policyModel.mode) return;
            const next = resolveSessionPolicySelection(policyModel.mode, value);
            if (!next) return;
            void applyPolicy(() =>
              setThreadInteractionMode(ensureEnvironmentApi(environmentId), threadId, next),
            );
          }}
        />
      ) : null}

      {headerModel ? (
        <ThreadActionsSheet
          environmentId={environmentId}
          visible={actionsVisible}
          model={headerModel}
          // Rename / stop / archive all call ensureEnvironmentApi, which throws
          // without a connection, so the sheet's rows are disabled rather than
          // left to surface an internal error. The sheet still opens: node,
          // project and worktree stay readable on a cached thread. `busy` is
          // the existing seam for that; it over-gates "Review changes" by one
          // row, which is acceptable — the review screen needs the same
          // connection this thread does not have.
          busy={actionBusy || cachedView.actionsDisabled}
          error={actionError}
          onClose={() => setActionsVisible(false)}
          onRename={(title) =>
            void runAction(() => renameThread(ensureEnvironmentApi(environmentId), threadId, title))
          }
          onStop={() =>
            void runAction(() => interruptThreadTurn(ensureEnvironmentApi(environmentId), threadId))
          }
          onToggleSettlement={() => {
            const action = headerModel.settlementAction;
            if (!action || action.disabled) return;
            void runAction(() =>
              setThreadSettled(
                ensureEnvironmentApi(environmentId),
                threadId,
                action.kind === "settle",
              ),
            );
          }}
          onToggleArchive={() =>
            void runAction(async () => {
              const shouldArchive = thread?.archivedAt === null;
              await setThreadArchived(ensureEnvironmentApi(environmentId), threadId, shouldArchive);
              if (shouldArchive && navigation.canGoBack()) navigation.goBack();
            })
          }
          onReview={() => {
            setActionsVisible(false);
            openReview();
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
