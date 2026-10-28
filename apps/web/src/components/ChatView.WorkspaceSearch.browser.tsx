import {
  MessageId,
  WS_METHODS,
  type ExecutionEnvironmentCapabilities,
  type ProjectContentMatch,
  type ProjectEntry,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { isMacPlatform } from "../lib/utils";
import { parkPointer } from "../../test/browserPointer";
import type { NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import {
  DEFAULT_VIEWPORT,
  createSnapshotForTargetUser,
  dispatchInputKey,
  mountChatView,
  openCommandPaletteFromTrigger,
  resolveWorkSurfaceRpc,
  setupChatViewBrowserSuite,
  waitForCommandPaletteInput,
  waitForComposerEditor,
  waitForComposerMenuItem,
  waitForElement,
  waitForLayout,
  WIDE_FOOTER_VIEWPORT,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const WORKSPACE_ENTRIES: ProjectEntry[] = [
  { path: "README.md", kind: "file" },
  { path: "src", kind: "directory" },
  { path: "src/wide.ts", kind: "file", parentPath: "src" },
];

const WORKSPACE_LINES: ProjectContentMatch[] = [
  { path: "README.md", lineNumber: 3, preview: "Read the Wide guide.", ranges: [] },
  { path: "src/wide.ts", lineNumber: 2, preview: "export const wide = true;", ranges: [] },
  { path: "src/wide.ts", lineNumber: 7, preview: "  return wide;", ranges: [] },
];

/** Enough lines in three files for the result list to scroll. */
const MANY_LINES: ProjectContentMatch[] = ["src/a.ts", "src/b.ts", "src/c.ts"].flatMap((path) =>
  Array.from({ length: 12 }, (_, index) => ({
    path,
    lineNumber: index + 1,
    preview: `const row${index + 1} = 1;`,
    ranges: [{ start: 6, end: 9 }],
  })),
);

/**
 * Stands in for the node's searches: the entries whose path holds the query,
 * and the lines that hold it, as one page.
 */
function resolveWorkspaceSearchRpc(body: NormalizedWsRpcRequestBody): unknown | undefined {
  if (body._tag === WS_METHODS.projectsSearchEntries) {
    const query = typeof body.query === "string" ? body.query.toLowerCase() : "";
    return {
      entries: WORKSPACE_ENTRIES.filter((entry) => entry.path.toLowerCase().includes(query)),
      truncated: false,
    };
  }
  if (body._tag === WS_METHODS.projectsSearchContent) {
    const fold = (text: string) => (body.caseSensitive === true ? text : text.toLowerCase());
    const query = fold(String(body.query));
    const matches = WORKSPACE_LINES.flatMap((line) => {
      const start = fold(line.preview).indexOf(query);
      return start === -1 ? [] : [{ ...line, ranges: [{ start, end: start + query.length }] }];
    });
    return { matches };
  }
  return resolveWorkSurfaceRpc(body);
}

type FixtureConfigurer = NonNullable<Parameters<typeof mountChatView>[0]["configureFixture"]>;

/** A node that also advertises `capabilities`. */
function withCapabilities(
  capabilities: Partial<ExecutionEnvironmentCapabilities>,
): FixtureConfigurer {
  return (fixture) => {
    fixture.serverConfig = {
      ...fixture.serverConfig,
      environment: {
        ...fixture.serverConfig.environment,
        capabilities: { ...fixture.serverConfig.environment.capabilities, ...capabilities },
      },
    };
  };
}

function contentSearchRequests() {
  return wsRequests.filter((request) => request._tag === WS_METHODS.projectsSearchContent);
}

function snapshot() {
  return createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-user-workspace-search"),
    targetText: "workspace search",
  });
}

function pressModKey(target: EventTarget, key: string, shiftKey = false): KeyboardEvent {
  const useMetaForMod = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function waitForQuickOpenInput(): Promise<HTMLInputElement> {
  await waitForElement(
    () => document.querySelector('[data-testid="quick-open"]'),
    "Quick open should have opened.",
  );
  return waitForCommandPaletteInput("Go to file");
}

async function waitForFindInFilesInput(): Promise<HTMLInputElement> {
  await waitForElement(
    () => document.querySelector('[data-testid="find-in-files"]'),
    "Find in files should have opened.",
  );
  return waitForCommandPaletteInput("Search in Project");
}

describe("ChatView workspace search", () => {
  setupChatViewBrowserSuite();

  it("opens a file picked in quick open in the Files panel", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
    });

    try {
      expect(pressModKey(window, "p").defaultPrevented).toBe(true);
      const input = await waitForQuickOpenInput();
      const quickOpen = page.getByTestId("quick-open");
      // This node does not list the workspace for an empty query.
      await expect.element(quickOpen.getByText("Type to search files.")).toBeInTheDocument();

      await page.getByPlaceholder("Go to file").fill("wid");
      await expect.element(quickOpen.getByRole("option", { name: /wide\.ts/ })).toBeInTheDocument();
      await dispatchInputKey(input, { key: "Enter" });

      // The Files panel loads on demand before it reads the file.
      await vi.waitFor(
        () => {
          expect(useCommandPaletteStore.getState().open).toBe(false);
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.projectsReadFile &&
                request.relativePath === "src/wide.ts",
            ),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );
      expect(mounted.router.state.location.search).toMatchObject({ workspaceTab: "files" });
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the composer's @ menu on its own query after quick open searched another", async () => {
    // Truncated answers: no query is narrowed locally from another's results.
    const files = ["src/pancake.ts", "src/preview.ts", "src/prevState.ts"];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: (body) =>
        body._tag === WS_METHODS.projectsSearchEntries
          ? {
              entries: files
                .filter((path) => path.includes(String(body.query)))
                .map((path) => ({ path, kind: "file", parentPath: "src" })),
              truncated: true,
            }
          : resolveWorkspaceSearchRpc(body),
    });
    const composerMenuItems = () =>
      [...document.querySelectorAll("[data-composer-item-id]")].map((item) =>
        item.getAttribute("data-composer-item-id"),
      );

    try {
      const editor = await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("@pan");
      await waitForComposerMenuItem("path:file:src/pancake.ts");

      // Both pickers search the workspace's one shared scope.
      editor.focus();
      pressModKey(editor, "p");
      const input = await waitForQuickOpenInput();
      await page.getByPlaceholder("Go to file").fill("prev");
      await expect
        .element(page.getByTestId("quick-open").getByRole("option", { name: /preview\.ts/ }))
        .toBeInTheDocument();
      await dispatchInputKey(input, { key: "Escape" });
      await vi.waitFor(() => expect(useCommandPaletteStore.getState().open).toBe(false));
      await waitForLayout();

      // Quick open's answer for "prev" must not stand in for "@pan": Enter
      // would mention a file that does not match it.
      expect(composerMenuItems()).toEqual(["path:file:src/pancake.ts"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts the typed text after the search icon", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
    });

    try {
      pressModKey(window, "p");
      const input = await waitForQuickOpenInput();
      // The autocomplete pads its input for the icon by the input's slot name.
      expect(input.getAttribute("data-slot")).toBe("autocomplete-input");
      const icon = input
        .closest('[data-testid="quick-open"]')!
        .querySelector('[data-slot="autocomplete-start-addon"] svg')!;
      const textStart =
        input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft);
      expect(textStart).toBeGreaterThanOrEqual(icon.getBoundingClientRect().right);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists only files for an empty query on nodes that list the workspace", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
      configureFixture: withCapabilities({ projectSearchEmptyQuery: true }),
    });

    try {
      pressModKey(window, "p");
      await waitForQuickOpenInput();
      const quickOpen = page.getByTestId("quick-open");
      await expect
        .element(quickOpen.getByRole("option", { name: /README\.md/ }))
        .toBeInTheDocument();
      await expect.element(quickOpen.getByRole("option", { name: /wide\.ts/ })).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="quick-open"] [role="option"]')).toHaveLength(
        2,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens from the composer and switches to and from the command list", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
    });

    try {
      const editor = await waitForComposerEditor();
      editor.focus();
      expect(pressModKey(editor, "p").defaultPrevented).toBe(true);
      const input = await waitForQuickOpenInput();

      // The palette key leads back to the command list, whose action returns here.
      pressModKey(input, "k");
      await waitForCommandPaletteInput("Search commands, projects, and threads...");
      expect(document.querySelector('[data-testid="quick-open"]')).toBeNull();
      expect(useCommandPaletteStore.getState()).toMatchObject({
        open: true,
        workspaceSearchMode: null,
      });
      await page.getByTestId("command-palette").getByText("Go to file", { exact: true }).click();
      const reopened = await waitForQuickOpenInput();

      // The same key closes it.
      pressModKey(reopened, "p");
      await vi.waitFor(() => expect(useCommandPaletteStore.getState().open).toBe(false));
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Go to file in the command palette with its shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
    });

    try {
      await openCommandPaletteFromTrigger();
      const shortcut = await waitForElement(
        () =>
          [...document.querySelectorAll('[data-testid="command-palette"] [role="option"]')]
            .find((option) => option.textContent?.startsWith("Go to file"))
            ?.querySelector('[data-slot="command-shortcut"]') ?? null,
        "The palette should offer Go to file with its shortcut.",
      );
      expect(shortcut.textContent).toBe(isMacPlatform(navigator.platform) ? "⌘P" : "Ctrl+P");
      const findShortcut = [
        ...document.querySelectorAll('[data-testid="command-palette"] [role="option"]'),
      ]
        .find((option) => option.textContent?.startsWith("Find in files"))
        ?.querySelector('[data-slot="command-shortcut"]');
      expect(findShortcut?.textContent).toBe(
        isMacPlatform(navigator.platform) ? "⇧⌘F" : "Ctrl+Shift+F",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("finds lines in the workspace and opens one at its line", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
      configureFixture: withCapabilities({ projectContentSearch: true }),
    });
    const navigations: Record<string, unknown>[] = [];
    const unsubscribe = mounted.router.subscribe("onBeforeNavigate", (event) => {
      navigations.push(event.toLocation.search);
    });

    try {
      expect(pressModKey(window, "F", true).defaultPrevented).toBe(true);
      const input = await waitForFindInFilesInput();
      const findInFiles = page.getByTestId("find-in-files");
      await expect
        .element(findInFiles.getByRole("status"))
        .toHaveTextContent("Type to search in files.");

      await page.getByPlaceholder("Search in Project").fill("wide");
      await expect
        .element(findInFiles.getByRole("status"))
        .toHaveTextContent("3 results in 2 files");
      // Grouped by file in the node's order, each line highlighted where it matched.
      expect(
        [...document.querySelectorAll('[data-testid="find-in-files"] [role="option"]')].map(
          (option) => option.getAttribute("aria-label"),
        ),
      ).toEqual([
        "README.md:3, Read the Wide guide.",
        "src/wide.ts:2, export const wide = true;",
        "src/wide.ts:7, return wide;",
      ]);
      expect(
        [
          ...document.querySelectorAll(
            '[data-testid="find-in-files"] mark.thread-message-search-highlight',
          ),
        ].map((mark) => mark.textContent),
      ).toEqual(["Wide", "wide", "wide"]);
      expect(contentSearchRequests().at(-1)).toMatchObject({
        cwd: "/repo/project",
        query: "wide",
        limit: 200,
      });
      expect(contentSearchRequests().at(-1)).not.toHaveProperty("caseSensitive");

      await dispatchInputKey(input, { key: "ArrowDown" });
      await dispatchInputKey(input, { key: "Enter" });

      await vi.waitFor(() => {
        expect(useCommandPaletteStore.getState().open).toBe(false);
        expect(
          wsRequests.some(
            (request) =>
              request._tag === WS_METHODS.projectsReadFile &&
              request.relativePath === "src/wide.ts",
          ),
        ).toBe(true);
      });
      expect(navigations).toContainEqual(
        expect.objectContaining({
          workspaceTab: "files",
          workspaceFile: "src/wide.ts",
          workspaceFileLine: 2,
        }),
      );
    } finally {
      unsubscribe();
      await mounted.cleanup();
    }
  });

  it("keeps the highlighted line below its file's header while moving up", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: (body) =>
        body._tag === WS_METHODS.projectsSearchContent
          ? { matches: MANY_LINES }
          : resolveWorkspaceSearchRpc(body),
      configureFixture: withCapabilities({ projectContentSearch: true }),
    });

    try {
      // Keyboard only: a pointer resting over the list would take the highlight as it scrolls.
      await parkPointer(0, 0);
      pressModKey(window, "F", true);
      const input = await waitForFindInFilesInput();
      await page.getByPlaceholder("Search in Project").fill("row");
      await expect
        .element(page.getByTestId("find-in-files").getByRole("status"))
        .toHaveTextContent("36 results in 3 files");

      // From the first line, ArrowUp wraps to the last; walk back up to the first. Each
      // highlighted line must sit inside the list and below the sticky file headers.
      const visited: string[] = [];
      for (let step = 0; step < MANY_LINES.length; step += 1) {
        await dispatchInputKey(input, { key: "ArrowUp" });
        await vi.waitFor(() => {
          const row = document.querySelector<HTMLElement>(
            '[data-testid="find-in-files"] [role="option"][data-highlighted]',
          );
          expect(row).not.toBeNull();
          const rowBox = row!.getBoundingClientRect();
          const listBox = row!
            .closest('[data-slot="scroll-area-viewport"]')!
            .getBoundingClientRect();
          expect(rowBox.top).toBeGreaterThanOrEqual(listBox.top - 1);
          expect(rowBox.bottom).toBeLessThanOrEqual(listBox.bottom + 1);
          const covering = [
            ...document.querySelectorAll(
              '[data-testid="find-in-files"] [data-slot="command-group-label"]',
            ),
          ].filter((label) => {
            const labelBox = label.getBoundingClientRect();
            return labelBox.bottom > rowBox.top + 1 && labelBox.top < rowBox.bottom - 1;
          });
          expect(covering.map((label) => label.textContent)).toEqual([]);
          if (visited.at(-1) !== row!.getAttribute("aria-label")) {
            visited.push(row!.getAttribute("aria-label") ?? "");
          }
        });
      }
      expect(visited).toEqual(
        MANY_LINES.map((line) => `${line.path}:${line.lineNumber}, ${line.preview}`).toReversed(),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("brings back its search after opening a line", async () => {
    // Wide enough for the Files panel to sit beside the chat: as the narrow
    // layout's sheet it is a dialog, which global shortcuts wait for.
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
      configureFixture: withCapabilities({ projectContentSearch: true }),
    });

    try {
      pressModKey(window, "F", true);
      const input = await waitForFindInFilesInput();
      const findInFiles = page.getByTestId("find-in-files");
      await page.getByPlaceholder("Search in Project").fill("wide");
      await expect
        .element(findInFiles.getByRole("status"))
        .toHaveTextContent("3 results in 2 files");
      await dispatchInputKey(input, { key: "Enter" });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="find-in-files"]')).toBeNull();
        expect(mounted.router.state.location.search).toMatchObject({ workspaceTab: "files" });
      });

      // The pick did not replace the query: the key reopens the same search,
      // from wherever opening the line left focus.
      expect(pressModKey(document.activeElement ?? window, "F", true).defaultPrevented).toBe(true);
      const reopened = await waitForFindInFilesInput();
      expect(reopened.value).toBe("wide");
      await expect
        .element(findInFiles.getByRole("status"))
        .toHaveTextContent("3 results in 2 files");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves both keys to other text fields", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
      configureFixture: withCapabilities({ projectContentSearch: true }),
    });
    const field = document.createElement("input");
    document.body.append(field);

    try {
      field.focus();
      expect(pressModKey(field, "p").defaultPrevented).toBe(false);
      expect(pressModKey(field, "F", true).defaultPrevented).toBe(false);
      expect(useCommandPaletteStore.getState()).toMatchObject({
        open: false,
        workspaceSearchMode: null,
      });
    } finally {
      field.remove();
      await mounted.cleanup();
    }
  });

  it("keeps each search's query and starts from the last one on reopen", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
      configureFixture: withCapabilities({ projectContentSearch: true }),
    });

    try {
      pressModKey(window, "F", true);
      await waitForFindInFilesInput();
      const findInFiles = page.getByTestId("find-in-files");
      await page.getByPlaceholder("Search in Project").fill("wide");
      await expect
        .element(findInFiles.getByRole("status"))
        .toHaveTextContent("3 results in 2 files");

      await findInFiles.getByRole("button", { name: "Match case" }).click();
      await expect
        .element(findInFiles.getByRole("status"))
        .toHaveTextContent("2 results in 1 file");
      expect(contentSearchRequests().at(-1)).toMatchObject({ query: "wide", caseSensitive: true });

      // Switching to quick open and back keeps both queries.
      pressModKey(window, "p");
      await waitForQuickOpenInput();
      await page.getByPlaceholder("Go to file").fill("wid");
      pressModKey(window, "F", true);
      const restored = await waitForFindInFilesInput();
      expect(restored.value).toBe("wide");
      await expect
        .element(findInFiles.getByRole("button", { name: "Match case" }))
        .toHaveAttribute("aria-pressed", "true");
      pressModKey(window, "p");
      expect((await waitForQuickOpenInput()).value).toBe("wid");

      // Closed and opened again, find in files searches its last query again, selected.
      useCommandPaletteStore.getState().setOpen(false);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="find-in-files"]')).toBeNull(),
      );
      const requestsBefore = contentSearchRequests().length;
      pressModKey(window, "F", true);
      const reopened = await waitForFindInFilesInput();
      expect(reopened.value).toBe("wide");
      await vi.waitFor(() => {
        expect(reopened.selectionStart).toBe(0);
        expect(reopened.selectionEnd).toBe(4);
      });
      await expect
        .element(findInFiles.getByRole("status"))
        .toHaveTextContent("2 results in 1 file");
      expect(contentSearchRequests().length).toBeGreaterThan(requestsBefore);
    } finally {
      await mounted.cleanup();
    }
  });

  it("asks to update a node that cannot search file contents", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
    });

    try {
      const editor = await waitForComposerEditor();
      editor.focus();
      expect(pressModKey(editor, "F", true).defaultPrevented).toBe(true);
      await waitForFindInFilesInput();
      await page.getByPlaceholder("Search in Project").fill("wide");
      await expect
        .element(page.getByTestId("find-in-files").getByRole("status"))
        .toHaveTextContent("Update Ryco on this node to search file contents.");
      expect(contentSearchRequests()).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });
});
