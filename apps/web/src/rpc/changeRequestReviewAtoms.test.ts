import {
  EnvironmentId,
  type ChangeRequestActivity,
  type ChangeRequestReviewThread,
  type SourceControlChangeRequestDetail,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const client = vi.hoisted(() => ({
  listChangeRequests: vi.fn(),
  searchChangeRequests: vi.fn(),
  listIssues: vi.fn(),
  listWorkflowRuns: vi.fn(),
  getWorkflowRunJobs: vi.fn(),
  getWorkflowJobLog: vi.fn(),
  addChangeRequestComment: vi.fn(),
  addChangeRequestCommentReaction: vi.fn(),
  addIssueComment: vi.fn(),
  addIssueCommentReaction: vi.fn(),
  submitChangeRequestReview: vi.fn(),
  getChangeRequestDetail: vi.fn(),
  getChangeRequestDiff: vi.fn(),
  getChangeRequestActivity: vi.fn(),
  getChangeRequestFileContents: vi.fn(),
  getIssue: vi.fn(),
  mergeChangeRequest: vi.fn(),
  setReviewThreadResolved: vi.fn(),
  replyToReviewThread: vi.fn(),
  updateChangeRequest: vi.fn(),
  updateChangeRequestComment: vi.fn(),
  createChangeRequest: vi.fn(),
}));

vi.mock("~/environments/runtime", () => ({
  requireEnvironmentConnection: vi.fn(() => ({ client: { sourceControl: client } })),
}));

import {
  changeRequestFileContentsToDiffFiles,
  ChangeRequestFileContentsUnavailableError,
  createChangeRequestDiffFilesLoader,
} from "./changeRequestDiffFiles";
import {
  addChangeRequestComment,
  changeRequestActivityBinding,
  changeRequestDetailBinding,
  changeRequestDiffBinding,
  changeRequestListBinding,
  createChangeRequest,
  fetchSourceControlChangeRequestDetail,
  fetchSourceControlIssueDetail,
  invalidateSourceControl,
  issueDetailBinding,
  issueListBinding,
  loadChangeRequestFileContents,
  mergeSourceControlChangeRequest,
  replyToReviewThread,
  resetSourceControlAtomsForTests,
  setReviewThreadResolved,
  submitChangeRequestReview,
  toggleChangeRequestCommentReaction,
  toggleIssueCommentReaction,
  updateChangeRequest,
  updateChangeRequestComment,
  workflowJobLogBinding,
  workflowRunJobsBinding,
  workflowRunsBinding,
  writeChangeRequestDetail,
} from "./sourceControlAtoms";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CWD = "/tmp/workspace";
const TARGET = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "7" } as const;
const NOW = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function thread(
  id: string,
  overrides: Partial<ChangeRequestReviewThread> = {},
): ChangeRequestReviewThread {
  return {
    id,
    path: "src/a.ts",
    subjectType: "line",
    side: "right",
    line: 3,
    isResolved: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [{ id: `${id}-c1`, author: { login: "bob" }, body: "nit", createdAt: NOW }],
    totalComments: 1,
    ...overrides,
  };
}

function activity(threads: ReadonlyArray<ChangeRequestReviewThread>): ChangeRequestActivity {
  return {
    provider: "github",
    number: 7,
    headSha: "head-1",
    viewer: {
      login: "octocat",
      isAuthor: false,
      canUpdate: true,
      canMerge: true,
      canReview: true,
      canUpdateBranch: true,
      canEnableAutoMerge: true,
      canDisableAutoMerge: true,
    },
    timeline: [{ id: "comment-1", createdAt: NOW, kind: "comment", body: "hello" }],
    timelineTruncated: false,
    reviewThreads: threads,
    reviewThreadsTruncated: false,
    pendingReview: null,
  };
}

function detail(
  overrides: Partial<SourceControlChangeRequestDetail> = {},
): SourceControlChangeRequestDetail {
  return {
    provider: "github",
    number: 7,
    title: "Title",
    url: "https://github.com/acme/app/pull/7",
    baseRefName: "main",
    headRefName: "feature",
    state: "open",
    updatedAt: Option.none(),
    body: "Body",
    comments: [{ id: "ic-1", author: "alice", body: "issue comment", createdAt: NOW }],
    truncated: false,
    labels: [{ name: "bug" }],
    ...overrides,
  };
}

const ACTIVITY_INPUT = TARGET;
const FULL_DETAIL_INPUT = { ...TARGET, fullContent: true } as const;
const SUMMARY_DETAIL_INPUT = { ...TARGET, fullContent: false } as const;

async function watchActivity(data: ChangeRequestActivity) {
  client.getChangeRequestActivity.mockResolvedValueOnce(data);
  const release = changeRequestActivityBinding.watch(ACTIVITY_INPUT);
  await flush();
  return release;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetSourceControlAtomsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetSourceControlAtomsForTests();
});

describe("change request query keys", () => {
  it("keys the list by involvement and forwards it", async () => {
    client.listChangeRequests.mockResolvedValue([]);
    const base = { environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" as const, limit: 99 };
    expect(changeRequestListBinding.targetKey(base)).not.toBe(
      changeRequestListBinding.targetKey({ ...base, involvement: "review-requested" }),
    );

    const releases = [
      changeRequestListBinding.watch(base),
      changeRequestListBinding.watch({ ...base, involvement: "review-requested" }),
      changeRequestListBinding.watch({ ...base, involvement: "review-requested" }),
    ];
    await flush();

    expect(client.listChangeRequests).toHaveBeenCalledTimes(2);
    expect(client.listChangeRequests).toHaveBeenCalledWith({ cwd: CWD, state: "open", limit: 99 });
    expect(client.listChangeRequests).toHaveBeenCalledWith({
      cwd: CWD,
      state: "open",
      limit: 99,
      involvement: "review-requested",
    });
    for (const release of releases) release();
  });

  it("keys the diff by commit and forwards it", async () => {
    client.getChangeRequestDiff.mockResolvedValue("diff");
    const base = { ...TARGET, headSha: "head-1" };
    expect(changeRequestDiffBinding.targetKey(base)).not.toBe(
      changeRequestDiffBinding.targetKey({ ...base, commitSha: "c1" }),
    );
    const release = changeRequestDiffBinding.watch({ ...base, commitSha: "c1" });
    await flush();
    expect(client.getChangeRequestDiff).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      expectedHeadSha: "head-1",
      commitSha: "c1",
    });
    release();
  });

  it("fetches activity per environment, checkout, and reference", async () => {
    const data = activity([]);
    const release = await watchActivity(data);
    expect(client.getChangeRequestActivity).toHaveBeenCalledWith({ cwd: CWD, reference: "7" });
    expect(changeRequestActivityBinding.snapshotFor(ACTIVITY_INPUT).data).toBe(data);
    expect(changeRequestActivityBinding.targetKey({ ...TARGET, reference: null })).toBeNull();
    expect(changeRequestActivityBinding.targetKey(TARGET)).not.toBe(
      changeRequestActivityBinding.targetKey({ ...TARGET, reference: "8" }),
    );
    release();
  });
});

describe("loadChangeRequestFileContents", () => {
  const input = { ...TARGET, path: "src/a.ts", headSha: "head-1" };
  const contents = { path: "src/a.ts", oldContents: "a\n", newContents: "b\n", truncated: false };

  it("dedupes in-flight loads and serves repeats from the cache", async () => {
    const deferred = createDeferred<unknown>();
    client.getChangeRequestFileContents.mockReturnValueOnce(deferred.promise);
    const first = loadChangeRequestFileContents(input);
    const second = loadChangeRequestFileContents(input);
    expect(client.getChangeRequestFileContents).toHaveBeenCalledTimes(1);
    expect(client.getChangeRequestFileContents).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      path: "src/a.ts",
      headSha: "head-1",
    });
    deferred.resolve(contents);
    await expect(first).resolves.toBe(contents);
    await expect(second).resolves.toBe(contents);

    await expect(loadChangeRequestFileContents(input)).resolves.toBe(contents);
    // Revisions are immutable: workspace invalidation keeps the entry.
    invalidateSourceControl({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    await loadChangeRequestFileContents(input);
    expect(client.getChangeRequestFileContents).toHaveBeenCalledTimes(1);
  });

  it("keys entries by both revisions and the previous path", async () => {
    client.getChangeRequestFileContents.mockResolvedValue(contents);
    await loadChangeRequestFileContents(input);
    await loadChangeRequestFileContents({ ...input, headSha: "head-2" });
    await loadChangeRequestFileContents({ ...input, baseSha: "base-1" });
    await loadChangeRequestFileContents({ ...input, previousPath: "src/old.ts" });
    expect(client.getChangeRequestFileContents).toHaveBeenCalledTimes(4);
    expect(client.getChangeRequestFileContents).toHaveBeenLastCalledWith({
      cwd: CWD,
      reference: "7",
      path: "src/a.ts",
      previousPath: "src/old.ts",
      headSha: "head-1",
    });
  });

  it("does not cache failures and rejects incomplete targets", async () => {
    client.getChangeRequestFileContents
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(contents);
    await expect(loadChangeRequestFileContents(input)).rejects.toThrow("boom");
    await expect(loadChangeRequestFileContents(input)).resolves.toBe(contents);
    await expect(loadChangeRequestFileContents({ ...input, cwd: null })).rejects.toThrow(
      "File contents are unavailable.",
    );
  });
});

describe("change request diff file loader", () => {
  it("hydrates both sides with stable cache keys", async () => {
    client.getChangeRequestFileContents.mockResolvedValue({
      path: "src/new.ts",
      oldContents: "old",
      newContents: null,
      truncated: false,
    });
    const loader = createChangeRequestDiffFilesLoader({ ...TARGET, headSha: "head-1" });
    const files = await loader({ name: "src/new.ts", prevName: "src/old.ts" } as never);
    expect(files).toEqual({
      oldFile: {
        name: "src/old.ts",
        contents: "old",
        cacheKey: "pr:7:merge-base:head-1:old:src/old.ts",
      },
      newFile: {
        name: "src/new.ts",
        contents: "",
        cacheKey: "pr:7:merge-base:head-1:new:src/new.ts",
      },
    });
  });

  it("refuses truncated or binary contents", () => {
    const options = { path: "a.bin", cacheKeyPrefix: "x" };
    expect(() =>
      changeRequestFileContentsToDiffFiles(
        { path: "a.bin", oldContents: null, newContents: null, truncated: false },
        options,
      ),
    ).toThrow(ChangeRequestFileContentsUnavailableError);
    expect(() =>
      changeRequestFileContentsToDiffFiles(
        { path: "a.bin", oldContents: "a", newContents: "b", truncated: true },
        options,
      ),
    ).toThrow("too large");
  });
});

describe("detail cache invalidation", () => {
  it("does not resurrect an entry invalidated while its fetch was in flight", async () => {
    const stale = createDeferred<unknown>();
    client.getIssue.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ id: "fresh" });
    const params = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "1" };
    const first = fetchSourceControlIssueDetail(params);
    invalidateSourceControl({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    stale.resolve({ id: "stale" });
    await expect(first).resolves.toEqual({ id: "stale" });

    await expect(fetchSourceControlIssueDetail(params)).resolves.toEqual({ id: "fresh" });
    expect(client.getIssue).toHaveBeenCalledTimes(2);
  });
});

describe("setReviewThreadResolved", () => {
  it("flips the thread immediately and applies the host's answer", async () => {
    const release = await watchActivity(activity([thread("t1"), thread("t2")]));
    const deferred = createDeferred<unknown>();
    client.setReviewThreadResolved.mockReturnValueOnce(deferred.promise);
    client.getChangeRequestActivity.mockReturnValue(new Promise(() => undefined));

    const pending = setReviewThreadResolved(TARGET, { threadId: "t1", resolved: true });
    const optimistic = changeRequestActivityBinding.snapshotFor(ACTIVITY_INPUT).data;
    expect(optimistic?.reviewThreads[0]).toMatchObject({ isResolved: true, resolvedBy: "octocat" });
    expect(optimistic?.reviewThreads[1]?.isResolved).toBe(false);

    deferred.resolve({ threadId: "t1", isResolved: true, resolvedBy: "OctoCat" });
    await pending;
    expect(client.setReviewThreadResolved).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      threadId: "t1",
      resolved: true,
    });
    expect(
      changeRequestActivityBinding.snapshotFor(ACTIVITY_INPUT).data?.reviewThreads[0]?.resolvedBy,
    ).toBe("OctoCat");
    // Refreshes the activity after the mutation.
    expect(client.getChangeRequestActivity).toHaveBeenCalledTimes(2);
    release();
  });

  it("rolls back exactly the failed thread", async () => {
    const release = await watchActivity(
      activity([thread("t1"), thread("t2", { isResolved: true })]),
    );
    client.setReviewThreadResolved.mockRejectedValueOnce(new Error("forbidden"));

    await expect(
      setReviewThreadResolved(TARGET, { threadId: "t1", resolved: true }),
    ).rejects.toThrow("forbidden");
    const threads = changeRequestActivityBinding.snapshotFor(ACTIVITY_INPUT).data?.reviewThreads;
    expect(threads?.map((entry) => entry.isResolved)).toEqual([false, true]);
    expect(threads?.[0] && "resolvedBy" in threads[0]).toBe(false);
    release();
  });

  it("keeps the optimistic state when a poll that started earlier lands late", async () => {
    const release = await watchActivity(activity([thread("t1")]));
    const stalePoll = createDeferred<unknown>();
    client.getChangeRequestActivity.mockReturnValueOnce(stalePoll.promise);
    changeRequestActivityBinding.refresh(ACTIVITY_INPUT);
    await flush();

    const mutation = createDeferred<unknown>();
    client.setReviewThreadResolved.mockReturnValueOnce(mutation.promise);
    client.getChangeRequestActivity.mockReturnValue(new Promise(() => undefined));
    const pending = setReviewThreadResolved(TARGET, { threadId: "t1", resolved: true });

    stalePoll.resolve(activity([thread("t1")]));
    await flush();
    expect(
      changeRequestActivityBinding.snapshotFor(ACTIVITY_INPUT).data?.reviewThreads[0]?.isResolved,
    ).toBe(true);

    mutation.resolve({ threadId: "t1", isResolved: true });
    await pending;
    release();
  });
});

describe("replyToReviewThread", () => {
  it("writes the returned thread and refreshes the activity", async () => {
    const release = await watchActivity(activity([thread("t1")]));
    const replied = thread("t1", { totalComments: 2 });
    client.replyToReviewThread.mockResolvedValueOnce({ thread: replied });
    client.getChangeRequestActivity.mockReturnValue(new Promise(() => undefined));

    await replyToReviewThread(TARGET, { threadId: "t1", body: "Done" });
    expect(client.replyToReviewThread).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      threadId: "t1",
      body: "Done",
    });
    expect(changeRequestActivityBinding.snapshotFor(ACTIVITY_INPUT).data?.reviewThreads[0]).toBe(
      replied,
    );
    expect(client.getChangeRequestActivity).toHaveBeenCalledTimes(2);
    release();
  });
});

describe("updateChangeRequestComment", () => {
  it("applies an edit to the activity and both detail variants", async () => {
    const releaseActivity = await watchActivity(activity([thread("t1")]));
    changeRequestDetailBinding.updateData(FULL_DETAIL_INPUT, () => detail());
    changeRequestDetailBinding.updateData(SUMMARY_DETAIL_INPUT, () => detail());
    client.updateChangeRequestComment.mockResolvedValueOnce({ commentId: "ic-1", deleted: false });

    await updateChangeRequestComment(TARGET, {
      commentId: "ic-1",
      commentKind: "issue-comment",
      action: "edit",
      body: "edited",
    });
    for (const input of [FULL_DETAIL_INPUT, SUMMARY_DETAIL_INPUT]) {
      expect(changeRequestDetailBinding.snapshotFor(input).data?.comments[0]?.body).toBe("edited");
    }
    releaseActivity();
  });
});

describe("updateChangeRequest", () => {
  it("applies predictable actions optimistically and writes the result into both detail variants", async () => {
    changeRequestDetailBinding.updateData(FULL_DETAIL_INPUT, () => detail());
    changeRequestDetailBinding.updateData(SUMMARY_DETAIL_INPUT, () => detail());
    const deferred = createDeferred<unknown>();
    client.updateChangeRequest.mockReturnValueOnce(deferred.promise);

    const pending = updateChangeRequest(TARGET, { kind: "labels", add: ["ui"], remove: ["bug"] });
    for (const input of [FULL_DETAIL_INPUT, SUMMARY_DETAIL_INPUT]) {
      expect(changeRequestDetailBinding.snapshotFor(input).data?.labels).toEqual([{ name: "ui" }]);
    }

    const fresh = detail({ labels: [{ name: "ui", color: "00ff00" }] });
    deferred.resolve({ detail: fresh });
    await pending;
    expect(client.updateChangeRequest).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      action: { kind: "labels", add: ["ui"], remove: ["bug"] },
    });
    expect(changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data).toBe(fresh);
    expect(changeRequestDetailBinding.snapshotFor(SUMMARY_DETAIL_INPUT).data).toBe(fresh);
  });

  it("rolls back the optimistic fields on failure", async () => {
    const original = detail({ isDraft: false, mergeStateStatus: "clean" });
    changeRequestDetailBinding.updateData(FULL_DETAIL_INPUT, () => original);
    client.updateChangeRequest.mockRejectedValueOnce(new Error("nope"));

    await expect(updateChangeRequest(TARGET, { kind: "set-draft", draft: true })).rejects.toThrow(
      "nope",
    );
    expect(changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data).toMatchObject({
      isDraft: false,
      mergeStateStatus: "clean",
    });
  });

  it("writes the summary variant only when something already holds it", () => {
    writeChangeRequestDetail(TARGET, detail());
    expect(changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data).not.toBeNull();
    expect(changeRequestDetailBinding.snapshotFor(SUMMARY_DETAIL_INPUT).data).toBeNull();
  });

  it("fails closed without a complete target", async () => {
    await expect(
      updateChangeRequest({ ...TARGET, reference: null }, { kind: "reopen" }),
    ).rejects.toThrow("Updating pull requests is unavailable.");
    expect(client.updateChangeRequest).not.toHaveBeenCalled();
  });
});

describe("merge and create", () => {
  it("forwards delete-branch and head guards to the merge RPC", async () => {
    client.mergeChangeRequest.mockResolvedValueOnce({ outcome: "merged" });
    await mergeSourceControlChangeRequest({
      ...TARGET,
      mergeMethod: "squash",
      deleteBranch: true,
      expectedHeadSha: "head-1",
    });
    expect(client.mergeChangeRequest).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      mergeMethod: "squash",
      deleteBranch: true,
      expectedHeadSha: "head-1",
    });
  });

  it("creates a change request and invalidates the workspace lists", async () => {
    client.listChangeRequests.mockResolvedValue([]);
    const release = changeRequestListBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      state: "open",
    });
    await flush();
    client.createChangeRequest.mockResolvedValueOnce({ number: 9 });

    await createChangeRequest(ENVIRONMENT_ID, {
      cwd: CWD,
      baseRefName: "main",
      headRefName: "feature",
      title: "New",
      body: "",
    });
    await flush();
    expect(client.listChangeRequests).toHaveBeenCalledTimes(2);
    release();
  });
});

// ---------------------------------------------------------------------------
// Targeted refresh after mutations
// ---------------------------------------------------------------------------

/** Mounts every read a fully visited reader holds open for TARGET, then forgets the calls. */
async function mountReader(options: { readonly detail?: SourceControlChangeRequestDetail } = {}) {
  const base = options.detail ?? detail();
  client.getChangeRequestDetail.mockResolvedValue(base);
  client.getChangeRequestActivity.mockResolvedValue(activity([thread("t1")]));
  client.getChangeRequestDiff.mockResolvedValue("diff --git a/x b/x");
  client.listChangeRequests.mockResolvedValue([]);
  client.searchChangeRequests.mockResolvedValue([]);
  client.listIssues.mockResolvedValue([]);
  client.listWorkflowRuns.mockResolvedValue({ runs: [] });
  client.getWorkflowRunJobs.mockResolvedValue({ jobs: [] });
  client.getWorkflowJobLog.mockResolvedValue({ log: "log", truncated: false });
  const listInput = { environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" as const };
  const releases = [
    changeRequestDetailBinding.watch(FULL_DETAIL_INPUT),
    changeRequestActivityBinding.watch(ACTIVITY_INPUT),
    changeRequestListBinding.watch(listInput),
    changeRequestListBinding.watch({ ...listInput, involvement: "review-requested" }),
    changeRequestDiffBinding.watch({ ...TARGET, headSha: "head-1" }),
    workflowRunsBinding.watch({ environmentId: ENVIRONMENT_ID, cwd: CWD, pullRequestNumber: 7 }),
    workflowRunJobsBinding.watch({ environmentId: ENVIRONMENT_ID, cwd: CWD, runId: "run-1" }),
    workflowJobLogBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      runId: "run-1",
      jobId: "job-1",
      enabled: true,
    }),
    issueListBinding.watch({ environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" }),
  ];
  await flush();
  vi.clearAllMocks();
  return () => {
    for (const release of releases) release();
  };
}

function readCounts() {
  return {
    detail: client.getChangeRequestDetail.mock.calls.length,
    activity: client.getChangeRequestActivity.mock.calls.length,
    lists: client.listChangeRequests.mock.calls.length,
    diff: client.getChangeRequestDiff.mock.calls.length,
    runs: client.listWorkflowRuns.mock.calls.length,
    jobs: client.getWorkflowRunJobs.mock.calls.length,
    logs: client.getWorkflowJobLog.mock.calls.length,
    issues: client.listIssues.mock.calls.length,
  };
}

const NO_READS = {
  detail: 0,
  activity: 0,
  lists: 0,
  diff: 0,
  runs: 0,
  jobs: 0,
  logs: 0,
  issues: 0,
};

describe("mutations refresh exactly what they change", () => {
  it("a label edit writes the detail and refreshes activity and lists only", async () => {
    const release = await mountReader();
    client.updateChangeRequest.mockResolvedValueOnce({
      detail: detail({ labels: [{ name: "ui" }] }),
    });

    await updateChangeRequest(TARGET, { kind: "labels", add: ["ui"], remove: ["bug"] });
    await flush();

    // Two list reads (state + involvement); no diff, jobs, logs, or detail refetch.
    expect(readCounts()).toEqual({ ...NO_READS, activity: 1, lists: 2 });
    expect(changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data?.labels).toEqual([
      { name: "ui" },
    ]);
    release();
  });

  it("a description checkbox (body-only edit) refetches nothing", async () => {
    const release = await mountReader();
    client.updateChangeRequest.mockResolvedValueOnce({ detail: detail({ body: "- [x] done" }) });

    await updateChangeRequest(TARGET, { kind: "edit", body: "- [x] done" });
    await flush();

    expect(readCounts()).toEqual(NO_READS);
    release();
  });

  it("a comment edit refreshes only the activity", async () => {
    const release = await mountReader();
    client.updateChangeRequestComment.mockResolvedValueOnce({ commentId: "ic-1", deleted: false });

    await updateChangeRequestComment(TARGET, {
      commentId: "ic-1",
      commentKind: "issue-comment",
      action: "edit",
      body: "edited",
    });
    await flush();

    expect(readCounts()).toEqual({ ...NO_READS, activity: 1 });
    release();
  });

  it("a reaction refreshes only the activity, never the diff or job logs", async () => {
    const release = await mountReader();
    const reacted = detail({
      comments: [
        {
          id: "ic-1",
          author: "alice",
          body: "issue comment",
          createdAt: NOW,
          reactions: [{ content: "thumbs-up", count: 1, viewerHasReacted: true }],
        },
      ],
    });
    client.addChangeRequestCommentReaction.mockResolvedValueOnce({ detail: reacted });

    await toggleChangeRequestCommentReaction(TARGET, { commentId: "ic-1", content: "thumbs-up" });
    await flush();

    expect(readCounts()).toEqual({ ...NO_READS, activity: 1 });
    expect(changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data).toBe(reacted);
    release();
  });

  it("a new comment writes the returned detail and refreshes only the activity", async () => {
    const release = await mountReader();
    const commented = detail({ body: "after" });
    client.addChangeRequestComment.mockResolvedValueOnce({ detail: commented });

    await addChangeRequestComment(TARGET, { body: "Looks good" });
    await flush();

    expect(client.addChangeRequestComment).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      body: "Looks good",
    });
    expect(readCounts()).toEqual({ ...NO_READS, activity: 1 });
    expect(changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data).toBe(commented);
    release();
  });

  it("a review refreshes detail, activity, and lists, never the diff, jobs, or logs", async () => {
    const release = await mountReader();
    client.submitChangeRequestReview.mockResolvedValueOnce({ reviewId: "r1", state: "approved" });

    await submitChangeRequestReview(TARGET, { event: "approve" } as never);
    await flush();

    expect(readCounts()).toEqual({ ...NO_READS, detail: 1, activity: 1, lists: 2 });
    release();
  });

  it("refreshes only watched detail variants after a thread is resolved", async () => {
    const release = await mountReader();
    // A capped variant someone read once but no longer watches.
    changeRequestDetailBinding.updateData(SUMMARY_DETAIL_INPUT, () => detail());
    client.setReviewThreadResolved.mockResolvedValueOnce({ threadId: "t1", isResolved: true });

    await setReviewThreadResolved(TARGET, { threadId: "t1", resolved: true });
    await flush();

    expect(readCounts()).toEqual({ ...NO_READS, detail: 1, activity: 1 });
    expect(client.getChangeRequestDetail).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      fullContent: true,
    });
    release();
  });

  it("updating the branch moves the head, so the whole checkout refreshes", async () => {
    const release = await mountReader();
    client.updateChangeRequest.mockResolvedValueOnce({ detail: detail({ headSha: "head-2" }) });

    await updateChangeRequest(TARGET, {
      kind: "update-branch",
      method: "merge",
      expectedHeadSha: "head-1",
    });
    await flush();

    const counts = readCounts();
    expect(counts.diff).toBe(1);
    expect(counts.jobs).toBe(1);
    expect(counts.lists).toBe(2);
    release();
  });

  it("an auto-merge that lands immediately refreshes the whole checkout", async () => {
    const release = await mountReader({ detail: detail({ headSha: "head-1" }) });
    client.updateChangeRequest.mockResolvedValueOnce({
      detail: detail({ headSha: "head-1", state: "merged" }),
    });

    await updateChangeRequest(TARGET, { kind: "auto-merge", enabled: true });
    await flush();

    expect(readCounts().diff).toBe(1);
    release();
  });

  it("drops the imperative detail of the mutated request", async () => {
    const release = await mountReader();
    await fetchSourceControlChangeRequestDetail({ ...TARGET, reference: "7" });
    client.updateChangeRequest.mockResolvedValueOnce({ detail: detail() });
    await updateChangeRequest(TARGET, { kind: "labels", add: ["ui"], remove: [] });
    await flush();
    client.getChangeRequestDetail.mockClear();

    await fetchSourceControlChangeRequestDetail({ ...TARGET, reference: "7" });
    expect(client.getChangeRequestDetail).toHaveBeenCalledTimes(1);
    release();
  });

  it("rolls back an optimistic reaction exactly when the host refuses it", async () => {
    changeRequestDetailBinding.updateData(FULL_DETAIL_INPUT, () => detail());
    const original = changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data;
    const deferred = createDeferred<unknown>();
    client.addChangeRequestCommentReaction.mockReturnValueOnce(deferred.promise);

    const pending = toggleChangeRequestCommentReaction(TARGET, {
      commentId: "ic-1",
      content: "heart",
    });
    expect(
      changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data?.comments[0]?.reactions,
    ).toEqual([{ content: "heart", count: 1, viewerHasReacted: true }]);

    deferred.reject(new Error("forbidden"));
    await expect(pending).rejects.toThrow("forbidden");
    expect(changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data).toBe(original);
  });

  it("an issue reaction writes the issue detail without touching pull request reads", async () => {
    const release = await mountReader();
    const issueInput = { ...TARGET, fullContent: true } as const;
    issueDetailBinding.updateData(issueInput, () => ({ comments: [] }) as never);
    const fresh = { comments: [], number: 7 } as never;
    client.addIssueCommentReaction.mockResolvedValueOnce({ detail: fresh });

    await toggleIssueCommentReaction(TARGET, { commentId: "c1", content: "heart" });
    await flush();

    expect(readCounts()).toEqual(NO_READS);
    expect(issueDetailBinding.snapshotFor(issueInput).data).toBe(fresh);
    release();
  });

  it("creating a pull request refreshes only the lists", async () => {
    const release = await mountReader();
    client.createChangeRequest.mockResolvedValueOnce({ number: 9 });

    await createChangeRequest(ENVIRONMENT_ID, {
      cwd: CWD,
      baseRefName: "main",
      headRefName: "feature",
      title: "New",
      body: "",
    });
    await flush();

    expect(readCounts()).toEqual({ ...NO_READS, lists: 2 });
    release();
  });
});

// ---------------------------------------------------------------------------
// Detail sharing across variants and checkouts
// ---------------------------------------------------------------------------

const WORKTREE_CWD = "/tmp/worktrees/feature";
const INBOX_DETAIL_INPUT = {
  environmentId: ENVIRONMENT_ID,
  cwd: WORKTREE_CWD,
  reference: "7",
} as const;
const ACTIVE_POLL = { resolveIntervalMs: () => 30_000 } as const;

function calledWithCwd(cwd: string): number {
  return client.getChangeRequestDetail.mock.calls.filter(
    ([request]) => (request as { cwd: string }).cwd === cwd,
  ).length;
}

/** The page (full, repository checkout) and an inbox row (capped, worktree) on one PR. */
async function mountPageAndInboxRow(
  options: { readonly pageDetail?: SourceControlChangeRequestDetail } = {},
) {
  client.getChangeRequestDetail.mockImplementation(async (request: { cwd: string }) =>
    request.cwd === CWD
      ? (options.pageDetail ?? detail())
      : detail({ truncated: true, comments: [] }),
  );
  const releaseInbox = changeRequestDetailBinding.watch(INBOX_DETAIL_INPUT, ACTIVE_POLL);
  await flush();
  const releasePage = changeRequestDetailBinding.watch(FULL_DETAIL_INPUT, ACTIVE_POLL);
  await flush();
  return () => {
    releaseInbox();
    releasePage();
  };
}

describe("change request detail sharing", () => {
  it("publishes the page's full read into the inbox row's capped key in another checkout", async () => {
    const release = await mountPageAndInboxRow();
    const pageData = changeRequestDetailBinding.snapshotFor(FULL_DETAIL_INPUT).data;
    expect(pageData?.truncated).toBe(false);
    expect(changeRequestDetailBinding.snapshotFor(INBOX_DETAIL_INPUT).data).toBe(pageData);
    release();
  });

  it("polls the host once per cycle for a request both readers watch", async () => {
    const release = await mountPageAndInboxRow();
    client.getChangeRequestDetail.mockClear();

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await vi.advanceTimersByTimeAsync(33_000);
    }

    // Only the page's key reaches the host; the inbox row is served from it.
    expect(calledWithCwd(WORKTREE_CWD)).toBe(0);
    expect(calledWithCwd(CWD)).toBeGreaterThanOrEqual(3);
    release();
  });

  it("falls back to the host once the page stops reading", async () => {
    client.getChangeRequestDetail.mockImplementation(async () => detail());
    const releaseInbox = changeRequestDetailBinding.watch(INBOX_DETAIL_INPUT, ACTIVE_POLL);
    await flush();
    const releasePage = changeRequestDetailBinding.watch(FULL_DETAIL_INPUT, ACTIVE_POLL);
    await flush();
    releasePage();
    client.getChangeRequestDetail.mockClear();

    await vi.advanceTimersByTimeAsync(33_000);
    // The page's last read is still young enough to answer the first due poll…
    expect(calledWithCwd(WORKTREE_CWD)).toBe(0);
    await vi.advanceTimersByTimeAsync(33_000);
    // …but not the next one.
    expect(calledWithCwd(WORKTREE_CWD)).toBe(1);
    releaseInbox();
  });

  it("always reads the host for an explicit refresh or invalidation of the capped key", async () => {
    const release = await mountPageAndInboxRow();
    client.getChangeRequestDetail.mockClear();

    changeRequestDetailBinding.refresh(INBOX_DETAIL_INPUT);
    await flush();
    expect(calledWithCwd(WORKTREE_CWD)).toBe(1);

    invalidateSourceControl({ environmentId: ENVIRONMENT_ID, cwd: WORKTREE_CWD });
    await flush();
    expect(calledWithCwd(WORKTREE_CWD)).toBe(2);
    release();
  });

  it("lands a merge made on the page in the inbox row's key", async () => {
    const release = await mountPageAndInboxRow();
    client.mergeChangeRequest.mockResolvedValueOnce({ outcome: "merged" });
    client.getChangeRequestDetail.mockImplementation(async () => detail({ state: "merged" }));
    client.getChangeRequestDiff.mockResolvedValue("diff");
    client.getChangeRequestActivity.mockResolvedValue(activity([]));
    client.getChangeRequestDetail.mockClear();

    await mergeSourceControlChangeRequest({ ...TARGET, mergeMethod: "squash" });
    await flush();

    expect(changeRequestDetailBinding.snapshotFor(INBOX_DETAIL_INPUT).data?.state).toBe("merged");
    expect(calledWithCwd(WORKTREE_CWD)).toBe(0);
    release();
  });

  it("lands a lifecycle result in the inbox row's key without a read", async () => {
    const release = await mountPageAndInboxRow();
    client.getChangeRequestDetail.mockClear();
    const fresh = detail({ isDraft: false, labels: [{ name: "ui" }] });
    client.updateChangeRequest.mockResolvedValueOnce({ detail: fresh });
    client.listChangeRequests.mockResolvedValue([]);
    client.getChangeRequestActivity.mockResolvedValue(activity([]));

    await updateChangeRequest(TARGET, { kind: "labels", add: ["ui"], remove: ["bug"] });
    await flush();

    expect(changeRequestDetailBinding.snapshotFor(INBOX_DETAIL_INPUT).data).toBe(fresh);
    expect(client.getChangeRequestDetail).not.toHaveBeenCalled();
    release();
  });

  it("never shares a full read that a local write superseded", async () => {
    const release = await mountPageAndInboxRow();
    const inboxBefore = changeRequestDetailBinding.snapshotFor(INBOX_DETAIL_INPUT).data;
    const stale = createDeferred<SourceControlChangeRequestDetail>();
    client.getChangeRequestDetail.mockReturnValueOnce(stale.promise);
    changeRequestDetailBinding.refresh(FULL_DETAIL_INPUT);
    await flush();

    changeRequestDetailBinding.updateData(FULL_DETAIL_INPUT, () => detail({ title: "Optimistic" }));
    stale.resolve(detail({ title: "Stale" }));
    await flush();

    expect(changeRequestDetailBinding.snapshotFor(INBOX_DETAIL_INPUT).data).toBe(inboxBefore);
    release();
  });

  it("never serves a key from its own shared read", async () => {
    client.getChangeRequestDetail.mockImplementation(async () => detail());
    const release = changeRequestDetailBinding.watch(FULL_DETAIL_INPUT, ACTIVE_POLL);
    await flush();
    client.getChangeRequestDetail.mockClear();

    await vi.advanceTimersByTimeAsync(33_000);
    expect(client.getChangeRequestDetail).toHaveBeenCalledTimes(1);
    release();
  });
});
