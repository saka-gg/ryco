/**
 * `ryco trace summary`: counts, rates and latency per span name, read straight from the local trace
 * file and its rotated backups. Needs no server and no database, so it works while the server is
 * stalled or stopped.
 *
 * The summarizer is pure (one line at a time, one number kept per span); the reader streams each
 * file through a fixed buffer.
 *
 * @module cliTrace/traceSummary
 */
import {
  NotRegularFileError,
  openRegularFile,
  type OpenedRegularFile,
} from "@ryco/shared/regularFile";
import type { BigIntStats } from "node:fs";

import { traceRecordStatus } from "../observability/TraceRecord.ts";

export interface TraceSpanNameSummary {
  readonly name: string;
  readonly count: number;
  /** Spans per minute over the window the summary covers; undefined when it has no length. */
  readonly perMinute: number | undefined;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly interrupted: number;
  readonly failures: number;
}

export interface TraceSpanSummary {
  readonly spanCount: number;
  /** Lines that are not trace records (or end outside the representable date range). */
  readonly skippedLineCount: number;
  /** End time of the first and last counted span, epoch ms; undefined when nothing was counted. */
  readonly firstEndMs: number | undefined;
  readonly lastEndMs: number | undefined;
  readonly minutes: number;
  /** Busiest first, then by name. */
  readonly spans: ReadonlyArray<TraceSpanNameSummary>;
}

interface SpanNameStats {
  readonly durations: Array<number>;
  interrupted: number;
  failures: number;
}

/** The largest epoch ms a `Date` can hold. */
const MAX_DATE_MS = 8.64e15;
const DECIMAL_DIGITS = /^\d+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `endTimeUnixNano` as epoch ms, or undefined when it is not a decimal nanosecond count. */
function endTimeMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !DECIMAL_DIGITS.test(value)) return undefined;
  const ms = Number(value) / 1_000_000;
  return Number.isFinite(ms) && ms <= MAX_DATE_MS ? ms : undefined;
}

/** Nearest-rank percentile of an ascending, non-empty array. */
export function nearestRankPercentile(sorted: ReadonlyArray<number>, percentile: number): number {
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function makeTraceSpanSummary(options: { readonly sinceMs?: number | undefined } = {}) {
  const sinceMs = options.sinceMs ?? Number.NEGATIVE_INFINITY;
  const byName = new Map<string, SpanNameStats>();
  let spanCount = 0;
  let skippedLineCount = 0;
  let firstEndMs = Number.POSITIVE_INFINITY;
  let lastEndMs = Number.NEGATIVE_INFINITY;

  /**
   * `terminated` is false for a last line with no newline: a live server may be appending it, so
   * a line that does not parse there is not counted as skipped.
   */
  const addLine = (line: string, terminated = true): void => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (terminated) skippedLineCount += 1;
      return;
    }
    const endMs = isRecord(parsed) ? endTimeMs(parsed.endTimeUnixNano) : undefined;
    if (
      !isRecord(parsed) ||
      typeof parsed.name !== "string" ||
      typeof parsed.durationMs !== "number" ||
      !Number.isFinite(parsed.durationMs) ||
      endMs === undefined
    ) {
      if (terminated) skippedLineCount += 1;
      return;
    }
    if (endMs < sinceMs) return;

    spanCount += 1;
    if (endMs < firstEndMs) firstEndMs = endMs;
    if (endMs > lastEndMs) lastEndMs = endMs;
    let stats = byName.get(parsed.name);
    if (stats === undefined) {
      stats = { durations: [], interrupted: 0, failures: 0 };
      byName.set(parsed.name, stats);
    }
    stats.durations.push(Math.max(0, parsed.durationMs));
    const status = traceRecordStatus({
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      exit: isRecord(parsed.exit)
        ? { _tag: typeof parsed.exit._tag === "string" ? parsed.exit._tag : undefined }
        : undefined,
      status: isRecord(parsed.status)
        ? { code: typeof parsed.status.code === "string" ? parsed.status.code : undefined }
        : undefined,
    });
    // Effect's OTLP tracer (browser spans) marks an interrupt with an attribute and an unset code.
    const interruptedAttribute =
      isRecord(parsed.attributes) && parsed.attributes["effect.fiber.interrupted"] === true;
    if (status === "interrupted" || interruptedAttribute) stats.interrupted += 1;
    if (status === "failure" || status === "error") stats.failures += 1;
  };

  const finish = (): TraceSpanSummary => {
    const counted = spanCount > 0;
    const minutes = counted ? (lastEndMs - firstEndMs) / 60_000 : 0;
    const spans = [...byName]
      .map(([name, stats]): TraceSpanNameSummary => {
        const sorted = stats.durations.toSorted((left, right) => left - right);
        return {
          name,
          count: sorted.length,
          perMinute: minutes > 0 ? sorted.length / minutes : undefined,
          p50Ms: nearestRankPercentile(sorted, 0.5),
          p90Ms: nearestRankPercentile(sorted, 0.9),
          p99Ms: nearestRankPercentile(sorted, 0.99),
          maxMs: sorted[sorted.length - 1]!,
          interrupted: stats.interrupted,
          failures: stats.failures,
        };
      })
      .toSorted(
        (left, right) =>
          right.count - left.count ||
          (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      );
    return {
      spanCount,
      skippedLineCount,
      firstEndMs: counted ? firstEndMs : undefined,
      lastEndMs: counted ? lastEndMs : undefined,
      minutes,
      spans,
    };
  };

  return { addLine, finish };
}

const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

export interface TraceFileReadResult {
  /** Files whose lines were read, oldest first. */
  readonly filesRead: ReadonlyArray<string>;
  /** Files that exist but could not be opened as a regular file, oldest first. */
  readonly filesUnreadable: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

const unreadableReason = (cause: unknown): string => {
  if (cause instanceof NotRegularFileError) return "not a regular file";
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.message : String(cause);
};

interface OpenedTraceFile {
  readonly path: string;
  readonly file: OpenedRegularFile<BigIntStats>;
}

/**
 * Streams the lines of `paths` (oldest first) into `onLine`. Missing files are skipped, and with
 * `sinceMs` so is a file last written before it (it cannot hold a span that ended later). A file
 * that exists but cannot be opened (a FIFO or link named like a trace file, no permission) is
 * reported in `filesUnreadable` and the rest are still read, the way Diagnostics warns about one.
 *
 * Every file is opened before any is read, so a rotation during the reads cannot move lines
 * between files; each is read up to its size when it was opened. Files are opened newest first,
 * and a file already opened under another name is read once. A rotation between two opens renames
 * every file to the next backup name: in this order the reader then meets a file it already holds
 * (and skips it) instead of missing one it never opened.
 */
export async function readTraceFileLines(options: {
  readonly paths: ReadonlyArray<string>;
  readonly sinceMs?: number | undefined;
  /** Follow a final symbolic link (an explicit `--file`). */
  readonly followSymlinks?: boolean;
  readonly onLine: (line: string, terminated: boolean) => void;
}): Promise<TraceFileReadResult> {
  const opened: Array<OpenedTraceFile> = [];
  const filesUnreadable: Array<{ readonly path: string; readonly reason: string }> = [];
  const seenIdentities = new Set<string>();
  try {
    for (const path of options.paths.toReversed()) {
      let file: OpenedRegularFile<BigIntStats>;
      try {
        file = await openRegularFile(path, {
          followSymlinks: options.followSymlinks === true,
          // Exact inode numbers: on Windows they do not fit a double.
          bigint: true,
        });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          filesUnreadable.push({ path, reason: unreadableReason(cause) });
        }
        continue;
      }
      // Some file systems report no inode (0); such files are never treated as duplicates.
      const identity = file.stat.ino === 0n ? undefined : `${file.stat.dev}:${file.stat.ino}`;
      if (
        (identity !== undefined && seenIdentities.has(identity)) ||
        (options.sinceMs !== undefined && Number(file.stat.mtimeMs) < options.sinceMs)
      ) {
        await file.handle.close();
        continue;
      }
      if (identity !== undefined) seenIdentities.add(identity);
      opened.push({ path, file });
    }
    const oldestFirst = opened.toReversed();
    for (const { file } of oldestFirst) {
      await readLines(file, options.onLine);
    }
    return {
      filesRead: oldestFirst.map(({ path }) => path),
      filesUnreadable: filesUnreadable.toReversed(),
    };
  } finally {
    await Promise.all(opened.map(({ file }) => file.handle.close().catch(() => undefined)));
  }
}

async function readLines(
  file: OpenedRegularFile<BigIntStats>,
  onLine: (line: string, terminated: boolean) => void,
): Promise<void> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let remaining = Number(file.stat.size);
  let position = 0;
  // A line split across reads, as copies (`chunk` is overwritten by the next read). Lines are
  // decoded straight from `chunk` otherwise: copying every chunk to join it with the previous
  // partial line doubled the peak memory of a 100 MB read.
  let carry: Array<Buffer> = [];
  while (remaining > 0) {
    const { bytesRead } = await file.handle.read(
      chunk,
      0,
      Math.min(READ_CHUNK_BYTES, remaining),
      position,
    );
    if (bytesRead === 0) break;
    position += bytesRead;
    remaining -= bytesRead;
    const bytes = chunk.subarray(0, bytesRead);
    let lineStart = 0;
    let newline = bytes.indexOf(NEWLINE);
    if (carry.length > 0) {
      if (newline === -1) {
        carry.push(Buffer.from(bytes));
        continue;
      }
      carry.push(bytes.subarray(0, newline));
      onLine(Buffer.concat(carry).toString("utf8"), true);
      carry = [];
      lineStart = newline + 1;
      newline = bytes.indexOf(NEWLINE, lineStart);
    }
    while (newline !== -1) {
      onLine(bytes.toString("utf8", lineStart, newline), true);
      lineStart = newline + 1;
      newline = bytes.indexOf(NEWLINE, lineStart);
    }
    if (lineStart < bytes.length) carry.push(Buffer.from(bytes.subarray(lineStart)));
  }
  if (carry.length > 0) onLine(Buffer.concat(carry).toString("utf8"), false);
}

const formatMs = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;

const formatPerMinute = (perMinute: number | undefined) =>
  perMinute === undefined ? "-" : perMinute < 0.1 ? "<0.1" : perMinute.toFixed(1);

const isoOrNull = (ms: number | undefined) =>
  ms === undefined ? null : new Date(ms).toISOString();

/** The trace file leaves out fast successful child spans; the footnote says so. */
export const TRACE_SUMMARY_RETENTION_NOTE =
  "Fast successful child spans are not written to the trace file (RYCO_TRACE_SPAN_MIN_DURATION_MS=5, " +
  "RYCO_TRACE_SQL_MIN_DURATION_MS=50 by default), so counts and percentiles cover retained spans.";

export interface TraceSummaryReport extends TraceFileReadResult {
  readonly traceFilePath: string;
  readonly sinceMs: number | undefined;
  readonly limit: number;
  readonly summary: TraceSpanSummary;
}

const unreadableLines = (report: TraceSummaryReport): ReadonlyArray<string> =>
  report.filesUnreadable.map(({ path, reason }) => `Could not read ${path} (${reason}).`);

export function formatTraceSummary(report: TraceSummaryReport): string {
  const { summary, limit } = report;
  if (summary.spanCount === 0) {
    return [
      [
        `No spans found in ${report.traceFilePath} or its rotated files${
          report.sinceMs === undefined ? "" : " in that window"
        }.`,
        ...(summary.skippedLineCount > 0
          ? [`Skipped ${summary.skippedLineCount} lines that are not spans.`]
          : []),
      ].join(" "),
      ...unreadableLines(report),
    ].join("\n");
  }
  const header = ["span", "count", "/min", "p50", "p90", "max", "interrupted", "failed"];
  const rows = summary.spans
    .slice(0, limit)
    .map((span) => [
      span.name,
      String(span.count),
      formatPerMinute(span.perMinute),
      formatMs(span.p50Ms),
      formatMs(span.p90Ms),
      formatMs(span.maxMs),
      String(span.interrupted),
      String(span.failures),
    ]);
  const table = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  const fileCount = report.filesRead.length;
  return [
    `${summary.spanCount} spans ended from ${isoOrNull(summary.firstEndMs)} to ${isoOrNull(
      summary.lastEndMs,
    )} (${summary.minutes.toFixed(1)} min), read from ${fileCount} ${fileCount === 1 ? "file" : "files"}.`,
    ...(summary.skippedLineCount > 0
      ? [`Skipped ${summary.skippedLineCount} lines that are not spans.`]
      : []),
    ...unreadableLines(report),
    "",
    ...table.map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
        )
        .join("  ")
        .trimEnd(),
    ),
    ...(summary.spans.length > limit
      ? ["", `${summary.spans.length - limit} more span names. Use --limit to show more.`]
      : []),
    "",
    TRACE_SUMMARY_RETENTION_NOTE,
  ].join("\n");
}

/** The `--json` document: one object, spans limited like the table. */
export function traceSummaryJson(report: TraceSummaryReport) {
  const { summary } = report;
  return {
    traceFilePath: report.traceFilePath,
    filesRead: report.filesRead,
    filesUnreadable: report.filesUnreadable,
    spanCount: summary.spanCount,
    skippedLineCount: summary.skippedLineCount,
    firstEndAt: isoOrNull(summary.firstEndMs),
    lastEndAt: isoOrNull(summary.lastEndMs),
    minutes: summary.minutes,
    spanNameCount: summary.spans.length,
    spans: summary.spans.slice(0, report.limit).map((span) => ({
      name: span.name,
      count: span.count,
      perMinute: span.perMinute ?? null,
      p50Ms: span.p50Ms,
      p90Ms: span.p90Ms,
      p99Ms: span.p99Ms,
      maxMs: span.maxMs,
      interrupted: span.interrupted,
      failures: span.failures,
    })),
  };
}
