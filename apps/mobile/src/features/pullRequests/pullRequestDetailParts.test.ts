import type { SourceControlChangeRequestStack } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { pullRequestActionBarModel } from "./pullRequestActionBarModel";
import { derivePullRequestStackNavigator } from "./pullRequestStackModel";

const review = (approveDisabled: boolean) => ({
  options: [
    { event: "comment" as const, label: "Comment", disabled: false },
    { event: "approve" as const, label: "Approve", disabled: approveDisabled },
  ],
  authorNote: null,
});

const merge = {
  methods: [
    { method: "merge" as const, label: "Merge commit", disabledReason: "Not allowed" },
    { method: "squash" as const, label: "Squash", disabledReason: null },
  ],
  method: "squash" as const,
  label: "Squash and merge",
  confirmLabel: "Confirm squash and merge",
  deleteBranchDefault: true,
};

describe("pullRequestActionBarModel", () => {
  it("offers review, one-tap approve and merge with its methods and update branch", () => {
    const bar = pullRequestActionBarModel({
      review: review(false),
      merge,
      updateBranch: { method: "merge" },
    });
    expect(bar).toMatchObject({
      review: true,
      approve: true,
      merge: { label: "Squash and merge" },
    });
    expect(bar?.merge?.menu).toEqual([
      {
        id: "method:merge",
        title: "Merge commit",
        subtitle: "Not allowed",
        checked: false,
        disabled: true,
      },
      { id: "method:squash", title: "Squash", checked: true, disabled: false },
      { id: "update-branch", title: "Update branch", checked: false, disabled: false },
    ]);
  });

  it("leaves approve out for the author and shows update branch alone", () => {
    expect(
      pullRequestActionBarModel({
        review: review(true),
        merge: null,
        updateBranch: { method: "rebase" },
      }),
    ).toEqual({ review: true, approve: false, merge: { label: "Rebase branch", menu: [] } });
  });

  it("is null when nothing applies", () => {
    expect(pullRequestActionBarModel({ review: null, merge: null, updateBranch: null })).toBeNull();
  });
});

describe("derivePullRequestStackNavigator", () => {
  const entry = (number: number, position: number) => ({
    position,
    number,
    title: `Layer ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    headRefName: `layer-${number}`,
    baseRefName: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
  });
  const stack: SourceControlChangeRequestStack = {
    number: 1,
    size: 3,
    position: 2,
    baseRefName: "main",
    entries: [entry(12, 3), entry(10, 1), entry(11, 2)],
  };

  it("orders the layers from the base up and marks the one on screen", () => {
    const navigator = derivePullRequestStackNavigator(stack, 11);
    expect(navigator?.layers.map((layer) => [layer.number, layer.current])).toEqual([
      [10, false],
      [11, true],
      [12, false],
    ]);
    expect(navigator?.positionLabel).toBe("2 of 3");
  });

  it("is null without a stack of two or more layers", () => {
    expect(derivePullRequestStackNavigator(undefined, 1)).toBeNull();
    expect(derivePullRequestStackNavigator({ ...stack, entries: [entry(10, 1)] }, 10)).toBeNull();
  });
});
