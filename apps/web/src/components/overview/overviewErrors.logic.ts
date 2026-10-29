/**
 * Classification for source-control fetch failures shown in the overview.
 *
 * The provider CLIs surface long, developer-facing errors — e.g. a timeout
 * carries the full `gh pr view 159 --json number,title,…` command. That is
 * useless (and alarming) to a user, so we map errors to short copy and a
 * transient/terminal kind, and keep the raw text only for logging.
 */

import type { SourceControlProviderErrorReason } from "@ryco/contracts";
import {
  describeSourceControlPause,
  readSourceControlFailure,
  readSourceControlPause,
} from "@ryco/shared/sourceControlFailure";

import { sourceControlPauseTimeFormatter } from "../../sourceControlPause";

/** How the overview should treat a source-control fetch failure. */
export type OverviewErrorKind = "transient" | "terminal";

export interface OverviewErrorInfo {
  kind: OverviewErrorKind;
  /** Short, user-facing copy. Never contains the raw command or stack trace. */
  message: string;
  /** Original error text, kept for logging/debugging only — never displayed. */
  raw: string;
  /** The host is rate limiting this account; the message names when requests go out again. */
  paused?: true;
}

export interface OverviewErrorOptions {
  /** Defaults to the current time. */
  readonly nowMs?: number;
  /** Formats the time a rate-limit pause ends (the user's clock format). */
  readonly formatTime: (epochMs: number) => string;
}

function rawErrorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

interface ErrorRule {
  kind: OverviewErrorKind;
  message: string;
  patterns: ReadonlyArray<string>;
  /**
   * The typed reason this rule stands for. An error the server classified
   * matches it by that reason alone: its text includes the command line, so a
   * title or path can contain any of the patterns.
   */
  reason?: SourceControlProviderErrorReason;
}

// First rule whose pattern is found (case-insensitive) wins, so the more
// specific / terminal rules come first.
const ERROR_RULES: ReadonlyArray<ErrorRule> = [
  {
    kind: "terminal",
    reason: "unauthenticated",
    message: "Sign in to your source control provider to load this pull request.",
    patterns: [
      "gh auth",
      "not logged in",
      "authentication",
      "unauthorized",
      "http 401",
      "401",
      "bad credentials",
    ],
  },
  {
    kind: "terminal",
    reason: "not-found",
    message: "This pull request could not be found.",
    patterns: ["could not resolve to a", "not found", "404", "no pull requests found"],
  },
  {
    kind: "transient",
    reason: "rate-limited",
    message: "The source control provider is rate limiting requests. Try again shortly.",
    patterns: ["rate limit"],
  },
  {
    kind: "transient",
    message: "Loading pull request details timed out. Try refreshing.",
    patterns: ["timed out", "timeout", "etimedout", "vcsprocesstimeout"],
  },
  {
    kind: "transient",
    message: "Couldn't reach the source control provider. Try refreshing.",
    patterns: [
      "econnreset",
      "enotfound",
      "eai_again",
      "socket hang up",
      "network",
      "fetch failed",
      "econnrefused",
      "connection refused",
    ],
  },
];

/**
 * Classify a source-control fetch error into short user copy + a
 * transient/terminal kind, or `null` when there is no error. Unknown errors are
 * treated as transient: surfaced once, then kept quiet with a retry affordance,
 * rather than pinned as an unexplained banner. A rate-limit pause reads
 * "GitHub requests paused until 14:32", like every other surface.
 */
export function classifyOverviewError(
  error: unknown,
  options?: OverviewErrorOptions,
): OverviewErrorInfo | null {
  const raw = rawErrorText(error).trim();
  if (raw.length === 0) return null;

  const pause = readSourceControlPause(error);
  if (pause !== null) {
    const { title } = describeSourceControlPause(pause, {
      nowMs: options?.nowMs ?? Date.now(),
      formatTime: options?.formatTime ?? sourceControlPauseTimeFormatter("locale"),
    });
    return { kind: "transient", message: title, raw, paused: true };
  }
  const reason = readSourceControlFailure(error)?.reason ?? null;
  const haystack = raw.toLowerCase();
  for (const rule of ERROR_RULES) {
    if (reason !== null && rule.reason !== undefined) {
      if (rule.reason === reason) return { kind: rule.kind, message: rule.message, raw };
      continue;
    }
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) {
      return { kind: rule.kind, message: rule.message, raw };
    }
  }
  return {
    kind: "transient",
    message: "Couldn't load pull request details. Try refreshing.",
    raw,
  };
}
