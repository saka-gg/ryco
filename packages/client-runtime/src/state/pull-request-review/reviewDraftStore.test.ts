import { describe, expect, it } from "vitest";

import {
  buildSubmitReviewInput,
  createReviewDraftStore,
  decodePersistedReviewDrafts,
  EMPTY_REVIEW_DRAFT,
  isReviewDraftCommentOutdated,
  REVIEW_DRAFT_STORAGE_KEY,
  reviewDraftKey,
  selectOutdatedReviewDraftComments,
  selectReviewDraft,
  type ReviewDraftStorage,
} from "./reviewDraftStore.ts";

const key = reviewDraftKey({ environmentId: "env-1", cwd: "/repo", number: 7 });

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ReviewDraftStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  return { storage, values };
}

function makeStore(options: Parameters<typeof createReviewDraftStore>[0] = {}) {
  let clock = 1_000;
  let id = 0;
  return createReviewDraftStore({
    now: () => clock++,
    createId: () => `c${++id}`,
    ...options,
  });
}

describe("reviewDraftKey", () => {
  it("scopes drafts by environment, checkout, and number", () => {
    expect(reviewDraftKey({ environmentId: "env-1", cwd: "/repo", number: 7 })).not.toBe(
      reviewDraftKey({ environmentId: "env-2", cwd: "/repo", number: 7 }),
    );
    expect(reviewDraftKey({ environmentId: "env-1", cwd: "/repo", number: 7 })).not.toBe(
      reviewDraftKey({ environmentId: "env-1", cwd: "/clone", number: 7 }),
    );
  });
});

describe("review draft store", () => {
  it("adds, edits, and removes comments, dropping the draft once empty", () => {
    const store = makeStore();
    const comment = store.getState().addComment(key, {
      path: "src/a.ts",
      line: 4,
      side: "right",
      body: "Rename this",
      headSha: "head-1",
    });
    expect(comment).toMatchObject({ id: "c1", subjectType: "line", createdAt: 1_000 });
    expect(selectReviewDraft(store.getState(), key)).toMatchObject({
      headSha: "head-1",
      comments: [{ id: "c1", body: "Rename this" }],
    });

    store.getState().updateComment(key, "c1", { body: "Rename this, please" });
    expect(selectReviewDraft(store.getState(), key).comments[0]?.body).toBe("Rename this, please");

    store.getState().removeComment(key, "c1");
    expect(store.getState().draftsByKey).toEqual({});
    expect(selectReviewDraft(store.getState(), key)).toBe(EMPTY_REVIEW_DRAFT);
  });

  it("strips line anchors from file-level comments", () => {
    const store = makeStore();
    const comment = store.getState().addComment(key, {
      path: "src/a.ts",
      subjectType: "file",
      line: 4,
      side: "left",
      body: "Whole file",
      headSha: "head-1",
    });
    expect(comment).toEqual({
      id: "c1",
      path: "src/a.ts",
      subjectType: "file",
      body: "Whole file",
      headSha: "head-1",
      createdAt: 1_000,
    });
  });

  it("marks comments on an older head outdated without re-anchoring them", () => {
    const store = makeStore();
    store
      .getState()
      .addComment(key, { path: "a.ts", line: 4, side: "right", body: "x", headSha: "h1" });
    store.getState().markHead(key, "h2");
    store
      .getState()
      .addComment(key, { path: "a.ts", line: 9, side: "right", body: "y", headSha: "h2" });

    const draft = selectReviewDraft(store.getState(), key);
    expect(draft.headSha).toBe("h2");
    expect(draft.comments.map((comment) => [comment.line, comment.headSha])).toEqual([
      [4, "h1"],
      [9, "h2"],
    ]);
    expect(selectOutdatedReviewDraftComments(draft).map((comment) => comment.id)).toEqual(["c1"]);
    expect(isReviewDraftCommentOutdated({ headSha: "h1" }, null)).toBe(false);
  });

  it("re-anchors only through an explicit update naming the new head", () => {
    const store = makeStore();
    store.getState().addComment(key, {
      path: "a.ts",
      line: 8,
      startLine: 5,
      side: "right",
      body: "x",
      headSha: "h1",
    });
    store.getState().updateComment(key, "c1", { line: 12, side: "left", headSha: "h2" });
    expect(selectReviewDraft(store.getState(), key).comments[0]).toMatchObject({
      line: 12,
      side: "left",
      headSha: "h2",
      body: "x",
    });
    expect(selectReviewDraft(store.getState(), key).comments[0]?.startLine).toBeUndefined();
  });

  it("does not create a draft just to record a head", () => {
    const store = makeStore();
    store.getState().markHead(key, "h1");
    expect(store.getState().draftsByKey).toEqual({});
  });

  it("clears exactly what was submitted", () => {
    const store = makeStore();
    store
      .getState()
      .addComment(key, { path: "a.ts", line: 1, side: "right", body: "a", headSha: "h1" });
    store.getState().setSummary(key, "LGTM");
    store.getState().setEvent(key, "approve");
    store
      .getState()
      .addComment(key, { path: "a.ts", line: 2, side: "right", body: "b", headSha: "h1" });
    // The summary was edited after the request went out.
    store.getState().setSummary(key, "LGTM!");

    store.getState().clearSubmitted(key, { commentIds: ["c1"], summary: "LGTM", event: "approve" });
    expect(selectReviewDraft(store.getState(), key)).toMatchObject({
      summary: "LGTM!",
      event: null,
      comments: [{ id: "c2" }],
    });
  });
});

describe("buildSubmitReviewInput", () => {
  function draftWith() {
    const store = makeStore();
    store.getState().addComment(key, {
      path: "a.ts",
      line: 8,
      startLine: 5,
      startSide: "right",
      side: "right",
      body: "range",
      headSha: "h2",
    });
    store
      .getState()
      .addComment(key, { path: "a.ts", line: 3, side: "left", body: "old", headSha: "h1" });
    store
      .getState()
      .addComment(key, { path: "b.ts", subjectType: "file", body: "file", headSha: "h2" });
    store
      .getState()
      .addComment(key, { path: "b.ts", line: 1, side: "right", body: "  ", headSha: "h2" });
    store.getState().markHead(key, "h2");
    return selectReviewDraft(store.getState(), key);
  }

  it("sends current-head comments and reports outdated ones", () => {
    const result = buildSubmitReviewInput(draftWith(), { cwd: "/repo", reference: "7" });
    expect(result).toMatchObject({
      ok: true,
      event: "comment",
      commentIds: ["c1", "c3"],
      input: {
        cwd: "/repo",
        reference: "7",
        event: "comment",
        expectedHeadSha: "h2",
        comments: [
          {
            path: "a.ts",
            body: "range",
            subjectType: "line",
            line: 8,
            side: "right",
            startLine: 5,
            startSide: "right",
          },
          { path: "b.ts", body: "file", subjectType: "file" },
        ],
      },
    });
    expect(result.outdated.map((comment) => comment.id)).toEqual(["c2"]);
    expect(result.ok && "body" in result.input).toBe(false);
  });

  it("uses an explicit head over the marked one", () => {
    const result = buildSubmitReviewInput(draftWith(), {
      cwd: "/repo",
      reference: "7",
      headSha: "h1",
    });
    expect(result.ok && result.commentIds).toEqual(["c2"]);
  });

  it("requires a known head", () => {
    const result = buildSubmitReviewInput(EMPTY_REVIEW_DRAFT, { cwd: "/repo", reference: "7" });
    expect(result).toMatchObject({ ok: false, reason: "no-head" });
  });

  it("allows an empty approval but not an empty comment or change request", () => {
    const head = { cwd: "/repo", reference: "7", headSha: "h1" } as const;
    expect(buildSubmitReviewInput(EMPTY_REVIEW_DRAFT, { ...head, event: "approve" })).toMatchObject(
      {
        ok: true,
        input: { event: "approve", comments: [] },
      },
    );
    expect(buildSubmitReviewInput(EMPTY_REVIEW_DRAFT, { ...head, event: "comment" })).toMatchObject(
      {
        ok: false,
        reason: "empty",
      },
    );
    expect(
      buildSubmitReviewInput(draftWith(), { ...head, headSha: "h2", event: "request_changes" }),
    ).toMatchObject({ ok: false, reason: "body-required" });
    expect(
      buildSubmitReviewInput(
        { ...EMPTY_REVIEW_DRAFT, summary: "Needs tests", event: "request_changes" },
        head,
      ),
    ).toMatchObject({ ok: true, input: { event: "request_changes", body: "Needs tests" } });
  });

  it("submits a comment review that only finishes the viewer's pending review on the host", () => {
    const head = { cwd: "/repo", reference: "7", headSha: "h1", hostPendingComments: 3 } as const;
    expect(buildSubmitReviewInput(EMPTY_REVIEW_DRAFT, { ...head, event: "comment" })).toMatchObject(
      { ok: true, input: { event: "comment", comments: [], expectedHeadSha: "h1" } },
    );
    // Requesting changes still needs a summary.
    expect(
      buildSubmitReviewInput(EMPTY_REVIEW_DRAFT, { ...head, event: "request_changes" }),
    ).toMatchObject({ ok: false, reason: "body-required" });
    expect(
      buildSubmitReviewInput(EMPTY_REVIEW_DRAFT, {
        ...head,
        hostPendingComments: 0,
        event: "comment",
      }),
    ).toMatchObject({ ok: false, reason: "empty" });
  });
});

describe("review draft persistence", () => {
  it("persists drafts through injected storage and rehydrates them", () => {
    const { storage, values } = memoryStorage();
    const first = makeStore({ storage });
    first
      .getState()
      .addComment(key, { path: "a.ts", line: 4, side: "right", body: "x", headSha: "h1" });
    first.getState().setSummary(key, "Summary");

    const raw = values.get(REVIEW_DRAFT_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toMatchObject({
      version: 1,
      state: { draftsByKey: { [key]: { summary: "Summary" } } },
    });

    const second = makeStore({ storage });
    expect(selectReviewDraft(second.getState(), key)).toMatchObject({
      summary: "Summary",
      comments: [{ path: "a.ts", line: 4, body: "x", headSha: "h1" }],
    });
  });

  it("drops malformed persisted drafts and keeps only the most recent ones", () => {
    const decoded = decodePersistedReviewDrafts(
      {
        draftsByKey: {
          broken: { comments: [{ id: "x", path: "", body: "b", headSha: "h", createdAt: 1 }] },
          noLine: {
            comments: [{ id: "x", path: "a.ts", body: "b", headSha: "h", createdAt: 1 }],
            updatedAt: 3,
          },
          older: { summary: "old", updatedAt: 1 },
          newer: { summary: "new", updatedAt: 2, event: "bogus" },
        },
      },
      1,
    );
    expect(decoded).toEqual({
      newer: { comments: [], summary: "new", event: null, headSha: null, updatedAt: 2 },
    });
    expect(decodePersistedReviewDrafts("garbage")).toEqual({});
  });

  it("works without storage as a memory-only store", () => {
    const store = makeStore();
    store.getState().setSummary(key, "Hi");
    expect(selectReviewDraft(store.getState(), key).summary).toBe("Hi");
  });
});
