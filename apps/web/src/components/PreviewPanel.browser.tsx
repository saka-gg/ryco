import { recordWsConnectionOpened } from "@ryco/client-runtime/rpc";
import { resetPreviewFileSessionsForTests } from "./previewFileSessions";
import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { ComponentProps, ReactNode } from "react";
import type { ComposerContextItem } from "@ryco/client-runtime/state/composer";

import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { resetProjectPreviewAtomsForTests } from "../rpc/projectPreviewAtoms";
import { composerContextIntake } from "../composerContextIntake";
import { readWorkspaceFileDragSource, WORKSPACE_FILE_DRAG_TYPE } from "../workspaceFileDrag";
import PreviewPanel from "./PreviewPanel";

type PreviewWriteFileInput = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly expectedVersion?: string;
  readonly encoding?: "utf8" | "utf8-bom";
  readonly lineEnding?: "lf" | "crlf" | "cr" | "mixed";
};

const previewHarness = vi.hoisted(() => {
  type Entry = {
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly sizeBytes?: number;
    readonly mimeType?: string;
  };
  type ReadFileResult = {
    readonly relativePath: string;
    readonly contents?: string;
    readonly version?: string;
    readonly encoding?: "utf8" | "utf8-bom";
    readonly lineEnding?: "lf" | "crlf" | "cr" | "mixed";
  };
  type DraftThreadStub = {
    readonly threadId: string;
    readonly environmentId: string;
    readonly projectId: string;
    readonly worktreePath: string | null;
  };
  type Params = {
    readonly environmentId?: string;
    readonly threadId?: string;
    readonly draftId?: string;
  };

  type BinaryFileResult = {
    readonly relativePath: string;
    readonly dataBase64: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  };

  return {
    entries: [] as Entry[],
    readFiles: new Map<string, ReadFileResult>(),
    binaryFiles: new Map<string, BinaryFileResult>(),
    readFailures: new Map<string, string>(),
    readAttempts: [] as string[],
    binaryReadAttempts: [] as string[],
    writeAttempts: [] as PreviewWriteFileInput[],
    writeFailure: null as { readonly reason: string; readonly message: string } | null,
    savedVersion: 0,
    serverThreadEnabled: true,
    /** Server threads' worktrees by thread id; a thread without one works in the project. */
    worktreePaths: {} as Record<string, string>,
    draftThread: null as DraftThreadStub | null,
    routeParams: { environmentId: "environment-local", threadId: "thread-1" } as Params,
    reset() {
      this.worktreePaths = {};
      this.entries = [];
      this.readFiles = new Map();
      this.binaryFiles = new Map();
      this.readFailures = new Map();
      this.readAttempts = [];
      this.binaryReadAttempts = [];
      this.writeAttempts = [];
      this.writeFailure = null;
      this.savedVersion = 0;
      this.serverThreadEnabled = true;
      this.draftThread = null;
      this.routeParams = { environmentId: "environment-local", threadId: "thread-1" };
    },
  };
});

vi.mock("@pierre/diffs/react", () => ({
  EditProvider: (props: { children: ReactNode }) => props.children,
  Virtualizer: (props: { children: ReactNode }) => <div>{props.children}</div>,
  // Stands in for the renderer: the gutter `+` callback, line annotations and
  // the highlighted lines are exposed so the panel's wiring can be driven.
  File: (props: {
    edit?: boolean;
    file: { contents: string; name: string };
    onEditChange?: (event: { file: { contents: string; name: string } }) => void;
    options?: {
      enableGutterUtility?: boolean;
      onGutterUtilityClick?: (range: { start: number; end: number }) => void;
    };
    lineAnnotations?: ReadonlyArray<{ lineNumber: number }>;
    renderAnnotation?: (annotation: { lineNumber: number }) => ReactNode;
    selectedLines?: { start: number; end: number } | null;
  }) => (
    <div
      data-test-selected-lines={
        props.selectedLines ? `${props.selectedLines.start}-${props.selectedLines.end}` : ""
      }
    >
      {props.edit ? (
        <textarea
          aria-label={`Edit ${props.file.name}`}
          value={props.file.contents}
          onChange={(event) =>
            props.onEditChange?.({
              file: { ...props.file, contents: event.currentTarget.value },
            })
          }
        />
      ) : (
        <pre>
          <code>{props.file.contents}</code>
        </pre>
      )}
      {props.options?.enableGutterUtility ? (
        <button
          type="button"
          onClick={() => props.options?.onGutterUtilityClick?.({ start: 3, end: 2 })}
        >
          Mock gutter add
        </button>
      ) : null}
      {(props.lineAnnotations ?? []).map((annotation) => (
        <div key={annotation.lineNumber} data-test-annotation-line={annotation.lineNumber}>
          {props.renderAnnotation?.(annotation)}
        </div>
      ))}
    </div>
  ),
}));

// The shared highlight pool spawns real workers; these tests render plain output.
vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: (props: { children?: ReactNode }) => <>{props.children}</>,
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: vi.fn((options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = previewHarness.routeParams;
    return options?.select ? options.select(params) : params;
  }),
  useSearch: vi.fn((options?: { select?: (search: Record<string, string>) => unknown }) => {
    const search = { preview: "1" };
    return options?.select ? options.select(search) : search;
  }),
  useBlocker: vi.fn(() => ({
    status: "idle",
    current: undefined,
    next: undefined,
    action: undefined,
    proceed: undefined,
    reset: undefined,
  })),
}));

vi.mock("../hostedHub/hostedConnectionCoordinator", () => ({
  readHostedNodeMutationLease: () => null,
}));

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: () => ({
    projects: {
      listEntries: vi.fn().mockImplementation(() =>
        Promise.resolve({
          entries: previewHarness.entries,
          truncated: false,
        }),
      ),
      readFile: vi.fn().mockImplementation(({ relativePath }: { relativePath: string }) => {
        previewHarness.readAttempts.push(relativePath);
        const failure = previewHarness.readFailures.get(relativePath);
        if (failure) {
          return Promise.reject(new Error(failure));
        }
        const result = previewHarness.readFiles.get(relativePath);
        if (!result) {
          return Promise.reject(new Error("ENOENT: no such file"));
        }
        return Promise.resolve({
          version: `sha256:${relativePath}:initial`,
          encoding: "utf8",
          lineEnding: "lf",
          ...result,
        });
      }),
      readFileBinary: vi.fn().mockImplementation(({ relativePath }: { relativePath: string }) => {
        previewHarness.binaryReadAttempts.push(relativePath);
        const result = previewHarness.binaryFiles.get(relativePath);
        return result
          ? Promise.resolve(result)
          : Promise.reject(new Error("Not a supported image."));
      }),
      writeFile: vi.fn().mockImplementation((input: PreviewWriteFileInput) => {
        previewHarness.writeAttempts.push(input);
        if (previewHarness.writeFailure) return Promise.reject(previewHarness.writeFailure);
        const version = `sha256:saved:${++previewHarness.savedVersion}`;
        const existing = previewHarness.readFiles.get(input.relativePath);
        previewHarness.readFiles.set(input.relativePath, {
          ...existing,
          relativePath: input.relativePath,
          contents: input.contents,
          version,
          encoding: input.encoding ?? "utf8",
          lineEnding: input.lineEnding ?? "lf",
        });
        return Promise.resolve({ relativePath: input.relativePath, version });
      }),
      stageFileReference: vi.fn(),
    },
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
    timestampFormat: "locale",
  }),
}));

vi.mock("../storeSelectors", () => ({
  createThreadSelectorByRef: (ref: { threadId: string } | null) => () =>
    previewHarness.serverThreadEnabled
      ? {
          id: ThreadId.make(ref?.threadId ?? "thread-1"),
          environmentId: EnvironmentId.make("environment-local"),
          projectId: ProjectId.make("project-1"),
          worktreePath: previewHarness.worktreePaths[ref?.threadId ?? "thread-1"] ?? null,
          turnDiffSummaries: [],
        }
      : undefined,
}));

vi.mock("../store", () => ({
  selectProjectByRef: () => ({
    cwd: "/repo",
  }),
  useStore: (selector: (store: Record<string, never>) => unknown) => selector({}),
}));

vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: (
    selector: (store: {
      getDraftSession: (id: string) => unknown;
      getDraftThreadByRef: (ref: { environmentId: string; threadId: string }) => unknown;
    }) => unknown,
  ) =>
    selector({
      getDraftSession: () => previewHarness.draftThread,
      getDraftThreadByRef: () => previewHarness.draftThread,
    }),
}));

vi.mock("./chat/ChangedFilesTree", () => ({
  ChangedFilesTree: (props: {
    files: readonly { readonly path: string }[];
    onSelectFile: (path: string) => void;
    onFileDragStart?: (path: string, transfer: DataTransfer) => void;
  }) => (
    <div>
      {props.files.map((file) => (
        <button
          key={file.path}
          type="button"
          draggable={props.onFileDragStart ? true : undefined}
          onDragStart={(event) => props.onFileDragStart?.(file.path, event.dataTransfer)}
          onClick={() => props.onSelectFile(file.path)}
        >
          {file.path}
        </button>
      ))}
    </div>
  ),
}));

function renderPreviewPanel(props: Partial<ComponentProps<typeof PreviewPanel>> = {}) {
  return render(
    <AppAtomRegistryProvider>
      <PreviewPanel mode="sheet" {...props} />
    </AppAtomRegistryProvider>,
  );
}

async function waitForLayout(): Promise<void> {
  for (let frame = 0; frame < 3; frame++) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

const PREVIEW_THREAD = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-1"),
};

describe("PreviewPanel", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(() => {
    resetPreviewFileSessionsForTests();
    previewHarness.reset();
    resetAppAtomRegistryForTests();
    resetProjectPreviewAtomsForTests();
    recordWsConnectionOpened({ environmentId: EnvironmentId.make("environment-local") });
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
    resetPreviewFileSessionsForTests();
    previewHarness.reset();
    resetAppAtomRegistryForTests();
    resetProjectPreviewAtomsForTests();
    recordWsConnectionOpened({ environmentId: EnvironmentId.make("environment-local") });
  });

  it("opens a deep-linked file once and marks its line", async () => {
    previewHarness.entries = [
      { path: "src/app.ts", kind: "file" },
      { path: "README.md", kind: "file" },
    ];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "one\ntwo\nthree",
    });
    const onRevealHandled = vi.fn();
    const reveal = { path: "src/app.ts", line: 2 };

    mounted = await renderPreviewPanel({ reveal, onRevealHandled });

    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .toHaveValue("one\ntwo\nthree");
    expect(onRevealHandled).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(
        document
          .querySelector("[data-test-selected-lines]")
          ?.getAttribute("data-test-selected-lines"),
      ).toBe("2-2"),
    );

    await mounted.rerender(
      <AppAtomRegistryProvider>
        <PreviewPanel mode="sheet" reveal={reveal} onRevealHandled={onRevealHandled} />
      </AppAtomRegistryProvider>,
    );
    expect(onRevealHandled).toHaveBeenCalledTimes(1);
  });

  it("drops a deep link's line when its file is left or never opened", async () => {
    previewHarness.entries = [
      { path: "src/app.ts", kind: "file" },
      { path: "README.md", kind: "file" },
    ];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "one\ntwo\nthree",
    });
    previewHarness.readFiles.set("README.md", { relativePath: "README.md", contents: "# Ryco" });
    const selectedLines = () =>
      document
        .querySelector("[data-test-selected-lines]")
        ?.getAttribute("data-test-selected-lines");
    const panel = (reveal: ComponentProps<typeof PreviewPanel>["reveal"]) => (
      <AppAtomRegistryProvider>
        <PreviewPanel mode="sheet" reveal={reveal} onRevealHandled={() => undefined} />
      </AppAtomRegistryProvider>
    );

    mounted = await renderPreviewPanel({ reveal: { path: "src/app.ts", line: 2 } });
    await vi.waitFor(() => expect(selectedLines()).toBe("2-2"));
    // Leaving the file drops the mark; coming back does not bring it back.
    await page.getByRole("button", { name: "README.md" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit README.md" }))
      .toHaveValue("# Ryco");
    await page.getByRole("button", { name: "src/app.ts" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .toHaveValue("one\ntwo\nthree");
    expect(selectedLines()).toBe("");

    // A link whose file the unsaved-draft prompt kept from opening leaves nothing armed.
    await page.getByRole("button", { name: "README.md" }).click();
    await page.getByRole("textbox", { name: "Edit README.md" }).fill("# Draft");
    previewHarness.writeFailure = { reason: "conflict", message: "External edit" };
    await mounted.rerender(panel({ path: "src/app.ts", line: 3 }));
    await expect
      .element(page.getByRole("heading", { name: "Save changes before continuing?" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit README.md" }))
      .toHaveValue("# Draft");
    await page.getByRole("button", { name: "src/app.ts" }).click();
    await page.getByRole("button", { name: "Discard & Open" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .toHaveValue("one\ntwo\nthree");
    expect(selectedLines()).toBe("");
  });

  it("shows a folder link in the tree instead of reading it", async () => {
    previewHarness.entries = [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file" },
      { path: "README.md", kind: "file" },
    ];
    mounted = await renderPreviewPanel();
    await expect.element(page.getByRole("button", { name: "README.md" })).toBeInTheDocument();
    await mounted.rerender(
      <AppAtomRegistryProvider>
        <PreviewPanel mode="sheet" reveal={{ path: "src" }} onRevealHandled={() => undefined} />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByPlaceholder("Filter files...")).toHaveValue("src");
    await expect.element(page.getByRole("button", { name: "README.md" })).not.toBeInTheDocument();
    expect(previewHarness.readAttempts).not.toContain("src");
    await expect.element(page.getByText("Open file")).toBeInTheDocument();
  });

  it("opens a linked file the listing leaves out, and lets the read decide it is gone", async () => {
    // The listing skips ignored folders, gitignored files and entries past its cap.
    previewHarness.entries = [{ path: "README.md", kind: "file" }];
    previewHarness.readFiles.set("node_modules/effect/Effect.js", {
      relativePath: "node_modules/effect/Effect.js",
      contents: "one\ntwo\nthree",
    });
    const panel = (reveal: ComponentProps<typeof PreviewPanel>["reveal"]) => (
      <AppAtomRegistryProvider>
        <PreviewPanel mode="sheet" reveal={reveal} onRevealHandled={() => undefined} />
      </AppAtomRegistryProvider>
    );

    mounted = await renderPreviewPanel({
      reveal: { path: "node_modules/effect/Effect.js", line: 2 },
    });
    await expect.element(page.getByRole("button", { name: "README.md" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Edit node_modules/effect/Effect.js" }))
      .toHaveValue("one\ntwo\nthree");
    await waitForLayout();
    // Still open once the listing that lacks it has loaded, with its line marked.
    await expect
      .element(page.getByRole("textbox", { name: "Edit node_modules/effect/Effect.js" }))
      .toBeInTheDocument();
    expect(
      document
        .querySelector("[data-test-selected-lines]")
        ?.getAttribute("data-test-selected-lines"),
    ).toBe("2-2");

    // A link to a file that does not exist ends on the tree once the read says so.
    await mounted.rerender(panel({ path: "src/gone.ts", line: 1 }));
    await vi.waitFor(() => expect(previewHarness.readAttempts).toContain("src/gone.ts"));
    await expect.element(page.getByText("Open file")).toBeInTheDocument();
  });

  it("opens a link in the thread it switched to, even at the path the last thread had open", async () => {
    previewHarness.entries = [{ path: "src/a.ts", kind: "file" }];
    previewHarness.readFiles.set("src/a.ts", { relativePath: "src/a.ts", contents: "one\ntwo" });
    previewHarness.worktreePaths = { "thread-2": "/worktrees/thread-2" };
    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/a.ts" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/a.ts" }))
      .toHaveValue("one\ntwo");

    // A link in another split pane routes that pane's thread and opens the file in one go.
    previewHarness.routeParams = { environmentId: "environment-local", threadId: "thread-2" };
    await mounted.rerender(
      <AppAtomRegistryProvider>
        <PreviewPanel
          mode="sheet"
          reveal={{ path: "src/a.ts", line: 2 }}
          onRevealHandled={() => undefined}
        />
      </AppAtomRegistryProvider>,
    );

    await expect
      .element(page.getByRole("textbox", { name: "Edit src/a.ts" }))
      .toHaveValue("one\ntwo");
    await vi.waitFor(() =>
      expect(
        document
          .querySelector("[data-test-selected-lines]")
          ?.getAttribute("data-test-selected-lines"),
      ).toBe("2-2"),
    );
  });

  it("starts a new pick with an empty note", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file" }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "one\ntwo\nthree",
    });
    const release = composerContextIntake.register(PREVIEW_THREAD, () => "added");
    try {
      mounted = await renderPreviewPanel();
      await page.getByRole("button", { name: "src/app.ts" }).click();
      await page.getByRole("button", { name: "Mock gutter add" }).click();
      const note = page.getByRole("textbox", { name: "Note on src/app.ts lines 2-3" });
      await note.fill("Why does this run twice?");
      await page.getByRole("button", { name: "Mock gutter add" }).click();
      await expect.element(note).toHaveValue("");
    } finally {
      release();
    }
  });

  it("adds picked lines, unsaved edits included, to the thread's composer", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file" }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "one\ntwo\nthree",
    });
    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();
    const editor = page.getByRole("textbox", { name: "Edit src/app.ts" });
    await expect.element(editor).toHaveValue("one\ntwo\nthree");
    // No composer takes context yet: nothing is offered.
    expect(page.getByRole("button", { name: "Mock gutter add" }).query()).toBeNull();

    const received: ComposerContextItem[] = [];
    const release = composerContextIntake.register(PREVIEW_THREAD, (item) => {
      received.push(item);
      return "added";
    });
    try {
      await editor.fill("one\nTWO\nTHREE");
      await page.getByRole("button", { name: "Mock gutter add" }).click();
      const note = page.getByRole("textbox", { name: "Note on src/app.ts lines 2-3" });
      await expect.element(note).toBeInTheDocument();
      expect(
        document
          .querySelector("[data-test-selected-lines]")
          ?.getAttribute("data-test-selected-lines"),
      ).toBe("2-3");
      await note.fill("Uppercase?");
      await page.getByRole("button", { name: /Add to chat/u }).click();

      expect(received).toEqual([
        {
          kind: "file-reference",
          reference: {
            path: "src/app.ts",
            lineStart: 2,
            lineEnd: 3,
            snippet: "TWO\nTHREE",
            truncated: false,
            comment: "Uppercase?",
          },
        },
      ]);
      await expect.element(note).not.toBeInTheDocument();
    } finally {
      release();
    }
  });

  it("drags tree files as workspace files of the thread's workspace", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file" }];
    mounted = await renderPreviewPanel();
    const row = page.getByRole("button", { name: "src/app.ts" });
    await expect.element(row).toHaveAttribute("draggable", "true");

    const transfer = new DataTransfer();
    row
      .element()
      .dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
    expect(JSON.parse(transfer.getData(WORKSPACE_FILE_DRAG_TYPE))).toEqual({
      environmentId: "environment-local",
      workspaceRoot: "/repo",
      path: "src/app.ts",
    });
    expect(transfer.getData("text/plain")).toBe("src/app.ts");
    // A real transfer carries the drag's id among its types.
    expect(readWorkspaceFileDragSource(transfer)).toMatchObject({ path: "src/app.ts" });
    expect(readWorkspaceFileDragSource(new DataTransfer())).toBeNull();
  });

  it("places the workspace tree on the right and filters visible files", async () => {
    previewHarness.entries = [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file", sizeBytes: 64 },
      { path: "README.md", kind: "file", sizeBytes: 64 },
    ];

    mounted = await renderPreviewPanel();

    const contentPanel = document.querySelector("[data-preview-content-panel]");
    const fileRail = document.querySelector("[data-preview-file-rail]");
    expect(contentPanel).not.toBeNull();
    expect(fileRail).not.toBeNull();
    expect(
      contentPanel!.compareDocumentPosition(fileRail!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await expect.element(page.getByText("Open file")).toBeInTheDocument();
    await page.getByPlaceholder("Filter files...").fill("readme");

    await expect.element(page.getByRole("button", { name: "README.md" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "src/app.ts" })).not.toBeInTheDocument();
  });

  it("hides and restores the workspace tree with a smooth rail collapse", async () => {
    previewHarness.entries = [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file", sizeBytes: 64 },
    ];

    mounted = await renderPreviewPanel();

    const fileRail = document.querySelector<HTMLElement>("[data-preview-file-rail]");
    expect(fileRail).not.toBeNull();
    expect(fileRail!.getBoundingClientRect().width).toBeGreaterThan(100);

    await page.getByRole("button", { name: "Hide workspace tree" }).click();

    await expect
      .element(page.getByRole("button", { name: "Show workspace tree" }))
      .toBeInTheDocument();
    expect(fileRail!.getAttribute("aria-hidden")).toBe("true");
    await vi.waitFor(() => {
      expect(fileRail!.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    });

    await page.getByRole("button", { name: "Show workspace tree" }).click();

    await expect
      .element(page.getByRole("button", { name: "Hide workspace tree" }))
      .toBeInTheDocument();
    expect(fileRail!.getAttribute("aria-hidden")).toBeNull();
    await vi.waitFor(() => {
      expect(fileRail!.getBoundingClientRect().width).toBeGreaterThan(100);
    });
  });

  it("renders raster image previews from the binary read without a text read", async () => {
    previewHarness.entries = [{ path: "assets/logo.png", kind: "file" }];
    previewHarness.binaryFiles.set("assets/logo.png", {
      relativePath: "assets/logo.png",
      dataBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      mimeType: "image/png",
      sizeBytes: 70,
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "assets/logo.png" }).click();

    const image = page.getByRole("img", { name: "assets/logo.png" });
    await expect.element(image).toBeInTheDocument();
    await expect.element(image).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    await vi.waitFor(() => {
      expect((image.element() as HTMLImageElement).naturalWidth).toBe(1);
    });
    expect(previewHarness.binaryReadAttempts).toEqual(["assets/logo.png"]);
    expect(previewHarness.readAttempts).not.toContain("assets/logo.png");
  });

  it("refuses binary reads that report a scriptable type", async () => {
    previewHarness.entries = [{ path: "assets/logo.png", kind: "file" }];
    previewHarness.binaryFiles.set("assets/logo.png", {
      relativePath: "assets/logo.png",
      dataBase64: btoa("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
      mimeType: "image/svg+xml",
      sizeBytes: 72,
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "assets/logo.png" }).click();

    await expect.element(page.getByText("Not a supported image.")).toBeInTheDocument();
    await expect
      .element(page.getByRole("img", { name: "assets/logo.png" }))
      .not.toBeInTheDocument();
  });

  it("renders SVG previews from the text read", async () => {
    previewHarness.entries = [{ path: "assets/icon.svg", kind: "file" }];
    previewHarness.readFiles.set("assets/icon.svg", {
      relativePath: "assets/icon.svg",
      contents:
        '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3"/></svg>',
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "assets/icon.svg" }).click();

    const image = page.getByRole("img", { name: "assets/icon.svg" });
    // A data: URL, never a same-origin blob: one that could run the SVG's scripts.
    await expect
      .element(image)
      .toHaveAttribute("src", expect.stringMatching(/^data:image\/svg\+xml;/));
    await vi.waitFor(() => {
      expect((image.element() as HTMLImageElement).naturalHeight).toBe(3);
    });
    expect(previewHarness.binaryReadAttempts).toEqual([]);
  });

  it("renders text previews through syntax-highlighted output", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file", sizeBytes: 64 }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 42;",
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();

    await expect.element(page.getByText("const answer = 42;")).toBeInTheDocument();
  });

  it("edits and explicitly saves a text file with its read version and format", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file", sizeBytes: 64 }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 41;",
      version: "sha256:opened",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();
    const editor = page.getByRole("textbox", { name: "Edit src/app.ts" });
    await editor.fill("const answer = 42;");

    await expect.element(page.getByLabelText("Unsaved changes")).toBeInTheDocument();
    const saveShortcut = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(window.dispatchEvent(saveShortcut)).toBe(false);

    await vi.waitFor(() => expect(previewHarness.writeAttempts).toHaveLength(1));
    expect(previewHarness.writeAttempts[0]).toMatchObject({
      cwd: "/repo",
      relativePath: "src/app.ts",
      contents: "const answer = 42;",
      expectedVersion: "sha256:opened",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
    await expect.element(page.getByLabelText("Unsaved changes")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Save file" })).toBeDisabled();
  });

  it("guards file switching with cancel and discard choices", async () => {
    previewHarness.entries = [
      { path: "src/app.ts", kind: "file", sizeBytes: 64 },
      { path: "README.md", kind: "file", sizeBytes: 64 },
    ];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 41;",
    });
    previewHarness.readFiles.set("README.md", {
      relativePath: "README.md",
      contents: "# Ryco",
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();
    await page.getByRole("textbox", { name: "Edit src/app.ts" }).fill("const answer = 42;");
    previewHarness.writeFailure = { reason: "conflict", message: "External edit" };
    await page.getByRole("button", { name: "README.md" }).click();

    await expect
      .element(page.getByRole("heading", { name: "Save changes before continuing?" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .toHaveValue("const answer = 42;");

    await page.getByRole("button", { name: "README.md" }).click();
    await page.getByRole("button", { name: "Discard & Open" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit README.md" }))
      .toHaveValue("# Ryco");
    expect(previewHarness.writeAttempts).toHaveLength(1);
  });

  it("autosaves and drains before switching files without a discard dialog", async () => {
    previewHarness.entries = [
      { path: "src/app.ts", kind: "file" },
      { path: "README.md", kind: "file" },
    ];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "original",
    });
    previewHarness.readFiles.set("README.md", { relativePath: "README.md", contents: "readme" });
    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();
    await page.getByRole("textbox", { name: "Edit src/app.ts" }).fill("autosaved");
    await vi.waitFor(() => expect(previewHarness.writeAttempts).toHaveLength(1));
    await page.getByRole("textbox", { name: "Edit src/app.ts" }).fill("drained before switch");
    await page.getByRole("button", { name: "README.md" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit README.md" }))
      .toHaveValue("readme");
    expect(previewHarness.writeAttempts.at(-1)?.contents).toBe("drained before switch");
    await expect
      .element(page.getByRole("heading", { name: "Save changes before continuing?" }))
      .not.toBeInTheDocument();
  });

  it("retains a failed draft across remount and requires confirmation for a guarded overwrite", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file" }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "original",
      version: "v1",
    });
    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();
    previewHarness.writeFailure = { reason: "conflict", message: "External edit" };
    await page.getByRole("textbox", { name: "Edit src/app.ts" }).fill("retained draft");
    await page.getByRole("button", { name: "Save file" }).click();
    await expect
      .element(page.getByText("File changed on disk", { exact: true }))
      .toBeInTheDocument();
    await mounted.unmount?.();
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "external",
      version: "v2",
    });
    mounted = await renderPreviewPanel();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .toHaveValue("retained draft");
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    expect(previewHarness.writeAttempts).toHaveLength(1);
    previewHarness.writeFailure = null;
    await page.getByRole("button", { name: "Confirm overwrite" }).click();
    await vi.waitFor(() => expect(previewHarness.writeAttempts).toHaveLength(2));
    expect(previewHarness.writeAttempts[1]).toMatchObject({
      expectedVersion: "v2",
      contents: "retained draft",
    });
    await expect
      .element(page.getByText("File changed on disk", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("preserves local edits on conflict and reloads the disk version on request", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file", sizeBytes: 64 }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 41;",
      version: "sha256:opened",
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();
    const editor = page.getByRole("textbox", { name: "Edit src/app.ts" });
    await editor.fill("const answer = 42;");
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 99;",
      version: "sha256:external",
    });
    previewHarness.writeFailure = {
      reason: "conflict",
      message: "This file changed on disk after it was opened. Reload it before saving.",
    };

    await page.getByRole("button", { name: "Save file" }).click();
    await expect
      .element(page.getByText("File changed on disk", { exact: true }))
      .toBeInTheDocument();
    await expect.element(editor).toHaveValue("const answer = 42;");
    await expect.element(page.getByRole("button", { name: "Save file" })).toBeDisabled();

    await page.getByRole("button", { name: "Reload" }).click();
    await page.getByRole("button", { name: "Confirm reload" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .toHaveValue("const answer = 99;");
    await expect
      .element(page.getByText("File changed on disk", { exact: true }))
      .not.toBeInTheDocument();

    await page.getByRole("textbox", { name: "Edit src/app.ts" }).fill("const answer = 43;");
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 100;",
      version: "sha256:external-again",
    });
    await page.getByRole("button", { name: "Save file" }).click();
    await expect
      .element(page.getByText("File changed on disk", { exact: true }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Discard file changes" }).click();
    await page.getByRole("button", { name: "Confirm discard" }).click();
    await expect
      .element(
        page.getByText("Draft discarded. Reload to read the current disk contents.", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("File changed on disk", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("keeps mixed-line-ending files read-only", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file", sizeBytes: 64 }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "first\nsecond\n",
      lineEnding: "mixed",
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();

    await expect.element(page.getByText("Read-only · mixed line endings")).toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Edit src/app.ts" }))
      .not.toBeInTheDocument();
  });

  it("shows the server's refusal for files it will not preview", async () => {
    previewHarness.entries = [{ path: "logs/huge.log", kind: "file" }];
    previewHarness.readFailures.set(
      "logs/huge.log",
      "File is too large to preview (600000 bytes). Limit is 524288 bytes.",
    );

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "logs/huge.log" }).click();

    await expect.element(page.getByText(/File is too large to preview/)).toBeInTheDocument();
    expect(previewHarness.readAttempts).toContain("logs/huge.log");
  });

  it("pushes a full-width file view from the tree and returns with back on the phone surface", async () => {
    previewHarness.entries = [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file", sizeBytes: 64 },
    ];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 42;",
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <PreviewPanel mode="phone" />
      </AppAtomRegistryProvider>,
    );

    // Single-pane phone arrangement: the tree renders full-width — no split
    // rail, no tree-visibility toggle, no side-by-side empty state.
    await expect.element(page.getByRole("button", { name: "src/app.ts" })).toBeInTheDocument();
    expect(document.querySelector("[data-preview-file-rail]")).toBeNull();
    expect(document.querySelector('[aria-label="Resize workspace tree"]')).toBeNull();
    expect(document.querySelector('[aria-label="Hide workspace tree"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Open file");

    // Tapping a file pushes the full-width file view with a back affordance.
    await page.getByRole("button", { name: "src/app.ts" }).click();
    await expect.element(page.getByText("const answer = 42;")).toBeInTheDocument();
    const backButton = page.getByRole("button", { name: "Back to workspace tree" });
    await expect.element(backButton).toBeInTheDocument();
    expect(document.querySelector('[aria-label="Filter files"]')).toBeNull();

    // Back returns to the tree.
    await backButton.click();
    await expect.element(page.getByRole("button", { name: "src/app.ts" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("Filter files")).toBeInTheDocument();
  });

  it("defaults preview wrap on for the phone surface and keeps the toggle live", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file", sizeBytes: 64 }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const answer = 42;",
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <PreviewPanel mode="phone" />
      </AppAtomRegistryProvider>,
    );

    // Wrap defaults on for the phone presentation even though the settings
    // mock has diffWordWrap: false (same rationale as the phone diff surface).
    await expect
      .element(page.getByRole("button", { name: "Disable preview line wrapping" }))
      .toBeInTheDocument();

    // The toggle stays user-operable on the phone surface.
    await page.getByRole("button", { name: "Disable preview line wrapping" }).click();
    await expect
      .element(page.getByRole("button", { name: "Enable preview line wrapping" }))
      .toBeInTheDocument();
  });

  it("keeps the settings-driven preview wrap default on desktop presentations", async () => {
    previewHarness.entries = [{ path: "src/app.ts", kind: "file", sizeBytes: 64 }];

    mounted = await renderPreviewPanel();

    // diffWordWrap: false in the settings mock stays authoritative off-phone.
    await expect
      .element(page.getByRole("button", { name: "Enable preview line wrapping" }))
      .toBeInTheDocument();
  });

  it("falls back to the draft store on the draft route URL", async () => {
    previewHarness.serverThreadEnabled = false;
    previewHarness.routeParams = { draftId: "draft-1" };
    previewHarness.draftThread = {
      threadId: "thread-1",
      environmentId: "environment-local",
      projectId: "project-1",
      worktreePath: null,
    };
    previewHarness.entries = [{ path: "src/app.ts", kind: "file", sizeBytes: 64 }];
    previewHarness.readFiles.set("src/app.ts", {
      relativePath: "src/app.ts",
      contents: "const draft = true;",
    });

    mounted = await renderPreviewPanel();
    await page.getByRole("button", { name: "src/app.ts" }).click();

    await expect.element(page.getByText("const draft = true;")).toBeInTheDocument();
  });
});
