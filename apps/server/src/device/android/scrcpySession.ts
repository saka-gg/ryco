/**
 * One running scrcpy-server on one emulator: the adb forward tunnel, the
 * server process and its sockets.
 *
 * Ryco runs up to two per device, with independent lifetimes:
 *
 * - a control session (no video) for input. It lives while the device is in
 *   use, whether or not anyone watches, and takes display pixels directly;
 * - a video session while a pane watches the stream. Its control socket is
 *   only used to ask for a fresh keyframe (`RESET_VIDEO`).
 *
 * The tunnel is a forward (`tcp:0` on loopback to the server's abstract
 * socket), so the host never listens on a port the device connects to.
 *
 * @module device/android/scrcpySession
 */
import type { ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import * as net from "node:net";

import {
  encodeEmpty,
  encodeSetClipboard,
  ScrcpyControlType,
  ScrcpyDeviceMessageParser,
  ScrcpyVideoParser,
  type ScrcpyVideoEvent,
} from "./scrcpyProtocol.ts";
import { SCRCPY_DEVICE_PATH, SCRCPY_SERVER_VERSION } from "./scrcpyServer.ts";

export interface ScrcpyVideoOptions {
  /** Longest side of the encoded video in pixels; 0 keeps the display size. */
  readonly maxSize: number;
  readonly maxFps: number;
  readonly bitRate: number;
}

/**
 * Measured on an API 34 emulator (Apple M5 Max, scrcpy 5.0.1) while dragging
 * a list: full size (1080x2280) peaked at 26 fps, 1600 at 42-58 fps and 1280
 * at 46. 1600 keeps text sharp in a pane up to ~750 CSS px tall at 2x.
 */
export const SCRCPY_DEFAULT_VIDEO: ScrcpyVideoOptions = {
  maxSize: 1600,
  maxFps: 60,
  bitRate: 8_000_000,
};

export interface ScrcpyHost {
  /** adb with arguments; resolves stdout. */
  readonly adb: (args: readonly string[], timeoutMs?: number) => Promise<Buffer>;
  /** A long-lived `adb … shell <command>`; stdout and stderr are read for diagnostics. */
  readonly spawnAdb: (args: readonly string[]) => ChildProcess;
  readonly connect?: (port: number) => net.Socket;
  readonly delay?: (ms: number) => Promise<void>;
}

export interface ScrcpySessionOptions {
  readonly transportId: string;
  readonly video: ScrcpyVideoOptions | null;
  readonly onVideo?: (event: ScrcpyVideoEvent) => void;
  /** Once, when the session ends for any reason other than `close()`. */
  readonly onEnded?: (reason: string) => void;
  /** How long to wait for the server to accept its first socket. */
  readonly connectTimeoutMs?: number;
}

export class ScrcpySessionError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ScrcpySessionError";
  }
}

const CLIPBOARD_ACK_TIMEOUT_MS = 3_000;

function serverArguments(scid: string, video: ScrcpyVideoOptions | null): string {
  const options = [
    `scid=${scid}`,
    "log_level=warn",
    "tunnel_forward=true",
    "audio=false",
    `video=${video !== null}`,
    "control=true",
    // Nothing to restore: Ryco changes no show_touches/stay_awake settings.
    "cleanup=false",
    "clipboard_autosync=false",
    "send_device_meta=false",
    "send_dummy_byte=true",
    "send_frame_meta=true",
    "send_stream_meta=true",
    ...(video
      ? [
          "video_codec=h264",
          `max_size=${video.maxSize}`,
          `max_fps=${video.maxFps}`,
          `video_bit_rate=${video.bitRate}`,
        ]
      : []),
  ];
  return `CLASSPATH=${SCRCPY_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION} ${options.join(" ")}`;
}

export class ScrcpySession {
  private ended = false;
  private closing = false;
  private readonly acks = new Map<bigint, () => void>();
  private nextSequence = 1n;
  private readonly diagnostics: string[] = [];

  private readonly host: ScrcpyHost;
  private readonly options: ScrcpySessionOptions;
  private readonly port: number;
  private readonly process: ChildProcess;
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;

  private constructor(
    host: ScrcpyHost,
    options: ScrcpySessionOptions,
    port: number,
    child: ChildProcess,
  ) {
    this.host = host;
    this.options = options;
    this.port = port;
    this.process = child;
  }

  /** Push nothing: the caller has already put the jar on the device. */
  static async start(host: ScrcpyHost, options: ScrcpySessionOptions): Promise<ScrcpySession> {
    const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, "0");
    const forwarded = (
      await host.adb([
        "-t",
        options.transportId,
        "forward",
        "tcp:0",
        `localabstract:scrcpy_${scid}`,
      ])
    )
      .toString()
      .trim();
    const port = Number(forwarded);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535)
      throw new ScrcpySessionError(`adb forward returned no port (${forwarded.slice(0, 100)}).`);
    const child = host.spawnAdb([
      "-t",
      options.transportId,
      "shell",
      serverArguments(scid, options.video),
    ]);
    const session = new ScrcpySession(host, options, port, child);
    try {
      await session.open();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get isOpen(): boolean {
    return !this.ended && !this.closing;
  }

  /** The server's recent warnings and errors, for failure messages. */
  get serverOutput(): string {
    return this.diagnostics.join("\n").slice(-1_000);
  }

  private async open(): Promise<void> {
    const status: { exited: string | null } = { exited: null };
    const record = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
        if (!line.trim()) continue;
        this.diagnostics.push(line.trim().slice(0, 300));
        if (this.diagnostics.length > 20) this.diagnostics.shift();
      }
    };
    this.process.stdout?.on("data", record);
    this.process.stderr?.on("data", record);
    this.process.once("exit", (code, signal) => {
      status.exited = `scrcpy-server exited (${signal ?? code})`;
      this.end(status.exited);
    });
    this.process.once("error", (error) => {
      status.exited = `scrcpy-server could not start: ${error.message}`;
      this.end(status.exited);
    });

    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 10_000);
    const delay =
      this.host.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // The first socket gets the dummy byte. A forward tunnel accepts before
    // the server listens and closes at once, so only that byte proves it.
    let first: { socket: net.Socket; rest: Buffer } | null = null;
    while (first === null) {
      if (status.exited !== null || this.closing)
        throw new ScrcpySessionError(
          `${status.exited ?? "scrcpy session closed"}${this.serverOutput ? `: ${this.serverOutput}` : ""}`,
        );
      if (Date.now() > deadline)
        throw new ScrcpySessionError(
          `scrcpy-server did not accept a connection${this.serverOutput ? `: ${this.serverOutput}` : ""}`,
        );
      first = await this.tryFirstSocket();
      if (first === null) await delay(100);
    }
    let control: net.Socket;
    let controlRest: Buffer = Buffer.alloc(0);
    if (this.options.video) {
      this.videoSocket = first.socket;
      control = await this.connectSocket();
      this.watchVideo(first.socket, first.rest);
    } else {
      control = first.socket;
      controlRest = first.rest;
    }
    this.controlSocket = control;
    const parser = new ScrcpyDeviceMessageParser();
    const handle = (chunk: Buffer) => {
      try {
        for (const message of parser.push(chunk)) {
          if (message.kind === "ack-clipboard") {
            this.acks.get(message.sequence)?.();
            this.acks.delete(message.sequence);
          }
        }
      } catch (error) {
        this.end(error instanceof Error ? error.message : String(error));
      }
    };
    control.on("data", handle);
    control.on("close", () => this.end("scrcpy control socket closed"));
    control.on("error", () => undefined);
    control.setNoDelay(true);
    if (controlRest.byteLength > 0) handle(controlRest);
    control.resume();
  }

  private connectSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.host.connect?.(this.port) ?? net.connect(this.port, "127.0.0.1");
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });
  }

  private tryFirstSocket(): Promise<{ socket: net.Socket; rest: Buffer } | null> {
    return new Promise((resolve) => {
      const socket = this.host.connect?.(this.port) ?? net.connect(this.port, "127.0.0.1");
      const settle = (value: { socket: net.Socket; rest: Buffer } | null) => {
        socket.removeAllListeners("data");
        socket.removeAllListeners("end");
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
        if (value === null) socket.destroy();
        else socket.pause();
        resolve(value);
      };
      socket.once("data", (chunk: Buffer) => settle({ socket, rest: chunk.subarray(1) }));
      socket.once("end", () => settle(null));
      socket.once("close", () => settle(null));
      socket.once("error", () => settle(null));
    });
  }

  private watchVideo(socket: net.Socket, rest: Buffer): void {
    // The dummy byte is already consumed.
    const parser = new ScrcpyVideoParser({ dummyByte: false });
    const handle = (chunk: Buffer) => {
      if (this.ended) return;
      try {
        for (const event of parser.push(chunk)) this.options.onVideo?.(event);
      } catch (error) {
        this.end(error instanceof Error ? error.message : String(error));
      }
    };
    socket.on("data", handle);
    socket.on("close", () => this.end("scrcpy video socket closed"));
    socket.on("error", () => undefined);
    if (rest.byteLength > 0) handle(rest);
    socket.resume();
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const resolve of this.acks.values()) resolve();
    this.acks.clear();
    if (!this.closing) this.options.onEnded?.(reason);
    void this.teardown();
  }

  /** Write one control message. Throws once the session has ended. */
  send(bytes: Uint8Array): void {
    const socket = this.controlSocket;
    if (!socket || !this.isOpen || socket.destroyed)
      throw new ScrcpySessionError("The Android input channel closed.");
    socket.write(bytes);
  }

  /** Set the clipboard (and paste it); resolves once the device acknowledges. */
  setClipboard(text: string, paste: boolean): Promise<void> {
    const sequence = this.nextSequence++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(sequence);
        reject(new ScrcpySessionError("The emulator did not confirm the clipboard."));
      }, CLIPBOARD_ACK_TIMEOUT_MS);
      timer.unref?.();
      this.acks.set(sequence, () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.send(encodeSetClipboard(text, paste, sequence));
      } catch (error) {
        clearTimeout(timer);
        this.acks.delete(sequence);
        reject(error);
      }
    });
  }

  /** Ask the encoder for new parameter sets and a keyframe. */
  resetVideo(): void {
    this.send(encodeEmpty(ScrcpyControlType.resetVideo));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.end("closed");
    await this.teardown();
  }

  private tornDown: Promise<void> | null = null;
  private teardown(): Promise<void> {
    this.tornDown ??= (async () => {
      // Closing the sockets ends the server on the device; the adb client
      // process only relays its output.
      this.videoSocket?.destroy();
      this.controlSocket?.destroy();
      if (this.process.exitCode === null && this.process.signalCode === null)
        this.process.kill("SIGTERM");
      await this.host
        .adb(["-t", this.options.transportId, "forward", "--remove", `tcp:${this.port}`], 5_000)
        .catch(() => undefined);
    })();
    return this.tornDown;
  }
}
