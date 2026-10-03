import { describe, expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import {
  GITLAB_APPROVALS,
  GITLAB_MERGE_REQUEST,
  GITLAB_PROJECT,
  GITLAB_REVIEWERS,
} from "./gitLabMergeRequestPage.fixtures.ts";
import {
  GitLabApprovalStateSchema,
  GitLabProjectSchema,
  GitLabReviewerSchema,
  decodeGitLabMergeRequestDetailJson,
  decodeGitLabMergeRequestListJson,
  gitLabAutoMerge,
  gitLabDraftTitle,
  gitLabMergeCapabilities,
  gitLabMergeStateStatus,
  gitLabMergeability,
  gitLabReviewDecision,
  gitLabReviewerStates,
  stripGitLabDraftPrefix,
} from "./gitLabMergeRequests.ts";

describe("decodeGitLabMergeRequestListJson (sanity for existing list shape)", () => {
  it("decodes minimal MR list", () => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: "MR title",
        web_url: "https://gitlab.com/owner/repo/-/merge_requests/1",
        target_branch: "main",
        source_branch: "feature/x",
        state: "opened",
      },
    ]);
    const result = decodeGitLabMergeRequestListJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("carries the merge state the list's `detailed_merge_status` reports on open rows", () => {
    // The docs' merge request as list rows, each blocked a different way.
    const rows = [
      { ...GITLAB_MERGE_REQUEST, iid: 1, detailed_merge_status: "need_rebase" },
      { ...GITLAB_MERGE_REQUEST, iid: 2, detailed_merge_status: "discussions_not_resolved" },
      { ...GITLAB_MERGE_REQUEST, iid: 3, detailed_merge_status: "ci_must_pass" },
      { ...GITLAB_MERGE_REQUEST, iid: 4, detailed_merge_status: "mergeable" },
      { ...GITLAB_MERGE_REQUEST, iid: 5, draft: true, detailed_merge_status: "draft_status" },
      { ...GITLAB_MERGE_REQUEST, iid: 6, state: "merged", detailed_merge_status: "not_open" },
    ];
    const result = decodeGitLabMergeRequestListJson(JSON.stringify(rows));
    if (!Result.isSuccess(result)) throw new Error("decode failed");
    expect(
      result.success.map((row) => [row.number, row.mergeability, row.mergeStateStatus]),
    ).toEqual([
      [1, "mergeable", "behind"],
      [2, "mergeable", "blocked"],
      [3, "mergeable", "blocked"],
      [4, "mergeable", "clean"],
      [5, "mergeable", "draft"],
      [6, "mergeable", undefined],
    ]);
  });
});

describe("decodeGitLabMergeRequestDetailJson", () => {
  it("decodes description and notes as body + comments", () => {
    const raw = JSON.stringify({
      iid: 12,
      title: "Add feature",
      web_url: "https://gitlab.com/owner/repo/-/merge_requests/12",
      target_branch: "main",
      source_branch: "feature/add",
      state: "opened",
      description: "MR body text",
      notes: [
        {
          author: { username: "reviewer" },
          body: "looks good",
          created_at: "2026-03-01T10:00:00Z",
        },
      ],
    });
    const result = decodeGitLabMergeRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.number).toBe(12);
    expect(result.success.body).toBe("MR body text");
    expect(result.success.comments).toHaveLength(1);
    expect(result.success.comments[0]?.author).toBe("reviewer");
  });

  it("handles missing description / notes gracefully", () => {
    const raw = JSON.stringify({
      iid: 13,
      title: "no body",
      web_url: "https://gitlab.com/owner/repo/-/merge_requests/13",
      target_branch: "main",
      source_branch: "feature/empty",
      state: "merged",
    });
    const result = decodeGitLabMergeRequestDetailJson(raw);
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.body).toBe("");
    expect(result.success.comments).toEqual([]);
  });
});

describe("GitLab merge request readiness", () => {
  const facts = () => {
    const result = decodeGitLabMergeRequestDetailJson(JSON.stringify(GITLAB_MERGE_REQUEST));
    if (!Result.isSuccess(result) || !result.success.facts) throw new Error("decode failed");
    return { detail: result.success, facts: result.success.facts };
  };

  it("decodes the docs' single merge request into record fields and facts", () => {
    const { detail, facts: decoded } = facts();
    expect(detail).toMatchObject({
      number: 133,
      isDraft: false,
      author: "marcel.amirault",
      commentsCount: 0,
      headSha: "e82eb4a098e32c796079ca3915e07487fc4db24c",
      mergeability: "mergeable",
      isCrossRepository: false,
    });
    expect(decoded).toMatchObject({
      iid: 133,
      authorId: 4155490,
      headSha: "e82eb4a098e32c796079ca3915e07487fc4db24c",
      diffRefs: GITLAB_MERGE_REQUEST.diff_refs,
      canMerge: true,
      discussionLocked: false,
      autoMergeEnabled: false,
      forceRemoveSourceBranch: true,
      headPipeline: {
        id: 538317940,
        iid: 1877,
        name: null,
        sha: "1604b0c46c395822e4e9478777f8e54ac99fe5b9",
      },
      detailedMergeStatus: "mergeable",
      changesCount: 1,
      targetBranch: "main",
      sourceBranch: "manual-job-rules",
      state: "open",
    });
  });

  it("maps merge status and conflicts", () => {
    expect(gitLabMergeStateStatus("mergeable")).toBe("clean");
    expect(gitLabMergeStateStatus("need_rebase")).toBe("behind");
    expect(gitLabMergeStateStatus("conflict")).toBe("dirty");
    expect(gitLabMergeStateStatus("draft_status")).toBe("draft");
    // GitLab refuses these merges outright: never "unstable".
    expect(gitLabMergeStateStatus("ci_must_pass")).toBe("blocked");
    expect(gitLabMergeStateStatus("ci_still_running")).toBe("blocked");
    expect(gitLabMergeStateStatus("not_approved")).toBe("blocked");
    expect(gitLabMergeStateStatus("discussions_not_resolved")).toBe("blocked");
    expect(gitLabMergeStateStatus("checking")).toBe("unknown");
    expect(gitLabMergeStateStatus(null)).toBeUndefined();
    expect(gitLabMergeability({ hasConflicts: true, detailedMergeStatus: "conflict" })).toBe(
      "conflicting",
    );
    expect(gitLabMergeability({ hasConflicts: false, detailedMergeStatus: "checking" })).toBe(
      "unknown",
    );
    expect(gitLabMergeability({ hasConflicts: false, mergeStatus: "can_be_merged" })).toBe(
      "mergeable",
    );
    expect(gitLabMergeability({})).toBeUndefined();
  });

  it("combines reviewer states with approvals into the verdict", () => {
    const reviewers = GITLAB_REVIEWERS.map((reviewer) =>
      Schema.decodeUnknownSync(GitLabReviewerSchema)(reviewer),
    );
    const approvals = Schema.decodeUnknownSync(GitLabApprovalStateSchema)(GITLAB_APPROVALS);
    const states = gitLabReviewerStates({ reviewers, approvals });
    expect(states).toMatchObject([
      { login: "user1", kind: "user", state: "requested" },
      { login: "user2", kind: "user", state: "commented" },
      { login: "root", kind: "user", state: "approved" },
      { login: "ryley", kind: "user", state: "approved" },
    ]);
    expect(gitLabReviewDecision({ reviewerStates: states, approvals })).toBe("approved");
    expect(
      gitLabReviewDecision({
        reviewerStates: states,
        approvals: { ...approvals, approvals_left: 1 },
      }),
    ).toBe("review_required");
    expect(
      gitLabReviewDecision({
        reviewerStates: [{ login: "user1", kind: "user", state: "changes_requested" }],
        approvals,
      }),
    ).toBe("changes_requested");
    expect(
      gitLabReviewDecision({
        reviewerStates: [],
        approvals: { approved_by: [], approvals_left: 0 },
      }),
    ).toBeNull();
  });

  it("offers the project's merge method and squash per its settings", () => {
    const project = Schema.decodeUnknownSync(GitLabProjectSchema)(GITLAB_PROJECT);
    expect(gitLabMergeCapabilities(project)).toEqual({ merge: true, squash: true, rebase: false });
    expect(gitLabMergeCapabilities({ ...project, merge_method: "ff" })).toEqual({
      merge: false,
      squash: true,
      rebase: true,
    });
    expect(gitLabMergeCapabilities({ ...project, merge_method: "rebase_merge" })).toMatchObject({
      merge: true,
      rebase: false,
    });
    expect(gitLabMergeCapabilities({ ...project, squash_option: "never" }).squash).toBe(false);
    expect(gitLabMergeCapabilities({ ...project, squash_option: "always" })).toEqual({
      merge: false,
      squash: true,
      rebase: false,
    });
    expect(
      gitLabAutoMerge({
        facts: { ...facts().facts, autoMergeEnabled: true, autoMergeBy: "root" },
        project,
      }),
    ).toEqual({ mergeMethod: "merge", enabledBy: "root" });
  });

  it("marks drafts by title prefix", () => {
    expect(gitLabDraftTitle("Add feature", true)).toBe("Draft: Add feature");
    expect(gitLabDraftTitle("Draft: Add feature", true)).toBe("Draft: Add feature");
    expect(gitLabDraftTitle("[Draft] (Draft) WIP: Add feature", false)).toBe("Add feature");
    expect(stripGitLabDraftPrefix("Drafting rules")).toBe("Drafting rules");
  });

  it("enriches list rows from glab's list JSON", () => {
    const result = decodeGitLabMergeRequestListJson(
      JSON.stringify([
        {
          ...GITLAB_MERGE_REQUEST,
          draft: true,
          labels: ["bug", { name: "p1", color: "#0033CC", description: "Priority" }],
          assignees: [{ id: 1, username: "root" }],
          has_conflicts: true,
        },
        { ...GITLAB_MERGE_REQUEST, iid: 134, detailed_merge_status: "not_approved" },
        { ...GITLAB_MERGE_REQUEST, iid: 135, detailed_merge_status: "requested_changes" },
      ]),
    );
    const rows = Result.isSuccess(result) ? result.success : [];
    // Rows state only the verdicts GitLab's merge status names; never "approved".
    expect(rows.map((row) => row.reviewDecision)).toEqual([
      undefined,
      "review_required",
      "changes_requested",
    ]);
    expect(Result.isSuccess(result) && result.success[0]).toMatchObject({
      isDraft: true,
      labels: [{ name: "bug" }, { name: "p1", color: "0033cc", description: "Priority" }],
      assignees: ["root"],
      mergeability: "conflicting",
    });
  });
});
