import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HUB_SESSION_MAX_QUEUED_BYTES, type HubSessionFrame } from "@ryco/contracts/hub-session";
import { decodeHubSessionFrame, encodeHubSessionFrame } from "@ryco/shared/hubSessionCodec";
import { HostedHubSession, type HubSessionSocket } from "./hostedHubSession.ts";

class Socket implements HubSessionSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  closed = 0;
  openListeners: (() => void)[] = [];
  messages: ((bytes: Uint8Array) => void)[] = [];
  closes: ((reason?: string, code?: number) => void)[] = [];
  errors: (() => void)[] = [];
  send(bytes: Uint8Array) {
    this.sent.push(Uint8Array.from(bytes));
  }
  close(code = 1000, reason = "closed") {
    this.readyState = 3;
    this.closed++;
    for (const cb of this.closes) cb(reason, code);
  }
  onOpen(cb: () => void) {
    this.openListeners.push(cb);
  }
  onBinaryMessage(cb: (bytes: Uint8Array) => void) {
    this.messages.push(cb);
  }
  onClose(cb: (reason?: string, code?: number) => void) {
    this.closes.push(cb);
  }
  onError(cb: () => void) {
    this.errors.push(cb);
  }
  receive(frame: HubSessionFrame) {
    const bytes = encodeHubSessionFrame(frame);
    if (!bytes.ok) throw new Error("frame");
    for (const cb of this.messages) cb(bytes.value);
  }
  ready() {
    this.readyState = 1;
    for (const cb of this.openListeners) cb();
    this.receive({ type: "ready", protocolVersion: 1, maxChannels: 8 });
  }
  frames() {
    return this.sent.map((bytes) => {
      const decoded = decodeHubSessionFrame(bytes);
      if (!decoded.ok) throw new Error("decode");
      return decoded.value;
    });
  }
}
function harness() {
  const sockets: Socket[] = [];
  const onFailure = vi.fn();
  const onInvalidate = vi.fn();
  const session = new HostedHubSession({
    createSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    timers: {
      now: Date.now,
      setTimeout,
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      queueMicrotask,
    },
    random: () => 0.5,
    onFailure,
    onInvalidate,
  });
  return { session, sockets, onFailure, onInvalidate };
}
describe("persistent Hub session", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("opens independently of device selection and waits for authenticated READY", () => {
    const { session, sockets } = harness();
    session.start();
    session.start();
    expect(sockets).toHaveLength(1);
    const channel = session.createSocket();
    const opened = vi.fn();
    channel.onOpen(opened);
    expect(opened).not.toHaveBeenCalled();
    sockets[0]!.ready();
    expect(opened).toHaveBeenCalledOnce();
    expect(sockets[0]!.frames()).toEqual([{ type: "open", streamId: 1 }]);
    session.dispose();
  });
  it("routes two independent byte streams and preserves the physical socket when one closes", async () => {
    const { session, sockets } = harness();
    const first = session.createSocket();
    const second = session.createSocket();
    const firstData = vi.fn();
    const secondData = vi.fn();
    first.onBinaryMessage(firstData);
    second.onBinaryMessage(secondData);
    sockets[0]!.ready();
    first.send(Uint8Array.of(11));
    second.send(Uint8Array.of(22));
    sockets[0]!.receive({ type: "data", streamId: 2, payload: Uint8Array.of(33) });
    expect(firstData).not.toHaveBeenCalled();
    expect(secondData).toHaveBeenCalledWith(Uint8Array.of(33));
    first.close();
    expect(sockets[0]!.closed).toBe(0);
    expect(second.readyState).toBe(1);
    sockets[0]!.receive({ type: "data", streamId: 1, payload: Uint8Array.of(44) });
    expect(firstData).not.toHaveBeenCalled();
    second.close();
    const third = session.createSocket();
    await vi.runAllTicks();
    expect(third.readyState).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.frames().at(-1)).toEqual({ type: "open", streamId: 3 });
    session.dispose();
  });
  it("keeps an idle directory session alive and forwards bounded invalidation notifications", async () => {
    const { session, sockets, onInvalidate } = harness();
    const subscriber = vi.fn();
    session.subscribeInvalidation(subscriber);
    session.start();
    sockets[0]!.ready();
    for (let n = 0; n < 5; n++) {
      await vi.advanceTimersByTimeAsync(20_000);
      const ping = sockets[0]!.frames().at(-1);
      if (ping?.type !== "ping") throw new Error("missing ping");
      sockets[0]!.receive({ type: "pong", nonce: ping.nonce });
      sockets[0]!.receive({ type: "ping", nonce: new Uint8Array(8) });
    }
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(0);
    sockets[0]!.receive({ type: "invalidate", directory: true, threadCache: true });
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    expect(subscriber).toHaveBeenCalledTimes(2);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes old logical channels on physical failure without replaying their bytes", async () => {
    const { session, sockets } = harness();
    const old = session.createSocket();
    const closed = vi.fn();
    old.onClose(closed);
    sockets[0]!.ready();
    old.send(Uint8Array.of(99));
    sockets[0]!.close(1006);
    expect(closed).toHaveBeenCalledOnce();
    const next = session.createSocket();
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.ready();
    expect(next.readyState).toBe(1);
    expect(sockets[1]!.frames()).toEqual([{ type: "open", streamId: 2 }]);
    // An old physical socket cannot publish into the replacement.
    sockets[0]!.receive({ type: "data", streamId: 2, payload: Uint8Array.of(3) });
    expect(next.readyState).toBe(1);
    session.dispose();
  });
  it("bounds channel count and backpressure without sacrificing sibling channels", () => {
    const { session, sockets } = harness();
    const channels = Array.from({ length: 8 }, () => session.createSocket());
    expect(() => session.createSocket()).toThrow("capacity");
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = HUB_SESSION_MAX_QUEUED_BYTES;
    expect(() => channels[0]!.send(Uint8Array.of(1))).toThrow("queue is full");
    expect(channels[1]!.readyState).toBe(1);
    session.dispose();
  });
  it("bounds bookkeeping when a blocked socket receives many tiny frames", () => {
    const { session, sockets } = harness();
    const channel = session.createSocket();
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = 256 * 1024;
    let accepted = 0;
    expect(() => {
      for (; accepted < 10_000; accepted++) channel.send(Uint8Array.of(1));
    }).toThrow("queue is full");
    expect(accepted).toBeLessThanOrEqual(2_048);
    channel.close();
    expect(sockets[0]!.closed).toBe(0);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves queued OPEN, authentication and CLOSE order", async () => {
    const { session, sockets } = harness();
    const channel = session.createSocket();
    sockets[0]!.bufferedAmount = 256 * 1024;
    sockets[0]!.ready();
    channel.send(Uint8Array.of(42));
    channel.close();
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets[0]!.frames().map((frame) => frame.type)).toEqual(["open", "data", "close"]);
    session.dispose();
  });
  it.each([4401, 4403, 4411])(
    "does not reconnect or fall back after authority close %s",
    async (code) => {
      const { session, sockets, onFailure } = harness();
      session.start();
      sockets[0]!.ready();
      sockets[0]!.close(code);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      expect(onFailure).toHaveBeenCalledWith({ kind: "authentication", retryable: false });
      expect(() => session.createSocket()).toThrow("closed");
    },
  );
  it.each([1002, 1007, 1009, 4400, 4406])(
    "fails closed on protocol socket close %s",
    async (code) => {
      const { session, sockets, onFailure } = harness();
      session.start();
      sockets[0]!.ready();
      sockets[0]!.close(code);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      expect(onFailure).toHaveBeenCalledWith({ kind: "protocol", retryable: false });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("times out half-open transports and leaves no timers after account disposal", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.ready();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sockets[0]!.closed).toBe(1);
    session.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("backs off rapid flaps but resets after a stable authenticated interval", async () => {
    const { session, sockets, onInvalidate } = harness();
    session.start();
    sockets[0]!.ready();
    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.ready();
    sockets[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    sockets[2]!.ready();
    await vi.advanceTimersByTimeAsync(30_000);
    sockets[2]!.close(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(4);
    sockets[3]!.ready();
    expect(onInvalidate).toHaveBeenCalledTimes(4);
    expect(onInvalidate).toHaveBeenLastCalledWith({ directory: true, threadCache: true });
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects malformed or wrong-direction envelopes without fallback", () => {
    const { session, sockets, onFailure } = harness();
    session.start();
    sockets[0]!.ready();
    sockets[0]!.receive({ type: "open", streamId: 1 });
    expect(onFailure).toHaveBeenCalledWith({ kind: "protocol", retryable: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
