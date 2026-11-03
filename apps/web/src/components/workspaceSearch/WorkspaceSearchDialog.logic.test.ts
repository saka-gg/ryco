import {
  DEFAULT_CONTENT_SEARCH_OPTIONS,
  type WorkspaceContentSearchSnapshot,
} from "@ryco/client-runtime/state/files";
import {
  EnvironmentId,
  type ProjectContentMatch,
  type ProjectContentMatchRange,
  type ProjectEntry,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildContentSearchResults,
  buildQuickOpenRows,
  recallContentSearch,
  rememberContentSearch,
  resolveContentSearchStatus,
  resolveContentSearchUnavailable,
  resolveQuickOpenStatus,
} from "./WorkspaceSearchDialog.logic";

const file = (path: string): ProjectEntry => ({ path, kind: "file" });
const directory = (path: string): ProjectEntry => ({ path, kind: "directory" });

describe("buildQuickOpenRows", () => {
  it("lists files in the node's order and leaves folders out", () => {
    const rows = buildQuickOpenRows(
      [file("src/b.ts"), directory("src"), file("README.md"), file("src/b.ts")],
      "",
    );
    expect(rows.map((row) => row.path)).toEqual(["src/b.ts", "README.md"]);
    expect(rows[1]?.parentPath).toBeNull();
  });

  it("highlights the match in the name", () => {
    const [row] = buildQuickOpenRows([file("apps/web/PreviewPanel.tsx")], "panel");
    expect(row?.name).toEqual([
      { text: "Preview", highlighted: false },
      { text: "Panel", highlighted: true },
      { text: ".tsx", highlighted: false },
    ]);
    expect(row?.parentPath).toEqual([{ text: "apps/web", highlighted: false }]);
  });

  it("highlights the folder when only the path matches", () => {
    const [row] = buildQuickOpenRows([file("apps/web/index.ts")], "web/");
    expect(row?.name).toEqual([{ text: "index.ts", highlighted: false }]);
    expect(row?.parentPath).toEqual([
      { text: "apps/", highlighted: false },
      { text: "web", highlighted: true },
    ]);
  });
});

describe("resolveQuickOpenStatus", () => {
  const ready = {
    hasWorkspace: true,
    access: { allowed: true, reason: null },
    requestsSearch: true,
    isLoading: false,
    hasResults: true,
    error: null,
    partial: false,
  };

  it("asks for a thread when there is no workspace to search", () => {
    expect(resolveQuickOpenStatus({ ...ready, hasWorkspace: false })).toEqual({
      text: "Open a thread to search its files.",
      failed: false,
      footnote: null,
    });
  });

  it("gives the node's reason when it refuses the search", () => {
    const access = { allowed: false, reason: "Available when Studio is connected" };
    expect(resolveQuickOpenStatus({ ...ready, access }).text).toBe(
      "Available when Studio is connected",
    );
    expect(
      resolveQuickOpenStatus({ ...ready, access: { allowed: false, reason: null } }).text,
    ).toBe("Searching files is unavailable.");
  });

  it("waits for typing on nodes that do not list the workspace for an empty query", () => {
    expect(resolveQuickOpenStatus({ ...ready, requestsSearch: false }).text).toBe(
      "Type to search files.",
    );
  });

  it("says when the index is still building", () => {
    expect(resolveQuickOpenStatus({ ...ready, isLoading: true, hasResults: false }).text).toBe(
      "Indexing workspace…",
    );
    expect(resolveQuickOpenStatus({ ...ready, isLoading: true }).text).toBe("Searching files…");
  });

  it("reports a failed search with a retry, not as no matches", () => {
    const error = new Error("socket closed");
    expect(resolveQuickOpenStatus({ ...ready, error })).toEqual({
      text: "Couldn't search files.",
      failed: true,
      footnote: null,
    });
    expect(resolveQuickOpenStatus({ ...ready, error, isLoading: true }).failed).toBe(false);
    expect(resolveQuickOpenStatus({ ...ready }).text).toBe("No matching files.");
  });

  it("notes results from part of the workspace", () => {
    expect(resolveQuickOpenStatus({ ...ready, partial: true }).footnote).toBe(
      "Showing results from part of the workspace.",
    );
  });
});

const line = (
  path: string,
  lineNumber: number,
  preview: string,
  ranges: ProjectContentMatchRange[] = [],
): ProjectContentMatch => ({ path, lineNumber, preview, ranges });

describe("buildContentSearchResults", () => {
  const matches = [
    line("src/a.ts", 1, "alpha", [{ start: 0, end: 2 }]),
    line("src/a.ts", 4, "alpha again"),
    line("README.md", 2, "alpha"),
  ];

  it("groups lines by file in the node's order", () => {
    const results = buildContentSearchResults(matches, 100);
    expect(results.fileCount).toBe(2);
    expect(results.values).toEqual(["src/a.ts:1", "src/a.ts:4", "README.md:2"]);
    expect(
      results.groups.map(({ name, parentPath, matchCount }) => [name, parentPath, matchCount]),
    ).toEqual([
      ["a.ts", "src", 2],
      ["README.md", null, 1],
    ]);
    expect(results.groups[0]?.rows[0]).toMatchObject({
      path: "src/a.ts",
      lineNumber: 1,
      preview: [
        { text: "al", highlighted: true },
        { text: "pha", highlighted: false },
      ],
      label: "src/a.ts:1, alpha",
    });
  });

  it("renders up to the limit and still counts every loaded line of a file", () => {
    const results = buildContentSearchResults(matches, 1);
    expect(results.values).toEqual(["src/a.ts:1"]);
    expect(results.groups).toHaveLength(1);
    expect(results.groups[0]?.matchCount).toBe(2);
    expect(results.fileCount).toBe(2);
  });

  it("shows a line repeated in a malformed page once", () => {
    const results = buildContentSearchResults([matches[0]!, matches[0]!], 100);
    expect(results.values).toEqual(["src/a.ts:1"]);
  });

  it("drops indentation and starts a long line shortly before its first match", () => {
    const [indented] = buildContentSearchResults(
      [line("a.ts", 1, "    return x;", [{ start: 11, end: 12 }])],
      100,
    ).groups[0]!.rows;
    expect(indented?.preview.map((segment) => segment.text).join("")).toBe("return x;");

    const long = `${"a".repeat(100)}needle`;
    const [cut] = buildContentSearchResults(
      [line("a.ts", 1, long, [{ start: 100, end: 106 }])],
      100,
    ).groups[0]!.rows;
    expect(cut?.preview[0]).toEqual({ text: "…", highlighted: false });
    expect(cut?.preview.map((segment) => segment.text).join("")).toBe(`…${"a".repeat(32)}needle`);
    expect(cut?.preview.at(-1)).toEqual({ text: "needle", highlighted: true });
  });

  it("ignores ranges outside the line", () => {
    const [row] = buildContentSearchResults(
      [line("a.ts", 1, `${"a".repeat(80)}`, [{ start: 500, end: 510 }])],
      100,
    ).groups[0]!.rows;
    expect(row?.preview).toEqual([{ text: "a".repeat(80), highlighted: false }]);
  });
});

describe("resolveContentSearchUnavailable", () => {
  const ready = {
    hasWorkspace: true,
    access: { allowed: true, reason: null },
    supported: true,
  };

  it("lets a workspace on a node that can search through", () => {
    expect(resolveContentSearchUnavailable(ready)).toBeNull();
  });

  it("says why the workspace can't be searched", () => {
    expect(resolveContentSearchUnavailable({ ...ready, hasWorkspace: false })).toBe(
      "Open a thread to search its files.",
    );
    expect(
      resolveContentSearchUnavailable({
        ...ready,
        access: { allowed: false, reason: "Available when Studio is connected" },
      }),
    ).toBe("Available when Studio is connected");
    expect(resolveContentSearchUnavailable({ ...ready, supported: null })).toBe(
      "Available when this node is connected.",
    );
    expect(resolveContentSearchUnavailable({ ...ready, supported: false })).toBe(
      "Update Ryco on this node to search file contents.",
    );
  });
});

describe("resolveContentSearchStatus", () => {
  const snapshot = (
    patch: Partial<WorkspaceContentSearchSnapshot> = {},
  ): WorkspaceContentSearchSnapshot => ({
    query: "alpha",
    options: DEFAULT_CONTENT_SEARCH_OPTIONS,
    status: "ready",
    matches: [],
    hasMore: false,
    loadingMore: false,
    timedOut: false,
    stoppedEarly: false,
    partial: false,
    capped: false,
    error: null,
    ...patch,
  });
  const loaded = [line("a.ts", 1, "alpha"), line("a.ts", 2, "alpha"), line("b.ts", 1, "alpha")];
  const failure = { reason: "failed", message: "socket closed" } as const;

  it("asks for a query", () => {
    expect(
      resolveContentSearchStatus({ snapshot: snapshot({ status: "idle" }), fileCount: 0 }),
    ).toMatchObject({ message: "Type to search in files.", action: null });
    expect(
      resolveContentSearchStatus({ snapshot: snapshot({ status: "tooShort" }), fileCount: 0 })
        .message,
    ).toBe("Type at least 2 characters.");
  });

  it("counts results and files, with + while more follow", () => {
    expect(
      resolveContentSearchStatus({ snapshot: snapshot({ matches: loaded }), fileCount: 2 }),
    ).toMatchObject({ message: null, summary: "3 results in 2 files", notice: null });
    expect(
      resolveContentSearchStatus({
        snapshot: snapshot({ matches: loaded.slice(0, 1) }),
        fileCount: 1,
      }).summary,
    ).toBe("1 result in 1 file");
    expect(
      resolveContentSearchStatus({
        snapshot: snapshot({ matches: loaded, hasMore: true }),
        fileCount: 2,
      }).summary,
    ).toBe("3+ results in 2 files");
  });

  it("says when it is searching", () => {
    expect(
      resolveContentSearchStatus({ snapshot: snapshot({ status: "searching" }), fileCount: 0 }),
    ).toMatchObject({ message: "Searching…" });
    // The previous search's results stay until the new one answers.
    expect(
      resolveContentSearchStatus({
        snapshot: snapshot({ status: "searching", matches: loaded }),
        fileCount: 2,
      }),
    ).toMatchObject({ message: null, summary: "Searching…" });
    expect(resolveContentSearchStatus({ snapshot: snapshot(), fileCount: 0 }).message).toBe(
      "No results.",
    );
  });

  it("offers to keep searching after a page that found nothing in time", () => {
    const stopped = snapshot({ stoppedEarly: true, timedOut: true, hasMore: true });
    expect(resolveContentSearchStatus({ snapshot: stopped, fileCount: 0 })).toMatchObject({
      message: "Search stopped early.",
      action: "keepSearching",
      failed: false,
    });
    expect(
      resolveContentSearchStatus({ snapshot: { ...stopped, matches: loaded }, fileCount: 2 }),
    ).toMatchObject({
      summary: "3+ results in 2 files",
      notice: "Search stopped early.",
      action: "keepSearching",
    });
    // Asked to go on, it searches until the next page answers.
    expect(
      resolveContentSearchStatus({ snapshot: { ...stopped, loadingMore: true }, fileCount: 0 }),
    ).toMatchObject({ message: "Searching…", action: null });
  });

  it("offers a retry when a page failed", () => {
    expect(
      resolveContentSearchStatus({
        snapshot: snapshot({ status: "error", error: failure }),
        fileCount: 0,
      }),
    ).toMatchObject({ message: "Couldn't search files.", action: "retry", failed: true });
    expect(
      resolveContentSearchStatus({
        snapshot: snapshot({ status: "error", error: failure, matches: loaded, hasMore: true }),
        fileCount: 2,
      }),
    ).toMatchObject({
      summary: "3+ results in 2 files",
      notice: "Couldn't load more results.",
      action: "retry",
      failed: true,
    });
  });

  it("notes a partial search and the loaded-result cap", () => {
    expect(
      resolveContentSearchStatus({
        snapshot: snapshot({ matches: loaded, partial: true, capped: true, hasMore: true }),
        fileCount: 2,
      }).footnotes,
    ).toEqual(["Showing results from part of the workspace.", "Showing the first 3 results."]);
  });
});

describe("remembered content searches", () => {
  const workspace = (cwd: string) => ({ environmentId: EnvironmentId.make("env-1"), cwd });
  const search = (query: string) => ({ query, options: DEFAULT_CONTENT_SEARCH_OPTIONS });

  it("keeps the last search of each workspace", () => {
    rememberContentSearch(workspace("/repo/a"), search("alpha"));
    rememberContentSearch(workspace("/repo/b"), search("beta"));
    rememberContentSearch(workspace("/repo/a"), search("alpha two"));
    expect(recallContentSearch(workspace("/repo/a"))?.query).toBe("alpha two");
    expect(recallContentSearch(workspace("/repo/b"))?.query).toBe("beta");
    expect(
      recallContentSearch({ environmentId: EnvironmentId.make("env-2"), cwd: "/repo/a" }),
    ).toBeUndefined();
  });

  it("forgets the least recently searched workspace past its cap", () => {
    rememberContentSearch(workspace("/repo/first"), search("first"));
    for (let index = 0; index < 32; index += 1) {
      rememberContentSearch(workspace(`/repo/other-${index}`), search("other"));
    }
    expect(recallContentSearch(workspace("/repo/first"))).toBeUndefined();
    expect(recallContentSearch(workspace("/repo/other-0"))?.query).toBe("other");
  });
});
