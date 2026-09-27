import { describe, expect, it } from "vitest";
import { ProviderInstanceId, RuntimeSessionId } from "@ryco/contracts";
import { observeClaudeCache, readClaudeCacheCounts } from "./claudeCacheObservation.ts";

const input = {
  usage: {
    input_tokens: 12,
    cache_read_input_tokens: 40_000,
    cache_creation_input_tokens: 3_000,
    output_tokens: 1,
  },
  messageId: "request-1",
  model: "claude-sonnet-4-6",
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  observedAt: "2026-09-27T10:00:00.000Z",
};
describe("Claude cache evidence", () => {
  it("keeps direct input, reads, writes separate and does not count placeholder request output", () => {
    expect(observeClaudeCache(input)).toEqual({
      source: "assistant-usage",
      observedAt: input.observedAt,
      runtimeSessionId: input.runtimeSessionId,
      providerInstanceId: input.providerInstanceId,
      messageId: input.messageId,
      model: input.model,
      directInputTokens: 12,
      cacheReadInputTokens: 40_000,
      cacheWriteInputTokens: 3_000,
    });
  });
  it("does not refresh duplicate requests or invent TTL for cache reads", () => {
    const previous = observeClaudeCache(input)!;
    expect(observeClaudeCache({ ...input, observedAt: "2026-09-27T11:00:00.000Z", previous })).toBe(
      previous,
    );
    expect(previous.observedTtlSeconds).toBeUndefined();
  });
  it("uses only a duration explicitly reported for this write", () => {
    const previous = observeClaudeCache({
      ...input,
      usage: {
        ...input.usage,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
      },
    })!;
    expect(previous.observedTtlSeconds).toBe(300);
    expect(
      observeClaudeCache({ ...input, messageId: "request-2", previous })?.observedTtlSeconds,
    ).toBeUndefined();
  });
  it.each([
    undefined,
    {},
    { input_tokens: -1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { ...input.usage, input_tokens: NaN },
  ])("keeps unavailable or malformed counts unknown", (usage) => {
    expect(readClaudeCacheCounts(usage)).toBeUndefined();
    expect(observeClaudeCache({ ...input, usage })).toBeUndefined();
  });
  it("keeps result output separate and permits observed zeros", () => {
    expect(
      readClaudeCacheCounts({
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 900,
      }),
    ).toEqual({
      directInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 900,
    });
  });
});
