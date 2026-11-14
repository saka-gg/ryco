/**
 * Claude prompt building: user messages, attachments, effort and permission-mode mapping.
 */
import type { PermissionMode, SettingSource, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendAttachmentPathLines } from "@ryco/shared/attachmentPrompt";
import {
  type AgentTokenMode,
  type ChatFileAttachment,
  type ChatImageAttachment,
  ProviderInstanceId,
  type ProviderSendTurnInput,
} from "@ryco/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionStringOptionValue,
  resolvePromptInjectedEffort,
} from "@ryco/shared/model";
import { formatSourceControlContextsForAgent } from "@ryco/shared/sourceControlContextFormatter";
import { isNativeCompactionCommand, NATIVE_COMPACTION_COMMAND } from "@ryco/shared/threadActivity";
import { Effect, FileSystem } from "effect";
import {
  attachmentPathLines,
  isPersistableChatAttachment,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import { buildTokenReductionInstructions, checkRtkAvailability } from "../../tokenReduction.ts";
import { getClaudeModelCapabilities, normalizeClaudeCliEffort } from "./ClaudeProvider.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { toMessage } from "./ClaudeAdapter.errors.ts";
import { type ClaudeSdkEffort, PROVIDER } from "./ClaudeAdapter.types.ts";

export function getEffectiveClaudeAgentEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): ClaudeSdkEffort | null {
  const normalized = normalizeClaudeCliEffort(effort, model);
  return normalized ? (normalized as ClaudeSdkEffort) : null;
}

export function readTokenReductionInstructions(tokenMode: AgentTokenMode) {
  return Effect.promise(() => checkRtkAvailability()).pipe(
    Effect.map((availability) =>
      buildTokenReductionInstructions({
        tokenMode,
        rtkInstalled: availability.installed,
      }),
    ),
  );
}

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const CLAUDE_PDF_MIME_TYPE = "application/pdf";

export const CLAUDE_NATIVE_PDF_MAX_BYTES = 25_000_000;

export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

export function buildPromptText(
  input: ProviderSendTurnInput,
  boundInstanceId: ProviderInstanceId,
): string {
  if (isNativeCompactionCommand(input)) return NATIVE_COMPACTION_COMMAND;
  const rawEffort =
    input.modelSelection?.instanceId === boundInstanceId
      ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
      : null;
  const claudeModel =
    input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;
  const caps = getClaudeModelCapabilities(claudeModel);

  const promptEffort = resolvePromptInjectedEffort(caps, rawEffort);
  const formatted = formatSourceControlContextsForAgent(input.sourceControlContexts ?? []);
  const text = applyClaudePromptEffortPrefix(
    formatted ? formatted + "\n\n" + (input.input?.trim() ?? "") : (input.input?.trim() ?? ""),
    promptEffort,
  );
  return text;
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

export function buildClaudeDocumentContentBlock(input: {
  readonly bytes: Uint8Array;
  readonly title: string;
}): Record<string, unknown> {
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: CLAUDE_PDF_MIME_TYPE,
      data: Buffer.from(input.bytes).toString("base64"),
    },
    title: input.title,
  };
}

export function isClaudeNativeAttachment(
  attachment: ChatImageAttachment | ChatFileAttachment,
): boolean {
  if (attachment.type === "image") {
    return SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType);
  }
  return (
    attachment.mimeType === CLAUDE_PDF_MIME_TYPE &&
    attachment.sizeBytes <= CLAUDE_NATIVE_PDF_MAX_BYTES
  );
}

export const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly boundInstanceId: ProviderInstanceId;
  },
) {
  const promptText = buildPromptText(input, dependencies.boundInstanceId);
  const nativeBlocks: Array<Record<string, unknown>> = [];

  for (const attachment of input.attachments ?? []) {
    if (!isPersistableChatAttachment(attachment) || !isClaudeNativeAttachment(attachment)) {
      continue;
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toMessage(cause, "Failed to read attachment file."),
            cause,
          }),
      ),
    );

    nativeBlocks.push(
      attachment.type === "image"
        ? buildClaudeImageContentBlock({
            mimeType: attachment.mimeType,
            bytes,
          })
        : buildClaudeDocumentContentBlock({
            bytes,
            title: attachment.name,
          }),
    );
  }

  const text = appendAttachmentPathLines(
    promptText,
    attachmentPathLines({
      attachmentsDir: dependencies.attachmentsDir,
      attachments: input.attachments,
    }),
  );
  const sdkContent: Array<Record<string, unknown>> = [];
  if (text !== undefined && text.length > 0) {
    sdkContent.push({ type: "text", text });
  }
  for (const block of nativeBlocks) {
    sdkContent.push(block);
  }

  return buildUserMessage({ sdkContent });
});

/**
 * The SDK permission mode a turn's interaction mode asks for, or undefined to leave the
 * current mode alone. "plan" and "ask" both map to the SDK's read-only "plan" mode;
 * "default" restores the session's own mode.
 */
export function claudePermissionModeForInteraction(
  interactionMode: ProviderSendTurnInput["interactionMode"],
  basePermissionMode: PermissionMode | undefined,
): PermissionMode | undefined {
  if (interactionMode === "plan" || interactionMode === "ask") return "plan";
  if (interactionMode === "default") return basePermissionMode ?? "default";
  return undefined;
}
