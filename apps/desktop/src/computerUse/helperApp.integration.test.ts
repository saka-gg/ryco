import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assembleComputerUseApp,
  buildComputerUseAppExecutable,
} from "../../scripts/build-computer-use-app.mjs";
import { findComputerUseHelperApp } from "./helperApp.ts";
import { ComputerUseHelperBroker, type HelperChildProcess } from "./helperBroker.ts";

// The real Swift helper, launched directly (not through LaunchServices, which tests must not
// touch): spawning, the allowlist, stdio sockets, the driver relay and teardown.
const canBuild =
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).status === 0;

const FAKE_DRIVER = `
const net = require("node:net");
const path = process.argv[process.argv.indexOf("--socket") + 1];
net.createServer({ allowHalfOpen: true }, (socket) => {
  let input = "";
  socket.on("data", (chunk) => (input += chunk));
  socket.on("end", () => socket.end(JSON.stringify({ ppid: process.ppid, path, input }) + "\\n"));
}).listen(path, () => process.stdout.write("listening\\n"));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

let root: string;
let broker: ComputerUseHelperBroker;
let resources: string;

beforeAll(async () => {
  if (!canBuild) return;
  root = await mkdtemp(join(tmpdir(), "ryco-cu-app-"));
  resources = join(root, "resources");
  await mkdir(join(resources, "cua-driver"), { recursive: true });
  const driver = join(resources, "cua-driver", "cua-driver");
  await writeFile(driver, `#!${process.execPath}\n${FAKE_DRIVER}`);
  await chmod(driver, 0o755);
  await writeFile(join(root, "elsewhere"), `#!/bin/sh\necho no\n`, { mode: 0o755 });
  const executable = buildComputerUseAppExecutable({
    outputPath: join(root, "ryco-computer-use-app"),
    quiet: true,
  });
  assembleComputerUseApp({
    executable,
    outputDirectory: join(root, "launchers"),
    identity: { name: "Ryco Computer Use (Test)", bundleId: "com.example.ryco.test.computer-use" },
    version: "9.9.9",
    iconPath: join(import.meta.dirname, "../../resources/icon.icns"),
    resourcesDirectory: resources,
    // The test process brokers the helper here; Ryco does in the app.
    hostPath: realpathSync(process.execPath),
  });
  const app = findComputerUseHelperApp({
    hostBundlePath: join(root, "launchers", "Host.app"),
    platform: "darwin",
    isPackaged: false,
  })!;
  broker = new ComputerUseHelperBroker({
    app,
    idleMs: 60_000,
    log: () => undefined,
    launch: async (bundlePath, args) => {
      const helper = spawn(join(bundlePath, "Contents", "MacOS", "RycoComputerUse"), [...args], {
        stdio: "ignore",
      });
      helper.unref();
    },
  });
}, 180_000);

afterAll(async () => {
  broker?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

function firstLine(child: HelperChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.split("\n")[0]!);
    });
  });
}

function request(path: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("end", () => resolve(reply));
    socket.on("error", reject);
    socket.end(body);
  });
}

describe.skipIf(!canBuild)("Ryco Computer Use helper app", () => {
  it("runs the driver as its own child and relays Ryco's connections to it", async () => {
    const endpoint = join(root, "d.sock");
    const driver = broker.spawn(
      join(resources, "cua-driver", "cua-driver"),
      ["serve", "--embedded", "--socket", endpoint],
      { stdio: ["pipe", "pipe", "ignore"], proxySocket: endpoint },
    );
    expect(await firstLine(driver)).toBe("listening");
    const reply = JSON.parse(await request(endpoint, "metadata\n")) as Record<string, unknown>;
    // The driver's parent is the helper app, so macOS attributes its grants to the helper.
    expect(reply.ppid).toBe(broker.helperPid);
    expect(reply.ppid).not.toBe(process.pid);
    // It listens on a private path; Ryco reaches it only through the relay, with half-close.
    expect(reply.path).not.toBe(endpoint);
    expect(reply.input).toBe("metadata\n");
    const exited = new Promise((resolve) => driver.once("exit", (code) => resolve(code)));
    driver.stdin!.end();
    expect(await exited).toBe(0);
    // The relay goes away with its driver.
    await vi.waitFor(() => expect(spawnSync("test", ["-S", endpoint]).status).not.toBe(0));
  }, 60_000);

  it("refuses programs outside Ryco's resources", async () => {
    const child = broker.spawn(join(root, "elsewhere"), [], { stdio: "pipe" });
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    expect(error.message).toContain("only starts Ryco's own helpers");
  });

  it("serves no broker but the host its Info.plist names", async () => {
    const impostorExecutable = join(
      root,
      "launchers",
      "Ryco Computer Use (Test).app",
      "Contents",
      "MacOS",
      "RycoComputerUse",
    );
    assembleComputerUseApp({
      executable: impostorExecutable,
      outputDirectory: join(root, "other"),
      identity: { name: "Other Computer Use", bundleId: "com.example.other.computer-use" },
      version: "9.9.9",
      iconPath: join(import.meta.dirname, "../../resources/icon.icns"),
      resourcesDirectory: resources,
      // Not this test process: the helper must refuse to serve it.
      hostPath: "/usr/bin/true",
    });
    const other = new ComputerUseHelperBroker({
      app: findComputerUseHelperApp({
        hostBundlePath: join(root, "other", "Host.app"),
        platform: "darwin",
        isPackaged: false,
      })!,
      connectTimeoutMs: 3000,
      log: () => undefined,
      launch: async (bundlePath, args) => {
        spawn(join(bundlePath, "Contents", "MacOS", "RycoComputerUse"), [...args], {
          stdio: "ignore",
        }).unref();
      },
    });
    const child = other.spawn(join(resources, "cua-driver", "cua-driver"), [], {});
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    expect(error.message).toContain("did not connect in time");
    other.dispose();
  }, 30_000);

  it("stops its children and exits when Ryco goes away", async () => {
    const driver = broker.spawn(
      join(resources, "cua-driver", "cua-driver"),
      ["serve", "--socket", join(root, "e.sock")],
      { stdio: ["pipe", "pipe", "ignore"], proxySocket: join(root, "e.sock") },
    );
    expect(await firstLine(driver)).toBe("listening");
    const helperPid = broker.helperPid!;
    const driverPid = driver.pid!;
    broker.dispose();
    await vi.waitFor(
      () => {
        expect(() => process.kill(driverPid, 0)).toThrow();
        expect(() => process.kill(helperPid, 0)).toThrow();
      },
      { timeout: 5000 },
    );
  }, 60_000);
});
