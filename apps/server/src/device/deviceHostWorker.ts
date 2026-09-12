import type { Readable, Writable } from "node:stream";
import { createServer } from "node:net";
import { homedir } from "node:os";
import * as path from "node:path";
import { Schema } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import { localDeviceHost } from "./localDeviceHost.ts";
import { HostDeviceBackend } from "./HostDeviceBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";
import { makeBootOwnershipStore } from "./bootOwnership.ts";
import { DeviceBackendError, type DeviceBackend } from "./DeviceBackend.ts";
import {
  DEVICE_HOST_PROTOCOL,
  DeviceHostRequest,
  decodeDeviceHostValue,
  deviceHostOperations,
  isDeviceHostOperation,
} from "./deviceHostProtocol.ts";

/**
 * SSH is the authentication boundary. No HTTP/RPC listener, provider sessions or
 * browser credentials are started here. One coding node owns a Mac host at a time.
 * A loopback port is only an OS-owned lock (connections receive no data).
 */
export async function runDeviceHostWorker(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Device host requires macOS");
  const lock = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    lock.once("error", reject);
    lock.listen({ host: "127.0.0.1", port: 49177, exclusive: true }, resolve);
  });
  const backend = new HostDeviceBackend([localDeviceHost()]);
  const manager = new DeviceManager({
    backend,
    bootOwnership: makeBootOwnershipStore(
      path.join(
        process.env.RYCO_HOME?.trim() || path.join(homedir(), ".ryco"),
        "device-host",
        "boot-ownership.json",
      ),
    ),
  });
  const session = await startDeviceHostSession(
    backend,
    process.stdin,
    process.stdout,
    manager,
  ).catch(async (error: unknown) => {
    await manager.dispose();
    lock.close();
    throw error;
  });
  const stop = () => {
    void session.close().finally(() => lock.close());
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  void session.done.finally(() => lock.close());
}

/** Testable stdio lifecycle; EOF, timeout and protocol failure share one cleanup path. */
export async function startDeviceHostSession(
  backend: DeviceBackend,
  input: Readable,
  output: Writable,
  manager = new DeviceManager({ backend }),
): Promise<{ close: () => Promise<void>; done: Promise<void> }> {
  let closed = false;
  let queue = Promise.resolve();
  let queued = 0;
  let lastInput = Date.now();
  let buffer = "";
  const send = (value: unknown) => {
    if (!closed) output.write(JSON.stringify(value) + "\n");
  };
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = (): Promise<void> => {
    if (closed) return done;
    closed = true;
    clearInterval(heartbeat);
    input.pause();
    // Finish any boot already executing, then let shared boot policy clean it up.
    void queue.finally(async () => {
      await manager.dispose();
      input.destroy();
      finish();
    });
    return done;
  };
  const heartbeat = setInterval(() => {
    if (Date.now() - lastInput > 60_000) close();
  }, 10_000);
  input.setEncoding("utf8");
  input.on("end", close);
  input.on("error", close);
  output.on("error", close);
  try {
    await manager.reclaimOrphanedBoots();
    send({ type: "ready", protocol: DEVICE_HOST_PROTOCOL, version: packageJson.version });
  } catch (error) {
    close();
    throw error;
  }
  input.on("data", (chunk: string) => {
    if (closed) return;
    lastInput = Date.now();
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 64 * 1024) {
      close();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const raw: unknown = JSON.parse(line);
        if (raw && typeof raw === "object" && "type" in raw && raw.type === "ping") {
          send({ type: "pong" });
          continue;
        }
        const request = Schema.decodeUnknownSync(DeviceHostRequest)(raw);
        if (!isDeviceHostOperation(request.method)) throw new Error("method");
        const method = request.method;
        const args = decodeDeviceHostValue(
          deviceHostOperations[method].input,
          request.args.map((v) => (v === null ? undefined : v)),
        ) as unknown[];
        if (++queued > 32) {
          close();
          return;
        }
        queue = queue.then(async () => {
          if (closed) return;
          try {
            let result: unknown;
            const udid = args[0] as string;
            if (method === "boot") {
              const boot = await manager.boot(udid);
              if (boot.kind !== "booted")
                throw new DeviceBackendError("Remote host boot limit reached");
              result = boot.device;
            } else if (method === "shutdown") {
              await manager.shutdown(udid);
            } else if (method === "attachStream") {
              let awaitingKeyframe = false;
              await backend.attachStream(udid, (frame) => {
                // Bound the SSH pipe queue and never send dependent frames after a drop.
                if (!frame.codecConfig && output.writableLength > 4 * 1024 * 1024) {
                  awaitingKeyframe = true;
                  return;
                }
                if (awaitingKeyframe && !frame.codecConfig && !frame.keyframe) return;
                if (frame.keyframe) awaitingKeyframe = false;
                send({
                  type: "frame",
                  udid,
                  streamId: request.id,
                  ...frame,
                  data: Buffer.from(frame.data).toString("base64"),
                });
              });
              result = backend.geometry(udid);
            } else {
              const fn = backend[method] as (...args: unknown[]) => Promise<unknown>;
              result = await fn.apply(backend, args);
            }
            send({ id: request.id, result: result ?? null });
          } catch (error) {
            send({
              id: request.id,
              error:
                error instanceof Error ? error.message.slice(0, 2048) : "Device operation failed",
              retryable: error instanceof DeviceBackendError && error.retryable,
            });
          } finally {
            queued -= 1;
          }
        });
      } catch {
        close();
        return;
      }
    }
  });
  return { close, done };
}
