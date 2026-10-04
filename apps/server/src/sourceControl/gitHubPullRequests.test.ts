import { describe, expect, it } from "vite-plus/test";
import { Option, Result } from "effect";
import {
  decodeGitHubPullRequestListJson,
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestDetailJson,
  parseLinkedIssueNumbers,
} from "./gitHubPullRequests.ts";

describe("decodeGitHubPullRequestListJson", () => {
  it("decodes a valid list with state normalization", () => {
    const raw = JSON.stringify([
      {
        number: 42,
        title: "Add feature",
        url: "https://github.com/owner/repo/pull/42",
        baseRefName: "main",
        headRefName: "feature/add",
        state: "OPEN",
        mergedAt: null,
      },
    ]);
    const result = decodeGitHubPullRequestListJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success).toHaveLength(1);
    expect(result.success[0]?.number).toBe(42);
    expect(result.success[0]?.state).toBe("open");
  });

  it("skips invalid entries silently", () => {
    const raw = JSON.stringify([
      { number: "not-a-number", title: "bad" },
      {
        number: 7,
        title: "ok",
        url: "https://x/7",
        baseRefName: "main",
        headRefName: "fix/ok",
        state: "CLOSED",
      },
    ]);
    const result = decodeGitHubPullRequestListJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.map((p) => p.number)).toEqual([7]);
  });

  it("fails on non-JSON", () => {
    const result = decodeGitHubPullRequestListJson("{not json");
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("decodeGitHubPullRequestJson", () => {
  it("decodes a single PR", () => {
    const raw = JSON.stringify({
      number: 42,
      title: "My PR",
      url: "https://github.com/owner/repo/pull/42",
      baseRefName: "main",
      headRefName: "feature/my-pr",
      mergeable: "CONFLICTING",
      state: "OPEN",
      mergedAt: null,
    });
    const result = decodeGitHubPullRequestJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.number).toBe(42);
    expect(result.success.state).toBe("open");
    expect(result.success.mergeability).toBe("conflicting");
    expect(result.success.mergedAt).toBeUndefined();
    expect(result.success.closedAt).toBeUndefined();
  });

  it("decodes merge and close times", () => {
    const raw = JSON.stringify({
      number: 42,
      title: "My PR",
      url: "https://github.com/owner/repo/pull/42",
      baseRefName: "main",
      headRefName: "feature/my-pr",
      state: "MERGED",
      mergedAt: "2026-05-01T10:00:00Z",
      closedAt: "2026-05-01T10:00:05Z",
    });
    const result = decodeGitHubPullRequestJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.state).toBe("merged");
    expect(result.success.mergedAt?.epochMilliseconds).toBe(Date.parse("2026-05-01T10:00:00Z"));
    expect(result.success.closedAt?.epochMilliseconds).toBe(Date.parse("2026-05-01T10:00:05Z"));
  });
});

describe("decodeGitHubPullRequestDetailJson", () => {
  it("decodes body and comments", () => {
    const raw = JSON.stringify({
      number: 42,
      title: "My PR",
      url: "https://github.com/owner/repo/pull/42",
      baseRefName: "main",
      headRefName: "feature/my-pr",
      state: "OPEN",
      mergedAt: null,
      body: "PR body text",
      comments: [
        {
          id: "IC_kwDOA1B2C84AAAAB",
          author: { login: "alice" },
          body: "looks good",
          createdAt: "2026-03-14T10:00:00Z",
          reactionGroups: [
            { content: "THUMBS_UP", viewerHasReacted: true, users: { totalCount: 2 } },
            { content: "EYES", users: { totalCount: 1 } },
          ],
        },
        { author: null, body: "second comment", createdAt: "2026-03-14T11:00:00Z" },
      ],
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.body).toBe("PR body text");
    expect(result.success.comments).toHaveLength(2);
    expect(result.success.comments[0]?.id).toBe("IC_kwDOA1B2C84AAAAB");
    expect(result.success.comments[0]?.author).toBe("alice");
    expect(result.success.comments[0]?.reactions).toEqual([
      { content: "thumbs-up", count: 2, viewerHasReacted: true },
      { content: "eyes", count: 1 },
    ]);
    expect(result.success.comments[1]?.author).toBe("unknown");
  });

  it("handles missing body and comments", () => {
    const raw = JSON.stringify({
      number: 1,
      title: "PR",
      url: "https://x/1",
      baseRefName: "main",
      headRefName: "fix",
      state: "OPEN",
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.body).toBe("");
    expect(result.success.comments).toHaveLength(0);
    expect(result.success.linkedIssueNumbers).toEqual([]);
  });

  it("parses linked issue numbers from PR body", () => {
    const raw = JSON.stringify({
      number: 5,
      title: "Multi-link",
      url: "https://x/5",
      baseRefName: "main",
      headRefName: "feature/linked",
      state: "OPEN",
      body: "Closes #12. Also fixes #34, resolves #56.",
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.linkedIssueNumbers).toEqual([12, 34, 56]);
  });

  it("preserves authorAssociation when present", () => {
    const raw = JSON.stringify({
      number: 42,
      title: "My PR",
      url: "https://github.com/owner/repo/pull/42",
      baseRefName: "main",
      headRefName: "feature/my-pr",
      state: "OPEN",
      mergedAt: null,
      body: "PR body",
      comments: [
        {
          author: { login: "alice" },
          authorAssociation: "OWNER",
          body: "looks good",
          createdAt: "2026-03-14T10:00:00Z",
        },
        {
          author: { login: "bob" },
          body: "no association",
          createdAt: "2026-03-14T11:00:00Z",
        },
      ],
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.comments[0]?.authorAssociation).toBe("OWNER");
    expect(result.success.comments[1]?.authorAssociation).toBeUndefined();
  });

  it("interleaves PR review bodies into the comments stream with reviewState", () => {
    const raw = JSON.stringify({
      number: 14,
      title: "Feature/branch toolbar terminal label",
      url: "https://github.com/owner/repo/pull/14",
      baseRefName: "main",
      headRefName: "feature/x",
      state: "OPEN",
      mergedAt: null,
      body: "PR body",
      comments: [
        { author: { login: "bob" }, body: "general comment", createdAt: "2026-03-14T11:00:00Z" },
      ],
      reviews: [
        {
          id: "PRR_kwDOA1B2C84AAAAC",
          author: { login: "alice" },
          authorAssociation: "MEMBER",
          state: "APPROVED",
          body: "LGTM",
          reactionGroups: [{ content: "HOORAY", viewerHasReacted: true, users: { totalCount: 1 } }],
          submittedAt: "2026-03-14T10:00:00Z",
        },
        {
          author: { login: "carol" },
          state: "CHANGES_REQUESTED",
          body: "",
          submittedAt: "2026-03-14T12:00:00Z",
        },
        {
          author: { login: "dave" },
          state: "COMMENTED",
          body: "Some thoughts",
          submittedAt: "2026-03-14T13:00:00Z",
        },
      ],
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.comments).toHaveLength(3);
    expect(result.success.comments[0]?.author).toBe("alice");
    expect(result.success.comments[0]?.id).toBe("PRR_kwDOA1B2C84AAAAC");
    expect(result.success.comments[0]?.reviewState).toBe("approved");
    expect(result.success.comments[0]?.authorAssociation).toBe("MEMBER");
    expect(result.success.comments[0]?.reactions).toEqual([
      { content: "hooray", count: 1, viewerHasReacted: true },
    ]);
    expect(result.success.comments[1]?.author).toBe("bob");
    expect(result.success.comments[1]?.reviewState).toBeUndefined();
    expect(result.success.comments[2]?.author).toBe("dave");
    expect(result.success.comments[2]?.reviewState).toBe("commented");
  });

  it("preserves label colors when present", () => {
    const raw = JSON.stringify({
      number: 1,
      title: "Has labels",
      url: "https://x/1",
      baseRefName: "main",
      headRefName: "feature/labels",
      state: "OPEN",
      labels: [
        { name: "bug", color: "d73a4a", description: "Something is broken" },
        { name: "feature" },
        { name: "vouch:trusted", color: "0e8a16" },
      ],
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.labels).toEqual([
      { name: "bug", color: "d73a4a", description: "Something is broken" },
      { name: "feature" },
      { name: "vouch:trusted", color: "0e8a16" },
    ]);
  });

  it("parses changed files, additions, deletions", () => {
    const raw = JSON.stringify({
      number: 14,
      title: "Big PR",
      url: "https://github.com/owner/repo/pull/14",
      baseRefName: "main",
      headRefName: "feature/x",
      state: "OPEN",
      mergedAt: null,
      additions: 3825,
      deletions: 188,
      changedFiles: 55,
      files: [
        { path: "apps/web/src/app.tsx", additions: 12, deletions: 3 },
        { path: "apps/server/src/main.ts", additions: 5, deletions: 0 },
      ],
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.additions).toBe(3825);
    expect(result.success.deletions).toBe(188);
    expect(result.success.changedFiles).toBe(55);
    expect(result.success.files).toHaveLength(2);
    expect(result.success.files[0]?.path).toBe("apps/web/src/app.tsx");
    expect(result.success.files[0]?.additions).toBe(12);
    expect(result.success.files[0]?.deletions).toBe(3);
  });

  it("parses requested reviewers and commits", () => {
    const raw = JSON.stringify({
      number: 14,
      title: "Feature/branch toolbar terminal label",
      url: "https://github.com/owner/repo/pull/14",
      baseRefName: "main",
      headRefName: "feature/branch-toolbar-terminal-label",
      state: "OPEN",
      mergedAt: null,
      body: "What changed",
      reviewRequests: [{ login: "alice" }, { login: "coderabbitai[bot]" }],
      commits: [
        {
          oid: "abcd1234deadbeefabcd1234deadbeefabcd1234",
          messageHeadline: "Add toolbar label",
          authors: [{ login: "sak0a" }],
          committedDate: "2026-03-14T10:00:00Z",
        },
        {
          oid: "ef0011223344556677889900aabbccddeeff0011",
          messageHeadline: "Fix typo",
          authors: [{ login: "sak0a" }],
          committedDate: "2026-03-14T11:00:00Z",
        },
      ],
    });
    const result = decodeGitHubPullRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.reviewers).toEqual(["alice", "coderabbitai[bot]"]);
    expect(result.success.commits).toHaveLength(2);
    expect(result.success.commits[0]?.oid).toBe("abcd1234deadbeefabcd1234deadbeefabcd1234");
    expect(result.success.commits[0]?.shortOid).toBe("abcd123");
    expect(result.success.commits[0]?.messageHeadline).toBe("Add toolbar label");
    expect(result.success.commits[0]?.author).toBe("sak0a");
    expect(result.success.commits[0]?.committedDate).toBe("2026-03-14T10:00:00Z");
  });

  it("decodes integer comments count from list output", () => {
    const raw = JSON.stringify([
      {
        number: 9,
        title: "Counted",
        url: "https://x/9",
        baseRefName: "main",
        headRefName: "feature/c",
        state: "OPEN",
        comments: 7,
      },
    ]);
    const result = decodeGitHubPullRequestListJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success[0]?.commentsCount).toBe(7);
  });

  it("ignores malformed check rollup timestamps", () => {
    const raw = JSON.stringify([
      {
        number: 10,
        title: "Check dates",
        url: "https://x/10",
        baseRefName: "main",
        headRefName: "feature/check-dates",
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "CI",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: "not-a-date",
            completedAt: "2026-05-31T12:00:00Z",
          },
        ],
      },
    ]);
    const result = decodeGitHubPullRequestListJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(Option.isNone(result.success[0]?.checkRollup?.[0]?.startedAt ?? Option.none())).toBe(
      true,
    );
    expect(Option.isSome(result.success[0]?.checkRollup?.[0]?.completedAt ?? Option.none())).toBe(
      true,
    );
  });
});

describe("parseLinkedIssueNumbers", () => {
  it("matches all close/fix/resolve verb forms", () => {
    expect(parseLinkedIssueNumbers("Closes #1, fixed #2, resolve #3")).toEqual([1, 2, 3]);
  });

  it("dedupes repeated numbers", () => {
    expect(parseLinkedIssueNumbers("Fixes #5 and closes #5")).toEqual([5]);
  });

  it("ignores unrelated # references", () => {
    expect(parseLinkedIssueNumbers("See #7 for context. Closes #8.")).toEqual([8]);
  });

  it("returns empty for empty body", () => {
    expect(parseLinkedIssueNumbers("")).toEqual([]);
  });
});

describe("pull request page enrichment", () => {
  const base = {
    number: 7,
    title: "Seven",
    url: "https://github.com/acme/repo/pull/7",
    baseRefName: "main",
    headRefName: "feature/x",
    state: "MERGED",
    mergedAt: "2026-10-02T12:00:00Z",
  };

  it("decodes list metadata and treats an empty review decision as none", () => {
    const result = decodeGitHubPullRequestListJson(
      JSON.stringify([
        {
          ...base,
          createdAt: "2026-10-01T10:00:00Z",
          reviewDecision: "",
          additions: 5,
          deletions: -1,
          changedFiles: 3,
        },
      ]),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success[0]?.reviewDecision).toBeNull();
    expect(result.success[0]?.additions).toBe(5);
    expect(result.success[0]?.deletions).toBeUndefined();
    // List rows waiting on the viewer's review show the file count.
    expect(result.success[0]?.changedFiles).toBe(3);
    expect(result.success[0]?.createdAt?.toString()).toContain("2026-10-01T10:00:00");
  });

  it("builds reviewer states, merge state, auto-merge, and merge facts", () => {
    const result = decodeGitHubPullRequestDetailJson(
      JSON.stringify({
        ...base,
        body: "",
        closedAt: "2026-10-02T12:00:00Z",
        mergedBy: { login: "carol" },
        mergeStateStatus: "BEHIND",
        autoMergeRequest: {
          mergeMethod: "SQUASH",
          enabledAt: "2026-10-02T11:00:00Z",
          enabledBy: { login: "alice" },
        },
        latestReviews: [
          { author: { login: "bob" }, state: "APPROVED", submittedAt: "2026-10-02T09:00:00Z" },
          { author: { login: "coderabbitai[bot]" }, state: "COMMENTED", submittedAt: null },
          {
            author: { login: "dave" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-10-02T08:00:00Z",
          },
          { author: { login: "erin" }, state: "PENDING" },
        ],
        reviewRequests: [
          { __typename: "User", login: "dave" },
          { __typename: "Team", name: "Core", slug: "acme/core" },
          { __typename: "Bot", login: "copilot-pull-request-reviewer" },
        ],
      }),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    const detail = result.success;
    expect(
      detail.reviewerStates.map((reviewer) => [reviewer.login, reviewer.kind, reviewer.state]),
    ).toEqual([
      ["bob", "user", "approved"],
      ["coderabbitai[bot]", "bot", "commented"],
      // Re-requested after changes were requested: outstanding again, keeps the review time.
      ["dave", "user", "requested"],
      ["acme/core", "team", "requested"],
      ["copilot-pull-request-reviewer", "bot", "requested"],
    ]);
    expect(detail.reviewerStates[2]?.submittedAt?.toString()).toContain("2026-10-02T08:00:00");
    expect(detail.mergeStateStatus).toBe("behind");
    expect(detail.autoMerge?.mergeMethod).toBe("squash");
    expect(detail.autoMerge?.enabledBy).toBe("alice");
    expect(detail.mergedBy).toBe("carol");
    expect(detail.mergedAt?.toString()).toContain("2026-10-02T12:00:00");
    expect(detail.closedAt).toBeDefined();
    // Comments keep their agent-context semantics: none here, nothing synthesized from reviews.
    expect(detail.comments).toEqual([]);
  });

  it("distinguishes no auto-merge from an unreported one", () => {
    const disabled = decodeGitHubPullRequestDetailJson(
      JSON.stringify({ ...base, autoMergeRequest: null }),
    );
    const unreported = decodeGitHubPullRequestDetailJson(JSON.stringify(base));
    expect(Result.isSuccess(disabled) && disabled.success.autoMerge).toBeNull();
    expect(Result.isSuccess(unreported) && "autoMerge" in unreported.success).toBe(false);
  });
});
