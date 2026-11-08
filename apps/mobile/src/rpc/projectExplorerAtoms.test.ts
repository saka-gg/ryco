import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  clients: new Map<string, unknown>(),
}));

// The live RPC client comes off the connection supervisor; here it is a plain
// map, so the cache runs without the native connection stack.
vi.mock("../connection/environmentApi", () => ({
  readRpcClient: (environmentId: string) => mocks.clients.get(environmentId) ?? null,
}));

import {
  clearProjectExplorerStateForEnvironment,
  issueListQuery,
  jiraProjectLinkQuery,
  refreshProjectExplorerReads,
  resetProjectExplorerAtomsForTests,
  workflowRunsQuery,
} from "./projectExplorerAtoms";
import { PullRequestNodeOfflineError } from "./pullRequestAtoms";

const ENV = "env-a" as EnvironmentId;
const CWD = "/work/app";
const PROJECT = "project-1" as ProjectId;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mocks.clients.clear();
  resetProjectExplorerAtomsForTests();
});

describe("project explorer reads", () => {
  it("reads a checkout's issues with the list's state and limit", async () => {
    const listIssues = vi.fn(async () => []);
    mocks.clients.set(ENV, { sourceControl: { listIssues } });
    const input = { environmentId: ENV, cwd: CWD, state: "open" as const, limit: 100 };
    const release = issueListQuery.watch(input);
    await flush();
    expect(listIssues).toHaveBeenCalledWith({ cwd: CWD, state: "open", limit: 100 });
    release();
  });

  it("does not read before the checkout is known", async () => {
    const listIssues = vi.fn(async () => []);
    mocks.clients.set(ENV, { sourceControl: { listIssues } });
    const release = issueListQuery.watch({
      environmentId: ENV,
      cwd: null,
      state: "open",
      limit: 1,
    });
    await flush();
    expect(listIssues).not.toHaveBeenCalled();
    release();
  });

  it("fails as offline without a live client", async () => {
    const input = { environmentId: ENV, cwd: CWD, limit: 20 };
    const release = workflowRunsQuery.watch(input);
    const result = await workflowRunsQuery.refreshAsync(workflowRunsQuery.keyOf(input));
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(PullRequestNodeOfflineError);
    release();
  });

  it("tells an unlinked project from one not read yet", async () => {
    mocks.clients.set(ENV, { atlassian: { getProjectLink: vi.fn(async () => null) } });
    const input = { environmentId: ENV, projectId: PROJECT };
    const key = jiraProjectLinkQuery.keyOf(input) as string;
    const release = jiraProjectLinkQuery.watch(input);
    await flush();
    const next = await jiraProjectLinkQuery.refreshAsync(key);
    expect(next.data).toEqual({ link: null });
    release();
  });

  it("reads a family again after a change, and forgets a node on teardown", async () => {
    const listIssues = vi.fn(async () => []);
    mocks.clients.set(ENV, { sourceControl: { listIssues } });
    const input = { environmentId: ENV, cwd: CWD, state: "open" as const, limit: 100 };
    const release = issueListQuery.watch(input);
    await flush();
    refreshProjectExplorerReads({ environmentId: ENV, scope: CWD, family: "runs" });
    await flush();
    expect(listIssues).toHaveBeenCalledTimes(1);
    refreshProjectExplorerReads({ environmentId: ENV, scope: CWD, family: "issues" });
    await flush();
    expect(listIssues).toHaveBeenCalledTimes(2);
    release();
    clearProjectExplorerStateForEnvironment(ENV);
  });

  it("names the offline error as the screens recognise it", () => {
    expect(new PullRequestNodeOfflineError().name).toBe("PullRequestNodeOfflineError");
  });
});
