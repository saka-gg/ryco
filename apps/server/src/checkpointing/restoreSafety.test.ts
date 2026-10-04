import { ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkpointRestoreConflictMessage,
  evaluateCheckpointRestoreSafety,
  sharesWorkingTree,
  type CheckoutPathOps,
  type RestoreNeighbour,
} from "./restoreSafety.ts";

function makeOps(input: {
  readonly gitEntries?: ReadonlyArray<string>;
  readonly caseSensitive?: boolean;
  readonly links?: Record<string, string>;
}): CheckoutPathOps {
  const gitEntries = new Set(input.gitEntries ?? []);
  return {
    canonicalize: (value) => input.links?.[value] ?? value,
    caseSensitive: input.caseSensitive ?? true,
    hasGitEntry: (dir) => gitEntries.has(dir),
  };
}

const root = "/repo";

describe("sharesWorkingTree", () => {
  const ops = makeOps({ gitEntries: [root, "/repo/.ryco/worktrees/x"] });

  it("overlaps for the same path", () => {
    expect(sharesWorkingTree(root, "/repo", ops)).toBe(true);
    expect(sharesWorkingTree(root, "/repo/", ops)).toBe(true);
  });

  it("overlaps for a monorepo subfolder without a .git entry", () => {
    expect(sharesWorkingTree(root, "/repo/packages/app", ops)).toBe(true);
  });

  it("does not overlap with a nested worktree", () => {
    expect(sharesWorkingTree(root, "/repo/.ryco/worktrees/x", ops)).toBe(false);
    expect(sharesWorkingTree(root, "/repo/.ryco/worktrees/x/src", ops)).toBe(false);
  });

  it("overlaps with a neighbour working above the checkout", () => {
    expect(sharesWorkingTree("/repo/.ryco/worktrees/x", "/repo", ops)).toBe(true);
  });

  it("does not overlap with unrelated paths", () => {
    expect(sharesWorkingTree(root, "/other", ops)).toBe(false);
    expect(sharesWorkingTree(root, "/repository", ops)).toBe(false);
  });

  it("folds case on case-insensitive filesystems", () => {
    expect(sharesWorkingTree(root, "/Repo/Src", makeOps({ caseSensitive: false }))).toBe(true);
    expect(sharesWorkingTree(root, "/Repo/Src", makeOps({ caseSensitive: true }))).toBe(false);
  });

  it("compares canonical paths", () => {
    expect(sharesWorkingTree(root, "/link", makeOps({ links: { "/link": "/repo" } }))).toBe(true);
  });
});

function neighbour(overrides: Partial<RestoreNeighbour> = {}): RestoreNeighbour {
  return {
    threadId: ThreadId.make("thread-2"),
    title: "Other thread",
    paths: [root],
    busy: false,
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

const target = Date.parse("2026-08-04T00:05:00.000Z");

describe("evaluateCheckpointRestoreSafety", () => {
  const ops = makeOps({ gitEntries: [root] });
  const evaluate = (
    neighbours: ReadonlyArray<RestoreNeighbour>,
    source: "ref" | "head-fallback" = "ref",
  ) =>
    evaluateCheckpointRestoreSafety({
      checkoutRoot: root,
      source,
      targetInstantMs: target,
      neighbours,
      ops,
    });

  it("refuses when an overlapping neighbour is busy", () => {
    expect(evaluate([neighbour({ busy: true })])).toMatchObject({
      kind: "conflict",
      reason: "neighbour-busy",
    });
  });

  it("refuses when an overlapping neighbour has activity after the target", () => {
    expect(evaluate([neighbour({ lastActivityAt: "2026-08-04T00:06:00.000Z" })])).toMatchObject({
      kind: "conflict",
      reason: "neighbour-newer",
    });
  });

  it("is safe when the neighbour's activity predates the target", () => {
    expect(evaluate([neighbour()])).toEqual({ kind: "safe" });
  });

  it("ignores busy neighbours outside the working tree", () => {
    expect(evaluate([neighbour({ busy: true, paths: ["/elsewhere"] })])).toEqual({ kind: "safe" });
  });

  it("refuses a HEAD fallback with any overlapping neighbour", () => {
    expect(evaluate([neighbour()], "head-fallback")).toMatchObject({
      kind: "conflict",
      reason: "head-fallback-shared",
    });
    expect(evaluate([], "head-fallback")).toEqual({ kind: "safe" });
  });

  it("is safe without neighbours", () => {
    expect(evaluate([])).toEqual({ kind: "safe" });
  });
});

describe("checkpointRestoreConflictMessage", () => {
  it("caps the listed titles at three", () => {
    const threads = ["A", "B", "C", "D", "E"].map((title) => ({
      threadId: ThreadId.make(`thread-${title}`),
      title,
    }));
    const message = checkpointRestoreConflictMessage(
      { kind: "conflict", reason: "neighbour-busy", threads },
      2,
    );
    expect(message).toBe(
      'Nothing was changed. "A", "B", "C" and 2 more are working in this checkout. Wait for them to finish, or give this thread its own worktree.',
    );
  });

  it("describes a single newer neighbour", () => {
    expect(
      checkpointRestoreConflictMessage(
        {
          kind: "conflict",
          reason: "neighbour-newer",
          threads: [{ threadId: ThreadId.make("thread-2"), title: "Other" }],
        },
        3,
      ),
    ).toBe(
      'Nothing was changed. "Other" changed this checkout after checkpoint 3, so restoring files would discard its work.',
    );
  });

  it("explains the HEAD fallback refusal", () => {
    expect(
      checkpointRestoreConflictMessage(
        { kind: "conflict", reason: "head-fallback-shared", threads: [] },
        0,
      ),
    ).toContain("Checkpoint 0 is missing");
  });
});
