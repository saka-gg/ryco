import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import { createAppWindowRegistry } from "./appWindows.ts";

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
