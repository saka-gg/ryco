import { DeviceUdid } from "@ryco/contracts";
import { encodeNodeBrowserFrame, NODE_BROWSER_FRAME_ACK } from "@ryco/shared/nodeBrowserFrame";
import {
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelBinary,
  encodeRelayFrameTunnelClose,
  RELAY_FRAME_TUNNEL_CLOSE,
  type RelayFrameTunnelMessage,
} from "@ryco/shared/relayFrameTunnel";
import { describe, expect, it, vi } from "vitest";

import type { RelayFrameTunnelPeer } from "../relay/relayEngine.ts";
import { openHostedDeviceFrameSource } from "./hostedDeviceFrameTunnel.ts";
import { openHostedNodeBrowserFrameSource } from "./hostedNodeBrowserFrameTunnel.ts";

const TAB = `handoff-${"0f".repeat(16)}`;
const request = { tabId: TAB, maxWidth: 800, maxHeight: 600 };

function setup(options: { readonly bindable?: boolean; readonly ready?: boolean } = {}) {
  let ready = options.ready ?? true;
  const listeners = new Set<() => void>();
  const sent: RelayFrameTunnelMessage[] = [];
  let peer: RelayFrameTunnelPeer | null = null;
  let binds = 0;
  const channel = {
    socket: {},
    bind: (next: RelayFrameTunnelPeer) => {
      binds += 1;
      if (options.bindable === false) return null;
      peer = next;
      return (bytes: Uint8Array) => {
        const message = decodeRelayFrameTunnelMessage(bytes);
        if (message) sent.push(message);
        return true;
      };
    },
  };
  const frameOptions = {
    channel: () => channel,
    readiness: {
      read: () => ready,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const handlers = { onFrame: vi.fn(), onReset: vi.fn(), onStop: vi.fn() };
  return {
    frameOptions,
    handlers,
    sent,
    binds: () => binds,
    peer: () => peer,
    open: (tabRequest = request) =>
      openHostedNodeBrowserFrameSource(tabRequest, handlers, frameOptions),
    setReady: (value: boolean) => {
      ready = value;
      for (const listener of listeners) listener();
    },
  };
}

describe("openHostedNodeBrowserFrameSource", () => {
  it("opens the handed-off tab's stream and acknowledges every frame", async () => {
    const tunnel = setup();
    const source = tunnel.open();
    await vi.waitFor(() => expect(tunnel.sent[0]?.kind).toBe("open"));
    expect(tunnel.sent[0]).toEqual({
      kind: "open",
      streamId: 1,
      target: { target: "node-browser-frames", tabId: TAB, maxWidth: 800, maxHeight: 600 },
    });

    const envelope = encodeNodeBrowserFrame({
      seq: 3,
      cssWidth: 400,
      cssHeight: 300,
      jpeg: Uint8Array.of(0xff, 0xd8),
    });
    tunnel.peer()?.receive(encodeRelayFrameTunnelBinary(1, envelope));
    expect(tunnel.handlers.onFrame).toHaveBeenCalledOnce();
    expect(tunnel.handlers.onFrame.mock.calls[0]?.[0]).toMatchObject({ seq: 3, cssWidth: 400 });
    // The tunnel's count, then the frame socket's own ack.
    expect(tunnel.sent.slice(1)).toEqual([
      { kind: "ack", streamId: 1, received: 1 },
      { kind: "text", streamId: 1, text: NODE_BROWSER_FRAME_ACK },
    ]);
    source.close();
    expect(tunnel.sent.at(-1)).toEqual({ kind: "close", streamId: 1, code: null, reason: "" });
  });

  it("opens nothing until the session is ready and closes when it stops being", async () => {
    vi.useFakeTimers();
    try {
      const tunnel = setup({ ready: false });
      const source = tunnel.open();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tunnel.sent).toEqual([]);

      tunnel.setReady(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(tunnel.sent.map((message) => message.kind)).toEqual(["open"]);

      tunnel.setReady(false);
      expect(tunnel.sent.at(-1)).toEqual({ kind: "close", streamId: 1, code: null, reason: "" });
      await vi.advanceTimersByTimeAsync(10_000);
      // Not ready: no new stream, and the source keeps waiting rather than stopping.
      expect(tunnel.sent.filter((message) => message.kind === "open")).toHaveLength(1);
      expect(tunnel.handlers.onStop).not.toHaveBeenCalled();
      source.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the node refuses the session", async () => {
    const tunnel = setup();
    tunnel.open();
    await vi.waitFor(() => expect(tunnel.sent[0]?.kind).toBe("open"));
    tunnel.peer()?.receive(encodeRelayFrameTunnelClose(1, RELAY_FRAME_TUNNEL_CLOSE.forbidden, ""));
    await vi.waitFor(() =>
      expect(tunnel.handlers.onStop).toHaveBeenCalledWith({ reason: "forbidden" }),
    );
  });

  it("never tunnels an ordinary node tab", async () => {
    const tunnel = setup();
    tunnel.open({ ...request, tabId: "tab-1" });
    await vi.waitFor(() => expect(tunnel.handlers.onStop).toHaveBeenCalled());
    expect(tunnel.handlers.onStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unavailable" }),
    );
    expect(tunnel.binds()).toBe(0);
    expect(tunnel.sent).toEqual([]);
  });

  it("stops for good on a channel that cannot carry the tunnel", async () => {
    const tunnel = setup({ bindable: false });
    tunnel.open();
    await vi.waitFor(() => expect(tunnel.handlers.onStop).toHaveBeenCalled());
    expect(tunnel.handlers.onStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unavailable" }),
    );
    expect(tunnel.handlers.onStop).toHaveBeenCalledOnce();
    expect(tunnel.sent).toEqual([]);
  });

  it("shares the channel's tunnel with its device streams", async () => {
    const tunnel = setup();
    const device = openHostedDeviceFrameSource(
      DeviceUdid.make("SIM-1"),
      { onFrame: vi.fn(), onReset: vi.fn() },
      tunnel.frameOptions,
    );
    await vi.waitFor(() => expect(tunnel.sent).toHaveLength(1));
    const tab = tunnel.open();
    await vi.waitFor(() => expect(tunnel.sent).toHaveLength(2));

    expect(tunnel.binds()).toBe(1);
    expect(tunnel.sent.map((message) => message.kind === "open" && message.target)).toEqual([
      { target: "device-frames", udid: "SIM-1" },
      { target: "node-browser-frames", tabId: TAB, maxWidth: 800, maxHeight: 600 },
    ]);
    expect(new Set(tunnel.sent.map((message) => message.streamId)).size).toBe(2);
    device.close();
    tab.close();
  });
});
