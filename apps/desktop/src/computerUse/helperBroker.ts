import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync, rmSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { COMPUTER_USE_HELPER_PROTOCOL } from "@ryco/shared/computerUseHelperApp";

import type { ComputerUseHelperApp } from "./helperApp.ts";

/**
 * Starts Computer Use's native programs as children of Ryco Computer Use, the helper app macOS
 * gives the grants to (docs/superpowers/specs/2026-11-07-computer-use-helper-app.md). `spawn`
 * has the shape of Node's and returns a ChildProcess-like object whose stdio are the child's own
 * sockets, so the owners of those programs only receive a different `spawn`.
 */

export type ComputerUseStdio = "pipe" | "ignore";

export interface ComputerUseSpawnOptions {
  readonly stdio?: ComputerUseStdio | readonly (ComputerUseStdio | null | undefined)[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * The Cua driver: the socket path among `args` Ryco connects to. The helper gives the driver a
   * private path instead and relays connections, because the driver trusts host-only requests
   * only from its parent.
   */
  readonly proxySocket?: string;
}

export type ComputerUseSpawn = (
  command: string,
  args: readonly string[],
  options?: ComputerUseSpawnOptions,
) => HelperChildProcess;

const HELPER_STOPPED = "Ryco Computer Use stopped.";
const STREAM_HELLO_LIMIT = 4096;
const CONTROL_LINE_LIMIT = 64 * 1024;

/** A child of the helper app, with the parts of `ChildProcess` Computer Use's owners use. */
export class HelperChildProcess extends EventEmitter {
  readonly stdin: PassThrough | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** @internal */
  readonly stdioModes: readonly [ComputerUseStdio, ComputerUseStdio, ComputerUseStdio];
  /** @internal */
  pendingSignal: NodeJS.Signals | undefined = undefined;
  /** @internal */
  sendSignal: ((signal: NodeJS.Signals) => void) | undefined = undefined;
  private readonly sockets: Socket[] = [];
  private openReadables = 0;
  private exited = false;
  private closed = false;

  constructor(stdio: ComputerUseSpawnOptions["stdio"]) {
    super();
    const slots = typeof stdio === "string" ? [stdio, stdio, stdio] : (stdio ?? []);
    this.stdioModes = [0, 1, 2].map((fd) => (slots[fd] === "ignore" ? "ignore" : "pipe")) as [
      ComputerUseStdio,
      ComputerUseStdio,
      ComputerUseStdio,
    ];
    this.stdin = this.stdioModes[0] === "pipe" ? new PassThrough() : null;
    this.stdout = this.stdioModes[1] === "pipe" ? new PassThrough() : null;
    this.stderr = this.stdioModes[2] === "pipe" ? new PassThrough() : null;
    for (const readable of [this.stdout, this.stderr]) {
      if (!readable) continue;
      this.openReadables += 1;
      readable.once("end", () => {
        this.openReadables -= 1;
        this.maybeClose();
      });
      // Output nobody reads must not hold `close`: once it is complete, let it drain.
      readable.once("finish", () => {
        if (readable.readableFlowing !== true) readable.resume();
      });
    }
  }

  get connected(): boolean {
    return this.pid !== undefined && !this.exited;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exited) return false;
    const name =
      typeof signal === "number"
        ? ((Object.entries(osConstants.signals).find(([, value]) => value === signal)?.[0] as
            | NodeJS.Signals
            | undefined) ?? "SIGTERM")
        : signal;
    this.killed = true;
    if (this.sendSignal && this.pid !== undefined) this.sendSignal(name);
    else this.pendingSignal = name;
    return true;
  }

  /** @internal The helper connected one of the child's stdio sockets. */
  attach(fd: number, socket: Socket, initial: Buffer): void {
    this.sockets.push(socket);
    socket.on("error", () => undefined);
    if (fd === 0 && this.stdin) {
      this.stdin.pipe(socket);
      // Writes after the child is gone are dropped, like a closed pipe nobody listens to.
      socket.once("close", () => this.stdin?.unpipe(socket));
      return;
    }
    const readable = fd === 1 ? this.stdout : fd === 2 ? this.stderr : null;
    if (!readable) {
      socket.destroy();
      return;
    }
    if (initial.length > 0) readable.write(initial);
    socket.pipe(readable);
  }

  /** @internal */
  started(pid: number): void {
    this.pid = pid;
    this.emit("spawn");
    if (this.pendingSignal) {
      const signal = this.pendingSignal;
      this.pendingSignal = undefined;
      this.sendSignal?.(signal);
    }
  }

  /** @internal The program never ran. */
  failed(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("error", error);
    this.endStreams();
    this.maybeClose();
  }

  /** @internal */
  finished(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    // The stdin socket stays half open on Ryco's side; the child's output sockets end by
    // themselves once its descriptors close. A stream that never ends must not hold `close`.
    for (const socket of this.sockets) socket.end();
    setTimeout(() => this.endStreams(), 2000).unref();
    this.maybeClose();
  }

  private endStreams(): void {
    for (const socket of this.sockets) socket.destroy();
    for (const readable of [this.stdout, this.stderr])
      if (readable && !readable.writableEnded) readable.end();
  }

  private maybeClose(): void {
    if (this.closed || !this.exited || this.openReadables > 0) return;
    this.closed = true;
    this.stdin?.destroy();
    this.emit("close", this.exitCode, this.signalCode);
  }
}

interface PendingChild {
  readonly child: HelperChildProcess;
  readonly streamToken: Buffer;
}

interface Session {
  readonly directory: string;
  readonly server: Server;
  readonly control: Socket;
  readonly helperPid: number;
  readonly startedAt: number;
  readonly children: Map<string, PendingChild>;
  /** Ryco ended the session on purpose (idle, dispose); not a crash. */
  expected: boolean;
  ended: boolean;
}

export interface ComputerUseHelperBrokerOptions {
  readonly app: ComputerUseHelperApp;
  /** Starts the helper through LaunchServices so it is its own responsible process. */
  readonly launch?: (bundlePath: string, args: readonly string[]) => Promise<void>;
  readonly hostPid?: number;
  readonly idleMs?: number;
  readonly connectTimeoutMs?: number;
  readonly now?: () => number;
  /** Backstop when the helper dies: its reparented children are killed directly. */
  readonly killPid?: (pid: number, signal: NodeJS.Signals) => void;
  readonly log?: (message: string) => void;
  readonly runtimeParent?: string;
}

/** `open -n` always starts a fresh instance, so a helper left from an older Ryco never serves. */
export function launchWithLaunchServices(
  bundlePath: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/open",
      ["-n", "-g", "-j", bundlePath, "--args", ...args],
      { timeout: 10_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

const MAX_BACKOFF_MS = 30_000;
const STABLE_SESSION_MS = 60_000;

export class ComputerUseHelperBroker {
  private readonly options: ComputerUseHelperBrokerOptions;
  private readonly launch: (bundlePath: string, args: readonly string[]) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private session: Session | undefined;
  private connecting: Promise<Session> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private nextLaunchAt = 0;
  private disposed = false;

  constructor(options: ComputerUseHelperBrokerOptions) {
    this.options = options;
    this.launch = options.launch ?? launchWithLaunchServices;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.info(`[computer-use-helper] ${message}`));
  }

  get app(): ComputerUseHelperApp {
    return this.options.app;
  }

  /** The running helper's pid, for diagnostics and tests. */
  get helperPid(): number | undefined {
    return this.session && !this.session.ended ? this.session.helperPid : undefined;
  }

  readonly spawn: ComputerUseSpawn = (command, args, options = {}) => {
    const child = new HelperChildProcess(options.stdio);
    if (this.disposed) {
      queueMicrotask(() => child.failed(new Error(HELPER_STOPPED)));
      return child;
    }
    this.clearIdle();
    const id = randomUUID().slice(0, 18);
    const streamToken = randomBytes(24);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? process.env))
      if (typeof value === "string") env[key] = value;
    void this.ensureSession().then(
      (session) => {
        if (session.ended || this.disposed) {
          child.failed(new Error(HELPER_STOPPED));
          return;
        }
        session.children.set(id, { child, streamToken });
        child.sendSignal = (signal) =>
          this.write(session, { type: "kill", id, signal: osConstants.signals[signal] });
        child.once("close", () => {
          session.children.delete(id);
          this.scheduleIdle(session);
        });
        this.write(session, {
          type: "spawn",
          id,
          path: command,
          args: [...args],
          env,
          cwd: options.cwd ?? null,
          stdio: child.stdioModes,
          streamToken: streamToken.toString("base64url"),
          ...(options.proxySocket ? { proxySocket: options.proxySocket } : {}),
        });
      },
      (error: unknown) => {
        child.failed(error instanceof Error ? error : new Error(String(error)));
        if (this.session) this.scheduleIdle(this.session);
      },
    );
    return child;
  };

  private write(session: Session, message: Record<string, unknown>): void {
    if (!session.ended) session.control.write(`${JSON.stringify(message)}\n`);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdle(session: Session): void {
    if (session.ended || session.children.size > 0 || this.session !== session) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (session.children.size === 0) this.endSession(session, true);
    }, this.options.idleMs ?? 30_000);
    this.idleTimer.unref?.();
  }

  private ensureSession(): Promise<Session> {
    if (this.session && !this.session.ended) return Promise.resolve(this.session);
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<Session> {
    const wait = this.nextLaunchAt - this.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref());
    if (this.disposed) throw new Error(HELPER_STOPPED);
    const directory = await mkdtemp(join(this.options.runtimeParent ?? tmpdir(), "ryco-cu-"));
    await chmod(directory, 0o700);
    const token = randomBytes(32);
    const server = createServer({ allowHalfOpen: true });
    const brokerPath = join(directory, "broker.sock");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(brokerPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      await chmod(brokerPath, 0o600);
      await writeFile(join(directory, "token"), token.toString("base64url"), {
        mode: 0o600,
        flag: "wx",
      });
      const hello = this.awaitHello(server, token);
      try {
        await this.launch(this.options.app.bundlePath, ["--broker", directory]);
      } catch (error) {
        // Nothing will connect: stop waiting now, so no timer rejects later with nobody listening.
        hello.cancel();
        throw error;
      }
      const { control, helperPid } = await hello.promise;
      const session: Session = {
        directory,
        server,
        control,
        helperPid,
        startedAt: this.now(),
        children: new Map(),
        expected: false,
        ended: false,
      };
      this.session = session;
      server.on("connection", (socket) => this.acceptStream(session, socket));
      this.readControl(session);
      this.log(`started pid=${helperPid}`);
      // Disposed while it started: it goes again at once.
      if (this.disposed) this.endSession(session, true);
      return session;
    } catch (error) {
      server.close();
      await rm(directory, { recursive: true, force: true });
      this.noteFailure();
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`start failed: ${reason}`);
      throw new Error(`${this.options.app.displayName} did not start. ${reason}`.trim());
    }
  }

  private noteFailure(): void {
    this.failures += 1;
    this.nextLaunchAt = this.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
  }

  /** The first connection that proves the token, protocol, version and bundle is the helper. */
  private awaitHello(
    server: Server,
    token: Buffer,
  ): { promise: Promise<{ control: Socket; helperPid: number }>; cancel: () => void } {
    let cancel = (): void => undefined;
    const promise = new Promise<{ control: Socket; helperPid: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.removeListener("connection", onConnection);
        reject(new Error("It did not connect in time."));
      }, this.options.connectTimeoutMs ?? 10_000);
      const onConnection = (socket: Socket) => {
        readFirstLine(socket, STREAM_HELLO_LIMIT, (line, rest) => {
          const hello = parseJson(line);
          if (hello?.type !== "hello") {
            socket.destroy();
            return;
          }
          const presented = Buffer.from(typeof hello.token === "string" ? hello.token : "");
          const expected = Buffer.from(token.toString("base64url"));
          if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
            socket.destroy();
            return;
          }
          server.removeListener("connection", onConnection);
          clearTimeout(timeout);
          const mismatch = this.helloMismatch(hello);
          if (mismatch) {
            socket.end(`${JSON.stringify({ type: "reject", reason: mismatch })}\n`);
            reject(new Error(mismatch));
            return;
          }
          socket.write(
            `${JSON.stringify({ type: "welcome", hostPid: this.options.hostPid ?? process.pid })}\n`,
          );
          if (rest.length > 0) socket.unshift(rest);
          resolve({ control: socket, helperPid: hello.pid as number });
        });
      };
      server.on("connection", onConnection);
      cancel = () => {
        clearTimeout(timeout);
        server.removeListener("connection", onConnection);
      };
    });
    return { promise, cancel };
  }

  private helloMismatch(hello: Record<string, unknown>): string | undefined {
    if (hello.protocol !== COMPUTER_USE_HELPER_PROTOCOL)
      return "It speaks another protocol than this Ryco. Reinstall Ryco.";
    if (typeof hello.pid !== "number" || !Number.isSafeInteger(hello.pid) || hello.pid <= 1)
      return "It reported an invalid process.";
    if (hello.version !== this.options.app.version)
      return "It is from another Ryco version. Reinstall Ryco.";
    if (
      typeof hello.bundlePath !== "string" ||
      !samePath(hello.bundlePath, this.options.app.bundlePath)
    )
      return "macOS started another copy of it. Quit other Ryco copies and try again.";
    return undefined;
  }

  private readControl(session: Session): void {
    let pending = "";
    session.control.setEncoding("utf8");
    session.control.resume();
    session.control.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > CONTROL_LINE_LIMIT && !pending.includes("\n")) {
        session.control.destroy();
        return;
      }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        this.handleControl(session, parseJson(line));
      }
    });
    session.control.on("error", () => undefined);
    // The broker allows half-open sockets for stdin streams; a helper that ends or dies ends
    // the session whichever way its socket closes.
    session.control.once("end", () => this.endSession(session, session.expected));
    session.control.once("close", () => this.endSession(session, session.expected));
  }

  private handleControl(session: Session, message: Record<string, unknown> | undefined): void {
    const id = typeof message?.id === "string" ? message.id : undefined;
    const entry = id ? session.children.get(id) : undefined;
    if (!message || !entry) return;
    if (message.type === "spawned" && typeof message.pid === "number") {
      entry.child.started(message.pid);
    } else if (message.type === "spawn-failed") {
      entry.child.failed(
        new Error(typeof message.message === "string" ? message.message : "Could not start."),
      );
    } else if (message.type === "exit") {
      const signal =
        typeof message.signal === "number"
          ? ((Object.entries(osConstants.signals).find(
              ([, value]) => value === message.signal,
            )?.[0] as NodeJS.Signals | undefined) ?? "SIGKILL")
          : null;
      entry.child.finished(typeof message.code === "number" ? message.code : null, signal);
    }
  }

  /** Stream sockets: the first line names the child and fd and proves the spawn's token. */
  private acceptStream(session: Session, socket: Socket): void {
    readFirstLine(socket, STREAM_HELLO_LIMIT, (line, rest) => {
      const hello = parseJson(line);
      const entry =
        hello?.type === "stream" && typeof hello.id === "string"
          ? session.children.get(hello.id)
          : undefined;
      const presented = Buffer.from(typeof hello?.token === "string" ? hello.token : "");
      const expected = Buffer.from(entry ? entry.streamToken.toString("base64url") : "");
      const fd = hello?.fd;
      if (
        !entry ||
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected) ||
        (fd !== 0 && fd !== 1 && fd !== 2) ||
        entry.child.stdioModes[fd] !== "pipe"
      ) {
        socket.destroy();
        return;
      }
      entry.child.attach(fd, socket, rest);
    });
  }

  private endSession(session: Session, expected: boolean): void {
    if (session.ended) return;
    session.ended = true;
    if (this.session === session) this.session = undefined;
    this.clearIdle();
    if (!session.control.destroyed) {
      session.control.end(`${JSON.stringify({ type: "shutdown" })}\n`);
      setTimeout(() => session.control.destroy(), 2000).unref();
    }
    session.server.close();
    // Synchronous: dispose runs from the process exit hook too.
    rmSync(session.directory, { recursive: true, force: true });
    const killPid =
      this.options.killPid ??
      ((pid: number, signal: NodeJS.Signals) => {
        process.kill(pid, signal);
      });
    for (const { child } of session.children.values()) {
      if (child.pid === undefined) {
        child.failed(new Error(HELPER_STOPPED));
        continue;
      }
      // Already reaped by the helper: its pid may belong to another process by now.
      if (child.exitCode !== null || child.signalCode !== null) continue;
      // A helper that is gone cannot stop its children: a driver it started would keep running
      // under launchd. On purpose, the helper stops them itself (SIGTERM, then SIGKILL).
      if (!expected)
        try {
          killPid(child.pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      child.finished(null, expected ? "SIGTERM" : "SIGKILL");
    }
    if (expected || this.now() - session.startedAt >= STABLE_SESSION_MS) {
      this.failures = 0;
      this.nextLaunchAt = 0;
    } else {
      this.noteFailure();
    }
    this.log(`stopped pid=${session.helperPid}${expected ? "" : " unexpectedly"}`);
  }

  /** Ends the helper; it stops its children. Quitting Ryco closes the socket the same way. */
  dispose(): void {
    this.disposed = true;
    if (this.session) this.endSession(this.session, true);
  }
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one newline-terminated header line; the bytes after it belong to the stream. */
function readFirstLine(
  socket: Socket,
  limit: number,
  onLine: (line: string, rest: Buffer) => void,
): void {
  let buffered = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), 5000);
  timer.unref();
  socket.on("error", () => undefined);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) {
      if (buffered.length > limit) {
        clearTimeout(timer);
        socket.destroy();
      }
      return;
    }
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.pause();
    onLine(buffered.subarray(0, newline).toString("utf8"), buffered.subarray(newline + 1));
  };
  socket.on("data", onData);
}
