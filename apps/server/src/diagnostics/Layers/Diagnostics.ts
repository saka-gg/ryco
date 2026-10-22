import {
  DIAGNOSTIC_SECRET_KEY_PATTERN,
  redactDiagnosticText,
} from "@ryco/shared/diagnosticRedaction";
import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type DiagnosticsDurationBucket,
  type DiagnosticsFailure,
  type DiagnosticsFailureSummary,
  type DiagnosticsResourceSample,
  type DiagnosticsSpan,
  type DiagnosticsSpanEvent,
  type DiagnosticsSpanNameSummary,
  type DiagnosticsTraceSinkHealth,
  type DiagnosticsTraceSummary,
  type DiagnosticsWarning,
} from "@ryco/contracts";
import { Effect } from "effect";

import type { ServerConfigShape } from "../../config.ts";
import {
  isCurrentCanonicalProviderEventLog,
  parseProviderEventLogLine,
} from "../../provider/providerEventLogRecords.ts";
import type { TraceSinkHealth } from "../../observability/TraceSink.ts";
import type { TraceRecord } from "../../observability/TraceRecord.ts";
import { readResourceTelemetry, recordResourceAttribution } from "../ResourceTelemetry.ts";
import { readProcessDiagnostics } from "../ProcessDiagnostics.ts";
import { summarizeOperationalMetrics } from "../OperationalMetrics.ts";
import type { DiagnosticsShape, DiagnosticsSnapshotInput } from "../Services/Diagnostics.ts";

const TRACE_RECORD_LIMIT = 2_000;
const RESOURCE_SAMPLE_LIMIT = 240;
const FILE_TAIL_BYTES = 512 * 1024;
/** Provider failures come from the canonical logs of the most recently active threads. */
const PROVIDER_LOG_FILE_LIMIT = 8;
const PROVIDER_LOG_TAIL_BYTES = 128 * 1024;
const PROVIDER_FAILURE_SOURCE = "provider-events";
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
/** Cheap pre-filter so only candidate failure records are JSON-parsed. */
const PROVIDER_FAILURE_TYPE_PATTERN =
  /"type":"(?:runtime\.error|thread\.realtime\.error|turn\.completed|session\.exited)"/u;
const FILE_TAIL_REFRESH_INTERVAL_MS = 30_000;
const LIST_LIMIT = 50;
const EVENT_LIMIT = 80;
const RAW_MESSAGE_LIMIT = 1_200;

const SENSITIVE_KEY_PATTERN = DIAGNOSTIC_SECRET_KEY_PATTERN;

interface RingBuffer<A> {
  readonly push: (value: A) => void;
  readonly values: () => ReadonlyArray<A>;
  readonly size: () => number;
}

function makeRingBuffer<A>(limit: number): RingBuffer<A> {
  const values: A[] = [];
  return {
    push(value) {
      values.push(value);
      if (values.length > limit) {
        values.splice(0, values.length - limit);
      }
    },
    values: () => [...values],
    size: () => values.length,
  };
}

interface ResourceSampler {
  readonly sample: () => Promise<DiagnosticsResourceSample>;
  readonly history: () => ReadonlyArray<DiagnosticsResourceSample>;
}

function makeResourceSampler(): ResourceSampler {
  const samples = makeRingBuffer<DiagnosticsResourceSample>(RESOURCE_SAMPLE_LIMIT);
  const startedAtMs = Date.now();
  const cpuCount = Math.max(1, os.cpus().length);
  let lastCpu = process.cpuUsage();
  let lastSampledAtMs = startedAtMs;
  let inFlightSample: Promise<DiagnosticsResourceSample> | null = null;

  const sampleOnce = async () => {
    const eventLoopStartedAt = performance.now();
    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(resolve, 0);
      timeoutId.unref?.();
    });
    const eventLoopDelayMs = Math.max(0, performance.now() - eventLoopStartedAt);
    const nowMs = Date.now();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const cpuDelta = process.cpuUsage(lastCpu);
    const elapsedMicros = Math.max(1, (nowMs - lastSampledAtMs) * 1_000);
    const busyMicros = cpuDelta.user + cpuDelta.system;
    const utilizationPercent = Math.max(
      0,
      Math.min(100, (busyMicros / (elapsedMicros * cpuCount)) * 100),
    );
    lastCpu = cpu;
    lastSampledAtMs = nowMs;

    const next = {
      sampledAt: new Date(nowMs).toISOString(),
      uptimeMs: Math.max(0, Math.round(process.uptime() * 1_000)),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      cpu: {
        userMicros: cpu.user,
        systemMicros: cpu.system,
        utilizationPercent,
      },
      eventLoopDelayMs,
    } satisfies DiagnosticsResourceSample;
    samples.push(next);
    return next;
  };

  return {
    sample() {
      if (inFlightSample !== null) {
        return inFlightSample;
      }
      const pending = sampleOnce();
      inFlightSample = pending;
      const clearInFlight = () => {
        if (inFlightSample === pending) inFlightSample = null;
      };
      void pending.then(clearInFlight, clearInFlight);
      return pending;
    },
    history: samples.values,
  };
}

export function redactDiagnosticValue(value: unknown, depth = 0, keyHint = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return "[redacted]";
  }
  if (depth >= 8) {
    return "[truncated]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return SENSITIVE_KEY_PATTERN.test(value) ||
      /(?:Bearer\s+\S+|https?:\/\/[^\s/]+@|sk-[A-Za-z0-9_-]{8,}|-----BEGIN .*PRIVATE KEY)/iu.test(
        value,
      )
      ? "[redacted]"
      : redactDiagnosticText(value).slice(0, RAW_MESSAGE_LIMIT);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactDiagnosticValue(item, depth + 1, keyHint));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    redacted[key] = redactDiagnosticValue(child, depth + 1, key);
  }
  return redacted;
}

function diagnosticEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted endpoint]";
  }
}

function toIsoFromUnixNano(value: string): string {
  try {
    const millis = BigInt(value) / 1_000_000n;
    return new Date(Number(millis)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function normalizeOtlpSpanStatus(code: string | undefined): DiagnosticsSpan["status"] {
  if (!code) return "success";
  if (code === "2" || code === "STATUS_CODE_ERROR") return "error";
  if (code === "1" || code === "STATUS_CODE_OK") return "success";
  if (code === "0" || code === "STATUS_CODE_UNSET") return "unset";
  return "success";
}

function normalizeSpanSource(record: TraceRecord): DiagnosticsSpan["source"] {
  if (record.type === "effect-span") {
    return "server";
  }
  const resourceAttributes = record.resourceAttributes ?? {};
  const serviceRuntime = resourceAttributes["service.runtime"];
  const serviceName = resourceAttributes["service.name"];
  if (serviceRuntime === "ryco-web" || serviceName === "ryco-web") {
    return "browser";
  }
  if (serviceRuntime === "ryco-server" || serviceName === "ryco-server") {
    return "server";
  }
  return "unknown";
}

function normalizeSpanStatus(record: TraceRecord): DiagnosticsSpan["status"] {
  if (record.type === "effect-span") {
    const exit = record.exit;
    if (!exit || exit._tag === "Success") return "success";
    if (exit._tag === "Interrupted") return "interrupted";
    return "failure";
  }
  return normalizeOtlpSpanStatus(record.status?.code);
}

function spanFailureMessage(record: TraceRecord): string | undefined {
  if (record.type === "effect-span") {
    const exit = record.exit;
    if (exit?._tag === "Failure") {
      return String(redactDiagnosticValue(exit.cause));
    }
    return undefined;
  }
  if (record.type === "otlp-span" && record.status?.message) {
    return String(redactDiagnosticValue(record.status.message));
  }
  return undefined;
}

function toDiagnosticsSpan(record: TraceRecord): DiagnosticsSpan {
  const failureMessage = spanFailureMessage(record);
  return {
    id: `${record.traceId}:${record.spanId}`,
    source: normalizeSpanSource(record),
    traceId: record.traceId,
    spanId: record.spanId,
    ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
    name: record.name.trim() || "(unnamed span)",
    kind: record.kind?.trim() || "unknown",
    startTime: toIsoFromUnixNano(record.startTimeUnixNano),
    endTime: toIsoFromUnixNano(record.endTimeUnixNano),
    durationMs: Math.max(0, record.durationMs),
    status: normalizeSpanStatus(record),
    ...(failureMessage ? { failureMessage } : {}),
    attributes: redactDiagnosticValue(record.attributes ?? {}) as Record<string, unknown>,
  };
}

function safeToDiagnosticsSpan(record: TraceRecord): DiagnosticsSpan | null {
  try {
    return toDiagnosticsSpan(record);
  } catch {
    return null;
  }
}

function toDiagnosticsSpanEvents(
  records: ReadonlyArray<TraceRecord>,
): ReadonlyArray<DiagnosticsSpanEvent> {
  return records
    .flatMap((record) => {
      const events = Array.isArray(record.events) ? record.events.slice(-EVENT_LIMIT) : [];
      return events
        .filter((event) => event && typeof event.name === "string")
        .map((event) => ({
          traceId: record.traceId,
          spanId: record.spanId,
          spanName: record.name.trim() || "(unnamed span)",
          name: String(redactDiagnosticValue(event.name.trim())) || "(unnamed event)",
          time: toIsoFromUnixNano(event.timeUnixNano),
          attributes: redactDiagnosticValue(event.attributes ?? {}) as Record<string, unknown>,
        }));
    })
    .toSorted((left, right) => right.time.localeCompare(left.time))
    .slice(0, EVENT_LIMIT);
}

function buildTraceSummary(
  spans: ReadonlyArray<DiagnosticsSpan>,
  records: ReadonlyArray<TraceRecord>,
  warnings: ReadonlyArray<DiagnosticsWarning>,
  scannedFilePaths: ReadonlyArray<string>,
): DiagnosticsTraceSummary {
  const logLevelCounts: Record<string, number> = Object.create(null);
  const logs: DiagnosticsTraceSummary["latestWarningAndErrorLogs"][number][] = [];
  for (const record of records) {
    for (const event of Array.isArray(record.events) ? record.events.slice(-EVENT_LIMIT) : []) {
      if (!event || typeof event.name !== "string") continue;
      const rawLevel = event.attributes?.["effect.logLevel"];
      if (typeof rawLevel !== "string" || !rawLevel.trim()) continue;
      const level = rawLevel.toLowerCase().slice(0, 32);
      logLevelCounts[level] = (logLevelCounts[level] ?? 0) + 1;
      if (!["warning", "warn", "error", "fatal"].includes(level)) continue;
      logs.push({
        traceId: record.traceId,
        spanId: record.spanId,
        spanName: record.name?.trim() || "(unnamed span)",
        level,
        message: String(redactDiagnosticValue(event.name)),
        seenAt: toIsoFromUnixNano(event.timeUnixNano),
      });
    }
  }
  return {
    parseErrorCount: warnings
      .filter((warning) => warning.code === "diagnostics.trace-tail-malformed-lines")
      .reduce((sum, warning) => sum + (warning.count ?? 0), 0),
    scannedFilePaths,
    firstSpanAt: spans.length
      ? spans.reduce(
          (earliest, span) => (span.startTime < earliest ? span.startTime : earliest),
          spans[0]!.startTime,
        )
      : null,
    lastSpanAt: spans[0]?.endTime ?? null,
    failureCount: spans.filter((span) => span.status === "failure" || span.status === "error")
      .length,
    interruptionCount: spans.filter((span) => span.status === "interrupted").length,
    slowSpanThresholdMs: 1_000,
    slowSpanCount: spans.filter((span) => span.durationMs >= 1_000).length,
    logLevelCounts,
    latestWarningAndErrorLogs: logs
      .toSorted((a, b) => b.seenAt.localeCompare(a.seenAt))
      .slice(0, LIST_LIMIT),
    partialFailure: warnings.some(
      (warning) =>
        warning.source === "trace-file" || warning.code === "diagnostics.trace-records-skipped",
    ),
  };
}

function buildTopSpanNames(
  spans: ReadonlyArray<DiagnosticsSpan>,
): ReadonlyArray<DiagnosticsSpanNameSummary> {
  const byName = new Map<
    string,
    {
      count: number;
      failureCount: number;
      totalDurationMs: number;
      maxDurationMs: number;
    }
  >();

  for (const span of spans) {
    const current =
      byName.get(span.name) ??
      ({
        count: 0,
        failureCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
      } satisfies {
        count: number;
        failureCount: number;
        totalDurationMs: number;
        maxDurationMs: number;
      });
    current.count += 1;
    current.totalDurationMs += span.durationMs;
    current.maxDurationMs = Math.max(current.maxDurationMs, span.durationMs);
    if (span.status === "failure" || span.status === "error") {
      current.failureCount += 1;
    }
    byName.set(span.name, current);
  }

  return [...byName.entries()]
    .map(([name, value]) => ({
      name,
      count: value.count,
      failureCount: value.failureCount,
      totalDurationMs: value.totalDurationMs,
      averageDurationMs: value.count === 0 ? 0 : value.totalDurationMs / value.count,
      maxDurationMs: value.maxDurationMs,
    }))
    .toSorted((left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs)
    .slice(0, LIST_LIMIT);
}

function buildDurationBuckets(
  spans: ReadonlyArray<DiagnosticsSpan>,
): ReadonlyArray<DiagnosticsDurationBucket> {
  const buckets: Array<{
    label: string;
    minMs: number;
    maxMs?: number;
    count: number;
    maxExclusive?: number;
  }> = [
    { label: "<10ms", minMs: 0, maxMs: 10, count: 0, maxExclusive: 10 },
    { label: "10-100ms", minMs: 10, maxMs: 100, count: 0, maxExclusive: 100 },
    { label: "100ms-1s", minMs: 100, maxMs: 1_000, count: 0, maxExclusive: 1_000 },
    { label: "1s-10s", minMs: 1_000, maxMs: 10_000, count: 0, maxExclusive: 10_000 },
    { label: ">=10s", minMs: 10_000, count: 0 },
  ];

  for (const span of spans) {
    const bucket = buckets.find((candidate) =>
      candidate.maxExclusive === undefined
        ? span.durationMs >= candidate.minMs
        : span.durationMs >= candidate.minMs && span.durationMs < candidate.maxExclusive,
    );
    if (bucket) {
      bucket.count += 1;
    }
  }

  return buckets.map(({ maxExclusive: _maxExclusive, ...bucket }) => bucket);
}

function normalizeSignature(value: string): string {
  const compact = value
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/giu, "<hex>")
    .replace(/\b\d+\b/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim();
  return compact.slice(0, 180) || "unknown failure";
}

function failureFromSpan(span: DiagnosticsSpan): DiagnosticsFailure | null {
  if (span.status !== "failure" && span.status !== "error") {
    return null;
  }
  const message = span.failureMessage ?? `${span.name} failed`;
  return {
    id: `span:${span.id}`,
    occurredAt: span.endTime,
    source: span.source,
    category: "span",
    signature: normalizeSignature(`${span.name}:${message}`),
    message,
    raw: redactDiagnosticValue(span),
  };
}

/** Leading fields of the server's own logfmt log (see serverLogger.ts). */
const LOGFMT_LINE_PREFIX = /^timestamp=\S+ (level=[A-Z]+) fiber=#\d+ /u;

function failureFromLogLine(input: {
  readonly line: string;
  readonly source: string;
  readonly fallbackTime: string;
}): DiagnosticsFailure | null {
  const line = input.line.trim();
  if (!/(?:\berror\b|\bfailed\b|\bfailure\b|\bexception\b)/iu.test(line)) {
    return null;
  }
  const timestamp = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/u)?.[0];
  // The time is `occurredAt` and the fiber id is noise: left in, they would
  // fill the id and signature and make distinct failures look alike.
  const prefix = LOGFMT_LINE_PREFIX.exec(line);
  const text = prefix ? `${prefix[1]} ${line.slice(prefix[0].length)}` : line;
  const message = String(redactDiagnosticValue(text));
  return {
    id: `log:${input.source}:${normalizeSignature(message).slice(0, 80)}`,
    occurredAt: timestamp ?? input.fallbackTime,
    source: input.source,
    category: "log",
    signature: normalizeSignature(message),
    message,
    raw: redactDiagnosticValue({ line, source: input.source }),
  };
}

/** Failure message of a canonical provider runtime event, or `undefined` for anything else. */
function providerEventFailureMessage(record: Record<string, unknown>): string | undefined {
  const payload =
    typeof record.payload === "object" && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : {};
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  switch (record.type) {
    case "runtime.error":
    case "thread.realtime.error":
      return text(payload.message) ?? `${record.type}`;
    case "turn.completed":
      return payload.state === "failed" ? (text(payload.errorMessage) ?? "turn failed") : undefined;
    case "session.exited":
      return payload.exitKind === "error"
        ? (text(payload.reason) ?? "session exited with an error")
        : undefined;
    default:
      return undefined;
  }
}

function failureFromProviderEventLine(input: {
  readonly line: string;
  readonly fallbackTime: string;
}): DiagnosticsFailure | null {
  if (!PROVIDER_FAILURE_TYPE_PATTERN.test(input.line)) return null;
  const parsed = parseProviderEventLogLine(input.line);
  if (parsed === null || parsed.label !== "CANON") return null;
  const record =
    typeof parsed.record === "object" && parsed.record !== null
      ? (parsed.record as Record<string, unknown>)
      : null;
  if (record === null) return null;
  const failureMessage = providerEventFailureMessage(record);
  if (failureMessage === undefined) return null;
  const type = String(record.type);
  const message = String(redactDiagnosticValue(failureMessage));
  const signature = normalizeSignature(`${type}:${message}`);
  return {
    id:
      typeof record.eventId === "string" && record.eventId.length > 0
        ? `provider:${record.eventId}`
        : `provider:${signature.slice(0, 80)}`,
    occurredAt: ISO_TIMESTAMP_PATTERN.test(parsed.observedAt)
      ? parsed.observedAt
      : input.fallbackTime,
    source: PROVIDER_FAILURE_SOURCE,
    category: "provider",
    signature,
    message,
    raw: redactDiagnosticValue({
      type,
      provider: record.provider,
      threadId: record.threadId,
      turnId: record.turnId,
      message: failureMessage,
    }),
  };
}

function buildFailureSummary(
  failures: ReadonlyArray<DiagnosticsFailure>,
): ReadonlyArray<DiagnosticsFailureSummary> {
  const bySignature = new Map<
    string,
    {
      source: string;
      category: string;
      count: number;
      latestAt: string;
      sampleMessage: string;
    }
  >();

  for (const failure of failures) {
    const current =
      bySignature.get(failure.signature) ??
      ({
        source: failure.source,
        category: failure.category,
        count: 0,
        latestAt: failure.occurredAt,
        sampleMessage: failure.message,
      } satisfies {
        source: string;
        category: string;
        count: number;
        latestAt: string;
        sampleMessage: string;
      });
    current.count += 1;
    if (failure.occurredAt.localeCompare(current.latestAt) > 0) {
      current.latestAt = failure.occurredAt;
      current.sampleMessage = failure.message;
      current.source = failure.source;
      current.category = failure.category;
    }
    bySignature.set(failure.signature, current);
  }

  return [...bySignature.entries()]
    .map(([signature, value]) => ({
      signature,
      source: value.source,
      category: value.category,
      count: value.count,
      latestAt: value.latestAt,
      sampleMessage: value.sampleMessage,
    }))
    .toSorted(
      (left, right) => right.count - left.count || right.latestAt.localeCompare(left.latestAt),
    )
    .slice(0, LIST_LIMIT);
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  // Also reject links/special files on platforms without O_NOFOLLOW/O_NONBLOCK.
  const before = await lstat(filePath);
  if (!before.isFile()) throw new Error("Diagnostics only reads regular files.");
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error("Diagnostics file identity changed while opening.");
    }
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    recordResourceAttribution("diagnostics", "file-tail", bytesRead, 0, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // A bounded tail may begin in the middle of a record. Never parse that fragment.
    return stat.size > length ? text.slice(text.indexOf("\n") + 1 || text.length) : text;
  } finally {
    await handle.close();
  }
}

function parseTraceRecordLine(line: string): TraceRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<TraceRecord>;
    if (
      (parsed.type === "effect-span" || parsed.type === "otlp-span") &&
      typeof parsed.name === "string" &&
      typeof parsed.traceId === "string" &&
      typeof parsed.spanId === "string" &&
      typeof parsed.startTimeUnixNano === "string" &&
      typeof parsed.endTimeUnixNano === "string" &&
      typeof parsed.durationMs === "number" &&
      Number.isFinite(parsed.durationMs) &&
      parsed.durationMs >= 0 &&
      parsed.traceId.trim().length > 0 &&
      parsed.spanId.trim().length > 0
    ) {
      return parsed as TraceRecord;
    }
  } catch {
    return null;
  }
  return null;
}

async function readTraceTail(input: {
  readonly filePath: string;
  readonly warnings: DiagnosticsWarning[];
  readonly optional?: boolean;
}): Promise<ReadonlyArray<TraceRecord>> {
  let tail = "";
  try {
    tail = await readFileTail(input.filePath, FILE_TAIL_BYTES);
  } catch (error) {
    if (input.optional && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    input.warnings.push({
      code: "diagnostics.trace-tail-unavailable",
      source: "trace-file",
      message: error instanceof Error ? error.message : "Unable to read trace tail.",
    });
    return [];
  }

  const records: TraceRecord[] = [];
  let malformed = 0;
  for (const line of tail.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = parseTraceRecordLine(trimmed);
    if (record) {
      records.push(record);
    } else {
      malformed += 1;
    }
  }
  if (malformed > 0) {
    input.warnings.push({
      code: "diagnostics.trace-tail-malformed-lines",
      source: "trace-file",
      message: "Some trace records in the retained tail could not be parsed.",
      count: malformed,
    });
  }
  return records.slice(-TRACE_RECORD_LIMIT);
}

async function readFailureLogTail(input: {
  readonly filePath: string;
  readonly source: string;
  readonly fallbackTime: string;
  readonly warnings: DiagnosticsWarning[];
}): Promise<ReadonlyArray<DiagnosticsFailure>> {
  let tail = "";
  try {
    tail = await readFileTail(input.filePath, FILE_TAIL_BYTES);
  } catch (error) {
    // Fresh installations have no provider/server log until the first record is written.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    input.warnings.push({
      code: "diagnostics.log-tail-unavailable",
      source: input.source,
      message: error instanceof Error ? error.message : "Unable to read log tail.",
    });
    return [];
  }

  return tail
    .split(/\r?\n/gu)
    .flatMap(
      (line) =>
        failureFromLogLine({
          line,
          source: input.source,
          fallbackTime: input.fallbackTime,
        }) ?? [],
    )
    .slice(-LIST_LIMIT);
}

/**
 * Provider runtime failures (`runtime.error`, failed turns, errored session
 * exits) from the current canonical logs of the most recently written threads.
 * A missing directory is a fresh install; other read errors become warnings.
 */
async function readProviderEventFailures(input: {
  readonly directory: string;
  readonly fallbackTime: string;
  readonly warnings: DiagnosticsWarning[];
}): Promise<ReadonlyArray<DiagnosticsFailure>> {
  let recent: ReadonlyArray<string>;
  try {
    const entries = await readdir(input.directory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isCurrentCanonicalProviderEventLog(entry.name))
        .map(async (entry) => {
          const filePath = path.join(input.directory, entry.name);
          try {
            return { filePath, mtimeMs: (await stat(filePath)).mtimeMs };
          } catch {
            // Rotated or swept between readdir and stat.
            return null;
          }
        }),
    );
    recent = candidates
      .flatMap((candidate) => (candidate === null ? [] : [candidate]))
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, PROVIDER_LOG_FILE_LIMIT)
      .map((candidate) => candidate.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    input.warnings.push({
      code: "diagnostics.log-tail-unavailable",
      source: PROVIDER_FAILURE_SOURCE,
      message: error instanceof Error ? error.message : "Unable to list provider event logs.",
    });
    return [];
  }

  const failures: DiagnosticsFailure[] = [];
  for (const filePath of recent) {
    let tail: string;
    try {
      tail = await readFileTail(filePath, PROVIDER_LOG_TAIL_BYTES);
    } catch (error) {
      // Rotation can move the file away between listing and reading.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      input.warnings.push({
        code: "diagnostics.log-tail-unavailable",
        source: PROVIDER_FAILURE_SOURCE,
        message: error instanceof Error ? error.message : "Unable to read provider event log.",
      });
      continue;
    }
    for (const line of tail.split(/\r?\n/gu)) {
      const failure =
        line.length > 0
          ? failureFromProviderEventLine({ line, fallbackTime: input.fallbackTime })
          : null;
      if (failure !== null) failures.push(failure);
    }
  }
  return failures
    .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-LIST_LIMIT);
}

function dedupeTraceRecords(records: ReadonlyArray<TraceRecord>): ReadonlyArray<TraceRecord> {
  const byId = new Map<string, TraceRecord>();
  for (const record of records) {
    byId.set(`${record.traceId}:${record.spanId}`, record);
  }
  return [...byId.values()];
}

function readTraceSinkHealth(
  reader: (() => TraceSinkHealth) | undefined,
): DiagnosticsTraceSinkHealth | null {
  if (reader === undefined) return null;
  try {
    return reader();
  } catch {
    return null;
  }
}

function buildOperationalPerformance(input: {
  readonly snapshotInput: DiagnosticsSnapshotInput;
  readonly generatedAt: string;
  readonly snapshotStartedAt: number;
  readonly traceSinkHealth: (() => TraceSinkHealth) | undefined;
}) {
  return {
    local: input.snapshotInput.localMetrics ?? {
      turnQuiescenceAvgMs: null,
      checkpointDurationP95Ms: null,
      latestThreadSnapshotDurationMs: null,
      threadSnapshotDurationP95Ms: null,
      wsReconnectCount: 0,
      windowSampleCounts: {
        turnQuiescence: 0,
        checkpointDuration: 0,
        threadSnapshotDuration: 0,
      },
      capturedAt: input.generatedAt,
    },
    queues: summarizeOperationalMetrics(input.snapshotInput.metricSnapshots ?? []),
    traceSink: readTraceSinkHealth(input.traceSinkHealth),
    snapshotCollectionDurationMs: Math.max(0, performance.now() - input.snapshotStartedAt),
  };
}

export const makeDiagnosticsService = Effect.fn("makeDiagnosticsService")(
  (
    config: ServerConfigShape,
    dependencies?: {
      readonly traceSinkHealth?: () => TraceSinkHealth;
    },
  ) =>
    Effect.sync((): DiagnosticsShape => {
      const serverStartedAtMs = Date.now();
      const serverStartedAt = new Date(serverStartedAtMs).toISOString();
      const traceRecords = makeRingBuffer<TraceRecord>(TRACE_RECORD_LIMIT);
      const resourceSampler = makeResourceSampler();
      const scannedFilePaths = [
        ...Array.from(
          { length: Math.min(10, Math.max(0, Math.floor(config.traceMaxFiles))) },
          (_, index) =>
            `${config.serverTracePath}.${Math.min(10, Math.max(0, Math.floor(config.traceMaxFiles))) - index}`,
        ),
        config.serverTracePath,
      ];
      let persistedDiagnosticsCache:
        | {
            readonly expiresAt: number;
            readonly traceRecords: ReadonlyArray<TraceRecord>;
            readonly failures: ReadonlyArray<DiagnosticsFailure>;
            readonly warnings: ReadonlyArray<DiagnosticsWarning>;
          }
        | undefined;

      const readPersistedDiagnostics = async (fallbackTime: string) => {
        const now = Date.now();
        if (persistedDiagnosticsCache !== undefined && persistedDiagnosticsCache.expiresAt > now) {
          return persistedDiagnosticsCache;
        }

        const warnings: DiagnosticsWarning[] = [];
        const traceTail: TraceRecord[] = [];
        for (const filePath of scannedFilePaths) {
          traceTail.push(
            ...(await readTraceTail({
              filePath,
              warnings,
              optional: filePath !== config.serverTracePath,
            })),
          );
        }
        const failures = [
          ...(await readFailureLogTail({
            filePath: config.serverLogPath,
            source: path.basename(config.serverLogPath),
            fallbackTime,
            warnings,
          })),
          ...(await readProviderEventFailures({
            directory: path.dirname(config.providerEventLogPath),
            fallbackTime,
            warnings,
          })),
        ];
        persistedDiagnosticsCache = {
          expiresAt: now + FILE_TAIL_REFRESH_INTERVAL_MS,
          traceRecords: traceTail.slice(-TRACE_RECORD_LIMIT),
          failures,
          warnings,
        };
        return persistedDiagnosticsCache;
      };

      let persistedRead: ReturnType<typeof readPersistedDiagnostics> | undefined;
      const readPersistedShared = (fallbackTime: string) => {
        if (persistedRead) return persistedRead;
        const pending = readPersistedDiagnostics(fallbackTime).finally(() => {
          persistedRead = undefined;
        });
        persistedRead = pending;
        return pending;
      };

      return {
        recordTraceRecords(records) {
          for (const record of records) {
            traceRecords.push(record);
          }
        },
        getSnapshot(input) {
          const snapshotStartedAt = performance.now();
          return Effect.tryPromise(async () => {
            const generatedAt = new Date().toISOString();
            const [currentResource, processTree, telemetry] = await Promise.all([
              resourceSampler.sample(),
              readProcessDiagnostics(),
              readResourceTelemetry({
                terminalPids: input.terminals.flatMap((terminal) =>
                  terminal.pid !== null && terminal.status === "running" ? [terminal.pid] : [],
                ),
              }),
            ]);
            const persistedDiagnostics = await readPersistedShared(generatedAt);
            const warnings = [...persistedDiagnostics.warnings];
            const allTraceRecords = dedupeTraceRecords([
              ...persistedDiagnostics.traceRecords,
              ...traceRecords.values(),
            ]).slice(-TRACE_RECORD_LIMIT);
            let skippedSpanRecords = 0;
            const spans = allTraceRecords
              .flatMap((record) => {
                const span = safeToDiagnosticsSpan(record);
                if (span === null) {
                  skippedSpanRecords += 1;
                  return [];
                }
                return [span];
              })
              .toSorted((left, right) => right.endTime.localeCompare(left.endTime));
            if (skippedSpanRecords > 0) {
              warnings.push({
                code: "diagnostics.trace-records-skipped",
                message: `Skipped ${skippedSpanRecords} malformed trace record(s).`,
              });
            }
            const failuresFromSpans = spans.flatMap((span) => failureFromSpan(span) ?? []);
            const failuresFromLogs = persistedDiagnostics.failures;
            const latestFailures = [...failuresFromSpans, ...failuresFromLogs]
              .toSorted((left, right) => right.occurredAt.localeCompare(left.occurredAt))
              .slice(0, LIST_LIMIT);
            const resourceHistory = resourceSampler.history();

            return {
              generatedAt,
              serverStartedAt,
              uptimeMs: Math.max(0, Date.now() - serverStartedAtMs),
              limits: {
                traceRecordLimit: TRACE_RECORD_LIMIT,
                resourceSampleLimit: RESOURCE_SAMPLE_LIMIT,
                fileTailBytes: FILE_TAIL_BYTES,
              },
              observability: {
                logsDirectoryPath: config.logsDir,
                serverLogPath: config.serverLogPath,
                serverTracePath: config.serverTracePath,
                providerEventLogPath: config.providerEventLogPath,
                localTracingEnabled: true,
                ...(config.otlpTracesUrl !== undefined
                  ? { otlpTracesUrl: diagnosticEndpoint(config.otlpTracesUrl) }
                  : {}),
                otlpTracesEnabled: config.otlpTracesUrl !== undefined,
                ...(config.otlpMetricsUrl !== undefined
                  ? { otlpMetricsUrl: diagnosticEndpoint(config.otlpMetricsUrl) }
                  : {}),
                otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
              },
              resources: {
                current: currentResource,
                history: resourceHistory,
                host: {
                  cpuCount: os.cpus().length,
                  totalMemoryBytes: os.totalmem(),
                  availableMemoryBytes: os.freemem(),
                },
              },
              processTree,
              telemetry,
              liveProcesses: {
                server: {
                  pid: process.pid,
                  platform: process.platform,
                  runtime: typeof Bun !== "undefined" ? "bun" : "node",
                  version: typeof Bun !== "undefined" ? Bun.version : process.versions.node,
                  cwd: config.cwd,
                },
                terminals: [...input.terminals],
                providers: [...input.providers],
              },
              tracing: {
                summary: buildTraceSummary(spans, allTraceRecords, warnings, scannedFilePaths),
                retainedSpanCount: allTraceRecords.length,
                recentSpans: spans.slice(0, LIST_LIMIT),
                slowestSpans: [...spans]
                  .toSorted((left, right) => right.durationMs - left.durationMs)
                  .slice(0, LIST_LIMIT),
                topSpanNames: buildTopSpanNames(spans),
                durationBuckets: buildDurationBuckets(spans),
                recentEvents: toDiagnosticsSpanEvents(allTraceRecords),
              },
              failures: {
                latest: latestFailures,
                common: buildFailureSummary([...failuresFromSpans, ...failuresFromLogs]),
              },
              client: {
                slowRpcAcks: [],
              },
              performance: buildOperationalPerformance({
                snapshotInput: input,
                generatedAt,
                snapshotStartedAt,
                traceSinkHealth: dependencies?.traceSinkHealth,
              }),
              warnings,
            };
          }).pipe(
            Effect.catch((error) =>
              Effect.promise(async () => {
                const generatedAt = new Date().toISOString();
                const currentResource = await resourceSampler.sample();
                return {
                  generatedAt,
                  serverStartedAt,
                  uptimeMs: Math.max(0, Date.now() - serverStartedAtMs),
                  limits: {
                    traceRecordLimit: TRACE_RECORD_LIMIT,
                    resourceSampleLimit: RESOURCE_SAMPLE_LIMIT,
                    fileTailBytes: FILE_TAIL_BYTES,
                  },
                  observability: {
                    logsDirectoryPath: config.logsDir,
                    serverLogPath: config.serverLogPath,
                    serverTracePath: config.serverTracePath,
                    providerEventLogPath: config.providerEventLogPath,
                    localTracingEnabled: true,
                    ...(config.otlpTracesUrl !== undefined
                      ? { otlpTracesUrl: diagnosticEndpoint(config.otlpTracesUrl) }
                      : {}),
                    otlpTracesEnabled: config.otlpTracesUrl !== undefined,
                    ...(config.otlpMetricsUrl !== undefined
                      ? { otlpMetricsUrl: diagnosticEndpoint(config.otlpMetricsUrl) }
                      : {}),
                    otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
                  },
                  resources: {
                    current: currentResource,
                    history: resourceSampler.history(),
                  },
                  liveProcesses: {
                    server: {
                      pid: process.pid,
                      platform: process.platform,
                      runtime: typeof Bun !== "undefined" ? "bun" : "node",
                      version: typeof Bun !== "undefined" ? Bun.version : process.versions.node,
                      cwd: config.cwd,
                    },
                    terminals: [...input.terminals],
                    providers: [...input.providers],
                  },
                  tracing: {
                    retainedSpanCount: traceRecords.size(),
                    recentSpans: [],
                    slowestSpans: [],
                    topSpanNames: [],
                    durationBuckets: buildDurationBuckets([]),
                    recentEvents: [],
                  },
                  failures: {
                    latest: [],
                    common: [],
                  },
                  client: {
                    slowRpcAcks: [],
                  },
                  performance: buildOperationalPerformance({
                    snapshotInput: input,
                    generatedAt,
                    snapshotStartedAt,
                    traceSinkHealth: dependencies?.traceSinkHealth,
                  }),
                  warnings: [
                    {
                      code: "diagnostics.snapshot-partial",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Diagnostics snapshot was partially collected.",
                    },
                  ],
                };
              }),
            ),
          );
        },
      } satisfies DiagnosticsShape;
    }),
);
