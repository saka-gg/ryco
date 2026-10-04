/**
 * Claude usage-limit detection. Rejected rate-limit windows are account-scoped, so the
 * adapter keeps them per session; a result is a durable usage limit only on the CLI's
 * `blocking_limit` terminal reason or an error result while a window is rejected. A bare
 * 429 or `assistant.error: "rate_limit"` stays a transient error.
 *
 * @module claudeUsageLimits
 */
import type { UsageLimitState } from "@ryco/contracts";
import type { SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { isRepresentableEpochMs, usageLimitStateFromWindows } from "../usageLimitReset.ts";

export const CLAUDE_USAGE_LIMIT_FALLBACK_MESSAGE = "Claude usage limit reached.";
const MESSAGE_MAX_LENGTH = 500;

/** Rejected windows by limit type; the value is the reset ISO time, or null when unknown. */
export type ClaudeRejectedRateLimitWindows = Map<string, string | null>;

export interface ClaudeRateLimitTransition {
  readonly blocked: boolean;
  /** Dedupe key for the in-turn warning: one per window and reset. */
  readonly key: string;
  readonly limitType: string;
  readonly resetAt: string | null;
}

function resetIso(resetsAtSeconds: number | undefined): string | null {
  if (resetsAtSeconds === undefined || !Number.isFinite(resetsAtSeconds)) return null;
  const ms = resetsAtSeconds * 1000;
  return isRepresentableEpochMs(ms) ? new Date(ms).toISOString() : null;
}

/** Applies one `rate_limit_event` to the session's rejected windows. */
export function applyClaudeRateLimitInfo(
  windows: ClaudeRejectedRateLimitWindows,
  info: SDKRateLimitInfo,
): ClaudeRateLimitTransition {
  const limitType = info.rateLimitType ?? "unknown";
  const overageAllowed =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true;
  const blocked = info.status === "rejected" && !overageAllowed;
  const resetAt = resetIso(info.resetsAt);
  if (blocked) {
    windows.set(limitType, resetAt);
  } else {
    windows.delete(limitType);
  }
  return { blocked, key: `${limitType}:${info.resetsAt ?? "unknown"}`, limitType, resetAt };
}

/** Current state of the rejected windows; windows whose known reset passed are ignored. */
export function claudeUsageLimitState(
  windows: ClaudeRejectedRateLimitWindows,
  nowMs: number,
): UsageLimitState {
  return usageLimitStateFromWindows(
    [...windows.values()].map((resetAt) => ({
      exhausted: true,
      resetAtMs: resetAt === null ? null : Date.parse(resetAt),
    })),
    nowMs,
  );
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function limitMessage(result: SDKResultMessage): string {
  const raw =
    result.subtype === "success" ? trimmed(result.result) : trimmed(result.errors?.[0] ?? "");
  const message = raw ?? CLAUDE_USAGE_LIMIT_FALLBACK_MESSAGE;
  return message.length > MESSAGE_MAX_LENGTH ? message.slice(0, MESSAGE_MAX_LENGTH) : message;
}

/**
 * Whether a turn's result is a usage-limit stop. Only call it for a result that belongs
 * to an open turn and was not interrupted or cancelled.
 */
export function classifyClaudeUsageLimitResult(input: {
  readonly result: SDKResultMessage;
  readonly windows: ClaudeRejectedRateLimitWindows;
  readonly nowMs: number;
}): { readonly message: string; readonly resetAt: string | null } | null {
  const { result } = input;
  const state = claudeUsageLimitState(input.windows, input.nowMs);
  const terminalReason = result.terminal_reason;
  if (terminalReason === "blocking_limit") {
    return { message: limitMessage(result), resetAt: state.resetAt };
  }
  if (!state.exhausted) return null;
  const resultIsError = result.subtype !== "success" || result.is_error === true;
  if (!resultIsError) return null;
  if (terminalReason !== undefined && terminalReason !== null && terminalReason !== "api_error") {
    return null;
  }
  if (result.subtype === "success") {
    const status = result.api_error_status;
    if (status !== undefined && status !== null && status !== 429) return null;
  }
  return { message: limitMessage(result), resetAt: state.resetAt };
}
