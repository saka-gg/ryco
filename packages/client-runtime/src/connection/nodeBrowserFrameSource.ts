import {
  decodeNodeBrowserFrame,
  NODE_BROWSER_FRAME_ACK,
  NODE_BROWSER_FRAME_CLOSE,
  NODE_BROWSER_FRAME_PARAMS,
  NODE_BROWSER_FRAME_WS_PATH,
  type NodeBrowserFrame,
} from "@ryco/shared/nodeBrowserFrame";

import type { SocketService } from "../platform/index.ts";
import type { DeviceFrameWebSocket } from "./deviceFrameSource.ts";

export const NODE_BROWSER_FRAME_RECONNECT_BASE_MS = 500;
export const NODE_BROWSER_FRAME_RECONNECT_MAX_MS = 5_000;
/** Sockets refused before they opened (an upgrade the node turned down) before the source stops. */
export const NODE_BROWSER_FRAME_MAX_REFUSALS = 3;

export interface NodeBrowserFrameRequest {
  readonly tabId: string;
  /** The largest frame wanted, in device pixels. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality?: number;
}

/**
 * Why a source stopped for good: the tab is gone, the session may not watch
 * node tabs, the browser cannot run on the node, or the node kept refusing
 * the socket.
 */
export type NodeBrowserFrameStop =
  | { readonly reason: "gone" }
  | { readonly reason: "forbidden" }
  | { readonly reason: "unavailable"; readonly detail: string }
  | { readonly reason: "refused" };

export interface NodeBrowserFrameSourceHandlers {
  readonly onFrame: (frame: NodeBrowserFrame, generation: number) => void;
  /** The socket dropped; `retryInMs` until the next attempt. */
  readonly onReset?: (detail: { readonly generation: number; readonly retryInMs: number }) => void;
  readonly onStop: (stop: NodeBrowserFrameStop) => void;
}

export interface NodeBrowserFrameSource {
  readonly close: () => void;
}

export function nodeBrowserFrameSocketUrl(
  rawUrl: string,
  request: NodeBrowserFrameRequest,
): string {
  const url = new URL(rawUrl);
  url.pathname = NODE_BROWSER_FRAME_WS_PATH;
  url.searchParams.set(NODE_BROWSER_FRAME_PARAMS.tab, request.tabId);
  url.searchParams.set(NODE_BROWSER_FRAME_PARAMS.maxWidth, String(Math.round(request.maxWidth)));
  url.searchParams.set(NODE_BROWSER_FRAME_PARAMS.maxHeight, String(Math.round(request.maxHeight)));
  if (request.quality !== undefined) {
    url.searchParams.set(NODE_BROWSER_FRAME_PARAMS.quality, String(Math.round(request.quality)));
  }
  return url.toString();
}

const frameBytes = (data: unknown): Uint8Array | null =>
  data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : null;

/**
 * Live frames of one node browser tab over its own socket, supervised apart
 * from the RPC connection like device frames (`deviceFrameSource.ts`): each
 * connect resolves a fresh URL (a new socket token) and owns a generation, so
 * a late event from an older socket does nothing. Every frame is acknowledged
 * as it arrives, before it is decoded or painted; the node sends the next one
 * only after that.
 */
export function createNodeBrowserFrameSource(options: {
  readonly request: NodeBrowserFrameRequest;
  readonly resolveUrl: () => Promise<string>;
  readonly socket: SocketService;
  readonly handlers: NodeBrowserFrameSourceHandlers;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}): NodeBrowserFrameSource {
  const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const unschedule =
    options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let closed = false;
  let generation = 0;
  let attempt = 0;
  let refusals = 0;
  let timer: unknown | null = null;
  let current: DeviceFrameWebSocket | null = null;

  const stop = (reason: NodeBrowserFrameStop) => {
    if (closed) return;
    close();
    options.handlers.onStop(reason);
  };

  const retry = (socketGeneration: number, delayMs?: number) => {
    const retryInMs =
      delayMs ??
      Math.min(
        NODE_BROWSER_FRAME_RECONNECT_MAX_MS,
        NODE_BROWSER_FRAME_RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10),
      );
    attempt += 1;
    options.handlers.onReset?.({ generation: socketGeneration, retryInMs });
    timer = schedule(() => {
      timer = null;
      void connect();
    }, retryInMs);
  };

  const connect = async () => {
    if (closed) return;
    const socketGeneration = ++generation;
    let rawUrl: string;
    try {
      rawUrl = await options.resolveUrl();
    } catch {
      if (!closed && socketGeneration === generation) retry(socketGeneration);
      return;
    }
    if (closed || socketGeneration !== generation) return;
    const socket = options.socket.webSocketConstructor(
      nodeBrowserFrameSocketUrl(rawUrl, options.request),
    ) as DeviceFrameWebSocket;
    current = socket;
    socket.binaryType = "arraybuffer";
    let opened = false;
    let ended = false;
    const live = () => !closed && !ended && socketGeneration === generation;
    socket.addEventListener("open", (() => {
      if (!live()) return;
      opened = true;
      attempt = 0;
      refusals = 0;
    }) as (event: never) => void);
    socket.addEventListener("message", ((event: { readonly data: unknown }) => {
      if (!live()) return;
      const bytes = frameBytes(event.data);
      if (!bytes) return;
      try {
        socket.send(NODE_BROWSER_FRAME_ACK);
      } catch {
        return;
      }
      const decoded = decodeNodeBrowserFrame(bytes);
      if (decoded.ok) options.handlers.onFrame(decoded.frame, socketGeneration);
    }) as (event: never) => void);
    const end = (event: { readonly code?: number; readonly reason?: string } | undefined) => {
      if (!live()) return;
      ended = true;
      if (current === socket) current = null;
      switch (event?.code) {
        case NODE_BROWSER_FRAME_CLOSE.tabGone:
          return stop({ reason: "gone" });
        case NODE_BROWSER_FRAME_CLOSE.forbidden:
          return stop({ reason: "forbidden" });
        case NODE_BROWSER_FRAME_CLOSE.unavailable:
          return stop({ reason: "unavailable", detail: event.reason ?? "" });
        case NODE_BROWSER_FRAME_CLOSE.restarted:
          // The browser restarted or the tab was suspended: its page comes back on reconnect.
          attempt = 0;
          return retry(socketGeneration, NODE_BROWSER_FRAME_RECONNECT_BASE_MS);
      }
      // A refused upgrade never opens; a fresh token is tried a few times only.
      if (!opened && ++refusals >= NODE_BROWSER_FRAME_MAX_REFUSALS)
        return stop({ reason: "refused" });
      retry(socketGeneration);
    };
    socket.addEventListener("close", ((event: {
      readonly code?: number;
      readonly reason?: string;
    }) => end(event)) as (event: never) => void);
    socket.addEventListener("error", (() => end(undefined)) as (event: never) => void);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    generation += 1;
    if (timer !== null) unschedule(timer);
    timer = null;
    const socket = current;
    current = null;
    try {
      socket?.close();
    } catch {
      // Some adapters throw when a socket is closed before its open event.
    }
  };

  void connect();
  return { close };
}
