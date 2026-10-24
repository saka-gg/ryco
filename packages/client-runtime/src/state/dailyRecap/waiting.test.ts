import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AppState, EnvironmentState } from "../threads/store.ts";
import type { SidebarThreadSummary } from "../threads/types.ts";
import { createWaitingThreadCountSelector } from "./waiting.ts";

const nodeA = EnvironmentId.make("synthetic-node-a");
const nodeB = EnvironmentId.make("synthetic-node-b");
const nowMs = Date.parse("2026-10-23T12:00:00.000Z");

function thread(id: string, patch: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: nodeA,
    projectId: ProjectId.make("project"),
    title: `Chat ${id}`,
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-23T08:00:00.000Z",
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make(`${id}-turn`),
      state: "completed",
      requestedAt: "2026-10-23T09:00:00.000Z",
      startedAt: "2026-10-23T09:00:00.000Z",
      completedAt: "2026-10-23T09:30:00.000Z",
      assistantMessageId: null,
    },
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...patch,
  };
}

const planReady = (id: string, patch: Partial<SidebarThreadSummary> = {}) =>
  thread(id, { interactionMode: "plan", hasActionableProposedPlan: true, ...patch });

function summaries(
  ...threads: SidebarThreadSummary[]
): EnvironmentState["sidebarThreadSummaryById"] {
  return Object.fromEntries(threads.map((entry) => [entry.id, entry]));
}

function appState(nodes: Record<string, EnvironmentState["sidebarThreadSummaryById"]>): AppState {
  return {
    activeEnvironmentId: null,
    environmentStateById: Object.fromEntries(
      Object.entries(nodes).map(([environmentId, sidebarThreadSummaryById]) => [
        environmentId,
        { sidebarThreadSummaryById, bootstrapComplete: true } as EnvironmentState,
      ]),
    ),
  };
}

describe("chats waiting on the user", () => {
  it("counts approvals, questions and plans to review on the chosen nodes", () => {
    const select = createWaitingThreadCountSelector();
    const state = appState({
      [nodeA]: summaries(
        thread("approval", { hasPendingApprovals: true }),
        thread("question", { hasPendingUserInput: true }),
        planReady("plan"),
        thread("idle"),
        thread("archived", { hasPendingApprovals: true, archivedAt: "2026-10-23T10:00:00.000Z" }),
      ),
      [nodeB]: summaries(thread("elsewhere", { hasPendingApprovals: true })),
    });
    expect(select(state, [nodeA], nowMs)).toBe(3);
    expect(select(state, [nodeA, nodeB], nowMs)).toBe(4);
    expect(select(state, [], nowMs)).toBe(0);
  });

  it("leaves out a snoozed plan until its snooze runs out", () => {
    const select = createWaitingThreadCountSelector();
    const state = appState({
      [nodeA]: summaries(
        planReady("snoozed", {
          snoozedAt: "2026-10-23T11:00:00.000Z",
          snoozedUntil: "2026-10-23T13:00:00.000Z",
        }),
      ),
    });
    expect(select(state, [nodeA], nowMs)).toBe(0);
    expect(select(state, [nodeA], Date.parse("2026-10-23T13:00:00.000Z"))).toBe(1);
  });

  it("rescans a node only when its summaries changed", () => {
    let scans = 0;
    const counted = new Proxy(summaries(thread("approval", { hasPendingApprovals: true })), {
      ownKeys(target) {
        scans += 1;
        return Reflect.ownKeys(target);
      },
    });
    const select = createWaitingThreadCountSelector();
    expect(select(appState({ [nodeA]: counted }), [nodeA], nowMs)).toBe(1);
    expect(select(appState({ [nodeA]: counted }), [nodeA], nowMs + 60_000)).toBe(1);
    expect(scans).toBe(1);
  });
});
