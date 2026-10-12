import "../index.css";

import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import ThreadWorkspacePanel, { AgentThreadPanel } from "./ThreadWorkspacePanel";
import type { ThreadSubagentView } from "../threadWorkspaceViewModel";
import { LazySimulatorPanel, loadSimulatorPanel } from "../workspacePanelPreload";

/** The pull request surface chunk, held until a test releases it. */
const pullRequestChunk = vi.hoisted(() => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release: () => release(), resolvedAt: null as number | null };
});

vi.mock("./pullRequests/workspace/WorkspacePullRequestPanel", async () => {
  await pullRequestChunk.released;
  pullRequestChunk.resolvedAt = performance.now();
  return { default: () => <div data-testid="pull-request-surface" /> };
});

vi.mock("./device/SimulatorPanel", () => ({
  default: () => <div data-testid="simulator-surface" />,
}));

const routerState = vi.hoisted(() => ({
  navigate: null as null | ((options: unknown) => void),
  params: {} as Record<string, string>,
  search: { workspaceOpen: "1" } as Record<string, string>,
}));

vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useNavigate: () => routerState.navigate ?? vi.fn(),
  useParams: vi.fn((options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = routerState.params;
    return options?.select ? options.select(params) : params;
  }),
  useSearch: vi.fn((options?: { select?: (search: Record<string, string>) => unknown }) => {
    const search = routerState.search;
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

vi.mock("../rpc/serverState", async () => {
  const actual = await vi.importActual<typeof import("../rpc/serverState")>("../rpc/serverState");
  return {
    ...actual,
    useServerKeybindings: () => [],
  };
});

describe("ThreadWorkspacePanel", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    routerState.navigate = null;
    routerState.params = {};
    routerState.search = { workspaceOpen: "1" };
    document.body.innerHTML = "";
  });

  it("acts on a one-shot Agents workflow link once, then strips it from the route", async () => {
    const navigate = vi.fn();
    routerState.navigate = navigate;
    routerState.params = { draftId: "draft-reveal" };
    routerState.search = {
      workspaceOpen: "1",
      workspaceTab: "agents",
      workspaceAgentsWorkflow: "wf-audit",
    };
    const host = document.createElement("div");
    host.style.width = "720px";
    host.style.height = "520px";
    host.style.display = "flex";
    document.body.append(host);

    mounted = await render(
      <ThreadWorkspacePanel
        mode="sidebar"
        panelMode={null}
        openedPanelModes={[]}
        openedAgentKeys={[]}
        onClosePanelTab={vi.fn()}
      />,
      { container: host },
    );

    await expect.poll(() => navigate.mock.calls.length).toBe(1);
    const [options] = navigate.mock.calls[0] as [
      {
        to: string;
        replace: boolean;
        search: (previous: Record<string, unknown>) => Record<string, unknown>;
      },
    ];
    expect(options).toMatchObject({
      to: "/draft/$draftId",
      params: { draftId: "draft-reveal" },
      replace: true,
    });
    const next = options.search({ ...routerState.search, other: "kept" });
    expect(next.workspaceAgentsWorkflow).toBeUndefined();
    expect(next).toMatchObject({ workspaceOpen: "1", workspaceTab: "agents", other: "kept" });
  });

  it("stretches its root to the full right-panel width", async () => {
    const host = document.createElement("div");
    host.style.width = "900px";
    host.style.height = "620px";
    host.style.display = "flex";
    document.body.append(host);

    mounted = await render(
      <ThreadWorkspacePanel
        mode="sidebar"
        panelMode={null}
        openedPanelModes={[]}
        openedAgentKeys={[]}
        onClosePanelTab={vi.fn()}
      />,
      { container: host },
    );

    const workspaceRoot = host.firstElementChild as HTMLElement | null;
    const tabPanel = document.querySelector<HTMLElement>('[role="tabpanel"]');

    expect(workspaceRoot).not.toBeNull();
    expect(tabPanel).not.toBeNull();
    expect(workspaceRoot!.className).toContain("w-full");
    expect(workspaceRoot!.className).toContain("flex-1");
    expect(workspaceRoot!.getBoundingClientRect().width).toBeGreaterThan(890);
    expect(
      Math.abs(workspaceRoot!.getBoundingClientRect().width - host.clientWidth),
    ).toBeLessThanOrEqual(1);
  });

  it("keeps all desktop launcher cards inside a narrow, short workspace", async () => {
    const host = document.createElement("div");
    host.style.width = "340px";
    host.style.height = "420px";
    host.style.display = "flex";
    document.body.append(host);

    mounted = await render(
      <ThreadWorkspacePanel
        mode="sidebar"
        panelMode={null}
        openedPanelModes={[]}
        openedAgentKeys={[]}
        onClosePanelTab={vi.fn()}
      />,
      { container: host },
    );

    const launcher = document.querySelector<HTMLElement>('[data-slot="workspace-launcher"]');
    const grid = document.querySelector<HTMLElement>('[data-slot="workspace-launcher-grid"]');
    const cards = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="workspace-launcher-card"]'),
    ];

    expect(launcher).not.toBeNull();
    expect(grid).not.toBeNull();
    expect(cards).toHaveLength(6);

    const launcherRect = launcher!.getBoundingClientRect();
    const gridRect = grid!.getBoundingClientRect();
    expect(Math.abs(gridRect.width - gridRect.height)).toBeLessThanOrEqual(1);
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(launcherRect.left - 0.5);
      expect(rect.top).toBeGreaterThanOrEqual(launcherRect.top - 0.5);
      expect(rect.right).toBeLessThanOrEqual(launcherRect.right + 0.5);
      expect(rect.bottom).toBeLessThanOrEqual(launcherRect.bottom + 0.5);
    }
  });

  // A surface's loading state is an ordinary render, not a Suspense fallback,
  // whose reveal React holds until 300 ms after it, however soon the chunk lands.
  it("shows a cold surface right after its chunk lands", async () => {
    routerState.search = { workspaceOpen: "1", workspaceTab: "pullRequest" };
    const host = document.createElement("div");
    host.style.width = "720px";
    host.style.height = "520px";
    host.style.display = "flex";
    document.body.append(host);

    mounted = await render(
      <ThreadWorkspacePanel
        mode="sidebar"
        panelMode="pullRequest"
        openedPanelModes={["pullRequest"]}
        openedAgentKeys={[]}
        onClosePanelTab={vi.fn()}
      />,
      { container: host },
    );
    await expect
      .element(page.getByRole("status", { name: "Loading pull request..." }))
      .toBeInTheDocument();

    const committed = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-testid="pull-request-surface"]')) return;
        observer.disconnect();
        resolve(performance.now());
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    pullRequestChunk.release();
    const committedAt = await committed;

    expect(pullRequestChunk.resolvedAt).not.toBeNull();
    expect(committedAt - pullRequestChunk.resolvedAt!).toBeLessThan(150);
  });

  it("mounts a surface warmed by a preload site in its first commit", async () => {
    await loadSimulatorPanel();
    expect(LazySimulatorPanel.isLoaded()).toBe(true);
    routerState.search = { workspaceOpen: "1", workspaceTab: "simulator" };
    const host = document.createElement("div");
    host.style.width = "720px";
    host.style.height = "520px";
    host.style.display = "flex";
    document.body.append(host);
    let loadingStateShown = false;
    const observer = new MutationObserver(() => {
      loadingStateShown ||= document.querySelector('[role="tabpanel"] [role="status"]') !== null;
    });
    observer.observe(document.body, { childList: true, subtree: true });

    mounted = await render(
      <ThreadWorkspacePanel
        mode="sidebar"
        panelMode="simulator"
        openedPanelModes={["simulator"]}
        openedAgentKeys={[]}
        onClosePanelTab={vi.fn()}
      />,
      { container: host },
    );
    await expect.element(page.getByTestId("simulator-surface")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();

    expect(loadingStateShown).toBe(false);
  });

  it("renders the phone surface bar with a back affordance and 44px tab targets", async () => {
    const host = document.createElement("div");
    host.style.width = "390px";
    host.style.height = "700px";
    host.style.display = "flex";
    document.body.append(host);

    mounted = await render(
      <ThreadWorkspacePanel
        mode="phone"
        panelMode={null}
        openedPanelModes={["files", "review", "terminal"]}
        openedAgentKeys={[]}
        onClosePanelTab={vi.fn()}
      />,
      { container: host },
    );

    // Surface bar: back affordance to the thread instead of the desktop X.
    const backButton = document.querySelector<HTMLElement>('button[aria-label="Back to thread"]');
    expect(backButton).not.toBeNull();
    expect(document.querySelector('button[aria-label="Close workspace panel"]')).toBeNull();

    // Every tab is a >=44px touch target on the phone surface.
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.length).toBe(3);
    for (const tab of tabs) {
      expect(tab.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    for (const label of ["Files", "Review", "Terminal"]) {
      const closeButton = document.querySelector<HTMLElement>(
        `button[aria-label="Close ${label} tab"]`,
      );
      expect(closeButton).not.toBeNull();
      const hitArea = getComputedStyle(closeButton!, "::after");
      expect(hitArea.position).toBe("absolute");
      expect(parseFloat(hitArea.width)).toBeGreaterThanOrEqual(44);
      expect(parseFloat(hitArea.height)).toBeGreaterThanOrEqual(44);
    }
    const launcherButton = document.querySelector<HTMLElement>(
      'button[aria-label="Workspace launcher"]',
    );
    expect(launcherButton).not.toBeNull();
    expect(launcherButton!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(launcherButton!.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  });

  it("scrolls the workspace launcher when the cards overflow a short phone pane", async () => {
    const host = document.createElement("div");
    host.style.width = "320px";
    host.style.height = "420px";
    host.style.display = "flex";
    document.body.append(host);

    mounted = await render(
      <ThreadWorkspacePanel
        mode="phone"
        panelMode={null}
        openedPanelModes={[]}
        openedAgentKeys={[]}
        onClosePanelTab={vi.fn()}
      />,
      { container: host },
    );

    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    // The launcher card stack overflows 420px and must scroll instead of
    // clipping: the first card starts inside the scroll range (auto margins
    // collapse), and the pane scrolls through the full stack.
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
    viewport!.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const filesCard = [...viewport!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Files"),
    );
    expect(filesCard).toBeDefined();
    expect(filesCard!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      viewport!.getBoundingClientRect().top - 0.5,
    );
    viewport!.scrollTop = viewport!.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(viewport!.scrollTop).toBeGreaterThan(0);
  });

  it("scrolls long subagent transcripts inside the agent panel", async () => {
    const host = document.createElement("div");
    host.style.width = "420px";
    host.style.height = "320px";
    document.body.append(host);

    const subagent: ThreadSubagentView = {
      key: "subagent:researcher",
      name: "Researcher",
      status: "running",
      origin: null,
      capability: null,
      tool: "spawnAgent",
      detail: "Inspect the retry flow.",
      providerThreadIds: ["child-thread-1"],
      providerSessionIds: [],
      startedAt: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z",
      entries: [],
      messages: Array.from({ length: 24 }, (_, index) => ({
        id: `message-${index}`,
        createdAt: `2026-06-04T10:00:${String(index).padStart(2, "0")}.000Z`,
        providerThreadId: "child-thread-1",
        text: `Finding ${index + 1}: this is a deliberately long subagent transcript entry that should remain inside the scroll container rather than expanding the whole panel.`,
      })),
    };

    mounted = await render(
      <AgentThreadPanel subagent={subagent} agentKey="subagent:researcher" />,
      { container: host },
    );

    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');

    expect(viewport).not.toBeNull();
    expect(viewport!.clientHeight).toBeGreaterThan(0);
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);

    viewport!.scrollTop = viewport!.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(viewport!.scrollTop).toBeGreaterThan(0);
  });
});
