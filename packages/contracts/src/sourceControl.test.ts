import { describe, expect, it } from "vite-plus/test";
import { DateTime, Option, Schema } from "effect";
import {
  truncateSourceControlDetailContent,
  SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
  SOURCE_CONTROL_DETAIL_MAX_COMMENTS,
  SourceControlChangeRequestDetail,
  ChangeRequest,
  SourceControlChangeRequestStack,
  SourceControlMergeChangeRequestInput,
  SourceControlMergeChangeRequestResult,
  SourceControlAddCommentReactionInput,
  SourceControlIssueComment,
  SourceControlAssigneeCandidate,
  SourceControlAddChangeRequestCommentInput,
  SourceControlAddIssueCommentInput,
  SourceControlCreateIssueInput,
  SourceControlWorkflowRunListInput,
  SourceControlWorkflowRerunInput,
  SourceControlProviderError,
} from "./sourceControl.ts";

const standaloneChangeRequest = {
  provider: "github",
  number: 41,
  title: "Standalone pull request",
  url: "https://github.com/acme/ryco/pull/41",
  baseRefName: "main",
  headRefName: "feature/standalone",
  state: "open",
  updatedAt: Option.none(),
};

const threeEntryStack = {
  number: 7,
  size: 3,
  position: 2,
  baseRefName: "main",
  entries: [
    {
      position: 1,
      number: 41,
      title: "Foundation",
      url: "https://github.com/acme/ryco/pull/41",
      headRefName: "stack/foundation",
      baseRefName: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      mergeStateStatus: "CLEAN",
    },
    {
      position: 2,
      number: 42,
      title: "Middle",
      url: "https://github.com/acme/ryco/pull/42",
      headRefName: "stack/middle",
      baseRefName: "stack/foundation",
      state: "open",
      isDraft: false,
      mergeability: "unknown",
      mergeStateStatus: null,
    },
    {
      position: 3,
      number: 43,
      title: "Top",
      url: "https://github.com/acme/ryco/pull/43",
      headRefName: "stack/top",
      baseRefName: "stack/middle",
      state: "open",
      isDraft: true,
      mergeability: "unknown",
    },
  ],
} as const;

describe("stacked change request contracts", () => {
  it("keeps standalone change requests decodable without stack fields", () => {
    expect(Schema.decodeUnknownSync(ChangeRequest)(standaloneChangeRequest)).toEqual(
      standaloneChangeRequest,
    );
  });

  it("decodes a valid bottom-to-top three-entry stack", () => {
    const decoded = Schema.decodeUnknownSync(SourceControlChangeRequestStack)(threeEntryStack);
    expect(decoded.entries.map((entry) => entry.number)).toEqual([41, 42, 43]);
    expect(decoded.position).toBe(2);
  });

  it("rejects zero stack positions and sizes", () => {
    expect(() =>
      Schema.decodeUnknownSync(SourceControlChangeRequestStack)({
        ...threeEntryStack,
        position: 0,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SourceControlChangeRequestStack)({
        ...threeEntryStack,
        size: 0,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SourceControlChangeRequestStack)({
        ...threeEntryStack,
        entries: [{ ...threeEntryStack.entries[0], position: 0 }],
      }),
    ).toThrow();
  });

  it("decodes merge inputs and both normalized outcomes", () => {
    const decodeInput = Schema.decodeUnknownSync(SourceControlMergeChangeRequestInput);
    const decodeResult = Schema.decodeUnknownSync(SourceControlMergeChangeRequestResult);
    expect(decodeInput({ cwd: "/repo", reference: "42", mergeMethod: "squash" })).toEqual({
      cwd: "/repo",
      reference: "42",
      mergeMethod: "squash",
    });
    expect(decodeResult({ outcome: "merged" })).toEqual({ outcome: "merged" });
    expect(decodeResult({ outcome: "enqueued" })).toEqual({ outcome: "enqueued" });
    expect(() =>
      decodeInput({ cwd: "/repo", reference: "42", mergeMethod: "fast-forward" }),
    ).toThrow();
  });
});

describe("truncateSourceControlDetailContent", () => {
  it("returns input unchanged when within caps", () => {
    const result = truncateSourceControlDetailContent({
      body: "short body",
      comments: [{ author: "a", body: "small", createdAt: new Date().toISOString() }],
    });
    expect(result.truncated).toBe(false);
    expect(result.body).toBe("short body");
    expect(result.comments).toHaveLength(1);
  });

  it("truncates body when over byte cap", () => {
    const big = "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES + 100);
    const result = truncateSourceControlDetailContent({ body: big, comments: [] });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES);
  });

  it("does not split multi-byte characters at the byte cap", () => {
    const prefix = "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES - 1);
    const result = truncateSourceControlDetailContent({ body: `${prefix}\u{1f4be}`, comments: [] });
    expect(result.truncated).toBe(true);
    expect(result.body).toBe(prefix);
  });

  it("keeps only last N comments", () => {
    const comments = Array.from({ length: SOURCE_CONTROL_DETAIL_MAX_COMMENTS + 3 }, (_, i) => ({
      author: "a",
      body: `c${i}`,
      createdAt: new Date(2026, 0, i + 1).toISOString(),
    }));
    const result = truncateSourceControlDetailContent({ body: "ok", comments });
    expect(result.truncated).toBe(true);
    expect(result.comments).toHaveLength(SOURCE_CONTROL_DETAIL_MAX_COMMENTS);
    expect(result.comments[0]?.body).toBe(
      `c${comments.length - SOURCE_CONTROL_DETAIL_MAX_COMMENTS}`,
    );
  });

  it("preserves extra fields on each comment", () => {
    const comments = [
      {
        author: "a",
        body: "first",
        createdAt: "2026-03-14T10:00:00Z",
        authorAssociation: "OWNER",
      },
      {
        author: "b",
        body: "second",
        createdAt: "2026-03-14T11:00:00Z",
        authorAssociation: "MEMBER",
      },
    ];
    const result = truncateSourceControlDetailContent({ body: "body", comments });
    expect(result.comments[0]?.authorAssociation).toBe("OWNER");
    expect(result.comments[1]?.authorAssociation).toBe("MEMBER");
  });
});

describe("SourceControlChangeRequestDetail", () => {
  it("decodes rich Bitbucket pull request detail fields", () => {
    const updatedAt = DateTime.fromDateUnsafe(new Date("2026-05-12T12:00:00.000Z"));
    const commentCreatedAt = DateTime.fromDateUnsafe(new Date("2026-05-12T11:00:00.000Z"));

    const decoded = Schema.decodeUnknownSync(SourceControlChangeRequestDetail)({
      provider: "bitbucket",
      number: 42,
      title: "PROJ-123 add Atlassian workflow",
      url: "https://bitbucket.org/acme/ryco/pull-requests/42",
      baseRefName: "main",
      headRefName: "feature/proj-123",
      state: "open",
      updatedAt: Option.some(updatedAt),
      isDraft: false,
      mergeability: "conflicting",
      author: "Alice",
      assignees: ["Bob"],
      labels: [{ name: "backend", color: "0052cc" }],
      commentsCount: 2,
      body: "Adds a richer Bitbucket and Jira workflow.",
      comments: [
        {
          author: "Reviewer",
          body: "Looks good.",
          createdAt: commentCreatedAt,
        },
      ],
      truncated: false,
      linkedIssueNumbers: [17],
      linkedWorkItemKeys: ["PROJ-123"],
      reviewers: ["Reviewer"],
      participants: [
        {
          displayName: "Reviewer",
          username: "reviewer",
          role: "REVIEWER",
          approved: true,
        },
      ],
      tasksCount: 1,
      commits: [
        {
          oid: "abcdef123456",
          shortOid: "abcdef1",
          messageHeadline: "PROJ-123 add workflow",
          author: "Alice",
        },
      ],
      additions: 120,
      deletions: 12,
      changedFiles: 4,
      files: [
        { path: "apps/server/src/sourceControl/BitbucketApi.ts", additions: 80, deletions: 4 },
      ],
    });

    expect(decoded.linkedWorkItemKeys).toEqual(["PROJ-123"]);
    expect(decoded.mergeability).toBe("conflicting");
    expect(decoded.participants?.[0]?.approved).toBe(true);
    expect(decoded.tasksCount).toBe(1);
  });
});

describe("SourceControlIssueComment", () => {
  it("decodes optional structured author role metadata", () => {
    const createdAt = DateTime.fromDateUnsafe(new Date("2026-05-12T11:00:00.000Z"));
    const decoded = Schema.decodeUnknownSync(SourceControlIssueComment)({
      author: "alice",
      body: "I opened this.",
      createdAt,
      authorAssociation: "OWNER",
      authorRole: {
        primary: "author",
        isOriginalAuthor: true,
        isRepositoryOwner: true,
        isRepositoryMaintainer: false,
      },
    });

    expect(decoded.authorRole).toEqual({
      primary: "author",
      isOriginalAuthor: true,
      isRepositoryOwner: true,
      isRepositoryMaintainer: false,
    });
  });

  it("decodes optional comment ids and reactions", () => {
    const createdAt = DateTime.fromDateUnsafe(new Date("2026-05-12T11:00:00.000Z"));
    const decoded = Schema.decodeUnknownSync(SourceControlIssueComment)({
      id: "IC_kwDOA1B2C84AAAAB",
      author: "alice",
      body: "Nice.",
      createdAt,
      reactions: [
        { content: "thumbs-up", count: 3, viewerHasReacted: true },
        { content: "rocket", count: 1 },
      ],
    });

    expect(decoded.id).toBe("IC_kwDOA1B2C84AAAAB");
    expect(decoded.reactions).toEqual([
      { content: "thumbs-up", count: 3, viewerHasReacted: true },
      { content: "rocket", count: 1 },
    ]);
    expect(() =>
      Schema.decodeUnknownSync(SourceControlIssueComment)({
        id: "IC_kwDOA1B2C84AAAAB",
        author: "alice",
        body: "Nice.",
        createdAt,
        reactions: [{ content: "invalid", count: 1 }],
      }),
    ).toThrow();
  });
});

describe("SourceControlAssigneeCandidate", () => {
  it("requires login; optional displayName and avatarUrl", () => {
    const decode = Schema.decodeUnknownSync(SourceControlAssigneeCandidate);
    expect(decode({ login: "alice" })).toEqual({ login: "alice" });
    expect(decode({ login: "alice", displayName: "Alice", avatarUrl: "https://x" })).toEqual({
      login: "alice",
      displayName: "Alice",
      avatarUrl: "https://x",
    });
    expect(() => decode({ login: "" })).toThrow();
  });
});

describe("SourceControlCreateIssueInput", () => {
  it("requires cwd + title; body may be empty; worktree is optional", () => {
    const decode = Schema.decodeUnknownSync(SourceControlCreateIssueInput);
    expect(decode({ cwd: "/repo", title: "Bug", body: "" })).toEqual({
      cwd: "/repo",
      title: "Bug",
      body: "",
    });
    expect(
      decode({
        cwd: "/repo",
        title: "Bug",
        body: "details",
        labels: ["bug"],
        assignees: ["alice"],
        worktree: { enabled: true, branchName: "fix/bug" },
      }),
    ).toMatchObject({ worktree: { enabled: true, branchName: "fix/bug" } });
    expect(() => decode({ cwd: "", title: "Bug", body: "" })).toThrow();
    expect(() => decode({ cwd: "/repo", title: "", body: "" })).toThrow();
  });
});

describe("SourceControlAddIssueCommentInput", () => {
  it("requires cwd, reference, and a non-blank body without trimming Markdown", () => {
    const decode = Schema.decodeUnknownSync(SourceControlAddIssueCommentInput);
    expect(
      decode({
        cwd: "/repo",
        reference: "42",
        body: "    code block\n\nLooks good.\n",
        clientMutationId: "mutation-1",
      }),
    ).toEqual({
      cwd: "/repo",
      reference: "42",
      body: "    code block\n\nLooks good.\n",
      clientMutationId: "mutation-1",
    });
    expect(() => decode({ cwd: "/repo", reference: "42", body: "" })).toThrow();
    expect(() => decode({ cwd: "/repo", reference: "42", body: "   " })).toThrow();
    expect(() => decode({ cwd: "", reference: "42", body: "x" })).toThrow();
    expect(() => decode({ cwd: "/repo", reference: "", body: "x" })).toThrow();
  });
});

describe("SourceControlAddChangeRequestCommentInput", () => {
  it("validates PR comment bodies the same way as issue comments", () => {
    const decode = Schema.decodeUnknownSync(SourceControlAddChangeRequestCommentInput);
    expect(
      decode({
        cwd: "/repo",
        reference: "42",
        body: "> quoted\n\n**ship it**",
      }),
    ).toEqual({
      cwd: "/repo",
      reference: "42",
      body: "> quoted\n\n**ship it**",
    });
    expect(() => decode({ cwd: "/repo", reference: "42", body: "\n\t" })).toThrow();
  });
});

describe("SourceControlAddCommentReactionInput", () => {
  it("requires a GitHub comment id and supported reaction content", () => {
    const decode = Schema.decodeUnknownSync(SourceControlAddCommentReactionInput);
    expect(
      decode({
        cwd: "/repo",
        reference: "42",
        commentId: "IC_kwDOA1B2C84AAAAB",
        content: "heart",
      }),
    ).toEqual({
      cwd: "/repo",
      reference: "42",
      commentId: "IC_kwDOA1B2C84AAAAB",
      content: "heart",
    });
    expect(() =>
      decode({ cwd: "/repo", reference: "42", commentId: "", content: "heart" }),
    ).toThrow();
    expect(() =>
      decode({ cwd: "/repo", reference: "42", commentId: "IC_1", content: "invalid" }),
    ).toThrow();
  });
});

describe("SourceControlWorkflowRunListInput", () => {
  it("accepts commit-specific workflow run lookups", () => {
    const decode = Schema.decodeUnknownSync(SourceControlWorkflowRunListInput);
    expect(
      decode({
        cwd: "/repo",
        commitSha: "abcdef1234567890",
        limit: 10,
      }),
    ).toEqual({
      cwd: "/repo",
      commitSha: "abcdef1234567890",
      limit: 10,
    });
  });

  it("accepts branch-scoped workflow run lookups without a pull request", () => {
    const decode = Schema.decodeUnknownSync(SourceControlWorkflowRunListInput);
    expect(
      decode({
        cwd: "/repo",
        branch: "main",
        limit: 20,
      }),
    ).toEqual({
      cwd: "/repo",
      branch: "main",
      limit: 20,
    });
  });
});

describe("SourceControlWorkflowRerunInput", () => {
  it("decodes run-level and job-level rerun requests", () => {
    const decode = Schema.decodeUnknownSync(SourceControlWorkflowRerunInput);
    expect(decode({ cwd: "/repo", runId: "123", target: "failed-jobs" })).toEqual({
      cwd: "/repo",
      runId: "123",
      target: "failed-jobs",
    });
    expect(decode({ cwd: "/repo", runId: "123", target: "job", jobId: "456" })).toEqual({
      cwd: "/repo",
      runId: "123",
      target: "job",
      jobId: "456",
    });
    expect(() => decode({ cwd: "/repo", runId: "123", target: "job" })).toThrow();
  });
});

describe("SourceControlProviderError", () => {
  const encode = Schema.encodeUnknownSync(SourceControlProviderError);
  const decode = Schema.decodeUnknownSync(SourceControlProviderError);
  const wire = (error: SourceControlProviderError) => JSON.parse(JSON.stringify(encode(error)));

  it("round-trips the reason and retry time", () => {
    const decoded = decode(
      wire(
        new SourceControlProviderError({
          provider: "github",
          operation: "listChangeRequests",
          detail: "GitHub API rate limit exceeded. Wait for the reset window and retry.",
          reason: "rate-limited",
          retryAt: 1_000_000_600_000,
        }),
      ),
    );
    expect(decoded.reason).toBe("rate-limited");
    expect(decoded.retryAt).toBe(1_000_000_600_000);
    // The message stays the same, so older substring readers keep working.
    expect(decoded.message).toBe(
      "Source control provider github failed in listChangeRequests: GitHub API rate limit exceeded. Wait for the reset window and retry.",
    );
  });

  it("decodes errors from servers that send neither field", () => {
    const decoded = decode({
      _tag: "SourceControlProviderError",
      provider: "gitlab",
      operation: "getChangeRequest",
      detail: "Merge request not found.",
    });
    expect(decoded.reason).toBeUndefined();
    expect(decoded.retryAt).toBeUndefined();
  });

  it("is still read by clients that predate the fields", () => {
    class OlderSourceControlProviderError extends Schema.TaggedError<OlderSourceControlProviderError>()(
      "SourceControlProviderError",
      {
        provider: Schema.String,
        operation: Schema.String,
        detail: Schema.String,
        cause: Schema.optional(Schema.Defect()),
      },
    ) {}
    const decoded = Schema.decodeUnknownSync(OlderSourceControlProviderError)(
      wire(
        new SourceControlProviderError({
          provider: "bitbucket",
          operation: "listChangeRequests",
          detail: "Bitbucket is rate limiting requests (HTTP 429).",
          reason: "rate-limited",
          retryAt: 1_000_000_030_000,
        }),
      ),
    );
    expect(decoded.detail).toBe("Bitbucket is rate limiting requests (HTTP 429).");
  });

  it("keeps the reason a closed set and the retry time a whole epoch ms", () => {
    const base = {
      _tag: "SourceControlProviderError",
      provider: "github",
      operation: "listChangeRequests",
      detail: "x",
    };
    // A kind added later must map to "failed": older clients cannot decode a new literal.
    expect(() => decode({ ...base, reason: "quota-reserved" })).toThrow();
    expect(() => decode({ ...base, retryAt: 1.5 })).toThrow();
    expect(() => decode({ ...base, retryAt: -1 })).toThrow();
  });
});

// Note: The merged result type that includes worktree output lives in
// packages/contracts/src/rpc.ts (Task 10), because GitCreateWorktreeForProjectOutput
// is declared there. No separate result type is needed in sourceControl.ts.
