import { describe, expect, it } from "vite-plus/test";

import type { ThreadSession } from "../threads/types.ts";
import {
  agentActivityText,
  agentToolHint,
  elapsedBetween,
  formatElapsedSeconds,
  isThreadAgentSessionLive,
  settledDuration,
  SUBAGENT_STATUS_TEXT,
} from "./subagentRoster.ts";
import type { RuntimeSubagent } from "./subagentRuntime.ts";

function agent(id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title: `Task for ${id}`,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    runtimeSessionId: null,
    canStop: false,
    canMessage: false,
    recentActivity: [],
    firstSeenAt: "2026-08-10T10:00:00.000Z",
    spawnTurnId: null,
    startedAt: "2026-08-10T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  };
}

function session(overrides: Partial<ThreadSession>): ThreadSession {
  return {
    provider: "codex",
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  } as ThreadSession;
}

describe("isThreadAgentSessionLive", () => {
  it("is live while the provider session runs or is ready", () => {
    expect(isThreadAgentSessionLive(session({ status: "running" }))).toBe(true);
    expect(isThreadAgentSessionLive(session({ status: "ready" }))).toBe(true);
  });

  it("is dead without a session, or once it closed, stopped, was interrupted or failed", () => {
    expect(isThreadAgentSessionLive(null)).toBe(false);
    expect(isThreadAgentSessionLive(undefined)).toBe(false);
    expect(isThreadAgentSessionLive(session({ status: "closed" }))).toBe(false);
    for (const orchestrationStatus of ["stopped", "interrupted", "error"] as const) {
      expect(isThreadAgentSessionLive(session({ orchestrationStatus }))).toBe(false);
    }
  });
});

describe("SUBAGENT_STATUS_TEXT", () => {
  it("names every status that a dot and a clock alone cannot say", () => {
    expect(SUBAGENT_STATUS_TEXT.running).toEqual({ label: "Running", word: null });
    expect(SUBAGENT_STATUS_TEXT.completed).toEqual({ label: "Completed", word: null });
    expect(SUBAGENT_STATUS_TEXT.idle).toEqual({ label: "Idle · resumable", word: "Idle" });
    expect(SUBAGENT_STATUS_TEXT.cancelled.word).toBe("Stopped");
  });
});

describe("formatElapsedSeconds", () => {
  it("reads seconds, then minutes, then hours", () => {
    expect(formatElapsedSeconds(-4)).toBe("0s");
    expect(formatElapsedSeconds(42.9)).toBe("42s");
    expect(formatElapsedSeconds(65)).toBe("1m 05s");
    expect(formatElapsedSeconds(3 * 3600 + 7 * 60 + 12)).toBe("3h 07m");
  });
});

describe("elapsedBetween", () => {
  it("measures to an end instant, or to now when there is none", () => {
    expect(elapsedBetween("2026-08-10T10:00:00.000Z", "2026-08-10T10:01:30.000Z")).toBe("1m 30s");
    expect(
      elapsedBetween("2026-08-10T10:00:00.000Z", null, Date.parse("2026-08-10T10:00:12.000Z")),
    ).toBe("12s");
  });

  it("is empty for unparseable instants", () => {
    expect(elapsedBetween("not a date", null)).toBe("");
  });
});

describe("settledDuration", () => {
  it("prefers the provider's duration over activity timestamps", () => {
    expect(
      settledDuration(
        agent("a", {
          status: "completed",
          usage: { totalTokens: 10, durationMs: 9_500 },
          completedAt: "2026-08-10T10:05:00.000Z",
        }),
      ),
    ).toBe("9s");
    expect(
      settledDuration(agent("b", { status: "completed", completedAt: "2026-08-10T10:00:40.000Z" })),
    ).toBe("40s");
    expect(settledDuration(agent("c", { status: "completed" }))).toBeNull();
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
    expect(agentActivityText(agent("a", { progress: "Reading", error: "Earlier failure" }))).toBe(
      "Reading",
    );
    expect(agentActivityText(agent("b", { lastToolName: "Grep" }))).toBe("Using Grep");
    expect(agentActivityText(agent("c", { status: "waiting" }))).toBeNull();
  });

  it("leads settled rows with the outcome", () => {
    expect(
      agentActivityText(
        agent("a", { status: "failed", error: "Boom", result: "Partial", progress: "Reading" }),
      ),
    ).toBe("Boom");
    expect(agentActivityText(agent("b", { status: "completed", result: "All good" }))).toBe(
      "All good",
    );
    expect(
      agentActivityText(agent("c", { status: "completed", lastToolName: "StructuredOutput" })),
    ).toBe("Delivered result");
  });
});
