/**
 * A loopback stand-in for scrcpy-server behind `adb forward`, for tests: it
 * refuses the first connections the way a forward tunnel does before the
 * server listens, then serves video and control sockets in scrcpy's order.
 *
 * @module device/android/scrcpyTestServer
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";

import { SCRCPY_CODEC_H264 } from "./scrcpyProtocol.ts";

export function mediaPacket(options: {
  readonly config?: boolean;
  readonly key?: boolean;
  readonly pts: bigint;
  readonly data: readonly number[];
}): Buffer {
  const header = Buffer.alloc(12);
  let high = options.pts;
  if (options.config) high |= 1n << 62n;
  if (options.key) high |= 1n << 61n;
  header.writeBigUInt64BE(high, 0);
  header.writeUInt32BE(options.data.length, 8);
  return Buffer.concat([header, Buffer.from(options.data)]);
}

export function sessionPacket(width: number, height: number): Buffer {
  const packet = Buffer.alloc(12);
  packet.writeUInt32BE(0x8000_0000, 0);
  packet.writeUInt32BE(width, 4);
  packet.writeUInt32BE(height, 8);
  return packet;
}

export interface FakeScrcpyServer {
  readonly port: number;
  /** Bytes received on the control socket, concatenated. */
  readonly control: () => Buffer;
  /** Write more video bytes to the open video socket. */
  readonly sendVideo: (bytes: Buffer) => void;
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}

export async function startFakeScrcpyServer(options: {
  readonly video: boolean;
  readonly refuseFirst?: number;
  readonly initialVideo?: Buffer;
}): Promise<FakeScrcpyServer> {
  let accepted = 0;
  let refused = 0;
  let video: net.Socket | null = null;
  let controlBytes = Buffer.alloc(0);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (refused < (options.refuseFirst ?? 0)) {
      refused += 1;
      socket.destroy();
      return;
    }
    accepted += 1;
    const isVideo = options.video && accepted === 1;
    const isFirst = accepted === 1;
    if (isFirst) socket.write(Buffer.from([0]));
    if (isVideo) {
      video = socket;
      const codec = Buffer.alloc(4);
      codec.writeUInt32BE(SCRCPY_CODEC_H264);
      socket.write(Buffer.concat([codec, options.initialVideo ?? Buffer.alloc(0)]));
      return;
    }
    let parsed = 0;
    socket.on("data", (chunk: Buffer) => {
      controlBytes = Buffer.concat([controlBytes, chunk]);
      // Walk whole messages; acknowledge SET_CLIPBOARD (type 9) with its sequence.
      while (parsed < controlBytes.byteLength) {
        const type = controlBytes[parsed]!;
        const rest = controlBytes.byteLength - parsed;
        const size =
          type === 2
            ? 32
            : type === 0
              ? 14
              : type === 1
                ? rest >= 5
                  ? 5 + controlBytes.readUInt32BE(parsed + 1)
                  : Infinity
                : type === 9
                  ? rest >= 14
                    ? 14 + controlBytes.readUInt32BE(parsed + 10)
                    : Infinity
                  : 1;
        if (rest < size) break;
        if (type === 9) {
          const ack = Buffer.alloc(9);
          ack[0] = 1;
          controlBytes.copy(ack, 1, parsed + 1, parsed + 9);
          socket.write(ack);
        }
        parsed += size;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    control: () => controlBytes,
    sendVideo: (bytes) => video?.write(bytes),
    connections: () => accepted,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A child process that only exits when killed. */
export function fakeChild(): ChildProcess & { readonly killed: boolean } {
  const child = new EventEmitter() as ChildProcess & { killed: boolean };
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.killed) return true;
      Object.assign(child, { killed: true, signalCode: signal });
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    },
  });
  return child;
}
