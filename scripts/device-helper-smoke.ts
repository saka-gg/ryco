// End-to-end qualification for the source-shipped macOS device helper.
// Adapted from Synara v0.7.2; intentionally excluded from ordinary CI.
//
// Flags:
//   --probe-only      build and preflight the helper; never boots a simulator
//   --cache-dir <dir> build into <dir>/<cache key> instead of the user cache
//   --udid <udid>     drive exactly this iOS simulator; an already-booted one is
//                     refused unless --allow-booted is also given
//   --allow-booted    with --udid, reuse that simulator if it is already booted
//                     (it is then left running)
//   --screenshot-out <path>
//                     copy the run's screenshot there (Settings with a random
//                     token typed into its search field, unless the input check
//                     is off)
//   --skip-input-check
//                     skip the check that buttons, touches and keys reach the
//                     guest (for unusual home screens or Settings layouts)
//
// Without --udid the smoke prefers an already-booted simulator, which suits a
// developer's machine but not an agent sharing one: agents pass --udid.

import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { decodeDeviceFrame } from "@ryco/shared/deviceFrame";
import {
  DEVICE_HELPER_CACHE_SEGMENTS,
  deviceHelperCacheKey,
  readDeviceHelperSourceRevision,
} from "@ryco/shared/deviceHelperCache";

import {
  parseHelperInputTransport,
  parseHelperProbe,
  type HelperInputTransport,
} from "../apps/server/src/device/helperCapabilities.ts";
import { inputRetryFor } from "../apps/server/src/device/helperInputErrors.ts";
import { sandboxedHelperCommand } from "../apps/server/src/device/helperSandbox.ts";
import {
  parseSmokeOptions,
  selectSmokeSimulator,
  type SimctlDevice,
} from "./lib/device-helper-smoke-options.ts";
import {
  findSearchField,
  isTransientUiTreeError,
  layoutStableToken,
  mentions,
  normalizedTapPoint,
  readUiTree,
  rootLabel,
  showsAnotherApp,
  visibleLabels,
} from "./lib/device-helper-smoke-ui.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperDir = join(repoRoot, "apps/server/native/device-helper");
const requiredFrames = 30;
const settingsBundleId = "com.apple.Preferences";

let stepNumber = 0;
const step = (message: string): void => console.log(`[device-smoke] ${++stepNumber}. ${message}`);
const info = (message: string): void => console.log(`[device-smoke]    ${message}`);

/**
 * A failure that has already been reported. `fail()` throws instead of exiting
 * so the run unwinds through `finally` and shuts down a simulator it booted;
 * `process.exit` used to skip that and leave the device running.
 */
class SmokeFailure extends Error {}

function fail(message: string, detail?: unknown): never {
  console.error(`[device-smoke] FAIL: ${message}`);
  if (detail !== undefined) {
    console.error(detail instanceof Error ? (detail.stack ?? detail.message) : String(detail));
  }
  throw new SmokeFailure(message);
}
// Never call fail() or assert() from an event handler (socket, child process):
// a throw there is an uncaught exception that kills the process before the
// cleanup runs. Record the problem and assert it from the main flow instead.
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

function resolveDeveloperDirectory(): string {
  const override = process.env.DEVELOPER_DIR?.trim();
  if (override) return override;
  try {
    return execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
  } catch (error) {
    fail("xcode-select is unavailable; install Xcode or set DEVELOPER_DIR", error);
  }
}

function listDevices(env: NodeJS.ProcessEnv): SimctlDevice[] {
  const raw = execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
    env,
  });
  const parsed = JSON.parse(raw) as {
    devices: Record<string, Array<Omit<SimctlDevice, "runtime">>>;
  };
  return Object.entries(parsed.devices).flatMap(([runtime, devices]) =>
    runtime.includes("iOS") ? devices.map((device) => ({ ...device, runtime })) : [],
  );
}

/**
 * Runs a command with inherited stdio without blocking signal delivery.
 * `onSpawn` hands the child to the caller, whose cleanup must kill it: a
 * signal that ends this process does not end the child.
 */
function runInherited(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  onSpawn: (child: ChildProcess) => void,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { env, stdio: "inherit" });
    onSpawn(child);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(`${command} ${args.join(" ")} exited (code ${code}, signal ${signal})`),
        );
    });
  });
}

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

class HelperClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  readonly stderr: string[] = [];
  /** The attachment's input transport, from `attach`; picks the retry rule. */
  inputTransport: HelperInputTransport | null = null;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr.push(...chunk.split("\n").filter((line) => line.trim().length > 0));
    });
    child.on("exit", (code, signal) => {
      this.rejectPending(new Error(`helper exited early (code ${code}, signal ${signal})`));
    });
    // A spawn failure, or a write to a helper that already exited, arrives as
    // an 'error' event; unhandled, it would end the run before its cleanup.
    child.on("error", (error) => this.rejectPending(error));
    child.stdin.on("error", (error) => this.rejectPending(error));
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = message.id;
      if (typeof id !== "number") continue;
      const request = this.pending.get(id);
      if (!request) continue;
      this.pending.delete(id);
      const rpcError = message.error as { message?: string } | undefined;
      if (rpcError) request.reject(new Error(rpcError.message ?? "unknown helper error"));
      else request.resolve((message.result ?? {}) as Record<string, unknown>);
    }
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 45_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`helper method '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /**
   * One input RPC, sent once more exactly when the server would retry it on
   * the same attachment (dtuhidd still starting after a cold boot, above
   * all). A freshly created device's first boot can outlast the helper's 9 s
   * readiness wait, and without this its first swipe failed the run.
   * Anything the server would surface, or re-attach for, fails the run.
   */
  async input(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.call(method, params);
    } catch (error) {
      if (inputRetryFor(error, this.inputTransport) !== "same-attachment") throw error;
      info(`retrying ${method} once, as the server would: ${(error as Error).message}`);
      return await this.call(method, params);
    }
  }
}

class FrameCollector {
  readonly frames: Array<{
    readonly keyframe: boolean;
    readonly codecConfig: boolean;
    readonly sequence: number;
    readonly payload: Uint8Array;
  }> = [];
  /** The first frame that failed to decode; consumption stops there. */
  decodeError: string | undefined;
  /** The first socket or server error, reported with a short frame count. */
  socketError: string | undefined;
  private buffer = Buffer.alloc(0);
  private server: Server | undefined;
  private socket: Socket | undefined;

  async listen(socketPath: string): Promise<void> {
    await new Promise<void>((resolveListen, rejectListen) => {
      const server = createServer((socket) => {
        this.socket = socket;
        socket.on("data", (chunk) => this.consume(chunk));
        // A helper that dies mid-stream can reset the socket; the frame count
        // assertion reports the outcome, an unhandled 'error' would crash it.
        socket.on("error", (error) => {
          this.socketError ??= error.message;
        });
      });
      server.once("error", rejectListen);
      server.listen(socketPath, () => {
        this.server = server;
        server.on("error", (error) => {
          this.socketError ??= error.message;
        });
        resolveListen();
      });
    });
  }

  // Runs inside the socket's data callback, so it records a decode failure
  // rather than throwing; the frame loop asserts on it.
  private consume(chunk: Buffer): void {
    if (this.decodeError !== undefined) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const encoded = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      const decoded = decodeDeviceFrame(new Uint8Array(encoded));
      if (!decoded.ok) {
        this.decodeError = decoded.reason;
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.frames.push({
        keyframe: decoded.frame.header.keyframe,
        codecConfig: decoded.frame.header.codecConfig,
        sequence: decoded.frame.header.sequence,
        payload: decoded.frame.payload,
      });
    }
  }

  close(): void {
    this.socket?.destroy();
    this.server?.close();
  }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function naluTypes(payload: Uint8Array): number[] {
  const types: number[] = [];
  for (let index = 0; index + 4 < payload.length; index += 1) {
    if (
      payload[index] === 0 &&
      payload[index + 1] === 0 &&
      payload[index + 2] === 0 &&
      payload[index + 3] === 1
    ) {
      types.push(payload[index + 4]! & 0x1f);
    }
  }
  return types;
}

/** Probe fields that only feed the log, not the verdict; null when not JSON. */
function readProbeDiagnostics(raw: string): {
  readonly deviceCount: number | undefined;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { deviceCount?: unknown };
  return {
    deviceCount: typeof record.deviceCount === "number" ? record.deviceCount : undefined,
  };
}

function describeCapability(
  capability: ReturnType<typeof parseHelperProbe>["capabilities"][number],
): string {
  if (capability.ok) return "ok";
  const detail = capability.detail ?? "unavailable";
  return capability.missingSymbol === undefined
    ? detail
    : `missing ${capability.missingSymbol} (${detail})`;
}

type UiTree = ReturnType<typeof readUiTree>;

/**
 * One `describe-ui`, read again (up to 5 times, 1.5 s apart) while the
 * accessibility translator finds no frontmost application. That happens while
 * SpringBoard starts after a device's first boot and while an app launches on
 * a loaded machine, and it clears up by itself.
 */
async function describeUi(client: HelperClient, maxDepth: number): Promise<UiTree> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return readUiTree((await client.call("describe-ui", { maxDepth })).tree);
    } catch (error) {
      if (attempt >= 5 || !isTransientUiTreeError(error)) throw error;
      info(`describe-ui: ${(error as Error).message}; reading again`);
      await sleep(1_500);
    }
  }
}

/**
 * Proves that a hardware button, a touch and keystrokes reach the guest, by
 * the accessibility tree changing in response. On CoreSimulator 1155.4+ an
 * input path that only looks healthy (Indigo there) acks every call and
 * changes nothing, which the earlier steps cannot tell apart from success.
 */
async function checkInputReachesGuest(
  client: HelperClient,
  target: {
    readonly udid: string;
    readonly env: NodeJS.ProcessEnv;
    readonly pointWidth: number;
    readonly pointHeight: number;
  },
): Promise<void> {
  const describe = (): Promise<UiTree> => describeUi(client, 12);
  // Reads until `accept` holds, at most 8 times a second apart (an app launch
  // or the home transition can take seconds on a loaded machine); the last
  // read either way.
  const describeUntil = async (accept: (tree: UiTree) => boolean): Promise<UiTree> => {
    let tree = await describe();
    for (let read = 1; read < 8 && !accept(tree); read += 1) {
      await sleep(1_000);
      tree = await describe();
    }
    return tree;
  };
  const launchSettings = (): void => {
    execFileSync("xcrun", ["simctl", "launch", target.udid, settingsBundleId], {
      env: target.env,
      stdio: ["ignore", "ignore", "inherit"],
    });
  };
  // Settings resumed from the background on iOS 26.5 exposes its bottom
  // toolbar as one element without the search field inside it; a fresh launch
  // exposes the field.
  const quitSettings = (): void => {
    try {
      execFileSync("xcrun", ["simctl", "terminate", target.udid, settingsBundleId], {
        env: target.env,
        stdio: "ignore",
      });
    } catch {
      // Not running: nothing to quit.
    }
  };

  // 1. A known app in front. SpringBoard's root has no name, so the read
  // waits for one.
  await client.input("button", { name: "home" });
  await sleep(1_500);
  launchSettings();
  await sleep(2_500);
  const settingsTree = await describeUntil((tree) => rootLabel(tree) !== undefined);
  const settingsRoot = rootLabel(settingsTree);
  // Without a label to compare, the home-button check below proves nothing.
  assert(
    settingsRoot !== undefined,
    `the frontmost app after launching Settings has no label; visible labels: ${
      visibleLabels(settingsTree).join(", ") || "(none)"
    }`,
  );
  info(`frontmost after launching Settings: ${settingsRoot}`);

  // 2. The home button takes it away: another app, or SpringBoard (whose
  // root label is blank), with elements of its own is in front.
  await client.input("button", { name: "home" });
  await sleep(1_500);
  const homeTree = await describeUntil((tree) => showsAnotherApp(tree, settingsRoot));
  assert(
    showsAnotherApp(homeTree, settingsRoot),
    `the home button did not reach the guest: frontmost was '${settingsRoot}', after home '${
      rootLabel(homeTree) ?? "(no label)"
    }'; visible labels: ${visibleLabels(homeTree).join(", ") || "(none)"}`,
  );
  info(`home button reached the guest (frontmost now ${rootLabel(homeTree) ?? "the home screen"})`);

  // 3. A tap focuses Settings' search field and keystrokes fill it. The pull
  // down below must land in Settings, not on the home screen (where it opens
  // Spotlight), so the read waits for Settings to be in front again.
  quitSettings();
  launchSettings();
  await sleep(2_500);
  let tree = await describeUntil((candidate) => rootLabel(candidate) === settingsRoot);
  assert(
    rootLabel(tree) === settingsRoot,
    `Settings did not come back to the front: frontmost is '${rootLabel(tree) ?? "(no label)"}'`,
  );
  let field = findSearchField(tree);
  if (field === undefined) {
    // The search field hides until the list is pulled down a little.
    await client.input("swipe", {
      startX: 0.5,
      startY: 0.3,
      endX: 0.5,
      endY: 0.6,
      durationMs: 350,
    });
    await sleep(1_000);
    tree = await describe();
    field = findSearchField(tree);
  }
  assert(
    field !== undefined,
    `no search field in Settings; visible labels: ${visibleLabels(tree).join(", ") || "(none)"}`,
  );
  const point = normalizedTapPoint(field, target.pointWidth, target.pointHeight);
  assert(point !== undefined, "the search field's tap point is not on the screen");
  await client.input("tap", point);
  await sleep(800);
  const token = layoutStableToken();
  await client.input("text", { text: token });
  await sleep(800);
  tree = await describe();
  assert(
    mentions(tree, token),
    `typed "${token}" but no element shows it; visible labels: ${visibleLabels(tree).join(", ") || "(none)"}`,
  );
  info(`tap and keystrokes reached the guest ("${token}" is in the search field)`);
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") fail("the device helper is macOS only");
  const parsedOptions = parseSmokeOptions(process.argv.slice(2));
  if (!parsedOptions.ok) fail(parsedOptions.error);
  const options = parsedOptions.value;

  step("Checking Xcode");
  const developerDir = resolveDeveloperDirectory();
  if (!developerDir.endsWith("/Contents/Developer")) {
    fail(
      `the active developer directory '${developerDir}' is not a full Xcode; select Xcode.app or set DEVELOPER_DIR`,
    );
  }
  const toolchainEnv = { ...process.env, DEVELOPER_DIR: developerDir };
  const xcodeVersion = execFileSync("xcodebuild", ["-version"], {
    encoding: "utf8",
    env: toolchainEnv,
  }).trim();
  const sourceRevision = await readDeviceHelperSourceRevision(helperDir, {
    listSources: (directory) => readdir(directory),
    readFile: (file) => readFile(file, "utf8"),
    join,
  });
  const cacheKey = deviceHelperCacheKey(xcodeVersion, sourceRevision);
  assert(cacheKey !== null, "cannot derive an Xcode helper cache key");
  info(`${xcodeVersion.replace("\n", " / ")} (${developerDir})`);

  step("Compiling the helper");
  const cacheDir =
    options.cacheRoot === undefined
      ? join(homedir(), ...DEVICE_HELPER_CACHE_SEGMENTS, cacheKey)
      : join(options.cacheRoot, cacheKey);
  mkdirSync(cacheDir, { recursive: true });
  let helperPath: string;
  try {
    const { stdout } = await execFileAsync(join(helperDir, "build.sh"), [cacheDir], {
      env: toolchainEnv,
      maxBuffer: 8 * 1024 * 1024,
    });
    helperPath = stdout.trim().split("\n").at(-1)!;
  } catch (error) {
    fail("helper failed to compile", error);
  }
  assert(statSync(helperPath).isFile(), `compiled helper missing at ${helperPath}`);
  info(helperPath);

  step("Preflighting the helper");
  let probeRaw: string;
  try {
    probeRaw = execFileSync(helperPath, ["--probe"], {
      encoding: "utf8",
      env: toolchainEnv,
    }).trim();
  } catch (error) {
    probeRaw = (error as { stdout?: string }).stdout?.trim() ?? "";
    if (probeRaw.length === 0) fail("helper preflight produced no output", error);
  }
  if (process.env.DEVICE_HELPER_PROBE_JSON) {
    writeFileSync(process.env.DEVICE_HELPER_PROBE_JSON, `${probeRaw}\n`);
  }
  const diagnostics = readProbeDiagnostics(probeRaw);
  if (diagnostics === null) fail("helper preflight returned unreadable output", probeRaw);
  // The server's parser, so the smoke and the pane read the probe the same
  // way. The verdict is deliberately stricter: the pane shows a helper with
  // one broken capability as degraded but usable, a qualification run fails.
  const probe = parseHelperProbe(probeRaw);
  for (const capability of probe.capabilities) {
    info(`capability ${capability.id}: ${describeCapability(capability)}`);
  }
  const broken = probe.capabilities.filter((capability) => !capability.ok);
  assert(
    broken.length === 0,
    `helper capabilities unavailable: ${broken.map((capability) => capability.id).join(", ")}`,
  );
  assert(probe.ok, `helper preflight failed: ${probe.error ?? "unknown error"}`);
  info(
    `CoreSimulator ${probe.coreSimulatorVersion ?? "(version not reported)"} reachable, ${
      diagnostics.deviceCount ?? "?"
    } devices; input transport ${probe.inputTransport ?? "(not reported)"}`,
  );
  if (options.probeOnly) {
    console.log("\n[device-smoke] PASS (probe only; no simulator was booted)");
    return;
  }

  step("Selecting a simulator");
  const selection = selectSmokeSimulator(listDevices(toolchainEnv), options);
  if (!selection.ok) fail(selection.error);
  const { device, wasBooted } = selection.value;
  info(
    `${device.name} (${device.udid}, ${device.runtime}) ${
      wasBooted ? "already booted; reused and left running" : "shutdown; this run boots it"
    }`,
  );

  let bootedBySmoke = false;
  // Set just before `simctl boot`. If the boot then fails, the device may
  // still be coming up on this run's behalf (simctl killed mid-boot by the
  // Ctrl-C that reaches the whole process group), so cleanup checks it.
  let bootRequested = false;
  let bootstatus: ChildProcess | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: HelperClient | undefined;
  const collector = new FrameCollector();
  const cleanupPaths: string[] = [];

  // Whether the selected device is this run's to shut down.
  const ownsDevice = (): boolean => {
    if (bootedBySmoke) return true;
    if (!bootRequested) return false;
    // The boot failed or was cut short. The device was shut down when it was
    // selected, so anything but Shutdown now is this run's boot.
    let state: string | undefined;
    try {
      state = listDevices(toolchainEnv).find((candidate) => candidate.udid === device.udid)?.state;
    } catch {
      state = undefined;
    }
    if (state === "Shutdown") return false;
    info(`${device.udid} is ${state ?? "in an unknown state"} after an interrupted boot`);
    return true;
  };

  // Synchronous and idempotent, so the `finally` and a signal handler can both
  // call it. Only ever shuts down the simulator this run booted.
  let cleanedUp = false;
  const cleanUp = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    collector.close();
    child?.stdin.end();
    child?.kill();
    // A signal ends this process, not its children; a stray bootstatus would
    // keep waiting on (or reporting) the device after it is shut down.
    if (bootstatus && bootstatus.exitCode === null && bootstatus.signalCode === null) {
      bootstatus.kill();
    }
    for (const cleanupPath of cleanupPaths) rmSync(cleanupPath, { recursive: true, force: true });
    if (!ownsDevice()) return;
    info(`shutting down ${device.udid}, which this smoke run booted`);
    try {
      execFileSync("xcrun", ["simctl", "shutdown", device.udid], {
        env: toolchainEnv,
        stdio: "inherit",
      });
    } catch (error) {
      console.error(
        `[device-smoke] warning: could not shut down ${device.udid}, which this run booted; run 'xcrun simctl shutdown ${device.udid}'`,
        error,
      );
    }
  };
  // A tool timeout or Ctrl-C would otherwise end the process with the
  // simulator still running. Registered before the synchronous boot: a signal
  // that only this process gets (a timeout's SIGTERM) waits until the boot
  // returns, by which time `bootedBySmoke` is accurate. A terminal Ctrl-C also
  // reaches simctl, which can die mid-boot; `bootRequested` covers that case,
  // in the `finally` that the failed boot unwinds through.
  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`[device-smoke] ${signal} received; cleaning up`);
    cleanUp();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (!wasBooted) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  try {
    if (!wasBooted) {
      step("Booting the simulator");
      bootRequested = true;
      try {
        execFileSync("xcrun", ["simctl", "boot", device.udid], {
          env: toolchainEnv,
          encoding: "utf8",
          // stderr is captured (and shown in the failure) to tell a device
          // someone else booted meanwhile, which is not ours to shut down.
          stdio: ["ignore", "inherit", "pipe"],
        });
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        if (/current state: Booted/iu.test(stderr)) bootRequested = false;
        throw error;
      }
      bootedBySmoke = true;
      info(`booted ${device.udid}; it is shut down when this run ends`);
      // Asynchronous so a signal during a slow first boot is handled now, not
      // after the device finishes booting. No `-b`: the device is already
      // booted, and a bootstatus that outlived the shutdown must not boot it
      // again.
      await runInherited(
        "xcrun",
        ["simctl", "bootstatus", device.udid],
        toolchainEnv,
        (spawned) => {
          bootstatus = spawned;
        },
      );
      await sleep(3_000);
    }

    step("Starting and attaching the helper");
    const launch = await sandboxedHelperCommand([helperPath], {
      binaryPath: helperPath,
      helperSourceDir: helperDir,
      developerDir,
      env: toolchainEnv,
    });
    info(launch.profilePath ? `sandbox: ${launch.profilePath}` : "sandbox: OFF");
    child = spawn(launch.command, [...launch.args], {
      env: toolchainEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    client = new HelperClient(child);
    const attached = await client.call("attach", { udid: device.udid });
    assert(Number(attached.pixelWidth) > 0, "attach returned an invalid display");
    info(`${attached.name} ${attached.pixelWidth}x${attached.pixelHeight}`);
    // attach is where the HID client is really created; report its reason
    // here rather than as the first swipe's bare error.
    const attachedCapabilities = (attached.capabilities ?? {}) as Record<string, unknown>;
    const degraded = (attached.degraded ?? {}) as Record<string, unknown>;
    assert(
      attachedCapabilities.input === true,
      `attach reported input unavailable: ${
        typeof degraded.hid === "string" ? degraded.hid : "no reason given"
      }`,
    );
    // The probe and attach read the same version gate; a mismatch means the
    // probe checked the symbols of a transport attach does not use.
    assert(
      attached.inputTransport === probe.inputTransport,
      `attach uses input transport ${String(attached.inputTransport)}, the probe reported ${String(
        probe.inputTransport,
      )}`,
    );
    info(`input transport: ${String(attached.inputTransport)}`);
    client.inputTransport = parseHelperInputTransport(attached.inputTransport) ?? null;

    step(`Streaming at least ${requiredFrames} frames`);
    const socketDir = mkdtempSync(join(tmpdir(), "ryco-device-smoke-"));
    cleanupPaths.push(socketDir);
    const socketPath = join(socketDir, "frames.sock");
    await collector.listen(socketPath);
    await client.call("stream.start", { socketPath });
    const deadline = Date.now() + 60_000;
    while (collector.frames.length < requiredFrames && Date.now() < deadline) {
      assert(
        collector.decodeError === undefined,
        `frame failed to decode: ${collector.decodeError}`,
      );
      await client.input("swipe", {
        startX: 0.8,
        startY: 0.5,
        endX: 0.2,
        endY: 0.5,
        durationMs: 350,
      });
      await sleep(400);
      await client.input("swipe", {
        startX: 0.2,
        startY: 0.5,
        endX: 0.8,
        endY: 0.5,
        durationMs: 350,
      });
      await sleep(400);
    }
    assert(collector.decodeError === undefined, `frame failed to decode: ${collector.decodeError}`);
    assert(
      collector.frames.length >= requiredFrames,
      `expected ${requiredFrames} frames, got ${collector.frames.length}${
        collector.socketError === undefined ? "" : ` (frame socket: ${collector.socketError})`
      }`,
    );
    const configs = collector.frames.filter((frame) => frame.codecConfig);
    const keyframes = collector.frames.filter((frame) => frame.keyframe);
    assert(
      configs.some((frame) => naluTypes(frame.payload).includes(7)),
      "stream has no SPS",
    );
    assert(
      keyframes.some((frame) => naluTypes(frame.payload).includes(5)),
      "stream has no IDR",
    );
    for (const frame of collector.frames) {
      assert(
        frame.payload[0] === 0 &&
          frame.payload[1] === 0 &&
          frame.payload[2] === 0 &&
          frame.payload[3] === 1,
        `frame ${frame.sequence} is not Annex B`,
      );
    }
    info(`${collector.frames.length} frames; Annex B, SPS, and IDR verified`);

    step("Injecting input and inspecting accessibility");
    await client.input("tap", { x: 0.5, y: 0.92 });
    await client.input("button", { name: "home" });
    await sleep(1_000);
    const tree = await describeUi(client, 6);
    assert(tree.children.length > 0, "accessibility tree has no children");

    if (options.skipInputCheck) {
      info("input check skipped (--skip-input-check)");
    } else {
      step("Checking that input reaches the guest");
      await checkInputReachesGuest(client, {
        udid: device.udid,
        env: toolchainEnv,
        pointWidth: Number(attached.pointWidth),
        pointHeight: Number(attached.pointHeight),
      });
    }

    step("Taking a screenshot");
    const screenshotPath = join(socketDir, "screen.png");
    await client.call("screenshot", { path: screenshotPath });
    const png = readFileSync(screenshotPath);
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    assert(
      magic.every((byte, index) => png[index] === byte),
      "screenshot is not a PNG",
    );
    if (options.screenshotOut !== undefined) {
      mkdirSync(dirname(options.screenshotOut), { recursive: true });
      copyFileSync(screenshotPath, options.screenshotOut);
      info(`screenshot copied to ${options.screenshotOut}`);
    }
    if (!options.skipInputCheck) {
      // Leaves the device on the home screen rather than in Settings.
      await client.input("button", { name: "home" });
    }
    await client.call("stream.stop");
    console.log("\n[device-smoke] PASS");
  } catch (error) {
    if (client?.stderr.length) {
      console.error("[device-smoke] helper stderr:");
      for (const line of client.stderr.slice(-20)) console.error(`  ${line}`);
    }
    if (!(error instanceof SmokeFailure)) fail("smoke run failed", error);
    throw error;
  } finally {
    cleanUp();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

main().catch((error: unknown) => {
  // A SmokeFailure was reported where it was raised; anything else escaped
  // before the run's own error handling (Xcode checks, the source digest).
  if (!(error instanceof SmokeFailure)) {
    console.error("[device-smoke] FAIL: unexpected error");
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exitCode = 1;
});
