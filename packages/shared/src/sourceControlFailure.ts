import type { SourceControlProviderErrorReason, SourceControlProviderKind } from "@ryco/contracts";

import { resolveChangeRequestPresentationForKind } from "./sourceControl.ts";

/**
 * Failed forge calls as clients and the server read them: the typed reason and
 * retry time of a `SourceControlProviderError`, and the one wording every
 * client surface (web and mobile) shows for a rate-limit pause. A module of its
 * own, so the web's boot bundle, which loads `./sourceControl` for the git
 * status stream, does not carry it.
 */

/** What a failed forge call says about itself (`SourceControlProviderError`). */
export interface SourceControlFailureInfo {
  readonly provider: SourceControlProviderKind;
  /**
   * Null only from a server that predates the field: newer servers send "failed" for a
   * failure they could not classify.
   */
  readonly reason: SourceControlProviderErrorReason | null;
  /** Epoch ms when the host accepts requests again; null when not given. */
  readonly retryAt: number | null;
}

// Checked against the contract's literals, so a new kind or reason cannot be missed here.
const SOURCE_CONTROL_PROVIDER_KINDS = {
  github: true,
  gitlab: true,
  forgejo: true,
  "azure-devops": true,
  bitbucket: true,
  unknown: true,
} as const satisfies Record<SourceControlProviderKind, true>;

const SOURCE_CONTROL_PROVIDER_ERROR_REASONS = {
  "missing-tool": true,
  unauthenticated: true,
  "rate-limited": true,
  "not-found": true,
  failed: true,
} as const satisfies Record<SourceControlProviderErrorReason, true>;

function isSourceControlProviderKind(value: unknown): value is SourceControlProviderKind {
  return typeof value === "string" && Object.hasOwn(SOURCE_CONTROL_PROVIDER_KINDS, value);
}

function isSourceControlProviderErrorReason(
  value: unknown,
): value is SourceControlProviderErrorReason {
  return typeof value === "string" && Object.hasOwn(SOURCE_CONTROL_PROVIDER_ERROR_REASONS, value);
}

/**
 * Reads a `SourceControlProviderError` structurally, whether decoded from the
 * wire or raised on the server; null for anything else. Fields with an
 * unexpected type read as absent.
 */
export function readSourceControlFailure(error: unknown): SourceControlFailureInfo | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as {
    readonly _tag?: unknown;
    readonly provider?: unknown;
    readonly reason?: unknown;
    readonly retryAt?: unknown;
  };
  if (record._tag !== "SourceControlProviderError") return null;
  const retryAt = record.retryAt;
  return {
    provider: isSourceControlProviderKind(record.provider) ? record.provider : "unknown",
    reason: isSourceControlProviderErrorReason(record.reason) ? record.reason : null,
    retryAt:
      typeof retryAt === "number" && Number.isSafeInteger(retryAt) && retryAt >= 0 ? retryAt : null,
  };
}

/** True for a `SourceControlProviderError` with reason "rate-limited". */
export function isRateLimitedSourceControlFailure(error: unknown): boolean {
  return readSourceControlFailure(error)?.reason === "rate-limited";
}

// ── Rate-limit pauses ────────────────────────────────────────────────

/** A forge host that is rate limiting this account, as a failed read reports it. */
export interface SourceControlPause {
  readonly provider: SourceControlProviderKind;
  /** Epoch ms when requests go out again; null when the server did not say. */
  readonly retryAt: number | null;
}

/** The longest a client waits for a pause before reading again (the server's longest guessed pause). */
export const SOURCE_CONTROL_PAUSE_MAX_RETRY_DELAY_MS = 15 * 60_000;

/**
 * The pause a failed read reports, from the typed reason: only "rate-limited"
 * is a pause. A server that predates the field (no reason at all) counts as
 * paused when its detail says "rate limit"; a newer server always sends a
 * reason, so a path or title in its detail never reads as one.
 */
export function readSourceControlPause(error: unknown): SourceControlPause | null {
  const failure = readSourceControlFailure(error);
  if (failure === null) return null;
  if (failure.reason === "rate-limited") {
    return { provider: failure.provider, retryAt: failure.retryAt };
  }
  if (failure.reason !== null) return null;
  const detail = (error as { readonly detail?: unknown }).detail;
  return typeof detail === "string" && detail.toLowerCase().includes("rate limit")
    ? { provider: failure.provider, retryAt: null }
    : null;
}

/**
 * The one wording every surface shows for a pause: "GitHub requests paused
 * until 14:32", or without a time when none is known or it has passed.
 */
export function describeSourceControlPause(
  pause: SourceControlPause,
  options: { readonly nowMs: number; readonly formatTime: (epochMs: number) => string },
): { readonly title: string; readonly detail: string } {
  const known = pause.provider !== "unknown";
  const name = known
    ? resolveChangeRequestPresentationForKind(pause.provider).providerName
    : "Source control";
  const who = known ? name : "The source control provider";
  const until = pause.retryAt !== null && pause.retryAt > options.nowMs ? pause.retryAt : null;
  return until === null
    ? {
        title: `${name} requests paused`,
        detail: `${who} is rate limiting this account. Ryco tries again shortly.`,
      }
    : {
        title: `${name} requests paused until ${options.formatTime(until)}`,
        detail: `${who} is rate limiting this account. Ryco tries again then.`,
      };
}

/**
 * How long a poller waits after a failed read: until the pause ends, up to
 * 15 min; null when the error is not a pause with a known end. The wait is at
 * least 1 s, doubling with each failed read in a row, so an end that already
 * passed (an answer the server still holds, or a clock ahead of the node's)
 * backs off instead of reading every second.
 */
export function sourceControlPauseRetryDelayMs(
  error: unknown,
  nowMs: number,
  consecutiveFailures = 1,
): number | null {
  const retryAt = readSourceControlPause(error)?.retryAt ?? null;
  if (retryAt === null) return null;
  const doublings = Math.max(0, Math.min(10, Math.floor(consecutiveFailures) - 1));
  const minimumMs = 1_000 * 2 ** doublings;
  return Math.min(SOURCE_CONTROL_PAUSE_MAX_RETRY_DELAY_MS, Math.max(minimumMs, retryAt - nowMs));
}
