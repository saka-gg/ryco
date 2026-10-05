import { describe, expect, it } from "vitest";
import {
  branchNameCandidates,
  buildOverviewItems,
  compactQueryErrorMessage,
  findChangeRequestForBranch,
  resolveOverviewPullRequestNumber,
  resolveWorkflowDetailRunIds,
} from "./ChatOverviewPanel.logic";

describe("compactQueryErrorMessage", () => {
  it("returns undefined for falsy error", () => {
    expect(compactQueryErrorMessage(null)).toBeUndefined();
    expect(compactQueryErrorMessage(undefined)).toBeUndefined();
    expect(compactQueryErrorMessage("")).toBeUndefined();
  });

  it("extracts provider error message", () => {
    const error = new Error(
      "Source control provider github failed in fetchWorkflowRuns: rate limited",
    );
    expect(compactQueryErrorMessage(error)).toBe("rate limited");
  });

  it("returns generic message for non-provider errors", () => {
    const error = new Error("network timeout");
    expect(compactQueryErrorMessage(error)).toBe("network timeout");
  });

  it("returns fallback for non-Error values", () => {
    expect(compactQueryErrorMessage(42)).toBe("Failed to load.");
  });
});

describe("branchNameCandidates", () => {
  it("returns empty set for null/empty", () => {
    expect(branchNameCandidates(null).size).toBe(0);
    expect(branchNameCandidates("").size).toBe(0);
    expect(branchNameCandidates("  ").size).toBe(0);
  });

  it("includes the branch name itself", () => {
    const result = branchNameCandidates("feature/foo");
    expect(result.has("feature/foo")).toBe(true);
  });

  it("strips origin/ prefix", () => {
    const result = branchNameCandidates("origin/main");
    expect(result.has("origin/main")).toBe(true);
    expect(result.has("main")).toBe(true);
  });

  it("strips upstream/ prefix", () => {
    const result = branchNameCandidates("upstream/develop");
    expect(result.has("upstream/develop")).toBe(true);
    expect(result.has("develop")).toBe(true);
  });

  it("does not strip other prefixes", () => {
    const result = branchNameCandidates("feature/my-branch");
    expect(result.has("feature/my-branch")).toBe(true);
    expect(result.has("my-branch")).toBe(false);
  });
});

describe("findChangeRequestForBranch", () => {
  const mockChangeRequests = [
    { headRefName: "feature/test", number: 1, provider: "github" },
    { headRefName: "main", number: 2, provider: "github" },
  ] as unknown as Parameters<typeof findChangeRequestForBranch>[0];

  it("returns null for empty inputs", () => {
    expect(findChangeRequestForBranch(null, "main")).toBeNull();
    expect(findChangeRequestForBranch(mockChangeRequests, null)).toBeNull();
    expect(findChangeRequestForBranch([], "main")).toBeNull();
  });

  it("finds matching change request", () => {
    expect(findChangeRequestForBranch(mockChangeRequests, "main")).toEqual(
      expect.objectContaining({ number: 2 }),
    );
  });

  it("matches with origin/ prefix stripped", () => {
    expect(findChangeRequestForBranch(mockChangeRequests, "origin/main")).toEqual(
      expect.objectContaining({ number: 2 }),
    );
  });
});

describe("resolveOverviewPullRequestNumber", () => {
  it("prioritizes activeWorktreePrNumber", () => {
    expect(
      resolveOverviewPullRequestNumber({
        activeWorktreePrNumber: 10,
        gitStatusPrNumber: 20,
        overviewBranchPullRequestNumber: 30,
        postPushWatchPullRequestNumber: 40,
      }),
    ).toBe(10);
  });

  it("falls through to gitStatusPrNumber", () => {
    expect(
      resolveOverviewPullRequestNumber({
        activeWorktreePrNumber: null,
        gitStatusPrNumber: 20,
        overviewBranchPullRequestNumber: 30,
        postPushWatchPullRequestNumber: 40,
      }),
    ).toBe(20);
  });

  it("returns null when all are null", () => {
    expect(
      resolveOverviewPullRequestNumber({
        activeWorktreePrNumber: null,
        gitStatusPrNumber: null,
        overviewBranchPullRequestNumber: null,
        postPushWatchPullRequestNumber: null,
      }),
    ).toBeNull();
  });
});

describe("resolveWorkflowDetailRunIds", () => {
  it("returns empty for unsupported workflows", () => {
    expect(
      resolveWorkflowDetailRunIds({
        workflowRunsSupported: false,
        pullRequestNumber: 1,
        runs: [{ runId: "a" }],
        activeWorkflowRunId: null,
      }),
    ).toEqual([]);
  });

  it("returns empty when no pull request and no branch", () => {
    expect(
      resolveWorkflowDetailRunIds({
        workflowRunsSupported: true,
        pullRequestNumber: null,
        runs: [{ runId: "a" }],
        activeWorkflowRunId: null,
      }),
    ).toEqual([]);
  });

  it("returns run ids for a default-branch scope without a pull request", () => {
    expect(
      resolveWorkflowDetailRunIds({
        workflowRunsSupported: true,
        pullRequestNumber: null,
        branchName: "main",
        runs: [{ runId: "a" }, { runId: "b" }],
        activeWorkflowRunId: null,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns run ids in order", () => {
    expect(
      resolveWorkflowDetailRunIds({
        workflowRunsSupported: true,
        pullRequestNumber: 1,
        runs: [{ runId: "a" }, { runId: "b" }, { runId: "c" }],
        activeWorkflowRunId: null,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("prepends active workflow run id if missing", () => {
    expect(
      resolveWorkflowDetailRunIds({
        workflowRunsSupported: true,
        pullRequestNumber: 1,
        runs: [{ runId: "a" }, { runId: "b" }],
        activeWorkflowRunId: "x",
      }),
    ).toEqual(["x", "a", "b"]);
  });
});

describe("buildOverviewItems", () => {
  it("returns no items before git status or tracked changes exist", () => {
    const items = buildOverviewItems({
      gitStatusData: null,
      changedFiles: [],
      overviewPullRequestNumber: null,
    });
    expect(items).toEqual([]);
  });

  it("builds the changes item from the file list even without git status", () => {
    const items = buildOverviewItems({
      gitStatusData: null,
      changedFiles: [
        { path: "src/a.ts", insertions: 10, deletions: 2, category: "committed" },
        { path: "src/b.ts", insertions: 3, deletions: 1, category: "local" },
      ],
      overviewPullRequestNumber: 7,
    });
    expect(items[0]).toEqual(
      expect.objectContaining({
        label: "Changes",
        value: "Committed + local",
        additions: 13,
        deletions: 3,
        icon: "changes",
        action: "review",
      }),
    );
  });
});
