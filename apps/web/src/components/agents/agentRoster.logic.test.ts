import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  agentActivityText,
  agentToolHint,
  elapsedBetween,
  formatElapsedSeconds,
  settledDuration,
} from "./agentRoster.logic";
import { makeRuntimeAgent } from "./agentRosterTestFixtures";

describe("formatElapsedSeconds", () => {
  it("reads seconds, then minutes, then hours", () => {
    expect(formatElapsedSeconds(-4)).toBe("0s");
    expect(formatElapsedSeconds(42.9)).toBe("42s");
    expect(formatElapsedSeconds(65)).toBe("1m 05s");
    expect(formatElapsedSeconds(3 * 3600 + 7 * 60 + 12)).toBe("3h 07m");
  });
});

describe("elapsedBetween", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("measures to an end instant, or to now when there is none", () => {
    expect(elapsedBetween("2026-08-10T10:00:00.000Z", "2026-08-10T10:01:30.000Z")).toBe("1m 30s");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T10:00:12.000Z"));
    expect(elapsedBetween("2026-08-10T10:00:00.000Z", null)).toBe("12s");
  });

  it("is empty for unparseable instants", () => {
    expect(elapsedBetween("not a date", null)).toBe("");
  });
});

describe("settledDuration", () => {
  it("prefers the provider's duration over activity timestamps", () => {
    expect(
      settledDuration(
        makeRuntimeAgent("a", {
          status: "completed",
          usage: { totalTokens: 10, durationMs: 9_500 },
          completedAt: "2026-08-10T10:05:00.000Z",
        }),
      ),
    ).toBe("9s");
    expect(
      settledDuration(
        makeRuntimeAgent("b", { status: "completed", completedAt: "2026-08-10T10:00:40.000Z" }),
      ),
    ).toBe("40s");
    expect(settledDuration(makeRuntimeAgent("c", { status: "completed" }))).toBeNull();
  });
});

describe("agentToolHint", () => {
  it("maps the workflow result tool to result language", () => {
    expect(agentToolHint("StructuredOutput", true)).toBe("Delivering result");
    expect(agentToolHint("structured_output", false)).toBe("Delivered result");
    expect(agentToolHint("Bash", true)).toBe("Using Bash");
    expect(agentToolHint("Bash", false)).toBe("Bash");
  });
});

describe("agentActivityText", () => {
  it("leads live rows with what is happening now", () => {
    expect(
      agentActivityText(makeRuntimeAgent("a", { progress: "Reading", error: "Earlier failure" })),
    ).toBe("Reading");
    expect(agentActivityText(makeRuntimeAgent("b", { lastToolName: "Grep" }))).toBe("Using Grep");
    expect(agentActivityText(makeRuntimeAgent("c", { status: "waiting" }))).toBeNull();
  });

  it("leads settled rows with the outcome", () => {
    expect(
      agentActivityText(
        makeRuntimeAgent("a", {
          status: "failed",
          error: "Boom",
          result: "Partial",
          progress: "Reading",
        }),
      ),
    ).toBe("Boom");
    expect(
      agentActivityText(makeRuntimeAgent("b", { status: "completed", result: "All good" })),
    ).toBe("All good");
    expect(
      agentActivityText(
        makeRuntimeAgent("c", { status: "completed", lastToolName: "StructuredOutput" }),
      ),
    ).toBe("Delivered result");
  });
});
