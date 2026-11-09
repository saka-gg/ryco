import { describe, expect, it } from "vite-plus/test";

import {
  fileChangedSinceOpened,
  fileEditBase,
  fileWriteInput,
  FILE_EDIT_MAX_CHARACTERS,
  fileEditProblem,
  fileEditState,
  fileSaveFailureMessage,
  previewRuns,
} from "./fileEditModel";

describe("file editing", () => {
  it("edits read text files below the size cap", () => {
    expect(fileEditProblem({ contents: "hello" })).toBeNull();
    expect(fileEditProblem(null)).not.toBeNull();
    expect(fileEditProblem({ contents: "x".repeat(FILE_EDIT_MAX_CHARACTERS + 1) })).toContain(
      "too large",
    );
    expect(fileEditProblem({ contents: "a\0b" })).toBe("This file is not text.");
  });

  it("tracks unsaved edits and lines", () => {
    expect(fileEditState("a", "a")).toEqual({ dirty: false, lineCount: 1 });
    expect(fileEditState("a", "a\nb\n")).toEqual({ dirty: true, lineCount: 2 });
    expect(fileEditState("a", "a\n\nb")).toEqual({ dirty: true, lineCount: 3 });
  });

  it("explains a failed save by its reason", () => {
    expect(fileSaveFailureMessage({ reason: "conflict", message: "x" })).toContain("changed");
    expect(fileSaveFailureMessage({ reason: "deleted" })).toBe(
      "The file was deleted on the machine.",
    );
    expect(fileSaveFailureMessage(new Error("disk full"))).toBe("disk full");
    expect(fileSaveFailureMessage("?")).toBe("The file could not be saved.");
  });
});

describe("save guard", () => {
  const opened = {
    relativePath: "a.ts",
    contents: "one",
    version: "v1",
    encoding: "utf8",
    lineEnding: "lf",
  } as const;

  it("saves against the version the editor opened, not a later re-read", () => {
    const base = fileEditBase(opened as never);
    expect(
      fileWriteInput({ cwd: "/r", relativePath: "a.ts", contents: "two", base }),
    ).toMatchObject({ contents: "two", expectedVersion: "v1", encoding: "utf8", lineEnding: "lf" });
    expect(fileChangedSinceOpened(base, { version: "v2" })).toBe(true);
    expect(fileChangedSinceOpened(base, { version: "v1" })).toBe(false);
    expect(fileChangedSinceOpened(null, { version: "v2" })).toBe(false);
  });
});

describe("match previews", () => {
  it("splits at highlighted ranges", () => {
    expect(
      previewRuns("const foo = foo;", [
        { start: 6, end: 9 },
        { start: 12, end: 15 },
      ]),
    ).toEqual([
      { text: "const ", match: false },
      { text: "foo", match: true },
      { text: " = ", match: false },
      { text: "foo", match: true },
      { text: ";", match: false },
    ]);
  });

  it("clamps and merges malformed ranges without losing text", () => {
    const runs = previewRuns("abcdef", [
      { start: 4, end: 99 },
      { start: 1, end: 3 },
      { start: 2, end: 5 },
      { start: 3, end: 3 },
    ]);
    expect(runs.map((run) => run.text).join("")).toBe("abcdef");
    expect(runs).toEqual([
      { text: "a", match: false },
      { text: "bc", match: true },
      { text: "de", match: true },
      { text: "f", match: true },
    ]);
  });
});
