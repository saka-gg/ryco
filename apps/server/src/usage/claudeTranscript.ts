import type { UsageRecord } from "./usageRecord.ts";
import { parseTimestampMs, positiveInteger, withTokenTotal } from "./usageRecord.ts";

/** Parse one JSONL record written by Claude Code. */
export function parseClaudeTranscriptLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  const model = messageRecord["model"];
  if (timestampMs === null || typeof model !== "string" || model.length === 0) return null;

  const reportedCost = record["costUSD"];

  const totals = withTokenTotal({
    uncachedInputTokens: positiveInteger(usageRecord["input_tokens"]),
    cachedInputTokens: positiveInteger(usageRecord["cache_read_input_tokens"]),
    cacheCreationInputTokens: positiveInteger(usageRecord["cache_creation_input_tokens"]),
    outputTokens: positiveInteger(usageRecord["output_tokens"]),
    // Claude includes extended thinking in output and does not split it out.
    reasoningTokens: 0,
  });
  if (totals.totalTokens === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const eventId = typeof record["uuid"] === "string" ? record["uuid"] : null;
  const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : "";
  const dedupeKey =
    messageId !== null || requestId !== null
      ? `${messageId ?? ""}:${requestId ?? ""}`
      : eventId !== null
        ? `event:${eventId}`
        : `fallback:${sessionId}:${timestampMs}:${model}:${totals.uncachedInputTokens}:${totals.cachedInputTokens}:${totals.cacheCreationInputTokens}:${totals.outputTokens}`;

  return {
    provider: "claude",
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd:
      typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0
        ? reportedCost
        : null,
    dedupeKey,
  };
}
