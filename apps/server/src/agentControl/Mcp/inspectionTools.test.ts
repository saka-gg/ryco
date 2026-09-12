import {
  AGENT_CONTROL_CAPABILITIES,
  OrchestrationThreadShell,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  OrchestrationProjectShell,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AgentControlMcpToolDeps, AgentControlMcpTools } from "./tools.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { withInspectionTools } from "./inspectionTools.ts";

const now = "2026-09-12T00:00:00.000Z";
const shell = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: "child",
  projectId: "project",
  title: "Child",
  modelSelection: { instanceId: "codex", model: "test" },
  runtimeMode: "auto",
  interactionMode: "default",
  branch: "codex/test",
  worktreePath: "/worktree",
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: "project",
  title: "Project",
  workspaceRoot: "/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});
const page = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
const session = {
  sessionId: "lease",
  issuedAt: now,
  threadId: ThreadId.make("parent"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime"),
  grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.read],
  injectionMode: "codex-http",
} as AgentControlSessionRecord;
const base: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: (_session, _name, args) =>
    Effect.succeed({
      content: [],
      structuredContent: { ...(args as object), messages: [{ text: "Completed" }] },
    }),
};
const fixture = (overrides: Partial<AgentControlMcpToolDeps> = {}) => {
  const projections = {
    getThreadShellById: vi.fn(() => Effect.succeed(Option.some(shell))),
    getProjectShellById: vi.fn(() => Effect.succeed(Option.some(project))),
    getThreadWindow: vi.fn(() =>
      Effect.succeed({
        thread: { ...shell, messages: [], activities: [], proposedPlans: [], checkpoints: [] },
        history: { messages: page, activities: page, proposedPlans: page, checkpoints: page },
      }),
    ),
    getThreadHistoryPage: vi.fn(),
  };
  const deps = {
    policy: {
      isEnabled: Effect.succeed(true),
      requireEnabled: () => Effect.void,
      authorize: () => Effect.void,
    },
    projections,
    ...overrides,
  } as unknown as AgentControlMcpToolDeps;
  return { projections, deps, tools: withInspectionTools(base, deps) };
};
const call = (tools: AgentControlMcpTools, name: string, args: unknown) =>
  Effect.runPromise(tools.callTool(session, name, args));

describe("private thread inspection", () => {
  it("discovers inspection tools before a turn starts and hides them from ungranted sessions", async () => {
    const { tools } = fixture();
    expect((await Effect.runPromise(tools.descriptorsFor(session))).map((t) => t.name)).toContain(
      "ryco_wait_threads",
    );
    expect(
      await Effect.runPromise(tools.descriptorsFor({ ...session, grantedCapabilities: [] })),
    ).toEqual([]);
  });
  it("reads project preferences with a revision, without exposing the workspace root", async () => {
    const result = await call(fixture().tools, "ryco_read_project", { projectId: "project" });
    expect(result.structuredContent).toMatchObject({
      projectId: "project",
      updatedAt: now,
      scripts: [],
    });
    expect(JSON.stringify(result)).not.toContain("/workspace");
  });
  it("returns model and pending-input state without hydrating all history", async () => {
    const { tools, projections } = fixture();
    const result = await call(tools, "ryco_inspect_thread", { threadId: "child", section: "info" });
    expect(result.structuredContent).toMatchObject({
      modelSelection: { instanceId: "codex", model: "test" },
      hasPendingUserInput: false,
    });
    expect(projections.getThreadWindow).not.toHaveBeenCalled();
  });
  it("uses the shared subagent projection and redacts transcript credentials", async () => {
    const { tools, projections } = fixture();
    const activities = [
      {
        id: "start",
        kind: "subagent.started",
        tone: "info",
        summary: "Started",
        turnId: null,
        createdAt: now,
        payload: { itemType: "subagent", status: "running", subagent: { subagentId: "worker" } },
      },
      {
        id: "message",
        kind: "agent.message",
        tone: "info",
        summary: "Reply",
        turnId: null,
        createdAt: now,
        payload: {
          itemType: "assistant_message",
          subagentId: "worker",
          providerItemId: "reply",
          text: "Result: password=do-not-leak",
        },
      },
    ];
    projections.getThreadWindow.mockReturnValue(
      Effect.succeed({
        thread: { ...shell, messages: [], activities, proposedPlans: [], checkpoints: [] },
        history: {
          messages: page,
          activities: { ...page, hasMoreBefore: true },
          proposedPlans: page,
          checkpoints: page,
        },
      }) as never,
    );
    const result = await call(tools, "ryco_inspect_thread", {
      threadId: "child",
      section: "agents",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      partial: true,
      items: [{ key: "subagent:worker" }],
    });
    expect(JSON.stringify(result)).toContain("Result:");
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });
  it("waits on background work and returns a bounded immediate snapshot", async () => {
    const { tools, projections } = fixture();
    projections.getThreadShellById.mockReturnValue(
      Effect.succeed(Option.some({ ...shell, backgroundLiveness: "working" })),
    );
    expect(
      (await call(tools, "ryco_wait_threads", { threadIds: ["child"], timeoutMs: 0 }))
        .structuredContent,
    ).toMatchObject({ timedOut: true, threads: [{ threadId: "child" }] });
    expect(
      (await call(fixture().tools, "ryco_wait_threads", { threadIds: ["child"], timeoutMs: 0 }))
        .structuredContent,
    ).toMatchObject({ timedOut: false });
  });
  it("accepts longer requested waits while bounding the server wait", async () => {
    expect(
      (
        await call(fixture().tools, "ryco_wait_threads", {
          threadIds: ["child"],
          timeoutMs: 60000,
        })
      ).structuredContent,
    ).toMatchObject({ timedOut: false });
  });
  it("does not report an accepted running turn as completed before session startup", async () => {
    const { tools, projections } = fixture();
    projections.getThreadShellById.mockReturnValue(
      Effect.succeed(
        Option.some({
          ...shell,
          latestTurn: {
            turnId: "queued",
            state: "running",
            requestedAt: shell.updatedAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        } as typeof shell),
      ),
    );
    expect(
      (
        await call(tools, "ryco_wait_threads", {
          threadIds: ["child"],
          timeoutMs: 0,
        })
      ).structuredContent,
    ).toMatchObject({ timedOut: true });
  });
  it("rejects a negative wait and a policy denial before reading thread content", async () => {
    const { tools, projections } = fixture();
    expect(
      (await call(tools, "ryco_wait_threads", { threadIds: ["child"], timeoutMs: -1 })).isError,
    ).toBe(true);
    expect(projections.getThreadShellById).not.toHaveBeenCalled();
    const denied = fixture({
      policy: { authorize: () => Effect.fail(new Error("denied")) } as never,
    });
    expect(
      (await call(denied.tools, "ryco_inspect_thread", { threadId: "child", section: "info" }))
        .isError,
    ).toBe(true);
    expect(denied.projections.getThreadShellById).not.toHaveBeenCalled();
  });
  it("routes file reads to the target worktree through workspace authorization", async () => {
    const { deps } = fixture();
    const readFile = vi.fn(() => Effect.succeed({ contents: "file" }));
    const assertExistingPath = vi.fn(({ path }: { path: string }) => Effect.succeed(path));
    const tools = withInspectionTools(base, {
      ...deps,
      workspaceAccess: { assertExistingPath } as never,
      files: { readFile } as never,
    });
    await call(tools, "ryco_read_thread_file", { threadId: "child", relativePath: "README.md" });
    expect(assertExistingPath).toHaveBeenCalledWith({
      path: "/worktree",
      operation: "Agent Control file read",
    });
    expect(readFile).toHaveBeenCalledWith({ cwd: "/worktree", relativePath: "README.md" });
  });
});
