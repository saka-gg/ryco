import { DeviceUdid } from "@ryco/contracts";
import { encodeDeviceFrame } from "@ryco/shared/deviceFrame";
import {
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelBinary,
  type RelayFrameTunnelMessage,
} from "@ryco/shared/relayFrameTunnel";
import { describe, expect, it, vi } from "vitest";

import type { RelayFrameTunnelPeer } from "../relay/relayEngine.ts";
import { openHostedDeviceFrameSource } from "./hostedDeviceFrameTunnel.ts";

const udid = DeviceUdid.make("SIM-1");

function setup(bindable = true) {
  let ready = true;
  const listeners = new Set<() => void>();
  const sent: RelayFrameTunnelMessage[] = [];
  let peer: RelayFrameTunnelPeer | null = null;
  const channel = {
    socket: {},
    bind: (next: RelayFrameTunnelPeer) => {
      if (!bindable) return null;
      peer = next;
      return (bytes: Uint8Array) => {
        const message = decodeRelayFrameTunnelMessage(bytes);
        if (message) sent.push(message);
        return true;
      };
    },
  };
  const handlers = { onFrame: vi.fn(), onReset: vi.fn(), onText: vi.fn() };
  const source = openHostedDeviceFrameSource(udid, handlers, {
    channel: () => channel,
    readiness: {
      read: () => ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    source,
    handlers,
    sent,
    peer: () => peer,
    setReady: (value: boolean) => {
      ready = value;
      for (const listener of listeners) listener();
    },
  };
}

describe("openHostedDeviceFrameSource", () => {
  it("streams a device through the tunnel and closes it when the session stops being ready", async () => {
    const { source, handlers, sent, peer, setReady } = setup();
    await vi.waitFor(() => expect(sent[0]?.kind).toBe("open"));
    expect(sent[0]).toMatchObject({ target: { target: "device-frames", udid: "SIM-1" } });

    const envelope = encodeDeviceFrame({
      header: { deviceId: udid, sequence: 1, timestampMs: 5, keyframe: true, codecConfig: false },
      payload: Uint8Array.of(0, 0, 0, 1, 0x65),
    });
    peer()?.receive(encodeRelayFrameTunnelBinary(1, envelope));
    expect(handlers.onFrame).toHaveBeenCalledOnce();
    expect(handlers.onFrame.mock.calls[0]?.[0].header.sequence).toBe(1);
    expect(sent.at(-1)).toEqual({ kind: "ack", streamId: 1, received: 1 });

    setReady(false);
    expect(sent.at(-1)).toEqual({ kind: "close", streamId: 1, code: null, reason: "" });
    await vi.waitFor(() => expect(handlers.onReset).toHaveBeenCalled());
    source.close();
  });

  it("stops for good on a channel that cannot carry the tunnel, so the viewer falls back", async () => {
    const { source, handlers, sent } = setup(false);
    await vi.waitFor(() => expect(handlers.onReset).toHaveBeenCalled());
    expect(handlers.onReset).toHaveBeenCalledWith("unavailable", {
      generation: expect.any(Number),
      retryInMs: null,
    });
    expect(handlers.onReset).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    source.close();
  });
});
