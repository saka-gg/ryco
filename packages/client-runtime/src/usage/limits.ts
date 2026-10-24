import type { ServerProvider, ServerProviderRateLimitWindow } from "@ryco/contracts";
const SHORT_WINDOW_MAX_MINUTES = 360;
const WEEK_MINUTES = 7 * 24 * 60;
const MONTH_MINUTES = 30 * 24 * 60;
// Codex rounds windowDurationMins to whole-minute precision; allow a 6h
// slack so a "weekly" window reported as 6 days 18 hours still matches.
const WEEK_TOLERANCE_MINUTES = 6 * 60;
// Monthly windows (OpenCode Go reports 30 days) sit well past the weekly
// band; accept 28–34 days so calendar-month drift still matches.
const MONTH_TOLERANCE_MINUTES = 2 * 24 * 60;

/**
 * Clamp a 0..100 used-percent value into the visual range. The upstream
 * Codex protocol claims integer 0..100 but consumers shouldn't trust the
 * wire — a future protocol revision could legitimately overshoot 100 and
 * the bar would render past its track without this guard.
 */
export function clampUsedPercent(usedPercent: number): number | null {
  if (!Number.isFinite(usedPercent)) return null;
  if (usedPercent < 0) return 0;
  if (usedPercent > 100) return 100;
  return usedPercent;
}

export function availablePercent(usedPercent: number): number | null {
  const used = clampUsedPercent(usedPercent);
  return used === null ? null : 100 - used;
}

/**
 * Human-readable label for the cadence of a rate-limit window. Aligns
 * with the official Codex client which buckets windows as "5h" (the
 * short, several-hour cap) and "Weekly" (the 7-day cap); providers with
 * a third monthly cap (OpenCode Go) fall in a "Monthly" bucket, and
 * anything else falls back to a generic hour/day count.
 */
export function describeRateLimitWindow(window: ServerProviderRateLimitWindow): {
  readonly label: string;
  readonly bucket: "short" | "week" | "month" | "other";
} {
  const minutes = window.windowDurationMins;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return { label: "Window", bucket: "other" };
  }
  if (minutes <= SHORT_WINDOW_MAX_MINUTES) {
    const hours = Math.max(1, Math.round(minutes / 60));
    return { label: `${hours}h`, bucket: "short" };
  }
  if (minutes >= MONTH_MINUTES - MONTH_TOLERANCE_MINUTES) {
    return { label: "Monthly", bucket: "month" };
  }
  if (
    minutes >= WEEK_MINUTES - WEEK_TOLERANCE_MINUTES &&
    minutes <= WEEK_MINUTES + WEEK_TOLERANCE_MINUTES
  ) {
    return { label: "Weekly", bucket: "week" };
  }
  const days = Math.round(minutes / (24 * 60));
  if (days >= 1) {
    return { label: `${days}d`, bucket: "other" };
  }
  const hours = Math.max(1, Math.round(minutes / 60));
  return { label: `${hours}h`, bucket: "other" };
}

/** A comparison of one reported allowance at its snapshot time; never a forecast. */
export type RateLimitPace =
  | { readonly status: "unavailable" }
  | { readonly status: "quiet" }
  | {
      readonly status: "reserve" | "deficit";
      readonly points: number;
      readonly expectedUsedPercent: number;
    };

export function rateLimitPace(
  window: ServerProviderRateLimitWindow,
  checkedAt: string | undefined,
  now: number,
  available: boolean,
): RateLimitPace {
  const checked = checkedAt === undefined ? NaN : Date.parse(checkedAt);
  const reset = (window.resetsAt ?? NaN) * 1000;
  const duration = (window.windowDurationMins ?? NaN) * 60_000;
  const used = window.usedPercent;
  if (
    !available ||
    !Number.isFinite(now) ||
    !Number.isFinite(checked) ||
    checked <= 0 ||
    checked > now ||
    !Number.isFinite(reset) ||
    reset <= now ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100
  )
    return { status: "unavailable" };
  const elapsed = (duration - (reset - checked)) / duration;
  if (elapsed < 0 || elapsed >= 1) return { status: "unavailable" };
  const expectedUsedPercent = elapsed * 100;
  const gap = used - expectedUsedPercent;
  if (elapsed < 0.03 || Math.abs(gap) <= 2) return { status: "quiet" };
  return {
    status: gap < 0 ? "reserve" : "deficit",
    points: Math.round(Math.abs(gap)),
    expectedUsedPercent,
  };
}

export function describeRateLimitPace(pace: RateLimitPace): string | null {
  if (pace.status === "unavailable") return "Pace unavailable";
  if (pace.status === "quiet") return null;
  return `${pace.points} percentage points ${pace.status === "reserve" ? "below" : "above"} even pace · at last check`;
}

/** Shared qualification for retained snapshots, independent of transport implementation. */
export function isRateLimitSnapshotAvailable(
  provider: Pick<ServerProvider, "enabled" | "status" | "availability" | "auth"> | null | undefined,
  connected: boolean,
): boolean {
  return (
    connected &&
    provider != null &&
    provider.enabled &&
    provider.status === "ready" &&
    provider.availability !== "unavailable" &&
    provider.auth.status === "authenticated"
  );
}

/** One window of an account, labelled the same way for both sources. */
export interface LabelledLimitWindow {
  readonly label: string;
  readonly window: ServerProviderRateLimitWindow;
}

export interface PooledLimitWindow {
  /** The shared window label (`5h`, `Weekly`, `Weekly · Opus`); stable within a pool list. */
  readonly id: string;
  readonly label: string;
  readonly windowDurationMins: number | undefined;
  /** Mean used percent across accounts reporting this window. */
  readonly usedPercent: number;
  readonly accountCount: number;
  /** The soonest reset among the pooled accounts, epoch seconds. */
  readonly nextResetsAt: number | undefined;
}

/**
 * Averages each window label over the given accounts. Windows pool by label, so every account's
 * 5h window shares one pool; an account counts once per label.
 */
export function poolLimitWindows(
  accounts: ReadonlyArray<ReadonlyArray<LabelledLimitWindow>>,
): PooledLimitWindow[] {
  const pools = new Map<
    string,
    { durationMins: number | undefined; used: number[]; resets: number[] }
  >();
  for (const windows of accounts) {
    const counted = new Set<string>();
    for (const { label, window } of windows) {
      const used = clampUsedPercent(window.usedPercent);
      if (used === null || counted.has(label)) continue;
      counted.add(label);
      const pool = pools.get(label) ?? {
        durationMins: window.windowDurationMins,
        used: [],
        resets: [],
      };
      pool.used.push(used);
      if (window.resetsAt !== undefined) pool.resets.push(window.resetsAt);
      pools.set(label, pool);
    }
  }
  return [...pools.entries()].map(([label, { durationMins, used, resets }]) => ({
    id: label,
    label,
    windowDurationMins: durationMins,
    usedPercent: Math.round((used.reduce((sum, value) => sum + value, 0) / used.length) * 10) / 10,
    accountCount: used.length,
    nextResetsAt: resets.length > 0 ? Math.min(...resets) : undefined,
  }));
}
