import type { ReviewDraftComment } from "@ryco/client-runtime/state/pull-request-review";
import type { ChangeRequestReviewThread } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type { PullRequestDiffRow } from "./pullRequestDiffModel";
import {
  derivePullRequestReviewProgress,
  describeOutdatedDraftComments,
  interleavePullRequestFileComments,
  splitDraftCommentsByHead,
  nextUnviewedPath,
  pullRequestDiffRowAnchor,
} from "./pullRequestFileReviewModel";

const PATHS = ["a.ts", "b.ts", "c.ts"];

describe("review progress", () => {
  it("counts viewed files and finds the first one left", () => {
    const progress = derivePullRequestReviewProgress(PATHS, {
      provider: "github",
      capability: { storage: "host" },
      headSha: "abc",
      files: [
        { path: "a.ts", state: "viewed" },
        { path: "b.ts", state: "stale" },
      ],
    });
    expect(progress).toMatchObject({ total: 3, viewed: 1, firstUnviewed: "b.ts", supported: true });
    expect(progress.stateByPath.get("c.ts")).toBe("unviewed");
  });

  it("is unsupported until the host answers or where it keeps no state", () => {
    expect(derivePullRequestReviewProgress(PATHS, null).supported).toBe(false);
  });

  it("walks to the next unviewed file, wrapping around", () => {
    const states = new Map([
      ["a.ts", "unviewed" as const],
      ["b.ts", "viewed" as const],
      ["c.ts", "unviewed" as const],
    ]);
    expect(nextUnviewedPath(PATHS, states, "a.ts")).toBe("c.ts");
    expect(nextUnviewedPath(PATHS, states, "c.ts")).toBe("a.ts");
    expect(nextUnviewedPath(["a.ts"], states, "a.ts")).toBeNull();
  });
});

const rows: ReadonlyArray<PullRequestDiffRow> = [
  { kind: "hunk", text: "@@ -1,2 +1,2 @@", oldLine: null, newLine: null },
  { kind: "context", text: "x", oldLine: 1, newLine: 1 },
  { kind: "deletion", text: "y", oldLine: 2, newLine: null },
  { kind: "addition", text: "z", oldLine: null, newLine: 2 },
];

describe("diff comments", () => {
  it("anchors deletions on the old side and everything else on the new side", () => {
    expect(rows.map(pullRequestDiffRowAnchor)).toEqual([
      null,
      { line: 1, side: "right" },
      { line: 2, side: "left" },
      { line: 2, side: "right" },
    ]);
  });

  it("puts threads then drafts under their line, and the rest at the end", () => {
    const draft = (id: string, line: number, side: "left" | "right") =>
      ({
        id,
        path: "a.ts",
        subjectType: "line",
        line,
        side,
        body: id,
        headSha: "abc",
        createdAt: 0,
      }) satisfies ReviewDraftComment;
    const thread = {
      id: "t1",
      path: "a.ts",
      subjectType: "line",
      side: "right",
      line: 2,
      isResolved: false,
      isOutdated: false,
      comments: [],
    } as unknown as ChangeRequestReviewThread;
    const items = interleavePullRequestFileComments({
      path: "a.ts",
      rows,
      drafts: [
        draft("d-new", 2, "right"),
        draft("d-old", 2, "left"),
        draft("gone", 40, "right"),
        { ...draft("older-head", 1, "right"), headSha: "before" },
      ],
      headSha: "abc",
      threads: [thread, { ...thread, id: "elsewhere", path: "b.ts" }],
    });
    expect(items.map((item) => item.key)).toEqual([
      "row:0",
      "row:1",
      "row:2",
      "draft:d-old",
      "row:3",
      "thread:t1",
      "draft:d-new",
      // Line 1 is shown, but this comment's numbers refer to another head.
      "draft:gone",
      "draft:older-head",
    ]);
  });
});

describe("outdated draft comments", () => {
  const comment = (id: string, path: string, line: number, headSha: string) =>
    ({
      id,
      path,
      subjectType: "line",
      line,
      side: "right",
      body: id,
      headSha,
      createdAt: 0,
    }) satisfies ReviewDraftComment;

  it("counts only comments on the reviewed head and names the others", () => {
    const comments = [
      comment("a", "src/app.ts", 12, "new"),
      comment("b", "src/login.ts", 4, "old"),
      comment("c", "src/x.ts", 1, "old"),
    ];
    const split = splitDraftCommentsByHead(comments, "new");
    expect(split.current).toBe(1);
    expect(describeOutdatedDraftComments(split.outdated)).toBe(
      "2 comments were written on older commits (login.ts:4, x.ts:1) and stay in your draft without being sent.",
    );
    expect(describeOutdatedDraftComments([])).toBeNull();
    // Without a known head nothing counts as outdated.
    expect(splitDraftCommentsByHead(comments, null).current).toBe(3);
  });
});
