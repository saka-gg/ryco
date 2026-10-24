import { PROVIDER_DISPLAY_NAMES } from "@ryco/contracts";

import { canonicalizeModel } from "./modelPricing";

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact count, e.g. 12_400 → "12.4K", 3_200_000 → "3.2M". */
export function formatCompact(value: number): string {
  return compactNumber.format(value);
}

/** Token counts use the same compact formatting. */
export const formatTokens = formatCompact;

export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** US dollars, e.g. "$12.40". */
export function formatUsd(value: number): string {
  return usd.format(value);
}

/** An estimated cost, or "Unavailable" when nothing had a price. */
export function formatCost(value: number | null): string {
  return value === null ? "Unavailable" : usd.format(value);
}

/** Human duration from milliseconds: "30s", "45m", "2h 15m". */
export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "0m";
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "YYYY-MM-DD" → "Jun 27" (timezone-stable, no Date parsing). */
export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day || month < 1 || month > 12) {
    return date;
  }
  return `${MONTHS[month - 1]} ${day}`;
}

export function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Pretty provider name from a driver kind, e.g. "claudeAgent" → "Claude". */
export function formatProviderLabel(provider: string | undefined): string {
  if (!provider) {
    return "Unknown";
  }
  const known = (PROVIDER_DISPLAY_NAMES as Record<string, string>)[provider];
  if (known) {
    return known;
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Pretty model name from a slug, e.g. "claude-opus-4-8" → "Claude Opus 4.8". */
export function formatModelLabel(model: string): string {
  const canonical = canonicalizeModel(model);
  const base = canonical.includes("/") ? (canonical.split("/").pop() ?? canonical) : canonical;
  const segments = base.split("-").reduce<Array<string>>((acc, segment) => {
    const previous = acc[acc.length - 1];
    if (/^\d+$/.test(segment) && previous !== undefined && /\d$/.test(previous)) {
      acc[acc.length - 1] = `${previous}.${segment}`;
    } else {
      acc.push(segment);
    }
    return acc;
  }, []);
  return segments
    .map((segment) => {
      const lower = segment.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "mini") return "Mini";
      if (lower === "spark") return "Spark";
      if (/^\d/.test(segment)) return segment;
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join(" ");
}
