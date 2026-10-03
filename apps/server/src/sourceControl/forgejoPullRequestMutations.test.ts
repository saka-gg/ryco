import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ForgejoPullReviewSchema, decodeForgejoEntries } from "./forgejoPullRequestActivity.ts";
import {
  buildForgejoMergeBody,
  buildForgejoReviewSubmissionBody,
  encodeForgejoPathSegments,
  forgejoSubmitReviewResult,
  forgejoWorkInProgressTitle,
  hasForgejoWorkInProgressPrefix,
  isForgejoRepositoryFilePath,
  nextForgejoAssignees,
  resolveForgejoLabelIds,
  splitForgejoReviewers,
} from "./forgejoPullRequestMutations.ts";
import { forgejoHeadSha, forgejoReviews } from "./forgejoPullRequestPage.fixtures.ts";

describe("buildForgejoReviewSubmissionBody", () => {
  it("builds a CreatePullReviewOptions body pinned to the expected head", () => {
    const result = buildForgejoReviewSubmissionBody({
      event: "request_changes",
      body: "Please fix",
      expectedHeadSha: forgejoHeadSha,
      comments: [
        { path: "src/app.ts", body: "here", line: 12, side: "right" },
        { path: "src/setup.ts", body: "removed?", line: 5, side: "left" },
        // Ranges anchor on their last line.
        { path: "src/app.ts", body: "range", startLine: 8, line: 10, side: "right" },
        { path: "src/app.ts", body: "default side", line: 3 },
      ],
    });
    expect(Result.getOrThrow(result)).toEqual({
      event: "REQUEST_CHANGES",
      body: "Please fix",
      commit_id: forgejoHeadSha,
      comments: [
        { path: "src/app.ts", body: "here", new_position: 12 },
        { path: "src/setup.ts", body: "removed?", old_position: 5 },
        { path: "src/app.ts", body: "range", new_position: 10 },
        { path: "src/app.ts", body: "default side", new_position: 3 },
      ],
    });
  });

  it("maps the three verdicts", () => {
    const event = (value: "comment" | "approve" | "request_changes") =>
      Result.getOrThrow(
        buildForgejoReviewSubmissionBody({
          event: value,
          body: "summary",
          comments: [],
          expectedHeadSha: forgejoHeadSha,
        }),
      ).event;
    expect([event("comment"), event("approve"), event("request_changes")]).toEqual([
      "COMMENT",
      "APPROVED",
      "REQUEST_CHANGES",
    ]);
  });

  it("refuses reviews Forgejo would reject, before any request", () => {
    const fail = (input: Parameters<typeof buildForgejoReviewSubmissionBody>[0]) => {
      const result = buildForgejoReviewSubmissionBody(input);
      return Result.isFailure(result) ? result.failure : null;
    };
    expect(
      fail({ event: "request_changes", body: "  ", comments: [], expectedHeadSha: forgejoHeadSha }),
    ).toBe("Requesting changes needs a review summary.");
    expect(fail({ event: "comment", comments: [], expectedHeadSha: forgejoHeadSha })).toBe(
      "A comment review needs a summary or at least one line comment.",
    );
    expect(
      fail({
        event: "comment",
        comments: [{ path: "src/app.ts", body: "x", subjectType: "file" }],
        expectedHeadSha: forgejoHeadSha,
      }),
    ).toContain("cannot attach a comment to a whole file");
    expect(
      fail({
        event: "comment",
        comments: [{ path: "src/app.ts", body: "x", startLine: 9, line: 4 }],
        expectedHeadSha: forgejoHeadSha,
      }),
    ).toContain("starts after it ends");
    expect(fail({ event: "approve", comments: [], expectedHeadSha: forgejoHeadSha })).toBeNull();
  });
});

describe("forgejoSubmitReviewResult", () => {
  it("reports the created review", () => {
    const [approved, pending] = decodeForgejoEntries(ForgejoPullReviewSchema, [
      forgejoReviews[1],
      forgejoReviews[4],
    ]);
    expect(Result.getOrThrow(forgejoSubmitReviewResult(approved!))).toEqual({
      reviewId: "102",
      state: "approved",
      url: "https://codeberg.test/pingdotgg/ryco/pulls/42#issuecomment-102",
    });
    expect(Result.getOrThrow(forgejoSubmitReviewResult(pending!)).state).toBe("pending");
  });
});

describe("buildForgejoMergeBody", () => {
  it("sends the merge style and the head precondition", () => {
    expect(
      buildForgejoMergeBody({ mergeMethod: "rebase", expectedHeadSha: forgejoHeadSha }),
    ).toEqual({
      Do: "rebase",
      head_commit_id: forgejoHeadSha,
    });
    expect(buildForgejoMergeBody({ mergeMethod: "squash" })).toEqual({ Do: "squash" });
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

describe("people and labels", () => {
  it("splits user and team reviewers", () => {
    expect(splitForgejoReviewers(["bob", "pingdotgg/core", " "])).toEqual({
      reviewers: ["bob"],
      team_reviewers: ["core"],
    });
  });

  it("applies one assignee edit to the full set", () => {
    expect(
      nextForgejoAssignees({ current: ["bob", "carol"], add: ["dave", "Bob"], remove: ["carol"] }),
    ).toEqual(["bob", "dave"]);
  });

  it("resolves label names to ids", () => {
    const labels = [
      { id: 7, name: "enhancement" },
      { id: 8, name: "Bug" },
    ];
    expect(Result.getOrThrow(resolveForgejoLabelIds(["enhancement", "bug"], labels))).toEqual([
      7, 8,
    ]);
    const missing = resolveForgejoLabelIds(["nope"], labels);
    expect(Result.isFailure(missing) ? missing.failure : null).toBe(
      'No label named "nope" exists in this repository.',
    );
  });
});

describe("paths", () => {
  it("accepts repository-relative paths only", () => {
    expect(isForgejoRepositoryFilePath("src/app.ts")).toBe(true);
    expect(isForgejoRepositoryFilePath("../etc/passwd")).toBe(false);
    expect(isForgejoRepositoryFilePath("/abs")).toBe(false);
    expect(isForgejoRepositoryFilePath("a//b")).toBe(false);
    expect(isForgejoRepositoryFilePath("a\\b")).toBe(false);
  });

  it("encodes each segment and keeps the separators", () => {
    expect(encodeForgejoPathSegments("docs/a b#1.md")).toBe("docs/a%20b%231.md");
  });
});
