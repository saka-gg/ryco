import {
  reviewClaudeResumeBeforeSend,
  revalidateClaudeResumeBeforeCommit,
  type ClaudeCacheReviewPresentation,
} from "./claudeCacheReview.ts";
import type { ComputerTurnIntent } from "@ryco/contracts";
import { rejectRetiredProjectMemory } from "@ryco/shared/retiredFeatures";
import {
  DEFAULT_MODEL,
  type AgentTokenMode,
  CommandId,
  type ProviderDriverKind,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type ThreadGoalUpdate,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@ryco/contracts";
import { buildTemporaryWorktreeBranchName } from "@ryco/shared/git";
import { createModelSelection } from "@ryco/shared/model";
import type { ComposerAttachment } from "../../platform/index.ts";

export interface SendTurnBootstrapInput {
  readonly requireWorktree?: boolean;
  readonly isLocalDraftThread: boolean;
  readonly fetchOrigin?: boolean | undefined;
  readonly runSetupScript?: boolean | undefined;
  readonly worktreeBranchName?: string | null | undefined;
  readonly worktreeBranchPrefix?: string | undefined;
  readonly baseBranchForWorktree: string | null;
  readonly shouldMaterializeLegacyBranchWorktree: boolean;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly title: string;
  readonly threadCreateModelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode: AgentTokenMode;
  readonly activeThreadBranch: string | null;
  readonly worktreePath: string | null;
  readonly threadCreatedAt: string;
}

export type SendTurnBootstrap =
  | {
      readonly requireWorktree?: boolean;
      readonly createThread?: {
        readonly projectId: ProjectId;
        readonly title: string;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly tokenMode: AgentTokenMode;
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly createdAt: string;
      };
      readonly prepareWorktree?: {
        readonly projectCwd: string;
        readonly baseBranch: string;
        readonly fetchOrigin?: boolean;
        readonly branch?: string;
      };
      readonly runSetupScript?: boolean;
    }
  | undefined;

/**
 * Builds the provider-independent command bootstrap. UI concerns (optimistic
 * messages, toasts, focus, preview URLs, and undo presentation) remain in the
 * web caller around this deterministic send-engine step.
 */
export function buildSendTurnBootstrap(input: SendTurnBootstrapInput): SendTurnBootstrap {
  if (input.requireWorktree && (!input.isLocalDraftThread || !input.baseBranchForWorktree)) {
    throw new Error("This launch requires a new thread and an isolated Git worktree.");
  }
  if (!input.isLocalDraftThread && !input.baseBranchForWorktree) return undefined;

  return {
    ...(input.requireWorktree ? { requireWorktree: true } : {}),
    ...(input.isLocalDraftThread
      ? {
          createThread: {
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.threadCreateModelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            tokenMode: input.tokenMode,
            branch: input.activeThreadBranch,
            worktreePath: input.worktreePath,
            createdAt: input.threadCreatedAt,
          },
        }
      : {}),
    ...(input.baseBranchForWorktree
      ? {
          prepareWorktree: {
            projectCwd: input.projectCwd,
            baseBranch: input.baseBranchForWorktree,
            ...(input.fetchOrigin !== undefined ? { fetchOrigin: input.fetchOrigin } : {}),
            ...(input.shouldMaterializeLegacyBranchWorktree
              ? {}
              : {
                  branch:
                    input.worktreeBranchName ||
                    buildTemporaryWorktreeBranchName(input.worktreeBranchPrefix),
                }),
          },
          ...(input.runSetupScript === undefined ? {} : { runSetupScript: input.runSetupScript }),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Send-turn resolution and dispatch assembly
// ---------------------------------------------------------------------------

/** Prompt substituted when a user sends attachments without typed text. */
export const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attachment(s).]";

/** @deprecated Use `ATTACHMENT_ONLY_BOOTSTRAP_PROMPT`. */
export const IMAGE_ONLY_BOOTSTRAP_PROMPT = ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;

/**
 * Resolves the model selection recorded on a freshly created thread's
 * bootstrap: the composer's selection with its slug backfilled from the
 * global default when the composer has no explicit model.
 * Pure — the UI supplies the raw selections.
 */
export function resolveThreadCreateModelSelection(input: {
  readonly selectedModelSelection: ModelSelection;
  readonly selectedModel: string;
  /** @deprecated Project defaults are ignored. */
  readonly defaultModel?: string | null;
}): ModelSelection {
  return createModelSelection(
    input.selectedModelSelection.instanceId,
    input.selectedModel || DEFAULT_MODEL,
    input.selectedModelSelection.options,
  );
}

/** Neutral, already-encoded attachment carried on the outgoing turn message. */
export interface SendTurnDispatchAttachment {
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Inline bytes (images and legacy file attach). */
  readonly dataUrl?: string;
  /** Single-use token for a file already streamed to the server. */
  readonly uploadToken?: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Encodes a neutral composer attachment to the `dataUrl` the outgoing turn
 * message carries. A `bytes`-backed attachment becomes a base64 data URL
 * (byte-identical to `FileReader.readAsDataURL`); a `uri`-backed one passes its
 * uri through. No DOM `File`/`Blob` — the attachment is already neutral.
 */
export function encodeComposerAttachmentDataUrl(attachment: ComposerAttachment): string {
  if ("uri" in attachment) {
    return attachment.uri;
  }
  return `data:${attachment.mime};base64,${bytesToBase64(attachment.bytes)}`;
}

/**
 * Builds the outgoing turn attachment from a neutral `ComposerAttachment` and
 * its filename. This is the attachment-neutral send path: the web boundary
 * encodes `File → ComposerAttachment` via the `AttachmentCodec` and the package
 * consumes only the union fields (`mime`, `size`, `bytes | uri`).
 */
export function buildSendTurnDispatchAttachment(input: {
  readonly attachment: ComposerAttachment;
  readonly name: string;
  readonly type?: "image" | "file";
}): SendTurnDispatchAttachment {
  return {
    type: input.type ?? "image",
    name: input.name,
    mimeType: input.attachment.mime,
    sizeBytes: input.attachment.size,
    dataUrl: encodeComposerAttachmentDataUrl(input.attachment),
  };
}

/**
 * Builds the dispatch attachment for a file whose bytes were already streamed
 * to the server: the dispatch carries the single-use upload token and no
 * inline bytes.
 */
export function buildSendTurnUploadTokenDispatchAttachment(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly uploadToken: string;
}): SendTurnDispatchAttachment {
  return {
    type: "file",
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    uploadToken: input.uploadToken,
  };
}

export interface CommitSendTurnDispatchInput {
  readonly claudeCacheReview?: ClaudeCacheReviewPresentation;
  readonly providerDriver?: ProviderDriverKind | null;
  /** Known source session; null means no session, undefined means unavailable. */
  readonly sourceProviderDriver?: ProviderDriverKind | null | undefined;
  readonly assertMutationReady?: () => void;
  readonly computerUse?: ComputerTurnIntent;
  readonly api: EnvironmentApi;
  readonly threadId: ThreadId;
  readonly isFirstMessage: boolean;
  readonly isServerThread: boolean;
  readonly title: string;
  readonly messageId: MessageId;
  readonly outgoingMessageText: string;
  readonly turnAttachments: readonly SendTurnDispatchAttachment[];
  /** The composer's staged target, committed atomically by `thread.turn.start`. */
  readonly modelSelection: ModelSelection;
  /** @deprecated Accepted for source compatibility; model persistence is intentionally ignored. */
  readonly hasSelectedModel?: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode: AgentTokenMode;
  readonly goal?: ThreadGoalUpdate;
  readonly bootstrap: SendTurnBootstrap;
  readonly sourceControlContexts: readonly ComposerSourceControlContext[];
  readonly createdAt: string;
  readonly newCommandId: () => CommandId;
  readonly beginLocalDispatch: (options: { readonly preparingWorktree: boolean }) => void;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
    tokenMode: AgentTokenMode;
  }) => Promise<void>;
}

/**
 * Provider-independent dispatch assembly over `EnvironmentApi`: the ordered
 * server writes that commit a send turn — the first-message title update, the
 * next-turn settings persistence, and the `thread.turn.start` command. UI
 * concerns (optimistic messages, toasts, focus, the undo window, preview URLs)
 * remain in the web caller, which invokes this only once the turn commits.
 */
const pendingSends = new WeakMap<EnvironmentApi, Map<MessageId, Promise<void>>>();
export function commitSendTurnDispatch(input: CommitSendTurnDispatchInput): Promise<void> {
  let sends = pendingSends.get(input.api);
  if (!sends) {
    sends = new Map();
    pendingSends.set(input.api, sends);
  }
  const pending = sends.get(input.messageId);
  if (pending) return pending;
  const result = commitSendTurnDispatchOnce(input).finally(() => sends.delete(input.messageId));
  sends.set(input.messageId, result);
  return result;
}

async function commitSendTurnDispatchOnce(input: CommitSendTurnDispatchInput): Promise<void> {
  rejectRetiredProjectMemory(input);
  const reviewed = await reviewClaudeResumeBeforeSend(input);
  // Server-side writes derived from this message must only run once the send
  // commits; otherwise an undone first send leaves orphan title/settings.
  if (input.isFirstMessage && input.isServerThread) {
    await input.api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: input.newCommandId(),
      threadId: input.threadId,
      title: input.title,
    });
  }

  if (input.isServerThread) {
    await input.persistThreadSettingsForNextTurn({
      threadId: input.threadId,
      createdAt: input.createdAt,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      tokenMode: input.tokenMode,
    });
  }

  if (reviewed) {
    await revalidateClaudeResumeBeforeCommit(input, reviewed.guard);
  }
  if (reviewed || input.bootstrap?.requireWorktree) input.assertMutationReady?.();
  input.beginLocalDispatch({ preparingWorktree: false });
  await input.api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    ...(input.computerUse ? { computerUse: input.computerUse } : {}),
    commandId: CommandId.make(`composer-send:${input.threadId}:${input.messageId}`),
    ...(reviewed ? { claudeResumeGuard: reviewed.guard } : {}),
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.outgoingMessageText,
      attachments: input.turnAttachments,
    },
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    tokenMode: input.tokenMode,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    ...(input.sourceControlContexts.length > 0
      ? { sourceControlContexts: input.sourceControlContexts }
      : {}),
    createdAt: input.createdAt,
  });
}
