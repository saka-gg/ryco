import type { ProviderOptionSelection } from "@ryco/contracts";
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
import type { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import {
  type ComposerReferenceDraft,
  type PromptHistoryMessage,
} from "@ryco/client-runtime/state/composer";
import type { ContextWindowCompactNow } from "./ContextWindowMeter";
import type { ComposerExecutionTarget } from "./ExecutionTarget.logic";
import { type ComposerImageAttachment, type DraftId } from "../../composerDraftStore";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../../lib/terminalContext";
import type { ModelPickMeta } from "./modelPickerTuningBridge";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import type { PhoneThreadDockProps } from "../shell/phone/PhoneThreadDock";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";

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
    fileReferences: ComposerReferenceDraft[];
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

/**
 * What suggests the user is about to write (the composer gained focus, or its
 * first keystroke), or no longer is (focus left the composer).
 */
export type ComposerIntent = "focus" | "type" | "blur";

export interface ChatComposerProps {
  /**
   * The user is about to write (focus, first keystroke): a cue to warm what the
   * send needs; `blur` withdraws a focus that did not stay.
   */
  onComposerIntent?: (intent: ComposerIntent) => void;
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
  /**
   * Set while the environment's connection is being established: a send is
   * still accepted and waits in the queue. The caption says when it goes out.
   */
  sendsQueueUntilReady?: string | null;
  /**
   * The send in progress cannot wait for running uploads (saving the node's queued message):
   * Send stays held back until they finished, as it always was.
   */
  sendCannotWaitForUploads?: boolean;
  /**
   * Why actions that must reach the node now (stop, answers, plan follow-ups,
   * draft-local controls gated like them) are unavailable, worded for this
   * environment; `null` when they are available.
   */
  mutationUnavailableReason?: string | null;
  isPreparingWorktree: boolean;
  /**
   * A first send's new worktree is being set up: the primary action is Stop
   * (it cancels the setup) instead of a busy send button.
   */
  isWorktreeSetupRunning?: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connectionState: "connecting" | "disconnected" | "error" | "switched-off";
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
  /**
   * The session's provider runtime and running turn, and the turn on which an earlier redirect
   * declined approvals without sending. With the approvals they decide what a send does
   * (`resolveApprovalRedirect`), so the placeholder and primary action match the send.
   */
  activeRuntimeSessionId: string | null;
  activeTurnId: TurnId | null;
  approvalRedirectedTurnId: string | null;

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
  activeThreadModelSelection: ModelSelection | null | undefined;
  /** The node has an enabled CLIProxyAPI hub that Claude instances may be routed through. */
  cliProxyHubsEnabled: boolean;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;
  /** The thread's latest turn; a completed one may carry the provider's predicted next prompt. */
  activeLatestTurn: Pick<NonNullable<Thread["latestTurn"]>, "turnId" | "state"> | null;
  /** Compact now in the context meter; absent when the thread's provider cannot compact on request. */
  compactNow?: ContextWindowCompactNow | undefined;

  /**
   * The phone thread dock, rendered inside the composer surface beneath the
   * approval and pending-input panels so an open panel cannot carry it out of
   * the bottom third. `null` on every other tier — the tier decision stays
   * with `ChatView`, and the dock itself remains props in / callbacks out.
   */
  phoneThreadDock: PhoneThreadDockProps | null;

  /**
   * The thread's delegation dock (its delegated threads and Agent Control),
   * docked at the top of the composer surface. `null` on the phone tier and
   * without a thread; serializable so `memo` holds, and the dock reads its own
   * state.
   */
  delegationDock: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;
  executionTargets: ReadonlyArray<ComposerExecutionTarget>;
  executionTargetLocked: boolean;
  onExecutionTargetChange: (environmentId: EnvironmentId) => void;
  /** The device is shown outside the composer (pill above, or label under), not in the footer. */
  executionTargetHoisted?: boolean;

  /**
   * The thread's messages as the timeline shows them, sends not yet confirmed included, for
   * ArrowUp prompt recall. Read on the keypress: the list changes with every streamed delta.
   */
  readPromptHistoryMessages: () => ReadonlyArray<PromptHistoryMessage>;

  // Refs the parent needs kept in sync
  promptRef: React.MutableRefObject<string>;
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;
  composerFileReferencesRef: React.MutableRefObject<ComposerReferenceDraft[]>;

  // Scroll
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  scheduleStickToBottom: () => void;

  // Follow-up while a turn runs (desktop and tablet; the frozen phone tier always queues)
  followUpSurfaceAllowsSteer: boolean;
  /** The running turn's provider steers by stopping the turn and sending the message next. */
  followUpSteerRestarts?: boolean;
  getFollowUpSteerUnavailableReason: (snapshot: {
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly tokenMode: AgentTokenMode;
  }) => string | null;

  // Callbacks
  onSend: (
    e?: { preventDefault: () => void },
    options?: { readonly invertFollowUp?: boolean },
  ) => void;
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

  onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection>,
    meta?: ModelPickMeta,
  ) => void;
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
