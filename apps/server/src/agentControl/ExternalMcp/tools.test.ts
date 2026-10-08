import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_EXTERNAL_MCP_TOOLS,
  AgentControlIntegrationId,
  AgentControlProposal,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  type AgentControlCapability,
  type AgentControlExternalIntegration,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeExternalMcpTools } from "./tools.ts";

const now = "2026-10-08T00:00:00.000Z";
const integrationId = AgentControlIntegrationId.make("integration-1");
const T = AGENT_CONTROL_EXTERNAL_MCP_TOOLS;
const C = AGENT_CONTROL_CAPABILITIES;

const threadShell = (id: string, projectId: string) =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id,
    projectId,
    title: id,
    modelSelection: { instanceId: "codex", model: "test" },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: `/worktrees/${id}`,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
const projectShell = (id: string) =>
  Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id,
    title: id,
    workspaceRoot: `/workspaces/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  });

const allowedThread = threadShell("allowed-thread", "allowed");
const hiddenThread = threadShell("hidden-thread", "hidden");
const threads = [allowedThread, hiddenThread];
const projects = [projectShell("allowed"), projectShell("hidden")];
const page = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };

const makeIntegration = (
  capabilities: ReadonlyArray<AgentControlCapability>,
): AgentControlExternalIntegration => ({
  integrationId,
  displayName: "External",
  clientKind: "codex",
  projectScope: { kind: "selected", projectIds: [projects[0]!.id] },
  capabilities,
  rateLimitPerMinute: 60,
  activeTaskLimit: 1,
  activeTaskCount: 0,
  expiresAt: null,
  revokedAt: null,
  pairingState: "paired",
  pairingCodeExpiresAt: null,
  pairedAt: now,
  createdAt: now,
  updatedAt: now,
  lastUsedAt: null,
});

const DEFAULT_CAPABILITIES = [C.externalListProjects, C.externalCreateTask, C.externalReadTask];

const fixture = (capabilities: ReadonlyArray<AgentControlCapability>) => {
  let current = makeIntegration(capabilities);
  const integrations = {
    authorizeTool: vi.fn((input: { readonly requiredCapability?: AgentControlCapability }) =>
      input.requiredCapability !== undefined &&
      !current.capabilities.includes(input.requiredCapability)
        ? Effect.fail(new Error("capability-denied"))
        : Effect.succeed(current),
    ),
    revalidate: vi.fn(() => Effect.sync(() => current)),
  };
  const byId = <A extends { readonly id: string }>(rows: ReadonlyArray<A>, id: string) =>
    Effect.succeed(Option.fromNullishOr(rows.find((row) => row.id === id)));
  const projections = {
    getShellSnapshot: vi.fn(() => Effect.succeed({ projects, threads })),
    getThreadShellById: vi.fn((id: string) => byId(threads, id)),
    getProjectShellById: vi.fn((id: string) => byId(projects, id)),
    searchThreadMessages: vi.fn((input: { readonly projectId?: string }) =>
      Effect.succeed(
        threads
          .filter((thread) => input.projectId === undefined || thread.projectId === input.projectId)
          .map((thread) => ({
            threadId: thread.id,
            messageId: `${thread.id}-message`,
            snippet: "match",
            timestamp: now,
          })),
      ),
    ),
    getThreadWindow: vi.fn(({ threadId }: { readonly threadId: string }) =>
      Effect.succeed({
        thread: {
          ...threads.find((thread) => thread.id === threadId)!,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
        },
        history: { messages: page, activities: page, proposedPlans: page, checkpoints: page },
      }),
    ),
    getThreadHistoryPage: vi.fn(),
  };
  const proposal = (owner: string) =>
    Schema.decodeUnknownSync(AgentControlProposal)({
      proposalId: `proposal-${owner}`,
      requestId: `request-${owner}`,
      principal: {
        kind: "external-integration",
        integrationId: owner,
        label: "External",
        projectId: "allowed",
        runtimeMode: "approval-required",
        envMode: "worktree",
      },
      planVersion: 1,
      plan: {
        kind: "createThreads",
        entries: [
          {
            projectId: "allowed",
            title: "Fixture",
            prompt: "Fixture task",
            modelSelection: { instanceId: "codex", model: "fixture" },
            runtimeMode: "approval-required",
            envMode: "worktree",
          },
        ],
      },
      planDigest: "a".repeat(64),
      riskTags: [],
      promptSummary: null,
      status: "pending-user-approval",
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
      decidedAt: null,
      result: null,
    });
  const getProposal = vi.fn((proposalId: string) =>
    Effect.succeed(
      Option.some(proposalId === "proposal-other" ? proposal("other") : proposal(integrationId)),
    ),
  );
  const readFile = vi.fn(() => Effect.succeed({ contents: "file" }));
  const getFullThreadDiff = vi.fn(() => Effect.succeed({ diff: "patch" }));
  const assertExistingPath = vi.fn(({ path }: { readonly path: string }) => Effect.succeed(path));
  const workspaces = {
    list: vi.fn(() => Effect.succeed({ workspaces: [], nextCursor: null })),
    read: vi.fn(),
    revalidate: vi.fn(),
  };
  const tools = makeExternalMcpTools({
    integrations: integrations as never,
    tasks: {} as never,
    projections: projections as never,
    getProviders: Effect.succeed([]),
    proposals: { submit: vi.fn(), getProposal } as never,
    proposalEvents: { subscribe: Effect.never } as never,
    workspaces: workspaces as never,
    files: { readFile } as never,
    diffs: { getFullThreadDiff } as never,
    workspaceAccess: { assertExistingPath } as never,
  });
  const call = (name: string, args: unknown) =>
    Effect.runPromise(tools.callTool(integrationId, name, args));
  return {
    tools,
    call,
    projections,
    integrations,
    getProposal,
    readFile,
    getFullThreadDiff,
    workspaces,
    revoke: (next: ReadonlyArray<AgentControlCapability>) => {
      current = makeIntegration(next);
    },
    integration: () => current,
  };
};

const text = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  result.content[0]?.text;

describe("external Agent Control read catalog", () => {
  it("advertises read tools only for their grants and never offers terminal inspection", () => {
    const base = fixture(DEFAULT_CAPABILITIES);
    const defaults = base.tools.descriptorsFor(base.integration()).map((tool) => tool.name);
    expect(defaults).toContain(T.readControlRequest);
    expect(defaults).not.toContain(T.listThreads);
    expect(defaults).not.toContain(T.readThreadFile);

    const reader = fixture([C.externalReadThreads]);
    const descriptors = reader.tools.descriptorsFor(reader.integration());
    const names = descriptors.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([T.listThreads, T.readThread, T.searchThreads, T.inspectThread]),
    );
    expect(names).not.toContain(T.readThreadDiff);
    expect(names).not.toContain(T.listWorkspaces);
    expect(names).not.toContain(T.readControlRequest);
    const inspect = descriptors.find((tool) => tool.name === T.inspectThread)!;
    expect(JSON.stringify(inspect.inputSchema)).not.toContain("terminals");
  });

  it("refuses ungranted reads before touching projections", async () => {
    const { call, projections } = fixture(DEFAULT_CAPABILITIES);
    const result = await call(T.readThread, { threadId: allowedThread.id });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("External Agent Control request was refused.");
    expect(projections.getThreadShellById).not.toHaveBeenCalled();
  });

  it("lists only threads inside the project scope", async () => {
    const { call } = fixture([C.externalReadThreads]);
    const result = await call(T.listThreads, {});
    expect(result.structuredContent).toMatchObject({
      threads: [{ threadId: allowedThread.id }],
    });
    expect(JSON.stringify(result)).not.toContain(hiddenThread.id);
    const outside = await call(T.listThreads, { projectId: "hidden" });
    expect(text(outside)).toBe("Project not found.");
  });

  it("reports out-of-scope threads exactly like missing threads", async () => {
    const { call, projections } = fixture([C.externalReadThreads]);
    const hidden = await call(T.readThread, { threadId: hiddenThread.id });
    const missing = await call(T.readThread, { threadId: "missing" });
    expect(hidden).toEqual(missing);
    expect(text(hidden)).toBe("Thread not found.");
    expect(projections.getThreadWindow).not.toHaveBeenCalled();
    const allowed = await call(T.readThread, { threadId: allowedThread.id });
    expect(allowed.structuredContent).toMatchObject({ thread: { threadId: allowedThread.id } });
  });

  it("searches only allowed projects when no narrower target is given", async () => {
    const { call, projections } = fixture([C.externalReadThreads]);
    const result = await call(T.searchThreads, { query: "match" });
    expect(result.structuredContent).toEqual([
      expect.objectContaining({ threadId: allowedThread.id }),
    ]);
    expect(projections.searchThreadMessages.mock.calls.map(([input]) => input.projectId)).toEqual([
      "allowed",
    ]);
    expect(text(await call(T.searchThreads, { query: "match", threadId: hiddenThread.id }))).toBe(
      "Thread not found.",
    );
  });

  it("gates review inspection separately and rejects terminal output", async () => {
    const reader = fixture([C.externalReadThreads]);
    const args = { threadId: allowedThread.id };
    expect(text(await reader.call(T.inspectThread, { ...args, section: "terminals" }))).toBe(
      "Section unavailable.",
    );
    expect(text(await reader.call(T.inspectThread, { ...args, section: "review" }))).toBe(
      "Review access is not granted.",
    );
    expect(
      (await reader.call(T.inspectThread, { ...args, section: "info" })).structuredContent,
    ).toMatchObject({ threadId: allowedThread.id });
    const reviewer = fixture([C.externalReadThreads, C.externalReadReviews]);
    expect((await reviewer.call(T.inspectThread, { ...args, section: "review" })).isError).not.toBe(
      true,
    );
  });

  it("reads files only for allowed threads through workspace authorization", async () => {
    const { call, readFile } = fixture([C.externalReadFiles]);
    expect(
      text(await call(T.readThreadFile, { threadId: hiddenThread.id, relativePath: ".env" })),
    ).toBe("Thread not found.");
    expect(readFile).not.toHaveBeenCalled();
    await call(T.readThreadFile, { threadId: allowedThread.id, relativePath: "README.md" });
    expect(readFile).toHaveBeenCalledWith({
      cwd: allowedThread.worktreePath,
      relativePath: "README.md",
    });
  });

  it("reads workspaces without a caller thread and only in allowed projects", async () => {
    const { call, workspaces } = fixture([C.externalReadWorkspaces]);
    expect(text(await call(T.listWorkspaces, { projectId: "hidden" }))).toBe("Project not found.");
    expect(workspaces.list).not.toHaveBeenCalled();
    await call(T.listWorkspaces, { projectId: "allowed" });
    expect(workspaces.list).toHaveBeenCalledWith("allowed", null, undefined, undefined);
    const project = await call(T.readProject, { projectId: "allowed" });
    expect(project.structuredContent).toMatchObject({ projectId: "allowed", scripts: [] });
    expect(JSON.stringify(project)).not.toContain("/workspaces/");
  });

  it("reads review diffs only for allowed threads", async () => {
    const { call, getFullThreadDiff } = fixture([C.externalReadReviews]);
    expect(text(await call(T.readThreadDiff, { threadId: hiddenThread.id, toTurnCount: 1 }))).toBe(
      "Thread not found.",
    );
    expect(getFullThreadDiff).not.toHaveBeenCalled();
    const allowed = await call(T.readThreadDiff, { threadId: allowedThread.id, toTurnCount: 1 });
    expect(allowed.structuredContent).toEqual({ diff: "patch" });
  });

  it("refuses workspace reads outside the project scope", async () => {
    const { call, workspaces } = fixture([C.externalReadWorkspaces]);
    expect(text(await call(T.readWorkspace, { projectId: "hidden", workspaceId: "main" }))).toBe(
      "Project not found.",
    );
    expect(workspaces.read).not.toHaveBeenCalled();
  });

  it("returns control requests created by this integration only", async () => {
    const { call } = fixture(DEFAULT_CAPABILITIES);
    const own = await call(T.readControlRequest, { proposalId: `proposal-${integrationId}` });
    expect(own.structuredContent).toMatchObject({
      receipt: { proposalId: `proposal-${integrationId}`, status: "pending-user-approval" },
    });
    const other = await call(T.readControlRequest, { proposalId: "proposal-other" });
    expect(text(other)).toBe("Control request not found.");
  });

  it("ends a thread wait once the grant is revoked", async () => {
    const { call, revoke, projections } = fixture([C.externalReadThreads]);
    projections.getThreadShellById.mockImplementation(() =>
      Effect.succeed(Option.some({ ...allowedThread, backgroundLiveness: "working" })),
    );
    const pending = call(T.waitThreads, { threadIds: [allowedThread.id], timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    revoke(DEFAULT_CAPABILITIES);
    const result = await pending;
    expect(text(result)).toBe("Thread access was revoked.");
  });

  it("reports hidden threads in a wait as not found without waiting", async () => {
    const { call } = fixture([C.externalReadThreads]);
    const result = await call(T.waitThreads, { threadIds: [hiddenThread.id], timeoutMs: 10_000 });
    expect(result.structuredContent).toMatchObject({
      timedOut: false,
      threads: [{ threadId: hiddenThread.id, error: [{ text: "Thread not found." }] }],
    });
  });
});
