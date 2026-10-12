import { describe, expect, it } from "vite-plus/test";

import { parseClaudeProfilePlan, parseClaudeUsageWindows } from "./claudeOAuthUsage.ts";

describe("parseClaudeUsageWindows", () => {
  it("maps account-wide and model-scoped windows with their durations", () => {
    expect(
      parseClaudeUsageWindows({
        five_hour: { utilization: 42, resets_at: "2026-05-11T17:30:00.000Z" },
        seven_day: { utilization: 7, resets_at: "2026-05-18T12:00:00.000Z" },
        seven_day_opus: { utilization: 30, resets_at: "2026-05-18T12:00:00.000Z" },
        seven_day_sonnet: null,
        extra_usage: { is_enabled: true },
      }),
    ).toEqual([
      { id: "five_hour", usedPercent: 42, resetsAt: 1_778_520_600, windowDurationMins: 300 },
      { id: "seven_day", usedPercent: 7, resetsAt: 1_779_105_600, windowDurationMins: 10_080 },
      {
        id: "seven_day_opus",
        scope: "Opus",
        usedPercent: 30,
        resetsAt: 1_779_105_600,
        windowDurationMins: 10_080,
      },
    ]);
  });

  it("prefers the active weekly_scoped limit per model and skips duplicates", () => {
    const windows = parseClaudeUsageWindows({
      seven_day_opus: { utilization: 30 },
      limits: [
        { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Fable" } } },
        {
          kind: "weekly_scoped",
          percent: 55,
          is_active: true,
          resets_at: "2026-05-18T12:00:00.000Z",
          scope: { model: { display_name: "Fable" } },
        },
        { kind: "weekly_scoped", percent: 99, scope: { model: { display_name: "Opus" } } },
        { kind: "daily", percent: 1, scope: { model: { display_name: "Haiku" } } },
      ],
      iguana_necktie: { utilization: 80 },
    });
    expect(windows.map((window) => [window.id, window.scope, window.usedPercent])).toEqual([
      ["seven_day_opus", "Opus", 30],
      ["seven_day_fable", "Fable", 55],
    ]);
  });

  it("reads the undocumented key as Fable weekly or as a dollar credit pool", () => {
    expect(parseClaudeUsageWindows({ iguana_necktie: { utilization: 12 } })).toEqual([
      { id: "seven_day_fable", scope: "Fable", usedPercent: 12, windowDurationMins: 10_080 },
    ]);
    expect(
      parseClaudeUsageWindows({ iguana_necktie: { utilization: 40, used_dollars: 4 } }),
    ).toEqual([{ id: "cloud_session_credits", scope: "Cloud session credits", usedPercent: 40 }]);
  });

  it("returns no windows for unusable payloads", () => {
    expect(parseClaudeUsageWindows(null)).toEqual([]);
    expect(parseClaudeUsageWindows([])).toEqual([]);
    expect(parseClaudeUsageWindows({ five_hour: { utilization: "12" } })).toEqual([]);
  });
});

describe("parseClaudeProfilePlan", () => {
  it("resolves team, max, pro and free plans", () => {
    expect(
      parseClaudeProfilePlan({
        organization: { organization_type: "claude_team", subscription_status: "active" },
        account: { has_claude_max: true },
      }),
    ).toBe("team");
    expect(parseClaudeProfilePlan({ account: { has_claude_max: true } })).toBe("max");
    expect(parseClaudeProfilePlan({ account: { has_claude_pro: true } })).toBe("pro");
    expect(
      parseClaudeProfilePlan({ account: { has_claude_max: false, has_claude_pro: false } }),
    ).toBe("free");
    expect(parseClaudeProfilePlan({ account: {} })).toBeUndefined();
  });
});
