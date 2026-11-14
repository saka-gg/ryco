import { ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const windows: Array<{
    setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    hide: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    webContents: { executeJavaScript: ReturnType<typeof vi.fn> };
  }> = [];
  const trays: Array<{ destroy: ReturnType<typeof vi.fn>; setToolTip: ReturnType<typeof vi.fn> }> =
    [];
  return { windows, trays, menu: vi.fn(), load: vi.fn(async () => {}) };
});
vi.mock("electron", () => ({
  BrowserWindow: class {
    hide = vi.fn();
    showInactive = vi.fn();
    destroy = vi.fn();
    isDestroyed = () => false;
    setBounds = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setContentProtection = vi.fn();
    loadURL = mocks.load;
    webContents = { executeJavaScript: vi.fn(async () => {}) };
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.windows.push(this);
    }
  },
  Tray: class {
    destroy = vi.fn();
    setToolTip = vi.fn();
    setTitle = vi.fn();
    setContextMenu = vi.fn();
    constructor() {
      mocks.trays.push(this);
    }
  },
  nativeImage: {
    createEmpty: () => ({
      addRepresentation: vi.fn(),
      setTemplateImage: vi.fn(),
      getSize: () => ({ width: 36, height: 36 }),
      toBitmap: () => Buffer.alloc(36 * 36 * 4),
    }),
    createFromBitmap: () => ({}),
  },
  Menu: { buildFromTemplate: mocks.menu },
  globalShortcut: { unregister: vi.fn(), isRegistered: () => false, register: () => true },
  screen: {
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } }),
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } }),
  },
}));
import { ComputerUseOverlay } from "./overlay.ts";
import { ComputerActivityIndicator } from "./activityIndicator.ts";

const activity = {
  threadId: ThreadId.make("test"),
  target: "Device Hub — iPhone 17",
  app: "Device Hub",
  mode: "background" as const,
  action: "observe",
};
const indicator = () => new ComputerActivityIndicator({ onStop: vi.fn() });
const badgeScripts = (index = 0) =>
  mocks.windows[index]!.webContents.executeJavaScript.mock.calls.map(([script]) =>
    String(script),
  ).filter((script) => script.includes("textContent="));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.windows.length = 0;
  mocks.trays.length = 0;
  mocks.load.mockImplementation(async () => {});
});
afterEach(() => vi.useRealTimers());

it("keeps a named capture indicator and Stop action between tool calls", async () => {
  const stop = vi.fn();
  const idle = vi.fn();
  const overlay = new ComputerUseOverlay(
    stop,
    idle,
    new ComputerActivityIndicator({ onStop: stop }),
  );
  await overlay.show(activity);
  expect(mocks.windows[0]!.options.focusable).toBe(false);
  if (process.platform === "darwin") {
    expect(mocks.windows[0]!.options.type).toBe("panel");
    expect(mocks.windows[0]!.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  }
  expect(mocks.trays[0]!.setToolTip).toHaveBeenCalledWith("Ryco is using Device Hub");
  const menu = mocks.menu.mock.calls[0]![0];
  expect(menu).toContainEqual({ label: "Ryco is using Device Hub", enabled: false });
  menu.find((item: { label: string }) => item.label === "Stop computer use").click();
  expect(stop).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(8000);
  expect(mocks.windows[0]!.hide).toHaveBeenCalled();
  expect(mocks.trays[0]!.destroy).not.toHaveBeenCalled();
  expect(idle).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(52000);
  expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
  expect(idle).toHaveBeenCalledOnce();
  overlay.dispose();
});

it("refreshes the existing indicator and clears it immediately on release", async () => {
  const idle = vi.fn();
  const overlay = new ComputerUseOverlay(vi.fn(), idle, indicator());
  await overlay.show(activity);
  await vi.advanceTimersByTimeAsync(59000);
  await overlay.show({ ...activity, target: "Notes", action: "type_text" });
  expect(mocks.trays).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(idle).not.toHaveBeenCalled();
  await overlay.show(null);
  expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(idle).not.toHaveBeenCalled();
  overlay.dispose();
});

it("cannot show a late-loading overlay after its display timeout or disposal", async () => {
  let loaded!: () => void;
  mocks.load.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        loaded = resolve;
      }),
  );
  const idle = vi.fn();
  const overlay = new ComputerUseOverlay(vi.fn(), idle, indicator());
  const showing = overlay.show(activity);
  await vi.advanceTimersByTimeAsync(8000);
  loaded();
  await showing;
  expect(mocks.windows[0]!.showInactive).not.toHaveBeenCalled();
  overlay.dispose();
  expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(idle).not.toHaveBeenCalled();
});

it("announces the app once, not each action, and fades the badge", async () => {
  const overlay = new ComputerUseOverlay(vi.fn(), vi.fn(), indicator());
  await overlay.show(activity);
  await overlay.show({ ...activity, action: "click" });
  await overlay.show({ ...activity, action: "type_text" });
  const announced = badgeScripts();
  expect(announced).toHaveLength(1);
  expect(announced[0]).toContain("Ryco is using Device Hub");
  expect(announced[0]).not.toContain("observe");
  expect(mocks.trays).toHaveLength(1);
  expect(mocks.menu).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5000);
  expect(
    mocks.windows[0]!.webContents.executeJavaScript.mock.calls.some(([script]) =>
      String(script).includes("classList.add('faded')"),
    ),
  ).toBe(true);
  await overlay.show({ ...activity, target: "Notes", app: "Notes", action: "type_text" });
  expect(badgeScripts().at(-1)).toContain("Ryco is using Notes");
  overlay.dispose();
});

it("still announces when a newer update supersedes one waiting for its window", async () => {
  let loaded!: () => void;
  mocks.load.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        loaded = resolve;
      }),
  );
  const overlay = new ComputerUseOverlay(vi.fn(), vi.fn(), indicator());
  const first = overlay.show(activity);
  const second = overlay.show({ ...activity, action: "click" });
  loaded();
  await Promise.all([first, second]);
  const announced = badgeScripts();
  expect(announced).toHaveLength(1);
  expect(announced[0]).toContain("Ryco is using Device Hub");
  expect(mocks.windows[0]!.showInactive).toHaveBeenCalledOnce();
  overlay.dispose();
});
