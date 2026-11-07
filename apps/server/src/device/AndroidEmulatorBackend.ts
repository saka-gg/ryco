/**
 * Android SDK adapter. DeviceManager remains the owner of boots and attachments.
 *
 * Per running emulator it keeps, lazily:
 *
 * - a scrcpy control session (`android/scrcpySession.ts`) for every input:
 *   live touch phases, taps, swipes, keys, text, clipboard paste, hardware
 *   buttons and rotation, over one socket instead of an `adb shell input`
 *   process per event;
 * - a scrcpy video session while a pane watches: H.264 into the shared
 *   `DeviceFrameTransport`, the same path iOS uses;
 * - Ryco's resident UI reader (`android/androidUiHelper.ts`) for the
 *   accessibility tree agents target by ref, label and role.
 *
 * Every one of them degrades rather than fails: without scrcpy (no network
 * for the one-time download) input falls back to `adb shell input` and the
 * pane to screenshots; without a JDK the tree comes from `uiautomator dump`.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import type {
  DeviceAvailability,
  DeviceOrientation,
  DeviceDescriptor,
  DeviceGeometry,
  DeviceHardwareButton,
  DeviceKeyModifier,
  DeviceScreenshotResult,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
  DeviceDescribeUiResult,
  DeviceTestingInput,
} from "@ryco/contracts";
import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceFrameListener,
  type DeviceKeyEvent,
  type DeviceListOptions,
  type DeviceLogQuery,
  type DeviceLogResult,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";
import { selectRecordingDirectory } from "./IosSimulatorBackend.ts";
import {
  androidSetupSteps,
  installedSystemImages,
  resolveAndroidSdk,
  type AndroidSdk,
} from "./android/androidSdk.ts";
import type * as AndroidRuntimeModule from "./android/androidRuntime.ts";
import type {
  AndroidUiHelperBuild,
  AndroidUiHelperSession,
  ScrcpyHost,
  ScrcpyServerArtifact,
  ScrcpySession,
  ScrcpyVideoEvent,
  ScrcpyVideoOptions,
} from "./android/androidRuntime.ts";

let androidRuntime: Promise<typeof AndroidRuntimeModule> | null = null;
/** scrcpy, the UI reader, logs and testing: loaded on first use, never at boot. */
const loadAndroid = () => (androidRuntime ??= import("./android/androidRuntime.ts"));

const AVD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PREFIX = "android:";
const MAX_OUTPUT = 16 * 1024 * 1024;
/** Input with nobody typing for this long gives its scrcpy session back. */
const CONTROL_IDLE_MS = 120_000;
/** One finger step of a swipe: about one frame. */
const SWIPE_STEP_MS = 16;
/** Twice Android's 40 ms "pointer stopped" window, so a swipe never flings. */
const SWIPE_HOLD_MS = 80;
/** screenrecord's own ceiling on Android: three minutes per file. */
const RECORDING_TIME_LIMIT_S = 180;

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
  /** Long-lived adb processes (scrcpy, the UI reader, screenrecord). */
  readonly spawnProcess?: (command: string, args: readonly string[]) => ChildProcess;
  readonly delay?: (ms: number) => Promise<void>;
  readonly bootAttempts?: number;
  readonly screenshotDirectory?: string;
  readonly recordingDirectory?: string;
  /**
   * Null turns live video and the input channel off (adb input and screenshots
   * only); so does `RYCO_ANDROID_SCRCPY=0` in the environment.
   */
  readonly scrcpy?: ScrcpyServerArtifact | null;
  readonly video?: ScrcpyVideoOptions;
  /** Null always reads the tree with `uiautomator dump`. */
  readonly uiHelper?: AndroidUiHelperBuild | null;
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

const spawnProcess = (command: string, args: readonly string[]): ChildProcess =>
  spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });

/** adb joins shell arguments into a remote shell command: argv alone is insufficient. */
export function quoteAndroidShell(value: string): string {
  if (value.includes("\0")) throw new DeviceBackendError("Android input cannot contain NUL.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** USB HID usage to Android keycode, for keys the pane forwards. */
const HID_TO_ANDROID: Record<number, number> = {
  39: 7, // 0
  40: 66, // Enter
  41: 111, // Escape
  42: 67, // Backspace
  43: 61, // Tab
  44: 62, // Space
  45: 69, // -
  46: 70, // =
  47: 71, // [
  48: 72, // ]
  49: 73, // backslash
  51: 74, // ;
  52: 75, // '
  53: 68, // `
  54: 55, // ,
  55: 56, // .
  56: 76, // /
  57: 115, // Caps Lock
  74: 122, // Home
  75: 92, // Page Up
  76: 112, // Forward delete
  77: 123, // End
  78: 93, // Page Down
  79: 22, // Right
  80: 21, // Left
  81: 20, // Down
  82: 19, // Up
  224: 113, // Left Control
  225: 59, // Left Shift
  226: 57, // Left Alt
  227: 117, // Left Meta
  228: 114, // Right Control
  229: 60, // Right Shift
  230: 58, // Right Alt
  231: 118, // Right Meta
};

export function androidKeycode(hid: number): number | undefined {
  if (hid >= 4 && hid <= 29) return hid + 25; // A-Z
  if (hid >= 30 && hid <= 38) return hid - 22; // 1-9
  if (hid >= 58 && hid <= 69) return hid + 73; // F1-F12
  return HID_TO_ANDROID[hid];
}

const META: Record<DeviceKeyModifier, number> = {
  shift: 0x1 | 0x40,
  option: 0x2 | 0x10,
  control: 0x1000 | 0x2000,
  command: 0x10000 | 0x20000,
  function: 0x8,
};

const BUTTON_KEYCODE: Partial<Record<DeviceHardwareButton, number>> = {
  home: 3,
  back: 4,
  recents: 187,
  lock: 26,
  "volume-up": 24,
  "volume-down": 25,
};

export type AndroidTouchPhase = "down" | "move" | "up";
export type AndroidOrientation = DeviceOrientation;

interface VideoState {
  readonly session: ScrcpySession;
  sequence: number;
  size: { width: number; height: number } | null;
}

/** What Ryco keeps per running emulator, bound to one adb transport. */
interface DeviceRuntime {
  readonly transportId: string;
  apiLevel: number | null;
  /** Natural-orientation display size from `wm size`. */
  physical: { readonly width: number; readonly height: number } | null;
  scrcpyPushed: boolean;
  uiHelperPushed: boolean;
  control: Promise<ScrcpySession> | null;
  /** The control session once started, for input that must not wait on adb discovery. */
  controlSession: ScrcpySession | null;
  controlIdle: ReturnType<typeof setTimeout> | null;
  video: VideoState | null;
  ui: Promise<AndroidUiHelperSession> | null;
  recording: {
    readonly child: ChildProcess;
    readonly devicePath: string;
    readonly hostPath: string;
    readonly startedAt: number;
    readonly exited: Promise<void>;
  } | null;
  /** Serializes input so a key typed after a tap never overtakes it. */
  inputTail: Promise<unknown>;
}

export class AndroidEmulatorBackend implements DeviceBackend {
  readonly platform = "android-emulator" as const;
  private readonly hostPlatform: NodeJS.Platform;
  private readonly sdk: AndroidSdk;
  private readonly run: AndroidCommand;
  private readonly start: NonNullable<AndroidEmulatorOptions["start"]>;
  private readonly spawnProcess: NonNullable<AndroidEmulatorOptions["spawnProcess"]>;
  private readonly delay: NonNullable<AndroidEmulatorOptions["delay"]>;
  /** False with `scrcpy: null` or RYCO_ANDROID_SCRCPY=0: adb input and screenshots only. */
  private readonly scrcpyEnabled: boolean;
  private scrcpyArtifact: ScrcpyServerArtifact | undefined;
  private readonly uiHelperEnabled: boolean;
  private uiHelperBuild: AndroidUiHelperBuild | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly geometries = new Map<string, DeviceGeometry>();
  private readonly previews = new Map<string, "video" | "screenshots">();
  private readonly runtimes = new Map<string, DeviceRuntime>();
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

  /**
   * The `adb shell input` fallback keyboard: arrival order kept before
   * asynchronous discovery, and queued keys never retargeted.
   */
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
    this.sdk = resolveAndroidSdk({
      env,
      home: options.home ?? homedir(),
      platform: this.hostPlatform,
    });
    this.run = options.run ?? runAndroidCommand;
    this.start = options.start ?? startEmulator;
    this.spawnProcess = options.spawnProcess ?? spawnProcess;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // RYCO_ANDROID_SCRCPY=0 keeps the pre-scrcpy path (adb input, screenshots), for a node
    // whose emulators misbehave under scrcpy or that must never download it.
    this.env = env;
    // RYCO_ANDROID_SCRCPY=0 keeps the pre-scrcpy path (adb input, screenshots), for a node
    // whose emulators misbehave under scrcpy or that must never download it.
    this.scrcpyEnabled =
      options.scrcpy !== null &&
      !(options.scrcpy === undefined && env.RYCO_ANDROID_SCRCPY?.trim() === "0");
    this.scrcpyArtifact = options.scrcpy ?? undefined;
    this.uiHelperEnabled = options.uiHelper !== null;
    this.uiHelperBuild = options.uiHelper ?? undefined;
  }

  private tool(name: "adb" | "emulator" | "avdmanager"): string {
    return this.sdk.tool(name);
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
    const works = (tool: "adb" | "emulator", args: readonly string[]) =>
      this.run(this.tool(tool), args).then(
        () => true,
        () => false,
      );
    const [adb, emulator] = await Promise.all([
      works("adb", ["version"]),
      works("emulator", ["-version"]),
    ]);
    let avdCount: number | null = null;
    let avdError: string | null = null;
    if (emulator) {
      try {
        avdCount = (await this.avds()).length;
      } catch (error) {
        avdError = String(error).slice(0, 1_000);
      }
    }
    const steps = androidSetupSteps({
      sdk: this.sdk,
      adb,
      emulator,
      avdCount,
      avdmanager: existsSync(this.tool("avdmanager")),
      systemImages: avdCount === 0 ? installedSystemImages(this.sdk.root) : [],
    });
    if (avdError !== null)
      steps.push({
        id: "create-android-avd",
        label: "Check Android virtual devices",
        done: false,
        detail: avdError,
      });
    if (steps.some((step) => !step.done)) return { kind: "setup-required", steps };
    try {
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

  /**
   * The runtime for the emulator now behind `udid`. A new transport (the
   * emulator restarted) ends everything bound to the old one.
   */
  private async runtime(udid: string): Promise<DeviceRuntime> {
    const transportId = await this.transportId(udid);
    const existing = this.runtimes.get(udid);
    if (existing?.transportId === transportId) return existing;
    if (existing) await this.closeRuntime(udid);
    const created: DeviceRuntime = {
      transportId,
      apiLevel: null,
      physical: null,
      scrcpyPushed: false,
      uiHelperPushed: false,
      control: null,
      controlSession: null,
      controlIdle: null,
      video: null,
      ui: null,
      recording: null,
      inputTail: Promise.resolve(),
    };
    this.runtimes.set(udid, created);
    return created;
  }

  private async closeRuntime(udid: string): Promise<void> {
    const runtime = this.runtimes.get(udid);
    if (!runtime) return;
    this.runtimes.delete(udid);
    if (runtime.controlIdle) clearTimeout(runtime.controlIdle);
    const control = runtime.control;
    runtime.control = null;
    runtime.controlSession = null;
    const video = runtime.video;
    runtime.video = null;
    const ui = runtime.ui;
    runtime.ui = null;
    // The emulator is gone or restarted: its file cannot be pulled any more.
    runtime.recording?.child.kill("SIGKILL");
    runtime.recording = null;
    await Promise.allSettled([
      control?.then((session) => session.close()),
      video?.session.close(),
      ui?.then((session) => session.close()),
    ]);
  }

  private adbFor(transportId: string, args: readonly string[]): readonly string[] {
    return ["-t", transportId, ...args];
  }

  private async shellIn(
    runtime: DeviceRuntime,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<string> {
    return (
      await this.run(
        this.tool("adb"),
        this.adbFor(runtime.transportId, ["shell", args.map(quoteAndroidShell).join(" ")]),
        timeoutMs,
      )
    ).toString();
  }

  private async shell(udid: string, args: readonly string[]): Promise<string> {
    return await this.shellIn(await this.runtime(udid), args);
  }

  private async apiLevel(runtime: DeviceRuntime): Promise<number> {
    if (runtime.apiLevel === null) {
      const value = Number(
        (await this.shellIn(runtime, ["getprop", "ro.build.version.sdk"])).trim(),
      );
      runtime.apiLevel = Number.isInteger(value) && value > 0 ? value : 0;
    }
    return runtime.apiLevel;
  }

  /** The display size in its natural orientation, from `wm size` (an override wins). */
  private async physicalSize(runtime: DeviceRuntime): Promise<{ width: number; height: number }> {
    if (runtime.physical) return runtime.physical;
    const output = await this.shellIn(runtime, ["wm", "size"]);
    const override = /Override size:\s*(\d+)x(\d+)/u.exec(output);
    const physical = /Physical size:\s*(\d+)x(\d+)/u.exec(output);
    const match = override ?? physical;
    if (!match)
      throw new DeviceBackendError(
        `Cannot read the Android display size: ${output.trim().slice(0, 200)}`,
      );
    runtime.physical = { width: Number(match[1]), height: Number(match[2]) };
    return runtime.physical;
  }

  private scrcpyHost(): ScrcpyHost {
    return {
      adb: (args, timeoutMs) => this.run(this.tool("adb"), args, timeoutMs),
      spawnAdb: (args) => this.spawnProcess(this.tool("adb"), args),
      delay: this.delay,
    };
  }

  private async pushScrcpy(runtime: DeviceRuntime): Promise<void> {
    if (runtime.scrcpyPushed) return;
    const lib = await loadAndroid();
    this.scrcpyArtifact ??= new lib.ScrcpyServerArtifact({
      cacheDirectory: path.join(lib.androidCacheRoot(this.env), "scrcpy"),
    });
    const jar = await this.scrcpyArtifact.resolve();
    await this.run(
      this.tool("adb"),
      this.adbFor(runtime.transportId, ["push", jar, lib.SCRCPY_DEVICE_PATH]),
      60_000,
    );
    runtime.scrcpyPushed = true;
  }

  // ── Input ───────────────────────────────────────────────────────────

  /**
   * The emulator's input channel, started on first use. Null when scrcpy
   * cannot run here, which sends input through `adb shell input` instead.
   */
  private async control(runtime: DeviceRuntime): Promise<ScrcpySession | null> {
    if (!this.scrcpyEnabled) return null;
    const lib = await loadAndroid();
    if (runtime.controlIdle) clearTimeout(runtime.controlIdle);
    runtime.controlIdle = setTimeout(() => {
      const control = runtime.control;
      runtime.control = null;
      runtime.controlSession = null;
      void control?.then(
        (session) => session.close(),
        () => undefined,
      );
    }, CONTROL_IDLE_MS);
    runtime.controlIdle.unref?.();
    const existing = runtime.control;
    if (existing) {
      const session = await existing.catch(() => null);
      if (session?.isOpen) return session;
      if (runtime.control === existing) runtime.control = null;
    }
    const started = (async () => {
      await this.pushScrcpy(runtime);
      const session = await lib.ScrcpySession.start(this.scrcpyHost(), {
        transportId: runtime.transportId,
        video: null,
        onEnded: () => {
          if (runtime.control === started) runtime.control = null;
          if (runtime.controlSession === session) runtime.controlSession = null;
        },
      });
      runtime.controlSession = session;
      return session;
    })();
    runtime.control = started;
    try {
      return await started;
    } catch {
      if (runtime.control === started) runtime.control = null;
      return null;
    }
  }

  /** Run input in arrival order on one device. */
  private input<T>(
    udid: string,
    operation: (
      runtime: DeviceRuntime,
      control: ScrcpySession | null,
      lib: typeof AndroidRuntimeModule,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.disposed)
      return Promise.reject(new DeviceBackendError("Android backend is disposed."));
    // An open input channel is bound to its emulator and closes with it, so
    // live touch skips adb discovery (three adb processes) on every event.
    const live = this.runtimes.get(udid);
    const resolved = live?.controlSession?.isOpen ? Promise.resolve(live) : this.runtime(udid);
    return resolved.then((runtime) => {
      const result = runtime.inputTail.then(async () => {
        const lib = await loadAndroid();
        return operation(runtime, await this.control(runtime), lib);
      });
      runtime.inputTail = result.catch(() => undefined);
      return result;
    });
  }

  private coordinate(value: number): number {
    if (!Number.isFinite(value) || value < 0 || value > 20_000)
      throw new DeviceBackendError("Invalid Android input coordinate.");
    return Math.round(value);
  }

  private async screenFor(
    runtime: DeviceRuntime,
    udid: string,
  ): Promise<{ width: number; height: number }> {
    const geometry = this.geometries.get(udid);
    if (geometry) return { width: geometry.pointWidth, height: geometry.pointHeight };
    return await this.physicalSize(runtime);
  }

  /**
   * One phase of a live touch in display pixels: the pane streams a finger as
   * down, moves and up, so drags scroll while they move and a held press is a
   * long press.
   */
  async touch(udid: string, phase: AndroidTouchPhase, x: number, y: number): Promise<void> {
    const px = this.coordinate(x);
    const py = this.coordinate(y);
    await this.input(udid, async (runtime, control, lib) => {
      if (!control)
        throw new DeviceBackendError(
          "Live touch needs Ryco's Android input channel (scrcpy-server), which could not start here.",
        );
      control.send(
        lib.encodeTouch(lib.ScrcpyTouchAction[phase], px, py, await this.screenFor(runtime, udid)),
      );
    });
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    const px = this.coordinate(x);
    const py = this.coordinate(y);
    await this.input(udid, async (runtime, control, lib) => {
      if (!control) {
        await this.shellIn(runtime, ["input", "tap", String(px), String(py)]);
        return;
      }
      const screen = await this.screenFor(runtime, udid);
      control.send(lib.encodeTouch(lib.ScrcpyTouchAction.down, px, py, screen));
      await this.delay(30);
      control.send(lib.encodeTouch(lib.ScrcpyTouchAction.up, px, py, screen));
    });
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    if (
      !Number.isInteger(gesture.durationMs) ||
      gesture.durationMs < 0 ||
      gesture.durationMs > 10_000
    )
      throw new DeviceBackendError("Invalid Android swipe duration.");
    const [fromX, fromY, toX, toY] = [gesture.fromX, gesture.fromY, gesture.toX, gesture.toY].map(
      (value) => this.coordinate(value),
    ) as [number, number, number, number];
    await this.input(udid, async (runtime, control, lib) => {
      if (!control) {
        await this.shellIn(runtime, [
          "input",
          "swipe",
          ...[fromX, fromY, toX, toY].map(String),
          String(gesture.durationMs),
        ]);
        return;
      }
      const screen = await this.screenFor(runtime, udid);
      const steps = Math.max(2, Math.round(gesture.durationMs / SWIPE_STEP_MS));
      control.send(lib.encodeTouch(lib.ScrcpyTouchAction.down, fromX, fromY, screen));
      for (let step = 1; step <= steps; step += 1) {
        await this.delay(Math.max(1, gesture.durationMs / steps));
        const t = step / steps;
        control.send(
          lib.encodeTouch(
            lib.ScrcpyTouchAction.move,
            fromX + (toX - fromX) * t,
            fromY + (toY - fromY) * t,
            screen,
          ),
        );
      }
      // Hold still before lifting: Android's velocity tracker then reads zero
      // and the list stops where the finger did instead of flinging on, so a
      // tree read right after the swipe sees where things settled.
      await this.delay(SWIPE_HOLD_MS);
      control.send(lib.encodeTouch(lib.ScrcpyTouchAction.move, toX, toY, screen));
      await this.delay(SWIPE_HOLD_MS);
      control.send(lib.encodeTouch(lib.ScrcpyTouchAction.up, toX, toY, screen));
    });
  }

  async typeText(udid: string, text: string): Promise<void> {
    if (text.includes("\0")) throw new DeviceBackendError("Android input cannot contain NUL.");
    const ascii = /^[\x20-\x7e\n]*$/u.test(text);
    // Without the input channel there is only `input text`: printable ASCII, no %.
    if (!this.scrcpyEnabled) {
      if (!/^[\x20-\x7e]*$/.test(text) || text.includes("%"))
        throw new DeviceBackendError(
          "Android text input supports printable ASCII without percent signs; use the emulator keyboard for other text.",
        );
      await this.keyboard(udid, ["input", "text", text.replaceAll(" ", "%s")]);
      return;
    }
    await this.input(udid, async (runtime, control, lib) => {
      if (!control) {
        if (!/^[\x20-\x7e]*$/.test(text) || text.includes("%"))
          throw new DeviceBackendError(
            "Android text input supports printable ASCII without percent signs here; Ryco's input channel did not start.",
          );
        await this.shellIn(runtime, ["input", "text", text.replaceAll(" ", "%s")]);
        return;
      }
      if (ascii) {
        for (const chunk of lib.chunkUtf8(text, lib.SCRCPY_INJECT_TEXT_MAX_BYTES))
          control.send(lib.encodeText(chunk));
        return;
      }
      // Characters outside the virtual keyboard's map go in through the clipboard.
      await control.setClipboard(text, true);
    });
  }

  /** Paste text where the focus is, through the device clipboard. */
  async paste(udid: string, text: string): Promise<void> {
    await this.input(udid, async (runtime, control) => {
      if (!control) {
        if (!/^[\x20-\x7e]*$/.test(text) || text.includes("%"))
          throw new DeviceBackendError(
            "Pasting on Android needs Ryco's input channel, which did not start.",
          );
        await this.shellIn(runtime, ["input", "text", text.replaceAll(" ", "%s")]);
        return;
      }
      await control.setClipboard(text, true);
    });
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    const code = androidKeycode(event.keyCode);
    if (code === undefined)
      throw new DeviceBackendError("This HID key is not supported by Android input.");
    if (!this.scrcpyEnabled) {
      if (event.modifiers.length)
        throw new DeviceBackendError("Android key modifiers are not supported; use text input.");
      if (event.direction === "down")
        await this.keyboard(udid, ["input", "keyevent", String(code)]);
      return;
    }
    const meta = event.modifiers.reduce((state, modifier) => state | META[modifier], 0);
    await this.input(udid, async (runtime, control, lib) => {
      if (!control) {
        if (event.direction === "down")
          await this.shellIn(runtime, ["input", "keyevent", String(code)]);
        return;
      }
      control.send(
        lib.encodeKeycode(
          event.direction === "down" ? lib.ScrcpyKeyAction.down : lib.ScrcpyKeyAction.up,
          code,
          meta,
        ),
      );
    });
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    if (button === "rotate") {
      await this.input(udid, async (runtime, control, lib) => {
        if (control) {
          control.send(lib.encodeEmpty(lib.ScrcpyControlType.rotateDevice));
          return;
        }
        // Without the channel: step the locked rotation by a quarter turn.
        const current =
          Number(
            (await this.shellIn(runtime, ["settings", "get", "system", "user_rotation"])).trim(),
          ) || 0;
        await this.shellIn(runtime, ["settings", "put", "system", "accelerometer_rotation", "0"]);
        await this.shellIn(runtime, [
          "settings",
          "put",
          "system",
          "user_rotation",
          String((current + 1) % 4),
        ]);
      });
      return;
    }
    const code = BUTTON_KEYCODE[button];
    if (code === undefined)
      throw new DeviceBackendError("This hardware button is not supported by the Android adapter.");
    if (!this.scrcpyEnabled) {
      await this.keyboard(udid, ["input", "keyevent", String(code)]);
      return;
    }
    await this.input(udid, async (runtime, control, lib) => {
      if (!control) {
        await this.shellIn(runtime, ["input", "keyevent", String(code)]);
        return;
      }
      control.send(lib.encodeKeycode(lib.ScrcpyKeyAction.down, code));
      control.send(lib.encodeKeycode(lib.ScrcpyKeyAction.up, code));
    });
  }

  /** Lock the screen to one orientation. */
  async setOrientation(udid: string, orientation: AndroidOrientation): Promise<void> {
    await this.input(udid, async (runtime, _control, lib) => {
      await this.shellIn(runtime, ["settings", "put", "system", "accelerometer_rotation", "0"]);
      await this.shellIn(runtime, [
        "settings",
        "put",
        "system",
        "user_rotation",
        lib.ANDROID_ROTATION[orientation],
      ]);
    });
  }

  // ── Apps ────────────────────────────────────────────────────────────

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
    const pid = Number(
      (await this.shell(udid, ["pidof", bundleId]).catch(() => "")).trim().split(/\s+/u)[0],
    );
    return { udid, bundleId, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
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
    const sdk = this.sdk.root;
    if (sdk) {
      const versions = await readdir(path.join(sdk, "build-tools")).catch(() => []);
      const candidate = versions
        .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((v) => path.join(sdk, "build-tools", v, aapt))
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

  // ── Screen ──────────────────────────────────────────────────────────

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
  /** Video, screenshots, the tree and input all turn with an Android display. */
  uprightFrames(_udid: string): boolean {
    return true;
  }

  /** How the pane previews this device; null until the stream has started once. */
  previewMode(udid: string): "video" | "screenshots" | null {
    return this.previews.get(udid) ?? null;
  }

  /**
   * Stream H.264 from scrcpy into the shared frame transport. Without scrcpy
   * the attachment still succeeds after one screenshot, and the pane polls
   * screenshots the way hosted iOS does.
   */
  async attachStream(udid: string, listener: DeviceFrameListener): Promise<void> {
    const runtime = await this.runtime(udid);
    if (runtime.video) {
      await runtime.video.session.close();
      runtime.video = null;
    }
    if (this.scrcpyEnabled) {
      try {
        await this.startVideo(udid, runtime, listener);
        this.previews.set(udid, "video");
        return;
      } catch {
        // Fall through to screenshots: the pane keeps working without video.
      }
    }
    this.previews.set(udid, "screenshots");
    await this.screenshot(udid);
  }

  private async startVideo(
    udid: string,
    runtime: DeviceRuntime,
    listener: DeviceFrameListener,
  ): Promise<void> {
    const lib = await loadAndroid();
    await this.pushScrcpy(runtime);
    const physical = await this.physicalSize(runtime);
    // Known before the first session packet, so the attachment publishes it;
    // a rotated display corrects it as soon as the video says so.
    if (!this.geometries.has(udid))
      this.geometries.set(udid, {
        pointWidth: physical.width,
        pointHeight: physical.height,
        scale: 1,
      });
    let state: VideoState | null = null;
    const pendingEvents: ScrcpyVideoEvent[] = [];
    const handle = (event: ScrcpyVideoEvent) => {
      if (!state) {
        pendingEvents.push(event);
        return;
      }
      const current = state;
      if (event.kind === "codec") {
        if (event.codecId !== lib.SCRCPY_CODEC_H264) void current.session.close();
        return;
      }
      if (event.kind === "session") {
        current.size = { width: event.width, height: event.height };
        // The display turned with the video: its pixels are the physical size, rotated.
        const landscape = event.width > event.height;
        const [long, short] = [
          Math.max(physical.width, physical.height),
          Math.min(physical.width, physical.height),
        ];
        this.geometries.set(udid, {
          pointWidth: landscape ? long : short,
          pointHeight: landscape ? short : long,
          scale: 1,
        });
        return;
      }
      current.sequence += 1;
      listener({
        sequence: current.sequence,
        timestampMs: Number(event.ptsUs / 1_000n),
        keyframe: event.keyframe && !event.config,
        codecConfig: event.config,
        data: event.data,
      });
    };
    const session = await lib.ScrcpySession.start(this.scrcpyHost(), {
      transportId: runtime.transportId,
      video: this.options.video ?? lib.SCRCPY_DEFAULT_VIDEO,
      onVideo: handle,
      onEnded: () => {
        if (runtime.video?.session === session) runtime.video = null;
      },
    });
    state = { session, sequence: 0, size: null };
    runtime.video = state;
    for (const event of pendingEvents.splice(0)) handle(event);
  }

  /** A fresh codec config and keyframe on the running stream, without restarting it. */
  async requestKeyframe(udid: string): Promise<boolean> {
    const video = this.runtimes.get(udid)?.video;
    if (!video?.session.isOpen) return false;
    try {
      video.session.resetVideo();
      return true;
    } catch {
      return false;
    }
  }

  async detachStream(udid: string): Promise<void> {
    this.cancelKeyboard(udid);
    const runtime = this.runtimes.get(udid);
    const video = runtime?.video;
    if (runtime) runtime.video = null;
    await video?.session.close();
    this.geometries.delete(udid);
    // Keep the preview mode: a viewer opens the frame socket, and so restarts
    // the stream, only while the descriptor says "video". Forgetting it here
    // left a reloaded pane on screenshots for good. Shutdown and dispose clear it.
  }

  // ── Testing ─────────────────────────────────────────────────────────

  suspendTesting(_udid?: string): () => void {
    // Each testing call is one short adb sequence on the current transport;
    // a transport change fails it rather than retargeting it.
    return () => {};
  }
  async testing(input: DeviceTestingInput): Promise<void> {
    const lib = await loadAndroid();
    const runtime = await this.runtime(input.udid);
    const steps = lib.planAndroidTestingAction(input, await this.apiLevel(runtime));
    for (const step of steps) {
      if (step.kind === "shell") {
        const output = await this.shellIn(runtime, step.args);
        if (/^(Error|Exception|Security exception)/imu.test(output.trim()))
          throw new DeviceBackendError(`Android setting failed: ${output.trim().slice(0, 500)}`);
      } else if (step.kind === "emu") {
        const output = (
          await this.run(this.tool("adb"), this.adbFor(runtime.transportId, ["emu", ...step.args]))
        ).toString();
        if (/^KO/mu.test(output))
          throw new DeviceBackendError(
            `The emulator refused the setting: ${output.trim().slice(0, 300)}`,
          );
      } else {
        if (!PACKAGE.test(step.bundleId))
          throw new DeviceBackendError("Invalid Android package name.");
        const failures: string[] = [];
        let applied = 0;
        for (const permission of step.permissions) {
          try {
            for (const args of lib.permissionCommand(step.bundleId, step.decision, permission)) {
              const output = await this.shellIn(runtime, args);
              if (/Exception|Error|not a changeable|has not requested/iu.test(output))
                throw new DeviceBackendError(output.trim().slice(0, 300));
            }
            applied += 1;
          } catch (error) {
            failures.push(
              `${permission.replace("android.permission.", "")}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (applied === 0)
          throw new DeviceBackendError(
            `No permission changed for ${step.bundleId}; the app must declare it in its manifest. ${failures.join("; ").slice(0, 600)}`,
          );
      }
    }
  }

  // ── Logs ────────────────────────────────────────────────────────────

  async readLogs(udid: string, query: DeviceLogQuery): Promise<DeviceLogResult> {
    const lib = await loadAndroid();
    if (!PACKAGE.test(query.bundleId))
      throw new DeviceBackendError("Invalid Android package name.");
    const runtime = await this.runtime(udid);
    const sinceEpochMs = Date.now() - query.sinceSeconds * 1_000;
    const live = (await this.shellIn(runtime, ["pidof", query.bundleId]).catch(() => ""))
      .trim()
      .split(/\s+/u)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    let truncated = false;
    const output = await this.run(
      this.tool("adb"),
      this.adbFor(runtime.transportId, [
        "logcat",
        "-d",
        "-v",
        "epoch",
        "-b",
        "main,system,crash",
        "-T",
        (sinceEpochMs / 1_000).toFixed(3),
      ]),
      30_000,
    ).catch(async (error: unknown) => {
      // Past the output cap: read the newest lines only.
      truncated = true;
      return await this.run(
        this.tool("adb"),
        this.adbFor(runtime.transportId, [
          "logcat",
          "-d",
          "-v",
          "epoch",
          "-b",
          "main,system,crash",
          "-t",
          "20000",
        ]),
        30_000,
      ).catch(() => {
        throw error;
      });
    });
    return lib.androidLogResult({
      query,
      output: output.toString(),
      livePids: live,
      sinceEpochMs,
      truncated,
    });
  }

  // ── Recording ───────────────────────────────────────────────────────

  async startRecording(udid: string): Promise<DeviceStartRecordingResult> {
    const runtime = await this.runtime(udid);
    if (runtime.recording) throw new DeviceBackendError("This emulator is already recording.");
    const startedAt = new Date();
    const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
    const directory =
      this.options.recordingDirectory ??
      (await selectRecordingDirectory(
        [path.join(homedir(), "Desktop"), path.join(homedir(), "Downloads")],
        tmpdir(),
      ));
    const hostPath = path.join(directory, `emulator-${this.name(udid)}-${stamp}.mp4`);
    const devicePath = `/sdcard/ryco-recording-${stamp}.mp4`;
    const child = this.spawnProcess(
      this.tool("adb"),
      this.adbFor(runtime.transportId, [
        "shell",
        [
          "screenrecord",
          "--bit-rate",
          "8000000",
          "--time-limit",
          String(RECORDING_TIME_LIMIT_S),
          devicePath,
        ]
          .map(quoteAndroidShell)
          .join(" "),
      ]),
    );
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    runtime.recording = { child, devicePath, hostPath, startedAt: startedAt.getTime(), exited };
    return { udid, path: hostPath, startedAt: startedAt.toISOString() };
  }

  async stopRecording(udid: string): Promise<DeviceStopRecordingResult> {
    const runtime = this.runtimes.get(udid);
    const recording = runtime?.recording;
    if (!runtime || !recording) throw new DeviceBackendError("This emulator is not recording.");
    runtime.recording = null;
    // SIGINT lets screenrecord finish the MP4; killing the adb client would cut it.
    await this.shellIn(runtime, ["pkill", "-INT", "-f", recording.devicePath]).catch(
      () => undefined,
    );
    const timeout = this.delay(10_000).then(() => "timeout" as const);
    if ((await Promise.race([recording.exited.then(() => "done" as const), timeout])) === "timeout")
      recording.child.kill("SIGKILL");
    await this.delay(300);
    const durationMs = Date.now() - recording.startedAt;
    await this.run(
      this.tool("adb"),
      this.adbFor(runtime.transportId, ["pull", recording.devicePath, recording.hostPath]),
      120_000,
    );
    await this.shellIn(runtime, ["rm", "-f", recording.devicePath]).catch(() => undefined);
    const sizeBytes = (await stat(recording.hostPath).catch(() => null))?.size ?? 0;
    return {
      udid,
      path: recording.hostPath,
      sizeBytes,
      durationMs: Math.min(durationMs, RECORDING_TIME_LIMIT_S * 1_000),
      stoppedAt: new Date().toISOString(),
    };
  }

  // ── Accessibility tree ──────────────────────────────────────────────

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    const lib = await loadAndroid();
    const runtime = await this.runtime(udid);
    const xml = await this.dumpUi(runtime);
    const geometry = this.geometries.get(udid);
    const display = geometry ? { width: geometry.pointWidth, height: geometry.pointHeight } : null;
    return { udid, capturedAt: new Date().toISOString(), root: lib.androidUiRoot(xml, display) };
  }

  private async dumpUi(runtime: DeviceRuntime): Promise<string> {
    const helper = await this.uiReader(runtime);
    if (helper) {
      try {
        return await helper.dump();
      } catch {
        // A dead reader is replaced on the next read; this one falls back.
        runtime.ui = null;
      }
    }
    const output = (
      await this.run(
        this.tool("adb"),
        this.adbFor(runtime.transportId, [
          "exec-out",
          "uiautomator",
          "dump",
          "--compressed",
          "/dev/tty",
        ]),
        30_000,
      )
    ).toString();
    const end = output.lastIndexOf("</hierarchy>");
    if (end < 0)
      throw new DeviceBackendError(
        `Android accessibility tree is unavailable: ${output.trim().slice(0, 300)}`,
        { retryable: true },
      );
    return output.slice(0, end + "</hierarchy>".length);
  }

  /** The resident reader, started on first use; null when it cannot be built or run here. */
  private async uiReader(runtime: DeviceRuntime): Promise<AndroidUiHelperSession | null> {
    if (!this.uiHelperEnabled) return null;
    const lib = await loadAndroid();
    this.uiHelperBuild ??= new lib.AndroidUiHelperBuild({
      sdk: this.sdk.root,
      platform: this.hostPlatform,
      env: this.env,
    });
    const build = this.uiHelperBuild;
    const existing = runtime.ui;
    if (existing) {
      const session = await existing.catch(() => null);
      if (session?.isOpen) return session;
      if (runtime.ui === existing) runtime.ui = null;
    }
    if (build.lastFailure !== null) return null;
    const started = (async () => {
      const jar = await build.resolve();
      if (!runtime.uiHelperPushed) {
        await this.run(
          this.tool("adb"),
          this.adbFor(runtime.transportId, ["push", jar, lib.ANDROID_UI_HELPER_DEVICE_PATH]),
          30_000,
        );
        runtime.uiHelperPushed = true;
      }
      return await lib.AndroidUiHelperSession.start(
        (args) => this.spawnProcess(this.tool("adb"), args),
        runtime.transportId,
        () => {
          if (runtime.ui === started) runtime.ui = null;
        },
      );
    })();
    runtime.ui = started;
    try {
      return await started;
    } catch {
      if (runtime.ui === started) runtime.ui = null;
      return null;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async shutdown(udid: string): Promise<void> {
    this.cancelKeyboard(udid);
    await this.closeRuntime(udid);
    const current = (await this.running()).get(this.name(udid));
    if (current) await this.run(this.tool("adb"), ["-t", current.transportId, "emu", "kill"]);
    this.geometries.delete(udid);
    this.previews.delete(udid);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const udid of this.keyboardQueues.keys()) this.cancelKeyboard(udid);
    for (const child of this.starting) child.stop();
    await Promise.allSettled([...this.runtimes.keys()].map((udid) => this.closeRuntime(udid)));
    await Promise.allSettled(this.boots.values());
    this.geometries.clear();
    this.previews.clear();
  }
}
