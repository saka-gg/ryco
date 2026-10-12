import { describe, expect, it } from "vite-plus/test";

import { withProviderGoalPrompt } from "./goalMode.ts";

const goal = {
  objective: "Ship <safe> & reliable goals",
  status: "active" as const,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: "2026-08-17T10:00:00.000Z",
  updatedAt: "2026-08-17T10:00:00.000Z",
};

describe("withProviderGoalPrompt", () => {
  it("injects an active goal and escapes objective markup", () => {
    const result = withProviderGoalPrompt({ message: "Continue", goal });
    expect(result).toContain("<ryco_goal>");
    expect(result).toContain("Ship &lt;safe&gt; &amp; reliable goals");
    expect(result).toContain("\n\nContinue");
  });

  it("keeps a slash command verbatim so the provider still runs it", () => {
    expect(withProviderGoalPrompt({ message: "/review", goal })).toBe("/review");
    expect(withProviderGoalPrompt({ message: "  /compact", goal })).toBe("  /compact");
  });

  it("does not inject paused goals", () => {
    expect(
      withProviderGoalPrompt({ message: "Continue", goal: { ...goal, status: "paused" } }),
    ).toBe("Continue");
  });
});
