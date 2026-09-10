import { describe, expect, it, vi } from "vite-plus/test";

import { createQuitCleanupHandler } from "./quitCleanup.ts";

describe("desktop quit cleanup", () => {
  it("holds repeated quit requests until backend shutdown finishes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(() => pending);
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({ cleanup, quit });
    const first = { preventDefault: vi.fn() };
    const repeated = { preventDefault: vi.fn() };
    handler(first);
    handler(repeated);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    finish();
    await pending;
    await Promise.resolve();
    expect(quit).toHaveBeenCalledOnce();
    const final = { preventDefault: vi.fn() };
    handler(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not intercept updater handoff after the backend has already stopped", () => {
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({ cleanup: () => undefined, quit });
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("allows the app to finish quitting if cleanup rejects", async () => {
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({
      cleanup: () => Promise.reject(new Error("backend already unavailable")),
      quit,
    });
    handler({ preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(quit).toHaveBeenCalledOnce();
  });
});
