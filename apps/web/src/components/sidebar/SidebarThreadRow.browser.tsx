import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetGitStatusStateForTests } from "../../lib/gitStatusState";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { SidebarThreadRow, type SidebarThreadRowProps } from "./SidebarThreadRow";

const rpc = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  onStatus: vi.fn(),
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
    closeThread: async () => undefined,
    clearSelection: vi.fn(),
    commitRename: async () => undefined,
    cancelRename: vi.fn(),
    attemptArchiveThread: async () => undefined,
    openPrLink: vi.fn(),
  };
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
    resetGitStatusStateForTests();
    RowIntersectionObserver.observers.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shares visible cwd demand and retains it for an active offscreen row until deactivation", async () => {
    vi.stubGlobal("IntersectionObserver", RowIntersectionObserver);
    rpc.onStatus.mockImplementation(() => rpc.unsubscribe);
    const mounted = await render(<Rows />);
    try {
      expect(RowIntersectionObserver.observers.size).toBe(2);
      expect(rpc.onStatus).not.toHaveBeenCalled();

      RowIntersectionObserver.emit("first", true);
      await vi.waitFor(() => expect(rpc.onStatus).toHaveBeenCalledTimes(1));
      expect(rpc.onStatus.mock.calls[0]?.[0]).toMatchObject({ cwd: "/repo" });

      RowIntersectionObserver.emit("second", true);
      await flushVisibilityUpdates();
      expect(rpc.onStatus).toHaveBeenCalledTimes(1);
      RowIntersectionObserver.emit("first", false);
      await flushVisibilityUpdates();
      expect(rpc.unsubscribe).not.toHaveBeenCalled();

      await mounted.rerender(<Rows secondActive />);
      RowIntersectionObserver.emit("second", false);
      await flushVisibilityUpdates();
      expect(rpc.unsubscribe).not.toHaveBeenCalled();

      await mounted.rerender(<Rows />);
      await vi.waitFor(() => expect(rpc.unsubscribe).toHaveBeenCalledTimes(1));

      RowIntersectionObserver.emit("first", true);
      await vi.waitFor(() => expect(rpc.onStatus).toHaveBeenCalledTimes(2));
    } finally {
      await mounted.unmount();
    }
    expect(rpc.unsubscribe).toHaveBeenCalledTimes(2);
  });
});
