import { execFile } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
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

async function readClaudeCredentials(
  credentialsPath: string,
  useKeychain: boolean,
): Promise<{
  readonly credentials: ClaudeCredentials;
  readonly fromKeychain: boolean;
} | null> {
  // The global Keychain entry belongs only to the default home. A separate
  // home must never fall back to another account, even when its file is absent.
  if (useKeychain) {
    const credentials = await keychainRead();
    if (credentials?.claudeAiOauth?.accessToken) return { credentials, fromKeychain: true };
  }
  const credentials = await readCredentialsFile(credentialsPath);
  return credentials ? { credentials, fromKeychain: false } : null;
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
  readonly fromKeychain: boolean;
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

    // Persist only to the store that supplied this account.
    if (input.fromKeychain) await keychainWrite(updated);
    else await writeCredentialsFile(input.credentialsPath, updated);
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

export function parseClaudeUsageRateLimits(
  data: Record<string, unknown>,
  plan: string | null | undefined,
): ServerProviderRateLimits | undefined {
  const fiveHour = readUsageTier(data, "five_hour");
  const sevenDay = readUsageTier(data, "seven_day");

  if (!fiveHour && !sevenDay) {
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
  };
}

async function fetchClaudeUsageRateLimits(input: {
  readonly credentialsPath: string;
  readonly useKeychain: boolean;
  readonly version?: string | null;
}): Promise<ServerProviderRateLimits | undefined> {
  const selected = await readClaudeCredentials(input.credentialsPath, input.useKeychain);
  if (!selected) return undefined;
  const { credentials, fromKeychain } = selected;
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken) return undefined;

  let accessToken = oauth.accessToken;
  const plan = oauth.subscriptionType ?? oauth.rateLimitTier ?? null;
  const expiresAt = parseExpiresAtMs(oauth.expiresAt);
  if (expiresAt !== undefined && Date.now() > expiresAt - TOKEN_REFRESH_SKEW_MS) {
    accessToken =
      (await refreshAndPersistToken({
        credentials,
        credentialsPath: input.credentialsPath,
        fromKeychain,
      })) ?? accessToken;
  }

  let response = await callUsageApi(accessToken, input.version);
  if (response.status === 429 && oauth.refreshToken) {
    const refreshedAccessToken = await refreshAndPersistToken({
      credentials,
      credentialsPath: input.credentialsPath,
      fromKeychain,
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
        useKeychain: claudeHome === NodePath.resolve(NodeOS.homedir()),
        ...(version !== undefined ? { version } : {}),
      }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));
});
