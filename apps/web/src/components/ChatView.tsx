import { useAppKeybindings } from "../appKeybindings";
import { notifyWorktreeSubmoduleSetup } from "./worktrees/worktreeCreationNotifications";
import { closeThreadTerminal } from "../terminalClose";
import { OptionalQuestionCard } from "./chat/OptionalQuestionCard";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { parseComputerInvocation } from "@ryco/shared/computerInvocation";
import { BackgroundBrowserPreview } from "../browser/BackgroundBrowserPreview";
import type { ProviderOptionSelection } from "@ryco/contracts";
import { taskDraftSend } from "./tasks/taskDraft";
import {
  rejectRetiredProjectMemory,
  hasRetiredProjectMemory,
  REMOVED_PROJECT_MEMORY_MESSAGE,
} from "@ryco/shared/retiredFeatures";
import { usePaneEffect, usePaneFocus, usePaneFocusRef, usePaneThreadRef } from "./chat/PaneFocus";
import { startSelectionChat } from "../lib/selectionChat";
import { TranscriptSelectionActions } from "./chat/TranscriptSelectionActions";
import {
  appendSelectionQuote,
  checkpointRevertUnsupportedMessage,
  declineApprovalsForRedirect,
  describeApprovalRedirectRefusal,
  pendingApprovalSourceFromStore,
  planApprovalRedirect,
  requestProviderSessionPrewarm,
  resolveProviderSessionPrewarmRequest,
  selectProviderSessionPrewarmSupported,
  type ApprovalRedirectRefusal,
  type SubscribedClaudeReviewState,
} from "@ryco/client-runtime/state/composer";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { flushPreviewFiles, hasUnsavedPreviewFiles } from "./previewFileSessions";
import type { BackgroundTask } from "@ryco/shared/backgroundWork";
import { deriveThreadBackgroundWork } from "@ryco/client-runtime/state/session";
import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { readEnvironmentConnection } from "../environments/runtime";
import { useSideChatStore } from "../sideChatStore";
import { parseSideQuestionCommand } from "@ryco/client-runtime/state/side-chat";
import { useDeviceName } from "../deviceName";
import { newWorktreeBaseBranch } from "./chat/NewThreadWorkLocation.logic";
import {
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationThreadMessageSearchResult,
  type ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  RuntimeSessionId,
  AgentTokenMode,
  type ThreadGoalStatus,
  type ThreadGoalUpdate,
  THREAD_GOAL_OBJECTIVE_MAX_CHARS,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@ryco/contracts";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import {
  buildQueuedMessageSteerCommand,
  resolveComposerFollowUpAction,
  resolveQueuedMessageEditUnavailableReason,
  resolveQueuedMessageSteerEligibility,
  type QueuedMessageSteerAttempts,
} from "@ryco/client-runtime/state/message-queue";
import { projectScriptCwd } from "@ryco/shared/projectScripts";
import {
  readWorktreePullRequestLinks,
  workspaceDiscoversPullRequests,
} from "@ryco/shared/worktreePullRequests";
import { resolveThreadPullRequests } from "./chat/ChatOverviewPanel.logic";
import {
  WorkspacePullRequestsPopover,
  type WorkspacePullRequestsView,
} from "./worktrees/WorkspacePullRequestsPopover";
import { useWorkspacePullRequestEditing } from "./worktrees/useWorkspacePullRequestEditing";
import { hasSeveralPullRequests } from "./worktrees/workspacePullRequests.logic";
import { truncate } from "@ryco/shared/String";
import { Debouncer, useDebouncedValue } from "@tanstack/react-pacer";
import { useQueryClient } from "~/rpc/queryClient";
import { formatSourceControlContextsForAgent } from "@ryco/shared/sourceControlContextFormatter";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGitStatus } from "~/lib/gitStatusState";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import { isElectron } from "../env";
import { isRightPanelOpen, parseRightPanelRouteSearch } from "../rightPanelRouteSearch";
import { deriveThreadAgentPanelModel, deriveThreadSubagents } from "../threadWorkspaceViewModel";
import {
  parseStandaloneComposerSlashCommand,
  parseThreadGoalSlashCommand,
} from "../composer-logic";
import {
  derivePhase,
  createTimelineEntryIndex,
  type ContextHandoffTimelineEntry,
  deriveActiveWorkStartedAt,
  deriveThreadActivityViewModel,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isPlanFollowUpReady,
  isLatestTurnSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectEnvironmentState,
  selectSidebarThreadsForProjectRef,
  selectThreadExistsByRef,
  useStore,
} from "../store";
import {
  createProjectSelectorByRef,
  createThreadSelectorByRef,
  createWorktreeSelector,
} from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import { useSettingsDialogStore } from "../settingsDialogStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_RUNTIME_MODE,
  MAX_TERMINALS_PER_GROUP,
  fullThreadEntry,
  isArchivedThreadStub,
  isChatImageAttachment,
  type ChatMessage,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useReducedMotionEffective } from "../hooks/useAppearancePreference";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useAppSidebarCollapsed } from "../hooks/useAppSidebarCollapsed";
import { usePresentationTier } from "../hooks/usePresentationTier";
import type { PresentationTier } from "../lib/presentationTier";
import {
  APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
  COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
} from "../appChrome";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { BranchToolbar } from "./BranchToolbar";
import {
  hasOpenDialogShortcutTarget,
  isDialogShortcutTarget,
  isEditableShortcutTarget,
  matchesExactModShortcut,
  resolveShortcutCommand,
  shouldIgnoreGlobalNavigationShortcut,
  shortcutLabelForCommand,
} from "../keybindings";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  WifiOffIcon,
} from "lucide-react";
import { BackgroundLivenessChip } from "./chat/BackgroundLivenessChip";
import { cn, randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newCommandId, newDraftId, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { isChatProject } from "@ryco/shared/projectKind";
import { getProviderSupportsAskMode, resolveSelectableProvider } from "../providerModels";
import { useProjectGroupingSettings } from "../hooks/useProjectGroupingSettings";
import { useSettings } from "../hooks/useSettings";
import {
  useChatsAvailability,
  useEnvironmentChatsAvailable,
  useEnvironmentServerConfigSelector,
} from "../hooks/useChatsAvailability";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import {
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  buildChatDraftTarget,
  resolveChatsAvailability,
  CHAT_PROJECT_LABEL,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  isPendingChatDraft,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { type TerminalContextDraft, type TerminalContextSelection } from "../lib/terminalContext";
import {
  applyBuildModeToSend,
  attachDevicePromptScreenshot,
  createSourceControlContextFetcher,
  formatOutgoingPrompt,
  persistThreadSettingsForNextTurn as persistThreadSettingsForNextTurnShared,
  type DevicePromptScreenshotNotice,
} from "../hooks/chatSendShared";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import type { ModelPickMeta } from "./chat/modelPickerTuningBridge";
import { ChatComposer, type ChatComposerHandle, type ComposerIntent } from "./chat/ChatComposer";
import { PersistentThreadTerminalDrawer } from "./chat/ChatTerminalShell";
import type { NewWorktreeDialogTab } from "./worktrees/NewWorktreeDialog";
import type { LinkedWorktreeItem } from "./worktrees/LinkedWorktreeItemDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { openForkThreadDialog, useCanForkThread } from "./chat/forkThreadDialogStore";
import {
  deriveRevertTurnCountByUserMessageId,
  deriveUndoTurnCountByTurnId,
  type TimelineForkRequest,
  pinTimelineToEnd,
} from "./chat/MessagesTimeline.logic";
import { NewThreadContextBar } from "./chat/NewThreadContextBar";
import { NewThreadHero } from "./chat/NewThreadHero";
import { ThreadHistorySkeleton } from "./chat/ThreadHistorySkeleton";
import { NewThreadWorkLocation } from "./chat/NewThreadWorkLocation";
import { ThreadMessageSearchBar } from "./chat/ThreadMessageSearchBar";
import {
  buildThreadMessageSearchOccurrences,
  clampThreadMessageSearchIndex,
  moveThreadMessageSearchIndex,
} from "./chat/ThreadMessageSearch.logic";
import type { ThreadMessageSearchOccurrence } from "./chat/ThreadMessageSearch.logic";
import { ChatHeader } from "./chat/ChatHeader";
import type { ChatProjectTarget } from "./chat/ChatProjectActions";
import type { PhoneThreadDockProps } from "./shell/phone/PhoneThreadDock";
import {
  LazyPhoneOverviewSheet,
  LazyPhoneThreadAppBar,
} from "./shell/phone/lazyPhoneThreadSurfaces";
import { usePhoneThreadSurfaceReady } from "./shell/phone/usePhoneThreadSurfaceReady";
import { useChatSessionTabsPrefetch } from "./chat/useChatSessionTabsPrefetch";
import {
  createSessionTabsSelector,
  draftThreadToSidebarSummary,
  type SessionTabItem,
} from "../sessionTabs.selectors";
import type { SidebarThreadSummary } from "../types";
import { markTabSwitchClick, usePerfMark } from "../perf/tabSwitchInstrumentation";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import {
  dismissProviderStatusNotice,
  isProviderStatusNoticeDismissed,
  resolveProviderStatusNotice,
} from "./chat/providerStatusNotice";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { useRestartInterruptionBannerItem } from "./chat/restartInterruptionBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { useUsageLimitBannerItem } from "./chat/usageLimitBanner";
import {
  applicableUsageLimit,
  deriveThreadSnoozeEligibility,
  isMaterializableCheckpointSummary,
  threadForkBoundaryQuote,
  selectEnvironmentShellLive,
  selectThreadDetailLoaded,
  selectThreadLiveDetailLoaded,
} from "@ryco/client-runtime/state/threads";
import type { OverviewPanelControlsInput } from "./chat/ChatOverviewPanel";
import {
  LazyAgentControlApprovals,
  LazyChatOverviewPanel,
  LazyComputerBetaPreview,
  LazyContextHandoffInspectionPanel,
  LazyExpandedImageDialog,
  LazyPullRequestThreadDialog,
  LazySideChatPanel,
} from "./chat/chatViewLazySurfaces";
import { notifySurfaceLoadFailure } from "./ui/surfaceLoadFailure";
import {
  LazyLinkedWorktreeItemDialog,
  LazyNewWorktreeDialog,
} from "./worktrees/lazyWorktreeDialogs";
import { usePostPushWorkflowWatch } from "./chat/usePostPushWorkflowWatch";
import { useLazyComponentReady, usePreloadWhenIdle } from "../lib/preloadableLazy";
import {
  CROWN_EASE_OUT,
  CROWN_RAIL_EXIT_MS,
  CROWN_RAIL_SLOT_WIDTH_PX,
} from "./overview/crown/crownLayout";
import type { WorktreeNotesTarget } from "./overview/notes/useWorktreeNotes";
import type { OverviewPullRequestLinking } from "./overview/overviewTypes";
import { useChatGlobalShortcuts } from "./chat/useChatGlobalShortcuts";
import { useChatPendingUserInput } from "./chat/useChatPendingUserInput";
import { useChatWorkspacePanels } from "./chat/useChatWorkspacePanels";
import { useThreadPlanCatalog } from "./chat/useThreadPlanCatalog";
import { useLocalDispatchState } from "./chat/useLocalDispatchState";
import { useChatProjectScripts } from "./chat/useChatProjectScripts";
import { useChatAttachmentPreviewHandoff } from "./chat/useChatAttachmentPreviewHandoff";
import { useChatSessionActions } from "../hooks/useChatSessionActions";
import {
  buildOutgoingMessageText,
  buildOutgoingTurnAttachments,
  composerRefsHaveContent,
  executeChatSendTurn,
  restoreComposerContent,
  type ComposerDraftContent,
  type SendTurnComposerSnapshot,
  type SendTurnSettings,
} from "../hooks/executeChatSendTurn";
import { useMessageQueueStore } from "../messageQueueStore";
import { TIMELINE_REVEAL_SETTLE_MS, useTimelineRevealStore } from "../timelineRevealStore";
import {
  createForegroundQueueSender,
  hasOutstandingQueuedDispatch,
  resumeMessageQueue,
  retryQueuedMessage,
  useForegroundQueueSender,
  type ForegroundQueueTarget,
} from "../messageQueueDrain";
import type { QueuedMessage } from "../messageQueue.logic";
import { deriveComposerFileUploadSendBlock } from "~/composerFileUpload";
import { ComposerQueuedMessages, type QueuedMessagesWait } from "./chat/ComposerQueuedMessages";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  deriveComposerSendState,
  deriveProviderSelectionPolicy,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  normalizeInteractionModeForProviderTarget,
  PullRequestDialogState,
  reconcileMountedTerminalThreadIds,
  resolveHeaderLiveAgentCount,
  resolveSendEnvMode,
  resolveChatSendWorktreePlan,
  shouldShowNewThreadSurface,
  isServerThreadHistoryPending,
  createThreadSubmitGuard,
  createThreadSendFlags,
  selectionAllowedAtSendBoundary,
  threadHasStarted,
  revokeUserMessagePreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  getReportedThreadCapabilitiesSnapshot,
  resolveEnvironmentThreadCapabilities,
  subscribeReportedThreadCapabilities,
  useServerAvailableEditors,
  useServerConfig,
} from "~/rpc/serverState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { createTurnCompletionTracker } from "../lib/turnCompletion.logic";
import { sanitizeThreadErrorMessage } from "@ryco/client-runtime/errors";
import { useHostedDeliveryNotice, useHostedRpcCapability } from "../hostedHub/capabilities";
import {
  hostedCapabilityCopy,
  hostedQueuedCopy,
  hostedRoleRefusesSendCopy,
  hostedSendsWhenReadyCopy,
  hostedSyncingCopy,
  useHostedSwitchTarget,
} from "../hostedHub/switchTarget";
import { markNodeSwitchPhase } from "../perf/nodeSwitchInstrumentation";
import {
  loadOlderThreadHistory,
  loadThreadHistoryAroundMessage,
  retainThreadDetailSubscription,
} from "../environments/runtime/service";
import {
  retainDesktopWorkspaceProviderScope,
  retainDesktopWorkspaceVcsScope,
  useDesktopWorkspaceState,
} from "../platform/desktopWorkspace";
import { withDirectDesktopExecutionMachine } from "../platform/desktopWorkspaceTarget";
import {
  retainHostedWorkspaceProviderScope,
  retainHostedWorkspaceThreadScope,
  retainHostedWorkspaceVcsScope,
} from "../hostedHub/hostedConnectionScopes";
import {
  nodeIdForHostedEnvironment,
  useHostedWorkspaceState,
} from "../hostedHub/hostedConnectionCoordinator";
import { adoptRoutedHostedNode } from "../hostedHub/nodeRoutes";
import { useHostedDraftExecutionTarget } from "../hooks/useHostedDraftExecutionTarget";
import {
  chatComposerExecutionTargets,
  hostedComposerExecutionTargets,
  type ChatExecutionCandidate,
} from "./chat/ExecutionTarget.logic";
import { DraftDeviceProjectDialog } from "./chat/DraftDeviceProjectDialog";
import { RightPanelSheet } from "./RightPanelSheet";
import { Button } from "./ui/button";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "../versionSkew";
import {
  isWorktreeLaunchSettingUp,
  readWorktreeLaunch,
  resolveWorktreeLaunchWorkStartedAt,
  stopWorktreeLaunchFeed,
  useWorktreeLaunchStore,
} from "@ryco/client-runtime/state/worktree-setup";
import {
  forgetWorktreeLaunch,
  readWorktreeLaunchRetry,
} from "./chat/worktreeLaunch/worktreeLaunchSend";
import { useFirstSendTransition } from "./chat/worktreeLaunch/useFirstSendTransition";
import type {
  WorktreeSetupActions,
  WorktreeSetupTimelineState,
} from "./chat/worktreeLaunch/WorktreeSetupTimelineContext";

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_SESSION_TABS: ReadonlyArray<SessionTabItem> = Object.freeze([]);
const PROVIDER_STATUS_KEY_SEPARATOR = "\0";

// Stable identity so the message-queue selector doesn't churn on empty threads.
const EMPTY_QUEUED_MESSAGES: readonly QueuedMessage[] = Object.freeze([]);
const EMPTY_STEER_ATTEMPTS: QueuedMessageSteerAttempts = Object.freeze({});
/** A launch handed off this recently is still being carried over by a new view. */
const CONTINUED_LAUNCH_WINDOW_MS = 5_000;

/**
 * Whether a thread opens with the overview rail docked: only where the rail
 * sits inline. Narrow viewports and split panes present right-hand panels as
 * sheets, and the phone tier's overview is a full-screen surface that never
 * opens on its own.
 */
function overviewOpensByDefault(
  shouldUseRightPanelSheet: boolean,
  presentationTier: PresentationTier,
): boolean {
  return !shouldUseRightPanelSheet && presentationTier !== "phone";
}

function providerStatusesContentKey(providers: ReadonlyArray<ServerProvider>): string {
  const parts: string[] = [`${providers.length}`];
  for (const provider of providers) {
    parts.push(
      provider.instanceId,
      provider.driver,
      provider.displayName ?? "",
      provider.accentColor ?? "",
      provider.badgeLabel ?? "",
      provider.continuation?.groupKey ?? "",
      provider.showInteractionModeToggle ? "1" : "0",
      provider.supportsAskMode ? "1" : "0",
      provider.supportsTurnSteering ? "1" : "0",
      provider.enabled ? "1" : "0",
      provider.status,
      provider.installed ? "1" : "0",
      provider.availability ?? "",
      provider.unavailableReason ?? "",
      provider.auth.status,
      provider.auth.type ?? "",
      provider.auth.label ?? "",
      provider.auth.email ?? "",
      provider.message ?? "",
      // The composer's usage popup reads limits from these snapshots.
      provider.checkedAt,
      JSON.stringify(provider.rateLimits) ?? "",
    );
    for (const model of provider.models) {
      parts.push(
        "model",
        model.slug,
        model.name,
        model.shortName ?? "",
        model.subProvider ?? "",
        model.isCustom ? "1" : "0",
        JSON.stringify(model.capabilities) ?? "",
      );
    }
    for (const command of provider.slashCommands) {
      parts.push("command", command.name, command.description ?? "", command.input?.hint ?? "");
    }
    for (const skill of provider.skills) {
      parts.push(
        "skill",
        skill.name,
        skill.path,
        skill.enabled ? "1" : "0",
        skill.scope ?? "",
        skill.displayName ?? "",
        skill.shortDescription ?? "",
        skill.description ?? "",
      );
    }
  }
  return parts.join(PROVIDER_STATUS_KEY_SEPARATOR);
}

function stabilizeProviderStatusesSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  cache: { key: string; snapshot: ServerProvider[] },
): ServerProvider[] {
  const key = providerStatusesContentKey(providers);
  if (key === cache.key) {
    return cache.snapshot;
  }
  const snapshot = providers as ServerProvider[];
  cache.key = key;
  cache.snapshot = snapshot;
  return snapshot;
}

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connecting" | "disconnected" | "error";
};

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      onPreviewPanelOpen?: () => void;
      onTerminalPanelOpen?: () => void;
      onSimulatorPanelOpen?: () => void;
      onAgentPanelOpen?: () => void;
      workspacePanelOpen?: boolean;
      onToggleWorkspacePanel?: () => void;
      reserveTitleBarControlInset?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      onPreviewPanelOpen?: () => void;
      onTerminalPanelOpen?: () => void;
      onSimulatorPanelOpen?: () => void;
      onAgentPanelOpen?: () => void;
      workspacePanelOpen?: boolean;
      onToggleWorkspacePanel?: () => void;
      reserveTitleBarControlInset?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    };

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

interface ThreadMessageSearchTarget {
  messageId: MessageId;
  requestId: number;
}

function elementFromEventTarget(target: EventTarget | null | undefined): Element | null {
  if (typeof Element === "undefined") return null;
  return target instanceof Element ? target : null;
}

function isAllowedThreadSearchEditableTarget(target: EventTarget | null | undefined): boolean {
  return (
    elementFromEventTarget(target)?.closest(
      '[data-chat-composer-form="true"], [data-thread-message-search="true"]',
    ) !== null
  );
}

function shouldIgnoreThreadMessageSearchShortcut(
  event: globalThis.KeyboardEvent & { isComposing?: boolean },
): boolean {
  if (event.type !== "keydown") return true;
  if (event.isComposing) return true;
  if (isTerminalFocused()) return true;
  if (isDialogShortcutTarget(event.target) || hasOpenDialogShortcutTarget()) return true;
  if (
    isEditableShortcutTarget(event.target) &&
    !isAllowedThreadSearchEditableTarget(event.target)
  ) {
    return true;
  }
  return false;
}

/** Chat column custom properties carrying the floating bars' heights. */
const COMPOSER_CLEARANCE_PROPERTY = "--chat-composer-clearance";
const HEADER_CLEARANCE_PROPERTY = "--chat-header-clearance";

/**
 * Publishes `bar`'s rendered height plus a small gap on `host` as a CSS
 * variable. The size comes from the observer's notifications, which run once
 * layout is clean and before the first paint: reading the height here
 * directly would force a layout of the freshly committed tree on every
 * switch. Returns the cleanup that drops the variable.
 */
function publishOverlayClearance(
  host: HTMLElement,
  bar: HTMLElement,
  property: string,
): () => void {
  const apply = () => host.style.setProperty(property, `${bar.offsetHeight + 8}px`);
  const observer = new ResizeObserver(apply);
  observer.observe(bar);
  return () => {
    observer.disconnect();
    host.style.removeProperty(property);
  };
}

/** How long the composer keeps focus on a thread before that focus prewarms its session. */
const PROVIDER_SESSION_PREWARM_FOCUS_DWELL_MS = 400;

/** A composer draft's stored content: what a send reads once its view shows another thread. */
function readComposerDraftContent(target: ScopedThreadRef | DraftId): ComposerDraftContent | null {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft
    ? { prompt: draft.prompt, images: draft.images, terminalContexts: draft.terminalContexts }
    : null;
}

export default function ChatView(props: ChatViewProps) {
  // React Compiler cannot preserve this component's manual memoization, so it
  // stays uncompiled; say so explicitly rather than through a stray hooks
  // lint suppression (which is how it was skipped before).
  "use no memo";
  usePerfMark("ChatView");
  const paneFocused = usePaneFocus();
  const paneThreadRef = usePaneThreadRef();
  const paneFocusedRef = usePaneFocusRef();
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    onPreviewPanelOpen,
    onTerminalPanelOpen,
    onSimulatorPanelOpen,
    onAgentPanelOpen,
    onToggleWorkspacePanel: externalToggleWorkspacePanel,
    reserveTitleBarControlInset = true,
  } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const dispatchCapability = useHostedRpcCapability(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    environmentId,
  );
  const terminalCapability = useHostedRpcCapability(WS_METHODS.terminalOpen, environmentId);
  const sideChatCapability = useHostedRpcCapability(
    WS_METHODS.textGenerationAskSideQuestion,
    environmentId,
  );
  const cliProxyHubsCapability = useHostedRpcCapability(
    WS_METHODS.serverReadCliProxyHubs,
    environmentId,
  );
  const hostedSwitchTarget = useHostedSwitchTarget(environmentId);
  // A connection on its way (a node switch) still takes a plain send: it waits
  // in the queue and goes out once the node is ready. Every other refusal
  // (stale authorization, the role, an unconfirmed delivery) stops it.
  const dispatchEstablishing = dispatchCapability.kind === "establishing";
  // Stop, answers, approvals, steering, reverts and plan follow-ups reach the
  // node at once or not at all: while the connection is not ready they are
  // refused with this reason and never held for later.
  const mutationUnavailableReason = dispatchCapability.allowed
    ? null
    : (hostedCapabilityCopy(dispatchCapability, hostedSwitchTarget.label) ??
      "Commands are unavailable on this connection.");
  const sendsQueueUntilReady = dispatchEstablishing
    ? hostedSendsWhenReadyCopy(hostedSwitchTarget.label)
    : null;
  const hostedDeliveryNotice = useHostedDeliveryNotice(environmentId);
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  // A first send into a new worktree, from the send until its turn settles.
  // The draft's view and the thread's view that replaces it share it.
  const worktreeLaunch = useWorktreeLaunchStore(
    (store) => store.launchesByKey[routeThreadKey] ?? null,
  );
  const worktreeSetupRunning = isWorktreeLaunchSettingUp(worktreeLaunch);
  const worktreeSetupFailed = worktreeLaunch?.phase === "failed";
  const worktreeSetupOnScreen = worktreeSetupRunning || worktreeSetupFailed;
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorByRef(routeKind === "server" ? routeThreadRef : null),
      [routeKind, routeThreadRef],
    ),
  );
  const setStoreThreadError = useStore((store) => store.setThreadError);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const alwaysUseBuildMode = useUiStateStore((store) => store.alwaysUseBuildMode);
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    routeKind === "server" ? store.threadLastVisitedAtById[routeThreadKey] : undefined,
  );
  const settings = useSettings();
  const primaryDeviceName = useDeviceName();
  const desktopWorkspace = useDesktopWorkspaceState();
  const hostedWorkspace = useHostedWorkspaceState();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const routerNavigate = useNavigate();
  const navigate = useCallback<typeof routerNavigate>(
    (options) => (paneFocusedRef.current ? routerNavigate(options) : Promise.resolve()),
    [paneFocusedRef, routerNavigate],
  );
  const { handleNewThread } = useNewThreadHandler();
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const routeSearch = useSearch({
    strict: false,
    select: (params) => parseRightPanelRouteSearch(params),
  });
  const rawSearch = paneFocused ? routeSearch : {};
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerTokenMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.tokenMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const addComposerDraftSourceControlContext = useComposerDraftStore(
    (store) => store.addSourceControlContext,
  );
  // Editing a queued message replaces the composer's content, so it stays
  // unavailable while anything is typed or attached.
  const composerDraftHasContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return (
      draft !== null &&
      draft !== undefined &&
      (draft.prompt.length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0 ||
        draft.sourceControlContexts.length > 0)
    );
  });
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const setComposerDraftTokenMode = useComposerDraftStore((store) => store.setTokenMode);
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const readComposer = useCallback(() => composerRef.current, [composerRef]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const [threadMessageSearchOpen, setThreadMessageSearchOpen] = useState(false);
  const [threadMessageSearchQuery, setThreadMessageSearchQuery] = useState("");
  const [threadMessageSearchFocusRequestId, setThreadMessageSearchFocusRequestId] = useState(0);
  const [threadMessageSearchSelectedIndex, setThreadMessageSearchSelectedIndex] = useState(0);
  const [threadMessageSearchTarget, setThreadMessageSearchTarget] =
    useState<ThreadMessageSearchTarget | null>(null);
  const [serverThreadMessageSearchResults, setServerThreadMessageSearchResults] = useState<
    ReadonlyArray<OrchestrationThreadMessageSearchResult>
  >([]);
  const [debouncedThreadMessageSearchQuery] = useDebouncedValue(threadMessageSearchQuery, {
    wait: 180,
  });
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  // Narrow viewports and split panes present right-hand panels (the context
  // handoff inspector) as a sheet rather than an inline aside, and start every
  // thread with the overview rail closed.
  const viewportNeedsRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const shouldUseRightPanelSheet = viewportNeedsRightPanelSheet || paneThreadRef !== null;
  // Covers both the OS setting and the in-app Motion preference.
  const reducedMotion = useReducedMotionEffective();
  const presentationTier = usePresentationTier();
  // Starts in the state the thread-switch reset below settles on. Starting
  // open and letting that reset close it played the rail's exit transition on
  // every mount where the overview starts closed: the chat column, and with it
  // every transcript row, re-laid out each frame for the length of the
  // transition while the transcript was pinning itself to its end.
  const [planSidebarOpen, setPlanSidebarOpen] = useState(() =>
    overviewOpensByDefault(shouldUseRightPanelSheet, presentationTier),
  );
  // Set once the user opens the overview from the new-thread surface, so the
  // empty-thread suppression below yields to an explicit request.
  const [overviewOpenedOnEmptyThread, setOverviewOpenedOnEmptyThread] = useState(false);
  // With the thread sidebar collapsed this header owns the workspace's
  // top-left corner, so it reserves the room the shell's floating
  // show-sidebar control (and the native window controls) need there.
  const appSidebarCollapsed = useAppSidebarCollapsed();
  // Ref mirror for effects that must observe the tier without re-running on
  // tier flips (rotation preserves route, draft, and panel state).
  const presentationTierRef = useRef(presentationTier);
  presentationTierRef.current = presentationTier;
  // Entering a split must not dock one overview rail in every chat pane.
  useEffect(() => {
    if (paneThreadRef) setPlanSidebarOpen(false);
  }, [paneThreadRef]);
  const shouldUseRightPanelSheetRef = useRef(shouldUseRightPanelSheet);
  shouldUseRightPanelSheetRef.current = shouldUseRightPanelSheet;
  const [inspectedContextHandoff, setInspectedContextHandoff] = useState<{
    readonly marker: ContextHandoffTimelineEntry;
    readonly trigger: HTMLButtonElement;
  } | null>(null);
  const openContextHandoffInspection = useCallback(
    (marker: ContextHandoffTimelineEntry, trigger: HTMLButtonElement) => {
      if (presentationTierRef.current === "phone") return;
      setPlanSidebarOpen(false);
      setInspectedContextHandoff({ marker, trigger });
    },
    [],
  );
  const closeContextHandoffInspection = useCallback(() => {
    setInspectedContextHandoff((current) => {
      if (current) {
        requestAnimationFrame(() => current.trigger.focus({ preventScroll: true }));
      }
      return null;
    });
  }, []);
  // The web phone tier is frozen (see AGENTS.md): the Build-mode lock only
  // applies to non-phone presentation tiers.
  const enforceBuildMode = alwaysUseBuildMode && presentationTier !== "phone";
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [projectExplorerOpen, setProjectExplorerOpen] = useState(false);
  const projectExplorerOpenRef = useRef(projectExplorerOpen);
  projectExplorerOpenRef.current = projectExplorerOpen;
  const [projectExplorerInitialTab, setProjectExplorerInitialTab] =
    useState<NewWorktreeDialogTab>("prs");
  const [terminalLaunchContext, setTerminalLaunchContext] = useState<TerminalLaunchContext | null>(
    null,
  );
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(true);
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true);
  // Mirrors the live follow the committed timeline was given, for end pins
  // that outlive the render which started them.
  const timelineLiveFollowEnabledRef = useRef(timelineLiveFollowEnabled);
  useEffect(() => {
    timelineLiveFollowEnabledRef.current = timelineLiveFollowEnabled;
  }, [timelineLiveFollowEnabled]);
  // ChatView follows thread navigation instead of remounting: a send in flight
  // belongs to the thread it started on, and keeps writing to this view's state
  // (composer, timeline, busy state) only while the view still shows it.
  const [threadSendsInFlight] = useState(createThreadSendFlags);
  const shownThreadKeyRef = useRef(routeThreadKey);
  useLayoutEffect(() => {
    shownThreadKeyRef.current = routeThreadKey;
  }, [routeThreadKey]);
  /** Whether the view still shows the thread it showed when this was called. */
  const bindToShownThread = useCallback(() => {
    const threadKey = shownThreadKeyRef.current;
    return () => shownThreadKeyRef.current === threadKey;
  }, []);
  // A send preparing (open editors saved, the message assembled), per thread for the same reason.
  const [threadSendsPreparing] = useState(createThreadSendFlags);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef),
  );
  const openTerminalThreadKeys = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalState]) =>
          nextTerminalState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const storeServerTerminalLaunchContext = useTerminalStateStore(
    (s) => s.terminalLaunchContextByThreadKey[scopedThreadKey(routeThreadRef)] ?? null,
  );
  const storeClearTerminalLaunchContext = useTerminalStateStore(
    (s) => s.clearTerminalLaunchContext,
  );
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      new Set(
        Object.values(draftThreadsByThreadKey).map((draftThread) =>
          scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
        ),
      ),
    [draftThreadsByThreadKey],
  );
  // Open terminals whose thread still exists. Checks only the (usually 0-2)
  // open terminal keys instead of deriving a key for every thread on each
  // store commit, streaming events included.
  const existingOpenTerminalThreadKeys = useStore(
    useShallow((state) =>
      openTerminalThreadKeys.filter((nextThreadKey) => {
        if (draftThreadKeys.has(nextThreadKey)) return true;
        const nextThreadRef = parseScopedThreadKey(nextThreadKey);
        return nextThreadRef !== null && selectThreadExistsByRef(state, nextThreadRef);
      }),
    ),
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        if (paneThreadRef && mountedThreadKey !== scopedThreadKey(paneThreadRef)) return [];
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys, paneThreadRef],
  );

  const localDraftError =
    routeKind === "server" && serverThread
      ? null
      : ((draftId ? localDraftErrorsByDraftId[draftId] : null) ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, localDraftError, threadId],
  );
  const routeThreadIsArchivedStub = useStore(
    (store) =>
      routeKind === "server" &&
      isArchivedThreadStub(selectEnvironmentState(store, environmentId).threadShellById[threadId]),
  );
  const isServerThread = routeKind === "server" && serverThread !== undefined;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  useEffect(() => {
    setInspectedContextHandoff(null);
  }, [activeThread?.id]);
  // Defers heavy MessagesTimeline render to a transition. When threadId
  // changes, the urgent render paints with the placeholder branch (see
  // the JSX gate below); React then re-renders in a transition where
  // the deferred id catches up and the real timeline mounts. The `null`
  // initial value applies the same to a fresh mount: chrome and composer
  // commit first, the timeline follows in the transition.
  const activeThreadIdRaw = activeThread?.id ?? null;
  // A view taking a launch over mid-flight (the thread's view replacing the
  // draft's at the hand-off) paints its timeline at once: deferring it would
  // blank the message and the setup row for a frame.
  const [continuesWorktreeLaunch] = useState(() => {
    const launch = readWorktreeLaunch(routeThreadKey);
    return (
      launch !== null &&
      (launch.phase !== "handed-off" ||
        Date.now() - (launch.handedOffAtMs ?? 0) < CONTINUED_LAUNCH_WINDOW_MS)
    );
  });
  const deferredActiveThreadId = useDeferredValue(
    activeThreadIdRaw,
    continuesWorktreeLaunch ? activeThreadIdRaw : null,
  );
  const isActiveThreadIdFresh = deferredActiveThreadId === activeThreadIdRaw;
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = enforceBuildMode
    ? DEFAULT_INTERACTION_MODE
    : (composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE);
  const tokenMode =
    composerTokenMode ??
    activeThread?.tokenMode ??
    settings.defaultAgentTokenMode ??
    DEFAULT_AGENT_TOKEN_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.diff === "1";
  const workspacePanelOpen = props.workspacePanelOpen ?? isRightPanelOpen(rawSearch);
  const activeThreadId = activeThread?.id ?? null;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const isCurrentServerThread = shouldWriteThreadErrorToCurrentServerThread({
        serverThread,
        routeThreadRef,
        targetThreadId,
      });
      if (isCurrentServerThread) {
        setStoreThreadError(routeThreadRef, nextError);
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey] ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextError,
        };
      });
    },
    [draftId, routeThreadRef, serverThread, setStoreThreadError],
  );
  const {
    interruptTurn,
    respondToApproval: onRespondToApproval,
    submitApprovalDecision,
    respondToUserInput,
    revertToTurnCount,
    respondingRequestIds,
    respondingUserInputRequestIds,
    isRevertingCheckpoint,
  } = useChatSessionActions({
    environmentId,
    activeThreadId,
    setThreadError,
  });
  /** Says why an action that must reach the node now was refused. */
  const notifyMutationUnavailable = useCallback((reason: string) => {
    toastManager.add(stackedThreadToast({ type: "info", title: reason }));
  }, []);
  /** Says why a send that redirects pending approvals sent nothing; the draft stays. */
  const notifyApprovalRedirectRefused = useCallback(
    (refusal: ApprovalRedirectRefusal, error?: string | null) => {
      toastManager.add(
        stackedThreadToast({ type: "warning", ...describeApprovalRedirectRefusal(refusal, error) }),
      );
    },
    [],
  );
  const onInterrupt = useCallback(async () => {
    if (mutationUnavailableReason !== null) {
      notifyMutationUnavailable(mutationUnavailableReason);
      return;
    }
    await interruptTurn();
  }, [interruptTurn, mutationUnavailableReason, notifyMutationUnavailable]);
  // An answer reaches the waiting turn now or not at all; it is never queued.
  // Choosing an option on the last question answers at once, so the refusal
  // lives here rather than only on the submit button.
  const onRespondToUserInput = useCallback(
    async (...args: Parameters<typeof respondToUserInput>) => {
      if (mutationUnavailableReason !== null) {
        notifyMutationUnavailable(mutationUnavailableReason);
        return;
      }
      await respondToUserInput(...args);
    },
    [mutationUnavailableReason, notifyMutationUnavailable, respondToUserInput],
  );
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  // Rows painted from a cache (or kept after a disconnect) are last-known
  // state: a send into them waits in the queue until the shell is live.
  const activeEnvironmentShellLive = useStore((store) =>
    selectEnvironmentShellLive(store, activeThreadRef?.environmentId ?? null),
  );
  // Whether the open server thread's history window has been applied; drafts
  // have none to wait for.
  const activeThreadDetailLoaded = useStore((store) =>
    isServerThread && activeThreadRef ? selectThreadDetailLoaded(store, activeThreadRef) : true,
  );
  // The same, but not satisfied by messages hydrated from a read cache: sibling
  // prefetch waits for the active thread's live window, not its cached copy.
  const activeThreadLiveDetailLoaded = useStore((store) =>
    isServerThread && activeThreadRef ? selectThreadLiveDetailLoaded(store, activeThreadRef) : true,
  );
  // What the external switch probe reads on the chat root: whether the thread
  // shows live detail, detail from the read cache, or none yet.
  const threadDetailState = !activeThreadDetailLoaded
    ? "loading"
    : activeThreadLiveDetailLoaded
      ? "live"
      : "cached";
  // A node switch's content is painted the first time the routed thread's
  // detail (live or cached) commits after the route changed.
  const hasActiveThread = activeThread !== undefined;
  const contentPaintedRouteKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!hasActiveThread || !activeThreadDetailLoaded) return;
    if (contentPaintedRouteKeyRef.current === routeThreadKey) return;
    contentPaintedRouteKeyRef.current = routeThreadKey;
    markNodeSwitchPhase("content-painted", environmentId);
  }, [activeThreadDetailLoaded, environmentId, hasActiveThread, routeThreadKey]);
  const activeThreadMessageHistory = useStore((state) =>
    activeThreadRef
      ? state.environmentStateById[activeThreadRef.environmentId]?.threadHistoryByThreadId?.[
          activeThreadRef.threadId
        ]?.messages
      : undefined,
  );
  const activeThreadMessageHistoryLoad = useStore((state) =>
    activeThreadRef
      ? state.environmentStateById[activeThreadRef.environmentId]?.threadHistoryLoadByThreadId?.[
          activeThreadRef.threadId
        ]?.messages
      : undefined,
  );
  const handleLoadOlderMessages = useCallback(() => {
    if (!activeThreadRef || !activeThreadMessageHistory) return;
    void loadOlderThreadHistory({
      environmentId: activeThreadRef.environmentId,
      threadId: activeThreadRef.threadId,
      collection: "messages",
      page: activeThreadMessageHistory,
      limit: 150,
    }).catch(() => undefined);
  }, [activeThreadMessageHistory, activeThreadRef]);

  // The message the timeline brings into view: one the workspace panel asked
  // for (an artifact's "Show in thread"), else the route's deep link.
  const timelineReveal = useTimelineRevealStore((store) =>
    activeThreadKey ? (store.requestsByThreadKey[activeThreadKey] ?? null) : null,
  );
  const settleTimelineReveal = useTimelineRevealStore((store) => store.settle);
  const linkedMessageId = timelineReveal?.messageId ?? rawSearch.messageId;
  const linkedMessageLoaded =
    linkedMessageId !== undefined &&
    (activeThread?.messages.some((message) => message.id === linkedMessageId) ?? false);
  useEffect(() => {
    if (!activeThreadRef || !linkedMessageId || !activeThreadMessageHistory) return;
    if (linkedMessageLoaded) return;
    void loadThreadHistoryAroundMessage({
      environmentId: activeThreadRef.environmentId,
      threadId: activeThreadRef.threadId,
      messageId: linkedMessageId,
      limit: 101,
    }).catch(() => {
      // The thread no longer has the message: nothing to bring into view.
      if (timelineReveal && activeThreadKey) {
        settleTimelineReveal(activeThreadKey, timelineReveal.requestId);
      }
    });
  }, [
    activeThreadKey,
    activeThreadMessageHistory,
    activeThreadRef,
    linkedMessageId,
    linkedMessageLoaded,
    settleTimelineReveal,
    timelineReveal,
  ]);
  // Once shown (and highlighted), a reveal lets go: a timeline that keeps
  // streaming must not be pulled back to it.
  useEffect(() => {
    if (!timelineReveal || !activeThreadKey || !linkedMessageLoaded) return;
    const timeoutId = window.setTimeout(
      () => settleTimelineReveal(activeThreadKey, timelineReveal.requestId),
      TIMELINE_REVEAL_SETTLE_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [activeThreadKey, linkedMessageLoaded, settleTimelineReveal, timelineReveal]);

  // Message queue: prompts composed while a turn runs are queued and auto-sent on
  // quiescence. Client-owned, keyed by the scoped thread key.
  const enqueueMessage = useMessageQueueStore((store) => store.enqueue);
  const removeMessageFromQueue = useMessageQueueStore((store) => store.remove);
  const moveMessageInQueue = useMessageQueueStore((store) => store.move);
  const beginQueuedMessageSteer = useMessageQueueStore((store) => store.beginSteer);
  const endQueuedMessageSteer = useMessageQueueStore((store) => store.endSteer);
  const queuedMessages = useMessageQueueStore((store) =>
    activeThreadKey
      ? (store.queuesByThreadKey[activeThreadKey] ?? EMPTY_QUEUED_MESSAGES)
      : EMPTY_QUEUED_MESSAGES,
  );
  const queuedMessageSteerAttempts = useMessageQueueStore((store) =>
    activeThreadKey
      ? (store.steerAttemptsByThreadKey[activeThreadKey] ?? EMPTY_STEER_ATTEMPTS)
      : EMPTY_STEER_ATTEMPTS,
  );
  const steeringQueuedMessageIds = useMemo(
    () => Object.keys(queuedMessageSteerAttempts),
    [queuedMessageSteerAttempts],
  );
  const queueHold = useMessageQueueStore((store) =>
    activeThreadKey ? (store.holdsByThreadKey[activeThreadKey] ?? null) : null,
  );
  // Why queued messages are not going out, for the queue's header: a hosted
  // environment that is still being established, or one that refuses them.
  const queuedMessagesWait = useMemo<QueuedMessagesWait | null>(() => {
    if (!dispatchCapability.hosted || dispatchCapability.allowed) return null;
    if (dispatchEstablishing) {
      return {
        kind: "connecting",
        copy: hostedSendsWhenReadyCopy(hostedSwitchTarget.label),
        failure: dispatchCapability.reason,
      };
    }
    if (dispatchCapability.kind === "role") {
      return { kind: "role", copy: hostedRoleRefusesSendCopy(hostedSwitchTarget.label) };
    }
    return {
      kind: "unavailable",
      copy: dispatchCapability.reason ?? "Commands are unavailable on this connection.",
    };
  }, [
    dispatchCapability.allowed,
    dispatchCapability.hosted,
    dispatchCapability.kind,
    dispatchCapability.reason,
    dispatchEstablishing,
    hostedSwitchTarget.label,
  ]);
  const handleRemoveQueuedMessage = useCallback(
    (id: string) => {
      if (!activeThreadKey) return;
      const message = useMessageQueueStore
        .getState()
        .queuesByThreadKey[activeThreadKey]?.find((entry) => entry.id === id);
      if (message) {
        for (const image of message.composer.images) {
          if (image.previewUrl.startsWith("blob:")) {
            URL.revokeObjectURL(image.previewUrl);
          }
        }
      }
      removeMessageFromQueue(activeThreadKey, id);
    },
    [activeThreadKey, removeMessageFromQueue],
  );
  const handleMoveQueuedMessage = useCallback(
    (id: string, direction: "up" | "down") => {
      if (!activeThreadKey) return;
      moveMessageInQueue(activeThreadKey, id, direction);
    },
    [activeThreadKey, moveMessageInQueue],
  );

  useEffect(() => {
    setThreadMessageSearchOpen(false);
    setThreadMessageSearchQuery("");
    setThreadMessageSearchSelectedIndex(0);
    setThreadMessageSearchTarget(null);
  }, [activeThreadKey]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread?.id]),
  );
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalState.terminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(activeProjectRef), [activeProjectRef]),
  );
  // "No project" chat context: an unsent chat draft (its project does not exist
  // until the first send creates it) or a thread inside a chat project. A chat
  // runs locally in a plain folder, so branch/worktree/env-mode controls and
  // Git status queries stay off.
  const isPendingChat = !isServerThread && isPendingChatDraft(draftThread);
  const isChatContext = isPendingChat || isChatProject(activeProject);
  const chatsAvailability = useChatsAvailability(activeThread?.environmentId ?? environmentId);
  // A sent chat (its project exists) offers "Turn into project…" in the header.
  const chatThreadId = isServerThread ? (activeThread?.id ?? null) : null;
  const chatThreadTitle = activeThread?.title ?? null;
  const chatProjectHeaderTarget = useMemo<ChatProjectTarget | null>(
    () =>
      activeProject && isChatProject(activeProject)
        ? {
            projectRef: scopeProjectRef(activeProject.environmentId, activeProject.id),
            threadRef: chatThreadId
              ? scopeThreadRef(activeProject.environmentId, chatThreadId)
              : null,
            title: chatThreadTitle ?? activeProject.name,
            folderPath: activeProject.cwd,
          }
        : null,
    [activeProject, chatThreadId, chatThreadTitle],
  );
  const activeWorktreeSummary = useStore(
    useMemo(
      () => createWorktreeSelector(activeThread?.environmentId, activeThread?.worktreeId),
      [activeThread?.environmentId, activeThread?.worktreeId],
    ),
  );
  const activeWorktreePullRequests = useMemo(
    () => (activeWorktreeSummary ? readWorktreePullRequestLinks(activeWorktreeSummary) : []),
    [activeWorktreeSummary],
  );
  const activeWorktreeDiscoversPullRequests = workspaceDiscoversPullRequests(activeWorktreeSummary);
  const [headerLinkedItem, setHeaderLinkedItem] = useState<LinkedWorktreeItem | null>(null);
  const handleOpenHeaderLinkedItem = useCallback((item: LinkedWorktreeItem) => {
    setHeaderLinkedItem(item);
  }, []);
  const handleHeaderLinkedItemDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setHeaderLinkedItem(null);
    }
  }, []);
  const sessionTabsSelector = useMemo(() => createSessionTabsSelector(), []);
  const tabsWorktreeId = activeThread?.worktreeId;
  const tabsWorktreePath = activeThread?.worktreePath;
  const draftThreadSummariesForProject = useMemo<SidebarThreadSummary[]>(() => {
    if (!activeProjectRef) return [];
    const drafts: SidebarThreadSummary[] = [];
    for (const draft of Object.values(draftThreadsByThreadKey)) {
      if (draft.promotedTo != null) continue;
      if (draft.environmentId !== activeProjectRef.environmentId) continue;
      if (draft.projectId !== activeProjectRef.projectId) continue;
      drafts.push(draftThreadToSidebarSummary(draft));
    }
    return drafts;
  }, [draftThreadsByThreadKey, activeProjectRef]);
  const activeWorktreeSessionTabs = useStore((state) => {
    if (!activeProjectRef || !activeThread) return EMPTY_SESSION_TABS;
    const serverThreads = selectSidebarThreadsForProjectRef(state, activeProjectRef);
    const allThreads =
      draftThreadSummariesForProject.length > 0
        ? [...serverThreads, ...draftThreadSummariesForProject]
        : serverThreads;
    return sessionTabsSelector(allThreads, {
      worktreeId: tabsWorktreeId ?? null,
      worktreePath: tabsWorktreePath ?? null,
    });
  });
  const activeSessionTabKey = activeThread
    ? scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id))
    : null;
  const handleSelectSessionTab = useCallback(
    (key: string) => {
      const target = parseScopedThreadKey(key);
      if (!target) return;
      markTabSwitchClick(key);
      // Defer navigate to the next macrotask so React can commit the
      // dock's optimistic selection paint before the heavy route-driven
      // re-render kicks in. Wrapping in startTransition composed badly
      // with tanstack-router's internal Transitioner.
      setTimeout(() => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: target.environmentId,
            threadId: target.threadId,
          },
        });
      }, 0);
    },
    [navigate],
  );

  useChatSessionTabsPrefetch({
    activeWorktreeSessionTabs,
    activeSessionTabKey,
    activeDetailLoaded: activeThreadLiveDetailLoaded,
  });

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localComputerEnvironmentId =
    desktopWorkspace.localEnvironmentId ??
    (readPrimaryEnvironmentTarget()?.source === "desktop-managed" ? primaryEnvironmentId : null);
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const activeSavedEnvironmentRecord =
    activeThread && activeThread.environmentId !== primaryEnvironmentId
      ? (savedEnvironmentRegistry[activeThread.environmentId] ?? null)
      : null;
  const activeSavedEnvironmentRuntime = activeSavedEnvironmentRecord
    ? (savedEnvironmentRuntimeById[activeSavedEnvironmentRecord.environmentId] ?? null)
    : null;
  const activeSavedEnvironmentConnectionState = activeSavedEnvironmentRecord
    ? (activeSavedEnvironmentRuntime?.connectionState ?? "disconnected")
    : "connected";
  const sideChatConnection = useWsConnectionStatusForEnvironment(environmentId);
  const activeEnvironmentUnavailable =
    activeSavedEnvironmentRecord !== null && activeSavedEnvironmentConnectionState !== "connected";
  const activeSavedEnvironmentId = activeSavedEnvironmentRecord?.environmentId ?? null;
  const activeEnvironmentUnavailableLabel = activeSavedEnvironmentRecord
    ? resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: activeSavedEnvironmentRecord.environmentId,
        runtimeLabel: activeSavedEnvironmentRuntime?.descriptor?.label ?? null,
        savedLabel: activeSavedEnvironmentRecord.label,
      })
    : null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (
      !activeEnvironmentUnavailable ||
      !activeEnvironmentUnavailableLabel ||
      !activeSavedEnvironmentId
    ) {
      return null;
    }

    return {
      environmentId: activeSavedEnvironmentId,
      label: activeEnvironmentUnavailableLabel,
      connectionState:
        activeSavedEnvironmentConnectionState === "connecting" ||
        activeSavedEnvironmentConnectionState === "error"
          ? activeSavedEnvironmentConnectionState
          : "disconnected",
    };
  }, [
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    activeSavedEnvironmentConnectionState,
    activeSavedEnvironmentId,
  ]);
  const [reconnectingEnvironmentId, setReconnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId, label: string) => {
      setReconnectingEnvironmentId(environmentId);
      try {
        await reconnectSavedEnvironment(environmentId);
        toastManager.add({
          type: "success",
          title: "Environment reconnected",
          description: `${label} is ready.`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      } finally {
        setReconnectingEnvironmentId(null);
      }
    },
    [],
  );
  const projectGroupingSettings = useProjectGroupingSettings();
  const desktopExecutionMachines = useMemo(
    () =>
      withDirectDesktopExecutionMachine({
        machines: desktopWorkspace.machines,
        ready: desktopWorkspace.status === "ready",
        primaryEnvironmentId,
        localHubEnvironmentId: desktopWorkspace.localEnvironmentId,
        primaryLabel: primaryDeviceName,
      }),
    [desktopWorkspace, primaryEnvironmentId, primaryDeviceName],
  );
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
      disabled?: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const savedRecord = savedEnvironmentRegistry[p.environmentId];
      const runtimeState = savedEnvironmentRuntimeById[p.environmentId];
      const desktopMachine = desktopExecutionMachines.find(
        (machine) => machine.environmentId === p.environmentId,
      );
      const hostedMachine = hostedWorkspace.machines.find(
        (machine) => machine.environmentId === p.environmentId,
      );
      const workspaceMachine =
        hostedWorkspace.status === "signed-out" ? desktopMachine : hostedMachine;
      const fallbackLabel = resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId: p.environmentId,
        runtimeLabel: runtimeState?.descriptor?.label ?? null,
        savedLabel: savedRecord?.label ?? null,
      });
      const label = workspaceMachine?.label ?? (isPrimary ? primaryDeviceName : fallbackLabel);
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
        ...(desktopWorkspace.status === "ready" || hostedWorkspace.status === "ready"
          ? { disabled: workspaceMachine?.canMutate !== true }
          : {}),
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [
    activeProject,
    allProjects,
    desktopExecutionMachines,
    primaryDeviceName,
    desktopWorkspace.status,
    hostedWorkspace,
    projectGroupingSettings,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  // An unsent "No project" chat needs no project on its device, so it can move
  // to any reachable device whose node supports chats.
  const primaryChatsAvailable = useEnvironmentChatsAvailable(primaryEnvironmentId);
  const chatExecutionCandidates = useMemo<ReadonlyArray<ChatExecutionCandidate>>(() => {
    if (!isPendingChat || hostedWorkspace.status !== "signed-out") return [];
    const chatsAvailable = (candidateEnvironmentId: EnvironmentId) => {
      if (candidateEnvironmentId === primaryEnvironmentId) return primaryChatsAvailable;
      const config = savedEnvironmentRuntimeById[candidateEnvironmentId]?.serverConfig;
      return config ? resolveChatsAvailability(config).available : null;
    };
    if (desktopWorkspace.status === "ready") {
      return desktopExecutionMachines.map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        reachable: machine.canMutate,
        chatsAvailable: chatsAvailable(machine.environmentId),
      }));
    }
    return [
      ...(primaryEnvironmentId
        ? [
            {
              environmentId: primaryEnvironmentId,
              label: primaryDeviceName,
              reachable: true,
              chatsAvailable: primaryChatsAvailable,
            },
          ]
        : []),
      ...Object.values(savedEnvironmentRegistry).map((record) => {
        const runtime = savedEnvironmentRuntimeById[record.environmentId];
        return {
          environmentId: record.environmentId,
          label: resolveEnvironmentOptionLabel({
            isPrimary: false,
            environmentId: record.environmentId,
            runtimeLabel: runtime?.descriptor?.label ?? null,
            savedLabel: record.label,
          }),
          reachable: runtime?.connectionState === "connected",
          chatsAvailable: chatsAvailable(record.environmentId),
        };
      }),
    ];
  }, [
    desktopExecutionMachines,
    desktopWorkspace.status,
    hostedWorkspace.status,
    isPendingChat,
    primaryChatsAvailable,
    primaryDeviceName,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          tokenMode: activeDraftSession.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        tokenMode: settings.defaultAgentTokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
      settings.defaultAgentTokenMode,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!paneFocused || !serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      activeLatestTurn.completedAt,
    );
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    paneFocused,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider = activeThread?.modelSelection.instanceId ?? null;
  const primaryServerConfig = useServerConfig();
  const activeEnvRuntimeState = useSavedEnvironmentRuntimeStore((s) =>
    activeThread?.environmentId ? s.byId[activeThread.environmentId] : null,
  );
  // Use the server config for the thread's environment.  For the primary
  // environment fall back to the global atom; for remote environments use
  // the runtime state stored by the environment manager.
  const serverConfig =
    primaryEnvironmentId && activeThread?.environmentId === primaryEnvironmentId
      ? primaryServerConfig
      : (activeEnvRuntimeState?.serverConfig ?? primaryServerConfig);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const worktreeNotesAvailable = serverConfig?.environment.capabilities.worktreeNotes === true;
  // Notes key on the checkout: a server thread without a worktree runs in the
  // main checkout; a draft without one has no checkout yet. A chat folder is no
  // checkout (no Git, no worktree record), so a chat has no Notes until it is
  // turned into a project, which keeps its id.
  const notesEnvironmentId = activeThread?.environmentId ?? null;
  const notesProjectId = isChatContext ? null : (activeThread?.projectId ?? null);
  const notesWorktreeId = activeThread?.worktreeId ?? null;
  const notesWorktreeOrigin = activeWorktreeSummary?.origin ?? null;
  const worktreeNotesTarget = useMemo<WorktreeNotesTarget | null>(
    () =>
      notesEnvironmentId && notesProjectId
        ? {
            environmentId: notesEnvironmentId,
            projectId: notesProjectId,
            checkout:
              notesWorktreeId !== null
                ? { worktreeId: notesWorktreeId, origin: notesWorktreeOrigin }
                : isServerThread
                  ? { worktreeId: null, origin: "main" }
                  : null,
            available: worktreeNotesAvailable,
          }
        : null,
    [
      notesEnvironmentId,
      notesProjectId,
      notesWorktreeId,
      notesWorktreeOrigin,
      isServerThread,
      worktreeNotesAvailable,
    ],
  );
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = Object.keys(savedEnvironmentRegistry).length > 0;
  const versionMismatchServerLabel = useMemo(() => {
    if (!hasMultipleRegisteredEnvironments || !activeThread) {
      return "server";
    }

    const isPrimary = activeThread.environmentId === primaryEnvironmentId;
    const savedRecord = savedEnvironmentRegistry[activeThread.environmentId];
    const runtimeState = savedEnvironmentRuntimeById[activeThread.environmentId];
    return `${resolveEnvironmentOptionLabel({
      isPrimary,
      environmentId: activeThread.environmentId,
      runtimeLabel: runtimeState?.descriptor?.label ?? serverConfig?.environment.label ?? null,
      savedLabel: savedRecord?.label ?? null,
    })} server`;
  }, [
    activeThread,
    hasMultipleRegisteredEnvironments,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    serverConfig?.environment.label,
  ]);
  // A restart release is an interruption, not a thread error: a quiet line where the
  // user would continue. The web phone tier is frozen: no new banners there.
  const restartInterruptionBannerItem = useRestartInterruptionBannerItem(
    isServerThread && activeThreadDetailLoaded && presentationTier !== "phone"
      ? (activeThread ?? null)
      : null,
  );
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    if (hostedDeliveryNotice) {
      // Shown where the user would retry, not in the connection menu. It also
      // explains why sending is paused, so it replaces the read-only banner.
      items.push({
        id: "hosted-delivery-unconfirmed",
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: hostedDeliveryNotice.title,
        description: hostedDeliveryNotice.description,
        actions: (
          <Button
            size="xs"
            disabled={!hostedDeliveryNotice.canAcknowledge}
            onClick={hostedDeliveryNotice.acknowledge}
          >
            {hostedDeliveryNotice.actionLabel}
          </Button>
        ),
      });
    } else if (dispatchCapability.hosted && dispatchEstablishing) {
      // A connection on its way is not a problem: a quiet note instead of a
      // warning, while sends wait in the queue.
      items.push({
        id: "hosted-dispatch-syncing",
        variant: "info",
        icon: <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />,
        title: hostedSwitchTarget.queued
          ? hostedQueuedCopy(hostedSwitchTarget.label)
          : hostedSyncingCopy(hostedSwitchTarget.label),
      });
    } else if (dispatchCapability.hosted && !dispatchCapability.allowed) {
      items.push({
        id: "hosted-dispatch-unavailable",
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Read-only hosted session",
        description: dispatchCapability.reason ?? "Commands are unavailable on this connection.",
      });
    }
    if (activeEnvironmentUnavailableState) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant:
          activeEnvironmentUnavailableState.connectionState === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: (
          <>
            {activeEnvironmentUnavailableState.label} is{" "}
            {activeEnvironmentUnavailableState.connectionState === "connecting"
              ? "connecting"
              : "disconnected"}
          </>
        ),
        description: "Reconnect this environment before sending messages or running actions.",
        actions: (
          <>
            <Button
              size="xs"
              disabled={
                activeEnvironmentUnavailableState.connectionState === "connecting" ||
                reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
              }
              onClick={() =>
                void handleReconnectActiveEnvironment(
                  activeEnvironmentUnavailableState.environmentId,
                  activeEnvironmentUnavailableState.label,
                )
              }
            >
              {activeEnvironmentUnavailableState.connectionState === "connecting" ||
              reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
                ? "Reconnecting..."
                : "Reconnect"}
            </Button>
            <Button size="xs" variant="outline" onClick={() => openSettings("connections")}>
              Connections
            </Button>
          </>
        ),
      });
    }
    if (showVersionMismatchBanner && versionMismatch && versionMismatchDismissKey) {
      items.push({
        id: `version-mismatch:${versionMismatchDismissKey}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Client and server versions differ",
        description: (
          <>
            Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{" "}
            {versionMismatch.serverVersion}. Sync them if RPC calls or reconnects fail.
          </>
        ),
        dismissLabel: "Dismiss version mismatch warning",
        onDismiss: () => {
          dismissVersionMismatch(versionMismatchDismissKey);
          setDismissedVersionMismatchKey(versionMismatchDismissKey);
        },
      });
    }
    if (restartInterruptionBannerItem) {
      items.push(restartInterruptionBannerItem);
    }
    return items;
  }, [
    dispatchCapability.allowed,
    dispatchCapability.hosted,
    dispatchCapability.reason,
    dispatchEstablishing,
    hostedSwitchTarget.label,
    hostedSwitchTarget.queued,
    hostedDeliveryNotice,
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    openSettings,
    reconnectingEnvironmentId,
    restartInterruptionBannerItem,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    versionMismatchServerLabel,
  ]);
  // The history subscription goes out after this view mounts, while the shell
  // already lists the thread: until its window arrives an existing thread must
  // not present as a new one.
  const activeThreadHasLatestTurn = (activeThread?.latestTurn ?? null) !== null;
  const activeThreadMessageCount = activeThread?.messages.length ?? 0;
  const activeThreadLineage = activeThread?.lineage ?? null;
  const threadHistoryPending = useStore((store) => {
    if (!activeThreadRef) return false;
    const summary = selectSidebarThreadSummaryByRef(store, activeThreadRef);
    return isServerThreadHistoryPending({
      isServerThread,
      detailLoaded: activeThreadDetailLoaded,
      messageCount: activeThreadMessageCount,
      hasLatestTurn: activeThreadHasLatestTurn,
      latestUserMessageAt: summary?.latestUserMessageAt ?? null,
      lineage: summary?.lineage ?? activeThreadLineage,
    });
  });
  const showNewThreadComposerSpacer =
    activeThread !== undefined &&
    !threadHistoryPending &&
    activeThread.messages.length === 0 &&
    optimisticUserMessages.length === 0;
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const composerProviderStatusesCacheRef = useRef({
    key: "",
    snapshot: EMPTY_PROVIDERS,
  });
  const composerProviderStatuses = useMemo(
    () =>
      stabilizeProviderStatusesSnapshot(providerStatuses, composerProviderStatusesCacheRef.current),
    [providerStatuses],
  );
  // Hub reads are owner-only. Other Hub roles and client sessions paired to the node see the
  // hub settings but cannot read them; a primary session's role is only known from its reads.
  const cliProxyHubsEnabled =
    cliProxyHubsCapability.allowed &&
    !activeEnvironmentUnavailable &&
    (activeSavedEnvironmentRuntime?.role ?? "owner") === "owner" &&
    serverConfig?.environment.capabilities.cliProxyHubs === true &&
    Object.values(serverConfig.settings.cliProxyHubs).some((hub) => hub.enabled);
  const activeThreadSessionProviderInstanceId = activeThread?.session?.providerInstanceId ?? null;
  const phase = derivePhase(activeThread?.session ?? null);

  // Native desktop notification when a turn the user watched running completes
  // while the Ryco window is unfocused. Only fires for turns observed running in
  // this session (never for history loaded on mount), at most once per turn. The
  // main process authoritatively re-checks focus; the `document.hasFocus()`
  // pre-check just avoids a wasted IPC round-trip when we're clearly focused.
  const notifyOnTurnComplete = settings.notifyOnTurnCompleteWhenUnfocused;
  const turnCompletionTrackerRef = useRef(createTurnCompletionTracker());
  const turnCompletionTrackerThreadKeyRef = useRef(activeThreadKey);
  useEffect(() => {
    const tracker = turnCompletionTrackerRef.current;
    // ChatView follows thread navigation: only turns watched in this thread
    // since it was opened count, as when every open mounted a fresh view.
    if (turnCompletionTrackerThreadKeyRef.current !== activeThreadKey) {
      turnCompletionTrackerThreadKeyRef.current = activeThreadKey;
      tracker.reset();
    }
    const observation = {
      turnId: activeLatestTurn?.turnId ?? null,
      running: phase === "running",
      settled: latestTurnSettled,
      completedAt: activeLatestTurn?.completedAt ?? null,
      state: activeLatestTurn?.state ?? null,
    };
    // A running turn is recorded whatever the pane's focus; only its
    // completion waits for the focused pane of a server thread.
    if (observation.running) {
      tracker.observe(observation);
      return;
    }
    if (!paneFocused || !serverThread?.id) return;
    // Every ending notifies, however the turn ended.
    if (tracker.observe(observation) === null) return;

    if (!notifyOnTurnComplete) return;
    if (typeof document !== "undefined" && document.hasFocus()) return;
    const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
    if (!bridge?.notifyTurnComplete) return;
    const title = activeThread?.title?.trim() ? activeThread.title : "Ryco";
    void bridge
      .notifyTurnComplete({
        threadId: serverThread.id,
        environmentId: serverThread.environmentId,
        title,
        body: "The agent finished responding.",
      })
      .catch(() => undefined);
  }, [
    phase,
    latestTurnSettled,
    activeLatestTurn?.turnId,
    activeLatestTurn?.completedAt,
    activeLatestTurn?.state,
    notifyOnTurnComplete,
    serverThread?.id,
    serverThread?.environmentId,
    activeThread?.title,
    activeThreadKey,
  ]);

  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const backgroundWork = useMemo(
    () => deriveThreadBackgroundWork(threadActivities, activeThread?.session ?? null),
    [threadActivities, activeThread?.session],
  );
  const threadActivityViewModel = useMemo(
    () => deriveThreadActivityViewModel(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const {
    workLogEntries,
    contextCompactionEntries,
    contextHandoffEntries,
    forkOriginEntries,
    pendingApprovals,
    pendingUserInputs,
    optionalUserInputs,
    activePlan,
  } = threadActivityViewModel;
  // Native subagent fold: memoized by activity-list identity, shared by the
  // Agents surface, timeline spawn CTAs, and the background-liveness banner.
  const agentSessionLive =
    phase !== "disconnected" &&
    activeThread?.session?.orchestrationStatus !== "stopped" &&
    activeThread?.session?.orchestrationStatus !== "interrupted" &&
    activeThread?.session?.orchestrationStatus !== "error";
  const threadSubagents = useMemo(
    () =>
      deriveThreadSubagents(threadActivities, {
        sessionLive: agentSessionLive,
        parentTurnState: activeLatestTurn?.state ?? null,
      }),
    [activeLatestTurn?.state, agentSessionLive, threadActivities],
  );
  const agentPanelModel = useMemo(
    () =>
      deriveThreadAgentPanelModel({
        activities: threadActivities,
        transcriptSubagents: threadSubagents,
        sessionLive: agentSessionLive,
      }),
    [agentSessionLive, threadActivities, threadSubagents],
  );
  const {
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    onSelectActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
  } = useChatPendingUserInput({
    pendingUserInputs,
    respondingUserInputRequestIds,
    readComposer,
    promptRef,
    onRespondToUserInput,
  });
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const planSidebarLabel = "Overview";
  const showPlanFollowUpPrompt = isPlanFollowUpReady({
    hasPendingUserInput: pendingUserInputs.length > 0,
    interactionMode,
    latestTurnSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
  });
  const activePendingApproval = pendingApprovals[0] ?? null;
  const { bindLocalDispatch, localDispatchStartedAt, isPreparingWorktree, isSendBusy } =
    useLocalDispatchState({
      threadKey: routeThreadKey,
      activeThread,
      activeLatestTurn,
      phase,
      activePendingApproval: activePendingApproval?.requestId ?? null,
      activePendingUserInput: activePendingUserInput?.requestId ?? null,
      threadError: activeThread?.error,
    });
  const canonicalProvider = useMemo(
    () =>
      activeThread?.session?.provider ??
      providerStatuses.find(
        (provider) => provider.instanceId === activeThread?.modelSelection.instanceId,
      )?.driver ??
      null,
    [activeThread?.modelSelection.instanceId, activeThread?.session?.provider, providerStatuses],
  );
  const activeThreadStarted = threadHasStarted(activeThread);
  const orchestrationStatus = activeThread?.session?.orchestrationStatus ?? null;
  const providerSelectionPolicy = useMemo(
    () =>
      deriveProviderSelectionPolicy({
        threadStarted: activeThreadStarted,
        canonicalProvider,
        phase,
        orchestrationStatus,
        isConnecting,
        isSendBusy,
        isPreparingWorktree,
        hasPendingApproval: pendingApprovals.length > 0,
        hasPendingUserInput: pendingUserInputs.length > 0,
        hasQueuedMessage: queuedMessages.length > 0,
        isRevertingCheckpoint,
        mutationAllowed: dispatchCapability.allowed,
        environmentAvailable: !activeEnvironmentUnavailable,
        isPhoneTier: presentationTier === "phone",
      }),
    [
      activeEnvironmentUnavailable,
      activeThreadStarted,
      canonicalProvider,
      dispatchCapability.allowed,
      isConnecting,
      isPreparingWorktree,
      isRevertingCheckpoint,
      isSendBusy,
      pendingApprovals.length,
      pendingUserInputs.length,
      phase,
      presentationTier,
      queuedMessages.length,
      orchestrationStatus,
    ],
  );
  const lockedProvider = providerSelectionPolicy.lockedProvider;
  const unlockedSelectedProvider =
    providerStatuses.find((provider) => provider.instanceId === selectedProviderByThreadId)
      ?.driver ??
    resolveSelectableProvider(
      providerStatuses,
      selectedProviderByThreadId ?? threadProvider ?? ProviderDriverKind.make("codex"),
    );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  // Background work (subagent fleets, workflow runs, watch loops) can outlive
  // the turn; once it settles, the composer stop button is gone, so this
  // banner is the only visible stop affordance. Stop routes through the
  // stop-everything interrupt: it kills every live background task before
  // interrupting the parent turn.
  // An archived thread's stub carries none of this; its full summary loads on open.
  const activeThreadSummary = useStore((store) =>
    fullThreadEntry(selectSidebarThreadSummaryByRef(store, activeThreadRef)),
  );
  const activeBackgroundLiveness =
    !isWorking && activeThread ? (activeThreadSummary?.backgroundLiveness ?? null) : null;
  const [isStoppingBackgroundWork, setIsStoppingBackgroundWork] = useState(false);
  useEffect(() => {
    // "Stopping..." holds until the liveness clears; the interrupt command
    // returning only means the request was accepted.
    if (activeBackgroundLiveness === null) {
      setIsStoppingBackgroundWork(false);
    }
  }, [activeBackgroundLiveness]);
  useEffect(() => {
    if (!isStoppingBackgroundWork) return;
    // Dispatch acknowledges the command, not provider cancellation. Allow a
    // retry if no settlement arrives; never claim the agents have stopped.
    const timeout = window.setTimeout(() => setIsStoppingBackgroundWork(false), 20_000);
    return () => window.clearTimeout(timeout);
  }, [isStoppingBackgroundWork]);
  useEffect(() => {
    // Per-thread state: switching threads while A's stop is pending must not
    // disable B's Stop button.
    setIsStoppingBackgroundWork(false);
  }, [activeThreadId]);
  const handleStopBackgroundWork = useCallback(() => {
    setIsStoppingBackgroundWork(true);
    void (async () => {
      try {
        await onInterrupt();
      } catch (error) {
        // Every failure clears the pending state — the interrupt never
        // reached the server, so liveness would hold "Stopping..." forever.
        setIsStoppingBackgroundWork(false);
        if (activeThreadId) {
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : "Failed to stop background work.",
          );
        }
      }
    })();
  }, [activeThreadId, onInterrupt, setThreadError]);
  const handleStopBackgroundTask = useCallback(
    async (task: BackgroundTask) => {
      if (
        !activeThreadId ||
        !task.runtimeSessionId ||
        !dispatchCapability.allowed ||
        activeEnvironmentUnavailable ||
        sideChatConnection.phase !== "connected"
      ) {
        throw new Error("This connection is not ready to stop tasks.");
      }
      const stop = readEnvironmentApi(environmentId)?.orchestration.stopBackgroundTask;
      if (!stop) throw new Error("This environment cannot stop individual tasks.");
      await stop({
        threadId: activeThreadId,
        taskId: task.id,
        expected: {
          runtimeSessionId: RuntimeSessionId.make(task.runtimeSessionId),
          attempt: task.attempt,
        },
      });
    },
    [
      activeThreadId,
      dispatchCapability.allowed,
      activeEnvironmentUnavailable,
      environmentId,
      sideChatConnection.phase,
    ],
  );
  // A launched first turn counts from the send, through its worktree setup.
  const launchWorkStartedAt = resolveWorktreeLaunchWorkStartedAt(
    worktreeLaunch,
    activeThread?.messages,
  );
  const activeWorkStartedAt =
    launchWorkStartedAt ??
    deriveActiveWorkStartedAt(
      activeLatestTurn,
      activeThread?.session ?? null,
      localDispatchStartedAt,
    );
  const serverMessages = activeThread?.messages;
  const { attachmentPreviewHandoffByMessageId, handoffAttachmentPreviews } =
    useChatAttachmentPreviewHandoff({
      serverMessages,
      optimisticUserMessagesRef,
    });
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (!isChatImageAttachment(attachment)) {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntryIndexRef = useRef<{
    readonly threadId: ThreadId | null;
    readonly index: ReturnType<typeof createTimelineEntryIndex>;
  }>({ threadId: null, index: createTimelineEntryIndex() });
  const timelineEntries = useMemo(() => {
    if (timelineEntryIndexRef.current.threadId !== activeThreadId) {
      timelineEntryIndexRef.current = {
        threadId: activeThreadId,
        index: createTimelineEntryIndex(),
      };
    }
    return timelineEntryIndexRef.current.index.update({
      messages: timelineMessages,
      proposedPlans: activeThread?.proposedPlans ?? [],
      workEntries: workLogEntries,
      contextCompactionEntries,
      contextHandoffEntries,
      forkOriginEntries,
    });
  }, [
    activeThreadId,
    activeThread?.proposedPlans,
    contextCompactionEntries,
    contextHandoffEntries,
    forkOriginEntries,
    timelineMessages,
    workLogEntries,
  ]);
  // "Empty" for the new-thread surface means nothing to show at all, not merely
  // no chat messages. A thread can already carry work-log rows, a proposed plan,
  // or setup-script activity from worktree creation while `messages` is still
  // empty; showing the hero then would hide real progress — and real failures.
  const showNewThreadSurface =
    paneThreadRef === null &&
    shouldShowNewThreadSurface({
      hasThread: activeThread !== undefined,
      messageCount: activeThread?.messages.length ?? 0,
      optimisticMessageCount: optimisticUserMessages.length,
      timelineEntryCount: timelineEntries.length,
      presentationTier,
      historyPending: threadHistoryPending,
    });
  const chatColumnRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const newThreadHeroRef = useRef<HTMLDivElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  // The first send from the new-thread surface: hero out, composer to its dock.
  const { captureFirstSendLayout, enteringMessageId } = useFirstSendTransition({
    showNewThreadSurface,
    chatColumnRef,
    heroRef: newThreadHeroRef,
    composerBoxRef,
    composerBarRef: composerOverlayRef,
    latestOptimisticMessageId: optimisticUserMessages.at(-1)?.id ?? null,
  });

  const loadedThreadMessageSearchOccurrences = useMemo(
    () =>
      buildThreadMessageSearchOccurrences({
        timelineEntries,
        query: threadMessageSearchQuery,
      }),
    [threadMessageSearchQuery, timelineEntries],
  );
  useEffect(() => {
    const query = debouncedThreadMessageSearchQuery.trim();
    if (!threadMessageSearchOpen || !activeThreadRef || query.length < 2) {
      setServerThreadMessageSearchResults([]);
      return;
    }
    const api = readEnvironmentApi(activeThreadRef.environmentId);
    if (!api) {
      setServerThreadMessageSearchResults([]);
      return;
    }
    let cancelled = false;
    void api.orchestration
      .searchThreadMessages({
        query,
        threadId: activeThreadRef.threadId,
        limit: 50,
      })
      .then((results) => {
        if (!cancelled) setServerThreadMessageSearchResults(results);
      })
      .catch(() => {
        if (!cancelled) setServerThreadMessageSearchResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadRef, debouncedThreadMessageSearchQuery, threadMessageSearchOpen]);
  const threadMessageSearchOccurrences = useMemo(() => {
    const loadedMessageIds = new Set(
      loadedThreadMessageSearchOccurrences.map((occurrence) => occurrence.messageId),
    );
    const unloadedOccurrences: ThreadMessageSearchOccurrence[] = [];
    for (const result of serverThreadMessageSearchResults) {
      if (loadedMessageIds.has(result.messageId)) continue;
      unloadedOccurrences.push({
        id: `server:${result.messageId}`,
        messageId: result.messageId,
        occurrenceIndex: loadedThreadMessageSearchOccurrences.length + unloadedOccurrences.length,
        messageOccurrenceIndex: 0,
        start: 0,
        end: 0,
        text: threadMessageSearchQuery.trim(),
      });
    }
    return [...loadedThreadMessageSearchOccurrences, ...unloadedOccurrences];
  }, [
    loadedThreadMessageSearchOccurrences,
    serverThreadMessageSearchResults,
    threadMessageSearchQuery,
  ]);
  const threadMessageSearchOccurrencesByMessageId = useMemo(() => {
    if (!threadMessageSearchOpen) {
      return new Map<MessageId, ReadonlyArray<ThreadMessageSearchOccurrence>>();
    }

    const byMessageId = new Map<MessageId, ThreadMessageSearchOccurrence[]>();
    for (const occurrence of threadMessageSearchOccurrences) {
      const existing = byMessageId.get(occurrence.messageId);
      if (existing) {
        existing.push(occurrence);
      } else {
        byMessageId.set(occurrence.messageId, [occurrence]);
      }
    }
    return byMessageId;
  }, [threadMessageSearchOccurrences, threadMessageSearchOpen]);
  const threadMessageSearchMatchCount = threadMessageSearchOccurrences.length;
  const selectedThreadMessageSearchIndex = clampThreadMessageSearchIndex(
    threadMessageSearchSelectedIndex,
    threadMessageSearchMatchCount,
  );
  const selectedThreadMessageSearchOccurrence =
    threadMessageSearchOccurrences[selectedThreadMessageSearchIndex] ?? null;
  const selectedThreadMessageSearchMessageId =
    selectedThreadMessageSearchOccurrence?.messageId ?? null;
  const revealThreadMessageSearchMatch = useCallback((messageId: MessageId) => {
    setThreadMessageSearchTarget((current) => ({
      messageId,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }, []);
  useEffect(() => {
    setThreadMessageSearchSelectedIndex(0);
  }, [activeThreadKey, threadMessageSearchQuery]);
  useEffect(() => {
    setThreadMessageSearchSelectedIndex((currentIndex) =>
      clampThreadMessageSearchIndex(currentIndex, threadMessageSearchMatchCount),
    );
  }, [threadMessageSearchMatchCount]);
  useEffect(() => {
    if (!threadMessageSearchOpen || !selectedThreadMessageSearchMessageId) {
      setThreadMessageSearchTarget(null);
      return;
    }
    revealThreadMessageSearchMatch(selectedThreadMessageSearchMessageId);
  }, [
    revealThreadMessageSearchMatch,
    selectedThreadMessageSearchMessageId,
    threadMessageSearchOpen,
  ]);
  useEffect(() => {
    if (
      !threadMessageSearchOpen ||
      !selectedThreadMessageSearchMessageId ||
      !activeThreadRef ||
      !activeThreadMessageHistory ||
      activeThread?.messages.some((message) => message.id === selectedThreadMessageSearchMessageId)
    ) {
      return;
    }
    void loadThreadHistoryAroundMessage({
      environmentId: activeThreadRef.environmentId,
      threadId: activeThreadRef.threadId,
      messageId: selectedThreadMessageSearchMessageId,
      limit: 101,
    }).catch(() => undefined);
  }, [
    activeThread?.messages,
    activeThreadMessageHistory,
    activeThreadRef,
    selectedThreadMessageSearchMessageId,
    threadMessageSearchOpen,
  ]);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    return deriveRevertTurnCountByUserMessageId({
      timelineEntries,
      turnDiffSummaryByAssistantMessageId,
      inferredCheckpointTurnCountByTurnId,
    });
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);
  const undoTurnCountByTurnId = useMemo(() => {
    return deriveUndoTurnCountByTurnId({
      turnDiffSummaries,
      inferredCheckpointTurnCountByTurnId,
    });
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaries]);

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  // A chat folder is never treated as a repository: no Git status, pull request
  // or CI queries run against it (the overview's Changes would only ever say
  // "No changes" there, since a chat records no checkpoints).
  const sourceControlCwd = isChatContext ? null : gitCwd;
  const gitStatusQuery = useGitStatus({ environmentId, cwd: sourceControlCwd });
  const queryClient = useQueryClient();
  const {
    postPushWorkflowWatch,
    handlePostPush: handlePostPushGitAction,
    clearWatch: clearPostPushWatch,
  } = usePostPushWorkflowWatch();
  const keybindings = useAppKeybindings(activeProjectRef);
  const availableEditors = useServerAvailableEditors();
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const activeProviderInstanceId =
    activeThread?.session?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  const providerStatusNotice = resolveProviderStatusNotice(activeProviderStatus);
  const [dismissedProviderStatusKey, setDismissedProviderStatusKey] = useState<string | null>(null);
  const visibleProviderStatusNotice =
    providerStatusNotice &&
    providerStatusNotice.key !== dismissedProviderStatusKey &&
    !isProviderStatusNoticeDismissed(providerStatusNotice.key)
      ? providerStatusNotice
      : null;
  // Provider status joins the composer banner stack (lowest priority) instead
  // of floating over the transcript, so it stays opaque and dismissible.
  // Usage limits: snooze eligibility matches the inbox (a local queue blocks it),
  // with the capability of the thread's own node, as the inbox reads it.
  const reportedThreadCapabilities = useSyncExternalStore(
    subscribeReportedThreadCapabilities,
    getReportedThreadCapabilitiesSnapshot,
    getReportedThreadCapabilitiesSnapshot,
  );
  const activeThreadSettlementSupported = activeThreadSummary
    ? resolveEnvironmentThreadCapabilities(activeThreadSummary.environmentId, {
        reported: reportedThreadCapabilities,
      }).threadSettlement
    : "unknown";
  const usageLimitSnoozeEligibility = useMemo(
    () =>
      activeThreadSummary
        ? deriveThreadSnoozeEligibility({
            thread: activeThreadSummary,
            worktree: activeWorktreeSummary,
            environment: { threadSettlementSupported: activeThreadSettlementSupported },
            hasLocalQueuedMessage: queuedMessages.length > 0,
            nowMs: Date.now(),
          })
        : { canSnooze: false },
    [
      activeThreadSettlementSupported,
      activeThreadSummary,
      activeWorktreeSummary,
      queuedMessages.length,
    ],
  );
  const usageLimitBannerItem = useUsageLimitBannerItem({
    // The web phone tier is frozen: no new banners there.
    thread: isServerThread && presentationTier !== "phone" ? (activeThread ?? null) : null,
    environmentId: activeThread?.environmentId ?? null,
    serverConfig,
    dispatchAllowed: dispatchCapability.allowed,
    snoozeEligibility: usageLimitSnoozeEligibility,
  });
  const composerBannerStackItems = useMemo<ComposerBannerStackItem[]>(() => {
    const baseItems = usageLimitBannerItem
      ? [usageLimitBannerItem, ...composerBannerItems]
      : composerBannerItems;
    if (!visibleProviderStatusNotice) {
      return baseItems;
    }
    const { key, variant, title, description } = visibleProviderStatusNotice;
    return [
      ...baseItems,
      {
        id: `provider-status:${key}`,
        variant,
        icon: <CircleAlertIcon />,
        title,
        description: (
          <span className="line-clamp-3" title={description}>
            {description}
          </span>
        ),
        dismissLabel: "Dismiss provider status",
        onDismiss: () => {
          dismissProviderStatusNotice(key);
          setDismissedProviderStatusKey(key);
        },
      },
    ];
  }, [composerBannerItems, usageLimitBannerItem, visibleProviderStatusNotice]);

  useEffect(() => {
    if (routeKind !== "server" || !sourceControlCwd) return;
    const releaseDesktop = retainDesktopWorkspaceVcsScope(environmentId, sourceControlCwd);
    const releaseHosted = retainHostedWorkspaceVcsScope(environmentId, sourceControlCwd);
    return () => {
      releaseHosted();
      releaseDesktop();
    };
  }, [environmentId, routeKind, sourceControlCwd]);

  useEffect(() => {
    if (routeKind !== "server") return;
    const releaseDesktop = retainDesktopWorkspaceProviderScope(
      environmentId,
      activeProviderStatus?.instanceId,
    );
    const releaseHosted = retainHostedWorkspaceProviderScope(
      environmentId,
      activeProviderStatus?.instanceId,
    );
    return () => {
      releaseHosted();
      releaseDesktop();
    };
  }, [activeProviderStatus?.instanceId, environmentId, routeKind]);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalLaunchContext?.threadId === activeThreadId
      ? terminalLaunchContext
      : (storeServerTerminalLaunchContext ?? null);
  // Default true while loading to avoid toolbar flicker. A chat folder is never
  // a repository here (promotion with Git turns it into a project first).
  const isGitRepo = isChatContext ? false : (gitStatusQuery.data?.isRepo ?? true);
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const {
    onOpenReviewPanel,
    onToggleDiff,
    onOpenFilesPanel,
    onOpenBrowserPanel,
    onOpenPullRequestPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    onToggleWorkspacePanel,
    onOpenTurnDiff,
    onCloseDiff,
    onOpenAgentsPanel,
    onOpenRuntimeAgentPanel,
    onOpenAgentsWorkflowPanel,
    onOpenSubagentPanel,
    onOpenHtmlRender,
  } = useChatWorkspacePanels({
    navigate,
    environmentId,
    threadId,
    routeKind,
    draftId,
    isServerThread,
    hasActiveProject: Boolean(activeProject),
    diffOpen,
    workspacePanelOpen,
    externalToggleWorkspacePanel,
    onDiffPanelOpen,
    onPreviewPanelOpen,
    onTerminalPanelOpen,
    onSimulatorPanelOpen,
    onAgentPanelOpen,
  });
  // The overview's change request opens beside the chat in the workspace
  // panel; the full page stays one click away from the panel's own bar.
  const openPullRequestInApp =
    activeProject && presentationTier !== "phone" ? onOpenPullRequestPanel : undefined;
  // The header names the same pull request the overview does: the workspace's
  // links plus whatever the checkout's branch has right now, current first.
  const headerPullRequests = useMemo(
    () =>
      resolveThreadPullRequests({
        links: activeWorktreePullRequests,
        live: gitStatusQuery.data?.pr ?? null,
        discoversPullRequests: activeWorktreeDiscoversPullRequests,
      }),
    [activeWorktreeDiscoversPullRequests, activeWorktreePullRequests, gitStatusQuery.data?.pr],
  );
  const headerPullRequest = headerPullRequests[0] ?? null;
  const [headerPullRequestsOpen, setHeaderPullRequestsOpen] = useState(false);
  const [headerPullRequestsView, setHeaderPullRequestsView] =
    useState<WorkspacePullRequestsView>("list");
  const headerPullRequestsEditing = useWorkspacePullRequestEditing({
    environmentId,
    worktree: activeWorktreeSummary
      ? { ...activeWorktreeSummary, worktreeId: activeWorktreeSummary.id }
      : null,
  });
  const headerStoredPullRequestNumbers = useMemo(
    () => new Set(activeWorktreePullRequests.map((link) => link.number)),
    [activeWorktreePullRequests],
  );
  // One popover for the header, mounted while the header names a pull request
  // (it never remounts between one and two). With several, the chip toggles it.
  // The chip element itself (it is replaced when it switches between its
  // one-click and toggle forms), so the popover follows it.
  const [headerPullRequestBadge, setHeaderPullRequestBadge] = useState<HTMLButtonElement | null>(
    null,
  );
  const headerHasSeveralPullRequests = hasSeveralPullRequests(headerPullRequests);
  const headerPullRequestNumber = headerPullRequest?.number ?? null;
  const headerShowsPullRequests = Boolean(openPullRequestInApp) && headerPullRequestNumber !== null;
  // Nothing left to hang from: close now rather than pop up (and take focus)
  // when a pull request comes back.
  if (headerPullRequestsOpen && !headerShowsPullRequests) {
    setHeaderPullRequestsOpen(false);
    setHeaderPullRequestsView("list");
  }
  // ChatView follows thread navigation instead of remounting, so per-thread
  // popovers, dialogs and dismissals start over when the thread changes.
  const [threadScopedStateKey, setThreadScopedStateKey] = useState(activeThreadKey);
  if (threadScopedStateKey !== activeThreadKey) {
    setThreadScopedStateKey(activeThreadKey);
    setHeaderPullRequestsOpen(false);
    setHeaderPullRequestsView("list");
    setHeaderLinkedItem(null);
    setDismissedProviderStatusKey(null);
  }
  const toggleHeaderPullRequests = useCallback(() => {
    setHeaderPullRequestsView("list");
    setHeaderPullRequestsOpen((open) => !open);
  }, []);
  const headerPullRequestsToggle = useMemo(
    () =>
      headerShowsPullRequests
        ? { open: headerPullRequestsOpen, onToggle: toggleHeaderPullRequests }
        : undefined,
    [headerPullRequestsOpen, headerShowsPullRequests, toggleHeaderPullRequests],
  );
  const headerPullRequestsPopover =
    openPullRequestInApp && headerPullRequestNumber !== null ? (
      <WorkspacePullRequestsPopover
        environmentId={environmentId}
        worktreeId={
          headerPullRequestsEditing.supported ? (activeWorktreeSummary?.id ?? null) : null
        }
        cwd={sourceControlCwd}
        workspaceTitle={
          activeWorktreeSummary?.title ?? activeWorktreeSummary?.branch ?? activeThread?.title ?? ""
        }
        workspaceBranch={activeWorktreeSummary?.branch ?? activeThread?.branch ?? null}
        links={headerPullRequests}
        storedNumbers={headerStoredPullRequestNumbers}
        shownNumber={headerPullRequestNumber}
        showStack
        canEdit={headerPullRequestsEditing.ready}
        open={headerPullRequestsOpen}
        onOpenChange={setHeaderPullRequestsOpen}
        view={headerPullRequestsView}
        onViewChange={setHeaderPullRequestsView}
        anchor={headerPullRequestBadge}
        toggle={headerHasSeveralPullRequests ? () => headerPullRequestBadge : undefined}
        side="bottom"
        align="start"
        // The current one opens unpinned, so the tab keeps following the thread.
        onOpenPullRequest={(number) =>
          openPullRequestInApp(number === headerPullRequestNumber ? undefined : number)
        }
      />
    ) : null;
  // The crown's Pull request section links pull requests through the same popover.
  const overviewPullRequestLinking = useMemo<OverviewPullRequestLinking | undefined>(
    () =>
      openPullRequestInApp && headerPullRequestsEditing.supported && activeWorktreeSummary
        ? {
            environmentId,
            worktreeId: activeWorktreeSummary.id,
            cwd: sourceControlCwd,
            workspaceTitle:
              activeWorktreeSummary.title ??
              activeWorktreeSummary.branch ??
              activeThread?.title ??
              "",
            workspaceBranch: activeWorktreeSummary.branch ?? activeThread?.branch ?? null,
            links: headerPullRequests,
            storedNumbers: headerStoredPullRequestNumbers,
            shownNumber: headerPullRequestNumber,
            canEdit: headerPullRequestsEditing.ready,
            onOpenPullRequest: (number) =>
              openPullRequestInApp(number === headerPullRequestNumber ? undefined : number),
          }
        : undefined,
    [
      activeThread?.branch,
      activeThread?.title,
      activeWorktreeSummary,
      environmentId,
      headerPullRequestNumber,
      headerPullRequests,
      headerPullRequestsEditing.ready,
      headerPullRequestsEditing.supported,
      headerStoredPullRequestNumbers,
      openPullRequestInApp,
      sourceControlCwd,
    ],
  );
  // On desktop the header's pull request opens in the workspace panel's PR tab;
  // elsewhere (and for issues and work items) it opens the linked-item dialog.
  const openHeaderLinkedItem = useCallback(
    (item: LinkedWorktreeItem) => {
      if (item.kind === "pr" && openPullRequestInApp) {
        openPullRequestInApp(item.number === headerPullRequest?.number ? undefined : item.number);
        return;
      }
      handleOpenHeaderLinkedItem(item);
    },
    [handleOpenHeaderLinkedItem, headerPullRequest?.number, openPullRequestInApp],
  );
  const envLocked = Boolean(
    worktreeSetupOnScreen ||
    // A queued first send belongs to the draft's environment: moving the draft
    // would leave it behind.
    queuedMessages.length > 0 ||
    (activeThread &&
      (activeThread.messages.length > 0 ||
        (activeThread.session !== null && activeThread.session.status !== "closed"))),
  );

  const moveDraftThreadToProject = useComposerDraftStore((store) => store.moveDraftThreadToProject);
  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      if (isPendingChat) {
        const target = chatExecutionCandidates.find(
          (candidate) => candidate.environmentId === nextEnvironmentId,
        );
        if (!target?.reachable || target.chatsAvailable === false) return;
        moveDraftThreadToProject(draftId, buildChatDraftTarget(nextEnvironmentId, newProjectId()));
        return;
      }
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target || target.disabled) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [
      chatExecutionCandidates,
      draftId,
      envLocked,
      isPendingChat,
      logicalProjectEnvironments,
      moveDraftThreadToProject,
      setDraftThreadContext,
    ],
  );
  const hostedDraftTarget = useHostedDraftExecutionTarget({
    draftId,
    project: activeProject ?? null,
    pendingChat:
      isPendingChat && draftThread
        ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
        : null,
    locked: envLocked || routeKind === "server" || isSendBusy,
  });
  const hostedDemandEnvironmentId = hostedDraftTarget.pending?.environmentId ?? environmentId;
  useEffect(() => {
    if (routeKind === "draft" && hostedWorkspace.status !== "signed-out") {
      const nodeId = nodeIdForHostedEnvironment(hostedDemandEnvironmentId);
      if (nodeId) adoptRoutedHostedNode(nodeId);
    }
    const releaseHostedDemand = retainHostedWorkspaceThreadScope(
      hostedDemandEnvironmentId,
      threadId,
    );
    if (routeKind !== "server") return releaseHostedDemand;
    // The open view: provider history recovery follows it, never a prewarm.
    const releaseSubscription = retainThreadDetailSubscription(environmentId, threadId, {
      view: true,
    });
    return () => {
      releaseHostedDemand();
      releaseSubscription();
    };
  }, [environmentId, hostedDemandEnvironmentId, hostedWorkspace.status, routeKind, threadId]);
  const executionTargets = useMemo(
    () =>
      hostedWorkspace.status === "signed-out"
        ? isPendingChat
          ? chatComposerExecutionTargets({
              candidates: chatExecutionCandidates,
              environmentId,
              label: primaryDeviceName,
            })
          : logicalProjectEnvironments
        : hostedComposerExecutionTargets({
            machines: hostedWorkspace.machines,
            ready: hostedWorkspace.status === "ready",
            environmentId,
            label: primaryDeviceName,
          }),
    [
      chatExecutionCandidates,
      environmentId,
      hostedWorkspace,
      isPendingChat,
      logicalProjectEnvironments,
      primaryDeviceName,
    ],
  );
  const onExecutionTargetChange =
    hostedWorkspace.status === "signed-out"
      ? onEnvironmentChange
      : hostedDraftTarget.selectEnvironment;
  const executionTargetLocked =
    envLocked || routeKind === "server" || isSendBusy || hostedDraftTarget.pending !== null;
  // An empty thread shows its context as pills above the composer: the
  // new-worktree switch (git projects only) and the device, which then leaves
  // the composer footer so it is offered once.
  const showNewThreadContextBar = showNewThreadComposerSpacer && showNewThreadSurface;
  const executionTargetHoisted = showNewThreadContextBar && executionTargets.length > 0;
  const executionTargetMachine =
    hostedWorkspace.status === "signed-out"
      ? desktopExecutionMachines.find((machine) => machine.environmentId === environmentId)
      : hostedWorkspace.machines.find((machine) => machine.environmentId === environmentId);
  const workspaceExecutionTargetUnavailable =
    routeKind === "draft" &&
    (desktopWorkspace.status === "ready" || hostedWorkspace.status === "ready") &&
    executionTargetMachine?.canMutate !== true;

  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  // Invariant: on the phone tier the composer is focused by the user's own tap
  // and never programmatically. The collapsed composer is the real editor now,
  // not a hidden stand-in, so every programmatic focus would expand it, move
  // the caret, and raise the software keyboard — including from behind a
  // full-screen sheet, and including on paths that cannot raise it reliably
  // anyway because they run outside the activating task. Enforcing it here
  // means every call site inherits it. Composer-internal focus
  // (ComposerPromptEditor's own focusAt*, driven by composer gestures) is a
  // different concern and is unaffected.
  const focusComposer = useCallback(() => {
    if (!paneFocusedRef.current || presentationTierRef.current === "phone") return;
    readComposer()?.focusAtEnd();
  }, [paneFocusedRef, readComposer]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const getQueuedEditUnavailableReason = useCallback(
    (message: QueuedMessage) =>
      resolveQueuedMessageEditUnavailableReason({
        deliveryStatus: message.deliveryStatus,
        steering: steeringQueuedMessageIds.includes(message.id),
        composerHasContent: composerDraftHasContent,
      }),
    [composerDraftHasContent, steeringQueuedMessageIds],
  );
  // Edit = take the message out of the queue and put its content back into the
  // composer. Sending it again re-queues it (at the end) while the turn runs.
  // The queued image copies own their preview URLs, so they move over as-is.
  const handleEditQueuedMessage = useCallback(
    (id: string) => {
      if (!activeThreadKey) return;
      const queueState = useMessageQueueStore.getState();
      const message = queueState.queuesByThreadKey[activeThreadKey]?.find(
        (entry) => entry.id === id,
      );
      if (!message) return;
      const refs = { promptRef, composerImagesRef, composerTerminalContextsRef };
      const unavailableReason = resolveQueuedMessageEditUnavailableReason({
        deliveryStatus: message.deliveryStatus,
        steering: queueState.steerAttemptsByThreadKey[activeThreadKey]?.[id] !== undefined,
        composerHasContent: composerRefsHaveContent(refs),
      });
      if (unavailableReason !== null) return;
      removeMessageFromQueue(activeThreadKey, id);
      restoreComposerContent({
        refs,
        composerHandle: { readComposer },
        draft: {
          composerDraftTarget,
          setComposerDraftPrompt,
          addComposerDraftImages,
          setComposerDraftTerminalContexts,
        },
        prompt: message.composer.promptForRestore ?? message.composer.prompt,
        images: message.composer.images,
        terminalContexts: message.composer.sendableTerminalContexts,
      });
      for (const context of message.composer.sourceControlContexts) {
        addComposerDraftSourceControlContext(composerDraftTarget, context);
      }
      scheduleComposerFocus();
    },
    [
      activeThreadKey,
      addComposerDraftImages,
      addComposerDraftSourceControlContext,
      composerDraftTarget,
      readComposer,
      removeMessageFromQueue,
      scheduleComposerFocus,
      setComposerDraftPrompt,
      setComposerDraftTerminalContexts,
    ],
  );

  // Points a draft at a new "No project" chat in place, keeping its prompt,
  // attachments and model; returns the chat's (not yet created) project id.
  const moveDraftToNewChat = useCallback(
    (targetDraftId: DraftId, targetEnvironmentId: EnvironmentId): ProjectId => {
      const projectId = newProjectId();
      moveDraftThreadToProject(targetDraftId, buildChatDraftTarget(targetEnvironmentId, projectId));
      return projectId;
    },
    [moveDraftThreadToProject],
  );
  // "or start without a project": the composed draft becomes a chat.
  const draftEnvironmentId = activeThread?.environmentId ?? null;
  const startDraftWithoutProject = useCallback(() => {
    if (!draftId || !draftEnvironmentId) return;
    moveDraftToNewChat(draftId, draftEnvironmentId);
    scheduleComposerFocus();
  }, [draftEnvironmentId, draftId, moveDraftToNewChat, scheduleComposerFocus]);
  const openThreadMessageSearch = useCallback(() => {
    if (!activeThreadId) return;
    setThreadMessageSearchOpen(true);
    setThreadMessageSearchFocusRequestId((requestId) => requestId + 1);
  }, [activeThreadId]);
  const closeThreadMessageSearch = useCallback(() => {
    setThreadMessageSearchOpen(false);
    setThreadMessageSearchTarget(null);
    scheduleComposerFocus();
  }, [scheduleComposerFocus]);
  const navigateThreadMessageSearch = useCallback(
    (direction: "next" | "previous") => {
      if (threadMessageSearchMatchCount === 0) {
        return;
      }
      const nextIndex = moveThreadMessageSearchIndex({
        currentIndex: selectedThreadMessageSearchIndex,
        matchCount: threadMessageSearchMatchCount,
        direction,
      });
      setThreadMessageSearchSelectedIndex(nextIndex);
      const nextOccurrence = threadMessageSearchOccurrences[nextIndex];
      if (nextOccurrence) {
        revealThreadMessageSearchMatch(nextOccurrence.messageId);
      }
    },
    [
      revealThreadMessageSearchMatch,
      selectedThreadMessageSearchIndex,
      threadMessageSearchMatchCount,
      threadMessageSearchOccurrences,
    ],
  );
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      readComposer()?.addTerminalContext(selection);
    },
    [readComposer],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef || !terminalCapability.allowed) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadRef, setTerminalOpen, terminalCapability.allowed, terminalState.terminalOpen]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadRef || hasReachedSplitLimit || !terminalCapability.allowed) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadRef, hasReachedSplitLimit, storeSplitTerminal, terminalCapability.allowed]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef || !terminalCapability.allowed) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadRef, storeNewTerminal, terminalCapability.allowed]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !activeThreadRef || !terminalCapability.allowed) return;
      closeThreadTerminal({
        threadRef: activeThreadRef,
        terminalId,
        isFinalTerminal: terminalState.terminalIds.length <= 1,
        onClosed: () => {
          storeCloseTerminal(activeThreadRef, terminalId);
          setTerminalFocusRequestId((value) => value + 1);
        },
      });
    },
    [
      activeThreadId,
      activeThreadRef,
      storeCloseTerminal,
      terminalState.terminalIds.length,
      terminalCapability.allowed,
    ],
  );
  const { runProjectScript, saveProjectScript, updateProjectScript, deleteProjectScript } =
    useChatProjectScripts({
      environmentId,
      activeThread,
      activeThreadId,
      activeThreadRef,
      activeProject,
      gitCwd,
      terminalState,
      setLastInvokedScriptByProjectId,
      setTerminalLaunchContext,
      setTerminalOpen,
      storeNewTerminal,
      storeSetActiveTerminal,
      setTerminalFocusRequestId,
      setThreadError,
    });

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const handleTokenModeChange = useCallback(
    (mode: AgentTokenMode) => {
      if (mode === tokenMode) return;
      setComposerDraftTokenMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { tokenMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      composerDraftTarget,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftTokenMode,
      setDraftThreadContext,
      tokenMode,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    if (enforceBuildMode) return;
    const askModeSupported = getProviderSupportsAskMode(providerStatuses, selectedProvider);
    const nextMode: ProviderInteractionMode =
      interactionMode === "default"
        ? "plan"
        : interactionMode === "plan" && askModeSupported
          ? "ask"
          : "default";
    handleInteractionModeChange(nextMode);
  }, [
    enforceBuildMode,
    handleInteractionModeChange,
    interactionMode,
    providerStatuses,
    selectedProvider,
  ]);
  // The new-thread surface reads as its own page. The overview describes a
  // thread's history — checks, changes, plan — and an empty thread has none,
  // so suppress it until the user asks for it. This is a display-time override
  // rather than a `planSidebarOpen` reset so the rail reappears on its own the
  // moment the first turn lands, with no second state machine to keep in sync.
  const overviewSuppressedForEmptyThread = showNewThreadSurface && !overviewOpenedOnEmptyThread;
  const setOverviewSidebarOpen = useCallback(
    (open: boolean) => {
      setPlanSidebarOpen(open);
      planSidebarDismissedForTurnRef.current = open
        ? null
        : (activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__");
    },
    [activePlan?.turnId, sidebarProposedPlan?.turnId],
  );
  const closePlanSidebar = useCallback(() => {
    setOverviewSidebarOpen(false);
  }, [setOverviewSidebarOpen]);
  const toggleOverviewSidebar = useCallback(
    (nextOpen?: boolean) => {
      // While the thread is empty the overview reads as closed regardless of
      // `planSidebarOpen`, so the toggle has to invert the *visible* state or
      // the first click would be a no-op.
      const wantsOpen =
        typeof nextOpen === "boolean"
          ? nextOpen
          : overviewSuppressedForEmptyThread
            ? true
            : !planSidebarOpen;
      setOverviewSidebarOpen(wantsOpen);
      setOverviewOpenedOnEmptyThread(wantsOpen);
    },
    [overviewSuppressedForEmptyThread, planSidebarOpen, setOverviewSidebarOpen],
  );

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
      tokenMode: AgentTokenMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      await persistThreadSettingsForNextTurnShared(api, serverThread, input);
    },
    [environmentId, serverThread],
  );

  const startGoalTurnRef = useRef<
    (goal: NonNullable<SendTurnComposerSnapshot["goal"]>) => Promise<boolean>
  >(async () => false);

  const dispatchThreadGoalUpdate = useCallback(
    async (update: ThreadGoalUpdate & { readonly startTurn?: boolean }) => {
      if (!serverThread || !dispatchCapability.allowed) return false;
      const api = readEnvironmentApi(environmentId);
      if (!api) return false;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.goal.set",
          commandId: newCommandId(),
          threadId: serverThread.id,
          ...update,
          createdAt: new Date().toISOString(),
        });
        return true;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update goal",
            description: error instanceof Error ? error.message : "The goal update failed.",
          }),
        );
        return false;
      }
    },
    [dispatchCapability.allowed, environmentId, serverThread],
  );

  const handleEditGoal = useCallback(() => {
    const objective = serverThread?.goal?.objective;
    if (!objective) return;
    const nextPrompt = `/goal ${objective}`;
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    readComposer()?.resetCursorState({
      prompt: nextPrompt,
      cursor: nextPrompt.length,
      detectTrigger: false,
    });
    scheduleComposerFocus();
  }, [
    composerDraftTarget,
    readComposer,
    scheduleComposerFocus,
    serverThread?.goal?.objective,
    setComposerDraftPrompt,
  ]);

  const handleGoalStatusChange = useCallback(
    (status: ThreadGoalStatus) => {
      void dispatchThreadGoalUpdate({
        status,
        startTurn: status === "active" && phase !== "running",
      });
    },
    [dispatchThreadGoalUpdate, phase],
  );

  const handleClearGoal = useCallback(async () => {
    if (!serverThread || !dispatchCapability.allowed) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    return api.orchestration
      .dispatchCommand({
        type: "thread.goal.clear",
        commandId: newCommandId(),
        threadId: serverThread.id,
        createdAt: new Date().toISOString(),
      })
      .then(() => true)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not clear goal",
            description: error instanceof Error ? error.message : "The goal could not be cleared.",
          }),
        );
        return false;
      });
  }, [dispatchCapability.allowed, environmentId, serverThread]);

  // Scroll helpers — LegendList handles auto-scroll via maintainScrollAtEnd.
  // Explicit pins (the pill, the composer resizing, a send) are verified against the
  // live scroller: a composer that grows while a just-opened thread is still
  // laying out would otherwise leave the transcript short of its end, behind
  // the scroll-to-bottom pill (see `pinTimelineToEnd`).
  const timelineEndPinRef = useRef(0);
  const scrollToEnd = useCallback((animated = false) => {
    setTimelineLiveFollowEnabled(true);
    const list = legendListRef.current;
    if (!list) return;
    const pin = ++timelineEndPinRef.current;
    void pinTimelineToEnd(
      {
        scrollToEnd: (options) => list.scrollToEnd?.(options),
        readScrollMetrics: () => {
          const node = list.getScrollableNode?.();
          return node instanceof HTMLElement ? node : null;
        },
      },
      {
        animated,
        shouldContinue: () =>
          pin === timelineEndPinRef.current &&
          legendListRef.current === list &&
          timelineLiveFollowEnabledRef.current,
      },
    );
  }, []);

  // A send does not wait for the list to reach its end, so its row can land
  // while the transcript is away from the end or still moving there: pin the
  // end once the row has rendered and measured.
  const scrollToEndAfterOptimistic = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        scrollToEnd(false);
      });
    });
  }, [scrollToEnd]);

  const stopTimelineLiveFollow = useCallback(() => {
    setTimelineLiveFollowEnabled(false);
    readComposer()?.collapseForReading();
  }, [readComposer]);
  const resumeTimelineLiveFollow = useCallback(() => {
    setTimelineLiveFollowEnabled(true);
  }, []);

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches.  LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);
  // A send follows the transcript's end; its optimistic message does not wait
  // for the list to get there.
  const armTimelineEndFollow = useCallback(() => {
    isAtEndRef.current = true;
    setTimelineLiveFollowEnabled(true);
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    setTimelineLiveFollowEnabled(true);
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    // Honor an explicit "open the overview on the next thread" signal, set when
    // implementing a plan in a freshly created thread (`onImplementPlanInNewThread`).
    // In wide layouts the overview opens by default anyway, but in narrow and
    // split layouts it starts closed on every thread switch — without consuming this
    // signal the request to surface the new thread's plan would be silently lost.
    const openOverviewForNextThread = planSidebarOpenOnNextThreadRef.current;
    planSidebarOpenOnNextThreadRef.current = false;
    // Read through the refs: a tier flip alone must not re-run this reset (it
    // would drop preserved panel state on rotation).
    setPlanSidebarOpen(
      openOverviewForNextThread ||
        overviewOpensByDefault(shouldUseRightPanelSheetRef.current, presentationTierRef.current),
    );
    planSidebarDismissedForTurnRef.current = null;
  }, [activeThread?.id]);

  // Auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  useEffect(() => {
    if (!activePlan) return;
    if (planSidebarOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && activePlan.turnId !== latestTurnId) return;
    const turnKey = activePlan.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
    if (planSidebarDismissedForTurnRef.current === turnKey) return;
    // On the phone tier the overview is a full-screen takeover, so a plan
    // arriving while the user is composing must not steal focus or close the
    // keyboard. Smallest honest behavior: drop the auto-open for this turn
    // (recorded as dismissed so later plan updates in the same turn cannot
    // re-trigger a surprise takeover after blur). The plan stays reachable
    // through the composer plan banner and the thread kebab's "Source
    // control" entry. Tier is read through the ref so a tier flip alone never
    // re-runs this decision.
    // The thread dock is inside the composer form, so focus parked on a dock
    // control — where `MobileSheet` restores it when the thread-actions or
    // sessions sheet closes — suppresses the takeover for this turn too. That
    // is intended, not incidental: without it a plan arriving in that moment
    // would slam a full-screen surface over the sheet the user just used. The
    // containment test is what makes it work, so moving the dock back out of
    // the form would silently change this behavior.
    if (presentationTierRef.current === "phone") {
      const activeElement = document.activeElement;
      const composerFocused =
        activeElement instanceof HTMLElement &&
        activeElement.closest('[data-chat-composer-form="true"]') !== null;
      if (composerFocused) {
        planSidebarDismissedForTurnRef.current = turnKey;
        return;
      }
    }
    setPlanSidebarOpen(true);
  }, [activePlan, activeLatestTurn?.turnId, planSidebarOpen, sidebarProposedPlan?.turnId]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    // A send's local dispatch is kept per thread: back on it, it still shows busy.
    setExpandedImage(null);
  }, [draftId, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const envMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadBranch = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const activeThreadBranch =
    canOverrideServerThreadBranch && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  // The overview panel module builds the git controls from this; ChatView stays
  // free of them (the panel is loaded on demand).
  const overviewPanelControls: OverviewPanelControlsInput = {
    // No Git controls, and so no Git status polling, for a chat folder.
    gitCwd: sourceControlCwd,
    activeThreadRef,
    routeKind,
    draftId,
    onPostPush: handlePostPushGitAction,
    branchControlThread: activeThread
      ? { environmentId: activeThread.environmentId, id: activeThread.id }
      : null,
    isGitRepo,
    canOverrideServerThreadBranch,
    activeThreadBranch,
    onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
    envLocked,
    onComposerFocusRequest: scheduleComposerFocus,
    canCheckoutPullRequestIntoThread,
    onCheckoutPullRequestRequest: openPullRequestDialog,
  };
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });

  // The send's Stop while its worktree is still being set up: the node removes
  // the half-made checkout and the draft gets its message back. A stop that
  // comes too late for that (the thread is already being created) stops the
  // turn as soon as it starts instead.
  const cancelWorktreeSetup = useCallback(() => {
    const launch = readWorktreeLaunch(routeThreadKey);
    if (launch?.phase !== "preparing" || !activeThreadId) return;
    const launches = useWorktreeLaunchStore.getState();
    launches.requestCancel(routeThreadKey);
    const stopOnStart = () => launches.setInterruptOnStart(routeThreadKey);
    const cancel = readEnvironmentApi(environmentId)?.vcs.cancelWorktreeSetup;
    if (!cancel) {
      stopOnStart();
      return;
    }
    void cancel({ threadId: activeThreadId }).then((result) => {
      if (!result.cancelled) stopOnStart();
    }, stopOnStart);
  }, [activeThreadId, environmentId, routeThreadKey]);
  useEffect(() => {
    if (!worktreeLaunch?.interruptOnStart || worktreeLaunch.phase !== "handed-off") return;
    if (phase !== "running") return;
    useWorktreeLaunchStore.getState().clearInterruptOnStart(routeThreadKey);
    void onInterrupt();
  }, [onInterrupt, phase, routeThreadKey, worktreeLaunch?.interruptOnStart, worktreeLaunch?.phase]);
  const retryWorktreeSetup = useCallback(() => {
    void readWorktreeLaunchRetry(routeThreadKey)?.resend();
  }, [routeThreadKey]);
  const dismissWorktreeSetup = useCallback(() => {
    readWorktreeLaunchRetry(routeThreadKey)?.restore();
    forgetWorktreeLaunch(routeThreadKey);
  }, [routeThreadKey]);
  // "Work locally" switches the draft to the project checkout; the message goes
  // out again once that switch has rendered (the send reads the mode it shows).
  const workLocallyRequestedRef = useRef(false);
  const workLocallyAfterFailedSetup = useCallback(() => {
    if (!draftId) return;
    workLocallyRequestedRef.current = true;
    setDraftThreadContext(draftId, { envMode: "local", worktreePath: null });
  }, [draftId, setDraftThreadContext]);
  useEffect(() => {
    if (!workLocallyRequestedRef.current || sendEnvMode !== "local") return;
    workLocallyRequestedRef.current = false;
    const retry = readWorktreeLaunchRetry(routeThreadKey);
    // The local send has no setup to show; the failed one leaves the row.
    stopWorktreeLaunchFeed(routeThreadKey);
    useWorktreeLaunchStore.getState().remove(routeThreadKey);
    void retry?.resend();
  }, [routeThreadKey, sendEnvMode]);
  // A failed launch lives with the view that shows its message: leaving it
  // hands the message back to the draft's composer rather than losing it.
  useEffect(
    () => () => {
      if (readWorktreeLaunch(routeThreadKey)?.phase !== "failed") return;
      readWorktreeLaunchRetry(routeThreadKey)?.restore();
      forgetWorktreeLaunch(routeThreadKey);
    },
    [routeThreadKey],
  );
  const openWorktreeSetupTerminal = useCallback(
    (terminalId: string) => {
      storeSetTerminalOpen(routeThreadRef, true);
      storeSetActiveTerminal(routeThreadRef, terminalId);
    },
    [routeThreadRef, storeSetActiveTerminal, storeSetTerminalOpen],
  );
  const worktreeSetupActions = useMemo<WorktreeSetupActions>(
    () => ({
      onCancel: cancelWorktreeSetup,
      onRetry: retryWorktreeSetup,
      onWorkLocally: workLocallyAfterFailedSetup,
      onDismiss: dismissWorktreeSetup,
      onOpenTerminal: openWorktreeSetupTerminal,
    }),
    [
      cancelWorktreeSetup,
      dismissWorktreeSetup,
      openWorktreeSetupTerminal,
      retryWorktreeSetup,
      workLocallyAfterFailedSetup,
    ],
  );
  // The working row presents the launch while it owns the thread's wait: its
  // setup, its failure, and the first turn it hands the thread to. The frozen
  // phone tier keeps its generic row (AGENTS.md).
  const worktreeSetupTimeline = useMemo<WorktreeSetupTimelineState | null>(
    () =>
      worktreeLaunch &&
      presentationTier !== "phone" &&
      (worktreeSetupFailed || launchWorkStartedAt !== null)
        ? { launch: worktreeLaunch, actions: worktreeSetupActions }
        : null,
    [
      launchWorkStartedAt,
      presentationTier,
      worktreeLaunch,
      worktreeSetupActions,
      worktreeSetupFailed,
    ],
  );

  useEffect(() => {
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadBranch) {
      return;
    }
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadBranch]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalLaunchContext(null);
      storeClearTerminalLaunchContext(routeThreadRef);
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId, routeThreadRef, storeClearTerminalLaunchContext]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        if (activeThreadRef) {
          storeClearTerminalLaunchContext(activeThreadRef);
        }
        return null;
      }
      return current;
    });
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    storeClearTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd || !storeServerTerminalLaunchContext) {
      return;
    }
    const settledCwd = projectScriptCwd({
      project: { cwd: activeProjectCwd },
      worktreePath: activeThreadWorktreePath,
    });
    if (
      settledCwd === storeServerTerminalLaunchContext.cwd &&
      (activeThreadWorktreePath ?? null) === storeServerTerminalLaunchContext.worktreePath
    ) {
      if (activeThreadRef) {
        storeClearTerminalLaunchContext(activeThreadRef);
      }
    }
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (terminalState.terminalOpen) {
      return;
    }
    if (activeThreadRef) {
      storeClearTerminalLaunchContext(activeThreadRef);
    }
    setTerminalLaunchContext((current) => (current?.threadId === activeThreadId ? null : current));
  }, [
    activeThreadId,
    activeThreadRef,
    storeClearTerminalLaunchContext,
    terminalState.terminalOpen,
  ]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalState.terminalOpen]);

  usePaneEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: Boolean(terminalState.terminalOpen),
          modelPickerOpen: readComposer()?.isModelPickerOpen() ?? false,
        },
      });
      if (command !== "thread.find") return;
      if (shouldIgnoreThreadMessageSearchShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      openThreadMessageSearch();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeThreadId,
    keybindings,
    openThreadMessageSearch,
    readComposer,
    terminalState.terminalOpen,
  ]);

  usePaneEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (shouldIgnoreGlobalNavigationShortcut(event) && !projectExplorerOpenRef.current) return;
      const isToggleProjectExplorer = matchesExactModShortcut(event, "p", {
        shiftKey: true,
      });
      if (!isToggleProjectExplorer) return;
      event.preventDefault();
      event.stopPropagation();
      setProjectExplorerInitialTab("prs");
      setProjectExplorerOpen((value) => !value);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // The branch toolbar's inline chips cover the fast path (base branch + create
  // on send); this opens the full picker for worktrees sourced from a PR,
  // issue, or Jira item.
  const openWorktreeSources = useCallback(() => {
    setProjectExplorerInitialTab("prs");
    setProjectExplorerOpen(true);
  }, []);

  useChatGlobalShortcuts({
    activeThreadId,
    keybindings,
    terminalOpen: terminalState.terminalOpen,
    activeTerminalId: terminalState.activeTerminalId,
    readComposer,
    activeProject,
    toggleTerminalVisibility,
    splitTerminal,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    diffOpen,
    onToggleDiff,
    onOpenFilesPanel,
    onOpenReviewPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    runProjectScript,
  });

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      // A revert rewrites the checkout now or not at all; it is never queued.
      if (mutationUnavailableReason !== null) {
        notifyMutationUnavailable(mutationUnavailableReason);
        return;
      }
      const providerInstanceId =
        activeThread?.session?.providerInstanceId ?? activeThread?.modelSelection.instanceId;
      const provider = providerInstanceId
        ? composerProviderStatuses.find((entry) => entry.instanceId === providerInstanceId)
        : undefined;
      await revertToTurnCount({
        thread: activeThread ?? null,
        turnCount,
        environmentUnavailable: activeEnvironmentUnavailable,
        environmentUnavailableLabel: activeEnvironmentUnavailableLabel,
        turnInProgress: phase === "running" || isSendBusy || isConnecting,
        providerRefusal: checkpointRevertUnsupportedMessage(provider),
      });
    },
    [
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      activeThread,
      composerProviderStatuses,
      isConnecting,
      isSendBusy,
      mutationUnavailableReason,
      notifyMutationUnavailable,
      phase,
      revertToTurnCount,
    ],
  );

  const canSendModelSelection = useCallback(
    (targetSelection: ModelSelection): boolean => {
      if (!activeThread) return false;
      return selectionAllowedAtSendBoundary({
        threadStarted: activeThreadStarted,
        policy: providerSelectionPolicy,
        canonicalSelection: activeThread.modelSelection,
        targetSelection,
      });
    },
    [activeThread, activeThreadStarted, providerSelectionPolicy],
  );
  const notifyDevicePromptScreenshot = useCallback((notice: DevicePromptScreenshotNotice) => {
    toastManager.add(
      stackedThreadToast(
        notice.kind === "skipped"
          ? {
              type: "warning",
              title: "The simulator screenshot was skipped",
              description: `This message already has ${notice.maxAttachments} attachments.`,
            }
          : {
              type: "warning",
              title: "Couldn’t attach the simulator screen",
              description:
                notice.reason === "no-attached-device"
                  ? "Open the Simulator workspace and choose a device first."
                  : notice.reason === "device-not-booted"
                    ? "The selected simulator is still starting."
                    : "The current simulator screen could not be attached.",
            },
      ),
    );
  }, []);
  const notifySelectionBecameIneligible = useCallback(() => {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Wait for the thread to become idle",
        description:
          providerSelectionPolicy.reason === "phone-tier"
            ? "Provider switching stays on the current provider in the web phone view."
            : "The staged provider or model was not sent. Try again when this thread is idle.",
      }),
    );
  }, [providerSelectionPolicy.reason]);

  const captureComposerContentGuard = () => {
    const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    const prompt = promptRef.current;
    const showsThread = bindToShownThread();
    return () => {
      const current = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      return (
        // The live prompt is another thread's once the view moved on.
        (showsThread()
          ? promptRef.current !== prompt
          : (current?.prompt ?? "") !== (draft?.prompt ?? "")) ||
        current?.images !== draft?.images ||
        current?.terminalContexts !== draft?.terminalContexts ||
        current?.sourceControlContexts !== draft?.sourceControlContexts
      );
    };
  };

  // `allowed`: a send may proceed, now or through the queue while the
  // connection is being established. `writable`: the node takes writes now.
  const sendTargetAllowed = dispatchCapability.allowed || dispatchEstablishing;
  const editorSendTargetRef = useRef({
    environmentId,
    threadId: activeThread?.id,
    cwd: gitCwd,
    allowed: sendTargetAllowed,
    writable: dispatchCapability.allowed,
  });
  editorSendTargetRef.current = {
    environmentId,
    threadId: activeThread?.id,
    cwd: gitCwd,
    allowed: sendTargetAllowed,
    writable: dispatchCapability.allowed,
  };
  useEffect(() => {
    editorSendTargetRef.current = {
      environmentId,
      threadId: activeThread?.id,
      cwd: gitCwd,
      allowed: sendTargetAllowed,
      writable: dispatchCapability.allowed,
    };
    return () => {
      editorSendTargetRef.current = {
        ...editorSendTargetRef.current,
        allowed: false,
        writable: false,
      };
    };
  }, [activeThread?.id, dispatchCapability.allowed, environmentId, gitCwd, sendTargetAllowed]);
  const drainEditorsBeforeSend = useCallback(async () => {
    if (!activeThread) return false;
    if (!activeProject) {
      // An unsent chat has no folder yet, so no editor can hold unsaved files for it.
      if (!isPendingChat) return false;
      const current = editorSendTargetRef.current;
      return (
        current.allowed &&
        current.environmentId === environmentId &&
        current.threadId === activeThread.id
      );
    }
    const scope = { environmentId, cwd: activeThread.worktreePath ?? activeProject.cwd };
    if (hasUnsavedPreviewFiles(scope) && !editorSendTargetRef.current.writable) {
      // Saving them is a file write, which is never held for a connection.
      toastManager.add({
        type: "info",
        title: "Editor changes could not be saved",
        description: `${mutationUnavailableReason ?? "The connection is not ready."} Your message and file draft are preserved.`,
      });
      return false;
    }
    if (hasUnsavedPreviewFiles(scope) && !(await flushPreviewFiles(scope))) {
      toastManager.add({
        type: "error",
        title: "Editor changes could not be saved",
        description:
          "Your message and file draft are preserved. Resolve the save error in File Preview before sending.",
      });
      return false;
    }
    const current = editorSendTargetRef.current;
    return (
      current.allowed &&
      current.environmentId === environmentId &&
      current.threadId === activeThread.id &&
      current.cwd === scope.cwd
    );
  }, [activeProject, activeThread, environmentId, isPendingChat, mutationUnavailableReason]);

  const prepareEditorSend = useCallback(async () => {
    const preparing = threadSendsPreparing.ref(routeThreadKey);
    if (preparing.current) return false;
    preparing.current = true;
    try {
      return await drainEditorsBeforeSend();
    } finally {
      preparing.current = false;
    }
  }, [drainEditorsBeforeSend, routeThreadKey, threadSendsPreparing]);

  /** Whether a message with these turn settings could steer the running turn right now. */
  const getSteerEligibility = useCallback(
    (snapshot: {
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly tokenMode: AgentTokenMode | undefined;
    }) => {
      const providerInstanceId = activeThread?.session?.providerInstanceId;
      const provider = providerInstanceId
        ? composerProviderStatuses.find((entry) => entry.instanceId === providerInstanceId)
        : undefined;
      const activeTokenMode = activeThread?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
      const activeInteractionMode = activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
      // A steer reaches the running turn now or not at all; it is never queued.
      if (mutationUnavailableReason !== null) {
        return { allowed: false as const, reason: mutationUnavailableReason };
      }
      return resolveQueuedMessageSteerEligibility({
        mutationReady: dispatchCapability.allowed && !activeEnvironmentUnavailable,
        turnRunning: phase === "running",
        activeTurnId: activeThread?.session?.activeTurnId,
        supportsTurnSteering: provider?.supportsTurnSteering === true,
        queuedModelSelection: snapshot.modelSelection,
        activeModelSelection: activeThread?.modelSelection,
        queuedRuntimeMode: snapshot.runtimeMode,
        activeRuntimeMode: activeThread?.runtimeMode,
        queuedInteractionMode: snapshot.interactionMode,
        activeInteractionMode,
        queuedTokenMode: snapshot.tokenMode,
        activeTokenMode,
      });
    },
    [
      activeEnvironmentUnavailable,
      activeThread,
      composerProviderStatuses,
      dispatchCapability.allowed,
      mutationUnavailableReason,
      phase,
    ],
  );

  const getQueuedSteerEligibility = useCallback(
    (message: QueuedMessage) => {
      if (hasRetiredProjectMemory(message.composer))
        return { allowed: false as const, reason: REMOVED_PROJECT_MEMORY_MESSAGE };
      return getSteerEligibility({
        modelSelection: message.composer.selectedModelSelection,
        runtimeMode: message.settings.runtimeMode,
        interactionMode: message.settings.interactionMode,
        tokenMode: message.settings.tokenMode,
      });
    },
    [getSteerEligibility],
  );

  const getQueuedSteerUnavailableReason = useCallback(
    (message: QueuedMessage): string | null => {
      const eligibility = getQueuedSteerEligibility(message);
      return eligibility.allowed ? null : eligibility.reason;
    },
    [getQueuedSteerEligibility],
  );

  /**
   * Starts a steer attempt for a queued entry. The entry stays queued throughout: an accepted
   * steer is reconciled away by its projection, any rejection returns it to the queue, which
   * sends it as the next turn. `explicit` attempts (Steer button, Mod+Enter) report problems.
   */
  const steerQueuedEntry = useCallback(
    async (
      message: QueuedMessage,
      options: { readonly explicit: boolean; readonly prepareEditors: boolean },
    ) => {
      if (!activeThreadKey || !activeThread) return;
      const eligibility = getQueuedSteerEligibility(message);
      if (!eligibility.allowed) {
        if (options.explicit) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Cannot steer this message",
              description: eligibility.reason,
            }),
          );
        }
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) return;

      // Claimed synchronously, before any await, so the drain never sends it as a turn. The
      // store refuses a message already being sent or steered, or no longer queued.
      const commandId = newCommandId();
      if (
        !beginQueuedMessageSteer(activeThreadKey, message.id, {
          commandId,
          expectedTurnId: eligibility.expectedTurnId,
          startedAt: new Date().toISOString(),
          explicit: options.explicit,
        })
      ) {
        return;
      }
      try {
        if (options.prepareEditors && !(await prepareEditorSend())) {
          endQueuedMessageSteer(activeThreadKey, message.id, commandId);
          return;
        }
        const baseText = buildOutgoingMessageText({
          composer: message.composer,
          formatOutgoingPrompt,
        });
        const sourceControlContext = formatSourceControlContextsForAgent(
          message.composer.sourceControlContexts,
        );
        const text = sourceControlContext ? `${sourceControlContext}\n\n${baseText}` : baseText;
        const attachments = await buildOutgoingTurnAttachments(message.composer.images);
        const requestedAt = new Date().toISOString();
        await api.orchestration.dispatchCommand(
          buildQueuedMessageSteerCommand({
            commandId,
            threadId: activeThread.id,
            expectedTurnId: eligibility.expectedTurnId,
            messageId: MessageId.make(message.id),
            text,
            attachments,
            createdAt: message.createdAt ?? requestedAt,
            requestedAt,
          }),
        );
      } catch (error) {
        endQueuedMessageSteer(activeThreadKey, message.id, commandId);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not steer message",
            description: error instanceof Error ? error.message : "The steer request failed.",
          }),
        );
      }
    },
    [
      activeThread,
      activeThreadKey,
      beginQueuedMessageSteer,
      endQueuedMessageSteer,
      prepareEditorSend,
      environmentId,
      getQueuedSteerEligibility,
    ],
  );

  const handleSteerQueuedMessage = useCallback(
    (message: QueuedMessage) => steerQueuedEntry(message, { explicit: true, prepareEditors: true }),
    [steerQueuedEntry],
  );

  /** The composer's running-state hint: why its current selection could not steer. */
  const getFollowUpSteerUnavailableReason = useCallback(
    (snapshot: {
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly tokenMode: AgentTokenMode;
    }): string | null => {
      const eligibility = getSteerEligibility(snapshot);
      return eligibility.allowed ? null : eligibility.reason;
    },
    [getSteerEligibility],
  );

  // The Claude resume review reads what the live thread subscription already holds: only a
  // server thread whose shell is live (not cache) and whose detail is loaded qualifies.
  const activeThreadShellLive = useStore((store) =>
    selectEnvironmentShellLive(store, activeThread?.environmentId),
  );
  const readSubscribedClaudeReviewState = (): SubscribedClaudeReviewState | undefined => {
    const thread = activeThread;
    if (!thread || !isServerThread || !activeThreadShellLive || !activeThreadDetailLoaded) {
      return undefined;
    }
    return {
      thread: {
        modelSelection: thread.modelSelection,
        activities: thread.activities,
        session: thread.session
          ? {
              providerName: thread.session.provider,
              ...(thread.session.runtimeSessionId === undefined
                ? {}
                : { runtimeSessionId: RuntimeSessionId.make(thread.session.runtimeSessionId) }),
              status: thread.session.orchestrationStatus,
              activeTurnId: thread.session.activeTurnId ?? null,
            }
          : null,
      },
      workspaceCwd: thread.worktreePath ?? activeProject?.cwd,
    };
  };

  // Build the executeChatSendTurn input from a composer snapshot and dispatch it.
  // Shared by direct sends and queue flushes, so a queued message replays exactly
  // like a live send.
  // Returns true only after the turn command is accepted.
  const dispatchComposerSnapshot = async (
    composerSnapshot: SendTurnComposerSnapshot,
    settingsSnapshot: SendTurnSettings,
    messageId?: MessageId,
    hooks?: {
      readonly onBeforeTurnStart?: () => void;
      readonly onSendError?: (error: unknown) => void;
    },
  ): Promise<boolean> => {
    if (!dispatchCapability.allowed || hostedDraftTarget.pending !== null) return false;
    // Bound before the first await: the send belongs to the thread shown now.
    const sendThreadKey = routeThreadKey;
    const sendPreparing = threadSendsPreparing.ref(sendThreadKey);
    const sendLocalDispatch = bindLocalDispatch();
    const showsSendThread = bindToShownThread();
    // What a failed worktree launch sends again, before this send's own edits.
    const snapshotForResend = composerSnapshot;
    const api = readEnvironmentApi(environmentId);
    // A pending chat's project is created by this send, so it is not in the store yet.
    if (!api || !activeThread || (!activeProject && !isPendingChat) || sendPreparing.current)
      return false;
    sendPreparing.current = true;
    const composerChangedDuringPreparation = captureComposerContentGuard();
    try {
      rejectRetiredProjectMemory(composerSnapshot);
      if (!(await drainEditorsBeforeSend())) return false;
      const buildMode = applyBuildModeToSend({
        composer: composerSnapshot,
        settings: settingsSnapshot,
        enforceBuildMode,
      });
      composerSnapshot = buildMode.composer;
      if (!canSendModelSelection(composerSnapshot.selectedModelSelection)) {
        notifySelectionBecameIneligible();
        return false;
      }
      composerSnapshot = await attachDevicePromptScreenshot({
        api,
        threadId: activeThread.id,
        composer: composerSnapshot,
        notify: notifyDevicePromptScreenshot,
      });
      const effectiveSettingsSnapshot: SendTurnSettings = buildMode.settings;
      const threadIdForSend = activeThread.id;
      const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
      const { shouldMaterializeLegacyBranchWorktree, baseBranchForWorktree, shouldCreateWorktree } =
        resolveChatSendWorktreePlan({
          isServerThread,
          isFirstMessage,
          threadWorktreePath: activeThread.worktreePath,
          activeThreadBranch,
          currentGitRefName: gitStatusQuery.data?.refName ?? null,
          sendEnvMode,
        });

      // A PR / issue / work item source is only *recorded* when picked — creating
      // a git worktree is a side effect on disk, and picking a source is not a
      // decision to perform one. This is where the two join: the intent goes
      // through the same `createWorktreeForProject` call the New worktree dialog
      // makes, so the derived branch name, origin linkage, and sidebar badges all
      // match. That call also creates the thread, so the composed message is sent
      // into it rather than promoting the draft.
      const pendingWorktreeSource =
        isFirstMessage && sendEnvMode === "worktree" ? (draftThread?.worktreeSource ?? null) : null;
      if (pendingWorktreeSource && !api.git.createWorktreeForProject) {
        setThreadError(threadIdForSend, "Worktree creation is unavailable in this environment.");
        return false;
      }
      // A task draft's first message starts the chat as the task's.
      const localTask =
        isFirstMessage && draftThread?.localTaskId
          ? taskDraftSend(environmentId, draftThread.localTaskId)
          : null;
      // Filled by `prepareForDispatch` below when a source-backed worktree is created,
      // so the navigation at the end of this function targets the resulting thread.
      let sourceThreadRef: ScopedThreadRef | null = null;
      const prepareWorktreeSourceForDispatch = async () => {
        const createWorktree = api.git.createWorktreeForProject;
        if (!pendingWorktreeSource || !createWorktree || !activeProject) return null;
        // The task is checked before its worktree and thread are made for it.
        await localTask?.preflight();
        const created = await createWorktree({
          fetchOrigin: draftThread?.fetchOrigin ?? true,
          projectId: activeProject.id,
          intent:
            pendingWorktreeSource.kind === "pr"
              ? { kind: "pr", number: pendingWorktreeSource.number }
              : pendingWorktreeSource.kind === "issue"
                ? {
                    kind: "issue",
                    number: pendingWorktreeSource.number,
                    title: pendingWorktreeSource.title,
                  }
                : {
                    kind: "workItem",
                    provider: pendingWorktreeSource.provider,
                    key: pendingWorktreeSource.key,
                    title: pendingWorktreeSource.title,
                    ...(pendingWorktreeSource.state ? { state: pendingWorktreeSource.state } : {}),
                    ...(pendingWorktreeSource.stateName
                      ? { stateName: pendingWorktreeSource.stateName }
                      : {}),
                    ...(pendingWorktreeSource.url ? { url: pendingWorktreeSource.url } : {}),
                  },
        });
        notifyWorktreeSubmoduleSetup(created.submoduleInitialization);
        sourceThreadRef = scopeThreadRef(environmentId, created.sessionId);
        return {
          threadId: created.sessionId,
          isServerThread: true,
          isFirstMessage: true,
        };
      };

      const accepted = await executeChatSendTurn({
        ...(messageId !== undefined ? { messageId } : {}),
        readSubscribedClaudeReviewState: readSubscribedClaudeReviewState,
        ...(hooks?.onBeforeTurnStart ? { onBeforeTurnStart: hooks.onBeforeTurnStart } : {}),
        ...(hooks?.onSendError ? { onSendError: hooks.onSendError } : {}),
        resendFailedWorktreeLaunch: (failedMessageId) =>
          dispatchComposerSnapshotRef.current(snapshotForResend, settingsSnapshot, failedMessageId),
        preserveComposerDraft: messageId !== undefined || composerChangedDuringPreparation(),
        composer: composerSnapshot,
        thread: {
          threadId: threadIdForSend,
          sourceProviderDriver: activeThread.session?.provider ?? null,
          isFirstMessage,
          isServerThread,
          // A pending source materializes its own thread at commit time, so this
          // draft must not also be promoted by the bootstrap.
          isLocalDraftThread: isLocalDraftThread && !pendingWorktreeSource,
          activeThreadBranch,
          worktreePath: activeThread.worktreePath,
          createdAt: activeThread.createdAt,
          projectId: activeThread.projectId,
          // Every send of an unsent chat draft: the server allocates its folder
          // and creates the chat project with this id. The project can already
          // be here when an earlier first send failed after creating it; only
          // this bootstrap makes the server reuse it and recreate its (removed)
          // folder. Once the node has retired that id (an unused chat cleaned up
          // meanwhile), the draft moves to a fresh one and the message goes out
          // again.
          ...(isPendingChat && isLocalDraftThread
            ? {
                createChatProjectId: activeThread.projectId,
                ...(draftId
                  ? {
                      renewChatProjectId: () =>
                        moveDraftToNewChat(draftId, activeThread.environmentId),
                    }
                  : {}),
              }
            : {}),
        },
        worktree: pendingWorktreeSource
          ? {
              // The source's own worktree is created in `prepareForDispatch`; the
              // bootstrap must not prepare a second one.
              shouldMaterializeLegacyBranchWorktree: false,
              baseBranchForWorktree: null,
              shouldCreateWorktree: false,
            }
          : {
              shouldMaterializeLegacyBranchWorktree,
              baseBranchForWorktree:
                shouldCreateWorktree && !shouldMaterializeLegacyBranchWorktree
                  ? newWorktreeBaseBranch(activeThreadBranch, draftThread?.fetchOrigin ?? true)
                  : baseBranchForWorktree,
              ...(shouldCreateWorktree && !shouldMaterializeLegacyBranchWorktree
                ? {
                    fetchOrigin: draftThread?.fetchOrigin ?? true,
                    worktreeBranchName: draftThread?.worktreeBranchName ?? null,
                  }
                : {}),
              shouldCreateWorktree,
            },
        settings: effectiveSettingsSnapshot,
        project: {
          projectId: activeThread.projectId,
          // Only worktree preparation reads it, and a chat never prepares one.
          projectCwd: activeProject?.cwd ?? "",
        },
        ...(pendingWorktreeSource ? { prepareForDispatch: prepareWorktreeSourceForDispatch } : {}),
        ...(localTask ? { localTask } : {}),
        scroll: {
          armEndFollowBeforeOptimistic: () => {
            captureFirstSendLayout();
            armTimelineEndFollow();
          },
          scrollToEndAfterOptimistic,
        },
        draft: {
          // Clearing has to target the thread the turn actually went to, or the
          // composed prompt would linger on the abandoned draft.
          composerDraftTarget,
          environmentId,
          clearComposerDraftContent,
          setComposerDraftTokenMode,
          setComposerDraftPrompt,
          addComposerDraftImages,
          removeComposerDraftImage,
          setComposerDraftTerminalContexts,
          setDraftThreadContext,
          readComposerDraftContent,
        },
        dispatch: {
          api,
          beginLocalDispatch: sendLocalDispatch.beginLocalDispatch,
          resetLocalDispatch: sendLocalDispatch.resetLocalDispatch,
          setOptimisticUserMessages,
          setThreadError,
        },
        refs: {
          promptRef,
          composerImagesRef,
          composerTerminalContextsRef,
          sendInFlightRef: threadSendsInFlight.ref(sendThreadKey),
        },
        sourceControl: {
          fetcher: createSourceControlContextFetcher({ environmentId, cwd: gitCwd, queryClient }),
        },
        persistSettings: { persistThreadSettingsForNextTurn },
        composerHandle: { readComposer, showsSendThread },
        formatOutgoingPrompt,
      });
      if (!accepted) return false;
      if (sourceThreadRef) {
        // The draft has served its purpose — retire it and follow the turn to
        // the thread the worktree call created.
        if (draftId) {
          clearDraftThread(draftId);
        }
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(sourceThreadRef),
          replace: true,
        });
      }
      return true;
    } catch (error) {
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Could not launch the prompt.",
      );
      return false;
    } finally {
      sendPreparing.current = false;
    }
  };
  const dispatchComposerSnapshotRef = useRef(dispatchComposerSnapshot);
  dispatchComposerSnapshotRef.current = dispatchComposerSnapshot;
  startGoalTurnRef.current = async (goal) => {
    const context = readComposer()?.getSendContext();
    if (
      !context ||
      threadSendsInFlight.has(routeThreadKey) ||
      isConnecting ||
      activeEnvironmentUnavailable
    )
      return false;
    const objective = goal.objective ?? serverThread?.goal?.objective;
    if (!objective) return false;
    const sendState = deriveComposerSendState({
      prompt: objective,
      imageCount: context.images.length,
      terminalContexts: context.terminalContexts,
    });
    return dispatchComposerSnapshotRef.current(
      {
        goal,
        prompt: `Continue pursuing this goal: ${objective}`,
        promptForRestore: promptRef.current,
        trimmedPrompt: `Continue pursuing this goal: ${objective}`,
        images: context.images,
        sendableTerminalContexts: sendState.sendableTerminalContexts,
        sourceControlContexts: context.sourceControlContexts,
        selectedProvider: context.selectedProvider,
        selectedModel: context.selectedModel,
        selectedProviderModels: context.selectedProviderModels,
        selectedPromptEffort: context.selectedPromptEffort,
        selectedModelSelection: context.selectedModelSelection,
        expiredTerminalContextCount: 0,
      },
      { runtimeMode, interactionMode, tokenMode },
    );
  };

  const runSend = async (
    e?: { preventDefault: () => void },
    options?: { readonly invertFollowUp?: boolean },
  ) => {
    e?.preventDefault();
    // The approvals on screen when the user sent: a redirecting send declines only those.
    const approvalsAtSend = pendingApprovals;
    if (
      (!dispatchCapability.allowed && !dispatchEstablishing) ||
      hostedDraftTarget.pending !== null
    )
      return;
    const api = readEnvironmentApi(environmentId);
    // A plain send waits in the queue, instead of going out now, while its
    // environment is not ready for it: the connection is being established,
    // the rows are last-known state, or the connection is not there yet. The
    // queue sends it once the environment is live and takes mutations.
    const sendWaitsForEnvironment =
      dispatchEstablishing || !activeEnvironmentShellLive || api === undefined;
    // Everything else a submit can do (answers, goals, plan follow-ups, side
    // questions) reaches the node now or not at all.
    const reachNodeUnavailableReason =
      mutationUnavailableReason ??
      (api === undefined ? "Available once this environment is connected." : null);
    // When a turn is already running the submit is queued, so don't let the
    // transient post-dispatch `isSendBusy` window swallow a mid-turn message.
    const sideQuestion = parseSideQuestionCommand(promptRef.current);
    if (sideQuestion !== null && presentationTier !== "phone" && activeThreadRef && activeThread) {
      if (mutationUnavailableReason !== null) {
        notifyMutationUnavailable(mutationUnavailableReason);
        return;
      }
      const sideContext = readComposer()?.getSendContext();
      if (
        sideContext &&
        (sideContext.images.length > 0 ||
          sideContext.terminalContexts.length > 0 ||
          sideContext.sourceControlContexts.length > 0)
      ) {
        toastManager.add({
          type: "info",
          title: "Side questions accept text only",
          description:
            "Remove attached images, terminal selections, and source-control references before using /btw.",
        });
        return;
      }
      const key = scopedThreadKey(activeThreadRef);
      const side = useSideChatStore.getState().chatsByThreadKey[key];
      if (sideQuestion && (side?.pending || side?.failedQuestion)) {
        useSideChatStore.getState().open(key, activeThread.modelSelection);
        toastManager.add({
          type: "info",
          title: side.pending
            ? "Wait for the side answer or stop it first"
            : "Restore or discard the unsent side question first",
          description: "Your composer draft is preserved.",
        });
        return;
      }
      useSideChatStore.getState().open(key, activeThread.modelSelection, sideQuestion || undefined);
      const sideApi = readEnvironmentConnection(activeThreadRef.environmentId)?.client
        .textGeneration;
      if (
        sideQuestion &&
        sideApi &&
        sideChatCapability.allowed &&
        sideChatConnection.phase === "connected" &&
        !isConnecting &&
        !activeEnvironmentUnavailable
      ) {
        void useSideChatStore
          .getState()
          .ask(key, { threadId: activeThreadRef.threadId, requestId: randomUUID(), api: sideApi });
      }
      promptRef.current = "";
      setComposerDraftPrompt(composerDraftTarget, "");
      readComposer()?.resetCursorState();
      return;
    }
    const turnActive = phase === "running";
    if (
      !activeThread ||
      (isSendBusy && !turnActive) ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      threadSendsInFlight.has(routeThreadKey)
    )
      return;
    if (activePendingProgress) {
      // Moving between questions stays local; only the last one's answer
      // reaches the node.
      if (activePendingProgress.isLastQuestion && reachNodeUnavailableReason !== null) {
        notifyMutationUnavailable(reachNodeUnavailableReason);
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = readComposer()?.getSendContext();
    if (!sendCtx) return;
    const {
      images: composerImages,
      terminalContexts: composerTerminalContexts,
      sourceControlContexts: composerSourceControlContexts,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    const goalCommand = parseThreadGoalSlashCommand(trimmed);
    if (
      goalCommand !== null &&
      goalCommand.action !== "show" &&
      reachNodeUnavailableReason !== null
    ) {
      notifyMutationUnavailable(reachNodeUnavailableReason);
      return;
    }
    if (goalCommand !== null) {
      const clearGoalDraft = () => {
        promptRef.current = "";
        setComposerDraftPrompt(composerDraftTarget, "");
        setComposerDraftTokenMode(composerDraftTarget, tokenMode);
        readComposer()?.resetCursorState();
      };
      if (goalCommand.action === "show") {
        const goal = serverThread?.goal;
        toastManager.add({
          type: "info",
          title: goal ? `Goal: ${goal.status}` : "No goal set",
          description: goal
            ? `${goal.objective} — ${goal.tokensUsed.toLocaleString()} tokens used${goal.tokenBudget === null ? "" : ` of ${goal.tokenBudget.toLocaleString()}`}.${goal.synchronization ? ` Goal synchronization: ${goal.synchronization.state}. ${goal.synchronization.error ?? ""}` : ""}`
            : "Use /goal followed by the outcome you want to achieve.",
        });
        clearGoalDraft();
        return;
      }
      if (goalCommand.action !== "set" && !serverThread?.goal) {
        toastManager.add({
          type: "info",
          title: "No goal set",
          description: "Use /goal followed by an objective first.",
        });
        return;
      }
      if (goalCommand.action === "clear") {
        if (await handleClearGoal()) clearGoalDraft();
        return;
      }
      if (goalCommand.action === "pause") {
        if (await dispatchThreadGoalUpdate({ status: "paused" })) clearGoalDraft();
        return;
      }
      if (
        goalCommand.action === "set" &&
        goalCommand.objective.length > THREAD_GOAL_OBJECTIVE_MAX_CHARS
      ) {
        toastManager.add({
          type: "warning",
          title: "Goal is too long",
          description: `Keep the objective under ${THREAD_GOAL_OBJECTIVE_MAX_CHARS.toLocaleString()} characters.`,
        });
        return;
      }
      const goal =
        goalCommand.action === "set"
          ? { objective: goalCommand.objective, status: "active" as const }
          : { status: "active" as const };
      if (phase === "running") {
        if (await dispatchThreadGoalUpdate(goal)) clearGoalDraft();
      } else {
        // Uses the same worktree/thread bootstrap as a normal first message.
        await startGoalTurnRef.current(goal);
      }
      return;
    }
    if (showPlanFollowUpPrompt && activeProposedPlan && !parseComputerInvocation(promptForSend)) {
      if (reachNodeUnavailableReason !== null) {
        notifyMutationUnavailable(reachNodeUnavailableReason);
        return;
      }
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      setComposerDraftTokenMode(composerDraftTarget, tokenMode);
      readComposer()?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      setComposerDraftTokenMode(composerDraftTarget, tokenMode);
      readComposer()?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    const fileUploadSendBlock = deriveComposerFileUploadSendBlock({
      attachments: composerImages,
      nowMs: Date.now(),
    });
    if (fileUploadSendBlock) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Attachments aren't ready",
          description: fileUploadSendBlock,
        }),
      );
      return;
    }
    const composerSnapshot: SendTurnComposerSnapshot = {
      prompt: promptForSend,
      trimmedPrompt: trimmed,
      images: composerImages,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      sourceControlContexts: composerSourceControlContexts,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      expiredTerminalContextCount,
    };
    const settingsSnapshot: SendTurnSettings = {
      runtimeMode,
      interactionMode,
      tokenMode,
    };
    const computerInvocation = parseComputerInvocation(promptForSend);
    if (computerInvocation && !computerInvocation.prompt) return;
    const computer = window.desktopBridge?.computerBeta;
    const localComputer = computer && activeThread.environmentId === localComputerEnvironmentId;
    if (computerInvocation && !localComputer) {
      toastManager.add({
        type: "warning",
        title: "Computer Use requires the local desktop environment",
      });
      return;
    }
    if (localComputer) {
      try {
        const computerState = await computer.getState();
        if (computerInvocation || computerState.preferences.defaultEnabled) {
          if (
            !["codex", "claudeAgent", "cursor", "copilot", "opencode"].includes(ctxSelectedProvider)
          )
            throw new Error(
              "This provider does not support Computer Use. Select Codex, Claude, Cursor, Copilot or managed OpenCode.",
            );
          if (!api?.server)
            throw new Error(
              "Local desktop settings are unavailable. Reconnect before sending this task.",
            );
          const settings = await api.server.getSettings();
          if (!settings.agentControl.enabled)
            throw new Error(
              "Enable Private Agent Control in Settings → Integrations before sending this task.",
            );
          const instance = settings.providerInstances[ctxSelectedModelSelection.instanceId];
          if (
            ctxSelectedProvider === "opencode" &&
            instance &&
            instance.config !== null &&
            typeof instance.config === "object" &&
            "serverUrl" in instance.config &&
            instance.config.serverUrl
          )
            throw new Error(
              "Computer Use requires managed OpenCode. An external OpenCode server cannot receive local desktop access.",
            );
        }
        const intent = await computer.prepare(activeThread.id, computerInvocation !== null);
        // A permission check may yield to an edited draft or changed selection.
        if (promptRef.current !== promptForSend) return;
        if (intent) settingsSnapshot.computerUse = intent;
      } catch (error) {
        toastManager.add({
          type: "warning",
          title: "Computer Use setup",
          description: error instanceof Error ? error.message : "Complete setup, then send again.",
        });
        return;
      }
    }
    if (!canSendModelSelection(composerSnapshot.selectedModelSelection)) {
      notifySelectionBecameIneligible();
      return;
    }

    // A turn is already running: queue this message instead of sending it. Queued
    // messages auto-dispatch, in order, once the thread reaches quiescence. A
    // queued send whose turn has not started yet (an off-screen background send
    // included) counts too: a direct send would race it into the bind window.
    // So does an environment that is not ready yet (a node switch, last-known
    // rows): the queue only drains once its shell is live and it takes
    // mutations. A draft's first send queues under the draft and goes out from
    // this view, the draft's own, which creates its thread; nothing is sent
    // for a draft that is not open.
    if (
      activeThreadKey &&
      (phase === "running" ||
        hasOutstandingQueuedDispatch(activeThreadKey) ||
        sendWaitsForEnvironment)
    ) {
      // Steer = enqueue, then start a steer attempt at once: every failure falls back to the
      // queue. The phone tier is frozen and always queues; slash input never steers.
      const invertFollowUp = options?.invertFollowUp === true;
      const approvalRedirect = activeThreadRef
        ? planApprovalRedirect({
            approvals: approvalsAtSend,
            runtimeSessionId: activeThread.session?.runtimeSessionId,
            respondingRequestIds,
          })
        : ({ kind: "none" } as const);
      const followUpAction = resolveComposerFollowUpAction({
        turnRunning: phase === "running",
        // While approvals wait, a send redirects the turn whatever the setting says; the
        // alternate shortcut still queues and leaves them to be answered.
        followUpBehavior: approvalRedirect.kind === "none" ? settings.followUpBehavior : "steer",
        invert: invertFollowUp,
        surfaceAllowsSteer: presentationTier !== "phone",
        isSlashCommand: trimmed.startsWith("/"),
      });
      // A redirect declines only when the message can then steer; otherwise it queues as before.
      const redirectsApprovals =
        followUpAction === "steer" &&
        approvalRedirect.kind !== "none" &&
        !hasRetiredProjectMemory(composerSnapshot) &&
        getSteerEligibility({
          modelSelection: composerSnapshot.selectedModelSelection,
          runtimeMode: settingsSnapshot.runtimeMode,
          interactionMode: settingsSnapshot.interactionMode,
          tokenMode: settingsSnapshot.tokenMode,
        }).allowed;
      const preparing = threadSendsPreparing.ref(routeThreadKey);
      if (preparing.current) return;
      if (redirectsApprovals && approvalRedirect.kind === "blocked") {
        notifyApprovalRedirectRefused("blocked");
        return;
      }
      preparing.current = true;
      const composerChangedDuringPreparation = captureComposerContentGuard();
      try {
        if (!(await drainEditorsBeforeSend())) return;
        if (redirectsApprovals && approvalRedirect.kind === "decline" && activeThreadRef) {
          const outcome = await declineApprovalsForRedirect({
            plan: approvalRedirect,
            decline: (approval) =>
              submitApprovalDecision(approval.requestId, "decline", approval.approvalIdentity),
            source: pendingApprovalSourceFromStore(
              useStore,
              (state) => createThreadSelectorByRef(activeThreadRef)(state)?.activities,
            ),
          });
          if (outcome.kind !== "declined") {
            notifyApprovalRedirectRefused(
              outcome.kind,
              outcome.kind === "refused" ? outcome.error : null,
            );
            return;
          }
          // What goes out must be what the user sent; an edit made meanwhile stays a draft.
          if (composerChangedDuringPreparation()) {
            notifyApprovalRedirectRefused("draft-changed");
            return;
          }
        }
      } finally {
        preparing.current = false;
      }
      const queuedMessageId = newMessageId();
      const queuedEntry: QueuedMessage = {
        id: queuedMessageId,
        createdAt: new Date().toISOString(),
        composer: {
          ...composerSnapshot,
          // Clearing the composer revokes the live blob preview URLs, so clone the
          // image previews to keep the queued copies independent.
          images: composerSnapshot.images.map(cloneComposerImageForRetry),
        },
        settings: settingsSnapshot,
      };
      enqueueMessage(activeThreadKey, queuedEntry);
      if (followUpAction === "steer") {
        const eligibility = getQueuedSteerEligibility(queuedEntry);
        if (eligibility.allowed) {
          void steerQueuedEntry(queuedEntry, {
            explicit: invertFollowUp || redirectsApprovals,
            prepareEditors: false,
          });
        } else if (invertFollowUp) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Queued instead",
              description: eligibility.reason,
            }),
          );
        }
      }
      if (!composerChangedDuringPreparation()) {
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        setComposerDraftTokenMode(composerDraftTarget, tokenMode);
        readComposer()?.resetCursorState();
      }
      return;
    }

    await dispatchComposerSnapshotRef.current(composerSnapshot, settingsSnapshot);
  };
  const [composerSubmitGuard] = useState(createThreadSubmitGuard);
  const runSendRef = useRef({ send: runSend, threadKey: routeThreadKey });
  runSendRef.current = { send: runSend, threadKey: routeThreadKey };
  const onSend = useCallback(
    (e?: { preventDefault: () => void }, options?: { readonly invertFollowUp?: boolean }) => {
      const { send, threadKey } = runSendRef.current;
      composerSubmitGuard.run(threadKey, () => send(e, options));
    },
    [composerSubmitGuard],
  );

  // Queued messages drain through the shared coordinator (`messageQueueDrain`),
  // for every thread with a queue. While this ChatView is mounted it is its
  // thread's foreground sender, with optimistic UI, the Claude review dialog,
  // worktree and draft promotion. Busy reads are live refs: a "not now" is
  // `deferred` (the claim is released and retried), never a failed head.
  // The sender is bound to its thread key and reads only what the last
  // committed render showed (written in a layout effect, never during render),
  // so a ChatView that moves to another thread defers the old key's entries
  // until its registration is swapped instead of dispatching them here.
  const queueRenderBusy =
    isSendBusy ||
    isConnecting ||
    isRevertingCheckpoint ||
    hostedDraftTarget.pending !== null ||
    !dispatchCapability.allowed ||
    activeEnvironmentUnavailable;
  const foregroundQueueTargetRef = useRef<ForegroundQueueTarget | null>(null);
  useLayoutEffect(() => {
    foregroundQueueTargetRef.current = {
      threadKey: activeThreadKey,
      isBusy: () =>
        queueRenderBusy ||
        threadSendsInFlight.has(routeThreadKey) ||
        threadSendsPreparing.has(routeThreadKey),
      dispatch: (entry, hooks) =>
        dispatchComposerSnapshot(entry.composer, entry.settings, MessageId.make(entry.id), {
          onBeforeTurnStart: hooks.onBeforeTurnStart,
        }),
    };
  });
  const foregroundQueueSender = useMemo(
    () =>
      activeThreadKey
        ? createForegroundQueueSender(activeThreadKey, () => foregroundQueueTargetRef.current)
        : null,
    [activeThreadKey],
  );
  useForegroundQueueSender(activeThreadKey, foregroundQueueSender);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: ProviderInteractionMode;
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        threadSendsInFlight.has(routeThreadKey)
      ) {
        return;
      }
      const sendInFlight = threadSendsInFlight.ref(routeThreadKey);
      const sendLocalDispatch = bindLocalDispatch();
      const showsSendThread = bindToShownThread();

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      if (!(await prepareEditorSend())) return;
      const sendCtx = readComposer()?.getSendContext();
      if (!sendCtx) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;
      if (!canSendModelSelection(ctxSelectedModelSelection)) {
        notifySelectionBecameIneligible();
        return;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      sendInFlight.current = true;
      sendLocalDispatch.beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Follow the transcript's end; the optimistic message does not wait for
      // the list to get there.
      armTimelineEndFollow();

      // The timeline is the view's: once it shows another thread, it is not this one's.
      if (showsSendThread()) {
        setOptimisticUserMessages((existing) => [
          ...existing,
          {
            id: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            createdAt: messageCreatedAt,
            streaming: false,
          },
        ]);
        scrollToEndAfterOptimistic();
      }

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          runtimeMode,
          interactionMode: nextInteractionMode,
          tokenMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );
        setComposerDraftTokenMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          tokenMode,
        );

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          tokenMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default" && showsSendThread()) {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        sendInFlight.current = false;
      } catch (err) {
        if (showsSendThread()) {
          setOptimisticUserMessages((existing) =>
            existing.filter((message) => message.id !== messageIdForSend),
          );
        }
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlight.current = false;
        sendLocalDispatch.resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      armTimelineEndFollow,
      bindLocalDispatch,
      bindToShownThread,
      canSendModelSelection,
      isConnecting,
      isSendBusy,
      isServerThread,
      notifySelectionBecameIneligible,
      persistThreadSettingsForNextTurn,
      readComposer,
      routeThreadKey,
      runtimeMode,
      scrollToEndAfterOptimistic,
      setComposerDraftInteractionMode,
      setComposerDraftTokenMode,
      setThreadError,
      prepareEditorSend,
      environmentId,
      threadSendsInFlight,
      tokenMode,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      threadSendsInFlight.has(routeThreadKey)
    ) {
      return;
    }
    const sendInFlight = threadSendsInFlight.ref(routeThreadKey);
    const sendLocalDispatch = bindLocalDispatch();

    if (!(await prepareEditorSend())) return;
    const sendCtx = readComposer()?.getSendContext();
    if (!sendCtx) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlight.current = true;
    sendLocalDispatch.beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlight.current = false;
      sendLocalDispatch.resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        tokenMode,
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          tokenMode,
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId));
      })
      .then(() => {
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        });
      })
      .catch(async (err: unknown) => {
        // Roll back a creation that never ran; one that already holds the request
        // is archived instead (recoverable), never deleted. Trash would purge it.
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() =>
            api.orchestration.dispatchCommand({
              type: "thread.archive",
              commandId: newCommandId(),
              threadId: nextThreadId,
            }),
          )
          .catch(() => undefined);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              err instanceof Error
                ? err.message
                : "An error occurred while creating the new thread.",
          }),
        );
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    bindLocalDispatch,
    activeEnvironmentUnavailable,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    readComposer,
    routeThreadKey,
    runtimeMode,
    threadSendsInFlight,
    tokenMode,
    prepareEditorSend,
    environmentId,
  ]);

  const onProviderModelSelect = useCallback(
    (
      instanceId: ProviderInstanceId,
      model: string,
      options?: ReadonlyArray<ProviderOptionSelection>,
      meta?: ModelPickMeta,
    ) => {
      if (!activeThread) return;
      // A pointer pick with the tuning dial docked keeps the picker open;
      // pulling focus back to the composer would dismiss it.
      const refocusComposer = () => {
        if (!meta?.keepOpen) scheduleComposerFocus();
      };
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      if (
        !entry ||
        !entry.enabled ||
        !entry.installed ||
        entry.status !== "ready" ||
        entry.availability === "unavailable"
      ) {
        refocusComposer();
        return;
      }
      const resolvedDriverKind = entry?.driver ?? null;
      if (providerSelectionPolicy.mode === "continuation-only" && lockedProvider === null) {
        refocusComposer();
        return;
      }
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        refocusComposer();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          refocusComposer();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        refocusComposer();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
        ...(options ? { options } : {}),
      };
      if (
        !selectionAllowedAtSendBoundary({
          threadStarted: activeThreadStarted,
          policy: providerSelectionPolicy,
          canonicalSelection: activeThread.modelSelection,
          targetSelection: nextModelSelection,
        })
      ) {
        refocusComposer();
        return;
      }
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      if (!threadHasStarted(activeThread)) {
        setStickyComposerModelSelection(nextModelSelection);
      }
      const normalizedInteractionMode = normalizeInteractionModeForProviderTarget(
        interactionMode,
        entry.supportsAskMode ?? false,
      );
      if (normalizedInteractionMode !== interactionMode) {
        handleInteractionModeChange(normalizedInteractionMode);
      }
      refocusComposer();
    },
    [
      activeThread,
      activeThreadStarted,
      handleInteractionModeChange,
      interactionMode,
      lockedProvider,
      providerSelectionPolicy,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);
  // The changed-files card already resolved its rollback target when the row
  // was derived, so this only has to dispatch. Same ref indirection as above so
  // the callback identity never busts the timeline's stable context.
  const onUndoTurn = useCallback((turnCount: number) => {
    void onRevertToTurnCountRef.current(turnCount);
  }, []);
  // Composer focus or the first keystroke starts the provider session the next send
  // would start (`provider.prewarmSession`), so the send does not wait for the provider
  // to boot. The gating is shared with the mobile composer
  // (`resolveProviderSessionPrewarmRequest`): among others, it skips sends that first
  // create a worktree or a chat folder, whose directory does not exist yet. Ref
  // indirection keeps the callback stable for the memoized composer.
  const providerSessionPrewarmSupported = useEnvironmentServerConfigSelector(
    environmentId,
    selectProviderSessionPrewarmSupported,
  );
  const prewarmProviderSessionRef = useRef<(threadId: ThreadId | null) => void>(() => undefined);
  // Refreshed after each commit, never during render.
  useLayoutEffect(() => {
    prewarmProviderSessionRef.current = (threadId) => {
      const thread = activeThread;
      // A dwell that outlived its thread (see onComposerIntent).
      if (!thread || (threadId !== null && thread.id !== threadId)) return;
      const request = resolveProviderSessionPrewarmRequest({
        thread,
        isServerThread,
        isPendingChat,
        dispatchAllowed: dispatchCapability.allowed,
        hostedTargetPending: hostedDraftTarget.pending !== null,
        worktreePlan: resolveChatSendWorktreePlan({
          isServerThread,
          isFirstMessage: !isServerThread || thread.messages.length === 0,
          threadWorktreePath: thread.worktreePath,
          activeThreadBranch,
          currentGitRefName: gitStatusQuery.data?.refName ?? null,
          sendEnvMode,
        }),
        modelSelection: readComposer()?.getSendContext().selectedModelSelection,
        runtimeMode,
        tokenMode,
      });
      if (request === null) return;
      requestProviderSessionPrewarm({
        api: readEnvironmentApi(environmentId),
        supported: providerSessionPrewarmSupported,
        request,
      });
    };
  });
  // Every thread switch focuses the composer, so focus alone is a weak signal: a
  // prewarm on focus waits until the composer has stayed on the thread for a
  // moment, and browsing threads never boots (or, past the node's pool limit,
  // retires) a provider process per thread passed through. Typing is intent
  // enough and asks at once.
  const focusPrewarmTimerRef = useRef<{
    readonly threadId: ThreadId | null;
    readonly timer: number;
  } | null>(null);
  const cancelFocusPrewarm = useCallback(() => {
    const pending = focusPrewarmTimerRef.current;
    if (pending === null) return;
    window.clearTimeout(pending.timer);
    focusPrewarmTimerRef.current = null;
  }, []);
  const prewarmThreadId = activeThread?.id ?? null;
  const prewarmThreadIdRef = useRef(prewarmThreadId);
  useLayoutEffect(() => {
    prewarmThreadIdRef.current = prewarmThreadId;
    return cancelFocusPrewarm;
  }, [cancelFocusPrewarm, prewarmThreadId]);
  const onComposerIntent = useCallback(
    (intent: ComposerIntent) => {
      if (intent === "type") {
        cancelFocusPrewarm();
        prewarmProviderSessionRef.current(null);
        return;
      }
      // Focus that left before the dwell ran out was no intent to write.
      if (intent === "blur") {
        cancelFocusPrewarm();
        return;
      }
      const threadId = prewarmThreadIdRef.current;
      if (focusPrewarmTimerRef.current?.threadId === threadId) return;
      cancelFocusPrewarm();
      focusPrewarmTimerRef.current = {
        threadId,
        timer: window.setTimeout(() => {
          focusPrewarmTimerRef.current = null;
          prewarmProviderSessionRef.current(threadId);
        }, PROVIDER_SESSION_PREWARM_FOCUS_DWELL_MS),
      };
    },
    [cancelFocusPrewarm],
  );
  // "Fork from here": desktop and tablet only (the frozen phone tier never
  // offers it), on server threads of machines that advertise `threadFork`.
  // Same ref indirection: the callback identity never changes.
  const threadForkSupported = useCanForkThread(environmentId);
  const offerThreadFork = threadForkSupported && isServerThread && presentationTier !== "phone";
  const forkSourceRef = useRef({ thread: activeThread, turnDiffSummaries });
  forkSourceRef.current = { thread: activeThread, turnDiffSummaries };
  const onForkFromMessage = useCallback(
    (request: TimelineForkRequest, trigger: HTMLButtonElement) => {
      const { thread, turnDiffSummaries: summaries } = forkSourceRef.current;
      if (!thread) return;
      openForkThreadDialog({
        sourceThreadRef: scopeThreadRef(thread.environmentId, thread.id),
        sourceMessageId: request.messageId,
        sourceTurnId: request.turnId,
        // A page-only turn, or a blank reply under a page, quotes what the turn published.
        boundaryText: threadForkBoundaryQuote(thread.messages, request.messageId),
        checkpointAvailable: isMaterializableCheckpointSummary(
          summaries.find((summary) => summary.turnId === request.turnId),
        ),
        origin: trigger,
      });
    },
    [],
  );

  useEffect(() => {
    setOverviewOpenedOnEmptyThread(false);
  }, [activeThread?.id]);

  // One open state for every presentation. Desktop docks the Crown rail beside
  // the chat column, also while the workspace panel is open, at every width;
  // the phone tier promotes the overview to a full-screen surface, which (as
  // before the rail, the web phone tier is frozen) waits for the full-screen
  // workspace sheet to close.
  const overviewVisible = planSidebarOpen && !overviewSuppressedForEmptyThread;
  const isPhoneTier = presentationTier === "phone";
  const showCrownRail = overviewVisible && !isPhoneTier;
  const showPhoneOverviewSheet = overviewVisible && !workspacePanelOpen && isPhoneTier;
  const overviewControlOpen = isPhoneTier ? showPhoneOverviewSheet : overviewVisible;
  // Keeps the rail mounted through its exit transition.
  const renderCrownRail = useDelayedUnmount(showCrownRail, reducedMotion ? 0 : CROWN_RAIL_EXIT_MS);
  // Conditional surfaces load the first time they are wanted (see
  // `chatViewLazySurfaces`) and mount only once loaded, so none commits a
  // Suspense fallback; an empty thread or a draft never loads the overview
  // stack. A failed chunk says so with a Retry: the rail and the side chat
  // stay wanted and retry in place, while dialogs and the handoff inspector
  // close (so nothing sits open and empty) and the Retry reopens them.
  const overviewPanelReady = useLazyComponentReady(
    LazyChatOverviewPanel,
    renderCrownRail || showPhoneOverviewSheet,
    {
      onLoadError: (error, retry) => notifySurfaceLoadFailure("overview panel", error, retry),
    },
  );
  const computerBetaPreviewReady = useLazyComponentReady(
    LazyComputerBetaPreview,
    renderCrownRail && activeThread?.environmentId === localComputerEnvironmentId,
    {
      onLoadError: (error, retry) => notifySurfaceLoadFailure("computer preview", error, retry),
    },
  );
  const contextHandoffPanelReady = useLazyComponentReady(
    LazyContextHandoffInspectionPanel,
    !isPhoneTier && inspectedContextHandoff !== null,
    {
      onLoadError: (error) => {
        const inspected = inspectedContextHandoff;
        closeContextHandoffInspection();
        notifySurfaceLoadFailure(
          "handoff details",
          error,
          () => {
            if (inspected) openContextHandoffInspection(inspected.marker, inspected.trigger);
          },
          activeThreadRef,
        );
      },
    },
  );
  const pullRequestDialogReady = useLazyComponentReady(
    LazyPullRequestThreadDialog,
    pullRequestDialogState !== null,
    {
      onLoadError: (error) => {
        const reference = pullRequestDialogState?.initialReference ?? undefined;
        closePullRequestDialog();
        notifySurfaceLoadFailure(
          "pull request dialog",
          error,
          () => openPullRequestDialog(reference),
          activeThreadRef,
        );
      },
    },
  );
  const newWorktreeDialogReady = useLazyComponentReady(
    LazyNewWorktreeDialog,
    paneFocused && projectExplorerOpen,
    {
      onLoadError: (error) => {
        setProjectExplorerOpen(false);
        notifySurfaceLoadFailure(
          "new worktree dialog",
          error,
          () => setProjectExplorerOpen(true),
          activeThreadRef,
        );
      },
    },
  );
  const linkedItemDialogReady = useLazyComponentReady(
    LazyLinkedWorktreeItemDialog,
    paneFocused && headerLinkedItem !== null,
    {
      onLoadError: (error) => {
        const item = headerLinkedItem;
        setHeaderLinkedItem(null);
        notifySurfaceLoadFailure(
          "linked item",
          error,
          () => {
            if (item) setHeaderLinkedItem(item);
          },
          activeThreadRef,
        );
      },
    },
  );
  const expandedImageDialogReady = useLazyComponentReady(
    LazyExpandedImageDialog,
    expandedImage !== null,
    {
      onLoadError: (error) => {
        const preview = expandedImage;
        closeExpandedImage();
        notifySurfaceLoadFailure(
          "image preview",
          error,
          () => {
            if (preview) setExpandedImage(preview);
          },
          activeThreadRef,
        );
      },
    },
  );
  // Agent Control approvals stay off the frozen phone tier (apps/mobile owns
  // the native surface).
  const agentControlApprovalsReady = useLazyComponentReady(
    LazyAgentControlApprovals,
    presentationTier !== "phone",
    {
      onLoadError: (error, retry) =>
        notifySurfaceLoadFailure("Agent Control approvals", error, retry),
    },
  );
  const phoneOverviewSheetReady = usePhoneThreadSurfaceReady(
    LazyPhoneOverviewSheet,
    isPhoneTier && showPhoneOverviewSheet,
  );
  const phoneThreadAppBarReady = usePhoneThreadSurfaceReady(LazyPhoneThreadAppBar, isPhoneTier);
  const sideChatThreadKey = !isPhoneTier ? activeThreadKey : null;
  const hasSideChat = useSideChatStore((state) =>
    sideChatThreadKey ? state.chatsByThreadKey[sideChatThreadKey] !== undefined : false,
  );
  const sideChatPanelReady = useLazyComponentReady(LazySideChatPanel, hasSideChat, {
    onLoadError: (error, retry) => notifySurfaceLoadFailure("side chat", error, retry),
  });
  // Opening a side chat focuses its field on the next frame, so the panel is
  // warmed in idle time wherever a side chat can be started.
  usePreloadWhenIdle(
    LazySideChatPanel,
    !isPhoneTier && isServerThread && sideChatCapability.allowed,
  );

  // Delegation and Agent Control dock on the composer; off the frozen phone
  // tier (apps/mobile owns the native surface). Memoised for the composer's `memo`.
  const delegationDock = useMemo(
    () =>
      isPhoneTier || activeThreadId === null ? null : { environmentId, threadId: activeThreadId },
    [activeThreadId, environmentId, isPhoneTier],
  );
  // The thread dock renders inside the composer, beneath the approval and
  // pending-input panels (see `ChatComposer`), so an open panel cannot carry it
  // out of the bottom third. The phone-tier gate stays here; the dock stays
  // props in / callbacks out. Memoised so the composer's `memo` still holds.
  const phoneThreadDock = useMemo<PhoneThreadDockProps | null>(() => {
    if (!isPhoneTier || !activeThread) return null;
    return {
      environmentId: activeThread.environmentId,
      threadId: activeThread.id,
      title: activeThread.title,
      projectCwd: gitCwd,
      branch: activeWorktreeSummary?.branch ?? activeThread.branch ?? null,
      draft:
        routeKind === "draft" && draftId
          ? {
              draftId,
              projectId: activeThread.projectId,
              createdAt: activeThread.createdAt,
            }
          : null,
      workspacePanelOpen,
      onToggleWorkspacePanel,
      onOpenFindInThread: openThreadMessageSearch,
      onOpenSourceControl: routeKind === "draft" ? null : () => toggleOverviewSidebar(true),
      sessionTabs: activeWorktreeSessionTabs,
      activeSessionTabKey,
      onSelectSessionTab: handleSelectSessionTab,
    };
  }, [
    activeSessionTabKey,
    activeThread,
    activeWorktreeSessionTabs,
    activeWorktreeSummary?.branch,
    draftId,
    gitCwd,
    handleSelectSessionTab,
    isPhoneTier,
    onToggleWorkspacePanel,
    openThreadMessageSearch,
    routeKind,
    toggleOverviewSidebar,
    workspacePanelOpen,
  ]);

  // Direction A chrome layering: on the desktop tier the input bar overlays
  // the transcript so messages scroll beneath the composer. The bar's
  // rendered height travels as a CSS variable on the chat column — consumed
  // by the timeline's list footer (internal scroll clearance) and the
  // scroll-to-bottom pill. The phone tier and the new-thread hero keep the
  // in-flow layout, where the variable stays unset and the old spacers apply.
  const composerOverlayActive = presentationTier !== "phone" && !showNewThreadSurface;
  const headerOverlayActive = presentationTier !== "phone";
  const chatShellRef = useRef<HTMLDivElement | null>(null);
  const headerOverlayRef = useRef<HTMLElement | null>(null);
  // The overlay elements exist while a thread is on screen and keep their
  // identity across thread switches, so one observer serves every switch.
  const chatSurfaceMounted = activeThreadId !== null;
  useEffect(() => {
    const column = chatColumnRef.current;
    if (!column) return;
    if (!composerOverlayActive) {
      column.style.removeProperty(COMPOSER_CLEARANCE_PROPERTY);
      return;
    }
    const bar = composerOverlayRef.current;
    if (!bar) return;
    return publishOverlayClearance(column, bar, COMPOSER_CLEARANCE_PROPERTY);
  }, [composerOverlayActive, chatSurfaceMounted]);
  // Same mechanism for the top bar: the header overlays the transcript and
  // publishes its height so the timeline's list header, the search bar, the
  // Crown rail, and the (rare) banner stack clear it.
  useEffect(() => {
    const shell = chatShellRef.current;
    if (!shell) return;
    if (!headerOverlayActive) {
      shell.style.removeProperty(HEADER_CLEARANCE_PROPERTY);
      return;
    }
    const header = headerOverlayRef.current;
    if (!header) return;
    return publishOverlayClearance(shell, header, HEADER_CLEARANCE_PROPERTY);
  }, [headerOverlayActive, chatSurfaceMounted]);

  // Empty state: no active thread. An archived thread listed as a stub exists:
  // its full shell and window are loading (this view retains them).
  if (!activeThread) {
    return <NoActiveThreadState loading={routeThreadIsArchivedStub} />;
  }

  const workspacePreview =
    !isPhoneTier && activeThread.environmentId === localComputerEnvironmentId ? (
      <>
        {computerBetaPreviewReady ? (
          <LazyComputerBetaPreview key={activeThread.id} threadId={activeThread.id} inline />
        ) : null}
        <BackgroundBrowserPreview
          environmentId={environmentId}
          cwd={activeWorkspaceRoot ?? null}
          onOpen={onOpenBrowserPanel}
        />
      </>
    ) : null;

  return (
    <div
      ref={chatShellRef}
      data-thread-detail-state={threadDetailState}
      data-mutation-ready={String(dispatchCapability.allowed)}
      className="app-content-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {!isPhoneTier && activeThreadRef ? (
        <TranscriptSelectionActions
          key={`selection-actions:${activeThreadKey}`}
          containerRef={chatShellRef}
          source={activeThreadRef}
          canUseSide={isServerThread && sideChatCapability.allowed}
          canCreate={
            dispatchCapability.allowed &&
            !isConnecting &&
            !activeEnvironmentUnavailable &&
            !!activeProject &&
            // A chat holds one thread: no second thread in the same chat folder.
            !isChatContext
          }
          canUseWorktree={isGitRepo && !!activeThreadBranch}
          onCurrent={(quote) => {
            const nextPrompt = appendSelectionQuote(
              readComposer()?.getSendContext().prompt ?? promptRef.current,
              quote,
            );
            promptRef.current = nextPrompt;
            setComposerDraftPrompt(composerDraftTarget, nextPrompt);
            readComposer()?.resetCursorState({
              prompt: nextPrompt,
              cursor: nextPrompt.length,
              detectTrigger: false,
            });
            scheduleComposerFocus();
          }}
          onSide={(quote) => {
            if (!isServerThread || !sideChatCapability.allowed) return;
            const key = scopedThreadKey(activeThreadRef);
            const side = useSideChatStore.getState();
            side.open(key, activeThread.modelSelection);
            side.setDraft(
              key,
              appendSelectionQuote(
                useSideChatStore.getState().chatsByThreadKey[key]?.draft ?? "",
                quote,
              ),
            );
            requestAnimationFrame(
              () =>
                paneFocusedRef.current &&
                chatShellRef.current
                  ?.querySelector<HTMLTextAreaElement>('[aria-label="Side question"]')
                  ?.focus(),
            );
          }}
          onNew={async ({ quote, prompt, envMode, intent, requestKey }) => {
            const context = readComposer()?.getSendContext();
            if (
              !context ||
              !activeProject ||
              !dispatchCapability.allowed ||
              isConnecting ||
              activeEnvironmentUnavailable
            ) {
              throw new Error("The workspace is unavailable. Your selection draft is preserved.");
            }
            await startSelectionChat({
              quote,
              prompt,
              envMode,
              intent,
              requestKey,
              projectRef: scopeProjectRef(environmentId, activeProject.id),
              branch: activeThreadBranch,
              canUseWorktree: isGitRepo,
              composer: context,
              settings: { runtimeMode, interactionMode: "default", tokenMode },
              prepare: prepareEditorSend,
              isCurrent: () =>
                paneFocusedRef.current &&
                editorSendTargetRef.current.allowed &&
                editorSendTargetRef.current.environmentId === environmentId &&
                editorSendTargetRef.current.threadId === activeThread.id,
              createThread: handleNewThread,
            });
          }}
        />
      ) : null}
      {!isPhoneTier && activeThreadRef && sideChatPanelReady ? (
        // One instance per thread: the panel reads which entries were already
        // there when it opened, and ChatView now follows thread navigation.
        // Keys of this list's per-thread children are prefixed: a key shared
        // by two siblings makes React drop one of them without unmounting it,
        // so its effects never clean up.
        <LazySideChatPanel
          key={`side-chat:${activeThreadKey}`}
          threadRef={activeThreadRef}
          providers={providerStatuses}
          connected={
            sideChatConnection.phase === "connected" &&
            !isConnecting &&
            !activeEnvironmentUnavailable
          }
        />
      ) : null}
      {/* Top bar */}
      <header
        ref={headerOverlayRef}
        className={cn(
          // The phone tier pads the top safe area itself (the root-level
          // inset is disabled for the phone tier in index.css).
          // Chrome-layer material: same plate/filter family as the sidebar,
          // so the bar and the sidebar read as one continuous chrome tier.
          // Desktop only — the web phone tier is frozen and keeps its
          // original header chrome (AGENTS.md).
          "border-b phone:pt-safe",
          headerOverlayActive
            ? "app-chrome-glass border-sidebar-border"
            : "border-border bg-muted/24",
          // Desktop: the bar floats over the transcript, which scrolls
          // beneath it (the timeline's list header provides the clearance).
          headerOverlayActive && "absolute inset-x-0 top-0 z-20",
          // Keeps the breadcrumb travelling with the sidebar instead of
          // snapping to its collapsed position a slide ahead of it. Inert on
          // the phone tier, which never takes the collapsed inset.
          APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
          isElectron
            ? cn(
                "drag-region flex min-h-[52px] items-stretch pr-3 sm:pr-5 wco:min-h-[env(titlebar-area-height)]",
                appSidebarCollapsed ? COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS : "pl-3 sm:pl-5",
                reserveTitleBarControlInset &&
                  "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              )
            : cn(
                "pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
                appSidebarCollapsed
                  ? COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS
                  : "pl-[calc(env(safe-area-inset-left)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)]",
              ),
        )}
      >
        {presentationTier === "phone" ? (
          phoneThreadAppBarReady ? (
            <LazyPhoneThreadAppBar
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              title={activeThread.title}
            />
          ) : null
        ) : (
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadTitle={activeThread.title}
            // An unsent chat draft has no project yet but is already a chat.
            activeProjectName={isChatContext ? CHAT_PROJECT_LABEL : activeProject?.name}
            activeProjectId={isChatContext ? null : (activeProject?.id ?? null)}
            activeProjectCwd={isChatContext ? null : (activeProject?.cwd ?? null)}
            activeProjectAvatarContentHash={activeProject?.customAvatarContentHash ?? null}
            // A chat has no Git to miss: no "No Git" badge (promotion offers Git instead).
            isGitRepo={isGitRepo || isChatContext}
            chatProject={chatProjectHeaderTarget}
            openInCwd={gitCwd}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            worktreeIssueNumber={activeWorktreeSummary?.issueNumber ?? null}
            worktreeIssueState={activeWorktreeSummary?.issueState ?? null}
            worktreePrNumber={headerPullRequest?.number ?? null}
            worktreePrState={headerPullRequest?.state ?? null}
            worktreePrIsDraft={headerPullRequest?.isDraft ?? null}
            worktreePrUrl={headerPullRequest?.url ?? null}
            worktreePullRequests={headerPullRequests}
            worktreePullRequestsToggle={headerPullRequestsToggle}
            worktreePullRequestBadgeRef={setHeaderPullRequestBadge}
            worktreeWorkItemProvider={activeWorktreeSummary?.workItemProvider ?? null}
            worktreeWorkItemKey={activeWorktreeSummary?.workItemKey ?? null}
            worktreeWorkItemState={activeWorktreeSummary?.workItemState ?? null}
            worktreeWorkItemStateName={activeWorktreeSummary?.workItemStateName ?? null}
            onOpenLinkedWorktreeItem={openHeaderLinkedItem}
            workspacePanelOpen={workspacePanelOpen}
            liveAgentCount={resolveHeaderLiveAgentCount({
              liveCount: agentPanelModel.liveCount,
              workspacePanelOpen,
              workspaceTab: rawSearch.workspaceTab,
            })}
            onToggleWorkspacePanel={onToggleWorkspacePanel}
            overviewSidebarOpen={overviewControlOpen}
            onToggleOverviewSidebar={toggleOverviewSidebar}
            onRunProjectScript={runProjectScript}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
          />
        )}
      </header>
      {headerPullRequestsPopover}
      {/* Mounted from the first open on, so later closes still animate. */}
      {linkedItemDialogReady ? (
        <LazyLinkedWorktreeItemDialog
          open={paneFocused && headerLinkedItem !== null}
          item={headerLinkedItem}
          environmentId={activeProject?.environmentId ?? activeThread.environmentId}
          projectId={activeProject?.id ?? activeThread.projectId}
          cwd={activeProject?.cwd ?? gitCwd}
          onOpenChange={handleHeaderLinkedItemDialogOpenChange}
        />
      ) : null}

      {/* Provider status lives in the composer banner stack. Thread errors use
          the global notification surface instead of obscuring the
          transcript with a full-width inline strip. */}
      <ThreadErrorBanner
        error={applicableUsageLimit(activeThread) ? null : activeThread.error}
        threadRef={activeThreadRef}
        onDismiss={() => setThreadError(activeThread.id, null)}
      />
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div ref={chatColumnRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper. Stays `flex-1` even while empty so the absolutely
              positioned children below (search bar, scroll pill) keep a
              full-height containing block. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Messages — LegendList handles virtualization and scrolling internally.
                Gated on useDeferredValue: the urgent render after a tab switch
                paints the placeholder, then React commits the heavy timeline in
                a low-priority transition. */}
            {showNewThreadSurface ? null : threadHistoryPending &&
              timelineEntries.length === 0 &&
              !isWorking ? (
              <ThreadHistorySkeleton />
            ) : isActiveThreadIdFresh ? (
              <MessagesTimeline
                key={activeThread.id}
                agentPanelModel={agentPanelModel}
                onOpenAgents={onOpenAgentsPanel}
                onOpenAgent={onOpenRuntimeAgentPanel}
                isWorking={isWorking}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnId={activeLatestTurn?.turnId ?? null}
                latestTurn={activeLatestTurn}
                activeTurnStartedAt={activeWorkStartedAt}
                worktreeSetup={worktreeSetupTimeline}
                launchTurnDurationStart={
                  worktreeLaunch?.phase === "handed-off" ? launchWorkStartedAt : null
                }
                enteringMessageId={enteringMessageId}
                listRef={legendListRef}
                targetMessageId={threadMessageSearchTarget?.messageId ?? linkedMessageId ?? null}
                targetMessageRequestId={
                  threadMessageSearchTarget?.requestId ?? timelineReveal?.requestId ?? 0
                }
                targetMessageRowHighlight={threadMessageSearchTarget === null}
                threadMessageSearchQuery={threadMessageSearchOpen ? threadMessageSearchQuery : ""}
                threadMessageSearchOccurrencesByMessageId={
                  threadMessageSearchOccurrencesByMessageId
                }
                activeThreadMessageSearchOccurrence={
                  threadMessageSearchOpen ? selectedThreadMessageSearchOccurrence : null
                }
                timelineEntries={timelineEntries}
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                openDiffTurnId={diffOpen ? (rawSearch.diffTurnId ?? null) : null}
                onOpenTurnDiff={onOpenTurnDiff}
                onCloseDiff={onCloseDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                undoTurnCountByTurnId={undoTurnCountByTurnId}
                onUndoTurn={onUndoTurn}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                // The frozen phone tier has no page tab; its renders open in a dialog.
                onOpenHtmlRender={
                  presentationTier !== "phone" && isServerThread ? onOpenHtmlRender : undefined
                }
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
                liveFollowEnabled={timelineLiveFollowEnabled}
                onIsAtEndChange={onIsAtEndChange}
                onManualNavigation={stopTimelineLiveFollow}
                onUserReachedEnd={resumeTimelineLiveFollow}
                canLoadOlder={activeThreadMessageHistory?.hasMoreBefore ?? false}
                isLoadingOlder={activeThreadMessageHistoryLoad?.status === "loading"}
                loadOlderError={activeThreadMessageHistoryLoad?.error ?? null}
                onLoadOlder={handleLoadOlderMessages}
                {...(presentationTier !== "phone"
                  ? { onInspectContextHandoff: openContextHandoffInspection }
                  : {})}
                {...(offerThreadFork ? { onForkFromMessage } : {})}
                providerDriverKind={selectedProvider}
              />
            ) : (
              <div aria-hidden className="flex min-h-0 flex-1" />
            )}

            {threadMessageSearchOpen ? (
              <ThreadMessageSearchBar
                query={threadMessageSearchQuery}
                focusRequestId={threadMessageSearchFocusRequestId}
                matchCount={threadMessageSearchMatchCount}
                selectedIndex={selectedThreadMessageSearchIndex}
                onQueryChange={setThreadMessageSearchQuery}
                onNext={() => navigateThreadMessageSearch("next")}
                onPrevious={() => navigateThreadMessageSearch("previous")}
                onClose={closeThreadMessageSearch}
              />
            ) : null}

            {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
            {showScrollToBottom && (
              <div className="pointer-events-none absolute bottom-[calc(var(--chat-composer-clearance,0px)+0.25rem)] left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                <button
                  type="button"
                  onClick={() => scrollToEnd(true)}
                  className="selection-glass-surface pointer-events-auto flex items-center gap-1.5 rounded-full border px-3 py-1 text-muted-foreground text-xs shadow-md/5 transition-[background-color,color,box-shadow] hover:bg-popover hover:text-foreground hover:shadow-lg/8 hover:cursor-pointer"
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to bottom
                </button>
              </div>
            )}
          </div>

          {/* Empty thread: the hero sits between the (now empty) messages
              region and the composer, sized to its own content so it can never
              be squeezed into the header. The messages region above and the
              spacer below the input bar are both `flex-1`, so the hero and
              composer read as one vertically centered block. */}
          {showNewThreadSurface ? (
            <div
              ref={newThreadHeroRef}
              className={cn(
                "shrink-0",
                !reducedMotion && "animate-in fade-in slide-in-from-bottom-1",
              )}
            >
              <NewThreadHero
                projectName={activeProject?.name ?? null}
                activeProjectId={
                  activeProject?.id ?? (isPendingChat ? activeThread.projectId : null)
                }
                activeProjectEnvironmentId={
                  activeProject?.environmentId ??
                  (isPendingChat ? activeThread.environmentId : null)
                }
                routeKind={routeKind}
                envLocked={envLocked}
                draftId={draftId ?? undefined}
                pendingChat={isPendingChat}
                chatsAvailable={chatsAvailability.available}
                onStartWithoutProject={startDraftWithoutProject}
                workLocation={
                  isGitRepo ? (
                    <NewThreadWorkLocation
                      draftId={draftId ?? undefined}
                      environmentId={activeThread.environmentId}
                      threadId={activeThread.id}
                      projectId={activeProject?.id ?? null}
                      projectEnvironmentId={activeProject?.environmentId ?? null}
                      projectName={activeProject?.name ?? null}
                      envLocked={envLocked}
                      onComposerFocusRequest={scheduleComposerFocus}
                      onCheckoutPullRequestRequest={
                        canCheckoutPullRequestIntoThread ? openPullRequestDialog : undefined
                      }
                      cwd={activeProject?.cwd ?? gitCwd}
                    />
                  ) : null
                }
              />
            </div>
          ) : null}

          {/* Input bar. Bottom padding composes the safe-area inset with the
              keyboard inset published by the visual-viewport adapter: with the
              software keyboard open the keyboard inset wins the max() and keeps
              the composer, send action, and pending-approval panel above the
              keyboard; with no keyboard the variable is unset and the padding
              resolves exactly to the safe-area value. min-h-0 plus bottom
              anchoring lets the bar shrink when the keyboard leaves less room
              than its content needs: banners then overlap the collapsed
              timeline upward (unclipped, so the stack hover reveal keeps
              working) instead of pushing the composer behind the keyboard. */}
          <div
            ref={composerOverlayRef}
            className={cn(
              "flex min-h-0 flex-col justify-end",
              // Overlay mode: the bar floats over the transcript. The wrapper
              // ignores pointer events so the transcript's side gutters stay
              // clickable; the composer stack re-enables them below.
              composerOverlayActive && "pointer-events-none absolute inset-x-0 bottom-0 z-20",
              "pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-1.5 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-2",
              isGitRepo
                ? "pb-[calc(max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px))+0.25rem)]"
                : "pb-[calc(max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px))+0.75rem)] sm:pb-[calc(max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px))+1rem)]",
            )}
          >
            {composerOverlayActive ? (
              // Soft scroll-edge scrim across the whole floating bar
              // (composer + branch toolbar): keeps transcript lines readable
              // as they travel beneath without reserving layout for it. It
              // thins with the Transparency setting so a frosted composer
              // shows the transcript beneath it (see `.app-composer-scrim`).
              // The strip covers the branch toolbar row (42px + the bar's
              // 0.25rem bottom padding) or, without it, the bottom padding.
              <div
                aria-hidden
                className={cn(
                  "app-composer-scrim -top-10 -z-10 pointer-events-none absolute inset-x-0 bottom-0",
                  isGitRepo
                    ? "[--app-composer-scrim-strip:calc(2.875rem+max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px)))]"
                    : "[--app-composer-scrim-strip:calc(1rem+max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px)))]",
                )}
              />
            ) : null}
            <div className={cn("relative isolate", composerOverlayActive && "pointer-events-auto")}>
              {/* Background-liveness stays off the frozen phone tier along
                  with the rest of the Agents surface (AGENTS.md). */}
              {(activeBackgroundLiveness !== null ||
                backgroundWork.tasks.length > 0 ||
                backgroundWork.detailsOmitted) &&
              presentationTier !== "phone" ? (
                <div className="mx-auto mb-2 flex w-full min-w-0 max-w-208 items-center px-4">
                  <BackgroundLivenessChip
                    key={activeThreadKey}
                    work={backgroundWork}
                    connected={
                      !activeEnvironmentUnavailable && sideChatConnection.phase === "connected"
                    }
                    mutationReady={
                      dispatchCapability.allowed &&
                      !activeEnvironmentUnavailable &&
                      sideChatConnection.phase === "connected"
                    }
                    onStopTask={handleStopBackgroundTask}
                    liveness={activeBackgroundLiveness ?? "monitoring"}
                    liveCount={agentPanelModel.liveCount}
                    waitingCount={agentPanelModel.waitingCount}
                    onOpenAgents={onOpenAgentsPanel}
                    stopping={isStoppingBackgroundWork}
                    onStop={handleStopBackgroundWork}
                  />
                </div>
              ) : null}
              {presentationTier !== "phone"
                ? optionalUserInputs.map((input) => (
                    <OptionalQuestionCard
                      key={input.userInputIdentity?.requestEventId ?? input.requestId}
                      input={input}
                      disabled={
                        !dispatchCapability.allowed ||
                        activeEnvironmentUnavailable ||
                        sideChatConnection.phase !== "connected"
                      }
                      disabledReason={mutationUnavailableReason}
                      onRespond={onRespondToUserInput}
                    />
                  ))
                : null}
              <ComposerBannerStack className="relative z-0" items={composerBannerStackItems} />
              {/* External integrations' Agent Control approvals: this thread's
                  own live in the composer's delegation dock. Both stay off the
                  frozen phone tier; apps/mobile owns the native surface. */}
              {presentationTier !== "phone" && agentControlApprovalsReady ? (
                <LazyAgentControlApprovals environmentId={environmentId} />
              ) : null}
              {showNewThreadComposerSpacer ? (
                showNewThreadContextBar ? (
                  <NewThreadContextBar
                    draftId={draftId ?? undefined}
                    worktreeAvailable={isGitRepo && !isPendingChat}
                    envLocked={envLocked}
                    executionTargets={executionTargets}
                    executionEnvironmentId={environmentId}
                    executionTargetLocked={executionTargetLocked}
                    onExecutionTargetChange={onExecutionTargetChange}
                    onComposerFocusRequest={scheduleComposerFocus}
                  />
                ) : (
                  <div aria-hidden className="mb-2 h-5" />
                )
              ) : null}
              <ComposerQueuedMessages
                // A thread's wait starts its own deadline.
                key={activeThreadKey ?? undefined}
                messages={queuedMessages}
                hold={queueHold}
                wait={queuedMessagesWait}
                onResume={() => {
                  if (activeThreadKey) resumeMessageQueue(activeThreadKey);
                }}
                onRemove={handleRemoveQueuedMessage}
                onEdit={handleEditQueuedMessage}
                getEditUnavailableReason={getQueuedEditUnavailableReason}
                onMove={handleMoveQueuedMessage}
                onRetry={
                  presentationTier !== "phone"
                    ? (id) => {
                        if (activeThreadKey) retryQueuedMessage(activeThreadKey, id);
                      }
                    : undefined
                }
                showSteerAction={presentationTier !== "phone"}
                steeringIds={steeringQueuedMessageIds}
                getSteerUnavailableReason={getQueuedSteerUnavailableReason}
                onSteer={(message) => void handleSteerQueuedMessage(message)}
              />
              <div ref={composerBoxRef} className="relative z-10">
                <ChatComposer
                  ref={composerRef}
                  onComposerIntent={onComposerIntent}
                  composerDraftTarget={composerDraftTarget}
                  environmentId={environmentId}
                  routeKind={routeKind}
                  routeThreadRef={routeThreadRef}
                  draftId={draftId}
                  activeThreadId={activeThreadId}
                  activeThreadEnvironmentId={activeThread?.environmentId}
                  activeThreadSessionProviderInstanceId={activeThreadSessionProviderInstanceId}
                  activeThreadStarted={activeThreadStarted}
                  isServerThread={isServerThread}
                  isLocalDraftThread={isLocalDraftThread}
                  activeThreadGoal={serverThread?.goal ?? null}
                  phase={phase}
                  isConnecting={isConnecting}
                  isSendBusy={
                    isSendBusy ||
                    // A connection being established takes sends into the queue;
                    // any other refusal keeps the send button busy.
                    (!dispatchCapability.allowed && !dispatchEstablishing) ||
                    workspaceExecutionTargetUnavailable ||
                    hostedDraftTarget.pending !== null
                  }
                  sendsQueueUntilReady={sendsQueueUntilReady}
                  mutationUnavailableReason={mutationUnavailableReason}
                  isPreparingWorktree={isPreparingWorktree}
                  isWorktreeSetupRunning={
                    // Until the thread's own view takes over after the hand-off,
                    // the draft's keeps offering Stop, not a busy send button.
                    worktreeSetupRunning ||
                    (worktreeLaunch?.phase === "handed-off" && isSendBusy && !isServerThread)
                  }
                  environmentUnavailable={activeEnvironmentUnavailableState}
                  activePendingApproval={activePendingApproval}
                  pendingApprovals={pendingApprovals}
                  pendingUserInputs={pendingUserInputs}
                  activePendingProgress={activePendingProgress}
                  activePendingResolvedAnswers={activePendingResolvedAnswers}
                  activePendingIsResponding={activePendingIsResponding}
                  activePendingDraftAnswers={activePendingDraftAnswers}
                  activePendingQuestionIndex={activePendingQuestionIndex}
                  respondingRequestIds={respondingRequestIds}
                  showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                  activeProposedPlan={activeProposedPlan}
                  activePlan={activePlan as { turnId?: TurnId } | null}
                  sidebarProposedPlan={sidebarProposedPlan as { turnId?: TurnId } | null}
                  planSidebarLabel={planSidebarLabel}
                  planSidebarOpen={overviewControlOpen}
                  runtimeMode={runtimeMode}
                  interactionMode={interactionMode}
                  tokenMode={tokenMode}
                  lockedProvider={lockedProvider}
                  providerStatuses={composerProviderStatuses}
                  activeThreadModelSelection={activeThread?.modelSelection}
                  cliProxyHubsEnabled={cliProxyHubsEnabled}
                  activeThreadActivities={threadActivities}
                  phoneThreadDock={phoneThreadDock}
                  delegationDock={delegationDock}
                  resolvedTheme={resolvedTheme}
                  settings={settings}
                  keybindings={keybindings}
                  terminalOpen={Boolean(terminalState.terminalOpen)}
                  gitCwd={gitCwd}
                  executionTargets={executionTargets}
                  executionTargetLocked={executionTargetLocked}
                  executionTargetHoisted={executionTargetHoisted}
                  onExecutionTargetChange={onExecutionTargetChange}
                  promptRef={promptRef}
                  composerImagesRef={composerImagesRef}
                  composerTerminalContextsRef={composerTerminalContextsRef}
                  shouldAutoScrollRef={isAtEndRef}
                  scheduleStickToBottom={scrollToEnd}
                  followUpSurfaceAllowsSteer={presentationTier !== "phone"}
                  getFollowUpSteerUnavailableReason={getFollowUpSteerUnavailableReason}
                  onSend={onSend}
                  onInterrupt={worktreeSetupRunning ? cancelWorktreeSetup : onInterrupt}
                  onImplementPlanInNewThread={onImplementPlanInNewThread}
                  onRespondToApproval={onRespondToApproval}
                  onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
                  onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                  onPreviousActivePendingUserInputQuestion={
                    onPreviousActivePendingUserInputQuestion
                  }
                  onChangeActivePendingUserInputCustomAnswer={
                    onChangeActivePendingUserInputCustomAnswer
                  }
                  onProviderModelSelect={onProviderModelSelect}
                  toggleInteractionMode={toggleInteractionMode}
                  handleRuntimeModeChange={handleRuntimeModeChange}
                  handleInteractionModeChange={handleInteractionModeChange}
                  handleTokenModeChange={handleTokenModeChange}
                  togglePlanSidebar={toggleOverviewSidebar}
                  focusComposer={focusComposer}
                  scheduleComposerFocus={scheduleComposerFocus}
                  setThreadError={setThreadError}
                  onExpandImage={onExpandTimelineImage}
                  onGoalBudgetChange={(tokenBudget) => dispatchThreadGoalUpdate({ tokenBudget })}
                  onRetryGoal={() => {
                    if (serverThread?.goal?.synchronization?.action === "clear")
                      void handleClearGoal();
                    else
                      void dispatchThreadGoalUpdate({
                        startTurn: serverThread?.goal?.status === "active" && phase !== "running",
                      });
                  }}
                  onEditGoal={handleEditGoal}
                  onGoalStatusChange={handleGoalStatusChange}
                  onClearGoal={handleClearGoal}
                />
              </div>
            </div>
            {isGitRepo && (
              <div className={cn(composerOverlayActive && "pointer-events-auto")}>
                <BranchToolbar
                  environmentId={activeThread.environmentId}
                  threadId={activeThread.id}
                  {...(routeKind === "draft" && draftId ? { draftId } : {})}
                  {...(canOverrideServerThreadBranch
                    ? {
                        activeThreadBranchOverride: activeThreadBranch,
                        onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
                      }
                    : {})}
                  envLocked={envLocked}
                  {...(worktreeLaunch && worktreeSetupOnScreen && presentationTier !== "phone"
                    ? {
                        worktreeLaunch: {
                          branch: worktreeLaunch.snapshot?.worktreePath
                            ? (worktreeLaunch.snapshot.branch ?? null)
                            : null,
                        },
                      }
                    : {})}
                  onComposerFocusRequest={scheduleComposerFocus}
                  onOpenWorktreeSources={openWorktreeSources}
                  contextControlsHoisted={showNewThreadSurface}
                  {...(canCheckoutPullRequestIntoThread
                    ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                    : {})}
                  {...(hostedWorkspace.status === "signed-out" && hasMultipleEnvironments
                    ? { onEnvironmentChange }
                    : {})}
                  availableEnvironments={logicalProjectEnvironments}
                  terminalAvailable={activeProject !== undefined && terminalCapability.allowed}
                  terminalOpen={terminalState.terminalOpen}
                  terminalToggleShortcutLabel={terminalToggleShortcutLabel}
                  onToggleTerminal={toggleTerminalVisibility}
                  terminalCount={terminalState.terminalIds.length}
                  runningTerminalCount={terminalState.runningTerminalIds.length}
                />
              </div>
            )}
          </div>

          {/* Balances the empty-thread messages region above so the hero and
              composer center together. `flex-1` with no basis means it yields
              first when the software keyboard leaves less room than the
              composer needs. */}
          {showNewThreadSurface ? <div aria-hidden className="min-h-0 flex-1" /> : null}

          {pullRequestDialogState && pullRequestDialogReady ? (
            <LazyPullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              environmentId={activeThread.environmentId}
              projectId={activeProject?.id ?? null}
              threadId={activeThread.id}
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
          {newWorktreeDialogReady ? (
            <LazyNewWorktreeDialog
              open={paneFocused && projectExplorerOpen}
              environmentId={activeThread.environmentId}
              projectId={activeProject?.id ?? null}
              cwd={activeProject?.cwd ?? null}
              initialTab={projectExplorerInitialTab}
              onCreated={(result) => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: {
                    environmentId: activeThread.environmentId,
                    threadId: result.sessionId,
                  },
                });
              }}
              onOpenChange={setProjectExplorerOpen}
            />
          ) : null}
          {!isPhoneTier && expandedImage && expandedImageDialogReady ? (
            <LazyExpandedImageDialog
              preview={expandedImage}
              onClose={closeExpandedImage}
              contained
            />
          ) : null}
        </div>
        {/* end chat column */}
        {isPhoneTier ? null : inspectedContextHandoff && !shouldUseRightPanelSheet ? (
          <aside className="flex min-h-0 w-[25rem] shrink-0 border-l border-border pt-[var(--chat-header-clearance,0px)]">
            {contextHandoffPanelReady ? (
              <LazyContextHandoffInspectionPanel
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                marker={inspectedContextHandoff.marker}
                onClose={closeContextHandoffInspection}
              />
            ) : null}
          </aside>
        ) : (
          // Reserves the docked rail's column; the Crown positions itself
          // inside. No z-index and no overflow clip: the header controls stay
          // clickable and the expanded card / flyouts extend over the transcript.
          <div
            data-slot="crown-rail-slot"
            className={cn(
              "pointer-events-none relative shrink-0 transition-[width] motion-reduce:transition-none",
              reducedMotion && "transition-none",
            )}
            style={{
              width: showCrownRail ? CROWN_RAIL_SLOT_WIDTH_PX : 0,
              transitionDuration: `${CROWN_RAIL_EXIT_MS}ms`,
              transitionTimingFunction: CROWN_EASE_OUT,
            }}
          >
            {renderCrownRail && overviewPanelReady ? (
              <LazyChatOverviewPanel
                environmentId={environmentId}
                gitCwd={sourceControlCwd}
                activeWorktreeBranch={activeWorktreeSummary?.branch ?? null}
                activeThreadBranch={activeThread?.branch ?? null}
                activeWorktreePullRequests={activeWorktreePullRequests}
                activeWorktreeDiscoversPullRequests={activeWorktreeDiscoversPullRequests}
                activeWorktreeTitle={activeWorktreeSummary?.title}
                postPushWorkflowWatch={postPushWorkflowWatch}
                activeThreadKey={activeThreadKey}
                activePlan={activePlan}
                sidebarProposedPlan={sidebarProposedPlan}
                threadSubagents={threadSubagents}
                changedFileSummaries={activeThread?.turnDiffSummaries}
                controls={overviewPanelControls}
                markdownCwd={gitCwd ?? undefined}
                workspaceRoot={activeWorkspaceRoot}
                presentation="crown"
                open={showCrownRail}
                notesTarget={worktreeNotesTarget}
                chatProject={chatProjectHeaderTarget}
                threadTitle={activeThread.title}
                project={activeProject ?? null}
                // A chat's face wears its "No project" glyph, also before its first send.
                isChat={isChatContext}
                isGitRepo={isGitRepo}
                latestTurn={activeLatestTurn}
                turnSettled={latestTurnSettled}
                agentRunning={phase === "running"}
                preview={workspacePreview}
                onOpenFiles={onOpenFilesPanel}
                onOpenReview={onOpenReviewPanel}
                onOpenSubagent={onOpenSubagentPanel}
                onOpenPullRequestInApp={openPullRequestInApp}
                pullRequestLinking={overviewPullRequestLinking}
                agentPanelModel={agentPanelModel}
                onOpenAgent={onOpenRuntimeAgentPanel}
                onOpenAgentsWorkflow={onOpenAgentsWorkflowPanel}
                onPostPushDiscoveryComplete={clearPostPushWatch}
              />
            ) : null}
          </div>
        )}
      </div>
      {/* end horizontal flex container */}

      {hostedDraftTarget.pending ? (
        <DraftDeviceProjectDialog
          key={hostedDraftTarget.pending.environmentId}
          {...hostedDraftTarget.pending}
          onCancel={hostedDraftTarget.cancel}
          onRetry={hostedDraftTarget.retry}
          onSelect={hostedDraftTarget.selectProject}
          onSelectNoProject={hostedDraftTarget.selectNoProject}
        />
      ) : null}

      {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadKey}
          threadRef={mountedThreadRef}
          threadId={mountedThreadRef.threadId}
          visible={
            paneFocused &&
            mountedThreadKey === activeThreadKey &&
            terminalState.terminalOpen &&
            terminalCapability.allowed
          }
          launchContext={
            mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
          }
          focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          keybindings={keybindings}
          onAddTerminalContext={addTerminalContextToDraft}
        />
      ))}
      {paneFocused && !isPhoneTier && shouldUseRightPanelSheet && inspectedContextHandoff ? (
        <RightPanelSheet open onClose={closeContextHandoffInspection}>
          {contextHandoffPanelReady ? (
            <LazyContextHandoffInspectionPanel
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              marker={inspectedContextHandoff.marker}
              onClose={closeContextHandoffInspection}
            />
          ) : null}
        </RightPanelSheet>
      ) : null}
      {isPhoneTier && phoneOverviewSheetReady ? (
        // Phone tier: the overview promotes to a full-screen surface with an
        // explicit back affordance, consistent with the other work surfaces
        // (the audited right overlay had no close affordance at all).
        // The sheet stays mounted once it first opened, like the other work
        // surfaces.
        <LazyPhoneOverviewSheet
          label={planSidebarLabel}
          open={paneFocused && showPhoneOverviewSheet}
          onClose={closePlanSidebar}
        >
          {overviewPanelReady ? (
            <LazyChatOverviewPanel
              environmentId={environmentId}
              gitCwd={sourceControlCwd}
              activeWorktreeBranch={activeWorktreeSummary?.branch ?? null}
              activeThreadBranch={activeThread?.branch ?? null}
              activeWorktreePullRequests={activeWorktreePullRequests}
              activeWorktreeDiscoversPullRequests={activeWorktreeDiscoversPullRequests}
              activeWorktreeTitle={activeWorktreeSummary?.title}
              postPushWorkflowWatch={postPushWorkflowWatch}
              activeThreadKey={activeThreadKey}
              activePlan={activePlan}
              sidebarProposedPlan={sidebarProposedPlan}
              threadSubagents={threadSubagents}
              changedFileSummaries={activeThread?.turnDiffSummaries}
              controls={overviewPanelControls}
              markdownCwd={gitCwd ?? undefined}
              workspaceRoot={activeWorkspaceRoot}
              presentation="sheet"
              onOpenFiles={onOpenFilesPanel}
              onOpenReview={onOpenReviewPanel}
              onOpenSubagent={onOpenSubagentPanel}
              onOpenPullRequestInApp={openPullRequestInApp}
              onPostPushDiscoveryComplete={clearPostPushWatch}
            />
          ) : null}
        </LazyPhoneOverviewSheet>
      ) : null}

      {isPhoneTier && expandedImage && expandedImageDialogReady ? (
        <LazyExpandedImageDialog preview={expandedImage} onClose={closeExpandedImage} />
      ) : null}
    </div>
  );
}
