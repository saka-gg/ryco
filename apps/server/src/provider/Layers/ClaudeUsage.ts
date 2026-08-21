import { execFile } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import type { ClaudeSettings, ServerProviderRateLimits } from "@ryco/contracts";
import { Effect, Path } from "effect";

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";

const CLAUDE_USAGE_API = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const KEYCHAIN_SERVICE_NAME = "Claude Code-credentials";
const CLAUDE_USAGE_BETA_HEADER = "oauth-2025-04-20";
const TOKEN_REFRESH_SKEW_MS = 60_000;

interface ClaudeCredentials {
  readonly claudeAiOauth?: {
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly expiresAt?: string | number;
    readonly subscriptionType?: string;
    readonly rateLimitTier?: string;
  };
}

interface TokenRefreshResult {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

function keychainRead(): Promise<ClaudeCredentials | null> {
  if (process.platform !== "darwin") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE_NAME, "-w"],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(stdout.trim()) as ClaudeCredentials);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function keychainWrite(credentials: ClaudeCredentials): Promise<void> {
  if (process.platform !== "darwin") {
    return Promise.resolve();
  }

  const payload = JSON.stringify(credentials);
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE_NAME],
      { timeout: 5_000 },
      () => {
        execFile(
          "/usr/bin/security",
          ["add-generic-password", "-s", KEYCHAIN_SERVICE_NAME, "-w", payload, "-U"],
          { timeout: 5_000 },
          () => resolve(),
        );
      },
    );
  });
}

async function readCredentialsFile(credentialsPath: string): Promise<ClaudeCredentials | null> {
  try {
    return JSON.parse(await NodeFS.readFile(credentialsPath, "utf8")) as ClaudeCredentials;
  } catch {
    return null;
  }
}

async function writeCredentialsFile(
  credentialsPath: string,
  credentials: ClaudeCredentials,
): Promise<void> {
  try {
    await NodeFS.mkdir(NodePath.dirname(credentialsPath), { recursive: true });
    await NodeFS.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), "utf8");
  } catch {
    // Best effort only. A refreshed in-memory token can still serve this request.
  }
}

async function readClaudeCredentials(credentialsPath: string): Promise<ClaudeCredentials | null> {
  const keychainCredentials = await keychainRead();
  if (keychainCredentials?.claudeAiOauth?.accessToken) {
    return keychainCredentials;
  }
  return readCredentialsFile(credentialsPath);
}

function parseExpiresAtMs(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseResetEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

async function refreshAndPersistToken(input: {
  readonly credentials: ClaudeCredentials;
  readonly credentialsPath: string;
}): Promise<string | null> {
  const refreshToken = input.credentials.claudeAiOauth?.refreshToken;
  if (!refreshToken) {
    return null;
  }

  try {
    const response = await fetch(CLAUDE_TOKEN_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as TokenRefreshResult;
    if (!data.access_token) {
      return null;
    }

    const updated: ClaudeCredentials = {
      ...input.credentials,
      claudeAiOauth: {
        ...input.credentials.claudeAiOauth,
        accessToken: data.access_token,
        ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        ...(typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
          ? { expiresAt: Date.now() + data.expires_in * 1000 }
          : {}),
      },
    };

    await Promise.all([
      keychainWrite(updated),
      writeCredentialsFile(input.credentialsPath, updated),
    ]);
    return data.access_token;
  } catch {
    return null;
  }
}

function claudeUsageUserAgent(version: string | null | undefined): string {
  return version ? `claude-code/${version}` : "claude-code";
}

async function callUsageApi(
  accessToken: string,
  version: string | null | undefined,
): Promise<Response> {
  return fetch(CLAUDE_USAGE_API, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": CLAUDE_USAGE_BETA_HEADER,
      "User-Agent": claudeUsageUserAgent(version),
    },
  });
}

function readUsageTier(
  data: Record<string, unknown>,
  key: string,
): { readonly utilization: number; readonly resetsAt?: number } | undefined {
  const value = data[key];
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const utilization = record.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return undefined;
  }

  const resetsAt = parseResetEpochSeconds(record.resets_at);
  return {
    utilization,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Weekly windows the usage API scopes to a single premium model, most
 * capable first. These sit alongside the account-wide `seven_day` cap and
 * are the ones users actually run out of, so the first one present is
 * surfaced as its own window. Sonnet-scoped windows are deliberately not
 * listed — the account-wide weekly window already tracks that spend.
 */
const MODEL_WEEKLY_TIERS = [
  { model: "fable", label: "Fable weekly" },
  { model: "opus", label: "Opus weekly" },
] as const;

/**
 * Match `seven_day_fable` and generation-suffixed variants the API may
 * start emitting (`seven_day_fable_5`), without matching an unrelated
 * model whose name merely starts with the same letters.
 */
function matchesModelWeeklyKey(key: string, model: string): boolean {
  const prefix = `seven_day_${model}`;
  if (!key.startsWith(prefix)) {
    return false;
  }
  const suffix = key.slice(prefix.length);
  return suffix.length === 0 || /^[_-]?\d+$/.test(suffix);
}

function readModelWeeklyTier(
  data: Record<string, unknown>,
):
  | { readonly utilization: number; readonly resetsAt?: number; readonly label: string }
  | undefined {
  for (const tier of MODEL_WEEKLY_TIERS) {
    for (const key of Object.keys(data)) {
      if (!matchesModelWeeklyKey(key, tier.model)) continue;
      const parsed = readUsageTier(data, key);
      if (parsed) {
        return { ...parsed, label: tier.label };
      }
    }
  }
  return undefined;
}

export function parseClaudeUsageRateLimits(
  data: Record<string, unknown>,
  plan: string | null | undefined,
): ServerProviderRateLimits | undefined {
  const fiveHour = readUsageTier(data, "five_hour");
  const sevenDay = readUsageTier(data, "seven_day");
  const modelWeekly = readModelWeeklyTier(data);

  if (!fiveHour && !sevenDay && !modelWeekly) {
    return undefined;
  }

  return {
    limitId: "claude-oauth",
    ...(plan ? { limitName: plan, planType: plan } : {}),
    ...(fiveHour
      ? {
          primary: {
            usedPercent: fiveHour.utilization,
            windowDurationMins: 5 * 60,
            ...(fiveHour.resetsAt !== undefined ? { resetsAt: fiveHour.resetsAt } : {}),
          },
        }
      : {}),
    ...(sevenDay
      ? {
          secondary: {
            usedPercent: sevenDay.utilization,
            windowDurationMins: 7 * 24 * 60,
            ...(sevenDay.resetsAt !== undefined ? { resetsAt: sevenDay.resetsAt } : {}),
          },
        }
      : {}),
    ...(modelWeekly
      ? {
          tertiary: {
            usedPercent: modelWeekly.utilization,
            windowDurationMins: 7 * 24 * 60,
            label: modelWeekly.label,
            ...(modelWeekly.resetsAt !== undefined ? { resetsAt: modelWeekly.resetsAt } : {}),
          },
        }
      : {}),
  };
}

async function fetchClaudeUsageRateLimits(input: {
  readonly credentialsPath: string;
  readonly version?: string | null;
}): Promise<ServerProviderRateLimits | undefined> {
  const credentials = await readClaudeCredentials(input.credentialsPath);
  if (!credentials?.claudeAiOauth?.accessToken) {
    return undefined;
  }

  let accessToken = credentials.claudeAiOauth.accessToken;
  const plan =
    credentials.claudeAiOauth.subscriptionType ?? credentials.claudeAiOauth.rateLimitTier ?? null;
  const expiresAt = parseExpiresAtMs(credentials.claudeAiOauth.expiresAt);
  if (expiresAt !== undefined && Date.now() > expiresAt - TOKEN_REFRESH_SKEW_MS) {
    accessToken =
      (await refreshAndPersistToken({ credentials, credentialsPath: input.credentialsPath })) ??
      accessToken;
  }

  let response = await callUsageApi(accessToken, input.version);
  if (response.status === 429 && credentials.claudeAiOauth.refreshToken) {
    const refreshedAccessToken = await refreshAndPersistToken({
      credentials,
      credentialsPath: input.credentialsPath,
    });
    if (refreshedAccessToken) {
      accessToken = refreshedAccessToken;
      response = await callUsageApi(accessToken, input.version);
    }
  }

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as Record<string, unknown>;
  return parseClaudeUsageRateLimits(data, plan);
}

export const probeClaudeUsageRateLimits = Effect.fn("probeClaudeUsageRateLimits")(function* (
  claudeSettings: ClaudeSettings,
  version?: string | null,
): Effect.fn.Return<ServerProviderRateLimits | undefined, never, Path.Path> {
  const claudeHome = yield* resolveClaudeHomePath(claudeSettings);
  const credentialsPath = NodePath.join(claudeHome, ".claude", ".credentials.json");

  return yield* Effect.tryPromise({
    try: () =>
      fetchClaudeUsageRateLimits({
        credentialsPath,
        ...(version !== undefined ? { version } : {}),
      }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));
});
