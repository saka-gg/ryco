import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AppState, EnvironmentState } from "../threads/store.ts";
import type { SidebarThreadSummary } from "../threads/types.ts";
import { createWaitingThreadCountSelector } from "./waiting.ts";

const nodeA = EnvironmentId.make("synthetic-node-a");
const nodeB = EnvironmentId.make("synthetic-node-b");

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
  it("counts approvals and questions on the chosen nodes", () => {
    const select = createWaitingThreadCountSelector();
    const state = appState({
      [nodeA]: summaries(
        thread("approval", { hasPendingApprovals: true }),
        thread("question", { hasPendingUserInput: true }),
        thread("idle"),
        thread("archived", { hasPendingApprovals: true, archivedAt: "2026-10-23T10:00:00.000Z" }),
      ),
      [nodeB]: summaries(thread("elsewhere", { hasPendingApprovals: true })),
    });
    expect(select(state, [nodeA])).toBe(2);
    expect(select(state, [nodeA, nodeB])).toBe(3);
    expect(select(state, [])).toBe(0);
  });

  it("counts a snoozed approval and leaves out plans to review", () => {
    const select = createWaitingThreadCountSelector();
    const state = appState({
      [nodeA]: summaries(
        thread("snoozed", {
          hasPendingApprovals: true,
          snoozedAt: "2026-10-23T11:00:00.000Z",
          snoozedUntil: "2026-10-23T13:00:00.000Z",
        }),
        thread("plan", { interactionMode: "plan", hasActionableProposedPlan: true }),
      ),
    });
    expect(select(state, [nodeA])).toBe(1);
  });

  it("leaves out the last-known chats of a node whose shell is not live", () => {
    const select = createWaitingThreadCountSelector();
    const waiting = summaries(thread("approval", { hasPendingApprovals: true }));
    const live = appState({ [nodeA]: waiting, [nodeB]: waiting });
    const state: AppState = {
      ...live,
      environmentStateById: {
        // Painted from the shell cache before it connected.
        [nodeA]: {
          ...live.environmentStateById[nodeA],
          bootstrapComplete: false,
          hydratedFromCacheAt: Date.parse("2026-10-23T12:00:00.000Z"),
        } as EnvironmentState,
        // Demoted after its connection dropped.
        [nodeB]: {
          ...live.environmentStateById[nodeB],
          hydratedFromCacheAt: Date.parse("2026-10-23T12:00:00.000Z"),
        } as EnvironmentState,
      },
    };
    expect(select(live, [nodeA, nodeB])).toBe(2);
    expect(select(state, [nodeA, nodeB])).toBe(0);
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
    expect(select(appState({ [nodeA]: counted }), [nodeA])).toBe(1);
    expect(select(appState({ [nodeA]: counted }), [nodeA])).toBe(1);
    expect(scans).toBe(1);
  });
});
