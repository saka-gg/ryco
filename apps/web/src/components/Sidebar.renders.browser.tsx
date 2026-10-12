import "../index.css";

import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { setModelPickerOpen } from "../modelPickerOpenState";
import Sidebar from "./Sidebar";
import { CommandDialog } from "./ui/command";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("./sidebar/hooks/useSidebarThreadPrewarm", () => ({
  useSidebarThreadPrewarm: () => undefined,
}));
// Every Sidebar render calls `usePerfMark("Sidebar")`: count the function
// body itself, separately from the Profiler's subtree commits.
const renderCounts = vi.hoisted(() => new Map<string, number>());
vi.mock("../perf/tabSwitchInstrumentation", async (original) => {
  const actual = await original<typeof import("../perf/tabSwitchInstrumentation")>();
  return {
    ...actual,
    usePerfMark: (label: string) => {
      renderCounts.set(label, (renderCounts.get(label) ?? 0) + 1);
    },
  };
});

const environmentId = EnvironmentId.make("sidebar-render-environment");
const PROJECT_COUNT = 30;
const THREAD_COUNT = 2_000;

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

function makeDeltaEvent(sequence: number, threadId: ThreadId): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-10-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make(`message-${sequence}`),
      role: "assistant",
      text: `delta ${sequence}`,
      turnId: TurnId.make("turn-1"),
      streaming: true,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  } as unknown as OrchestrationEvent;
}

async function nextFrames() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Mount-time work settles (row visibility delays, motion gate) before counting. */
async function waitForQuiescence(readCommits: () => number) {
  let last = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = readCommits();
    if (current === last) return;
    last = current;
  }
  throw new Error("The sidebar never stopped committing.");
}

describe("Sidebar render cost", () => {
  afterEach(() => {
    renderCounts.clear();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    setModelPickerOpen(false);
    document.body.innerHTML = "";
  });

  it("does not re-render for streaming thread-detail events or model picker toggles", async () => {
    await page.viewport(1280, 900);
    useUiStateStore.getState().setSidebarMode("projects");
    useStore.getState().syncServerShellSnapshot(makeSnapshot(), environmentId);

    let sidebarCommits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
      sidebarCommits += 1;
    };
    const rootRoute = createRootRoute({
      component: () => (
        <SidebarProvider>
          {/* The sidebar's search trigger belongs to the command palette dialog. */}
          <CommandDialog open={false}>
            <Profiler id="sidebar" onRender={onRender}>
              <Sidebar />
            </Profiler>
          </CommandDialog>
        </SidebarProvider>
      ),
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
    try {
      await expect.element(page.getByText("Project 0", { exact: true })).toBeInTheDocument();
      await waitForQuiescence(() => sidebarCommits);
      const commitsAfterMount = sidebarCommits;
      const sidebarRendersAfterMount = renderCounts.get("Sidebar") ?? 0;
      expect(sidebarRendersAfterMount).toBeGreaterThan(0);

      // Streaming deltas for a thread change only thread-detail state.
      const streamingThread = ThreadId.make("thread-7");
      for (let sequence = 2; sequence < 32; sequence += 1) {
        useStore
          .getState()
          .applyOrchestrationEvents([makeDeltaEvent(sequence, streamingThread)], environmentId);
      }
      await nextFrames();
      expect(renderCounts.get("Sidebar")).toBe(sidebarRendersAfterMount);
      expect(sidebarCommits - commitsAfterMount).toBe(0);

      // Opening and closing the model picker no longer re-renders the Sidebar;
      // only the jump-hint leaf that owns that subscription updates.
      setModelPickerOpen(true);
      await nextFrames();
      setModelPickerOpen(false);
      await nextFrames();
      expect(renderCounts.get("Sidebar")).toBe(sidebarRendersAfterMount);
    } finally {
      await mounted.unmount();
    }
  });
});
