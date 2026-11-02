import { describe, expect, it } from "vite-plus/test";
import { DateTime, Option, Result } from "effect";

import {
  decodeForgejoPullRequestDetailJson,
  decodeForgejoPullRequestListJson,
  forgejoWorkInProgressTitle,
  hasForgejoWorkInProgressPrefix,
  normalizeForgejoPullRequestDetail,
} from "./forgejoPullRequests.ts";

const forgejoPullRequest = {
  number: 42,
  title: "Add Forgejo provider",
  state: "open",
  merged: false,
  draft: true,
  body: "PR body",
  html_url: "https://codeberg.org/owner/repo/pulls/42",
  updated_at: "2026-03-14T10:00:00Z",
  comments: 3,
  user: { login: "alice" },
  head: {
    ref: "feature/forgejo",
    label: "alice:feature/forgejo",
    repo_id: 11,
    repo: {
      full_name: "alice/repo",
      html_url: "https://codeberg.org/alice/repo",
      clone_url: "https://codeberg.org/alice/repo.git",
      ssh_url: "git@codeberg.org:alice/repo.git",
      default_branch: "main",
    },
  },
  base: {
    ref: "main",
    repo_id: 12,
    repo: {
      full_name: "owner/repo",
      html_url: "https://codeberg.org/owner/repo",
      clone_url: "https://codeberg.org/owner/repo.git",
      ssh_url: "git@codeberg.org:owner/repo.git",
      default_branch: "main",
    },
  },
} as const;

describe("decodeForgejoPullRequestListJson", () => {
  it("decodes Forgejo pull requests into normalized records", () => {
    const result = decodeForgejoPullRequestListJson(JSON.stringify([forgejoPullRequest]));

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success[0]).toMatchObject({
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/owner/repo/pulls/42",
      baseRefName: "main",
      headRefName: "feature/forgejo",
      state: "open",
      isCrossRepository: true,
      isDraft: true,
      author: "alice",
      commentsCount: 3,
      headRepositoryNameWithOwner: "alice/repo",
      headRepositoryOwnerLogin: "alice",
    });
    expect(Option.isSome(result.success[0]?.updatedAt ?? Option.none())).toBe(true);
  });

  it("normalizes merged Forgejo pull requests", () => {
    const result = decodeForgejoPullRequestListJson(
      JSON.stringify([{ ...forgejoPullRequest, merged: true, state: "closed" }]),
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success[0]?.state).toBe("merged");
  });
});

describe("decodeForgejoPullRequestDetailJson", () => {
  it("decodes single pull request bodies", () => {
    const result = decodeForgejoPullRequestDetailJson(JSON.stringify(forgejoPullRequest));

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.body).toBe("PR body");
    expect(result.success.number).toBe(42);
  });
});

describe("normalizeForgejoPullRequestDetail", () => {
  it("normalizes comments, commits, and files", () => {
    const detail = normalizeForgejoPullRequestDetail({
      pullRequest: {
        ...forgejoPullRequest,
        updated_at: Option.some(DateTime.makeUnsafe("2026-03-14T10:00:00Z")),
      },
      comments: [
        {
          user: { login: "reviewer" },
          body: "review comment",
          created_at: "2026-03-15T10:00:00Z",
        },
      ],
      commits: [
        {
          sha: "abcdef1234567890",
          commit: {
            message: "Add support\n\nDetails",
            author: { name: "Alice", date: "2026-03-15T09:00:00Z" },
          },
          author: { login: "alice" },
        },
      ],
      files: [{ filename: "src/forgejo.ts", additions: 10, deletions: 2 }],
    });

    expect(detail.comments).toEqual([
      {
        author: "reviewer",
        body: "review comment",
        createdAt: "2026-03-15T10:00:00Z",
      },
    ]);
    expect(detail.commits[0]).toMatchObject({
      oid: "abcdef1234567890",
      shortOid: "abcdef123456",
      messageHeadline: "Add support",
      author: "alice",
    });
    expect(detail.additions).toBe(10);
    expect(detail.deletions).toBe(2);
    expect(detail.changedFiles).toBe(1);
    expect(detail.files).toEqual([{ path: "src/forgejo.ts", additions: 10, deletions: 2 }]);
  });
});

describe("work-in-progress titles", () => {
  it("adds and strips Forgejo's default prefixes", () => {
    expect(forgejoWorkInProgressTitle("Add page", true)).toBe("WIP: Add page");
    expect(forgejoWorkInProgressTitle("[WIP] Add page", true)).toBe("[WIP] Add page");
    expect(forgejoWorkInProgressTitle("WIP: Add page", false)).toBe("Add page");
    expect(forgejoWorkInProgressTitle("wip: [WIP] Add page", false)).toBe("Add page");
    expect(forgejoWorkInProgressTitle("Add page", false)).toBe("Add page");
    expect(hasForgejoWorkInProgressPrefix("[wip] x")).toBe(true);
    expect(hasForgejoWorkInProgressPrefix("Wipe the cache")).toBe(false);
  });
});
