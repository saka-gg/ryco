import "../../index.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { Project, SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { Profiler, act, useLayoutEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ConnectedInboxSidebar } from "./ConnectedInboxSidebar";
import { InboxSidebar, type InboxSidebarProps } from "./InboxSidebar";
import type { InboxSidebarEnvironment } from "./inboxSidebarModel";

// Counts model builds, to show that the rows stay put although the model is rebuilt.
const modelBuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock("./inboxSidebarModel", async (original) => {
  const actual = await original<typeof import("./inboxSidebarModel")>();
  return {
    ...actual,
    buildInboxSidebarModel: (input: Parameters<typeof actual.buildInboxSidebarModel>[0]) => {
      modelBuilds.count += 1;
      return actual.buildInboxSidebarModel(input);
    },
  };
});

// Every body run of a row calls this hook once: it counts renders of the real
// (memoized) row, which a wrapper component could not tell apart from its own.
const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./useInboxRowPreviewIntent", async (original) => {
  const actual = await original<typeof import("./useInboxRowPreviewIntent")>();
  return {
    ...actual,
    useInboxRowPreviewIntent: () => {
      rowRenders.count += 1;
      return actual.useInboxRowPreviewIntent();
    },
  };
});

const ENVIRONMENT_IDS = [
  EnvironmentId.make("stability-env-a"),
  EnvironmentId.make("stability-env-b"),
];
const PROJECT_ID = ProjectId.make("stability-project");
const ROWS_PER_ENVIRONMENT = 75;

const projects = (): Project[] =>
  ENVIRONMENT_IDS.map((environmentId) => ({
    id: PROJECT_ID,
    environmentId,
    name: "Stability",
    cwd: "/repo/stability",
    defaultModelSelection: null,
    scripts: [],
  }));

const environments = (): InboxSidebarEnvironment[] =>
  ENVIRONMENT_IDS.map((environmentId) => ({
    environmentId,
    label: environmentId,
    connectionState: "idle",
    stale: false,
    role: "owner",
    trust: "not-required",
    deliveryUnknown: false,
    threadSettlementSupported: true,
    mutationReady: false,
    shellCurrent: true,
  }));

const threads = (): SidebarThreadSummary[] =>
  ENVIRONMENT_IDS.flatMap((environmentId, environmentIndex) =>
    Array.from({ length: ROWS_PER_ENVIRONMENT }, (_, index) => ({
      id: ThreadId.make(`thread-${index}`),
      environmentId,
      projectId: PROJECT_ID,
      title: `Task ${environmentIndex}-${index}`,
      interactionMode: "default" as const,
      session: null,
      createdAt: new Date(Date.UTC(2026, 8, 1, environmentIndex, index)).toISOString(),
      archivedAt: null,
      latestTurn: null,
      branch: "main",
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    })),
  );

const rowKey = (environmentIndex: number, index: number) =>
  `${ENVIRONMENT_IDS[environmentIndex]}:thread-${index}`;

const baseProps = (): InboxSidebarProps => ({
  projects: projects(),
  worktrees: [],
  environments: environments(),
  threads: threads(),
  deliveryUnknownThreadKeys: new Set(),
  localQueuedThreadKeys: new Set(),
  activeThreadKey: rowKey(0, 0),
  aiFocusEnabled: false,
  autoSettleAfterDays: null,
  pinnedThreadKeys: new Set(),
  onOpenThread: vi.fn(),
});

/** Mount work (visibility observers, motion gates) settles before renders are counted. */
async function waitForQuietRows() {
  let last = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (rowRenders.count === last) return;
    last = rowRenders.count;
  }
  throw new Error("The inbox rows never stopped rendering.");
}

/** Counts commits of the inbox subtree; `tree` renders the sidebar for new props. */
function mountInbox(
  props: InboxSidebarProps,
  renderSidebar: (props: InboxSidebarProps) => ReactNode = (next) => <InboxSidebar {...next} />,
) {
  let commits = 0;
  const tree = (next: InboxSidebarProps) => (
    <Profiler id="inbox" onRender={() => void (commits += 1)}>
      {renderSidebar(next)}
    </Profiler>
  );
  return {
    tree,
    commits: () => commits,
    mount: () => render(tree(props)),
  };
}

describe("Inbox row render stability", () => {
  afterEach(() => {
    rowRenders.count = 0;
    modelBuilds.count = 0;
    document.body.innerHTML = "";
  });

  it("renders only the rows whose own inputs changed", async () => {
    await page.viewport(1280, 900);
    const props = baseProps();
    const inbox = mountInbox(props);
    const mounted = await inbox.mount();
    try {
      expect(document.querySelectorAll('[data-testid="inbox-thread-row"]')).toHaveLength(
        ENVIRONMENT_IDS.length * ROWS_PER_ENVIRONMENT,
      );
      await waitForQuietRows();

      // The open thread moves from one row to another: those two rows, no others.
      let rendersBefore = rowRenders.count;
      await mounted.rerender(inbox.tree({ ...props, activeThreadKey: rowKey(1, 3) }));
      expect(rowRenders.count - rendersBefore).toBeLessThanOrEqual(2);
      expect(rowRenders.count - rendersBefore).toBeGreaterThan(0);
      await waitForQuietRows();

      // The same data in fresh objects, the way a store republish delivers it.
      rendersBefore = rowRenders.count;
      const buildsBefore = modelBuilds.count;
      const commitsBefore = inbox.commits();
      await mounted.rerender(
        inbox.tree({
          ...props,
          activeThreadKey: rowKey(1, 3),
          projects: projects(),
          environments: environments(),
          threads: [...props.threads],
          deliveryUnknownThreadKeys: new Set(),
          localQueuedThreadKeys: new Set(),
          pinnedThreadKeys: new Set(),
        }),
      );
      expect(modelBuilds.count).toBeGreaterThan(buildsBefore);
      expect(inbox.commits()).toBeGreaterThan(commitsBefore);
      expect(rowRenders.count - rendersBefore).toBe(0);

      // One thread's summary changes: exactly its row renders.
      rendersBefore = rowRenders.count;
      const renamed = props.threads.map((thread) =>
        thread.environmentId === ENVIRONMENT_IDS[0] && thread.id === "thread-40"
          ? { ...thread, title: "Renamed task" }
          : thread,
      );
      await mounted.rerender(
        inbox.tree({ ...props, activeThreadKey: rowKey(1, 3), threads: renamed }),
      );
      await expect.element(page.getByText("Renamed task", { exact: true })).toBeInTheDocument();
      expect(rowRenders.count - rendersBefore).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("opens the thread of the clicked row through the current callback", async () => {
    await page.viewport(1280, 900);
    const props = baseProps();
    const firstOpen = vi.fn();
    const secondOpen = vi.fn();
    const inbox = mountInbox({ ...props, onOpenThread: firstOpen });
    const mounted = await inbox.mount();
    try {
      await waitForQuietRows();
      await mounted.rerender(inbox.tree({ ...props, onOpenThread: secondOpen }));
      const row = document.querySelector<HTMLElement>(
        `[data-inbox-row-key="${rowKey(1, 5)}"] [data-testid="inbox-thread-row"]`,
      )!;
      row.click();
      expect(firstOpen).not.toHaveBeenCalled();
      expect(secondOpen).toHaveBeenCalledExactlyOnceWith(
        scopeThreadRef(ENVIRONMENT_IDS[1]!, ThreadId.make("thread-5")),
      );
    } finally {
      await mounted.unmount();
    }
  });
  it("keeps the menu actions of the connected inbox stable while the open thread moves", async () => {
    await page.viewport(1280, 900);
    const initial = baseProps();
    const threadActions = {
      archiveThread: vi.fn(),
      deleteThread: vi.fn(),
      stopThreadSession: vi.fn(),
      interruptThreadTurn: vi.fn(),
    };
    let showProps: (next: InboxSidebarProps) => void = () => undefined;
    function Host() {
      const [props, setProps] = useState(initial);
      useLayoutEffect(() => {
        showProps = setProps;
      }, []);
      return <ConnectedInboxSidebar {...props} {...threadActions} />;
    }
    const router = createRouter({
      routeTree: createRootRoute({ component: Host }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const mounted = await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
    );
    try {
      await expect
        .poll(() => document.querySelectorAll('[data-testid="inbox-thread-row"]').length)
        .toBe(ENVIRONMENT_IDS.length * ROWS_PER_ENVIRONMENT);
      await waitForQuietRows();

      const rendersBefore = rowRenders.count;
      await act(async () => showProps({ ...initial, activeThreadKey: rowKey(1, 3) }));
      expect(rowRenders.count - rendersBefore).toBeLessThanOrEqual(2);
      expect(rowRenders.count - rendersBefore).toBeGreaterThan(0);
    } finally {
      await mounted.unmount();
    }
  });
});
