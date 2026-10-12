/**
 * Claude subscription usage (`GET /api/oauth/usage`) response parsing, shared by the native
 * Claude probe (local CLI credentials) and CLIProxyAPI hubs (hub-held credentials).
 *
 * The endpoint reports utilization as a 0..100 percent per window and states no window
 * length, so durations come from the key: `five_hour` is the rolling session window and the
 * `seven_day*` keys are weekly. `limits[]` carries model-scoped weekly windows.
 *
 * @module provider/claudeOAuthUsage
 */
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

const FIVE_HOUR_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

export interface ClaudeUsageWindow {
  readonly id: string;
  /** Model or product the window is limited to; absent for the account-wide windows. */
  readonly scope?: string;
  readonly usedPercent: number;
  /** Epoch seconds. */
  readonly resetsAt?: number;
  readonly windowDurationMins?: number;
}

const NAMED_WINDOWS: ReadonlyArray<{
  readonly key: string;
  readonly id: string;
  readonly scope?: string;
  readonly windowDurationMins: number;
}> = [
  { key: "five_hour", id: "five_hour", windowDurationMins: FIVE_HOUR_MINS },
  { key: "seven_day", id: "seven_day", windowDurationMins: WEEK_MINS },
  { key: "seven_day_opus", id: "seven_day_opus", scope: "Opus", windowDurationMins: WEEK_MINS },
  {
    key: "seven_day_sonnet",
    id: "seven_day_sonnet",
    scope: "Sonnet",
    windowDurationMins: WEEK_MINS,
  },
  {
    key: "seven_day_oauth_apps",
    id: "seven_day_oauth_apps",
    scope: "OAuth apps",
    windowDurationMins: WEEK_MINS,
  },
  {
    key: "seven_day_cowork",
    id: "seven_day_cowork",
    scope: "Cowork",
    windowDurationMins: WEEK_MINS,
  },
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function resetEpochSeconds(value: unknown): number | undefined {
  const text = nonEmptyString(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function window(input: {
  readonly id: string;
  readonly scope: string | undefined;
  readonly usedPercent: number;
  readonly resetsAt: unknown;
  readonly windowDurationMins: number | undefined;
}): ClaudeUsageWindow {
  const resetsAt = resetEpochSeconds(input.resetsAt);
  return {
    id: input.id,
    usedPercent: input.usedPercent,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(input.windowDurationMins !== undefined
      ? { windowDurationMins: input.windowDurationMins }
      : {}),
  };
}

function scopeId(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isDollarDenominated(value: Record<string, unknown>): boolean {
  return (
    finiteNumber(value.limit_dollars) !== undefined ||
    finiteNumber(value.used_dollars) !== undefined ||
    finiteNumber(value.remaining_dollars) !== undefined
  );
}

/** Every reported window, account-wide first. Unreported (null) windows are omitted. */
export function parseClaudeUsageWindows(data: unknown): ClaudeUsageWindow[] {
  const payload = record(data);
  if (!payload) return [];
  const windows: ClaudeUsageWindow[] = [];

  for (const named of NAMED_WINDOWS) {
    const value = record(payload[named.key]);
    const usedPercent = finiteNumber(value?.utilization);
    if (!value || usedPercent === undefined) continue;
    windows.push(
      window({
        id: named.id,
        scope: named.scope,
        usedPercent,
        resetsAt: value.resets_at,
        windowDurationMins: named.windowDurationMins,
      }),
    );
  }

  const scopes = new Set(windows.flatMap((entry) => (entry.scope ? [entry.scope] : [])));
  // Several entries can name one model; the active one is current.
  const scopedLimits = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(payload.limits) ? payload.limits : []) {
    const limit = record(raw);
    if (!limit || nonEmptyString(limit.kind)?.toLowerCase() !== "weekly_scoped") continue;
    const scope = nonEmptyString(record(record(limit.scope)?.model)?.display_name);
    if (scope === undefined || finiteNumber(limit.percent) === undefined) continue;
    const current = scopedLimits.get(scope);
    if (current === undefined || (current.is_active !== true && limit.is_active === true)) {
      scopedLimits.set(scope, limit);
    }
  }
  for (const [scope, limit] of scopedLimits) {
    if (scopes.has(scope)) continue;
    scopes.add(scope);
    windows.push(
      window({
        id: `seven_day_${scopeId(scope)}`,
        scope,
        usedPercent: limit.percent as number,
        resetsAt: limit.resets_at,
        windowDurationMins: WEEK_MINS,
      }),
    );
  }

  // Undocumented key: a dollar-denominated cloud session credit pool, or the Fable weekly
  // window on accounts whose `limits[]` does not list Fable yet.
  const extra = record(payload.iguana_necktie);
  const extraUsed = finiteNumber(extra?.utilization);
  if (extra && extraUsed !== undefined) {
    if (isDollarDenominated(extra)) {
      windows.push(
        window({
          id: "cloud_session_credits",
          scope: "Cloud session credits",
          usedPercent: extraUsed,
          resetsAt: extra.resets_at,
          windowDurationMins: undefined,
        }),
      );
    } else if (![...scopes].some((scope) => scope.toLowerCase().startsWith("fable"))) {
      windows.push(
        window({
          id: "seven_day_fable",
          scope: "Fable",
          usedPercent: extraUsed,
          resetsAt: extra.resets_at,
          windowDurationMins: WEEK_MINS,
        }),
      );
    }
  }

  return windows;
}

/** Plan from `GET /api/oauth/profile`: `team`, `max`, `pro`, `free`, or undefined. */
export function parseClaudeProfilePlan(data: unknown): string | undefined {
  const profile = record(data);
  if (!profile) return undefined;
  const organization = record(profile.organization);
  if (
    nonEmptyString(organization?.organization_type)?.toLowerCase() === "claude_team" &&
    nonEmptyString(organization?.subscription_status)?.toLowerCase() === "active"
  ) {
    return "team";
  }
  const account = record(profile.account);
  if (account?.has_claude_max === true) return "max";
  if (account?.has_claude_pro === true) return "pro";
  if (account?.has_claude_max === false && account?.has_claude_pro === false) return "free";
  return undefined;
}
