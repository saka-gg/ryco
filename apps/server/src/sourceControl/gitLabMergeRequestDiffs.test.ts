import { createHash } from "node:crypto";

import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGitLabDraftNoteBody,
  buildGitLabUnifiedDiff,
  gitLabDiffHunkExcerpt,
  gitLabLineCode,
  resolveGitLabLineAnchor,
  type GitLabDiffEntry,
} from "./gitLabMergeRequestDiffs.ts";
import {
  GITLAB_MERGE_REQUEST,
  GITLAB_MERGE_REQUEST_DIFFS,
} from "./gitLabMergeRequestPage.fixtures.ts";

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");

const FILE: GitLabDiffEntry = {
  old_path: "src/app.ts",
  new_path: "src/app.ts",
  a_mode: "100644",
  b_mode: "100644",
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  diff: [
    "@@ -1,4 +1,5 @@",
    " line1",
    "-line2",
    "+line2 changed",
    "+inserted",
    " line3",
    " line4",
    "@@ -10,3 +11,2 @@",
    " line10",
    "-line11",
    " line12",
    "",
  ].join("\n"),
};

describe("buildGitLabUnifiedDiff", () => {
  it("restores git headers around GitLab's hunk-only diffs", () => {
    expect(buildGitLabUnifiedDiff(GITLAB_MERGE_REQUEST_DIFFS)).toBe(
      [
        "diff --git a/README b/README",
        "--- a/README",
        "+++ b/README",
        "@@ -1 +1 @@",
        "-Title",
        "+README",
        "diff --git a/VERSION b/VERSION",
        "--- a/VERSION",
        "+++ b/VERSION",
        "@@ -1 +1 @@",
        "-1.9.7",
        "+1.9.8",
        "",
      ].join("\n"),
    );
  });

  it("writes new, deleted, renamed, mode-only and hunk-less files like git", () => {
    const diff = buildGitLabUnifiedDiff([
      {
        old_path: "a.txt",
        new_path: "a.txt",
        b_mode: "100644",
        new_file: true,
        diff: "@@ -0,0 +1 @@\n+a\n",
      },
      {
        old_path: "b.txt",
        new_path: "b.txt",
        a_mode: "100755",
        deleted_file: true,
        diff: "@@ -1 +0,0 @@\n-b\n",
      },
      { old_path: "old.txt", new_path: "new.txt", renamed_file: true, diff: "" },
      { old_path: "run.sh", new_path: "run.sh", a_mode: "100644", b_mode: "100755", diff: "" },
      { old_path: "logo.png", new_path: "logo.png", diff: "", too_large: true },
    ]);
    expect(diff).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/a.txt",
        "@@ -0,0 +1 @@",
        "+a",
        "diff --git a/b.txt b/b.txt",
        "deleted file mode 100755",
        "--- a/b.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-b",
        "diff --git a/old.txt b/new.txt",
        "rename from old.txt",
        "rename to new.txt",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/logo.png b/logo.png",
        "",
      ].join("\n"),
    );
    expect(buildGitLabUnifiedDiff([])).toBe("");
  });
});

describe("resolveGitLabLineAnchor", () => {
  const code = (oldPos: number, newPos: number) => `${sha1("src/app.ts")}_${oldPos}_${newPos}`;

  it("anchors added, removed and unchanged hunk lines with GitLab's positions", () => {
    expect(resolveGitLabLineAnchor(FILE, "right", 3)).toEqual({
      kind: "added",
      oldLine: null,
      newLine: 3,
      lineCode: code(3, 3),
    });
    expect(resolveGitLabLineAnchor(FILE, "left", 2)).toEqual({
      kind: "removed",
      oldLine: 2,
      newLine: null,
      lineCode: code(2, 2),
    });
    // Unchanged lines need both numbers (docs: "include both").
    expect(resolveGitLabLineAnchor(FILE, "right", 4)).toEqual({
      kind: "context",
      oldLine: 3,
      newLine: 4,
      lineCode: code(3, 4),
    });
    expect(resolveGitLabLineAnchor(FILE, "left", 11)?.kind).toBe("removed");
  });

  it("shifts expanded context between and after hunks", () => {
    expect(resolveGitLabLineAnchor(FILE, "right", 7)).toMatchObject({ oldLine: 6, newLine: 7 });
    expect(resolveGitLabLineAnchor(FILE, "left", 8)).toMatchObject({ oldLine: 8, newLine: 9 });
    expect(resolveGitLabLineAnchor(FILE, "right", 30)).toMatchObject({ oldLine: 30, newLine: 30 });
  });

  it("places a line before an empty side's hunk ahead of it", () => {
    const deletion: GitLabDiffEntry = {
      old_path: "x",
      new_path: "x",
      diff: "@@ -5,2 +4,0 @@\n-gone\n-gone too\n",
    };
    expect(resolveGitLabLineAnchor(deletion, "right", 4)).toMatchObject({ oldLine: 4, newLine: 4 });
    expect(resolveGitLabLineAnchor(deletion, "right", 5)).toMatchObject({ oldLine: 7, newLine: 5 });
  });

  it("refuses lines a new file does not have", () => {
    const added: GitLabDiffEntry = {
      old_path: "n",
      new_path: "n",
      new_file: true,
      diff: "@@ -0,0 +1 @@\n+n\n",
    };
    expect(resolveGitLabLineAnchor(added, "right", 1)?.kind).toBe("added");
    expect(resolveGitLabLineAnchor(added, "right", 2)).toBeNull();
  });

  it("computes line codes as GitLab links them", () => {
    // From a gitlab.com system note: "changed this line in version 2 of the diff"
    // linking `#825187c998c4a2c7752c4ac7af5b956fa3957245_173_181`.
    expect(gitLabLineCode("internal/commands/mr/note/mr_note_create.go", 173, 181)).toBe(
      "825187c998c4a2c7752c4ac7af5b956fa3957245_173_181",
    );
  });
});

describe("gitLabDiffHunkExcerpt", () => {
  it("cuts the hunk at the commented line", () => {
    expect(gitLabDiffHunkExcerpt(FILE, "right", 3)).toBe(
      ["@@ -1,4 +1,5 @@", " line1", "-line2", "+line2 changed", "+inserted"].join("\n"),
    );
    expect(gitLabDiffHunkExcerpt(FILE, "right", 7)).toBeNull();
  });
});

describe("buildGitLabDraftNoteBody", () => {
  const diffRefs = GITLAB_MERGE_REQUEST.diff_refs;
  const shas = {
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    old_path: "src/app.ts",
    new_path: "src/app.ts",
  };

  it("anchors a right-side added line with new_line only", () => {
    const body = buildGitLabDraftNoteBody({
      comment: { path: "src/app.ts", body: "Nice", line: 3, side: "right" },
      diffRefs,
      entries: [FILE],
    });
    expect(Result.getOrThrow(body)).toEqual({
      note: "Nice",
      position: { position_type: "text", ...shas, new_line: 3 },
    });
  });

  it("anchors an unchanged line with both numbers and a range with line codes", () => {
    const body = buildGitLabDraftNoteBody({
      comment: {
        path: "src/app.ts",
        body: "Range",
        line: 4,
        side: "right",
        startLine: 2,
        startSide: "left",
      },
      diffRefs,
      entries: [FILE],
    });
    expect(Result.getOrThrow(body)).toEqual({
      note: "Range",
      position: {
        position_type: "text",
        ...shas,
        old_line: 3,
        new_line: 4,
        line_range: {
          start: { line_code: `${sha1("src/app.ts")}_2_2`, type: "old", old_line: 2 },
          end: { line_code: `${sha1("src/app.ts")}_3_4`, type: "old", old_line: 3, new_line: 4 },
        },
      },
    });
  });

  it("writes file comments as file positions", () => {
    expect(
      Result.getOrThrow(
        buildGitLabDraftNoteBody({
          comment: { path: "src/app.ts", body: "File note", subjectType: "file" },
          diffRefs,
          entries: [FILE],
        }),
      ),
    ).toEqual({ note: "File note", position: { position_type: "file", ...shas } });
  });

  it("fails before anything is created when a comment cannot be anchored", () => {
    expect(
      buildGitLabDraftNoteBody({
        comment: { path: "missing.ts", body: "x", line: 1 },
        diffRefs,
        entries: [FILE],
      }),
    ).toEqual(Result.fail("missing.ts is not part of this merge request's diff."));
    expect(
      buildGitLabDraftNoteBody({
        comment: { path: "src/app.ts", body: "x", line: 5, side: "left" },
        diffRefs,
        entries: [{ ...FILE, new_file: true }],
      }),
    ).toEqual(Result.fail("Line 5 of src/app.ts is not part of this merge request's diff."));
  });
});
