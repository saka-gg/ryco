import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  hide: vi.fn(),
  spawn: vi.fn(),
  exit: vi.fn(),
  on: vi.fn(),
  setPath: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  existsSync: vi.fn(() => false),
  readShellEnvironmentCache: vi.fn(),
  applyShellEnvironmentCache: vi.fn(),
  bridgeArgs: ["/bundled/bin.mjs", "mcp", "serve"] as string[] | null,
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
    setPath: mocks.setPath,
    requestSingleInstanceLock: mocks.requestSingleInstanceLock,
    getAppPath: () => "/Applications/Ryco.app/Contents/Resources/app.asar",
    getVersion: () => "1.2.3",
  },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.existsSync,
}));
vi.mock("@ryco/shared/shellEnvironment", () => ({
  readShellEnvironmentCache: mocks.readShellEnvironmentCache,
  applyShellEnvironmentCache: mocks.applyShellEnvironmentCache,
}));
vi.mock("./externalBridgeLaunch.ts", () => ({
  externalBridgeLaunchArgs: () => mocks.bridgeArgs,
}));

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stdio: EventEmitter[];
  exitCode: number | null;
  signalCode: string | null;
};

function makeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdio: [0, 1, 2, 3, 4].map(() => new EventEmitter()),
    exitCode: null,
    signalCode: null,
  });
}

describe("desktop launch entry", () => {
  let child: FakeChild;
  let originalSigterm: NodeJS.SignalsListener[];
  let originalSigint: NodeJS.SignalsListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.dock = true;
    mocks.bridgeArgs = ["/bundled/bin.mjs", "mcp", "serve"];
    mocks.requestSingleInstanceLock.mockReturnValue(true);
    mocks.existsSync.mockReturnValue(false);
    child = makeChild();
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
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("ryco.desktop.launchRecord")];
    delete (process as { resourcesPath?: string }).resourcesPath;
  });

  it("hides the forwarding app before starting its Node-mode bridge", async () => {
    await import("./desktopEntry.ts");

    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(mocks.hide.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawn.mock.invocationCallOrder[0]!,
    );
    const [executable, args, options] = mocks.spawn.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(args.slice(-3)).toEqual(["/bundled/bin.mjs", "mcp", "serve"]);
    expect(options).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
        stdio: "inherit",
      }),
    );
    // A bridge never takes the GUI's single-instance lock.
    expect(mocks.requestSingleInstanceLock).not.toHaveBeenCalled();
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

  it("refuses a second instance before loading the main bundle or starting a backend", async () => {
    mocks.bridgeArgs = null;
    mocks.requestSingleInstanceLock.mockReturnValue(false);

    await import("./desktopEntry.ts");

    expect(mocks.setPath).toHaveBeenCalledWith("userData", expect.stringMatching(/ryco$/));
    expect(mocks.setPath.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestSingleInstanceLock.mock.invocationCallOrder[0]!,
    );
    expect(mocks.exit).toHaveBeenCalledWith(0);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("starts the backend from a cached shell environment before the main bundle loads", async () => {
    // Electron defines process.resourcesPath; plain Node does not.
    Object.defineProperty(process, "resourcesPath", {
      value: "/Applications/Ryco.app/Contents/Resources",
      configurable: true,
    });
    mocks.bridgeArgs = null;
    mocks.existsSync.mockReturnValue(true);
    mocks.readShellEnvironmentCache.mockReturnValue({
      kind: "hit",
      record: { environment: { PATH: "/opt/homebrew/bin" } },
      ageMs: 0,
    });

    // The main bundle is not built in tests, so loading it fails; the entry
    // must then stop the backend it started.
    await expect(import("./desktopEntry.ts")).rejects.toThrow();

    expect(mocks.applyShellEnvironmentCache).toHaveBeenCalledOnce();
    expect(readLaunchRecord()?.shellEnvironmentApplied).toBe(true);
    expect(mocks.applyShellEnvironmentCache.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawn.mock.invocationCallOrder[0]!,
    );
    const [executable, args, options] = mocks.spawn.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(args).toEqual([
      "--max-semi-space-size=16",
      ...(args.includes("--require")
        ? ["--require", expect.stringMatching(/compileCache\.cjs$/)]
        : []),
      "/Applications/Ryco.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
      "--bootstrap-fd",
      "3",
      "--mode",
      "desktop",
      "--no-browser",
    ]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe", "pipe", "pipe"]);
    expect(options.env).toEqual(expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("starts the backend early without a cached shell environment too", async () => {
    // The main bundle captures the environment meanwhile and delivers it in the
    // bootstrap envelope, which the backend applies before building anything.
    Object.defineProperty(process, "resourcesPath", {
      value: "/Applications/Ryco.app/Contents/Resources",
      configurable: true,
    });
    mocks.bridgeArgs = null;
    mocks.existsSync.mockReturnValue(true);
    mocks.readShellEnvironmentCache.mockReturnValue({ kind: "miss", reason: "unreadable" });

    await expect(import("./desktopEntry.ts")).rejects.toThrow();

    expect(mocks.applyShellEnvironmentCache).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(readLaunchRecord()?.shellEnvironmentApplied).toBe(false);
    // Loading the main bundle failed, so the entry stopped the child again.
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("starts no backend when the server entry is missing", async () => {
    mocks.bridgeArgs = null;
    mocks.existsSync.mockReturnValue(false);
    mocks.readShellEnvironmentCache.mockReturnValue({ kind: "miss", reason: "missing" });

    await expect(import("./desktopEntry.ts")).rejects.toThrow();

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(readLaunchRecord()?.earlyBackend).toBeNull();
  });
});

function readLaunchRecord():
  | { readonly shellEnvironmentApplied: boolean; readonly earlyBackend: unknown }
  | undefined {
  return (globalThis as Record<symbol, never>)[Symbol.for("ryco.desktop.launchRecord")];
}
