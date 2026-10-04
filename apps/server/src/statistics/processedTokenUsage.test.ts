import { describe, expect, it } from "vite-plus/test";
import { collectProcessedTokenUsage, type TokenActivity } from "./processedTokenUsage.ts";

function row(index: number, payload: object, turnId = "turn-a"): TokenActivity {
  return {
    threadId: "thread",
    turnId,
    sequence: index,
    createdAt: `2026-06-10T00:00:0${index}.000Z`,
    payloadJson: JSON.stringify(payload),
  };
}
function session(total: number, sessionId = "provider-thread") {
  return {
    usedTokens: 100,
    processedUsage: {
      scope: "session",
      sessionId,
      inputTokens: total - 100,
      cachedInputTokens: total - 200,
      outputTokens: 100,
      reasoningOutputTokens: 10,
      totalTokens: total,
    },
  };
}
describe("processed token counters", () => {
  it("differences cumulative requests and ignores duplicate notifications", () => {
    const result = collectProcessedTokenUsage(
      [row(0, session(1000)), row(1, session(3000)), row(2, session(3000))],
      () => "codex",
    );
    expect(result.entries.map((entry) => entry.totalTokens)).toEqual([1000, 2000]);
    expect(result.entries.reduce((n, entry) => n + entry.inputTokens, 0)).toBe(2900);
    expect(result.entries.reduce((n, entry) => n + entry.outputTokens, 0)).toBe(100);
  });
  it("handles counter resets and new provider sessions without losing subsequent work", () => {
    const result = collectProcessedTokenUsage(
      [
        row(0, session(3000)),
        row(1, session(1000)),
        row(2, session(1000, "new-session")),
        row(3, session(2000, "new-session")),
      ],
      () => "codex",
    );
    expect(result.entries.map((entry) => entry.totalTokens)).toEqual([3000, 1000, 1000, 1000]);
  });
  it("does not count old cumulative totals again when exact counters become available", () => {
    const result = collectProcessedTokenUsage(
      [row(0, { usedTokens: 100, totalProcessedTokens: 1000 }), row(1, session(3000))],
      () => "codex",
    );
    expect(result.entries.map((entry) => entry.totalTokens)).toEqual([1000, 2000]);
    expect(result.entries.every((entry) => entry.approximate)).toBe(true);
  });
  it("counts the final processed snapshot of each Claude turn independently of its context", () => {
    const turn = (total: number) => ({
      usedTokens: 100,
      processedUsage: { ...session(total).processedUsage, scope: "turn" },
    });
    const result = collectProcessedTokenUsage(
      [
        row(0, turn(1000)),
        row(1, turn(3000)),
        row(2, { usedTokens: 100 }),
        row(3, turn(2000), "turn-b"),
      ],
      () => "claudeAgent",
    );
    expect(result.entries.map((entry) => entry.totalTokens)).toEqual([3000, 2000]);
  });
  it("keeps malformed and legacy gauge-only payloads for the existing fallback", () => {
    const result = collectProcessedTokenUsage(
      [row(0, { usedTokens: 100 }), { ...row(1, {}), payloadJson: "invalid" }],
      () => "claudeAgent",
    );
    expect(result.entries).toEqual([]);
    expect(result.turns.size).toBe(0);
  });
});

it("counts OpenCode requests separately and replaces repeated snapshots of one request", () => {
  const request = (requestId: string, total: number) => ({
    processedUsage: {
      scope: "request",
      requestId,
      inputTokens: total - 100,
      cachedInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 10,
      totalTokens: total,
    },
  });
  const result = collectProcessedTokenUsage(
    [
      row(0, request("message-a", 1000)),
      row(1, request("message-a", 1500)),
      row(2, request("message-b", 3000)),
    ],
    () => "opencode",
  );
  expect(result.entries.map((entry) => entry.totalTokens)).toEqual([1500, 3000]);
  expect(result.entries.reduce((n, entry) => n + entry.outputTokens, 0)).toBe(200);
});
