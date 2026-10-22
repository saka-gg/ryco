import { readEnvironmentConnection } from "../environments/runtime";
import { isHostedHubMode } from "../env";
import {
  hasRememberedProjectPreferences,
  readAndRememberProjectPreferences,
  readRememberedProjectPreferences,
} from "./newDraftDefaults";
import { readNodeConfig, resolveNodeConfigSource } from "./nodeConfigSource";
import { claudeCacheReviewPresentation } from "../components/chat/ClaudeCacheReview";
import type { ComputerTurnIntent } from "@ryco/contracts";
import type { ClaudeCacheReviewPresentation } from "@ryco/client-runtime/state/composer";
import { rejectRetiredProjectMemory } from "@ryco/shared/retiredFeatures";
import {
  type AgentTokenMode,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type EnvironmentId,
  type ModelSelection,
  type MessageId,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
  type ThreadGoalUpdate,
} from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  buildSendTurnBootstrap,
  composeOutgoingPrompt,
  type FileReferenceDraft,
  formatFileReferenceTitle,
  buildSendTurnDispatchAttachment,
  buildSendTurnUploadTokenDispatchAttachment,
  CHAT_PROJECT_LABEL,
  commitSendTurnDispatch,
  captureReviewedSendReadiness,
  isFileUploadTokenUsable,
  resolveChatProjectTitleSeed,
  resolveThreadCreateModelSelection,
  type CommitSendTurnDispatchInput,
} from "@ryco/client-runtime/state/composer";
import { truncate } from "@ryco/shared/String";
import { webAttachmentCodec } from "../platform/attachmentCodec";
import { readWorktreeLaunch } from "@ryco/client-runtime/state/worktree-setup";
import {
  beginWorktreeLaunch,
  forgetWorktreeLaunch,
  handOffWorktreeLaunch,
  settleFailedWorktreeLaunch,
  worktreeLaunchKey as worktreeLaunchKeyFor,
} from "../components/chat/worktreeLaunch/worktreeLaunchSend";

import type { ComposerImageAttachment, DraftId } from "../composerDraftStore";
import type { ChatMessage } from "../types";
import type { TerminalContextDraft } from "../lib/terminalContext";
import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import type { ScopedThreadRef } from "@ryco/contracts";

type ComposerThreadTarget = ScopedThreadRef | DraftId;

import { formatTerminalContextLabel } from "../lib/terminalContext";
import { collapseExpandedComposerCursor } from "../composer-logic";
import { newCommandId, newMessageId } from "../lib/utils";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  buildChatSendTitleSeed,
  buildExpiredTerminalContextToastCopy,
  cloneComposerImageForRetry,
  refreshStaleSourceControlContexts,
  revokeUserMessagePreviewUrls,
} from "../components/ChatView.logic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendTurnComposerSnapshot {
  /** Preserve slash-command text when a synthesized turn fails to dispatch. */
  promptForRestore?: string;
  goal?: ThreadGoalUpdate;
  prompt: string;
  trimmedPrompt: string;
  images: ComposerImageAttachment[];
  sendableTerminalContexts: TerminalContextDraft[];
  /** Lines from the Review and Files panels; absent for sends composed without the composer. */
  fileReferences?: FileReferenceDraft[];
  sourceControlContexts: ComposerSourceControlContext[];
  selectedProvider: ProviderDriverKind;
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  selectedPromptEffort: string | null;
  selectedModelSelection: ModelSelection;
  expiredTerminalContextCount: number;
}

export interface SendTurnThreadContext {
  sourceProviderDriver?: ProviderDriverKind | null;
  threadId: ThreadId;
  isFirstMessage: boolean;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  activeThreadBranch: string | null;
  worktreePath: string | null;
  createdAt: string;
  projectId: ProjectId;
  /**
   * Set on the first send of a "No project" chat draft: the bootstrap asks the
   * server to create this chat project (titled from the message) first.
   */
  createChatProjectId?: ProjectId;
  /**
   * With `createChatProjectId`: gives the chat draft a fresh project id, kept
   * on the draft, when the node has retired the current one (an unused chat
   * removed by cleanup). The message is then sent once more under it.
   */
  renewChatProjectId?: () => ProjectId;
}

export interface SendTurnWorktreePlan {
  fetchOrigin?: boolean;
  worktreeBranchName?: string | null;
  shouldMaterializeLegacyBranchWorktree: boolean;
  baseBranchForWorktree: string | null;
  shouldCreateWorktree: boolean;
}

/**
 * Thread identity resolved at commit time, replacing the one the turn was
 * assembled with.
 */
export interface SendTurnDispatchPreparation {
  readonly threadId: ThreadId;
  readonly isServerThread: boolean;
  readonly isFirstMessage: boolean;
}

export interface SendTurnSettings {
  computerUse?: ComputerTurnIntent;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  tokenMode: AgentTokenMode;
}

export interface SendTurnProjectContext {
  projectId: ProjectId;
  projectCwd: string;
  /** @deprecated Retained for older callers; never used for model resolution. */
  defaultModelSelection?: ModelSelection | null;
}

export interface SendTurnScrollDeps {
  /**
   * Prepares the view for the optimistic message, synchronously: live follow,
   * the at-end state, and anything that has to see the view before the message
   * commits. It must not wait for the list: the message and the composer clear
   * never wait for scrolling, and `scrollToEndAfterOptimistic` brings the end
   * into view afterwards.
   */
  armEndFollowBeforeOptimistic: () => void;
  /** Starts following the new end once the optimistic message is in; never awaited. */
  scrollToEndAfterOptimistic: () => void;
}

export interface SendTurnComposerDraftDeps {
  composerDraftTarget: ComposerThreadTarget;
  environmentId: EnvironmentId;
  clearComposerDraftContent: (target: ComposerThreadTarget) => void;
  setComposerDraftTokenMode: (target: ComposerThreadTarget, mode: AgentTokenMode) => void;
  setComposerDraftPrompt: (target: ComposerThreadTarget, prompt: string) => void;
  removeComposerDraftImage: (target: ComposerThreadTarget, imageId: string) => void;
  addComposerDraftImages: (target: ComposerThreadTarget, images: ComposerImageAttachment[]) => void;
  setComposerDraftTerminalContexts: (
    target: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
  ) => void;
  setComposerDraftFileReferences: (
    target: ComposerThreadTarget,
    references: ReadonlyArray<FileReferenceDraft>,
  ) => void;
  setDraftThreadContext: (
    target: ComposerThreadTarget,
    context: { tokenMode: AgentTokenMode },
  ) => void;
  /** What the draft store holds for a target: read once the view no longer shows it. */
  readComposerDraftContent: (target: ComposerThreadTarget) => ComposerDraftContent | null;
}

/** A composer's sendable content: its prompt, attachments, terminal contexts and file references. */
export interface ComposerDraftContent {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly fileReferences: ReadonlyArray<FileReferenceDraft>;
}

export interface SendTurnDispatchDeps {
  api: EnvironmentApi;
  beginLocalDispatch: (options: { preparingWorktree: boolean }) => void;
  resetLocalDispatch: () => void;
  setOptimisticUserMessages: (updater: (existing: ChatMessage[]) => ChatMessage[]) => void;
  setThreadError: (threadId: ThreadId, error: string | null) => void;
}

export interface SendTurnRollbackRefs {
  promptRef: { current: string };
  composerImagesRef: { current: ComposerImageAttachment[] };
  composerTerminalContextsRef: { current: TerminalContextDraft[] };
  composerFileReferencesRef: { current: FileReferenceDraft[] };
  sendInFlightRef: { current: boolean };
}

export interface SendTurnSourceControlFetcher {
  fetcher: (ctx: ComposerSourceControlContext) => Promise<ComposerSourceControlContext>;
}

export interface SendTurnPersistSettingsDeps {
  persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
    tokenMode: AgentTokenMode;
  }) => Promise<void>;
}

export interface SendTurnReadComposer {
  readComposer: () => ChatComposerHandle | null;
  /**
   * Whether the view this send started from still shows its thread. ChatView
   * follows thread navigation, so the live composer (refs, handle), the
   * timeline's optimistic messages and its scroll are this send's only while it
   * does; afterwards the send restores or clears its draft in the store alone.
   * Absent: always (a send with no view of its own).
   */
  showsSendThread?: () => boolean;
}

export interface ExecuteChatSendTurnInput {
  /** Queued sends own their snapshot independently of the live composer. */
  preserveComposerDraft?: boolean;
  /** undefined = the dialog presentation (default); null = never review interactively. */
  claudeCacheReview?: ClaudeCacheReviewPresentation | null;
  /** The live subscribed thread for the Claude resume review (see the send engine). */
  readSubscribedClaudeReviewState?: CommitSendTurnDispatchInput["readSubscribedClaudeReviewState"];
  /** Background sends never toast. */
  suppressToasts?: boolean;
  /** Runs immediately before the final `thread.turn.start`. */
  onBeforeTurnStart?: () => void;
  /** Observes the caught error before it becomes a thread error (classification only). */
  onSendError?: (error: unknown) => void;
  /** Stable client id; queued sends reuse the id assigned at enqueue time. */
  messageId?: MessageId;
  /**
   * Sends this message again under the same id, after its new worktree failed
   * to set up. Without it a failed setup can only hand the message back.
   */
  resendFailedWorktreeLaunch?: (messageId: MessageId) => Promise<boolean>;
  composer: SendTurnComposerSnapshot;
  thread: SendTurnThreadContext;
  worktree: SendTurnWorktreePlan;
  settings: SendTurnSettings;
  project: SendTurnProjectContext;
  scroll: SendTurnScrollDeps;
  /**
   * Runs before dispatch for work that must produce the destination thread first.
   * Returning a preparation redirects the dispatch at the thread it produced.
   */
  prepareForDispatch?: () => Promise<SendTurnDispatchPreparation | null>;
  /** A task draft's first send, recorded under the task (see the send engine). */
  localTask?: CommitSendTurnDispatchInput["localTask"];
  draft: SendTurnComposerDraftDeps;
  dispatch: SendTurnDispatchDeps;
  refs: SendTurnRollbackRefs;
  sourceControl: SendTurnSourceControlFetcher;
  persistSettings: SendTurnPersistSettingsDeps;
  composerHandle: SendTurnReadComposer;
  formatOutgoingPrompt: (params: {
    provider: ProviderDriverKind;
    model: string | null;
    models: ReadonlyArray<ServerProvider["models"][number]>;
    effort: string | null;
    text: string;
  }) => string;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/** Remove a pending optimistic user message from the timeline, revoking its previews. */
export function removeOptimisticUserMessage(
  setOptimisticUserMessages: (updater: (existing: ChatMessage[]) => ChatMessage[]) => void,
  messageId: string,
): void {
  setOptimisticUserMessages((existing) => {
    const removed = existing.filter((m) => m.id === messageId);
    for (const m of removed) {
      revokeUserMessagePreviewUrls(m);
    }
    const next = existing.filter((m) => m.id !== messageId);
    return next.length === existing.length ? existing : next;
  });
}

export type ComposerContentRefs = Pick<
  SendTurnRollbackRefs,
  "promptRef" | "composerImagesRef" | "composerTerminalContextsRef" | "composerFileReferencesRef"
>;

/** Whether a stored draft still holds exactly what a send took from it (by identity of each item). */
function composerDraftContentMatches(
  content: ComposerDraftContent | null,
  sent: ComposerDraftContent,
): boolean {
  const sameIds = (
    left: ReadonlyArray<{ readonly id: string }>,
    right: ReadonlyArray<{ readonly id: string }>,
  ) => left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
  return (
    (content?.prompt ?? "") === sent.prompt &&
    sameIds(content?.images ?? [], sent.images) &&
    sameIds(content?.terminalContexts ?? [], sent.terminalContexts) &&
    sameIds(content?.fileReferences ?? [], sent.fileReferences)
  );
}

function composerDraftContentHasContent(content: ComposerDraftContent | null): boolean {
  return (
    content !== null &&
    (content.prompt.length !== 0 ||
      content.images.length !== 0 ||
      content.terminalContexts.length !== 0 ||
      content.fileReferences.length !== 0)
  );
}

export function composerRefsHaveContent(refs: ComposerContentRefs): boolean {
  return (
    refs.promptRef.current.length !== 0 ||
    refs.composerImagesRef.current.length !== 0 ||
    refs.composerTerminalContextsRef.current.length !== 0 ||
    refs.composerFileReferencesRef.current.length !== 0
  );
}

/**
 * Puts a prompt, its attachments, terminal contexts and file references back
 * into the composer and parks the cursor at the end. Shared by the send rollback and by editing a
 * queued message. Callers check `composerRefsHaveContent` first: this replaces
 * the composer's content, so it must only run into an empty composer.
 */
export function restoreComposerContent(input: {
  refs: ComposerContentRefs;
  composerHandle: SendTurnReadComposer;
  draft: Pick<
    SendTurnComposerDraftDeps,
    | "composerDraftTarget"
    | "setComposerDraftPrompt"
    | "addComposerDraftImages"
    | "setComposerDraftTerminalContexts"
    | "setComposerDraftFileReferences"
  >;
  prompt: string;
  images: ComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  fileReferences: FileReferenceDraft[];
  /** False once the view shows another thread: only the draft store is written. */
  live?: boolean;
}): void {
  const { refs, composerHandle, draft, prompt, images, terminalContexts, fileReferences } = input;
  const live = input.live ?? true;

  if (live) {
    refs.promptRef.current = prompt;
    refs.composerImagesRef.current = images;
    refs.composerTerminalContextsRef.current = terminalContexts;
    refs.composerFileReferencesRef.current = fileReferences;
  }

  draft.setComposerDraftPrompt(draft.composerDraftTarget, prompt);
  draft.addComposerDraftImages(draft.composerDraftTarget, images);
  draft.setComposerDraftTerminalContexts(draft.composerDraftTarget, terminalContexts);
  draft.setComposerDraftFileReferences(draft.composerDraftTarget, fileReferences);

  if (!live) return;
  composerHandle.readComposer()?.resetCursorState({
    cursor: collapseExpandedComposerCursor(prompt, prompt.length),
    prompt,
    detectTrigger: true,
  });
}

export function rollbackSendTurn(input: {
  refs: SendTurnRollbackRefs;
  composerHandle: SendTurnReadComposer;
  dispatch: Pick<SendTurnDispatchDeps, "setOptimisticUserMessages">;
  draft: SendTurnComposerDraftDeps;
  messageId: string;
  promptSnapshot: string;
  imagesSnapshot: ComposerImageAttachment[];
  terminalContextsSnapshot: TerminalContextDraft[];
  fileReferencesSnapshot: FileReferenceDraft[];
}): void {
  const {
    refs,
    composerHandle,
    dispatch,
    draft,
    messageId,
    promptSnapshot,
    imagesSnapshot,
    terminalContextsSnapshot,
    fileReferencesSnapshot,
  } = input;
  // The live refs belong to whichever thread the view shows: once that is
  // another one, this thread's draft is what decides, in the store.
  const live = composerHandle.showsSendThread?.() ?? true;

  if (
    live
      ? composerRefsHaveContent(refs)
      : composerDraftContentHasContent(draft.readComposerDraftContent(draft.composerDraftTarget))
  ) {
    return;
  }

  if (live) removeOptimisticUserMessage(dispatch.setOptimisticUserMessages, messageId);

  restoreComposerContent({
    refs,
    composerHandle,
    draft,
    live,
    prompt: promptSnapshot,
    // The send revoked the live previews; give the retry its own blob URLs.
    images: imagesSnapshot.map(cloneComposerImageForRetry),
    terminalContexts: terminalContextsSnapshot,
    fileReferences: fileReferencesSnapshot,
  });
}

// ---------------------------------------------------------------------------
// Bootstrap building
// ---------------------------------------------------------------------------

export { buildSendTurnBootstrap } from "@ryco/client-runtime/state/composer";

export function buildOutgoingMessageText(input: {
  readonly composer: SendTurnComposerSnapshot;
  readonly formatOutgoingPrompt: ExecuteChatSendTurnInput["formatOutgoingPrompt"];
}): string {
  // The same composition on every surface, so web, desktop and mobile send identical text.
  const messageTextForSend = composeOutgoingPrompt({
    prompt: input.composer.prompt,
    fileReferences: input.composer.fileReferences,
    terminalContexts: input.composer.sendableTerminalContexts,
  });
  return input.formatOutgoingPrompt({
    provider: input.composer.selectedProvider,
    model: input.composer.selectedModel,
    models: input.composer.selectedProviderModels,
    effort: input.composer.selectedPromptEffort,
    text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  });
}

export async function buildOutgoingTurnAttachments(
  images: readonly ComposerImageAttachment[],
  options?: { nowMs?: number },
) {
  const nowMs = options?.nowMs ?? Date.now();
  return Promise.all(
    images.map(async (image) => {
      // Uploaded streamed files dispatch by token; images and legacy inline
      // files keep the dataUrl path.
      if (
        image.type === "file" &&
        image.uploadToken !== undefined &&
        (image.expiresAt === undefined || isFileUploadTokenUsable(image.expiresAt, nowMs))
      ) {
        return buildSendTurnUploadTokenDispatchAttachment({
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          uploadToken: image.uploadToken,
        });
      }
      return buildSendTurnDispatchAttachment({
        attachment: await webAttachmentCodec.encode({
          id: image.id,
          file: image.file,
        }),
        name: image.name,
        type: image.type,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Core send turn
// ---------------------------------------------------------------------------

export async function executeChatSendTurn(input: ExecuteChatSendTurnInput): Promise<boolean> {
  const {
    composer,
    thread,
    worktree,
    settings,
    project,
    scroll,
    draft,
    dispatch,
    refs,
    sourceControl,
    persistSettings: persistSettingsDeps,
    composerHandle,
    formatOutgoingPrompt,
  } = input;

  const { api, beginLocalDispatch, resetLocalDispatch, setThreadError } = dispatch;
  const showsSendThread = composerHandle.showsSendThread ?? (() => true);
  // The timeline the optimistic message goes into is the view's; it is reset
  // when the view moves to another thread.
  const setOptimisticUserMessages: SendTurnDispatchDeps["setOptimisticUserMessages"] = (
    updater,
  ) => {
    if (showsSendThread()) dispatch.setOptimisticUserMessages(updater);
  };

  refs.sendInFlightRef.current = true;
  beginLocalDispatch({
    preparingWorktree: Boolean(worktree.baseBranchForWorktree),
  });
  const messageIdForSend = input.messageId ?? newMessageId();
  // A new message sent past a failed setup replaces the message it kept.
  const failedLaunch = readWorktreeLaunch(
    worktreeLaunchKeyFor(draft.environmentId, thread.threadId),
  );
  if (failedLaunch?.phase === "failed" && failedLaunch.messageId !== messageIdForSend) {
    removeOptimisticUserMessage(setOptimisticUserMessages, failedLaunch.messageId);
    forgetWorktreeLaunch(failedLaunch.key);
  }
  // A draft's first send into a new worktree: its setup is shown live, from
  // this frame on, and survives the draft view being replaced by the thread's.
  const worktreeLaunchKey =
    thread.isLocalDraftThread &&
    worktree.shouldCreateWorktree &&
    !worktree.shouldMaterializeLegacyBranchWorktree &&
    worktree.baseBranchForWorktree !== null &&
    !input.prepareForDispatch
      ? beginWorktreeLaunch({
          api,
          environmentId: draft.environmentId,
          threadId: thread.threadId,
          messageId: messageIdForSend,
          baseRef: worktree.baseBranchForWorktree,
          fetchOrigin: worktree.fetchOrigin ?? false,
        })
      : null;

  const imagesSnapshot = [...composer.images];
  const terminalContextsSnapshot = [...composer.sendableTerminalContexts];
  const fileReferencesSnapshot = [...(composer.fileReferences ?? [])];
  const sourceControlSnapshot = [...composer.sourceControlContexts];

  // The live refs are this thread's only while the view shows it; once the view
  // moved on (the caller awaited before this), the stored draft is what it holds.
  const liveAtStart = showsSendThread();
  const draftAtStart: ComposerDraftContent = liveAtStart
    ? {
        prompt: refs.promptRef.current,
        images: refs.composerImagesRef.current,
        terminalContexts: refs.composerTerminalContextsRef.current,
        fileReferences: refs.composerFileReferencesRef.current,
      }
    : (draft.readComposerDraftContent(draft.composerDraftTarget) ?? {
        prompt: "",
        images: [],
        terminalContexts: [],
        fileReferences: [],
      });

  const messageCreatedAt = new Date().toISOString();
  const outgoingMessageText = buildOutgoingMessageText({
    composer,
    formatOutgoingPrompt,
  });

  // Attachment-neutral send path: the web boundary encodes each DOM `File` to a
  // neutral `ComposerAttachment` via the AttachmentCodec, and the package builds
  // the outgoing turn attachment from the union alone (no `.file` in the engine).
  let turnStartSucceeded = false;
  let composerCleared = false;
  try {
    rejectRetiredProjectMemory(composer);
    const turnAttachments = await buildOutgoingTurnAttachments(imagesSnapshot);

    // Arm the end follow; the message and the composer clear do not wait for
    // the list to scroll.
    if (showsSendThread()) scroll.armEndFollowBeforeOptimistic();

    const optimisticAttachments = imagesSnapshot.map(cloneComposerImageForRetry).map((image) => ({
      type: image.type,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));

    setOptimisticUserMessages((existing) =>
      // A retried launch resends the message its failure kept on screen.
      existing.some((message) => message.id === messageIdForSend)
        ? existing
        : [
            ...existing,
            {
              id: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
              createdAt: messageCreatedAt,
              streaming: false,
            },
          ],
    );
    if (showsSendThread()) scroll.scrollToEndAfterOptimistic();

    // Edits made during preparation keep the draft. Once the view shows another
    // thread the live refs are that thread's, so this thread's stored draft is
    // compared instead (also when the send started away from it: its start
    // state is the stored draft's, not the refs').
    const liveAtConsume = liveAtStart && showsSendThread();
    const consumeDraft =
      !input.preserveComposerDraft &&
      (liveAtConsume
        ? refs.promptRef.current === draftAtStart.prompt &&
          refs.composerImagesRef.current === draftAtStart.images &&
          refs.composerTerminalContextsRef.current === draftAtStart.terminalContexts &&
          refs.composerFileReferencesRef.current === draftAtStart.fileReferences
        : composerDraftContentMatches(
            draft.readComposerDraftContent(draft.composerDraftTarget),
            draftAtStart,
          ));
    setThreadError(thread.threadId, null);
    if (consumeDraft) {
      draft.setComposerDraftTokenMode(
        scopeThreadRef(draft.environmentId, thread.threadId),
        settings.tokenMode,
      );
      if (thread.isLocalDraftThread) {
        draft.setDraftThreadContext(draft.composerDraftTarget, {
          tokenMode: settings.tokenMode,
        });
      }
    }

    if (composer.expiredTerminalContextCount > 0 && !input.suppressToasts) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        composer.expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }

    // Queued snapshots and edits made during preparation belong to the next draft.
    if (consumeDraft) {
      composerCleared = true;
      if (liveAtConsume) {
        refs.promptRef.current = "";
        // A failure before the composer re-renders must still find it empty and restore.
        refs.composerFileReferencesRef.current = [];
      }
      draft.clearComposerDraftContent(draft.composerDraftTarget);
      draft.setComposerDraftTokenMode(draft.composerDraftTarget, settings.tokenMode);
      if (liveAtConsume) composerHandle.readComposer()?.resetCursorState();
    }
    let firstComposerImageName: string | null = null;
    if (imagesSnapshot.length > 0) {
      const firstComposerImage = imagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    const titleSeedText = buildChatSendTitleSeed({
      trimmedPrompt: composer.trimmedPrompt,
      firstImageName: firstComposerImageName,
      firstTerminalContextLabel:
        terminalContextsSnapshot.length > 0
          ? formatTerminalContextLabel(terminalContextsSnapshot[0]!)
          : null,
      firstFileReferenceTitle:
        fileReferencesSnapshot.length > 0
          ? formatFileReferenceTitle(fileReferencesSnapshot[0]!)
          : null,
    });
    const title = truncate(titleSeedText);

    const threadCreateModelSelection = resolveThreadCreateModelSelection({
      selectedModelSelection: composer.selectedModelSelection,
      selectedModel: composer.selectedModel,
    });

    const freshSourceControlContexts = await refreshStaleSourceControlContexts(
      sourceControlSnapshot,
      sourceControl,
    );

    // Resolve the node-owned default at creation time, including for queued drafts.
    const needsBranchPrefix =
      Boolean(worktree.baseBranchForWorktree) &&
      !worktree.shouldMaterializeLegacyBranchWorktree &&
      !worktree.worktreeBranchName;
    if (needsBranchPrefix && !api.server) {
      throw new Error("Server settings are unavailable for worktree creation.");
    }
    // Nothing here waits on a server round trip in the common case. Support for
    // project preferences comes from the environment's live config (hosted
    // targets only from the connection's config for the current attempt and
    // generation, else read fresh: a cached one may still be another node's), the
    // branch prefix from the preferences remembered when the draft opened or
    // worktree mode was entered (while the node's settings are unchanged), and
    // the setup-script choice is left to the server, which resolves the same
    // preferences while it bootstraps.
    const readSettingsFallback = () =>
      api.server!.getSettings().then(
        (settings) => ({ ok: true as const, settings }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    // Without a remembered prefix, the node-wide fallback is read alongside the
    // config; its outcome, a failure included, only counts when the project
    // names no prefix.
    const settingsFallback =
      needsBranchPrefix &&
      api.server &&
      !hasRememberedProjectPreferences(draft.environmentId, project.projectId)
        ? readSettingsFallback()
        : undefined;
    const config = worktree.baseBranchForWorktree
      ? await readNodeConfig(
          resolveNodeConfigSource(draft.environmentId, { currentOnly: isHostedHubMode() }),
          api,
        )
      : null;
    const remembered = needsBranchPrefix
      ? readRememberedProjectPreferences(draft.environmentId, project.projectId, config ?? null)
      : null;
    const supportsPreferences = config?.environment.capabilities.projectPreferences === true;
    let worktreeBranchPrefix: string | undefined;
    if (needsBranchPrefix && api.server) {
      const effective = supportsPreferences
        ? (remembered ??
          (await readAndRememberProjectPreferences({
            api,
            environmentId: draft.environmentId,
            config: config ?? null,
            projectId: project.projectId,
          })))
        : null;
      worktreeBranchPrefix = effective?.worktreeBranchPrefix.value;
      if (worktreeBranchPrefix === undefined) {
        const fallback = await (settingsFallback ?? readSettingsFallback());
        if (!fallback.ok) throw fallback.error;
        worktreeBranchPrefix = fallback.settings.worktreeBranchPrefix;
      }
    }
    const bootstrap = buildSendTurnBootstrap({
      isLocalDraftThread: thread.isLocalDraftThread,
      baseBranchForWorktree: worktree.baseBranchForWorktree,
      fetchOrigin: worktree.fetchOrigin,
      worktreeBranchName: worktree.worktreeBranchName,
      worktreeBranchPrefix,
      // A node with project preferences resolves the project's choice itself;
      // an older one runs the setup script as it always did.
      runSetupScript: supportsPreferences ? undefined : true,
      shouldMaterializeLegacyBranchWorktree: worktree.shouldMaterializeLegacyBranchWorktree,
      projectId: project.projectId,
      projectCwd: project.projectCwd,
      title,
      threadCreateModelSelection,
      runtimeMode: settings.runtimeMode,
      interactionMode: settings.interactionMode,
      tokenMode: settings.tokenMode,

      activeThreadBranch: thread.activeThreadBranch,
      worktreePath: thread.worktreePath,
      threadCreatedAt: thread.createdAt,
      ...(thread.createChatProjectId
        ? {
            createChatProject: {
              projectId: thread.createChatProjectId,
              // The untruncated first message (bounded by the contract); attachment
              // names stand in for missing text, so it is never empty.
              titleSeed: resolveChatProjectTitleSeed(titleSeedText) ?? CHAT_PROJECT_LABEL,
            },
          }
        : {}),
    });

    // Creating a worktree from a PR / issue / work item also creates its thread,
    // so that work happens before send assembly and redirects the dispatch at
    // what it produced.
    const prepared = input.prepareForDispatch ? await input.prepareForDispatch() : null;

    // Provider-independent dispatch assembly (title update, next-turn settings,
    // and `thread.turn.start`).
    const claudeCacheReview =
      input.claudeCacheReview === undefined
        ? claudeCacheReviewPresentation
        : (input.claudeCacheReview ?? undefined);
    await commitSendTurnDispatch({
      ...(claudeCacheReview ? { claudeCacheReview } : {}),
      // A prepared thread is new: there is no subscribed state of it to review from.
      ...(input.readSubscribedClaudeReviewState && !prepared
        ? { readSubscribedClaudeReviewState: input.readSubscribedClaudeReviewState }
        : {}),
      ...(input.onBeforeTurnStart ? { onBeforeTurnStart: input.onBeforeTurnStart } : {}),
      providerDriver: composer.selectedProvider,
      sourceProviderDriver: thread.sourceProviderDriver,
      assertMutationReady: captureReviewedSendReadiness(draft.environmentId, () =>
        readEnvironmentConnection(draft.environmentId),
      ),
      api,
      threadId: prepared?.threadId ?? thread.threadId,
      isFirstMessage: prepared?.isFirstMessage ?? thread.isFirstMessage,
      isServerThread: prepared?.isServerThread ?? thread.isServerThread,
      title,
      messageId: messageIdForSend,
      outgoingMessageText,
      turnAttachments,
      modelSelection: composer.selectedModelSelection,
      runtimeMode: settings.runtimeMode,
      interactionMode: settings.interactionMode,
      tokenMode: settings.tokenMode,
      ...(settings.computerUse ? { computerUse: settings.computerUse } : {}),
      // A prepared thread already exists server-side, so there is nothing left
      // for the bootstrap to create.
      ...(composer.goal ? { goal: composer.goal } : {}),
      bootstrap: prepared ? undefined : bootstrap,
      ...(!prepared && thread.createChatProjectId && thread.renewChatProjectId
        ? { renewChatProjectId: thread.renewChatProjectId }
        : {}),
      sourceControlContexts: freshSourceControlContexts,
      ...(input.localTask ? { localTask: input.localTask } : {}),
      createdAt: messageCreatedAt,
      newCommandId,
      beginLocalDispatch,
      endLocalDispatch: resetLocalDispatch,
      persistThreadSettingsForNextTurn: persistSettingsDeps.persistThreadSettingsForNextTurn,
    });
    turnStartSucceeded = true;
    if (worktreeLaunchKey) handOffWorktreeLaunch(worktreeLaunchKey);
    if (!composerCleared && !input.preserveComposerDraft) {
      // A prompt edit preserves the draft, but accepted uploads cannot be sent
      // under a new command. Keep additions and replacements made during prep.
      const live = showsSendThread();
      const current = live
        ? refs.composerImagesRef.current
        : (draft.readComposerDraftContent(draft.composerDraftTarget)?.images ?? []);
      const consumed = current.filter((image) =>
        imagesSnapshot.some(
          (sent) =>
            sent.id === image.id &&
            sent.uploadToken === image.uploadToken &&
            sent.file === image.file,
        ),
      );
      if (live) {
        refs.composerImagesRef.current = refs.composerImagesRef.current.filter(
          (image) => !consumed.includes(image),
        );
      }
      for (const attachment of consumed) {
        draft.removeComposerDraftImage(draft.composerDraftTarget, attachment.id);
      }
    }
  } catch (err: unknown) {
    input.onSendError?.(err);
    const restoreComposer = () => {
      // A resent launch never cleared the composer, but its message still
      // belongs back there when the launch is given up.
      if (composerCleared || worktreeLaunchKey) {
        rollbackSendTurn({
          refs,
          composerHandle,
          dispatch: { setOptimisticUserMessages },
          draft,
          messageId: messageIdForSend,
          promptSnapshot: composer.promptForRestore ?? composer.prompt,
          imagesSnapshot,
          terminalContextsSnapshot,
          fileReferencesSnapshot,
        });
      }
      // The rollback leaves a composer the user typed into meanwhile alone.
      removeOptimisticUserMessage(setOptimisticUserMessages, messageIdForSend);
    };
    if (worktreeLaunchKey) {
      // The setup's own row reports the failure (or a stop): no thread error.
      const resend = input.resendFailedWorktreeLaunch;
      settleFailedWorktreeLaunch({
        key: worktreeLaunchKey,
        error: err,
        retry: {
          messageId: messageIdForSend,
          resend: resend ? () => resend(messageIdForSend) : async () => false,
          restore: restoreComposer,
        },
      });
    } else {
      restoreComposer();
      setThreadError(
        thread.threadId,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    }
  } finally {
    refs.sendInFlightRef.current = false;
    if (!turnStartSucceeded) resetLocalDispatch();
  }
  return turnStartSucceeded;
}
