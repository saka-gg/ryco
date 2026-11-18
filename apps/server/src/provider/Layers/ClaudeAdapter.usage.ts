/**
 * Claude token and context-window math: SDK usage to canonical usage snapshots.
 */
import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadTokenUsageSnapshot, RuntimeTaskUsage } from "@ryco/contracts";
import { Effect } from "effect";

import { readClaudeCacheCounts } from "../claudeCacheObservation.ts";
import { selectClaudeResultUsageGauge } from "../claudeContextUsage.ts";
import { nowIso } from "./ClaudeAdapter.session.ts";
import type { ClaudeSessionContext } from "./ClaudeAdapter.types.ts";

export function mainClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
  mainModel?: string,
): number | undefined {
  if (!modelUsage) return undefined;
  // modelUsage includes subagents. A child's larger budget is not the parent's.
  const usage = mainModel
    ? modelUsage[mainModel]
    : Object.keys(modelUsage).length === 1
      ? Object.values(modelUsage)[0]
      : undefined;
  const window = usage?.contextWindow;
  return typeof window === "number" && Number.isSafeInteger(window) && window > 0
    ? window
    : undefined;
}

export function normalizeClaudeTokenUsage(
  value: unknown,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const directInputTokens =
    typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : 0;
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0;
  const cachedInputTokens =
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0;
  const inputTokens = directInputTokens + cacheCreationInputTokens + cachedInputTokens;
  const outputTokens =
    typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : 0;
  const derivedTotalProcessedTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined) ?? (derivedTotalProcessedTokens > 0 ? derivedTotalProcessedTokens : undefined);
  if (totalProcessedTokens === undefined || totalProcessedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  const usedTokens =
    maxTokens !== undefined ? Math.min(totalProcessedTokens, maxTokens) : totalProcessedTokens;

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof usage.tool_uses === "number" && Number.isFinite(usage.tool_uses)
      ? { toolUses: usage.tool_uses }
      : {}),
    ...(typeof usage.duration_ms === "number" && Number.isFinite(usage.duration_ms)
      ? { durationMs: usage.duration_ms }
      : {}),
  };
}

export function withAutomaticCompactionCapability(
  usage: ThreadTokenUsageSnapshot,
  supported: boolean,
): ThreadTokenUsageSnapshot {
  return supported ? { ...usage, compactsAutomatically: true } : usage;
}

export function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * SDK task usage ({total_tokens, tool_uses, duration_ms}, sometimes with
 * input/output/cache breakdowns) → the typed contract shape. Unknown or
 * malformed input yields undefined rather than a partial guess.
 */
export function normalizeTaskUsage(usage: unknown): RuntimeTaskUsage | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const totalTokens = nonNegativeInt(record.total_tokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const inputTokens = nonNegativeInt(record.input_tokens);
  const cachedInputTokens = nonNegativeInt(record.cache_read_input_tokens);
  const cacheWriteInputTokens = nonNegativeInt(record.cache_creation_input_tokens);
  const outputTokens = nonNegativeInt(record.output_tokens);
  const toolUses = nonNegativeInt(record.tool_uses);
  const durationMs = nonNegativeInt(record.duration_ms);
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens, directInputTokens: inputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** The cache writes a Claude usage record reports (already counted in its input). */
export function claudeCacheWriteInputTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const value = (usage as Record<string, unknown>).cache_creation_input_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * What a result's processed usage counts. Claude Code starts `result.usage` from zero for every
 * prompt it runs, so it covers only the CLI segment that result closes, and only main-loop calls
 * (`modelUsage` is the session-cumulative, all-calls figure). In the pinned CLI, `query()`'s
 * per-prompt run starts its usage at the empty usage and adds each main-loop message's usage at
 * `message_stop`; the SDK types call it "per-turn in streaming-input sessions"; a capture against
 * a fake endpoint showed a `/compact` result with zero usage and a steer's segment with only its
 * own calls (the opt-in probe in claudeCompactionCliProbe.test.ts re-checks this). One Ryco turn
 * spans several segments when a steer runs as its own CLI turn or the turn compacts before it
 * closes, so each segment is its own request, keyed by the result's uuid, and Statistics adds
 * them up. A result without a uuid (older producers) stays a turn total.
 */
export function claudeResultProcessedUsageIdentity(
  result: SDKResultMessage | undefined,
): { readonly scope: "request"; readonly requestId: string } | { readonly scope: "turn" } {
  const uuid: unknown = result?.uuid;
  const requestId = typeof uuid === "string" ? uuid.trim() : "";
  return requestId.length > 0 ? { scope: "request", requestId } : { scope: "turn" };
}

/** The context gauge a result (or a local close without one) publishes. */
export const resolveResultUsageSnapshot = Effect.fn("resolveResultUsageSnapshot")(function* (
  context: ClaudeSessionContext,
  result: SDKResultMessage | undefined,
) {
  const resultCounts = readClaudeCacheCounts(result?.usage);
  if (context.cacheObservation && resultCounts?.outputTokens !== undefined) {
    context.cacheObservation = {
      ...context.cacheObservation,
      mainLoopTotals: {
        source: "result-usage",
        observedAt: yield* nowIso,
        ...resultCounts,
        outputTokens: resultCounts.outputTokens,
      },
    };
  }
  const resultContextWindow = mainClaudeContextWindowFromModelUsage(
    result?.modelUsage,
    context.cacheObservation?.model ?? context.currentApiModelId,
  );
  if (resultContextWindow !== undefined) {
    context.lastKnownContextWindow = resultContextWindow;
  }

  // result.usage sums the main-loop API calls of the CLI segment this result closes
  // (see claudeResultProcessedUsageIdentity). It does NOT represent the current context
  // window size. Prefer the last main-loop request gauge (legacy main-task telemetry is
  // a fallback) and keep the segment's sum separate as totalProcessedTokens.
  const accumulatedSnapshot = normalizeClaudeTokenUsage(
    result?.usage,
    resultContextWindow ?? context.lastKnownContextWindow,
  );
  const rawUsageSnapshot = selectClaudeResultUsageGauge({
    lastGauge: context.lastKnownTokenUsage,
    cumulative: accumulatedSnapshot,
    maxTokens: resultContextWindow ?? context.lastKnownContextWindow,
    cumulativeIsGauge: !context.cumulativeUsageSpansCompaction,
  });
  // Only a real result consumes the boundary: a local close must not re-enable the
  // cumulative fallback for the CLI's late result of the same turn.
  if (result !== undefined) context.cumulativeUsageSpansCompaction = false;
  return rawUsageSnapshot
    ? withAutomaticCompactionCapability(
        {
          ...rawUsageSnapshot,
          ...(accumulatedSnapshot
            ? {
                processedUsage: {
                  ...claudeResultProcessedUsageIdentity(result),
                  inputTokens: accumulatedSnapshot.inputTokens ?? 0,
                  cachedInputTokens: accumulatedSnapshot.cachedInputTokens ?? 0,
                  cacheWriteInputTokens: claudeCacheWriteInputTokens(result?.usage),
                  outputTokens: accumulatedSnapshot.outputTokens ?? 0,
                  reasoningOutputTokens: accumulatedSnapshot.reasoningOutputTokens ?? 0,
                  totalTokens:
                    accumulatedSnapshot.totalProcessedTokens ?? accumulatedSnapshot.usedTokens,
                },
              }
            : {}),
          ...(context.cacheObservation ? { claudeCache: context.cacheObservation } : {}),
        },
        context.supportsAutomaticCompaction,
      )
    : undefined;
});
