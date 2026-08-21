import type { ServerProviderRateLimits, ServerProviderRateLimitWindow } from "@ryco/contracts";

import { formatRelativeTimeUntilLabel } from "../../timestampFormat";

const SHORT_WINDOW_MAX_MINUTES = 360;
const WEEK_MINUTES = 7 * 24 * 60;
// Codex rounds windowDurationMins to whole-minute precision; allow a 6h
// slack so a "weekly" window reported as 6 days 18 hours still matches.
const WEEK_TOLERANCE_MINUTES = 6 * 60;

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
 * short, several-hour cap) and "Weekly" (the 7-day cap); anything
 * in-between falls back to a generic hour/day count.
 */
export function describeRateLimitWindow(window: ServerProviderRateLimitWindow): {
  readonly label: string;
  readonly bucket: "short" | "week" | "other";
} {
  const minutes = window.windowDurationMins;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return { label: "Window", bucket: "other" };
  }
  if (minutes <= SHORT_WINDOW_MAX_MINUTES) {
    const hours = Math.max(1, Math.round(minutes / 60));
    return { label: `${hours}h`, bucket: "short" };
  }
  if (minutes >= WEEK_MINUTES - WEEK_TOLERANCE_MINUTES) {
    return { label: "Weekly", bucket: "week" };
  }
  const days = Math.round(minutes / (24 * 60));
  if (days >= 1) {
    return { label: `${days}d`, bucket: "other" };
  }
  const hours = Math.max(1, Math.round(minutes / 60));
  return { label: `${hours}h`, bucket: "other" };
}

/**
 * Heading for a rate-limit row. A driver-supplied `label` wins — it exists
 * precisely for windows the duration can't tell apart (Claude's
 * account-wide vs Fable-scoped weekly caps). Otherwise fall back to the
 * duration bucket, or the caller's slot label when the duration is absent.
 */
export function resolveRateLimitWindowLabel(
  window: ServerProviderRateLimitWindow,
  fallbackLabel: string,
): string {
  if (window.label !== undefined) return window.label;
  if (window.windowDurationMins === undefined) return fallbackLabel;
  return describeRateLimitWindow(window).label;
}

/**
 * Whether a snapshot has any window worth rendering.
 */
export function hasRateLimitWindows(rateLimits: ServerProviderRateLimits | undefined): boolean {
  if (!rateLimits) return false;
  return Boolean(rateLimits.primary ?? rateLimits.secondary ?? rateLimits.tertiary);
}

/**
 * Convert a Unix epoch second into a "resets in 4h" style label using
 * the existing relative-time formatter. Returns `null` when the
 * timestamp is missing or the upstream protocol returned a clearly
 * invalid value (e.g. zero / negative seconds).
 */
export function formatRateLimitResetLabel(resetsAt: number | undefined): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return null;
  }
  const iso = new Date(resetsAt * 1000).toISOString();
  return formatRelativeTimeUntilLabel(iso);
}

/**
 * Render a reset timestamp as a UI-ready phrase like "resets in 4h" or
 * "expired". The shared `formatRelativeTimeUntilLabel` returns "4h left"
 * / "Expired", which reads awkwardly when surrounded by "Resets … left"
 * or "resets in … Expired". Centralizing the framing keeps the
 * settings card and the chat composer popup phrased consistently.
 */
export function formatRateLimitResetText(resetsAt: number | undefined): string | null {
  const label = formatRateLimitResetLabel(resetsAt);
  if (label === null) return null;
  if (label === "Expired") return "expired";
  return `resets in ${label.replace(/ left$/, "")}`;
}
