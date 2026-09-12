import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { baseSshArgs, buildSshHostSpec, SSH_COMMAND } from "@ryco/ssh/command";
import { Schema } from "effect";
import type { DeviceGeometry } from "@ryco/contracts";
import packageJson from "../../package.json" with { type: "json" };
import { DeviceBackendError, type DeviceFrameListener } from "./DeviceBackend.ts";
import {
  ForwardingDeviceBackend,
  type DeviceCall,
  type DeviceArgs,
  type DeviceResult,
} from "./ForwardingDeviceBackend.ts";
import { SshDeviceHostConfig } from "./deviceHostConfig.ts";
import {
  DEVICE_HOST_PROTOCOL,
  DEVICE_HOST_WORKER_ARG,
  MAX_DEVICE_HOST_MESSAGE,
  decodeDeviceHostValue,
  deviceHostOperations,
  type DeviceHostOperation,
} from "./deviceHostProtocol.ts";

export function deviceHostSshArgs(config: SshDeviceHostConfig): string[] {
  Schema.decodeUnknownSync(SshDeviceHostConfig)(config);
  const target = {
    alias: config.target,
    hostname: config.target,
    username: null,
    port: config.port ?? null,
  };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    ...baseSshArgs(target, { batchMode: "yes" }),
    "-T",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    ...(config.identityFile ? ["-i", config.identityFile] : []),
    buildSshHostSpec(target),
    `exec ${quote(config.executable)} ${DEVICE_HOST_WORKER_ARG}`,
  ];
}

export interface SshDeviceProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): boolean;
}
export type SpawnDeviceHost = (command: string, args: readonly string[]) => SshDeviceProcess;

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: DeviceHostOperation;
};

/** One bounded, authenticated SSH channel per host. Reads may reconnect; mutations never replay. */
export class SshDeviceBackend extends ForwardingDeviceBackend {
  private child: SshDeviceProcess | null = null;
  private connecting: Promise<void> | null = null;
  private ready = false;
  private disposed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<string, { listener: DeviceFrameListener; id: number }>();
  private readonly geometries = new Map<string, DeviceGeometry>();
  private readonly disconnectListeners = new Set<(udids: readonly string[]) => void>();
  private heartbeat: NodeJS.Timeout | undefined;
  private lastPong = 0;
  private retryAt = 0;

  private readonly config: SshDeviceHostConfig;
  private readonly spawnProcess: SpawnDeviceHost;
  constructor(
    config: SshDeviceHostConfig,
    spawnProcess: SpawnDeviceHost = (command, args) => spawn(command, [...args], { stdio: "pipe" }),
  ) {
    super();
    this.config = config;
    this.spawnProcess = spawnProcess;
  }

  onDisconnect(listener: (udids: readonly string[]) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private disconnect(
    child: SshDeviceProcess,
    message = "SSH device host disconnected; refresh and select the device again.",
  ): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.retryAt = Date.now() + 1_000;
    clearInterval(this.heartbeat);
    const error = new DeviceBackendError(message);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    const udids = [...this.streams.keys()];
    this.streams.clear();
    this.geometries.clear();
    child.stdin.destroy();
    child.kill();
    for (const listener of this.disconnectListeners) listener(udids);
  }

  private connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new DeviceBackendError("Device host disposed"));
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAt)
      return Promise.reject(
        new DeviceBackendError("SSH device host unavailable; retry after a moment."),
      );
    this.connecting = new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(SSH_COMMAND, deviceHostSshArgs(this.config));
      this.child = child;
      let buffer = "";
      const decoder = new StringDecoder("utf8");
      const timer = setTimeout(() => fail("SSH device host handshake timed out"), 20_000);
      const fail = (message: string) => {
        clearTimeout(timer);
        this.disconnect(child, message);
        reject(new DeviceBackendError(message));
      };
      child.on("error", () => fail("Could not start SSH device host"));
      child.on("close", () =>
        fail("SSH device host disconnected; verify SSH access and matching Ryco installation."),
      );
      child.stdin.on("error", () => fail("SSH device host input closed"));
      // Drain stderr without putting remote shell output or secrets into device events.
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.child !== child) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_DEVICE_HOST_MESSAGE) {
          fail("Oversized SSH device host message");
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (!this.ready) {
              if (
                message.type !== "ready" ||
                message.protocol !== DEVICE_HOST_PROTOCOL ||
                message.version !== packageJson.version
              )
                throw new Error("version");
              this.ready = true;
              clearTimeout(timer);
              this.lastPong = Date.now();
              this.heartbeat = setInterval(() => {
                if (Date.now() - this.lastPong > 45_000) {
                  fail("SSH device host heartbeat timed out");
                  return;
                }
                child.stdin.write('{"type":"ping"}\n');
              }, 15_000);
              this.heartbeat.unref();
              resolve();
              continue;
            }
            if (message.type === "pong") {
              this.lastPong = Date.now();
              continue;
            }
            if (message.type === "frame") {
              if (
                typeof message.udid !== "string" ||
                typeof message.data !== "string" ||
                !Number.isSafeInteger(message.sequence) ||
                typeof message.timestampMs !== "number" ||
                !Number.isFinite(message.timestampMs) ||
                typeof message.keyframe !== "boolean" ||
                typeof message.codecConfig !== "boolean"
              )
                throw new Error("frame");
              const stream = this.streams.get(message.udid);
              if (!stream || stream.id !== message.streamId) continue;
              stream.listener({
                sequence: message.sequence as number,
                timestampMs: message.timestampMs,
                keyframe: message.keyframe,
                codecConfig: message.codecConfig,
                data: Buffer.from(message.data, "base64"),
              });
              continue;
            }
            if (typeof message.id !== "number") throw new Error("id");
            const p = this.pending.get(message.id);
            if (!p) throw new Error("stale response");
            if (typeof message.error === "string") {
              clearTimeout(p.timer);
              this.pending.delete(message.id);
              p.reject(
                new DeviceBackendError(message.error.slice(0, 2048), {
                  retryable: message.retryable === true,
                }),
              );
            } else {
              const value = decodeDeviceHostValue(
                deviceHostOperations[p.method].output,
                message.result === null && p.method !== "attachStream" ? undefined : message.result,
              );
              clearTimeout(p.timer);
              this.pending.delete(message.id);
              p.resolve(value);
            }
          } catch {
            fail("Malformed SSH device host protocol or incompatible Ryco version");
            return;
          }
        }
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private request(method: DeviceHostOperation, args: readonly unknown[]): Promise<unknown> {
    const child = this.child;
    if (!child || !this.ready || this.disposed)
      return Promise.reject(
        new DeviceBackendError("Device host disconnected. Refresh devices before retrying."),
      );
    if (this.pending.size >= 32)
      return Promise.reject(new DeviceBackendError("Device host is busy"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.disconnect(
            child,
            "Device host operation timed out; its outcome is unknown. Refresh before retrying.",
          ),
        180_000,
      );
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    });
  }

  suspendTesting(_udid?: string): () => void {
    // No testing operation exists in the remote protocol. Nothing can be in flight.
    return () => undefined;
  }

  async testing(_input: Parameters<ForwardingDeviceBackend["testing"]>[0]): Promise<void> {
    throw new DeviceBackendError("Simulator testing controls are unavailable on SSH hosts.");
  }

  async call<K extends DeviceCall>(method: K, args: DeviceArgs<K>): Promise<DeviceResult<K>> {
    if (method === "availability" || method === "listDevices") await this.connect();
    if (method === "install") {
      throw new DeviceBackendError(
        "SSH app delivery is not supported. Install the app on the Mac, then launch it by bundle ID.",
      );
    }
    // Host paths must never be mistaken for coding-node artifacts.
    if (
      method === "startRecording" ||
      method === "stopRecording" ||
      (method === "screenshot" && (args[1] as { save?: boolean } | undefined)?.save)
    ) {
      throw new DeviceBackendError(
        "Saving captures on an SSH device host is not supported. Capture a screenshot without save, or record on the Mac.",
      );
    }
    return (await this.request(method, args)) as DeviceResult<K>;
  }

  geometry(udid: string): DeviceGeometry | null {
    return this.geometries.get(udid) ?? null;
  }
  async attachStream(udid: string, listener: DeviceFrameListener): Promise<void> {
    const stream = { listener, id: this.nextId + 1 };
    this.streams.set(udid, stream);
    try {
      const result = (await this.request("attachStream", [udid])) as DeviceGeometry | null;
      if (this.streams.get(udid) !== stream)
        throw new DeviceBackendError("Stale stream attachment");
      if (result) this.geometries.set(udid, result);
    } catch (error) {
      if (this.streams.get(udid) === stream) this.streams.delete(udid);
      throw error;
    }
  }
  override async detachStream(udid: string): Promise<void> {
    this.streams.delete(udid);
    this.geometries.delete(udid);
    if (this.ready) await this.request("detachStream", [udid]);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.child) this.disconnect(this.child);
    this.disconnectListeners.clear();
  }
}
