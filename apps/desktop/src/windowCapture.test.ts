import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type {
  DesktopAppSnapCapture,
  DesktopAppSnapShortcut,
  DesktopAppSnapState,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopAppSnapManager, type DesktopAppSnapManagerOptions } from "./appSnapManager.ts";
import {
  DesktopWindowCapture,
  registerWindowCaptureIpc,
  requiredWindowCapturePermissions,
  windowCaptureMessage,
  type WindowCaptureManager,
} from "./windowCapture.ts";
import { WINDOW_CAPTURE_IPC } from "./windowCaptureChannels.ts";

const CHORD = { kind: "key-chord", modifier: "control", key: "KeyG" } as const;
const TAKEN = {
  available: false,
  reason: "macOS or another app is already using this shortcut.",
} as const;

function appSnapState(patch: Partial<DesktopAppSnapState> = {}): DesktopAppSnapState {
  return {
    platform: "macos",
    supported: true,
    enabled: false,
    status: "disabled",
    shortcut: { kind: "both-option-keys" },
    inputMonitoringPermission: "unknown",
    screenRecordingPermission: "unknown",
    message: null,
    appDisplayName: "Ryco",
    ...patch,
  };
}

function capture(id = "8d5f0c1e-0000-4000-8000-000000000001"): DesktopAppSnapCapture {
  return {
    id,
    capturedAt: "2026-10-22T10:00:00.000Z",
    name: `appsnap-${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
    bytes: new Uint8Array([1, 2, 3]),
    sourceAppName: "Safari",
    sourceBundleIdentifier: "com.apple.Safari",
    sourceAppIconDataUrl: null,
    sourceWindowTitle: "Docs",
  };
}

/** A manager double whose state the test drives; calls are recorded. */
function createFakeManager() {
  let state = appSnapState();
  const manager = {
    getState: vi.fn(() => state),
    listenerState: vi.fn(() => ({
      listening: state.enabled && (state.status === "ready" || state.status === "starting"),
      message: state.message,
    })),
    refreshState: vi.fn(async () => state),
    setEnabled: vi.fn(async (enabled: boolean) => {
      state = { ...state, enabled, status: enabled ? "ready" : "disabled" };
      return state;
    }),
    setShortcut: vi.fn(async () => ({ state, availability: { available: true, reason: null } })),
    setShortcutEnabled: vi.fn(async (_enabled: boolean) => state),
    checkShortcut: vi.fn((): { available: boolean; reason: string | null } => ({
      available: true,
      reason: null,
    })),
    startPermissionSetup: vi.fn(async () => state),
    listWindows: vi.fn(async () => [
      {
        windowId: 7,
        appName: "Safari",
        bundleIdentifier: "com.apple.Safari",
        windowTitle: "Docs",
        appIconDataUrl: null,
      },
    ]),
    captureWindow: vi.fn(async () => capture("picker-1")),
    listPendingCaptureEntries: vi.fn(async () => [] as Omit<DesktopAppSnapCapture, "bytes">[]),
    readPendingCapture: vi.fn(async (): Promise<DesktopAppSnapCapture | null> => null),
    acknowledgeCapture: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  return {
    manager,
    setState: (patch: Partial<DesktopAppSnapState>) => {
      state = { ...state, ...patch };
    },
  };
}

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  // A disposed manager may still finish file work; the retries let it land.
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function stateDirectory(savedShortcut?: DesktopAppSnapShortcut | null): string {
  const stateDir = mkdtempSync(join(tmpdir(), "ryco-window-capture-"));
  directories.push(stateDir);
  if (savedShortcut !== undefined) {
    writeFileSync(
      join(stateDir, "window-capture.json"),
      JSON.stringify({ version: 1, shortcut: savedShortcut }),
    );
  }
  return stateDir;
}

function fixture(options: { savedShortcut?: DesktopAppSnapShortcut | null } = {}) {
  const stateDir = stateDirectory(options.savedShortcut);
  const fake = createFakeManager();
  let managerOptions: DesktopAppSnapManagerOptions | null = null;
  const send = vi.fn();
  const revealWindow = vi.fn();
  const service = new DesktopWindowCapture({
    platform: "darwin",
    helperPath: "/Applications/Ryco.app/Contents/Resources/ryco-computer-ui-helper",
    stateDir,
    excludedBundleId: "com.laurinfrank.ryco",
    appDisplayName: "Ryco",
    shortcutRegistry: { register: vi.fn(() => true), unregister: vi.fn() },
    openSettingsPane: vi.fn(),
    send,
    revealWindow,
    pickerIdleStopMs: 1_000,
    createManager: (input) => {
      managerOptions = input;
      return fake.manager as unknown as WindowCaptureManager;
    },
  });
  const readSaved = () =>
    JSON.parse(readFileSync(join(stateDir, "window-capture.json"), "utf8")) as unknown;
  return {
    service,
    ...fake,
    send,
    revealWindow,
    stateDir,
    readSaved,
    managerOptions: () => managerOptions!,
  };
}

describe("window capture service", () => {
  it("keeps its own capture directory and starts with the shortcut off", async () => {
    const f = fixture();
    await f.service.start();
    expect(f.managerOptions().captureDirectory).toBe(join(f.stateDir, "window-captures"));
    expect(f.manager.setShortcutEnabled).toHaveBeenCalledWith(false);
    // No listener, no grant check: nothing runs until a picker or shortcut needs it.
    expect(f.manager.setEnabled).not.toHaveBeenCalled();
    expect(f.service.state()).toMatchObject({ shortcut: null });
  });

  it("arms a saved shortcut at startup with a preflight check only", async () => {
    const f = fixture({ savedShortcut: CHORD });
    f.setState({ screenRecordingPermission: "granted" });
    await f.service.start();
    expect(f.manager.setShortcut).toHaveBeenCalledWith(CHORD);
    expect(f.manager.refreshState).toHaveBeenCalledWith(["screenRecording"]);
    expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(true);
    expect(f.manager.setEnabled).toHaveBeenCalledWith(true);
    expect(f.manager.startPermissionSetup).not.toHaveBeenCalled();
    expect(f.service.state().shortcut).toEqual(CHORD);
  });

  it("keeps the picker usable while the Option-key shortcut lacks Input Monitoring", async () => {
    const f = fixture({ savedShortcut: { kind: "both-option-keys" } });
    f.setState({ screenRecordingPermission: "granted", inputMonitoringPermission: "denied" });
    await f.service.start();
    // Disarmed, and no background listener for a shortcut that cannot fire.
    expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(false);
    expect(f.manager.setEnabled).not.toHaveBeenCalled();
    expect(f.service.state().missingPermissions).toEqual(["inputMonitoring"]);

    await expect(f.service.listWindows()).resolves.toHaveLength(1);

    f.setState({ inputMonitoringPermission: "granted" });
    await f.service.refresh();
    expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(true);
    expect(f.service.state().missingPermissions).toEqual([]);
  });

  it("follows grants that land or go away outside a refresh", async () => {
    const f = fixture({ savedShortcut: { kind: "both-option-keys" } });
    f.setState({ screenRecordingPermission: "granted", inputMonitoringPermission: "denied" });
    await f.service.start();
    expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(false);
    const syncsBefore = f.manager.setShortcutEnabled.mock.calls.length;

    // The setup guide's grant watch reports Input Monitoring; bursts coalesce.
    f.setState({ inputMonitoringPermission: "granted" });
    for (let index = 0; index < 3; index += 1) f.managerOptions().onState(f.manager.getState());
    await vi.waitFor(() => expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(true));
    expect(f.manager.setShortcutEnabled).toHaveBeenCalledTimes(syncsBefore + 1);
    expect(f.manager.setEnabled).toHaveBeenLastCalledWith(true);

    // A revoke disarms it and stops the listener it kept running.
    f.setState({ inputMonitoringPermission: "denied" });
    f.managerOptions().onState(f.manager.getState());
    await vi.waitFor(() => expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(false));
    expect(f.manager.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("sets up only the grants the caller names", async () => {
    const f = fixture({ savedShortcut: { kind: "both-option-keys" } });
    await f.service.start();
    await f.service.setup(["screenRecording"]);
    expect(f.manager.startPermissionSetup).toHaveBeenLastCalledWith(["screenRecording"]);
    await expect(f.service.setup(["accessibility"])).rejects.toThrow("Choose which permissions");
    await expect(f.service.setup("screenRecording")).rejects.toThrow("Choose which permissions");
    await expect(f.service.setup([])).rejects.toThrow("Choose which permissions");
    expect(f.manager.startPermissionSetup).toHaveBeenCalledTimes(1);
  });

  it("lists the grants the current setup still lacks", async () => {
    const f = fixture();
    await f.service.start();
    f.setState({ screenRecordingPermission: "denied", inputMonitoringPermission: "denied" });
    expect(f.service.state().missingPermissions).toEqual(["screenRecording"]);

    await f.service.setShortcut({ kind: "both-option-keys" });
    expect(f.service.state().missingPermissions).toEqual(["screenRecording", "inputMonitoring"]);
    await f.service.setup();
    expect(f.manager.startPermissionSetup).toHaveBeenCalledWith([
      "screenRecording",
      "inputMonitoring",
    ]);
  });

  it("saves an available shortcut and arms it", async () => {
    const f = fixture();
    f.setState({ screenRecordingPermission: "granted" });
    await f.service.start();
    const result = await f.service.setShortcut(CHORD);
    expect(result.availability).toEqual({ available: true, reason: null });
    expect(f.readSaved()).toEqual({ version: 1, shortcut: CHORD });
    expect(f.manager.setShortcut).toHaveBeenCalledWith(CHORD);
    expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(true);
    expect(f.manager.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("reports a taken shortcut without saving or arming it", async () => {
    const f = fixture();
    await f.service.start();
    f.manager.checkShortcut.mockReturnValueOnce({
      available: false,
      reason: "macOS or another app is already using this shortcut.",
    });
    const result = await f.service.setShortcut(CHORD);
    expect(result.availability.available).toBe(false);
    expect(f.manager.setShortcut).not.toHaveBeenCalled();
    expect(() => f.readSaved()).toThrow();
  });

  it("turns the shortcut off and stops the listener", async () => {
    const f = fixture({ savedShortcut: CHORD });
    f.setState({ screenRecordingPermission: "granted" });
    await f.service.start();
    await f.service.setShortcut(null);
    expect(f.readSaved()).toEqual({ version: 1, shortcut: null });
    expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(false);
    expect(f.manager.setEnabled).toHaveBeenLastCalledWith(false);
    // Stopped before disarming, which would otherwise restart it for requests.
    expect(f.manager.setEnabled.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.manager.setShortcutEnabled.mock.invocationCallOrder.at(-1)!,
    );
    await expect(f.service.setShortcut({ kind: "nope" })).rejects.toThrow("modifier");
  });

  it("starts the listener for the picker on demand and stops it once idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    await f.service.start();
    const windows = await f.service.listWindows();
    expect(windows).toHaveLength(1);
    expect(f.manager.setEnabled).toHaveBeenCalledWith(true);

    const picked = await f.service.captureWindow(7);
    expect(picked.id).toBe("picker-1");
    expect(f.manager.setEnabled).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(f.manager.setEnabled).not.toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.manager.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("keeps an armed shortcut's listener running after picker use", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture({ savedShortcut: CHORD });
    f.setState({ screenRecordingPermission: "granted" });
    await f.service.start();
    await f.service.listWindows();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.manager.setEnabled).not.toHaveBeenCalledWith(false);
  });

  it("tries a held combo again when the app becomes active", async () => {
    const f = fixture({ savedShortcut: CHORD });
    f.setState({ screenRecordingPermission: "granted" });
    f.manager.checkShortcut.mockReturnValue(TAKEN);
    await f.service.start();
    expect(f.service.state().message).toBe(TAKEN.reason);
    expect(f.manager.checkShortcut).toHaveBeenCalledTimes(1);

    // Still held: one probe, no listener.
    f.service.retryHeldShortcut();
    await vi.waitFor(() => expect(f.manager.checkShortcut).toHaveBeenCalledTimes(2));
    expect(f.manager.setEnabled).not.toHaveBeenCalled();

    // The other app let go; activations in a burst share one probe.
    f.manager.checkShortcut.mockReturnValue({ available: true, reason: null });
    f.service.retryHeldShortcut();
    f.service.retryHeldShortcut();
    await vi.waitFor(() => expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(true));
    expect(f.manager.checkShortcut).toHaveBeenCalledTimes(3);
    expect(f.manager.setEnabled).toHaveBeenLastCalledWith(true);
    expect(f.service.state().message).toBeNull();

    // Armed, an activation queues nothing: only the refresh behind it probes.
    f.service.retryHeldShortcut();
    await f.service.refresh();
    expect(f.manager.checkShortcut).toHaveBeenCalledTimes(4);
  });

  it("keeps the picker's idle grace when arming fails after the check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture({ savedShortcut: CHORD });
    f.setState({ screenRecordingPermission: "granted" });
    f.manager.checkShortcut.mockReturnValue(TAKEN);
    await f.service.start();
    // The picker starts the listener; it stops once the picker is idle.
    await f.service.listWindows();
    expect(f.manager.setEnabled).toHaveBeenCalledExactlyOnceWith(true);

    // The combo checks free, then another app takes it before the reservation.
    f.manager.checkShortcut.mockReturnValueOnce({ available: true, reason: null });
    f.manager.setShortcutEnabled.mockImplementation(async (enabled) => {
      f.setState({ status: enabled ? "error" : "ready" });
      return f.manager.getState();
    });
    await f.service.refresh();
    expect(f.manager.setShortcutEnabled).toHaveBeenLastCalledWith(false);
    expect(f.service.state().message).toBe(TAKEN.reason);
    // Never armed, so the failure leaves the picker's listener running.
    expect(f.manager.setEnabled).not.toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.manager.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("explains a missing grant instead of a silent listener failure", async () => {
    const f = fixture();
    await f.service.start();
    f.manager.setEnabled.mockImplementationOnce(async () => {
      f.setState({
        enabled: true,
        status: "permission-required",
        message: "Allow Screen Recording in macOS System Settings, then try again.",
      });
      return f.manager.getState();
    });
    await expect(f.service.listWindows()).rejects.toThrow(
      "Allow Screen Recording in macOS System Settings, then try again.",
    );
    expect(f.manager.listWindows).not.toHaveBeenCalled();
    await expect(f.service.captureWindow(0)).rejects.toThrow("Choose a window");
  });

  it("brings the app forward and forwards shortcut captures and errors", () => {
    const f = fixture();
    const shot = capture();
    f.managerOptions().onCaptured(shot);
    expect(f.revealWindow).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledWith(WINDOW_CAPTURE_IPC.captured, shot);

    f.managerOptions().onError(
      { code: "helper-stopped", message: "The AppSnap helper stopped.", capturedAt: "x" },
      false,
    );
    expect(f.revealWindow).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenLastCalledWith(WINDOW_CAPTURE_IPC.error, {
      code: "helper-stopped",
      message: "The window capture helper stopped.",
      capturedAt: "x",
    });
  });

  it("publishes each distinct state once", () => {
    const f = fixture();
    f.managerOptions().onState(appSnapState());
    f.managerOptions().onState(appSnapState());
    expect(
      f.send.mock.calls.filter(([channel]) => channel === WINDOW_CAPTURE_IPC.state),
    ).toHaveLength(1);
  });
});

describe("window capture with the AppSnap manager", () => {
  type FakeChildProcess = ChildProcess.ChildProcessWithoutNullStreams & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  const WINDOW = { windowId: 7, appName: "Safari", windowTitle: "Docs" };

  /** A helper double: grant checks answer at once, the listener lists one window. */
  function realFixture(options: {
    readonly savedShortcut?: DesktopAppSnapShortcut | null;
    readonly permissions: Record<string, string>;
    readonly setupError?: string;
  }) {
    const stateDir = stateDirectory(options.savedShortcut);
    const spawn = vi.fn((_path: string, args: readonly string[]) => {
      const child = new EventEmitter() as FakeChildProcess;
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      const write = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
      if (args[0] === "--watch") {
        child.stdin.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            const [request, requestId] = line.split(" ");
            if (request === "list-windows")
              write({ type: "windows", requestId, windows: [WINDOW] });
          }
        });
        setImmediate(() => write({ type: "ready" }));
      } else {
        setImmediate(() => {
          const failed = args[0] === "--prepare-permission-setup" && options.setupError;
          write(
            failed
              ? {
                  type: "error",
                  code: options.setupError,
                  message: "This copy of Ryco is unknown.",
                }
              : { type: "permissions", ...options.permissions },
          );
          child.stdout.end();
          child.stderr.end();
          child.emit("close", failed ? 1 : 0, null);
        });
      }
      return child;
    });
    const register = vi.fn((_accelerator: string, _callback: () => void) => true);
    let manager: DesktopAppSnapManager | null = null;
    const service = new DesktopWindowCapture({
      platform: "darwin",
      helperPath: process.execPath,
      stateDir,
      excludedBundleId: "com.laurinfrank.ryco",
      appDisplayName: "Ryco",
      shortcutRegistry: { register, unregister: vi.fn() },
      openSettingsPane: vi.fn(),
      send: vi.fn(),
      revealWindow: vi.fn(),
      pickerIdleStopMs: 60_000,
      createManager: (input) => {
        manager = new DesktopAppSnapManager({
          ...input,
          spawn: spawn as unknown as typeof ChildProcess.spawn,
        });
        return manager;
      },
    });
    const watchSpawns = () => spawn.mock.calls.filter(([, args]) => args[0] === "--watch").length;
    return { service, register, watchSpawns, manager: () => manager! };
  }

  it("keeps the picker working while another app holds the saved key combo", async () => {
    const f = realFixture({
      savedShortcut: CHORD,
      permissions: { screenRecording: "granted", inputMonitoring: "denied" },
    });
    try {
      f.register.mockReturnValue(false);
      await f.service.start();
      expect(f.service.state()).toMatchObject({
        shortcut: CHORD,
        message: "macOS or another app is already using this shortcut.",
      });

      await expect(f.service.listWindows()).resolves.toEqual([
        expect.objectContaining({ windowId: 7, appName: "Safari" }),
      ]);

      // Once the other app lets go, the next check arms the combo.
      f.register.mockReturnValue(true);
      await f.service.refresh();
      expect(f.register).toHaveBeenLastCalledWith("Control+G", expect.any(Function));
      expect(f.service.state().message).toBeNull();
    } finally {
      f.service.dispose();
    }
  });

  it("keeps the picker working after a failed permission setup", async () => {
    const f = realFixture({
      savedShortcut: { kind: "both-option-keys" },
      permissions: { screenRecording: "granted", inputMonitoring: "denied" },
      setupError: "permission_setup_registration_unresolved",
    });
    try {
      await f.service.start();
      await f.service.setup();
      // The failure stays visible until the next explicit setup or a restart.
      expect(f.manager().getState().status).toBe("error");
      expect(f.service.state().message).toBe("This copy of Ryco is unknown.");

      await expect(f.service.listWindows()).resolves.toHaveLength(1);
    } finally {
      f.service.dispose();
    }
  });

  it("stops an armed combo's listener without starting another when turned off", async () => {
    const f = realFixture({
      savedShortcut: CHORD,
      permissions: { screenRecording: "granted", inputMonitoring: "denied" },
    });
    try {
      await f.service.start();
      expect(f.watchSpawns()).toBe(1);
      expect(f.manager().listenerState().listening).toBe(true);

      await f.service.setShortcut(null);
      expect(f.watchSpawns()).toBe(1);
      expect(f.manager().getState()).toMatchObject({ enabled: false, status: "disabled" });
    } finally {
      f.service.dispose();
    }
  });
});

describe("window capture IPC", () => {
  function ipcFixture() {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    };
    const f = fixture();
    const mainFrame = {};
    const webContents = { mainFrame };
    const window = { webContents, isDestroyed: () => false };
    registerWindowCaptureIpc(ipcMain as never, f.service, () => window as never);
    const invoke = (channel: string, input?: unknown, sender: unknown = webContents) =>
      handlers.get(channel)!({ sender, senderFrame: mainFrame }, input);
    return { ...f, handlers, invoke, ipcMain };
  }

  it("registers every bridge channel and answers only the main window", async () => {
    const f = ipcFixture();
    expect([...f.handlers.keys()].toSorted()).toEqual(
      [
        WINDOW_CAPTURE_IPC.getState,
        WINDOW_CAPTURE_IPC.setup,
        WINDOW_CAPTURE_IPC.setShortcut,
        WINDOW_CAPTURE_IPC.listWindows,
        WINDOW_CAPTURE_IPC.captureWindow,
        WINDOW_CAPTURE_IPC.listPendingCaptures,
        WINDOW_CAPTURE_IPC.readPendingCapture,
        WINDOW_CAPTURE_IPC.acknowledgeCapture,
      ].toSorted(),
    );
    expect(f.ipcMain.removeHandler).toHaveBeenCalledTimes(f.handlers.size);
    expect(() => f.invoke(WINDOW_CAPTURE_IPC.listWindows, undefined, {})).toThrow(
      "only in the Ryco desktop window",
    );
    await expect(f.invoke(WINDOW_CAPTURE_IPC.listWindows)).resolves.toHaveLength(1);
  });

  it("routes captures and acknowledgements to the manager", async () => {
    const f = ipcFixture();
    await f.invoke(WINDOW_CAPTURE_IPC.captureWindow, 7);
    expect(f.manager.captureWindow).toHaveBeenCalledWith(7);
    await f.invoke(WINDOW_CAPTURE_IPC.acknowledgeCapture, "picker-1");
    expect(f.manager.acknowledgeCapture).toHaveBeenCalledWith("picker-1");
    await f.invoke(WINDOW_CAPTURE_IPC.acknowledgeCapture, 42);
    await f.invoke(WINDOW_CAPTURE_IPC.acknowledgeCapture, "x".repeat(200));
    expect(f.manager.acknowledgeCapture).toHaveBeenCalledTimes(1);
    await f.invoke(WINDOW_CAPTURE_IPC.listPendingCaptures);
    expect(f.manager.listPendingCaptureEntries).toHaveBeenCalledTimes(1);
    await f.invoke(WINDOW_CAPTURE_IPC.readPendingCapture, "picker-1");
    expect(f.manager.readPendingCapture).toHaveBeenCalledWith("picker-1");
    await expect(f.invoke(WINDOW_CAPTURE_IPC.readPendingCapture, 42)).resolves.toBeNull();
    expect(f.manager.readPendingCapture).toHaveBeenCalledTimes(1);
    await f.invoke(WINDOW_CAPTURE_IPC.setup, ["screenRecording"]);
    expect(f.manager.startPermissionSetup).toHaveBeenLastCalledWith(["screenRecording"]);
  });
});

describe("window capture copy", () => {
  it("names the feature window capture", () => {
    expect(windowCaptureMessage("AppSnap is not listening.")).toBe(
      "Window capture is not listening.",
    );
    expect(windowCaptureMessage("A previous AppSnap capture is still in progress.")).toBe(
      "A previous window capture is still in progress.",
    );
    expect(windowCaptureMessage("Could not read the captured AppSnap.")).toBe(
      "Could not read the capture.",
    );
    expect(windowCaptureMessage("Timed out. AppSnap stopped listening.")).toBe(
      "Timed out. Window capture stopped listening.",
    );
  });

  it("needs Input Monitoring only for the both-Option-keys shortcut", () => {
    expect(requiredWindowCapturePermissions(null)).toEqual(["screenRecording"]);
    expect(requiredWindowCapturePermissions(CHORD)).toEqual(["screenRecording"]);
    expect(requiredWindowCapturePermissions({ kind: "both-option-keys" })).toEqual([
      "screenRecording",
      "inputMonitoring",
    ]);
  });
});
