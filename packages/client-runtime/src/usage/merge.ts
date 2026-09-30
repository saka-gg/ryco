import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageCalendarDate,
  type UsageCostSource,
  type UsageDailyBucket,
  type UsageImportedMetric,
  type UsageSourceCoverage,
  type UsageSummary,
  type UsageTokenTotals,
} from "@ryco/contracts";

export type UsageEnvironmentTerminalStatus =
  | "complete"
  | "partial"
  | "failed"
  | "unavailable"
  | "stale-contract";

export interface UsageEnvironmentResult {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: UsageEnvironmentTerminalStatus;
  readonly summary?: UsageSummary;
  readonly message?: string;
}

export interface MergedUsageSource extends UsageSourceCoverage {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly included: boolean;
  readonly exclusionReason?: "duplicate";
}

export interface MergedUsageBucket extends Omit<UsageDailyBucket, "sourceId"> {
  readonly sourceIds: readonly string[];
  readonly exportSessionIds?: readonly string[];
}

export interface MergedUsageSummary {
  readonly startDate?: UsageCalendarDate;
  readonly endDate: UsageCalendarDate;
  readonly timeZone: string;
  readonly buckets: readonly MergedUsageBucket[];
  readonly imports?: readonly UsageImportedMetric[];
  readonly sources: readonly MergedUsageSource[];
  readonly environments: readonly UsageEnvironmentResult[];
  readonly duplicateSourceCount: number;
  readonly environmentOnlyDeduplicationWarning: boolean;
}

function coverageRank(status: UsageSourceCoverage["status"]): number {
  switch (status) {
    case "complete":
      return 4;
    case "partial":
      return 3;
    case "not-found":
      return 2;
    case "failed":
      return 1;
    case "unsupported":
      return 0;
  }
}

interface SourceCandidate {
  readonly environment: UsageEnvironmentResult & { readonly summary: UsageSummary };
  readonly source: UsageSourceCoverage;
}

function compareSourceCandidates(left: SourceCandidate, right: SourceCandidate): number {
  return (
    coverageRank(right.source.status) - coverageRank(left.source.status) ||
    right.source.scanFinishedAt.localeCompare(left.source.scanFinishedAt) ||
    right.environment.summary.generatedAt.localeCompare(left.environment.summary.generatedAt) ||
    left.environment.environmentId.localeCompare(right.environment.environmentId)
  );
}

function addTokens(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(left.reasoningTokens === undefined || right.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: left.reasoningTokens + right.reasoningTokens }),
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function resolveMergedCostSource(
  sources: ReadonlySet<UsageCostSource>,
  unpricedTokenCount: number,
): UsageCostSource {
  if (sources.size === 0 || (sources.size === 1 && sources.has("unpriced"))) return "unpriced";
  const pricedSources = new Set([...sources].filter((source) => source !== "unpriced"));
  if (unpricedTokenCount > 0 || pricedSources.size !== 1 || sources.has("mixed")) return "mixed";
  return pricedSources.values().next().value ?? "unpriced";
}

interface MutableMergedBucket {
  date: UsageCalendarDate;
  provider: UsageDailyBucket["provider"];
  model: string;
  rawModel?: string;
  tokens: UsageTokenTotals;
  responseCount: number;
  sessionCount: number;
  exportSessionIds: Set<string>;
  estimatedCostUsd: number;
  estimatedCacheSavingsUsd: number;
  hasCost: boolean;
  hasCacheSavings: boolean;
  pricedTokenCount: number;
  unpricedTokenCount: number;
  costSources: Set<UsageCostSource>;
  sourceIds: Set<string>;
}

export function mergeUsageEnvironmentResults(
  environments: readonly UsageEnvironmentResult[],
): MergedUsageSummary | null {
  const usable = environments.filter(
    (environment): environment is UsageEnvironmentResult & { readonly summary: UsageSummary } =>
      environment.summary !== undefined &&
      environment.summary.contractVersion === USAGE_CONTRACT_VERSION &&
      (environment.status === "complete" || environment.status === "partial"),
  );
  if (usable.length === 0) return null;

  const candidates = usable
    .flatMap((environment) =>
      environment.summary.sources.map((source) => ({ environment, source })),
    )
    .toSorted(compareSourceCandidates);
  const physicalClaims = new Set<string>();
  const includedByEnvironmentSource = new Set<string>();
  const mergedSources: MergedUsageSource[] = [];
  let duplicateSourceCount = 0;
  let environmentOnlyDeduplicationWarning = false;

  for (const candidate of candidates) {
    const key = `${candidate.environment.environmentId}\0${candidate.source.sourceId}`;
    const isPhysical = candidate.source.deduplicationKind === "physical";
    const duplicate = isPhysical && physicalClaims.has(candidate.source.sourceId);
    if (isPhysical && !duplicate) physicalClaims.add(candidate.source.sourceId);
    if (candidate.source.deduplicationKind === "environment-only")
      environmentOnlyDeduplicationWarning = true;
    if (!duplicate) includedByEnvironmentSource.add(key);
    else duplicateSourceCount += 1;
    mergedSources.push({
      ...candidate.source,
      environmentId: candidate.environment.environmentId,
      environmentLabel: candidate.environment.label,
      included: !duplicate,
      ...(duplicate ? { exclusionReason: "duplicate" as const } : {}),
    });
  }

  const mutableBuckets = new Map<string, MutableMergedBucket>();
  const exportRecords = new Set<string>();
  for (const environment of [...usable].toSorted((left, right) =>
    right.summary.generatedAt.localeCompare(left.summary.generatedAt),
  )) {
    for (const bucket of environment.summary.buckets) {
      const sourceKey = `${environment.environmentId}\0${bucket.sourceId}`;
      if (!includedByEnvironmentSource.has(sourceKey)) continue;
      if (bucket.provider === "cursor" && bucket.exportRecordId !== undefined) {
        const key = `${bucket.sourceId}\0${bucket.exportRecordId}`;
        if (exportRecords.has(key)) continue;
        exportRecords.add(key);
      }
      const bucketKey = `${bucket.date}\0${bucket.provider}\0${bucket.model}`;
      let merged = mutableBuckets.get(bucketKey);
      if (merged === undefined) {
        merged = {
          date: bucket.date,
          provider: bucket.provider,
          model: bucket.model,
          ...(bucket.rawModel === undefined ? {} : { rawModel: bucket.rawModel }),
          tokens: {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
          },
          responseCount: 0,
          sessionCount: 0,
          exportSessionIds: new Set(),
          estimatedCostUsd: 0,
          estimatedCacheSavingsUsd: 0,
          hasCost: false,
          hasCacheSavings: false,
          pricedTokenCount: 0,
          unpricedTokenCount: 0,
          costSources: new Set(),
          sourceIds: new Set(),
        };
        mutableBuckets.set(bucketKey, merged);
      }
      merged.tokens = addTokens(merged.tokens, bucket.tokens);
      merged.responseCount += bucket.responseCount;
      if (bucket.provider === "cursor" && bucket.exportRecordId !== undefined) {
        if (bucket.exportSessionId !== undefined)
          merged.exportSessionIds.add(`${bucket.sourceId}\0${bucket.exportSessionId}`);
      } else merged.sessionCount += bucket.sessionCount;
      if (bucket.estimatedCostUsd !== undefined) {
        merged.estimatedCostUsd += bucket.estimatedCostUsd;
        merged.hasCost = true;
      }
      if (bucket.estimatedCacheSavingsUsd !== undefined) {
        merged.estimatedCacheSavingsUsd += bucket.estimatedCacheSavingsUsd;
        merged.hasCacheSavings = true;
      }
      merged.pricedTokenCount += bucket.pricedTokenCount;
      merged.unpricedTokenCount += bucket.unpricedTokenCount;
      merged.costSources.add(bucket.costSource);
      merged.sourceIds.add(bucket.sourceId);
    }
  }

  const buckets: MergedUsageBucket[] = [...mutableBuckets.values()]
    .map((bucket): MergedUsageBucket =>
      Object.assign(
        {
          date: bucket.date,
          provider: bucket.provider,
          model: bucket.model,
          tokens: bucket.tokens,
          responseCount: bucket.responseCount,
          sessionCount: bucket.sessionCount + bucket.exportSessionIds.size,
          pricedTokenCount: bucket.pricedTokenCount,
          unpricedTokenCount: bucket.unpricedTokenCount,
          costSource: resolveMergedCostSource(bucket.costSources, bucket.unpricedTokenCount),
          sourceIds: [...bucket.sourceIds].toSorted(),
          ...(bucket.exportSessionIds.size
            ? { exportSessionIds: [...bucket.exportSessionIds] }
            : {}),
        },
        bucket.rawModel === undefined ? {} : { rawModel: bucket.rawModel },
        bucket.hasCost ? { estimatedCostUsd: bucket.estimatedCostUsd } : {},
        bucket.hasCacheSavings ? { estimatedCacheSavingsUsd: bucket.estimatedCacheSavingsUsd } : {},
      ),
    )
    .toSorted(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
    );

  const imports = new Map<string, UsageImportedMetric>();
  // Identical documented events are counted once across copies/overlapping pages.
  // There is no public event ID: changed values form a new fingerprint, with
  // ambiguity disclosed by source coverage. Distinct account scopes stay separate.
  for (const environment of [...usable].toSorted((left, right) =>
    left.summary.generatedAt.localeCompare(right.summary.generatedAt),
  )) {
    const validSources = new Set(
      environment.summary.sources
        .filter((source) => source.provider === "cursor" && source.status === "partial")
        .map((source) => source.sourceId),
    );
    for (const row of environment.summary.imports ?? [])
      if (validSources.has(row.sourceId)) imports.set(`${row.sourceId}\0${row.recordId}`, row);
  }
  const first = usable[0]?.summary;
  if (!first) return null;
  return {
    ...(first.startDate === undefined ? {} : { startDate: first.startDate }),
    endDate: first.endDate,
    timeZone: first.timeZone,
    buckets,
    imports: [...imports.values()],
    sources: mergedSources.toSorted(
      (left, right) =>
        Number(right.included) - Number(left.included) ||
        left.provider.localeCompare(right.provider) ||
        left.environmentLabel.localeCompare(right.environmentLabel),
    ),
    environments,
    duplicateSourceCount,
    environmentOnlyDeduplicationWarning,
  };
}

export class UsageRequestGeneration {
  #current = 0;

  next(): number {
    this.#current += 1;
    return this.#current;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#current;
  }
}
