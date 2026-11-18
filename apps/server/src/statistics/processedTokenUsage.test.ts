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
  it("adds up the CLI segments of one Claude turn and ignores its gauge-only totals", () => {
    const segment = (requestId: string, input: number, output: number) => ({
      usedTokens: 100,
      processedUsage: {
        scope: "request",
        requestId,
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0,
        totalTokens: input + output,
      },
    });
    const result = collectProcessedTokenUsage(
      [
        // A historical-looking gauge (a total without counters) in a turn with exact counters.
        row(0, { usedTokens: 100, totalProcessedTokens: 9000 }),
        row(1, segment("result-prompt", 1000, 10)),
        // The steer's segment, then a gauge-only snapshot (the compaction's result) after it.
        row(2, segment("result-steer", 2000, 20)),
        row(3, { usedTokens: 100, totalProcessedTokens: 9000 }),
        // A turn with only the historical total keeps it as an approximation.
        row(4, { usedTokens: 100, totalProcessedTokens: 500 }, "turn-legacy"),
      ],
      () => "claudeAgent",
    );
    expect(
      result.entries.map((entry) => [entry.row.turnId, entry.totalTokens, entry.approximate]),
    ).toEqual([
      ["turn-legacy", 500, true],
      ["turn-a", 1010, false],
      ["turn-a", 2020, false],
    ]);
    expect([...result.turns].toSorted()).toEqual(["thread\0turn-a", "thread\0turn-legacy"]);
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

it("carries a turn's cache writes and the speed ingestion stamped", () => {
  const result = collectProcessedTokenUsage(
    [
      row(0, {
        usedTokens: 100,
        statisticsSpeed: "fast",
        processedUsage: {
          scope: "turn",
          inputTokens: 900,
          cachedInputTokens: 600,
          cacheWriteInputTokens: 250,
          outputTokens: 100,
          reasoningOutputTokens: 0,
          totalTokens: 1000,
        },
      }),
      row(
        1,
        { usedTokens: 100, statisticsSpeed: "turbo", processedUsage: session(500).processedUsage },
        "turn-b",
      ),
    ],
    () => "claudeAgent",
  );
  // Session deltas come first, final turn counters after them.
  expect(result.entries.map((entry) => [entry.cacheWriteInputTokens, entry.speed])).toEqual([
    [0, undefined],
    [250, "fast"],
  ]);
});
