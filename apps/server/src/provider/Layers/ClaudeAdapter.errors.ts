/**
 * Claude adapter error mapping: SDK/CLI causes to typed adapter errors and user-facing text.
 */
import { getActiveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import { appendClaudeStderrTail } from "../claudeCodeSpawn.ts";
import type { ClaudeTurnCloseCause } from "../claudeSteering.ts";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@ryco/contracts";
import { findServerProviderModel } from "@ryco/shared/serverProviderModels";
import { Cause } from "effect";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  type ClaudeSessionContext,
  FOLDED_INTO_DISCARDED_STEER_REASON,
  PROVIDER,
} from "./ClaudeAdapter.types.ts";

export function claudeAutoModeRefusedMessage(model: string | undefined): string {
  const catalogModels = getActiveClaudeModelCatalog().models.map((entry) => entry.model);
  const name = findServerProviderModel(catalogModels, model)?.name ?? model ?? "the selected model";
  return `Claude Code reports that ${name} can't run in Auto mode, so this session asks before commands and file changes.`;
}

/** An SDK exit error with the stderr tail the SDK adds only for its own spawn (see claudeCodeSpawn). */
export function withClaudeProcessStderr<A>(
  context: Pick<ClaudeSessionContext, "processStderrTail">,
  cause: A,
): A {
  return context.processStderrTail
    ? appendClaudeStderrTail(cause, context.processStderrTail())
    : cause;
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

/** A typed adapter error's user-level text: its `detail` or `issue`, not its prefixed message. */
export function adapterFailureDetail(error: { readonly message: string }): string {
  const fields = error as { readonly detail?: unknown; readonly issue?: unknown };
  for (const value of [fields.detail, fields.issue]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return error.message;
}

export function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

export function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

export function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

export function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

export function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

export function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

/** The error a completing turn reports, by why it reports its status (`decideClaudeTurnClose`). */
export function claudeTurnCloseErrorMessage(
  cause: ClaudeTurnCloseCause,
  result: SDKResultMessage,
): string | undefined {
  switch (cause) {
    case "result":
      return result.subtype === "success" ? undefined : result.errors[0];
    case "aborted-by-steer":
      return undefined;
    case "stopped":
      return "Interrupted by user.";
    case "failed-segment-dropped-steers": {
      // A success flagged as an error carries the error text as its result.
      const text = result.subtype === "success" ? result.result.trim() : result.errors[0];
      return text !== undefined && text.length > 0 ? text : "Claude turn failed.";
    }
    case "folded-into-discarded-cli-turn":
      return FOLDED_INTO_DISCARDED_STEER_REASON;
  }
}

/**
 * The SDK's own "this session is gone" messages: `Session <id> not found`, "unknown session",
 * "Query closed before …" and "Transport is closed". Everything else (a missing model, file or
 * executable, a peer closing a connection) is an ordinary request failure.
 */
export const CLAUDE_SESSION_NOT_FOUND = /\bunknown session\b|\bsession\b[^.:]*\bnot found\b/;

export const CLAUDE_SESSION_CLOSED =
  /\bquery closed\b|\btransport is closed\b|\bsession (?:is )?closed\b/;

/**
 * Classifies a Claude SDK failure as a gone session. Callers pass the SDK's error before any stderr
 * tail is appended (see {@link toSessionRequestError}): CLI stderr is free text and must not turn
 * a request failure into a session-gone one.
 */
export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (CLAUDE_SESSION_NOT_FOUND.test(normalized)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (CLAUDE_SESSION_CLOSED.test(normalized)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  return toSessionError(threadId, cause) ?? toPlainRequestError(method, cause);
}

export function toPlainRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

/**
 * {@link toRequestError} for an SDK call on a live session. When the CLI exits, the SDK rejects
 * every pending call with its exit error; this restores the stderr tail on it (see
 * {@link withClaudeProcessStderr}), so the text matches the SDK's own spawn. The session-gone
 * classification reads the SDK's message from before the tail is added.
 */
export function toSessionRequestError(
  context: Pick<ClaudeSessionContext, "processStderrTail">,
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  const withStderr = withClaudeProcessStderr(context, cause);
  return sessionError ?? toPlainRequestError(method, withStderr);
}
