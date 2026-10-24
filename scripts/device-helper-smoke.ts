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
//
// Without --udid the smoke prefers an already-booted simulator, which suits a
// developer's machine but not an agent sharing one: agents pass --udid.

import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

import { sandboxedHelperCommand } from "../apps/server/src/device/helperSandbox.ts";
import {
  parseSmokeOptions,
  selectSmokeSimulator,
  type SimctlDevice,
} from "./lib/device-helper-smoke-options.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperDir = join(repoRoot, "apps/server/native/device-helper");
const requiredFrames = 30;

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

/** Runs a command with inherited stdio without blocking signal delivery. */
function runInherited(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { env, stdio: "inherit" });
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
  const probe = JSON.parse(probeRaw) as {
    readonly ok: boolean;
    readonly deviceCount?: number;
    readonly error?: string;
    readonly capabilities?: Record<string, unknown>;
  };
  for (const [name, status] of Object.entries(probe.capabilities ?? {})) {
    info(`capability ${name}: ${status === "ok" ? "ok" : JSON.stringify(status)}`);
  }
  const broken = Object.entries(probe.capabilities ?? {})
    .filter(([, status]) => status !== "ok")
    .map(([name]) => name);
  assert(broken.length === 0, `helper capabilities unavailable: ${broken.join(", ")}`);
  assert(probe.ok, `helper preflight failed: ${probe.error ?? "unknown error"}`);
  info(`CoreSimulator reachable, ${probe.deviceCount ?? "?"} devices`);
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
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: HelperClient | undefined;
  const collector = new FrameCollector();
  const cleanupPaths: string[] = [];

  // Synchronous and idempotent, so the `finally` and a signal handler can both
  // call it. Only ever shuts down the simulator this run booted.
  let cleanedUp = false;
  const cleanUp = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    collector.close();
    child?.stdin.end();
    child?.kill();
    for (const cleanupPath of cleanupPaths) rmSync(cleanupPath, { recursive: true, force: true });
    if (bootedBySmoke) {
      info(`shutting down ${device.udid}, which this smoke run booted`);
      try {
        execFileSync("xcrun", ["simctl", "shutdown", device.udid], {
          env: toolchainEnv,
          stdio: "inherit",
        });
      } catch (error) {
        console.error("[device-smoke] warning: owned simulator shutdown failed", error);
      }
    }
  };
  // A tool timeout or Ctrl-C would otherwise end the process with the
  // simulator still running. Registered before the synchronous boot: a signal
  // that arrives during it is delivered once it returns, by which time
  // `bootedBySmoke` says whether the boot was ours.
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
      execFileSync("xcrun", ["simctl", "boot", device.udid], {
        env: toolchainEnv,
        stdio: "inherit",
      });
      bootedBySmoke = true;
      info(`booted ${device.udid}; it is shut down when this run ends`);
      // Asynchronous so a signal during a slow first boot is handled now, not
      // after the device finishes booting.
      await runInherited("xcrun", ["simctl", "bootstatus", device.udid, "-b"], toolchainEnv);
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
      await client.call("swipe", {
        startX: 0.8,
        startY: 0.5,
        endX: 0.2,
        endY: 0.5,
        durationMs: 350,
      });
      await sleep(400);
      await client.call("swipe", {
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
    await client.call("tap", { x: 0.5, y: 0.92 });
    await client.call("button", { name: "home" });
    await sleep(1_000);
    const described = await client.call("describe-ui", { maxDepth: 6 });
    const tree = described.tree as { children?: unknown[] } | undefined;
    assert(Boolean(tree?.children?.length), "accessibility tree has no children");

    step("Taking a screenshot");
    const screenshotPath = join(socketDir, "screen.png");
    await client.call("screenshot", { path: screenshotPath });
    const png = readFileSync(screenshotPath);
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    assert(
      magic.every((byte, index) => png[index] === byte),
      "screenshot is not a PNG",
    );
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
