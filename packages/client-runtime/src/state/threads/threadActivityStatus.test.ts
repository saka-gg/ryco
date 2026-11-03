import { TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRunningSince } from "./threadActivityStatus.ts";

const turn = (
  overrides: Partial<NonNullable<Parameters<typeof resolveRunningSince>[0]["latestTurn"]>>,
) => ({
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "running" as const,
    requestedAt: "2026-08-10T10:00:00.000Z",
    startedAt: "2026-08-10T10:00:02.000Z",
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  },
});

describe("resolveRunningSince", () => {
  it("clocks a running turn from its start, else from its request", () => {
    expect(resolveRunningSince(turn({}))).toBe("2026-08-10T10:00:02.000Z");
    expect(resolveRunningSince(turn({ startedAt: null }))).toBe("2026-08-10T10:00:00.000Z");
  });

  it("has no clock for a settled turn or none at all", () => {
    expect(resolveRunningSince(turn({ state: "completed" }))).toBeNull();
    expect(resolveRunningSince({ latestTurn: null })).toBeNull();
  });
});
