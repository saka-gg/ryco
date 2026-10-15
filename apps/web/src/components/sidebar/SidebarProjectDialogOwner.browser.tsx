import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

const newWorktreeChunk = vi.hoisted(() => ({
  fails: false,
  notify: vi.fn<(surface: string, error: unknown, retry: () => void) => void>(),
}));

// The new-workspace dialog's shared wrapper, with a chunk that can fail to
// load (offline, or a deploy replaced it) while `fails` is set.
vi.mock("../worktrees/lazyWorktreeDialogs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktrees/lazyWorktreeDialogs")>();
  const { preloadableLazy } = await import("../../lib/preloadableLazy");
  function NewWorktreeDialogStub(props: {
    readonly open: boolean;
    readonly projectId: string;
    readonly initialTab: string;
  }) {
    return props.open ? (
      <div role="dialog" aria-label={`New workspace in ${props.projectId}`}>
        {props.initialTab}
      </div>
    ) : null;
  }
  const LazyNewWorktreeDialog = preloadableLazy(async () => {
    if (newWorktreeChunk.fails) throw new Error("Failed to fetch dynamically imported module");
    return NewWorktreeDialogStub;
  });
  return { ...actual, LazyNewWorktreeDialog };
});
vi.mock("../ui/surfaceLoadFailure", () => ({
  notifySurfaceLoadFailure: newWorktreeChunk.notify,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

import {
  SidebarProjectDialogProvider,
  useSidebarProjectDialogs,
} from "./SidebarProjectDialogOwner";

const project = {
  environmentId: EnvironmentId.make("environment-local"),
  id: ProjectId.make("project-1"),
  cwd: "/repo",
} as unknown as SidebarProjectSnapshot;

function OpenNewWorkspace() {
  const { openNewWorktree } = useSidebarProjectDialogs();
  return (
    <button type="button" onClick={() => openNewWorktree(project, "prs")}>
      New workspace
    </button>
  );
}

describe("SidebarProjectDialogProvider", () => {
  it("reports a new workspace dialog chunk that fails to load and reopens it on retry", async () => {
    newWorktreeChunk.fails = true;
    await render(
      <SidebarProjectDialogProvider
        projectGroupingSettings={{
          sidebarProjectGroupingMode: "repository",
          sidebarProjectGroupingOverrides: undefined,
        }}
        updateSettings={vi.fn()}
        navigateToThread={vi.fn()}
      >
        <OpenNewWorkspace />
      </SidebarProjectDialogProvider>,
    );

    await page.getByRole("button", { name: "New workspace" }).click();

    await vi.waitFor(() => expect(newWorktreeChunk.notify).toHaveBeenCalledOnce());
    expect(newWorktreeChunk.notify.mock.calls[0]?.[0]).toBe("new workspace dialog");
    // The request is dropped and nothing threw to an error boundary.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await expect.element(page.getByRole("button", { name: "New workspace" })).toBeInTheDocument();

    // Retry reopens the same project and tab once the chunk loads.
    newWorktreeChunk.fails = false;
    newWorktreeChunk.notify.mock.calls[0]?.[2]();

    const dialog = page.getByRole("dialog", { name: "New workspace in project-1" });
    await expect.element(dialog).toBeInTheDocument();
    await expect.element(dialog).toHaveTextContent("prs");
    expect(newWorktreeChunk.notify).toHaveBeenCalledOnce();
  });
});
