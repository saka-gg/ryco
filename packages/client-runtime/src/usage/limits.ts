import type { ServerProviderRateLimitWindow } from "@ryco/contracts";
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
export function clampUsedPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  if (usedPercent < 0) return 0;
  if (usedPercent > 100) return 100;
  return usedPercent;
}

export function availablePercent(usedPercent: number): number {
  return 100 - clampUsedPercent(usedPercent);
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
