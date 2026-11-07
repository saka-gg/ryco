import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPUTER_USE_HELPER_PROTOCOL } from "@ryco/shared/computerUseHelperApp";

import { ComputerUseHelperBroker, HelperChildProcess } from "./helperBroker.ts";

/**
 * Plays Ryco Computer Use's side of the protocol in-process: reads the token, says hello, and
 * starts real Node children whose stdio are piped through the stream sockets it opens.
 */
class FakeHelper {
  control: Socket | undefined;
  readonly children = new Map<string, ChildProcess>();
  readonly spawns: Record<string, unknown>[] = [];
  readonly kills: Array<{ id: string; signal: number }> = [];
  rejected: string | undefined;

  private readonly hello: Partial<Record<string, unknown>>;
  readonly pid: number;

  constructor(hello: Partial<Record<string, unknown>> = {}, pid = 4242) {
    this.hello = hello;
    this.pid = pid;
  }

  async start(bundlePath: string, args: readonly string[]): Promise<void> {
    const directory = args[args.indexOf("--broker") + 1]!;
    const tokenPath = join(directory, "token");
    expect((await stat(tokenPath)).mode & 0o077).toBe(0);
    const token = await readFile(tokenPath, "utf8");
    await unlink(tokenPath);
    const control = connect(join(directory, "broker.sock"));
    this.control = control;
    control.setEncoding("utf8");
    control.write(
      `${JSON.stringify({
        type: "hello",
        protocol: COMPUTER_USE_HELPER_PROTOCOL,
        token,
        pid: this.pid,
        version: "1.2.3",
        bundlePath,
        ...this.hello,
      })}\n`,
    );
    let pending = "";
    control.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const message = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>;
        pending = pending.slice(newline + 1);
        this.handle(directory, message);
      }
    });
    control.on("error", () => undefined);
  }

  private send(message: Record<string, unknown>): void {
    this.control?.write(`${JSON.stringify(message)}\n`);
  }

  private handle(directory: string, message: Record<string, unknown>): void {
    if (message.type === "reject") this.rejected = String(message.reason);
    if (message.type === "kill") {
      this.kills.push({ id: String(message.id), signal: Number(message.signal) });
      const name = Object.entries(osConstants.signals).find(
        ([, value]) => value === message.signal,
      )?.[0] as NodeJS.Signals;
      this.children.get(String(message.id))?.kill(name);
    }
    if (message.type !== "spawn") return;
    this.spawns.push(message);
    const id = String(message.id);
    const stdio = message.stdio as string[];
    const child = spawn(String(message.path), message.args as string[], {
      stdio: stdio.map((mode) => (mode === "pipe" ? "pipe" : "ignore")) as ("pipe" | "ignore")[],
      env: message.env as NodeJS.ProcessEnv,
    });
    this.children.set(id, child);
    stdio.forEach((mode, fd) => {
      if (mode !== "pipe") return;
      const socket = connect(join(directory, "broker.sock"));
      socket.on("error", () => undefined);
      socket.write(`${JSON.stringify({ type: "stream", id, fd, token: message.streamToken })}\n`);
      if (fd === 0) socket.pipe(child.stdin!);
      else (fd === 1 ? child.stdout! : child.stderr!).pipe(socket);
    });
    child.once("spawn", () => this.send({ type: "spawned", id, pid: child.pid }));
    child.once("exit", (code, signal) =>
      this.send({
        type: "exit",
        id,
        ...(signal ? { signal: osConstants.signals[signal] } : { code }),
      }),
    );
  }

  crash(): void {
    this.control?.destroy();
  }
}

const NODE = process.execPath;
const roots: string[] = [];
const brokers: ComputerUseHelperBroker[] = [];

afterEach(async () => {
  for (const broker of brokers.splice(0)) broker.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  helper = new FakeHelper(),
  options: Partial<ConstructorParameters<typeof ComputerUseHelperBroker>[0]> = {},
) {
  const runtimeParent = await mkdtemp(join(tmpdir(), "ryco-cu-test-"));
  roots.push(runtimeParent);
  const launch = vi.fn((bundlePath: string, args: readonly string[]) =>
    helper.start(bundlePath, args),
  );
  const broker = new ComputerUseHelperBroker({
    app: {
      bundlePath: runtimeParent,
      bundleId: "com.example.computer-use",
      displayName: "Ryco Computer Use",
      version: "1.2.3",
    },
    launch,
    runtimeParent,
    connectTimeoutMs: 2000,
    log: () => undefined,
    ...options,
  });
  brokers.push(broker);
  return { broker, helper, launch };
}

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => (text += chunk));
  return () => text;
}

function closed(child: HelperChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => child.once("close", (code, signal) => resolve([code, signal])));
}

const ECHO = `process.stdout.write("ready:" + process.env.MARK + "\\n");
process.stderr.write("err\\n");
process.stdin.on("data", (d) => process.stdout.write("got:" + d));
process.stdin.on("end", () => process.exit(3));`;

describe.skipIf(process.platform === "win32")("ComputerUseHelperBroker", () => {
  it("starts a child through the helper with its stdio, env and exit status", async () => {
    const { broker, launch, helper } = await setup();
    const child = broker.spawn(NODE, ["-e", ECHO], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { MARK: "m1", PATH: process.env.PATH },
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const done = closed(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    expect(child.pid).toBe(helper.children.values().next().value?.pid);
    await vi.waitFor(() => expect(stdout()).toBe("ready:m1\n"));
    child.stdin!.write("hello\n");
    await vi.waitFor(() => expect(stdout()).toContain("got:hello"));
    child.stdin!.end();
    expect(await exit).toBe(3);
    expect(await done).toEqual([3, null]);
    expect(stderr()).toBe("err\n");
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![1]).toEqual(["--broker", expect.any(String)]);
    // The env Ryco passes is the child's whole environment, never the helper's own.
    expect(helper.spawns[0]!.env).toEqual({ MARK: "m1", PATH: process.env.PATH });
  });

  it("reuses one helper for many children, routes kill through it and passes the proxy socket", async () => {
    const { broker, launch, helper } = await setup();
    const first = broker.spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const second = broker.spawn(
      NODE,
      ["-e", "setInterval(() => {}, 1000)", "--socket", "/x.sock"],
      {
        stdio: ["ignore", "ignore", "pipe"],
        proxySocket: "/x.sock",
      },
    );
    const secondSpawned = new Promise((resolve) => second.once("spawn", resolve));
    const secondClosed = closed(second);
    // A kill before the helper answered is sent once the child exists.
    first.kill("SIGTERM");
    expect(await closed(first)).toEqual([null, "SIGTERM"]);
    await secondSpawned;
    second.kill();
    expect(await secondClosed).toEqual([null, "SIGTERM"]);
    expect(launch).toHaveBeenCalledOnce();
    expect(helper.kills.map((kill) => kill.signal)).toEqual([15, 15]);
    expect(helper.spawns[1]).toMatchObject({
      proxySocket: "/x.sock",
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(first.kill()).toBe(false);
  });

  it("rejects a helper of another version and backs off before the next launch", async () => {
    let now = 1_000;
    const helper = new FakeHelper({ version: "0.9.0" });
    const { broker, launch } = await setup(helper, { now: () => now });
    const child = broker.spawn(NODE, ["-e", ""], {});
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    expect(error.message).toContain("another Ryco version");
    await vi.waitFor(() => expect(helper.rejected).toContain("another Ryco version"));
    now += 200;
    const retry = broker.spawn(NODE, ["-e", ""], {});
    const started = Date.now();
    await new Promise((resolve) => retry.once("error", resolve));
    // The second launch waited out the rest of the first backoff second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("rejects a hello without the launch token", async () => {
    const helper = new FakeHelper({ token: "forged" });
    const { broker } = await setup(helper, { connectTimeoutMs: 300 });
    const child = broker.spawn(NODE, ["-e", ""], {});
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    expect(error.message).toContain("did not connect in time");
  });

  it("refuses a stream socket that does not prove the spawn's token", async () => {
    const { broker } = await setup();
    const child = broker.spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    // Anyone who can reach the broker socket still cannot attach to a child's stdio.
    const directory = (await import("node:fs/promises")).readdir;
    const parent = roots[0]!;
    const [runtime] = (await directory(parent)).filter((entry) => entry.startsWith("ryco-cu-"));
    const intruder = connect(join(parent, runtime!, "broker.sock"));
    const ended = new Promise((resolve) => intruder.once("close", resolve));
    intruder.on("error", () => undefined);
    intruder.write(`${JSON.stringify({ type: "stream", id: "x", fd: 1, token: "nope" })}\n`);
    await ended;
    child.kill("SIGKILL");
    await closed(child);
  });

  it("closes an idle helper and starts a fresh one on demand", async () => {
    const { broker, launch } = await setup(new FakeHelper(), { idleMs: 50 });
    const first = broker.spawn(NODE, ["-e", ""], { stdio: "ignore" });
    await closed(first);
    await vi.waitFor(() => expect(broker.helperPid).toBeUndefined());
    const second = broker.spawn(NODE, ["-e", ""], { stdio: "ignore" });
    expect(await closed(second)).toEqual([0, null]);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("kills a crashed helper's children itself and reports them exited", async () => {
    const killPid = vi.fn((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });
    const { broker, helper } = await setup(new FakeHelper(), { killPid });
    const child = broker.spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    const pid = child.pid!;
    const done = closed(child);
    helper.crash();
    expect(await done).toEqual([null, "SIGKILL"]);
    expect(killPid).toHaveBeenCalledWith(pid, "SIGKILL");
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("fails a spawn cleanly when the launch itself fails", async () => {
    const { broker } = await setup(new FakeHelper());
    (broker as unknown as { launch: () => Promise<void> }).launch = async () => {
      throw new Error("open failed");
    };
    const child = broker.spawn(NODE, ["-e", ""], {});
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    expect(error.message).toContain("open failed");
  });

  it("settles a spawn that races dispose", async () => {
    const { broker } = await setup();
    const child = broker.spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    broker.dispose();
    const done = await new Promise<string>((resolve) => {
      child.once("error", () => resolve("error"));
      child.once("close", () => resolve("close"));
    });
    expect(done).toBe("error");
    expect(broker.helperPid).toBeUndefined();
  });

  it("fails spawns after dispose without launching", async () => {
    const { broker, launch } = await setup();
    broker.dispose();
    const child = broker.spawn(NODE, ["-e", ""], {});
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    expect(error.message).toBe("Ryco Computer Use stopped.");
    expect(launch).not.toHaveBeenCalled();
  });
});
