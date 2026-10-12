/**
 * Pure decoding of CLIProxyAPI management responses and the upstream quota payloads read
 * through its `api-call` passthrough. Hub responses are treated as untrusted: every field is
 * checked, unknown fields are dropped, and raw upstream API keys never leave this module.
 *
 * @module cliProxy/cliProxyParsing
 */
import type {
  CliProxyAccount,
  CliProxyAccountCredits,
  CliProxyApiKeyUsage,
  CliProxyCooldown,
  CliProxyQuotaWindow,
  CliProxyRequestBucket,
  CliProxyRequestCounts,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@ryco/contracts";
import { isLoopbackHost, normalizeHubBaseUrl } from "@ryco/shared/cliProxyHubUrl";

const FIVE_HOUR_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MAX_TEXT_CHARS = 500;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A trimmed, non-empty string capped for display. Contract fields reject surrounding
 * whitespace, so a cut that lands on whitespace is trimmed again.
 */
export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS).trimEnd() : trimmed;
}

/** `value` as `text` shapes it, or `fallback` when nothing is left. */
export function displayText(value: string, fallback: string): string {
  return text(value) ?? fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? Math.floor(number) : 0;
}

function isoTime(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  // Go serializes unset times as year 1; treat anything before 2000 as absent.
  return Number.isFinite(parsed) && parsed > 946_684_800_000
    ? new Date(parsed).toISOString()
    : undefined;
}

/** The latest of several hub timestamps, ignoring absent and Go zero times. */
function latestIsoTime(values: ReadonlyArray<unknown>): string | undefined {
  let latest: string | undefined;
  for (const value of values) {
    const iso = isoTime(value);
    if (iso !== undefined && (latest === undefined || iso > latest)) latest = iso;
  }
  return latest;
}

function epochSecondsFromIso(value: unknown): number | undefined {
  const iso = isoTime(value);
  return iso === undefined ? undefined : Math.floor(Date.parse(iso) / 1000);
}

// ── Hub URL ─────────────────────────────────────────────────────────

export const INVALID_HUB_URL_MESSAGE =
  "The hub URL must be an http:// or https:// address without a user name or password.";

/**
 * A hub address in a form two configurations can be compared by: loopback hosts are
 * interchangeable and the hub's `/v1` API root is dropped, so `http://127.0.0.1:8317/v1` and
 * `http://localhost:8317` name the same hub.
 */
function hubRouteKey(raw: string): string | null {
  const baseUrl = normalizeHubBaseUrl(raw);
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  if (isLoopbackHost(url.hostname)) url.hostname = "localhost";
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/v1$/i, "").replace(/\/+$/, "")}`;
}

/**
 * The host a hub counts this node's rejected management keys under. The hub counts per client
 * IP, so every hub path and loopback alias on one host shares the count.
 */
export function hubAuthAddress(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (isLoopbackHost(url.hostname)) url.hostname = "localhost";
  return url.host;
}

/** Claude instances whose `ANTHROPIC_BASE_URL` points at the hub. */
export function routedInstanceIds(
  hubBaseUrl: string,
  instances: ProviderInstanceConfigMap,
): ProviderInstanceId[] {
  const hubKey = hubRouteKey(hubBaseUrl);
  if (hubKey === null) return [];
  const routed: ProviderInstanceId[] = [];
  for (const [instanceId, instance] of Object.entries(instances)) {
    if (instance.driver !== "claudeAgent") continue;
    // The provider process sees the last definition of a repeated variable.
    const baseUrl = instance.environment?.findLast(
      (variable) => variable.name === "ANTHROPIC_BASE_URL",
    )?.value;
    if (baseUrl !== undefined && hubRouteKey(baseUrl) === hubKey) {
      routed.push(instanceId as ProviderInstanceId);
    }
  }
  return routed;
}

/** Display label for a hub without one: its host. */
export function hubHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// ── Request counters ────────────────────────────────────────────────

function parseRequestBuckets(value: unknown): CliProxyRequestBucket[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const bucket = record(raw);
    if (!bucket) return [];
    return [
      {
        label: text(bucket.time) ?? "",
        success: count(bucket.success),
        failed: count(bucket.failed),
      },
    ];
  });
}

export function parseRequestCounts(source: Record<string, unknown>): CliProxyRequestCounts {
  return {
    success: count(source.success),
    failed: count(source.failed),
    recent: parseRequestBuckets(source.recent_requests),
  };
}

// ── Accounts (`GET /credentials`, legacy `/auth-files`) ─────────────

export interface HubAccountRecord {
  readonly account: Omit<CliProxyAccount, "quota">;
  /** Google Cloud project, needed for Antigravity quota. */
  readonly projectId?: string;
  /** ChatGPT workspace the Codex credential belongs to. */
  readonly chatgptAccountId?: string;
  /** Plan claimed by the Codex id token; the live usage response wins when present. */
  readonly tokenPlanType?: string;
}

function parseCooldowns(value: unknown): CliProxyCooldown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const cooldown = record(raw);
    const scope = text(cooldown?.scope);
    if (!cooldown || scope === undefined) return [];
    const model = text(cooldown.model_key);
    const reason = text(cooldown.reason);
    const retryAt = isoTime(cooldown.retry_at);
    const httpStatus = count(cooldown.http_status);
    return [
      {
        scope,
        ...(model !== undefined ? { model } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(retryAt !== undefined ? { retryAt } : {}),
        ...(httpStatus > 0 ? { httpStatus } : {}),
      },
    ];
  });
}

/**
 * Subscription (OAuth) accounts from the credential list. API-key credentials are skipped:
 * their `account` field is the raw key, and their counters arrive keyed per key from
 * `/observability/usage/api-keys`.
 */
export function parseHubAccounts(data: unknown): HubAccountRecord[] {
  const files = record(data)?.files;
  if (!Array.isArray(files)) return [];
  const accounts: HubAccountRecord[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    const file = record(raw);
    if (!file) continue;
    const authIndex = text(file.auth_index);
    const provider = text(file.provider)?.toLowerCase() ?? text(file.type)?.toLowerCase();
    if (authIndex === undefined || provider === undefined || seen.has(authIndex)) continue;
    if (text(file.account_type)?.toLowerCase() === "api_key") continue;
    seen.add(authIndex);
    const name = text(file.name) ?? text(file.id) ?? authIndex;
    const label = text(file.label);
    const email = text(file.email);
    const statusMessage = text(file.status_message);
    const nextRetryAt = isoTime(file.next_retry_after);
    const lastUsedAt = latestIsoTime([
      record(file.quota)?.observed_at,
      ...Object.values(record(file.model_quotas) ?? {}).map((quota) => record(quota)?.observed_at),
    ]);
    const idToken = record(file.id_token);
    const projectId = text(file.project_id);
    const chatgptAccountId = text(idToken?.chatgpt_account_id);
    const tokenPlanType = text(idToken?.plan_type)?.toLowerCase();
    accounts.push({
      account: {
        authIndex,
        provider,
        name,
        ...(label !== undefined && label !== email ? { label } : {}),
        ...(email !== undefined ? { email } : {}),
        status: text(file.status)?.toLowerCase() ?? "unknown",
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        disabled: file.disabled === true,
        unavailable: file.unavailable === true,
        ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
        cooldowns: parseCooldowns(file.cooldowns),
        requests: parseRequestCounts(file),
      },
      ...(projectId !== undefined ? { projectId } : {}),
      ...(chatgptAccountId !== undefined ? { chatgptAccountId } : {}),
      ...(tokenPlanType !== undefined ? { tokenPlanType } : {}),
    });
  }
  return accounts;
}

// ── API keys (`GET /observability/usage/api-keys`, legacy `/api-key-usage`) ──

/** Last four characters for keys long enough that four do not reveal the key. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length >= 12 ? `…${trimmed.slice(-4)}` : "…";
}

/**
 * Request counters per upstream API key. The hub keys entries `base_url|api_key`; only a
 * masked key suffix is kept.
 */
export function parseApiKeyUsage(data: unknown): CliProxyApiKeyUsage[] {
  const providers = record(data);
  if (!providers) return [];
  const usage: CliProxyApiKeyUsage[] = [];
  for (const [providerKey, entries] of Object.entries(providers)) {
    const provider = text(providerKey);
    const byKey = record(entries);
    if (provider === undefined || !byKey) continue;
    for (const [compositeKey, rawEntry] of Object.entries(byKey)) {
      const entry = record(rawEntry);
      if (!entry) continue;
      const separator = compositeKey.indexOf("|");
      const baseUrl = separator >= 0 ? text(compositeKey.slice(0, separator)) : undefined;
      const apiKey = separator >= 0 ? compositeKey.slice(separator + 1) : compositeKey;
      usage.push({
        provider,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        keyHint: maskApiKey(apiKey),
        requests: parseRequestCounts(entry),
      });
    }
  }
  return usage.toSorted(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      right.requests.success +
        right.requests.failed -
        (left.requests.success + left.requests.failed),
  );
}

// ── `api-call` passthrough ──────────────────────────────────────────

export interface ApiCallResult {
  readonly statusCode: number;
  readonly body: string;
}

export function parseApiCallResult(data: unknown): ApiCallResult | null {
  const result = record(data);
  const statusCode = finiteNumber(result?.status_code);
  if (!result || statusCode === undefined) return null;
  return { statusCode, body: typeof result.body === "string" ? result.body : "" };
}

export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** A short reason from an upstream error body, for display next to the HTTP status. */
export function upstreamErrorDetail(body: string): string | undefined {
  const payload = record(parseJsonBody(body));
  const error = payload?.error;
  return (
    text(record(error)?.message) ?? text(error) ?? text(payload?.message) ?? text(payload?.detail)
  );
}

// ── Codex (`GET chatgpt.com/backend-api/wham/usage`) ────────────────

export interface ParsedQuota {
  readonly windows: CliProxyQuotaWindow[];
  readonly planType?: string;
  readonly credits?: CliProxyAccountCredits;
}

function codexWindow(input: {
  readonly id: string;
  readonly scope: string | undefined;
  readonly raw: unknown;
  readonly limitReached: boolean;
  readonly nowMs: number;
}): CliProxyQuotaWindow | undefined {
  const raw = record(input.raw);
  if (!raw) return undefined;
  const seconds = finiteNumber(raw.limit_window_seconds);
  const resetAt = finiteNumber(raw.reset_at);
  const resetAfter = finiteNumber(raw.reset_after_seconds);
  const resetsAt =
    resetAt !== undefined && resetAt > 0
      ? Math.floor(resetAt)
      : resetAfter !== undefined
        ? Math.floor(input.nowMs / 1000 + resetAfter)
        : undefined;
  const usedPercent = finiteNumber(raw.used_percent) ?? (input.limitReached ? 100 : undefined);
  if (usedPercent === undefined) return undefined;
  return {
    id: input.id,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(seconds !== undefined && seconds > 0
      ? { windowDurationMins: Math.round(seconds / 60) }
      : {}),
  };
}

function codexLimitWindows(input: {
  readonly idPrefix: string;
  readonly scope: string | undefined;
  readonly limit: unknown;
  readonly nowMs: number;
}): CliProxyQuotaWindow[] {
  const limit = record(input.limit);
  if (!limit) return [];
  const limitReached = limit.limit_reached === true || limit.allowed === false;
  return [
    codexWindow({
      id: `${input.idPrefix}primary`,
      scope: input.scope,
      raw: limit.primary_window,
      limitReached,
      nowMs: input.nowMs,
    }),
    codexWindow({
      id: `${input.idPrefix}secondary`,
      scope: input.scope,
      raw: limit.secondary_window,
      limitReached,
      nowMs: input.nowMs,
    }),
  ].filter((window): window is CliProxyQuotaWindow => window !== undefined);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseCodexUsage(data: unknown, nowMs: number): ParsedQuota | null {
  const payload = record(data);
  if (!payload) return null;
  const windows = codexLimitWindows({
    idPrefix: "",
    scope: undefined,
    limit: payload.rate_limit,
    nowMs,
  });
  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const [index, raw] of additional.entries()) {
    const entry = record(raw);
    const scope = text(entry?.limit_name) ?? text(entry?.metered_feature);
    windows.push(
      ...codexLimitWindows({
        idPrefix: `${scope ? slug(scope) : `additional-${index + 1}`}-`,
        scope: scope ?? `Additional limit ${index + 1}`,
        limit: entry?.rate_limit,
        nowMs,
      }),
    );
  }
  const planType = text(payload.plan_type)?.toLowerCase();
  const credits = record(payload.credits);
  const balanceValue = credits?.balance;
  const balance =
    typeof balanceValue === "number" && Number.isFinite(balanceValue)
      ? String(balanceValue)
      : text(balanceValue);
  const hasCredits = credits?.has_credits === true || credits?.unlimited === true;
  return {
    windows,
    ...(planType !== undefined ? { planType } : {}),
    ...(credits && hasCredits
      ? {
          credits: {
            unlimited: credits.unlimited === true,
            ...(balance !== undefined && /^\d+(\.\d+)?$/.test(balance) ? { balance } : {}),
          },
        }
      : {}),
  };
}

// ── Antigravity (`POST …/v1internal:retrieveUserQuotaSummary`) ──────

function antigravityWindowMins(window: string | undefined): number | undefined {
  switch (window?.toLowerCase()) {
    case "5h":
    case "five-hour":
    case "five_hour":
      return FIVE_HOUR_MINS;
    case "weekly":
    case "week":
      return WEEK_MINS;
    default:
      return undefined;
  }
}

function remainingFraction(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number !== undefined) return number;
  const raw = text(value);
  if (raw?.endsWith("%")) {
    const parsed = Number(raw.slice(0, -1));
    return Number.isFinite(parsed) ? parsed / 100 : undefined;
  }
  return undefined;
}

export function parseAntigravityQuota(data: unknown): ParsedQuota | null {
  const groups = record(data)?.groups;
  if (!Array.isArray(groups)) return null;
  const windows: CliProxyQuotaWindow[] = [];
  for (const [groupIndex, rawGroup] of groups.entries()) {
    const group = record(rawGroup);
    const groupLabel = text(group?.displayName) ?? `Quota group ${groupIndex + 1}`;
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const [bucketIndex, rawBucket] of buckets.entries()) {
      const bucket = record(rawBucket);
      const remaining = remainingFraction(bucket?.remainingFraction);
      if (!bucket || remaining === undefined) continue;
      const window = text(bucket.window);
      const bucketLabel = text(bucket.displayName) ?? text(bucket.description);
      const windowDurationMins = antigravityWindowMins(window);
      const resetsAt = epochSecondsFromIso(bucket.resetTime);
      const usedPercent = Math.round(Math.min(1, Math.max(0, 1 - remaining)) * 1000) / 10;
      const scope =
        bucketLabel && bucketLabel !== groupLabel && windowDurationMins === undefined
          ? `${groupLabel} · ${bucketLabel}`
          : groupLabel;
      windows.push({
        id: text(bucket.bucketId) ?? `${slug(groupLabel)}-${window ?? "bucket"}-${bucketIndex + 1}`,
        scope,
        usedPercent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
      });
    }
  }
  return { windows };
}

// ── Management errors ───────────────────────────────────────────────

/**
 * How a failed management request counts toward the hub's IP ban: a 401 naming a rejected key
 * is counted, and a 403 naming a ban means the hub already refuses this IP. Other refusals,
 * such as remote management being disabled, are not counted by the hub.
 */
export function managementAuthOutcome(
  status: number,
  body: string,
): "rejected" | "banned" | undefined {
  if (isCloudflareAccessResponse(body)) return undefined;
  if (
    status === 401 &&
    /\b(?:invalid|missing) management key\b/i.test(upstreamErrorDetail(body) ?? "")
  ) {
    return "rejected";
  }
  if (status === 403 && /\bip banned\b/i.test(upstreamErrorDetail(body) ?? body)) return "banned";
  return undefined;
}

/** A user-facing reason for a failed management request. */
export function isCloudflareAccessResponse(body: string, location?: string): boolean {
  if (location) {
    try {
      const url = new URL(location, "https://hub.invalid");
      if (
        url.hostname.endsWith(".cloudflareaccess.com") ||
        url.pathname.startsWith("/cdn-cgi/access/")
      ) {
        return true;
      }
    } catch {
      // An invalid redirect is still reported as a redirect below.
    }
  }
  return /cloudflare[\s\S]{0,80}access|cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(body);
}

export function describeManagementFailure(status: number, body: string, location?: string): string {
  if (isCloudflareAccessResponse(body, location)) {
    return "Cloudflare Access blocked the management request. Enter a service token's Client ID and Client Secret in this hub's settings, and allow that token in a Cloudflare Service Auth policy.";
  }
  const detail = upstreamErrorDetail(body);
  if (status === 401 && managementAuthOutcome(status, body) === "rejected") {
    return "The hub rejected the management key.";
  }
  if (status >= 300 && status < 400) {
    return "The hub redirected the management request. Use its direct management API address; Ryco does not forward credentials through redirects.";
  }
  if (status === 403) {
    if (detail?.toLowerCase().includes("remote management disabled")) {
      return "Remote management is disabled on this hub. Enable `allow-remote` in its management settings, or connect from the machine the hub runs on.";
    }
    return detail ?? "The hub refused the management request (HTTP 403).";
  }
  if (status === 404) {
    return "This hub has no management API at this address. Set a management secret key in its config and restart CLIProxyAPI, and make sure the proxy forwards /v0/management/ or /v8/management/ paths.";
  }
  return detail ? `The hub returned HTTP ${status}: ${detail}` : `The hub returned HTTP ${status}.`;
}
