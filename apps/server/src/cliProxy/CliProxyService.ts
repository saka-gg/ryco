/**
 * CliProxyService — reads CLIProxyAPI hubs configured in `ServerSettings.cliProxyHubs`.
 *
 * Per hub it lists the subscription accounts and API-key counters through the management
 * API (v8 paths, falling back to v0 for older hubs) and reads each Claude, Codex and
 * Antigravity account's quota upstream through the hub's `api-call` passthrough, which
 * substitutes the account's own token for `$TOKEN$`.
 *
 * Reads are on demand (no background polling) and cached: account lists briefly, upstream
 * quota for minutes with a floor on forced refreshes, because the provider usage endpoints
 * rate-limit aggressively. The hub bans a client IP, localhost included, after five rejected
 * management keys, so a rejected key is not resent until the hub has forgotten it, and new
 * keys stop before the fifth rejection.
 *
 * @module cliProxy/CliProxyService
 */
import { createHash } from "node:crypto";

import {
  CliProxyHubError,
  type CliProxyAccount,
  type CliProxyAccountQuota,
  type CliProxyHubConfig,
  type CliProxyHubId,
  type CliProxyHubSnapshot,
  type CliProxyReadHubsInput,
  type CliProxyReadHubsResult,
  type CliProxyTestHubInput,
  type CliProxyTestHubResult,
} from "@ryco/contracts";
import { Clock, Context, Data, DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Semaphore from "effect/Semaphore";

import {
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_USAGE_URL,
  parseClaudeProfilePlan,
  parseClaudeUsageWindows,
} from "../provider/claudeOAuthUsage.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { hubKeyAddress, normalizeHubBaseUrl } from "@ryco/shared/cliProxyHubUrl";
import { validateCloudflareAccessCredentials } from "@ryco/shared/cliProxyHubCredentials";
import {
  describeManagementFailure,
  displayText,
  hubAuthAddress,
  hubHostLabel,
  INVALID_HUB_URL_MESSAGE,
  isCloudflareAccessResponse,
  managementAuthOutcome,
  parseAntigravityQuota,
  parseApiCallResult,
  parseApiKeyUsage,
  parseCodexUsage,
  parseHubAccounts,
  parseJsonBody,
  routedInstanceIds,
  upstreamErrorDetail,
  type HubAccountRecord,
  type ParsedQuota,
} from "./cliProxyParsing.ts";

const MANAGEMENT_TIMEOUT = Duration.seconds(15);
// The hub's own upstream timeout for `api-call` is 60 seconds.
const API_CALL_TIMEOUT = Duration.seconds(45);
// Bounds one account's quota read across its upstream calls and fallbacks.
const QUOTA_READ_TIMEOUT = Duration.seconds(60);
const ACCOUNT_LIST_TTL_MS = 20_000;
const QUOTA_TTL_MS = 5 * 60_000;
const QUOTA_REFRESH_FLOOR_MS = 60_000;
const CLAUDE_PLAN_TTL_MS = 6 * 60 * 60_000;
// The hub counts rejected management keys per client IP, bans the IP for 30 minutes at the
// fifth, and forgets the count once the IP has been idle for two hours (purging hourly).
const AUTH_FAILURE_MEMORY_MS = 3 * 60 * 60_000;
// Rejections Ryco allows itself per hub address, below the hub's ban at five.
const AUTH_FAILURE_LIMIT = 4;
const HUB_BAN_MS = 30 * 60_000;
const QUOTA_CONCURRENCY = 4;

const CLAUDE_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
  "User-Agent": "claude-cli/2.1.280 (external, cli)",
};
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "codex-tui/0.149.1",
};
const ANTIGRAVITY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
const ANTIGRAVITY_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
};

const QUOTA_PROVIDERS = new Set(["claude", "codex", "antigravity"]);

export interface CliProxyServiceShape {
  readonly readHubs: (
    input: CliProxyReadHubsInput,
  ) => Effect.Effect<CliProxyReadHubsResult, CliProxyHubError>;
  readonly testHub: (
    input: CliProxyTestHubInput,
  ) => Effect.Effect<CliProxyTestHubResult, CliProxyHubError>;
}

export class CliProxyService extends Context.Service<CliProxyService, CliProxyServiceShape>()(
  "ryco/cliProxy/CliProxyService",
) {}

/** A failed hub or upstream request; `authOutcome` marks one the hub's IP ban counts or reports. */
class HubRequestError extends Data.TaggedError("HubRequestError")<{
  readonly message: string;
  readonly authOutcome?: "rejected" | "banned";
}> {}

interface HubConnection {
  readonly baseUrl: string;
  readonly managementKey: string;
  readonly cloudflareAccessClientId?: string | undefined;
  readonly cloudflareAccessClientSecret?: string | undefined;
}

type ManagementApi = "v8" | "v0";

interface ManagementRoute {
  readonly v8: string;
  readonly v0: string;
}

const ROUTES = {
  credentials: { v8: "credentials", v0: "auth-files" },
  apiKeyUsage: { v8: "observability/usage/api-keys", v0: "api-key-usage" },
  apiCall: { v8: "requests/api-call", v0: "api-call" },
} satisfies Record<string, ManagementRoute>;

/**
 * What reading a hub yields. Routing comes from the node's settings, not the hub, so it is
 * attached per call instead of being cached with the hub's data.
 */
type HubRead = Omit<CliProxyHubSnapshot, "routedInstanceIds">;

interface CachedQuota {
  readonly fetchedAtMs: number;
  readonly quota: CliProxyAccountQuota;
}

interface HubState {
  readonly fingerprint: string;
  readonly lock: Semaphore.Semaphore;
  api: ManagementApi | undefined;
  snapshot: { readonly fetchedAtMs: number; readonly value: HubRead } | undefined;
  readonly quotas: Map<string, CachedQuota>;
  readonly claudePlans: Map<string, { readonly fetchedAtMs: number; readonly plan?: string }>;
}

/** What the hub at one address remembers about this node's management keys. */
interface HubAuthRecord {
  /** Rejections the hub still counts toward its ban. */
  failures: number;
  lastFailureAtMs: number;
  /** Requests sent and not answered yet; they may still be rejected. */
  pending: number;
  bannedUntilMs: number;
  /** Rejected key fingerprints, by when the hub rejected them. */
  readonly rejected: Map<string, number>;
}

function waitLabel(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `about ${Math.round(minutes / 60)} hours`;
}

function managementKeyFingerprint(connection: HubConnection): string {
  const keyHash = createHash("sha256").update(connection.managementKey).digest("hex");
  return `${connection.baseUrl}\n${keyHash}`;
}

function hubFingerprint(connection: HubConnection): string {
  // Token rotation invalidates cached failures and quota, without forgetting a management
  // key the hub already rejected (admission uses managementKeyFingerprint instead).
  return createHash("sha256").update(JSON.stringify(connection)).digest("hex");
}

function redactConnectionSecrets(message: string, connection: HubConnection): string {
  let redacted = message;
  for (const secret of [connection.managementKey, connection.cloudflareAccessClientSecret]) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function isoAt(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const nested = (cause as { cause?: unknown }).cause;
    const detail = nested instanceof Error ? nested.message : undefined;
    return detail && detail !== cause.message ? `${cause.message} (${detail})` : cause.message;
  }
  return String(cause);
}

export const makeCliProxyService = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const statesLock = yield* Semaphore.make(1);
  const states = new Map<CliProxyHubId, HubState>();

  const stateFor = (hubId: CliProxyHubId, fingerprint: string) =>
    statesLock.withPermits(1)(
      Effect.sync(() => {
        const existing = states.get(hubId);
        if (existing && existing.fingerprint === fingerprint) return existing;
        const state: HubState = {
          fingerprint,
          lock: Semaphore.makeUnsafe(1),
          api: undefined,
          snapshot: undefined,
          quotas: new Map(),
          claudePlans: new Map(),
        };
        states.set(hubId, state);
        return state;
      }),
    );

  const forgetRemovedHubs = (hubIds: ReadonlySet<string>) =>
    statesLock.withPermits(1)(
      Effect.sync(() => {
        for (const hubId of states.keys()) if (!hubIds.has(hubId)) states.delete(hubId);
      }),
    );

  // ── Management key admission ────────────────────────────────────

  const authRecords = new Map<string, HubAuthRecord>();

  /** Reserves one keyed request to the hub at `address`, or says why it must not be sent. */
  const admitKey = (address: string, fingerprint: string) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const record: HubAuthRecord = authRecords.get(address) ?? {
        failures: 0,
        lastFailureAtMs: 0,
        pending: 0,
        bannedUntilMs: 0,
        rejected: new Map(),
      };
      authRecords.set(address, record);
      if (nowMs - record.lastFailureAtMs >= AUTH_FAILURE_MEMORY_MS) record.failures = 0;
      for (const [key, rejectedAtMs] of record.rejected) {
        if (nowMs - rejectedAtMs >= AUTH_FAILURE_MEMORY_MS) record.rejected.delete(key);
      }
      if (nowMs < record.bannedUntilMs) {
        return {
          refusal: `The hub blocked this machine's IP address after too many rejected management keys. Ryco contacts it again in ${waitLabel(record.bannedUntilMs - nowMs)}.`,
        } as const;
      }
      const rejectedAtMs = record.rejected.get(fingerprint);
      if (rejectedAtMs !== undefined) {
        return {
          refusal: `The hub rejected the management key. Ryco will not send it again for ${waitLabel(rejectedAtMs + AUTH_FAILURE_MEMORY_MS - nowMs)}, so the hub does not block this machine's IP address. Enter the correct key to try again.`,
        } as const;
      }
      if (record.failures >= AUTH_FAILURE_LIMIT) {
        return {
          refusal: `The hub rejected ${record.failures} management keys recently. Ryco will not send it another key for ${waitLabel(record.lastFailureAtMs + AUTH_FAILURE_MEMORY_MS - nowMs)}, so the hub does not block this machine's IP address.`,
        } as const;
      }
      if (record.failures + record.pending >= AUTH_FAILURE_LIMIT) {
        return {
          refusal: "Another key check for this hub is still running. Try again shortly.",
        } as const;
      }
      record.pending += 1;
      return { record } as const;
    });

  const settleKey = (
    address: string,
    record: HubAuthRecord,
    fingerprint: string,
    outcome: "accepted" | "rejected" | "banned" | "unknown",
  ) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      record.pending -= 1;
      if (outcome === "accepted") {
        // An accepted key clears the hub's count too.
        record.failures = 0;
        record.rejected.delete(fingerprint);
      } else if (outcome === "rejected") {
        record.failures += 1;
        record.lastFailureAtMs = nowMs;
        record.rejected.set(fingerprint, nowMs);
      } else if (outcome === "banned") {
        record.failures = 0;
        record.bannedUntilMs = nowMs + HUB_BAN_MS;
      }
      const idle =
        record.pending === 0 &&
        record.failures === 0 &&
        record.rejected.size === 0 &&
        nowMs >= record.bannedUntilMs;
      if (idle && authRecords.get(address) === record) authRecords.delete(address);
    });

  /**
   * A request that authenticates with the hub's management key. It is not sent while the key
   * is known to be rejected, while the hub bans this node, or once Ryco's own rejections at
   * the hub's address reach the limit, so Ryco alone never gets the IP banned.
   */
  const withManagementKey = <A>(
    connection: HubConnection,
    request: Effect.Effect<A, HubRequestError>,
  ): Effect.Effect<A, HubRequestError> =>
    Effect.gen(function* () {
      const address = hubAuthAddress(connection.baseUrl);
      const fingerprint = managementKeyFingerprint(connection);
      const admission = yield* admitKey(address, fingerprint);
      if ("refusal" in admission) {
        return yield* new HubRequestError({ message: admission.refusal });
      }
      return yield* request.pipe(
        Effect.onExit((exit) =>
          settleKey(
            address,
            admission.record,
            fingerprint,
            Exit.isSuccess(exit)
              ? "accepted"
              : (Option.getOrUndefined(Exit.findErrorOption(exit))?.authOutcome ?? "unknown"),
          ),
        ),
      );
    });

  // ── Transport ───────────────────────────────────────────────────

  const send = (input: {
    readonly connection: HubConnection;
    readonly api: ManagementApi;
    readonly route: ManagementRoute;
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly timeout: Duration.Duration;
  }) =>
    Effect.gen(function* () {
      const url = `${input.connection.baseUrl}/${input.api}/management/${input.route[input.api]}`;
      let request = HttpClientRequest.make(input.method)(url).pipe(
        HttpClientRequest.bearerToken(input.connection.managementKey),
        HttpClientRequest.acceptJson,
      );
      if (
        input.connection.cloudflareAccessClientId &&
        input.connection.cloudflareAccessClientSecret
      ) {
        request = request.pipe(
          HttpClientRequest.setHeader(
            "CF-Access-Client-Id",
            input.connection.cloudflareAccessClientId,
          ),
          HttpClientRequest.setHeader(
            "CF-Access-Client-Secret",
            input.connection.cloudflareAccessClientSecret,
          ),
        );
      }
      if (input.body !== undefined) {
        request = request.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
      }
      const response = yield* httpClient.execute(request).pipe(
        Effect.flatMap((response) =>
          response.text.pipe(
            Effect.map((body) => ({
              status: response.status,
              body,
              version: response.headers["x-cpa-version"]?.trim() || undefined,
              location: response.headers["location"],
            })),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new HubRequestError({
              message: redactConnectionSecrets(
                `Couldn't reach the hub at ${input.connection.baseUrl}: ${errorMessage(cause)}`,
                input.connection,
              ),
            }),
        ),
        Effect.timeoutOrElse({
          duration: input.timeout,
          orElse: () =>
            Effect.fail(
              new HubRequestError({
                message: `The hub at ${input.connection.baseUrl} did not respond in time.`,
              }),
            ),
        }),
        // Fetch otherwise follows redirects while retaining custom Access headers. Requests
        // authenticate only the configured hub; a login redirect is reported to the user.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
      return response;
    });

  /**
   * One management request. Tries the v8 path first and falls back to v0 when the hub
   * predates it; the working API is remembered per hub.
   */
  const management = (
    connection: HubConnection,
    state: Pick<HubState, "api">,
    route: ManagementRoute,
    options: {
      readonly method: "GET" | "POST";
      readonly body?: unknown;
      readonly timeout?: Duration.Duration;
    },
  ) =>
    Effect.gen(function* () {
      const candidates: ReadonlyArray<ManagementApi> = state.api
        ? [state.api, ...(state.api === "v8" ? ["v0" as const] : [])]
        : ["v8", "v0"];
      let last: { status: number; body: string } | undefined;
      for (const api of candidates) {
        const response = yield* send({
          connection,
          api,
          route,
          method: options.method,
          ...(options.body !== undefined ? { body: options.body } : {}),
          timeout: options.timeout ?? MANAGEMENT_TIMEOUT,
        });
        if (
          (response.status >= 300 || parseJsonBody(response.body) === undefined) &&
          isCloudflareAccessResponse(response.body, response.location)
        ) {
          return yield* new HubRequestError({
            message: describeManagementFailure(response.status, response.body, response.location),
          });
        }
        if (response.status === 404) {
          last = response;
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          const authOutcome = managementAuthOutcome(response.status, response.body);
          return yield* Effect.fail(
            new HubRequestError({
              message: redactConnectionSecrets(
                describeManagementFailure(response.status, response.body, response.location),
                connection,
              ),
              ...(authOutcome ? { authOutcome } : {}),
            }),
          );
        }
        state.api = api;
        const data = parseJsonBody(response.body);
        if (data === undefined) {
          return yield* Effect.fail(
            new HubRequestError({ message: "The hub returned a response Ryco could not read." }),
          );
        }
        return { data, version: response.version };
      }
      state.api = undefined;
      return yield* Effect.fail(
        new HubRequestError({
          message: describeManagementFailure(last?.status ?? 404, last?.body ?? ""),
        }),
      );
    });

  /** An upstream request made by the hub with the account's own credentials. */
  const apiCall = (
    connection: HubConnection,
    state: HubState,
    input: {
      readonly authIndex: string;
      readonly method: "GET" | "POST";
      readonly url: string;
      readonly header: Record<string, string>;
      readonly data?: string;
    },
  ) =>
    management(connection, state, ROUTES.apiCall, {
      method: "POST",
      timeout: API_CALL_TIMEOUT,
      body: {
        auth_index: input.authIndex,
        method: input.method,
        url: input.url,
        header: input.header,
        ...(input.data !== undefined ? { data: input.data } : {}),
      },
    }).pipe(
      Effect.flatMap(({ data }) => {
        const result = parseApiCallResult(data);
        return result
          ? Effect.succeed(result)
          : Effect.fail(
              new HubRequestError({ message: "The hub returned an unreadable api-call response." }),
            );
      }),
    );

  const upstreamJson = (
    result: { readonly statusCode: number; readonly body: string },
    provider: string,
  ) =>
    result.statusCode >= 200 && result.statusCode < 300
      ? Effect.succeed(parseJsonBody(result.body))
      : Effect.fail(
          new HubRequestError({
            message: [
              `${provider} refused the request (HTTP ${result.statusCode})`,
              upstreamErrorDetail(result.body),
            ]
              .filter(Boolean)
              .join(": "),
          }),
        );

  // ── Quota per provider ──────────────────────────────────────────

  const readClaudeQuota = (
    connection: HubConnection,
    state: HubState,
    record: HubAccountRecord,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const authIndex = record.account.authIndex;
      const cachedPlan = state.claudePlans.get(authIndex);
      const planFresh =
        cachedPlan !== undefined && nowMs - cachedPlan.fetchedAtMs < CLAUDE_PLAN_TTL_MS;
      const [usage, plan] = yield* Effect.all(
        [
          apiCall(connection, state, {
            authIndex,
            method: "GET",
            url: CLAUDE_OAUTH_USAGE_URL,
            header: CLAUDE_HEADERS,
          }).pipe(Effect.flatMap((result) => upstreamJson(result, "Anthropic"))),
          planFresh
            ? Effect.succeed(cachedPlan.plan)
            : apiCall(connection, state, {
                authIndex,
                method: "GET",
                url: CLAUDE_OAUTH_PROFILE_URL,
                header: CLAUDE_HEADERS,
              }).pipe(
                Effect.flatMap((result) => upstreamJson(result, "Anthropic")),
                Effect.map(parseClaudeProfilePlan),
                Effect.tap((plan) =>
                  Effect.sync(() =>
                    state.claudePlans.set(authIndex, {
                      fetchedAtMs: nowMs,
                      ...(plan !== undefined ? { plan } : {}),
                    }),
                  ),
                ),
                // The plan only labels the account; its absence must not hide the quota.
                Effect.orElseSucceed(() => cachedPlan?.plan),
              ),
        ],
        { concurrency: 2 },
      );
      return {
        windows: parseClaudeUsageWindows(usage),
        ...(plan !== undefined ? { planType: plan } : {}),
      } satisfies ParsedQuota;
    });

  const readCodexQuota = (
    connection: HubConnection,
    state: HubState,
    record: HubAccountRecord,
    nowMs: number,
  ) =>
    apiCall(connection, state, {
      authIndex: record.account.authIndex,
      method: "GET",
      url: CODEX_USAGE_URL,
      header: {
        ...CODEX_HEADERS,
        ...(record.chatgptAccountId ? { "Chatgpt-Account-Id": record.chatgptAccountId } : {}),
      },
    }).pipe(
      Effect.flatMap((result) => upstreamJson(result, "ChatGPT")),
      Effect.flatMap((data) => {
        const parsed = parseCodexUsage(data, nowMs);
        if (!parsed)
          return Effect.fail(new HubRequestError({ message: "ChatGPT returned no usage data." }));
        const planType = parsed.planType ?? record.tokenPlanType;
        return Effect.succeed({ ...parsed, ...(planType !== undefined ? { planType } : {}) });
      }),
    );

  const readAntigravityQuota = (
    connection: HubConnection,
    state: HubState,
    record: HubAccountRecord,
  ) =>
    Effect.gen(function* () {
      const projectId = record.projectId;
      if (!projectId) {
        return yield* Effect.fail(
          new HubRequestError({ message: "The hub has no Google Cloud project for this account." }),
        );
      }
      let lastError = new HubRequestError({ message: "Google returned no quota data." });
      for (const url of ANTIGRAVITY_QUOTA_URLS) {
        const outcome = yield* apiCall(connection, state, {
          authIndex: record.account.authIndex,
          method: "POST",
          url,
          header: ANTIGRAVITY_HEADERS,
          data: JSON.stringify({ project: projectId }),
        }).pipe(
          Effect.flatMap((result) => upstreamJson(result, "Google")),
          Effect.map(parseAntigravityQuota),
          Effect.result,
        );
        if (outcome._tag === "Success" && outcome.success && outcome.success.windows.length > 0) {
          return outcome.success;
        }
        if (outcome._tag === "Failure") lastError = outcome.failure;
      }
      return yield* Effect.fail(lastError);
    });

  const readQuota = (
    connection: HubConnection,
    state: HubState,
    record: HubAccountRecord,
    refresh: boolean,
    nowMs: number,
  ): Effect.Effect<CliProxyAccountQuota> => {
    const { account } = record;
    if (account.disabled) return Effect.succeed({ status: "skipped", windows: [] });
    if (!QUOTA_PROVIDERS.has(account.provider)) {
      return Effect.succeed({ status: "unsupported", windows: [] });
    }
    const cached = state.quotas.get(account.authIndex);
    const maxAgeMs =
      refresh || cached?.quota.status === "failed" ? QUOTA_REFRESH_FLOOR_MS : QUOTA_TTL_MS;
    if (cached && nowMs - cached.fetchedAtMs < maxAgeMs) return Effect.succeed(cached.quota);

    const read: Effect.Effect<ParsedQuota, HubRequestError> =
      account.provider === "claude"
        ? readClaudeQuota(connection, state, record, nowMs)
        : account.provider === "codex"
          ? readCodexQuota(connection, state, record, nowMs)
          : readAntigravityQuota(connection, state, record);
    return Effect.gen(function* () {
      const outcome = yield* read.pipe(
        Effect.timeoutOrElse({
          duration: QUOTA_READ_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new HubRequestError({ message: "Reading this account's quota timed out." }),
            ),
        }),
        Effect.result,
      );
      // Cached from when the read ended, so a slow failure still holds the refresh floor.
      const doneMs = yield* Clock.currentTimeMillis;
      const quota: CliProxyAccountQuota =
        outcome._tag === "Success"
          ? {
              status: "ok",
              checkedAt: isoAt(doneMs),
              windows: outcome.success.windows,
              ...(outcome.success.planType !== undefined
                ? { planType: outcome.success.planType }
                : {}),
              ...(outcome.success.credits !== undefined
                ? { credits: outcome.success.credits }
                : {}),
            }
          : {
              status: "failed",
              checkedAt: isoAt(doneMs),
              windows: [],
              message: displayText(outcome.failure.message, "The quota could not be read."),
            };
      state.quotas.set(account.authIndex, { fetchedAtMs: doneMs, quota });
      return quota;
    });
  };

  // ── Hubs ────────────────────────────────────────────────────────

  const errorSnapshot = (
    base: Pick<HubRead, "hubId" | "label" | "url">,
    nowMs: number,
    error: string,
  ): HubRead => ({
    ...base,
    checkedAt: isoAt(nowMs),
    status: "error",
    error: displayText(error, "The hub could not be read."),
    accounts: [],
    apiKeys: [],
  });

  const readHub = (
    hubId: CliProxyHubId,
    config: CliProxyHubConfig,
    refresh: boolean,
  ): Effect.Effect<HubRead> =>
    Effect.gen(function* () {
      const baseUrl = normalizeHubBaseUrl(config.url);
      const base = {
        hubId,
        label: config.label ?? (baseUrl ? hubHostLabel(baseUrl) : config.url),
        url: baseUrl ?? config.url,
      };
      const startedAtMs = yield* Clock.currentTimeMillis;
      if (!baseUrl) return errorSnapshot(base, startedAtMs, INVALID_HUB_URL_MESSAGE);
      const managementKey = config.managementKey.trim();
      if (managementKey.length === 0) {
        return errorSnapshot(
          base,
          startedAtMs,
          "Add the hub's management key to read its accounts.",
        );
      }
      const invalid = validateCloudflareAccessCredentials({
        clientId: config.cloudflareAccessClientId,
        clientSecret: config.cloudflareAccessClientSecret,
      });
      if (invalid) return errorSnapshot(base, startedAtMs, invalid);
      const connection: HubConnection = {
        baseUrl,
        managementKey,
        cloudflareAccessClientId: config.cloudflareAccessClientId?.trim(),
        cloudflareAccessClientSecret: config.cloudflareAccessClientSecret?.trim(),
      };
      const state = yield* stateFor(hubId, hubFingerprint(connection));

      return yield* state.lock.withPermits(1)(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const cached = state.snapshot;
          // Snapshots are cached from when their read ended, so a reader that waited for the
          // lock reuses the read it waited for.
          if (cached && !refresh && nowMs - cached.fetchedAtMs < ACCOUNT_LIST_TTL_MS) {
            return cached.value;
          }

          const listed = yield* withManagementKey(
            connection,
            management(connection, state, ROUTES.credentials, { method: "GET" }),
          ).pipe(Effect.result);
          if (listed._tag === "Failure") {
            const failedAtMs = yield* Clock.currentTimeMillis;
            const snapshot = errorSnapshot(base, failedAtMs, listed.failure.message);
            state.snapshot = { fetchedAtMs: failedAtMs, value: snapshot };
            return snapshot;
          }

          const records = parseHubAccounts(listed.success.data);
          const [apiKeys, accounts] = yield* Effect.all(
            [
              management(connection, state, ROUTES.apiKeyUsage, { method: "GET" }).pipe(
                Effect.map(({ data }) => ({ usage: parseApiKeyUsage(data) })),
                Effect.catch((error: HubRequestError) =>
                  Effect.succeed({
                    error: displayText(error.message, "The hub did not return API-key counters."),
                  }),
                ),
              ),
              Effect.forEach(
                records,
                (record) =>
                  readQuota(connection, state, record, refresh, nowMs).pipe(
                    Effect.map((quota): CliProxyAccount => ({ ...record.account, quota })),
                  ),
                { concurrency: QUOTA_CONCURRENCY },
              ),
            ],
            { concurrency: 2 },
          );
          for (const authIndex of state.quotas.keys()) {
            if (!records.some((record) => record.account.authIndex === authIndex)) {
              state.quotas.delete(authIndex);
              state.claudePlans.delete(authIndex);
            }
          }

          const doneMs = yield* Clock.currentTimeMillis;
          const snapshot: HubRead = {
            ...base,
            checkedAt: isoAt(doneMs),
            status: "ok",
            ...(listed.success.version ? { version: listed.success.version } : {}),
            accounts,
            apiKeys: "usage" in apiKeys ? apiKeys.usage : [],
            ...("error" in apiKeys ? { apiKeysError: apiKeys.error } : {}),
          };
          state.snapshot = { fetchedAtMs: doneMs, value: snapshot };
          return snapshot;
        }),
      );
    });

  const readSettings = settingsService.getSettings.pipe(
    Effect.mapError(() => new CliProxyHubError({ message: "Couldn't read the hub settings." })),
  );

  const readHubs: CliProxyServiceShape["readHubs"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      const hubs = settings.cliProxyHubs;
      yield* forgetRemovedHubs(new Set(Object.keys(hubs)));
      const enabled = Object.entries(hubs).filter(([, hub]) => hub.enabled) as Array<
        [CliProxyHubId, CliProxyHubConfig]
      >;
      const snapshots = yield* Effect.forEach(
        enabled,
        ([hubId, hub]) =>
          readHub(hubId, hub, input.refresh === true).pipe(
            Effect.map((read): CliProxyHubSnapshot => ({
              ...read,
              routedInstanceIds: routedInstanceIds(read.url, settings.providerInstances),
            })),
          ),
        { concurrency: "unbounded" },
      );
      return { hubs: snapshots };
    });

  const testHub: CliProxyServiceShape["testHub"] = (input) =>
    Effect.gen(function* () {
      const baseUrl = normalizeHubBaseUrl(input.url);
      if (!baseUrl) return yield* new CliProxyHubError({ message: INVALID_HUB_URL_MESSAGE });
      const saved = input.hubId ? (yield* readSettings).cliProxyHubs[input.hubId] : undefined;
      const savedAddressApplies = saved && hubKeyAddress(saved.url) === hubKeyAddress(baseUrl);
      let managementKey = input.managementKey?.trim() ?? "";
      if (managementKey.length === 0 && input.hubId !== undefined) {
        // A saved key only ever goes to the address it was entered for.
        if (saved && !savedAddressApplies) {
          return yield* new CliProxyHubError({
            message: "Enter the management key again to test a different hub address.",
          });
        }
        managementKey = saved?.managementKey.trim() ?? "";
      }
      if (managementKey.length === 0) {
        return yield* new CliProxyHubError({ message: "Enter the hub's management key." });
      }
      const clientId =
        input.cloudflareAccessClientId?.trim() ??
        (savedAddressApplies ? saved.cloudflareAccessClientId?.trim() : undefined) ??
        "";
      let clientSecret = input.cloudflareAccessClientSecret?.trim() ?? "";
      if (clientId && !clientSecret && saved?.cloudflareAccessClientSecret) {
        if (!savedAddressApplies || saved.cloudflareAccessClientId?.trim() !== clientId) {
          return yield* new CliProxyHubError({
            message:
              "Enter the Cloudflare Access Client Secret again to test a different hub address or Client ID.",
          });
        }
        clientSecret = saved.cloudflareAccessClientSecret.trim();
      }
      if (
        !savedAddressApplies &&
        saved?.cloudflareAccessClientId &&
        input.cloudflareAccessClientId === undefined
      ) {
        return yield* new CliProxyHubError({
          message: "Enter the Cloudflare Access credentials again to test a different hub address.",
        });
      }
      const invalid = validateCloudflareAccessCredentials({ clientId, clientSecret });
      if (invalid) return yield* new CliProxyHubError({ message: invalid });
      // Tests share the key admission with reads: a stored key the hub rejected is not resent.
      const connection: HubConnection = {
        baseUrl,
        managementKey,
        cloudflareAccessClientId: clientId,
        cloudflareAccessClientSecret: clientSecret,
      };
      const listed = yield* withManagementKey(
        connection,
        management(connection, { api: undefined }, ROUTES.credentials, { method: "GET" }),
      ).pipe(Effect.mapError((error) => new CliProxyHubError({ message: error.message })));
      return {
        ...(listed.version ? { version: listed.version } : {}),
        accountCount: parseHubAccounts(listed.data).length,
      };
    });

  return CliProxyService.of({ readHubs, testHub });
});

export const CliProxyServiceLive = Layer.effect(CliProxyService, makeCliProxyService);

/** Route tests that do not provide the live service read no hubs. */
export const CliProxyServiceUnavailable = CliProxyService.of({
  readHubs: () => Effect.succeed({ hubs: [] }),
  testHub: () =>
    Effect.fail(
      new CliProxyHubError({ message: "CLIProxyAPI hubs are unavailable on this node." }),
    ),
});
