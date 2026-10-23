/**
 * The event-loop stall history: `event-loop-stalls.ndjson` next to the server trace file, one JSON
 * record per line plus one rotated backup.
 *
 * Written by the lifetime monitor (`EventLoopMonitor.ts`) and read back by Diagnostics. The reader
 * is lenient on purpose: a hand-edited line, a line from a newer server or a line cut short by a
 * concurrent append must never break the Diagnostics snapshot, so every field is checked, rounded
 * and bounded here before it reaches the contract schema.
 *
 * @module EventLoopStallLog
 */
import path from "node:path";

export const EVENT_LOOP_STALL_LOG_FILE_NAME = "event-loop-stalls.ndjson";
/** Two files of 512 KiB keep well over a thousand records. */
export const EVENT_LOOP_STALL_LOG_MAX_BYTES = 512 * 1024;
export const EVENT_LOOP_STALL_LOG_MAX_FILES = 1;
/** Phases kept per record, and the length each one is cut to. */
export const EVENT_LOOP_STALL_PHASE_LIMIT = 8;
export const EVENT_LOOP_STALL_PHASE_MAX_CHARS = 160;
const KIND_MAX_CHARS = 64;
const BUSY_SOURCE_MAX_CHARS = 16;

/** The stall log lives next to the trace file, so `RYCO_TRACE_FILE` moves both. */
export const eventLoopStallLogPath = (serverTracePath: string): string =>
  path.join(path.dirname(serverTracePath), EVENT_LOOP_STALL_LOG_FILE_NAME);

/** The rotated backup first, then the current file: oldest records first. */
export const eventLoopStallLogPaths = (logPath: string): ReadonlyArray<string> => [
  `${logPath}.1`,
  logPath,
];

export interface EventLoopStallLine {
  /** ISO time the record was written. */
  readonly time: string;
  /** `event-loop`, `threadpool` or `threadpool-pending`; an open set for newer writers. */
  readonly kind: string;
  /** The longest stall the record covers. */
  readonly durationMs: number;
  /** ISO start of that longest stall. */
  readonly startedAt?: string | undefined;
  /** Stalls the record covers. */
  readonly count: number;
  /** Their summed duration. */
  readonly totalMs: number;
  /** Idle (asleep or stopped) time inside the longest stall's gap. */
  readonly suspendedMs?: number | undefined;
  /** How busy time was measured: `elu` (event-loop utilization) or `cpu` (Bun, no ELU). */
  readonly busySource?: string | undefined;
  readonly cpuUserMs?: number | undefined;
  readonly cpuSystemMs?: number | undefined;
  readonly majorPageFaults?: number | undefined;
  readonly minorPageFaults?: number | undefined;
  readonly involuntaryContextSwitches?: number | undefined;
  readonly rssBytes?: number | undefined;
  readonly heapUsedBytes?: number | undefined;
  /** Absent on Windows, where the load average is always 0. */
  readonly loadAverage1m?: number | undefined;
  readonly cpuCount?: number | undefined;
  /** Tracked phases that overlapped the stall. */
  readonly phases?: ReadonlyArray<string> | undefined;
  readonly pid?: number | undefined;
  /** Process uptime when the stall was detected. */
  readonly uptimeMs?: number | undefined;
}

const toNonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
};

const toIsoTime = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

/** Trimmed again after the cut: the contract's trimmed strings reject trailing whitespace. */
const toBoundedString = (value: unknown, maxChars: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const bounded = value.trim().slice(0, maxChars).trimEnd();
  return bounded.length === 0 ? undefined : bounded;
};

/** Cuts a phase description to {@link EVENT_LOOP_STALL_PHASE_MAX_CHARS}, marking the cut. */
export const truncateStallPhase = (phase: string): string =>
  phase.length > EVENT_LOOP_STALL_PHASE_MAX_CHARS
    ? `${phase.slice(0, EVENT_LOOP_STALL_PHASE_MAX_CHARS - 1)}…`
    : phase;

const toPhases = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const phases = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, EVENT_LOOP_STALL_PHASE_LIMIT)
    .map(truncateStallPhase);
  return phases.length > 0 ? phases : undefined;
};

/** `threadpool` and `threadpool-pending` today; prefix-matched so newer threadpool kinds count. */
export const isThreadpoolStallKind = (kind: string): boolean => kind.startsWith("threadpool");

const OPTIONAL_INT_FIELDS = [
  "suspendedMs",
  "cpuUserMs",
  "cpuSystemMs",
  "majorPageFaults",
  "minorPageFaults",
  "involuntaryContextSwitches",
  "rssBytes",
  "heapUsedBytes",
  "cpuCount",
  "pid",
  "uptimeMs",
] as const satisfies ReadonlyArray<keyof EventLoopStallLine>;

/**
 * Brings a record into the shape the contract accepts: integers rounded and clamped, non-finite
 * or empty optionals dropped, phases bounded. Returns null when a required field is unusable.
 */
const normalizeStallLine = (raw: Record<string, unknown>): EventLoopStallLine | null => {
  const time = toIsoTime(raw.time);
  const kind = toBoundedString(raw.kind, KIND_MAX_CHARS);
  if (time === undefined || kind === undefined) return null;
  if (typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs)) return null;
  if (raw.durationMs < 0) return null;
  const durationMs = toNonNegativeInt(raw.durationMs) ?? 0;
  const count = Math.max(1, toNonNegativeInt(raw.count) ?? 1);
  const totalMs = Math.max(durationMs, toNonNegativeInt(raw.totalMs) ?? durationMs);

  const line: Record<string, unknown> = { time, kind, durationMs };
  const startedAt = toIsoTime(raw.startedAt);
  if (startedAt !== undefined) line.startedAt = startedAt;
  line.count = count;
  line.totalMs = totalMs;
  const busySource = toBoundedString(raw.busySource, BUSY_SOURCE_MAX_CHARS);
  if (busySource !== undefined) line.busySource = busySource;
  for (const field of OPTIONAL_INT_FIELDS) {
    const value = toNonNegativeInt(raw[field]);
    if (value !== undefined) line[field] = value;
  }
  if (typeof raw.loadAverage1m === "number" && Number.isFinite(raw.loadAverage1m)) {
    line.loadAverage1m = Math.max(0, Math.round(raw.loadAverage1m * 100) / 100);
  }
  const phases = toPhases(raw.phases);
  if (phases !== undefined) line.phases = phases;
  return line as unknown as EventLoopStallLine;
};

/** One line, without the trailing newline. Integers are rounded; absent fields are left out. */
export const encodeStallLine = (line: EventLoopStallLine): string =>
  JSON.stringify(normalizeStallLine(line as unknown as Record<string, unknown>) ?? line);

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
