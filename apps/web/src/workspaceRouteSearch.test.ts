import {
  EnvironmentId,
  MessageId,
  type OrchestrationThreadActivity,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentPanelRoster,
  canonicalSubagentIdentityKey,
  deriveThreadAgentPanelModel,
  deriveThreadSubagents,
} from "./threadWorkspaceViewModel";

import {
  buildCloseWorkspacePanelSearch,
  buildOpenAgentsSearch,
  buildOpenAgentsWorkflowSearch,
  buildOpenPullRequestSearch,
  buildOpenRenderSearch,
  buildOpenReviewSearch,
  carryWorkspaceSearchToThread,
  formatWorkspacePullRequestReveal,
  formatWorkspaceRenderKey,
  parseWorkspacePullRequestReveal,
  parseWorkspaceRenderKey,
  parseWorkspaceRouteSearch,
  stripThreadScopedWorkspaceSearch,
  stripWorkspacePanelSearchParams,
  stripWorkspaceRevealSearch,
  workspaceAgentKeyForRuntimeAgent,
} from "./workspaceRouteSearch";

describe("workspace route search", () => {
  it("pins a change request only on the pull request tab and clears it everywhere else", () => {
    const pinned = buildOpenPullRequestSearch({ other: "kept" }, 42);
    expect(pinned).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePr: 42,
    });
    expect(buildOpenPullRequestSearch({}, -1).workspacePr).toBeUndefined();
    expect(buildOpenReviewSearch(pinned)).toMatchObject({
      workspaceTab: "review",
      diff: "1",
      workspacePr: undefined,
    });
    expect(buildCloseWorkspacePanelSearch(pinned)).toMatchObject({
      other: "kept",
      workspaceOpen: undefined,
      workspaceTab: undefined,
      workspacePr: undefined,
    });
  });

  it("drops a pin, and nothing else, when the search follows to another thread", () => {
    const carried = stripThreadScopedWorkspaceSearch({
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePr: 42,
      messageId: "m-1",
    });
    expect(carried).toEqual({ workspaceOpen: "1", workspaceTab: "pullRequest", messageId: "m-1" });
  });

  it("leaves a page tab behind for the launcher when the search follows to another thread", () => {
    const carried = stripThreadScopedWorkspaceSearch(
      buildOpenRenderSearch({ messageId: "m-1" }, "render-message:thread-chart-html"),
    );
    expect(carried).toMatchObject({ workspaceOpen: "1", messageId: "m-1" });
    expect(carried.workspaceTab).toBeUndefined();
    expect("workspaceRender" in carried).toBe(false);
  });

  it("keeps the page tab and pin within the thread, and drops them for any other", () => {
    const here = {
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-1"),
    };
    const search = {
      ...buildOpenRenderSearch({ other: "kept" }, "render-message:thread-chart-html"),
      workspacePr: 42,
    };
    // A message hit in the thread the panel shows leaves the panel alone.
    expect(carryWorkspaceSearchToThread(search, { from: here, to: { ...here } })).toBe(search);
    for (const to of [
      { ...here, threadId: ThreadId.make("thread-2") },
      // The same thread id in another environment is another thread.
      { ...here, environmentId: EnvironmentId.make("environment-remote") },
    ]) {
      const carried = carryWorkspaceSearchToThread(search, { from: here, to });
      expect(carried).toMatchObject({ other: "kept", workspaceOpen: "1" });
      expect(carried.workspaceTab).toBeUndefined();
      expect("workspaceRender" in carried || "workspacePr" in carried).toBe(false);
    }
    // From a draft (no thread yet), nothing is known to belong to the target.
    expect(
      "workspaceRender" in carryWorkspaceSearchToThread(search, { from: null, to: here }),
    ).toBe(false);
  });
});

describe("page tab search", () => {
  it("round-trips a render key, splitting at the attachment id's colon", () => {
    const target = {
      messageId: MessageId.make("assistant:turn:7"),
      attachmentId: "t-1_chart-html",
    };
    const key = formatWorkspaceRenderKey(target);
    expect(key).toBe("assistant:turn:7:t-1_chart-html");
    expect(parseWorkspaceRenderKey(key)).toEqual(target);
  });

  it.each([
    ["no separator", "message"],
    ["no message", ":attachment"],
    ["a blank message", "  :attachment"],
    ["no attachment", "message:"],
    ["an attachment id outside the id alphabet", "message:../attachment"],
    ["an overlong attachment id", `message:${"a".repeat(129)}`],
  ])("names no render with %s", (_label, key) => {
    expect(parseWorkspaceRenderKey(key)).toBeNull();
  });

  it("opens the page tab and clears every other panel key", () => {
    const search = buildOpenRenderSearch(
      { other: "kept", diff: "1", workspaceTab: "review", workspacePr: 3 },
      "message:attachment",
    );
    expect(search).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "render",
      workspaceRender: "message:attachment",
      diff: undefined,
      workspacePr: undefined,
    });
    expect(buildCloseWorkspacePanelSearch(search)).toMatchObject({
      workspaceTab: undefined,
      workspaceRender: undefined,
    });
    // Another tab drops the page key.
    expect(buildOpenReviewSearch(search).workspaceRender).toBeUndefined();
  });

  it("parses a page tab only with a render it can name", () => {
    expect(
      parseWorkspaceRouteSearch({
        workspaceTab: "render",
        workspaceRender: " message:attachment ",
      }),
    ).toEqual({
      workspaceOpen: "1",
      workspaceTab: "render",
      workspaceRender: "message:attachment",
    });
    expect(parseWorkspaceRouteSearch({ workspaceTab: "render" })).toEqual({});
    expect(
      parseWorkspaceRouteSearch({ workspaceTab: "render", workspaceRender: "message:a/b" }),
    ).toEqual({});
    // Other tabs never carry a page key.
    expect(
      parseWorkspaceRouteSearch({ workspaceTab: "files", workspaceRender: "message:attachment" }),
    ).toEqual({ workspaceOpen: "1", workspaceTab: "files" });
  });
});

describe("one-shot reveal search", () => {
  it("round-trips a pull request reveal", () => {
    expect(formatWorkspacePullRequestReveal({ kind: "checks" })).toBe("checks");
    expect(formatWorkspacePullRequestReveal({ kind: "job", job: "CI/lint" })).toBe("job:CI/lint");
    for (const reveal of [
      { kind: "checks" } as const,
      { kind: "job", job: "52004433871" } as const,
      // A `workflow/name` param may itself hold a colon.
      { kind: "job", job: "CI: nightly/Test · web" } as const,
    ]) {
      expect(parseWorkspacePullRequestReveal(formatWorkspacePullRequestReveal(reveal))).toEqual(
        reveal,
      );
    }
  });

  it.each([
    ["an unknown kind", "files"],
    ["an empty job", "job:"],
    ["a blank job", "job:   "],
    ["an overlong job", `job:${"a".repeat(129)}`],
    ["a different case", "Checks"],
  ])("names no reveal with %s", (_label, key) => {
    expect(parseWorkspacePullRequestReveal(key)).toBeNull();
  });

  it("accepts a job of the page param's maximum length", () => {
    const job = "a".repeat(128);
    expect(parseWorkspacePullRequestReveal(`job:${job}`)).toEqual({ kind: "job", job });
  });

  it("writes a reveal with the pull request tab and clears it from every other builder", () => {
    const search = buildOpenPullRequestSearch({ other: "kept" }, 42, { kind: "job", job: "7" });
    expect(search).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePr: 42,
      workspacePrReveal: "job:7",
    });
    expect(buildOpenPullRequestSearch({}, undefined, { kind: "checks" })).toMatchObject({
      workspacePr: undefined,
      workspacePrReveal: "checks",
    });
    // An unusable job writes no reveal rather than a broken one.
    expect(
      buildOpenPullRequestSearch({}, 42, { kind: "job", job: "" }).workspacePrReveal,
    ).toBeUndefined();
    // Reopening the tab without a reveal drops a pending one.
    expect(buildOpenPullRequestSearch(search, 42).workspacePrReveal).toBeUndefined();
    expect(buildOpenReviewSearch(search).workspacePrReveal).toBeUndefined();
    expect(buildCloseWorkspacePanelSearch(search).workspacePrReveal).toBeUndefined();
    expect("workspacePrReveal" in stripWorkspacePanelSearchParams(search)).toBe(false);
  });

  it("focuses a workflow on the Agents tab and clears it from every other builder", () => {
    const search = buildOpenAgentsWorkflowSearch({ other: "kept", workspacePr: 3 }, " wf-audit ");
    expect(search).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "agents",
      workspaceAgentsWorkflow: "wf-audit",
      workspaceAgentKey: undefined,
      workspacePr: undefined,
    });
    expect(
      buildOpenAgentsWorkflowSearch({}, "w".repeat(257)).workspaceAgentsWorkflow,
    ).toBeUndefined();
    expect(buildOpenAgentsSearch(search).workspaceAgentsWorkflow).toBeUndefined();
    expect(buildOpenPullRequestSearch(search).workspaceAgentsWorkflow).toBeUndefined();
  });

  it("strips only the reveal keys once consumed", () => {
    const stripped = stripWorkspaceRevealSearch({
      ...buildOpenPullRequestSearch({ other: "kept" }, 42, { kind: "checks" }),
      workspaceAgentsWorkflow: "wf-audit",
    });
    expect(stripped).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePr: 42,
    });
    expect(stripped.workspacePrReveal).toBeUndefined();
    expect(stripped.workspaceAgentsWorkflow).toBeUndefined();
  });

  it("parses each reveal only on its own tab", () => {
    expect(
      parseWorkspaceRouteSearch({
        workspaceTab: "pullRequest",
        workspacePrReveal: " job:CI/lint ",
        workspaceAgentsWorkflow: "wf-audit",
      }),
    ).toEqual({
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePrReveal: "job:CI/lint",
    });
    expect(
      parseWorkspaceRouteSearch({ workspaceTab: "pullRequest", workspacePrReveal: "job:" }),
    ).toEqual({ workspaceOpen: "1", workspaceTab: "pullRequest" });
    expect(
      parseWorkspaceRouteSearch({
        workspaceTab: "agents",
        workspaceAgentsWorkflow: "wf-audit",
        workspacePrReveal: "checks",
      }),
    ).toEqual({ workspaceOpen: "1", workspaceTab: "agents", workspaceAgentsWorkflow: "wf-audit" });
    expect(
      parseWorkspaceRouteSearch({
        workspaceTab: "agents",
        workspaceAgentsWorkflow: "w".repeat(257),
      }),
    ).toEqual({ workspaceOpen: "1", workspaceTab: "agents" });
    expect(
      parseWorkspaceRouteSearch({
        workspaceTab: "agent",
        workspaceAgentKey: "subagent:a",
        workspaceAgentsWorkflow: "wf",
      }),
    ).toEqual({ workspaceOpen: "1", workspaceTab: "agent", workspaceAgentKey: "subagent:a" });
  });

  it("drops the reveals when the search follows to another thread", () => {
    const carried = stripThreadScopedWorkspaceSearch({
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePrReveal: "checks",
      workspaceAgentsWorkflow: "wf-audit",
    });
    expect(carried).toEqual({ workspaceOpen: "1", workspaceTab: "pullRequest" });
  });

  it("keys a runtime subagent's Agents row", () => {
    expect(workspaceAgentKeyForRuntimeAgent("agent-7")).toBe("subagent:agent-7");
  });

  it("keeps an already-prefixed transcript-backed agent key unchanged", () => {
    expect(workspaceAgentKeyForRuntimeAgent("subagent:abc")).toBe("subagent:abc");
  });

  it("keys a transcript-backed runtime agent so the Agents tab selects it", () => {
    const activities = [
      {
        id: "activity-1",
        tone: "info",
        kind: "tool.started",
        summary: "tool.started",
        turnId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          providerItemId: "collab-reviewer",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "collab-reviewer",
              tool: "spawnAgent",
              prompt: "You are a reviewer.",
              receiverThreadIds: ["child-reviewer"],
              status: "inProgress",
            },
          },
        },
      },
    ] as unknown as ReadonlyArray<OrchestrationThreadActivity>;
    const model = deriveThreadAgentPanelModel({
      activities,
      transcriptSubagents: deriveThreadSubagents(activities),
      sessionLive: true,
    });
    const agent = agentPanelRoster(model)[0]!;
    expect(agent.id.startsWith("subagent:")).toBe(true);
    const key = workspaceAgentKeyForRuntimeAgent(agent.id);
    expect(canonicalSubagentIdentityKey(key)).toBe(canonicalSubagentIdentityKey(agent.id));
  });
});
