import type {
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestDetail,
} from "@ryco/contracts";
import type { ChangeRequestNextAction } from "@ryco/client-runtime/state/pull-request-review";
import { getChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  buildPullRequestMergeInput,
  buildPullRequestUpdateBranchInput,
  derivePullRequestActions,
  describePullRequestActionError,
  PULL_REQUEST_NOT_READY,
  pullRequestReviewEvent,
  shownPullRequestActionSheet,
} from "./pullRequestActionsModel";

const GITHUB = getChangeRequestHostCapabilities("github");
const UNKNOWN = getChangeRequestHostCapabilities("unknown");

function detail(overrides: Partial<SourceControlChangeRequestDetail> = {}) {
  return {
    provider: "github",
    number: 42,
    title: "Phone pull requests",
    url: "https://github.com/acme/app/pull/42",
    baseRefName: "main",
    headRefName: "feature/prs",
    state: "open",
    updatedAt: Option.none(),
    headSha: "abc1234",
    body: "",
    comments: [],
    truncated: false,
    mergeCapabilities: { merge: false, squash: true, rebase: true },
    deleteBranchOnMerge: true,
    ...overrides,
  } as SourceControlChangeRequestDetail;
}

const viewer = (overrides: Partial<ChangeRequestViewerCapabilities> = {}) => ({
  login: "bob",
  isAuthor: false,
  canUpdate: true,
  canMerge: true,
  canReview: true,
  canUpdateBranch: true,
  canEnableAutoMerge: true,
  canDisableAutoMerge: true,
  ...overrides,
});

const next = (
  kind: ChangeRequestNextAction["kind"],
  overrides: Partial<ChangeRequestNextAction> = {},
): ChangeRequestNextAction => ({
  kind,
  label: kind,
  tone: "neutral",
  blocking: false,
  viewerCanAct: true,
  ...overrides,
});

const base = {
  detail: detail(),
  viewer: viewer(),
  nextAction: next("merge"),
  capabilities: GITHUB,
  mutationReady: true,
  role: "owner" as const,
  chosenMethod: null,
};

describe("derivePullRequestActions", () => {
  it("offers review and merge on a mergeable pull request, with the repository's methods", () => {
    const actions = derivePullRequestActions(base);
    expect(actions.blockedReason).toBeNull();
    expect(actions.review?.options.map((option) => option.event)).toEqual([
      "comment",
      "approve",
      "request_changes",
    ]);
    // The repository turns merge commits off, so squash is preselected.
    expect(actions.merge?.methods?.map((option) => option.method)).toEqual([
      "squash",
      "merge",
      "rebase",
    ]);
    expect(actions.merge).toMatchObject({
      method: "squash",
      label: "Squash and merge",
      confirmLabel: "Confirm squash and merge",
      deleteBranchDefault: true,
    });
    expect(actions.updateBranch).toBeNull();
  });

  it("keeps the reader's merge method where the repository allows it", () => {
    expect(derivePullRequestActions({ ...base, chosenMethod: "rebase" }).merge?.method).toBe(
      "rebase",
    );
    expect(derivePullRequestActions({ ...base, chosenMethod: "merge" }).merge?.method).toBe(
      "squash",
    );
  });

  it("offers no method choice where the host does not report the repository's settings", () => {
    const merge = derivePullRequestActions({
      ...base,
      detail: detail({ mergeCapabilities: undefined }),
      chosenMethod: "rebase",
    }).merge;
    expect(merge?.methods).toBeNull();
    // The merge itself is still offered, with the reader's method.
    expect(merge?.method).toBe("rebase");
  });

  it("does not offer a merge the next step says is blocked, or one the viewer cannot make", () => {
    expect(
      derivePullRequestActions({ ...base, nextAction: next("merge", { blocking: true }) }).merge,
    ).toBeNull();
    expect(
      derivePullRequestActions({ ...base, nextAction: next("merge", { viewerCanAct: false }) })
        .merge,
    ).toBeNull();
    expect(derivePullRequestActions({ ...base, nextAction: next("fix-checks") }).merge).toBeNull();
  });

  it("offers a branch update when the branch is behind its base", () => {
    const actions = derivePullRequestActions({ ...base, nextAction: next("update-branch") });
    expect(actions.updateBranch).toEqual({ method: "merge" });
    expect(actions.merge).toBeNull();
    expect(
      derivePullRequestActions({
        ...base,
        nextAction: next("update-branch"),
        viewer: viewer({ canUpdateBranch: false }),
      }).updateBranch,
    ).toBeNull();
  });

  it("lets the author only comment", () => {
    const actions = derivePullRequestActions({ ...base, viewer: viewer({ isAuthor: true }) });
    expect(actions.review?.authorNote).toMatch(/you can comment/u);
    expect(
      pullRequestReviewEvent({
        capabilities: GITHUB,
        viewer: viewer({ isAuthor: true }),
        chosen: "approve",
      }),
    ).toBe("comment");
  });

  it("offers a session whose role on the node is read-only nothing, instead of asking it to reconnect", () => {
    for (const role of ["viewer", "client"] as const) {
      for (const nextAction of [next("merge"), next("update-branch")]) {
        expect(derivePullRequestActions({ ...base, role, nextAction })).toEqual({
          blockedReason: null,
          review: null,
          merge: null,
          updateBranch: null,
        });
      }
    }
    // Operators and owners are offered changes; an unknown role is left to the node.
    for (const role of ["operator", "owner", undefined] as const) {
      expect(derivePullRequestActions({ ...base, role }).merge).not.toBeNull();
    }
  });

  it("waits for the node to take changes", () => {
    const actions = derivePullRequestActions({ ...base, role: "operator", mutationReady: false });
    expect(actions.blockedReason).toBe(PULL_REQUEST_NOT_READY);
    // The actions stay visible so the reader sees what will be possible.
    expect(actions.merge).not.toBeNull();
  });

  it("offers nothing on a closed or merged pull request, or where the host takes no changes", () => {
    expect(derivePullRequestActions({ ...base, detail: detail({ state: "merged" }) })).toEqual({
      blockedReason: null,
      review: null,
      merge: null,
      updateBranch: null,
    });
    const none = derivePullRequestActions({ ...base, capabilities: UNKNOWN, mutationReady: false });
    expect([none.review, none.merge, none.blockedReason]).toEqual([null, null, null]);
    expect(derivePullRequestActions({ ...base, detail: null }).review).toBeNull();
  });
});

describe("pullRequestReviewEvent", () => {
  it("sends the reader's verdict where the host takes it, else the first it offers", () => {
    const input = { capabilities: GITHUB, viewer: viewer() };
    expect(pullRequestReviewEvent({ ...input, chosen: null })).toBe("comment");
    expect(pullRequestReviewEvent({ ...input, chosen: "approve" })).toBe("approve");
    expect(pullRequestReviewEvent({ ...input, viewer: null, chosen: "request_changes" })).toBe(
      "request_changes",
    );
  });
});

describe("shownPullRequestActionSheet", () => {
  const review = derivePullRequestActions(base).review;
  const merge = derivePullRequestActions(base).merge;

  it("shows the sheet the reader opened while its action is offered", () => {
    expect(shownPullRequestActionSheet("review", { review, merge })).toBe("review");
    expect(shownPullRequestActionSheet("merge", { review, merge })).toBe("merge");
    expect(shownPullRequestActionSheet(null, { review, merge })).toBeNull();
  });

  it("closes a sheet whose action went away", () => {
    expect(shownPullRequestActionSheet("review", { review: null, merge })).toBeNull();
    expect(shownPullRequestActionSheet("merge", { review, merge: null })).toBeNull();
  });
});

describe("change inputs", () => {
  it("guards the merge with the head the reader saw", () => {
    expect(
      buildPullRequestMergeInput({
        cwd: "/repo",
        number: 42,
        method: "squash",
        deleteBranch: true,
        headSha: "abc1234",
        capabilities: GITHUB,
      }),
    ).toEqual({
      cwd: "/repo",
      reference: "42",
      mergeMethod: "squash",
      deleteBranch: true,
      expectedHeadSha: "abc1234",
    });
    // Hosts that cannot guard the head or delete the branch are not asked to.
    const plain = { merge: { ...GITHUB.merge, expectedHeadSha: false, deleteBranch: false } };
    expect(
      buildPullRequestMergeInput({
        cwd: "/repo",
        number: 42,
        method: "rebase",
        deleteBranch: true,
        headSha: "abc1234",
        capabilities: plain,
      }),
    ).toEqual({ cwd: "/repo", reference: "42", mergeMethod: "rebase" });
  });

  it("updates the branch at the head the reader saw", () => {
    expect(
      buildPullRequestUpdateBranchInput({
        cwd: "/repo",
        number: 42,
        method: "rebase",
        headSha: "abc1234",
      }),
    ).toEqual({
      cwd: "/repo",
      reference: "42",
      action: { kind: "update-branch", method: "rebase", expectedHeadSha: "abc1234" },
    });
  });

  it("says when new commits arrived", () => {
    expect(describePullRequestActionError(new Error("Head branch was modified"))).toMatch(
      /New commits were pushed/u,
    );
    expect(describePullRequestActionError(new Error("Required status check failing"))).toBe(
      "Required status check failing",
    );
    expect(describePullRequestActionError("weird")).toBe(
      "The change did not go through. Try again.",
    );
  });
});
