import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { DraftId } from "../../composerDraftStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetGitStatusStateForTests } from "../../lib/gitStatusState";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { SidebarThreadRow, type SidebarThreadRowProps } from "./SidebarThreadRow";
import { SOURCE_CONTROL_VISIBILITY_HYSTERESIS } from "./hooks/useHasIntersectedViewport";

const rpc = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  onStatus: vi.fn(),
}));
const intent = vi.hoisted(() => ({
  hover: vi.fn(),
  hoverEnd: vi.fn(),
  press: vi.fn(),
  draft: vi.fn(),
}));

vi.mock("./threadNavigationIntent", async () => ({
  isNavigationPress: (await import("./threadNavigationIntent.logic")).isNavigationPress,
  noteThreadHoverIntent: intent.hover,
  noteThreadHoverEnd: intent.hoverEnd,
  noteThreadPressIntent: intent.press,
  preloadDraftRoute: intent.draft,
}));

vi.mock("../../environments/runtime/service", () => ({
  readEnvironmentConnection: () => ({
    environmentId: "row-visibility-environment",
    client: { vcs: { onStatus: rpc.onStatus } },
  }),
  subscribeEnvironmentConnections: () => () => undefined,
  getPrimaryEnvironmentConnection: () => null,
  listEnvironmentConnections: () => [],
  addSavedEnvironment: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  connectDesktopWorkspaceEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: vi.fn(),
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(),
  resetEnvironmentServiceForTests: vi.fn(),
  startEnvironmentConnectionService: vi.fn(),
  updateEnvironmentServerSettings: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector(DEFAULT_UNIFIED_SETTINGS),
}));

class RowIntersectionObserver {
  static observers = new Map<Element, RowIntersectionObserver>();
  private target: Element | null = null;

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element): void {
    this.target = target;
    RowIntersectionObserver.observers.set(target, this);
  }

  unobserve(target: Element): void {
    RowIntersectionObserver.observers.delete(target);
  }

  disconnect(): void {
    if (this.target) RowIntersectionObserver.observers.delete(this.target);
    this.target = null;
  }

  static emit(threadId: string, isIntersecting: boolean): void {
    const row = document.querySelector(`[data-testid="thread-row-${threadId}"]`);
    const target = row?.closest("[data-thread-item]");
    const observer = target ? this.observers.get(target) : undefined;
    if (!observer || !target) throw new Error(`Thread ${threadId} has no observed row.`);
    observer.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  }
}

const environmentId = EnvironmentId.make("row-visibility-environment");

function rowProps(id: string, isActive = false): SidebarThreadRowProps {
  return {
    thread: {
      id: ThreadId.make(id),
      environmentId,
      projectId: ProjectId.make("project-1"),
      title: id,
      interactionMode: DEFAULT_INTERACTION_MODE,
      session: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-05-01T00:00:00.000Z",
      latestTurn: null,
      branch: "main",
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      manualStatusBucket: null,
    },
    projectCwd: "/repo",
    gitStatusTarget: { environmentId, cwd: "/repo" },
    orderedProjectThreadKeys: [],
    isActive,
    jumpLabel: null,
    appSettingsConfirmThreadArchive: false,
    renamingThreadKey: null,
    renamingTitle: "",
    setRenamingTitle: vi.fn(),
    startThreadRename: vi.fn(),
    renamingInputRef: { current: null },
    renamingCommittedRef: { current: false },
    confirmingArchiveThreadKey: null,
    setConfirmingArchiveThreadKey: vi.fn(),
    confirmArchiveButtonRefs: { current: new Map() },
    handleThreadClick: vi.fn(),
    navigateToThread: vi.fn(),
    navigateToDraft: vi.fn(),
    handleMultiSelectContextMenu: async () => undefined,
    handleThreadContextMenu: async () => undefined,
    requestTrashThread: async () => undefined,
    clearSelection: vi.fn(),
    commitRename: async () => undefined,
    cancelRename: vi.fn(),
    attemptArchiveThread: async () => undefined,
    openPrLink: vi.fn(),
  };
}

function IntentRows() {
  const draftRow = rowProps("draft-row");
  return (
    <AppAtomRegistryProvider>
      <ul>
        <SidebarThreadRow {...rowProps("idle")} gitStatusTarget={null} />
        <SidebarThreadRow {...rowProps("open", true)} gitStatusTarget={null} />
        <SidebarThreadRow
          {...draftRow}
          thread={{ ...draftRow.thread, draftId: DraftId.make("draft-1") }}
          gitStatusTarget={null}
        />
      </ul>
    </AppAtomRegistryProvider>
  );
}

function Rows({ secondActive = false }: { secondActive?: boolean }) {
  return (
    <AppAtomRegistryProvider>
      <ul>
        <SidebarThreadRow {...rowProps("first")} />
        <SidebarThreadRow {...rowProps("second", secondActive)} />
      </ul>
    </AppAtomRegistryProvider>
  );
}

async function flushVisibilityUpdates() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

describe("SidebarThreadRow git status demand", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetGitStatusStateForTests();
    RowIntersectionObserver.observers.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shares visible cwd demand and retains it for an active offscreen row until deactivation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("IntersectionObserver", RowIntersectionObserver);
    rpc.onStatus.mockImplementation(() => rpc.unsubscribe);
    const mounted = await render(<Rows />);
    try {
      expect(RowIntersectionObserver.observers.size).toBe(2);
      expect(rpc.onStatus).not.toHaveBeenCalled();

      RowIntersectionObserver.emit("first", true);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.enterDelayMs);
      await vi.waitFor(() => expect(rpc.onStatus).toHaveBeenCalledTimes(1));
      // Rows ask only for the badge summary, never full status.
      expect(rpc.onStatus.mock.calls[0]?.[0]).toMatchObject({ cwd: "/repo", view: "summary" });

      RowIntersectionObserver.emit("second", true);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.enterDelayMs);
      await flushVisibilityUpdates();
      expect(rpc.onStatus).toHaveBeenCalledTimes(1);
      RowIntersectionObserver.emit("first", false);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.exitDelayMs);
      await flushVisibilityUpdates();
      expect(rpc.unsubscribe).not.toHaveBeenCalled();

      await mounted.rerender(<Rows secondActive />);
      RowIntersectionObserver.emit("second", false);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.exitDelayMs);
      await flushVisibilityUpdates();
      expect(rpc.unsubscribe).not.toHaveBeenCalled();

      await mounted.rerender(<Rows />);
      await vi.waitFor(() => expect(rpc.unsubscribe).toHaveBeenCalledTimes(1));

      RowIntersectionObserver.emit("first", true);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.enterDelayMs);
      await vi.waitFor(() => expect(rpc.onStatus).toHaveBeenCalledTimes(2));
    } finally {
      await mounted.unmount();
    }
    expect(rpc.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("keeps a row's stream through a brief scroll-out and never subscribes on a fling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("IntersectionObserver", RowIntersectionObserver);
    rpc.onStatus.mockImplementation(() => rpc.unsubscribe);
    const mounted = await render(<Rows />);
    try {
      // Fling: in and out again before the enter delay elapses.
      RowIntersectionObserver.emit("first", true);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.enterDelayMs - 50);
      RowIntersectionObserver.emit("first", false);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.enterDelayMs);
      await flushVisibilityUpdates();
      expect(rpc.onStatus).not.toHaveBeenCalled();

      RowIntersectionObserver.emit("first", true);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.enterDelayMs);
      await vi.waitFor(() => expect(rpc.onStatus).toHaveBeenCalledTimes(1));

      // Scrolled out and back within the retention window: same stream.
      RowIntersectionObserver.emit("first", false);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.exitDelayMs / 2);
      RowIntersectionObserver.emit("first", true);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.exitDelayMs);
      await flushVisibilityUpdates();
      expect(rpc.unsubscribe).not.toHaveBeenCalled();
      expect(rpc.onStatus).toHaveBeenCalledTimes(1);

      // Out for the whole window: the stream is released.
      RowIntersectionObserver.emit("first", false);
      vi.advanceTimersByTime(SOURCE_CONTROL_VISIBILITY_HYSTERESIS.exitDelayMs);
      await vi.waitFor(() => expect(rpc.unsubscribe).toHaveBeenCalledTimes(1));
    } finally {
      await mounted.unmount();
    }
  });
});

describe("SidebarThreadRow navigation intent", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  const rowButton = (id: string) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="thread-row-${id}"]`);
    if (!element) throw new Error(`No row ${id}`);
    return element;
  };

  it("warms an idle thread on hover and retains it on a navigating press", async () => {
    const mounted = await render(<IntentRows />);
    try {
      await userEvent.hover(rowButton("idle"));
      await vi.waitFor(() =>
        expect(intent.hover).toHaveBeenCalledWith({ environmentId, threadId: "idle" }),
      );
      await userEvent.click(rowButton("idle"));
      expect(intent.press).toHaveBeenCalledExactlyOnceWith({ environmentId, threadId: "idle" });
      await userEvent.unhover(rowButton("idle"));
      await vi.waitFor(() =>
        expect(intent.hoverEnd).toHaveBeenCalledWith({ environmentId, threadId: "idle" }),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("ignores selection presses and the thread already open", async () => {
    const mounted = await render(<IntentRows />);
    try {
      await userEvent.keyboard("{Shift>}");
      await userEvent.click(rowButton("idle"));
      await userEvent.keyboard("{/Shift}");
      expect(intent.press).not.toHaveBeenCalled();

      await userEvent.hover(rowButton("open"));
      await userEvent.click(rowButton("open"));
      expect(intent.hover).not.toHaveBeenCalledWith({ environmentId, threadId: "open" });
      expect(intent.press).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("warms only the draft route for a draft row", async () => {
    const mounted = await render(<IntentRows />);
    try {
      await userEvent.hover(rowButton("draft-row"));
      await vi.waitFor(() => expect(intent.draft).toHaveBeenCalled());
      await userEvent.click(rowButton("draft-row"));
      expect(intent.hover).not.toHaveBeenCalledWith({ environmentId, threadId: "draft-row" });
      expect(intent.press).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
