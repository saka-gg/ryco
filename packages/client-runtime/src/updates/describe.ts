import type { UpdateEverythingResult } from "./run.ts";

export interface UpdateEverythingResultDescription {
  readonly type: "success" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
}

const LISTED_ITEMS = 2;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The first few items, then how many more, as one sentence. */
function summarize(items: ReadonlyArray<string>): string {
  const listed = items
    .slice(0, LISTED_ITEMS)
    .map((item) => item.replace(/[.!?]+$/u, ""))
    .join("; ");
  const more = items.length - LISTED_ITEMS;
  return more > 0 ? `${listed}; and ${more} more.` : `${listed}.`;
}

function joinLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length <= 3) return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

type Problem = "failures" | "unknown" | "postponed" | "skipped";

/**
 * A toast for a finished "Update everything" run; null when it did nothing at
 * all. The worst problem names the toast and the rest follow in its
 * description. A postponed restart is not a failure, but it is not done either.
 */
export function describeUpdateEverythingResult(
  result: UpdateEverythingResult,
): UpdateEverythingResultDescription | null {
  const updatedParts = [
    ...(result.updatedNodes > 0 ? [plural(result.updatedNodes, "node")] : []),
    ...(result.updatedProviders > 0 ? [plural(result.updatedProviders, "provider")] : []),
  ];
  const updated = updatedParts.length > 0 ? `Updated ${updatedParts.join(" and ")}` : null;
  const items: Record<Problem, ReadonlyArray<string>> = {
    failures: result.failures,
    unknown: result.unknown,
    postponed: result.postponed,
    skipped: result.skipped ?? [],
  };
  const problems = (["failures", "unknown", "postponed", "skipped"] as const).filter(
    (problem) => items[problem].length > 0,
  );
  const worst = problems[0];
  if (worst === undefined) return updated === null ? null : { type: "success", title: updated };

  const detail: Record<Problem, string> = {
    failures: summarize(items.failures),
    unknown: `Check ${summarize(items.unknown)}`,
    postponed: "Someone there postponed the restart. The download is kept for later.",
    skipped: summarize(items.skipped),
  };
  const aside: Record<Problem, string> = {
    failures: `Failed: ${summarize(items.failures)}`,
    unknown: `No result from: ${summarize(items.unknown)}`,
    postponed: `Postponed on ${joinLabels(items.postponed)}.`,
    skipped: `Didn't start: ${summarize(items.skipped)}`,
  };
  const titles: Record<Problem, string> = {
    failures:
      items.failures.length === 1 ? "An update failed" : `${items.failures.length} updates failed`,
    unknown: "Some updates didn't report back",
    postponed: `Update postponed on ${joinLabels(items.postponed)}`,
    skipped: "Some updates didn't start",
  };
  const description = [
    ...(updated === null ? [] : [`${updated}.`]),
    detail[worst],
    ...problems.slice(1).map((problem) => aside[problem]),
  ].join(" ");
  const type =
    updated === null && (worst === "failures" || worst === "skipped") ? "error" : "warning";
  return { type, title: titles[worst], description };
}
