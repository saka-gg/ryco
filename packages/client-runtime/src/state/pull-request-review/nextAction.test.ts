import type {
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestStack,
  SourceControlCheckRollupItem,
} from "@ryco/contracts";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { summarizeChangeRequestChecks } from "./checks.ts";
import {
  deriveChangeRequestMergeAction,
  deriveChangeRequestNextAction,
  type ChangeRequestNextActionDetail,
} from "./nextAction.ts";

function rollup(...states: ReadonlyArray<"success" | "failure" | "pending">) {
  return states.map((state, index): SourceControlCheckRollupItem => ({
    kind: "check-run",
    name: `check-${index}`,
    status: Option.some(state === "pending" ? "IN_PROGRESS" : "COMPLETED"),
    conclusion: state === "pending" ? Option.none() : Option.some(state.toUpperCase()),
    url: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
  }));
}

function detail(
  overrides: Partial<ChangeRequestNextActionDetail> = {},
): ChangeRequestNextActionDetail {
  return {
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    reviewDecision: "approved",
    checkRollup: rollup("success"),
    baseRefName: "main",
    ...overrides,
  };
}

const viewer: ChangeRequestViewerCapabilities = {
  login: "octocat",
  isAuthor: false,
  canUpdate: true,
  canMerge: true,
  canReview: true,
  canUpdateBranch: true,
  canEnableAutoMerge: true,
  canDisableAutoMerge: true,
};

function stack(
  position: number,
  entries: ReadonlyArray<Partial<SourceControlChangeRequestStack["entries"][number]>>,
): SourceControlChangeRequestStack {
  return {
    number: 1,
    size: entries.length,
    position,
    baseRefName: "main",
    entries: entries.map((entry, index) => ({
      position: index + 1,
      number: 10 + index,
      title: `Layer ${index + 1}`,
      url: `https://example.test/pull/${10 + index}`,
      headRefName: `layer-${index + 1}`,
      baseRefName: index === 0 ? "main" : `layer-${index}`,
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      ...entry,
    })),
  };
}

describe("deriveChangeRequestNextAction", () => {
  it("reports terminal states as blocking and never offers a merge", () => {
    expect(
      deriveChangeRequestNextAction(detail({ state: "merged", mergedBy: "hubot" })),
    ).toMatchObject({
      kind: "merged",
      tone: "success",
      blocking: true,
      reason: "Merged by @hubot.",
    });
    expect(deriveChangeRequestNextAction(detail({ state: "closed" }))).toMatchObject({
      kind: "closed",
      blocking: true,
    });
  });

  it("ranks conflicts above every other blocker", () => {
    const action = deriveChangeRequestNextAction(
      detail({
        mergeability: "conflicting",
        isDraft: true,
        checkRollup: rollup("failure"),
        reviewDecision: "changes_requested",
      }),
    );
    expect(action).toMatchObject({ kind: "resolve-conflicts", tone: "danger", blocking: true });
    expect(action.reason).toContain("main");
    expect(
      deriveChangeRequestNextAction(detail({ mergeStateStatus: "dirty", mergeability: "unknown" }))
        .kind,
    ).toBe("resolve-conflicts");
  });

  it("asks to mark drafts ready and explains when only the author can", () => {
    expect(deriveChangeRequestNextAction(detail({ isDraft: true }), { viewer })).toMatchObject({
      kind: "mark-ready",
      blocking: true,
      viewerCanAct: true,
    });
    const readOnly = deriveChangeRequestNextAction(detail({ isDraft: true }), {
      viewer: { ...viewer, canUpdate: false },
    });
    expect(readOnly.viewerCanAct).toBe(false);
    expect(readOnly.reason).toContain("author");
  });

  it("asks to update a branch that is behind its base", () => {
    expect(deriveChangeRequestNextAction(detail({ mergeStateStatus: "behind" }))).toMatchObject({
      kind: "update-branch",
      tone: "warning",
      blocking: true,
    });
  });

  it("blocks on failing required checks but lets unstable merges through with a warning", () => {
    const blocked = deriveChangeRequestNextAction(
      detail({ checkRollup: rollup("success", "failure"), mergeStateStatus: "blocked" }),
    );
    expect(blocked).toMatchObject({ kind: "fix-checks", tone: "danger", blocking: true });
    expect(blocked.reason).toBe("check-1 is failing.");

    const unstable = deriveChangeRequestNextAction(
      detail({ checkRollup: rollup("failure"), mergeStateStatus: "unstable" }),
    );
    expect(unstable).toMatchObject({ kind: "fix-checks", tone: "warning", blocking: false });
  });

  it("names the reviewers who requested changes", () => {
    const action = deriveChangeRequestNextAction(
      detail({
        reviewDecision: "changes_requested",
        mergeStateStatus: "blocked",
        reviewerStates: [
          { login: "alice", kind: "user", state: "changes_requested" },
          { login: "bob", kind: "user", state: "approved" },
        ],
      }),
    );
    expect(action).toMatchObject({ kind: "changes-requested", blocking: true });
    expect(action.reason).toBe("@alice requested changes.");
  });

  it("shows an armed auto-merge as progress", () => {
    const action = deriveChangeRequestNextAction(
      detail({
        autoMerge: { mergeMethod: "squash" },
        checkRollup: rollup("pending"),
        mergeStateStatus: "blocked",
      }),
      { viewer },
    );
    expect(action).toMatchObject({
      kind: "auto-merge-pending",
      tone: "progress",
      blocking: true,
      reason: "Merges with squash once checks pass.",
    });
  });

  it("waits on running checks, offering auto-merge when the host blocks", () => {
    const blocked = deriveChangeRequestNextAction(
      detail({ checkRollup: rollup("success", "pending"), mergeStateStatus: "blocked" }),
      { viewer },
    );
    expect(blocked).toMatchObject({ kind: "checks-running", blocking: true, viewerCanAct: true });
    expect(blocked.reason).toBe("1 of 2 running.");

    const mergeable = deriveChangeRequestNextAction(
      detail({ checkRollup: rollup("pending"), mergeStateStatus: "clean" }),
    );
    expect(mergeable.blocking).toBe(false);
  });

  it("lists pending reviewers when a review is required", () => {
    const action = deriveChangeRequestNextAction(
      detail({
        reviewDecision: "review_required",
        mergeStateStatus: "blocked",
        reviewerStates: [
          { login: "alice", kind: "user", state: "requested" },
          { login: "org/core", kind: "team", state: "requested" },
        ],
      }),
      { viewer },
    );
    expect(action).toMatchObject({ kind: "awaiting-review", blocking: true, viewerCanAct: true });
    expect(action.reason).toBe("Waiting on @alice and @org/core.");
  });

  it("offers the merge when everything is green", () => {
    expect(deriveChangeRequestNextAction(detail(), { viewer })).toEqual({
      kind: "merge",
      label: "Merge pull request",
      tone: "success",
      blocking: false,
      viewerCanAct: true,
    });
  });

  it("keeps the control visible but blocked without merge permission", () => {
    expect(
      deriveChangeRequestNextAction(detail(), { viewer: { ...viewer, canMerge: false } }),
    ).toMatchObject({ kind: "merge", blocking: true, viewerCanAct: false });
  });

  it("explains an otherwise unexplained branch protection block", () => {
    expect(
      deriveChangeRequestNextAction(detail({ mergeStateStatus: "blocked", reviewDecision: null })),
    ).toMatchObject({
      kind: "merge",
      blocking: true,
      reason: "Branch protection rules are blocking this merge.",
    });
  });

  it("merges through the stack when lower layers are still open", () => {
    const action = deriveChangeRequestNextAction(
      detail({ stack: stack(3, [{ state: "merged" }, {}, {}]) }),
    );
    expect(action).toMatchObject({
      kind: "merge-stack",
      label: "Merge 2 pull requests",
      blocking: false,
      reason: "Merges #11 and this pull request into main.",
    });
  });

  it("blocks a stack merge on a draft or closed lower layer and on incomplete metadata", () => {
    expect(
      deriveChangeRequestNextAction(detail({ stack: stack(2, [{ isDraft: true }, {}]) })),
    ).toMatchObject({ kind: "merge-stack", blocking: true, reason: "#10 below is still a draft." });
    expect(
      deriveChangeRequestNextAction(detail({ stack: stack(2, [{ state: "closed" }, {}]) })).reason,
    ).toBe("#10 below is closed without being merged.");
    expect(
      deriveChangeRequestNextAction(
        detail({ stack: stack(2, [{}, {}]), stackMetadataIncomplete: true }),
      ),
    ).toMatchObject({ blocking: true });
  });

  it("does not block while the host is still computing mergeability", () => {
    expect(
      deriveChangeRequestNextAction(
        detail({ mergeability: "unknown", mergeStateStatus: "unknown" }),
      ),
    ).toMatchObject({ kind: "merge", tone: "progress", blocking: false });
  });

  it("accepts a precomputed checks summary", () => {
    const action = deriveChangeRequestNextAction(
      detail({ checkRollup: undefined, mergeStateStatus: "blocked" }),
      null,
      summarizeChangeRequestChecks(rollup("failure")),
    );
    expect(action.kind).toBe("fix-checks");
  });
});

describe("deriveChangeRequestMergeAction", () => {
  it("is the stack merge behind a next action that does not block it", () => {
    // Optional checks still running on layer 2: the host merges, and lands layer 1 too.
    const layer = detail({
      mergeStateStatus: "unstable",
      checkRollup: rollup("pending"),
      stack: stack(2, [{}, {}]),
    });
    expect(deriveChangeRequestNextAction(layer, { viewer })).toMatchObject({
      kind: "checks-running",
      blocking: false,
    });
    expect(deriveChangeRequestMergeAction(layer, { viewer })).toMatchObject({
      kind: "merge-stack",
      blocking: false,
    });
    expect(
      deriveChangeRequestMergeAction(
        { ...layer, stack: stack(2, [{ isDraft: true }, {}]) },
        {
          viewer,
        },
      ),
    ).toMatchObject({ kind: "merge-stack", blocking: true, reason: "#10 below is still a draft." });
    expect(
      deriveChangeRequestMergeAction(layer, { viewer: { ...viewer, canMerge: false } }),
    ).toMatchObject({ blocking: true });
  });
});
