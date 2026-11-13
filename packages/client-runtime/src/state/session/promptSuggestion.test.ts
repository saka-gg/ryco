import { EventId, TurnId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePromptSuggestion } from "./promptSuggestion.ts";

const TURN = TurnId.make("turn-2");

function suggestionActivity(turnId: string, suggestion: string): OrchestrationThreadActivity {
  return {
    id: EventId.make("prompt-suggestion:thread-1:latest"),
    kind: "prompt.suggestion",
    tone: "info",
    summary: "Suggested next prompt",
    payload: { suggestion },
    turnId: TurnId.make(turnId),
    createdAt: "2026-11-13T00:00:00.000Z",
  };
}

const toolActivity: OrchestrationThreadActivity = {
  id: EventId.make("tool-1"),
  kind: "tool.completed",
  tone: "tool",
  summary: "Ran command",
  payload: { suggestion: "not this one" },
  turnId: TURN,
  createdAt: "2026-11-13T00:00:01.000Z",
};

describe("derivePromptSuggestion", () => {
  it("offers the suggestion of the latest completed turn", () => {
    expect(
      derivePromptSuggestion({
        activities: [suggestionActivity("turn-2", "run the tests"), toolActivity],
        latestTurn: { turnId: TURN, state: "completed" },
      }),
    ).toEqual({ turnId: TURN, text: "run the tests" });
  });

  it("hides a suggestion of an older turn once a newer one exists", () => {
    expect(
      derivePromptSuggestion({
        activities: [suggestionActivity("turn-1", "run the tests")],
        latestTurn: { turnId: TURN, state: "completed" },
      }),
    ).toBeNull();
  });

  it("offers nothing while the latest turn runs or after it failed or was stopped", () => {
    const activities = [suggestionActivity("turn-2", "run the tests")];
    for (const state of ["running", "interrupted", "error"] as const) {
      expect(
        derivePromptSuggestion({ activities, latestTurn: { turnId: TURN, state } }),
      ).toBeNull();
    }
  });

  it("offers nothing without a turn, activities or text", () => {
    expect(
      derivePromptSuggestion({
        activities: [suggestionActivity("turn-2", "x")],
        latestTurn: null,
      }),
    ).toBeNull();
    expect(
      derivePromptSuggestion({
        activities: undefined,
        latestTurn: { turnId: TURN, state: "completed" },
      }),
    ).toBeNull();
    expect(
      derivePromptSuggestion({
        activities: [suggestionActivity("turn-2", "   ")],
        latestTurn: { turnId: TURN, state: "completed" },
      }),
    ).toBeNull();
  });
});
