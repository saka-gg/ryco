import { describe, expect, it } from "vite-plus/test";
import {
  OrchestrationMessageBackgroundTaskError,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";

import { foldSubagentActivities } from "./subagentRuntime.ts";
import {
  describeSubagentMessageFailure,
  subagentMessageIdentity,
  subagentMessageRequest,
} from "./subagentMessage.ts";

let sequence = 0;
function agentRow(kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: { agentKind: "agent", ...payload },
    turnId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, sequence)).toISOString(),
  } as unknown as OrchestrationThreadActivity;
}

/** A Claude subagent that runtime rt-1 reported running and able to read messages. */
const started = (taskId: string, overrides: Record<string, unknown> = {}) =>
  agentRow("task.started", {
    taskId,
    taskType: "local_agent",
    runtimeSessionId: "rt-1",
    canMessage: true,
    ...overrides,
  });

const identityAfter = (
  rows: ReadonlyArray<OrchestrationThreadActivity>,
  currentRuntimeSessionId: string | null = "rt-1",
) => {
  const [agent] = foldSubagentActivities(rows, { sessionLive: true });
  return agent ? subagentMessageIdentity(agent, currentRuntimeSessionId) : undefined;
};

describe("subagentMessageIdentity", () => {
  it("reaches a running agent its provider flagged, on the current runtime", () => {
    expect(identityAfter([started("agent-1")])).toEqual({
      taskId: "agent-1",
      runtimeSessionId: "rt-1",
      attempt: 0,
    });
  });

  it("offers nothing to an agent that can't read messages, has settled or ran elsewhere", () => {
    expect(identityAfter([started("agent-2", { canMessage: false })])).toBeNull();
    expect(
      identityAfter([agentRow("task.started", { taskId: "agent-3", runtimeSessionId: "rt-1" })]),
    ).toBeNull();
    expect(
      identityAfter([
        started("agent-4"),
        agentRow("task.completed", { taskId: "agent-4", status: "completed" }),
      ]),
    ).toBeNull();
    expect(identityAfter([started("agent-5")], "rt-2")).toBeNull();
  });
});

describe("subagentMessageRequest", () => {
  it("names the exact task activation the node checks", () => {
    expect(
      subagentMessageRequest(
        ThreadId.make("thread-1"),
        { taskId: "agent-1", runtimeSessionId: "rt-1", attempt: 0 },
        "Skip the docs",
      ),
    ).toEqual({
      threadId: "thread-1",
      taskId: "agent-1",
      text: "Skip the docs",
      expected: { runtimeSessionId: "rt-1", attempt: 0 },
    });
  });
});

describe("describeSubagentMessageFailure", () => {
  it("explains the node's reasons and keeps other messages", () => {
    expect(
      describeSubagentMessageFailure(
        new OrchestrationMessageBackgroundTaskError({
          reason: "task-ended",
          threadId: "thread-1",
          taskId: "agent-1",
        }),
      ),
    ).toBe("This agent already finished, so it can't read your message.");
    expect(describeSubagentMessageFailure(new Error("Socket closed"))).toBe("Socket closed");
    expect(describeSubagentMessageFailure(null)).toBe("Could not send your message.");
  });
});
