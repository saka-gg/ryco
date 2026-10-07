import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  hide: vi.fn(),
  spawn: vi.fn(),
  exit: vi.fn(),
  on: vi.fn(),
  dock: true,
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    get dock() {
      return mocks.dock ? { hide: mocks.hide } : undefined;
    },
    exit: mocks.exit,
    on: mocks.on,
  },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./externalBridgeLaunch.ts", () => ({
  externalBridgeLaunchArgs: () => ["/bundled/bin.mjs", "mcp", "serve"],
}));

describe("packaged external MCP bridge entry", () => {
  let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
  let originalSigterm: NodeJS.SignalsListener[];
  let originalSigint: NodeJS.SignalsListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.dock = true;
    child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    originalSigterm = process.listeners("SIGTERM");
    originalSigint = process.listeners("SIGINT");
  });

  afterEach(() => {
    for (const [signal, original] of [
      ["SIGTERM", originalSigterm],
      ["SIGINT", originalSigint],
    ] as const) {
      for (const listener of process.listeners(signal)) {
        if (!original.includes(listener)) process.removeListener(signal, listener);
      }
    }
  });

  it("hides the forwarding app before starting its Node-mode bridge", async () => {
    await import("./desktopEntry.ts");

    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(mocks.hide.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawn.mock.invocationCallOrder[0]!,
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/bundled/bin.mjs", "mcp", "serve"],
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
        stdio: "inherit",
      }),
    );
    child.emit("exit", 7);
    expect(mocks.exit).toHaveBeenCalledWith(7);
  });

  it("still starts and stops the bridge on platforms without a Dock", async () => {
    mocks.dock = false;
    await import("./desktopEntry.ts");

    expect(mocks.hide).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    const beforeQuit = mocks.on.mock.calls.find(([event]) => event === "before-quit")?.[1];
    expect(beforeQuit).toBeTypeOf("function");
    beforeQuit();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
