/** Android SDK adapter. DeviceManager remains the owner of boots and attachments. */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
  DeviceAvailability,
  DeviceDescriptor,
  DeviceGeometry,
  DeviceHardwareButton,
  DeviceScreenshotResult,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
  DeviceDescribeUiResult,
} from "@ryco/contracts";
import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceFrameListener,
  type DeviceKeyEvent,
  type DeviceListOptions,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";

const AVD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PREFIX = "android:";
const MAX_OUTPUT = 16 * 1024 * 1024;

export type AndroidCommand = (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<Buffer>;

/** No host shell, including on Windows. adb shell arguments are quoted separately below. */
export const runAndroidCommand: AndroidCommand = (command, args, timeoutMs = 15_000) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "buffer", timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new DeviceBackendError(
              `Android command ${path.basename(command)} failed: ${stderr.toString().trim().slice(0, 1_000) || error.message.slice(0, 1_000)}`,
              { cause: error },
            ),
          );
        else resolve(stdout);
      },
    );
  });

export interface AndroidEmulatorOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly run?: AndroidCommand;
  readonly start?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ stop(): void; exited(): boolean }>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly bootAttempts?: number;
  readonly screenshotDirectory?: string;
}

function startEmulator(
  command: string,
  args: readonly string[],
): Promise<{ stop(): void; exited(): boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("spawn", () =>
      resolve({
        stop: () => {
          child.kill("SIGKILL");
        },
        exited: () => child.exitCode !== null || child.signalCode !== null,
      }),
    );
  });
}

/** adb joins shell arguments into a remote shell command: argv alone is insufficient. */
export function quoteAndroidShell(value: string): string {
  if (value.includes("\0")) throw new DeviceBackendError("Android input cannot contain NUL.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export class AndroidEmulatorBackend implements DeviceBackend {
  readonly platform = "android-emulator" as const;
  private readonly hostPlatform: NodeJS.Platform;
  private readonly sdk: string | undefined;
  private readonly run: AndroidCommand;
  private readonly start: NonNullable<AndroidEmulatorOptions["start"]>;
  private readonly delay: NonNullable<AndroidEmulatorOptions["delay"]>;
  private readonly geometries = new Map<string, DeviceGeometry>();
  private readonly boots = new Map<string, Promise<DeviceDescriptor>>();
  private readonly starting = new Set<{ stop(): void }>();
  private disposed = false;
  private readonly keyboardQueues = new Map<
    string,
    {
      tail: Promise<void>;
      pending: number;
      cancelled: boolean;
      transportId?: string;
    }
  >();

  private cancelKeyboard(udid: string): void {
    const queue = this.keyboardQueues.get(udid);
    if (queue) queue.cancelled = true;
    this.keyboardQueues.delete(udid);
  }

  /** Preserve arrival order before asynchronous discovery; never retarget queued keys. */
  private keyboard(udid: string, args: readonly string[]): Promise<void> {
    if (this.disposed)
      return Promise.reject(new DeviceBackendError("Android backend is disposed."));
    let queue = this.keyboardQueues.get(udid);
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0, cancelled: false };
      this.keyboardQueues.set(udid, queue);
    }
    if (queue.pending >= 64)
      return Promise.reject(new DeviceBackendError("Android keyboard queue is full."));
    const batch = queue;
    const assertCurrent = () => {
      if (this.disposed || batch.cancelled)
        throw new DeviceBackendError("Android keyboard target changed; queued input cancelled.");
    };
    batch.pending++;
    const result = batch.tail
      .then(async () => {
        assertCurrent();
        const transportId = await this.transportId(udid);
        assertCurrent();
        if (batch.transportId !== undefined && batch.transportId !== transportId) {
          throw new DeviceBackendError(
            "Android keyboard transport changed; queued input cancelled.",
          );
        }
        batch.transportId = transportId;
        await this.run(this.tool("adb"), [
          "-t",
          transportId,
          "shell",
          args.map(quoteAndroidShell).join(" "),
        ]);
      })
      .catch((error: unknown) => {
        batch.cancelled = true;
        throw error;
      })
      .finally(() => {
        batch.pending--;
        // Keep the transport (and failures) pinned between sequential RPCs.
        // Only an explicit detach/shutdown ends this input session.
      });
    batch.tail = result.catch(() => undefined);
    return result;
  }
  private availabilityProbe: { expires: number; value: Promise<DeviceAvailability> } | null = null;

  private readonly options: AndroidEmulatorOptions;
  constructor(options: AndroidEmulatorOptions = {}) {
    this.options = options;
    this.hostPlatform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    this.sdk =
      env.ANDROID_HOME?.trim() ||
      env.ANDROID_SDK_ROOT?.trim() ||
      [
        path.join(home, "Library", "Android", "sdk"),
        path.join(home, "Android", "Sdk"),
        path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Android", "Sdk"),
      ].find(existsSync);
    this.run = options.run ?? runAndroidCommand;
    this.start = options.start ?? startEmulator;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private tool(name: "adb" | "emulator"): string {
    const binary = name + (this.hostPlatform === "win32" ? ".exe" : "");
    return this.sdk
      ? path.join(this.sdk, name === "adb" ? "platform-tools" : "emulator", binary)
      : binary;
  }

  private name(udid: string): string {
    const name = udid.startsWith(PREFIX) ? udid.slice(PREFIX.length) : "";
    if (!AVD_NAME.test(name))
      throw new DeviceBackendError("Invalid Android virtual device identifier.");
    return name;
  }

  private async avds(): Promise<string[]> {
    return [
      ...new Set(
        (await this.run(this.tool("emulator"), ["-list-avds"]))
          .toString()
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => AVD_NAME.test(s)),
      ),
    ];
  }

  availability(): Promise<DeviceAvailability> {
    if (this.availabilityProbe && this.availabilityProbe.expires > Date.now())
      return this.availabilityProbe.value;
    const value = this.probeAvailability();
    this.availabilityProbe = { expires: Date.now() + 5_000, value };
    return value;
  }

  private async probeAvailability(): Promise<DeviceAvailability> {
    if (!["darwin", "linux", "win32"].includes(this.hostPlatform))
      return { kind: "unsupported-platform", platform: this.hostPlatform };
    const steps = await Promise.all(
      (
        [
          [
            "install-android-platform-tools",
            "adb",
            ["version"],
            "Install Android SDK Platform-Tools",
          ],
          ["install-android-emulator", "emulator", ["-version"], "Install Android Emulator"],
        ] as const
      ).map(async ([id, tool, args, label]) => ({
        id,
        label,
        done: await this.run(this.tool(tool), args).then(
          () => true,
          () => false,
        ),
        detail:
          "Use Android Studio's SDK Manager; set ANDROID_HOME for a custom SDK, or put the tools on PATH.",
      })),
    );
    if (steps.some((step) => !step.done)) return { kind: "setup-required", steps };
    try {
      if ((await this.avds()).length === 0)
        return {
          kind: "setup-required",
          steps: [
            {
              id: "create-android-avd",
              label: "Create an Android virtual device",
              done: false,
              detail:
                "Use Android Studio's Device Manager to install a system image and create an AVD.",
            },
          ],
        };
      await this.running();
      return { kind: "available" };
    } catch (error) {
      return {
        kind: "setup-required",
        steps: [
          {
            id: "create-android-avd",
            label: "Check Android virtual devices",
            done: false,
            detail: String(error).slice(0, 1_000),
          },
        ],
      };
    }
  }

  private async running(): Promise<
    Map<string, { serial: string; transportId: string; ready: boolean }>
  > {
    const output = (await this.run(this.tool("adb"), ["devices", "-l"])).toString();
    const result = new Map<string, { serial: string; transportId: string; ready: boolean }>();
    for (const line of output.split(/\r?\n/)) {
      const match = /^(emulator-\d+)\s+(\S+)/.exec(line);
      if (!match) continue; // Never address physical devices or network adb targets.
      const serial = match[1]!;
      const transportId = /(?:^|\s)transport_id:(\d+)(?:\s|$)/.exec(line)?.[1];
      if (match[2] !== "device")
        throw new DeviceBackendError(
          `Android emulator ${serial} is ${match[2]}; reconnect it in Android Studio.`,
          { retryable: true },
        );
      if (!transportId)
        throw new DeviceBackendError(
          `Android emulator ${serial} has no transport ID; update Android SDK Platform-Tools.`,
        );
      const name = (await this.run(this.tool("adb"), ["-t", transportId, "emu", "avd", "name"]))
        .toString()
        .split(/\r?\n/)[0]
        ?.trim();
      if (!name || !AVD_NAME.test(name))
        throw new DeviceBackendError(`Cannot identify Android emulator ${serial}.`);
      if (result.has(name))
        throw new DeviceBackendError(
          `Multiple running instances of AVD ${name}; close duplicates before controlling it.`,
        );
      const ready =
        (
          await this.run(this.tool("adb"), [
            "-t",
            transportId,
            "shell",
            "getprop sys.boot_completed",
          ])
        )
          .toString()
          .trim() === "1";
      result.set(name, { serial, transportId, ready });
    }
    return result;
  }

  async listDevices(options: DeviceListOptions = {}): Promise<readonly DeviceDescriptor[]> {
    const names = await this.avds();
    const running = await this.running();
    return names
      .map((name): DeviceDescriptor => ({
        platform: this.platform,
        udid: PREFIX + name,
        name,
        runtime: "Android AVD",
        state: running.has(name)
          ? running.get(name)!.ready
            ? "booted"
            : "booting"
          : this.boots.has(PREFIX + name)
            ? "booting"
            : "shutdown",
        bootSource: "user",
      }))
      .filter((device) => options.includeShutdown || device.state !== "shutdown");
  }

  boot(udid: string): Promise<DeviceDescriptor> {
    const pending = this.boots.get(udid);
    if (pending) return pending;
    const boot = this.bootDevice(udid).finally(() => this.boots.delete(udid));
    this.boots.set(udid, boot);
    return boot;
  }

  private async bootDevice(udid: string): Promise<DeviceDescriptor> {
    if (this.disposed) throw new DeviceBackendError("Android backend is disposed.");
    const name = this.name(udid);
    const device = (await this.listDevices({ includeShutdown: true })).find((d) => d.udid === udid);
    if (!device) throw new DeviceBackendError(`Unknown Android AVD ${name}.`);
    // A user-owned boot in progress must not become a Ryco-owned boot.
    if ((await this.running()).has(name))
      throw new DeviceBackendError(
        `Android AVD ${name} is already running; refresh and attach when booted.`,
        { retryable: true },
      );
    const child = await this.start(this.tool("emulator"), [
      "-avd",
      name,
      "-no-window",
      "-no-audio",
    ]);
    this.starting.add(child);
    const deadline = Date.now() + 120_000;
    try {
      for (
        let attempt = 0;
        attempt < (this.options.bootAttempts ?? 120) && Date.now() < deadline;
        attempt++
      ) {
        if (this.disposed || child.exited())
          throw new DeviceBackendError(
            `Android emulator ${name} exited before boot completed. Check its system image and hardware acceleration in Android Studio.`,
          );
        const running = await this.running().catch(() => null);
        if (running?.get(name)?.ready) return { ...device, state: "booted" };
        await this.delay(1_000);
      }
      throw new DeviceBackendError(
        `Android emulator ${name} boot timed out. Check its system image and hardware acceleration in Android Studio.`,
        { retryable: true },
      );
    } catch (error) {
      child.stop(); // Only our launch, never an emulator identified by a reused adb port.
      throw error;
    } finally {
      this.starting.delete(child);
    }
  }

  private async transportId(udid: string): Promise<string> {
    if (this.disposed) throw new DeviceBackendError("Android backend is disposed.");
    const device = (await this.running()).get(this.name(udid));
    if (!device?.ready)
      throw new DeviceBackendError(`Android device ${udid} is not booted.`, { retryable: true });
    return device.transportId;
  }

  private async shell(udid: string, args: readonly string[]): Promise<string> {
    const transportId = await this.transportId(udid);
    return (
      await this.run(this.tool("adb"), [
        "-t",
        transportId,
        "shell",
        args.map(quoteAndroidShell).join(" "),
      ])
    ).toString();
  }

  async shutdown(udid: string): Promise<void> {
    this.cancelKeyboard(udid);
    const current = (await this.running()).get(this.name(udid));
    if (current) await this.run(this.tool("adb"), ["-t", current.transportId, "emu", "kill"]);
    this.geometries.delete(udid);
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.shell(udid, ["input", "tap", this.coordinate(x), this.coordinate(y)]);
  }
  private coordinate(value: number): string {
    if (!Number.isFinite(value) || value < 0 || value > 20_000)
      throw new DeviceBackendError("Invalid Android input coordinate.");
    return String(Math.round(value));
  }
  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    if (
      !Number.isInteger(gesture.durationMs) ||
      gesture.durationMs < 0 ||
      gesture.durationMs > 10_000
    )
      throw new DeviceBackendError("Invalid Android swipe duration.");
    await this.shell(udid, [
      "input",
      "swipe",
      ...[gesture.fromX, gesture.fromY, gesture.toX, gesture.toY].map((v) => this.coordinate(v)),
      String(gesture.durationMs),
    ]);
  }
  async typeText(udid: string, text: string): Promise<void> {
    if (!/^[\x20-\x7e]*$/.test(text) || text.includes("%"))
      throw new DeviceBackendError(
        "Android text input supports printable ASCII without percent signs; use the emulator keyboard for other text.",
      );
    await this.keyboard(udid, ["input", "text", text.replaceAll(" ", "%s")]);
  }
  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    if (event.modifiers.length)
      throw new DeviceBackendError("Android key modifiers are not supported; use text input.");
    const code =
      event.keyCode >= 4 && event.keyCode <= 29
        ? event.keyCode + 25
        : event.keyCode >= 30 && event.keyCode <= 38
          ? event.keyCode - 22
          : (
              {
                39: 7,
                40: 66,
                41: 4,
                42: 67,
                43: 61,
                44: 62,
                79: 22,
                80: 21,
                81: 20,
                82: 19,
              } as Record<number, number>
            )[event.keyCode];
    if (code === undefined)
      throw new DeviceBackendError("This HID key is not supported by Android input.");
    if (event.direction === "down") await this.keyboard(udid, ["input", "keyevent", String(code)]);
  }
  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    const code = (
      { home: 3, back: 4, recents: 187, lock: 26, "volume-up": 24, "volume-down": 25 } as Partial<
        Record<DeviceHardwareButton, number>
      >
    )[button];
    if (code === undefined)
      throw new DeviceBackendError("This hardware button is not supported by the Android adapter.");
    await this.keyboard(udid, ["input", "keyevent", String(code)]);
  }
  async openUrl(udid: string, url: string): Promise<void> {
    const result = await this.shell(udid, [
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      url,
    ]);
    this.checkLaunch(result);
  }
  private checkLaunch(output: string): void {
    if (/Error:|Exception|unable to resolve Intent/i.test(output))
      throw new DeviceBackendError(`Android launch failed: ${output.trim().slice(0, 1_000)}`);
  }
  async launch(udid: string, bundleId: string, args: readonly string[] = []) {
    if (!PACKAGE.test(bundleId)) throw new DeviceBackendError("Invalid Android package name.");
    if (args.length)
      throw new DeviceBackendError(
        "Android launch arguments are not supported; use an app deep link.",
      );
    const resolved = await this.shell(udid, [
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LAUNCHER",
      bundleId,
    ]);
    const component = resolved.trim().split(/\r?\n/).at(-1) ?? "";
    if (
      !/^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(component) ||
      !component.startsWith(bundleId + "/")
    )
      throw new DeviceBackendError(`No launchable activity found for ${bundleId}.`);
    this.checkLaunch(await this.shell(udid, ["am", "start", "-W", "-n", component]));
    return { udid, bundleId, pid: null };
  }
  async install(udid: string, appPath: string) {
    if (
      !path.isAbsolute(appPath) ||
      !appPath.toLowerCase().endsWith(".apk") ||
      !(await stat(appPath)).isFile()
    )
      throw new DeviceBackendError(
        "Android install requires an absolute path to a built .apk file.",
      );
    let aapt = "aapt" + (this.hostPlatform === "win32" ? ".exe" : "");
    if (this.sdk) {
      const versions = await readdir(path.join(this.sdk, "build-tools")).catch(() => []);
      const candidate = versions
        .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((v) => path.join(this.sdk!, "build-tools", v, aapt))
        .find(existsSync);
      if (candidate) aapt = candidate;
    }
    const metadata = await this.run(aapt, ["dump", "badging", appPath]).catch((cause) => {
      throw new DeviceBackendError(
        "Cannot read APK package name. Install Android SDK Build-Tools (aapt) and check the APK.",
        { cause },
      );
    });
    const bundleId = /^package: name='([^']+)'/m.exec(metadata.toString())?.[1];
    if (!bundleId || !PACKAGE.test(bundleId))
      throw new DeviceBackendError("APK metadata has no valid Android package name.");
    const transportId = await this.transportId(udid);
    const output = (
      await this.run(this.tool("adb"), ["-t", transportId, "install", "-r", appPath], 120_000)
    ).toString();
    if (!/^Success\s*$/m.test(output))
      throw new DeviceBackendError(`Android APK install failed: ${output.trim().slice(0, 1_000)}`);
    return { udid, bundleId };
  }

  async screenshot(
    udid: string,
    options: { readonly save?: boolean } = {},
  ): Promise<DeviceScreenshotResult> {
    const transportId = await this.transportId(udid);
    const bytes = await this.run(this.tool("adb"), [
      "-t",
      transportId,
      "exec-out",
      "screencap",
      "-p",
    ]);
    if (
      bytes.length < 45 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
    )
      throw new DeviceBackendError("Android screenshot returned invalid PNG data.", {
        retryable: true,
      });
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (!width || !height || width > 20_000 || height > 20_000)
      throw new DeviceBackendError("Android screenshot dimensions are invalid.");
    this.geometries.set(udid, { pointWidth: width, pointHeight: height, scale: 1 });
    const capturedAt = new Date().toISOString();
    const name = `android-${this.name(udid)}-${capturedAt.replaceAll(/[:.]/g, "-")}.png`;
    let savedPath: string | undefined;
    if (options.save) {
      const directory = this.options.screenshotDirectory ?? path.join(homedir(), "Desktop");
      await mkdir(directory, { recursive: true });
      savedPath = path.join(directory, name);
      await writeFile(savedPath, bytes, { flag: "wx" });
    }
    return {
      udid,
      name,
      mimeType: "image/png",
      width,
      height,
      sizeBytes: bytes.length,
      bytesBase64: bytes.toString("base64"),
      capturedAt,
      ...(savedPath ? { path: savedPath } : {}),
    };
  }
  geometry(udid: string): DeviceGeometry | null {
    return this.geometries.get(udid) ?? null;
  }
  async attachStream(udid: string, _listener: DeviceFrameListener): Promise<void> {
    // Confirm the display before the shared manager publishes attachment readiness.
    // Preview uses the same authorized, backpressured screenshot RPC as hosted iOS.
    await this.screenshot(udid);
  }
  async detachStream(udid: string): Promise<void> {
    this.cancelKeyboard(udid);
    this.geometries.delete(udid);
  }
  startRecording(_udid: string): Promise<DeviceStartRecordingResult> {
    return Promise.reject(
      new DeviceBackendError(
        "Android recording is not supported; use Android Studio to record the emulator.",
      ),
    );
  }
  stopRecording(_udid: string): Promise<DeviceStopRecordingResult> {
    return Promise.reject(new DeviceBackendError("Android recording is not supported."));
  }
  describeUi(_udid: string): Promise<DeviceDescribeUiResult> {
    return Promise.reject(
      new DeviceBackendError(
        "Android accessibility inspection is not supported; use a screenshot and coordinate input.",
      ),
    );
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const udid of this.keyboardQueues.keys()) this.cancelKeyboard(udid);
    for (const child of this.starting) child.stop();
    await Promise.allSettled(this.boots.values());
    this.geometries.clear();
  }
}
