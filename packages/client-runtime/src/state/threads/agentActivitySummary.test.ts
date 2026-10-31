import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_ACTIVITY_RECENT_RESULT_MS,
  summarizeAgentActivity,
  type AgentActivityThread,
} from "./agentActivitySummary.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

let counter = 0;
const thread = (overrides: Partial<AgentActivityThread> = {}): AgentActivityThread => {
  counter += 1;
  return {
    key: `env:thread-${counter}`,
    environmentId: "env",
    threadId: `thread-${counter}`,
    title: `Thread ${counter}`,
    projectName: "ryco",
    live: true,
    state: "working",
    attention: null,
    resting: false,
    unseen: false,
    delegated: false,
    finishedAtMs: null,
    updatedAtMs: NOW - counter * 1_000,
    ...overrides,
  };
};

describe("summarizeAgentActivity", () => {
  it("puts what waits on you first, in the Inbox's order, then running work", () => {
    const running = thread({ title: "Running" });
    const done = thread({
      title: "Done",
      state: "idle",
      unseen: true,
      finishedAtMs: NOW - 60_000,
    });
    const input = thread({ title: "Question", state: "needs-input", attention: "input" });
    const approval = thread({ title: "Approve", state: "needs-input", attention: "approval" });
    const summary = summarizeAgentActivity([running, done, input, approval], NOW);
    expect(summary.rows.map((row) => [row.title, row.phase])).toEqual([
      ["Approve", "approval"],
      ["Question", "input"],
      ["Done", "done"],
      ["Running", "running"],
    ]);
    expect(summary.counts).toEqual({ running: 1, needsYou: 2, failed: 0, done: 1 });
    expect(summary.settled).toBe(false);
  });

  it("shows at most 5 rows and counts the rest", () => {
    const summary = summarizeAgentActivity(
      Array.from({ length: 8 }, () => thread()),
      NOW,
    );
    expect(summary.rows).toHaveLength(5);
    expect(summary.counts.running).toBe(8);
  });

  it("drops a result 15 minutes after its turn ended", () => {
    const failed = thread({
      state: "error",
      unseen: true,
      finishedAtMs: NOW - AGENT_ACTIVITY_RECENT_RESULT_MS,
    });
    expect(summarizeAgentActivity([failed], NOW).counts.failed).toBe(1);
    expect(summarizeAgentActivity([failed], NOW + 1).rows).toEqual([]);
    // A seen result never shows.
    expect(summarizeAgentActivity([{ ...failed, unseen: false }], NOW).counts.failed).toBe(0);
  });

  it("leaves out machines that are offline or not current, and resting threads", () => {
    const summary = summarizeAgentActivity(
      [
        thread({ live: false }),
        thread({ live: false, state: "needs-input", attention: "approval" }),
        thread({ state: "offline" }),
        thread({ resting: true, state: "needs-input", attention: "input" }),
      ],
      NOW,
    );
    expect(summary.rows).toEqual([]);
    expect(summary.counts).toEqual({ running: 0, needsYou: 0, failed: 0, done: 0 });
  });

  it("counts a delegated child only while it is blocked on you", () => {
    const summary = summarizeAgentActivity(
      [
        thread({ delegated: true }),
        thread({ delegated: true, state: "needs-input", attention: "plan" }),
        thread({ delegated: true, state: "idle", unseen: true, finishedAtMs: NOW - 1 }),
        thread({ delegated: true, state: "needs-input", attention: "approval", title: "Sub" }),
      ],
      NOW,
    );
    expect(summary.rows.map((row) => [row.title, row.phase])).toEqual([["Sub", "approval"]]);
    expect(summary.counts).toEqual({ running: 0, needsYou: 1, failed: 0, done: 0 });
  });

  it("is settled when only results remain", () => {
    const summary = summarizeAgentActivity(
      [
        thread({ state: "idle", unseen: true, finishedAtMs: NOW - 1_000 }),
        thread({ state: "limited", unseen: true, finishedAtMs: NOW - 2_000 }),
      ],
      NOW,
    );
    expect(summary.counts).toEqual({ running: 0, needsYou: 0, failed: 1, done: 1 });
    expect(summary.settled).toBe(true);
    expect(summarizeAgentActivity([], NOW).settled).toBe(true);
  });

  it("shortens titles and project names for the card", () => {
    const [row] = summarizeAgentActivity(
      [thread({ title: `  ${"x".repeat(60)}  `, projectName: "a-very-long-project-name-indeed" })],
      NOW,
    ).rows;
    expect(row?.title).toHaveLength(48);
    expect(row?.title.endsWith("…")).toBe(true);
    expect(row?.projectName).toHaveLength(24);
  });
});
