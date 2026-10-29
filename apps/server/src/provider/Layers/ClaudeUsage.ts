import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderRateLimits } from "@ryco/contracts";
import { claudeNonLoginCredentialSource } from "@ryco/shared/claudeCredentialVariables";
import { Cache, Clock, type Duration, Effect } from "effect";

import { parseProviderSourcePaths } from "../ProviderSourcePaths.ts";
import {
  requestUsage,
  usageAccountKey,
  type UsageReadGate,
  type UsageReadOutcome,
  type UsageReadPlan,
} from "../usageReadGate.ts";
import {
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_OAUTH_USAGE_URL,
  parseClaudeUsageWindows,
  type ClaudeUsageWindow,
} from "../claudeOAuthUsage.ts";

/**
 * Claude Code owns these credentials and refreshes its rotating tokens. Usage probes only
 * read them; an expired or rejected token yields no live limit data until the CLI refreshes it.
 */
const KEYCHAIN_SERVICE_NAME = "Claude Code-credentials";
const KEYCHAIN_FALLBACK_ACCOUNT = "claude-code-user";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;

interface ClaudeCredentials {
  readonly claudeAiOauth?: {
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly expiresAt?: string | number;
    readonly subscriptionType?: string;
    readonly rateLimitTier?: string;
  };
}

export interface ClaudeKeychainItem {
  readonly service: string;
  readonly account: string;
}

/** Where Claude Code keeps a claude.ai login: its macOS Keychain item first, then its file. */
export interface ClaudeCredentialStore {
  readonly credentialsPath: string;
  readonly keychain: ClaudeKeychainItem | undefined;
}

/** Account fields Claude Code reports at initialization. */
export interface ClaudeLoginAccount {
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
}

function usesLocalClaudeLogin(
  environment: NodeJS.ProcessEnv,
  account: ClaudeLoginAccount,
): boolean {
  // Claude Code reports a subscription, and no token source, only while it authenticates with its
  // claude.ai login; a "claude.ai" token source means a login exists but something else is used.
  // A base URL set only in its settings files is not reported, so it cannot be detected here.
  // Any other credential or provider would make the login's usage describe another account.
  if (account.subscriptionType === undefined || account.tokenSource !== undefined) return false;
  return claudeNonLoginCredentialSource(environment) === undefined;
}

function keychainService(configDir: string | undefined): string {
  if (configDir === undefined) return KEYCHAIN_SERVICE_NAME;
  const digest = createHash("sha256").update(configDir.normalize("NFC")).digest("hex");
  return `${KEYCHAIN_SERVICE_NAME}-${digest.slice(0, 8)}`;
}

function keychainAccount(environment: NodeJS.ProcessEnv): string {
  let user = environment.USER;
  if (!user) {
    try {
      user = NodeOS.userInfo().username;
    } catch {
      return KEYCHAIN_FALLBACK_ACCOUNT;
    }
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : KEYCHAIN_FALLBACK_ACCOUNT;
}

/**
 * The store of the claude.ai login an instance runs with, or undefined when it authenticates
 * any other way. `environment` must be the instance's effective environment
 * (`makeClaudeEnvironment`), the one its Claude Code processes see, and `account` what those
 * processes reported at initialization.
 *
 * Mirrors Claude Code 2.1.296: `CLAUDE_CONFIG_DIR` moves the file and gives the login its own
 * Keychain item, suffixed with a hash of that directory. Only the real user home reads the
 * Keychain; a separate home uses its own file.
 */
export function resolveClaudeLoginStore(
  environment: NodeJS.ProcessEnv,
  account: ClaudeLoginAccount,
  userHome = NodeOS.homedir(),
): ClaudeCredentialStore | undefined {
  if (!usesLocalClaudeLogin(environment, account)) return undefined;
  // Claude Code's undocumented store override: no usage rather than another store's.
  if (environment.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return undefined;
  const { home, root } = parseProviderSourcePaths("claudeAgent", {}, environment, userHome);
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim()
    ? environment.CLAUDE_CONFIG_DIR
    : undefined;
  return {
    credentialsPath: NodePath.join(root, ".credentials.json"),
    keychain:
      home === NodePath.resolve(userHome)
        ? { service: keychainService(configDir), account: keychainAccount(environment) }
        : undefined,
  };
}

function keychainRead(keychain: ClaudeKeychainItem): Promise<ClaudeCredentials | null> {
  if (process.platform !== "darwin") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", keychain.account, "-s", keychain.service, "-w"],
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

async function readClaudeCredentials(store: ClaudeCredentialStore): Promise<{
  readonly credentials: ClaudeCredentials;
  /** The Keychain item that supplied the credentials; undefined when the file did. */
  readonly keychain: ClaudeKeychainItem | undefined;
} | null> {
  // A store without a Keychain item must never fall back to another login's item, even when
  // its file is absent.
  if (store.keychain) {
    const credentials = await keychainRead(store.keychain);
    if (credentials?.claudeAiOauth?.accessToken) return { credentials, keychain: store.keychain };
  }
  const credentials = await readCredentialsFile(store.credentialsPath);
  return credentials ? { credentials, keychain: undefined } : null;
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

function claudeUsageUserAgent(version: string | null): string {
  return version ? `claude-code/${version}` : "claude-code";
}

function callUsageApi(
  fetchImpl: typeof globalThis.fetch,
  accessToken: string,
  version: string | null,
): Promise<Response> {
  return fetchImpl(CLAUDE_OAUTH_USAGE_URL, {
    signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      "User-Agent": claudeUsageUserAgent(version),
    },
  });
}

function rateLimitWindow(window: ClaudeUsageWindow) {
  return {
    usedPercent: window.usedPercent,
    ...(window.windowDurationMins !== undefined
      ? { windowDurationMins: window.windowDurationMins }
      : {}),
    ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
  };
}

/**
 * The usage response as rate limits, read at `nowMs`. The account-wide five-hour and weekly
 * windows fill the legacy slots; `windows` also carries the model-scoped ones and credit pools.
 */
export function parseClaudeUsageRateLimits(
  data: unknown,
  plan: string | null | undefined,
  nowMs: number,
): ServerProviderRateLimits | undefined {
  const windows = parseClaudeUsageWindows(data);
  const fiveHour = windows.find((window) => window.id === "five_hour");
  const sevenDay = windows.find((window) => window.id === "seven_day");

  if (!fiveHour && !sevenDay) {
    return undefined;
  }

  return {
    limitId: "claude-oauth",
    ...(plan ? { limitName: plan, planType: plan } : {}),
    ...(fiveHour ? { primary: rateLimitWindow(fiveHour) } : {}),
    ...(sevenDay ? { secondary: rateLimitWindow(sevenDay) } : {}),
    windows,
    observedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * The usage read of the login in `store` (resolve it with `resolveClaudeLoginStore`): its account
 * key and the one usage request, or undefined when the store holds no login. An expired token
 * clears usage without a request; Claude Code refreshes its own tokens.
 */
export const planClaudeUsageRead = Effect.fn("planClaudeUsageRead")(function* (
  store: ClaudeCredentialStore,
  version: string | null,
  fetchImpl: typeof globalThis.fetch = fetch,
): Effect.fn.Return<UsageReadPlan | undefined> {
  const selected = yield* Effect.tryPromise(() => readClaudeCredentials(store)).pipe(
    Effect.orElseSucceed(() => null),
  );
  const oauth = selected?.credentials.claudeAiOauth;
  const accessToken = oauth?.accessToken;
  if (!oauth || !accessToken) return undefined;

  // Keyed on the login's token too, so another login in the same store never gets these
  // numbers; a token rotation only starts a fresh read state.
  const accountKey = usageAccountKey(
    "claude",
    store.credentialsPath,
    store.keychain?.service ?? "",
    oauth.refreshToken ?? accessToken,
  );
  const nowMs = yield* Clock.currentTimeMillis;
  const expiresAt = parseExpiresAtMs(oauth.expiresAt);
  if (expiresAt !== undefined && nowMs > expiresAt - TOKEN_EXPIRY_SKEW_MS) {
    return { accountKey, fetch: Effect.succeed<UsageReadOutcome>({ _tag: "Cleared" }) };
  }

  const plan = oauth.subscriptionType ?? oauth.rateLimitTier ?? null;
  return {
    accountKey,
    fetch: requestUsage(
      () => callUsageApi(fetchImpl, accessToken, version),
      (body, nowMs) => parseClaudeUsageRateLimits(body, plan, nowMs),
    ),
  };
});

/**
 * Usage reads of this instance's login through its `gate`, behind a cache keyed on the
 * credential store as well as the CLI version, so usage read for one login is never served for
 * another.
 */
export const makeCachedClaudeUsageProbe = Effect.fn("makeCachedClaudeUsageProbe")(function* (
  timeToLive: Duration.Input,
  gate: UsageReadGate,
) {
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive,
    lookup: (key: ClaudeCredentialStore & { readonly version: string | null }) =>
      gate.read(planClaudeUsageRead(key, key.version)),
  });
  return (store: ClaudeCredentialStore, version: string | null) =>
    Cache.get(cache, { ...store, version });
});
