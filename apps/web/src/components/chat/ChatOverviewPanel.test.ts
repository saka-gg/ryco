import { describe, expect, it } from "vitest";
import {
  branchNameCandidates,
  buildOverviewItems,
  compactQueryErrorMessage,
  findChangeRequestForBranch,
  resolveThreadPullRequests,
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

describe("resolveThreadPullRequests", () => {
  const link = (number: number, state: "open" | "merged", dismissedAt: string | null = null) => ({
    number,
    title: `PR ${number}`,
    url: null,
    state,
    isDraft: false,
    terminalAt: state === "merged" ? "2026-10-06T06:51:51.000Z" : null,
    headRefName: "feature",
    baseRefName: "main",
    source: "created" as const,
    linkedAt: "2026-10-05T09:00:00.000Z",
    dismissedAt,
  });
  const live = (number: number, state: "open" | "merged" = "open") => ({
    number,
    title: `Live ${number}`,
    url: `https://example.test/pull/${number}`,
    baseRef: "main",
    headRef: "feature",
    state,
  });

  it("lets the branch's open follow-up outrank a merged link", () => {
    const resolved = resolveThreadPullRequests({
      links: [link(675, "merged")],
      live: live(677),
      discoversPullRequests: true,
    });
    expect(resolved.map((entry) => [entry.number, entry.state])).toEqual([
      [677, "open"],
      [675, "merged"],
    ]);
  });

  it("keeps a linked pull request's own data and never revives a dismissed one", () => {
    expect(
      resolveThreadPullRequests({
        links: [link(677, "open")],
        live: live(677),
        discoversPullRequests: true,
      })[0]?.title,
    ).toBe("PR 677");
    expect(
      resolveThreadPullRequests({
        links: [link(675, "merged"), link(677, "open", "2026-10-06T07:00:00.000Z")],
        live: live(677),
        discoversPullRequests: true,
      }).map((entry) => entry.number),
    ).toEqual([675]);
  });

  it("is empty with no links and nothing live", () => {
    expect(
      resolveThreadPullRequests({ links: [], live: null, discoversPullRequests: true }),
    ).toEqual([]);
  });

  it("leaves out a finished pull request the server never linked", () => {
    expect(
      resolveThreadPullRequests({
        links: [],
        live: live(600, "merged"),
        discoversPullRequests: true,
      }),
    ).toEqual([]);
    // Without discovery (no workspace record, the main checkout) git status is all there is.
    expect(
      resolveThreadPullRequests({
        links: [],
        live: live(600, "merged"),
        discoversPullRequests: false,
      }).map((entry) => entry.number),
    ).toEqual([600]);
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
