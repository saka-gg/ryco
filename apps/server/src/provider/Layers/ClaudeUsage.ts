import { execFile } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ClaudeSettings, ServerProviderRateLimits } from "@ryco/contracts";
import { Effect, Path } from "effect";

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";

/**
 * Claude OAuth usage limits, read with Claude Code's own credentials.
 *
 * The credentials (Keychain entry or `.credentials.json`) belong to Claude Code. This probe only
 * reads them: it never refreshes the token and never writes the store. Claude Code rotates its
 * refresh token on every refresh, so a refresh from here could race the CLI (which refreshes the
 * same token whenever it runs) and log the user out of Claude Code. An access token that has
 * expired, or is rejected, simply means "no live limit data" until Claude Code refreshes it.
 */
const CLAUDE_USAGE_API = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE_NAME = "Claude Code-credentials";
const CLAUDE_USAGE_BETA_HEADER = "oauth-2025-04-20";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;

interface ClaudeCredentials {
  readonly claudeAiOauth?: {
    readonly accessToken?: string;
    readonly expiresAt?: string | number;
    readonly subscriptionType?: string;
    readonly rateLimitTier?: string;
  };
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

async function readCredentialsFile(credentialsPath: string): Promise<ClaudeCredentials | null> {
  try {
    return JSON.parse(await NodeFS.readFile(credentialsPath, "utf8")) as ClaudeCredentials;
  } catch {
    return null;
  }
}

async function readClaudeCredentials(
  credentialsPath: string,
  useKeychain: boolean,
): Promise<ClaudeCredentials | null> {
  // The global Keychain entry belongs only to the default home. A separate
  // home must never fall back to another account, even when its file is absent.
  if (useKeychain) {
    const credentials = await keychainRead();
    if (credentials?.claudeAiOauth?.accessToken) return credentials;
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

function claudeUsageUserAgent(version: string | null | undefined): string {
  return version ? `claude-code/${version}` : "claude-code";
}

async function callUsageApi(
  accessToken: string,
  version: string | null | undefined,
): Promise<Response> {
  return fetch(CLAUDE_USAGE_API, {
    signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
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
  const credentials = await readClaudeCredentials(input.credentialsPath, input.useKeychain);
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken) return undefined;

  const plan = oauth.subscriptionType ?? oauth.rateLimitTier ?? null;
  const expiresAt = parseExpiresAtMs(oauth.expiresAt);
  if (expiresAt !== undefined && Date.now() > expiresAt - TOKEN_EXPIRY_SKEW_MS) {
    // Expired: Claude Code refreshes it the next time it runs. Never refresh it from here.
    return undefined;
  }

  const response = await callUsageApi(oauth.accessToken, input.version);
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
