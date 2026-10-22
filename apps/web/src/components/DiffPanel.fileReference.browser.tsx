// "Add to chat" from the Review diff gutter. The renderer is a stand-in that
// exposes the gutter `+` callback and renders line annotations in place.
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

import type {
  ComposerContextDelivery,
  ComposerContextItem,
} from "@ryco/client-runtime/state/composer";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { composerContextIntake } from "../composerContextIntake";
import DiffPanel from "./DiffPanel";

vi.mock("../composerDraftStore", () => import("@ryco/client-runtime/state/composer"));

type DiffFileStub = {
  name: string;
  prevName: string;
  cacheKey: string;
  type: string;
  hunks: never[];
  additionLines: string[];
  deletionLines: string[];
};

const harness = vi.hoisted(() => {
  const diffFile = (name: string) => ({
    name,
    prevName: name,
    cacheKey: name,
    type: "change",
    hunks: [] as never[],
    additionLines: ["const alpha = 1;\n", "const beta = 2;\n"],
    deletionLines: ["const oldAlpha = 0;\n"],
  });
  return {
    diffFile,
    // Files come from the patch's `diff --git` headers, one per segment. Each
    // test reviews its own patch text, so no parse is reused across tests.
    patch: "diff --git a/src/app.ts b/src/app.ts",
    threadWorktreePath: "/repo" as string | null,
    project: { cwd: "/repo" } as { cwd: string; repositoryIdentity?: { rootPath: string } },
    reset() {
      this.patch = "diff --git a/src/app.ts b/src/app.ts";
      this.threadWorktreePath = "/repo";
      this.project = { cwd: "/repo" };
    },
  };
});

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: vi.fn(() => [{ files: [harness.diffFile("named-by-the-header")] }]),
}));

vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: (props: { children?: ReactNode }) => <>{props.children}</>,
}));

vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: (props: { children: ReactNode }) => <>{props.children}</>,
  useWorkerPool: () => null,
  Virtualizer: (props: { children: ReactNode; className?: string }) => (
    <div className={props.className}>{props.children}</div>
  ),
  FileDiff: (props: {
    fileDiff: DiffFileStub;
    lineAnnotations?: ReadonlyArray<{ side: string; lineNumber: number }>;
    selectedLines?: { start: number; end: number; side?: string } | null;
    renderAnnotation?: (annotation: { side: string; lineNumber: number }) => ReactNode;
    options: {
      enableGutterUtility?: boolean;
      onGutterUtilityClick?: (range: { start: number; end: number; side?: string }) => void;
    };
  }) => (
    <div
      data-test-selected-lines={
        props.selectedLines ? `${props.selectedLines.start}-${props.selectedLines.end}` : ""
      }
    >
      <div data-title="">{props.fileDiff.name}</div>
      {props.options.enableGutterUtility ? (
        <button
          type="button"
          onClick={() =>
            props.options.onGutterUtilityClick?.({ start: 2, end: 1, side: "additions" })
          }
        >
          Mock gutter add
        </button>
      ) : null}
      {(props.lineAnnotations ?? []).map((annotation) => (
        <div
          key={`${annotation.side}:${annotation.lineNumber}`}
          data-test-annotation-line={annotation.lineNumber}
        >
          {props.renderAnnotation?.(annotation)}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("../editorPreferences", () => ({ openInPreferredEditor: vi.fn() }));

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

vi.mock("~/lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: { isRepo: true } }),
}));

vi.mock("~/rpc/useProvider", () => ({
  useCheckpointDiff: () => ({
    data: { diff: harness.patch },
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
        files: [{ path: "src/app.ts" }],
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
  createThreadSelectorByRef: () => () => ({
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-1"),
    worktreePath: harness.threadWorktreePath,
    turnDiffSummaries: [],
  }),
}));

vi.mock("../store", () => ({
  selectProjectByRef: () => harness.project,
  useStore: (selector: (store: Record<string, never>) => unknown) => selector({}),
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ shell: { openInEditor: vi.fn() } }),
}));

const THREAD = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-1"),
};

describe("DiffPanel add to chat", () => {
  const releases: Array<() => void> = [];
  afterEach(() => {
    for (const release of releases.splice(0)) release();
    harness.reset();
    document.body.innerHTML = "";
  });

  function listen(result: ComposerContextDelivery = "added") {
    const received: ComposerContextItem[] = [];
    releases.push(
      composerContextIntake.register(THREAD, (item) => {
        received.push(item);
        return result;
      }),
    );
    return received;
  }

  it("offers no gutter action while no composer takes context for the thread", async () => {
    const mounted = await render(<DiffPanel mode="inline" />);
    await expect.element(page.getByText("src/app.ts", { exact: true })).toBeInTheDocument();
    expect(page.getByRole("button", { name: "Mock gutter add" }).query()).toBeNull();
    await mounted.unmount();
  });

  it("hands the picked lines and the note to the thread's composer", async () => {
    const received = listen();
    const mounted = await render(<DiffPanel mode="inline" />);

    await page.getByRole("button", { name: "Mock gutter add" }).click();
    const note = page.getByRole("textbox", { name: "Note on src/app.ts lines 1-2 (new version)" });
    await expect.element(note).toBeInTheDocument();
    expect(
      document
        .querySelector("[data-test-selected-lines]")
        ?.getAttribute("data-test-selected-lines"),
    ).toBe("1-2");
    expect(
      document
        .querySelector("[data-test-annotation-line]")
        ?.getAttribute("data-test-annotation-line"),
    ).toBe("2");

    await note.fill("  Why two constants?  ");
    await page.getByRole("button", { name: /Add to chat/u }).click();

    expect(received).toEqual([
      {
        kind: "file-reference",
        reference: {
          path: "src/app.ts",
          lineStart: 1,
          lineEnd: 2,
          side: "new",
          snippet: "const alpha = 1;\nconst beta = 2;",
          truncated: false,
          comment: "Why two constants?",
        },
      },
    ]);
    await expect.element(note).not.toBeInTheDocument();
    await mounted.unmount();
  });

  it("keeps the pick open when the composer refuses, and Escape drops it", async () => {
    const received = listen("unavailable");
    const mounted = await render(<DiffPanel mode="inline" />);

    await page.getByRole("button", { name: "Mock gutter add" }).click();
    const note = page.getByRole("textbox", { name: /Note on src\/app.ts/u });
    await expect.element(note).toBeInTheDocument();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await expect.element(note).toBeInTheDocument();
    await expect
      .element(page.getByText("The chat can’t take these lines right now."))
      .toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await expect.element(note).not.toBeInTheDocument();
    await mounted.unmount();
  });

  it("says when the message already holds as many references as it carries", async () => {
    listen("full");
    const mounted = await render(<DiffPanel mode="inline" />);

    await page.getByRole("button", { name: "Mock gutter add" }).click();
    const note = page.getByRole("textbox", { name: /Note on src\/app.ts/u });
    await note.fill("One more");
    await page.getByRole("button", { name: /Add to chat/u }).click();
    await expect
      .element(
        page.getByText("This message already has 20 file references. Remove one to add more."),
      )
      .toBeInTheDocument();
    // The note is kept for when a chip has been removed.
    await expect.element(note).toHaveValue("One more");
    await mounted.unmount();
  });

  it("starts a new pick with an empty note", async () => {
    listen();
    harness.patch = "diff --git a/src/app.ts b/src/app.ts\n# fresh note";
    const mounted = await render(<DiffPanel mode="inline" />);

    await page.getByRole("button", { name: "Mock gutter add" }).click();
    const note = page.getByRole("textbox", { name: /Note on src\/app.ts/u });
    await note.fill("Why does this run twice?");
    // A second pick in the same file reuses the annotation slot.
    await page.getByRole("button", { name: "Mock gutter add" }).click();
    await expect.element(note).toHaveValue("");
    await mounted.unmount();
  });

  it("names lines by the thread's folder when the project sits inside its repository", async () => {
    const received = listen();
    harness.threadWorktreePath = null;
    harness.project = { cwd: "/repo/packages/app", repositoryIdentity: { rootPath: "/repo" } };
    harness.patch = [
      "diff --git a/packages/app/src/app.ts b/packages/app/src/app.ts",
      "diff --git a/README.md b/README.md",
    ].join("\n");
    const mounted = await render(<DiffPanel mode="inline" />);

    await expect.element(page.getByText("README.md", { exact: true })).toBeInTheDocument();
    // README.md lies outside the project folder: only the app file offers the `+`.
    expect(page.getByRole("button", { name: "Mock gutter add" }).elements()).toHaveLength(1);
    await page.getByRole("button", { name: "Mock gutter add" }).click();
    await page
      .getByRole("textbox", { name: "Note on src/app.ts lines 1-2 (new version)" })
      .fill("Here");
    await page.getByRole("button", { name: /Add to chat/u }).click();
    expect(received.map((item) => item.reference.path)).toEqual(["src/app.ts"]);
    await mounted.unmount();
  });

  it("offers nothing for a file no reference can name", async () => {
    listen();
    // Git quotes a path with a tab in it; decoded, no reference can carry it.
    harness.patch = 'diff --git "a/src/bad\\tname.ts" "b/src/bad\\tname.ts"';
    const mounted = await render(<DiffPanel mode="inline" />);
    await vi.waitFor(() => expect(document.querySelectorAll("[data-title]")).toHaveLength(1));
    expect(document.querySelector("[data-title]")?.textContent).toBe("src/bad\tname.ts");
    expect(page.getByRole("button", { name: "Mock gutter add" }).query()).toBeNull();
    await mounted.unmount();
  });

  it("does not offer the action on the phone presentation", async () => {
    listen();
    const mounted = await render(<DiffPanel mode="phone" />);
    await expect.element(page.getByText("src/app.ts", { exact: true })).toBeInTheDocument();
    expect(page.getByRole("button", { name: "Mock gutter add" }).query()).toBeNull();
    await mounted.unmount();
  });
});
