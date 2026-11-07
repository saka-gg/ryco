import {
  decodeRelayFrameTunnelMessage,
  encodeRelayFrameTunnelBinary,
  encodeRelayFrameTunnelClose,
  encodeRelayFrameTunnelText,
  RELAY_FRAME_TUNNEL_MAGIC,
  RELAY_FRAME_TUNNEL_MAX_STREAMS,
  RELAY_FRAME_TUNNEL_VERSION,
} from "@ryco/shared/relayFrameTunnel";
import { describe, expect, it } from "vitest";

import { CLIENT_RELAY_FRAME_TUNNEL_VERSION } from "../state/device/videoAvailability.ts";
import { RELAY_ENGINE_FRAME_TUNNEL_MAGIC } from "./relayEngine.ts";
import { RELAY_FRAME_TUNNEL_CHANNEL_LOST, RelayFrameTunnelClient } from "./relayFrameTunnel.ts";

function harness(accept = true) {
  const sent: Uint8Array[] = [];
  const tasks: (() => void)[] = [];
  const client = new RelayFrameTunnelClient({
    send: (bytes) => {
      sent.push(bytes);
      return accept;
    },
    queueMicrotask: (task) => tasks.push(task),
  });
  const flush = () => {
    while (tasks.length > 0) tasks.shift()?.();
  };
  const decoded = () => sent.map((bytes) => decodeRelayFrameTunnelMessage(bytes));
  return { client, sent, flush, decoded };
}

function listen(socket: ReturnType<RelayFrameTunnelClient["openSocket"]>) {
  const events: { type: string; data?: unknown; code?: number | undefined }[] = [];
  for (const type of ["open", "message", "close", "error"] as const) {
    socket.addEventListener(type, ((event: { data?: unknown; code?: number }) =>
      events.push({ type, data: event.data, code: event.code })) as (event: never) => void);
  }
  return events;
}

describe("RelayFrameTunnelClient", () => {
  it("pins the constants the boot path repeats", () => {
    expect(RELAY_ENGINE_FRAME_TUNNEL_MAGIC).toBe(RELAY_FRAME_TUNNEL_MAGIC);
    expect(CLIENT_RELAY_FRAME_TUNNEL_VERSION).toBe(RELAY_FRAME_TUNNEL_VERSION);
  });

  it("opens a stream, acknowledges binary before delivering it, and carries text both ways", () => {
    const { client, flush, decoded } = harness();
    const socket = client.openSocket({ target: "device-frames", udid: "SIM-1" });
    const events = listen(socket);
    flush();
    expect(events).toEqual([{ type: "open", data: undefined, code: undefined }]);
    expect(decoded()[0]).toEqual({
      kind: "open",
      streamId: 1,
      target: { target: "device-frames", udid: "SIM-1" },
    });

    client.receive(encodeRelayFrameTunnelText(1, '{"type":"device.input.ready","input":true}'));
    client.receive(encodeRelayFrameTunnelBinary(1, Uint8Array.of(9, 8)));
    client.receive(encodeRelayFrameTunnelBinary(1, Uint8Array.of(7)));
    expect(events.slice(1).map((event) => event.data)).toEqual([
      '{"type":"device.input.ready","input":true}',
      Uint8Array.of(9, 8),
      Uint8Array.of(7),
    ]);
    expect(decoded().slice(1)).toEqual([
      { kind: "ack", streamId: 1, received: 1 },
      { kind: "ack", streamId: 1, received: 2 },
    ]);

    socket.send('{"type":"device.frame.resync"}');
    expect(decoded().at(-1)).toEqual({
      kind: "text",
      streamId: 1,
      text: '{"type":"device.frame.resync"}',
    });
  });

  it("ignores another stream's messages and ends a stream the node closed", () => {
    const { client, flush } = harness();
    const socket = client.openSocket({ target: "device-frames", udid: "SIM-1" });
    const events = listen(socket);
    flush();
    client.receive(encodeRelayFrameTunnelBinary(99, Uint8Array.of(1)));
    client.receive(encodeRelayFrameTunnelClose(1, 4404, "unavailable"));
    flush();
    expect(events.map((event) => [event.type, event.code])).toEqual([
      ["open", undefined],
      ["close", 4404],
    ]);
    expect(client.openStreams).toBe(0);
    expect(() => socket.send("x")).toThrow();
  });

  it("closes every stream as lost with the channel, and refuses new ones", () => {
    const { client, flush } = harness();
    const events = listen(client.openSocket({ target: "device-frames", udid: "A" }));
    flush();
    client.close();
    flush();
    expect(events.at(-1)).toMatchObject({ type: "close", code: RELAY_FRAME_TUNNEL_CHANNEL_LOST });
    expect(client.closed).toBe(true);
    expect(() => client.openSocket({ target: "device-frames", udid: "A" })).toThrow();
  });

  it("reports a stream the channel would not open as lost", () => {
    const { client, flush } = harness(false);
    const events = listen(client.openSocket({ target: "device-frames", udid: "A" }));
    flush();
    expect(events).toEqual([
      { type: "close", data: undefined, code: RELAY_FRAME_TUNNEL_CHANNEL_LOST },
    ]);
  });

  it("bounds the streams per channel", () => {
    const { client } = harness();
    for (let index = 0; index < RELAY_FRAME_TUNNEL_MAX_STREAMS; index += 1) {
      client.openSocket({ target: "device-frames", udid: `D${index}` });
    }
    expect(() => client.openSocket({ target: "device-frames", udid: "X" })).toThrow();
  });
});
