import {
  AgentControlActionPlan,
  AgentControlIntegrationId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { pullRequestWatchPlan } from "./Mcp/controlPlans.ts";
import {
  agentControlPromptSummaryForPlan,
  agentControlRiskTagsForPlan,
} from "./proposalPresentation.ts";
import { isRoutineAgentControlAction } from "./routineActions.ts";

const caller = ThreadId.make("thread-caller");
const child = ThreadId.make("thread-child");
const request = AgentControlRequestId.make("request-watch");

describe("pull request watch plans", () => {
  it("watch the caller's own chat unless the agent names another", () => {
    expect(pullRequestWatchPlan({ requestId: request }, caller, true)).toEqual({
      kind: "pullRequestWatch",
      threadId: caller,
      watching: true,
    });
    expect(
      pullRequestWatchPlan(
        { requestId: request, threadId: child, url: "https://github.com/o/r/pull/34" },
        caller,
        false,
      ),
    ).toEqual({
      kind: "pullRequestWatch",
      threadId: child,
      url: "https://github.com/o/r/pull/34",
      watching: false,
    });
  });

  it("run as routine requests of a provider session only", () => {
    const plan = pullRequestWatchPlan({ requestId: request, number: 34 }, caller, true);
    expect(
      isRoutineAgentControlAction(
        {
          kind: "provider-session",
          threadId: caller,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        plan,
      ),
    ).toBe(true);
    expect(
      isRoutineAgentControlAction(
        {
          kind: "external-integration",
          integrationId: AgentControlIntegrationId.make("integration-1"),
          projectId: ProjectId.make("project-1"),
          runtimeMode: "approval-required",
          envMode: "worktree",
        },
        plan,
      ),
    ).toBe(false);
  });

  it("carry no risk tags and say which pull request and chat they are for", () => {
    const watch = pullRequestWatchPlan({ requestId: request, number: 34 }, caller, true);
    expect(agentControlRiskTagsForPlan(watch)).toEqual([]);
    expect(agentControlPromptSummaryForPlan(watch)).toBe(
      "Watch pull request #34 for thread thread-caller",
    );
    expect(
      agentControlPromptSummaryForPlan(pullRequestWatchPlan({ requestId: request }, caller, false)),
    ).toBe("Stop watching the pull request for thread thread-caller");
    expect(
      agentControlPromptSummaryForPlan(
        pullRequestWatchPlan(
          { requestId: request, url: "https://github.com/o/r/pull/34" },
          caller,
          true,
        ),
      ),
    ).toBe("Watch pull request https://github.com/o/r/pull/34 for thread thread-caller");
  });

  it("take no Auto-fix CI switch and only web addresses", () => {
    const decode = Schema.decodeUnknownExit(AgentControlActionPlan);
    expect(
      decode({ kind: "pullRequestWatch", threadId: caller, watching: true, autoFix: true })._tag,
    ).toBe("Failure");
    expect(
      decode({ kind: "pullRequestWatch", threadId: caller, url: "file:///etc", watching: true })
        ._tag,
    ).toBe("Failure");
    expect(
      decode({ kind: "pullRequestWatch", threadId: caller, number: 0, watching: true })._tag,
    ).toBe("Failure");
  });
});
