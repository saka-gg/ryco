import { describe, expect, it, vi } from "vite-plus/test";

import { registerDeferredIpcHandlers } from "./deferredIpc.ts";

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: readonly unknown[]) => unknown>();
  return {
    handlers,
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn(
      (channel: string, listener: (event: unknown, ...args: readonly unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    ),
  };
}

describe("registerDeferredIpcHandlers", () => {
  it("registers every channel now and loads the implementation on first use", async () => {
    const ipcMain = fakeIpcMain();
    const load = vi.fn(
      async (registrar: Parameters<Parameters<typeof registerDeferredIpcHandlers>[2]>[0]) => {
        registrar.removeHandler("ssh:a");
        registrar.handle("ssh:a", (_event, value) => `a:${String(value)}`);
        registrar.handle("ssh:b", async () => "b");
      },
    );

    registerDeferredIpcHandlers(ipcMain, ["ssh:a", "ssh:b"], load);

    expect([...ipcMain.handlers.keys()]).toEqual(["ssh:a", "ssh:b"]);
    expect(load).not.toHaveBeenCalled();
    await expect(
      Promise.all([ipcMain.handlers.get("ssh:a")!({}, 1), ipcMain.handlers.get("ssh:b")!({})]),
    ).resolves.toEqual(["a:1", "b"]);
    await expect(ipcMain.handlers.get("ssh:a")!({}, 2)).resolves.toBe("a:2");
    expect(load).toHaveBeenCalledOnce();
  });

  it("reports a channel the loaded module does not implement", async () => {
    const ipcMain = fakeIpcMain();
    registerDeferredIpcHandlers(ipcMain, ["ssh:missing"], async () => undefined);
    await expect(ipcMain.handlers.get("ssh:missing")!({})).rejects.toThrow(
      "No handler is registered for ssh:missing.",
    );
  });

  it("retries loading after a failed attempt", async () => {
    const ipcMain = fakeIpcMain();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockImplementation(async (registrar) => registrar.handle("ssh:a", () => "ok"));
    registerDeferredIpcHandlers(ipcMain, ["ssh:a"], load);
    await expect(ipcMain.handlers.get("ssh:a")!({})).rejects.toThrow("load failed");
    await expect(ipcMain.handlers.get("ssh:a")!({})).resolves.toBe("ok");
  });
});
