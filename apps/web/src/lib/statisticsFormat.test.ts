import { describe, expect, it } from "vite-plus/test";

import { formatEstimatedUsd, formatModelLabel, formatUsdAxisTick } from "./statisticsFormat";

describe("formatEstimatedUsd", () => {
  it("formats across thresholds", () => {
    expect(formatEstimatedUsd(0)).toBe("$0.00");
    expect(formatEstimatedUsd(0.004)).toBe("<$0.01");
    expect(formatEstimatedUsd(12.5)).toBe("$12.50");
    expect(formatEstimatedUsd(2500)).toBe("$2,500");
  });
});

describe("formatUsdAxisTick", () => {
  const labels = (ticks: number[]) => ticks.map((tick) => formatUsdAxisTick(tick, ticks));

  it("gives every tick the decimals the axis's step needs", () => {
    expect(labels([0, 0.01, 0.02, 0.03, 0.04])).toEqual([
      "$0.00",
      "$0.01",
      "$0.02",
      "$0.03",
      "$0.04",
    ]);
    expect(labels([0, 0.25, 0.5, 0.75, 1])).toEqual(["$0.00", "$0.25", "$0.50", "$0.75", "$1.00"]);
    expect(labels([0, 0.095, 0.19, 0.285, 0.38])).toEqual([
      "$0.000",
      "$0.095",
      "$0.190",
      "$0.285",
      "$0.380",
    ]);
    expect(labels([0, 2.5, 5, 7.5, 10])).toEqual(["$0.0", "$2.5", "$5.0", "$7.5", "$10.0"]);
    expect(labels([0, 25, 50, 75, 100])).toEqual(["$0", "$25", "$50", "$75", "$100"]);
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
