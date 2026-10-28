import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const RetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
/** A complete policy as sent in settings patches; a partial one is rejected, not reset. */
export const StorageRetentionPolicyInput = Schema.Struct({
  automatic: Schema.Boolean,
  completedWorktreeDays: RetentionDays,
  temporaryDataDays: RetentionDays,
});

// Per-field defaults: settings files written sparsely by older builds omit default fields.
export const StorageRetentionPolicy = Schema.Struct({
  automatic: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  completedWorktreeDays: RetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  temporaryDataDays: RetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageRetentionPolicy = typeof StorageRetentionPolicy.Type;

export const DEFAULT_STORAGE_RETENTION_POLICY: StorageRetentionPolicy = Schema.decodeSync(
  StorageRetentionPolicy,
)({});

export const StorageEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  category: Schema.Literals([
    "repository",
    "worktree",
    "temporary",
    "history",
    "attachments",
    "protected",
  ]),
  label: Schema.String,
  path: Schema.String,
  bytes: Schema.NullOr(NonNegativeInt),
  sizeStatus: Schema.Literals(["complete", "bounded", "unknown"]),
  eligible: Schema.Boolean,
  reason: Schema.String,
});
export type StorageEntry = typeof StorageEntry.Type;
export const StorageUsageSample = Schema.Struct({
  sampledAt: IsoDateTime,
  projectId: Schema.NullOr(ProjectId),
  measuredBytes: NonNegativeInt,
  incompleteEntries: NonNegativeInt,
});
/** Background removal of superseded history from the event log (see docs/storage-management.md). */
export const DatabaseCompactionReport = Schema.Struct({
  /** Removing (`RYCO_EVENT_COMPACTION` unset or `on`); false when off or only dry-running. */
  enabled: Schema.Boolean,
  headSequence: NonNegativeInt,
  /** History up to here has been examined. */
  compactedThroughSequence: NonNegativeInt,
  /** The last pass left nothing settled behind (events older than a day, old receipts). */
  caughtUp: Schema.Boolean,
  lastPassCompletedAt: Schema.NullOr(IsoDateTime),
  removedEvents: NonNegativeInt,
  removedBytes: NonNegativeInt,
  /** Superseded bytes the rest of the history likely holds; null before the first pass. */
  estimatedCompactableBytes: Schema.NullOr(NonNegativeInt),
});
export type DatabaseCompactionReport = typeof DatabaseCompactionReport.Type;

/** The node's state database: its size, free space inside it, and what could be returned. */
export const DatabaseStorageReport = Schema.Struct({
  fileBytes: NonNegativeInt,
  /**
   * Size of the `-wal` file. SQLite keeps and reuses it after merging its writes into the file
   * (up to `journal_size_limit`), so this is space on disk, not writes still pending.
   */
  walBytes: NonNegativeInt,
  pageSize: NonNegativeInt,
  pageCount: NonNegativeInt,
  /** Pages inside the file that hold nothing; SQLite reuses them before growing the file. */
  freePages: NonNegativeInt,
  /** `incremental`: free pages are returned to the file system online; `none`: they stay. */
  autoVacuum: Schema.Literals(["none", "full", "incremental"]),
  compaction: DatabaseCompactionReport,
  /** Free pages plus the compaction estimate. */
  reclaimableBytes: NonNegativeInt,
  /**
   * Whether an offline `ryco doctor --apply` would shrink the file a lot (automatic shrinking off
   * and much reclaimable space), and the command to run it; null for development databases.
   * Absent from nodes that predate it.
   */
  doctor: Schema.optionalKey(
    Schema.Struct({
      recommended: Schema.Boolean,
      command: Schema.NullOr(Schema.String),
    }),
  ),
});
export type DatabaseStorageReport = typeof DatabaseStorageReport.Type;

export const StorageSnapshot = Schema.Struct({
  scannedAt: IsoDateTime,
  entries: Schema.Array(StorageEntry),
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
  history: Schema.Array(StorageUsageSample),
  /** Absent from nodes that predate it; older clients ignore it. */
  database: Schema.optionalKey(DatabaseStorageReport),
});
export type StorageSnapshot = typeof StorageSnapshot.Type;
export const StorageScanInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export const StoragePreviewInput = Schema.Struct({
  entryIds: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
});
export const StorageCleanupPreview = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  entries: Schema.Array(StorageEntry),
});
export type StorageCleanupPreview = typeof StorageCleanupPreview.Type;
export const StorageExecuteInput = Schema.Struct({
  token: TrimmedNonEmptyString,
  confirmation: Schema.Literal("delete reviewed data"),
});
export const StorageCleanupResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["removed", "protected", "failed"]),
      detail: Schema.String,
    }),
  ),
});
export type StorageCleanupResult = typeof StorageCleanupResult.Type;
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
