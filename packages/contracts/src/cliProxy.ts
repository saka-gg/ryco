/**
 * CLIProxyAPI hub contracts.
 *
 * A hub is a self-hosted CLIProxyAPI server that pools Claude Code, Codex, Antigravity and
 * API-key credentials behind one endpoint. Ryco reads a hub through its management API as a
 * read-only usage source: the account list, each subscription account's quota (fetched
 * upstream through the hub's `api-call` passthrough), cooldowns, and request counters.
 * Routing agent turns through a hub is configured on provider instances, not here; a hub
 * snapshot only reports which of the node's instances point at it.
 *
 * @module cliProxy
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CLI_PROXY_HUB_ID_MAX_CHARS = 64;
export const CLI_PROXY_HUB_URL_MAX_CHARS = 2048;
export const CLI_PROXY_HUB_LABEL_MAX_CHARS = 80;
const CLI_PROXY_HUB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const CliProxyHubId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CLI_PROXY_HUB_ID_MAX_CHARS),
  Schema.isPattern(CLI_PROXY_HUB_ID_PATTERN),
).pipe(Schema.brand("CliProxyHubId"));
export type CliProxyHubId = typeof CliProxyHubId.Type;

/**
 * Hub configuration stored in `ServerSettings.cliProxyHubs`.
 *
 * `managementKey` is write-only, with the same contract as sensitive provider environment
 * variables: the server moves a submitted key into its secret store and persists `""` with
 * `managementKeyRedacted: true`. Clients send the redacted entry back unchanged to keep the
 * stored key, a new value to replace it, or `""` without the flag to remove it.
 *
 * The URL is deliberately not validated beyond its length, so a hand-edited URL still loads
 * and the server reports it as unusable on the hub's snapshot. A hand-edited entry that fails
 * to decode (an invalid id, an empty URL or label) is dropped on load on its own; the other
 * hubs are kept.
 */
const CliProxyHubLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CLI_PROXY_HUB_LABEL_MAX_CHARS),
);
const CliProxyHubUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(CLI_PROXY_HUB_URL_MAX_CHARS));

const CloudflareAccessFields = {
  /** Optional Cloudflare Access service-token ID. Empty disables service-token authentication. */
  cloudflareAccessClientId: Schema.optionalKey(Schema.String),
  /** Write-only service-token secret, stored and redacted like the management key. */
  cloudflareAccessClientSecret: Schema.optionalKey(Schema.String),
  cloudflareAccessClientSecretRedacted: Schema.optionalKey(Schema.Boolean),
};

export const CliProxyHubConfig = Schema.Struct({
  label: Schema.optionalKey(CliProxyHubLabel),
  url: CliProxyHubUrl,
  managementKey: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  managementKeyRedacted: Schema.optionalKey(Schema.Boolean),
  ...CloudflareAccessFields,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type CliProxyHubConfig = typeof CliProxyHubConfig.Type;

/**
 * A complete hub entry as sent in settings patches. Every field is explicit, so a partial
 * entry is rejected instead of reading a missing key as "remove the stored key".
 * Omitted Cloudflare fields preserve an existing service token for older clients. Explicit
 * empty values without a redacted marker remove it.
 */
export const CliProxyHubConfigInput = Schema.Struct({
  label: Schema.optionalKey(CliProxyHubLabel),
  url: CliProxyHubUrl,
  managementKey: Schema.String,
  managementKeyRedacted: Schema.optionalKey(Schema.Boolean),
  ...CloudflareAccessFields,
  enabled: Schema.Boolean,
});

export const CliProxyHubs = Schema.Record(CliProxyHubId, CliProxyHubConfig);
export type CliProxyHubs = typeof CliProxyHubs.Type;

/**
 * One usage window of a subscription account. Structurally compatible with
 * `ServerProviderRateLimitWindow` so the shared limit presentation renders both; clients
 * derive the cadence label ("5h", "Weekly") from the duration and append `scope`.
 */
export const CliProxyQuotaWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** What the window is limited to, e.g. a model ("Opus") or a metered feature. */
  scope: Schema.optionalKey(TrimmedNonEmptyString),
  usedPercent: Schema.Number,
  /** Epoch seconds. */
  resetsAt: Schema.optionalKey(Schema.Number),
  windowDurationMins: Schema.optionalKey(Schema.Number),
});
export type CliProxyQuotaWindow = typeof CliProxyQuotaWindow.Type;

/**
 * - `ok`: windows were read from the provider at `checkedAt`.
 * - `unsupported`: the provider exposes no subscription quota (API-key credentials, or a
 *   provider Ryco does not read).
 * - `skipped`: the account is disabled on the hub, so no upstream call was made.
 * - `failed`: the upstream read failed; `message` says why.
 */
export const CliProxyAccountQuotaStatus = Schema.Literals([
  "ok",
  "unsupported",
  "skipped",
  "failed",
]);
export type CliProxyAccountQuotaStatus = typeof CliProxyAccountQuotaStatus.Type;

export const CliProxyAccountCredits = Schema.Struct({
  unlimited: Schema.Boolean,
  balance: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CliProxyAccountCredits = typeof CliProxyAccountCredits.Type;

export const CliProxyAccountQuota = Schema.Struct({
  status: CliProxyAccountQuotaStatus,
  checkedAt: Schema.optionalKey(IsoDateTime),
  planType: Schema.optionalKey(TrimmedNonEmptyString),
  windows: Schema.Array(CliProxyQuotaWindow),
  credits: Schema.optionalKey(CliProxyAccountCredits),
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CliProxyAccountQuota = typeof CliProxyAccountQuota.Type;

/** A ten-minute request bucket; `label` is the hub's local `HH:MM-HH:MM` span. */
export const CliProxyRequestBucket = Schema.Struct({
  label: Schema.String,
  success: NonNegativeInt,
  failed: NonNegativeInt,
});
export type CliProxyRequestBucket = typeof CliProxyRequestBucket.Type;

/** Hub-side counters since the hub last started, plus the recent buckets oldest first. */
export const CliProxyRequestCounts = Schema.Struct({
  success: NonNegativeInt,
  failed: NonNegativeInt,
  recent: Schema.Array(CliProxyRequestBucket),
});
export type CliProxyRequestCounts = typeof CliProxyRequestCounts.Type;

export const CliProxyCooldown = Schema.Struct({
  scope: TrimmedNonEmptyString,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
  retryAt: Schema.optionalKey(IsoDateTime),
  httpStatus: Schema.optionalKey(NonNegativeInt),
});
export type CliProxyCooldown = typeof CliProxyCooldown.Type;

export const CliProxyAccount = Schema.Struct({
  /** Hub-assigned stable credential index. */
  authIndex: TrimmedNonEmptyString,
  /** Hub provider slug (`claude`, `codex`, `antigravity`, `kimi`, ...). Open by design. */
  provider: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  email: Schema.optionalKey(TrimmedNonEmptyString),
  /** Hub credential status (`active`, `refreshing`, `error`, `disabled`, ...). Open by design. */
  status: TrimmedNonEmptyString,
  statusMessage: Schema.optionalKey(TrimmedNonEmptyString),
  disabled: Schema.Boolean,
  unavailable: Schema.Boolean,
  nextRetryAt: Schema.optionalKey(IsoDateTime),
  /**
   * When the hub last saw an upstream response for this account that carried quota headers
   * (Claude, Codex and Devin). Hub-wide: any client of the hub may have caused it.
   */
  lastUsedAt: Schema.optionalKey(IsoDateTime),
  cooldowns: Schema.Array(CliProxyCooldown),
  requests: CliProxyRequestCounts,
  quota: CliProxyAccountQuota,
});
export type CliProxyAccount = typeof CliProxyAccount.Type;

/** Request counters for one upstream API key configured on the hub. Never carries the key. */
export const CliProxyApiKeyUsage = Schema.Struct({
  /** Provider slug, or the openai-compatibility entry name. */
  provider: TrimmedNonEmptyString,
  baseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  /** Masked key suffix such as `…a1b2`. */
  keyHint: TrimmedNonEmptyString,
  requests: CliProxyRequestCounts,
});
export type CliProxyApiKeyUsage = typeof CliProxyApiKeyUsage.Type;

export const CliProxyHubStatus = Schema.Literals(["ok", "error"]);
export type CliProxyHubStatus = typeof CliProxyHubStatus.Type;

export const CliProxyHubSnapshot = Schema.Struct({
  hubId: CliProxyHubId,
  label: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  status: CliProxyHubStatus,
  /** Why the hub could not be read; present when `status` is `error`. */
  error: Schema.optionalKey(TrimmedNonEmptyString),
  /** Why API-key counters are missing while the account list loaded. */
  apiKeysError: Schema.optionalKey(TrimmedNonEmptyString),
  version: Schema.optionalKey(TrimmedNonEmptyString),
  accounts: Schema.Array(CliProxyAccount),
  apiKeys: Schema.Array(CliProxyApiKeyUsage),
  /** The node's provider instances whose base URL points at this hub. */
  routedInstanceIds: Schema.Array(ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type CliProxyHubSnapshot = typeof CliProxyHubSnapshot.Type;

export const CliProxyReadHubsInput = Schema.Struct({
  /** Bypass the cache, subject to a per-account floor that protects upstream quota APIs. */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type CliProxyReadHubsInput = typeof CliProxyReadHubsInput.Type;

export const CliProxyReadHubsResult = Schema.Struct({
  hubs: Schema.Array(CliProxyHubSnapshot),
});
export type CliProxyReadHubsResult = typeof CliProxyReadHubsResult.Type;

export const CliProxyTestHubInput = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(CLI_PROXY_HUB_URL_MAX_CHARS)),
  /** Key to test. When empty, the stored key of `hubId` is used (editing a saved hub). */
  managementKey: Schema.optionalKey(Schema.String),
  /** Omitted uses the saved ID of `hubId`; an explicit empty ID disables the service token. */
  cloudflareAccessClientId: Schema.optionalKey(Schema.String),
  /** Empty uses the saved secret only at the same hub address with the same Client ID. */
  cloudflareAccessClientSecret: Schema.optionalKey(Schema.String),
  hubId: Schema.optionalKey(CliProxyHubId),
});
export type CliProxyTestHubInput = typeof CliProxyTestHubInput.Type;

export const CliProxyTestHubResult = Schema.Struct({
  version: Schema.optionalKey(TrimmedNonEmptyString),
  accountCount: NonNegativeInt,
});
export type CliProxyTestHubResult = typeof CliProxyTestHubResult.Type;

export class CliProxyHubError extends Schema.TaggedError<CliProxyHubError>()("CliProxyHubError", {
  message: Schema.String,
}) {}
