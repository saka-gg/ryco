import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DiagnosticsPowerSnapshot = Schema.Struct({
  idleState: Schema.String,
  idleSeconds: Schema.Number,
  onBattery: Schema.Boolean,
  thermalState: Schema.String,
  speedLimitPercent: Schema.NullOr(Schema.Number),
  suspended: Schema.Boolean,
  locked: Schema.optional(Schema.NullOr(Schema.Boolean)),
  lowPowerMode: Schema.optional(Schema.NullOr(Schema.Boolean)),
  updatedAt: Schema.optional(IsoDateTime),
  stale: Schema.optional(Schema.Boolean),
});
export type DiagnosticsPowerSnapshot = typeof DiagnosticsPowerSnapshot.Type;

export const ResourceTelemetryIoSemantics = Schema.Literals([
  "storage",
  "logical",
  "all-io",
  "unavailable",
]);
export type ResourceTelemetryIoSemantics = typeof ResourceTelemetryIoSemantics.Type;

export const ResourceTelemetryProcessCategory = Schema.Literals([
  "server",
  "server-child",
  "provider-root",
  "terminal-root",
  "electron-main",
  "electron-renderer",
  "electron-gpu",
  "electron-utility",
  "resource-monitor",
  "unknown-ryco",
]);
export type ResourceTelemetryProcessCategory = typeof ResourceTelemetryProcessCategory.Type;

export const ResourceTelemetrySourceStatus = Schema.Literals([
  "starting",
  "healthy",
  "degraded",
  "unavailable",
  "stopped",
]);
export type ResourceTelemetrySourceStatus = typeof ResourceTelemetrySourceStatus.Type;

export const ResourceTelemetryProcessIdentity = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
});
export type ResourceTelemetryProcessIdentity = typeof ResourceTelemetryProcessIdentity.Type;

export const ResourceMonitorExternalProcess = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: Schema.optional(NonNegativeInt),
});
export type ResourceMonitorExternalProcess = typeof ResourceMonitorExternalProcess.Type;

export const ResourceMonitorCapabilities = Schema.Struct({
  cumulativeCpuTime: Schema.Boolean,
  currentCpuPercent: Schema.Boolean,
  residentMemory: Schema.Boolean,
  virtualMemory: Schema.Boolean,
  ioBytes: Schema.Boolean,
  processStartTime: Schema.Boolean,
  processTree: Schema.Boolean,
});
export type ResourceMonitorCapabilities = typeof ResourceMonitorCapabilities.Type;

export const ResourceMonitorProcessSample = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  startTimeMs: NonNegativeInt,
  runTimeMs: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: Schema.Literals(["storage", "all-io"]),
});
export type ResourceMonitorProcessSample = typeof ResourceMonitorProcessSample.Type;

export const ResourceTelemetryProcess = Schema.Struct({
  identity: ResourceTelemetryProcessIdentity,
  ppid: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  category: ResourceTelemetryProcessCategory,
  electronType: Schema.optional(Schema.String),
  electronServiceName: Schema.optional(Schema.String),
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  peakResidentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  ioSemantics: ResourceTelemetryIoSemantics,
  idleWakeupsPerSecond: Schema.optional(Schema.Number),
  runTimeMs: NonNegativeInt,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
});
export type ResourceTelemetryProcess = typeof ResourceTelemetryProcess.Type;

export const ResourceTelemetryAggregate = Schema.Struct({
  processCount: NonNegativeInt,
  currentCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  processStarts: NonNegativeInt,
  processExits: NonNegativeInt,
});
export type ResourceTelemetryAggregate = typeof ResourceTelemetryAggregate.Type;

export const ResourceTelemetryGroups = Schema.Struct({
  backend: ResourceTelemetryAggregate,
  electron: ResourceTelemetryAggregate,
  monitor: ResourceTelemetryAggregate,
  allRyco: ResourceTelemetryAggregate,
});
export type ResourceTelemetryGroups = typeof ResourceTelemetryGroups.Type;

export const ResourceTelemetrySourceHealth = Schema.Struct({
  status: ResourceTelemetrySourceStatus,
  lastSampleAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
});
export type ResourceTelemetrySourceHealth = typeof ResourceTelemetrySourceHealth.Type;

export const ResourceTelemetryHealth = Schema.Struct({
  native: ResourceTelemetrySourceHealth,
  desktop: ResourceTelemetrySourceHealth,
  sidecarVersion: Schema.NullOr(TrimmedNonEmptyString),
  sidecarPid: Schema.NullOr(PositiveInt),
  restartCount: NonNegativeInt,
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  retainedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
});
export type ResourceTelemetryHealth = typeof ResourceTelemetryHealth.Type;

export const ResourceAttributionEntry = Schema.Struct({
  component: TrimmedNonEmptyString,
  operation: TrimmedNonEmptyString,
  logicalReadBytes: NonNegativeInt,
  logicalWriteBytes: NonNegativeInt,
  count: NonNegativeInt,
  durationMs: NonNegativeInt,
});
export type ResourceAttributionEntry = typeof ResourceAttributionEntry.Type;

export const ResourceAttributionSnapshot = Schema.Struct({
  readAt: IsoDateTime,
  entries: Schema.Array(ResourceAttributionEntry),
});
export type ResourceAttributionSnapshot = typeof ResourceAttributionSnapshot.Type;

export const ResourceTelemetrySnapshot = Schema.Struct({
  readAt: IsoDateTime,
  sampleIntervalMs: NonNegativeInt,
  processes: Schema.Array(ResourceTelemetryProcess),
  groups: ResourceTelemetryGroups,
  power: Schema.NullOr(DiagnosticsPowerSnapshot),
  speedLimitPercent: Schema.NullOr(Schema.Number),
  attribution: ResourceAttributionSnapshot,
  health: ResourceTelemetryHealth,
});
export type ResourceTelemetrySnapshot = typeof ResourceTelemetrySnapshot.Type;

export const ResourceTelemetryHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ResourceTelemetryHistoryInput = typeof ResourceTelemetryHistoryInput.Type;

export const ResourceTelemetryHistoryBucket = Schema.Struct({
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ResourceTelemetryHistoryBucket = typeof ResourceTelemetryHistoryBucket.Type;

export const ResourceTelemetryProcessSummary = Schema.Struct({
  identity: ResourceTelemetryProcessIdentity,
  ppid: NonNegativeInt,
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  category: ResourceTelemetryProcessCategory,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: ResourceTelemetryIoSemantics,
  sampleCount: NonNegativeInt,
});
export type ResourceTelemetryProcessSummary = typeof ResourceTelemetryProcessSummary.Type;

export const ResourceTelemetryHistory = Schema.Struct({
  totalCpuTimeMs: Schema.optional(NonNegativeInt),
  readAt: IsoDateTime,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  buckets: Schema.Array(ResourceTelemetryHistoryBucket),
  topProcesses: Schema.Array(ResourceTelemetryProcessSummary),
  health: ResourceTelemetryHealth,
});
export type ResourceTelemetryHistory = typeof ResourceTelemetryHistory.Type;
