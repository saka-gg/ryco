// This suite exercises checkpoint review; repository comparison has its own browser coverage.
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
import { useEffect } from "react";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import DiffPanel, { DiffWorkerPoolProvider } from "./DiffPanel";

const fixture = vi.hoisted(() => ({
  patch: "",
  legacy: false,
  selectedFile: null as string | null,
  renders: {} as Record<string, number>,
  mounts: {} as Record<string, number>,
}));
// Baseline uses the former whole-patch React identity with the same real renderer.
vi.mock("../lib/diffRendering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/diffRendering")>();
  return {
    ...actual,
    ActiveDiffParser: class extends actual.ActiveDiffParser {
      override parse(...args: Parameters<InstanceType<typeof actual.ActiveDiffParser>["parse"]>) {
        const result = super.parse(...args);
        if (!fixture.legacy || result?.kind !== "files") return result;
        return {
          ...result,
          files: result.files.map((file, index) =>
            Object.assign({}, file, {
              cacheKey: `${actual.buildPatchCacheKey(args[0] ?? "")}:${index}`,
            }),
          ),
        };
      }
    },
  };
});
const openInPreferredEditor = vi.hoisted(() => vi.fn());
vi.mock("../composerDraftStore", () => import("@ryco/client-runtime/state/composer"));
// Instrument the boundary while retaining the real Pierre renderer and worker pool.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...actual,
    FileDiff: function MeasuredFileDiff(props: React.ComponentProps<typeof actual.FileDiff>) {
      const name = props.fileDiff.name;
      fixture.renders[name] = (fixture.renders[name] ?? 0) + 1;
      useEffect(() => {
        fixture.mounts[name] = (fixture.mounts[name] ?? 0) + 1;
      }, [name]);
      return <actual.FileDiff {...props} />;
    },
  };
});
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

function patchFor(path: string, value = "new", lineCount = 35) {
  const before = Array.from({ length: lineCount }, (_, i) => `-const value${i} = "old";`).join(
    "\n",
  );
  const after = Array.from({ length: lineCount }, (_, i) => `+const value${i} = "${value}";`).join(
    "\n",
  );
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lineCount} +1,${lineCount} @@\n${before}\n${after}\n`;
}
function App() {
  return (
    <div style={{ height: 700, width: 560 }}>
      <DiffWorkerPoolProvider>
        <DiffPanel mode="sidebar" />
      </DiffWorkerPoolProvider>
    </div>
  );
}
function row(path: string) {
  const found = Array.from(document.querySelectorAll<HTMLElement>("[data-diff-file-path]")).find(
    (element) => element.dataset.diffFilePath === path,
  );
  if (!found) throw new Error(`Missing ${path}`);
  return found;
}

describe("real Pierre file identity and panel navigation", () => {
  it("keeps unchanged renderers mounted and synchronizes navigation after scrolling", async () => {
    await page.viewport(1100, 800);
    fixture.selectedFile = "a.ts";
    fixture.patch = patchFor("a.ts") + patchFor("b.ts") + patchFor("c.ts", "new", 1);
    const screen = await render(<App />);
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-diff-file-path]")).toHaveLength(3),
    );
    await vi.waitFor(() => expect(fixture.mounts["b/a.ts"] ?? fixture.mounts["a.ts"]).toBe(1));
    const a = row("a.ts");
    await vi.waitFor(() => {
      const shadow = a.querySelector("diffs-container")?.shadowRoot;
      expect(shadow?.querySelector("[data-line]")).toBeTruthy();
    });
    await page.screenshot({ path: "../../output/task04-panel.png" });
    const b = row("b.ts");
    const aMounts = { ...fixture.mounts };
    const aRenders = { ...fixture.renders };
    const start = performance.now();
    fixture.patch = patchFor("a.ts") + patchFor("b.ts", "edited") + patchFor("c.ts", "new", 1);
    await screen.rerender(<App />);
    await vi.waitFor(() => expect(row("b.ts")).not.toBe(b));
    expect(row("a.ts")).toBe(a);
    const aName = Object.keys(fixture.mounts).find((name) => name.endsWith("a.ts"))!;
    expect(fixture.mounts[aName]).toBe(aMounts[aName]);
    console.info("Per-file update measurement", {
      unchangedRemounts: fixture.mounts[aName]! - aMounts[aName]!,
      unchangedRenders: fixture.renders[aName]! - aRenders[aName]!,
      updateMs: performance.now() - start,
    });

    await page.getByRole("button", { name: "Next changed file", exact: true }).click();
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-diff-active-file]")?.getAttribute("data-diff-active-file"),
      ).toBe("b.ts"),
    );
    const surface = document.querySelector<HTMLElement>(".diff-render-surface")!;
    const scrollTop = surface.scrollTop;
    fixture.patch = patchFor("a.ts") + patchFor("b.ts", "refreshed") + patchFor("c.ts", "new", 1);
    await screen.rerender(<App />);
    expect(Math.abs(surface.scrollTop - scrollTop)).toBeLessThan(2);
    surface.scrollTop = 0;
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-diff-active-file]")?.getAttribute("data-diff-active-file"),
      ).toBe("a.ts"),
    );
    await expect
      .element(page.getByRole("button", { name: "Previous changed file", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Next changed file", exact: true }).click();
    await page.getByRole("button", { name: "Next changed file", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Next changed file", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Previous changed file", exact: true }).click();
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-diff-active-file]")?.getAttribute("data-diff-active-file"),
      ).toBe("b.ts"),
    );
    await page.getByRole("button", { name: "Collapse a.ts", exact: true }).click();
    fixture.patch = patchFor("a.ts") + patchFor("b.ts", "again") + patchFor("c.ts", "new", 1);
    await screen.rerender(<App />);
    await expect
      .element(page.getByRole("button", { name: "Expand a.ts", exact: true }))
      .toBeVisible();
    await page.getByRole("textbox", { name: "Search diff" }).fill("b.ts");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-diff-file-path]")).toHaveLength(1),
    );
    await expect
      .element(page.getByRole("button", { name: "Next changed file", exact: true }))
      .toBeDisabled();
    await page.getByRole("textbox", { name: "Search diff" }).fill("no-such-file");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-diff-file-path]")).toHaveLength(0),
    );
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-diff-file-path]")).toHaveLength(3),
    );
    await page.getByRole("button", { name: "Split diff view", exact: true }).click();
    await page.screenshot({ path: "../../output/task04-panel-split.png" });
    fixture.selectedFile = null;
    await screen.unmount();
  });
  it.each([true, false])("measures 60-file real renderer updates (legacy=%s)", async (legacy) => {
    fixture.legacy = legacy;
    fixture.mounts = {};
    fixture.renders = {};
    const paths = Array.from(
      { length: 60 },
      (_, i) => `${legacy ? "legacy" : "active"}-${String(i).padStart(2, "0")}.ts`,
    );
    fixture.patch = paths.map((path) => patchFor(path)).join("");
    const screen = await render(<App />);
    await vi.waitFor(() => expect(Object.keys(fixture.mounts)).toHaveLength(60));
    const beforeRows = paths.map(row);
    const beforeRenders = Object.values(fixture.renders).reduce((sum, count) => sum + count, 0);
    const started = performance.now();
    fixture.patch = paths.map((path, i) => patchFor(path, i === 30 ? "changed" : "new")).join("");
    await screen.rerender(<App />);
    await vi.waitFor(() => expect(row(paths[30]!)).not.toBe(beforeRows[30]));
    const retained = paths.filter((path, i) => row(path) === beforeRows[i]).length;
    expect(retained).toBe(legacy ? 0 : 59);
    const remounts = Object.values(fixture.mounts).reduce((sum, count) => sum + count - 1, 0);
    expect(remounts).toBe(legacy ? 60 : 1);
    console.log("60-file measurement", {
      legacy,
      retained,
      remounts,
      renders:
        Object.values(fixture.renders).reduce((sum, count) => sum + count, 0) - beforeRenders,
      updateMs: performance.now() - started,
    });
    await screen.unmount();
    fixture.legacy = false;
  });
});
