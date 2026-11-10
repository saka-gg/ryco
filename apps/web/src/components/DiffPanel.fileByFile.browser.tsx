// A large turn diff read file by file (D6) on the real `@pierre/diffs` renderer:
// the file list comes from the node's file index, each file's patch loads near
// the viewport, and search and previous/next hunk load the files they need.
// The node's answers are fixtures behind the real client stores.
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
vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: () => ({
    orchestration: {
      getFullThreadDiff: node.getFullThreadDiff,
      getTurnDiff: node.getFullThreadDiff,
    },
  }),
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
import { checkpointDiffFilePatches } from "../rpc/checkpointDiffFilePatches";
import DiffPanel from "./DiffPanel";

const FILE_COUNT = 12;
const LINES_PER_FILE = 150;
const node = vi.hoisted(() => {
  const patchOf = (index: number) =>
    [
      `diff --git a/src/f${index}.ts b/src/f${index}.ts`,
      `--- a/src/f${index}.ts`,
      `+++ b/src/f${index}.ts`,
      `@@ -0,0 +1,150 @@`,
      ...Array.from({ length: 150 }, (_, line) =>
        index === 11 && line === 140 ? "+const needle = 11;" : `+const v${line} = ${index};`,
      ),
    ].join("\n");
  const requested: number[] = [];
  const getFullThreadDiff = async (input: {
    readonly fileView?: { readonly kind: string; readonly indices?: ReadonlyArray<number> };
  }) => {
    const commits = { fromCommitOid: "c0", toCommitOid: "c1" };
    if (input.fileView?.kind === "files") {
      requested.push(...(input.fileView.indices ?? []));
      return {
        threadId: "thread-1",
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: "",
        fileView: {
          ...commits,
          patches: (input.fileView.indices ?? []).map((index) => ({
            index,
            patch: patchOf(index),
          })),
        },
      };
    }
    throw new Error("The index comes from useCheckpointDiff in this test.");
  };
  return { patchOf, requested, getFullThreadDiff };
});
const indexData = {
  threadId: "thread-1",
  fromTurnCount: 0,
  toTurnCount: 1,
  diff: "",
  fileView: {
    fromCommitOid: "c0",
    toCommitOid: "c1",
    files: Array.from({ length: 12 }, (_, index) => ({
      index,
      path: `src/f${index}.ts`,
      status: "added",
      additions: 150,
      deletions: 0,
      patchChars: 40_000,
    })),
  },
};

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
  useCheckpointDiff: (input: { readonly fileIndex?: boolean }) => ({
    // Turn summaries without line counts: the panel asks for the file index.
    data: input.fileIndex ? indexData : null,
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
        files: [{ path: "src/f0.ts" }],
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

function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".diff-render-surface");
  if (!element) throw new Error("Missing the diff scroller");
  return element;
}

const pendingCount = () => document.querySelectorAll("[data-diff-file-pending]").length;

async function renderPanel() {
  await page.viewport(1100, 800);
  node.requested.length = 0;
  const screen = await render(
    <div style={{ height: 700, width: 900, display: "flex" }}>
      <DiffPanel mode="sidebar" />
    </div>,
  );
  await vi.waitFor(
    () =>
      expect(
        document
          .querySelector('[data-diff-file-path="src/f0.ts"] diffs-container')
          ?.shadowRoot?.querySelector("[data-line]"),
      ).toBeTruthy(),
    { timeout: 15_000 },
  );
  return screen;
}

describe("Diff panel reading a large diff file by file", () => {
  beforeEach(async () => {
    checkpointDiffFilePatches.clear();
    setAppearancePreference("diffLayout", "stacked");
    applyAppearancePreferencesToDocument();
    await resetAppKeybindings();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lists every file from the index and loads only the ones near the viewport", async () => {
    const screen = await renderPanel();
    expect(document.querySelectorAll("[data-diff-file-path]")).toHaveLength(FILE_COUNT);
    // Totals come from the index, before most files arrive.
    await expect
      .element(page.getByText(`${FILE_COUNT} files`, { exact: false }))
      .toBeInTheDocument();
    expect(new Set(node.requested).size).toBeLessThan(FILE_COUNT);
    expect(pendingCount()).toBeGreaterThan(0);

    // Scrolling to the end loads the files that come near it.
    scroller().scrollTop = scroller().scrollHeight;
    await vi.waitFor(() => expect(node.requested).toContain(FILE_COUNT - 1));
    await screen.unmount();
  });

  it("loads the files a search needs and finds a match in a file not loaded yet", async () => {
    const screen = await renderPanel();
    expect(node.requested).not.toContain(11);
    await page.getByRole("textbox", { name: "Search diff" }).fill("needle");
    await vi.waitFor(() => expect(pendingCount()).toBe(0), { timeout: 10_000 });
    expect(new Set(node.requested).size).toBe(FILE_COUNT);
    await expect.element(page.getByText("1 of 1")).toBeInTheDocument();
    await screen.unmount();
  });

  it("steps to the next hunk across files that were not loaded", async () => {
    const screen = await renderPanel();
    expect(pendingCount()).toBeGreaterThan(0);
    const next = page.getByRole("button", { name: "Next hunk", exact: true });
    await next.click();
    await vi.waitFor(() => expect(pendingCount()).toBe(0), { timeout: 10_000 });
    // Each file is one hunk: the step brings the second file's first row into view.
    const inView = (path: string) => {
      const row = document
        .querySelector(`[data-diff-file-path="${path}"] diffs-container`)
        ?.shadowRoot?.querySelector("[data-line]");
      if (!row) return false;
      const box = row.getBoundingClientRect();
      const viewport = scroller().getBoundingClientRect();
      return box.top >= viewport.top && box.bottom <= viewport.bottom;
    };
    await vi.waitFor(() => expect(inView("src/f1.ts")).toBe(true), { timeout: 10_000 });
    await next.click();
    await vi.waitFor(() => expect(inView("src/f2.ts")).toBe(true), { timeout: 10_000 });
    await screen.unmount();
  });
});
