import type { DiagnosticsEventLoopHistory, DiagnosticsEventLoopStall } from "@ryco/contracts";

import { formatBytes, formatDuration, relativeTimeLabel } from "./DiagnosticsSettings.logic";

/** Records written while the server was this young are labelled "during startup". */
export const STARTUP_STALL_UPTIME_MS = 60_000;
export const EVENT_LOOP_STALL_ROW_LIMIT = 20;
const MEMORY_PRESSURE_MAJOR_FAULTS = 1_000;

export type EventLoopHistoryState = "unsupported" | "empty" | "stalls";

export interface EventLoopHistorySummary {
  readonly state: EventLoopHistoryState;
  readonly headline: string;
  readonly detail: string;
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const isThreadpoolKind = (kind: string) => kind.startsWith("threadpool");

const formatThreshold = (ms: number) =>
  ms > 0 && ms % 1_000 === 0 ? `${ms / 1_000} s` : formatDuration(ms);

export function summarizeEventLoopHistory(
  history: DiagnosticsEventLoopHistory | undefined,
  nowMs: number,
): EventLoopHistorySummary {
  if (history === undefined) {
    return {
      state: "unsupported",
      headline: "This node's server does not record stalls. Update it to see them here.",
      detail: "",
    };
  }
  const threshold = formatThreshold(history.thresholdMs);
  if (history.recent.length === 0) {
    return {
      state: "empty",
      headline: `No stalls of ${threshold} or more recorded`,
      detail: "The server checks its event loop every second for as long as it runs.",
    };
  }
  // Counted by the server over the whole history, summary records' counts included.
  const threadpoolLast24h = history.last24h.threadpoolStalls;
  const threadpoolDetail =
    threadpoolLast24h > 0
      ? `The libuv threadpool was slow ${plural(threadpoolLast24h, "time")} in the last 24 h.`
      : "";
  if (history.last24h.stalls > 0) {
    return {
      state: "stalls",
      headline: `${plural(history.last24h.stalls, "stall")} in the last 24 h, longest ${formatDuration(history.last24h.longestMs)}`,
      detail: threadpoolDetail,
    };
  }
  const latest = history.recent[0];
  return {
    state: "stalls",
    headline: `No event-loop stalls of ${threshold} or more in the last 24 h`,
    detail:
      threadpoolDetail ||
      (latest ? `The last one was recorded ${relativeTimeLabel(latest.time, nowMs)}.` : ""),
  };
}

const cpuMs = (record: DiagnosticsEventLoopStall) =>
  record.cpuUserMs === undefined && record.cpuSystemMs === undefined
    ? undefined
    : (record.cpuUserMs ?? 0) + (record.cpuSystemMs ?? 0);

/** A short reading of the evidence, or undefined when it does not point anywhere. */
export function stallHint(record: DiagnosticsEventLoopStall): string | undefined {
  if (isThreadpoolKind(record.kind)) {
    return "The libuv threadpool was saturated (file system, DNS or compression work queued)";
  }
  if (record.kind !== "event-loop" || record.durationMs <= 0) return undefined;
  const cpu = cpuMs(record);
  if (cpu === undefined) return undefined;
  if ((record.majorPageFaults ?? 0) >= MEMORY_PRESSURE_MAJOR_FAULTS) {
    return "Memory pressure (page faults)";
  }
  // Kernel time without many major faults: large synchronous reads or writes, many small
  // synchronous file-system calls, or minor faults from touching fresh memory.
  if ((record.cpuSystemMs ?? 0) >= 0.5 * record.durationMs) {
    return "Kernel time (synchronous system calls or page faults)";
  }
  if (cpu >= 0.7 * record.durationMs) return "CPU-bound (JavaScript or garbage collection)";
  if (cpu < 0.3 * record.durationMs) return "Waiting (synchronous disk I/O or a lock)";
  return undefined;
}

export function stallKindLabel(kind: string): string {
  switch (kind) {
    case "event-loop":
      return "Event loop";
    case "threadpool":
      return "libuv threadpool";
    case "threadpool-pending":
      return "libuv threadpool, request pending";
    default:
      return kind;
  }
}

export interface EventLoopStallRow {
  readonly key: string;
  readonly label: string;
  readonly relativeTime: string;
  readonly duration: string;
  /** Set when the record covers more than one stall. */
  readonly countLabel: string | undefined;
  readonly duringStartup: boolean;
  readonly evidence: string;
  readonly hint: string | undefined;
  readonly phases: ReadonlyArray<string>;
}

function stallEvidence(record: DiagnosticsEventLoopStall): string {
  const parts: Array<string> = [];
  const cpu = cpuMs(record);
  if (cpu !== undefined) parts.push(`CPU ${formatDuration(cpu)}`);
  if ((record.majorPageFaults ?? 0) > 0) {
    parts.push(plural(record.majorPageFaults ?? 0, "major page fault"));
  }
  if ((record.involuntaryContextSwitches ?? 0) > 0) {
    parts.push(plural(record.involuntaryContextSwitches ?? 0, "preemption"));
  }
  if (record.rssBytes !== undefined) parts.push(`RSS ${formatBytes(record.rssBytes)}`);
  if (record.loadAverage1m !== undefined) {
    parts.push(
      `load ${record.loadAverage1m.toFixed(2)}${record.cpuCount !== undefined ? ` on ${plural(record.cpuCount, "core")}` : ""}`,
    );
  }
  if ((record.suspendedMs ?? 0) > 0)
    parts.push(`${formatDuration(record.suspendedMs ?? 0)} asleep`);
  if (record.busySource === "cpu") parts.push("measured by CPU time");
  return parts.join(" · ");
}

export function stallRows(
  history: DiagnosticsEventLoopHistory | undefined,
  nowMs: number,
  limit = EVENT_LOOP_STALL_ROW_LIMIT,
): ReadonlyArray<EventLoopStallRow> {
  if (history === undefined) return [];
  return history.recent.slice(0, limit).map((record, index) => ({
    key: `${record.time}:${record.kind}:${record.pid ?? ""}:${index}`,
    label: stallKindLabel(record.kind),
    relativeTime: relativeTimeLabel(record.time, nowMs),
    duration: formatDuration(record.durationMs),
    countLabel:
      record.count > 1
        ? `${record.count} stalls, ${formatDuration(record.totalMs)} in total`
        : undefined,
    duringStartup: record.uptimeMs !== undefined && record.uptimeMs < STARTUP_STALL_UPTIME_MS,
    evidence: stallEvidence(record),
    hint: stallHint(record),
    phases: [...new Set(record.phases ?? [])],
  }));
}
