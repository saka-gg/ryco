import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AndroidEmulatorBackend,
  quoteAndroidShell,
  runAndroidCommand,
  type AndroidCommand,
} from "./AndroidEmulatorBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { PlatformDeviceBackend } from "./PlatformDeviceBackend.ts";

const UDID = "android:Pixel_Test";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
function fixture(initiallyRunning = true) {
  let running = initiallyRunning;
  let ready = true;
  let devicesOverride: string | undefined;
  let screenshot: Buffer = PNG;
  let installOutput = "Success\n";
  const stop = vi.fn(() => {
    running = false;
  });
  const run = vi.fn<AndroidCommand>(async (command, args) => {
    if (args[0] === "-list-avds") return Buffer.from("Pixel_Test\nTablet\n");
    if (args[0] === "devices")
      return Buffer.from(
        devicesOverride ??
          `List of devices attached\nphysical-device\tdevice\n${running ? "emulator-5554\tdevice transport_id:1\n" : ""}`,
      );
    if (args.includes("name")) return Buffer.from("Pixel_Test\nOK\n");
    if (args.includes("getprop sys.boot_completed")) return Buffer.from(ready ? "1\n" : "0\n");
    if (args.includes("kill")) {
      running = false;
      return Buffer.alloc(0);
    }
    if (args.includes("screencap")) return screenshot;
    if (args[0] === "dump") return Buffer.from("package: name='com.example.app' versionCode='1'\n");
    if (args.includes("install")) return Buffer.from(installOutput);
    if (args.at(-1)?.includes("resolve-activity"))
      return Buffer.from("com.example.app/.MainActivity\n");
    return Buffer.from("");
  });
  const start = vi.fn(async () => {
    running = true;
    return { stop, exited: (): boolean => false };
  });
  const backend = new AndroidEmulatorBackend({
    env: {},
    home: "/nonexistent-android-test",
    run,
    start,
    delay: async () => {},
    bootAttempts: 2,
  });
  return {
    backend,
    run,
    start,
    stop,
    setReady: (value: boolean) => {
      ready = value;
    },
    setDevices: (value: string) => {
      devicesOverride = value;
    },
    setPng: (value: Buffer) => {
      screenshot = value;
    },
    setInstall: (value: string) => {
      installOutput = value;
    },
  };
}

describe("Android SDK adapter", () => {
  it("runs bounded binary commands without a host shell", async () => {
    const payload = "'; $(echo injected) & spaces";
    const bytes = await runAndroidCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      payload,
    ]);
    expect(bytes.toString()).toBe(payload);
    await expect(runAndroidCommand(process.execPath, ["-e", "process.exit(7)"])).rejects.toThrow(
      "Android command",
    );
    await expect(
      runAndroidCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 50),
    ).rejects.toThrow("Android command");
  });
  it("reports missing tooling as actionable setup, on supported hosts", async () => {
    const run = vi.fn<AndroidCommand>().mockRejectedValue(new Error("ENOENT"));
    const backend = new AndroidEmulatorBackend({
      platform: "linux",
      env: { ANDROID_HOME: "/sdk with spaces" },
      run,
    });
    expect(await backend.availability()).toMatchObject({
      kind: "setup-required",
      steps: [
        { id: "install-android-platform-tools", done: false },
        { id: "install-android-emulator", done: false },
      ],
    });
    expect(run.mock.calls[0]?.[0]).toBe("/sdk with spaces/platform-tools/adb");
  });
  it("reports missing AVDs and excludes physical devices", async () => {
    const f = fixture();
    expect(await f.backend.listDevices()).toMatchObject([
      { udid: UDID, state: "booted", bootSource: "user", platform: "android-emulator" },
    ]);
    expect(await f.backend.listDevices({ includeShutdown: true })).toHaveLength(2);
    expect(f.run.mock.calls.some(([, args]) => args.includes("physical-device"))).toBe(false);
    f.run.mockImplementation(async () => Buffer.alloc(0));
    expect(await f.backend.availability()).toMatchObject({
      kind: "setup-required",
      steps: [{ id: "create-android-avd" }],
    });
  });
  it("rejects offline and duplicate instances rather than choosing an ambiguous target", async () => {
    const f = fixture();
    f.setDevices("emulator-5554\toffline\n");
    await expect(f.backend.tap(UDID, 1, 2)).rejects.toThrow("offline");
    f.setDevices("emulator-5554\tdevice transport_id:1\nemulator-5556\tdevice transport_id:2\n");
    await expect(f.backend.shutdown(UDID)).rejects.toThrow("Multiple running instances");
    expect(f.run.mock.calls.some(([, args]) => args.includes("kill"))).toBe(false);
    f.setDevices("emulator-5554\tdevice\n");
    await expect(f.backend.tap(UDID, 1, 2)).rejects.toThrow("no transport ID");
  });
  it("boots once, waits for Android readiness and cleans up only its failed launch", async () => {
    const f = fixture(false);
    const [a, b] = await Promise.all([f.backend.boot(UDID), f.backend.boot(UDID)]);
    expect(a).toEqual(b);
    expect(a.state).toBe("booted");
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.stop).not.toHaveBeenCalled();
    const failing = fixture(false);
    failing.setReady(false);
    await expect(failing.backend.boot(UDID)).rejects.toThrow("timed out");
    expect(failing.stop).toHaveBeenCalledOnce();
    expect((await failing.backend.listDevices({ includeShutdown: true }))[0]?.state).toBe(
      "shutdown",
    );
    await expect(f.backend.boot(UDID)).rejects.toThrow("already running");
    expect(f.start).toHaveBeenCalledOnce();
    const exited = fixture(false);
    exited.start.mockResolvedValueOnce({ stop: exited.stop, exited: () => true });
    await expect(exited.backend.boot(UDID)).rejects.toThrow("exited before boot");
    expect(exited.stop).toHaveBeenCalledOnce();
  });
  it("rejects unknown AVDs and launch failures without retaining a boot", async () => {
    const f = fixture(false);
    await expect(f.backend.boot("android:Missing")).rejects.toThrow("Unknown Android AVD");
    expect(f.start).not.toHaveBeenCalled();
    f.start.mockRejectedValueOnce(new Error("spawn ENOENT"));
    await expect(f.backend.boot(UDID)).rejects.toThrow("ENOENT");
    expect((await f.backend.listDevices({ includeShutdown: true }))[0]?.state).toBe("shutdown");
  });
  it("confirms screenshots and pixel geometry before attaching, rejects bad output", async () => {
    const f = fixture();
    await f.backend.attachStream(UDID, () => {});
    expect(f.backend.geometry(UDID)).toEqual({ pointWidth: 1, pointHeight: 1, scale: 1 });
    expect(await f.backend.screenshot(UDID)).toMatchObject({
      bytesBase64: PNG.toString("base64"),
      width: 1,
      height: 1,
    });
    f.setPng(Buffer.from("error: offline"));
    await expect(f.backend.attachStream(UDID, () => {})).rejects.toThrow("invalid PNG");
    await f.backend.detachStream(UDID);
    expect(f.backend.geometry(UDID)).toBeNull();
  });
  it("quotes remote shell input and translates HID keys, never forwards unchecked flags", async () => {
    const f = fixture();
    await f.backend.typeText(UDID, "hello ' ; $(id) & world");
    expect(f.run.mock.calls.at(-1)?.[1]).toEqual([
      "-t",
      "1",
      "shell",
      "'input' 'text' 'hello%s'\\''%s;%s$(id)%s&%sworld'",
    ]);
    expect(quoteAndroidShell("'")).toBe("''\\'''");
    await f.backend.keyEvent(UDID, { keyCode: 40, modifiers: [], direction: "down" });
    expect(f.run.mock.calls.at(-1)?.[1].at(-1)).toBe("'input' 'keyevent' '66'");
    await f.backend.pressButton(UDID, "back");
    expect(f.run.mock.calls.at(-1)?.[1].at(-1)).toBe("'input' 'keyevent' '4'");
    await f.backend.pressButton(UDID, "recents");
    expect(f.run.mock.calls.at(-1)?.[1].at(-1)).toBe("'input' 'keyevent' '187'");
    await expect(f.backend.typeText(UDID, "こんにちは")).rejects.toThrow("printable ASCII");
    await expect(f.backend.typeText(UDID, "%s")).rejects.toThrow("percent");
    await expect(f.backend.tap(UDID, NaN, 2)).rejects.toThrow("coordinate");
    await expect(f.backend.launch(UDID, "com.example.app;id")).rejects.toThrow("package name");
    await expect(f.backend.launch(UDID, "com.example.app", ["--bad"])).rejects.toThrow("arguments");
    await expect(f.backend.launch(UDID, "com.example.app")).resolves.toMatchObject({
      bundleId: "com.example.app",
      pid: null,
    });
  });
  it("validates APK metadata before install and reports adb failures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ryco-android-test-"));
    try {
      const apk = path.join(directory, "app with spaces.apk");
      await writeFile(apk, "fixture");
      const f = fixture();
      expect(await f.backend.install(UDID, apk)).toEqual({
        udid: UDID,
        bundleId: "com.example.app",
      });
      expect(f.run.mock.calls.at(-1)?.[1]).toEqual(["-t", "1", "install", "-r", apk]);
      f.setInstall("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]");
      await expect(f.backend.install(UDID, apk)).rejects.toThrow("INSTALL_FAILED");
      await expect(f.backend.install(UDID, "relative.apk")).rejects.toThrow("absolute path");
      const originalRun = f.run.getMockImplementation()!;
      f.run.mockImplementation(async (command, args, timeout) => {
        if (args[0] === "dump") throw new Error("aapt missing");
        return originalRun(command, args, timeout);
      });
      await expect(f.backend.install(UDID, apk)).rejects.toThrow("Build-Tools");
      f.run.mockImplementation(async (command, args, timeout) =>
        args[0] === "dump" ? Buffer.from("invalid APK") : originalRun(command, args, timeout),
      );
      await expect(f.backend.install(UDID, apk)).rejects.toThrow("no valid Android package");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not stop user boots on dispose and refuses unsupported features", async () => {
    const f = fixture();
    await expect(f.backend.startRecording(UDID)).rejects.toThrow("not supported");
    await expect(f.backend.describeUi(UDID)).rejects.toThrow("not supported");
    await f.backend.dispose();
    expect(f.stop).not.toHaveBeenCalled();
    await expect(f.backend.tap(UDID, 1, 2)).rejects.toThrow("disposed");
  });
});

describe("shared platform routing", () => {
  it("keeps iOS available without Android tools and Android available without Xcode", async () => {
    const ios = new FakeDeviceBackend();
    const f = fixture();
    const router = new PlatformDeviceBackend(ios, f.backend);
    await router.tap("FAKE-0001", 1, 2).catch(() => {});
    expect(ios.callsOfKind("tap")).toHaveLength(1);
    await router.tap(UDID, 1, 2);
    expect(ios.callsOfKind("tap")).toHaveLength(1);
    f.run.mockRejectedValue(new Error("missing SDK"));
    expect((await router.listDevices({ includeShutdown: true })).map((d) => d.platform)).toEqual(
      Array(4).fill("ios-simulator"),
    );
    expect(await router.availability()).toEqual({ kind: "available" });
    ios.setAvailability({ kind: "unsupported-platform", platform: "linux" });
    expect(await router.availability()).toMatchObject({ kind: "setup-required" });
  });
  it("uses the shared manager boot cap and preserves user boot ownership on shutdown", async () => {
    const f = fixture(false);
    const ios = new FakeDeviceBackend();
    const manager = new DeviceManager({
      backend: new PlatformDeviceBackend(ios, f.backend),
      bootLimit: 1,
    });
    await expect(manager.boot(UDID)).resolves.toMatchObject({
      kind: "booted",
      device: { bootSource: "ryco" },
    });
    await manager.attach("android-thread", UDID);
    await vi.waitFor(async () => {
      const state = await manager.getThreadState("android-thread");
      expect(state).toMatchObject({ attachedDeviceUdid: UDID, attachPhase: null, lastError: null });
      expect(state.devices.find((device) => device.udid === UDID)?.geometry?.scale).toBe(1);
    });
    const originalRun = f.run.getMockImplementation()!;
    f.run.mockRejectedValue(new Error("adb temporarily unavailable"));
    await expect(manager.boot("FAKE-0001")).resolves.toMatchObject({ kind: "boot-limit-reached" });
    f.run.mockImplementation(originalRun);
    await manager.dispose();
    expect(f.run.mock.calls.some(([, args]) => args.includes("kill"))).toBe(true);
    const user = fixture();
    const userManager = new DeviceManager({ backend: user.backend });
    await expect(userManager.boot(UDID)).resolves.toMatchObject({
      kind: "booted",
      device: { bootSource: "user" },
    });
    await userManager.dispose();
    expect(user.run.mock.calls.some(([, args]) => args.includes("kill"))).toBe(false);
  });
});

describe("platform setup usability", () => {
  it("keeps first iOS attachment available without Android tools", async () => {
    const ios = new FakeDeviceBackend({
      availability: {
        kind: "setup-required",
        steps: [
          { id: "install-xcode", label: "Xcode", done: true },
          { id: "build-device-helper", label: "Build helper on attach", done: false },
        ],
      },
    });
    const android = new FakeDeviceBackend({
      availability: {
        kind: "setup-required",
        steps: [{ id: "install-android-platform-tools", label: "Android tools", done: false }],
      },
    });
    const router = new PlatformDeviceBackend(ios, android);
    expect(await router.availability()).toEqual(await ios.availability());
    const manager = new DeviceManager({ backend: router });
    await manager.boot("FAKE-0001");
    await manager.attach("first-ios", "FAKE-0001");
    await vi.waitFor(() => expect(ios.hasStream("FAKE-0001")).toBe(true));
    await manager.dispose();
  });
  it("keeps Android usable when iOS still needs Xcode", async () => {
    const ios = new FakeDeviceBackend({
      availability: {
        kind: "setup-required",
        steps: [{ id: "install-xcode", label: "Xcode", done: false }],
      },
    });
    const android = new FakeDeviceBackend();
    expect(await new PlatformDeviceBackend(ios, android).availability()).toEqual({
      kind: "available",
    });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Android keyboard sequencing", () => {
  it("pins transport between sequential RPCs until explicit detach", async () => {
    const f = fixture();
    await f.backend.typeText(UDID, "a");
    f.setDevices("emulator-5554\tdevice transport_id:2\n");
    await expect(f.backend.typeText(UDID, "b")).rejects.toThrow("transport changed");
    await expect(
      f.backend.keyEvent(UDID, { keyCode: 42, direction: "down", modifiers: [] }),
    ).rejects.toThrow("target changed");
    expect(f.run.mock.calls.filter(([, args]) => args.at(-1)?.startsWith("'input'"))).toEqual([
      [expect.any(String), ["-t", "1", "shell", "'input' 'text' 'a'"]],
    ]);
    await f.backend.detachStream(UDID);
    await f.backend.attachStream(UDID, () => undefined);
    await f.backend.typeText(UDID, "c");
    expect(f.run.mock.calls.at(-1)?.[1]).toEqual(["-t", "2", "shell", "'input' 'text' 'c'"]);
  });
  it("orders text, Backspace and Enter before delayed discovery and responses", async () => {
    const f = fixture();
    const run = f.run.getMockImplementation()!;
    const discovery = deferred(),
      response = deferred();
    let discoveries = 0;
    const inputs: string[] = [];
    f.run.mockImplementation(async (command, args, timeout) => {
      if (args[0] === "devices" && ++discoveries === 1) await discovery.promise;
      if (args.at(-1)?.startsWith("'input'")) {
        inputs.push(args.at(-1)!);
        if (inputs.length === 1) await response.promise;
      }
      return run(command, args, timeout);
    });
    const requests = [
      f.backend.typeText(UDID, "a"),
      f.backend.typeText(UDID, "b"),
      f.backend.keyEvent(UDID, { keyCode: 42, direction: "down", modifiers: [] }),
      f.backend.keyEvent(UDID, { keyCode: 40, direction: "down", modifiers: [] }),
    ];
    await vi.waitFor(() => expect(discoveries).toBe(1));
    expect(inputs).toEqual([]);
    discovery.resolve();
    await vi.waitFor(() => expect(inputs).toEqual(["'input' 'text' 'a'"]));
    expect(discoveries).toBe(1);
    response.resolve();
    await Promise.all(requests);
    expect(inputs).toEqual([
      "'input' 'text' 'a'",
      "'input' 'text' 'b'",
      "'input' 'keyevent' '67'",
      "'input' 'keyevent' '66'",
    ]);
  });
  it.each(["detach", "shutdown", "dispose"] as const)(
    "cancels keys waiting on discovery after %s",
    async (lifecycle) => {
      const f = fixture();
      const run = f.run.getMockImplementation()!;
      const discovery = deferred();
      let discoveries = 0;
      f.run.mockImplementation(async (command, args, timeout) => {
        if (args[0] === "devices" && ++discoveries === 1) await discovery.promise;
        return run(command, args, timeout);
      });
      const first = f.backend.typeText(UDID, "a"),
        second = f.backend.typeText(UDID, "b");
      const results = Promise.allSettled([first, second]);
      await vi.waitFor(() => expect(discoveries).toBe(1));
      if (lifecycle === "detach") await f.backend.detachStream(UDID);
      else if (lifecycle === "shutdown") await f.backend.shutdown(UDID);
      else await f.backend.dispose();
      discovery.resolve();
      expect((await results).every((result) => result.status === "rejected")).toBe(true);
      expect(f.run.mock.calls.some(([, args]) => args.at(-1)?.startsWith("'input'"))).toBe(false);
    },
  );
  it("refuses queued keys after an external emulator transport change", async () => {
    const f = fixture();
    const run = f.run.getMockImplementation()!;
    const response = deferred();
    const inputs: string[] = [];
    f.run.mockImplementation(async (command, args, timeout) => {
      if (args.at(-1)?.startsWith("'input'")) {
        inputs.push(args.at(-1)!);
        await response.promise;
      }
      return run(command, args, timeout);
    });
    const results = Promise.allSettled([
      f.backend.typeText(UDID, "a"),
      f.backend.typeText(UDID, "b"),
    ]);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    f.setDevices("emulator-5554\tdevice transport_id:2\n");
    response.resolve();
    expect((await results).map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(inputs).toEqual(["'input' 'text' 'a'"]);
  });
});
