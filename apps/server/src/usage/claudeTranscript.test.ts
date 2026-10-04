import { describe, expect, it } from "vite-plus/test";

import { parseClaudeTranscriptLine } from "./claudeTranscript.ts";

function claudeLine(
  overrides: {
    readonly messageId?: string;
    readonly requestId?: string;
    readonly contentType?: string;
    readonly model?: string;
    readonly outputTokens?: number;
  } = {},
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "session-a",
    ...(overrides.requestId === undefined ? {} : { requestId: overrides.requestId }),
    message: {
      ...(overrides.messageId === undefined ? {} : { id: overrides.messageId }),
      role: "assistant",
      model: overrides.model ?? "claude-sonnet-4-5-20250929",
      content: [{ type: overrides.contentType ?? "text" }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
      },
    },
  });
}

describe("parseClaudeTranscriptLine", () => {
  it("extracts the complete token mix without double-counting output", () => {
    const record = parseClaudeTranscriptLine(claudeLine({ messageId: "msg_1" }));

    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationInputTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
      totalTokens: 68106,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
  });

  it("uses message and request identity across repeated content blocks", () => {
    const text = parseClaudeTranscriptLine(
      claudeLine({ messageId: "msg_2", requestId: "req_2", contentType: "text" }),
    );
    const toolUse = parseClaudeTranscriptLine(
      claudeLine({ messageId: "msg_2", requestId: "req_2", contentType: "tool_use" }),
    );

    expect(text?.dedupeKey).toBe("msg_2:req_2");
    expect(toolUse?.dedupeKey).toBe(text?.dedupeKey);
  });

  it("uses stable non-content metadata when provider response IDs are absent", () => {
    const first = parseClaudeTranscriptLine(claudeLine())?.dedupeKey;
    const second = parseClaudeTranscriptLine(claudeLine())?.dedupeKey;
    expect(first).toMatch(/^fallback:/);
    expect(second).toBe(first);
  });

  it("ignores malformed, non-assistant, and zero-token records", () => {
    expect(parseClaudeTranscriptLine("not-json")).toBeNull();
    expect(parseClaudeTranscriptLine(JSON.stringify({ type: "user" }))).toBeNull();
    expect(
      parseClaudeTranscriptLine(
        claudeLine({ messageId: "zero", outputTokens: 0 })
          .replace('"input_tokens":2', '"input_tokens":0')
          .replace('"cache_creation_input_tokens":66818', '"cache_creation_input_tokens":0')
          .replace('"cache_read_input_tokens":1000', '"cache_read_input_tokens":0'),
      ),
    ).toBeNull();
  });
});

it("retains Claude's recorded fast billing speed", () => {
  const parsed = JSON.parse(claudeLine());
  parsed.message.usage.speed = "fast";
  expect(parseClaudeTranscriptLine(JSON.stringify(parsed))?.speed).toBe("fast");
});
