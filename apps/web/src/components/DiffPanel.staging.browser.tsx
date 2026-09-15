import "../index.css";
import { EnvironmentId, ProjectId, ThreadId, type GitLocalChangesResult } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import DiffPanel, { DiffWorkerPoolProvider } from "./DiffPanel";
const fixture = vi.hoisted(() => ({ read: vi.fn(), apply: vi.fn() }));
vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: () => ({
    vcs: { readLocalChanges: fixture.read, applyIndexPatch: fixture.apply },
  }),
}));
vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: () => null,
  subscribeEnvironmentConnections: () => () => {},
}));
vi.mock("../rpc/useComparison", () => ({
  useComparison: () => ({
    selection: null,
    data: null,
    isLoading: false,
    error: null,
    refMoved: false,
    setSelection: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("../rpc/gitAtoms", () => ({
  gitScopeKey: (cwd: string) => cwd,
  invalidateScopes: vi.fn(),
  subscribeInvalidationScope: () => () => {},
}));
const openInPreferredEditor = vi.hoisted(() => vi.fn());
vi.mock("../composerDraftStore", () => import("@ryco/client-runtime/state/composer"));
vi.mock("../editorPreferences", () => ({
  openInPreferredEditor,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: vi.fn((options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = { environmentId: "environment-local", threadId: "thread-1" };
    return options?.select ? options.select(params) : params;
  }),
  useSearch: vi.fn((options?: { select?: (search: Record<string, string>) => unknown }) => {
    const search = {
      diff: "1",
    };
    return options?.select ? options.select(search) : search;
  }),
}));

vi.mock("~/lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: { isRepo: true } }),
}));

vi.mock("~/rpc/useProvider", () => ({
  useCheckpointDiff: () => ({
    data: { diff: "" },
    error: null,
    isLoading: false,
  }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
  }),
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    diffWordWrap: false,
    diffIgnoreWhitespace: false,
    timestampFormat: "locale",
  }),
}));

/**
 * Twelve turns, not one. The turn strip's whole reachability question is what
 * happens when the rail overflows; a single-chip fixture never scrolls and
 * would make every strip assertion below true of any layout.
 */
const TURN_DIFF_SUMMARIES = vi.hoisted(() =>
  Array.from({ length: 12 }, (_unused, index) => ({
    turnId: `turn-${index + 1}`,
    checkpointTurnCount: index + 1,
    completedAt: "2026-05-06T00:00:00.000Z",
    files: [{ path: "src/app.ts" }],
  })),
);

vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: TURN_DIFF_SUMMARIES,
    inferredCheckpointTurnCountByTurnId: {},
  }),
}));

vi.mock("../threadRoutes", () => ({
  buildThreadRouteParams: () => ({ environmentId: "environment-local", threadId: "thread-1" }),
  resolveThreadRouteRef: () => ({
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make("thread-1"),
  }),
}));

vi.mock("../storeSelectors", () => ({
  createThreadSelectorByRef: () => () => ({
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-1"),
    worktreePath: "/repo",
    turnDiffSummaries: [],
  }),
}));

vi.mock("../store", () => ({
  selectProjectByRef: () => ({
    cwd: "/repo",
  }),
  useStore: (selector: (store: Record<string, never>) => unknown) => selector({}),
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    shell: {
      openInEditor: vi.fn(),
    },
  }),
}));

const patch = `diff --git a/a/file.ts b/a/file.ts
index 1111111..2222222 100644
--- a/a/file.ts
+++ b/a/file.ts
@@ -1,4 +1,4 @@
-before
+first edit
 context 1
 context 2
 context 3
@@ -20,4 +20,4 @@
-before 2
+second edit
 context 20
 context 21
 context 22
`;
function snapshot(revision: string, staged = "", unstaged = patch): GitLocalChangesResult {
  const files = (value: string) =>
    value
      ? [
          {
            id: "a".repeat(64),
            hunkCount: [...value.matchAll(/^@@ /gm)].length,
            fileAction: true,
            hunkAction: true,
          },
        ]
      : [];
  return {
    worktreePath: "/repo",
    headOid: "b".repeat(40),
    branch: "refs/heads/main",
    indexIdentity: "index",
    revision,
    staged: { patch: staged, files: files(staged) },
    unstaged: { patch: unstaged, files: files(unstaged) },
  };
}
function App() {
  return (
    <div style={{ height: 750, width: 900, maxWidth: "100%" }}>
      <DiffWorkerPoolProvider>
        <DiffPanel mode="sidebar" />
      </DiffWorkerPoolProvider>
    </div>
  );
}
describe("staged and unstaged review", () => {
  it("reviews both sources, stages a selected hunk, refreshes and shows safe stale failure", async () => {
    await page.viewport(1100, 850);
    fixture.read.mockResolvedValue(snapshot("1".repeat(64)));
    fixture.apply.mockResolvedValue(undefined);
    const screen = await render(<App />);
    await screen.getByRole("button", { name: "Unstaged changes", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Stage file a/file.ts" }))
      .toBeVisible();
    await screen.getByRole("combobox", { name: "Hunk in a/file.ts" }).selectOptions("1");
    fixture.read.mockResolvedValue(
      snapshot("2".repeat(64), patch.split(/(?=^@@ )/m)[0]! + patch.split(/(?=^@@ )/m)[2]!, ""),
    );
    await screen.getByRole("button", { name: "Stage hunk 2 in a/file.ts" }).click();
    await expect
      .poll(() => fixture.apply.mock.calls[0]?.[0])
      .toEqual({
        cwd: "/repo",
        scope: "unstaged",
        fileId: "a".repeat(64),
        hunkIndex: 1,
        expectedRevision: "1".repeat(64),
      });
    await screen.getByRole("button", { name: "Staged changes", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Unstage file a/file.ts" }))
      .toBeVisible();
    await page.screenshot({ path: "../../output/task07-staged-review.png" });
    fixture.apply.mockRejectedValueOnce(
      new Error("HEAD, branch, index or patch changed. Refresh before staging or unstaging."),
    );
    await screen.getByRole("button", { name: "Unstage file a/file.ts" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(/HEAD, branch, index or patch changed/);
    expect(fixture.apply).toHaveBeenCalledTimes(2);
    fixture.read.mockResolvedValue(snapshot("3".repeat(64), patch, ""));
    await screen.getByRole("button", { name: "Refresh local changes" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Unstage file a/file.ts" }))
      .toBeVisible();
    await page.viewport(720, 850);
    await page.screenshot({ path: "../../output/task07-staged-narrow.png" });
    await screen.unmount();
  });
});
