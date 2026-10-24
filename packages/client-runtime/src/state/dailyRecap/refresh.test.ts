import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AppState, EnvironmentState } from "../threads/store.ts";
import type {
  ArchivedThreadStub,
  SidebarThreadOrStub,
  SidebarThreadSummary,
} from "../threads/types.ts";
import {
  DAILY_RECAP_COMPLETION_REFRESH_MIN_MS,
  createLatestTurnCompletionSelector,
  nextCompletionRefreshDelay,
  nodesWithNewTurnCompletions,
} from "./refresh.ts";

const nodeA = EnvironmentId.make("synthetic-node-a");
const nodeB = EnvironmentId.make("synthetic-node-b");

function thread(
  id: string,
  state: "running" | "completed" | "error" | "interrupted",
  completedAt: string | null,
  patch: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
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
      state,
      requestedAt: "2026-10-23T09:00:00.000Z",
      startedAt: "2026-10-23T09:00:00.000Z",
      completedAt,
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

function stub(id: string): ArchivedThreadStub {
  return {
    shellDetail: "archived-stub",
    id: ThreadId.make(id),
    environmentId: nodeA,
    projectId: ProjectId.make("project"),
    title: `Chat ${id}`,
    createdAt: "2026-10-23T08:00:00.000Z",
    updatedAt: "2026-10-23T23:00:00.000Z",
    archivedAt: "2026-10-23T23:00:00.000Z",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    latestUserMessageAt: null,
    lineage: null,
  };
}

function summaries(
  ...threads: SidebarThreadOrStub[]
): EnvironmentState["sidebarThreadSummaryById"] {
  return Object.fromEntries(threads.map((entry) => [entry.id, entry]));
}

function appState(
  nodes: Record<string, EnvironmentState["sidebarThreadSummaryById"]>,
  live: Partial<Record<string, boolean>> = {},
): AppState {
  return {
    activeEnvironmentId: null,
    environmentStateById: Object.fromEntries(
      Object.entries(nodes).map(([environmentId, sidebarThreadSummaryById]) => [
        environmentId,
        {
          sidebarThreadSummaryById,
          bootstrapComplete: live[environmentId] ?? true,
        } as EnvironmentState,
      ]),
    ),
  };
}

const at = (time: string) => Date.parse(`2026-10-23T${time}:00.000Z`);

describe("each node's newest finished turn", () => {
  it("takes the newest completion of any outcome and skips running turns and stubs", () => {
    const select = createLatestTurnCompletionSelector();
    expect(
      select(
        appState({
          [nodeA]: summaries(
            thread("done", "completed", "2026-10-23T10:00:00.000Z"),
            thread("failed", "error", "2026-10-23T11:00:00.000Z"),
            // A resumed turn still carries the completion of the run before it.
            thread("resumed", "running", "2026-10-23T12:00:00.000Z"),
            stub("archived"),
          ),
          [nodeB]: summaries(thread("fresh", "running", null)),
        }),
      ),
    ).toEqual({ [nodeA]: at("11:00"), [nodeB]: null });
  });

  it("leaves out nodes whose shell is not live", () => {
    const select = createLatestTurnCompletionSelector();
    const state = appState(
      {
        [nodeA]: summaries(),
        [nodeB]: summaries(thread("t", "completed", "2026-10-23T10:00:00.000Z")),
      },
      { [nodeB]: false },
    );
    expect(select(state)).toEqual({ [nodeA]: null });
  });

  it("keeps the same answer while no node's newest completion moves", () => {
    const select = createLatestTurnCompletionSelector();
    const first = select(
      appState({ [nodeA]: summaries(thread("t", "completed", "2026-10-23T10:00:00.000Z")) }),
    );
    const renamed = select(
      appState({
        [nodeA]: summaries(
          thread("t", "completed", "2026-10-23T10:00:00.000Z", { title: "Renamed" }),
          thread("new", "running", null),
        ),
      }),
    );
    expect(renamed).toBe(first);
  });

  it("rescans only the nodes whose summaries changed", () => {
    let scans = 0;
    const counted = new Proxy(summaries(thread("t", "completed", "2026-10-23T10:00:00.000Z")), {
      ownKeys(target) {
        scans += 1;
        return Reflect.ownKeys(target);
      },
    });
    const select = createLatestTurnCompletionSelector();
    select(appState({ [nodeA]: counted, [nodeB]: summaries() }));
    const next = select(
      appState({
        [nodeA]: counted,
        [nodeB]: summaries(thread("b", "completed", "2026-10-23T12:00:00.000Z")),
      }),
    );
    expect(scans).toBe(1);
    expect(next).toEqual({ [nodeA]: at("10:00"), [nodeB]: at("12:00") });
  });
});

describe("nodes with new turn completions", () => {
  const before = { [nodeA]: at("10:00"), [nodeB]: null };

  it("names every node whose newest completion moved later, the first one included", () => {
    expect(
      nodesWithNewTurnCompletions(before, { [nodeA]: at("10:05"), [nodeB]: at("09:00") }),
    ).toEqual([nodeA, nodeB]);
  });

  it("ignores a node that just went live and one whose newest completion went away", () => {
    expect(
      nodesWithNewTurnCompletions({ [nodeB]: null }, { [nodeA]: at("10:00"), [nodeB]: null }),
    ).toEqual([]);
    // The thread with the newest turn started another one, or was deleted.
    expect(nodesWithNewTurnCompletions(before, { [nodeA]: at("09:00"), [nodeB]: null })).toEqual(
      [],
    );
  });

  it("finds the turn after one a running thread had hidden", () => {
    const select = createLatestTurnCompletionSelector();
    const done = (time: string) => thread("t", "completed", `2026-10-23T${time}:00.000Z`);
    const other = thread("other", "completed", "2026-10-23T08:00:00.000Z");
    const first = select(appState({ [nodeA]: summaries(done("10:00"), other) }));
    const running = select(appState({ [nodeA]: summaries(thread("t", "running", null), other) }));
    const finished = select(appState({ [nodeA]: summaries(done("10:30"), other) }));
    expect(nodesWithNewTurnCompletions(first, running)).toEqual([]);
    expect(nodesWithNewTurnCompletions(running, finished)).toEqual([nodeA]);
  });
});

describe("the completion refresh throttle", () => {
  it("waits out the rest of the minimum gap since the last refresh", () => {
    const now = at("12:00");
    expect(nextCompletionRefreshDelay(null, now)).toBe(0);
    expect(nextCompletionRefreshDelay(now - 5_000, now)).toBe(
      DAILY_RECAP_COMPLETION_REFRESH_MIN_MS - 5_000,
    );
    expect(nextCompletionRefreshDelay(now - DAILY_RECAP_COMPLETION_REFRESH_MIN_MS, now)).toBe(0);
    expect(nextCompletionRefreshDelay(now - 60_000, now)).toBe(0);
  });
});
