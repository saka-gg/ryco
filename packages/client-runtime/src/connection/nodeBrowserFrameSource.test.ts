import {
  encodeNodeBrowserFrame,
  NODE_BROWSER_FRAME_ACK,
  NODE_BROWSER_FRAME_CLOSE,
  type NodeBrowserFrame,
} from "@ryco/shared/nodeBrowserFrame";
import { describe, expect, it } from "vitest";

import {
  createNodeBrowserFrameSource,
  NODE_BROWSER_FRAME_RECONNECT_MAX_MS,
  type NodeBrowserFrameStop,
} from "./nodeBrowserFrameSource.ts";

class FakeSocket {
  binaryType = "blob";
  readonly sent: Array<string> = [];
  readonly events: Array<string> = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly url: string;
  private readonly log: Array<string>;
  constructor(url: string, log: Array<string>) {
    this.url = url;
    this.log = log;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(data);
    this.log.push("ack");
  }
  close() {
    this.closed = true;
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const harness = () => {
  const sockets: Array<FakeSocket> = [];
  const log: Array<string> = [];
  const frames: Array<{ frame: NodeBrowserFrame; generation: number }> = [];
  const stops: Array<NodeBrowserFrameStop> = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  let tokens = 0;
  const source = createNodeBrowserFrameSource({
    request: { tabId: "tab-1", maxWidth: 1600.4, maxHeight: 1000 },
    resolveUrl: async () => `wss://node.example/ws?wsToken=token-${++tokens}`,
    socket: {
      webSocketConstructor: (url) => {
        const socket = new FakeSocket(url, log);
        sockets.push(socket);
        return socket;
      },
    },
    handlers: {
      onFrame: (frame, generation) => {
        log.push(`frame ${frame.seq}`);
        frames.push({ frame, generation });
      },
      onStop: (stop) => stops.push(stop),
    },
    setTimeout: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  const runTimer = async () => {
    timers.shift()?.callback();
    await Promise.resolve();
  };
  return { source, sockets, log, frames, stops, timers, runTimer, tokens: () => tokens };
};

const frame = (seq: number) =>
  encodeNodeBrowserFrame({ seq, cssWidth: 800, cssHeight: 600, jpeg: new Uint8Array([0xff]) })
    .buffer;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("node browser frame source", () => {
  it("opens the tab's frame socket with a fresh token and acknowledges every frame before it is used", async () => {
    const { sockets, log, frames } = harness();
    await tick();
    const url = new URL(sockets[0]!.url);
    expect(url.pathname).toBe("/ws/node-browser-frames");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      wsToken: "token-1",
      tab: "tab-1",
      maxWidth: "1600",
      maxHeight: "1000",
    });
    expect(sockets[0]!.binaryType).toBe("arraybuffer");
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", { data: frame(1) });
    sockets[0]!.emit("message", { data: new Uint8Array([1, 2, 3]).buffer });
    // A frame that does not decode is still acknowledged: the node waits on every one.
    expect(log).toEqual(["ack", "frame 1", "ack"]);
    expect(sockets[0]!.sent).toEqual([NODE_BROWSER_FRAME_ACK, NODE_BROWSER_FRAME_ACK]);
    expect(frames.map(({ frame }) => [frame.seq, frame.cssWidth, frame.cssHeight])).toEqual([
      [1, 800, 600],
    ]);
  });

  it("ignores a replaced socket's late frames and closes", async () => {
    const { sockets, frames, stops, runTimer } = harness();
    await tick();
    const first = sockets[0]!;
    first.emit("open");
    first.emit("close", { code: 1006 });
    await runTimer();
    await tick();
    first.emit("message", { data: frame(9) });
    first.emit("close", { code: NODE_BROWSER_FRAME_CLOSE.tabGone });
    expect(frames).toEqual([]);
    expect(first.sent).toEqual([]);
    expect(stops).toEqual([]);
    sockets[1]!.emit("message", { data: frame(10) });
    expect(frames.map(({ generation }) => generation)).toEqual([2]);
  });

  it("stops for a gone tab, a refused role or an unavailable browser", async () => {
    for (const [code, stop] of [
      [NODE_BROWSER_FRAME_CLOSE.tabGone, { reason: "gone" }],
      [NODE_BROWSER_FRAME_CLOSE.forbidden, { reason: "forbidden" }],
      [NODE_BROWSER_FRAME_CLOSE.unavailable, { reason: "unavailable", detail: "crashed" }],
    ] as const) {
      const { sockets, stops, timers } = harness();
      await tick();
      sockets[0]!.emit("open");
      sockets[0]!.emit("close", { code, reason: "crashed" });
      expect(stops).toEqual([stop]);
      expect(timers).toEqual([]);
    }
  });

  it("reconnects at once after a browser restart, and backs off up to 5 s otherwise", async () => {
    const { sockets, timers, runTimer, stops } = harness();
    await tick();
    sockets[0]!.emit("open");
    sockets[0]!.emit("close", { code: NODE_BROWSER_FRAME_CLOSE.restarted });
    expect(timers.map(({ delayMs }) => delayMs)).toEqual([500]);
    const delays: Array<number> = [];
    for (let index = 1; index <= 6; index += 1) {
      await runTimer();
      await tick();
      sockets[index]!.emit("open");
      sockets[index]!.emit("close", { code: 1006 });
      delays.push(timers[0]!.delayMs);
    }
    // An opened socket resets the backoff each time.
    expect(delays.every((delay) => delay === 500)).toBe(true);
    for (let index = 7; index <= 12; index += 1) {
      await runTimer();
      await tick();
      sockets[index]!.emit("open");
      sockets[index]!.emit("error");
    }
    expect(Math.max(...timers.map(({ delayMs }) => delayMs))).toBeLessThanOrEqual(
      NODE_BROWSER_FRAME_RECONNECT_MAX_MS,
    );
    expect(stops).toEqual([]);
  });

  it("gives up after three sockets refused before they opened", async () => {
    const { sockets, stops, runTimer, tokens } = harness();
    await tick();
    sockets[0]!.emit("close", { code: 1006 });
    await runTimer();
    await tick();
    sockets[1]!.emit("close", { code: 1006 });
    expect(stops).toEqual([]);
    await runTimer();
    await tick();
    sockets[2]!.emit("close", { code: 1006 });
    expect(stops).toEqual([{ reason: "refused" }]);
    // Each attempt asked for a fresh socket token.
    expect(tokens()).toBe(3);
  });
});
