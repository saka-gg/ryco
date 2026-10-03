import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  GitLabCommitSchema,
  GitLabDiscussionSchema,
  GitLabDraftNoteSchema,
  GitLabLabelEventSchema,
  GitLabNoteSchema,
  GitLabStateEventSchema,
  GitLabVersionSchema,
  assembleGitLabChangeRequestActivity,
  gitLabReviewThread,
  gitLabSystemNoteItems,
  gitLabViewerCapabilities,
  parseGitLabTitleChange,
  type GitLabActivityInput,
  type GitLabNote,
} from "./gitLabMergeRequestActivity.ts";
import {
  GITLAB_COMMITS,
  GITLAB_CURRENT_USER,
  GITLAB_DISCUSSIONS,
  GITLAB_DRAFT_NOTES,
  GITLAB_LABEL_EVENTS,
  GITLAB_MERGE_REQUEST,
  GITLAB_NOTE,
  GITLAB_PROJECT,
  GITLAB_STATE_EVENTS,
  GITLAB_SYSTEM_NOTE_BODIES,
  GITLAB_VERSIONS,
} from "./gitLabMergeRequestPage.fixtures.ts";
import {
  GitLabMergeRequestDetailSchema,
  GitLabProjectSchema,
  gitLabMergeRequestFacts,
} from "./gitLabMergeRequests.ts";

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
) => Schema.decodeUnknownSync(schema)(value);

const facts = gitLabMergeRequestFacts(decode(GitLabMergeRequestDetailSchema, GITLAB_MERGE_REQUEST));
const MR_URL = GITLAB_MERGE_REQUEST.web_url;

function systemNote(body: string, id = 900): GitLabNote {
  return decode(GitLabNoteSchema, {
    ...GITLAB_NOTE,
    id,
    body,
    system: true,
    author: { id: 7, username: "phikai", avatar_url: "https://a/7.png" },
  });
}

function items(body: string) {
  return gitLabSystemNoteItems(systemNote(body), { mergeRequestUrl: MR_URL, targetBranch: "main" });
}

describe("gitLabSystemNoteItems", () => {
  it("reads title changes in GitLab's HTML and Markdown forms", () => {
    expect(parseGitLabTitleChange(GITLAB_SYSTEM_NOTE_BODIES.titleHtml)).toEqual({
      previousTitle: "feat(mr): add --review flag for pending review comments",
      currentTitle: "feat(mr): add --draft flag and publish command for pending review comments",
    });
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.titleMarkdown)).toMatchObject([
      {
        id: "note:900",
        kind: "renamed",
        previousTitle: "Draft: Add feature",
        currentTitle: "Add feature X",
      },
    ]);
  });

  it("reads draft, review request, assignment and review notes", () => {
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.draft)).toMatchObject([{ kind: "converted-to-draft" }]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.ready)).toMatchObject([{ kind: "ready-for-review" }]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.reviewRequested)).toMatchObject([
      { id: "note:900:review-requested:phikai", kind: "review-requested", reviewer: "phikai" },
      { id: "note:900:review-requested:rjlandry", kind: "review-requested", reviewer: "rjlandry" },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.reviewRequestChanged)).toMatchObject([
      { kind: "review-requested", reviewer: "alice", reviewerKind: "user" },
      { kind: "review-request-removed", reviewer: "bob" },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.assigned)).toMatchObject([
      { kind: "assigned", assignee: "andrei.zubov" },
      { kind: "unassigned", assignee: "kai" },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.approved)).toMatchObject([
      { kind: "review", state: "approved", body: "", threadIds: [], actor: { login: "phikai" } },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.requestedChanges)).toMatchObject([
      { kind: "review", state: "changes_requested" },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.resetApprovals)).toMatchObject([
      { kind: "review-dismissed", reviewAuthor: "uchandran" },
    ]);
  });

  it("reads auto-merge, base changes and cross references", () => {
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.autoMergeEnabled)).toMatchObject([
      { kind: "auto-merge-enabled" },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.autoMergeAborted)).toMatchObject([
      { kind: "auto-merge-disabled" },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.targetBranch)).toMatchObject([
      { kind: "base-ref-changed", previousRefName: "main", currentRefName: "release" },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.mentionedInMergeRequest)).toMatchObject([
      {
        kind: "cross-referenced",
        source: {
          kind: "change-request",
          number: 3909,
          title: "",
          url: "https://gitlab.com/marcel.amirault/test-project/-/merge_requests/3909",
        },
      },
    ]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.mentionedInOtherIssue)).toMatchObject([
      {
        kind: "cross-referenced",
        source: {
          kind: "issue",
          number: 3084,
          repository: "gitlab-org/editor-extensions/gitlab-lsp",
          url: "https://gitlab.com/gitlab-org/editor-extensions/gitlab-lsp/-/issues/3084",
        },
      },
    ]);
  });

  it("drops notes other APIs cover and prose it does not know", () => {
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.pushed)).toEqual([]);
    expect(items(GITLAB_SYSTEM_NOTE_BODIES.leftReviewComments)).toEqual([]);
    expect(items("changed the description")).toEqual([]);
  });
});

const user = decode(
  Schema.Struct({ id: Schema.Number, username: Schema.String }),
  GITLAB_CURRENT_USER,
);
const project = decode(GitLabProjectSchema, GITLAB_PROJECT);

describe("gitLabViewerCapabilities", () => {
  it("derives permissions from authorship, access level and can_merge", () => {
    expect(gitLabViewerCapabilities({ user, project, facts })).toEqual({
      login: "john_smith",
      isAuthor: false,
      // Group access 50 (Owner) outranks the project's Guest access.
      canUpdate: true,
      canMerge: true,
      canReview: true,
      canUpdateBranch: true,
      canEnableAutoMerge: true,
      canDisableAutoMerge: true,
    });
  });

  it("is conservative without permissions", () => {
    const guest = decode(GitLabProjectSchema, {
      id: 3,
      permissions: { project_access: null, group_access: null },
    });
    expect(
      gitLabViewerCapabilities({
        user,
        project: guest,
        facts: { ...facts, canMerge: null, discussionLocked: true },
      }),
    ).toMatchObject({
      canUpdate: false,
      canMerge: false,
      canReview: false,
      canEnableAutoMerge: false,
    });
    expect(gitLabViewerCapabilities({ user: null, project, facts })).toBeNull();
  });
});

describe("gitLabReviewThread", () => {
  const diffDiscussion = decode(GitLabDiscussionSchema, GITLAB_DISCUSSIONS[1]);
  const context = {
    mergeRequestUrl: MR_URL,
    headSha: "4803c71e6b1833ca72b8b26ef2ecd5adc8a38031",
    viewerId: 1,
    viewerCanReply: true,
    viewerCanResolve: true,
    diffEntries: null,
  };

  it("maps a diff discussion on the current head", () => {
    const entry = gitLabReviewThread(diffDiscussion, context);
    expect(entry?.thread).toMatchObject({
      id: "87805b7c09016a7058e91bdbe7b29d1f284a39e6",
      path: "package.json",
      subjectType: "line",
      side: "right",
      line: 27,
      startSide: "right",
      startLine: 10,
      originalLine: 27,
      originalStartLine: 10,
      originalCommitOid: "4803c71e6b1833ca72b8b26ef2ecd5adc8a38031",
      isResolved: false,
      isOutdated: false,
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      totalComments: 1,
      comments: [
        {
          id: "1128",
          author: { login: "root" },
          body: "diff comment",
          url: `${MR_URL}#note_1128`,
          state: "submitted",
          viewerCanUpdate: true,
          viewerCanDelete: true,
        },
      ],
    });
  });

  it("marks a position left behind on an older head outdated", () => {
    const entry = gitLabReviewThread(diffDiscussion, { ...context, headSha: "e82eb4a0" });
    expect(entry?.thread).toMatchObject({
      isOutdated: true,
      line: null,
      startLine: null,
      originalLine: 27,
      originalStartLine: 10,
    });
  });

  it("anchors a removed line on the left and excerpts its hunk", () => {
    const leftOnly = decode(GitLabDiscussionSchema, {
      ...GITLAB_DISCUSSIONS[1],
      notes: [
        {
          ...GITLAB_DISCUSSIONS[1].notes[0],
          resolved: true,
          resolved_by: { id: 2, username: "maintainer" },
          position: {
            ...GITLAB_DISCUSSIONS[1].notes[0].position,
            old_path: "VERSION",
            new_path: "VERSION",
            old_line: 1,
            new_line: null,
            line_range: null,
          },
        },
      ],
    });
    const entry = gitLabReviewThread(leftOnly, {
      ...context,
      viewerId: 99,
      diffEntries: [
        { old_path: "VERSION", new_path: "VERSION", diff: "@@ -1 +1 @@\n-1.9.7\n+1.9.8\n" },
      ],
    });
    expect(entry?.thread).toMatchObject({
      path: "VERSION",
      side: "left",
      line: 1,
      diffHunk: "@@ -1 +1 @@\n-1.9.7",
      isResolved: true,
      resolvedBy: "maintainer",
      viewerCanResolve: false,
      viewerCanUnresolve: true,
      comments: [{ viewerCanUpdate: false, viewerCanDelete: false }],
    });
    expect(entry?.thread.startLine).toBeUndefined();
  });

  it("is not a review thread without a diff position", () => {
    expect(
      gitLabReviewThread(decode(GitLabDiscussionSchema, GITLAB_DISCUSSIONS[0]), context),
    ).toBeNull();
  });
});

describe("assembleGitLabChangeRequestActivity", () => {
  const base: GitLabActivityInput = {
    facts,
    user: decode(
      Schema.Struct({ id: Schema.Number, username: Schema.String }),
      GITLAB_CURRENT_USER,
    ),
    project,
    notes: {
      items: [
        decode(GitLabNoteSchema, GITLAB_NOTE),
        systemNote(GITLAB_SYSTEM_NOTE_BODIES.approved, 950),
        systemNote(GITLAB_SYSTEM_NOTE_BODIES.pushed, 940),
      ],
      truncated: false,
    },
    discussions: {
      items: GITLAB_DISCUSSIONS.map((discussion) => decode(GitLabDiscussionSchema, discussion)),
      truncated: false,
    },
    stateEvents: GITLAB_STATE_EVENTS.map((event) => decode(GitLabStateEventSchema, event)),
    labelEvents: GITLAB_LABEL_EVENTS.map((event) => decode(GitLabLabelEventSchema, event)),
    commits: {
      items: GITLAB_COMMITS.map((commit) => decode(GitLabCommitSchema, commit)),
      truncated: false,
    },
    versions: GITLAB_VERSIONS.map((version) => decode(GitLabVersionSchema, version)),
    draftNotes: GITLAB_DRAFT_NOTES.map((draft) => decode(GitLabDraftNoteSchema, draft)),
    diffEntries: null,
  };

  it("assembles a chronological timeline, threads, viewer and the pending review", () => {
    const activity = assembleGitLabChangeRequestActivity(base);
    expect(activity.provider).toBe("gitlab");
    expect(activity.number).toBe(133);
    expect(activity.headSha).toBe("e82eb4a098e32c796079ca3915e07487fc4db24c");
    expect(activity.viewer?.login).toBe("john_smith");
    expect(activity.pendingReview).toEqual({ id: "draft-notes", commentsCount: 1 });
    expect(activity.timelineTruncated).toBe(false);
    expect(activity.reviewThreadsTruncated).toBe(false);
    expect(activity.reviewThreads.map((thread) => thread.id)).toEqual([
      "87805b7c09016a7058e91bdbe7b29d1f284a39e6",
    ]);
    // The docs' diff note sits on another head than the docs' merge request.
    expect(activity.reviewThreads[0]?.isOutdated).toBe(true);

    expect(activity.timeline.map((item) => [item.kind, item.id])).toEqual([
      ["commit", "commit:6104942438c14ec7bd21c6cd5bd995272b3faff6"],
      ["commit", "commit:ed899a2f4b50b4370feeea94676502b42383c746"],
      ["comment", "note:301"],
      ["review", "note:950"],
      ["force-pushed", "version:110"],
      ["review", "review:87805b7c09016a7058e91bdbe7b29d1f284a39e6"],
      ["labeled", "label:119"],
      ["labeled", "label:120"],
      ["closed", "state:143"],
    ]);
  });

  it("maps each item's payload", () => {
    const activity = assembleGitLabChangeRequestActivity(base);
    const byId = new Map(activity.timeline.map((item) => [item.id, item]));
    expect(byId.get("commit:ed899a2f4b50b4370feeea94676502b42383c746")).toMatchObject({
      oid: "ed899a2f4b50b4370feeea94676502b42383c746",
      shortOid: "ed899a2f4b5",
      messageHeadline: "Replace sanitize with escape once",
      // Credited to whoever pushed it ("added 1 commit … ed899a2f").
      actor: { login: "phikai" },
    });
    expect(byId.get("note:301")).toMatchObject({
      body: "Comment for MR",
      actor: { login: "pipin" },
      url: `${MR_URL}#note_301`,
      // Ownership is by user id: the docs' note author and current user are both id 1.
      viewerCanUpdate: true,
      viewerCanDelete: true,
    });
    expect(byId.get("version:110")).toMatchObject({
      beforeOid: "3eed087b29835c48015768f839d76e5ea8f07a24",
      afterOid: "33e2ee8579fda5bc36accc9c6fbd0b4fefda9e30",
    });
    expect(byId.get("review:87805b7c09016a7058e91bdbe7b29d1f284a39e6")).toMatchObject({
      state: "commented",
      threadIds: ["87805b7c09016a7058e91bdbe7b29d1f284a39e6"],
      actor: { login: "root" },
    });
    expect(byId.get("label:119")).toMatchObject({
      label: { name: "p1", color: "0033cc" },
      actor: { login: "root" },
    });
    // The docs' approval and push notes carry the docs' 2013 note timestamp.
    expect(byId.get("note:950")).toMatchObject({ kind: "review", state: "approved" });
  });

  it("drops events older than a cut note list and reports the cut", () => {
    const cut = assembleGitLabChangeRequestActivity({
      ...base,
      notes: {
        items: [
          {
            ...systemNote(GITLAB_SYSTEM_NOTE_BODIES.draft, 990),
            created_at: "2018-08-21T00:00:00Z",
          },
        ],
        truncated: true,
      },
    });
    expect(cut.timelineTruncated).toBe(true);
    expect(cut.timeline.map((item) => item.id)).toEqual(["note:990", "state:143"]);
    expect(
      cut.timeline.every(
        (item) => DateTime.toEpochMillis(item.createdAt) >= Date.parse("2018-08-21T00:00:00Z"),
      ),
    ).toBe(true);
  });

  it("does not guess force pushes from a cut commit list", () => {
    const activity = assembleGitLabChangeRequestActivity({
      ...base,
      commits: { ...base.commits, truncated: true },
    });
    expect(activity.timeline.some((item) => item.kind === "force-pushed")).toBe(false);
    expect(activity.timelineTruncated).toBe(true);
  });

  it("reports no pending review when the host could not say", () => {
    expect(
      assembleGitLabChangeRequestActivity({ ...base, draftNotes: null }).pendingReview,
    ).toBeNull();
    expect(
      assembleGitLabChangeRequestActivity({ ...base, draftNotes: [] }).pendingReview,
    ).toBeNull();
  });
});
