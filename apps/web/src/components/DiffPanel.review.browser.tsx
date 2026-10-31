// The Diff panel's review tools on the real `@pierre/diffs` renderer (worker pool, shadow DOM,
// virtualizer): totals, collapse all, the file tree, previous/next hunk with its keys and
// scrollbar markers, and word-level highlighting. Only the data hooks are fixtures.
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
vi.mock("../environmentApi", () => ({ ensureEnvironmentApi: vi.fn() }));
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
import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { resetAppKeybindings } from "../appKeybindings";
import {
  applyAppearancePreferencesToDocument,
  setAppearancePreference,
} from "../themes/appearancePreferences";
import DiffPanel from "./DiffPanel";
import { findDiffLineElement } from "./pullRequests/files/diffReveal";

const fixture = vi.hoisted(() => ({ patch: "", checkpointData: null as { diff: string } | null }));

vi.mock("../composerDraftStore", () => import("@ryco/client-runtime/state/composer"));
vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: vi.fn(),
  // Where a path opens (this machine, over SSH, or not at all) is `editorOpenRoute.test.ts`'s
  // concern; here every path opens on this machine.
  openPathInEditor: vi.fn(async () => "vscode"),
  openPathInEditorWithToast: vi.fn(),
  canOpenInEditor: () => true,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: vi.fn((options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = { environmentId: "environment-local", threadId: "thread-1" };
    return options?.select ? options.select(params) : params;
  }),
  useSearch: vi.fn((options?: { select?: (search: Record<string, string>) => unknown }) => {
    const search = { diff: "1" };
    return options?.select ? options.select(search) : search;
  }),
}));
vi.mock("~/lib/gitStatusState", () => ({ useGitStatus: () => ({ data: { isRepo: true } }) }));
vi.mock("~/rpc/useProvider", () => ({
  useCheckpointDiff: () => ({
    data:
      fixture.checkpointData?.diff === fixture.patch
        ? fixture.checkpointData
        : (fixture.checkpointData = { diff: fixture.patch }),
    error: null,
    isLoading: false,
  }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    diffWordWrap: false,
    diffIgnoreWhitespace: false,
    timestampFormat: "locale",
  }),
}));
vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: [
      {
        turnId: "turn-1",
        checkpointTurnCount: 1,
        completedAt: "2026-05-06T00:00:00.000Z",
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      },
    ],
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
  createThreadStructureSelectorByRef: () => () => ({
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-1"),
    worktreePath: "/repo",
    turnDiffSummaries: [],
  }),
}));
vi.mock("../store", () => ({
  selectProjectByRef: () => ({ cwd: "/repo" }),
  useStore: (selector: (store: Record<string, never>) => unknown) => selector({}),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ shell: { openInEditor: vi.fn() } }),
}));

/**
 * `count` hunks, each changing one word of a line between `context` unchanged lines on both
 * sides, so each hunk is taller than the panel. The changed line of hunk `i` is
 * `1 + i * 1000 + context` on both sides.
 */
function spreadPatch(path: string, count: number, context = 30): string {
  const hunks = Array.from({ length: count }, (_, index) => {
    const start = 1 + index * 1000;
    const around = (side: string) =>
      Array.from({ length: context }, (_, line) => ` const ${side}${index}_${line} = ${line};`);
    return [
      `@@ -${start},${2 * context + 1} +${start},${2 * context + 1} @@`,
      ...around("before"),
      `-const value${index} = "old";`,
      `+const value${index} = "new";`,
      ...around("after"),
    ].join("\n");
  });
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}\n`;
}

/** The changed line of hunk `index` in `spreadPatch`. */
const changedLine = (index: number, context = 30) => 1 + index * 1000 + context;

const NEW_FILE = [
  "diff --git a/docs/added.md b/docs/added.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/added.md",
  "@@ -0,0 +1,2 @@",
  "+# Added",
  "+text",
  "",
].join("\n");

function fileElement(path: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-diff-file-path="${path}"]`);
  if (!element) throw new Error(`Missing ${path}`);
  return element;
}

function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".diff-render-surface");
  if (!element) throw new Error("Missing the diff scroller");
  return element;
}

/** Whether `line` of `path` is drawn inside the scroller's viewport. */
function lineInView(path: string, side: "additions" | "deletions", line: number): boolean {
  const row = findDiffLineElement(fileElement(path), side, line);
  if (!row) return false;
  const rowBox = row.getBoundingClientRect();
  const viewport = scroller().getBoundingClientRect();
  return rowBox.height > 0 && rowBox.top >= viewport.top && rowBox.bottom <= viewport.bottom;
}

async function renderPanel(patch: string) {
  await page.viewport(1100, 800);
  fixture.patch = patch;
  const screen = await render(
    <div style={{ height: 700, width: 900, display: "flex" }}>
      <DiffPanel mode="sidebar" />
    </div>,
  );
  // The highlighter worker answers before pierre draws rows.
  await vi.waitFor(
    () =>
      expect(
        document
          .querySelector("[data-diff-file-index='0'] diffs-container")
          ?.shadowRoot?.querySelector("[data-line]"),
      ).toBeTruthy(),
    { timeout: 15_000 },
  );
  return screen;
}

describe("Diff panel review tools on the real renderer", () => {
  beforeEach(async () => {
    setAppearancePreference("diffLayout", "stacked");
    applyAppearancePreferencesToDocument();
    await resetAppKeybindings();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("highlights the changed words of a visible line pair", async () => {
    const screen = await renderPanel(spreadPatch("src/a.ts", 1, 2));
    await vi.waitFor(
      () => {
        const row = findDiffLineElement(fileElement("src/a.ts"), "additions", changedLine(0, 2));
        expect(row?.querySelector("[data-diff-span]")?.textContent).toContain("new");
      },
      { timeout: 10_000 },
    );
    await screen.unmount();
  });

  it("totals the patch, collapses every file and lists them in a tree that follows the diff", async () => {
    const screen = await renderPanel(
      spreadPatch("src/a.ts", 3) + spreadPatch("src/b.ts", 3) + NEW_FILE,
    );
    const tools = screen.getByRole("toolbar", { name: "Review tools" });
    await vi.waitFor(() =>
      expect(document.querySelector("[data-diff-totals]")?.textContent).toBe("3 files +8/-6"),
    );

    await tools.getByRole("button", { name: "Show file tree" }).click();
    const tree = screen.getByRole("navigation", { name: "Changed files" });
    // Paths sort as the diff lists them: docs/ first.
    await expect
      .element(tree.getByRole("button", { name: "Added added.md" }))
      .toHaveAttribute("aria-current", "true");
    fileElement("src/b.ts").scrollIntoView({ block: "start" });
    await expect
      .element(tree.getByRole("button", { name: "Modified b.ts" }))
      .toHaveAttribute("aria-current", "true");
    await tree.getByRole("button", { name: "Modified a.ts" }).click();
    await vi.waitFor(() =>
      expect(
        Math.abs(
          fileElement("src/a.ts").getBoundingClientRect().top -
            scroller().getBoundingClientRect().top,
        ),
      ).toBeLessThan(4),
    );
    await expect
      .element(tree.getByRole("button", { name: "Modified a.ts" }))
      .toHaveAttribute("aria-current", "true");

    await tools.getByRole("button", { name: "Collapse all files" }).click();
    for (const path of ["src/a.ts", "src/b.ts", "docs/added.md"]) {
      await expect
        .element(screen.getByRole("button", { name: `Expand ${path}`, exact: true }))
        .toBeInTheDocument();
    }
    // Folded files are passed by: no hunk is left to step to.
    await expect.element(tools.getByRole("button", { name: "Next hunk" })).toBeDisabled();
    await tools.getByRole("button", { name: "Expand all files" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Collapse src/a.ts", exact: true }))
      .toBeInTheDocument();
    await screen.unmount();
  });

  it("steps through hunks with the buttons, Alt+Down and Alt+Up, and the scrollbar markers", async () => {
    const screen = await renderPanel(spreadPatch("src/a.ts", 3) + spreadPatch("src/b.ts", 2));
    const tools = screen.getByRole("toolbar", { name: "Review tools" });
    const previous = tools.getByRole("button", { name: "Previous hunk" });
    const next = tools.getByRole("button", { name: "Next hunk" });
    await expect.element(previous).toBeDisabled();
    await expect.element(next).toHaveAttribute("title", expect.stringMatching(/^Next hunk \(/));

    await next.click();
    await vi.waitFor(() => expect(lineInView("src/a.ts", "deletions", changedLine(0))).toBe(true));
    await next.click();
    await vi.waitFor(() => expect(lineInView("src/a.ts", "deletions", changedLine(1))).toBe(true));
    await expect.element(previous).toBeEnabled();

    // The keys work wherever focus is in the diff (here the button just clicked).
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() => expect(lineInView("src/a.ts", "deletions", changedLine(2))).toBe(true));
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() => expect(lineInView("src/b.ts", "deletions", changedLine(0))).toBe(true));
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await vi.waitFor(() => expect(lineInView("src/a.ts", "deletions", changedLine(2))).toBe(true));

    // Scrolled by hand, the next hunk is the first one below the middle of the panel.
    fileElement("src/b.ts").scrollIntoView({ block: "start" });
    await next.click();
    await vi.waitFor(() => expect(lineInView("src/b.ts", "deletions", changedLine(0))).toBe(true));

    // A text field keeps the keys for its caret.
    const top = scroller().scrollTop;
    await screen.getByRole("textbox", { name: "Search diff" }).click();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scroller().scrollTop).toBe(top);

    const markers = screen.getByRole("group", { name: "Hunk markers" });
    await expect.element(markers.getByRole("button").nth(4)).toBeInTheDocument();
    expect(markers.getByRole("button").elements()).toHaveLength(5);
    await markers.getByRole("button", { name: "Changed lines: hunk 2 of 5" }).click();
    await vi.waitFor(() => expect(lineInView("src/a.ts", "deletions", changedLine(1))).toBe(true));
    await screen.unmount();
  });
});
