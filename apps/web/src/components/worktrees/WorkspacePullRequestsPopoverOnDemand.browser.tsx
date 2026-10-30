import "../../index.css";

import { EnvironmentId } from "@ryco/contracts";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import type { WorkspacePullRequestsPopoverProps } from "./WorkspacePullRequestsPopover";

// A stand-in for the popover's chunk: it loads when asked, or fails to.
const chunk = vi.hoisted(() => ({
  loaded: false,
  fail: false,
  loads: 0,
}));
const notifySurfaceLoadFailure = vi.hoisted(() => vi.fn());

vi.mock("./lazyWorktreeDialogs", () => {
  let failure: { readonly error: unknown } | null = null;
  const Popover = (props: WorkspacePullRequestsPopoverProps) => (
    <div role="dialog" aria-label="Pull requests" data-open={String(props.open)}>
      {props.workspaceTitle}
    </div>
  );
  return {
    LazyWorkspacePullRequestsPopover: Object.assign(Popover, {
      preload: () => {
        chunk.loads += 1;
        if (chunk.fail) failure = { error: new Error("chunk failed") };
        else chunk.loaded = true;
        return Promise.resolve();
      },
      isLoaded: () => chunk.loaded,
      loadFailure: () => failure,
    }),
  };
});
vi.mock("../ui/surfaceLoadFailure", () => ({ notifySurfaceLoadFailure }));

const { WorkspacePullRequestsPopoverOnDemand } =
  await import("./WorkspacePullRequestsPopoverOnDemand");

const props = (
  overrides: Partial<ComponentProps<typeof WorkspacePullRequestsPopoverOnDemand>> = {},
): ComponentProps<typeof WorkspacePullRequestsPopoverOnDemand> =>
  ({
    environmentId: EnvironmentId.make("environment-1"),
    worktreeId: null,
    cwd: "/workspace",
    workspaceTitle: "Workspace",
    workspaceBranch: "feature",
    links: [],
    shownNumber: null,
    canEdit: false,
    open: false,
    onOpenChange: vi.fn(),
    view: "list",
    onViewChange: vi.fn(),
    ...overrides,
  }) as ComponentProps<typeof WorkspacePullRequestsPopoverOnDemand>;

describe("WorkspacePullRequestsPopoverOnDemand", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(() => {
    chunk.loaded = false;
    chunk.fail = false;
    chunk.loads = 0;
    notifySurfaceLoadFailure.mockReset();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("loads nothing until its first open, then stays mounted to animate closed", async () => {
    mounted = await render(<WorkspacePullRequestsPopoverOnDemand {...props()} />);
    expect(chunk.loads).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await mounted.rerender(<WorkspacePullRequestsPopoverOnDemand {...props({ open: true })} />);
    await expect.element(page.getByRole("dialog", { name: "Pull requests" })).toBeVisible();
    expect(chunk.loads).toBe(1);

    await mounted.rerender(<WorkspacePullRequestsPopoverOnDemand {...props({ open: false })} />);
    expect(document.querySelector('[role="dialog"]')?.getAttribute("data-open")).toBe("false");
  });

  it("closes on a failed chunk and offers a Retry that reopens the same view", async () => {
    chunk.fail = true;
    const onOpenChange = vi.fn();
    const onViewChange = vi.fn();
    mounted = await render(
      <WorkspacePullRequestsPopoverOnDemand
        {...props({ open: true, view: "link", onOpenChange, onViewChange })}
      />,
    );
    await vi.waitFor(() => expect(notifySurfaceLoadFailure).toHaveBeenCalledOnce());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const [surface, , retry] = notifySurfaceLoadFailure.mock.calls[0]!;
    expect(surface).toBe("pull requests");
    (retry as () => void)();
    expect(onViewChange).toHaveBeenCalledWith("link");
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });
});
