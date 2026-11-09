import { describe, expect, it } from "vite-plus/test";

import { formatEstimatedUsd, formatModelLabel } from "./statisticsFormat";

describe("formatEstimatedUsd", () => {
  it("formats across thresholds", () => {
    expect(formatEstimatedUsd(0)).toBe("$0.00");
    expect(formatEstimatedUsd(0.004)).toBe("<$0.01");
    expect(formatEstimatedUsd(12.5)).toBe("$12.50");
    expect(formatEstimatedUsd(2500)).toBe("$2,500");
  });
});

describe("formatModelLabel", () => {
  it("renders default + common models correctly (gpt-5.4 mislabel regression)", () => {
    expect(formatModelLabel("gpt-5.4")).toBe("GPT 5.4");
    expect(formatModelLabel("gpt-5.4-mini")).toBe("GPT 5.4 Mini");
    expect(formatModelLabel("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(formatModelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
    expect(formatModelLabel("composer-2")).toBe("Composer 2");
    expect(formatModelLabel("composer-1")).toBe("Composer 1");
  });

  it("drops a provider prefix", () => {
    expect(formatModelLabel("openai/gpt-5")).toBe("GPT 5");
  });
});
