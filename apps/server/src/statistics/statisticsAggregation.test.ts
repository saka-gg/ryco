import { ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computeStatisticsThreadPartial,
  normalizeStatisticsThreadPartial,
  type StatisticsThreadMeta,
} from "./statisticsAggregation.ts";

const meta: StatisticsThreadMeta = {
  projectId: ProjectId.make("project-1"),
  model: "claude-opus-5-5",
  provider: "claudeAgent",
  createdAt: "2026-11-09T00:00:00.000Z",
};

function turnUsage(turnId: string, speed: "fast" | undefined, cacheWrites: number) {
  return {
    threadId: "thread",
    turnId,
    sequence: 1,
    createdAt: "2026-11-09T10:00:00.000Z",
    payloadJson: JSON.stringify({
      usedTokens: 100,
      statisticsModel: "claude-opus-5-5",
      ...(speed ? { statisticsSpeed: speed } : {}),
      processedUsage: {
        scope: "turn",
        inputTokens: 1000,
        cachedInputTokens: 500,
        cacheWriteInputTokens: cacheWrites,
        outputTokens: 50,
        reasoningOutputTokens: 0,
        totalTokens: 1050,
      },
    }),
  };
}

describe("computeStatisticsThreadPartial", () => {
  it("buckets fast usage apart and sums cache writes", () => {
    const partial = computeStatisticsThreadPartial(meta, {
      tokens: [turnUsage("a", undefined, 100), turnUsage("b", "fast", 300)],
      turns: [],
      tools: [],
    });
    const tokens = partial.buckets.map((bucket) => ({
      speed: bucket.speed,
      inputTokens: bucket.inputTokens,
      cacheWriteInputTokens: bucket.cacheWriteInputTokens,
    }));
    expect(tokens).toEqual([
      { speed: undefined, inputTokens: 1000, cacheWriteInputTokens: 100 },
      { speed: "fast", inputTokens: 1000, cacheWriteInputTokens: 300 },
    ]);
    expect(partial.buckets[0]).not.toHaveProperty("speed");
  });

  it("restores a stored partial's speed and cache writes", () => {
    const partial = computeStatisticsThreadPartial(meta, {
      tokens: [turnUsage("b", "fast", 300)],
      turns: [],
      tools: [],
    });
    const restored = normalizeStatisticsThreadPartial(JSON.parse(JSON.stringify(partial)));
    expect(restored?.buckets).toEqual(partial.buckets);
  });
});
