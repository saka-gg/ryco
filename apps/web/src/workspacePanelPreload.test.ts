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
  vi.unstubAllGlobals();
  setWorkspacePanelPreloadHint(null);
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
    scheduleIdleWorkspacePanelPreload("simulator");
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(loaded.modules).not.toContain("SimulatorPanel");
  });

  it("skips idle preloads on a link slower than 4G, like the shell's speculative preloads", () => {
    vi.stubGlobal("navigator", { connection: { effectiveType: "3g" } });
    const requestIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    scheduleIdleWorkspacePanelPreload("simulator");
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(loaded.modules).not.toContain("SimulatorPanel");
  });

  it("preloads on idle otherwise", async () => {
    const requestIdleCallback = vi.fn((callback: () => void) => {
      callback();
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    scheduleIdleWorkspacePanelPreload("pullRequest");
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 4_000 });
    await vi.waitFor(() => {
      expect(loaded.modules).toContain("WorkspacePullRequestPanel");
    });
  });
});
