import { describe, expect, it } from "vite-plus/test";

import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";

import { resolveDelegatedTaskStatus, type DelegatedTaskState } from "./delegatedTaskStatus.ts";
import type { SidebarThreadSummary } from "./types.ts";

type ChildTurns = Pick<SidebarThreadSummary, "latestTurn" | "latestCompletedTurnAt">;

const NEVER_FINISHED: ChildTurns = { latestTurn: null };
const RUNNING: ChildTurns = {
  latestTurn: {
    turnId: "turn-2",
    state: "running",
    requestedAt: "2026-10-16T10:00:00.000Z",
    startedAt: "2026-10-16T10:00:05.000Z",
    completedAt: null,
    assistantMessageId: null,
  } as never,
  latestCompletedTurnAt: "2026-10-16T09:00:00.000Z",
};
const FINISHED_EARLIER: ChildTurns = {
  latestTurn: null,
  latestCompletedTurnAt: "2026-10-16T09:00:00.000Z",
};

function returnWith(status: AgentControlCompletionReturn["status"]): AgentControlCompletionReturn {
  return { status } as AgentControlCompletionReturn;
}

function status(
  thread: ChildTurns,
  state: DelegatedTaskState,
  completionReturn?: AgentControlCompletionReturn,
) {
  return resolveDelegatedTaskStatus({ thread, state, completionReturn });
}

describe("resolveDelegatedTaskStatus", () => {
  it("clocks a working task from its running turn", () => {
    expect(status(RUNNING, "working")).toEqual({
      tone: "working",
      label: "Working",
      runningSince: "2026-10-16T10:00:05.000Z",
      finishedAt: "2026-10-16T09:00:00.000Z",
      failed: false,
    });
  });

  it("calls a resting task done once it finished any turn, idle before", () => {
    expect(status(FINISHED_EARLIER, "idle")).toMatchObject({
      tone: "done",
      label: "Done",
      finishedAt: "2026-10-16T09:00:00.000Z",
    });
    expect(status(NEVER_FINISHED, "idle")).toMatchObject({ tone: "muted", label: "Idle" });
  });

  it("leaves every other state its inbox words, in the dock's tones", () => {
    const tones = (
      ["needs-input", "limited", "error", "delivery-unknown", "offline", "settled"] as const
    ).map((state) => [
      state,
      status(NEVER_FINISHED, state).tone,
      status(NEVER_FINISHED, state).label,
    ]);
    expect(tones).toEqual([
      ["needs-input", "attention", null],
      ["limited", "attention", null],
      ["error", "danger", null],
      ["delivery-unknown", "danger", null],
      ["offline", "muted", null],
      ["settled", "muted", null],
    ]);
  });

  it("fails a task in error or whose result return to the parent broke", () => {
    expect(status(NEVER_FINISHED, "error").failed).toBe(true);
    expect(status(FINISHED_EARLIER, "idle", returnWith("blocked")).failed).toBe(true);
    expect(status(FINISHED_EARLIER, "idle", returnWith("failed")).failed).toBe(true);
    expect(status(FINISHED_EARLIER, "idle", returnWith("uncertain")).failed).toBe(true);
    expect(status(FINISHED_EARLIER, "idle", returnWith("delivered")).failed).toBe(false);
    expect(status(FINISHED_EARLIER, "idle", returnWith("waiting")).failed).toBe(false);
    expect(status(FINISHED_EARLIER, "idle").failed).toBe(false);
  });
});
