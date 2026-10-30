import {
  AgentControlAutomationId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationDefinitionAfterUpdateInput,
  automationDefinitionFromCreateInput,
} from "./automationToolInput.ts";

const create = {
  requestId: AgentControlRequestId.make("request-1"),
  projectId: ProjectId.make("project-1"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  title: "Check CI",
  prompt: "Check CI and continue.",
  model: "sonnet",
  options: [],
  runtimeMode: "approval-required" as const,
  envMode: "worktree" as const,
  baseRef: "main",
  schedule: { kind: "once" as const, runAt: "2099-01-01T00:00:00.000Z" },
};

describe("automation tool input", () => {
  it("runs into an existing chat when the create names one", () => {
    expect(automationDefinitionFromCreateInput(create).execution).not.toHaveProperty("target");
    expect(
      automationDefinitionFromCreateInput({ ...create, targetThreadId: ThreadId.make("thread-ci") })
        .execution.target,
    ).toEqual({ kind: "thread", threadId: "thread-ci" });
  });

  it("keeps, replaces or clears the chat on an update, and never keeps run without asking", () => {
    const current = {
      definition: {
        ...automationDefinitionFromCreateInput({
          ...create,
          targetThreadId: ThreadId.make("thread-ci"),
        }),
        runPolicy: "run-without-asking" as const,
      },
    };
    const update = {
      requestId: AgentControlRequestId.make("request-2"),
      automationId: AgentControlAutomationId.make("automation-1"),
      expectedRevision: 1,
    };
    const kept = automationDefinitionAfterUpdateInput(current, { ...update, title: "CI" });
    expect(kept.execution).toMatchObject({
      title: "CI",
      baseRef: "main",
      target: { kind: "thread", threadId: "thread-ci" },
    });
    expect(kept).not.toHaveProperty("runPolicy");
    expect(
      automationDefinitionAfterUpdateInput(current, {
        ...update,
        targetThreadId: ThreadId.make("thread-other"),
      }).execution.target,
    ).toEqual({ kind: "thread", threadId: "thread-other" });
    expect(
      automationDefinitionAfterUpdateInput(current, { ...update, targetThreadId: null }).execution,
    ).not.toHaveProperty("target");
  });
});
