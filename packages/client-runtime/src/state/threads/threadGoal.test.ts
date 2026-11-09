import type { ThreadGoal } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseThreadGoalSlashCommand } from "../composer/logic.ts";
import {
  formatThreadGoalElapsed,
  planThreadGoalCommand,
  threadGoalCanResume,
  threadGoalElapsedSeconds,
  threadGoalHeading,
  threadGoalUsageLabel,
} from "./threadGoal.ts";

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    objective: "Ship the phone goal line",
    status: "active",
    tokenBudget: null,
    tokensUsed: 12_400,
    timeUsedSeconds: 65,
    createdAt: "2026-11-09T01:00:00.000Z",
    updatedAt: "2026-11-09T01:00:00.000Z",
    ...overrides,
  };
}

describe("thread goal presentation", () => {
  it("heads the goal with its delivery state first, then its status", () => {
    expect(threadGoalHeading(goal())).toBe("Pursuing goal");
    expect(threadGoalHeading(goal({ status: "budgetLimited" }))).toBe("Goal budget reached");
    expect(
      threadGoalHeading(
        goal({ synchronization: { requestId: "r", state: "pending", action: "set" } }),
      ),
    ).toBe("Updating goal…");
    expect(
      threadGoalHeading(
        goal({ synchronization: { requestId: "r", state: "failed", action: "set" } }),
      ),
    ).toBe("Goal change failed");
    expect(
      threadGoalHeading(
        goal({ synchronization: { requestId: "r", state: "unsupported", action: "set" } }),
      ),
    ).toBe("Goal reminder");
  });

  it("counts the running turn only while an active, confirmed goal runs", () => {
    const now = 1_000_000;
    expect(threadGoalElapsedSeconds(goal(), now, now - 30_000, true)).toBe(95);
    expect(threadGoalElapsedSeconds(goal(), now, now - 30_000, false)).toBe(65);
    expect(threadGoalElapsedSeconds(goal({ status: "paused" }), now, now - 30_000, true)).toBe(65);
    expect(formatThreadGoalElapsed(65)).toBe("1:05");
    expect(formatThreadGoalElapsed(3_729)).toBe("1:02:09");
  });

  it("shows token usage against a budget, but not for a reminder-only goal", () => {
    expect(threadGoalUsageLabel(goal())).toBe("12k tokens");
    expect(threadGoalUsageLabel(goal({ tokenBudget: 50_000 }))).toBe("12k / 50k tokens");
    expect(
      threadGoalUsageLabel(
        goal({ synchronization: { requestId: "r", state: "unsupported", action: "set" } }),
      ),
    ).toBeNull();
    expect(threadGoalCanResume("usageLimited")).toBe(true);
    expect(threadGoalCanResume("complete")).toBe(false);
  });
});

describe("/goal", () => {
  const plan = (text: string, context = { hasGoal: true, running: false }) =>
    planThreadGoalCommand(parseThreadGoalSlashCommand(text)!, context);

  it("sets a goal and starts its turn when the thread is idle", () => {
    expect(plan("/goal  Ship it ")).toEqual({
      kind: "set",
      update: { objective: "Ship it", status: "active" },
      startTurn: true,
    });
    expect(plan("/goal Ship it", { hasGoal: false, running: true })).toMatchObject({
      kind: "set",
      startTurn: false,
    });
  });

  it("pauses, resumes, clears and shows", () => {
    expect(plan("/goal pause")).toEqual({
      kind: "set",
      update: { status: "paused" },
      startTurn: false,
    });
    expect(plan("/goal resume")).toEqual({
      kind: "set",
      update: { status: "active" },
      startTurn: true,
    });
    expect(plan("/goal clear")).toEqual({ kind: "clear" });
    expect(plan("/goal")).toEqual({ kind: "show" });
  });

  it("refuses to change a goal that is not there, or one that is too long", () => {
    expect(plan("/goal pause", { hasGoal: false, running: false })).toMatchObject({
      kind: "refuse",
      title: "No goal set",
    });
    expect(plan(`/goal ${"x".repeat(4_001)}`)).toMatchObject({
      kind: "refuse",
      title: "Goal is too long",
    });
  });
});
