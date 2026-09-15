import { formatRelativeTimeUntilLabel } from "../../timestampFormat";

export {
  clampUsedPercent,
  availablePercent,
  describeRateLimitWindow,
} from "@ryco/client-runtime/usage";

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
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
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
