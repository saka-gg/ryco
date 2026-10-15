import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const loaded = vi.hoisted(() => ({
  modules: [] as string[],
  prewarm: vi.fn(),
  iconResolver: vi.fn(),
}));

vi.mock("./components/ThreadWorkspacePanel", () => {
  loaded.modules.push("ThreadWorkspacePanel");
  return { default: () => null };
});
vi.mock("./components/DiffPanel", () => {
  loaded.modules.push("DiffPanel");
  return { default: () => null };
});
vi.mock("./components/PreviewPanel", () => {
  loaded.modules.push("PreviewPanel");
  return { default: () => null };
});
vi.mock("./components/ThreadTerminalDrawer", () => {
  loaded.modules.push("ThreadTerminalDrawer");
  return { default: () => null };
});
vi.mock("./components/device/SimulatorPanel", () => {
  loaded.modules.push("SimulatorPanel");
  return { default: () => null };
});
vi.mock("./components/pullRequests/workspace/WorkspacePullRequestPanel", () => {
  loaded.modules.push("WorkspacePullRequestPanel");
  return { default: () => null };
});
vi.mock("./lib/diffWorkerPool", () => {
  loaded.modules.push("diffWorkerPool");
  return { prewarmDiffWorkerPool: loaded.prewarm };
});
vi.mock("./hooks/useVscodeIconUrl", () => ({
  preloadVscodeIconResolver: loaded.iconResolver,
}));

import {
  SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS,
  SHELL_IDLE_PRELOAD_START_CAP_MS,
} from "./lib/shellIdlePreload";
import { markStartupPhase, resetStartupPhasesForTests } from "./perf/startupInstrumentation";
import {
  LazyDiffPanel,
  LazyThreadTerminalDrawer,
  loadDiffPanel,
  loadThreadTerminalDrawer,
  preloadWorkspacePanel,
  preloadWorkspacePanelForIntent,
  scheduleIdleWorkspacePanelPreload,
  setWorkspacePanelPreloadHint,
  workspacePanelLoadingLabel,
} from "./workspacePanelPreload";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setWorkspacePanelPreloadHint(null);
  resetStartupPhasesForTests();
});

describe("workspace panel loaders", () => {
  it("share one request and report when the chunk resolved", async () => {
    expect(loadThreadTerminalDrawer.isLoaded()).toBe(false);
    const first = loadThreadTerminalDrawer();
    expect(loadThreadTerminalDrawer()).toBe(first);
    await first;
    expect(loadThreadTerminalDrawer.isLoaded()).toBe(true);
    expect(loaded.modules.filter((name) => name === "ThreadTerminalDrawer")).toHaveLength(1);
    // The rendered component is the same chunk: it renders without suspending.
    expect(LazyThreadTerminalDrawer.isLoaded()).toBe(true);
  });

  it("let a preload site warm the component a mount point renders", async () => {
    expect(LazyDiffPanel.isLoaded()).toBe(false);
    await loadDiffPanel();
    expect(LazyDiffPanel.isLoaded()).toBe(true);
    expect(loaded.modules.filter((name) => name === "DiffPanel")).toHaveLength(1);
  });
});

describe("workspacePanelLoadingLabel", () => {
  it("names the surface that is loading, and the workspace otherwise", () => {
    expect(workspacePanelLoadingLabel("review")).toBe("Loading diff viewer...");
    expect(workspacePanelLoadingLabel("terminal")).toBe("Loading terminal...");
    expect(workspacePanelLoadingLabel("browser")).toBe("Loading workspace...");
    expect(workspacePanelLoadingLabel(null)).toBe("Loading workspace...");
  });
});

describe("preloadWorkspacePanel", () => {
  it("loads the shell with the review surface, and only an intent warms the workers", async () => {
    preloadWorkspacePanel("review");
    await loadDiffPanel();
    await vi.waitFor(() => {
      expect(loaded.modules).toEqual(
        expect.arrayContaining(["ThreadWorkspacePanel", "DiffPanel", "diffWorkerPool"]),
      );
    });
    expect(loaded.prewarm).not.toHaveBeenCalled();

    setWorkspacePanelPreloadHint("review");
    preloadWorkspacePanelForIntent();
    await vi.waitFor(() => {
      expect(loaded.prewarm).toHaveBeenCalledTimes(1);
    });
  });

  it("warms the file icon lookup with the files surface", async () => {
    preloadWorkspacePanel("files");
    expect(loaded.iconResolver).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(loaded.modules).toContain("PreviewPanel");
    });
  });

  it("skips idle preloads when the browser asks to save data", () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const requestIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    markStartupPhase("primary-shell-painted");
    scheduleIdleWorkspacePanelPreload("simulator");
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(loaded.modules).not.toContain("SimulatorPanel");
  });

  it("skips idle preloads on a link slower than 4G, like the shell's speculative preloads", () => {
    vi.stubGlobal("navigator", { connection: { effectiveType: "3g" } });
    const requestIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    markStartupPhase("primary-shell-painted");
    scheduleIdleWorkspacePanelPreload("simulator");
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(loaded.modules).not.toContain("SimulatorPanel");
  });

  it("schedules nothing before the primary shell has painted", () => {
    const requestIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    const cancel = scheduleIdleWorkspacePanelPreload("files");
    expect(requestIdleCallback).not.toHaveBeenCalled();

    markStartupPhase("primary-shell-painted");
    expect(requestIdleCallback).toHaveBeenCalledOnce();
    cancel();
  });

  it("keeps the idle preload out of boot without requestIdleCallback (Safari)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    loaded.iconResolver.mockClear();
    scheduleIdleWorkspacePanelPreload("files");

    // The idle fallback is a short timeout; the shell's paint gates it.
    vi.advanceTimersByTime(SHELL_IDLE_PRELOAD_START_CAP_MS);
    expect(loaded.iconResolver).not.toHaveBeenCalled();

    markStartupPhase("primary-shell-painted");
    vi.advanceTimersToNextTimer();
    expect(loaded.iconResolver).toHaveBeenCalledOnce();
  });

  it("starts at the long start cap when the shell never paints", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    loaded.iconResolver.mockClear();
    scheduleIdleWorkspacePanelPreload("files");

    vi.advanceTimersByTime(SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS - 1);
    expect(loaded.iconResolver).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(loaded.iconResolver).toHaveBeenCalledOnce();
  });

  it("preloads on idle once the shell has painted", async () => {
    const requestIdleCallback = vi.fn((callback: () => void) => {
      callback();
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    markStartupPhase("primary-shell-painted");
    scheduleIdleWorkspacePanelPreload("pullRequest");
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 4_000 });
    await vi.waitFor(() => {
      expect(loaded.modules).toContain("WorkspacePullRequestPanel");
    });
  });
});
