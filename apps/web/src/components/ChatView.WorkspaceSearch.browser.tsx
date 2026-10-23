import { MessageId, WS_METHODS, type ProjectEntry } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { isMacPlatform } from "../lib/utils";
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
  waitForElement,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const WORKSPACE_ENTRIES: ProjectEntry[] = [
  { path: "README.md", kind: "file" },
  { path: "src", kind: "directory" },
  { path: "src/wide.ts", kind: "file", parentPath: "src" },
];

/** Stands in for the node's ranking: the entries whose path holds the query. */
function resolveWorkspaceSearchRpc(body: NormalizedWsRpcRequestBody): unknown | undefined {
  if (body._tag === WS_METHODS.projectsSearchEntries) {
    const query = typeof body.query === "string" ? body.query.toLowerCase() : "";
    return {
      entries: WORKSPACE_ENTRIES.filter((entry) => entry.path.toLowerCase().includes(query)),
      truncated: false,
    };
  }
  return resolveWorkSurfaceRpc(body);
}

function snapshot() {
  return createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-user-workspace-search"),
    targetText: "workspace search",
  });
}

function pressModKey(target: EventTarget, key: string): KeyboardEvent {
  const useMetaForMod = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
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
      expect(mounted.router.state.location.search).toMatchObject({ workspaceTab: "files" });
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists only files for an empty query on nodes that list the workspace", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshot(),
      resolveRpc: resolveWorkspaceSearchRpc,
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          environment: {
            ...fixture.serverConfig.environment,
            capabilities: {
              ...fixture.serverConfig.environment.capabilities,
              projectSearchEmptyQuery: true,
            },
          },
        };
      },
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
    } finally {
      await mounted.cleanup();
    }
  });
});
