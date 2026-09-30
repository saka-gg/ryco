import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const RetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
export const StorageRetentionPolicy = Schema.Struct({
  automatic: Schema.Boolean,
  completedWorktreeDays: RetentionDays,
  temporaryDataDays: RetentionDays,
});
export type StorageRetentionPolicy = typeof StorageRetentionPolicy.Type;

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
export const StorageSnapshot = Schema.Struct({
  scannedAt: IsoDateTime,
  entries: Schema.Array(StorageEntry),
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
  history: Schema.Array(StorageUsageSample),
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
