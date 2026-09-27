import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@ryco/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [
    Key in keyof Omit<ThreadTokenUsageSnapshot, "claudeCache">
  ]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowUsage = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
};

export type ContextWindowSnapshot = ContextWindowUsage & {
  readonly updatedAt: string;
};

export function parseContextWindowTokenLimit(value: string | null | undefined): number | null {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase() ?? "";
  if (!Number.isFinite(amount) || amount <= 0 || (suffix === "" && !Number.isInteger(amount))) {
    return null;
  }

  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const tokens = Math.round(amount * multiplier);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

export function createInitialContextWindowUsage(maxTokens: number | null): ContextWindowUsage {
  const normalizedMaxTokens =
    maxTokens !== null && Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : null;

  return {
    usedTokens: 0,
    totalProcessedTokens: null,
    maxTokens: normalizedMaxTokens,
    remainingTokens: normalizedMaxTokens,
    usedPercentage: normalizedMaxTokens === null ? null : 0,
    remainingPercentage: normalizedMaxTokens === null ? null : 100,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
  };
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const reportedMaxTokens = asFiniteNumber(payload?.maxTokens);
    const maxTokens =
      reportedMaxTokens !== null && Number.isSafeInteger(reportedMaxTokens) && reportedMaxTokens > 0
        ? reportedMaxTokens
        : null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

/**
 * Fill in a missing context-window size from a fallback source (the
 * configured context window or selected model's `maxContextTokens`). Live usage snapshots
 * from some drivers carry no `maxTokens`; without this they'd render as
 * a raw token count even when the model's limit is known. Returns the
 * input untouched when a limit is already present or the fallback is
 * not a positive finite number.
 */
export function withContextWindowLimitFallback(
  usage: ContextWindowUsage,
  fallbackMaxTokens: number | null | undefined,
): ContextWindowUsage {
  if (
    usage.maxTokens !== null ||
    fallbackMaxTokens === null ||
    fallbackMaxTokens === undefined ||
    !Number.isSafeInteger(fallbackMaxTokens) ||
    fallbackMaxTokens <= 0
  ) {
    return usage;
  }
  const usedPercentage = Math.min(100, (usage.usedTokens / fallbackMaxTokens) * 100);
  return {
    ...usage,
    maxTokens: fallbackMaxTokens,
    remainingTokens: Math.max(0, fallbackMaxTokens - usage.usedTokens),
    usedPercentage,
    remainingPercentage: Math.max(0, 100 - usedPercentage),
  };
}

export function deriveContextWindowUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  configuredContextWindow: string | null | undefined,
  modelMaxContextTokens: number | null = null,
): ContextWindowUsage {
  const fallbackMaxTokens =
    parseContextWindowTokenLimit(configuredContextWindow) ?? modelMaxContextTokens;
  return withContextWindowLimitFallback(
    deriveLatestContextWindowSnapshot(activities) ??
      createInitialContextWindowUsage(fallbackMaxTokens),
    fallbackMaxTokens,
  );
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
