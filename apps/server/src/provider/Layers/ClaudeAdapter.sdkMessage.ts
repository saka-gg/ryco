/**
 * Claude SDK message readers: message kinds, native refs, turn status and text extraction.
 */
import {
  isClaudeAbortTerminalReason,
  isInterruptedResult,
  resultErrorsText,
} from "../claudeSteering.ts";
import type {
  SDKAPIRetryMessage,
  SDKInformationalMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
} from "@ryco/contracts";
import { toolResultBlocksFromUserMessage } from "./ClaudeAdapter.tools.ts";
import type { ClaudeSessionContext, ClaudeTextStreamKind } from "./ClaudeAdapter.types.ts";

export function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

/**
 * The uuid of a main-chain transcript entry (user, assistant, compaction
 * boundary), or undefined for subagent sidechains and non-chain frames.
 */
export function claudeMainChainUuid(message: SDKMessage): string | undefined {
  const isChainEntry =
    message.type === "user" ||
    message.type === "assistant" ||
    (message.type === "system" &&
      (message as { readonly subtype?: unknown }).subtype === "compact_boundary");
  if (!isChainEntry) return undefined;
  const uuid = (message as { readonly uuid?: unknown }).uuid;
  const parentToolUseId = (message as { readonly parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof uuid === "string" &&
    uuid.length > 0 &&
    (parentToolUseId === null || parentToolUseId === undefined)
    ? uuid
    : undefined;
}

/** Only http/https survive; anything else (javascript:, file:, …) is dropped. */
export function sanitizeSessionUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }
  // An abort is never a failure, even when the error text lacks "abort".
  if (isClaudeAbortTerminalReason(result)) {
    return "interrupted";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

export const CLAUDE_API_RETRY_ERROR_LABELS: Partial<Record<SDKAPIRetryMessage["error"], string>> = {
  overloaded: "API overloaded",
  rate_limit: "Rate limited",
  server_error: "API server error",
};

/** `api_retry` as a notice: "Retrying request (2/10) in 4s", detailed by why the attempt failed. */
export function claudeApiRetryNotice(message: SDKAPIRetryMessage): {
  readonly message: string;
  readonly detail: string;
} {
  const attempt = Math.trunc(message.attempt);
  const maxRetries = Math.trunc(message.max_retries);
  const delaySeconds = Math.ceil(message.retry_delay_ms / 1000);
  const waitedSeconds = Math.round((message.no_response?.waited_ms ?? Number.NaN) / 1000);
  const label = CLAUDE_API_RETRY_ERROR_LABELS[message.error];
  const status =
    typeof message.error_status === "number" ? `HTTP ${message.error_status}` : undefined;
  return {
    message: [
      "Retrying request",
      ...(attempt > 0 && maxRetries > 0 ? [`(${attempt}/${maxRetries})`] : []),
      ...(delaySeconds > 0 ? [`in ${delaySeconds}s`] : []),
    ].join(" "),
    detail: Number.isFinite(waitedSeconds)
      ? `No response after ${waitedSeconds}s`
      : status === undefined
        ? "Connection error"
        : label === undefined
          ? status
          : `${label} (${status})`,
  };
}

/** The row label of an `informational` banner; the CLI's own text is the row's body. */
export function claudeInformationalLabel(message: SDKInformationalMessage): string {
  if (message.prevent_continuation === true) {
    return "Claude stopped";
  }
  switch (message.level) {
    case "warning":
      return "Claude warning";
    case "suggestion":
      return "Claude suggestion";
    default:
      return "Claude notice";
  }
}

export const DEBUG_PREVIEW_MAX_CHARS = 400;

/** A frame for a log line: JSON, cut to a few hundred characters. */
export function boundedJsonPreview(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return json.length > DEBUG_PREVIEW_MAX_CHARS
    ? `${json.slice(0, DEBUG_PREVIEW_MAX_CHARS)}…`
    : json;
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

export function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    };
  }
  return {};
}

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

export function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}
