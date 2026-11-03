import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  applyProvidersUpdated,
  resetServerStateForTests,
  setServerConfigSnapshot,
} from "../rpc/serverState";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { setModelPickerOpen } from "../modelPickerOpenState";
import Sidebar from "./Sidebar";
import { preloadSidebarUpdateEverythingPill } from "./sidebar/SidebarChrome";
import { CommandDialog } from "./ui/command";
import { SidebarProvider } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

// Counts the project-tree traversal derivations (see the inbox-mode test).
const traversalCalls = vi.hoisted(() => ({ collect: 0, sort: 0 }));
vi.mock("./sidebar/sidebarVisibleThreadKeys", async (original) => {
  const actual = await original<typeof import("./sidebar/sidebarVisibleThreadKeys")>();
  return {
    ...actual,
    collectSidebarVisibleThreadKeys: (
      input: Parameters<typeof actual.collectSidebarVisibleThreadKeys>[0],
    ) => {
      traversalCalls.collect += 1;
      return actual.collectSidebarVisibleThreadKeys(input);
    },
    sortSidebarProjects: (input: Parameters<typeof actual.sortSidebarProjects>[0]) => {
      traversalCalls.sort += 1;
      return actual.sortSidebarProjects(input);
    },
  };
});
// Counts inbox model builds (see the provider-status test).
const inboxModelBuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock("./inboxSidebar/inboxSidebarModel", async (original) => {
  const actual = await original<typeof import("./inboxSidebar/inboxSidebarModel")>();
  return {
    ...actual,
    buildInboxSidebarModel: (input: Parameters<typeof actual.buildInboxSidebarModel>[0]) => {
      inboxModelBuilds.count += 1;
      return actual.buildInboxSidebarModel(input);
    },
  };
});
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

function mountSidebar() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <CommandDialog open={false}>
          <Sidebar />
        </CommandDialog>
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
  );
}

function makeServerConfig(providers: ReadonlyArray<ServerProvider>): ServerConfig {
  return {
    environment: {
      environmentId,
      label: "Local",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, threadSettlement: false },
    },
    cwd: "/repo",
    keybindings: [],
    issues: [],
    providers,
    availableEditors: [],
    settings: DEFAULT_SERVER_SETTINGS,
  } as unknown as ServerConfig;
}

/** Rows on a machine that is not connected are not current, so nothing on it needs you. */
function connectEnvironment() {
  useSavedEnvironmentRuntimeStore
    .getState()
    .patch(environmentId, { connectionState: "connected", role: "owner" });
}

/** ⌥⌘A, or Ctrl+Alt+A off macOS: the next thread that needs you. */
function pressAttentionShortcut(target: EventTarget): boolean {
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  return target.dispatchEvent(
    new KeyboardEvent("keydown", {
      // Option+A types "å" on macOS; the binding matches the physical key.
      key: mac ? "å" : "a",
      code: "KeyA",
      metaKey: mac,
      ctrlKey: !mac,
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("Sidebar render cost", () => {
  // The footer's update pill arrives in an idle slot after the first mount; loaded up
  // front it mounts with the sidebar, so its one-time arrival is not counted as a re-render.
  beforeAll(() => preloadSidebarUpdateEverythingPill());

  afterEach(() => {
    renderCounts.clear();
    traversalCalls.collect = 0;
    traversalCalls.sort = 0;
    inboxModelBuilds.count = 0;
    resetServerStateForTests();
    useSavedEnvironmentRuntimeStore.getState().reset();
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

  it("derives the project tree in inbox mode only when a thread shortcut needs it", async () => {
    await page.viewport(1280, 900);
    useUiStateStore.getState().setSidebarMode("inbox");
    useStore.getState().syncServerShellSnapshot(makeSnapshot(), environmentId);

    const mounted = await mountSidebar();
    try {
      await expect.element(page.getByText("Thread 1999", { exact: true })).toBeInTheDocument();
      await waitForQuiescence(() => renderCounts.get("Sidebar") ?? 0);
      // The hidden project tree is never built while the inbox shows.
      expect(traversalCalls.sort).toBe(0);
      expect(traversalCalls.collect).toBe(0);

      // A jump shortcut still follows the project tree's order: the most
      // recently active project's newest thread comes first.
      const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          code: "Digit1",
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() =>
        expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(
          scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make("thread-1999"))),
        ),
      );
      expect(traversalCalls.collect).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("opens the threads that need you in turn while typing", async () => {
    await page.viewport(1280, 900);
    useUiStateStore.getState().setSidebarMode("inbox");
    const snapshot = makeSnapshot();
    const threads = snapshot.threads as unknown as Array<Record<string, unknown>>;
    // One thread waits for an approval, another just finished a turn nobody has seen.
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    threads[5] = { ...threads[5], hasPendingApprovals: true };
    threads[6] = {
      ...threads[6],
      latestTurn: {
        turnId: TurnId.make("turn-done"),
        state: "completed",
        requestedAt: finishedAt,
        startedAt: finishedAt,
        completedAt: finishedAt,
        assistantMessageId: null,
      },
    };
    useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
    connectEnvironment();
    const addToast = vi.spyOn(toastManager, "add");

    const mounted = await mountSidebar();
    const composer = document.createElement("textarea");
    try {
      await expect.element(page.getByText("Thread 1999", { exact: true })).toBeInTheDocument();
      await waitForQuiescence(() => renderCounts.get("Sidebar") ?? 0);
      // The walk builds its own inbox model when pressed.
      const buildsBeforePress = inboxModelBuilds.count;

      document.body.append(composer);
      composer.focus();
      const anchorOf = (id: string) =>
        scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
      const expectAnchor = (id: string) =>
        vi.waitFor(() =>
          expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(anchorOf(id)),
        );

      expect(pressAttentionShortcut(composer)).toBe(false);
      await expectAnchor("thread-5");
      expect(inboxModelBuilds.count).toBeGreaterThan(buildsBeforePress);
      // The route here never commits: each press goes on from the last target.
      pressAttentionShortcut(composer);
      await expectAnchor("thread-6");
      pressAttentionShortcut(composer);
      await expectAnchor("thread-5");
      expect(addToast).not.toHaveBeenCalled();
    } finally {
      composer.remove();
      addToast.mockRestore();
      await mounted.unmount();
    }
  });

  it("says so when no thread needs you", async () => {
    await page.viewport(1280, 900);
    useUiStateStore.getState().setSidebarMode("inbox");
    useStore.getState().syncServerShellSnapshot(makeSnapshot(), environmentId);
    connectEnvironment();
    const addToast = vi.spyOn(toastManager, "add");

    const mounted = await mountSidebar();
    try {
      await expect.element(page.getByText("Thread 1999", { exact: true })).toBeInTheDocument();
      const anchorBeforePress = useThreadSelectionStore.getState().anchorThreadKey;
      pressAttentionShortcut(window);
      await vi.waitFor(() =>
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: "info", title: "No other thread needs you right now" }),
        ),
      );
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(anchorBeforePress);
    } finally {
      addToast.mockRestore();
      await mounted.unmount();
    }
  });

  it("does not rebuild the inbox model on status-only provider pushes", async () => {
    await page.viewport(1280, 900);
    useUiStateStore.getState().setSidebarMode("inbox");
    useStore.getState().syncServerShellSnapshot(makeSnapshot(), environmentId);
    const models = [{ slug: "gpt-5.4", name: "GPT-5.4" }] as unknown as ServerProvider["models"];
    const provider = (status: string, nextModels = models) =>
      ({
        instanceId: "codex",
        driver: "codex",
        status,
        models: nextModels,
      }) as unknown as ServerProvider;
    setServerConfigSnapshot(makeServerConfig([provider("ready")]));

    const mounted = await mountSidebar();
    try {
      await expect.element(page.getByText("Thread 1999", { exact: true })).toBeInTheDocument();
      await waitForQuiescence(() => renderCounts.get("Sidebar") ?? 0);
      const buildsAfterMount = inboxModelBuilds.count;
      expect(buildsAfterMount).toBeGreaterThan(0);

      // Provider status pushes keep every model catalog: the inbox environments,
      // and with them the inbox model, are not rebuilt.
      applyProvidersUpdated({ providers: [provider("checking")] });
      applyProvidersUpdated({ providers: [provider("error")] });
      await waitForQuiescence(() => renderCounts.get("Sidebar") ?? 0);
      expect(inboxModelBuilds.count).toBe(buildsAfterMount);

      // A new model catalog does rebuild it.
      applyProvidersUpdated({
        providers: [
          provider("ready", [...models, { slug: "gpt-5.5", name: "GPT-5.5" }] as typeof models),
        ],
      });
      await vi.waitFor(() => expect(inboxModelBuilds.count).toBeGreaterThan(buildsAfterMount));
    } finally {
      await mounted.unmount();
    }
  });
});
