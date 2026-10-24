/**
 * Reads the event-loop stall log back for Diagnostics: lenient line parsing and the history the
 * Diagnostics snapshot shows (newest records, last-24 h counts).
 *
 * Only the Diagnostics snapshot needs it, so Diagnostics loads this module with its first
 * snapshot instead of at boot. The writer side (path, line shape, normalization) is
 * `EventLoopStallLog.ts`, which the lifetime monitor uses from boot. Import only that module here,
 * not the monitor: a lazy chunk that reaches the monitor's own imports makes the bundler split them
 * into extra boot chunks.
 *
 * @module EventLoopStallHistory
 */
import { lstat } from "node:fs/promises";

import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import type {
  DiagnosticsEventLoopHistory,
  DiagnosticsEventLoopStall,
  DiagnosticsWarning,
} from "@ryco/contracts";

import {
  EVENT_LOOP_STALL_THRESHOLD_MS,
  EVENT_LOOP_WINDOW_MS,
  eventLoopStallLogPath,
  eventLoopStallLogPaths,
  isThreadpoolStallKind,
  normalizeStallLine,
  type EventLoopStallLine,
} from "./EventLoopStallLog.ts";

const EVENT_LOOP_HISTORY_SOURCE = "event-loop-stalls";
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Parses one line leniently: requires an ISO `time`, a non-empty `kind` and a finite,
 * non-negative `durationMs`; drops unknown fields; clamps the rest. Null for anything else.
 */
export const parseStallLine = (text: string): EventLoopStallLine | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return normalizeStallLine(parsed as Record<string, unknown>);
};

export interface ParsedStallLog {
  readonly records: ReadonlyArray<EventLoopStallLine>;
  readonly malformedLineCount: number;
}

/**
 * Parses the text of a stall log (or a tail of it). A last line without a newline may be a write
 * still in progress: it is skipped without counting as malformed when it does not parse.
 */
export const parseStallLog = (text: string): ParsedStallLog => {
  const lines = text.split("\n");
  const unterminated = lines.pop() ?? "";
  const records: Array<EventLoopStallLine> = [];
  let malformedLineCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const record = parseStallLine(trimmed);
    if (record === null) malformedLineCount += 1;
    else records.push(record);
  }
  const partial = unterminated.trim();
  if (partial.length > 0) {
    const record = parseStallLine(partial);
    if (record !== null) records.push(record);
  }
  return { records, malformedLineCount };
};

/** Phase names can carry ids or arguments; they get the same redaction as other text. */
function redactStallPhases(record: EventLoopStallLine): DiagnosticsEventLoopStall {
  if (record.phases === undefined) return record;
  return { ...record, phases: record.phases.map((phase) => redactDiagnosticText(phase)) };
}

interface ParsedStallFile {
  readonly key: string;
  readonly records: ReadonlyArray<DiagnosticsEventLoopStall>;
  readonly malformedLineCount: number;
}

export interface EventLoopHistoryReaderOptions {
  readonly serverTracePath: string;
  /** Reads the bounded tail of a regular file (Diagnostics' file-tail reader). */
  readonly readTail: (filePath: string) => Promise<string>;
  /** Records kept in `recent`, newest first. */
  readonly recentLimit: number;
}

export interface EventLoopHistoryReader {
  /** Never rejects: an unreadable file becomes a warning in `warnings`. */
  readonly read: (
    nowMs: number,
    warnings: DiagnosticsWarning[],
  ) => Promise<DiagnosticsEventLoopHistory>;
  /** The last successful read, for the partial snapshot after a failure. */
  readonly last: () => DiagnosticsEventLoopHistory | undefined;
}

/**
 * Reads the event-loop stall log and its backup. Each file is re-parsed only when its size, mtime
 * or inode changes, so a stall written seconds ago shows on the next snapshot without re-reading
 * the files on every refresh. A missing file is a fresh install, not a warning.
 */
export function makeEventLoopHistoryReader(
  options: EventLoopHistoryReaderOptions,
): EventLoopHistoryReader {
  const logPath = eventLoopStallLogPath(options.serverTracePath);
  const filePaths = eventLoopStallLogPaths(logPath);
  const cache = new Map<string, ParsedStallFile>();
  let last: DiagnosticsEventLoopHistory | undefined;

  const readFile = async (
    filePath: string,
    warnings: DiagnosticsWarning[],
  ): Promise<ParsedStallFile | null> => {
    try {
      const stat = await lstat(filePath);
      const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const cached = cache.get(filePath);
      if (cached?.key === key) return cached;
      const parsed = parseStallLog(await options.readTail(filePath));
      const entry = {
        key,
        records: parsed.records.map(redactStallPhases),
        malformedLineCount: parsed.malformedLineCount,
      };
      cache.set(filePath, entry);
      return entry;
    } catch (error) {
      cache.delete(filePath);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      warnings.push({
        code: "diagnostics.event-loop-history-unavailable",
        source: EVENT_LOOP_HISTORY_SOURCE,
        message:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Unable to read the event-loop stall history.",
      });
      return null;
    }
  };

  return {
    async read(nowMs, warnings) {
      const files = await Promise.all(filePaths.map((filePath) => readFile(filePath, warnings)));
      const records: Array<DiagnosticsEventLoopStall> = [];
      let malformedLineCount = 0;
      for (const file of files) {
        if (file === null) continue;
        records.push(...file.records);
        malformedLineCount += file.malformedLineCount;
      }
      if (malformedLineCount > 0) {
        warnings.push({
          code: "diagnostics.event-loop-history-malformed-lines",
          source: EVENT_LOOP_HISTORY_SOURCE,
          message: "Some event-loop stall records could not be parsed.",
          count: malformedLineCount,
        });
      }
      const newestFirst = records.toSorted((left, right) => right.time.localeCompare(left.time));
      const sinceMs = nowMs - DAY_MS;
      let last24hRecords = 0;
      let last24hStalls = 0;
      let last24hLongestMs = 0;
      let last24hThreadpoolStalls = 0;
      for (const record of newestFirst) {
        if (Date.parse(record.time) < sinceMs) break;
        last24hRecords += 1;
        if (isThreadpoolStallKind(record.kind)) last24hThreadpoolStalls += record.count;
        if (record.kind !== "event-loop") continue;
        last24hStalls += record.count;
        last24hLongestMs = Math.max(last24hLongestMs, record.durationMs);
      }
      last = {
        thresholdMs: EVENT_LOOP_STALL_THRESHOLD_MS,
        windowMs: EVENT_LOOP_WINDOW_MS,
        historyFilePaths: [logPath, `${logPath}.1`],
        recent: newestFirst.slice(0, options.recentLimit),
        last24h: {
          records: last24hRecords,
          stalls: last24hStalls,
          longestMs: last24hLongestMs,
          threadpoolStalls: last24hThreadpoolStalls,
        },
      };
      return last;
    },
    last: () => last,
  };
}
