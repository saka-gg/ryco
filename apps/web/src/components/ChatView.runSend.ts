/**
 * ChatView's submit: everything the composer's Send (or Enter) does with what
 * is in the composer. Side questions, goal commands, plan follow-ups, slash
 * commands, queue edits, queued and steered follow-ups, held sends, and the
 * direct send through `dispatchComposerSnapshot`. Moved out of ChatView as is:
 * it reads the values of the render that called it and the same refs at the
 * same moments as before.
 */
import type {
  AgentTokenMode,
  CommandId,
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
  ThreadGoalUpdate,
  ThreadId,
} from "@ryco/contracts";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import type { HostedRpcCapability } from "@ryco/client-runtime/authorization/capabilities";
import type { WsConnectionStatus } from "@ryco/client-runtime/rpc";
import type { PendingUserInputProgress } from "@ryco/client-runtime/state/user-input";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  parseStandaloneComposerSlashCommand,
  parseThreadGoalSlashCommand,
} from "../composer-logic";
import { noteComputerSetupMissingOnce } from "../computerUse/computerSetupNotice";
import {
  computerUseSendBlocker,
  isExternalOpenCodeInstance,
  resolveComputerSendIntent,
} from "../computerUse/computerUseSend.logic";
import { readEnvironmentApi } from "../environmentApi";
import { readEnvironmentConnection } from "../environments/runtime";
import { holdSendForUploads } from "../heldSends";
import { formatOutgoingPrompt } from "../hooks/chatSendShared";
import {
  clearComposerContentRefs,
  restoreUnsentComposerContent,
  type SendTurnComposerSnapshot,
  type SendTurnSettings,
} from "../hooks/executeChatSendTurn";
import { type QueuedMessage, summarizeQueuedMessage } from "../messageQueue.logic";
import {
  buildWebFollowUpContent,
  countPendingFollowUpAdds,
  hasOutstandingQueuedDispatch,
  isWebFollowUpMovable,
  queueFollowUpOnServer,
} from "../messageQueueDrain";
import { useMessageQueueStore } from "../messageQueueStore";
import { resolvePlanFollowUpSubmission } from "../proposedPlan";
import { useSideChatStore } from "../sideChatStore";
import { useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { readComposerDraftContent } from "./ChatView.composerDraft";
import {
  buildExpiredTerminalContextToastCopy,
  cloneComposerImageForRetry,
  deriveComposerSendState,
} from "./ChatView.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  type ApprovalRedirect,
  type ApprovalRedirectRefusal,
  approvalRedirectTooSoon,
  composeOutgoingPrompt,
  declineApprovalsForRedirect,
  noteApprovalRedirectEnd,
  outgoingPromptOverflow,
  pendingApprovalSourceFromStore,
  resolveApprovalRedirect,
} from "@ryco/client-runtime/state/composer";
import {
  buildFollowUpQueueEditCommand,
  buildFollowUpQueueSteerCommand,
  followUpSendWaitsForServerQueue,
  queueHasUploadHeldSend,
  resolveComposerFollowUpAction,
  selectServerFollowUpQueueWaiting,
  shouldQueueFollowUpOnServer,
} from "@ryco/client-runtime/state/message-queue";
import { parseSideQuestionCommand } from "@ryco/client-runtime/state/side-chat";
import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  THREAD_GOAL_OBJECTIVE_MAX_CHARS,
} from "@ryco/contracts";
import { parseComputerInvocation } from "@ryco/shared/computerInvocation";
import { hasRetiredProjectMemory } from "@ryco/shared/retiredFeatures";
import { deriveComposerFileUploadSendState } from "~/composerFileUpload";
import { errorMessage } from "~/lib/errorMessage";
import { newMessageId, randomUUID } from "~/lib/utils";
import type {
  ComposerDraftStoreState,
  ComposerImageAttachment,
  DraftId,
} from "../composerDraftStore";
import type { useChatSessionActions } from "../hooks/useChatSessionActions";
import type { useHostedDraftExecutionTarget } from "../hooks/useHostedDraftExecutionTarget";
import type { ComposerReferenceDraft, TerminalContextDraft } from "../lib/terminalContext";
import type { PresentationTier } from "../lib/presentationTier";
import type { LatestProposedPlanState, PendingApproval, PendingUserInput } from "../session-logic";
import type { SessionPhase, Thread } from "../types";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import type { createThreadSendFlags } from "./ChatView.logic";
import type {
  ApprovalRedirectedTurns,
  ApprovalSightings,
} from "@ryco/client-runtime/state/composer";
import type {
  FollowUpQueueCommand,
  FollowUpQueueEdit,
  QueuedMessageSteerEligibility,
} from "@ryco/client-runtime/state/message-queue";
import type { MessageId } from "@ryco/contracts";

type ChatSessionActions = ReturnType<typeof useChatSessionActions>;
type ThreadSendFlags = ReturnType<typeof createThreadSendFlags>;

/** ChatView's direct send of a composer snapshot (see `dispatchComposerSnapshot`). */
export type DispatchComposerSnapshot = (
  composerSnapshot: SendTurnComposerSnapshot,
  settingsSnapshot: SendTurnSettings,
  messageId?: MessageId,
  hooks?: {
    readonly onBeforeTurnStart?: () => void;
    readonly onSendError?: (error: unknown) => void;
  },
) => Promise<boolean>;

/** What `runSend` reads from the ChatView render that called it. */
export interface RunSendInput {
  readonly environmentId: EnvironmentId;
  readonly dispatchCapability: HostedRpcCapability;
  readonly sideChatCapability: HostedRpcCapability;
  readonly dispatchEstablishing: boolean;
  readonly mutationUnavailableReason: string | null;
  readonly routeThreadKey: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly serverThread: Thread | undefined;
  readonly settings: UnifiedSettings;
  readonly setComposerDraftPrompt: ComposerDraftStoreState["setPrompt"];
  readonly addComposerDraftImages: ComposerDraftStoreState["addImages"];
  readonly setComposerDraftTerminalContexts: ComposerDraftStoreState["setTerminalContexts"];
  readonly setComposerDraftFileReferences: ComposerDraftStoreState["setFileReferences"];
  readonly setComposerDraftTokenMode: ComposerDraftStoreState["setTokenMode"];
  readonly clearComposerDraftContent: ComposerDraftStoreState["clearComposerContent"];
  readonly promptRef: RefObject<string>;
  readonly composerImagesRef: RefObject<ComposerImageAttachment[]>;
  readonly composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  readonly composerFileReferencesRef: RefObject<ComposerReferenceDraft[]>;
  readonly readComposer: () => ChatComposerHandle | null;
  readonly isConnecting: boolean;
  readonly presentationTier: PresentationTier;
  readonly threadSendsInFlight: ThreadSendFlags;
  readonly bindToShownThread: () => () => boolean;
  readonly threadSendsPreparing: ThreadSendFlags;
  readonly isServerThread: boolean;
  readonly activeThread: Thread | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode: AgentTokenMode;
  readonly submitApprovalDecision: ChatSessionActions["submitApprovalDecision"];
  readonly respondingRequestIds: ChatSessionActions["respondingRequestIds"];
  readonly notifyMutationUnavailable: (reason: string) => void;
  readonly notifyApprovalRedirectRefused: (refusal: ApprovalRedirectRefusal) => void;
  readonly approvalRedirectedTurns: ApprovalRedirectedTurns;
  readonly setApprovalRedirectedTurns: Dispatch<SetStateAction<ApprovalRedirectedTurns>>;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly activeEnvironmentShellLive: boolean;
  readonly enqueueMessage: (threadKey: string, message: QueuedMessage) => void;
  readonly serverFollowUpQueueSupported: boolean;
  readonly setServerQueueEdit: Dispatch<SetStateAction<FollowUpQueueEdit | null>>;
  readonly setSavingServerQueueEdit: Dispatch<SetStateAction<FollowUpQueueEdit | null>>;
  readonly activeServerQueueEdit: FollowUpQueueEdit | null;
  readonly runServerQueueCommand: (
    failureTitle: string,
    build: (base: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly createdAt: string;
    }) => FollowUpQueueCommand | null,
  ) => Promise<boolean>;
  readonly isLocalComputerEnvironment: (environmentId: EnvironmentId | null | undefined) => boolean;
  readonly sideChatConnection: WsConnectionStatus;
  readonly activeEnvironmentUnavailable: boolean;
  readonly phase: SessionPhase;
  readonly pendingApprovals: PendingApproval[];
  readonly pendingUserInputs: PendingUserInput[];
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly onAdvanceActivePendingUserInput: () => void;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly showPlanFollowUpPrompt: boolean;
  readonly approvalSightingsRef: RefObject<ApprovalSightings>;
  readonly isSendBusy: boolean;
  readonly hostedDraftTarget: ReturnType<typeof useHostedDraftExecutionTarget>;
  readonly handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly startGoalTurnRef: RefObject<
    (goal: NonNullable<SendTurnComposerSnapshot["goal"]>) => Promise<boolean>
  >;
  readonly dispatchThreadGoalUpdate: (
    update: ThreadGoalUpdate & { readonly startTurn?: boolean },
  ) => Promise<boolean>;
  readonly handleClearGoal: () => Promise<boolean | undefined>;
  readonly canSendModelSelection: (targetSelection: ModelSelection) => boolean;
  readonly notifySelectionBecameIneligible: () => void;
  readonly captureComposerContentGuard: () => () => boolean;
  readonly drainEditorsBeforeSend: () => Promise<boolean>;
  readonly getSteerEligibility: (snapshot: {
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly tokenMode: AgentTokenMode | undefined;
  }) => QueuedMessageSteerEligibility;
  readonly getQueuedSteerEligibility: (message: QueuedMessage) => QueuedMessageSteerEligibility;
  readonly steerQueuedEntry: (
    message: QueuedMessage,
    options: { readonly explicit: boolean; readonly prepareEditors: boolean },
  ) => Promise<void>;
  readonly dispatchComposerSnapshotRef: RefObject<DispatchComposerSnapshot>;
  readonly onSubmitPlanFollowUp: (input: {
    text: string;
    interactionMode: ProviderInteractionMode;
  }) => Promise<boolean>;
}

export async function runSend(
  input: RunSendInput,
  e?: { preventDefault: () => void },
  options?: { readonly invertFollowUp?: boolean },
): Promise<void> {
  const {
    environmentId,
    dispatchCapability,
    sideChatCapability,
    dispatchEstablishing,
    mutationUnavailableReason,
    routeThreadKey,
    composerDraftTarget,
    serverThread,
    settings,
    setComposerDraftPrompt,
    addComposerDraftImages,
    setComposerDraftTerminalContexts,
    setComposerDraftFileReferences,
    setComposerDraftTokenMode,
    clearComposerDraftContent,
    promptRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerFileReferencesRef,
    readComposer,
    isConnecting,
    presentationTier,
    threadSendsInFlight,
    bindToShownThread,
    threadSendsPreparing,
    isServerThread,
    activeThread,
    runtimeMode,
    interactionMode,
    tokenMode,
    submitApprovalDecision,
    respondingRequestIds,
    notifyMutationUnavailable,
    notifyApprovalRedirectRefused,
    approvalRedirectedTurns,
    setApprovalRedirectedTurns,
    activeThreadRef,
    activeThreadKey,
    activeEnvironmentShellLive,
    enqueueMessage,
    serverFollowUpQueueSupported,
    setServerQueueEdit,
    setSavingServerQueueEdit,
    activeServerQueueEdit,
    runServerQueueCommand,
    isLocalComputerEnvironment,
    sideChatConnection,
    activeEnvironmentUnavailable,
    phase,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    onAdvanceActivePendingUserInput,
    activeProposedPlan,
    showPlanFollowUpPrompt,
    approvalSightingsRef,
    isSendBusy,
    hostedDraftTarget,
    handleInteractionModeChange,
    startGoalTurnRef,
    dispatchThreadGoalUpdate,
    handleClearGoal,
    canSendModelSelection,
    notifySelectionBecameIneligible,
    captureComposerContentGuard,
    drainEditorsBeforeSend,
    getSteerEligibility,
    getQueuedSteerEligibility,
    steerQueuedEntry,
    dispatchComposerSnapshotRef,
    onSubmitPlanFollowUp,
  } = input;
  e?.preventDefault();
  // The approvals on screen when the user sent: a redirecting send declines only those.
  const approvalsAtSend = pendingApprovals;
  if ((!dispatchCapability.allowed && !dispatchEstablishing) || hostedDraftTarget.pending !== null)
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
        sideContext.fileReferences.length > 0 ||
        sideContext.sourceControlContexts.length > 0)
    ) {
      toastManager.add({
        type: "info",
        title: "Side questions accept text only",
        description:
          "Remove attached images, terminal selections, file references, page elements, and source-control references before using /btw.",
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
    const sideApi = readEnvironmentConnection(activeThreadRef.environmentId)?.client.textGeneration;
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
    fileReferences: composerFileReferences,
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
    fileReferences: composerFileReferences,
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
  // Quote chips send their quote and comment, and the effort may add a
  // prefix: measure what goes out, so a send the provider would refuse
  // stays in the composer instead.
  const overflow = outgoingPromptOverflow({
    prompt: promptForSend,
    fileReferences: composerFileReferences,
    terminalContexts: sendableComposerTerminalContexts,
    format: (text) =>
      formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text,
      }),
  });
  if (overflow > 0) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Message is too long",
        description: `It is ${overflow.toLocaleString()} characters over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString()} character limit. Shorten it or remove a quote.`,
      }),
    );
    return;
  }
  if (showPlanFollowUpPrompt && activeProposedPlan && !parseComputerInvocation(promptForSend)) {
    if (reachNodeUnavailableReason !== null) {
      notifyMutationUnavailable(reachNodeUnavailableReason);
      return;
    }
    // File references are feedback on the plan: they refine it, and go with the text.
    const followUp = resolvePlanFollowUpSubmission({
      draftText: composeOutgoingPrompt({
        prompt: trimmed,
        fileReferences: composerFileReferences,
      }),
      planMarkdown: activeProposedPlan.planMarkdown,
    });
    const refs = {
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerFileReferencesRef,
    };
    // Bound before the send: the restore below belongs to the thread shown now.
    const showsSendThread = bindToShownThread();
    clearComposerContentRefs(refs);
    clearComposerDraftContent(composerDraftTarget);
    setComposerDraftTokenMode(composerDraftTarget, tokenMode);
    readComposer()?.resetCursorState();
    const sent = await onSubmitPlanFollowUp({
      text: followUp.text,
      interactionMode: followUp.interactionMode,
    });
    // A refinement that did not go out comes back, chips included, as a failed send does.
    if (!sent) {
      restoreUnsentComposerContent({
        refs,
        composerHandle: { readComposer, showsSendThread },
        draft: {
          composerDraftTarget,
          setComposerDraftPrompt,
          addComposerDraftImages,
          setComposerDraftTerminalContexts,
          setComposerDraftFileReferences,
          readComposerDraftContent,
        },
        prompt: promptForSend,
        images: composerImages,
        terminalContexts: composerTerminalContexts,
        fileReferences: composerFileReferences,
      });
    }
    return;
  }
  const standaloneSlashCommand =
    composerImages.length === 0 &&
    sendableComposerTerminalContexts.length === 0 &&
    composerFileReferences.length === 0
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
      const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "empty");
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
  const fileUploadSendState = deriveComposerFileUploadSendState({
    attachments: composerImages,
    nowMs: Date.now(),
  });
  const notifyAttachmentsNotReady = (description: string) =>
    toastManager.add(
      stackedThreadToast({ type: "warning", title: "Attachments aren't ready", description }),
    );
  if (fileUploadSendState.kind === "blocked") {
    notifyAttachmentsNotReady(fileUploadSendState.reason);
    return;
  }
  // Only uploads still running: the message is accepted now and goes out once they finished
  // (`holdSendForUploads`), unless the path below cannot wait for them.
  const awaitingUploads =
    fileUploadSendState.kind === "uploading" ? fileUploadSendState.attachmentIds : null;
  const composerSnapshot: SendTurnComposerSnapshot = {
    prompt: promptForSend,
    trimmedPrompt: trimmed,
    images: composerImages,
    sendableTerminalContexts: sendableComposerTerminalContexts,
    fileReferences: composerFileReferences,
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
  const localComputer = computer && isLocalComputerEnvironment(activeThread.environmentId);
  if (computerInvocation && !localComputer) {
    toastManager.add({
      type: "warning",
      title: "Computer Use requires the local desktop environment",
    });
    return;
  }
  if (localComputer) {
    try {
      // On by default: every chat from this Mac may use the computer without the command,
      // and such a send never waits on Computer Use; `/computer-use` reports what blocks it.
      const resolution = await resolveComputerSendIntent({
        threadId: activeThread.id,
        explicit: computerInvocation !== null,
        computer,
        readBlocker: async () => {
          if (!api?.server)
            throw new Error(
              "Local desktop settings are unavailable. Reconnect before sending this task.",
            );
          const settings = await api.server.getSettings();
          return computerUseSendBlocker({
            provider: ctxSelectedProvider,
            agentControlEnabled: settings.agentControl.enabled,
            externalOpenCode: isExternalOpenCodeInstance(
              ctxSelectedProvider,
              settings.providerInstances[ctxSelectedModelSelection.instanceId]?.config ?? null,
            ),
          });
        },
      });
      // `/computer-use` may wait on setup: a draft edited meanwhile stays a draft. A default
      // send waited at most a moment and goes out as sent.
      if (resolution.prepared && promptRef.current !== promptForSend) return;
      if (resolution.setupMissing) noteComputerSetupMissingOnce();
      if (resolution.intent) settingsSnapshot.computerUse = resolution.intent;
    } catch (error) {
      // A default send goes without Computer Use; only `/computer-use` waits on it.
      if (computerInvocation) {
        toastManager.add({
          type: "warning",
          title: "Computer Use setup",
          description: errorMessage(error, "Complete setup, then send again."),
        });
        return;
      }
    }
    // Another send of this thread may have started while this one waited.
    if (threadSendsInFlight.has(routeThreadKey)) return;
  }
  if (!canSendModelSelection(composerSnapshot.selectedModelSelection)) {
    notifySelectionBecameIneligible();
    return;
  }

  // Editing the node's queued entry: the send saves it in place, busy or not.
  if (activeServerQueueEdit !== null) {
    // The node stores the edit with its upload tokens: it waits for them, as before.
    if (fileUploadSendState.kind === "uploading") {
      notifyAttachmentsNotReady(fileUploadSendState.reason);
      return;
    }
    const edit = activeServerQueueEdit;
    const composerChangedDuringSave = captureComposerContentGuard();
    // Saving from here on: the attachments it keeps are fixed (no drop replaces the edit
    // mid-save), and the revision this save raises is not someone else's change.
    setSavingServerQueueEdit(edit);
    let content: Awaited<ReturnType<typeof buildWebFollowUpContent>>;
    try {
      content = await buildWebFollowUpContent(composerSnapshot, settingsSnapshot);
    } catch (error) {
      setSavingServerQueueEdit((current) => (current === edit ? null : current));
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save the queued message",
          description: errorMessage(error, "Try again."),
        }),
      );
      return;
    }
    const saved = await runServerQueueCommand("Could not save the queued message", (base) =>
      buildFollowUpQueueEditCommand({
        ...base,
        entry: { messageId: edit.messageId, revision: edit.revision },
        content,
        keptAttachmentIds: edit.keptAttachmentIds,
      }),
    );
    setSavingServerQueueEdit((current) => (current === edit ? null : current));
    if (!saved) return;
    setServerQueueEdit((current) => (current === edit ? null : current));
    if (!composerChangedDuringSave()) {
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      setComposerDraftTokenMode(composerDraftTarget, tokenMode);
      readComposer()?.resetCursorState();
    }
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
  // for a draft that is not open. So does a node about to send its own queue's
  // head (its dispatch leaves the session "ready" while it starts) or an add of
  // this tab still on its way: a turn start would jump ahead of them.
  // A message sent while its uploads ran waits in the queue until it went out; a later send
  // waits behind it rather than overtaking it.
  const heldSendAhead =
    activeThreadKey !== null &&
    queueHasUploadHeldSend(useMessageQueueStore.getState().queuesByThreadKey[activeThreadKey]);
  const sendQueuesBehindTurn =
    activeThreadKey !== null &&
    (phase === "running" ||
      hasOutstandingQueuedDispatch(activeThreadKey) ||
      sendWaitsForEnvironment ||
      followUpSendWaitsForServerQueue({
        serverQueueSupported: serverFollowUpQueueSupported && isServerThread,
        queueWaiting: selectServerFollowUpQueueWaiting(useStore.getState(), activeThreadRef),
        pendingAdds: countPendingFollowUpAdds(activeThreadKey),
      }));
  if (activeThreadKey && (sendQueuesBehindTurn || heldSendAhead)) {
    // Steer = enqueue, then start a steer attempt at once: every failure falls back to the
    // queue. The phone tier is frozen and always queues; slash input never steers.
    const invertFollowUp = options?.invertFollowUp === true;
    const activeTurnId = activeThread.session?.activeTurnId ?? null;
    const isSlashCommand = trimmed.startsWith("/");
    // The decision the composer showed (`resolveApprovalRedirect`), from the send's snapshot.
    const approvalRedirect = resolveApprovalRedirect({
      approvals: approvalsAtSend,
      runtimeSessionId: activeThread.session?.runtimeSessionId,
      activeTurnId,
      respondingRequestIds,
      steerAllowed:
        presentationTier !== "phone" &&
        !hasRetiredProjectMemory(composerSnapshot) &&
        getSteerEligibility({
          modelSelection: composerSnapshot.selectedModelSelection,
          runtimeMode: settingsSnapshot.runtimeMode,
          interactionMode: settingsSnapshot.interactionMode,
          tokenMode: settingsSnapshot.tokenMode,
        }).allowed,
      isSlashCommand,
      questionPending: pendingUserInputs.length > 0,
      redirectedTurnId: approvalRedirectedTurns.get(activeThreadKey) ?? null,
    });
    const followUpAction = resolveComposerFollowUpAction({
      turnRunning: phase === "running",
      // A redirect steers whatever the setting says; the alternate shortcut still queues and
      // leaves the approvals to be answered.
      followUpBehavior: approvalRedirect.kind === "none" ? settings.followUpBehavior : "steer",
      invert: invertFollowUp,
      surfaceAllowsSteer: presentationTier !== "phone",
      isSlashCommand,
    });
    const redirect: ApprovalRedirect =
      followUpAction === "steer" ? approvalRedirect : { kind: "none" };
    const refuseRedirect = (refusal: ApprovalRedirectRefusal) => {
      notifyApprovalRedirectRefused(refusal);
      setApprovalRedirectedTurns((turns) =>
        noteApprovalRedirectEnd(turns, activeThreadKey, redirect, refusal),
      );
    };
    const preparing = threadSendsPreparing.ref(routeThreadKey);
    if (preparing.current) return;
    // Declining cannot be undone: a redirect waits for its uploads before it declines.
    if (redirect.kind === "decline" && fileUploadSendState.kind === "uploading") {
      notifyAttachmentsNotReady(fileUploadSendState.reason);
      return;
    }
    if (
      redirect.kind === "decline" &&
      approvalRedirectTooSoon(redirect, approvalSightingsRef.current)
    ) {
      refuseRedirect({ kind: "just-arrived" });
      return;
    }
    preparing.current = true;
    const composerChangedDuringPreparation = captureComposerContentGuard();
    try {
      if (!(await drainEditorsBeforeSend())) return;
      if (redirect.kind === "decline" && activeThreadRef) {
        const outcome = await declineApprovalsForRedirect({
          redirect,
          decline: (approval) =>
            submitApprovalDecision(approval.requestId, "decline", approval.approvalIdentity),
          source: pendingApprovalSourceFromStore(
            useStore,
            (state) => createThreadSelectorByRef(activeThreadRef)(state)?.activities,
          ),
        });
        if (outcome.kind !== "declined") {
          refuseRedirect(outcome);
          return;
        }
        // What goes out must be what the user sent; an edit made meanwhile stays a draft.
        if (composerChangedDuringPreparation()) {
          refuseRedirect({ kind: "draft-changed", declined: outcome.declined });
          return;
        }
      }
    } finally {
      preparing.current = false;
    }
    // This send carries the redirect; later ones on the turn follow the setting again.
    setApprovalRedirectedTurns((turns) =>
      noteApprovalRedirectEnd(turns, activeThreadKey, redirect, null),
    );
    const queuedMessageId = newMessageId();
    const tabQueueEntry = (): QueuedMessage => ({
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
    // Uploads still running, or a held message ahead: it waits in this tab's queue, in its
    // place. An ordinary send behind a held one keeps showing as a send in the timeline.
    if (awaitingUploads !== null || heldSendAhead) {
      holdSendForUploads({
        threadKey: activeThreadKey,
        entry: tabQueueEntry(),
        awaiting: awaitingUploads ?? [],
        sentAs: !sendQueuesBehindTurn ? "send" : followUpAction === "steer" ? "steer" : "queue",
        draftTarget: composerDraftTarget,
      });
      if (!composerChangedDuringPreparation()) {
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        setComposerDraftTokenMode(composerDraftTarget, tokenMode);
        readComposer()?.resetCursorState();
      }
      return;
    }
    // The node keeps this thread's queue: the message is queued there. Not while this
    // tab still holds entries for it (they move first, in order), nor while the node is
    // not ready (this tab's queue holds it until it is, then moves it).
    if (
      shouldQueueFollowUpOnServer({
        serverQueueSupported: serverFollowUpQueueSupported,
        serverThread: isServerThread,
        mutationReady: !sendWaitsForEnvironment,
        deviceQueueLength:
          useMessageQueueStore.getState().queuesByThreadKey[activeThreadKey]?.length ?? 0,
        deviceDispatchPending: hasOutstandingQueuedDispatch(activeThreadKey),
        movable: isWebFollowUpMovable(composerSnapshot, settingsSnapshot),
      }) &&
      activeThreadRef !== null
    ) {
      const steerEligibility =
        followUpAction === "steer"
          ? getSteerEligibility({
              modelSelection: composerSnapshot.selectedModelSelection,
              runtimeMode: settingsSnapshot.runtimeMode,
              interactionMode: settingsSnapshot.interactionMode,
              tokenMode: settingsSnapshot.tokenMode,
            })
          : null;
      const restore = {
        prompt: composerSnapshot.promptForRestore ?? composerSnapshot.prompt,
        images: composerSnapshot.images.map(cloneComposerImageForRetry),
        terminalContexts: composerSnapshot.sendableTerminalContexts,
        fileReferences: composerSnapshot.fileReferences ?? [],
      };
      const showsSendThread = bindToShownThread();
      if (!composerChangedDuringPreparation()) {
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        setComposerDraftTokenMode(composerDraftTarget, tokenMode);
        readComposer()?.resetCursorState();
      }
      const giveBack = (error: unknown) => {
        restoreUnsentComposerContent({
          refs: {
            promptRef,
            composerImagesRef,
            composerTerminalContextsRef,
            composerFileReferencesRef,
          },
          composerHandle: { readComposer, showsSendThread },
          draft: {
            composerDraftTarget,
            setComposerDraftPrompt,
            addComposerDraftImages,
            setComposerDraftTerminalContexts,
            setComposerDraftFileReferences,
            readComposerDraftContent,
          },
          ...restore,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Not queued",
            description: errorMessage(error, "The node did not queue it."),
          }),
        );
      };
      let content: Awaited<ReturnType<typeof buildWebFollowUpContent>>;
      try {
        content = await buildWebFollowUpContent(composerSnapshot, settingsSnapshot);
      } catch (error) {
        giveBack(error);
        return;
      }
      const queued = await queueFollowUpOnServer({
        ref: activeThreadRef,
        messageId: queuedMessageId,
        content,
        summary: summarizeQueuedMessage({
          id: queuedMessageId,
          composer: composerSnapshot,
          settings: settingsSnapshot,
        }),
        // No answer: the node may have it. This tab keeps it under the same id and moves it.
        keepInTab: tabQueueEntry,
      });
      if (queued.kind === "refused") {
        giveBack(queued.error);
        return;
      }
      if (queued.kind === "queued" && steerEligibility?.allowed) {
        await runServerQueueCommand("Could not steer message", (base) =>
          buildFollowUpQueueSteerCommand({
            ...base,
            messageId: queuedMessageId,
            expectedTurnId: steerEligibility.expectedTurnId,
          }),
        );
      } else if (steerEligibility && !steerEligibility.allowed && invertFollowUp) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Queued instead",
            description: steerEligibility.reason,
          }),
        );
      }
      return;
    }
    const queuedEntry = tabQueueEntry();
    enqueueMessage(activeThreadKey, queuedEntry);
    if (followUpAction === "steer") {
      const eligibility = getQueuedSteerEligibility(queuedEntry);
      if (eligibility.allowed) {
        void steerQueuedEntry(queuedEntry, {
          explicit: invertFollowUp || redirect.kind !== "none",
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

  // An idle thread, uploads still running: the message shows as sent at once and its turn
  // starts once they finished, through the queue's drain and the same gate as this send.
  if (awaitingUploads !== null && activeThreadKey) {
    const composerChangedDuringPreparation = captureComposerContentGuard();
    if (!(await drainEditorsBeforeSend())) return;
    holdSendForUploads({
      threadKey: activeThreadKey,
      entry: {
        id: newMessageId(),
        createdAt: new Date().toISOString(),
        composer: {
          ...composerSnapshot,
          // Clearing the composer revokes its blob previews; the held copy keeps its own.
          images: composerSnapshot.images.map(cloneComposerImageForRetry),
        },
        settings: settingsSnapshot,
      },
      awaiting: awaitingUploads,
      sentAs: "send",
      draftTarget: composerDraftTarget,
    });
    if (!composerChangedDuringPreparation()) {
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      setComposerDraftTokenMode(composerDraftTarget, tokenMode);
      readComposer()?.resetCursorState();
    }
    return;
  }

  await dispatchComposerSnapshotRef.current(composerSnapshot, settingsSnapshot);
}
