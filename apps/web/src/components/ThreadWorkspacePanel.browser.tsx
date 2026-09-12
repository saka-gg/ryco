import "../index.css";

import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import ThreadWorkspacePanel, { AgentThreadPanel } from "./ThreadWorkspacePanel";
import type { ThreadSubagentView } from "../threadWorkspaceViewModel";

vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useNavigate: () => vi.fn(),
  useParams: vi.fn((options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = {};
    return options?.select ? options.select(params) : params;
  }),
  useSearch: vi.fn((options?: { select?: (search: Record<string, string>) => unknown }) => {
    const search = { workspaceOpen: "1" };
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
    document.body.innerHTML = "";
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
