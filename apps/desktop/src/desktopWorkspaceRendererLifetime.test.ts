import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  resetDesktopWorkspaceRenderer,
  watchDesktopWorkspaceRenderer,
  type DesktopWorkspaceRendererWindow,
} from "./desktopWorkspaceRendererLifetime.ts";

function fakeWindow() {
  const window = new EventEmitter();
  const webContents = new EventEmitter();
  const typed: DesktopWorkspaceRendererWindow = {
    on: (event, listener) => window.on(event, listener),
    webContents: { on: (event: string, listener: () => void) => webContents.on(event, listener) },
  };
  return {
    window: typed,
    emitWindow: (event: string) => window.emit(event),
    emitContents: (event: string, ...args: unknown[]) => webContents.emit(event, ...args),
  };
}

describe("desktop workspace renderer lifetime", () => {
  it("reports a replaced, crashed or closed document as gone", () => {
    const f = fakeWindow();
    const onGone = vi.fn();
    watchDesktopWorkspaceRenderer(f.window, onGone);

    f.emitContents("did-navigate", {}, "app://index.html");
    f.emitContents("render-process-gone", {}, { reason: "crashed" });
    f.emitWindow("closed");

    expect(onGone).toHaveBeenCalledTimes(3);
  });

  it("ignores a navigation that only started, and in-page navigations", () => {
    const f = fakeWindow();
    const onGone = vi.fn();
    watchDesktopWorkspaceRenderer(f.window, onGone);

    // A download or a cancelled navigation starts and never commits.
    f.emitContents("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    f.emitContents("did-navigate-in-page", {}, "app://index.html#thread");

    expect(onGone).not.toHaveBeenCalled();
  });

  it("closes the transports and resets the demand together", () => {
    const order: string[] = [];
    resetDesktopWorkspaceRenderer({
      client: { resetRenderer: () => order.push("client") },
      relay: { closeAll: () => order.push("relay") },
    });
    expect(order).toEqual(["relay", "client"]);
  });

  it("resets the demand even when closing a transport throws", () => {
    const resetRenderer = vi.fn();
    expect(() =>
      resetDesktopWorkspaceRenderer({
        client: { resetRenderer },
        relay: {
          closeAll: () => {
            throw new Error("emit failed");
          },
        },
      }),
    ).toThrow("emit failed");
    expect(resetRenderer).toHaveBeenCalledOnce();
  });

  it("needs neither owner to exist", () => {
    expect(() => resetDesktopWorkspaceRenderer({ client: null, relay: null })).not.toThrow();
  });
});
