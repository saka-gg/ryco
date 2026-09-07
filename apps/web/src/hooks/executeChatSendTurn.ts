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
  buildSendTurnDispatchAttachment,
  buildSendTurnUploadTokenDispatchAttachment,
  commitSendTurnDispatch,
  isFileUploadTokenUsable,
  resolveThreadCreateModelSelection,
} from "@ryco/client-runtime/state/composer";
import { truncate } from "@ryco/shared/String";
import { webAttachmentCodec } from "../platform/attachmentCodec";

import type { ComposerImageAttachment, DraftId } from "../composerDraftStore";
import type { ChatMessage } from "../types";
import type { TerminalContextDraft } from "../lib/terminalContext";
import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import type { ScopedThreadRef } from "@ryco/contracts";

type ComposerThreadTarget = ScopedThreadRef | DraftId;

import { appendTerminalContextsToPrompt, formatTerminalContextLabel } from "../lib/terminalContext";
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
  sourceControlContexts: ComposerSourceControlContext[];
  selectedProvider: ProviderDriverKind;
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  selectedPromptEffort: string | null;
  selectedModelSelection: ModelSelection;
  expiredTerminalContextCount: number;
}

export interface SendTurnThreadContext {
  threadId: ThreadId;
  isFirstMessage: boolean;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  activeThreadBranch: string | null;
  worktreePath: string | null;
  createdAt: string;
  projectId: ProjectId;
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
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  tokenMode: AgentTokenMode;
}

export interface SendTurnProjectContext {
  projectId: ProjectId;
  projectCwd: string;
  defaultModelSelection: ModelSelection | null;
}

export interface SendTurnScrollDeps {
  scrollToEndBeforeOptimistic: () => Promise<void>;
  scrollToEndAfterOptimistic: () => void;
}

export interface SendTurnComposerDraftDeps {
  composerDraftTarget: ComposerThreadTarget;
  environmentId: EnvironmentId;
  clearComposerDraftContent: (target: ComposerThreadTarget) => void;
  setComposerDraftTokenMode: (target: ComposerThreadTarget, mode: AgentTokenMode) => void;
  setComposerDraftPrompt: (target: ComposerThreadTarget, prompt: string) => void;
  addComposerDraftImages: (target: ComposerThreadTarget, images: ComposerImageAttachment[]) => void;
  setComposerDraftTerminalContexts: (
    target: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
  ) => void;
  setDraftThreadContext: (
    target: ComposerThreadTarget,
    context: { tokenMode: AgentTokenMode },
  ) => void;
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
}

export interface ExecuteChatSendTurnInput {
  /** Stable client id; queued sends reuse the id assigned at enqueue time. */
  messageId?: MessageId;
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

export function rollbackSendTurn(input: {
  refs: SendTurnRollbackRefs;
  composerHandle: SendTurnReadComposer;
  dispatch: Pick<SendTurnDispatchDeps, "setOptimisticUserMessages">;
  draft: SendTurnComposerDraftDeps;
  messageId: string;
  promptSnapshot: string;
  imagesSnapshot: ComposerImageAttachment[];
  terminalContextsSnapshot: TerminalContextDraft[];
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
  } = input;

  if (
    refs.promptRef.current.length !== 0 ||
    refs.composerImagesRef.current.length !== 0 ||
    refs.composerTerminalContextsRef.current.length !== 0
  ) {
    return;
  }

  removeOptimisticUserMessage(dispatch.setOptimisticUserMessages, messageId);

  refs.promptRef.current = promptSnapshot;
  const retryImages = imagesSnapshot.map(cloneComposerImageForRetry);
  refs.composerImagesRef.current = retryImages;
  refs.composerTerminalContextsRef.current = terminalContextsSnapshot;

  draft.setComposerDraftPrompt(draft.composerDraftTarget, promptSnapshot);
  draft.addComposerDraftImages(draft.composerDraftTarget, retryImages);
  draft.setComposerDraftTerminalContexts(draft.composerDraftTarget, terminalContextsSnapshot);

  composerHandle.readComposer()?.resetCursorState({
    cursor: collapseExpandedComposerCursor(promptSnapshot, promptSnapshot.length),
    prompt: promptSnapshot,
    detectTrigger: true,
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
  const messageTextForSend = appendTerminalContextsToPrompt(
    input.composer.prompt,
    input.composer.sendableTerminalContexts,
  );
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

export async function executeChatSendTurn(input: ExecuteChatSendTurnInput): Promise<void> {
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

  const { api, beginLocalDispatch, resetLocalDispatch, setOptimisticUserMessages, setThreadError } =
    dispatch;

  refs.sendInFlightRef.current = true;
  beginLocalDispatch({
    preparingWorktree: Boolean(worktree.baseBranchForWorktree),
  });

  const imagesSnapshot = [...composer.images];
  const terminalContextsSnapshot = [...composer.sendableTerminalContexts];
  const sourceControlSnapshot = [...composer.sourceControlContexts];

  const messageIdForSend = input.messageId ?? newMessageId();
  const messageCreatedAt = new Date().toISOString();
  const outgoingMessageText = buildOutgoingMessageText({
    composer,
    formatOutgoingPrompt,
  });

  // Attachment-neutral send path: the web boundary encodes each DOM `File` to a
  // neutral `ComposerAttachment` via the AttachmentCodec, and the package builds
  // the outgoing turn attachment from the union alone (no `.file` in the engine).
  const turnAttachmentsPromise = buildOutgoingTurnAttachments(imagesSnapshot);

  const optimisticAttachments = imagesSnapshot.map((image) => ({
    type: image.type,
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    previewUrl: image.previewUrl,
  }));

  // Scroll to end before optimistic message for auto-pin.
  await scroll.scrollToEndBeforeOptimistic();

  setOptimisticUserMessages((existing) => [
    ...existing,
    {
      id: messageIdForSend,
      role: "user",
      text: outgoingMessageText,
      ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
      createdAt: messageCreatedAt,
      streaming: false,
    },
  ]);
  scroll.scrollToEndAfterOptimistic();

  setThreadError(thread.threadId, null);
  draft.setComposerDraftTokenMode(
    scopeThreadRef(draft.environmentId, thread.threadId),
    settings.tokenMode,
  );
  if (thread.isLocalDraftThread) {
    draft.setDraftThreadContext(draft.composerDraftTarget, {
      tokenMode: settings.tokenMode,
    });
  }

  if (composer.expiredTerminalContextCount > 0) {
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

  // Clear composer
  refs.promptRef.current = "";
  draft.clearComposerDraftContent(draft.composerDraftTarget);
  draft.setComposerDraftTokenMode(draft.composerDraftTarget, settings.tokenMode);
  composerHandle.readComposer()?.resetCursorState();

  let turnStartSucceeded = false;
  await (async () => {
    let firstComposerImageName: string | null = null;
    if (imagesSnapshot.length > 0) {
      const firstComposerImage = imagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    const title = truncate(
      buildChatSendTitleSeed({
        trimmedPrompt: composer.trimmedPrompt,
        firstImageName: firstComposerImageName,
        firstTerminalContextLabel:
          terminalContextsSnapshot.length > 0
            ? formatTerminalContextLabel(terminalContextsSnapshot[0]!)
            : null,
      }),
    );

    const defaultModel = project.defaultModelSelection?.model ?? null;
    const threadCreateModelSelection = resolveThreadCreateModelSelection({
      selectedModelSelection: composer.selectedModelSelection,
      selectedModel: composer.selectedModel,
      defaultModel,
    });

    const turnAttachments = await turnAttachmentsPromise;

    const freshSourceControlContexts = await refreshStaleSourceControlContexts(
      sourceControlSnapshot,
      sourceControl,
    );

    const bootstrap = buildSendTurnBootstrap({
      isLocalDraftThread: thread.isLocalDraftThread,
      baseBranchForWorktree: worktree.baseBranchForWorktree,
      fetchOrigin: worktree.fetchOrigin,
      worktreeBranchName: worktree.worktreeBranchName,
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
    });

    // Creating a worktree from a PR / issue / work item also creates its thread,
    // so that work happens before send assembly and redirects the dispatch at
    // what it produced.
    const prepared = input.prepareForDispatch ? await input.prepareForDispatch() : null;

    // Provider-independent dispatch assembly (title update, next-turn settings,
    // and `thread.turn.start`).
    await commitSendTurnDispatch({
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
      // A prepared thread already exists server-side, so there is nothing left
      // for the bootstrap to create.
      ...(composer.goal ? { goal: composer.goal } : {}),
      bootstrap: prepared ? undefined : bootstrap,
      sourceControlContexts: freshSourceControlContexts,
      createdAt: messageCreatedAt,
      newCommandId,
      beginLocalDispatch,
      persistThreadSettingsForNextTurn: persistSettingsDeps.persistThreadSettingsForNextTurn,
    });
    turnStartSucceeded = true;
  })().catch(async (err: unknown) => {
    rollbackSendTurn({
      refs,
      composerHandle,
      dispatch: { setOptimisticUserMessages },
      draft,
      messageId: messageIdForSend,
      promptSnapshot: composer.promptForRestore ?? composer.prompt,
      imagesSnapshot,
      terminalContextsSnapshot,
    });
    setThreadError(thread.threadId, err instanceof Error ? err.message : "Failed to send message.");
  });

  refs.sendInFlightRef.current = false;
  if (!turnStartSucceeded) {
    resetLocalDispatch();
  }
}
