import type { AgentActivitySummary } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { InboxEnvironment, InboxSection, InboxThreadRow } from "../features/inbox/inboxModel";
import {
  AGENT_ACTIVITY_DISMISS_AFTER_MS,
  AGENT_ACTIVITY_MAX_STATE_BYTES,
  AGENT_ACTIVITY_STALE_AFTER_MS,
  AGENT_ACTIVITY_STATE_BUDGET_BYTES,
  agentActivityContentState,
  agentActivityShownKey,
  agentActivityThreads,
  decideAgentActivity,
  encodeAgentActivityState,
  type AgentActivityCard,
  type AgentActivityContext,
} from "./agentActivityModel";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const LINKS = {
  inbox: "ryco-dev://",
  thread: (environmentId: string, threadId: string) =>
    `ryco-dev://threads/${environmentId}/${threadId}`,
};

function summary(
  counts: Partial<AgentActivitySummary["counts"]>,
  rows: AgentActivitySummary["rows"] = [],
): AgentActivitySummary {
  const full = { running: 0, needsYou: 0, failed: 0, done: 0, ...counts };
  return { counts: full, rows, settled: full.running + full.needsYou === 0 };
}

const RUNNING = summary({ running: 1 }, [
  {
    key: "env:t1",
    environmentId: "env",
    threadId: "t1",
    title: "Fix the flaky test",
    projectName: "ryco",
    phase: "running",
  },
]);
const SETTLED = summary({ done: 1 }, [{ ...RUNNING.rows[0]!, phase: "done" }]);

const CONTEXT: AgentActivityContext = {
  foreground: true,
  enabled: true,
  signedIn: true,
  known: true,
  unknownSinceMs: null,
  nowMs: NOW,
};
/** No machine is live yet, since a moment ago. */
const UNKNOWN: AgentActivityContext = { ...CONTEXT, known: false, unknownSinceMs: NOW - 1_000 };

function card(overrides: Partial<AgentActivityCard> = {}): AgentActivityCard {
  const state = agentActivityContentState(RUNNING, LINKS, NOW - 1_000);
  return {
    id: "card-1",
    updatedAt: NOW - 1_000,
    staleAt: NOW - 1_000 + AGENT_ACTIVITY_STALE_AFTER_MS,
    shownKey: agentActivityShownKey(state),
    ...overrides,
  };
}

describe("deciding the Live Activity", () => {
  it("starts only in the foreground, when it is on, signed in and something runs or waits", () => {
    expect(decideAgentActivity([], RUNNING, CONTEXT, LINKS)).toMatchObject({
      kind: "start",
      staleAtMs: NOW + 600_000,
      state: {
        v: 1,
        origin: "local",
        counts: { running: 1, needsYou: 0, failed: 0, done: 0 },
        rows: [
          {
            title: "Fix the flaky test",
            project: "ryco",
            phase: "running",
            url: "ryco-dev://threads/env/t1",
          },
        ],
        url: "ryco-dev://",
        updatedAt: NOW,
      },
    });
    for (const context of [
      { ...CONTEXT, foreground: false },
      { ...CONTEXT, enabled: false },
      { ...CONTEXT, signedIn: false },
      UNKNOWN,
      { ...UNKNOWN, unknownSinceMs: NOW - AGENT_ACTIVITY_STALE_AFTER_MS },
    ]) {
      expect(decideAgentActivity([], RUNNING, context, LINKS)).toEqual({ kind: "noop" });
    }
    expect(decideAgentActivity([], SETTLED, CONTEXT, LINKS)).toEqual({ kind: "noop" });
  });

  it("does not update a card for the same state, and pushes the stale date on a change", () => {
    expect(decideAgentActivity([card()], RUNNING, CONTEXT, LINKS)).toEqual({ kind: "noop" });
    const waiting = summary({ needsYou: 1 }, [{ ...RUNNING.rows[0]!, phase: "approval" }]);
    // In the background too: the app still runs for a moment after it leaves the foreground.
    expect(
      decideAgentActivity([card()], waiting, { ...CONTEXT, foreground: false }, LINKS),
    ).toMatchObject({ kind: "update", id: "card-1", staleAtMs: NOW + 600_000 });
  });

  it("refreshes a card that is about to go stale while Ryco runs in front", () => {
    const old = card({ staleAt: NOW + 60_000 });
    expect(decideAgentActivity([old], RUNNING, CONTEXT, LINKS)).toMatchObject({
      kind: "update",
      staleAtMs: NOW + AGENT_ACTIVITY_STALE_AFTER_MS,
    });
    expect(decideAgentActivity([old], RUNNING, { ...CONTEXT, foreground: false }, LINKS)).toEqual({
      kind: "noop",
    });
  });

  it("ends once settled, showing the results for fifteen minutes", () => {
    expect(decideAgentActivity([card()], SETTLED, CONTEXT, LINKS)).toMatchObject({
      kind: "end",
      id: "card-1",
      dismissAtMs: NOW + AGENT_ACTIVITY_DISMISS_AFTER_MS,
      state: { counts: { running: 0, needsYou: 0, done: 1 }, rows: [{ phase: "done" }] },
    });
    expect(AGENT_ACTIVITY_DISMISS_AFTER_MS).toBe(15 * 60_000);
  });

  it("ends at once on sign-out or when turned off", () => {
    for (const context of [
      { ...CONTEXT, signedIn: false },
      { ...CONTEXT, enabled: false },
    ]) {
      expect(decideAgentActivity([card()], RUNNING, context, LINKS)).toEqual({
        kind: "end",
        id: "card-1",
        state: null,
        dismissAtMs: null,
      });
    }
  });

  it("keeps one card: the newest stays, the others end", () => {
    expect(
      decideAgentActivity(
        [
          card({ id: "old", updatedAt: NOW - 50_000 }),
          card({ id: "new" }),
          card({ id: "older", updatedAt: 0 }),
        ],
        RUNNING,
        CONTEXT,
        LINKS,
      ),
    ).toEqual({ kind: "endExtras", ids: ["old", "older"] });
  });

  it("ends a stale card an earlier launch left once nothing runs, and waits until machines answer", () => {
    const leftOver = card({ shownKey: null, staleAt: NOW - 1 });
    expect(decideAgentActivity([leftOver], SETTLED, UNKNOWN, LINKS)).toEqual({ kind: "noop" });
    expect(decideAgentActivity([leftOver], SETTLED, CONTEXT, LINKS)).toEqual({
      kind: "end",
      id: "card-1",
      state: null,
      dismissAtMs: null,
    });
    // Work still runs: the card is adopted and brought up to date.
    expect(decideAgentActivity([leftOver], RUNNING, CONTEXT, LINKS)).toMatchObject({
      kind: "update",
      id: "card-1",
    });
  });
});

describe("a card no machine can speak for", () => {
  it("stays while machines may still answer, and ends once none was live for the stale window", () => {
    const unknownFor = (ms: number): AgentActivityContext => ({
      ...UNKNOWN,
      unknownSinceMs: NOW - ms,
    });
    expect(
      decideAgentActivity([card()], RUNNING, unknownFor(AGENT_ACTIVITY_STALE_AFTER_MS - 1), LINKS),
    ).toEqual({ kind: "noop" });
    for (const summaryNow of [RUNNING, SETTLED]) {
      expect(
        decideAgentActivity([card()], summaryNow, unknownFor(AGENT_ACTIVITY_STALE_AFTER_MS), LINKS),
      ).toEqual({ kind: "end", id: "card-1", state: null, dismissAtMs: null });
    }
    expect(AGENT_ACTIVITY_STALE_AFTER_MS).toBe(10 * 60_000);
  });
});

describe("the Live Activity state", () => {
  it("stays within its budget, under ActivityKit's 4 KB, with five rows of the longest titles", () => {
    const emoji = "🧪".repeat(48);
    const rows = Array.from({ length: 5 }, (_, index) => ({
      key: `environment-${"e".repeat(30)}:thread-${index}-${"t".repeat(30)}`,
      environmentId: `environment-${"e".repeat(30)}`,
      threadId: `thread-${index}-${"t".repeat(30)}`,
      title: emoji,
      projectName: "🧪".repeat(24),
      phase: "approval" as const,
    }));
    const json = encodeAgentActivityState(
      agentActivityContentState(summary({ needsYou: 5 }, rows), LINKS, NOW),
    );
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(
      AGENT_ACTIVITY_STATE_BUDGET_BYTES,
    );
    expect(JSON.parse(json).rows).toHaveLength(5);
  });

  it("keeps a margin under 4 KB for Swift's larger encoding", () => {
    expect(AGENT_ACTIVITY_MAX_STATE_BYTES - AGENT_ACTIVITY_STATE_BUDGET_BYTES).toBe(512);
    // About 3.8 KB as JavaScript encodes it: under ActivityKit's limit, over the budget.
    const rows = Array.from({ length: 5 }, (_, index) => ({
      key: `k${index}`,
      environmentId: "env",
      threadId: `t${index}`,
      title: "x".repeat(680),
      projectName: null,
      phase: "running" as const,
    }));
    const state = agentActivityContentState(summary({ running: 5 }, rows), LINKS, NOW);
    const whole = new TextEncoder().encode(JSON.stringify(state)).length;
    expect(whole).toBeGreaterThan(AGENT_ACTIVITY_STATE_BUDGET_BYTES);
    expect(whole).toBeLessThan(AGENT_ACTIVITY_MAX_STATE_BYTES);
    const json = encodeAgentActivityState(state);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(
      AGENT_ACTIVITY_STATE_BUDGET_BYTES,
    );
    expect(JSON.parse(json).rows).toHaveLength(4);
  });

  it("drops rows, never the counts, from a state that would not fit", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      key: `k${index}`,
      environmentId: "env",
      threadId: `t${index}`,
      title: "x".repeat(2_000),
      projectName: null,
      phase: "running" as const,
    }));
    const json = encodeAgentActivityState(
      agentActivityContentState(summary({ running: 5 }, rows), LINKS, NOW),
    );
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(
      AGENT_ACTIVITY_STATE_BUDGET_BYTES,
    );
    expect(JSON.parse(json)).toMatchObject({ counts: { running: 5 }, rows: [{}] });
  });
});

describe("the Inbox rows the summary takes", () => {
  const environment: InboxEnvironment = {
    environmentId: "env" as EnvironmentId,
    label: "Mac",
    connectionState: "connected",
    shellCurrent: true,
  };
  const row = (overrides: Partial<InboxThreadRow>): InboxThreadRow =>
    ({
      key: "env:t1",
      environmentId: "env" as EnvironmentId,
      threadId: "t1" as ThreadId,
      title: "Fix the flaky test",
      projectLabel: "ryco",
      isChat: false,
      state: "working",
      attentionState: "active",
      updatedAt: new Date(NOW).toISOString(),
      ...overrides,
    }) as InboxThreadRow;
  const thread = (id: string, overrides: Record<string, unknown> = {}) =>
    ({
      id,
      environmentId: "env",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      interactionMode: "default",
      session: null,
      latestTurn: {
        turnId: "turn",
        state: "completed",
        requestedAt: new Date(NOW - 60_000).toISOString(),
        startedAt: new Date(NOW - 60_000).toISOString(),
        completedAt: new Date(NOW - 30_000).toISOString(),
        assistantMessageId: null,
      },
      ...overrides,
    }) as never;

  it("carries the Inbox's state, what a request waits on, and whether the machine is live", () => {
    const sections: InboxSection[] = [
      {
        key: "active",
        title: "Active",
        rows: [
          row({}),
          row({ key: "env:t2", threadId: "t2" as ThreadId, state: "needs-input", isChat: true }),
        ],
      },
      {
        key: "snoozed",
        title: "Snoozed",
        rows: [row({ key: "env:t3", threadId: "t3" as ThreadId, attentionState: "snoozed" })],
      },
    ];
    const threads = agentActivityThreads({
      sections,
      threads: [
        thread("t1", {
          latestTurn: {
            turnId: "turn",
            state: "running",
            requestedAt: "",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        thread("t2", { hasPendingApprovals: true }),
        thread("t3", {
          lineage: { parentThreadId: "p", rootThreadId: "p", relationship: "delegated" },
        }),
      ],
      environments: [environment],
    });
    expect(
      threads.map((entry) => [
        entry.threadId,
        entry.state,
        entry.attention,
        entry.resting,
        entry.live,
      ]),
    ).toEqual([
      ["t1", "working", null, false, true],
      ["t2", "needs-input", "approval", false, true],
      ["t3", "working", null, true, true],
    ]);
    expect(threads[0]).toMatchObject({ projectName: "ryco", finishedAtMs: null, unseen: true });
    expect(threads[1]).toMatchObject({ projectName: null, finishedAtMs: NOW - 30_000 });
    expect(threads.map((entry) => entry.delegated)).toEqual([false, false, true]);
  });

  it("is not live on a machine that is offline, cached or not current yet", () => {
    const sections: InboxSection[] = [{ key: "active", title: "Active", rows: [row({})] }];
    for (const other of [
      { ...environment, connectionState: "offline" as const },
      { ...environment, stale: true },
      { ...environment, shellCurrent: false },
    ]) {
      const [entry] = agentActivityThreads({
        sections,
        threads: [thread("t1")],
        environments: [other],
      });
      expect(entry!.live).toBe(false);
    }
  });
});
