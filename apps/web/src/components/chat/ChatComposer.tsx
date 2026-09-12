import type {
  ApprovalRequestId,
  ComposerSourceControlContext,
  EnvironmentId,
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  AgentTokenMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  TurnId,
  ThreadGoalStatus,
} from "@ryco/contracts";
import {
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import { createModelSelection, normalizeModelSlug } from "@ryco/shared/model";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../composer-logic";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { serializeComposerMentionPath } from "../../composerMentionSyntax";
import {
  composerDraftImageDedupKey,
  encodeComposerAttachmentDataUrl,
  PROMPT_STASH_MAX_ENTRIES,
  stripInlineTerminalContextPlaceholders,
  type PromptStashEntry,
} from "@ryco/client-runtime/state/composer";
import { webAttachmentCodec } from "../../platform/attachmentCodec";
import {
  deriveComposerFileUploadSendBlock,
  releaseUnusedComposerFileUploads,
  useComposerFileUploadRecords,
} from "../../composerFileUpload";
import {
  deriveComposerFooterActionLayoutKey,
  deriveComposerSendState,
  isComposerPrimaryActionDisabled,
  shouldBlurComposerOnSubmit,
} from "./ComposerSendPipeline";
import { ComposerFooter } from "./ComposerFooter";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftSelectors";
import {
  useComposerAttachmentMenus,
  useComposerSourceControlContextSelection,
} from "./ComposerAttachmentMenus";
import { useSourceControlDiscovery } from "~/lib/sourceControlDiscoveryState";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ApprovalCard } from "./ApprovalCard";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import {
  getComposerProviderState,
  renderProviderTraitsChips,
  renderProviderTraitsMenuContent,
} from "./composerProviderState";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ComposerPromptShell } from "./ComposerPromptShell";
import { PhoneThreadDock, type PhoneThreadDockProps } from "../shell/phone/PhoneThreadDock";
import { useComposerImageAttachments } from "./useComposerImageAttachments";
import { cn, randomUUID } from "~/lib/utils";
import { proposedPlanTitle } from "../../proposedPlan";
import { getProviderInteractionModeToggle, getProviderSupportsAskMode } from "../../providerModels";
import {
  deriveProviderInstanceEntries,
  resolveProviderDriverKindForInstanceSelection,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import { deriveContextWindowUsage } from "../../lib/contextWindow";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { hydrateImagesFromPersistedWithFailures } from "../../composerDraftPersistence";
import { usePromptStashStore } from "../../promptStashStore";
import { useUiStateStore } from "../../uiStateStore";
import { resolveShortcutCommand, shouldIgnoreGlobalNavigationShortcut } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ComposerLiquidGlass } from "./ComposerLiquidGlass";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashPicker } from "./ComposerStashPicker";
import { PendingContextHandoffChip } from "./PendingContextHandoffChip";
import { ComposerGoalHeader } from "./ComposerGoalHeader";
import { derivePendingContextHandoff } from "./pendingContextHandoff";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

function mergeStashedPrompt(currentPrompt: string, stashedPrompt: string): string {
  if (stashedPrompt.trim().length === 0) return currentPrompt;
  if (currentPrompt.length === 0) return stashedPrompt;
  return `${currentPrompt}\n\n${stashedPrompt}`;
}

function formatStashImageNames(names: ReadonlyArray<string>): string {
  const visible = names.slice(0, 3);
  const suffix = names.length > visible.length ? ` and ${names.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

function stashSnapshotKey(
  target: ScopedThreadRef | DraftId,
  prompt: string,
  images: ReadonlyArray<ComposerImageAttachment>,
): string {
  const targetKey =
    typeof target === "string" ? target : `${target.environmentId}:${target.threadId}`;
  return `${targetKey}\u0000${prompt}\u0000${images.map((image) => image.id).join("\u0001")}`;
}

function revokeUnreferencedStashPreviewUrls(images: ReadonlyArray<ComposerImageAttachment>): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  const referencedPreviewUrls = new Set(
    Object.values(useComposerDraftStore.getState().draftsByThreadKey).flatMap((draft) =>
      draft.images.map((image) => image.previewUrl),
    ),
  );
  for (const image of images) {
    if (image.previewUrl.startsWith("blob:") && !referencedPreviewUrls.has(image.previewUrl)) {
      URL.revokeObjectURL(image.previewUrl);
    }
  }
}

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  collapseForReading: () => void;
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /**
   * Inserts trigger text (e.g. "#i ", "#pr ", "#jira ", "/") at the current
   * cursor position, focuses the editor, and lets detectComposerTrigger pick
   * up the new trigger so the inline picker opens as if the user had typed
   * the same keys.
   */
  insertTriggerAtCursor: (text: string) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
    sourceControlContexts: ComposerSourceControlContext[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  };
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThreadSessionProviderInstanceId: ProviderInstanceId | null | undefined;
  activeThreadStarted: boolean;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  activeThreadGoal: Thread["goal"];

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  isPreparingWorktree: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connectionState: "connecting" | "disconnected" | "error";
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activePlan: { turnId?: TurnId } | null;
  sidebarProposedPlan: { turnId?: TurnId } | null;
  planSidebarLabel: string;
  planSidebarOpen: boolean;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  tokenMode: AgentTokenMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;

  /**
   * The phone thread dock, rendered inside the composer surface beneath the
   * approval and pending-input panels so an open panel cannot carry it out of
   * the bottom third. `null` on every other tier — the tier decision stays
   * with `ChatView`, and the dock itself remains props in / callbacks out.
   */
  phoneThreadDock: PhoneThreadDockProps | null;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;
  executionTargets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly disabled?: boolean;
  }>;
  executionTargetLocked: boolean;
  onExecutionTargetChange: (environmentId: EnvironmentId) => void;

  // Refs the parent needs kept in sync
  promptRef: React.MutableRefObject<string>;
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;

  // Scroll
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  scheduleStickToBottom: () => void;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  handleTokenModeChange: (mode: AgentTokenMode) => void;
  togglePlanSidebar: () => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onGoalBudgetChange: (tokenBudget: number | null) => Promise<boolean>;
  onRetryGoal: () => void;
  onEditGoal: () => void;
  onGoalStatusChange: (status: ThreadGoalStatus) => void;
  onClearGoal: () => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(
  forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(props, ref) {
    const {
      composerDraftTarget,
      environmentId,
      routeKind,
      routeThreadRef,
      draftId,
      activeThreadId,
      activeThreadEnvironmentId: _activeThreadEnvironmentId,
      activeThreadSessionProviderInstanceId,
      activeThreadStarted,
      isServerThread: _isServerThread,
      isLocalDraftThread: _isLocalDraftThread,
      activeThreadGoal,
      phase,
      isConnecting,
      isSendBusy,
      isPreparingWorktree,
      environmentUnavailable,
      activePendingApproval,
      pendingApprovals,
      pendingUserInputs,
      activePendingProgress,
      activePendingResolvedAnswers,
      activePendingIsResponding,
      activePendingDraftAnswers,
      activePendingQuestionIndex,
      respondingRequestIds,
      showPlanFollowUpPrompt,
      activeProposedPlan,
      planSidebarLabel,
      planSidebarOpen,
      runtimeMode,
      interactionMode,
      tokenMode,
      lockedProvider,
      providerStatuses,
      activeProjectDefaultModelSelection,
      activeThreadModelSelection,
      activeThreadActivities,
      phoneThreadDock,
      resolvedTheme,
      settings,
      keybindings,
      terminalOpen,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      shouldAutoScrollRef,
      scheduleStickToBottom,
      onSend,
      onInterrupt,
      onImplementPlanInNewThread,
      onRespondToApproval,
      onSelectActivePendingUserInputOption,
      onAdvanceActivePendingUserInput,
      onPreviousActivePendingUserInputQuestion,
      onChangeActivePendingUserInputCustomAnswer,
      onProviderModelSelect,
      toggleInteractionMode,
      handleRuntimeModeChange,
      handleInteractionModeChange,
      handleTokenModeChange,
      togglePlanSidebar,
      focusComposer,
      scheduleComposerFocus,
      setThreadError,
      onExpandImage,
      onGoalBudgetChange,
      onRetryGoal,
      onEditGoal,
      onGoalStatusChange,
      onClearGoal,
    } = props;

    // ------------------------------------------------------------------
    // Store subscriptions (prompt / images / terminal contexts)
    // ------------------------------------------------------------------
    const composerDraft = useComposerThreadDraft(composerDraftTarget);
    const prompt = composerDraft.prompt;
    const composerImages = composerDraft.images;
    const composerTerminalContexts = composerDraft.terminalContexts;
    const composerSourceControlContexts = composerDraft.sourceControlContexts;
    const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;

    const sourceControlDiscovery = useSourceControlDiscovery();
    const hasSourceControlRemote = useMemo(
      () =>
        (sourceControlDiscovery.data?.sourceControlProviders ?? []).some(
          (provider) =>
            provider.status === "available" &&
            (provider.auth.status === "authenticated" || provider.auth.status === "unknown"),
        ),
      [sourceControlDiscovery.data],
    );

    const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
    const insertComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.insertTerminalContext,
    );
    const removeComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.removeTerminalContext,
    );
    const setComposerDraftTerminalContexts = useComposerDraftStore(
      (store) => store.setTerminalContexts,
    );
    const clearComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.clearPersistedAttachments,
    );
    const syncComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.syncPersistedAttachments,
    );
    const clearComposerDraftPromptAndImages = useComposerDraftStore(
      (store) => store.clearPromptAndImages,
    );
    const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
    const updateComposerDraftImage = useComposerDraftStore((store) => store.updateImage);
    const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
    const addSourceControlContextToDraft = useComposerDraftStore(
      (store) => store.addSourceControlContext,
    );
    const removeSourceControlContextFromDraft = useComposerDraftStore(
      (store) => store.removeSourceControlContext,
    );
    const stashEntries = usePromptStashStore((store) => store.entries);
    const stashEntry = usePromptStashStore((store) => store.stashEntry);
    const takeStashEntry = usePromptStashStore((store) => store.takeEntry);
    const finalizeStashEntryImages = usePromptStashStore((store) => store.finalizeEntryImages);

    // ------------------------------------------------------------------
    // Model state
    // ------------------------------------------------------------------
    // Instance-aware projection of the wire provider list. One entry per
    // configured instance (default built-in + any custom `providerInstances.*`),
    // sorted default-first per driver kind for a stable picker order.
    const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
      () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providerStatuses)),
      [providerStatuses],
    );
    const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
    const threadProvider =
      activeThreadSessionProviderInstanceId ??
      activeThreadModelSelection?.instanceId ??
      activeProjectDefaultModelSelection?.instanceId ??
      null;
    const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider;

    const unlockedSelectedProvider =
      resolveProviderDriverKindForInstanceSelection(
        providerInstanceEntries,
        providerStatuses,
        explicitSelectedInstanceId,
      ) ?? ProviderDriverKind.make("codex");
    const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
    const lockedContinuationGroupKey = useMemo((): string | null => {
      if (!lockedProvider) return null;
      const lockedInstanceId =
        activeThreadSessionProviderInstanceId ?? activeThreadModelSelection?.instanceId;
      if (!lockedInstanceId) return null;
      return (
        providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
          ?.continuationGroupKey ?? null
      );
    }, [
      activeThreadModelSelection?.instanceId,
      activeThreadSessionProviderInstanceId,
      lockedProvider,
      providerInstanceEntries,
    ]);

    // Resolve which configured instance the composer is currently targeting.
    // Priority:
    //   1. The composer draft's `activeProvider` — the user's unsaved pick
    //      from the model picker (must win, otherwise the UI appears to
    //      ignore picker selections).
    //   2. Thread's persisted instance id (server-side saved selection).
    //   3. Project default's instance id.
    //   4. First enabled entry matching the current driver kind.
    //   5. First enabled entry overall / default instance for the kind.
    //
    const selectedInstanceId = useMemo<ProviderInstanceId>(() => {
      const candidates: Array<string | null | undefined> = lockedProvider
        ? [
            activeThreadModelSelection?.instanceId,
            activeThreadSessionProviderInstanceId,
            activeProjectDefaultModelSelection?.instanceId,
          ]
        : [
            composerDraft.activeProvider,
            activeThreadSessionProviderInstanceId,
            activeThreadModelSelection?.instanceId,
            activeProjectDefaultModelSelection?.instanceId,
          ];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const match = providerInstanceEntries.find(
          (entry) => entry.instanceId === candidate && entry.enabled,
        );
        if (match) {
          // When locked to a specific driver kind, ignore persisted instance
          // ids from a different kind or continuation group.
          if (lockedProvider && match.driverKind !== lockedProvider) continue;
          if (
            lockedContinuationGroupKey &&
            match.continuationGroupKey !== lockedContinuationGroupKey
          ) {
            continue;
          }
          return match.instanceId;
        }
      }
      if (explicitSelectedInstanceId) {
        return ProviderInstanceId.make(explicitSelectedInstanceId);
      }
      const byKind = providerInstanceEntries.find(
        (entry) =>
          entry.enabled &&
          entry.driverKind === selectedProvider &&
          (!lockedContinuationGroupKey ||
            entry.continuationGroupKey === lockedContinuationGroupKey),
      );
      if (byKind) return byKind.instanceId;
      const anyEnabled = providerInstanceEntries.find((entry) => entry.enabled);
      return (
        anyEnabled?.instanceId ??
        providerInstanceEntries[0]?.instanceId ??
        activeThreadModelSelection?.instanceId ??
        activeProjectDefaultModelSelection?.instanceId ??
        ProviderInstanceId.make("codex")
      );
    }, [
      activeProjectDefaultModelSelection?.instanceId,
      activeThreadSessionProviderInstanceId,
      activeThreadModelSelection?.instanceId,
      composerDraft.activeProvider,
      explicitSelectedInstanceId,
      lockedContinuationGroupKey,
      lockedProvider,
      providerInstanceEntries,
      selectedProvider,
    ]);

    const effectiveModelState = useEffectiveComposerModelState({
      threadRef: composerDraftTarget,
      providers: providerStatuses,
      selectedProvider,
      selectedInstanceId,
      threadModelSelection: activeThreadModelSelection,
      projectModelSelection: activeProjectDefaultModelSelection,
      settings,
    });
    const composerModelOptions = effectiveModelState.modelOptions;
    const selectedModel =
      lockedProvider && activeThreadModelSelection?.instanceId === selectedInstanceId
        ? activeThreadModelSelection.model
        : effectiveModelState.selectedModel;

    // Resolve the active instance's snapshot by `instanceId` so a custom
    // instance gets its own slash commands, skills, and model list — not
    // the first snapshot for the same driver kind.
    const selectedProviderEntry = useMemo(
      () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
      [providerInstanceEntries, selectedInstanceId],
    );
    const selectedProviderStatus = useMemo(
      () => selectedProviderEntry?.snapshot ?? null,
      [selectedProviderEntry],
    );
    const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
      () => selectedProviderEntry?.models ?? [],
      [selectedProviderEntry],
    );

    const composerProviderState = useMemo(
      () =>
        getComposerProviderState({
          provider: selectedProvider,
          model: selectedModel,
          models: selectedProviderModels,
          prompt,
          modelOptions: composerModelOptions?.[selectedInstanceId],
        }),
      [
        composerModelOptions,
        prompt,
        selectedInstanceId,
        selectedModel,
        selectedProvider,
        selectedProviderModels,
      ],
    );

    const selectedPromptEffort = composerProviderState.promptEffort;
    const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
    const alwaysUseBuildMode = useUiStateStore((state) => state.alwaysUseBuildMode);
    // Read unconditionally: behind a `&&` this hook would be skipped whenever
    // the Build-mode lock is off, so toggling the setting would change the
    // component's hook count mid-flight and tear down the tree.
    const presentationTier = usePresentationTier();
    // The web phone tier is frozen (see AGENTS.md): the Build-mode lock only
    // applies to non-phone presentation tiers.
    const enforceBuildMode = alwaysUseBuildMode && presentationTier !== "phone";
    const composerProviderControls = useMemo(
      () => ({
        showInteractionModeToggle:
          !enforceBuildMode && getProviderInteractionModeToggle(providerStatuses, selectedProvider),
        askModeSupported: getProviderSupportsAskMode(providerStatuses, selectedProvider),
      }),
      [enforceBuildMode, providerStatuses, selectedProvider],
    );
    const selectedModelSelection = useMemo<ModelSelection>(
      () =>
        createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
      [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
    );
    const selectedModelForPicker = selectedModel;
    // Instance-keyed option list so the picker can show each configured
    // instance (built-in + custom) as a first-class sidebar entry. The
    // options are server-reported models plus that exact instance's
    // configured custom models. While a provider snapshot is unavailable,
    // keep the active slug visible so a transient catalog failure cannot
    // make the trigger appear to switch models.
    const modelOptionsByInstance = useMemo<
      ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
    >(() => {
      const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
      for (const entry of providerInstanceEntries) {
        out.set(
          entry.instanceId,
          getAppModelOptionsForInstance(
            settings,
            entry,
            entry.instanceId === selectedInstanceId ? selectedModel : undefined,
          ),
        );
      }
      return out;
    }, [providerInstanceEntries, selectedInstanceId, selectedModel, settings]);
    const selectedModelForPickerWithCustomFallback = useMemo(() => {
      const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
      return currentOptions.some((option) => option.slug === selectedModelForPicker)
        ? selectedModelForPicker
        : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
    }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

    // ------------------------------------------------------------------
    // Context window
    // ------------------------------------------------------------------
    const selectedContextWindow =
      composerProviderState.modelOptionsForDispatch?.find(
        (selection) => selection.id === "contextWindow",
      )?.value ?? null;
    // Drivers that report a per-model context limit (OpenCode, Copilot) fill the
    // meter's max before the user overrides it via the contextWindow
    // capability option or the provider sends a limit with usage.
    const selectedModelMaxContextTokens =
      selectedProviderStatus?.models.find((model) => model.slug === selectedModel)
        ?.maxContextTokens ?? null;
    const contextWindowUsage = useMemo(
      () =>
        deriveContextWindowUsage(
          activeThreadActivities ?? [],
          typeof selectedContextWindow === "string" ? selectedContextWindow : null,
          selectedModelMaxContextTokens,
        ),
      [activeThreadActivities, selectedContextWindow, selectedModelMaxContextTokens],
    );
    const contextWindowRateLimits = selectedProviderStatus?.rateLimits;

    // ------------------------------------------------------------------
    // Composer-local state
    // ------------------------------------------------------------------
    const [composerCursor, setComposerCursor] = useState(() =>
      collapseExpandedComposerCursor(prompt, prompt.length),
    );
    const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
      detectComposerTrigger(prompt, prompt.length),
    );
    const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
    const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
      null,
    );
    const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
    const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
    const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
    const [isComposerFocused, setIsComposerFocused] = useState(false);
    const [isComposerHovered, setIsComposerHovered] = useState(false);
    const [isReadingChat, setIsReadingChat] = useState(false);
    const [isStashPickerOpen, setIsStashPickerOpen] = useState(false);
    // The collapse-to-pill behavior follows the presentation tier (not the
    // old <640 px query), so 640-767 px viewports and coarse-pointer
    // landscape phones collapse consistently with the rest of the phone UI.
    const isMobileViewport = presentationTier === "phone";
    const isComposerCollapsedMobile = isMobileViewport && !isComposerFocused;
    const pendingContextHandoff = useMemo(
      () =>
        derivePendingContextHandoff({
          threadStarted: activeThreadStarted,
          isPhoneTier: isMobileViewport,
          canonicalSelection: activeThreadModelSelection,
          targetSelection: selectedModelSelection,
          providerInstanceEntries,
          modelOptionsByInstance,
        }),
      [
        activeThreadModelSelection,
        activeThreadStarted,
        isMobileViewport,
        modelOptionsByInstance,
        providerInstanceEntries,
        selectedModelSelection,
      ],
    );

    // ------------------------------------------------------------------
    // Refs
    // ------------------------------------------------------------------
    const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
    const composerFormRef = useRef<HTMLFormElement>(null);
    const composerSurfaceRef = useRef<HTMLDivElement>(null);
    const composerFormHeightRef = useRef(0);
    const composerSelectLockRef = useRef(false);
    const composerMenuOpenRef = useRef(false);
    const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
    const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
    const composerBlurFrameRef = useRef<number | null>(null);
    const inFlightStashKeysRef = useRef(new Set<string>());
    const stashSnapshotsRef = useRef(
      new Map<
        string,
        {
          key: string;
          images: ComposerImageAttachment[];
        }
      >(),
    );
    const stashCommandHandlerRef = useRef<() => void>(() => {});

    const releaseStashSnapshot = useCallback((id: string) => {
      const snapshot = stashSnapshotsRef.current.get(id);
      if (!snapshot) return;
      stashSnapshotsRef.current.delete(id);
      inFlightStashKeysRef.current.delete(snapshot.key);
      revokeUnreferencedStashPreviewUrls(snapshot.images);
    }, []);

    useEffect(
      () => () => {
        const snapshots = [...stashSnapshotsRef.current.values()];
        stashSnapshotsRef.current.clear();
        inFlightStashKeysRef.current.clear();
        for (const snapshot of snapshots) {
          revokeUnreferencedStashPreviewUrls(snapshot.images);
        }
      },
      [],
    );

    // ------------------------------------------------------------------
    // Derived: composer send state
    // ------------------------------------------------------------------
    const composerSendState = useMemo(
      () =>
        deriveComposerSendState({
          prompt,
          imageCount: composerImages.length,
          terminalContexts: composerTerminalContexts,
          sourceControlContexts: composerSourceControlContexts,
        }),
      [composerImages.length, composerSourceControlContexts, composerTerminalContexts, prompt],
    );

    // ------------------------------------------------------------------
    // File upload state (streamed attachments)
    // ------------------------------------------------------------------
    const fileUploadRecords = useComposerFileUploadRecords();
    // Recomputed on every upload-record change: the engine subscription in
    // useComposerFileUploadRecords re-renders the composer as uploads progress.
    const composerFileUploadSendBlock = deriveComposerFileUploadSendBlock({
      attachments: composerImages,
      nowMs: Date.now(),
    });
    const composerSendBlockedReason = composerFileUploadSendBlock;
    const composerHasSendableContent =
      composerSendState.hasSendableContent && composerFileUploadSendBlock === null;

    // Upload completion flows back into the draft entry so dispatch, draft
    // persistence, and stash snapshots all read the token from the attachment.
    useEffect(() => {
      for (const image of composerImages) {
        if (image.type !== "file") continue;
        const status = fileUploadRecords.get(image.id)?.status;
        if (!status || status.kind !== "uploaded") continue;
        if (image.uploadToken === status.uploadToken && image.expiresAt === status.expiresAt) {
          continue;
        }
        updateComposerDraftImage(composerDraftTarget, image.id, (draftImage) => ({
          ...draftImage,
          uploadToken: status.uploadToken,
          expiresAt: status.expiresAt,
        }));
      }
    }, [composerDraftTarget, composerImages, fileUploadRecords, updateComposerDraftImage]);

    const previousUploadIdsRef = useRef<ReadonlySet<string>>(new Set());

    // Engine records are process-transient: drop the ones whose attachment
    // left the composer (removal, send clear, discard), except those still
    // referenced by a stash snapshot that may be restored this session.
    useEffect(() => {
      const liveIds = new Set(composerImages.map((image) => image.id));
      const stashedIds = new Set(
        [...stashSnapshotsRef.current.values()].flatMap((snapshot) =>
          snapshot.images.map((image) => image.id),
        ),
      );
      // A mounted composer may change threads while the previous draft keeps
      // uploading. Its records still belong to that draft, even while hidden.
      const retainedIds = new Set([...liveIds, ...stashedIds]);
      for (const draft of Object.values(useComposerDraftStore.getState().draftsByThreadKey)) {
        for (const image of draft.images) retainedIds.add(image.id);
      }
      releaseUnusedComposerFileUploads(previousUploadIdsRef.current, retainedIds);
      previousUploadIdsRef.current = liveIds;
    }, [composerImages]);

    // ------------------------------------------------------------------
    // Derived: composer trigger / menu
    // ------------------------------------------------------------------
    const composerTriggerKind = composerTrigger?.kind ?? null;
    const {
      composerMenuItems,
      composerMenuOpen,
      composerMenuSearchKey,
      activeComposerMenuItem,
      isComposerMenuLoading,
      composerMenuEmptyState,
    } = useComposerAttachmentMenus({
      composerTrigger,
      environmentId,
      gitCwd,
      selectedProvider,
      selectedProviderStatus,
      composerHighlightedItemId,
      composerHighlightedSearchKey,
    });

    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;

    const nonPersistedComposerImageIdSet = useMemo(
      () => new Set(nonPersistedComposerImageIds),
      [nonPersistedComposerImageIds],
    );

    const isComposerApprovalState = activePendingApproval !== null;
    const activePendingUserInput = pendingUserInputs[0] ?? null;
    const showGoalHeader =
      !isMobileViewport &&
      activeThreadGoal != null &&
      !isComposerApprovalState &&
      pendingUserInputs.length === 0 &&
      !(showPlanFollowUpPrompt && activeProposedPlan !== null);
    const hasComposerHeader =
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      (showPlanFollowUpPrompt && activeProposedPlan !== null) ||
      showGoalHeader;
    // Presentation flag only: the collapsed editor is the same always-mounted
    // editor, so this decides whether the compact send affordance renders
    // beside it — nothing is swapped in or out.
    const showCollapsedMobileSendAction =
      isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;
    // A disabled editor is not editable, so it cannot receive the activating
    // tap at all. The collapsed surface needs an explicit expand path in that
    // state (see the surface onClick below).
    const isComposerEditorDisabled =
      isConnecting ||
      isComposerApprovalState ||
      (environmentUnavailable !== null && activePendingProgress === null);

    const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
    const showPlanSidebarToggle = false;
    const composerFooterActionLayoutKey = useMemo(
      () =>
        deriveComposerFooterActionLayoutKey({
          pendingProgress: activePendingProgress,
          pendingIsResponding: activePendingIsResponding,
          phase,
          showPlanFollowUpPrompt,
          promptHasText: prompt.trim().length > 0,
          hasSendableContent: composerHasSendableContent,
          isSendBusy,
          isConnecting,
          isPreparingWorktree,
        }),
      [
        activePendingIsResponding,
        activePendingProgress,
        composerHasSendableContent,
        isConnecting,
        isPreparingWorktree,
        isSendBusy,
        phase,
        prompt,
        showPlanFollowUpPrompt,
      ],
    );

    // ------------------------------------------------------------------
    // Provider traits UI
    // ------------------------------------------------------------------
    const setPromptFromTraits = useCallback(
      (nextPrompt: string) => {
        if (nextPrompt === promptRef.current) {
          scheduleComposerFocus();
          return;
        }
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
        scheduleComposerFocus();
      },
      [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
    );

    // The same read-only mutation capability the footer consumes. Traits are
    // draft-local, so an ungated chip is an inconsistent gate rather than a
    // privilege escape — but leaving it live beside a disabled model pill and a
    // disabled policy control is exactly the retrofit this step exists to avoid.
    const traitsMutationCapability = useHostedRpcCapability(
      ORCHESTRATION_WS_METHODS.dispatchCommand,
    );
    const traitsDisabled = !traitsMutationCapability.allowed;
    const traitsDisabledReason = traitsMutationCapability.reason;

    const providerTraitsMenuContent = renderProviderTraitsMenuContent({
      hideAgent: enforceBuildMode,
      provider: selectedProvider,
      instanceId: selectedInstanceId,
      ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
      ...(routeKind === "draft" && draftId ? { draftId } : {}),
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: composerModelOptions?.[selectedInstanceId],
      prompt,
      onPromptChange: setPromptFromTraits,
      disabled: traitsDisabled,
      disabledReason: traitsDisabledReason,
    });
    const providerTraitsChips = renderProviderTraitsChips({
      hideAgent: enforceBuildMode,
      provider: selectedProvider,
      instanceId: selectedInstanceId,
      ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
      ...(routeKind === "draft" && draftId ? { draftId } : {}),
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: composerModelOptions?.[selectedInstanceId],
      prompt,
      onPromptChange: setPromptFromTraits,
      disabled: traitsDisabled,
      disabledReason: traitsDisabledReason,
    });
    const pendingPrimaryAction = useMemo(
      () =>
        activePendingProgress
          ? {
              questionIndex: activePendingProgress.questionIndex,
              isLastQuestion: activePendingProgress.isLastQuestion,
              canAdvance: activePendingProgress.canAdvance,
              isResponding: activePendingIsResponding,
              isComplete: Boolean(activePendingResolvedAnswers),
            }
          : null,
      [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
    );
    const collapsedComposerPrimaryActionDisabled = isComposerPrimaryActionDisabled({
      phase,
      isSendBusy,
      isConnecting,
      hasSendableContent: composerHasSendableContent,
    });
    const collapsedComposerPrimaryActionLabel = "Send message";
    const showMobilePendingAnswerActions =
      isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

    // ------------------------------------------------------------------
    // Prompt helpers
    // ------------------------------------------------------------------
    const setPrompt = useCallback(
      (nextPrompt: string) => {
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      },
      [composerDraftTarget, setComposerDraftPrompt],
    );

    const removeComposerTerminalContextFromDraft = useCallback(
      (contextId: string) => {
        const contextIndex = composerTerminalContexts.findIndex(
          (context) => context.id === contextId,
        );
        if (contextIndex < 0) return;
        const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
        promptRef.current = removal.prompt;
        setPrompt(removal.prompt);
        removeComposerDraftTerminalContext(composerDraftTarget, contextId);
        const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
      },
      [
        composerDraftTarget,
        composerTerminalContexts,
        promptRef,
        removeComposerDraftTerminalContext,
        setPrompt,
      ],
    );

    // ------------------------------------------------------------------
    // Sync refs back to parent
    // ------------------------------------------------------------------
    useEffect(() => {
      promptRef.current = prompt;
      setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
    }, [prompt, promptRef]);

    useEffect(() => {
      composerImagesRef.current = composerImages;
    }, [composerImages, composerImagesRef]);

    useEffect(() => {
      composerTerminalContextsRef.current = composerTerminalContexts;
    }, [composerTerminalContexts, composerTerminalContextsRef]);

    // ------------------------------------------------------------------
    // Composer menu highlight sync
    // ------------------------------------------------------------------
    useEffect(() => {
      if (!composerMenuOpen) {
        setComposerHighlightedItemId(null);
        setComposerHighlightedSearchKey(null);
        return;
      }
      const nextActiveItemId = resolveComposerMenuActiveItemId({
        items: composerMenuItems,
        highlightedItemId: composerHighlightedItemId,
        currentSearchKey: composerMenuSearchKey,
        highlightedSearchKey: composerHighlightedSearchKey,
      });
      setComposerHighlightedItemId((existing) =>
        existing === nextActiveItemId ? existing : nextActiveItemId,
      );
      setComposerHighlightedSearchKey((existing) =>
        existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
      );
    }, [
      composerHighlightedItemId,
      composerHighlightedSearchKey,
      composerMenuItems,
      composerMenuOpen,
      composerMenuSearchKey,
    ]);

    const lastSyncedPendingInputRef = useRef<{
      requestId: string | null;
      questionId: string | null;
    } | null>(null);

    useEffect(() => {
      const nextCustomAnswer = activePendingProgress?.customAnswer;
      if (typeof nextCustomAnswer !== "string") {
        lastSyncedPendingInputRef.current = null;
        return;
      }

      const nextRequestId = activePendingUserInput?.requestId ?? null;
      const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
      const questionChanged =
        lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
        lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
      const textChangedExternally = promptRef.current !== nextCustomAnswer;

      lastSyncedPendingInputRef.current = {
        requestId: nextRequestId,
        questionId: nextQuestionId,
      };

      if (!questionChanged && !textChangedExternally) {
        return;
      }

      promptRef.current = nextCustomAnswer;
      const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextCustomAnswer,
          expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
        ),
      );
      setComposerHighlightedItemId(null);
    }, [
      activePendingProgress?.customAnswer,
      activePendingProgress?.activeQuestion?.id,
      activePendingUserInput?.requestId,
      promptRef,
    ]);

    // ------------------------------------------------------------------
    // Reset compositor state on thread/draft change
    // ------------------------------------------------------------------
    useEffect(() => {
      setComposerHighlightedItemId(null);
      setComposerCursor(
        collapseExpandedComposerCursor(promptRef.current, promptRef.current.length),
      );
      setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    }, [draftId, activeThreadId, promptRef]);

    // ------------------------------------------------------------------
    // Footer compact layout observation
    // ------------------------------------------------------------------
    useLayoutEffect(() => {
      const composerForm = composerFormRef.current;
      if (!composerForm) return;
      const measureComposerFormWidth = () => composerForm.clientWidth;
      const measureFooterCompactness = () => {
        const composerFormWidth = measureComposerFormWidth();
        const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
        const primaryActionsCompact =
          footerCompact &&
          shouldUseCompactComposerPrimaryActions(composerFormWidth, {
            hasWideActions: composerFooterHasWideActions,
          });
        return {
          primaryActionsCompact,
          footerCompact,
        };
      };

      composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
      const initialCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
      setIsComposerFooterCompact(initialCompactness.footerCompact);
      if (typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver((entries) => {
        const [entry] = entries;
        if (!entry) return;
        const nextCompactness = measureFooterCompactness();
        setIsComposerPrimaryActionsCompact((previous) =>
          previous === nextCompactness.primaryActionsCompact
            ? previous
            : nextCompactness.primaryActionsCompact,
        );
        setIsComposerFooterCompact((previous) =>
          previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
        );
        const nextHeight = entry.contentRect.height;
        const previousHeight = composerFormHeightRef.current;
        composerFormHeightRef.current = nextHeight;
        if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
        if (!shouldAutoScrollRef.current) return;
        scheduleStickToBottom();
      });

      observer.observe(composerForm);
      return () => {
        observer.disconnect();
      };
    }, [
      activeThreadId,
      composerFooterActionLayoutKey,
      composerFooterHasWideActions,
      scheduleStickToBottom,
      shouldAutoScrollRef,
    ]);

    // ------------------------------------------------------------------
    // Image persist effect
    // ------------------------------------------------------------------
    useEffect(() => {
      let cancelled = false;
      void (async () => {
        if (composerImages.length === 0) {
          clearComposerDraftPersistedAttachments(composerDraftTarget);
          return;
        }
        const getPersistedAttachmentsForThread = () =>
          getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
        try {
          const currentPersistedAttachments = getPersistedAttachmentsForThread();
          const existingPersistedById = new Map(
            currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
          );
          const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
          await Promise.all(
            composerImages.map(async (image) => {
              // Streamed file attachments persist token metadata only; the
              // bytes stay out of localStorage by design.
              if (image.type === "file") {
                const status = fileUploadRecords.get(image.id)?.status;
                if (status?.kind === "uploaded") {
                  stagedAttachmentById.set(image.id, {
                    type: "file",
                    id: image.id,
                    name: image.name,
                    mimeType: image.mimeType,
                    sizeBytes: image.sizeBytes,
                    uploadToken: status.uploadToken,
                    expiresAt: status.expiresAt,
                  });
                  return;
                }
                if (status) {
                  stagedAttachmentById.set(image.id, {
                    type: "file",
                    id: image.id,
                    name: image.name,
                    mimeType: image.mimeType,
                    sizeBytes: image.sizeBytes,
                    uploadState: "needsReattach",
                  });
                  return;
                }
              }
              try {
                // Encode from the neutral union via the AttachmentCodec so the
                // persisted dataUrl is produced through the same attachment path
                // as the send pipeline.
                const dataUrl = encodeComposerAttachmentDataUrl(
                  await webAttachmentCodec.encode(image),
                );
                stagedAttachmentById.set(image.id, {
                  type: image.type,
                  id: image.id,
                  name: image.name,
                  mimeType: image.mimeType,
                  sizeBytes: image.sizeBytes,
                  dataUrl,
                });
              } catch {
                const existingPersisted = existingPersistedById.get(image.id);
                if (existingPersisted) {
                  stagedAttachmentById.set(image.id, existingPersisted);
                }
              }
            }),
          );
          const serialized = Array.from(stagedAttachmentById.values());
          if (cancelled) return;
          syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
        } catch {
          const currentImageIds = new Set(composerImages.map((image) => image.id));
          const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
          const fallbackPersistedIds = fallbackPersistedAttachments
            .map((attachment) => attachment.id)
            .filter((id) => currentImageIds.has(id));
          const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
          const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
            fallbackPersistedIdSet.has(attachment.id),
          );
          if (cancelled) return;
          syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [
      composerDraftTarget,
      clearComposerDraftPersistedAttachments,
      composerImages,
      fileUploadRecords,
      getComposerDraft,
      syncComposerDraftPersistedAttachments,
    ]);

    // ------------------------------------------------------------------
    // Callbacks: prompt change
    // ------------------------------------------------------------------
    const onPromptChange = useCallback(
      (
        nextPrompt: string,
        nextCursor: number,
        expandedCursor: number,
        cursorAdjacentToMention: boolean,
        terminalContextIds: string[],
      ) => {
        if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
          setComposerCursor(nextCursor);
          setComposerTrigger(
            cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
          );
          onChangeActivePendingUserInputCustomAnswer(
            activePendingProgress.activeQuestion.id,
            nextPrompt,
            nextCursor,
            expandedCursor,
            cursorAdjacentToMention,
          );
          return;
        }
        promptRef.current = nextPrompt;
        setPrompt(nextPrompt);
        if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
          setComposerDraftTerminalContexts(
            composerDraftTarget,
            syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
          );
        }
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
      },
      [
        activePendingProgress?.activeQuestion,
        pendingUserInputs.length,
        onChangeActivePendingUserInputCustomAnswer,
        promptRef,
        setPrompt,
        composerDraftTarget,
        composerTerminalContexts,
        setComposerDraftTerminalContexts,
      ],
    );

    // ------------------------------------------------------------------
    // Callbacks: prompt replacement / menu
    // ------------------------------------------------------------------
    const applyPromptReplacement = useCallback(
      (
        rangeStart: number,
        rangeEnd: number,
        replacement: string,
        options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
      ): boolean => {
        const currentText = promptRef.current;
        const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
        const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
        if (
          options?.expectedText !== undefined &&
          currentText.slice(safeStart, safeEnd) !== options.expectedText
        ) {
          return false;
        }
        const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
        const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
        const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
        promptRef.current = next.text;
        const activePendingQuestion = activePendingProgress?.activeQuestion;
        if (activePendingQuestion && activePendingUserInput) {
          onChangeActivePendingUserInputCustomAnswer(
            activePendingQuestion.id,
            next.text,
            nextCursor,
            nextExpandedCursor,
            false,
          );
        } else {
          setPrompt(next.text);
        }
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
        if (options?.focusEditorAfterReplace !== false) {
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCursor);
          });
        }
        return true;
      },
      [
        activePendingProgress?.activeQuestion,
        activePendingUserInput,
        onChangeActivePendingUserInputCustomAnswer,
        promptRef,
        setPrompt,
      ],
    );

    const readComposerSnapshot = useCallback((): {
      value: string;
      cursor: number;
      expandedCursor: number;
      terminalContextIds: string[];
    } => {
      const editorSnapshot = composerEditorRef.current?.readSnapshot();
      if (editorSnapshot) {
        return editorSnapshot;
      }
      return {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
    }, [composerCursor, composerTerminalContexts, promptRef]);

    const resolveActiveComposerTrigger = useCallback((): {
      snapshot: { value: string; cursor: number; expandedCursor: number };
      trigger: ComposerTrigger | null;
    } => {
      const snapshot = readComposerSnapshot();
      return {
        snapshot,
        trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
      };
    }, [readComposerSnapshot]);

    // ------------------------------------------------------------------
    // Callbacks: source-control context picker
    // ------------------------------------------------------------------
    const { handleSelectIssue, handleSelectChangeRequest } =
      useComposerSourceControlContextSelection({
        environmentId,
        gitCwd,
        composerDraftTarget,
        addSourceControlContext: addSourceControlContextToDraft,
      });

    const onSelectComposerItem = useCallback(
      (item: ComposerCommandItem) => {
        if (composerSelectLockRef.current) return;
        composerSelectLockRef.current = true;
        window.requestAnimationFrame(() => {
          composerSelectLockRef.current = false;
        });
        const { snapshot, trigger } = resolveActiveComposerTrigger();
        if (!trigger) return;
        if (item.type === "path") {
          const replacement = `@${serializeComposerMentionPath(item.path)} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "slash-command") {
          if (item.command === "model") {
            const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
              expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
              focusEditorAfterReplace: false,
            });
            if (applied) {
              setComposerHighlightedItemId(null);
              setIsComposerModelPickerOpen(true);
            }
            return;
          }
          if (item.command === "goal" || item.command === "btw") {
            const replacement = `/${item.command} `;
            const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
              snapshot.value,
              trigger.rangeEnd,
              replacement,
            );
            const applied = applyPromptReplacement(
              trigger.rangeStart,
              replacementRangeEnd,
              replacement,
              { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
            );
            if (applied) setComposerHighlightedItemId(null);
            return;
          }
          void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          });
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "provider-slash-command") {
          const replacement = `/${item.command.name} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "skill") {
          const replacement = `$${item.skill.name} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "source-control-issue") {
          // Delete the `#...` text range from the composer
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          });
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          // Fetch detail and attach chip (event-driven, non-blocking)
          void handleSelectIssue(item.summary);
          return;
        }
        if (item.type === "source-control-pr") {
          // Delete the `#...` text range from the composer
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          });
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          // Fetch detail and attach chip (event-driven, non-blocking)
          void handleSelectChangeRequest(item.summary);
          return;
        }
      },
      [
        applyPromptReplacement,
        handleInteractionModeChange,
        handleSelectIssue,
        handleSelectChangeRequest,
        resolveActiveComposerTrigger,
      ],
    );

    const onComposerMenuItemHighlighted = useCallback(
      (itemId: string | null) => {
        setComposerHighlightedItemId(itemId);
        setComposerHighlightedSearchKey(composerMenuSearchKey);
      },
      [composerMenuSearchKey],
    );

    const nudgeComposerMenuHighlight = useCallback(
      (key: "ArrowDown" | "ArrowUp") => {
        if (composerMenuItems.length === 0) return;
        const highlightedIndex = composerMenuItems.findIndex(
          (item) => item.id === composerHighlightedItemId,
        );
        const normalizedIndex =
          highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
        const offset = key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
        const nextItem = composerMenuItems[nextIndex];
        setComposerHighlightedItemId(nextItem?.id ?? null);
      },
      [composerHighlightedItemId, composerMenuItems],
    );

    const blurMobileComposerAfterSend = useCallback(() => {
      if (!isMobileViewport) return;
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
        composerBlurFrameRef.current = null;
      }
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      setIsComposerFocused(false);
    }, [isMobileViewport]);

    const shouldBlurMobileComposerOnSubmit = useCallback(
      () =>
        shouldBlurComposerOnSubmit({
          isMobileViewport,
          isSendBusy,
          isConnecting,
          phase,
          pendingProgress: activePendingProgress,
          hasResolvedAnswers: Boolean(activePendingResolvedAnswers),
          showPlanFollowUpPrompt,
          hasSendableContent: composerHasSendableContent,
        }),
      [
        activePendingProgress,
        activePendingResolvedAnswers,
        composerHasSendableContent,
        isConnecting,
        isMobileViewport,
        isSendBusy,
        phase,
        showPlanFollowUpPrompt,
      ],
    );

    const submitComposer = useCallback(
      (event?: { preventDefault: () => void }) => {
        onSend(event);
        if (shouldBlurMobileComposerOnSubmit()) {
          blurMobileComposerAfterSend();
        }
      },
      [blurMobileComposerAfterSend, onSend, shouldBlurMobileComposerOnSubmit],
    );

    // ------------------------------------------------------------------
    // Callbacks: command key
    // ------------------------------------------------------------------
    const onComposerCommandKey = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
      event: KeyboardEvent,
    ) => {
      if (key === "Tab" && event.shiftKey) {
        toggleInteractionMode();
        return true;
      }
      const { trigger } = resolveActiveComposerTrigger();
      const menuIsActive = composerMenuOpenRef.current || trigger !== null;
      if (menuIsActive) {
        const currentItems = composerMenuItemsRef.current;
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (key === "ArrowDown" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowDown");
          return true;
        }
        if (key === "ArrowUp" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowUp");
          return true;
        }
        if ((key === "Enter" || key === "Tab") && selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
      if (key === "Enter" && !event.shiftKey) {
        submitComposer();
        return true;
      }
      return false;
    };

    // ------------------------------------------------------------------
    // Callbacks: images / file attachments / drag / paste
    // ------------------------------------------------------------------
    const {
      isDragOverComposer,
      addComposerAttachments,
      removeComposerImage,
      retryComposerFileUpload,
      onComposerPaste,
      onComposerDragEnter,
      onComposerDragOver,
      onComposerDragLeave,
      onComposerDrop,
    } = useComposerImageAttachments({
      composerDraftTarget,
      environmentId,
      activeThreadId,
      draftId,
      routeThreadRef,
      runtimeMode,
      selectedProvider,
      gitCwd,
      pendingUserInputCount: pendingUserInputs.length,
      composerImagesRef,
      editorRef: composerEditorRef,
      setThreadError,
      focusComposer,
    });

    const handleRemoveSourceControlContext = useCallback(
      (id: string) => {
        removeSourceControlContextFromDraft(composerDraftTarget, id);
      },
      [composerDraftTarget, removeSourceControlContextFromDraft],
    );

    // ------------------------------------------------------------------
    // Re-attach flow for interrupted streamed uploads
    // ------------------------------------------------------------------
    const reattachFileInputRef = useRef<HTMLInputElement>(null);
    const reattachingAttachmentIdRef = useRef<string | null>(null);
    const handleReattachFile = useCallback((imageId: string) => {
      reattachingAttachmentIdRef.current = imageId;
      reattachFileInputRef.current?.click();
    }, []);
    const handleReattachFileChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        const deadAttachmentId = reattachingAttachmentIdRef.current;
        reattachingAttachmentIdRef.current = null;
        if (!file) return;
        if (deadAttachmentId) {
          removeComposerImage(deadAttachmentId);
        }
        void addComposerAttachments([file]);
      },
      [addComposerAttachments, removeComposerImage],
    );

    // ------------------------------------------------------------------
    // Prompt stash
    // ------------------------------------------------------------------
    const restoreStashEntry = useCallback(
      (id: string, options?: { preferMemorySnapshot?: boolean }) => {
        // Take first: restore and delete are single-consumer operations even
        // if click and Enter arrive in the same frame.
        const { entry, durable } = takeStashEntry(id);
        if (!entry) return;

        const memorySnapshot = stashSnapshotsRef.current.get(id);
        const useMemorySnapshot =
          memorySnapshot !== undefined &&
          (options?.preferMemorySnapshot === true || entry.pendingImageCount > 0);
        let imageCandidates: ComposerImageAttachment[];
        let hydrationUnreadableNames: string[] = [];
        if (useMemorySnapshot && memorySnapshot) {
          imageCandidates = memorySnapshot.images;
        } else {
          const hydrated = hydrateImagesFromPersistedWithFailures(entry.attachments);
          imageCandidates = hydrated.images;
          hydrationUnreadableNames = hydrated.unreadableImageNames;
        }

        const currentImages = [...composerImagesRef.current];
        const existingIds = new Set(currentImages.map((image) => image.id));
        const existingDedupKeys = new Set(
          currentImages.map((image) => composerDraftImageDedupKey(image)),
        );
        const acceptedImages: ComposerImageAttachment[] = [];
        const duplicateImageNames: string[] = [];
        const attachmentLimitImageNames: string[] = [];
        for (const image of imageCandidates) {
          const dedupKey = composerDraftImageDedupKey(image);
          if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
            duplicateImageNames.push(image.name);
            continue;
          }
          if (currentImages.length + acceptedImages.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
            attachmentLimitImageNames.push(image.name);
            continue;
          }
          acceptedImages.push(image);
          existingIds.add(image.id);
          existingDedupKeys.add(dedupKey);
        }

        const currentPrompt = promptRef.current;
        const nextPrompt = mergeStashedPrompt(currentPrompt, entry.prompt);
        if (nextPrompt !== currentPrompt) {
          promptRef.current = nextPrompt;
          setPrompt(nextPrompt);
          const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
          setComposerCursor(nextCursor);
          setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
        }
        if (acceptedImages.length > 0) {
          addComposerDraftImages(composerDraftTarget, acceptedImages);
          composerImagesRef.current = [...currentImages, ...acceptedImages];
        }

        setIsStashPickerOpen(false);
        releaseStashSnapshot(id);
        scheduleComposerFocus();

        if (!durable) {
          toastManager.add({
            type: "warning",
            title: "Restored stash may reappear after reload",
            description: "The prompt was restored, but browser storage could not save its removal.",
            data: { hideCopyButton: true },
          });
        }

        const imageWarnings: string[] = [];
        if (!useMemorySnapshot && entry.unreadableImageNames.length > 0) {
          imageWarnings.push(
            `Unreadable while saving: ${formatStashImageNames(entry.unreadableImageNames)}.`,
          );
        }
        if (!useMemorySnapshot && hydrationUnreadableNames.length > 0) {
          imageWarnings.push(
            `Unreadable while restoring: ${formatStashImageNames(hydrationUnreadableNames)}.`,
          );
        }
        if (!useMemorySnapshot && entry.droppedImageNames.length > 0) {
          imageWarnings.push(
            `Not saved because the stash image budget was full: ${formatStashImageNames(entry.droppedImageNames)}.`,
          );
        }
        if (!useMemorySnapshot && entry.pendingImageCount > 0) {
          imageWarnings.push(
            `${entry.pendingImageCount} image${entry.pendingImageCount === 1 ? " was" : "s were"} still saving and could not be restored.`,
          );
        }
        if (duplicateImageNames.length > 0) {
          imageWarnings.push(
            `Already attached and skipped: ${formatStashImageNames(duplicateImageNames)}.`,
          );
        }
        if (attachmentLimitImageNames.length > 0) {
          imageWarnings.push(
            `Not restored because this composer can hold ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images: ${formatStashImageNames(attachmentLimitImageNames)}.`,
          );
        }
        if (imageWarnings.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Some stashed images could not be restored",
            description: imageWarnings.join(" "),
            data: { hideCopyButton: true },
          });
        }
      },
      [
        addComposerDraftImages,
        composerDraftTarget,
        composerImagesRef,
        promptRef,
        releaseStashSnapshot,
        scheduleComposerFocus,
        setPrompt,
        takeStashEntry,
      ],
    );

    const deleteStashEntry = useCallback(
      (id: string) => {
        const { entry, durable } = takeStashEntry(id);
        if (!entry) return;
        releaseStashSnapshot(id);
        if (!durable) {
          toastManager.add({
            type: "warning",
            title: "Deleted stash may reappear after reload",
            description: "Browser storage could not save the deletion.",
            data: { hideCopyButton: true },
          });
        }
      },
      [releaseStashSnapshot, takeStashEntry],
    );

    const stashCurrentPrompt = useCallback(() => {
      // The shortcut is still handled by the capture listener in these
      // states, preventing the browser Save dialog without mutating hidden or
      // pending-answer composer content.
      if (isMobileViewport || isComposerApprovalState || pendingUserInputs.length > 0) {
        return;
      }

      const stashedPrompt = stripInlineTerminalContextPlaceholders(promptRef.current);
      const images = [...composerImagesRef.current];
      const promptForEntry = stashedPrompt.trim().length > 0 ? stashedPrompt : "";
      if (promptForEntry.length === 0 && images.length === 0) {
        setIsStashPickerOpen((open) => !open);
        return;
      }

      const snapshotKey = stashSnapshotKey(composerDraftTarget, promptForEntry, images);
      if (inFlightStashKeysRef.current.has(snapshotKey)) {
        return;
      }
      inFlightStashKeysRef.current.add(snapshotKey);

      const entryId = randomUUID();
      const entry: PromptStashEntry = {
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt: promptForEntry,
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
      };
      const write = stashEntry(entry);
      if (!write.written) {
        inFlightStashKeysRef.current.delete(snapshotKey);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not stash this prompt",
            description: "Browser storage rejected the stash. The composer was left unchanged.",
            data: { hideCopyButton: true },
          }),
        );
        return;
      }

      stashSnapshotsRef.current.set(entryId, { key: snapshotKey, images });
      if (write.evicted) {
        releaseStashSnapshot(write.evicted.id);
      }

      clearComposerDraftPromptAndImages(composerDraftTarget);
      const clearedPrompt = getComposerDraft(composerDraftTarget)?.prompt ?? "";
      promptRef.current = clearedPrompt;
      composerImagesRef.current = [];
      const clearedCursor = collapseExpandedComposerCursor(clearedPrompt, clearedPrompt.length);
      setComposerCursor(clearedCursor);
      setComposerTrigger(null);
      setComposerHighlightedItemId(null);
      setIsStashPickerOpen(false);

      toastManager.add({
        type: "success",
        title: "Prompt stashed",
        description:
          images.length > 0
            ? `Saving ${images.length} image${images.length === 1 ? "" : "s"} in the background.`
            : undefined,
        actionProps: {
          children: "Undo",
          onClick: () => restoreStashEntry(entryId, { preferMemorySnapshot: true }),
        },
        data: { hideCopyButton: true },
      });

      if (!write.durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory for this page session only.",
          data: { hideCopyButton: true },
        });
      }
      if (write.evicted) {
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${PROMPT_STASH_MAX_ENTRIES} prompts; the oldest was removed.`,
          data: { hideCopyButton: true },
        });
      }

      void (async () => {
        const encodedImages = await Promise.all(
          images.map(async (image) => {
            if (image.type === "file") {
              const status = fileUploadRecords.get(image.id)?.status;
              if (status?.kind === "uploaded") {
                return {
                  attachment: {
                    type: "file",
                    id: image.id,
                    name: image.name,
                    mimeType: image.mimeType,
                    sizeBytes: image.sizeBytes,
                    uploadToken: status.uploadToken,
                    expiresAt: status.expiresAt,
                  } satisfies PersistedComposerImageAttachment,
                  unreadableName: null,
                };
              }
            }
            try {
              return {
                attachment: {
                  type: image.type,
                  id: image.id,
                  name: image.name,
                  mimeType: image.mimeType,
                  sizeBytes: image.sizeBytes,
                  dataUrl: encodeComposerAttachmentDataUrl(await webAttachmentCodec.encode(image)),
                } satisfies PersistedComposerImageAttachment,
                unreadableName: null,
              };
            } catch {
              return { attachment: null, unreadableName: image.name };
            }
          }),
        );
        const attachments = encodedImages.flatMap((result) =>
          result.attachment ? [result.attachment] : [],
        );
        const unreadableImageNames = encodedImages.flatMap((result) =>
          result.unreadableName ? [result.unreadableName] : [],
        );
        const finalized = finalizeStashEntryImages(entryId, {
          attachments,
          droppedImageNames: [],
          unreadableImageNames,
        });
        if (!finalized.attached) {
          if (write.durable && !finalized.written && images.length > 0) {
            toastManager.add({
              type: "warning",
              title: "Stashed images were not saved",
              description:
                "The prompt is still stashed, but browser storage rejected its image data.",
              data: { hideCopyButton: true },
            });
          }
          return;
        }

        const finalizedEntry = usePromptStashStore
          .getState()
          .entries.find((candidate) => candidate.id === entryId);
        const imageWarnings: string[] = [];
        if (finalizedEntry?.unreadableImageNames.length) {
          imageWarnings.push(
            `Could not read: ${formatStashImageNames(finalizedEntry.unreadableImageNames)}.`,
          );
        }
        if (finalizedEntry?.droppedImageNames.length) {
          imageWarnings.push(
            `Over the stash image budget: ${formatStashImageNames(finalizedEntry.droppedImageNames)}.`,
          );
        }
        if (imageWarnings.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Some images were not added to the stash",
            description: imageWarnings.join(" "),
            data: { hideCopyButton: true },
          });
        } else if (write.durable && !finalized.durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images will not survive a reload",
            description:
              "The prompt was saved, but browser storage rejected the later image update.",
            data: { hideCopyButton: true },
          });
        }
      })().finally(() => {
        releaseStashSnapshot(entryId);
      });
    }, [
      clearComposerDraftPromptAndImages,
      composerDraftTarget,
      composerImagesRef,
      fileUploadRecords,
      finalizeStashEntryImages,
      getComposerDraft,
      isComposerApprovalState,
      isMobileViewport,
      pendingUserInputs.length,
      promptRef,
      releaseStashSnapshot,
      restoreStashEntry,
      stashEntry,
    ]);

    stashCommandHandlerRef.current = stashCurrentPrompt;

    useLayoutEffect(() => {
      const handler = (event: globalThis.KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing) {
          return;
        }
        const isComposerTarget =
          composerFormRef.current !== null &&
          event.composedPath().includes(composerFormRef.current);
        const isDocumentRootTarget =
          event.target === window || event.target === document || event.target === document.body;
        if (
          !isComposerTarget &&
          !isDocumentRootTarget &&
          shouldIgnoreGlobalNavigationShortcut(event)
        ) {
          return;
        }
        const command = resolveShortcutCommand(event, keybindings, {
          context: {
            terminalFocus: isTerminalFocused(),
            terminalOpen,
            modelPickerOpen: isComposerModelPickerOpen,
            composerFocus: isComposerFocused,
          },
        });
        if (command !== "composer.stash") return;
        event.preventDefault();
        event.stopPropagation();
        stashCommandHandlerRef.current();
      };
      window.addEventListener("keydown", handler, true);
      return () => window.removeEventListener("keydown", handler, true);
    }, [isComposerFocused, isComposerModelPickerOpen, keybindings, terminalOpen]);

    useEffect(() => {
      setIsStashPickerOpen(false);
    }, [composerDraftTarget, isMobileViewport]);

    const handleInterruptPrimaryAction = useCallback(() => {
      void onInterrupt();
    }, [onInterrupt]);
    const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
      void onImplementPlanInNewThread();
    }, [onImplementPlanInNewThread]);
    const scheduleComposerCollapseCheck = useCallback(() => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      composerBlurFrameRef.current = window.requestAnimationFrame(() => {
        composerBlurFrameRef.current = null;
        const composerSurface = composerSurfaceRef.current;
        const activeElement = document.activeElement;
        if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
          return;
        }
        // Focus that landed on a control the composer does not own — the
        // thread dock, the approval panel, the pending-input panel — is not
        // composer focus, even though those controls are descendants of the
        // surface. Without the exclusion, focusing the dock's workspace toggle
        // blurs the editor (the software keyboard leaves) while the composer
        // keeps its full expanded height, because nothing ever moves focus back
        // out of the surface. Controls that open a sheet self-correct, since
        // the portal takes focus outside the surface; the plain toggle does not.
        if (
          composerSurface &&
          activeElement instanceof Element &&
          composerSurface.contains(activeElement) &&
          activeElement.closest('[data-chat-composer-collapsed-controls="true"]') === null
        ) {
          return;
        }
        setIsComposerFocused(false);
      });
    }, []);

    useEffect(() => {
      return () => {
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
        }
      };
    }, []);

    // ------------------------------------------------------------------
    // Imperative handle
    // ------------------------------------------------------------------
    useImperativeHandle(
      ref,
      () => ({
        collapseForReading: () => {
          if (
            !isMobileViewport &&
            !isInsideComposerFloatingLayer(document.activeElement ?? document.body)
          ) {
            setIsReadingChat(true);
            setIsComposerHovered(false);
          }
        },
        focusAtEnd: () => {
          setIsReadingChat(false);
          composerEditorRef.current?.focusAtEnd();
        },
        focusAt: (cursor: number) => {
          setIsReadingChat(false);
          composerEditorRef.current?.focusAt(cursor);
        },
        openModelPicker: () => {
          setIsComposerModelPickerOpen(true);
        },
        toggleModelPicker: () => {
          setIsComposerModelPickerOpen((open) => !open);
        },
        isModelPickerOpen: () => isComposerModelPickerOpen,
        readSnapshot: () => {
          return readComposerSnapshot();
        },
        resetCursorState: (options?: {
          cursor?: number;
          prompt?: string;
          detectTrigger?: boolean;
        }) => {
          const promptForState = options?.prompt ?? promptRef.current;
          const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
          setComposerHighlightedItemId(null);
          setComposerCursor(cursor);
          setComposerTrigger(
            options?.detectTrigger
              ? detectComposerTrigger(
                  promptForState,
                  expandCollapsedComposerCursor(promptForState, cursor),
                )
              : null,
          );
        },
        addTerminalContext: (selection: TerminalContextSelection) => {
          if (!activeThreadId) return;
          const snapshot = composerEditorRef.current?.readSnapshot() ?? {
            value: promptRef.current,
            cursor: composerCursor,
            expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
            terminalContextIds: composerTerminalContexts.map((context) => context.id),
          };
          const insertion = insertInlineTerminalContextPlaceholder(
            snapshot.value,
            snapshot.expandedCursor,
          );
          const nextCollapsedCursor = collapseExpandedComposerCursor(
            insertion.prompt,
            insertion.cursor,
          );
          const inserted = insertComposerDraftTerminalContext(
            composerDraftTarget,
            insertion.prompt,
            {
              id: randomUUID(),
              threadId: activeThreadId,
              createdAt: new Date().toISOString(),
              ...selection,
            },
            insertion.contextIndex,
          );
          if (!inserted) return;
          promptRef.current = insertion.prompt;
          setComposerCursor(nextCollapsedCursor);
          setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCollapsedCursor);
          });
        },
        insertTriggerAtCursor: (text: string) => {
          if (isMobileViewport) {
            setIsComposerFocused(true);
          }
          const snapshot = composerEditorRef.current?.readSnapshot() ?? {
            value: promptRef.current,
            cursor: composerCursor,
            expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
            terminalContextIds: composerTerminalContexts.map((context) => context.id),
          };
          const { text: nextPrompt, cursor: nextExpandedCursor } = replaceTextRange(
            snapshot.value,
            snapshot.expandedCursor,
            snapshot.expandedCursor,
            text,
          );
          const nextCollapsedCursor = collapseExpandedComposerCursor(
            nextPrompt,
            nextExpandedCursor,
          );
          promptRef.current = nextPrompt;
          setComposerDraftPrompt(composerDraftTarget, nextPrompt);
          setComposerCursor(nextCollapsedCursor);
          setComposerTrigger(detectComposerTrigger(nextPrompt, nextExpandedCursor));
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCollapsedCursor);
          });
        },
        getSendContext: () => ({
          prompt: promptRef.current,
          images: composerImagesRef.current,
          terminalContexts: composerTerminalContextsRef.current,
          sourceControlContexts: composerSourceControlContexts,
          selectedPromptEffort,
          selectedModelOptionsForDispatch,
          selectedModelSelection,
          selectedProvider,
          selectedModel,
          selectedProviderModels,
        }),
      }),
      [
        activeThreadId,
        composerDraftTarget,
        composerCursor,
        composerSourceControlContexts,
        composerTerminalContexts,
        insertComposerDraftTerminalContext,
        isMobileViewport,
        promptRef,
        composerImagesRef,
        composerTerminalContextsRef,
        isComposerModelPickerOpen,
        readComposerSnapshot,
        selectedModel,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        selectedPromptEffort,
        selectedProvider,
        selectedProviderModels,
        setComposerDraftPrompt,
      ],
    );

    const isComposerCompact =
      !isMobileViewport &&
      activeThreadStarted &&
      (isReadingChat || (!isComposerFocused && !isComposerHovered)) &&
      !isComposerModelPickerOpen &&
      !composerMenuOpen &&
      !isDragOverComposer;

    // Render
    // ------------------------------------------------------------------
    return (
      <form
        ref={composerFormRef}
        onSubmit={submitComposer}
        className="relative mx-auto w-full min-w-0 max-w-208"
        data-chat-composer-form="true"
      >
        <input
          ref={reattachFileInputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={handleReattachFileChange}
        />
        {pendingContextHandoff ? (
          <div
            className={cn(
              "mb-2 flex min-w-0 items-center px-4",
              stashEntries.length > 0 && "pr-24",
            )}
          >
            <PendingContextHandoffChip
              source={pendingContextHandoff.source}
              target={pendingContextHandoff.target}
            />
          </div>
        ) : null}
        {!isMobileViewport ? (
          <>
            <ComposerStashBadge
              count={stashEntries.length}
              open={isStashPickerOpen}
              onToggle={() => setIsStashPickerOpen((open) => !open)}
            />
            {isStashPickerOpen ? (
              <ComposerStashPicker
                entries={stashEntries}
                onRestore={(id) => restoreStashEntry(id)}
                onDelete={deleteStashEntry}
                onClose={() => setIsStashPickerOpen(false)}
              />
            ) : null}
          </>
        ) : null}
        <div
          className={cn(
            "group rounded-3xl p-px transition-colors duration-200",
            composerProviderState.composerFrameClassName,
          )}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          <div
            ref={composerSurfaceRef}
            data-chat-composer-compact={!isMobileViewport ? String(isComposerCompact) : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") {
                setIsComposerHovered(true);
                setIsReadingChat(false);
              }
            }}
            onPointerLeave={() => setIsComposerHovered(false)}
            onPointerDownCapture={() => setIsReadingChat(false)}
            onKeyDownCapture={() => setIsReadingChat(false)}
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className={cn(
              // The fill never changes on hover or focus. This is a persistent
              // surface the pointer crosses on its way to the transcript and
              // clicks into constantly, so re-tinting it read as a flicker
              // rather than an affordance. Focus still lifts the shadow — the
              // one state worth signalling — and a drag-over still tints,
              // because that one has to read as a drop target.
              "rounded-[max(0px,calc(var(--radius-3xl)-2px))] border-0 bg-[color-mix(in_srgb,var(--card)_var(--app-composer-alpha),transparent)] dark:bg-[color-mix(in_srgb,var(--card)_var(--app-composer-dark-alpha),transparent)] [-webkit-backdrop-filter:var(--app-composer-filter)] [backdrop-filter:var(--app-composer-filter)] shadow-[0_6px_18px_rgba(0,0,0,0.06),0_1px_3px_rgba(0,0,0,0.05)] outline-none transition-[background-color,box-shadow] duration-200 has-focus-visible:shadow-[0_8px_24px_rgba(0,0,0,0.09),0_1px_4px_rgba(0,0,0,0.07)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_rgba(0,0,0,0.4),0_1px_3px_rgba(0,0,0,0.35)] dark:has-focus-visible:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_12px_32px_rgba(0,0,0,0.5),0_1px_4px_rgba(0,0,0,0.4)]",
              isDragOverComposer
                ? "bg-accent/30 shadow-lg/12 ring-1 ring-inset ring-primary/45 [--lg-plate-alpha:72%] [--lg-plate-color:color-mix(in_srgb,var(--accent)_38%,var(--card))]"
                : null,
              environmentUnavailable ? "opacity-75" : null,
              composerProviderState.composerSurfaceClassName,
            )}
            onFocusCapture={(event) => {
              const activeElement = event.target;
              // Still required after the collapsed pills were removed: the
              // container also holds the approval actions, the pending
              // user-input panel, and the thread dock. Focusing one of those is
              // an answer to that panel or an action on the thread, not a
              // request to open the composer, so it must not expand the
              // composer under the user's finger — and, when the composer is
              // already expanded, must not cancel the pending collapse check
              // either, or the editor blurs (the software keyboard leaves)
              // while the composer keeps its full expanded height. Focus
              // reaching the editor itself is outside this container and does
              // expand. Unconditional on the collapsed state: the approval and
              // pending-input panels only carry the marker while collapsed, so
              // this widens nothing but the dock.
              if (
                activeElement instanceof HTMLElement &&
                activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
              ) {
                return;
              }
              if (composerBlurFrameRef.current !== null) {
                window.cancelAnimationFrame(composerBlurFrameRef.current);
                composerBlurFrameRef.current = null;
              }
              setIsComposerFocused(true);
              setIsReadingChat(false);
            }}
            onBlurCapture={() => {
              scheduleComposerCollapseCheck();
            }}
            onClick={(event) => {
              // Normal case: the collapsed editor is the tap target and the
              // browser focuses it natively, which expands through
              // onFocusCapture. A disabled editor is `contenteditable="false"`
              // and cannot take focus, and the collapsed surface has no other
              // focusable node, so without this the composer would be an inert
              // line whenever the environment is connecting or unavailable.
              // Expanding here cannot reintroduce the deferred-focus defect: a
              // disabled editor raises no software keyboard either way.
              if (!isComposerCollapsedMobile || !isComposerEditorDisabled) {
                return;
              }
              const target = event.target;
              if (
                target instanceof HTMLElement &&
                target.closest('[data-chat-composer-collapsed-controls="true"]')
              ) {
                return;
              }
              setIsComposerFocused(true);
            }}
          >
            <ComposerLiquidGlass hostRef={composerSurfaceRef} />
            {!isComposerCollapsedMobile &&
              (activePendingApproval ? (
                <div className="rounded-t-[max(0px,calc(var(--radius-3xl)-3px))] border-b border-border/65 bg-muted/20">
                  <ApprovalCard
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div className="rounded-t-[max(0px,calc(var(--radius-3xl)-3px))] border-b border-border/65 bg-muted/20">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    respondingRequestIds={respondingRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                  />
                </div>
              ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                <div className="rounded-t-[max(0px,calc(var(--radius-3xl)-3px))] border-b border-border/65 bg-muted/20">
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                </div>
              ) : showGoalHeader && activeThreadGoal ? (
                <ComposerGoalHeader
                  goal={activeThreadGoal}
                  isRunning={phase === "running"}
                  onBudgetChange={onGoalBudgetChange}
                  onRetry={onRetryGoal}
                  onEdit={onEditGoal}
                  onStatusChange={onGoalStatusChange}
                  onClear={onClearGoal}
                />
              ) : null)}

            {isComposerCollapsedMobile && activePendingApproval ? (
              <div
                className="rounded-t-[max(0px,calc(var(--radius-3xl)-3px))] border-b border-border/65 bg-muted/20"
                data-chat-composer-collapsed-controls="true"
              >
                <ApprovalCard
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                />
              </div>
            ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
              <div
                className="rounded-t-[max(0px,calc(var(--radius-3xl)-3px))] border-b border-border/65 bg-muted/20"
                data-chat-composer-collapsed-controls="true"
              >
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
                {activePendingProgress?.activeQuestion?.multiSelect ? (
                  <div className="px-3 pb-3 sm:px-4">
                    <div
                      data-chat-composer-mobile-pending-compact="true"
                      className="flex min-w-0 items-center justify-end gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5"
                    >
                      <ComposerPrimaryActions
                        compact
                        pendingAction={pendingPrimaryAction}
                        isRunning={false}
                        showPlanFollowUpPrompt={false}
                        promptHasText={false}
                        isSendBusy={isSendBusy}
                        isConnecting={isConnecting}
                        isEnvironmentUnavailable={environmentUnavailable !== null}
                        isPreparingWorktree={false}
                        hasSendableContent={false}
                        preserveComposerFocusOnPointerDown
                        onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                        onInterrupt={handleInterruptPrimaryAction}
                        onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* The thread dock: the workspace toggle and the thread-actions
                overflow that used to sit in the app bar's top-right corner,
                with the contextual strip between them. It renders here, below
                the approval and pending-input panels and above the prompt row,
                so an open panel grows the composer upward *past* the dock
                instead of carrying it out of the bottom third.

                It carries the collapsed-controls marker for the same reason
                the panels above it do: focusing or tapping a dock control is
                an action on the thread, not a request to open the composer,
                so it must neither expand the composer under the user's finger
                nor — since it is now a descendant of the composer surface —
                hold an expanded composer open after the editor has blurred.
                The dock is laid out in normal flow above the prompt row and
                never overlays the collapsed editor, so the editor still takes
                the activating tap natively. */}
            {phoneThreadDock ? (
              <div className="px-3 pt-2 sm:px-4" data-chat-composer-collapsed-controls="true">
                <PhoneThreadDock {...phoneThreadDock} />
              </div>
            ) : null}

            <ComposerPromptShell
              editorRef={composerEditorRef}
              isComposerCollapsedMobile={isComposerCollapsedMobile}
              hasComposerHeader={hasComposerHeader}
              isComposerApprovalState={isComposerApprovalState}
              resolvedTheme={resolvedTheme}
              composerMenuOpen={composerMenuOpen}
              composerMenuItems={composerMenuItems}
              isComposerMenuLoading={isComposerMenuLoading}
              composerTriggerKind={composerTriggerKind}
              composerTrigger={composerTrigger}
              composerMenuEmptyState={composerMenuEmptyState}
              activeComposerMenuItemId={activeComposerMenuItem?.id ?? null}
              onComposerMenuItemHighlighted={onComposerMenuItemHighlighted}
              onSelectComposerItem={onSelectComposerItem}
              composerSourceControlContexts={composerSourceControlContexts}
              onRemoveSourceControlContext={handleRemoveSourceControlContext}
              composerImages={composerImages}
              nonPersistedComposerImageIdSet={nonPersistedComposerImageIdSet}
              fileUploadRecords={fileUploadRecords}
              onExpandImage={onExpandImage}
              onRemoveImage={removeComposerImage}
              onRetryFileUpload={retryComposerFileUpload}
              onReattachFile={handleReattachFile}
              pendingUserInputCount={pendingUserInputs.length}
              prompt={prompt}
              composerCursor={composerCursor}
              composerTerminalContexts={composerTerminalContexts}
              skills={selectedProviderStatus?.skills ?? []}
              showMobilePendingAnswerActions={showMobilePendingAnswerActions}
              onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
              onPromptChange={onPromptChange}
              onComposerCommandKey={onComposerCommandKey}
              onComposerPaste={onComposerPaste}
              activePendingProgress={activePendingProgress}
              showPlanFollowUpPrompt={showPlanFollowUpPrompt}
              activeProposedPlan={activeProposedPlan}
              environmentUnavailable={environmentUnavailable}
              phase={phase}
              isConnecting={isConnecting}
              isEditorDisabled={isComposerEditorDisabled}
              showCollapsedSendAction={showCollapsedMobileSendAction}
              collapsedSendActionLabel={collapsedComposerPrimaryActionLabel}
              collapsedSendActionDisabled={collapsedComposerPrimaryActionDisabled}
              onCollapsedSend={submitComposer}
              isSendBusy={isSendBusy}
              pendingPrimaryAction={pendingPrimaryAction}
              onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
              onInterrupt={handleInterruptPrimaryAction}
              onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
            />

            {/* Bottom toolbar. During a pending approval the approval card
                above the editor carries the single action set, so the footer
                stays hidden exactly as before. */}
            {isComposerCollapsedMobile ? null : activePendingApproval ? null : (
              <ComposerFooter
                isFooterCompact={isComposerFooterCompact}
                isPrimaryActionsCompact={isComposerPrimaryActionsCompact}
                isMobileViewport={isMobileViewport}
                hideOnMobilePendingAnswers={showMobilePendingAnswerActions}
                environmentId={environmentId}
                gitCwd={gitCwd}
                hasSourceControlRemote={hasSourceControlRemote}
                onSelectIssue={handleSelectIssue}
                onSelectChangeRequest={handleSelectChangeRequest}
                onAttachFile={(file) => {
                  void addComposerAttachments([file]);
                }}
                executionTargets={props.executionTargets}
                selectedExecutionEnvironmentId={environmentId}
                executionTargetLocked={props.executionTargetLocked}
                onExecutionTargetChange={props.onExecutionTargetChange}
                selectedInstanceId={selectedInstanceId}
                selectedModel={selectedModelForPickerWithCustomFallback}
                lockedProvider={lockedProvider}
                lockedContinuationGroupKey={lockedContinuationGroupKey}
                providerInstanceEntries={providerInstanceEntries}
                keybindings={keybindings}
                modelOptionsByInstance={modelOptionsByInstance}
                terminalOpen={terminalOpen}
                isModelPickerOpen={isComposerModelPickerOpen}
                {...(composerProviderState.modelPickerIconClassName
                  ? { modelPickerIconClassName: composerProviderState.modelPickerIconClassName }
                  : {})}
                onModelPickerOpenChange={setIsComposerModelPickerOpen}
                onProviderModelSelect={onProviderModelSelect}
                showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                askModeSupported={composerProviderControls.askModeSupported}
                showPlanSidebarToggle={showPlanSidebarToggle}
                interactionMode={interactionMode}
                runtimeMode={runtimeMode}
                tokenMode={tokenMode}
                planSidebarLabel={planSidebarLabel}
                planSidebarOpen={planSidebarOpen}
                providerTraitsMenuContent={providerTraitsMenuContent}
                providerTraitsChips={providerTraitsChips}
                onInteractionModeChange={handleInteractionModeChange}
                onTogglePlanSidebar={togglePlanSidebar}
                onRuntimeModeChange={handleRuntimeModeChange}
                onTokenModeChange={handleTokenModeChange}
                contextWindowUsage={contextWindowUsage}
                contextWindowRateLimits={contextWindowRateLimits}
                pendingAction={pendingPrimaryAction}
                isRunning={phase === "running"}
                showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                promptHasText={prompt.trim().length > 0}
                isSendBusy={isSendBusy}
                isConnecting={isConnecting}
                isEnvironmentUnavailable={environmentUnavailable !== null}
                isPreparingWorktree={isPreparingWorktree}
                hasSendableContent={composerHasSendableContent}
                sendDisabledReason={composerSendBlockedReason}
                onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                onInterrupt={handleInterruptPrimaryAction}
                onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
              />
            )}
          </div>
        </div>
      </form>
    );
  }),
);
