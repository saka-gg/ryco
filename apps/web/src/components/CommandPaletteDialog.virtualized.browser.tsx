import "../index.css";

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { useStore } from "../store";
import { COMMAND_PALETTE_VIRTUALIZE_AFTER_ITEMS } from "./CommandPalette.logic";
import { CommandPaletteDialog } from "./CommandPaletteDialog";
import { CommandDialog } from "./ui/command";

const environmentId = EnvironmentId.make("palette-environment");
const PROJECT_COUNT = 20;
const THREAD_COUNT = 2_400;
const PLACEHOLDER = "Search commands, projects, and threads...";

function makeSnapshot(): OrchestrationShellSnapshot {
  const projects = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
    id: ProjectId.make(`project-${index}`),
    title: `Project ${index}`,
    workspaceRoot: `/tmp/project-${index}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }));
  const threads = Array.from({ length: THREAD_COUNT }, (_, index) => ({
    id: ThreadId.make(`thread-${index}`),
    projectId: ProjectId.make(`project-${index % PROJECT_COUNT}`),
    title: `Thread ${index}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    // Newest first: thread 2399 lists first, thread 0 last.
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }));
  return {
    snapshotSequence: 1,
    projects,
    worktrees: [],
    threads,
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
}

async function mountPalette() {
  const rootRoute = createRootRoute({
    component: () => {
      const open = useCommandPaletteStore((store) => store.open);
      return (
        <CommandDialog open={open}>
          <CommandPaletteDialog />
        </CommandDialog>
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const mounted = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
  );
  return { mounted, router };
}

const palette = () => document.querySelector<HTMLElement>('[data-testid="command-palette"]');
const options = () => [...(palette()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
const titleOf = (option: HTMLElement | null) =>
  option?.querySelector("span.truncate")?.textContent ?? null;
/** The option whose title is exactly `title` ("Thread 1" must not find "Thread 10"). */
const optionTitled = (title: string) =>
  options().find((option) => titleOf(option) === title) ?? null;
/** The row the palette shows as highlighted (it styles the active row itself). */
const activeOption = () =>
  options().find((option) => option.className.includes("bg-accent!")) ?? null;
const activeTitle = () => titleOf(activeOption());
const scroller = () => {
  const node = palette()?.querySelector('[role="listbox"]')?.firstElementChild;
  return node instanceof HTMLElement ? node : null;
};
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function openAndSearch(query: string) {
  useCommandPaletteStore.getState().setOpen(true);
  const input = page.getByPlaceholder(PLACEHOLDER);
  await expect.element(input).toBeInTheDocument();
  await input.fill(query);
  // Searching drops the root view's recent threads for the full thread list.
  await expect.element(page.getByText("Recent Threads", { exact: true })).not.toBeInTheDocument();
  await expect.poll(() => options().length).toBeGreaterThan(5);
}

function isWithinScroller(element: HTMLElement) {
  const viewport = scroller()!.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
}

async function scrollListTo(top: number) {
  const list = scroller()!;
  list.scrollTop = top;
  list.dispatchEvent(new Event("scroll"));
  await nextFrame();
}

describe("CommandPaletteDialog with thousands of threads", () => {
  afterEach(() => {
    useCommandPaletteStore.getState().setOpen(false);
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    document.body.innerHTML = "";
  });

  it("mounts only the rows in view for a one-letter query, with group headings", async () => {
    await page.viewport(1280, 900);
    useStore.getState().syncServerShellSnapshot(makeSnapshot(), environmentId);
    const { mounted } = await mountPalette();
    try {
      // The root view stays a plain grouped list.
      useCommandPaletteStore.getState().setOpen(true);
      await expect.element(page.getByText("Recent Threads", { exact: true })).toBeInTheDocument();
      expect(palette()!.querySelectorAll('[role="group"]').length).toBeGreaterThan(0);

      await openAndSearch("t");
      // Every thread matches "t"; only a window of them mounts.
      expect(options().length).toBeLessThan(COMMAND_PALETTE_VIRTUALIZE_AFTER_ITEMS);
      expect(optionTitled("Thread 0")).toBeNull();
      await expect.element(page.getByText("Actions", { exact: true })).toBeInTheDocument();
      // The first row is highlighted, and the input points at it.
      await expect.poll(() => activeOption()?.id).toBeTruthy();
      expect(palette()!.querySelector("input")!.getAttribute("aria-activedescendant")).toBe(
        activeOption()!.id,
      );

      // Assistive technology hears the whole count, not the mounted window.
      const setSize = Number(options()[0]!.getAttribute("aria-setsize"));
      expect(setSize).toBeGreaterThan(COMMAND_PALETTE_VIRTUALIZE_AFTER_ITEMS * 10);
      expect(options()[0]!.getAttribute("aria-posinset")).toBe("1");

      // Scrolling far down brings later rows in, still windowed.
      await scrollListTo(scroller()!.scrollHeight / 2);
      await expect
        .poll(() => options().filter((option) => option.textContent?.startsWith("Thread")).length)
        .toBeGreaterThan(5);
      expect(options().length).toBeLessThan(COMMAND_PALETTE_VIRTUALIZE_AFTER_ITEMS);
      const later = options().find((option) => option.textContent?.startsWith("Thread"))!;
      expect(Number(later.getAttribute("aria-posinset"))).toBeGreaterThan(20);
      expect(Number(later.getAttribute("aria-setsize"))).toBe(setSize);

      // Typing on returns a long list to its top, where the new first row is highlighted.
      await page.getByPlaceholder(PLACEHOLDER).fill("th");
      await expect.poll(() => scroller()!.scrollTop).toBe(0);
      await expect
        .poll(() => activeOption() !== null && isWithinScroller(activeOption()!))
        .toBe(true);

      // Narrowing the query back under the threshold returns to the grouped list.
      await page.getByPlaceholder(PLACEHOLDER).fill("Thread 2399");
      await expect.poll(() => palette()!.querySelectorAll('[role="group"]').length).toBe(1);
      expect(options().map(titleOf)).toEqual(["Thread 2399"]);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the keyboard highlight in view and runs it on Enter after it unmounts", async () => {
    await page.viewport(1280, 900);
    useStore.getState().syncServerShellSnapshot(makeSnapshot(), environmentId);
    const { mounted, router } = await mountPalette();
    try {
      // Only threads match: the exact title first, then Thread 1999 … 1000, 199 … 100, 19 … 10.
      await openAndSearch("Thread 1");
      await expect.poll(activeTitle).toBe("Thread 1");

      // Arrow keys move the highlight down the list and keep it in view.
      for (let step = 0; step < 30; step += 1) {
        await userEvent.keyboard("{ArrowDown}");
      }
      await expect.poll(() => scroller()!.scrollTop).toBeGreaterThan(0);
      expect(isWithinScroller(activeOption()!)).toBe(true);

      // Back on the first item, ArrowUp wraps to the last thread, far below the window.
      for (let step = 0; step < 31; step += 1) {
        await userEvent.keyboard("{ArrowUp}");
      }
      await expect.poll(activeTitle).toBe("Thread 10");
      await expect.poll(() => isWithinScroller(optionTitled("Thread 10")!)).toBe(true);

      // Scrolled back to the top, the highlighted row unmounts; Enter still runs it.
      await scrollListTo(0);
      await expect.poll(() => optionTitled("Thread 10")).toBeNull();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => router.state.location.pathname).toBe(`/${environmentId}/thread-10`);
      expect(useCommandPaletteStore.getState().open).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it("highlights the row under the pointer and runs a clicked row", async () => {
    await page.viewport(1280, 900);
    useStore.getState().syncServerShellSnapshot(makeSnapshot(), environmentId);
    const { mounted, router } = await mountPalette();
    try {
      await openAndSearch("Thread 1");
      const target = page.getByRole("option", { name: /Thread 1995/ });
      await target.hover();
      await expect.poll(activeTitle).toBe("Thread 1995");
      await target.click();
      await expect.poll(() => router.state.location.pathname).toBe(`/${environmentId}/thread-1995`);
    } finally {
      await mounted.unmount();
    }
  });
});
