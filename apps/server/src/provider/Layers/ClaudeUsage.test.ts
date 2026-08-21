import { describe, expect, it } from "vite-plus/test";

import { parseClaudeUsageRateLimits } from "./ClaudeUsage.ts";

describe("parseClaudeUsageRateLimits", () => {
  it("maps Claude OAuth five-hour and seven-day tiers into provider rate limits", () => {
    const parsed = parseClaudeUsageRateLimits(
      {
        five_hour: {
          utilization: 42,
          resets_at: "2026-05-11T17:30:00.000Z",
        },
        seven_day: {
          utilization: 7,
          resets_at: "2026-05-18T12:00:00.000Z",
        },
        seven_day_sonnet: {
          utilization: 12,
          resets_at: "2026-05-18T12:00:00.000Z",
        },
        extra_usage: {
          is_enabled: true,
        },
      },
      "Claude Max Subscription",
    );

    expect(parsed).toEqual({
      limitId: "claude-oauth",
      limitName: "Claude Max Subscription",
      planType: "Claude Max Subscription",
      primary: {
        usedPercent: 42,
        windowDurationMins: 300,
        resetsAt: 1_778_520_600,
      },
      secondary: {
        usedPercent: 7,
        windowDurationMins: 10_080,
        resetsAt: 1_779_105_600,
      },
    });
  });

  it("surfaces the Fable-scoped weekly tier as a labelled third window", () => {
    const parsed = parseClaudeUsageRateLimits(
      {
        five_hour: { utilization: 42 },
        seven_day: { utilization: 7 },
        seven_day_sonnet: { utilization: 12 },
        seven_day_fable: {
          utilization: 63,
          resets_at: "2026-05-18T12:00:00.000Z",
        },
      },
      null,
    );

    expect(parsed?.tertiary).toEqual({
      usedPercent: 63,
      windowDurationMins: 10_080,
      label: "Fable weekly",
      resetsAt: 1_779_105_600,
    });
  });

  it("accepts a generation-suffixed Fable weekly key", () => {
    expect(
      parseClaudeUsageRateLimits({ seven_day_fable_5: { utilization: 5 } }, null)?.tertiary,
    ).toEqual({
      usedPercent: 5,
      windowDurationMins: 10_080,
      label: "Fable weekly",
    });
  });

  it("prefers the Fable weekly tier over the Opus one", () => {
    expect(
      parseClaudeUsageRateLimits(
        {
          seven_day_opus: { utilization: 20 },
          seven_day_fable: { utilization: 63 },
        },
        null,
      )?.tertiary,
    ).toEqual({
      usedPercent: 63,
      windowDurationMins: 10_080,
      label: "Fable weekly",
    });
  });

  it("returns undefined when no usage tiers are present", () => {
    expect(
      parseClaudeUsageRateLimits(
        {
          seven_day_sonnet: { utilization: 12 },
          extra_usage: { is_enabled: true },
        },
        null,
      ),
    ).toBeUndefined();
  });
});
