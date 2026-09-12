import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { readEnvironmentConnection } from "../environments/runtime";
import { SideChatPanel } from "./SideChatPanel";
import { useSideChatStore } from "../sideChatStore";
import { parseSideQuestionCommand } from "@ryco/client-runtime/state/side-chat";
import { useDeviceName } from "../deviceName";
import { resolveBuildModeModelSelection } from "../buildMode";
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
  AgentTokenMode,
  type ThreadGoalStatus,
  type ThreadGoalUpdate,
  THREAD_GOAL_OBJECTIVE_MAX_CHARS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
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
  resolveQueuedMessageSteerEligibility,
} from "@ryco/client-runtime/state/message-queue";
import { applyClaudePromptEffortPrefix, resolvePromptInjectedEffort } from "@ryco/shared/model";
import { projectScriptCwd } from "@ryco/shared/projectScripts";
import { truncate } from "@ryco/shared/String";
import { Debouncer, useDebouncedValue } from "@tanstack/react-pacer";
import { useQueryClient } from "~/rpc/queryClient";
import { DateTime } from "effect";
import { formatSourceControlContextsForAgent } from "@ryco/shared/sourceControlContextFormatter";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGitStatus } from "~/lib/gitStatusState";
import {
  issueDetailQueryOptions,
  changeRequestDetailQueryOptions,
} from "~/lib/sourceControlContextRpc";
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
  selectSidebarThreadsForProjectRef,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
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
  isChatImageAttachment,
  type ChatMessage,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { PREFERS_REDUCED_MOTION_QUERY } from "../lib/perf/motion";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useAppSidebarCollapsed } from "../hooks/useAppSidebarCollapsed";
import { usePresentationTier } from "../hooks/usePresentationTier";
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
import { ChevronDownIcon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import { BackgroundLivenessChip } from "./chat/BackgroundLivenessChip";
import { cn, randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newCommandId, newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import {
  getProviderModelCapabilities,
  getProviderSupportsAskMode,
  resolveSelectableProvider,
} from "../providerModels";
import { useSettings } from "../hooks/useSettings";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import {
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { type TerminalContextDraft, type TerminalContextSelection } from "../lib/terminalContext";
import {
  maybeResolveDevicePromptAttachment,
  type DevicePromptAttachmentResolution,
} from "../lib/devicePromptContext";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { PersistentThreadTerminalDrawer } from "./chat/ChatTerminalShell";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { ContextHandoffInspectionPanel } from "./chat/ContextHandoffInspectionPanel";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { NewWorktreeDialog, type NewWorktreeDialogTab } from "./worktrees/NewWorktreeDialog";
import {
  LinkedWorktreeItemDialog,
  type LinkedWorktreeItem,
} from "./worktrees/LinkedWorktreeItemDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import {
  deriveRevertTurnCountByUserMessageId,
  deriveUndoTurnCountByTurnId,
} from "./chat/MessagesTimeline.logic";
import { NewThreadHero } from "./chat/NewThreadHero";
import { NewThreadWorkLocation } from "./chat/NewThreadWorkLocation";
import { ThreadMessageSearchBar } from "./chat/ThreadMessageSearchBar";
import {
  buildThreadMessageSearchOccurrences,
  clampThreadMessageSearchIndex,
  moveThreadMessageSearchIndex,
} from "./chat/ThreadMessageSearch.logic";
import type { ThreadMessageSearchOccurrence } from "./chat/ThreadMessageSearch.logic";
import { ChatHeader } from "./chat/ChatHeader";
import { PhoneThreadAppBar } from "./shell/phone/PhoneThreadAppBar";
import type { PhoneThreadDockProps } from "./shell/phone/PhoneThreadDock";
import { PhoneSurfaceScaffold, PhoneWorkSurfaceSheet } from "./shell/phone/PhoneWorkSurface";
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
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { AgentControlApprovals } from "./agent-control/AgentControlApprovals";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  ChatOverviewPanel,
  FloatingOverviewMotionFrame,
  OverviewSidebarMotionFrame,
  OVERVIEW_FLOATING_EXIT_DURATION_MS,
  OVERVIEW_SIDEBAR_EXIT_DURATION_MS,
  usePostPushWorkflowWatch,
  useOverviewPanelControls,
} from "./chat/ChatOverviewPanel";
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
  executeChatSendTurn,
  type SendTurnComposerSnapshot,
  type SendTurnSettings,
} from "../hooks/executeChatSendTurn";
import { useMessageQueueStore } from "../messageQueueStore";
import type { QueuedMessage } from "../messageQueue.logic";
import { deriveComposerFileUploadSendBlock } from "~/composerFileUpload";
import { ComposerQueuedMessages } from "./chat/ComposerQueuedMessages";
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
  selectionAllowedAtSendBoundary,
  threadHasStarted,
  revokeUserMessagePreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { sanitizeThreadErrorMessage } from "@ryco/client-runtime/errors";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
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
import { useHostedWorkspaceState } from "../hostedHub/hostedConnectionCoordinator";
import { RightPanelSheet } from "./RightPanelSheet";
import { Button } from "./ui/button";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "../versionSkew";

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_SESSION_TABS: ReadonlyArray<SessionTabItem> = Object.freeze([]);
const PROVIDER_STATUS_KEY_SEPARATOR = "\0";

// Stable identity so the message-queue selector doesn't churn on empty threads.
const EMPTY_QUEUED_MESSAGES: readonly QueuedMessage[] = Object.freeze([]);
const EMPTY_STEERING_MESSAGE_IDS: readonly string[] = Object.freeze([]);

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

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

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

export default function ChatView(props: ChatViewProps) {
  usePerfMark("ChatView");
  const dispatchCapability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand);
  const terminalCapability = useHostedRpcCapability(WS_METHODS.terminalOpen);
  const sideChatCapability = useHostedRpcCapability(WS_METHODS.textGenerationAskSideQuestion);
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
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
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
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar;
  const navigate = useNavigate();
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseRightPanelRouteSearch(params),
  });
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
  const [planSidebarOpen, setPlanSidebarOpen] = useState(true);
  // Set once the user opens the overview from the new-thread surface, so the
  // empty-thread suppression below yields to an explicit request.
  const [overviewOpenedOnEmptyThread, setOverviewOpenedOnEmptyThread] = useState(false);
  const [overviewFloatingOpen, setOverviewFloatingOpen] = useState(false);
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const prefersReducedMotion = useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);
  const presentationTier = usePresentationTier();
  // With the thread sidebar collapsed this header owns the workspace's
  // top-left corner, so it reserves the room the shell's floating
  // show-sidebar control (and the native window controls) need there.
  const appSidebarCollapsed = useAppSidebarCollapsed();
  // Ref mirror for effects that must observe the tier without re-running on
  // tier flips (rotation preserves route, draft, and panel state).
  const presentationTierRef = useRef(presentationTier);
  presentationTierRef.current = presentationTier;
  const shouldUsePlanSidebarSheetRef = useRef(shouldUsePlanSidebarSheet);
  shouldUsePlanSidebarSheetRef.current = shouldUsePlanSidebarSheet;
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
  const sendInFlightRef = useRef(false);
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
  const serverThreadKeys = useStore(
    useShallow((state) =>
      selectThreadsAcrossEnvironments(state).map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    ),
  );
  const storeServerTerminalLaunchContext = useTerminalStateStore(
    (s) => s.terminalLaunchContextByThreadKey[scopedThreadKey(routeThreadRef)] ?? null,
  );
  const storeClearTerminalLaunchContext = useTerminalStateStore(
    (s) => s.clearTerminalLaunchContext,
  );
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelectorByRef(fallbackDraftProjectRef), [fallbackDraftProjectRef]),
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
            fallbackDraftProject?.defaultModelSelection ?? {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const isServerThread = routeKind === "server" && serverThread !== undefined;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  useEffect(() => {
    setInspectedContextHandoff(null);
  }, [activeThread?.id]);
  // Defers heavy MessagesTimeline render to a transition. When threadId
  // changes, the urgent render paints with the placeholder branch (see
  // the JSX gate below); React then re-renders in a transition where
  // the deferred id catches up and the real timeline mounts.
  const activeThreadIdRaw = activeThread?.id ?? null;
  const deferredActiveThreadId = useDeferredValue(activeThreadIdRaw);
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
    interruptTurn: onInterrupt,
    respondToApproval: onRespondToApproval,
    respondToUserInput: onRespondToUserInput,
    revertToTurnCount,
    respondingRequestIds,
    respondingUserInputRequestIds,
    isRevertingCheckpoint,
  } = useChatSessionActions({
    environmentId,
    activeThreadId,
    setThreadError,
  });
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
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

  useEffect(() => {
    const targetMessageId = rawSearch.messageId;
    if (!activeThreadRef || !targetMessageId || !activeThreadMessageHistory) return;
    if (activeThread?.messages.some((message) => message.id === targetMessageId)) return;
    void loadThreadHistoryAroundMessage({
      environmentId: activeThreadRef.environmentId,
      threadId: activeThreadRef.threadId,
      messageId: targetMessageId,
      limit: 101,
    }).catch(() => undefined);
  }, [activeThread?.messages, activeThreadMessageHistory, activeThreadRef, rawSearch.messageId]);

  // Message queue: prompts composed while a turn runs are queued and auto-sent on
  // quiescence. Client-owned, keyed by the scoped thread key.
  const enqueueMessage = useMessageQueueStore((store) => store.enqueue);
  const removeMessageFromQueue = useMessageQueueStore((store) => store.remove);
  const moveMessageInQueue = useMessageQueueStore((store) => store.move);
  const beginQueuedSend = useMessageQueueStore((store) => store.beginSend);
  const finishQueuedSend = useMessageQueueStore((store) => store.finishSend);
  const retryQueuedSend = useMessageQueueStore((store) => store.retrySend);
  const beginQueuedMessageSteer = useMessageQueueStore((store) => store.beginSteer);
  const endQueuedMessageSteer = useMessageQueueStore((store) => store.endSteer);
  const queuedMessages = useMessageQueueStore((store) =>
    activeThreadKey
      ? (store.queuesByThreadKey[activeThreadKey] ?? EMPTY_QUEUED_MESSAGES)
      : EMPTY_QUEUED_MESSAGES,
  );
  const steeringQueuedMessageIds = useMessageQueueStore((store) =>
    activeThreadKey
      ? (store.steeringIdsByThreadKey[activeThreadKey] ?? EMPTY_STEERING_MESSAGE_IDS)
      : EMPTY_STEERING_MESSAGE_IDS,
  );
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
  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys]);
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

  const activeWorktreeSummary = useStore(
    useMemo(
      () => (state: Parameters<typeof selectSidebarThreadsForProjectRef>[0]) => {
        if (!activeThread || !activeThread.environmentId) return null;
        const wid = activeThread.worktreeId;
        if (!wid) return null;
        const env = state.environmentStateById[activeThread.environmentId];
        if (!env?.worktreeById) return null;
        return (
          (
            env.worktreeById as Record<
              string,
              (typeof env.worktreeById)[keyof typeof env.worktreeById]
            >
          )[wid] ?? null
        );
      },
      // Re-create the selector only when the identity inputs change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [activeThread?.environmentId, activeThread?.worktreeId],
    ),
  );
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
  });

  useEffect(() => {
    const releaseHostedDemand = retainHostedWorkspaceThreadScope(environmentId, threadId);
    if (routeKind !== "server") {
      return releaseHostedDemand;
    }
    const releaseSubscription = retainThreadDetailSubscription(environmentId, threadId);
    return () => {
      releaseHostedDemand();
      releaseSubscription();
    };
  }, [environmentId, routeKind, threadId]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
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
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
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
    if (!serverThread?.id) return;
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
    latestTurnSettled,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
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
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    if (dispatchCapability.hosted && !dispatchCapability.allowed) {
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
    return items;
  }, [
    dispatchCapability.allowed,
    dispatchCapability.hosted,
    dispatchCapability.reason,
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    openSettings,
    reconnectingEnvironmentId,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    versionMismatchServerLabel,
  ]);
  const showNewThreadComposerSpacer =
    activeThread !== undefined &&
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
  const activeThreadSessionProviderInstanceId = activeThread?.session?.providerInstanceId ?? null;
  const phase = derivePhase(activeThread?.session ?? null);

  // Native desktop notification when a turn the user watched running completes
  // while the Ryco window is unfocused. Only fires for turns observed running in
  // this session (never for history loaded on mount), at most once per turn. The
  // main process authoritatively re-checks focus; the `document.hasFocus()`
  // pre-check just avoids a wasted IPC round-trip when we're clearly focused.
  const notifyOnTurnComplete = settings.notifyOnTurnCompleteWhenUnfocused;
  const seenRunningTurnIdsRef = useRef<Set<string>>(new Set());
  const notifiedTurnIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const turnId = activeLatestTurn?.turnId;
    if (!turnId) return;
    if (phase === "running") {
      seenRunningTurnIdsRef.current.add(turnId);
      return;
    }
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    if (!seenRunningTurnIdsRef.current.has(turnId)) return;
    if (notifiedTurnIdsRef.current.has(turnId)) return;
    notifiedTurnIdsRef.current.add(turnId);

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
    notifyOnTurnComplete,
    serverThread?.id,
    serverThread?.environmentId,
    activeThread?.title,
  ]);

  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const threadActivityViewModel = useMemo(
    () => deriveThreadActivityViewModel(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const {
    workLogEntries,
    contextCompactionEntries,
    contextHandoffEntries,
    pendingApprovals,
    pendingUserInputs,
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
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
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
  const activeThreadSummary = useStore((store) =>
    selectSidebarThreadSummaryByRef(store, activeThreadRef),
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
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
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
    });
  }, [
    activeThreadId,
    activeThread?.proposedPlans,
    contextCompactionEntries,
    contextHandoffEntries,
    timelineMessages,
    workLogEntries,
  ]);
  // "Empty" for the new-thread surface means nothing to show at all, not merely
  // no chat messages. A thread can already carry work-log rows, a proposed plan,
  // or setup-script activity from worktree creation while `messages` is still
  // empty; showing the hero then would hide real progress — and real failures.
  const showNewThreadSurface = shouldShowNewThreadSurface({
    hasThread: activeThread !== undefined,
    messageCount: activeThread?.messages.length ?? 0,
    optimisticMessageCount: optimisticUserMessages.length,
    timelineEntryCount: timelineEntries.length,
    presentationTier,
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
  const gitStatusQuery = useGitStatus({ environmentId, cwd: gitCwd });
  const queryClient = useQueryClient();
  const {
    postPushWorkflowWatch,
    handlePostPush: handlePostPushGitAction,
    clearWatch: clearPostPushWatch,
  } = usePostPushWorkflowWatch();
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const activeProviderInstanceId =
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);

  useEffect(() => {
    if (routeKind !== "server" || !gitCwd) return;
    const releaseDesktop = retainDesktopWorkspaceVcsScope(environmentId, gitCwd);
    const releaseHosted = retainHostedWorkspaceVcsScope(environmentId, gitCwd);
    return () => {
      releaseHosted();
      releaseDesktop();
    };
  }, [environmentId, gitCwd, routeKind]);

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
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
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
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    onToggleWorkspacePanel,
    onOpenTurnDiff,
    onCloseDiff,
    onOpenAgentsPanel,
    onOpenSubagentPanel,
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
  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target || target.disabled) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );
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
    if (presentationTierRef.current === "phone") return;
    readComposer()?.focusAtEnd();
  }, [readComposer]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
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
      const api = readEnvironmentApi(environmentId);
      if (!activeThreadId || !api || !terminalCapability.allowed) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      if (activeThreadRef) {
        storeCloseTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      environmentId,
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
    setOverviewFloatingOpen(false);
    setOverviewSidebarOpen(false);
  }, [setOverviewSidebarOpen]);
  const toggleOverviewSidebar = useCallback(
    (nextOpen?: boolean) => {
      if (workspacePanelOpen) {
        const wantsOpen = typeof nextOpen === "boolean" ? nextOpen : !overviewFloatingOpen;
        setOverviewFloatingOpen(wantsOpen);
        setOverviewSidebarOpen(wantsOpen);
        if (wantsOpen) setOverviewOpenedOnEmptyThread(true);
        return;
      }

      // While the thread is empty the panel reads as closed regardless of
      // `planSidebarOpen`, so the toggle has to invert the *visible* state or
      // the first click would be a no-op.
      const wantsOpen =
        typeof nextOpen === "boolean"
          ? nextOpen
          : showNewThreadSurface && !overviewOpenedOnEmptyThread
            ? true
            : !planSidebarOpen;
      setOverviewFloatingOpen(false);
      setOverviewSidebarOpen(wantsOpen);
      setOverviewOpenedOnEmptyThread(wantsOpen);
    },
    [
      showNewThreadSurface,
      overviewFloatingOpen,
      overviewOpenedOnEmptyThread,
      planSidebarOpen,
      setOverviewSidebarOpen,
      workspacePanelOpen,
    ],
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

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }

      if (input.tokenMode !== (serverThread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE)) {
        await api.orchestration.dispatchCommand({
          type: "thread.token-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          tokenMode: input.tokenMode,
          createdAt: input.createdAt,
        });
      }
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
  const scrollToEnd = useCallback((animated = false) => {
    setTimelineLiveFollowEnabled(true);
    legendListRef.current?.scrollToEnd?.({ animated });
  }, []);

  const scrollToEndAfterOptimistic = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void legendListRef.current?.scrollToEnd?.({ animated: false });
      });
    });
  }, []);

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

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    setTimelineLiveFollowEnabled(true);
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    // Honor an explicit "open the overview on the next thread" signal, set when
    // implementing a plan in a freshly created thread (`onImplementPlanInNewThread`).
    // In wide layouts the overview opens by default anyway, but in sheet/narrow
    // layouts it starts closed on every thread switch — without consuming this
    // signal the request to surface the new thread's plan would be silently lost.
    const openOverviewForNextThread = planSidebarOpenOnNextThreadRef.current;
    planSidebarOpenOnNextThreadRef.current = false;
    // The phone tier renders the overview as a full-screen surface, so it must
    // never open by default on a thread switch regardless of viewport width.
    // Read through the ref: a tier flip alone must not re-run this reset (it
    // would drop preserved panel state on rotation).
    setPlanSidebarOpen(
      openOverviewForNextThread ||
        (!shouldUsePlanSidebarSheetRef.current && presentationTierRef.current !== "phone"),
    );
    planSidebarDismissedForTurnRef.current = null;
  }, [activeThread?.id]);

  // Auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  useEffect(() => {
    if (!autoOpenPlanSidebar) return;
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
  }, [
    activePlan,
    activeLatestTurn?.turnId,
    autoOpenPlanSidebar,
    planSidebarOpen,
    sidebarProposedPlan?.turnId,
  ]);

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
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, threadId]);

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
  const {
    sourceControlActions: overviewSourceControlActions,
    branchControl: overviewBranchControl,
  } = useOverviewPanelControls({
    gitCwd,
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
  });
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });

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

  useEffect(() => {
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

  useEffect(() => {
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
    onToggleDiff,
    onOpenFilesPanel,
    onOpenReviewPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    runProjectScript,
  });

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      await revertToTurnCount({
        thread: activeThread ?? null,
        turnCount,
        environmentUnavailable: activeEnvironmentUnavailable,
        environmentUnavailableLabel: activeEnvironmentUnavailableLabel,
        turnInProgress: phase === "running" || isSendBusy || isConnecting,
      });
    },
    [
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      activeThread,
      isConnecting,
      isSendBusy,
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

  const getQueuedSteerEligibility = useCallback(
    (message: QueuedMessage) => {
      const providerInstanceId = activeThread?.session?.providerInstanceId;
      const provider = providerInstanceId
        ? composerProviderStatuses.find((entry) => entry.instanceId === providerInstanceId)
        : undefined;
      const activeTokenMode = activeThread?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
      const activeInteractionMode = activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
      return resolveQueuedMessageSteerEligibility({
        mutationReady: dispatchCapability.allowed && !activeEnvironmentUnavailable,
        turnRunning: phase === "running",
        activeTurnId: activeThread?.session?.activeTurnId,
        supportsTurnSteering: provider?.supportsTurnSteering === true,
        queuedModelSelection: message.composer.selectedModelSelection,
        activeModelSelection: activeThread?.modelSelection,
        queuedRuntimeMode: message.settings.runtimeMode,
        activeRuntimeMode: activeThread?.runtimeMode,
        queuedInteractionMode: message.settings.interactionMode,
        activeInteractionMode,
        queuedTokenMode: message.settings.tokenMode,
        activeTokenMode,
      });
    },
    [
      activeEnvironmentUnavailable,
      activeThread,
      composerProviderStatuses,
      dispatchCapability.allowed,
      phase,
    ],
  );

  const getQueuedSteerUnavailableReason = useCallback(
    (message: QueuedMessage): string | null => {
      const eligibility = getQueuedSteerEligibility(message);
      return eligibility.allowed ? null : eligibility.reason;
    },
    [getQueuedSteerEligibility],
  );

  const handleSteerQueuedMessage = useCallback(
    async (message: QueuedMessage) => {
      if (!activeThreadKey || !activeThread) return;
      const eligibility = getQueuedSteerEligibility(message);
      if (!eligibility.allowed) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Cannot steer this message",
            description: eligibility.reason,
          }),
        );
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) return;

      beginQueuedMessageSteer(activeThreadKey, message.id);
      try {
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
            commandId: newCommandId(),
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
        endQueuedMessageSteer(activeThreadKey, message.id);
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
      environmentId,
      getQueuedSteerEligibility,
    ],
  );

  useEffect(() => {
    if (!activeThreadKey || steeringQueuedMessageIds.length === 0) return;
    const projectedIds = new Set(activeThread?.messages.map((message) => String(message.id)) ?? []);
    for (const messageId of steeringQueuedMessageIds) {
      if (projectedIds.has(messageId)) {
        handleRemoveQueuedMessage(messageId);
      }
    }
  }, [
    activeThread?.messages,
    activeThreadKey,
    handleRemoveQueuedMessage,
    steeringQueuedMessageIds,
  ]);

  useEffect(() => {
    if (!activeThreadKey || steeringQueuedMessageIds.length === 0) return;
    const rejectedIds = new Set(
      threadActivities.flatMap((activity) => {
        if (activity.kind !== "provider.turn.steer.failed" || !activity.payload) return [];
        const messageId = (activity.payload as { messageId?: unknown }).messageId;
        return typeof messageId === "string" ? [messageId] : [];
      }),
    );
    for (const messageId of steeringQueuedMessageIds) {
      if (rejectedIds.has(messageId)) {
        endQueuedMessageSteer(activeThreadKey, messageId);
      }
    }
  }, [activeThreadKey, endQueuedMessageSteer, steeringQueuedMessageIds, threadActivities]);

  // Build the executeChatSendTurn input from a composer snapshot and dispatch it.
  // Shared by direct sends and queue flushes, so a queued message replays exactly
  // like a live send.
  // Returns true only after the turn command is accepted.
  const dispatchComposerSnapshot = async (
    composerSnapshot: SendTurnComposerSnapshot,
    settingsSnapshot: SendTurnSettings,
    messageId?: MessageId,
  ): Promise<boolean> => {
    if (!dispatchCapability.allowed) return false;
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread || !activeProject) return false;
    if (enforceBuildMode) {
      composerSnapshot = {
        ...composerSnapshot,
        selectedModelSelection: resolveBuildModeModelSelection(
          composerSnapshot.selectedProvider,
          composerSnapshot.selectedModelSelection,
        ),
      };
    }
    if (!canSendModelSelection(composerSnapshot.selectedModelSelection)) {
      notifySelectionBecameIneligible();
      return false;
    }
    const devicePromptAttachment: DevicePromptAttachmentResolution =
      await maybeResolveDevicePromptAttachment({
        api,
        threadId: activeThread.id,
        prompt: composerSnapshot.prompt,
      }).catch(() => ({ requested: false, image: null }));
    if (devicePromptAttachment.image) {
      if (composerSnapshot.images.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        composerSnapshot = {
          ...composerSnapshot,
          images: [...composerSnapshot.images, devicePromptAttachment.image],
        };
      } else {
        URL.revokeObjectURL(devicePromptAttachment.image.previewUrl);
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "The simulator screenshot was skipped",
            description: `This message already has ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
          }),
        );
      }
    } else if (devicePromptAttachment.requested) {
      const description =
        devicePromptAttachment.reason === "no-attached-device"
          ? "Open the Simulator workspace and choose a device first."
          : devicePromptAttachment.reason === "device-not-booted"
            ? "The selected simulator is still starting."
            : "The current simulator screen could not be attached.";
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Couldn’t attach the simulator screen",
          description,
        }),
      );
    }
    // Queued messages keep the settings snapshot from enqueue time; when the
    // Build-mode lock is on, every dispatched turn must still run in Build
    // mode even if it was queued as Plan/Ask before the setting flipped.
    const effectiveSettingsSnapshot: SendTurnSettings = enforceBuildMode
      ? { ...settingsSnapshot, interactionMode: DEFAULT_INTERACTION_MODE }
      : settingsSnapshot;
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
    // Filled by `prepareForDispatch` below when a source-backed worktree is created,
    // so the navigation at the end of this function targets the resulting thread.
    let sourceThreadRef: ScopedThreadRef | null = null;
    const prepareWorktreeSourceForDispatch = async () => {
      const createWorktree = api.git.createWorktreeForProject;
      if (!pendingWorktreeSource || !createWorktree || !activeProject) return null;
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
      sourceThreadRef = scopeThreadRef(environmentId, created.sessionId);
      return {
        threadId: created.sessionId,
        isServerThread: true,
        isFirstMessage: true,
      };
    };

    const accepted = await executeChatSendTurn({
      ...(messageId !== undefined ? { messageId, preserveComposerDraft: true } : {}),
      composer: composerSnapshot,
      thread: {
        threadId: threadIdForSend,
        isFirstMessage,
        isServerThread,
        // A pending source materializes its own thread at commit time, so this
        // draft must not also be promoted by the bootstrap.
        isLocalDraftThread: isLocalDraftThread && !pendingWorktreeSource,
        activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt: activeThread.createdAt,
        projectId: activeProject.id,
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
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        defaultModelSelection: activeProject.defaultModelSelection ?? null,
      },
      ...(pendingWorktreeSource ? { prepareForDispatch: prepareWorktreeSourceForDispatch } : {}),
      scroll: {
        scrollToEndBeforeOptimistic: async () => {
          isAtEndRef.current = true;
          setTimelineLiveFollowEnabled(true);
          showScrollDebouncer.current.cancel();
          setShowScrollToBottom(false);
          await legendListRef.current?.scrollToEnd?.({ animated: false });
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
      },
      dispatch: {
        api,
        beginLocalDispatch,
        resetLocalDispatch,
        setOptimisticUserMessages,
        setThreadError,
      },
      refs: {
        promptRef,
        composerImagesRef,
        composerTerminalContextsRef,
        sendInFlightRef,
      },
      sourceControl: {
        fetcher: async (ctx) => {
          const cwd = gitCwd;
          if (!cwd) return ctx;
          const now = DateTime.fromDateUnsafe(new Date());
          const staleAfterDate = DateTime.fromDateUnsafe(new Date(Date.now() + 5 * 60 * 1000));
          if (ctx.kind === "issue") {
            const detail = await queryClient.fetchQuery(
              issueDetailQueryOptions({
                environmentId,
                cwd,
                reference: String(ctx.detail.number),
              }),
            );
            return {
              ...ctx,
              detail,
              fetchedAt: now,
              staleAfter: staleAfterDate,
            };
          }
          const detail = await queryClient.fetchQuery(
            changeRequestDetailQueryOptions({
              environmentId,
              cwd,
              reference: String(ctx.detail.number),
            }),
          );
          return { ...ctx, detail, fetchedAt: now, staleAfter: staleAfterDate };
        },
      },
      persistSettings: { persistThreadSettingsForNextTurn },
      composerHandle: { readComposer },
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
  };
  const dispatchComposerSnapshotRef = useRef(dispatchComposerSnapshot);
  dispatchComposerSnapshotRef.current = dispatchComposerSnapshot;
  startGoalTurnRef.current = async (goal) => {
    const context = readComposer()?.getSendContext();
    if (!context || sendInFlightRef.current || isConnecting || activeEnvironmentUnavailable)
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

  const runSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    if (!dispatchCapability.allowed) return;
    const api = readEnvironmentApi(environmentId);
    // When a turn is already running the submit is queued, so don't let the
    // transient post-dispatch `isSendBusy` window swallow a mid-turn message.
    const sideQuestion = parseSideQuestionCommand(promptRef.current);
    if (sideQuestion !== null && presentationTier !== "phone" && activeThreadRef && activeThread) {
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
      !api ||
      !activeThread ||
      (isSendBusy && !turnActive) ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    )
      return;
    if (activePendingProgress) {
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
    if (showPlanFollowUpPrompt && activeProposedPlan) {
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
    if (!canSendModelSelection(composerSnapshot.selectedModelSelection)) {
      notifySelectionBecameIneligible();
      return;
    }

    // A turn is already running: queue this message instead of sending it. Queued
    // messages auto-dispatch, in order, once the thread reaches quiescence.
    if (phase === "running" && activeThreadKey) {
      const queuedMessageId = newMessageId();
      enqueueMessage(activeThreadKey, {
        id: queuedMessageId,
        createdAt: new Date().toISOString(),
        composer: {
          ...composerSnapshot,
          // Clearing the composer revokes the live blob preview URLs, so clone the
          // image previews to keep the queued copies independent.
          images: composerSnapshot.images.map(cloneComposerImageForRetry),
        },
        settings: settingsSnapshot,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      setComposerDraftTokenMode(composerDraftTarget, tokenMode);
      readComposer()?.resetCursorState();
      return;
    }

    await dispatchComposerSnapshotRef.current(composerSnapshot, settingsSnapshot);
  };
  const runSendRef = useRef(runSend);
  runSendRef.current = runSend;
  const onSend = useCallback((e?: { preventDefault: () => void }) => {
    void runSendRef.current(e);
  }, []);

  // Flush the message queue: when the thread is idle, dispatch the next queued
  // message. One at a time — the dispatched turn goes running, and the following
  // item flushes on the next quiescence. Guards prevent firing mid-turn, while an
  // interrupt or provider error leaves the remaining queue intact.
  useEffect(() => {
    if (!activeThreadKey) return;
    const threadKey = activeThreadKey;
    const next = queuedMessages[0];
    if (!next) return;
    if (!dispatchCapability.allowed) return;
    // A lost RPC reply is not evidence of a rejected send. Reconcile projected
    // messages before retrying, including failures retained across reconnects.
    if (activeThread?.messages.some((message) => message.id === next.id)) {
      handleRemoveQueuedMessage(next.id);
      return;
    }
    if (next.deliveryStatus) return;
    if (isWorking || activeEnvironmentUnavailable) return;
    if (activePendingProgress || activePendingApproval) return;
    if (sendInFlightRef.current) return;
    // Claim before asynchronous preparation so rerenders cannot dispatch twice.
    // A failed attempt waits for explicit retry instead of spinning on idle updates.
    if (steeringQueuedMessageIds.includes(next.id)) return;
    if (!beginQueuedSend(threadKey, next.id)) return;
    void dispatchComposerSnapshotRef
      .current(next.composer, next.settings, MessageId.make(next.id))
      .then(
        (accepted) => {
          finishQueuedSend(threadKey, next.id, accepted);
          if (accepted) {
            for (const image of next.composer.images) {
              if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
            }
          }
        },
        () => finishQueuedSend(threadKey, next.id, false),
      );
  }, [
    activeThreadKey,
    queuedMessages,
    isWorking,
    activeEnvironmentUnavailable,
    activePendingProgress,
    activePendingApproval,
    dispatchCapability.allowed,
    beginQueuedSend,
    finishQueuedSend,
    activeThread?.messages,
    handleRemoveQueuedMessage,
    steeringQueuedMessageIds,
  ]);

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
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

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

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Scroll to the current end *before* adding the optimistic message.
      isAtEndRef.current = true;
      setTimelineLiveFollowEnabled(true);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      await legendListRef.current?.scrollToEnd?.({ animated: false });

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
        if (nextInteractionMode === "default" && autoOpenPlanSidebar) {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      canSendModelSelection,
      isConnecting,
      isSendBusy,
      isServerThread,
      notifySelectionBecameIneligible,
      persistThreadSettingsForNextTurn,
      readComposer,
      resetLocalDispatch,
      runtimeMode,
      scrollToEndAfterOptimistic,
      setComposerDraftInteractionMode,
      setComposerDraftTokenMode,
      setThreadError,
      autoOpenPlanSidebar,
      environmentId,
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
      sendInFlightRef.current
    ) {
      return;
    }

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

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
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
        // Signal that the plan sidebar should open on the new thread when enabled.
        planSidebarOpenOnNextThreadRef.current = autoOpenPlanSidebar;
        return navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        });
      })
      .catch(async (err: unknown) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
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
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    readComposer,
    resetLocalDispatch,
    runtimeMode,
    tokenMode,
    autoOpenPlanSidebar,
    environmentId,
  ]);

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
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
        scheduleComposerFocus();
        return;
      }
      const resolvedDriverKind = entry?.driver ?? null;
      if (providerSelectionPolicy.mode === "continuation-only" && lockedProvider === null) {
        scheduleComposerFocus();
        return;
      }
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
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
          scheduleComposerFocus();
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
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      if (
        !selectionAllowedAtSendBoundary({
          threadStarted: activeThreadStarted,
          policy: providerSelectionPolicy,
          canonicalSelection: activeThread.modelSelection,
          targetSelection: nextModelSelection,
        })
      ) {
        scheduleComposerFocus();
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
      scheduleComposerFocus();
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

  useEffect(() => {
    if (!workspacePanelOpen) {
      setOverviewFloatingOpen(false);
    }
  }, [workspacePanelOpen]);

  useEffect(() => {
    setOverviewFloatingOpen(false);
    setOverviewOpenedOnEmptyThread(false);
  }, [activeThread?.id]);

  // The new-thread surface reads as its own page. The overview panel describes
  // a thread's history — checks, changes, plan — and an empty thread has none,
  // so suppress it until the user asks for it. This is a display-time override
  // rather than a `planSidebarOpen` reset so the panel reappears on its own the
  // moment the first turn lands, with no second state machine to keep in sync.
  const overviewSuppressedForEmptyThread = showNewThreadSurface && !overviewOpenedOnEmptyThread;
  const overviewSidebarVisible =
    planSidebarOpen && !workspacePanelOpen && !overviewSuppressedForEmptyThread;
  const showFloatingOverviewSidebar = overviewFloatingOpen && workspacePanelOpen;
  const overviewControlOpen = overviewSidebarVisible || showFloatingOverviewSidebar;
  // The phone tier always promotes the overview to a full-screen surface;
  // the width-based inline/sheet fork only applies to the desktop tier.
  const isPhoneTier = presentationTier === "phone";
  const showInlineOverviewSidebar =
    overviewSidebarVisible && !shouldUsePlanSidebarSheet && !isPhoneTier;
  const showOverviewSidebarSheet =
    overviewSidebarVisible && (shouldUsePlanSidebarSheet || isPhoneTier);
  const renderFloatingOverviewSidebar = useDelayedUnmount(
    showFloatingOverviewSidebar,
    prefersReducedMotion || !workspacePanelOpen ? 0 : OVERVIEW_FLOATING_EXIT_DURATION_MS,
  );
  const renderInlineOverviewSidebar = useDelayedUnmount(
    showInlineOverviewSidebar,
    prefersReducedMotion || shouldUsePlanSidebarSheet || workspacePanelOpen
      ? 0
      : OVERVIEW_SIDEBAR_EXIT_DURATION_MS,
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
  // the transcript so messages scroll beneath the glass composer. The bar's
  // rendered height travels as a CSS variable on the chat column — consumed
  // by the timeline's list footer (internal scroll clearance) and the
  // scroll-to-bottom pill. The phone tier and the new-thread hero keep the
  // in-flow layout, where the variable stays unset and the old spacers apply.
  const composerOverlayActive = presentationTier !== "phone" && !showNewThreadSurface;
  const headerOverlayActive = presentationTier !== "phone";
  const chatColumnRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const chatShellRef = useRef<HTMLDivElement | null>(null);
  const headerOverlayRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const column = chatColumnRef.current;
    if (!column) return;
    if (!composerOverlayActive) {
      column.style.removeProperty("--chat-composer-clearance");
      return;
    }
    const bar = composerOverlayRef.current;
    if (!bar) return;
    const apply = () =>
      column.style.setProperty("--chat-composer-clearance", `${bar.offsetHeight + 8}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--chat-composer-clearance");
    };
  }, [composerOverlayActive, activeThreadId]);
  // Same mechanism for the top bar: the header overlays the transcript and
  // publishes its height so the timeline's list header, the search bar, the
  // floating overview, and the (rare) banner stack clear it.
  useEffect(() => {
    const shell = chatShellRef.current;
    if (!shell) return;
    if (!headerOverlayActive) {
      shell.style.removeProperty("--chat-header-clearance");
      return;
    }
    const header = headerOverlayRef.current;
    if (!header) return;
    const apply = () =>
      shell.style.setProperty("--chat-header-clearance", `${header.offsetHeight + 8}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--chat-header-clearance");
    };
  }, [headerOverlayActive, activeThreadId]);

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  return (
    <div
      ref={chatShellRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {!isPhoneTier && activeThreadRef ? (
        <SideChatPanel
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
          <PhoneThreadAppBar
            environmentId={activeThread.environmentId}
            threadId={activeThread.id}
            title={activeThread.title}
          />
        ) : (
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadTitle={activeThread.title}
            activeProjectName={activeProject?.name}
            isGitRepo={isGitRepo}
            openInCwd={gitCwd}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            worktreeBranch={activeWorktreeSummary?.branch ?? activeThread.branch ?? null}
            worktreeTitle={activeWorktreeSummary?.title ?? null}
            worktreeOrigin={activeWorktreeSummary?.origin ?? null}
            worktreeIssueNumber={activeWorktreeSummary?.issueNumber ?? null}
            worktreeIssueState={activeWorktreeSummary?.issueState ?? null}
            worktreePrNumber={activeWorktreeSummary?.prNumber ?? null}
            worktreePrState={activeWorktreeSummary?.prState ?? null}
            worktreePrIsDraft={activeWorktreeSummary?.prIsDraft ?? null}
            worktreeWorkItemProvider={activeWorktreeSummary?.workItemProvider ?? null}
            worktreeWorkItemKey={activeWorktreeSummary?.workItemKey ?? null}
            worktreeWorkItemState={activeWorktreeSummary?.workItemState ?? null}
            worktreeWorkItemStateName={activeWorktreeSummary?.workItemStateName ?? null}
            onOpenLinkedWorktreeItem={handleOpenHeaderLinkedItem}
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
      <LinkedWorktreeItemDialog
        open={headerLinkedItem !== null}
        item={headerLinkedItem}
        environmentId={activeProject?.environmentId ?? activeThread.environmentId}
        projectId={activeProject?.id ?? activeThread.projectId}
        cwd={activeProject?.cwd ?? gitCwd}
        onOpenChange={handleHeaderLinkedItemDialogOpenChange}
      />

      {/* Provider status remains contextual to the composer. Thread errors use
          the global liquid-glass notification surface instead of obscuring the
          transcript with a full-width inline strip. */}
      <div
        className={cn(
          headerOverlayActive && "absolute inset-x-0 top-(--chat-header-clearance,0px) z-20",
        )}
      >
        <ProviderStatusBanner status={activeProviderStatus} />
      </div>
      <ThreadErrorBanner
        error={activeThread.error}
        threadRef={activeThreadRef}
        onDismiss={() => setThreadError(activeThread.id, null)}
      />
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div ref={chatColumnRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper. Stays `flex-1` even while empty so the absolutely
              positioned children below (search bar, floating overview, scroll
              pill) keep a full-height containing block. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Messages — LegendList handles virtualization and scrolling internally.
                Gated on useDeferredValue: the urgent render after a tab switch
                paints the placeholder, then React commits the heavy timeline in
                a low-priority transition. */}
            {showNewThreadSurface ? null : isActiveThreadIdFresh ? (
              <MessagesTimeline
                key={activeThread.id}
                agentPanelModel={agentPanelModel}
                onOpenAgents={onOpenAgentsPanel}
                isWorking={isWorking}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnId={activeLatestTurn?.turnId ?? null}
                latestTurn={activeLatestTurn}
                activeTurnStartedAt={activeWorkStartedAt}
                listRef={legendListRef}
                targetMessageId={
                  threadMessageSearchTarget?.messageId ?? rawSearch.messageId ?? null
                }
                targetMessageRequestId={threadMessageSearchTarget?.requestId ?? 0}
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

            {renderFloatingOverviewSidebar ? (
              <FloatingOverviewMotionFrame
                animate={!prefersReducedMotion}
                open={showFloatingOverviewSidebar}
              >
                <ChatOverviewPanel
                  environmentId={environmentId}
                  gitCwd={gitCwd}
                  activeWorktreeBranch={activeWorktreeSummary?.branch ?? null}
                  activeThreadBranch={activeThread?.branch ?? null}
                  activeWorktreePrNumber={activeWorktreeSummary?.prNumber ?? null}
                  activeWorktreePrState={activeWorktreeSummary?.prState}
                  activeWorktreePrIsDraft={activeWorktreeSummary?.prIsDraft}
                  activeWorktreeTitle={activeWorktreeSummary?.title}
                  postPushWorkflowWatch={postPushWorkflowWatch}
                  activeThreadKey={activeThreadKey}
                  activeEnvironmentUnavailableState={activeEnvironmentUnavailableState}
                  activePlan={activePlan}
                  sidebarProposedPlan={sidebarProposedPlan}
                  threadSubagents={threadSubagents}
                  changedFileSummaries={activeThread?.turnDiffSummaries}
                  sourceControlActions={overviewSourceControlActions}
                  branchControl={overviewBranchControl}
                  markdownCwd={gitCwd ?? undefined}
                  workspaceRoot={activeWorkspaceRoot}
                  mode="floating"
                  onClose={closePlanSidebar}
                  onOpenFiles={onOpenFilesPanel}
                  onOpenReview={onOpenReviewPanel}
                  onOpenSubagent={onOpenSubagentPanel}
                  onPostPushDiscoveryComplete={clearPostPushWatch}
                />
              </FloatingOverviewMotionFrame>
            ) : null}

            {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
            {showScrollToBottom && (
              <div className="pointer-events-none absolute bottom-[calc(var(--chat-composer-clearance,0px)+0.25rem)] left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                <button
                  type="button"
                  onClick={() => scrollToEnd(true)}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border-0 bg-card/80 px-3 py-1 text-muted-foreground text-xs shadow-md/5 ring-1 ring-inset ring-foreground/6 backdrop-blur transition-[background-color,color,box-shadow] hover:bg-card hover:text-foreground hover:shadow-lg/8 hover:cursor-pointer"
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
              className={cn(
                "shrink-0",
                !prefersReducedMotion && "animate-in fade-in slide-in-from-bottom-1",
              )}
            >
              <NewThreadHero
                projectName={activeProject?.name ?? null}
                activeProjectId={activeProject?.id ?? null}
                activeProjectEnvironmentId={activeProject?.environmentId ?? null}
                routeKind={routeKind}
                envLocked={envLocked}
                draftId={draftId ?? undefined}
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
                      availableEnvironments={logicalProjectEnvironments}
                      onEnvironmentChange={
                        hasMultipleEnvironments ? onEnvironmentChange : undefined
                      }
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
              // as they travel beneath without reserving layout for it.
              <div
                aria-hidden
                className="-top-10 -z-10 pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-background via-background/45 to-transparent"
              />
            ) : null}
            <div className={cn("relative isolate", composerOverlayActive && "pointer-events-auto")}>
              {/* Background-liveness stays off the frozen phone tier along
                  with the rest of the Agents surface (AGENTS.md). */}
              {activeBackgroundLiveness !== null && presentationTier !== "phone" ? (
                <div className="mx-auto mb-2 flex w-full min-w-0 max-w-208 items-center px-4">
                  <BackgroundLivenessChip
                    liveness={activeBackgroundLiveness}
                    liveCount={agentPanelModel.liveCount}
                    waitingCount={agentPanelModel.waitingCount}
                    onOpenAgents={onOpenAgentsPanel}
                    stopping={isStoppingBackgroundWork}
                    onStop={handleStopBackgroundWork}
                  />
                </div>
              ) : null}
              <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
              {/* Agent Control approvals stay off the frozen phone tier;
                  apps/mobile owns the native surface. */}
              {presentationTier !== "phone" ? (
                <AgentControlApprovals
                  environmentId={environmentId}
                  activeThreadId={activeThreadId}
                />
              ) : null}
              {showNewThreadComposerSpacer ? <div aria-hidden className="mb-2 h-5" /> : null}
              <ComposerQueuedMessages
                messages={queuedMessages}
                onRemove={handleRemoveQueuedMessage}
                onMove={handleMoveQueuedMessage}
                onRetry={
                  presentationTier !== "phone"
                    ? (id) => {
                        if (activeThreadKey) retryQueuedSend(activeThreadKey, id);
                      }
                    : undefined
                }
                showSteerAction={presentationTier !== "phone"}
                steeringIds={steeringQueuedMessageIds}
                getSteerUnavailableReason={getQueuedSteerUnavailableReason}
                onSteer={(message) => void handleSteerQueuedMessage(message)}
              />
              <div className="relative z-10">
                <ChatComposer
                  ref={composerRef}
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
                    isSendBusy || !dispatchCapability.allowed || workspaceExecutionTargetUnavailable
                  }
                  isPreparingWorktree={isPreparingWorktree}
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
                  activeProjectDefaultModelSelection={activeProject?.defaultModelSelection}
                  activeThreadModelSelection={activeThread?.modelSelection}
                  activeThreadActivities={threadActivities}
                  phoneThreadDock={phoneThreadDock}
                  resolvedTheme={resolvedTheme}
                  settings={settings}
                  keybindings={keybindings}
                  terminalOpen={Boolean(terminalState.terminalOpen)}
                  gitCwd={gitCwd}
                  executionTargets={logicalProjectEnvironments}
                  executionTargetLocked={envLocked || routeKind === "server"}
                  onExecutionTargetChange={onEnvironmentChange}
                  promptRef={promptRef}
                  composerImagesRef={composerImagesRef}
                  composerTerminalContextsRef={composerTerminalContextsRef}
                  shouldAutoScrollRef={isAtEndRef}
                  scheduleStickToBottom={scrollToEnd}
                  onSend={onSend}
                  onInterrupt={onInterrupt}
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
                  onComposerFocusRequest={scheduleComposerFocus}
                  onOpenWorktreeSources={openWorktreeSources}
                  contextControlsHoisted={showNewThreadSurface}
                  {...(canCheckoutPullRequestIntoThread
                    ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                    : {})}
                  {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                  availableEnvironments={logicalProjectEnvironments}
                  terminalAvailable={activeProject !== undefined && terminalCapability.allowed}
                  terminalOpen={terminalState.terminalOpen}
                  terminalToggleShortcutLabel={terminalToggleShortcutLabel}
                  onToggleTerminal={toggleTerminalVisibility}
                  terminalCount={terminalState.terminalIds.length}
                />
              </div>
            )}
          </div>

          {/* Balances the empty-thread messages region above so the hero and
              composer center together. `flex-1` with no basis means it yields
              first when the software keyboard leaves less room than the
              composer needs. */}
          {showNewThreadSurface ? <div aria-hidden className="min-h-0 flex-1" /> : null}

          {pullRequestDialogState ? (
            <PullRequestThreadDialog
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
          <NewWorktreeDialog
            open={projectExplorerOpen}
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
        </div>
        {/* end chat column */}
        {inspectedContextHandoff && !shouldUsePlanSidebarSheet && !isPhoneTier ? (
          <aside className="flex min-h-0 w-[25rem] shrink-0 border-l border-border pt-[var(--chat-header-clearance,0px)]">
            <ContextHandoffInspectionPanel
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              marker={inspectedContextHandoff.marker}
              onClose={closeContextHandoffInspection}
            />
          </aside>
        ) : renderInlineOverviewSidebar ? (
          <OverviewSidebarMotionFrame
            animate={!prefersReducedMotion}
            open={showInlineOverviewSidebar}
          >
            <ChatOverviewPanel
              environmentId={environmentId}
              gitCwd={gitCwd}
              activeWorktreeBranch={activeWorktreeSummary?.branch ?? null}
              activeThreadBranch={activeThread?.branch ?? null}
              activeWorktreePrNumber={activeWorktreeSummary?.prNumber ?? null}
              activeWorktreePrState={activeWorktreeSummary?.prState}
              activeWorktreePrIsDraft={activeWorktreeSummary?.prIsDraft}
              activeWorktreeTitle={activeWorktreeSummary?.title}
              postPushWorkflowWatch={postPushWorkflowWatch}
              activeThreadKey={activeThreadKey}
              activeEnvironmentUnavailableState={activeEnvironmentUnavailableState}
              activePlan={activePlan}
              sidebarProposedPlan={sidebarProposedPlan}
              threadSubagents={threadSubagents}
              changedFileSummaries={activeThread?.turnDiffSummaries}
              sourceControlActions={overviewSourceControlActions}
              branchControl={overviewBranchControl}
              markdownCwd={gitCwd ?? undefined}
              workspaceRoot={activeWorkspaceRoot}
              mode="sidebar"
              onOpenFiles={onOpenFilesPanel}
              onOpenReview={onOpenReviewPanel}
              onOpenSubagent={onOpenSubagentPanel}
              onPostPushDiscoveryComplete={clearPostPushWatch}
            />
          </OverviewSidebarMotionFrame>
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadKey}
          threadRef={mountedThreadRef}
          threadId={mountedThreadRef.threadId}
          visible={
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
      {!isPhoneTier && shouldUsePlanSidebarSheet && inspectedContextHandoff ? (
        <RightPanelSheet open onClose={closeContextHandoffInspection}>
          <ContextHandoffInspectionPanel
            environmentId={activeThread.environmentId}
            threadId={activeThread.id}
            marker={inspectedContextHandoff.marker}
            onClose={closeContextHandoffInspection}
          />
        </RightPanelSheet>
      ) : null}
      {isPhoneTier ? (
        // Phone tier: the overview promotes to a full-screen surface with an
        // explicit back affordance, consistent with the other work surfaces
        // (the audited right overlay had no close affordance at all).
        <PhoneWorkSurfaceSheet
          label={planSidebarLabel}
          open={showOverviewSidebarSheet}
          onClose={closePlanSidebar}
        >
          <PhoneSurfaceScaffold
            title={planSidebarLabel}
            backLabel="Back to thread"
            onBack={closePlanSidebar}
          >
            <ChatOverviewPanel
              environmentId={environmentId}
              gitCwd={gitCwd}
              activeWorktreeBranch={activeWorktreeSummary?.branch ?? null}
              activeThreadBranch={activeThread?.branch ?? null}
              activeWorktreePrNumber={activeWorktreeSummary?.prNumber ?? null}
              activeWorktreePrState={activeWorktreeSummary?.prState}
              activeWorktreePrIsDraft={activeWorktreeSummary?.prIsDraft}
              activeWorktreeTitle={activeWorktreeSummary?.title}
              postPushWorkflowWatch={postPushWorkflowWatch}
              activeThreadKey={activeThreadKey}
              activeEnvironmentUnavailableState={activeEnvironmentUnavailableState}
              activePlan={activePlan}
              sidebarProposedPlan={sidebarProposedPlan}
              threadSubagents={threadSubagents}
              changedFileSummaries={activeThread?.turnDiffSummaries}
              sourceControlActions={overviewSourceControlActions}
              branchControl={overviewBranchControl}
              markdownCwd={gitCwd ?? undefined}
              workspaceRoot={activeWorkspaceRoot}
              mode="sheet"
              onOpenFiles={onOpenFilesPanel}
              onOpenReview={onOpenReviewPanel}
              onOpenSubagent={onOpenSubagentPanel}
              onPostPushDiscoveryComplete={clearPostPushWatch}
            />
          </PhoneSurfaceScaffold>
        </PhoneWorkSurfaceSheet>
      ) : shouldUsePlanSidebarSheet ? (
        <RightPanelSheet open={showOverviewSidebarSheet} onClose={closePlanSidebar}>
          <ChatOverviewPanel
            environmentId={environmentId}
            gitCwd={gitCwd}
            activeWorktreeBranch={activeWorktreeSummary?.branch ?? null}
            activeThreadBranch={activeThread?.branch ?? null}
            activeWorktreePrNumber={activeWorktreeSummary?.prNumber ?? null}
            activeWorktreePrState={activeWorktreeSummary?.prState}
            activeWorktreePrIsDraft={activeWorktreeSummary?.prIsDraft}
            activeWorktreeTitle={activeWorktreeSummary?.title}
            postPushWorkflowWatch={postPushWorkflowWatch}
            activeThreadKey={activeThreadKey}
            activeEnvironmentUnavailableState={activeEnvironmentUnavailableState}
            activePlan={activePlan}
            sidebarProposedPlan={sidebarProposedPlan}
            threadSubagents={threadSubagents}
            changedFileSummaries={activeThread?.turnDiffSummaries}
            sourceControlActions={overviewSourceControlActions}
            branchControl={overviewBranchControl}
            markdownCwd={gitCwd ?? undefined}
            workspaceRoot={activeWorkspaceRoot}
            mode="sheet"
            onOpenFiles={onOpenFilesPanel}
            onOpenReview={onOpenReviewPanel}
            onOpenSubagent={onOpenSubagentPanel}
            onPostPushDiscoveryComplete={clearPostPushWatch}
          />
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog preview={expandedImage} onClose={closeExpandedImage} />
      )}
    </div>
  );
}
