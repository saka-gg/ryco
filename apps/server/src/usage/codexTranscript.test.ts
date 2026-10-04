import { describe, expect, it } from "vite-plus/test";

import { initialCodexTranscriptState, parseCodexTranscriptLine } from "./codexTranscript.ts";

const sessionMeta = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-08-01T05:17:41.289Z",
  payload: { type: "session_meta", id: "session-a" },
});
const turnContext = JSON.stringify({
  type: "turn_context",
  timestamp: "2026-08-01T05:17:42.694Z",
  payload: { type: "turn_context", model: "gpt-5.6-sol" },
});

function tokenCount(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  timestamp = "2026-08-01T05:17:49.919Z",
): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          cache_write_input_tokens: 100,
          output_tokens: outputTokens,
          reasoning_output_tokens: reasoningTokens,
        },
      },
    },
  });
}

describe("parseCodexTranscriptLine", () => {
  it("carries session and model context into token deltas", () => {
    const state = initialCodexTranscriptState();
    parseCodexTranscriptLine(sessionMeta, state);
    parseCodexTranscriptLine(turnContext, state);
    const record = parseCodexTranscriptLine(tokenCount(19_239, 11_008, 299, 116), state);

    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("session-a");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 8_131,
      cachedInputTokens: 11_008,
      cacheCreationInputTokens: 100,
      outputTokens: 299,
      reasoningTokens: 116,
      totalTokens: 19_538,
    });
  });

  it("drops repeated token deltas without poisoning pre-context events", () => {
    const state = initialCodexTranscriptState();
    const line = tokenCount(1000, 100, 10, 0);
    expect(parseCodexTranscriptLine(line, state)).toBeNull();
    parseCodexTranscriptLine(turnContext, state);
    expect(parseCodexTranscriptLine(line, state)).not.toBeNull();
    expect(parseCodexTranscriptLine(line, state)).toBeNull();
  });

  it("keeps identical token totals when they belong to distinct turns", () => {
    const state = initialCodexTranscriptState();
    parseCodexTranscriptLine(turnContext, state);
    const line = tokenCount(1000, 100, 10, 0);
    expect(parseCodexTranscriptLine(line, state)).not.toBeNull();
    parseCodexTranscriptLine(turnContext, state);
    expect(parseCodexTranscriptLine(line, state)).not.toBeNull();
  });

  it("keeps the child session id when a rollout repeats ancestor metadata", () => {
    const state = initialCodexTranscriptState();
    parseCodexTranscriptLine(sessionMeta, state);
    parseCodexTranscriptLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-01T05:17:41.290Z",
        payload: { type: "session_meta", id: "parent-session" },
      }),
      state,
    );
    expect(state.sessionId).toBe("session-a");
  });

  it("suppresses a fork's re-stamped history and accepts its first real turn", () => {
    const state = initialCodexTranscriptState();
    parseCodexTranscriptLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-01T05:00:00.000Z",
        payload: { type: "session_meta", id: "child", forked_from_id: "parent" },
      }),
      state,
    );
    parseCodexTranscriptLine(turnContext, state);

    expect(
      parseCodexTranscriptLine(tokenCount(1000, 100, 10, 0, "2026-08-01T05:00:00.010Z"), state),
    ).toBeNull();
    expect(
      parseCodexTranscriptLine(tokenCount(2000, 200, 20, 0, "2026-08-01T05:00:00.020Z"), state),
    ).toBeNull();
    expect(
      parseCodexTranscriptLine(tokenCount(3000, 300, 30, 0, "2026-08-01T05:00:06.000Z"), state),
    ).not.toBeNull();
    expect(
      parseCodexTranscriptLine(tokenCount(4000, 400, 40, 0, "2026-08-01T05:00:06.100Z"), state),
    ).not.toBeNull();
  });

  it("recognizes subagent rollouts as forks", () => {
    const state = initialCodexTranscriptState();
    parseCodexTranscriptLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-01T05:00:00.000Z",
        payload: {
          type: "session_meta",
          id: "child",
          source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
        },
      }),
      state,
    );
    parseCodexTranscriptLine(turnContext, state);
    expect(
      parseCodexTranscriptLine(tokenCount(1000, 100, 10, 0, "2026-08-01T05:00:00.010Z"), state),
    ).toBeNull();
  });
});

it("carries billing speed across requests and resets it when default settings are applied", () => {
  const state = initialCodexTranscriptState();
  parseCodexTranscriptLine(turnContext, state);
  for (const [tier, speed] of [
    ["priority", "fast"],
    ["ultrafast", "ultrafast"],
    ["default", "standard"],
  ]) {
    parseCodexTranscriptLine(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } },
      }),
      state,
    );
    parseCodexTranscriptLine(turnContext, state);
    expect(parseCodexTranscriptLine(tokenCount(1000, 100, 10, 0), state)?.speed).toBe(speed);
  }
});
