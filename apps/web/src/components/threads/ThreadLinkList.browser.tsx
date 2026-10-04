import "../../index.css";

import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentsSection } from "../pullRequests/rail/AgentsSection";
import { ThreadLinkList } from "./ThreadLinkList";

const ENVIRONMENT_ID = EnvironmentId.make("thread-links-env");
const PROJECT_ID = ProjectId.make("thread-links-project");

function summary(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: `${id} title`,
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

async function mountWithRouter(content: ReactNode) {
  const root = createRootRoute({
    component: () => (
      <>
        {content}
        <Outlet />
      </>
    ),
  });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: () => <div data-testid="thread-route">Thread route</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, thread]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const mounted = await render(<RouterProvider router={router} />);
  await vi.waitFor(() => expect(router.state.status).toBe("idle"));
  return { router, mounted };
}

describe("ThreadLinkList", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders every rail row with its status glyph and title, and opens the thread", async () => {
    const threads = [
      summary("worker", { hasPendingApprovals: true }),
      summary("reviewer"),
      summary("tester"),
    ];
    const { router, mounted } = await mountWithRouter(
      <div data-testid="links">
        <ThreadLinkList threads={threads} tone="rail" />
      </div>,
    );
    try {
      const rows = [...document.querySelectorAll('[data-testid="links"] button')];
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("worker title"),
        expect.stringContaining("reviewer title"),
        expect.stringContaining("tester title"),
      ]);
      expect(
        rows.map((row) => row.querySelector('[role="img"]')?.getAttribute("aria-label")),
      ).toEqual(["Needs approval", "Idle", "Idle"]);

      (rows[1] as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/reviewer`),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the Agents band to its first row", async () => {
    const { mounted } = await mountWithRouter(
      <AgentsSection layout="band" threads={[summary("first"), summary("second")]} />,
    );
    try {
      const section = document.querySelector('section[aria-label="Agents"]')!;
      expect([...section.querySelectorAll("button")].map((row) => row.textContent)).toEqual([
        expect.stringContaining("first title"),
      ]);
      expect(section.textContent).not.toContain("Agents");
    } finally {
      await mounted.unmount();
    }
  });
});
