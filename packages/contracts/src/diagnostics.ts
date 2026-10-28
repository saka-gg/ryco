import * as Schema from "effect/Schema";
import { ResourceTelemetrySnapshot } from "./resourceTelemetry.ts";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderState } from "./server.ts";
import { TerminalSessionStatus } from "./terminal.ts";

export const DiagnosticsWarning = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  source: Schema.optional(TrimmedNonEmptyString),
  count: Schema.optional(NonNegativeInt),
});
export type DiagnosticsWarning = typeof DiagnosticsWarning.Type;

export const DiagnosticsObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  serverLogPath: TrimmedNonEmptyString,
  serverTracePath: TrimmedNonEmptyString,
  providerEventLogPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type DiagnosticsObservability = typeof DiagnosticsObservability.Type;

export const DiagnosticsResourceMemory = Schema.Struct({
  rssBytes: NonNegativeInt,
  heapUsedBytes: NonNegativeInt,
  heapTotalBytes: NonNegativeInt,
  externalBytes: NonNegativeInt,
  arrayBuffersBytes: NonNegativeInt,
});
export type DiagnosticsResourceMemory = typeof DiagnosticsResourceMemory.Type;

export const DiagnosticsResourceCpu = Schema.Struct({
  userMicros: NonNegativeInt,
  systemMicros: NonNegativeInt,
  utilizationPercent: Schema.optional(Schema.Number),
});
export type DiagnosticsResourceCpu = typeof DiagnosticsResourceCpu.Type;

export const DiagnosticsResourceSample = Schema.Struct({
  sampledAt: IsoDateTime,
  uptimeMs: NonNegativeInt,
  memory: DiagnosticsResourceMemory,
  cpu: DiagnosticsResourceCpu,
  eventLoopDelayMs: Schema.optional(Schema.Number),
});
export type DiagnosticsResourceSample = typeof DiagnosticsResourceSample.Type;

export const DiagnosticsHostResources = Schema.Struct({
  cpuCount: NonNegativeInt,
  totalMemoryBytes: NonNegativeInt,
  availableMemoryBytes: NonNegativeInt,
});
export type DiagnosticsHostResources = typeof DiagnosticsHostResources.Type;

export const DiagnosticsResources = Schema.Struct({
  host: Schema.optional(DiagnosticsHostResources),
  current: DiagnosticsResourceSample,
  history: Schema.Array(DiagnosticsResourceSample),
});
export type DiagnosticsResources = typeof DiagnosticsResources.Type;

export const DiagnosticsServerProcess = Schema.Struct({
  pid: NonNegativeInt,
  platform: TrimmedNonEmptyString,
  runtime: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});
export type DiagnosticsServerProcess = typeof DiagnosticsServerProcess.Type;

export const DiagnosticsTerminalProcess = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(NonNegativeInt),
  hasRunningSubprocess: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: IsoDateTime,
});
export type DiagnosticsTerminalProcess = typeof DiagnosticsTerminalProcess.Type;

export const DiagnosticsProviderProcess = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: ServerProviderState,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type DiagnosticsProviderProcess = typeof DiagnosticsProviderProcess.Type;

export const DiagnosticsLiveProcesses = Schema.Struct({
  server: DiagnosticsServerProcess,
  terminals: Schema.Array(DiagnosticsTerminalProcess),
  providers: Schema.Array(DiagnosticsProviderProcess),
});
export type DiagnosticsLiveProcesses = typeof DiagnosticsLiveProcesses.Type;

export const DiagnosticsSpanStatus = Schema.Literals([
  "success",
  "failure",
  "interrupted",
  "error",
  "unset",
]);
export type DiagnosticsSpanStatus = typeof DiagnosticsSpanStatus.Type;

export const DiagnosticsSpanSource = Schema.Literals(["server", "browser", "unknown"]);
export type DiagnosticsSpanSource = typeof DiagnosticsSpanSource.Type;

export const DiagnosticsSpan = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: DiagnosticsSpanSource,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
  parentSpanId: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  startTime: IsoDateTime,
  endTime: IsoDateTime,
  durationMs: Schema.Number,
  status: DiagnosticsSpanStatus,
  failureMessage: Schema.optional(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
});
export type DiagnosticsSpan = typeof DiagnosticsSpan.Type;

export const DiagnosticsSpanEvent = Schema.Struct({
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
  spanName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  time: IsoDateTime,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
});
export type DiagnosticsSpanEvent = typeof DiagnosticsSpanEvent.Type;

export const DiagnosticsSpanNameSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  count: NonNegativeInt,
  failureCount: NonNegativeInt,
  totalDurationMs: Schema.Number,
  averageDurationMs: Schema.Number,
  maxDurationMs: Schema.Number,
});
export type DiagnosticsSpanNameSummary = typeof DiagnosticsSpanNameSummary.Type;

export const DiagnosticsDurationBucket = Schema.Struct({
  label: TrimmedNonEmptyString,
  minMs: NonNegativeInt,
  maxMs: Schema.optional(NonNegativeInt),
  count: NonNegativeInt,
});
export type DiagnosticsDurationBucket = typeof DiagnosticsDurationBucket.Type;

export const DiagnosticsTraceSummary = Schema.Struct({
  parseErrorCount: NonNegativeInt,
  scannedFilePaths: Schema.Array(TrimmedNonEmptyString),
  firstSpanAt: Schema.NullOr(IsoDateTime),
  lastSpanAt: Schema.NullOr(IsoDateTime),
  failureCount: NonNegativeInt,
  interruptionCount: NonNegativeInt,
  slowSpanThresholdMs: NonNegativeInt,
  slowSpanCount: NonNegativeInt,
  logLevelCounts: Schema.Record(Schema.String, NonNegativeInt),
  latestWarningAndErrorLogs: Schema.Array(
    Schema.Struct({
      traceId: TrimmedNonEmptyString,
      spanId: TrimmedNonEmptyString,
      spanName: TrimmedNonEmptyString,
      level: TrimmedNonEmptyString,
      message: Schema.String,
      seenAt: IsoDateTime,
    }),
  ),
  partialFailure: Schema.Boolean,
});
export type DiagnosticsTraceSummary = typeof DiagnosticsTraceSummary.Type;

export const DiagnosticsTracing = Schema.Struct({
  summary: Schema.optional(DiagnosticsTraceSummary),
  retainedSpanCount: NonNegativeInt,
  recentSpans: Schema.Array(DiagnosticsSpan),
  slowestSpans: Schema.Array(DiagnosticsSpan),
  topSpanNames: Schema.Array(DiagnosticsSpanNameSummary),
  durationBuckets: Schema.Array(DiagnosticsDurationBucket),
  recentEvents: Schema.Array(DiagnosticsSpanEvent),
});
export type DiagnosticsTracing = typeof DiagnosticsTracing.Type;

export const DiagnosticsFailure = Schema.Struct({
  id: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  source: TrimmedNonEmptyString,
  category: TrimmedNonEmptyString,
  signature: TrimmedNonEmptyString,
  message: Schema.String,
  raw: Schema.optional(Schema.Unknown),
});
export type DiagnosticsFailure = typeof DiagnosticsFailure.Type;

export const DiagnosticsFailureSummary = Schema.Struct({
  signature: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  category: TrimmedNonEmptyString,
  count: NonNegativeInt,
  latestAt: IsoDateTime,
  sampleMessage: Schema.String,
});
export type DiagnosticsFailureSummary = typeof DiagnosticsFailureSummary.Type;

export const DiagnosticsFailures = Schema.Struct({
  latest: Schema.Array(DiagnosticsFailure),
  common: Schema.Array(DiagnosticsFailureSummary),
});
export type DiagnosticsFailures = typeof DiagnosticsFailures.Type;

export const DiagnosticsClientSlowRpcAck = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  tag: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  thresholdMs: NonNegativeInt,
});
export type DiagnosticsClientSlowRpcAck = typeof DiagnosticsClientSlowRpcAck.Type;

export const DiagnosticsClient = Schema.Struct({
  slowRpcAcks: Schema.Array(DiagnosticsClientSlowRpcAck),
});
export type DiagnosticsClient = typeof DiagnosticsClient.Type;

export const DiagnosticsLocalPerformance = Schema.Struct({
  turnQuiescenceAvgMs: Schema.NullOr(Schema.Number),
  checkpointDurationP95Ms: Schema.NullOr(Schema.Number),
  latestThreadSnapshotDurationMs: Schema.NullOr(Schema.Number),
  threadSnapshotDurationP95Ms: Schema.NullOr(Schema.Number),
  wsReconnectCount: NonNegativeInt,
  windowSampleCounts: Schema.Struct({
    turnQuiescence: NonNegativeInt,
    checkpointDuration: NonNegativeInt,
    threadSnapshotDuration: NonNegativeInt,
  }),
  capturedAt: IsoDateTime,
});
export type DiagnosticsLocalPerformance = typeof DiagnosticsLocalPerformance.Type;

export const DiagnosticsQueuePressure = Schema.Struct({
  runtimeDepthTotal: NonNegativeInt,
  runtimeHighWaterMax: NonNegativeInt,
  replayDepthMax: NonNegativeInt,
  liveBufferDepthTotal: NonNegativeInt,
  liveBufferHighWaterMax: NonNegativeInt,
  liveBufferOverflowCount: NonNegativeInt,
  replayLagMax: NonNegativeInt,
  providerLogDroppedRecords: NonNegativeInt,
});
export type DiagnosticsQueuePressure = typeof DiagnosticsQueuePressure.Type;

export const DiagnosticsTraceSinkHealth = Schema.Struct({
  bufferedBytes: NonNegativeInt,
  bufferedRecords: NonNegativeInt,
  maxBufferedBytes: NonNegativeInt,
  maxBufferedRecords: NonNegativeInt,
  droppedRecords: NonNegativeInt,
  writeFailures: NonNegativeInt,
  retryDelayMs: NonNegativeInt,
  lastWriteFailureAt: Schema.NullOr(IsoDateTime),
});
export type DiagnosticsTraceSinkHealth = typeof DiagnosticsTraceSinkHealth.Type;

export const DiagnosticsOperationalPerformance = Schema.Struct({
  local: DiagnosticsLocalPerformance,
  queues: DiagnosticsQueuePressure,
  traceSink: Schema.NullOr(DiagnosticsTraceSinkHealth),
  snapshotCollectionDurationMs: Schema.Number,
});
export type DiagnosticsOperationalPerformance = typeof DiagnosticsOperationalPerformance.Type;

export const DiagnosticsLimits = Schema.Struct({
  traceRecordLimit: NonNegativeInt,
  resourceSampleLimit: NonNegativeInt,
  fileTailBytes: NonNegativeInt,
});
export type DiagnosticsLimits = typeof DiagnosticsLimits.Type;

export const DiagnosticsProcessEntry = Schema.Struct({
  pid: NonNegativeInt,
  ppid: NonNegativeInt,
  startTimeMs: NonNegativeInt,
  command: Schema.String,
  status: Schema.String,
  cpuPercent: Schema.Number,
  rssBytes: NonNegativeInt,
  elapsed: Schema.String,
  depth: NonNegativeInt,
  childPids: Schema.Array(NonNegativeInt),
});
export type DiagnosticsProcessEntry = typeof DiagnosticsProcessEntry.Type;
export const DiagnosticsProcessTree = Schema.Struct({
  readAt: IsoDateTime,
  serverPid: NonNegativeInt,
  processes: Schema.Array(DiagnosticsProcessEntry),
  totalCpuPercent: Schema.Number,
  totalRssBytes: NonNegativeInt,
  error: Schema.optional(Schema.String),
});
export type DiagnosticsProcessTree = typeof DiagnosticsProcessTree.Type;
export const DiagnosticsSignalProcessInput = Schema.Struct({
  pid: NonNegativeInt,
  startTimeMs: NonNegativeInt,
  signal: Schema.Literals(["SIGINT", "SIGKILL"]),
});
export type DiagnosticsSignalProcessInput = typeof DiagnosticsSignalProcessInput.Type;
export const DiagnosticsSignalProcessResult = Schema.Struct({
  pid: NonNegativeInt,
  signal: Schema.Literals(["SIGINT", "SIGKILL"]),
  signaled: Schema.Boolean,
  message: Schema.optional(Schema.String),
});
export type DiagnosticsSignalProcessResult = typeof DiagnosticsSignalProcessResult.Type;

/**
 * One record of the server's event-loop stall history (`event-loop-stalls.ndjson`). `kind` is an
 * open set (`event-loop`, `threadpool`, `threadpool-pending` today) so a newer server's kinds never
 * break an older reader. Optional fields are absent where the platform has no value.
 */
export const DiagnosticsEventLoopStall = Schema.Struct({
  time: IsoDateTime,
  kind: TrimmedNonEmptyString,
  /** The longest stall the record covers. */
  durationMs: NonNegativeInt,
  startedAt: Schema.optional(IsoDateTime),
  count: NonNegativeInt,
  totalMs: NonNegativeInt,
  suspendedMs: Schema.optional(NonNegativeInt),
  /** `elu` or `cpu`: how busy time was measured. Open set. */
  busySource: Schema.optional(TrimmedNonEmptyString),
  cpuUserMs: Schema.optional(NonNegativeInt),
  cpuSystemMs: Schema.optional(NonNegativeInt),
  majorPageFaults: Schema.optional(NonNegativeInt),
  minorPageFaults: Schema.optional(NonNegativeInt),
  involuntaryContextSwitches: Schema.optional(NonNegativeInt),
  rssBytes: Schema.optional(NonNegativeInt),
  heapUsedBytes: Schema.optional(NonNegativeInt),
  loadAverage1m: Schema.optional(Schema.Number),
  cpuCount: Schema.optional(NonNegativeInt),
  phases: Schema.optional(Schema.Array(Schema.String)),
  pid: Schema.optional(NonNegativeInt),
  uptimeMs: Schema.optional(NonNegativeInt),
});
export type DiagnosticsEventLoopStall = typeof DiagnosticsEventLoopStall.Type;

export const DiagnosticsEventLoopHistory = Schema.Struct({
  thresholdMs: NonNegativeInt,
  windowMs: NonNegativeInt,
  historyFilePaths: Schema.Array(TrimmedNonEmptyString),
  /** Newest first, at most 50. */
  recent: Schema.Array(DiagnosticsEventLoopStall),
  last24h: Schema.Struct({
    records: NonNegativeInt,
    /** Event-loop stalls (summed record counts). */
    stalls: NonNegativeInt,
    longestMs: NonNegativeInt,
    /** Threadpool stalls of every threadpool kind (summed record counts). */
    threadpoolStalls: NonNegativeInt,
  }),
});
export type DiagnosticsEventLoopHistory = typeof DiagnosticsEventLoopHistory.Type;

export const DiagnosticsSnapshot = Schema.Struct({
  generatedAt: IsoDateTime,
  serverStartedAt: IsoDateTime,
  uptimeMs: NonNegativeInt,
  limits: DiagnosticsLimits,
  observability: DiagnosticsObservability,
  resources: DiagnosticsResources,
  liveProcesses: DiagnosticsLiveProcesses,
  processTree: Schema.optional(DiagnosticsProcessTree),
  telemetry: Schema.optional(ResourceTelemetrySnapshot),
  tracing: DiagnosticsTracing,
  failures: DiagnosticsFailures,
  client: DiagnosticsClient,
  performance: Schema.optional(DiagnosticsOperationalPerformance),
  /** Absent from servers that do not record stalls yet. */
  eventLoop: Schema.optional(DiagnosticsEventLoopHistory),
  warnings: Schema.Array(DiagnosticsWarning),
});
export type DiagnosticsSnapshot = typeof DiagnosticsSnapshot.Type;

export class DiagnosticsError extends Schema.TaggedError<DiagnosticsError>()("DiagnosticsError", {
  operation: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Diagnostics ${this.operation} failed: ${this.detail}`;
  }
}
