import { Schema } from "effect";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const USAGE_CONTRACT_VERSION = 2 as const;

export const UsageCalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type UsageCalendarDate = typeof UsageCalendarDate.Type;

export const UsageProviderKind = Schema.Literals(["claude", "codex", "cursor", "opencode"]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

export const UsageCostSource = Schema.Literals([
  "provider-reported",
  "litellm",
  "mixed",
  "unpriced",
]);
export type UsageCostSource = typeof UsageCostSource.Type;

export const UsageSourceStatus = Schema.Literals([
  "complete",
  "not-found",
  "partial",
  "failed",
  "unsupported",
]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSourceDeduplicationKind = Schema.Literals([
  "physical",
  "environment-only",
  "declared",
]);
export type UsageSourceDeduplicationKind = typeof UsageSourceDeduplicationKind.Type;

export const UsagePricingState = Schema.Literals(["live", "cached", "unavailable"]);
export type UsagePricingState = typeof UsagePricingState.Type;

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeFinite,
  cachedInputTokens: NonNegativeFinite,
  cacheCreationInputTokens: NonNegativeFinite,
  outputTokens: NonNegativeFinite,
  reasoningTokens: Schema.optional(NonNegativeFinite),
  totalTokens: NonNegativeFinite,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageDailyBucket = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  // Cursor exports retain only anonymized event/session identity for overlap dedupe.
  exportRecordId: Schema.optional(TrimmedNonEmptyString),
  exportSessionId: Schema.optional(TrimmedNonEmptyString),
  date: UsageCalendarDate,
  provider: UsageProviderKind,
  model: Schema.String,
  rawModel: Schema.optional(Schema.String),
  tokens: UsageTokenTotals,
  responseCount: NonNegativeInt,
  sessionCount: NonNegativeInt,
  estimatedCostUsd: Schema.optional(NonNegativeFinite),
  estimatedCacheSavingsUsd: Schema.optional(NonNegativeFinite),
  pricedTokenCount: NonNegativeFinite,
  unpricedTokenCount: NonNegativeFinite,
  costSource: UsageCostSource,
});
export type UsageDailyBucket = typeof UsageDailyBucket.Type;

export const UsageSourceCoverage = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  deduplicationKind: UsageSourceDeduplicationKind,
  status: UsageSourceStatus,
  transcriptFileCount: NonNegativeInt,
  reusedCacheFileCount: NonNegativeInt,
  parsedFileCount: NonNegativeInt,
  skippedLineCount: NonNegativeInt,
  malformedLineCount: NonNegativeInt,
  distinctSessionCount: NonNegativeInt,
  distinctResponseCount: NonNegativeInt,
  scanStartedAt: IsoDateTime,
  scanFinishedAt: IsoDateTime,
  scanDurationMs: NonNegativeInt,
  diagnosticCode: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type UsageSourceCoverage = typeof UsageSourceCoverage.Type;

export const UsagePricingStatus = Schema.Struct({
  state: UsagePricingState,
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  fetchedAt: Schema.optional(IsoDateTime),
  cacheAgeMs: Schema.optional(NonNegativeInt),
  recognizedModelCount: NonNegativeInt,
  unrecognizedModelCount: NonNegativeInt,
});
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

export const UsageSummaryRequest = Schema.Struct({
  startDate: Schema.optional(UsageCalendarDate),
  endDate: UsageCalendarDate,
  timeZone: TrimmedNonEmptyString,
  // Accept older requests so the service can return a friendly update error.
  contractVersion: NonNegativeInt,
});
export type UsageSummaryRequest = typeof UsageSummaryRequest.Type;

/** User-supplied provider export metadata; unavailable token fields are absent. */
export const UsageImportedMetric = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  recordId: TrimmedNonEmptyString,
  provider: Schema.Literal("cursor"),
  date: UsageCalendarDate,
  model: Schema.optional(Schema.String),
  metric: Schema.Literals(["requests", "cost"]),
  value: NonNegativeFinite,
  currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
});
export type UsageImportedMetric = typeof UsageImportedMetric.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Literal(USAGE_CONTRACT_VERSION),
  startDate: Schema.optional(UsageCalendarDate),
  endDate: UsageCalendarDate,
  timeZone: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  scanDurationMs: NonNegativeInt,
  buckets: Schema.Array(UsageDailyBucket),
  imports: Schema.optional(Schema.Array(UsageImportedMetric)),
  sources: Schema.Array(UsageSourceCoverage),
  pricing: UsagePricingStatus,
});
export type UsageSummary = typeof UsageSummary.Type;

export const UsageReadErrorReason = Schema.Literals([
  "invalid-window",
  "invalid-time-zone",
  "scan-failed",
]);
export type UsageReadErrorReason = typeof UsageReadErrorReason.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: UsageReadErrorReason,
  detail: TrimmedNonEmptyString,
  environmentId: Schema.optional(EnvironmentId),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
