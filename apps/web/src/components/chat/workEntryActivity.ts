// FILE: workEntryActivity.ts
// Purpose: Derives the status + timing a tool-call row reports inline and in its
//          expanded Activity card, from the fields the work log already carries.
// Layer: Web chat presentation helpers
// Exports: formatWorkEntryStatusLabel, formatWorkEntryElapsed, workEntryActivityMeta
//          (the status rule itself, resolveWorkEntryStatus, is shared from client-runtime)

import {
  formatDuration,
  resolveWorkEntryStatus,
  type WorkEntryStatus,
  type WorkLogEntry,
} from "../../session-logic";

type WorkEntryStatusInput = Pick<WorkLogEntry, "completed" | "exitCode" | "tone">;

export function formatWorkEntryStatusLabel(status: WorkEntryStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

type WorkEntryTimingInput = Pick<WorkLogEntry, "startedAt" | "lastActivityAt" | "createdAt">;

/**
 * How long the call took. Needs a start time, which only exists once a
 * `tool.started` activity was correlated or more than one lifecycle event
 * folded into the entry — so a lone completion reports no elapsed rather than a
 * misleading zero.
 */
export function formatWorkEntryElapsed(entry: WorkEntryTimingInput, nowMs?: number): string | null {
  if (!entry.startedAt) {
    return null;
  }
  const startedAt = Date.parse(entry.startedAt);
  if (Number.isNaN(startedAt)) {
    return null;
  }
  const endedAtIso = entry.lastActivityAt ?? entry.createdAt;
  const endedAt = nowMs ?? Date.parse(endedAtIso);
  if (Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

/**
 * The trailing " · Completed · 1s elapsed" clause on a settled tool-call row.
 * Returns null when there is nothing worth appending.
 */
export function workEntryActivityMeta(
  entry: WorkEntryStatusInput & WorkEntryTimingInput,
): string | null {
  const parts = [formatWorkEntryStatusLabel(resolveWorkEntryStatus(entry))];
  const elapsed = formatWorkEntryElapsed(entry);
  if (elapsed) {
    parts.push(`${elapsed} elapsed`);
  }
  return parts.join(" · ");
}
