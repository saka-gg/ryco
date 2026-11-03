import { describe, expect, it } from "vite-plus/test";

import { isThreadTurnRunning } from "./turnRunning.ts";

const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";

describe("isThreadTurnRunning", () => {
  const turn = (state: string) => ({ state, requestedAt: T1, startedAt: T2 });
  const session = (status: string, updatedAt: string, activeTurnId: string | null = null) => ({
    status,
    activeTurnId,
    updatedAt,
  });

  it("counts a starting or running session and an active turn", () => {
    expect(isThreadTurnRunning(session("starting", T3), null)).toBe(true);
    expect(isThreadTurnRunning(session("running", T3), turn("completed"))).toBe(true);
    expect(isThreadTurnRunning(session("ready", T3, "turn-1"), turn("completed"))).toBe(true);
  });

  it("counts a running turn row until the session settles after it started", () => {
    expect(isThreadTurnRunning(null, turn("running"))).toBe(true);
    expect(isThreadTurnRunning(session("ready", T1), turn("running"))).toBe(true);
    // The session settled after the turn started: the row is stale, not a running turn.
    expect(isThreadTurnRunning(session("ready", T3), turn("running"))).toBe(false);
  });

  it("is false for a settled thread", () => {
    expect(isThreadTurnRunning(null, null)).toBe(false);
    expect(isThreadTurnRunning(session("ready", T3), turn("completed"))).toBe(false);
    expect(isThreadTurnRunning(session("error", T3), turn("error"))).toBe(false);
  });
});
