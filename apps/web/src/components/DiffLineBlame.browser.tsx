// Local staging is covered by DiffPanel.staging.browser; keep this suite's transport isolated.
vi.mock("../rpc/useLocalChanges", () => ({
  useLocalChanges: () => ({
    data: null,
    isLoading: false,
    isApplying: false,
    error: null,
    refresh: vi.fn(),
    apply: vi.fn(),
  }),
}));
import "../index.css";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { StrictMode } from "react";
import { DiffLineBlame } from "./DiffLineBlame";
import { getRenderablePatch } from "../lib/diffParsing";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import DiffPanel, { DiffWorkerPoolProvider } from "./DiffPanel";

const fixture = vi.hoisted(() => ({
  patch: "",
  comparison: null as import("@ryco/contracts").GitReadComparisonResult | null,
  readBlame: vi.fn(),
  selectedFile: null as string | null,
}));
vi.mock("../rpc/useComparison", () => ({
  useComparison: () => ({
    selection: fixture.comparison?.selection ?? null,
    data: fixture.comparison,
    isLoading: false,
    error: null,
    refMoved: false,
    setSelection: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: () => ({ vcs: { readLineBlame: fixture.readBlame } }),
}));
const openInPreferredEditor = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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
      ...(fixture.selectedFile
        ? { diffTurnId: "turn-12", diffFilePath: fixture.selectedFile }
        : {}),
    };
    return options?.select ? options.select(search) : search;
  }),
}));

vi.mock("~/lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: { isRepo: true } }),
}));

vi.mock("~/rpc/useProvider", () => ({
  useCheckpointDiff: () => ({
    data: { diff: fixture.patch },
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

const patch = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const context = 1;\n-const removed = 2;\n+const added = 3;\n const tail = 4;\n`;
const source = {
  repositoryPath: "/repo/.git",
  worktreePath: "/repo",
  revision: "revision-one",
  refOid: "c".repeat(40),
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};
function App() {
  return (
    <div style={{ height: 700, width: 850 }}>
      <DiffWorkerPoolProvider>
        <DiffPanel mode="sidebar" />
      </DiffWorkerPoolProvider>
    </div>
  );
}
function setComparison() {
  fixture.comparison = {
    selection: { mode: "direct", ref: "main" },
    source: { ...source },
    patch: patch("a/file.ts") + patch("b/file.ts") + patch("file.ts"),
  };
  fixture.readBlame.mockReset().mockResolvedValue({
    kind: "committed",
    oid: "c".repeat(40),
    author: "Ada Lovelace",
    summary: "Preserve the original line",
    authorTime: "2026-09-01T12:00:00.000Z",
  });
  fixture.selectedFile = null;
}
describe("real comparison line blame and path identity", () => {
  it("supports keyboard lookup, rejects additions, preserves navigation/editor paths, and dismisses", async () => {
    await page.viewport(1100, 800);
    setComparison();
    const screen = await render(<App />);
    await page.getByRole("button", { name: "Blame line in a/file.ts", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect
      .element(page.getByText("Preserve the original line", { exact: true }))
      .toBeVisible();
    expect(fixture.readBlame).toHaveBeenLastCalledWith({
      cwd: "/repo",
      oid: source.baseOid,
      filePath: "a/file.ts",
      line: 1,
    });
    await page.getByRole("spinbutton", { name: "Line", exact: true }).fill("2");
    await page.getByRole("combobox", { name: "Side", exact: true }).selectOptions("head");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "Choose a displayed context or deleted line. Added lines have no blame here.",
        ),
      )
      .toBeVisible();
    expect(fixture.readBlame).toHaveBeenCalledTimes(1);
    await page.getByRole("spinbutton", { name: "Line", exact: true }).fill("3");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect
      .element(page.getByText("Preserve the original line", { exact: true }))
      .toBeVisible();
    expect(fixture.readBlame).toHaveBeenLastCalledWith({
      cwd: "/repo",
      oid: source.headOid,
      filePath: "a/file.ts",
      line: 3,
    });
    await page.screenshot({ path: "../../output/task06-line-blame.png" });
    await page
      .getByRole("dialog")
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Next changed file", exact: true }).click();
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-diff-active-file]")?.getAttribute("data-diff-active-file"),
      ).toBe("b/file.ts"),
    );
    const b = document.querySelector('[data-diff-file-path="b/file.ts"]');
    await vi.waitFor(() =>
      expect(
        b?.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] "),
      ).toBeTruthy(),
    );
    const shadow = b!.querySelector("diffs-container")!.shadowRoot!;
    const number = shadow.querySelector<HTMLElement>("[data-column-number]");
    if (!number) throw new Error("Missing real line number");
    number.click();
    await vi.waitFor(() => expect(openInPreferredEditor).toHaveBeenCalled());
    expect(JSON.stringify(openInPreferredEditor.mock.calls.at(-1))).toContain("b/file.ts");
    const deletion = shadow.querySelector<HTMLElement>(
      '[data-line-type="change-deletion"][data-line]',
    );
    if (!deletion) throw new Error("Missing real deletion line");
    deletion.click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await vi.waitFor(() =>
      expect(fixture.readBlame).toHaveBeenLastCalledWith({
        cwd: "/repo",
        oid: source.baseOid,
        filePath: "b/file.ts",
        line: 2,
      }),
    );
    await screen.unmount();
  });
  it("drops a pending response when the comparison disconnects and hides checkpoint blame", async () => {
    setComparison();
    let resolve!: (value: unknown) => void;
    fixture.readBlame.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const screen = await render(<App />);
    await page.getByRole("button", { name: "Blame line in a/file.ts", exact: true }).click();
    await expect.element(page.getByText("Loading blame…")).toBeVisible();
    fixture.comparison = null;
    fixture.patch = patch("a/file.ts");
    await screen.rerender(<App />);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    resolve({
      kind: "committed",
      oid: source.baseOid,
      author: "Stale",
      summary: "Stale result",
      authorTime: null,
    });
    await expect.element(page.getByText("Stale result")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Blame line in a/file.ts", exact: true }))
      .not.toBeInTheDocument();
    await screen.unmount();
  });
  it("recovers from failed reads in Strict Mode and fits dark desktop presentation", async () => {
    setComparison();
    document.documentElement.classList.add("dark");
    fixture.readBlame.mockRejectedValueOnce(new Error("offline"));
    const rendered = getRenderablePatch(patch("b/file.ts"));
    if (rendered?.kind !== "files") throw new Error("fixture");
    const screen = await render(
      <StrictMode>
        <DiffLineBlame
          environmentId={EnvironmentId.make("environment-local")}
          source={source}
          file={rendered.files[0]!}
          initialSide="base"
          initialLine={2}
          onClose={vi.fn()}
        />
      </StrictMode>,
    );
    // Strict Mode may cancel the first read; explicitly request a failing read on this mounted view.
    await vi.waitFor(() =>
      expect(
        page
          .getByRole("button", { name: "Look up", exact: true })
          .element()
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fixture.readBlame.mockRejectedValueOnce(new Error("offline"));
    await page.getByRole("spinbutton", { name: "Line", exact: true }).fill("1");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect
      .element(page.getByText("Blame unavailable. Retry or refresh the comparison."))
      .toBeVisible();
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect
      .element(page.getByText("Preserve the original line", { exact: true }))
      .toBeVisible();
    await page.screenshot({ path: "../../output/task06-line-blame-dark.png" });
    const dialog = page.getByRole("dialog").element().getBoundingClientRect();
    expect(dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialog.right).toBeLessThanOrEqual(window.innerWidth);
    await screen.unmount();
    document.documentElement.classList.remove("dark");
  });
});
