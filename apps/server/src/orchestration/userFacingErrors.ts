/**
 * Maps orchestration failure causes to short, bounded text that is safe to
 * show to a user (activity details, `session.lastError`, steer rejections,
 * goal and context-handoff errors).
 *
 * The full cause belongs in the server log, never in user-visible state:
 * callers that swallow a cause log `Cause.pretty(cause)` together with
 * `failureTag(cause)` and display `userFacingFailureDetail(cause)`.
 *
 * Pure module: no services, no I/O.
 */
import { Cause, Schema } from "effect";
import { truncateUnicodeSafe } from "@ryco/shared/String";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  ProviderSessionRepositoryPersistenceError,
  ProviderSessionRepositoryValidationError,
} from "../persistence/Errors.ts";
import {
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderInstanceNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../provider/Errors.ts";

export const USER_FACING_ERROR_MAX_CHARS = 1_000;
export const UNEXPECTED_FAILURE_DETAIL =
  "Ryco hit an unexpected error. Check the server logs for details.";
export const STORAGE_FAILURE_DETAIL =
  "Ryco could not read or save its local state. Try again. If this keeps happening, check the server logs.";

function isStorageError(error: unknown): boolean {
  return (
    Schema.is(PersistenceSqlError)(error) ||
    Schema.is(PersistenceDecodeError)(error) ||
    Schema.is(ProviderSessionRepositoryPersistenceError)(error) ||
    Schema.is(ProviderSessionRepositoryValidationError)(error) ||
    Schema.is(ProviderSessionDirectoryPersistenceError)(error)
  );
}

/**
 * Ordered, first match wins. Guards use real class imports so a renamed or
 * removed error class fails typecheck instead of silently falling through.
 * Extension point: add new user-facing mappings here.
 */
const KNOWN_FAILURES: ReadonlyArray<(error: unknown) => string | undefined> = [
  (e) => (isStorageError(e) ? STORAGE_FAILURE_DETAIL : undefined),
  (e) =>
    Schema.is(ProviderSessionNotFoundError)(e) || Schema.is(ProviderAdapterSessionNotFoundError)(e)
      ? "The provider session is no longer running."
      : undefined,
  (e) =>
    Schema.is(ProviderAdapterSessionClosedError)(e)
      ? "The provider session has closed."
      : undefined,
  (e) =>
    Schema.is(ProviderInstanceNotFoundError)(e)
      ? `Provider instance '${e.instanceId}' is not configured.`
      : undefined,
  (e) =>
    Schema.is(ProviderUnsupportedError)(e)
      ? `Provider '${e.provider}' is not available in this build.`
      : undefined,
  (e) =>
    Schema.is(ProviderAdapterValidationError)(e) || Schema.is(ProviderValidationError)(e)
      ? e.issue
      : undefined,
];

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function describeFailure(error: unknown): string | undefined {
  if (typeof error === "string") {
    return error;
  }
  for (const known of KNOWN_FAILURES) {
    const text = known(error);
    if (text !== undefined) {
      return text;
    }
  }
  // A typed error's `detail` is its user-level description; its `message`
  // usually wraps that detail in internal operation names. A present but
  // empty detail falls back instead of leaking the wrapped message.
  const detail = stringField(error, "detail");
  if (detail !== undefined) {
    return detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return undefined;
}

const STACK_FRAME = /\r?\n\s*at\s/;

function bound(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const frameIndex = text.search(STACK_FRAME);
  const withoutFrames = frameIndex === -1 ? text : text.slice(0, frameIndex);
  const bounded = truncateUnicodeSafe(withoutFrames.trim(), maxChars).trimEnd();
  return bounded.length > 0 ? bounded : undefined;
}

/**
 * Short, non-empty, bounded text for a failure cause. Only the first typed
 * failure is described. Defects and interrupts are internal and map to the
 * fallback; their details belong in the server log.
 */
export function userFacingFailureDetail(
  cause: Cause.Cause<unknown>,
  options?: { readonly fallback?: string; readonly maxChars?: number },
): string {
  const maxChars = options?.maxChars ?? USER_FACING_ERROR_MAX_CHARS;
  const failure = cause.reasons.find(Cause.isFailReason);
  return (
    (failure ? bound(describeFailure(failure.error), maxChars) : undefined) ??
    bound(options?.fallback ?? UNEXPECTED_FAILURE_DETAIL, maxChars) ??
    bound(UNEXPECTED_FAILURE_DETAIL, Math.max(maxChars, 1)) ??
    UNEXPECTED_FAILURE_DETAIL
  );
}

/** Stable, log-safe classifier for a cause: the failure `_tag`, `Error.name`, "defect" or "interrupt". */
export function failureTag(cause: Cause.Cause<unknown>): string {
  const failure = cause.reasons.find(Cause.isFailReason);
  if (failure) {
    const tag = stringField(failure.error, "_tag");
    if (tag !== undefined && tag.length > 0) {
      return tag;
    }
    if (failure.error instanceof Error) {
      return failure.error.name;
    }
    return "unknown";
  }
  if (cause.reasons.some(Cause.isDieReason)) {
    return "defect";
  }
  if (cause.reasons.some(Cause.isInterruptReason)) {
    return "interrupt";
  }
  return "unknown";
}
