export interface TokenActivity {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly sequence: number | null;
  readonly createdAt: string;
  readonly payloadJson: string;
}

interface Counters {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export interface ProcessedUsageEntry extends Counters {
  readonly row: TokenActivity;
  readonly provider?: string;
  readonly model?: string;
  readonly approximate: boolean;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read billing counters without mistaking the last request for a whole turn. */
export function collectProcessedTokenUsage(
  rows: readonly TokenActivity[],
  providerForThread: (threadId: string) => string | undefined,
) {
  const entries: ProcessedUsageEntry[] = [];
  const sessionThreads = new Set<string>();
  const turns = new Set<string>();
  const firstSessionIds = new Map<string, string>();
  const sessions = new Map<string, Counters & { exact: boolean }>();
  const finalRequests = new Map<string, ProcessedUsageEntry>();
  const finalTurns = new Map<string, ProcessedUsageEntry>();
  const parsed = rows.map((row) => {
    try {
      return { row, payload: object(JSON.parse(row.payloadJson)) };
    } catch {
      return { row, payload: undefined };
    }
  });
  // Legacy Codex snapshots retained the session total but only the last request's split.
  for (const { row, payload } of parsed) {
    const provider = payload?.statisticsProvider ?? providerForThread(row.threadId);
    const processed = object(payload?.processedUsage);
    if (
      processed?.scope === "session" &&
      typeof processed.sessionId === "string" &&
      !firstSessionIds.has(row.threadId)
    ) {
      firstSessionIds.set(row.threadId, processed.sessionId);
    }
    if (
      processed?.scope === "session" ||
      (provider === "codex" && count(payload?.totalProcessedTokens) > 0)
    ) {
      sessionThreads.add(row.threadId);
    }
  }
  for (const { row, payload } of parsed) {
    if (!payload) continue;
    const processed = object(payload.processedUsage);
    const providerValue = payload.statisticsProvider ?? providerForThread(row.threadId);
    const provider = typeof providerValue === "string" ? providerValue : undefined;
    const model = typeof payload.statisticsModel === "string" ? payload.statisticsModel : undefined;
    const modelFields = model ? { model } : {};
    const turnKey = `${row.threadId}\0${row.turnId ?? ""}`;
    if (
      processed?.scope === "turn" ||
      (processed?.scope === "request" && typeof processed.requestId === "string")
    ) {
      const entry: ProcessedUsageEntry = {
        row,
        ...modelFields,
        ...(provider ? { provider } : {}),
        approximate: false,
        inputTokens: count(processed.inputTokens),
        cachedInputTokens: count(processed.cachedInputTokens),
        outputTokens: count(processed.outputTokens),
        reasoningTokens: count(processed.reasoningOutputTokens),
        totalTokens: count(processed.totalTokens),
      };
      if (processed.scope === "request")
        finalRequests.set(`${row.threadId}\0${processed.requestId}`, entry);
      else finalTurns.set(turnKey, entry);
      turns.add(turnKey);
      continue;
    }
    if (
      sessionThreads.has(row.threadId) &&
      (provider === "codex" || processed?.scope === "session")
    ) {
      const sessionKey = `${row.threadId}\0${processed?.sessionId ?? firstSessionIds.get(row.threadId) ?? ""}`;
      const previous = sessions.get(sessionKey);
      const totalTokens =
        processed?.scope === "session"
          ? count(processed.totalTokens)
          : count(payload.totalProcessedTokens) ||
            count(payload.lastUsedTokens) ||
            count(payload.usedTokens);
      if (totalTokens === 0 || totalTokens === previous?.totalTokens) continue;
      const reset = previous === undefined || totalTokens < previous.totalTokens;
      const delta = reset ? totalTokens : totalTokens - previous.totalTokens;
      const cumulative: Counters = {
        inputTokens: count(processed?.inputTokens),
        cachedInputTokens: count(processed?.cachedInputTokens),
        outputTokens: count(processed?.outputTokens),
        reasoningTokens: count(processed?.reasoningOutputTokens),
        totalTokens,
      };
      const exact = processed?.scope === "session" && (reset || previous.exact);
      entries.push({
        row,
        ...modelFields,
        ...(provider ? { provider } : {}),
        approximate: !exact,
        inputTokens: exact
          ? Math.max(0, cumulative.inputTokens - (reset ? 0 : previous.inputTokens))
          : count(payload.lastInputTokens ?? payload.inputTokens),
        cachedInputTokens: exact
          ? Math.max(0, cumulative.cachedInputTokens - (reset ? 0 : previous.cachedInputTokens))
          : count(payload.lastCachedInputTokens ?? payload.cachedInputTokens),
        outputTokens: exact
          ? Math.max(0, cumulative.outputTokens - (reset ? 0 : previous.outputTokens))
          : count(payload.lastOutputTokens ?? payload.outputTokens),
        reasoningTokens: exact
          ? Math.max(0, cumulative.reasoningTokens - (reset ? 0 : previous.reasoningTokens))
          : count(payload.lastReasoningOutputTokens ?? payload.reasoningOutputTokens),
        totalTokens: delta,
      });
      sessions.set(sessionKey, { ...cumulative, exact: processed?.scope === "session" });
    } else if (provider === "claudeAgent" && count(payload.totalProcessedTokens) > 0) {
      // Historical Claude result snapshots contain a turn total even when the
      // context gauge replaced its split. Keep that total, mark attribution approximate.
      finalTurns.set(turnKey, {
        row,
        ...modelFields,
        provider,
        approximate: true,
        totalTokens: count(payload.totalProcessedTokens),
        inputTokens: count(payload.inputTokens),
        cachedInputTokens: count(payload.cachedInputTokens),
        outputTokens: count(payload.outputTokens),
        reasoningTokens: count(payload.reasoningOutputTokens),
      });
      turns.add(turnKey);
    }
  }
  entries.push(...finalTurns.values(), ...finalRequests.values());
  return { entries, sessionThreads, turns };
}
