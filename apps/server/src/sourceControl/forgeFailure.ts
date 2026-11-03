/**
 * Classifying a failed forge call: what the forge or its CLI said, whether that
 * was a rate limit, and the provider error that carries the kind to clients.
 *
 * Loaded with the forge clients and providers (all behind `import()`), never on
 * the boot path. The HTTP status and header helpers the eager Forgejo client
 * needs live in `forgeHttpRateLimit.ts`.
 */
import {
  SourceControlProviderError,
  type SourceControlProviderErrorReason,
  type SourceControlProviderKind,
} from "@ryco/contracts";

import { forgeFailureFields } from "./forgeHttpRateLimit.ts";

export type ForgeFailureKind = SourceControlProviderErrorReason;

/**
 * What the forge or its CLI said, without the command line or cwd a process
 * error carries (`VcsProcessExitError.message` holds both, and pull request
 * titles, branch names and folder names travel in them). Classify failures on
 * this text only.
 *
 * - `VcsProcessExitError`: its `detail` (stderr), but "" when stderr was empty
 *   and VcsProcess filled in `<command line> exited with code N.`.
 * - Other tagged errors (spawn, timeout, output decode, client errors): "".
 *   Their text is Ryco's own, or holds the command line.
 * - `{ detail: string }` (a `gh api` failure's stderr and response body): `detail`.
 * - A string: itself.
 *
 * Status lines, which can hold a title, are dropped: `gh pr close --delete-branch`
 * prints `✓ Closed pull request o/r#12 (<title>)` before the cleanup that fails,
 * and on a merged pull request `X Pull request o/r#12 (<title>) can't be closed
 * because it was already merged`.
 */
export function forgeFailureText(error: unknown): string {
  return withoutStatusLines(rawForgeFailureText(error));
}

function rawForgeFailureText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as {
    readonly _tag?: unknown;
    readonly detail?: unknown;
    readonly command?: unknown;
    readonly exitCode?: unknown;
  };
  if (record._tag === "VcsProcessExitError") {
    if (typeof record.detail !== "string") return "";
    // Exactly the line VcsProcess writes for an empty stderr (pinned by forgeFailure.test.ts).
    const filledIn = `${String(record.command)} exited with code ${String(record.exitCode)}.`;
    return record.detail === filledIn ? "" : record.detail;
  }
  if (record._tag !== undefined) return "";
  return typeof record.detail === "string" ? record.detail : "";
}

/**
 * gh and glab mark a step that went through with "✓", and gh one that failed
 * with "X" and a warning with "!"; such a line can echo a title.
 */
const STATUS_LINE = /^\s*(?:✓|[X!](?:\s|$))/u;

function withoutStatusLines(text: string): string {
  if (!/[✓X!]/u.test(text)) return text;
  return text
    .split("\n")
    .filter((line) => !STATUS_LINE.test(line))
    .join("\n");
}

// Each phrase holds a space or a colon, which branch and repository names cannot:
// gh, glab and az echo those names in their errors.
const RATE_LIMIT_PHRASES = [
  "api rate limit",
  "secondary rate limit",
  "rate limit exceeded",
  "rate limit already exceeded",
  "abuse detection mechanism",
  "too many requests",
  "http 429",
  "status code 429",
  " (429)",
  // Azure DevOps: "TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource …"
  "tf400733:",
];

/**
 * GitHub's primary, secondary and abuse limits, HTTP 429, GitLab's "Too Many
 * Requests" and Azure DevOps' TF400733, by phrase. Never a bare "429" (an MR
 * number) or "ratelimit" (GraphQL `rateLimit` fields). Pass `forgeFailureText`,
 * never a message that holds the command line.
 */
export function isForgeRateLimitText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    RATE_LIMIT_PHRASES.some((phrase) => lower.includes(phrase)) ||
    (lower.includes("http 403") && lower.includes("rate limit"))
  );
}

/**
 * The CLI binary is not installed: a spawn error whose cause is the spawner's
 * ENOENT from `ChildProcess.spawn`. A missing cwd fails earlier (in
 * `FileSystem.access`), and other spawn failures (too many open files, no
 * permission) are not a missing tool.
 */
export function isMissingToolSpawnError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const spawn = error as { readonly _tag?: unknown; readonly cause?: unknown };
  if (spawn._tag !== "VcsProcessSpawnError") return false;
  const cause = spawn.cause as { readonly reason?: unknown } | null | undefined;
  const reason = cause?.reason as
    | { readonly _tag?: unknown; readonly module?: unknown }
    | null
    | undefined;
  return reason?._tag === "NotFound" && reason.module === "ChildProcess";
}

type LowerTextMatcher = (lower: string) => boolean;

/**
 * Typed kinds for a failed CLI call, read only from what the forge or its CLI
 * said (`forgeFailureText`). The CLI normalizers keep matching their detail
 * strings on the whole error text, command line included; the kind they attach
 * comes from here, so a title, branch or folder name never becomes one.
 */
export interface ForgeFailureClassifier {
  /** The forge reported a rate limit. Check it before sign-in rules, which match loosely. */
  readonly rateLimited: boolean;
  /** `kind` when `matches` holds for the forge's own lower-cased text. */
  readonly kindIf: (
    kind: ForgeFailureKind,
    matches: LowerTextMatcher,
  ) => ForgeFailureKind | undefined;
  /** "missing-tool" for a spawn that found no binary, or when the forge's text `matches`. */
  readonly missingToolIf: (matches: LowerTextMatcher) => ForgeFailureKind | undefined;
}

export function classifyForgeFailure(error: unknown): ForgeFailureClassifier {
  const forgeLower = forgeFailureText(error).toLowerCase();
  const missingBinary = isMissingToolSpawnError(error);
  return {
    rateLimited: isForgeRateLimitText(forgeLower),
    kindIf: (kind, matches) => (matches(forgeLower) ? kind : undefined),
    missingToolIf: (matches) => (missingBinary || matches(forgeLower) ? "missing-tool" : undefined),
  };
}

/** A forge client's error, as every provider's `providerError` receives it. */
export interface ForgeClientFailure {
  readonly detail: string;
  readonly failureKind?: ForgeFailureKind | undefined;
  /** Epoch ms the forge named for the retry; kept for "rate-limited" only. */
  readonly retryAt?: number | undefined;
}

/**
 * The provider error for a failed client call: the client's detail, its
 * failure kind as `reason`, and for a rate limit the retry time (rounded up to
 * whole ms, as the contract requires).
 */
export function sourceControlProviderErrorFrom(
  provider: SourceControlProviderKind,
  operation: string,
  cause: ForgeClientFailure,
): SourceControlProviderError {
  const { failureKind, retryAt: namedRetryAt } = forgeFailureFields(cause);
  const retryAt =
    namedRetryAt !== undefined && Number.isFinite(namedRetryAt) && namedRetryAt >= 0
      ? Math.ceil(namedRetryAt)
      : undefined;
  return new SourceControlProviderError({
    provider,
    operation,
    detail: cause.detail,
    ...(failureKind !== undefined ? { reason: failureKind } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    cause,
  });
}
