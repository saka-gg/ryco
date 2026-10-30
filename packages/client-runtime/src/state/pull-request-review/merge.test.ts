import { getChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";
import { describe, expect, it } from "vitest";

import {
  isHeadMovedError,
  mergeDeleteBranchDefault,
  mergeMethodOptions,
  resolveMergeMethod,
  resolveReviewEvents,
} from "./merge.ts";

const GITHUB = getChangeRequestHostCapabilities("github");
const NO_MERGE_COMMITS = { mergeCapabilities: { merge: false, squash: true, rebase: true } };

describe("merge methods", () => {
  it("falls back to the first method the repository allows", () => {
    expect(
      mergeMethodOptions(NO_MERGE_COMMITS).find((option) => option.method === "merge"),
    ).toMatchObject({ disabledReason: "Not allowed in this repository" });
    expect(resolveMergeMethod(NO_MERGE_COMMITS, "merge")).toBe("squash");
    expect(resolveMergeMethod(NO_MERGE_COMMITS, "rebase")).toBe("rebase");
    expect(resolveMergeMethod(NO_MERGE_COMMITS, null)).toBe("squash");
    // Without repository settings every method is allowed.
    expect(resolveMergeMethod({}, "merge")).toBe("merge");
  });

  it("leaves out methods the host cannot merge with", () => {
    const hostMethods = new Set(["rebase"] as const);
    expect(
      mergeMethodOptions(NO_MERGE_COMMITS, hostMethods).map((option) => option.method),
    ).toEqual(["rebase"]);
    expect(resolveMergeMethod(NO_MERGE_COMMITS, "squash", hostMethods)).toBe("rebase");
  });

  it("defaults branch deletion to the repository setting, for the repository's own branches", () => {
    expect(mergeDeleteBranchDefault({ deleteBranchOnMerge: true }, GITHUB)).toBe(true);
    expect(mergeDeleteBranchDefault({}, GITHUB)).toBe(false);
    expect(
      mergeDeleteBranchDefault({ deleteBranchOnMerge: true, isCrossRepository: true }, GITHUB),
    ).toBeNull();
    const noDelete = { merge: { ...GITHUB.merge, deleteBranch: false } };
    expect(mergeDeleteBranchDefault({ deleteBranchOnMerge: true }, noDelete)).toBeNull();
  });

  it("recognizes a refusal because the head moved", () => {
    expect(
      isHeadMovedError(new Error("Head branch was modified. Review and try the merge again.")),
    ).toBe(true);
    expect(isHeadMovedError(new Error("Pull request head changed since it was loaded"))).toBe(true);
    expect(isHeadMovedError(new Error("Required status check is failing"))).toBe(false);
  });
});

describe("resolveReviewEvents", () => {
  it("offers the verdicts the host takes and keeps the reader's choice", () => {
    const resolved = resolveReviewEvents({
      capabilities: GITHUB,
      isAuthor: false,
      chosen: "approve",
    });
    expect(resolved.options.map((option) => [option.event, option.disabled])).toEqual([
      ["comment", false],
      ["approve", false],
      ["request_changes", false],
    ]);
    expect(resolved.event).toBe("approve");
  });

  it("lets the author only comment", () => {
    const resolved = resolveReviewEvents({
      capabilities: GITHUB,
      isAuthor: true,
      chosen: "request_changes",
    });
    expect(resolved.event).toBe("comment");
    expect(resolved.options.filter((option) => option.disabled).map((o) => o.event)).toEqual([
      "approve",
      "request_changes",
    ]);
  });

  it("falls back to the first verdict the host takes", () => {
    const commentOnly = {
      ...GITHUB,
      submitReview: { ...GITHUB.submitReview, approve: false, requestChanges: false },
    };
    const resolved = resolveReviewEvents({
      capabilities: commentOnly,
      isAuthor: false,
      chosen: "approve",
    });
    expect(resolved.options.map((option) => option.event)).toEqual(["comment"]);
    expect(resolved.event).toBe("comment");
  });
});
