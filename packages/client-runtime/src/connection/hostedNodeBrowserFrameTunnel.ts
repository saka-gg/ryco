import { NODE_BROWSER_FRAME_CLOSE } from "@ryco/shared/nodeBrowserFrame";
import {
  isRelayFrameTunnelNodeBrowserTabId,
  RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
} from "@ryco/shared/relayFrameTunnel";

import type { RelayFrameTunnelSocket } from "../relay/relayFrameTunnel.ts";
import type { DeviceFrameWebSocket } from "./deviceFrameSource.ts";
import { HOSTED_FRAME_TUNNEL_URL, hostedFrameTunnelFor } from "./hostedFrameTunnel.ts";
import type { HostedNodeBrowserFrameSourceOptions } from "./hostedNodeBrowserFrameSource.ts";
import {
  createNodeBrowserFrameSource,
  type NodeBrowserFrameRequest,
  type NodeBrowserFrameSource,
  type NodeBrowserFrameSourceHandlers,
} from "./nodeBrowserFrameSource.ts";

type Listener = (event: never) => void;

/**
 * A socket that never opens and closes on the next microtask with `code`. The
 * frame source's connect does not survive a throwing constructor, so every
 * failure to open a stream reads as a close it already handles.
 */
function closedSocket(code: number, reason: string): DeviceFrameWebSocket {
  const listeners = new Set<Listener>();
  void Promise.resolve().then(() => {
    for (const listener of listeners) {
      (listener as (event: unknown) => void)({ type: "close", code, reason, wasClean: false });
    }
    listeners.clear();
  });
  return {
    binaryType: "arraybuffer",
    send: () => {
      throw new Error("The browser tab stream is closed.");
    },
    close: () => listeners.clear(),
    addEventListener: (type, listener) => {
      if (type === "close") listeners.add(listener);
    },
  };
}

/**
 * Frames of a handed-off desktop tab (`handoff-<32 hex>`) over the hosted
 * relay: the direct path's node browser frame source, supervised the same way
 * (generations, backoff, stops), with each socket a stream of the current
 * relay channel's frame tunnel, shared with the connection's device streams.
 * A socket opens only while the session is ready — a current attempt that
 * accepted a current snapshot — and closes the moment it stops being.
 *
 * Only hand-off tabs ride the tunnel; any other tab id stops at once as
 * `unavailable`, and the node refuses it too. The tunnel's open names only the
 * tab: the node picks the frame size.
 */
export function openHostedNodeBrowserFrameSource(
  request: NodeBrowserFrameRequest,
  handlers: NodeBrowserFrameSourceHandlers,
  options: HostedNodeBrowserFrameSourceOptions,
): NodeBrowserFrameSource {
  if (!isRelayFrameTunnelNodeBrowserTabId(request.tabId)) {
    let closed = false;
    void Promise.resolve().then(() => {
      if (!closed) {
        handlers.onStop({
          reason: "unavailable",
          detail: "Only handed-off tabs stream through the relay.",
        });
      }
    });
    return {
      close: () => {
        closed = true;
      },
    };
  }
  let current: RelayFrameTunnelSocket | null = null;
  const source = createNodeBrowserFrameSource({
    request,
    handlers,
    resolveUrl: async () => {
      if (!options.readiness.read() || options.channel() === null) {
        throw new Error("The hosted session is not ready.");
      }
      return HOSTED_FRAME_TUNNEL_URL;
    },
    socket: {
      webSocketConstructor: () => {
        const channel = options.readiness.read() ? options.channel() : null;
        // Readiness changed since the URL resolved: try again soon, uncounted.
        if (channel === null) return closedSocket(NODE_BROWSER_FRAME_CLOSE.restarted, "");
        const tunnel = hostedFrameTunnelFor(channel);
        // A ready session's channel is locked: one that will not bind is a
        // `legacy` channel, which never carries the tunnel.
        if (tunnel === null) {
          return closedSocket(
            NODE_BROWSER_FRAME_CLOSE.unavailable,
            "This relay channel uses the legacy format, so it cannot carry the tab.",
          );
        }
        try {
          current = tunnel.openSocket({
            target: RELAY_FRAME_TUNNEL_NODE_BROWSER_FRAMES,
            tabId: request.tabId,
            maxWidth: Math.round(request.maxWidth),
            maxHeight: Math.round(request.maxHeight),
            ...(request.quality === undefined ? {} : { quality: request.quality }),
          });
        } catch {
          // Too many streams on this channel: a refusal, retried with backoff.
          return closedSocket(NODE_BROWSER_FRAME_CLOSE.capacity, "");
        }
        return current;
      },
    },
  });
  const unsubscribe = options.readiness.subscribe(() => {
    if (options.readiness.read()) return;
    const socket = current;
    current = null;
    socket?.close();
  });
  return {
    close: () => {
      unsubscribe();
      current = null;
      source.close();
    },
  };
}
