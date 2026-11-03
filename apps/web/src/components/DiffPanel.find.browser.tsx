// Find in the Diff panel on the real `@pierre/diffs` renderer (worker pool,
// shadow DOM, virtualizer): highlights, reveals and keyboard focus. Only the
// data hooks are fixtures.
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
import { isMacPlatform } from "../lib/utils";
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

/** A long file: one hunk of 60 removed and 60 added lines, taller than the panel. */
function longFilePatch(): string {
  const before = Array.from({ length: 60 }, (_, i) => `-const value${i} = "old";`).join("\n");
  const after = Array.from({ length: 60 }, (_, i) => `+const value${i} = "new";`).join("\n");
  return `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,60 +1,60 @@\n${before}\n${after}\n`;
}

/** Two hunks; the second has two matches of "needle" on new line 201. */
const B_PATCH = [
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,3 +1,3 @@",
  " const top = 1;",
  "-const first = 0;",
  "+const first = 1;",
  " const after = 2;",
  "@@ -200,3 +200,3 @@",
  " const before = 199;",
  "-const other = 0;",
  "+const needle = needle + 1;",
  " const end = 202;",
  "",
].join("\n");

const MATCH = "ryco-diff-search-match";
const CURRENT = "ryco-diff-search-current";

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

function highlightRanges(name: string): Range[] {
  const highlight = CSS.highlights.get(name);
  return highlight ? ([...highlight] as Range[]) : [];
}

function pressFindKey(): KeyboardEvent {
  const mac = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

async function renderPanel() {
  await page.viewport(1100, 800);
  fixture.patch = longFilePatch() + B_PATCH;
  const screen = await render(
    <div style={{ height: 700, width: 900, display: "flex" }}>
      <DiffPanel mode="sidebar" />
    </div>,
  );
  // The highlighter worker answers before pierre draws rows.
  await vi.waitFor(
    () =>
      expect(
        fileElement("src/a.ts")
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector("[data-line]"),
      ).toBeTruthy(),
    { timeout: 15_000 },
  );
  return screen;
}

describe("Diff panel find on the real renderer", () => {
  beforeEach(async () => {
    setAppearancePreference("diffLayout", "stacked");
    applyAppearancePreferencesToDocument();
    await resetAppKeybindings();
  });

  afterEach(() => {
    setAppearancePreference("diffLayout", "stacked");
    applyAppearancePreferencesToDocument();
    document.body.innerHTML = "";
  });

  it("opens a folded file on its match and paints the current match apart", async () => {
    const screen = await renderPanel();
    // Fold the second file (its header renders once it nears the viewport), then go back up.
    fileElement("src/b.ts").scrollIntoView({ block: "start" });
    await page.getByRole("button", { name: "Collapse src/b.ts", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Expand src/b.ts", exact: true }))
      .toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        fileElement("src/b.ts")
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector("[data-line]"),
      ).toBeNull(),
    );

    scroller().scrollTop = 0;
    await page.getByRole("textbox", { name: "Search diff" }).fill("needle");
    await expect.element(page.getByText("1 of 2")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByRole("button", { name: "Collapse src/b.ts", exact: true }))
      .toBeInTheDocument();
    await vi.waitFor(
      () => {
        const row = findDiffLineElement(fileElement("src/b.ts"), "additions", 201);
        expect(row).toBeTruthy();
        const rowRect = row!.getBoundingClientRect();
        const viewport = scroller().getBoundingClientRect();
        expect(rowRect.top).toBeGreaterThanOrEqual(viewport.top);
        expect(rowRect.bottom).toBeLessThanOrEqual(viewport.bottom);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => {
      expect(highlightRanges(CURRENT)).toHaveLength(1);
      expect(highlightRanges(MATCH)).toHaveLength(1);
    });
    const [current] = highlightRanges(CURRENT);
    const [other] = highlightRanges(MATCH);
    expect(current!.toString()).toBe("needle");
    expect(other!.toString()).toBe("needle");
    // The first "needle" on the row is current: it starts before the other.
    expect(current!.compareBoundaryPoints(Range.START_TO_START, other!)).toBe(-1);

    // The next match on the same row becomes current.
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("2 of 2")).toBeInTheDocument();
    await vi.waitFor(() => {
      const [next] = highlightRanges(CURRENT);
      expect(next).toBeTruthy();
      const [rest] = highlightRanges(MATCH);
      expect(rest!.compareBoundaryPoints(Range.START_TO_START, next!)).toBe(-1);
    });

    // Clearing the search removes both highlights.
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await vi.waitFor(() => {
      expect(CSS.highlights.has(CURRENT)).toBe(false);
      expect(CSS.highlights.has(MATCH)).toBe(false);
    });
    await screen.unmount();
  });

  it("maps matches to split rows", async () => {
    const screen = await renderPanel();
    await page.getByRole("button", { name: "Split diff view", exact: true }).click();
    await page.getByRole("textbox", { name: "Search diff" }).fill("value7 =");
    // value7 is on a removed and an added line: one match per column.
    await expect.element(page.getByText("1 of 2")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      expect(highlightRanges(CURRENT)).toHaveLength(1);
      expect(highlightRanges(MATCH)).toHaveLength(1);
    });
    const columnOf = (range: Range) => {
      const node = range.startContainer.parentElement;
      return node?.closest("code[data-deletions]")
        ? "deletions"
        : node?.closest("code[data-additions]")
          ? "additions"
          : null;
    };
    expect(columnOf(highlightRanges(CURRENT)[0]!)).toBe("deletions");
    expect(columnOf(highlightRanges(MATCH)[0]!)).toBe("additions");
    expect(highlightRanges(CURRENT)[0]!.toString()).toBe("value7 =");
    await screen.unmount();
  });

  it("seeds the search from text selected on a diff row", async () => {
    const screen = await renderPanel();
    const row = findDiffLineElement(fileElement("src/a.ts"), "additions", 3);
    if (!row) throw new Error("Expected a rendered row");
    // The row lives in pierre's shadow root; select "value2" in its text.
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let text: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node as Text).data.includes("value2")) {
        text = node as Text;
        break;
      }
    }
    if (!text) throw new Error("Expected the row text");
    const start = text.data.indexOf("value2");
    scroller().focus();
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "value2".length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    expect(pressFindKey().defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[aria-label="Search diff"]')?.value).toBe(
        "value2",
      ),
    );
    await screen.unmount();
  });

  it("keeps keyboard scrolling and the find key after a click into the diff", async () => {
    const screen = await renderPanel();
    const row = findDiffLineElement(fileElement("src/a.ts"), "additions", 3);
    if (!row) throw new Error("Expected a rendered row");
    await userEvent.click(row);
    expect(document.activeElement).toBe(scroller());
    // No focus ring after a click.
    expect(scroller().matches(":focus-visible")).toBe(false);

    const before = scroller().scrollTop;
    await userEvent.keyboard("{PageDown}");
    await vi.waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(before));

    expect(pressFindKey().defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[aria-label="Search diff"]')),
    );

    // Escape from the field puts focus back on the diff, with a ring a keyboard user can see.
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(scroller()));
    expect(scroller().matches(":focus-visible")).toBe(true);
    await screen.unmount();
  });
});
