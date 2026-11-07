import type { DeviceUdid } from "@ryco/contracts";
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  decodeDeviceFrame,
  type DeviceFrame,
} from "@ryco/shared/deviceFrame";

import type { SocketService } from "../platform/index.ts";

export const DEVICE_FRAME_RECONNECT_BASE_MS = 500;
export const DEVICE_FRAME_RECONNECT_MAX_MS = 5_000;
export const DEVICE_FRAME_RESYNC_COOLDOWN_MS = 1_000;

/**
 * `unavailable` is terminal: this connection cannot carry the stream at all (a
 * hosted relay channel without the frame tunnel), so the source stops and the
 * viewer falls back to screenshots.
 */
export type DeviceFrameSourceResetReason = "closed" | "error" | "decode-failed" | "unavailable";

/**
 * Thrown by a socket constructor that can never open on this connection; the
 * source reports `unavailable` and stops instead of retrying.
 */
export class DeviceFrameSourceUnavailableError extends Error {
  constructor(message = "This connection cannot stream device frames.") {
    super(message);
    this.name = "DeviceFrameSourceUnavailableError";
  }
}

export interface DeviceFrameSourceHandlers {
  readonly onFrame: (frame: DeviceFrame, generation: number) => void;
  readonly onReset: (
    reason: DeviceFrameSourceResetReason,
    detail: { readonly generation: number; readonly retryInMs: number | null },
  ) => void;
  /**
   * A text message from the server on the current socket. Video is binary;
   * text carries the live input protocol (`@ryco/shared/deviceLiveInput`),
   * which the pane decodes, so the protocol stays out of this boot-time module.
   */
  readonly onText?: (text: string, generation: number) => void;
}

export interface DeviceFrameSource {
  readonly requestResync: () => boolean;
  /**
   * Send one text message (live input) in order with the ones before it, on
   * the current socket. False when no socket is open, in which case nothing
   * was sent. Whether the server accepts input is the caller's to track.
   */
  readonly sendText: (text: string) => boolean;
  readonly close: () => void;
}

export interface DeviceFrameWebSocket {
  binaryType: string;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    type: "message" | "close" | "error" | "open",
    listener: (event: never) => void,
    options?: unknown,
  ) => void;
}

export function deviceFrameSocketUrl(rawUrl: string, udid: DeviceUdid): string {
  const url = new URL(rawUrl);
  url.pathname = DEVICE_FRAME_WS_PATH;
  url.searchParams.set(DEVICE_FRAME_WS_UDID_PARAM, udid);
  return url.toString();
}

function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * Supervise a lossy frame socket independently from the authoritative RPC
 * connection. Each reconnect owns a generation; listeners from older sockets
 * are inert even when a platform delivers their close/message events late.
 */
export function createDeviceFrameSource(options: {
  readonly udid: DeviceUdid;
  readonly resolveUrl: () => Promise<string>;
  readonly socket: SocketService;
  readonly handlers: DeviceFrameSourceHandlers;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly resyncCooldownMs?: number;
}): DeviceFrameSource {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const unschedule =
    options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const reconnectBaseMs = options.reconnectBaseMs ?? DEVICE_FRAME_RECONNECT_BASE_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? DEVICE_FRAME_RECONNECT_MAX_MS;
  const resyncCooldownMs = options.resyncCooldownMs ?? DEVICE_FRAME_RESYNC_COOLDOWN_MS;

  let closed = false;
  let generation = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown | null = null;
  let currentSocket: DeviceFrameWebSocket | null = null;
  let socketOpen = false;
  let lastResyncAt: number | null = null;
  let resyncPending = false;

  const sendResync = (): boolean => {
    if (closed || !socketOpen || !currentSocket) return false;
    try {
      currentSocket.send(JSON.stringify({ type: DEVICE_FRAME_RESYNC_MESSAGE }));
      return true;
    } catch {
      return false;
    }
  };

  const connect = async () => {
    if (closed) return;
    const socketGeneration = generation + 1;
    generation = socketGeneration;
    let socketEnded = false;
    try {
      const rawUrl = await options.resolveUrl();
      if (closed || socketGeneration !== generation) return;
      const socket = options.socket.webSocketConstructor(
        deviceFrameSocketUrl(rawUrl, options.udid),
      ) as DeviceFrameWebSocket;
      currentSocket = socket;
      socket.binaryType = "arraybuffer";

      const end = (reason: "closed" | "error") => {
        if (closed || socketEnded || socketGeneration !== generation) return;
        socketEnded = true;
        socketOpen = false;
        if (currentSocket === socket) currentSocket = null;
        const retryInMs = Math.min(
          reconnectMaxMs,
          reconnectBaseMs * 2 ** Math.min(reconnectAttempt, 10),
        );
        reconnectAttempt += 1;
        options.handlers.onReset(reason, { generation: socketGeneration, retryInMs });
        reconnectTimer = schedule(() => {
          reconnectTimer = null;
          void connect();
        }, retryInMs);
      };

      socket.addEventListener("open", (() => {
        if (closed || socketGeneration !== generation) return;
        socketOpen = true;
        reconnectAttempt = 0;
        if (resyncPending) {
          resyncPending = false;
          sendResync();
        }
      }) as (event: never) => void);
      socket.addEventListener("message", ((event: { data: unknown }) => {
        if (closed || socketGeneration !== generation) return;
        if (typeof event.data === "string") {
          options.handlers.onText?.(event.data, socketGeneration);
          return;
        }
        const bytes = frameBytes(event.data);
        if (!bytes) return;
        const result = decodeDeviceFrame(bytes);
        if (!result.ok) {
          options.handlers.onReset("decode-failed", {
            generation: socketGeneration,
            retryInMs: null,
          });
          return;
        }
        options.handlers.onFrame(result.frame, socketGeneration);
      }) as (event: never) => void);
      socket.addEventListener("close", (() => end("closed")) as (event: never) => void);
      socket.addEventListener("error", (() => end("error")) as (event: never) => void);
    } catch (error) {
      if (closed || socketGeneration !== generation) return;
      if (error instanceof DeviceFrameSourceUnavailableError) {
        options.handlers.onReset("unavailable", { generation: socketGeneration, retryInMs: null });
        return;
      }
      const retryInMs = Math.min(
        reconnectMaxMs,
        reconnectBaseMs * 2 ** Math.min(reconnectAttempt, 10),
      );
      reconnectAttempt += 1;
      options.handlers.onReset("error", { generation: socketGeneration, retryInMs });
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        void connect();
      }, retryInMs);
    }
  };

  void connect();

  return {
    requestResync: () => {
      if (closed) return false;
      const at = now();
      if (lastResyncAt !== null && at - lastResyncAt < resyncCooldownMs) return false;
      lastResyncAt = at;
      if (!socketOpen) {
        resyncPending = true;
        return false;
      }
      return sendResync();
    },
    sendText: (text) => {
      if (closed || !socketOpen || !currentSocket) return false;
      try {
        currentSocket.send(text);
        return true;
      } catch {
        return false;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      generation += 1;
      resyncPending = false;
      if (reconnectTimer !== null) unschedule(reconnectTimer);
      reconnectTimer = null;
      const socket = currentSocket;
      currentSocket = null;
      socketOpen = false;
      try {
        socket?.close();
      } catch {
        // Some adapters throw when a socket is closed before its open event.
      }
    },
  };
}
