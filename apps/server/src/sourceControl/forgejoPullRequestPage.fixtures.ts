/**
 * Forgejo REST v1 payloads for the pull request page tests.
 *
 * Each fixture is shaped exactly like the API definition it is named after in
 * Forgejo's OpenAPI document (https://codeberg.org/api/swagger, served as
 * `/swagger.v1.json`; field set checked against Forgejo 16.0-dev, which
 * reports itself as gitea-1.22.0 compatible) and as Forgejo's converters
 * fill it: `services/convert/pull.go` (PullRequest), `pull_review.go`
 * (PullReview, PullReviewComment), `issue_comment.go` (TimelineComment) and
 * `repository.go` (Repository). Values are illustrative; field names, types
 * and nullability are not.
 */

const zeroTime = "0001-01-01T00:00:00Z";

/** `User`. */
export function forgejoUser(id: number, login: string, fullName = "") {
  return {
    id,
    login,
    login_name: "",
    source_id: 0,
    full_name: fullName,
    email: `${login}@noreply.codeberg.test`,
    avatar_url: `https://codeberg.test/avatars/${login}`,
    html_url: `https://codeberg.test/${login}`,
    language: "",
    is_admin: false,
    last_login: zeroTime,
    created: "2024-01-02T10:00:00Z",
    restricted: false,
    active: false,
    prohibit_login: false,
    location: "",
    pronouns: "",
    website: "",
    description: "",
    visibility: "public",
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    username: login,
  };
}

export const alice = forgejoUser(2, "alice", "Alice");
export const bob = forgejoUser(3, "bob", "Bob");
export const carol = forgejoUser(4, "carol");
export const dave = forgejoUser(5, "dave");
export const erin = forgejoUser(6, "erin");

/** `Repository` (base repository, read with a token so `permissions` is set). */
export const forgejoBaseRepository = {
  id: 12,
  owner: forgejoUser(10, "pingdotgg", "pingdotgg"),
  name: "ryco",
  full_name: "pingdotgg/ryco",
  description: "",
  empty: false,
  private: false,
  fork: false,
  template: false,
  parent: null,
  mirror: false,
  size: 1024,
  language: "TypeScript",
  languages_url: "https://codeberg.test/api/v1/repos/pingdotgg/ryco/languages",
  html_url: "https://codeberg.test/pingdotgg/ryco",
  url: "https://codeberg.test/api/v1/repos/pingdotgg/ryco",
  link: "",
  ssh_url: "git@codeberg.test:pingdotgg/ryco.git",
  clone_url: "https://codeberg.test/pingdotgg/ryco.git",
  original_url: "",
  website: "",
  stars_count: 0,
  forks_count: 1,
  watchers_count: 1,
  open_issues_count: 0,
  open_pr_counter: 1,
  release_counter: 0,
  default_branch: "main",
  archived: false,
  created_at: "2024-01-02T10:00:00Z",
  updated_at: "2026-03-14T10:00:00Z",
  archived_at: "1970-01-01T00:00:00Z",
  permissions: { admin: false, push: true, pull: true },
  has_issues: true,
  internal_tracker: {
    enable_time_tracker: true,
    allow_only_contributors_to_track_time: true,
    enable_issue_dependencies: true,
  },
  has_wiki: true,
  wiki_branch: "main",
  globally_editable_wiki: false,
  has_pull_requests: true,
  has_projects: true,
  has_releases: true,
  has_packages: true,
  has_actions: true,
  ignore_whitespace_conflicts: false,
  allow_merge_commits: true,
  allow_rebase: true,
  allow_rebase_explicit: true,
  allow_squash_merge: false,
  allow_fast_forward_only_merge: true,
  allow_rebase_update: true,
  default_delete_branch_after_merge: false,
  default_merge_style: "merge",
  default_update_style: "merge",
  default_allow_maintainer_edit: false,
  avatar_url: "",
  internal: false,
  mirror_interval: "",
  object_format_name: "sha1",
  mirror_updated: zeroTime,
  repo_transfer: null,
  topics: [],
};

const headSha = "4f2a9c1e0b7d63a85e9f10c2d4b6a8e0f1c3d5e7";
const baseSha = "9b8a7c6d5e4f30211234567890abcdef12345678";
export const forgejoHeadSha = headSha;
export const forgejoMergeBaseSha = "1111111111111111111111111111111111111111";
export const forgejoOldHeadSha = "2222222222222222222222222222222222222222";

/** `PullRequest` (`GET /repos/{owner}/{repo}/pulls/{index}`), same-repository head. */
export const forgejoPullRequest = {
  id: 501,
  url: "https://codeberg.test/pingdotgg/ryco/pulls/42",
  number: 42,
  user: alice,
  title: "Add Forgejo review page",
  body: "Implements the review page.",
  labels: [
    {
      id: 7,
      name: "enhancement",
      exclusive: false,
      is_archived: false,
      color: "84b6eb",
      description: "New feature",
      url: "https://codeberg.test/api/v1/repos/pingdotgg/ryco/labels/7",
    },
  ],
  milestone: null,
  assignee: bob,
  assignees: [bob],
  requested_reviewers: [erin],
  requested_reviewers_teams: [],
  state: "open",
  draft: false,
  is_locked: false,
  comments: 2,
  review_comments: 3,
  additions: 30,
  deletions: 4,
  changed_files: 3,
  html_url: "https://codeberg.test/pingdotgg/ryco/pulls/42",
  diff_url: "https://codeberg.test/pingdotgg/ryco/pulls/42.diff",
  patch_url: "https://codeberg.test/pingdotgg/ryco/pulls/42.patch",
  mergeable: true,
  merged: false,
  merged_at: null,
  merge_commit_sha: null,
  merged_by: null,
  allow_maintainer_edit: false,
  base: {
    label: "main",
    ref: "main",
    sha: baseSha,
    repo_id: 12,
    repo: forgejoBaseRepository,
  },
  head: {
    label: "feature/review-page",
    ref: "feature/review-page",
    sha: headSha,
    repo_id: 12,
    repo: forgejoBaseRepository,
  },
  merge_base: forgejoMergeBaseSha,
  due_date: null,
  created_at: "2026-03-10T09:00:00Z",
  updated_at: "2026-03-14T10:00:00Z",
  closed_at: null,
  pin_order: 0,
  flow: 0,
};

/** `TimelineComment` base (`GET /repos/{owner}/{repo}/issues/{index}/timeline`). */
function timelineComment(
  id: number,
  type: string,
  user: ReturnType<typeof forgejoUser>,
  createdAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type,
    html_url: `https://codeberg.test/pingdotgg/ryco/pulls/42#issuecomment-${id}`,
    pull_request_url: "https://codeberg.test/pingdotgg/ryco/pulls/42",
    issue_url: "",
    user,
    body: "",
    created_at: createdAt,
    updated_at: createdAt,
    old_project_id: 0,
    project_id: 0,
    old_title: "",
    new_title: "",
    old_ref: "",
    new_ref: "",
    ref_action: "",
    ref_commit_sha: "",
    review_id: 0,
    removed_assignee: false,
    ...extra,
  };
}

export const forgejoTimeline = [
  timelineComment(900, "label", alice, "2026-03-10T09:01:00Z", {
    body: "1",
    label: forgejoPullRequest.labels[0],
  }),
  timelineComment(901, "review_request", alice, "2026-03-10T09:02:00Z", {
    assignee: erin,
    review_id: 104,
  }),
  timelineComment(902, "comment", bob, "2026-03-11T08:00:00Z", {
    body: "Looks promising.\n\n<!-- ryco-comment-id:0000000000000000000000000000000000000000000000000000000000000000 -->",
    updated_at: "2026-03-11T08:05:00Z",
  }),
  timelineComment(903, "review", dave, "2026-03-11T09:00:00Z", {
    body: "A few notes inline.",
    review_id: 101,
  }),
  timelineComment(904, "pull_push", alice, "2026-03-12T07:00:00Z", {
    body: JSON.stringify({ is_force_push: true, commit_ids: [forgejoOldHeadSha, headSha] }),
  }),
  timelineComment(905, "pull_push", alice, "2026-03-12T07:30:00Z", {
    body: JSON.stringify({ is_force_push: false, commit_ids: [headSha] }),
  }),
  timelineComment(906, "review", bob, "2026-03-12T08:00:00Z", { body: "", review_id: 102 }),
  timelineComment(907, "assignees", alice, "2026-03-12T08:10:00Z", {
    assignee: bob,
    removed_assignee: false,
  }),
  timelineComment(908, "change_title", alice, "2026-03-12T08:20:00Z", {
    old_title: "WIP: Add Forgejo review page",
    new_title: "Add Forgejo review page",
  }),
  timelineComment(909, "change_target_branch", alice, "2026-03-12T08:30:00Z", {
    old_ref: "develop",
    new_ref: "main",
  }),
  timelineComment(910, "pull_ref", carol, "2026-03-12T09:00:00Z", {
    ref_action: "closes",
    ref_issue: {
      id: 600,
      url: "https://codeberg.test/api/v1/repos/pingdotgg/ryco/issues/43",
      html_url: "https://codeberg.test/pingdotgg/ryco/pulls/43",
      number: 43,
      user: carol,
      original_author: "",
      original_author_id: 0,
      title: "Follow-up fixes",
      body: "Fixes #42",
      ref: "",
      assets: [],
      labels: [],
      milestone: null,
      assignee: null,
      assignees: null,
      state: "open",
      is_locked: false,
      comments: 0,
      created_at: "2026-03-12T09:00:00Z",
      updated_at: "2026-03-12T09:00:00Z",
      closed_at: null,
      due_date: null,
      pull_request: {
        merged: false,
        merged_at: null,
        draft: false,
        html_url: "https://codeberg.test/pingdotgg/ryco/pulls/43",
      },
      repository: { id: 12, name: "ryco", owner: "pingdotgg", full_name: "pingdotgg/ryco" },
      pin_order: 0,
    },
  }),
  timelineComment(911, "review", carol, "2026-03-13T10:00:00Z", {
    body: "Please split this.",
    review_id: 103,
  }),
  timelineComment(912, "dismiss_review", alice, "2026-03-13T11:00:00Z", {
    body: "Addressed in the latest push.",
    review_id: 103,
  }),
  timelineComment(913, "milestone", alice, "2026-03-13T12:00:00Z"),
  timelineComment(914, "close", alice, "2026-03-13T13:00:00Z"),
  timelineComment(915, "reopen", alice, "2026-03-13T13:05:00Z"),
  timelineComment(916, "delete_branch", alice, "2026-03-13T13:10:00Z", {
    body: "feature/old",
  }),
];

/** `PullReview` (`GET /repos/{owner}/{repo}/pulls/{index}/reviews`). */
function pullReview(
  id: number,
  user: ReturnType<typeof forgejoUser>,
  state: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    user,
    team: null,
    state,
    body: "",
    commit_id: headSha,
    stale: false,
    official: false,
    dismissed: false,
    comments_count: 0,
    submitted_at: "2026-03-11T09:00:00Z",
    updated_at: "2026-03-11T09:00:00Z",
    html_url: `https://codeberg.test/pingdotgg/ryco/pulls/42#issuecomment-${id}`,
    pull_request_url: "https://codeberg.test/pingdotgg/ryco/pulls/42",
    ...extra,
  };
}

export const forgejoReviews = [
  pullReview(101, dave, "COMMENT", {
    body: "A few notes inline.",
    commit_id: forgejoOldHeadSha,
    comments_count: 3,
  }),
  pullReview(102, bob, "APPROVED", {
    official: true,
    submitted_at: "2026-03-12T08:00:00Z",
    updated_at: "2026-03-12T08:00:00Z",
  }),
  pullReview(103, carol, "REQUEST_CHANGES", {
    body: "Please split this.",
    official: true,
    dismissed: true,
    submitted_at: "2026-03-13T10:00:00Z",
  }),
  pullReview(104, erin, "REQUEST_REVIEW", { submitted_at: "2026-03-10T09:02:00Z" }),
  pullReview(105, alice, "PENDING", {
    comments_count: 1,
    submitted_at: "2026-03-14T09:00:00Z",
  }),
];

/** `PullReviewComment` (`GET /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments`). */
function reviewComment(
  id: number,
  reviewId: number,
  user: ReturnType<typeof forgejoUser>,
  extra: Record<string, unknown>,
) {
  return {
    id,
    body: "",
    user,
    resolver: null,
    pull_request_review_id: reviewId,
    created_at: "2026-03-11T09:00:00Z",
    updated_at: "2026-03-11T09:00:00Z",
    path: "src/app.ts",
    commit_id: forgejoOldHeadSha,
    original_commit_id: "",
    diff_hunk: "",
    position: 0,
    original_position: 0,
    html_url: `https://codeberg.test/pingdotgg/ryco/pulls/42/files#issuecomment-${id}`,
    pull_request_url: "https://codeberg.test/pingdotgg/ryco/pulls/42",
    ...extra,
  };
}

/** The excerpt ends at new line 12 (`const c = 4;`). */
export const forgejoRightHunk =
  "@@ -10,3 +10,4 @@ export function run() {\n   const a = 1;\n-  const b = 2;\n+  const b = 3;\n+  const c = 4;";
/** The excerpt ends at old line 5 (`legacy();`). */
export const forgejoLeftHunk = "@@ -3,3 +3,2 @@\n setup();\n teardown();\n-legacy();";

export const forgejoReviewComments: Record<number, ReadonlyArray<Record<string, unknown>>> = {
  101: [
    reviewComment(301, 101, dave, {
      body: "Should `c` be configurable?",
      diff_hunk: forgejoRightHunk,
      position: 12,
      resolver: alice,
    }),
    reviewComment(302, 101, alice, {
      body: "Done.",
      created_at: "2026-03-11T10:00:00Z",
      updated_at: "2026-03-11T10:00:00Z",
      diff_hunk: forgejoRightHunk,
      position: 12,
    }),
    reviewComment(303, 101, dave, {
      body: "Why remove legacy()?",
      path: "src/setup.ts",
      diff_hunk: forgejoLeftHunk,
      original_position: 5,
    }),
  ],
  105: [
    reviewComment(304, 105, alice, {
      body: "Draft note",
      commit_id: headSha,
      created_at: "2026-03-14T09:00:00Z",
      updated_at: "2026-03-14T09:00:00Z",
      path: "src/other.ts",
      diff_hunk: "@@ -1,1 +1,2 @@\n line one\n+line two",
      position: 2,
    }),
  ],
};

/** `Commit` (`GET /repos/{owner}/{repo}/pulls/{index}/commits?verification=false&files=false`). */
export const forgejoPullRequestCommits = [
  {
    url: `https://codeberg.test/api/v1/repos/pingdotgg/ryco/git/commits/${headSha}`,
    sha: headSha,
    created: "2026-03-12T06:55:00Z",
    html_url: `https://codeberg.test/pingdotgg/ryco/commit/${headSha}`,
    commit: {
      url: `https://codeberg.test/api/v1/repos/pingdotgg/ryco/git/commits/${headSha}`,
      author: { name: "Alice", email: "alice@example.test", date: "2026-03-12T06:50:00Z" },
      committer: { name: "Alice", email: "alice@example.test", date: "2026-03-12T06:55:00Z" },
      message: "Render review threads\n\nWith outdated detection.",
      tree: { url: "", sha: "ffffffffffffffffffffffffffffffffffffffff", created: zeroTime },
      verification: null,
    },
    author: alice,
    committer: alice,
    parents: [{ url: "", sha: forgejoMergeBaseSha, created: zeroTime }],
    files: null,
    stats: null,
  },
];

/** `Reaction` list (`GET /repos/{owner}/{repo}/issues/comments/{id}/reactions`). */
export const forgejoReactions = [
  { user: bob, content: "+1", created_at: "2026-03-11T08:10:00Z" },
  { user: carol, content: "+1", created_at: "2026-03-11T08:11:00Z" },
  { user: alice, content: "heart", created_at: "2026-03-11T08:12:00Z" },
  { user: dave, content: "custom_party", created_at: "2026-03-11T08:13:00Z" },
];

/** `Branch` (`GET /repos/{owner}/{repo}/branches/{branch}`) for a protected base. */
export const forgejoProtectedBranch = {
  name: "main",
  commit: {
    id: baseSha,
    message: "Merge pull request #41",
    url: `https://codeberg.test/pingdotgg/ryco/commit/${baseSha}`,
    author: { name: "bob", email: "bob@example.test", username: "bob" },
    committer: { name: "bob", email: "bob@example.test", username: "bob" },
    verification: null,
    timestamp: "2026-03-09T12:00:00Z",
    added: null,
    removed: null,
    modified: null,
  },
  protected: true,
  required_approvals: 1,
  enable_status_check: true,
  status_check_contexts: ["ci/build", "lint/*"],
  user_can_push: false,
  user_can_merge: true,
  effective_branch_protection_name: "main",
};

/** `CombinedStatus` (`GET /repos/{owner}/{repo}/commits/{ref}/status`). */
export const forgejoCombinedStatus = {
  state: "failure",
  sha: headSha,
  total_count: 3,
  statuses: [
    {
      id: 71,
      status: "success",
      target_url: "https://ci.example.test/build/71",
      description: "Build passed",
      url: `https://codeberg.test/api/v1/repos/pingdotgg/ryco/statuses/${headSha}`,
      context: "ci/build",
      creator: bob,
      created_at: "2026-03-12T07:00:00Z",
      updated_at: "2026-03-12T07:04:00Z",
    },
    {
      id: 72,
      status: "pending",
      target_url: "https://ci.example.test/lint/72",
      description: "Linting",
      url: `https://codeberg.test/api/v1/repos/pingdotgg/ryco/statuses/${headSha}`,
      context: "lint/eslint",
      creator: bob,
      created_at: "2026-03-12T07:00:00Z",
      updated_at: "2026-03-12T07:00:00Z",
    },
    {
      id: 73,
      status: "failure",
      target_url: "",
      description: "Coverage dropped",
      url: `https://codeberg.test/api/v1/repos/pingdotgg/ryco/statuses/${headSha}`,
      context: "coverage",
      creator: bob,
      created_at: "2026-03-12T07:00:00Z",
      updated_at: "2026-03-12T07:06:00Z",
    },
  ],
  commit_url: `https://codeberg.test/api/v1/repos/pingdotgg/ryco/commits/${headSha}`,
  url: `https://codeberg.test/api/v1/repos/pingdotgg/ryco/commits/${headSha}/status`,
  repository: forgejoBaseRepository,
};

/** The change request diff (`GET /repos/{owner}/{repo}/pulls/{index}.diff`) at the current head. */
export const forgejoPullRequestDiff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,2 +10,4 @@ export function run() {",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "+  const d = 5;",
  "diff --git a/src/setup.ts b/src/setup.ts",
  "index 3333333..4444444 100644",
  "--- a/src/setup.ts",
  "+++ b/src/setup.ts",
  "@@ -3,3 +3,3 @@",
  " setup();",
  " teardown();",
  "-legacy();",
  "+modern();",
  "",
].join("\n");
