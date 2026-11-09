import { createInitialContextWindowUsage } from "@ryco/client-runtime/state/session/contextWindow";
import { describe, expect, it } from "vite-plus/test";

import { summarizeContextWindow } from "./contextWindowSummary";

describe("context window summary", () => {
  it("is absent until the provider reported usage", () => {
    expect(summarizeContextWindow(createInitialContextWindowUsage(200_000))).toBeNull();
  });

  it("reads the share used against the limit, and the conversation's total", () => {
    const usage = {
      ...createInitialContextWindowUsage(200_000),
      usedTokens: 84_000,
      maxTokens: 200_000,
      usedPercentage: 42,
      remainingPercentage: 58,
      remainingTokens: 116_000,
      totalProcessedTokens: 1_250_000,
      compactsAutomatically: true,
    };
    expect(summarizeContextWindow(usage)).toEqual({
      label: "42% used",
      detail: "84k of 200k",
      fraction: 0.42,
      compactsAutomatically: true,
      totalProcessed: "1.3m processed",
    });
  });

  it("counts tokens when the limit is unknown", () => {
    const usage = { ...createInitialContextWindowUsage(null), usedTokens: 12_300 };
    expect(summarizeContextWindow(usage)).toMatchObject({
      label: "12k tokens used",
      detail: null,
      fraction: null,
    });
  });
});
