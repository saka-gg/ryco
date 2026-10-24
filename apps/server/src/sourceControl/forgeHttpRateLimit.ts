/**
 * What a forge's HTTP response says about rate limits: the failure kind of a
 * status and the retry time its headers name. Also the two typed fields every
 * forge client error carries, so the clients set and copy them one way.
 *
 * The eager Forgejo client reads it, so it is on the server's boot path: keep
 * it small and free of runtime imports. Text matching and the provider error
 * constructor live in the lazily loaded `forgeFailure.ts`.
 */
import type { SourceControlProviderErrorReason } from "@ryco/contracts";

/** GitHub's primary window is one hour; no pause a forge names runs longer than that. */
export const FORGE_MAX_EXPLICIT_PAUSE_MS = 60 * 60_000;

/**
 * The typed part of a forge client error (`GitHubCliError`, `GitLabCliError`,
 * `AzureDevOpsCliError`, `BitbucketApiError`, `ForgejoApiError`).
 */
export interface ForgeFailureFields {
  readonly failureKind?: SourceControlProviderErrorReason;
  /** Epoch ms the forge named for the retry; only with failureKind "rate-limited". */
  readonly retryAt?: number;
}

/**
 * Only the fields that are set, ready to spread into a client error. Callers
 * that wrap a client error in a new one with their own detail pass the wrapped
 * error, so its kind reaches the provider error.
 */
export function forgeFailureFields(source: {
  readonly failureKind?: SourceControlProviderErrorReason | undefined;
  readonly retryAt?: number | undefined;
}): ForgeFailureFields {
  const { failureKind, retryAt } = source;
  if (failureKind === undefined) return {};
  return failureKind === "rate-limited" && retryAt !== undefined
    ? { failureKind, retryAt }
    : { failureKind };
}

/** Response headers by lower-case name (Effect's `Headers` already are). */
export type ForgeHttpHeaders = Readonly<Record<string, string | undefined>>;

const WHOLE_SECONDS = /^\d+$/u;
/** Reset values above this are epoch seconds (2001-09-09); below, a delta in seconds. */
const EPOCH_SECONDS_FLOOR = 1e9;

function headerValue(headers: ForgeHttpHeaders, name: string): string | undefined {
  const value = headers[name]?.trim();
  return value ? value : undefined;
}

/**
 * The quota a `*-reset` header belongs to is spent. GitHub sends
 * `x-ratelimit-reset` (up to an hour away) on every response, also on
 * secondary limits with quota left, so a reset counts only when its
 * `*-remaining` is "0".
 */
function quotaSpent(headers: ForgeHttpHeaders, prefix: "x-ratelimit" | "ratelimit"): boolean {
  return headerValue(headers, `${prefix}-remaining`) === "0";
}

/** `Retry-After`: delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
function retryAfterAt(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  if (WHOLE_SECONDS.test(value)) return nowMs + Number(value) * 1_000;
  // An HTTP-date names a weekday and month; bare numbers like "1.5" are not dates.
  if (!/[a-z]/iu.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** `x-ratelimit-reset` (GitHub, epoch seconds) or `ratelimit-reset` (GitLab; IETF draft: delta). */
function resetAt(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined || !WHOLE_SECONDS.test(value)) return undefined;
  const seconds = Number(value);
  return seconds > EPOCH_SECONDS_FLOOR ? seconds * 1_000 : nowMs + seconds * 1_000;
}

/**
 * The failure kind an HTTP status states: 401 unauthenticated, 404 not-found,
 * 429 rate-limited, and 403 rate-limited when it carries `Retry-After` or a
 * spent quota (GitHub answers primary and secondary limits with 403).
 */
export function forgeFailureKindFromHttp(
  status: number | null | undefined,
  headers: ForgeHttpHeaders = {},
): SourceControlProviderErrorReason | undefined {
  switch (status) {
    case 401:
      return "unauthenticated";
    case 404:
      return "not-found";
    case 429:
      return "rate-limited";
    case 403:
      return headerValue(headers, "retry-after") !== undefined ||
        quotaSpent(headers, "x-ratelimit") ||
        quotaSpent(headers, "ratelimit")
        ? "rate-limited"
        : undefined;
    default:
      return undefined;
  }
}

/**
 * When the host asked to be retried, as whole epoch ms; undefined when it did
 * not say, or the value is unusable or already past. The first usable of
 * `retry-after`, `x-ratelimit-reset` and `ratelimit-reset` wins, each reset only
 * with its quota spent. Clamped to `nowMs + FORGE_MAX_EXPLICIT_PAUSE_MS`.
 */
export function retryAtFromHeaders(headers: ForgeHttpHeaders, nowMs: number): number | undefined {
  const candidates = [
    retryAfterAt(headerValue(headers, "retry-after"), nowMs),
    quotaSpent(headers, "x-ratelimit")
      ? resetAt(headerValue(headers, "x-ratelimit-reset"), nowMs)
      : undefined,
    quotaSpent(headers, "ratelimit")
      ? resetAt(headerValue(headers, "ratelimit-reset"), nowMs)
      : undefined,
  ];
  const at = candidates.find((candidate) => candidate !== undefined && candidate > nowMs);
  // The contract's retryAt is a whole number of ms.
  return at === undefined
    ? undefined
    : Math.ceil(Math.min(at, nowMs + FORGE_MAX_EXPLICIT_PAUSE_MS));
}

/**
 * The typed fields of a failed HTTP response, for the HTTP forge clients:
 * the status's kind and, for a rate limit, the retry time its headers name.
 */
export function forgeHttpFailureFields(
  status: number,
  headers: ForgeHttpHeaders,
  nowMs: number,
): ForgeFailureFields {
  const failureKind = forgeFailureKindFromHttp(status, headers);
  return forgeFailureFields({
    failureKind,
    retryAt: failureKind === "rate-limited" ? retryAtFromHeaders(headers, nowMs) : undefined,
  });
}
