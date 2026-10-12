import "../index.css";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

/*
 * The toolbar's intent preloads: hovering or focusing the terminal toggle
 * fetches the drawer's chunk (code only, never a PTY), and "From PR / issue"
 * fetches the new-worktree dialog it opens. The stores and the heavy child
 * selectors are stubbed; only the toolbar's own wiring is under test.
 */
const { loadThreadTerminalDrawer, preloadNewWorktreeDialog, ids } = vi.hoisted(() => ({
  loadThreadTerminalDrawer: vi.fn(() => Promise.resolve()),
  preloadNewWorktreeDialog: vi.fn(() => Promise.resolve()),
  ids: {
    environmentId: "environment-branch-toolbar",
    projectId: "project-branch-toolbar",
    threadId: "thread-branch-toolbar",
  },
}));

const ENVIRONMENT_ID = EnvironmentId.make(ids.environmentId);
const THREAD_ID = ThreadId.make(ids.threadId);
const DRAFT_ID = "draft-branch-toolbar" as NonNullable<
  ComponentProps<typeof BranchToolbar>["draftId"]
>;

vi.mock("../workspacePanelPreload", () => ({ loadThreadTerminalDrawer }));
vi.mock("./worktrees/lazyWorktreeDialogs", () => ({
  LazyNewWorktreeDialog: { preload: preloadNewWorktreeDialog },
}));
vi.mock("../store", () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock("../storeSelectors", () => ({
  createThreadSelectorByRef: () => () => undefined,
  createProjectSelectorByRef: () => () => ({
    id: ids.projectId,
    environmentId: ids.environmentId,
    name: "Demo project",
  }),
}));
vi.mock("../composerDraftStore", async () => {
  // The real module's other exports (the `DraftId` brand) with the store stubbed.
  const composer = await import("@ryco/client-runtime/state/composer");
  const draft = {
    environmentId: ids.environmentId,
    projectId: ids.projectId,
    threadId: ids.threadId,
    worktreePath: null,
    envMode: "worktree",
  };
  const state = {
    getDraftSession: () => draft,
    getDraftThreadByRef: () => draft,
    setDraftThreadContext: () => undefined,
  };
  return {
    ...composer,
    useComposerDraftStore: (selector: (value: typeof state) => unknown) => selector(state),
  };
});
vi.mock("./BranchToolbarBranchSelector", () => ({ BranchToolbarBranchSelector: () => null }));
vi.mock("./BranchToolbarEnvironmentSelector", () => ({
  BranchToolbarEnvironmentSelector: () => null,
}));
vi.mock("./BranchToolbarEnvModeSelector", () => ({ BranchToolbarEnvModeSelector: () => null }));
vi.mock("./ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));

import { BranchToolbar } from "./BranchToolbar";

function Toolbar(props: { readonly terminalOpen: boolean }) {
  return (
    <BranchToolbar
      environmentId={ENVIRONMENT_ID}
      threadId={THREAD_ID}
      draftId={DRAFT_ID}
      envLocked={false}
      onOpenWorktreeSources={() => undefined}
      terminalAvailable
      terminalOpen={props.terminalOpen}
      terminalToggleShortcutLabel={null}
      onToggleTerminal={() => undefined}
      terminalCount={1}
    />
  );
}

describe("BranchToolbar intent preloads", () => {
  afterEach(() => {
    loadThreadTerminalDrawer.mockClear();
    preloadNewWorktreeDialog.mockClear();
  });

  it("fetches the terminal drawer's chunk on hover and focus while the drawer is closed", async () => {
    const screen = await render(<Toolbar terminalOpen={false} />);
    try {
      const toggle = page.getByRole("button", { name: "Toggle terminal drawer" });
      await toggle.hover();
      await vi.waitFor(() => expect(loadThreadTerminalDrawer).toHaveBeenCalled());

      loadThreadTerminalDrawer.mockClear();
      (toggle.element() as HTMLElement).focus();
      expect(loadThreadTerminalDrawer).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not preload the drawer once it is open", async () => {
    const screen = await render(<Toolbar terminalOpen />);
    try {
      const toggle = page.getByRole("button", { name: "Toggle terminal drawer" });
      await toggle.hover();
      (toggle.element() as HTMLElement).focus();
      await userEvent.unhover(toggle);
      expect(loadThreadTerminalDrawer).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("fetches the new-worktree dialog's chunk on hover over From PR / issue", async () => {
    const screen = await render(<Toolbar terminalOpen={false} />);
    try {
      await page.getByTestId("branch-toolbar-worktree-sources").hover();
      await vi.waitFor(() => expect(preloadNewWorktreeDialog).toHaveBeenCalled());
      expect(loadThreadTerminalDrawer).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
