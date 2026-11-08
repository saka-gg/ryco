import type { ChangeRequestChecksOverall } from "@ryco/client-runtime/state/pull-request-review";

import type { PullRequestCheckCounts } from "./pullRequestListModel";

export type CheckRingSegmentKind = "passed" | "failed" | "running";

export interface CheckRingSegment {
  readonly kind: CheckRingSegmentKind;
  /** Arc length along the circumference. */
  readonly length: number;
  /** Where the arc starts, measured clockwise from the top. */
  readonly offset: number;
}

/** A visible gap between arcs, so two colours never read as one. */
const SEGMENT_GAP = 1.2;

/** The ring's arcs, in order passed → failed → running; empty kinds are left out. */
export function checkRingSegments(
  counts: PullRequestCheckCounts,
  circumference: number,
): ReadonlyArray<CheckRingSegment> {
  if (counts.total <= 0) return [];
  const kinds: ReadonlyArray<readonly [CheckRingSegmentKind, number]> = [
    ["passed", counts.passed],
    ["failed", counts.failed],
    ["running", counts.running],
  ];
  const shown = kinds.filter(([, count]) => count > 0);
  const gap = shown.length > 1 ? SEGMENT_GAP : 0;
  const segments: CheckRingSegment[] = [];
  let offset = 0;
  for (const [kind, count] of shown) {
    const share = (Math.min(count, counts.total) / counts.total) * circumference;
    const length = Math.max(0, share - gap);
    segments.push({ kind, length, offset });
    offset += share;
  }
  return segments;
}

/** "7 of 9 checks passed, 2 running" for VoiceOver and the checks bar. */
export function describeCheckCounts(counts: PullRequestCheckCounts): string {
  if (counts.total === 0) return "No checks";
  if (counts.passed === counts.total) {
    return counts.total === 1 ? "Check passed" : `All ${counts.total} checks passed`;
  }
  const parts = [`${counts.passed} of ${counts.total} checks passed`];
  if (counts.failed > 0) parts.push(`${counts.failed} failing`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  return parts.join(", ");
}

/** The checks bar's short line: "7 of 9 passed · 2 running". */
export function shortCheckCounts(counts: PullRequestCheckCounts): string {
  if (counts.total === 0) return "No checks";
  if (counts.passed === counts.total) return `All ${counts.total} passed`;
  const parts = [`${counts.passed} of ${counts.total} passed`];
  if (counts.failed > 0) parts.push(`${counts.failed} failing`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  return parts.join(" · ");
}

/** How often an open pull request on screen is read again: sooner while checks run. */
export function pullRequestLiveChecksIntervalMs(overall: ChangeRequestChecksOverall): number {
  return overall === "pending" || overall === "none" ? 45_000 : 60_000;
}
