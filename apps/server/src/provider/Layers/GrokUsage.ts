/**
 * GrokUsage — reads the credit usage of the Grok CLI's own login.
 *
 * Mirrors `ClaudeUsage.ts`: the Grok CLI owns its login (`<GROK_HOME>/auth.json`) and refreshes
 * its tokens; Ryco only reads them, never refreshes or rewrites them. An expired token means no
 * read until the CLI renews it. The read is conservative: an API-key instance, an alternate auth
 * deployment or custom endpoint (environment or config), or a file without the standard login
 * reads nothing, so another account's credits are never shown.
 *
 * Every failure degrades to no usage; a read never fails the provider probe. Behind a
 * `UsageReadGate`, a throttled or failed read re-serves the last good one.
 *
 * Imported only by the Grok driver chunk, never by the server boot path.
 *
 * @module provider/Layers/GrokUsage
 */
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CliProxyQuotaWindow, ServerProviderRateLimits } from "@ryco/contracts";
import { Context, Effect, Option } from "effect";

import { usesGrokApiKey } from "../acp/GrokAcpSupport.ts";
import {
  credentialUsageReadPlan,
  parseCredentialExpiresAtMs,
  requestUsage,
  usageAccountKey,
  type UsageReadGate,
  type UsageReadPlan,
} from "../usageReadGate.ts";

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_USAGE_TIMEOUT_MS = 10_000;
// Reading a few local files; bounded so an odd file (a FIFO) can never hold up the probe.
const GROK_LOGIN_READ_TIMEOUT_MS = 5_000;
const WEEKLY_WINDOW_DURATION_MINS = 7 * 24 * 60;
const MONTHLY_WINDOW_DURATION_MINS = 30 * 24 * 60;
const DEFAULT_SYSTEM_CONFIG_DIR = "/etc/grok";

// The CLI's `grok login` entry, then its legacy one. Any other entry may belong to another
// deployment or account, so it is used only as the file's single `auth.x.ai` login.
const GROK_LOGIN_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const GROK_LEGACY_LOGIN_KEY = "https://accounts.x.ai/sign-in";
const GROK_LOGIN_KEY_PREFIX = "https://auth.x.ai::";

// Grok CLI variables that select another issuer, principal, credential source or endpoint: the
// stored login may then describe another account, or not be the one the CLI uses.
export const GROK_ALTERNATE_AUTH_VARIABLES = [
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_OAUTH2_ISSUER",
  "GROK_OAUTH2_CLIENT_ID",
  "GROK_OAUTH2_PRINCIPAL_TYPE",
  "GROK_OAUTH2_PRINCIPAL_ID",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_LOCAL_AUTH",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
  "GROK_MODELS_BASE_URL",
  "GROK_CONFIG",
  "GROK_CONFIG_PATH",
] as const;

// A config section (`[auth]`, `[endpoints.x]`, `[[auth]]`) or dotted key that changes the account
// or endpoint the CLI uses.
const ALTERNATE_AUTH_CONFIG =
  /^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/mu;

// A complete ISO date-time with an offset, as the billing API reports period boundaries.
const ISO_DATE_TIME =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

interface GrokAuthEntry {
  readonly key?: unknown;
  readonly auth_mode?: unknown;
  readonly email?: unknown;
  readonly expires_at?: unknown;
  readonly refresh_token?: unknown;
}

interface GrokBillingResponse {
  readonly config?: {
    readonly creditUsagePercent?: unknown;
    readonly currentPeriod?: {
      readonly type?: unknown;
      readonly start?: unknown;
      readonly end?: unknown;
    };
  };
}

/** The Grok CLI login an instance runs with. Holds its token: server memory only. */
export interface GrokLogin {
  readonly email: string | undefined;
  readonly token: string;
  /** `usageAccountKey(...)` of the login; never the token itself. */
  readonly accountKey: string;
  /** When the token expires, in epoch ms; undefined when neither the file nor the token says. */
  readonly expiresAtMs: number | undefined;
}

/** What the probe learns about the signed-in account besides the ACP start. */
export interface GrokAccount {
  readonly email?: string;
  readonly rateLimits?: ServerProviderRateLimits;
}

export interface GrokLoginReadOptions {
  /** The machine-wide Grok config directory; tests point it at a temporary one. */
  readonly systemConfigDir?: string;
}

/** How a Grok instance's account is read; the defaults read the machine's own config. */
export interface GrokAccountReadOptions extends GrokLoginReadOptions {
  /** Sends the billing request; tests pass a fake. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * The account read options `GrokDriver` uses: the machine's own by default. Tests provide a
 * temporary config directory and a fake `fetch`, so a driver test never reads `/etc/grok` or
 * sends a request.
 */
export const GrokAccountReadOptions = Context.Reference<GrokAccountReadOptions>(
  "ryco/provider/GrokUsage/GrokAccountReadOptions",
  { defaultValue: () => ({}) },
);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** `GROK_HOME`, else `~/.grok` of the instance's home. */
export function resolveGrokHomePath(environment: NodeJS.ProcessEnv): string {
  return (
    nonEmptyString(environment.GROK_HOME) ??
    NodePath.join(
      nonEmptyString(environment.HOME) ??
        nonEmptyString(environment.USERPROFILE) ??
        NodeOS.homedir(),
      ".grok",
    )
  );
}

/** Where the Grok CLI keeps its login (`GROK_AUTH` may hold it inline instead). */
export function resolveGrokAuthPath(environment: NodeJS.ProcessEnv): string {
  return NodePath.join(resolveGrokHomePath(environment), "auth.json");
}

/** A file's text, `fallback` when it does not exist; other read errors throw. */
async function readOptionalFile(path: string, fallback: string): Promise<string> {
  try {
    return await NodeFS.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function usesAlternateAuthConfig(home: string, systemConfigDir: string): Promise<boolean> {
  const configs = await Promise.all(
    [
      NodePath.join(home, "config.toml"),
      NodePath.join(home, "managed_config.toml"),
      NodePath.join(home, "requirements.toml"),
      NodePath.join(systemConfigDir, "managed_config.toml"),
      NodePath.join(systemConfigDir, "requirements.toml"),
    ].map((path) => readOptionalFile(path, "")),
  );
  return configs.some((config) => ALTERNATE_AUTH_CONFIG.test(config));
}

/**
 * The standard login entry: the current key, then the legacy one, then the file's only
 * `auth.x.ai` entry. Undefined rather than an arbitrary account when none of these applies.
 */
function selectLoginEntry(
  store: Readonly<Record<string, unknown>>,
): { readonly scope: string; readonly entry: GrokAuthEntry } | undefined {
  const pick = (scope: string) => {
    const entry = store[scope];
    return entry !== null && typeof entry === "object"
      ? { scope, entry: entry as GrokAuthEntry }
      : undefined;
  };
  if (GROK_LOGIN_KEY in store) return pick(GROK_LOGIN_KEY);
  if (GROK_LEGACY_LOGIN_KEY in store) return pick(GROK_LEGACY_LOGIN_KEY);
  const [scope, ...others] = Object.keys(store).filter((key) =>
    key.startsWith(GROK_LOGIN_KEY_PREFIX),
  );
  return scope !== undefined && others.length === 0 ? pick(scope) : undefined;
}

/** The `exp` claim of a JWT access token, in epoch ms; undefined for an opaque token. */
function jwtExpiresAtMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

async function readLogin(
  environment: NodeJS.ProcessEnv,
  systemConfigDir: string,
): Promise<GrokLogin | undefined> {
  // Sessions then authenticate with the key, not the login.
  if (usesGrokApiKey(environment)) return undefined;
  if (GROK_ALTERNATE_AUTH_VARIABLES.some((name) => nonEmptyString(environment[name]))) {
    return undefined;
  }
  const home = resolveGrokHomePath(environment);
  if (await usesAlternateAuthConfig(home, systemConfigDir)) return undefined;

  const inlineAuth = nonEmptyString(environment.GROK_AUTH);
  const authPath = resolveGrokAuthPath(environment);
  const store = JSON.parse(inlineAuth ?? (await readOptionalFile(authPath, "{}"))) as unknown;
  if (store === null || typeof store !== "object" || Array.isArray(store)) return undefined;
  const selected = selectLoginEntry(store as Record<string, unknown>);
  if (!selected || selected.entry.auth_mode === "api_key") return undefined;
  const token = nonEmptyString(selected.entry.key);
  if (!token) return undefined;

  // The earlier of the two expiries counts, so a stale `expires_at` never outlives the token.
  const expiries = [
    parseCredentialExpiresAtMs(selected.entry.expires_at),
    jwtExpiresAtMs(token),
  ].filter((value): value is number => value !== undefined);
  return {
    email: nonEmptyString(selected.entry.email),
    token,
    // Keyed on the refresh token when there is one, so the CLI renewing its access token keeps
    // the read state; another login in the same file starts over.
    accountKey: usageAccountKey(
      "grok",
      inlineAuth === undefined ? authPath : "GROK_AUTH",
      selected.scope,
      nonEmptyString(selected.entry.refresh_token) ?? token,
    ),
    expiresAtMs: expiries.length > 0 ? Math.min(...expiries) : undefined,
  };
}

/**
 * The Grok CLI login `environment` (the instance's effective environment) runs with, or
 * undefined when it uses an API key, an alternate auth deployment or endpoint, or holds no
 * standard login. Unreadable or malformed credentials are no login.
 */
export const readGrokLogin = Effect.fn("readGrokLogin")(function* (
  environment: NodeJS.ProcessEnv,
  options: GrokLoginReadOptions = {},
): Effect.fn.Return<GrokLogin | undefined> {
  const login = yield* Effect.tryPromise(() =>
    readLogin(environment, options.systemConfigDir ?? DEFAULT_SYSTEM_CONFIG_DIR),
  ).pipe(Effect.timeoutOption(GROK_LOGIN_READ_TIMEOUT_MS), Effect.option);
  return Option.flatten(login).pipe(Option.getOrUndefined);
});

/** A billing period boundary in epoch ms; NaN unless it is a real ISO date-time. */
function parsePeriodBoundaryMs(value: unknown): number {
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value)) return Number.NaN;
  // `Date.parse` rolls impossible dates (02-30) into the next month instead of rejecting them.
  const date = value.slice(0, value.indexOf("T"));
  if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) return Number.NaN;
  return Date.parse(value);
}

/**
 * The billing response as rate limits, read at `nowMs`: one credits window, or undefined when the
 * response reports no usage. `creditUsagePercent` is a 0..100 percent; Grok omits it at zero
 * while still reporting a complete weekly or monthly period.
 */
export function parseGrokBillingRateLimits(
  data: unknown,
  nowMs: number,
): ServerProviderRateLimits | undefined {
  const config = (data as GrokBillingResponse | null | undefined)?.config;
  if (config === null || typeof config !== "object") return undefined;
  const period =
    config.currentPeriod !== null && typeof config.currentPeriod === "object"
      ? config.currentPeriod
      : undefined;
  const periodType =
    typeof period?.type === "string" ? period.type.replace(/^USAGE_PERIOD_TYPE_/u, "") : "";
  const windowDurationMins =
    periodType === "WEEKLY"
      ? WEEKLY_WINDOW_DURATION_MINS
      : periodType === "MONTHLY"
        ? MONTHLY_WINDOW_DURATION_MINS
        : undefined;
  const startMs = parsePeriodBoundaryMs(period?.start);
  const endMs = parsePeriodBoundaryMs(period?.end);

  let usedPercent =
    typeof config.creditUsagePercent === "number" && Number.isFinite(config.creditUsagePercent)
      ? config.creditUsagePercent
      : undefined;
  if (
    usedPercent === undefined &&
    config.creditUsagePercent === undefined &&
    windowDurationMins !== undefined &&
    startMs < endMs
  ) {
    usedPercent = 0;
  }
  if (usedPercent === undefined) return undefined;

  // Without a known period the window has no cadence; its scope names it ("Credits").
  const window: CliProxyQuotaWindow = {
    id: "credits",
    ...(windowDurationMins === undefined ? { scope: "Credits" } : {}),
    usedPercent: Math.min(Math.max(usedPercent, 0), 100),
    ...(Number.isFinite(endMs) ? { resetsAt: Math.floor(endMs / 1000) } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
  const { id: _id, scope: _scope, ...slot } = window;
  return {
    limitId: "grok-credits",
    // Older clients render only the slots: weekly in the weekly slot, monthly in the third.
    ...(periodType === "WEEKLY" ? { secondary: slot } : {}),
    ...(periodType === "MONTHLY" ? { tertiary: slot } : {}),
    windows: [window],
    observedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * The credit usage read of `login`: its account key and the one billing request, or undefined
 * without a login. An expired token clears usage without a request; the CLI renews its own token.
 */
export const planGrokUsageRead = Effect.fn("planGrokUsageRead")(function* (
  login: GrokLogin | undefined,
  fetchImpl: typeof globalThis.fetch = fetch,
): Effect.fn.Return<UsageReadPlan | undefined> {
  if (!login) return undefined;
  return yield* credentialUsageReadPlan(
    login.accountKey,
    login.expiresAtMs,
    requestUsage(
      () =>
        fetchImpl(GROK_BILLING_URL, {
          headers: {
            Authorization: `Bearer ${login.token}`,
            Accept: "application/json",
            "x-xai-token-auth": "xai-grok-cli",
          },
          // The token is for this origin only: a redirect fails the read instead of following.
          redirect: "error",
          signal: AbortSignal.timeout(GROK_USAGE_TIMEOUT_MS),
        }),
      parseGrokBillingRateLimits,
    ),
  );
});

/**
 * The signed-in account of `environment` and its credit usage through `gate`. Never fails: an
 * unreadable login or a failed read only leaves fields out.
 */
export const resolveGrokAccount = Effect.fn("resolveGrokAccount")(function* (
  environment: NodeJS.ProcessEnv,
  gate: UsageReadGate,
  options: GrokAccountReadOptions = {},
): Effect.fn.Return<GrokAccount> {
  const login = yield* readGrokLogin(environment, options);
  const rateLimits = yield* gate.read(planGrokUsageRead(login, options.fetchImpl));
  return {
    ...(login?.email ? { email: login.email } : {}),
    ...(rateLimits ? { rateLimits } : {}),
  };
});
