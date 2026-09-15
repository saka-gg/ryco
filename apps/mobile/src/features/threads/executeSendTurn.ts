import type { ProjectMemoryRecallInput } from "@ryco/contracts";
import type {
  AgentTokenMode,
  EnvironmentApi,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@ryco/contracts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  buildSendTurnBootstrap,
  buildSendTurnDispatchAttachment,
  buildSendTurnUploadTokenDispatchAttachment,
  commitSendTurnDispatch,
  isFileUploadTokenUsable,
  resolveThreadCreateModelSelection,
} from "@ryco/client-runtime/state/composer";

import { mobileAttachmentCodec } from "../../platform/attachmentCodec";
import { newCommandId, newMessageId } from "../../lib/ids";
import type { DraftComposerAttachment } from "../../lib/composerFiles";
import { isDraftComposerFileAttachment } from "../../lib/composerFiles";

// §2.3 pt5 / send pipeline. Mirrors apps/web/src/hooks/executeChatSendTurn.ts but
// omits the web-only pieces (blob revocation, undo window, ChatComposerHandle
// cursor, toasts, terminal/source-control contexts). The ordered server writes
// (thread.meta.update on the first server-thread message → next-turn settings →
// thread.turn.start) stay in the runtime's commitSendTurnDispatch — no forked
// send logic. persistThreadSettingsForNextTurn is a no-op for the MVP (§3-13).

export interface ExecuteSendTurnInput {
  readonly projectMemory?: ProjectMemoryRecallInput;
  readonly api: EnvironmentApi;
  readonly thread: {
    readonly threadId: ThreadId;
    readonly isFirstMessage: boolean;
    readonly isServerThread: boolean;
    readonly isLocalDraftThread: boolean;
    readonly activeThreadBranch: string | null;
    readonly worktreePath: string | null;
    readonly createdAt: string;
  };
  readonly composer: {
    readonly prompt: string;
    readonly images: ReadonlyArray<DraftComposerAttachment>;
    readonly selectedModelSelection: ModelSelection;
    readonly selectedModel: string;
    readonly hasSelectedModel: boolean;
  };
  readonly project: {
    readonly projectId: ProjectId;
    readonly projectCwd: string;
  };
  readonly settings: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly tokenMode: AgentTokenMode;
  };
  readonly title: string;
  /** Optimistically clears the composer draft before dispatch. */
  readonly clearDraft: () => void;
  /** Restores the snapshotted prompt + images if the dispatch fails. */
  readonly restoreDraft: (input: {
    readonly prompt: string;
    readonly images: ReadonlyArray<DraftComposerAttachment>;
  }) => void;
  readonly setThreadError: (threadId: ThreadId, error: string | null) => void;
  readonly beginLocalDispatch?: (options: { readonly preparingWorktree: boolean }) => void;
}

/**
 * Returns true when the turn was dispatched, false when it failed (the caller —
 * e.g. the composer — must keep the user's input on false; web
 * executeChatSendTurn restores the prompt via rollbackSendTurn on failure).
 */
export async function executeSendTurn(input: ExecuteSendTurnInput): Promise<boolean> {
  const promptSnapshot = input.composer.prompt;
  const imagesSnapshot = [...input.composer.images];
  const messageId = newMessageId();
  const createdAt = new Date().toISOString();
  const outgoingMessageText = promptSnapshot.trim() || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;

  try {
    // Attachment-neutral send path: encode each RN uri/bytes to the outgoing
    // turn attachment (no DOM File). Uploaded streamed files dispatch by
    // single-use token; images keep the dataUrl path.
    const turnAttachments = await Promise.all(
      imagesSnapshot.map(async (attachment) => {
        if (isDraftComposerFileAttachment(attachment)) {
          if (
            attachment.uploadToken === undefined ||
            (attachment.expiresAt !== undefined &&
              !isFileUploadTokenUsable(attachment.expiresAt, Date.now()))
          ) {
            throw new Error(`Attach '${attachment.name}' again to send this message.`);
          }
          return buildSendTurnUploadTokenDispatchAttachment({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            uploadToken: attachment.uploadToken,
          });
        }
        return buildSendTurnDispatchAttachment({
          attachment: await mobileAttachmentCodec.encode({
            id: attachment.id,
            mime: attachment.mimeType,
            size: attachment.sizeBytes,
            // The runtime attachment pipeline expects the outgoing data URL,
            // not the image-picker preview file URI.
            uri: attachment.dataUrl,
          }),
          name: attachment.name,
        });
      }),
    );

    // Optimistic: clear the draft now; on failure it is restored below.
    input.clearDraft();
    input.setThreadError(input.thread.threadId, null);

    const threadCreateModelSelection = resolveThreadCreateModelSelection({
      selectedModelSelection: input.composer.selectedModelSelection,
      selectedModel: input.composer.selectedModel,
    });

    const bootstrap = buildSendTurnBootstrap({
      isLocalDraftThread: input.thread.isLocalDraftThread,
      // Existing task sends keep their server-owned worktree context; worktree
      // creation itself is handled by the New Task / Project workflows.
      baseBranchForWorktree: null,
      shouldMaterializeLegacyBranchWorktree: false,
      projectId: input.project.projectId,
      projectCwd: input.project.projectCwd,
      title: input.title,
      threadCreateModelSelection,
      runtimeMode: input.settings.runtimeMode,
      interactionMode: input.settings.interactionMode,
      tokenMode: input.settings.tokenMode,
      activeThreadBranch: input.thread.activeThreadBranch,
      worktreePath: input.thread.worktreePath,
      threadCreatedAt: input.thread.createdAt,
    });

    await commitSendTurnDispatch({
      api: input.api,
      threadId: input.thread.threadId,
      isFirstMessage: input.thread.isFirstMessage,
      isServerThread: input.thread.isServerThread,
      title: input.title,
      messageId,
      outgoingMessageText,
      turnAttachments,
      modelSelection: input.composer.selectedModelSelection,
      hasSelectedModel: input.composer.hasSelectedModel,
      runtimeMode: input.settings.runtimeMode,
      interactionMode: input.settings.interactionMode,
      tokenMode: input.settings.tokenMode,
      bootstrap,
      sourceControlContexts: [],
      ...(input.projectMemory ? { projectMemory: input.projectMemory } : {}),
      createdAt,
      newCommandId,
      beginLocalDispatch: input.beginLocalDispatch ?? (() => {}),
      // Per-thread next-turn settings persistence is deferred (§3-13).
      persistThreadSettingsForNextTurn: () => Promise.resolve(),
    });
    return true;
  } catch (error) {
    input.restoreDraft({ prompt: promptSnapshot, images: imagesSnapshot });
    input.setThreadError(
      input.thread.threadId,
      error instanceof Error ? error.message : "Failed to send message.",
    );
    return false;
  }
}
