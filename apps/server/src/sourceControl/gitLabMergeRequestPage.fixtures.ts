/**
 * GitLab REST v4 payloads for the pull request page tests, copied from the
 * example responses in the official API docs (GitLab `doc/api/*.md`,
 * published at https://docs.gitlab.com/api/). Where a docs example is not
 * valid JSON (comments, trailing commas, an elided `...`), only that syntax
 * was removed; field names and value shapes are the docs'. Values a scenario
 * needs (a SHA tying a thread to the head, a second note) are overridden in
 * the tests, never invented as new fields.
 */

// https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request
export const GITLAB_MERGE_REQUEST = {
  id: 155016530,
  iid: 133,
  project_id: 15513260,
  title: "Manual job rules",
  description: "",
  state: "opened",
  imported: false,
  imported_from: "none",
  created_at: "2022-05-13T07:26:38.402Z",
  updated_at: "2022-05-14T03:38:31.354Z",
  merged_by: null,
  merge_user: null,
  merged_at: null,
  merge_after: "2018-09-07T11:16:00.000Z",
  prepared_at: "2018-09-04T11:16:17.520Z",
  closed_by: null,
  closed_at: null,
  target_branch: "main",
  source_branch: "manual-job-rules",
  user_notes_count: 0,
  upvotes: 0,
  downvotes: 0,
  author: {
    bot: false,
    id: 4155490,
    username: "marcel.amirault",
    name: "Marcel Amirault",
    state: "active",
    avatar_url: "https://gitlab.com/uploads/-/system/user/avatar/4155490/avatar.png",
    web_url: "https://gitlab.com/marcel.amirault",
  },
  assignees: [],
  assignee: null,
  reviewers: [],
  source_project_id: 15513260,
  target_project_id: 15513260,
  labels: [],
  draft: false,
  work_in_progress: false,
  milestone: null,
  merge_when_pipeline_succeeds: false,
  merge_status: "can_be_merged",
  detailed_merge_status: "mergeable",
  sha: "e82eb4a098e32c796079ca3915e07487fc4db24c",
  merge_commit_sha: null,
  squash_commit_sha: null,
  discussion_locked: null,
  should_remove_source_branch: null,
  force_remove_source_branch: true,
  reference: "!133",
  references: {
    short: "!133",
    relative: "!133",
    full: "marcel.amirault/test-project!133",
  },
  web_url: "https://gitlab.com/marcel.amirault/test-project/-/merge_requests/133",
  time_stats: {
    time_estimate: 0,
    total_time_spent: 0,
    human_time_estimate: null,
    human_total_time_spent: null,
  },
  squash: false,
  task_completion_status: { count: 0, completed_count: 0 },
  has_conflicts: false,
  blocking_discussions_resolved: true,
  subscribed: true,
  changes_count: "1",
  latest_build_started_at: "2022-05-13T09:46:50.032Z",
  latest_build_finished_at: null,
  first_deployed_to_production_at: null,
  pipeline: {
    id: 538317940,
    iid: 1877,
    project_id: 15513260,
    sha: "1604b0c46c395822e4e9478777f8e54ac99fe5b9",
    ref: "refs/merge-requests/133/merge",
    status: "failed",
    source: "merge_request_event",
    created_at: "2022-05-13T09:46:39.560Z",
    updated_at: "2022-05-13T09:47:20.706Z",
    web_url: "https://gitlab.com/marcel.amirault/test-project/-/pipelines/538317940",
  },
  head_pipeline: {
    id: 538317940,
    iid: 1877,
    project_id: 15513260,
    sha: "1604b0c46c395822e4e9478777f8e54ac99fe5b9",
    ref: "refs/merge-requests/133/merge",
    status: "failed",
    source: "merge_request_event",
    created_at: "2022-05-13T09:46:39.560Z",
    updated_at: "2022-05-13T09:47:20.706Z",
    web_url: "https://gitlab.com/marcel.amirault/test-project/-/pipelines/538317940",
    before_sha: "1604b0c46c395822e4e9478777f8e54ac99fe5b9",
    tag: false,
    yaml_errors: null,
    user: {
      id: 4155490,
      username: "marcel.amirault",
      name: "Marcel Amirault",
      state: "active",
      avatar_url: "https://gitlab.com/uploads/-/system/user/avatar/4155490/avatar.png",
      web_url: "https://gitlab.com/marcel.amirault",
    },
    started_at: "2022-05-13T09:46:50.032Z",
    finished_at: "2022-05-13T09:47:20.697Z",
    committed_at: null,
    duration: 30,
    queued_duration: 10,
    coverage: null,
    archived: false,
  },
  diff_refs: {
    base_sha: "1162f719d711319a2efb2a35566f3bfdadee8bab",
    head_sha: "e82eb4a098e32c796079ca3915e07487fc4db24c",
    start_sha: "1162f719d711319a2efb2a35566f3bfdadee8bab",
  },
  merge_error: null,
  first_contribution: false,
  user: { can_merge: true },
  approvals_before_merge: null,
} as const;

export const GITLAB_HEAD_SHA = GITLAB_MERGE_REQUEST.diff_refs.head_sha;

// https://docs.gitlab.com/api/users/#retrieve-the-current-user (trimmed to
// the identity fields; the rest are profile settings)
export const GITLAB_CURRENT_USER = {
  id: 1,
  username: "john_smith",
  email: "john@example.com",
  name: "John Smith",
  state: "active",
  locked: false,
  avatar_url: "http://localhost:3000/uploads/user/avatar/1/index.jpg",
  web_url: "http://localhost:3000/john_smith",
  created_at: "2012-05-23T08:00:58Z",
  bot: false,
} as const;

// https://docs.gitlab.com/api/projects/#retrieve-a-project (the merge
// settings and permissions of the example)
export const GITLAB_PROJECT = {
  id: 3,
  path_with_namespace: "diaspora/diaspora-project-site",
  remove_source_branch_after_merge: false,
  merge_method: "merge",
  squash_option: "default_on",
  permissions: {
    project_access: { access_level: 10, notification_level: 3 },
    group_access: { access_level: 50, notification_level: 3 },
  },
} as const;

// https://docs.gitlab.com/api/merge_requests/#list-merge-request-diffs (the
// docs' `diff` strings lost their newlines in rendering; restored here)
export const GITLAB_MERGE_REQUEST_DIFFS = [
  {
    old_path: "README",
    new_path: "README",
    a_mode: "100644",
    b_mode: "100644",
    diff: "@@ -1 +1 @@\n-Title\n+README\n",
    collapsed: false,
    too_large: false,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    generated_file: false,
  },
  {
    old_path: "VERSION",
    new_path: "VERSION",
    a_mode: "100644",
    b_mode: "100644",
    diff: "@@ -1 +1 @@\n-1.9.7\n+1.9.8\n",
    collapsed: false,
    too_large: false,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    generated_file: false,
  },
] as const;

// https://docs.gitlab.com/api/discussions/#list-all-merge-request-discussion-items
export const GITLAB_DISCUSSIONS = [
  {
    id: "6a9c1750b37d513a43987b574953fceb50b03ce7",
    individual_note: false,
    notes: [
      {
        id: 1126,
        type: "DiscussionNote",
        body: "discussion text",
        attachment: null,
        author: {
          id: 1,
          name: "root",
          username: "root",
          state: "active",
          avatar_url:
            "https://www.gravatar.com/avatar/00afb8fb6ab07c3ee3e9c1f38777e2f4?s=80&d=identicon",
          web_url: "http://localhost:3000/root",
        },
        created_at: "2018-03-03T21:54:39.668Z",
        updated_at: "2018-03-03T21:54:39.668Z",
        system: false,
        noteable_id: 3,
        noteable_type: "MergeRequest",
        project_id: 5,
        noteable_iid: null,
        resolved: false,
        resolvable: true,
        resolved_by: null,
        resolved_at: null,
      },
    ],
  },
  {
    id: "87805b7c09016a7058e91bdbe7b29d1f284a39e6",
    individual_note: false,
    notes: [
      {
        id: 1128,
        type: "DiffNote",
        body: "diff comment",
        attachment: null,
        author: {
          id: 1,
          name: "root",
          username: "root",
          state: "active",
          avatar_url:
            "https://www.gravatar.com/avatar/00afb8fb6ab07c3ee3e9c1f38777e2f4?s=80&d=identicon",
          web_url: "http://localhost:3000/root",
        },
        created_at: "2018-03-04T09:17:22.520Z",
        updated_at: "2018-03-04T09:17:22.520Z",
        system: false,
        noteable_id: 3,
        noteable_type: "MergeRequest",
        project_id: 5,
        noteable_iid: null,
        commit_id: "4803c71e6b1833ca72b8b26ef2ecd5adc8a38031",
        position: {
          base_sha: "b5d6e7b1613fca24d250fa8e5bc7bcc3dd6002ef",
          start_sha: "7c9c2ead8a320fb7ba0b4e234bd9529a2614e306",
          head_sha: "4803c71e6b1833ca72b8b26ef2ecd5adc8a38031",
          old_path: "package.json",
          new_path: "package.json",
          position_type: "text",
          old_line: 27,
          new_line: 27,
          line_range: {
            start: {
              line_code: "588440f66559714280628a4f9799f0c4eb880a4a_10_10",
              type: "new",
              old_line: null,
              new_line: 10,
            },
            end: {
              line_code: "588440f66559714280628a4f9799f0c4eb880a4a_11_11",
              type: "old",
              old_line: 11,
              new_line: 11,
            },
          },
        },
        resolved: false,
        resolvable: true,
        resolved_by: null,
        suggestions: [
          {
            id: 1,
            from_line: 27,
            to_line: 27,
            appliable: true,
            applied: false,
            from_content: "x",
            to_content: "b",
          },
        ],
      },
    ],
  },
] as const;

// https://docs.gitlab.com/api/notes/#retrieve-a-merge-request-note
export const GITLAB_NOTE = {
  id: 301,
  body: "Comment for MR",
  author: {
    id: 1,
    username: "pipin",
    email: "admin@example.com",
    name: "Pip",
    state: "active",
    created_at: "2013-09-30T13:46:01Z",
  },
  created_at: "2013-10-02T08:57:14Z",
  updated_at: "2013-10-02T08:57:14Z",
  system: false,
  noteable_id: 2,
  noteable_type: "MergeRequest",
  project_id: 5,
  noteable_iid: 2,
  resolvable: false,
  confidential: false,
  internal: false,
} as const;

// https://docs.gitlab.com/api/resource_state_events/#list-project-merge-request-state-events
export const GITLAB_STATE_EVENTS = [
  {
    id: 142,
    user: {
      id: 1,
      name: "Administrator",
      username: "root",
      state: "active",
      avatar_url:
        "https://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=80&d=identicon",
      web_url: "http://gitlab.example.com/root",
    },
    created_at: "2018-08-20T13:38:20.077Z",
    resource_type: "MergeRequest",
    resource_id: 11,
    source_commit: null,
    source_merge_request_id: null,
    state: "opened",
  },
  {
    id: 143,
    user: {
      id: 1,
      name: "Administrator",
      username: "root",
      state: "active",
      avatar_url:
        "https://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=80&d=identicon",
      web_url: "http://gitlab.example.com/root",
    },
    created_at: "2018-08-21T14:38:20.077Z",
    resource_type: "MergeRequest",
    resource_id: 11,
    source_commit: null,
    source_merge_request_id: null,
    state: "closed",
  },
] as const;

// https://docs.gitlab.com/api/resource_label_events/#list-project-merge-request-label-events
export const GITLAB_LABEL_EVENTS = [
  {
    id: 119,
    user: {
      id: 1,
      name: "Administrator",
      username: "root",
      state: "active",
      avatar_url:
        "https://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=80&d=identicon",
      web_url: "http://gitlab.example.com/root",
    },
    created_at: "2018-08-20T06:17:28.394Z",
    resource_type: "MergeRequest",
    resource_id: 28,
    label: { id: 74, name: "p1", color: "#0033CC", description: "" },
    action: "add",
  },
  {
    id: 120,
    user: {
      id: 1,
      name: "Administrator",
      username: "root",
      state: "active",
      avatar_url:
        "https://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=80&d=identicon",
      web_url: "http://gitlab.example.com/root",
    },
    created_at: "2018-08-20T06:17:28.394Z",
    resource_type: "MergeRequest",
    resource_id: 28,
    label: { id: 41, name: "project", color: "#D1D100", description: "" },
    action: "add",
  },
] as const;

// https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-commits
export const GITLAB_COMMITS = [
  {
    id: "ed899a2f4b50b4370feeea94676502b42383c746",
    short_id: "ed899a2f4b5",
    title: "Replace sanitize with escape once",
    author_name: "Example User",
    author_email: "user@example.com",
    authored_date: "2012-09-20T11:50:22+03:00",
    committer_name: "Example User",
    committer_email: "user@example.com",
    committed_date: "2012-09-20T11:50:22+03:00",
    created_at: "2012-09-20T11:50:22+03:00",
    message: "Replace sanitize with escape once",
    trailers: {},
    extended_trailers: {},
    web_url: "https://gitlab.example.com/project/-/commit/ed899a2f4b50b4370feeea94676502b42383c746",
  },
  {
    id: "6104942438c14ec7bd21c6cd5bd995272b3faff6",
    short_id: "6104942438c",
    title: "Sanitize for network graph",
    author_name: "Example User",
    author_email: "user@example.com",
    authored_date: "2012-09-20T09:06:12+03:00",
    committer_name: "Example User",
    committer_email: "user@example.com",
    committed_date: "2012-09-20T09:06:12+03:00",
    created_at: "2012-09-20T09:06:12+03:00",
    message: "Sanitize for network graph",
    trailers: {},
    extended_trailers: {},
    web_url: "https://gitlab.example.com/project/-/commit/6104942438c14ec7bd21c6cd5bd995272b3faff6",
  },
] as const;

// https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-diff-versions
export const GITLAB_VERSIONS = [
  {
    id: 110,
    head_commit_sha: "33e2ee8579fda5bc36accc9c6fbd0b4fefda9e30",
    base_commit_sha: "eeb57dffe83deb686a60a71c16c32f71046868fd",
    start_commit_sha: "eeb57dffe83deb686a60a71c16c32f71046868fd",
    created_at: "2016-07-26T14:44:48.926Z",
    merge_request_id: 105,
    state: "collected",
    real_size: "1",
    patch_id_sha: "d504412d5b6e6739647e752aff8e468dde093f2f",
  },
  {
    id: 108,
    head_commit_sha: "3eed087b29835c48015768f839d76e5ea8f07a24",
    base_commit_sha: "eeb57dffe83deb686a60a71c16c32f71046868fd",
    start_commit_sha: "eeb57dffe83deb686a60a71c16c32f71046868fd",
    created_at: "2016-07-25T14:21:33.028Z",
    merge_request_id: 105,
    state: "collected",
    real_size: "1",
    patch_id_sha: "72c30d1f0115fc1d2bb0b29b24dc2982cbcdfd32",
  },
] as const;

// https://docs.gitlab.com/api/draft_notes/#list-all-merge-request-draft-notes
export const GITLAB_DRAFT_NOTES = [
  {
    id: 5,
    author_id: 23,
    merge_request_id: 11,
    resolve_discussion: false,
    discussion_id: null,
    note: "Example title",
    commit_id: null,
    line_code: null,
    position: {
      base_sha: null,
      start_sha: null,
      head_sha: null,
      old_path: null,
      new_path: null,
      position_type: "text",
      old_line: null,
      new_line: null,
      line_range: null,
    },
  },
] as const;

// https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-reviewers
export const GITLAB_REVIEWERS = [
  {
    user: {
      id: 1,
      name: "John Doe1",
      username: "user1",
      state: "active",
      avatar_url:
        "http://www.gravatar.com/avatar/c922747a93b40d1ea88262bf1aebee62?s=80&d=identicon",
      web_url: "http://localhost/user1",
    },
    state: "unreviewed",
    created_at: "2022-07-27T17:03:27.684Z",
  },
  {
    user: {
      id: 2,
      name: "John Doe2",
      username: "user2",
      state: "active",
      avatar_url:
        "http://www.gravatar.com/avatar/10fc7f102be8de7657fb4d80898bbfe3?s=80&d=identicon",
      web_url: "http://localhost/user2",
    },
    state: "reviewed",
    created_at: "2022-07-27T17:03:27.684Z",
  },
] as const;

// https://docs.gitlab.com/api/merge_request_approvals/#approve-merge-request
// (the approval state the approve endpoint and `GET .../approvals` return)
export const GITLAB_APPROVALS = {
  id: 5,
  iid: 5,
  project_id: 1,
  title: "Approvals API",
  description: "Test",
  state: "opened",
  created_at: "2016-06-08T00:19:52.638Z",
  updated_at: "2016-06-09T21:32:14.105Z",
  merge_status: "can_be_merged",
  approvals_required: 2,
  approvals_left: 0,
  approved_by: [
    {
      user: {
        name: "Administrator",
        username: "root",
        id: 1,
        state: "active",
        avatar_url:
          "http://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=80&d=identicon",
        web_url: "http://localhost:3000/root",
      },
      approved_at: "2016-06-10T04:21:41.050Z",
    },
    {
      user: {
        name: "Nico Cartwright",
        username: "ryley",
        id: 2,
        state: "active",
        avatar_url:
          "http://www.gravatar.com/avatar/cf7ad14b34162a76d593e3affca2adca?s=80&d=identicon",
        web_url: "http://localhost:3000/ryley",
      },
      approved_at: "2016-06-10T09:17:13.520Z",
    },
  ],
} as const;

// https://docs.gitlab.com/api/pipelines/#list-project-pipelines
export const GITLAB_PIPELINES = [
  {
    id: 47,
    iid: 12,
    project_id: 1,
    status: "pending",
    source: "push",
    ref: "new-pipeline",
    sha: "a91957a858320c0e17f3a0eca7cfacbff50ea29a",
    name: "Build pipeline",
    web_url: "https://example.com/foo/bar/pipelines/47",
    created_at: "2016-08-11T11:28:34.085Z",
    updated_at: "2016-08-11T11:32:35.169Z",
  },
  {
    id: 48,
    iid: 13,
    project_id: 1,
    status: "pending",
    source: "web",
    ref: "new-pipeline",
    sha: "eb94b618fb5865b26e80fdd8ae531b7a63ad851a",
    name: "Build pipeline",
    web_url: "https://example.com/foo/bar/pipelines/48",
    created_at: "2016-08-12T10:06:04.561Z",
    updated_at: "2016-08-12T10:09:56.223Z",
  },
] as const;

// https://docs.gitlab.com/api/jobs/#list-all-jobs-by-pipeline (runner and
// artifact details dropped)
export const GITLAB_JOBS = [
  {
    commit: {
      author_email: "admin@example.com",
      author_name: "Administrator",
      created_at: "2015-12-24T16:51:14.000+01:00",
      id: "0ff3ae198f8601a285adcf5c0fff204ee6fba5fd",
      message: "Test the CI integration.",
      short_id: "0ff3ae19",
      title: "Test the CI integration.",
    },
    coverage: null,
    archived: false,
    source: "push",
    allow_failure: false,
    created_at: "2015-12-24T15:51:21.727Z",
    started_at: "2015-12-24T17:54:24.729Z",
    finished_at: "2015-12-24T17:54:24.921Z",
    erased_at: null,
    duration: 0.192,
    queued_duration: 0.023,
    id: 6,
    name: "rspec:other",
    pipeline: {
      id: 6,
      project_id: 1,
      ref: "main",
      sha: "0ff3ae198f8601a285adcf5c0fff204ee6fba5fd",
      status: "pending",
    },
    ref: "main",
    stage: "test",
    status: "failed",
    failure_reason: "stuck_or_timeout_failure",
    tag: false,
    web_url: "https://example.com/foo/bar/-/jobs/6",
  },
] as const;

// https://docs.gitlab.com/api/commits/#get-a-single-commit (`stats` dropped)
export const GITLAB_COMMIT = {
  id: "6104942438c14ec7bd21c6cd5bd995272b3faff6",
  short_id: "6104942438c",
  title: "Sanitize for network graph",
  author_name: "randx",
  author_email: "user@example.com",
  committer_name: "Dmitriy",
  committer_email: "dmitriy.zaporozhets@gmail.com",
  created_at: "2021-09-20T09:06:12.300+03:00",
  message:
    "Sanitize for network graph\nCc: John Doe <johndoe@gitlab.com>\nCc: Jane Doe <janedoe@gitlab.com>",
  committed_date: "2021-09-20T09:06:12.300+03:00",
  authored_date: "2021-09-20T09:06:12.420+03:00",
  parent_ids: ["ae1d9fb46aa2b07ee9836d49862ec4e2c46fbbba"],
  last_pipeline: {
    id: 8,
    ref: "main",
    sha: "2dc6aa325a317eda67812f05600bdf0fcdc70ab0",
    status: "created",
  },
  status: "running",
  web_url:
    "https://gitlab.example.com/janedoe/gitlab-foss/-/commit/6104942438c14ec7bd21c6cd5bd995272b3faff6",
} as const;

// https://docs.gitlab.com/api/commits/#list-commit-statuses
export const GITLAB_COMMIT_STATUSES = [
  {
    status: "pending",
    created_at: "2016-01-19T08:40:25.934Z",
    started_at: null,
    name: "bundler:audit",
    allow_failure: true,
    author: {
      username: "janedoe",
      state: "active",
      web_url: "https://gitlab.example.com/janedoe",
      avatar_url: "https://gitlab.example.com/uploads/user/avatar/28/jane-doe-400-400.png",
      id: 28,
      name: "Jane Doe",
    },
    description: null,
    sha: "18f3e63d05582537db6d183d9d557be09e1f90c8",
    target_url: "https://gitlab.example.com/janedoe/gitlab-foss/builds/91",
    finished_at: null,
    id: 91,
    ref: "main",
  },
  {
    started_at: null,
    name: "test",
    allow_failure: false,
    status: "pending",
    created_at: "2016-01-19T08:40:25.832Z",
    target_url: "https://gitlab.example.com/janedoe/gitlab-foss/builds/90",
    id: 90,
    finished_at: null,
    ref: "main",
    sha: "18f3e63d05582537db6d183d9d557be09e1f90c8",
    author: {
      id: 28,
      name: "Jane Doe",
      username: "janedoe",
      state: "active",
    },
    description: null,
  },
] as const;

/**
 * System note bodies as GitLab writes them (`SystemNotes::*Service`), in the
 * Markdown form older releases store and the HTML form gitlab.com returns
 * today (observed on public merge requests of gitlab-org/cli).
 */
export const GITLAB_SYSTEM_NOTE_BODIES = {
  titleHtml:
    '<p>changed title from <code class="idiff">feat(mr): add --<span class="idiff left right deletion">review flag</span> for pending review comments</code> to <code class="idiff">feat(mr): add --<span class="idiff left right addition">draft flag and publish command</span> for pending review comments</code></p>',
  titleMarkdown: "changed title from **{-Draft: -}Add feature** to **Add feature{+ X+}**",
  draft: "marked this merge request as **draft**",
  ready: "marked this merge request as **ready**",
  reviewRequested: "requested review from @phikai and @rjlandry",
  reviewRequestChanged: "requested review from @alice and removed review request for @bob",
  assigned: "assigned to @andrei.zubov and unassigned @kai",
  approved: "approved this merge request",
  requestedChanges: "requested changes",
  resetApprovals: "reset approvals from @uchandran by pushing to the branch",
  autoMergeEnabled: "enabled automatic add to merge train when checks pass",
  autoMergeAborted:
    "aborted automatic add to merge train because the merge request cannot be merged.",
  targetBranch: "changed target branch from `main` to `release`",
  mentionedInMergeRequest: "mentioned in merge request !3909",
  mentionedInOtherIssue: "mentioned in issue gitlab-org/editor-extensions/gitlab-lsp#3084",
  pushed:
    "added 1 commit\n\n<ul><li>ed899a2f - Replace sanitize with escape once</li></ul>\n\n[Compare with previous version](/project/-/merge_requests/133/diffs?diff_id=1&start_sha=6104942438c14ec7bd21c6cd5bd995272b3faff6)",
  leftReviewComments: "left review comments",
} as const;
