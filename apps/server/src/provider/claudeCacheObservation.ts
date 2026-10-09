import type {
  ClaudeCacheObservation,
  ModelSelection,
  ProviderInstanceId,
  RuntimeSessionId,
} from "@ryco/contracts";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function readClaudeCacheCounts(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  if (
    !count(usage.input_tokens) ||
    !count(usage.cache_read_input_tokens) ||
    !count(usage.cache_creation_input_tokens)
  )
    return undefined;
  return {
    directInputTokens: usage.input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    cacheWriteInputTokens: usage.cache_creation_input_tokens,
    ...(count(usage.output_tokens) ? { outputTokens: usage.output_tokens } : {}),
  };
}

/** A single bounded observation; duplicate snapshots do not refresh its timestamp. */
export function observeClaudeCache(input: {
  usage: unknown;
  messageId: string;
  model: string;
  modelSelection?: ModelSelection;
  /** The runtime's working directory, where Claude keeps this native conversation. */
  cwd?: string;
  runtimeSessionId: RuntimeSessionId;
  providerInstanceId: ProviderInstanceId;
  observedAt: string;
  previous?: ClaudeCacheObservation;
}): ClaudeCacheObservation | undefined {
  const counts = readClaudeCacheCounts(input.usage);
  if (!counts || !input.messageId || !input.model) return input.previous;
  if (
    input.previous?.messageId === input.messageId &&
    input.previous.runtimeSessionId === input.runtimeSessionId
  )
    return input.previous;
  const raw = input.usage as Record<string, unknown>;
  const creation = raw.cache_creation as Record<string, unknown> | undefined;
  const ttl =
    creation && typeof creation === "object"
      ? count(creation.ephemeral_5m_input_tokens) && creation.ephemeral_5m_input_tokens > 0
        ? 300
        : count(creation.ephemeral_1h_input_tokens) && creation.ephemeral_1h_input_tokens > 0
          ? 3600
          : undefined
      : undefined;
  return {
    source: "assistant-usage",
    observedAt: input.observedAt,
    runtimeSessionId: input.runtimeSessionId,
    providerInstanceId: input.providerInstanceId,
    model: input.model,
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    messageId: input.messageId,
    directInputTokens: counts.directInputTokens,
    cacheReadInputTokens: counts.cacheReadInputTokens,
    cacheWriteInputTokens: counts.cacheWriteInputTokens,
    ...(ttl ? { observedTtlSeconds: ttl } : {}),
  };
}
