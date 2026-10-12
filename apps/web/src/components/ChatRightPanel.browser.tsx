import "../index.css";

import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { syncDocumentPresentationTier } from "../lib/presentationTier";
import { LazyDiffPanel, LazyThreadWorkspacePanel } from "../workspacePanelPreload";

import { RightPanelInlineSidebar } from "./ChatRightPanel";

const diffWorkerPool = vi.hoisted(() => ({ prewarm: vi.fn() }));

vi.mock("./DiffPanel", () => ({ default: () => <div data-testid="diff-surface" /> }));
vi.mock("../lib/diffWorkerPool", () => ({ prewarmDiffWorkerPool: diffWorkerPool.prewarm }));

/**
 * The workspace panel chunk, held until a test releases it, so the loading
 * state and the moment the chunk lands are both observable.
 */
const workspaceChunk = vi.hoisted(() => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release: () => release(), resolvedAt: null as number | null };
});

vi.mock("./ThreadWorkspacePanel", async () => {
  await workspaceChunk.released;
  workspaceChunk.resolvedAt = performance.now();
  return {
    default: (props: { panelMode: string | null }) => (
      <div data-testid="workspace-panel">{props.panelMode ?? "launcher"}</div>
    ),
  };
});

/** Resolves with the time the element carrying `testId` is first committed. */
function observeCommit(testId: string): Promise<number> {
  return new Promise((resolve) => {
    const check = () => {
      if (!document.querySelector(`[data-testid="${testId}"]`)) return false;
      observer.disconnect();
      resolve(performance.now());
      return true;
    };
    const observer = new MutationObserver(() => {
      check();
    });
    if (!check()) observer.observe(document.body, { childList: true, subtree: true });
  });
}

const BASE_PROPS = {
  panelMode: null,
  openedPanelModes: [],
  openedAgentKeys: [],
  renderContent: false,
  maximized: false,
  reserveChromeInset: false,
} as const;

describe("RightPanelInlineSidebar", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  // The inline presentation only exists on the desktop tier — the phone tier
  // swaps the whole sidebar for a sheet with no inline geometry at all.
  beforeEach(async () => {
    await page.viewport(1_280, 800);
    syncDocumentPresentationTier();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("reserves the configured inline width while open", async () => {
    mounted = await render(
      <RightPanelInlineSidebar
        {...BASE_PROPS}
        open
        onClosePanelTab={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onToggleMaximized={vi.fn()}
      />,
    );

    const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');

    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("w-(--sidebar-width)");

    const wrapperWidth = wrapper!.getBoundingClientRect().width;

    expect(wrapperWidth).toBeGreaterThan(300);
  });

  it("does not reserve inline space while closed", async () => {
    mounted = await render(
      <RightPanelInlineSidebar
        {...BASE_PROPS}
        open={false}
        onClosePanelTab={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onToggleMaximized={vi.fn()}
      />,
    );

    const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');

    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("w-0");
    expect(wrapper!.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  });

  it("fills the space it is given while maximized, dropping the resize rail", async () => {
    const host = document.createElement("div");
    host.style.display = "flex";
    host.style.width = "900px";
    document.body.append(host);

    mounted = await render(
      <RightPanelInlineSidebar
        {...BASE_PROPS}
        open
        maximized
        onClosePanelTab={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onToggleMaximized={vi.fn()}
      />,
      { container: host },
    );

    const wrapper = host.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');
    const container = host.querySelector<HTMLElement>('[data-slot="sidebar-container"]');

    expect(wrapper).not.toBeNull();
    expect(container).not.toBeNull();
    // The fixed off-canvas geometry is gone: the panel is an ordinary flex
    // child sized by its parent rather than by `--sidebar-width`.
    expect(getComputedStyle(container!).position).not.toBe("fixed");
    expect(wrapper!.getBoundingClientRect().width).toBeCloseTo(900, 0);
    expect(container!.getBoundingClientRect().width).toBeCloseTo(900, 0);
    expect(host.querySelector('[data-slot="sidebar-rail"]')).toBeNull();
  });

  // Opening the panel is an explicit intent: the surface chunk and the review
  // highlight workers start next to the shell instead of after it mounts.
  // Runs while the shell chunk is still held, before the tests that release it.
  it("starts the review surface and its workers with the shell when it opens", async () => {
    expect(LazyThreadWorkspacePanel.isLoaded()).toBe(false);
    expect(LazyDiffPanel.isLoaded()).toBe(false);
    mounted = await render(
      <RightPanelInlineSidebar
        {...BASE_PROPS}
        panelMode="review"
        openedPanelModes={["review"]}
        open
        renderContent
        onClosePanelTab={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onToggleMaximized={vi.fn()}
      />,
    );
    await expect
      .element(page.getByRole("status", { name: "Loading diff viewer..." }))
      .toBeInTheDocument();

    await vi.waitFor(() => {
      expect(LazyDiffPanel.isLoaded()).toBe(true);
      expect(diffWorkerPool.prewarm).toHaveBeenCalled();
    });
    // Neither waited for the shell, which is still loading.
    expect(LazyThreadWorkspacePanel.isLoaded()).toBe(false);
  });

  // React holds the reveal after a committed Suspense fallback until 300 ms
  // after that fallback, however soon the chunk lands. The panel's loading
  // state is an ordinary render instead, so the panel follows its chunk.
  it("shows the panel right after a cold chunk lands", async () => {
    expect(LazyThreadWorkspacePanel.isLoaded()).toBe(false);
    mounted = await render(
      <RightPanelInlineSidebar
        {...BASE_PROPS}
        open
        renderContent
        onClosePanelTab={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onToggleMaximized={vi.fn()}
      />,
    );
    await expect
      .element(page.getByRole("status", { name: "Loading workspace..." }))
      .toBeInTheDocument();

    const committed = observeCommit("workspace-panel");
    workspaceChunk.release();
    const committedAt = await committed;

    expect(workspaceChunk.resolvedAt).not.toBeNull();
    expect(committedAt - workspaceChunk.resolvedAt!).toBeLessThan(150);
    expect(document.querySelector('[aria-label="Loading workspace..."]')).toBeNull();
  });

  it("renders an already loaded panel in its first commit, with no loading state", async () => {
    workspaceChunk.release();
    await LazyThreadWorkspacePanel.preload();
    let loadingStateShown = false;
    const observer = new MutationObserver(() => {
      loadingStateShown ||= document.querySelector('[aria-label="Loading workspace..."]') !== null;
    });
    observer.observe(document.body, { childList: true, subtree: true });

    mounted = await render(
      <RightPanelInlineSidebar
        {...BASE_PROPS}
        open
        renderContent
        onClosePanelTab={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onToggleMaximized={vi.fn()}
      />,
    );
    await expect.element(page.getByTestId("workspace-panel")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();

    expect(loadingStateShown).toBe(false);
  });
});
