import { describe, expect, it } from "vite-plus/test";

import {
  createTurnCompletionTracker,
  type TurnCompletionObservation,
} from "./turnCompletion.logic";

const COMPLETED_AT = "2026-10-07T12:00:00.000Z";

function running(turnId: string | null): TurnCompletionObservation {
  return { turnId, running: true, settled: false, completedAt: null, state: "running" };
}

function settled(
  turnId: string | null,
  completedAt: string | null = COMPLETED_AT,
  state: TurnCompletionObservation["state"] = "completed",
) {
  return {
    turnId,
    running: false,
    settled: true,
    completedAt,
    state,
  } satisfies TurnCompletionObservation;
}

describe("createTurnCompletionTracker", () => {
  it("never completes a turn that was not observed running", () => {
    const tracker = createTurnCompletionTracker();
    // History loaded on mount: the turn is already settled the first time it is seen.
    expect(tracker.observe(settled("turn-1"))).toBeNull();
    expect(tracker.observe(settled("turn-1"))).toBeNull();
  });

  it("completes a watched turn once it settles with a completion time", () => {
    const tracker = createTurnCompletionTracker();
    expect(tracker.observe(running("turn-1"))).toBeNull();
    expect(tracker.observe(running("turn-1"))).toBeNull();
    expect(tracker.observe(settled("turn-1"))).toBe("completed");
  });

  it("reports how the turn ended", () => {
    const tracker = createTurnCompletionTracker();
    tracker.observe(running("turn-1"));
    expect(tracker.observe(settled("turn-1", COMPLETED_AT, "error"))).toBe("failed");
    tracker.observe(running("turn-2"));
    expect(tracker.observe(settled("turn-2", COMPLETED_AT, "interrupted"))).toBe("interrupted");
    tracker.observe(running("turn-3"));
    expect(tracker.observe(settled("turn-3", COMPLETED_AT, null))).toBe("completed");
  });

  it("does not complete again when the settled turn is observed again", () => {
    const tracker = createTurnCompletionTracker();
    tracker.observe(running("turn-1"));
    expect(tracker.observe(settled("turn-1"))).toBe("completed");
    expect(tracker.observe(settled("turn-1"))).toBeNull();
    expect(tracker.observe(settled("turn-1", "2026-10-07T12:05:00.000Z"))).toBeNull();
  });

  it("waits for the turn to settle and carry a completion time", () => {
    const tracker = createTurnCompletionTracker();
    tracker.observe(running("turn-1"));
    expect(
      tracker.observe({
        turnId: "turn-1",
        running: false,
        settled: false,
        completedAt: null,
        state: "completed",
      }),
    ).toBeNull();
    expect(tracker.observe(settled("turn-1", null))).toBeNull();
    // Neither look consumed the completion.
    expect(tracker.observe(settled("turn-1"))).toBe("completed");
  });

  it("completes each new turn", () => {
    const tracker = createTurnCompletionTracker();
    tracker.observe(running("turn-1"));
    expect(tracker.observe(settled("turn-1"))).toBe("completed");
    tracker.observe(running("turn-2"));
    expect(tracker.observe(settled("turn-2"))).toBe("completed");
    expect(tracker.observe(settled("turn-1"))).toBeNull();
  });

  it("ignores observations without a turn id", () => {
    const tracker = createTurnCompletionTracker();
    expect(tracker.observe(running(null))).toBeNull();
    expect(tracker.observe(settled(null))).toBeNull();
    expect(tracker.observe(running(""))).toBeNull();
    expect(tracker.observe(settled(""))).toBeNull();
  });

  it("forgets running and completed turns on reset", () => {
    const tracker = createTurnCompletionTracker();
    tracker.observe(running("turn-1"));
    tracker.reset();
    expect(tracker.observe(settled("turn-1"))).toBeNull();

    tracker.observe(running("turn-2"));
    expect(tracker.observe(settled("turn-2"))).toBe("completed");
    tracker.reset();
    tracker.observe(running("turn-2"));
    expect(tracker.observe(settled("turn-2"))).toBe("completed");
  });
});
