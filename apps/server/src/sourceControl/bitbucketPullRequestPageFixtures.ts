/**
 * Bitbucket Cloud REST 2.0 payloads for the pull requests page tests, shaped
 * exactly like the official responses:
 *
 * - Activity entries (`update`, `approval`, `comment`) copy the examples in
 *   "List a pull request activity log":
 *   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-pullrequests-pull-request-id-activity-get
 *   (the docs blank `uuid` / `account_id`; distinct ids are filled in so
 *   accounts can be told apart). `changes_requested` follows the approval
 *   shape the same page describes ("approvals and request changes").
 * - Pull requests, comments, participants, commit statuses and mergeability
 *   checks follow the `pullrequest`, `pullrequest_comment`, `participant`,
 *   `commitstatus` and `pullrequest_mergeability_check` schemas of the
 *   official OpenAPI document:
 *   https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json
 * - Commits copy the "Get a commit" example (api-group-commits); repository
 *   permissions copy the "List repository permissions in a workspace for a
 *   user" example (api-group-repositories); merge task status copies
 *   "Get the merge task status for a pull request".
 */

const API = "https://api.bitbucket.org/2.0";
const REPO = "atlassian/atlaskit-mk-2";

function user(input: {
  readonly displayName: string;
  readonly nickname: string;
  readonly uuid: string;
  readonly accountId: string;
}) {
  return {
    display_name: input.displayName,
    uuid: input.uuid,
    links: {
      self: { href: `${API}/users/${encodeURIComponent(input.uuid)}` },
      html: { href: `https://bitbucket.org/${encodeURIComponent(input.uuid)}/` },
      avatar: {
        href: `https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/${input.accountId}/128`,
      },
    },
    type: "user",
    nickname: input.nickname,
    account_id: input.accountId,
  };
}

export const authorUser = user({
  displayName: "Name Lastname",
  nickname: "Name",
  uuid: "{0b0f3a52-1111-4a0e-9c5f-6f2a1b3c4d5e}",
  accountId: "557058:author",
});
export const reviewerUser = user({
  displayName: "Jessica Yeh",
  nickname: "jessyeh",
  uuid: "{d301abfa-d676-4ee0-88be-962ce7443567}",
  accountId: "557058:reviewer",
});
export const otherUser = user({
  displayName: "Brodie Rao",
  nickname: "brodie",
  uuid: "{9484702e-c663-4afd-aefb-c93a8cd31c28}",
  accountId: "557058:3aae1e05-702a-41e5-81c8-f36f29afb6ca",
});

const repository = {
  name: "Atlaskit-MK-2",
  type: "repository",
  full_name: REPO,
  links: {
    self: { href: `${API}/repositories/${REPO}` },
    html: { href: `https://bitbucket.org/${REPO}` },
    avatar: { href: "https://bytebucket.org/ravatar/%7B%7D?ts=js" },
  },
  uuid: "{85d67b4e-571d-44e9-a507-fa476935aa98}",
};

function commitRef(hash: string) {
  return {
    type: "commit",
    hash,
    links: {
      self: { href: `${API}/repositories/${REPO}/commit/${hash}` },
      html: { href: `https://bitbucket.org/${REPO}/commits/${hash}` },
    },
  };
}

export const PULL_REQUEST_ID = 5695;
export const PULL_REQUEST_TITLE =
  "username/NONE: small change from onFocus to onClick to handle tabbing through the page and not expand the editor unless a click event triggers it";
export const HEAD_SHA = "728c8bad1813e6a1f2b9a7a3c4d5e6f708192a3b";
export const PARENT_SHA = "f06941fec4ef6bcb0c2456927a0cf258fa4f899b";
/** The head before a force push; not one of the pull request's commits. */
export const REWRITTEN_SHA = "0123456789ab";
export const DESTINATION_SHA = "6a2c16e4a152";
export const MERGE_BASE_SHA = "eefd5ef5d3df01aed629f650959d6706d54cd335";

const pullRequestLinks = {
  self: { href: `${API}/repositories/${REPO}/pullrequests/${PULL_REQUEST_ID}` },
  html: { href: `https://bitbucket.org/${REPO}/pull-requests/${PULL_REQUEST_ID}` },
};

/** `GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}`. */
export const pullRequest = {
  type: "pullrequest",
  id: PULL_REQUEST_ID,
  title: PULL_REQUEST_TITLE,
  rendered: {},
  summary: { raw: "Fixes keyboard focus.", markup: "markdown", html: "", type: "rendered" },
  state: "OPEN",
  author: authorUser,
  source: {
    branch: { name: "username/NONE-add-onClick-prop-for-accessibility" },
    commit: commitRef("728c8bad1813"),
    repository,
  },
  destination: {
    branch: {
      name: "master",
      merge_strategies: ["merge_commit", "squash", "fast_forward"],
      default_merge_strategy: "merge_commit",
    },
    commit: commitRef(DESTINATION_SHA),
    repository,
  },
  merge_commit: null,
  comment_count: 4,
  task_count: 0,
  close_source_branch: true,
  closed_by: null,
  reason: "",
  created_on: "2019-05-10T06:48:25.305565+00:00",
  updated_on: "2019-09-27T01:00:00.000000+00:00",
  reviewers: [reviewerUser],
  participants: [
    {
      type: "participant",
      user: reviewerUser,
      role: "REVIEWER",
      approved: true,
      state: "approved",
      participated_on: "2019-09-27T00:37:19.849534+00:00",
    },
    {
      type: "participant",
      user: otherUser,
      role: "PARTICIPANT",
      approved: false,
      state: "changes_requested",
      participated_on: "2019-09-27T01:00:00.000000+00:00",
    },
    {
      type: "participant",
      user: authorUser,
      role: "PARTICIPANT",
      approved: false,
      state: null,
      participated_on: "2019-09-27T00:40:00.000000+00:00",
    },
  ],
  draft: false,
  queued: false,
  links: pullRequestLinks,
};

const pullRequestStub = {
  type: "pullrequest",
  id: PULL_REQUEST_ID,
  links: pullRequestLinks,
  title: PULL_REQUEST_TITLE,
};

function activityUpdate(input: {
  readonly date: string;
  readonly title: string;
  readonly state: string;
  readonly sourceHash: string;
  readonly reviewers: ReadonlyArray<unknown>;
}) {
  return {
    update: {
      description: "",
      title: input.title,
      destination: {
        commit: commitRef(DESTINATION_SHA),
        branch: { name: "master" },
        repository,
      },
      reason: "",
      source: {
        commit: commitRef(input.sourceHash),
        branch: { name: "username/NONE-add-onClick-prop-for-accessibility" },
        repository,
      },
      state: input.state,
      author: authorUser,
      reviewers: input.reviewers,
      date: input.date,
    },
    pull_request: pullRequestStub,
  };
}

/** `GET .../pullrequests/{id}/activity` (newest first). */
export const activityPage = {
  pagelen: 50,
  values: [
    {
      changes_requested: {
        date: "2019-09-27T01:00:00.000000+00:00",
        pullrequest: pullRequestStub,
        user: otherUser,
      },
      pull_request: pullRequestStub,
    },
    {
      comment: {
        links: {
          self: {
            href: `${API}/repositories/${REPO}/pullrequests/${PULL_REQUEST_ID}/comments/118571088`,
          },
          html: {
            href: `https://bitbucket.org/${REPO}/pull-requests/${PULL_REQUEST_ID}/_/diff#comment-118571088`,
          },
        },
        deleted: false,
        pullrequest: pullRequestStub,
        content: {
          raw: "inline with to a dn from lines",
          markup: "markdown",
          html: "<p>inline with to a dn from lines</p>",
          type: "rendered",
        },
        created_on: "2019-09-27T00:33:46.039178+00:00",
        user: reviewerUser,
        updated_on: "2019-09-27T00:33:46.055384+00:00",
        inline: {
          context_lines: "",
          to: null,
          path: "packages/editor/src/index.ts",
          outdated: false,
          from: 211,
        },
        type: "pullrequest_comment",
        id: 118571088,
      },
      pull_request: pullRequestStub,
    },
    {
      approval: {
        date: "2019-09-27T00:37:19.849534+00:00",
        pullrequest: pullRequestStub,
        user: reviewerUser,
      },
      pull_request: pullRequestStub,
    },
    activityUpdate({
      date: "2019-09-26T10:00:00.000000+00:00",
      title: PULL_REQUEST_TITLE,
      state: "OPEN",
      sourceHash: "728c8bad1813",
      reviewers: [reviewerUser],
    }),
    activityUpdate({
      date: "2019-05-10T06:48:25.305565+00:00",
      title: "WIP: onClick",
      state: "OPEN",
      sourceHash: REWRITTEN_SHA,
      reviewers: [],
    }),
  ],
};

function commit(input: {
  readonly hash: string;
  readonly parent: string;
  readonly date: string;
  readonly message: string;
}) {
  return {
    hash: input.hash,
    author: { raw: "Brodie Rao <a@b.c>", type: "author", user: otherUser },
    summary: { raw: input.message, markup: "markdown", html: "", type: "rendered" },
    parents: [commitRef(input.parent)],
    date: input.date,
    message: input.message,
    type: "commit",
  };
}

/** `GET .../pullrequests/{id}/commits` (newest first, as Bitbucket lists them). */
export const commitsPage = {
  pagelen: 100,
  values: [
    commit({
      hash: HEAD_SHA,
      parent: PARENT_SHA,
      date: "2019-09-26T10:00:00+00:00",
      message: "Use onClick\n\nKeeps the editor collapsed while tabbing.",
    }),
    commit({
      hash: PARENT_SHA,
      parent: DESTINATION_SHA,
      date: "2019-09-26T10:00:00+00:00",
      message: "Add a GEORDI_OUTPUT_DIR setting",
    }),
  ],
};

function comment(input: {
  readonly id: number;
  readonly createdOn: string;
  readonly user: unknown;
  readonly raw: string;
  readonly inline?: unknown;
  readonly parent?: number;
  readonly deleted?: boolean;
  readonly pending?: boolean;
  readonly resolution?: unknown;
}) {
  return {
    type: "pullrequest_comment",
    id: input.id,
    created_on: input.createdOn,
    updated_on: input.createdOn,
    content: { raw: input.raw, markup: "markdown", html: `<p>${input.raw}</p>`, type: "rendered" },
    user: input.user,
    deleted: input.deleted ?? false,
    ...(input.parent !== undefined
      ? { parent: { id: input.parent, links: {}, type: "pullrequest_comment" } }
      : {}),
    ...(input.inline !== undefined ? { inline: input.inline } : {}),
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    pending: input.pending ?? false,
    links: {
      self: {
        href: `${API}/repositories/${REPO}/pullrequests/${PULL_REQUEST_ID}/comments/${input.id}`,
      },
      html: {
        href: `https://bitbucket.org/${REPO}/pull-requests/${PULL_REQUEST_ID}/_/diff#comment-${input.id}`,
      },
    },
    pullrequest: pullRequestStub,
  };
}

/** `GET .../pullrequests/{id}/comments?sort=-created_on` (newest first). */
export const commentsPage = {
  pagelen: 100,
  values: [
    comment({
      id: 118571600,
      createdOn: "2019-09-27T00:50:00.000000+00:00",
      user: reviewerUser,
      raw: "Draft thought",
      pending: true,
      inline: { to: 3, from: null, path: "packages/editor/src/types.ts", outdated: false },
    }),
    comment({
      id: 118571500,
      createdOn: "2019-09-27T00:45:00.000000+00:00",
      user: otherUser,
      raw: "",
      deleted: true,
    }),
    comment({
      id: 118571400,
      createdOn: "2019-09-27T00:40:00.000000+00:00",
      user: authorUser,
      raw: "Thanks for the reviews!",
    }),
    comment({
      id: 118571200,
      createdOn: "2019-09-27T00:35:00.000000+00:00",
      user: authorUser,
      raw: "Good catch, fixed.",
      parent: 118571088,
      inline: { to: null, from: 211, path: "packages/editor/src/index.ts", outdated: false },
    }),
    comment({
      id: 118571088,
      createdOn: "2019-09-27T00:33:46.039178+00:00",
      user: reviewerUser,
      raw: "inline with to a dn from lines",
      inline: {
        context_lines: "",
        to: null,
        path: "packages/editor/src/index.ts",
        outdated: false,
        from: 211,
      },
    }),
    comment({
      id: 118571000,
      createdOn: "2019-09-20T08:00:00.000000+00:00",
      user: otherUser,
      raw: "This range moved.",
      inline: {
        to: 12,
        from: null,
        start_to: 10,
        path: "README.md",
        outdated: true,
      },
      resolution: {
        type: "comment_resolution",
        user: reviewerUser,
        created_on: "2019-09-26T11:00:00.000000+00:00",
      },
    }),
  ],
};

/** `GET /user` (the authenticated reviewer). */
export const viewer = reviewerUser;

/** `GET /user/workspaces/{workspace}/permissions/repositories` (docs example, this repository). */
export const permissionsPage = {
  pagelen: 10,
  values: [
    {
      type: "repository_permission",
      user: {
        type: "user",
        nickname: "jessyeh",
        display_name: "Jessica Yeh",
        uuid: reviewerUser.uuid,
      },
      repository: {
        type: "repository",
        name: "Atlaskit-MK-2",
        full_name: REPO,
        uuid: repository.uuid,
      },
      permission: "write",
    },
  ],
  page: 1,
  size: 1,
};

/** `GET .../pullrequests/{id}/statuses`. */
export const statusesPage = {
  pagelen: 100,
  values: [
    {
      type: "build",
      key: "BB-DEPLOY",
      name: "BB-DEPLOY-1",
      state: "SUCCESSFUL",
      description: "Unit tests in Bamboo",
      refname: "username/NONE-add-onClick-prop-for-accessibility",
      url: "https://ci.example.com/BB-DEPLOY-1",
      created_on: "2019-09-26T10:05:00.000000+00:00",
      updated_on: "2019-09-26T10:09:00.000000+00:00",
      links: {
        self: { href: `${API}/repositories/${REPO}/commit/${HEAD_SHA}/statuses/build/BB-DEPLOY` },
        commit: { href: `${API}/repositories/${REPO}/commit/${HEAD_SHA}` },
      },
    },
    {
      type: "build",
      key: "LINT",
      name: "Lint",
      state: "INPROGRESS",
      url: "https://ci.example.com/LINT-7",
      created_on: "2019-09-26T10:05:00.000000+00:00",
      updated_on: "2019-09-26T10:05:00.000000+00:00",
      links: { commit: { href: `${API}/repositories/${REPO}/commit/${HEAD_SHA}` } },
    },
    {
      type: "build",
      key: "LINT",
      name: "Lint",
      state: "FAILED",
      url: "https://ci.example.com/LINT-6",
      created_on: "2019-05-10T07:00:00.000000+00:00",
      updated_on: "2019-05-10T07:03:00.000000+00:00",
      links: { commit: { href: `${API}/repositories/${REPO}/commit/${REWRITTEN_SHA}` } },
    },
  ],
};

/** `GET .../pullrequests/{id}/mergeability/checks`. */
export const mergeabilityChecks = {
  size: 4,
  values: [
    {
      type: "pullrequest_state_check",
      status: "PASSED",
      required: true,
      blocking: false,
      state: "OPEN",
    },
    { type: "current_user_permission_check", status: "PASSED", required: true, blocking: false },
    {
      type: "git_mergeability_check",
      status: "PASSED",
      required: true,
      blocking: false,
      reason: "clean",
    },
    {
      type: "standard_merge_check",
      status: "PASSED",
      required: true,
      blocking: false,
      check: { type: "standard_merge_check_definition", kind: "minimum_approvals" },
      requirement: { minimum_approvals: 1 },
      observed: { approval_count: 1 },
    },
  ],
};

/** A conflicted, blocked variant of `mergeabilityChecks`. */
export const conflictingMergeabilityChecks = {
  size: 2,
  values: [
    {
      type: "git_mergeability_check",
      status: "FAILED",
      required: true,
      blocking: true,
      reason: "conflicts",
      links: {
        details: { href: `${API}/repositories/${REPO}/pullrequests/${PULL_REQUEST_ID}/conflicts` },
      },
    },
    {
      type: "standard_merge_check",
      status: "FAILED",
      required: true,
      blocking: true,
      check: { type: "standard_merge_check_definition", kind: "minimum_approvals" },
      requirement: { minimum_approvals: 2 },
      observed: { approval_count: 1 },
    },
  ],
};

/** `GET /workspaces/{workspace}/members`. */
export const membersPage = {
  pagelen: 100,
  values: [authorUser, reviewerUser, otherUser].map((member) => ({
    type: "workspace_membership",
    user: member,
    workspace: { type: "workspace", slug: "atlassian", name: "Atlassian" },
  })),
};

/** `GET .../merge/task-status/{task_id}` (docs examples). */
export const mergeTaskPending = {
  task_status: "PENDING",
  links: {
    self: {
      href: `${API}/repositories/${REPO}/pullrequests/${PULL_REQUEST_ID}/merge/task-status/1`,
    },
  },
};
export const mergeTaskSuccess = {
  task_status: "SUCCESS",
  links: {
    self: {
      href: `${API}/repositories/${REPO}/pullrequests/${PULL_REQUEST_ID}/merge/task-status/1`,
    },
  },
  merge_result: { ...pullRequest, state: "MERGED" },
};

/** `POST .../approve` / `POST .../request-changes` → `participant`. */
export const approvalParticipant = {
  type: "participant",
  user: reviewerUser,
  role: "REVIEWER",
  approved: true,
  state: "approved",
  participated_on: "2019-09-28T09:00:00.000000+00:00",
};

/** `POST .../comments/{id}/resolve` → `comment_resolution`. */
export const commentResolution = {
  type: "comment_resolution",
  user: reviewerUser,
  created_on: "2019-09-28T09:00:00.000000+00:00",
};

/** `GET .../merge-base/{revspec}` → `commit` (from the "Get a commit" example). */
export const mergeBaseCommit = {
  ...commit({
    hash: MERGE_BASE_SHA,
    parent: "f7591a13eda445d9a9167f98eb870319f4b6c2d8",
    date: "2019-05-01T00:00:00+00:00",
    message: "Add a GEORDI_OUTPUT_DIR setting",
  }),
};

/** A created `pullrequest_comment` (`POST .../comments`, 201). */
export function createdComment(id: number, raw: string, extra: Record<string, unknown> = {}) {
  return comment({
    id,
    createdOn: "2019-09-28T09:00:00.000000+00:00",
    user: reviewerUser,
    raw,
    ...extra,
  });
}
