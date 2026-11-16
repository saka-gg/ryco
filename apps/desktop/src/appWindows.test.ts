import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import { createAppMenuActionDispatch, createAppWindowRegistry } from "./appWindows.ts";

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly name: string;
  constructor(name: string) {
    super();
    this.name = name;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    this.destroyed = true;
    this.emit("closed");
  }
}

describe("createAppWindowRegistry", () => {
  it("never counts or picks a window it does not track (an embedded browser tab host)", () => {
    const registry = createAppWindowRegistry<FakeWindow>({ onLastClosed: vi.fn() });
    const host = new FakeWindow("hidden tab host");
    const app = new FakeWindow("app");
    registry.track(app);

    expect(registry.has(host)).toBe(false);
    expect(registry.list()).toEqual([app]);
    // A focused popped-out tab is passed over for the app window.
    expect(registry.pick(host, null)).toBe(app);

    app.close();
    expect(registry.list()).toEqual([]);
    expect(registry.pick(host, app)).toBeNull();
  });

  it("prefers the given windows in order, then the oldest app window", () => {
    const registry = createAppWindowRegistry<FakeWindow>({ onLastClosed: vi.fn() });
    const first = new FakeWindow("first");
    const second = new FakeWindow("second");
    registry.track(first);
    registry.track(second);

    expect(registry.pick(second, first)).toBe(second);
    expect(registry.pick(null, undefined)).toBe(first);
    first.destroyed = true;
    expect(registry.pick(first)).toBe(second);
  });

  it("reports the last app window closing while other windows stay open", () => {
    const onLastClosed = vi.fn();
    const registry = createAppWindowRegistry<FakeWindow>({ onLastClosed });
    const first = new FakeWindow("first");
    const second = new FakeWindow("second");
    const host = new FakeWindow("hidden tab host");
    registry.track(first);
    registry.track(second);
    registry.track(first);

    first.close();
    expect(onLastClosed).not.toHaveBeenCalled();
    second.close();
    expect(onLastClosed).toHaveBeenCalledTimes(1);
    expect(host.isDestroyed()).toBe(false);
  });
});

function setup(options: { target: FakeWindow | null; usable?: ReadonlySet<FakeWindow> }) {
  const usable = new Set(options.usable ?? []);
  const calls: string[] = [];
  let target = options.target;
  const dispatch = createAppMenuActionDispatch<FakeWindow>({
    target: () => target,
    isShellUsable: (window) => usable.has(window),
    send: (window, action) => calls.push(`send ${window.name} ${action}`),
    reveal: (window) => calls.push(`reveal ${window.name}`),
    open: () => calls.push("open"),
  });
  return {
    dispatch,
    calls,
    setTarget: (next: FakeWindow | null) => {
      target = next;
    },
    markUsable: (window: FakeWindow) => {
      usable.add(window);
      dispatch.shellUsable(window);
    },
  };
}

describe("createAppMenuActionDispatch", () => {
  it("sends to an app window whose shell is usable, then reveals it", () => {
    const app = new FakeWindow("app");
    const { dispatch, calls } = setup({ target: app, usable: new Set([app]) });
    dispatch.dispatch("open-settings");
    expect(calls).toEqual(["send app open-settings", "reveal app"]);
  });

  it("with no app window, opens one through `open` and sends once its shell is usable", () => {
    const { dispatch, calls, setTarget, markUsable } = setup({ target: null });
    dispatch.dispatch("open-settings");
    expect(calls).toEqual(["open"]);

    // The packaged window shows the boot page first: nothing is sent to it.
    const opened = new FakeWindow("opened");
    setTarget(opened);
    expect(calls).toEqual(["open"]);

    markUsable(opened);
    expect(calls).toEqual(["open", "send opened open-settings", "reveal opened"]);
    // A later shell-usable report (shell-painted) sends nothing more.
    dispatch.shellUsable(opened);
    expect(calls).toHaveLength(3);
  });

  it("holds the action for an app window that is still booting", () => {
    const booting = new FakeWindow("booting");
    const { dispatch, calls, markUsable } = setup({ target: booting });
    dispatch.dispatch("open-settings");
    expect(calls).toEqual(["reveal booting"]);
    markUsable(booting);
    expect(calls).toEqual(["reveal booting", "send booting open-settings", "reveal booting"]);
  });
});
