import type { ProjectEntry } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildQuickOpenRows, resolveQuickOpenStatus } from "./WorkspaceSearchDialog.logic";

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
