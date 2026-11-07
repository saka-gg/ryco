import type { DeviceUdid } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { createDeviceFrameSource } from "./deviceFrameSource.ts";

class FakeSocket {
  binaryType = "blob";
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

function harness() {
  const sockets: FakeSocket[] = [];
  const texts: Array<[string, number]> = [];
  const timers: Array<() => void> = [];
  const source = createDeviceFrameSource({
    udid: "DEVICE" as DeviceUdid,
    resolveUrl: async () => "ws://node.example/ws?wsToken=t",
    socket: {
      webSocketConstructor: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    } as never,
    handlers: {
      onFrame: () => undefined,
      onReset: () => undefined,
      onText: (text, generation) => texts.push([text, generation]),
    },
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  return { source, sockets, texts, timers };
}

describe("device frame source text channel", () => {
  it("sends text only on an open socket", async () => {
    const { source, sockets } = harness();
    await settle();
    expect(source.sendText("early")).toBe(false);
    sockets[0]!.emit("open");
    expect(source.sendText("live")).toBe(true);
    expect(sockets[0]!.sent).toEqual(["live"]);

    sockets[0]!.emit("close");
    expect(source.sendText("after")).toBe(false);
  });

  it("hands text messages to the pane with their socket's generation", async () => {
    const { sockets, texts, timers } = harness();
    await settle();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", { data: '{"type":"device.input.ready","input":true}' });
    expect(texts).toEqual([['{"type":"device.input.ready","input":true}', 1]]);

    // A replaced socket's late messages are ignored.
    sockets[0]!.emit("close");
    timers.shift()!();
    await settle();
    sockets[0]!.emit("message", { data: "stale" });
    sockets[1]!.emit("message", { data: "fresh" });
    expect(texts.map(([text]) => text)).toEqual([
      '{"type":"device.input.ready","input":true}',
      "fresh",
    ]);
  });

  it("stops sending once closed", async () => {
    const { source, sockets } = harness();
    await settle();
    sockets[0]!.emit("open");
    source.close();
    expect(source.sendText("x")).toBe(false);
    expect(sockets[0]!.closed).toBe(true);
  });
});
