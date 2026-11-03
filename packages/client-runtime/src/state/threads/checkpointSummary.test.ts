import { TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveUndoTurnCountByTurnId } from "./checkpointSummary.ts";
import type { TurnDiffSummary } from "./types.ts";

describe("deriveUndoTurnCountByTurnId", () => {
  const summary = (
    turnId: string,
    overrides: Partial<Record<keyof TurnDiffSummary, unknown>> = {},
  ): TurnDiffSummary =>
    ({
      turnId: TurnId.make(turnId),
      completedAt: "2026-01-01T00:00:10Z",
      files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
      checkpointRef: "checkpoint-abc",
      checkpointTurnCount: 3,
      ...overrides,
    }) as TurnDiffSummary;

  it("targets the turn before the one being undone", () => {
    const result = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: [summary("turn-1")],
      inferredCheckpointTurnCountByTurnId: {},
    });
    expect(result.get(TurnId.make("turn-1"))).toBe(2);
  });

  it("falls back to the inferred checkpoint count", () => {
    const result = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: [summary("turn-1", { checkpointTurnCount: undefined })],
      inferredCheckpointTurnCountByTurnId: { [TurnId.make("turn-1")]: 5 },
    });
    expect(result.get(TurnId.make("turn-1"))).toBe(4);
  });

  it("skips turns with nothing restorable", () => {
    const result = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: [
        summary("missing", { status: "missing" }),
        summary("errored", { status: "error" }),
        // A reported provider diff is not a checkpoint we can roll back to.
        summary("provider", { checkpointRef: "provider-diff:xyz" }),
        summary("uncaptured", { checkpointRef: undefined }),
        summary("empty", { files: [] }),
        summary("no-count", { checkpointTurnCount: undefined }),
      ],
      inferredCheckpointTurnCountByTurnId: {},
    });
    expect(result.size).toBe(0);
  });
});
