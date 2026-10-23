import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopWindowStateStore,
  DESKTOP_WINDOW_DEFAULT_SIZE,
  type DesktopWindowBounds,
  type DesktopWindowStateTarget,
  isWindowPositionUnreported,
  parseDesktopWindowState,
  type PersistedDesktopWindowState,
  readDesktopWindowState,
  resolveRestoredDesktopWindowState,
  resolveVisibleWindowBounds,
  writeDesktopWindowState,
} from "./windowState.ts";

const directories: string[] = [];

function makeTempDir(): string {
  const directory = FS.mkdtempSync(join(tmpdir(), "ryco-window-state-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

const primary: DesktopWindowBounds = { x: 0, y: 25, width: 1440, height: 875 };

function savedState(bounds: DesktopWindowBounds, isMaximized = false): PersistedDesktopWindowState {
  return { version: 1, bounds, isMaximized };
}

describe("parseDesktopWindowState", () => {
  it("accepts a v1 state, ignoring extra keys", () => {
    const state = savedState({ x: -1920, y: 64, width: 1280, height: 860 }, true);
    expect(parseDesktopWindowState(state)).toEqual(state);
    expect(
      parseDesktopWindowState({ ...state, extra: 1, bounds: { ...state.bounds, z: 3 } }),
    ).toEqual(state);
  });

  it("rejects anything else", () => {
    const bounds = { x: 1, y: 2, width: 1000, height: 700 };
    for (const value of [
      { version: 2, bounds, isMaximized: false },
      { version: 1, bounds: { ...bounds, x: 1.5 }, isMaximized: false },
      { version: 1, bounds: { ...bounds, y: Number.NaN }, isMaximized: false },
      { version: 1, bounds: { ...bounds, x: 100_001 }, isMaximized: false },
      { version: 1, bounds: { ...bounds, width: 0 }, isMaximized: false },
      { version: 1, bounds: { ...bounds, height: 100_001 }, isMaximized: false },
      { version: 1, bounds },
      { version: 1, isMaximized: false },
      null,
      [bounds],
      "state",
    ]) {
      expect(parseDesktopWindowState(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("readDesktopWindowState", () => {
  it("tells a missing file from an unreadable one and reads a saved one", () => {
    const directory = makeTempDir();
    const filePath = join(directory, "desktop-window-state.json");
    expect(readDesktopWindowState(filePath)).toEqual({ kind: "missing" });

    FS.writeFileSync(filePath, "{");
    expect(readDesktopWindowState(filePath)).toEqual({ kind: "unreadable" });
    FS.writeFileSync(filePath, '{"version":1}');
    expect(readDesktopWindowState(filePath)).toEqual({ kind: "unreadable" });
    expect(readDesktopWindowState(directory)).toEqual({ kind: "unreadable" });

    const state = savedState({ x: 120, y: 64, width: 1280, height: 860 });
    writeDesktopWindowState(filePath, state);
    expect(readDesktopWindowState(filePath)).toEqual({ kind: "saved", state });
  });
});

describe("resolveVisibleWindowBounds", () => {
  it("keeps bounds that are fully on the primary display", () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800 };
    expect(resolveVisibleWindowBounds({ saved, workAreas: [primary] })).toEqual({
      bounds: saved,
      clamped: false,
    });
  });

  it("centres bounds from a monitor that is gone on the primary display, keeping the size", () => {
    const saved = { x: 4000, y: 100, width: 1200, height: 800 };
    expect(resolveVisibleWindowBounds({ saved, workAreas: [primary] })).toEqual({
      bounds: { x: 120, y: 63, width: 1200, height: 800 },
      clamped: true,
    });
  });

  it("moves bounds straddling two displays fully onto the one they overlap most", () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1050 };
    // 300 px on the primary, 700 px on the second.
    const saved = { x: 1140, y: 100, width: 1000, height: 800 };
    expect(resolveVisibleWindowBounds({ saved, workAreas: [primary, second] })).toEqual({
      bounds: { x: 1440, y: 100, width: 1000, height: 800 },
      clamped: true,
    });
  });

  it("shrinks bounds larger than the work area and grows ones below the minimum size", () => {
    expect(
      resolveVisibleWindowBounds({
        saved: { x: 0, y: 0, width: 3000, height: 2000 },
        workAreas: [primary],
      }),
    ).toEqual({ bounds: { x: 0, y: 25, width: 1440, height: 875 }, clamped: true });
    expect(
      resolveVisibleWindowBounds({
        saved: { x: 10, y: 40, width: 300, height: 200 },
        workAreas: [primary],
      }),
    ).toEqual({ bounds: { x: 10, y: 40, width: 840, height: 620 }, clamped: true });
  });

  it("keeps negative coordinates on a display left of the primary", () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1050 };
    const saved = { x: -1800, y: 50, width: 1200, height: 800 };
    expect(resolveVisibleWindowBounds({ saved, workAreas: [primary, left] })).toEqual({
      bounds: saved,
      clamped: false,
    });
  });

  it("returns the saved bounds unchanged without display information", () => {
    const saved = { x: 4000, y: 100, width: 1200, height: 800 };
    expect(resolveVisibleWindowBounds({ saved, workAreas: [] })).toEqual({
      bounds: saved,
      clamped: false,
    });
  });
});

describe("resolveRestoredDesktopWindowState", () => {
  it("opens a first launch at the default size, centred and not maximized", () => {
    expect(
      resolveRestoredDesktopWindowState({ read: { kind: "missing" }, workAreas: [primary] }),
    ).toEqual({
      bounds: DESKTOP_WINDOW_DEFAULT_SIZE,
      maximize: false,
      source: "default",
      clamped: false,
    });
  });

  it("opens at the default size when the file is unreadable", () => {
    expect(
      resolveRestoredDesktopWindowState({ read: { kind: "unreadable" }, workAreas: [primary] }),
    ).toEqual({
      bounds: DESKTOP_WINDOW_DEFAULT_SIZE,
      maximize: false,
      source: "unreadable",
      clamped: false,
    });
  });

  it("restores saved bounds and the maximized state", () => {
    const bounds = { x: 100, y: 80, width: 1200, height: 800 };
    expect(
      resolveRestoredDesktopWindowState({
        read: { kind: "saved", state: savedState(bounds, true) },
        workAreas: [primary],
      }),
    ).toEqual({ bounds, maximize: true, source: "saved", clamped: false });
  });
});

describe("isWindowPositionUnreported", () => {
  it("is true on Wayland only", () => {
    const base = { sessionType: undefined, waylandDisplay: undefined, ozonePlatform: "" };
    expect(isWindowPositionUnreported({ ...base, platform: "darwin" })).toBe(false);
    expect(isWindowPositionUnreported({ ...base, platform: "linux" })).toBe(false);
    expect(isWindowPositionUnreported({ ...base, platform: "linux", sessionType: "wayland" })).toBe(
      true,
    );
    expect(
      isWindowPositionUnreported({ ...base, platform: "linux", waylandDisplay: "wayland-0" }),
    ).toBe(true);
    expect(
      isWindowPositionUnreported({
        ...base,
        platform: "linux",
        sessionType: "wayland",
        ozonePlatform: "x11",
      }),
    ).toBe(false);
    expect(
      isWindowPositionUnreported({ ...base, platform: "linux", ozonePlatform: "wayland" }),
    ).toBe(true);
  });
});

/**
 * A BrowserWindow stand-in. Like Electron, it reports isMaximized() false while
 * minimized or fullscreen, even when it returns to maximized, and (like macOS,
 * which records the frame it minimizes from) reports its maximized frame as the
 * normal bounds of a maximized window that is minimized or fullscreen.
 */
class FakeWindow extends EventEmitter implements DesktopWindowStateTarget {
  bounds: DesktopWindowBounds;
  maximized = false;
  minimized = false;
  fullScreen = false;
  destroyed = false;
  maximizeCalls = 0;

  constructor(bounds: { readonly x?: number; readonly y?: number; width: number; height: number }) {
    super();
    this.bounds = {
      x: bounds.x ?? 170,
      y: bounds.y ?? 72,
      width: bounds.width,
      height: bounds.height,
    };
  }

  getNormalBounds(): DesktopWindowBounds {
    return this.maximized && (this.minimized || this.fullScreen)
      ? { ...primary }
      : { ...this.bounds };
  }
  isMaximized(): boolean {
    return this.maximized && !this.minimized && !this.fullScreen;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  maximize(): void {
    this.maximizeCalls += 1;
    this.maximized = true;
    this.emit("maximize");
  }
  unmaximize(): void {
    this.maximized = false;
    this.emit("unmaximize");
  }
  moveTo(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y };
    this.emit("move");
  }
  resizeTo(width: number, height: number): void {
    this.bounds = { ...this.bounds, width, height };
    this.emit("resize");
  }
  close(): void {
    this.emit("close");
    this.destroy();
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("closed");
  }
}

describe("createDesktopWindowStateStore", () => {
  let filePath: string;
  let lines: string[];
  let writes: PersistedDesktopWindowState[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    filePath = join(makeTempDir(), "desktop-window-state.json");
    lines = [];
    writes = [];
  });

  function createStore(options?: { readonly positionReported?: boolean }) {
    let clock = 0;
    return createDesktopWindowStateStore({
      filePath,
      log: (line) => lines.push(line),
      now: () => (clock += 0.25),
      write: (path, state) => {
        writeDesktopWindowState(path, state);
        writes.push(state);
      },
      ...options,
    });
  }

  function openWindow(store: ReturnType<typeof createStore>) {
    const restored = store.restore([primary]);
    const window = new FakeWindow(restored.bounds);
    store.track(window, restored);
    return { window, restored };
  }

  it("writes once after the window stops moving, with the latest bounds", () => {
    const store = createStore();
    const { window } = openWindow(store);

    for (let step = 1; step <= 10; step += 1) {
      if (step > 1) vi.advanceTimersByTime(40);
      window.moveTo(170 + step * 10, 72);
    }
    expect(writes).toHaveLength(0);

    vi.advanceTimersByTime(499);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([savedState({ x: 270, y: 72, width: 1100, height: 780 })]);
  });

  it("writes nothing when the window moves back before the save", () => {
    const store = createStore();
    const { window } = openWindow(store);

    window.moveTo(400, 300);
    vi.advanceTimersByTime(200);
    window.moveTo(170, 72);
    vi.advanceTimersByTime(2_000);

    expect(writes).toHaveLength(0);
  });

  it("writes a pending change at once on close, and only once", () => {
    const store = createStore();
    const { window } = openWindow(store);

    window.resizeTo(1300, 900);
    vi.advanceTimersByTime(100);
    window.close();
    expect(writes).toEqual([savedState({ x: 170, y: 72, width: 1300, height: 900 })]);

    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(1);
  });

  it("writes a pending change when the window is destroyed without close", () => {
    const store = createStore();
    const { window } = openWindow(store);

    window.moveTo(300, 200);
    window.destroy();

    expect(writes).toEqual([savedState({ x: 300, y: 200, width: 1100, height: 780 })]);
  });

  it("does not write back a restore clamped from a missing monitor", () => {
    const offscreen = JSON.stringify(savedState({ x: 9000, y: 100, width: 1200, height: 800 }));
    FS.writeFileSync(filePath, offscreen);
    const store = createStore();
    const { window, restored } = openWindow(store);
    expect(restored).toMatchObject({ source: "saved", clamped: true });

    store.beforeFirstShow(window);
    window.close();

    expect(writes).toHaveLength(0);
    expect(FS.readFileSync(filePath, "utf8")).toBe(offscreen);
  });

  it("maximizes once before the first show without writing", () => {
    writeDesktopWindowState(
      filePath,
      savedState({ x: 100, y: 80, width: 1200, height: 800 }, true),
    );
    const store = createStore();
    const { window } = openWindow(store);
    expect(window.maximizeCalls).toBe(0);

    store.beforeFirstShow(window);
    expect(window.maximizeCalls).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(0);

    store.beforeFirstShow(window);
    expect(window.maximizeCalls).toBe(1);
  });

  it("reopens maximized at the saved bounds after a maximize and close", () => {
    const first = createStore();
    const { window } = openWindow(first);
    window.moveTo(200, 100);
    window.maximize();
    window.close();

    const reopened = createStore().restore([primary]);
    expect(reopened).toEqual({
      bounds: { x: 200, y: 100, width: 1100, height: 780 },
      maximize: true,
      source: "saved",
      clamped: false,
    });
  });

  it("keeps the maximized state and the size to return to across a minimize before quitting", () => {
    const store = createStore();
    const { window } = openWindow(store);
    window.maximize();
    vi.advanceTimersByTime(500);
    expect(writes).toEqual([savedState({ x: 170, y: 72, width: 1100, height: 780 }, true)]);

    window.minimized = true;
    window.emit("resize");
    window.close();

    expect(writes).toHaveLength(1);
    expect(readDesktopWindowState(filePath)).toEqual({
      kind: "saved",
      state: savedState({ x: 170, y: 72, width: 1100, height: 780 }, true),
    });
  });

  it("keeps the maximized state while fullscreen", () => {
    const store = createStore();
    const { window } = openWindow(store);
    window.maximize();
    vi.advanceTimersByTime(500);
    const before = writes.length;

    window.fullScreen = true;
    window.emit("resize");
    vi.advanceTimersByTime(1_000);

    expect(writes).toHaveLength(before);
    expect(readDesktopWindowState(filePath)).toEqual({
      kind: "saved",
      state: savedState({ x: 170, y: 72, width: 1100, height: 780 }, true),
    });
  });

  it("keeps a restored maximized state when the window closes before its first show", () => {
    const saved = JSON.stringify(savedState({ x: 100, y: 80, width: 1200, height: 800 }, true));
    FS.writeFileSync(filePath, saved);
    const store = createStore();
    const { window } = openWindow(store);

    window.close();

    expect(writes).toHaveLength(0);
    expect(FS.readFileSync(filePath, "utf8")).toBe(saved);
  });

  it("opens a reopened window (macOS activate) where the closed one was, from memory", () => {
    const store = createStore();
    const { window } = openWindow(store);
    window.moveTo(321, 100);
    window.close();
    FS.rmSync(filePath);

    expect(store.restore([primary])).toMatchObject({
      bounds: { x: 321, y: 100, width: 1100, height: 780 },
      source: "saved",
    });
  });

  it("logs a failed write once and never throws", () => {
    const parent = join(makeTempDir(), "not-a-directory");
    FS.writeFileSync(parent, "");
    filePath = join(parent, "desktop-window-state.json");
    const store = createStore();
    const { window } = openWindow(store);

    window.moveTo(300, 200);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    window.moveTo(310, 210);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => window.close()).not.toThrow();

    expect(lines.filter((line) => line.startsWith("window state save failed"))).toHaveLength(1);
  });

  it("does not save bounds the reader would reject", () => {
    const store = createStore();
    const { window } = openWindow(store);

    window.resizeTo(0, 780);
    vi.advanceTimersByTime(500);
    window.resizeTo(0, 700);
    vi.advanceTimersByTime(500);

    expect(writes).toHaveLength(0);
    expect(lines.filter((line) => line.startsWith("window state not saved"))).toHaveLength(1);
  });

  it("keeps the saved position where the window system reports a fake one", () => {
    writeDesktopWindowState(filePath, savedState({ x: 100, y: 80, width: 1200, height: 800 }));
    const store = createStore({ positionReported: false });
    const { window } = openWindow(store);

    window.bounds = { x: 0, y: 0, width: 1200, height: 800 };
    window.resizeTo(1300, 850);
    window.close();

    expect(writes).toEqual([savedState({ x: 100, y: 80, width: 1300, height: 850 })]);
  });

  it("flushAll writes a pending change synchronously", () => {
    const store = createStore();
    const { window } = openWindow(store);

    window.moveTo(250, 150);
    store.flushAll();

    expect(writes).toEqual([savedState({ x: 250, y: 150, width: 1100, height: 780 })]);
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(1);
  });

  it("logs one restore line with its duration", () => {
    writeDesktopWindowState(
      filePath,
      savedState({ x: 100, y: 80, width: 1200, height: 800 }, true),
    );
    createStore().restore([primary]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^window state restore source=saved clamped=false maximized=true ms=\d/,
    );
  });

  it("says when an unreadable file falls back to the default size", () => {
    FS.writeFileSync(filePath, "{");
    createStore().restore([primary]);

    expect(lines).toEqual([
      "window state restore source=unreadable clamped=false maximized=false ms=0.25; using the default size",
    ]);
  });
});
