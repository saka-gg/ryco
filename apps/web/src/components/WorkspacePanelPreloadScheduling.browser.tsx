import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

import type { RightPanelMode } from "../rightPanelRouteSearch";

const harness = vi.hoisted(() => ({
  iconResolver: vi.fn(),
  idleTasks: [] as Array<{ readonly run: () => void; readonly cancel: ReturnType<typeof vi.fn> }>,
}));

// The panel chunks stay stubs: the hints and idle preloads are observed
// through the files surface's synchronous icon lookup warm-up and the idle
// tasks the hook schedules.
vi.mock("./ThreadWorkspacePanel", () => ({ default: () => null }));
vi.mock("./DiffPanel", () => ({ default: () => null }));
vi.mock("./PreviewPanel", () => ({ default: () => null }));
vi.mock("./ThreadTerminalDrawer", () => ({ default: () => null }));
vi.mock("./device/SimulatorPanel", () => ({ default: () => null }));
vi.mock("./pullRequests/workspace/WorkspacePullRequestPanel", () => ({ default: () => null }));
vi.mock("../browser/LazyBrowserPanel", () => ({
  BrowserPanelChunk: { preload: () => Promise.resolve(), isLoaded: () => true },
}));
vi.mock("../lib/diffWorkerPool", () => ({ prewarmDiffWorkerPool: vi.fn() }));
vi.mock("../hooks/useVscodeIconUrl", () => ({
  preloadVscodeIconResolver: harness.iconResolver,
}));
vi.mock("../lib/idleTask", () => ({
  scheduleIdleTask: (run: () => void) => {
    const cancel = vi.fn();
    harness.idleTasks.push({ run, cancel });
    return cancel;
  },
}));

import { markStartupPhase, resetStartupPhasesForTests } from "../perf/startupInstrumentation";
import {
  preloadWorkspacePanelForIntent,
  setWorkspacePanelPreloadHint,
  useWorkspacePanelPreloadScheduling,
} from "../workspacePanelPreload";

interface SchedulingProps {
  readonly open: boolean;
  readonly panelMode: RightPanelMode | null;
  readonly enabled: boolean;
}

function renderScheduling(initialProps: SchedulingProps) {
  return renderHook((props: SchedulingProps = initialProps) =>
    useWorkspacePanelPreloadScheduling(props),
  );
}

/** Whether a hover on a control that opens the panel warms the files surface. */
function intentWarmsFiles(): boolean {
  harness.iconResolver.mockClear();
  preloadWorkspacePanelForIntent();
  return harness.iconResolver.mock.calls.length === 1;
}

describe("useWorkspacePanelPreloadScheduling", () => {
  beforeEach(() => {
    // The idle preload waits for the primary shell's paint (see the last test).
    markStartupPhase("primary-shell-painted");
  });

  afterEach(() => {
    setWorkspacePanelPreloadHint(null);
    harness.idleTasks.length = 0;
    harness.iconResolver.mockClear();
    resetStartupPhasesForTests();
  });

  it("hints the surface a closed panel reopens to and preloads it once idle", async () => {
    // The route view renders the hook in every layout that presents the panel,
    // the narrow-window sheet included.
    const hook = await renderScheduling({ open: false, panelMode: "files", enabled: true });

    expect(intentWarmsFiles()).toBe(true);
    expect(harness.idleTasks).toHaveLength(1);
    harness.iconResolver.mockClear();
    harness.idleTasks[0]?.run();
    expect(harness.iconResolver).toHaveBeenCalledOnce();

    await hook.unmount();
  });

  it("schedules the idle preload only while the panel is closed", async () => {
    const hook = await renderScheduling({ open: true, panelMode: "files", enabled: true });

    // An open panel still hints its surface for the controls that reopen it.
    expect(intentWarmsFiles()).toBe(true);
    expect(harness.idleTasks).toHaveLength(0);

    await hook.rerender({ open: false, panelMode: "files", enabled: true });
    expect(harness.idleTasks).toHaveLength(1);

    await hook.rerender({ open: true, panelMode: "files", enabled: true });
    expect(harness.idleTasks[0]?.cancel).toHaveBeenCalledOnce();
    expect(harness.idleTasks).toHaveLength(1);

    await hook.unmount();
  });

  it("neither hints nor preloads where no panel opens", async () => {
    const hook = await renderScheduling({ open: false, panelMode: "files", enabled: false });

    expect(intentWarmsFiles()).toBe(false);
    expect(harness.idleTasks).toHaveLength(0);

    await hook.unmount();
  });

  it("clears its hint on unmount unless a later view replaced it", async () => {
    const leaving = await renderScheduling({ open: false, panelMode: "files", enabled: true });
    await leaving.unmount();
    expect(intentWarmsFiles()).toBe(false);

    const previous = await renderScheduling({ open: false, panelMode: "review", enabled: true });
    const next = await renderScheduling({ open: false, panelMode: "files", enabled: true });
    await previous.unmount();
    expect(intentWarmsFiles()).toBe(true);

    await next.unmount();
    expect(intentWarmsFiles()).toBe(false);
  });

  it("schedules the idle preload only once the primary shell has painted", async () => {
    resetStartupPhasesForTests();
    const hook = await renderScheduling({ open: false, panelMode: "files", enabled: true });

    // The hover hint does not wait: it is an intent, not a speculative download.
    expect(intentWarmsFiles()).toBe(true);
    expect(harness.idleTasks).toHaveLength(0);

    markStartupPhase("primary-shell-painted");
    expect(harness.idleTasks).toHaveLength(1);
    harness.iconResolver.mockClear();
    harness.idleTasks[0]?.run();
    expect(harness.iconResolver).toHaveBeenCalledOnce();

    await hook.unmount();
  });
});
