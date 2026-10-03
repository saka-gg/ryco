import type {
  ChangeRequestUpdateActionKind,
  SourceControlChangeRequestMergeMethod,
  SourceControlProviderKind,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canMergeChangeRequests,
  canSubmitChangeRequestReview,
  changeRequestCommitUrl,
  describeUnsupportedChangeRequestRequest,
  getChangeRequestHostCapabilities,
  preferredUpdateBranchMethod,
  supportsChangeRequestReviewEvent,
  type ChangeRequestHostCapabilities,
} from "./sourceControl.ts";

const KINDS: ReadonlyArray<SourceControlProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "forgejo",
  "azure-devops",
  "unknown",
];

const ALL_ACTIONS: ReadonlyArray<ChangeRequestUpdateActionKind> = [
  "edit",
  "set-draft",
  "close",
  "reopen",
  "reviewers",
  "labels",
  "assignees",
  "update-branch",
  "auto-merge",
  "delete-branch",
];

const ALL_METHODS: ReadonlyArray<SourceControlChangeRequestMergeMethod> = [
  "merge",
  "squash",
  "rebase",
];

type BooleanFlag = {
  [K in keyof ChangeRequestHostCapabilities]: ChangeRequestHostCapabilities[K] extends boolean
    ? K
    : never;
}[keyof ChangeRequestHostCapabilities];

const BOOLEAN_FLAGS: ReadonlyArray<BooleanFlag> = [
  "involvementFilters",
  "search",
  "activity",
  "diff",
  "commitDiffs",
  "fileContents",
  "checkRollup",
  "listCheckRollup",
  "mergeReadiness",
  "workflowRuns",
  "workflowJobLogs",
  "rerunWorkflows",
  "stacks",
  "viewedFiles",
  "comment",
  "reactions",
  "editComments",
  "deleteComments",
  "lineComments",
  "replyToThreads",
  "resolveThreads",
  "checkout",
];

/** Flags that are true for a host (booleans and nested groups flattened). */
function enabledFlags(capabilities: ChangeRequestHostCapabilities): ReadonlyArray<string> {
  const flags: string[] = BOOLEAN_FLAGS.filter((flag) => capabilities[flag]);
  for (const [key, value] of Object.entries(capabilities.submitReview)) {
    if (value) flags.push(`submitReview.${key}`);
  }
  for (const action of capabilities.lifecycle) flags.push(`lifecycle.${action}`);
  for (const method of capabilities.updateBranchMethods) flags.push(`updateBranch.${method}`);
  flags.push(`listReadiness.${capabilities.listReadiness}`);
  if (capabilities.idleRefresh !== "standard")
    flags.push(`idleRefresh.${capabilities.idleRefresh}`);
  for (const method of capabilities.merge.methods) flags.push(`merge.${method}`);
  if (capabilities.merge.deleteBranch) flags.push("merge.deleteBranch");
  if (capabilities.merge.expectedHeadSha) flags.push("merge.expectedHeadSha");
  if (capabilities.create.supported) flags.push("create");
  if (capabilities.create.draft) flags.push("create.draft");
  return flags.toSorted();
}

describe("change request host capabilities", () => {
  it("states every flag for every provider kind", () => {
    const keys = Object.keys(getChangeRequestHostCapabilities("github")).toSorted();
    for (const kind of KINDS) {
      const capabilities = getChangeRequestHostCapabilities(kind);
      expect(Object.keys(capabilities).toSorted(), kind).toEqual(keys);
      for (const flag of BOOLEAN_FLAGS)
        expect(typeof capabilities[flag], `${kind}.${flag}`).toBe("boolean");
    }
  });

  it("gives GitHub everything the page implements", () => {
    const github = getChangeRequestHostCapabilities("github");
    for (const flag of BOOLEAN_FLAGS) expect(github[flag], flag).toBe(true);
    expect(github.submitReview).toEqual({
      comment: true,
      approve: true,
      requestChanges: true,
      pendingReview: true,
    });
    expect([...github.lifecycle].toSorted()).toEqual([...ALL_ACTIONS].toSorted());
    expect([...github.updateBranchMethods].toSorted()).toEqual(["merge", "rebase"]);
    expect(github.listReadiness).toBe("verdict");
    expect(github.idleRefresh).toBe("standard");
    expect([...github.merge.methods].toSorted()).toEqual([...ALL_METHODS].toSorted());
    expect(github.merge.deleteBranch).toBe(true);
    expect(github.merge.expectedHeadSha).toBe(true);
    expect(github.create).toEqual({ supported: true, draft: true });
  });

  it("gives the other hosts exactly what their providers implement today", () => {
    expect(enabledFlags(getChangeRequestHostCapabilities("gitlab"))).toEqual(
      [
        "activity",
        "checkRollup",
        "checkout",
        "comment",
        "commitDiffs",
        "create",
        "create.draft",
        "deleteComments",
        "diff",
        "editComments",
        "fileContents",
        "idleRefresh.slow",
        "involvementFilters",
        "lifecycle.assignees",
        "lifecycle.auto-merge",
        "lifecycle.close",
        "lifecycle.delete-branch",
        "lifecycle.edit",
        "lifecycle.labels",
        "lifecycle.reopen",
        "lifecycle.reviewers",
        "lifecycle.set-draft",
        "lifecycle.update-branch",
        "lineComments",
        "listCheckRollup",
        "listReadiness.verdict",
        "merge.deleteBranch",
        "merge.expectedHeadSha",
        "merge.merge",
        "merge.rebase",
        "merge.squash",
        "mergeReadiness",
        "replyToThreads",
        "rerunWorkflows",
        "resolveThreads",
        "search",
        "submitReview.approve",
        "submitReview.comment",
        "submitReview.pendingReview",
        "submitReview.requestChanges",
        "updateBranch.rebase",
        "workflowJobLogs",
        "workflowRuns",
      ].toSorted(),
    );
    expect(enabledFlags(getChangeRequestHostCapabilities("azure-devops"))).toEqual(
      [
        "activity",
        "checkout",
        "comment",
        "commitDiffs",
        "create",
        "create.draft",
        "deleteComments",
        "diff",
        "editComments",
        "fileContents",
        "idleRefresh.slow",
        "involvementFilters",
        "lifecycle.auto-merge",
        "lifecycle.close",
        "lifecycle.delete-branch",
        "lifecycle.edit",
        "lifecycle.labels",
        "lifecycle.reopen",
        "lifecycle.reviewers",
        "lifecycle.set-draft",
        "lineComments",
        "listReadiness.blockers",
        "merge.deleteBranch",
        "merge.expectedHeadSha",
        "merge.merge",
        "merge.rebase",
        "merge.squash",
        "mergeReadiness",
        "replyToThreads",
        "resolveThreads",
        "search",
        "submitReview.approve",
        "submitReview.comment",
        "submitReview.requestChanges",
      ].toSorted(),
    );
    expect(enabledFlags(getChangeRequestHostCapabilities("bitbucket"))).toEqual(
      [
        "activity",
        "checkRollup",
        "checkout",
        "comment",
        "commitDiffs",
        "create",
        "create.draft",
        "deleteComments",
        "diff",
        "editComments",
        "fileContents",
        "involvementFilters",
        "lifecycle.close",
        "lifecycle.delete-branch",
        "lifecycle.edit",
        "lifecycle.reviewers",
        "lifecycle.set-draft",
        "lineComments",
        "listReadiness.none",
        "merge.deleteBranch",
        "merge.expectedHeadSha",
        "merge.merge",
        "merge.rebase",
        "merge.squash",
        "mergeReadiness",
        "replyToThreads",
        "resolveThreads",
        "search",
        "submitReview.approve",
        "submitReview.comment",
        "submitReview.requestChanges",
      ].toSorted(),
    );
    expect(enabledFlags(getChangeRequestHostCapabilities("forgejo"))).toEqual(
      [
        "activity",
        "checkRollup",
        "checkout",
        "comment",
        "commitDiffs",
        "create",
        "create.draft",
        "deleteComments",
        "diff",
        "editComments",
        "fileContents",
        "involvementFilters",
        "lifecycle.assignees",
        "lifecycle.close",
        "lifecycle.delete-branch",
        "lifecycle.edit",
        "lifecycle.labels",
        "lifecycle.reopen",
        "lifecycle.reviewers",
        "lifecycle.set-draft",
        "lifecycle.update-branch",
        "lineComments",
        "listCheckRollup",
        "listReadiness.blockers",
        "merge.deleteBranch",
        "merge.expectedHeadSha",
        "merge.merge",
        "merge.rebase",
        "merge.squash",
        "mergeReadiness",
        "reactions",
        "replyToThreads",
        "search",
        "submitReview.approve",
        "submitReview.comment",
        "submitReview.pendingReview",
        "submitReview.requestChanges",
        "updateBranch.merge",
        "updateBranch.rebase",
      ].toSorted(),
    );
    expect(enabledFlags(getChangeRequestHostCapabilities("unknown"))).toEqual([
      "listReadiness.none",
    ]);
  });

  // Each rule names what the dependent control reads: a provider entry that
  // breaks one would show a control that cannot work.
  it.each(KINDS)("keeps %s internally consistent", (kind) => {
    const c = getChangeRequestHostCapabilities(kind);
    const needsActivity =
      c.comment ||
      c.reactions ||
      c.editComments ||
      c.deleteComments ||
      c.lineComments ||
      c.replyToThreads ||
      c.resolveThreads ||
      canSubmitChangeRequestReview(c) ||
      c.submitReview.pendingReview ||
      c.lifecycle.size > 0 ||
      canMergeChangeRequests(c);
    // Viewer permissions, thread ids and comment ids all come from the activity read.
    if (needsActivity) expect(c.activity, "activity").toBe(true);
    if (c.lineComments) {
      expect(c.diff, "lineComments needs diff").toBe(true);
      expect(c.submitReview.comment, "lineComments needs comment reviews").toBe(true);
    }
    if (c.commitDiffs) expect(c.diff, "commitDiffs needs diff").toBe(true);
    if (c.fileContents) expect(c.diff, "fileContents needs diff").toBe(true);
    if (c.viewedFiles) expect(c.diff, "viewedFiles needs diff").toBe(true);
    if (c.workflowJobLogs || c.rerunWorkflows) expect(c.workflowRuns).toBe(true);
    if (c.merge.deleteBranch || c.merge.expectedHeadSha)
      expect(canMergeChangeRequests(c)).toBe(true);
    if (c.create.draft) expect(c.create.supported).toBe(true);
    // Rows cannot say more than the detail: a row fact is also a detail fact.
    if (c.listCheckRollup) expect(c.checkRollup, "listCheckRollup needs checkRollup").toBe(true);
    if (c.listReadiness !== "none") expect(c.mergeReadiness).toBe(true);
    expect(c.lifecycle.has("update-branch"), "update-branch ⇔ a method").toBe(
      c.updateBranchMethods.size > 0,
    );
  });

  it("answers review verdicts and merge support", () => {
    const github = getChangeRequestHostCapabilities("github");
    const gitlab = getChangeRequestHostCapabilities("gitlab");
    expect(supportsChangeRequestReviewEvent(github, "approve")).toBe(true);
    expect(supportsChangeRequestReviewEvent(github, "request_changes")).toBe(true);
    expect(supportsChangeRequestReviewEvent(gitlab, "comment")).toBe(true);
    expect(canSubmitChangeRequestReview(github)).toBe(true);
    expect(canSubmitChangeRequestReview(gitlab)).toBe(true);
    expect(canSubmitChangeRequestReview(getChangeRequestHostCapabilities("unknown"))).toBe(false);
    expect(canMergeChangeRequests(github)).toBe(true);
    expect(canMergeChangeRequests(gitlab)).toBe(true);
    expect(canMergeChangeRequests(getChangeRequestHostCapabilities("unknown"))).toBe(false);
  });
});

describe("describeUnsupportedChangeRequestRequest", () => {
  it("passes every request GitHub serves", () => {
    const requests = [
      { operation: "listChangeRequests", involvement: "authored", query: "bug" },
      { operation: "getChangeRequestDiff", commitSha: "abc" },
      { operation: "createChangeRequest", draft: true },
      { operation: "submitChangeRequestReview", event: "approve", commentCount: 2 },
      { operation: "updateChangeRequest", action: "auto-merge" },
      {
        operation: "mergeChangeRequest",
        mergeMethod: "rebase",
        deleteBranch: true,
        expectedHeadSha: "abc",
      },
      { operation: "updateChangeRequestComment", action: "delete" },
      { operation: "rerunWorkflow" },
    ] as const;
    for (const request of requests) {
      expect(describeUnsupportedChangeRequestRequest("github", request)).toBeNull();
    }
  });

  it("names the host and the missing feature in the host's own terms", () => {
    expect(
      describeUnsupportedChangeRequestRequest("gitlab", {
        operation: "addChangeRequestCommentReaction",
      }),
    ).toBe("GitLab does not support comment reactions.");
    // GitLab rebases but cannot merge the target branch in.
    expect(
      describeUnsupportedChangeRequestRequest("gitlab", {
        operation: "updateChangeRequest",
        action: "update-branch",
        updateBranchMethod: "merge",
      }),
    ).toBe("GitLab does not support updating branches by merging the base in.");
    expect(
      describeUnsupportedChangeRequestRequest("gitlab", {
        operation: "updateChangeRequest",
        action: "update-branch",
        updateBranchMethod: "rebase",
      }),
    ).toBeNull();
    expect(preferredUpdateBranchMethod(getChangeRequestHostCapabilities("gitlab"))).toBe("rebase");
    expect(preferredUpdateBranchMethod(getChangeRequestHostCapabilities("github"))).toBe("merge");
    expect(preferredUpdateBranchMethod(getChangeRequestHostCapabilities("bitbucket"))).toBeNull();
    expect(
      describeUnsupportedChangeRequestRequest("bitbucket", {
        operation: "updateChangeRequest",
        action: "reopen",
      }),
    ).toBe("Bitbucket does not support reopening pull requests.");
    expect(
      describeUnsupportedChangeRequestRequest("bitbucket", {
        operation: "addChangeRequestCommentReaction",
      }),
    ).toBe("Bitbucket does not support comment reactions.");
    expect(
      describeUnsupportedChangeRequestRequest("forgejo", {
        operation: "updateChangeRequest",
        action: "auto-merge",
      }),
    ).toBe("Forgejo does not support auto-merge.");
    expect(
      describeUnsupportedChangeRequestRequest("azure-devops", {
        operation: "updateChangeRequest",
        action: "update-branch",
      }),
    ).toBe("Azure DevOps does not support updating branches from their base.");
    expect(
      describeUnsupportedChangeRequestRequest("unknown", { operation: "searchChangeRequests" }),
    ).toBe("This source control provider does not support searching change requests.");
  });

  it("lets plain reads and creates through on hosts that serve them", () => {
    expect(
      describeUnsupportedChangeRequestRequest("gitlab", { operation: "listChangeRequests" }),
    ).toBeNull();
    expect(
      describeUnsupportedChangeRequestRequest("gitlab", {
        operation: "listChangeRequests",
        query: "  ",
      }),
    ).toBeNull();
    expect(
      describeUnsupportedChangeRequestRequest("bitbucket", { operation: "getChangeRequestDiff" }),
    ).toBeNull();
    expect(
      describeUnsupportedChangeRequestRequest("forgejo", { operation: "createChangeRequest" }),
    ).toBeNull();
    expect(
      describeUnsupportedChangeRequestRequest("forgejo", {
        operation: "createChangeRequest",
        draft: true,
      }),
    ).toBeNull();
    expect(
      describeUnsupportedChangeRequestRequest("bitbucket", {
        operation: "getChangeRequestDiff",
        commitSha: "abc",
      }),
    ).toBeNull();
    expect(
      describeUnsupportedChangeRequestRequest("bitbucket", {
        operation: "listChangeRequests",
        involvement: "review-requested",
        query: "fix",
      }),
    ).toBeNull();
  });
});

describe("changeRequestCommitUrl", () => {
  it("links GitHub commits under the pull request and nothing elsewhere", () => {
    expect(changeRequestCommitUrl("github", "https://github.com/a/b/pull/7/", "abc")).toBe(
      "https://github.com/a/b/pull/7/commits/abc",
    );
    expect(changeRequestCommitUrl("github", null, "abc")).toBeNull();
    expect(
      changeRequestCommitUrl("gitlab", "https://gitlab.com/g/p/-/merge_requests/7", "abc"),
    ).toBeNull();
  });
});
