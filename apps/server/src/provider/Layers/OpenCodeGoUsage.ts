/**
 * OpenCodeGoUsage — probes OpenCode Go subscription usage limits.
 *
 * Mirrors `ClaudeUsage.ts`: reads the OpenCode CLI's credential store
 * (`<data dir>/auth.json`), calls the Go usage API with the stored
 * `opencode-go` API key, and maps the response onto the shared
 * `ServerProviderRateLimits` contract (rolling → primary, weekly →
 * secondary, monthly → tertiary).
 *
 * Every failure path degrades to `undefined` — a missing Go key or an
 * unreachable API must never make the provider snapshot probe fail. Behind
 * a `UsageReadGate`, a throttled or failed read re-serves the last good one.
 *
 * @module provider/Layers/OpenCodeGoUsage
 */
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderRateLimits, ServerProviderRateLimitWindow } from "@ryco/contracts";
import { Effect } from "effect";

import { requestUsage, usageAccountKey, type UsageReadPlan } from "../usageReadGate.ts";

const OPENCODE_GO_USAGE_API = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_TIMEOUT_MS = 5_000;
const ROLLING_WINDOW_DURATION_MINS = 5 * 60;
const WEEKLY_WINDOW_DURATION_MINS = 7 * 24 * 60;
const MONTHLY_WINDOW_DURATION_MINS = 30 * 24 * 60;

interface OpenCodeAuthEntry {
  readonly type?: unknown;
  readonly key?: unknown;
}

interface OpenCodeAuthStore {
  readonly [providerId: string]: OpenCodeAuthEntry | undefined;
}

interface OpenCodeGoUsageWindow {
  readonly status?: unknown;
  readonly percent?: unknown;
  readonly resetsAt?: unknown;
}

interface OpenCodeGoUsageResponse {
  readonly usage?: Record<string, OpenCodeGoUsageWindow | undefined>;
}

export function resolveOpenCodeDataDirPath(environment: NodeJS.ProcessEnv = process.env): string {
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  const home = environment.HOME?.trim() || NodeOS.homedir();
  const base =
    xdgDataHome && xdgDataHome.length > 0 ? xdgDataHome : NodePath.join(home, ".local", "share");
  return NodePath.join(base, "opencode");
}

async function readOpenCodeGoLogin(
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly authPath: string; readonly apiKey: string } | undefined> {
  try {
    const authPath = NodePath.join(resolveOpenCodeDataDirPath(environment), "auth.json");
    const store = JSON.parse(await NodeFS.readFile(authPath, "utf8")) as OpenCodeAuthStore;
    const entry = store["opencode-go"];
    const key = entry?.key;
    if (typeof key !== "string" || key.trim().length === 0) {
      return undefined;
    }
    return { authPath, apiKey: key.trim() };
  } catch {
    return undefined;
  }
}

/** The usage response as rate limits, read at `nowMs`. */
export function parseOpenCodeGoUsageRateLimits(
  data: unknown,
  nowMs: number,
): ServerProviderRateLimits | undefined {
  const windows = (data as OpenCodeGoUsageResponse | null | undefined)?.usage;
  if (!windows || typeof windows !== "object") {
    return undefined;
  }

  const buildWindow = (
    raw: OpenCodeGoUsageWindow | undefined,
    windowDurationMins: number,
  ): ServerProviderRateLimitWindow | undefined => {
    if (!raw || typeof raw !== "object" || typeof raw.percent !== "number") {
      return undefined;
    }
    if (!Number.isFinite(raw.percent)) {
      return undefined;
    }
    const resetsAt = typeof raw.resetsAt === "string" ? Date.parse(raw.resetsAt) : Number.NaN;
    return {
      usedPercent: raw.percent,
      windowDurationMins,
      ...(Number.isFinite(resetsAt) ? { resetsAt: Math.floor(resetsAt / 1000) } : {}),
    };
  };

  const primary = buildWindow(windows.rolling, ROLLING_WINDOW_DURATION_MINS);
  const secondary = buildWindow(windows.weekly, WEEKLY_WINDOW_DURATION_MINS);
  const tertiary = buildWindow(windows.monthly, MONTHLY_WINDOW_DURATION_MINS);

  if (!primary && !secondary && !tertiary) {
    return undefined;
  }

  return {
    limitId: "opencode-go",
    limitName: "OpenCode Go",
    planType: "go",
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(tertiary ? { tertiary } : {}),
    observedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * The Go usage read of the `opencode-go` key in the CLI's `auth.json`: its account key and the one
 * usage request, or undefined without a Go key.
 */
export const planOpenCodeGoUsageRead = Effect.fn("planOpenCodeGoUsageRead")(function* (
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = fetch,
): Effect.fn.Return<UsageReadPlan | undefined> {
  const login = yield* Effect.promise(() => readOpenCodeGoLogin(environment));
  if (!login) return undefined;
  return {
    accountKey: usageAccountKey("opencode-go", login.authPath, login.apiKey),
    fetch: requestUsage(
      () =>
        fetchImpl(OPENCODE_GO_USAGE_API, {
          headers: {
            Authorization: `Bearer ${login.apiKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(OPENCODE_GO_USAGE_TIMEOUT_MS),
        }),
      parseOpenCodeGoUsageRateLimits,
    ),
  };
});
