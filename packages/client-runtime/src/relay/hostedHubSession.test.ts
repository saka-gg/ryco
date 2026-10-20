import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HUB_SESSION_MAX_QUEUED_BYTES, type HubSessionFrame } from "@ryco/contracts/hub-session";
import { decodeHubSessionFrame, encodeHubSessionFrame } from "@ryco/shared/hubSessionCodec";
import type { RelayNodeId } from "@ryco/contracts/relay";
import {
  HUB_SESSION_IDENTITY_MISMATCH_REASON,
  HUB_SESSION_SERVER_MINTED_UNAVAILABLE_REASON,
  HUB_SESSION_SUBPROTOCOL_FALLBACK_MS,
  HostedHubSession,
  type HostedHubSessionOptions,
  type HubSessionSocket,
} from "./hostedHubSession.ts";

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
  readyV2() {
    this.readyState = 1;
    for (const cb of this.openListeners) cb();
    this.receive({
      type: "ready",
      protocolVersion: 2,
      maxChannels: 8,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
    });
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
      const decoded = decodeHubSessionFrame(bytes, { protocolVersion: 2 });
      if (!decoded.ok) throw new Error("decode");
      return decoded.value;
    });
  }
}
/**
 * A browser WebSocket: `bufferedAmount` grows on `send()` and drops once the
 * bytes reach the kernel, which keeps accepting them on a dead path too.
 */
class BrowserSocket extends Socket {
  override send(bytes: Uint8Array) {
    super.send(bytes);
    this.bufferedAmount += bytes.byteLength;
    setTimeout(() => {
      this.bufferedAmount -= bytes.byteLength;
    }, 1);
  }
}
/**
 * A browser WebSocket on a slow uplink: `bufferedAmount` grows on `send()` and
 * only drops when the test drains it, in bursts as TCP acknowledgements free
 * the kernel's send buffer.
 */
class UplinkSocket extends Socket {
  override send(bytes: Uint8Array) {
    super.send(bytes);
    this.bufferedAmount += bytes.byteLength;
  }
  drain(bytes: number) {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
  }
}
const ACCOUNT_ID = `acct_${"a".repeat(22)}`;
const SESSION_ID = `sess_${"s".repeat(22)}`;
const NODE_ID = `node_${"n".repeat(22)}` as RelayNodeId;
function harness(
  SocketType: new () => Socket = Socket,
  overrides: Partial<HostedHubSessionOptions> & { readonly withoutIdentity?: boolean } = {},
) {
  const sockets: Socket[] = [];
  const offers: (readonly string[])[] = [];
  const onFailure = vi.fn();
  const onInvalidate = vi.fn();
  const onIdentityMismatch = vi.fn();
  const { withoutIdentity, ...options } = overrides;
  const session = new HostedHubSession({
    ...(withoutIdentity === true
      ? {}
      : { expectedIdentity: { accountId: ACCOUNT_ID, sessionId: SESSION_ID } }),
    onIdentityMismatch,
    createSocket: (protocols) => {
      offers.push(protocols);
      const socket = new SocketType();
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
    ...options,
  });
  return { session, sockets, offers, onFailure, onInvalidate, onIdentityMismatch };
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
  it("hands a stream its data inside the socket's buffer, and zeroes data no stream takes", () => {
    const { session, sockets } = harness();
    const stream = session.createSocket();
    let received: Uint8Array | undefined;
    stream.onBinaryMessage((bytes) => {
      received = bytes;
      // What the relay engine does with every buffer it is handed.
      bytes.fill(0);
    });
    sockets[0]!.ready();
    const deliver = (frame: HubSessionFrame) => {
      const encoded = encodeHubSessionFrame(frame);
      if (!encoded.ok) throw new Error("frame");
      for (const cb of sockets[0]!.messages) cb(encoded.value);
      return encoded.value;
    };
    const delivered = deliver({ type: "data", streamId: 1, payload: Uint8Array.of(7, 8, 9) });
    expect(received?.buffer).toBe(delivered.buffer);
    // The consumer's zeroing reaches the socket's buffer: no unzeroed copy is left.
    expect([...delivered]).toEqual([2, 0, 0, 0, 1, 0, 0, 0]);
    stream.close();
    const dropped = deliver({ type: "data", streamId: 1, payload: Uint8Array.of(4, 5) });
    expect([...dropped.subarray(5)]).toEqual([0, 0]);
    expect(sockets[0]!.closed).toBe(0);
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
  it("detects a silently dead connection within the probe bound instead of the liveness bound", async () => {
    const { session, sockets, onFailure } = harness();
    const channel = session.createSocket();
    const closed = vi.fn();
    channel.onClose(closed);
    sockets[0]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    expect(sockets[0]!.frames().at(-1)?.type).toBe("ping");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    expect(closed).toHaveBeenCalledOnce();
    expect(sockets[0]!.closed).toBe(1);
    // The ordinary bounded reconnect follows.
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("loses an idle dead browser connection within the probe bound though its ping left the buffer", async () => {
    const { session, sockets, onFailure } = harness(BrowserSocket);
    session.createSocket();
    sockets[0]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    expect(sockets[0]!.closed).toBe(1);
    session.dispose();
  });
  it("loses a dead browser connection within the probe bound though small frames keep leaving", async () => {
    const { session, sockets, onFailure } = harness(BrowserSocket);
    const channel = session.createSocket();
    sockets[0]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    // Channel pings, acks: a trickle the kernel accepts on a dead path too.
    const trickle = setInterval(() => {
      if (channel.readyState === 1) channel.send(new Uint8Array(64));
    }, 1_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    clearInterval(trickle);
    session.dispose();
  });
  it("keeps a probed browser connection while a backlogged upload drains", async () => {
    const { session, sockets, onFailure } = harness(BrowserSocket);
    const channel = session.createSocket();
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = 1_024 * 1_024;
    channel.send(new Uint8Array(1_024));
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    for (let second = 0; second < 12; second++) {
      sockets[0]!.bufferedAmount -= 50 * 1_024;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    session.dispose();
  });
  it("keeps a probed upload that drains in bursts after the ping leaves the queue", async () => {
    const { session, sockets, onFailure } = harness(UplinkSocket);
    const channel = session.createSocket();
    sockets[0]!.ready();
    const socket = sockets[0] as UplinkSocket;
    for (let frame = 0; frame < 24; frame++) channel.send(new Uint8Array(64 * 1_024));
    const drains = setInterval(() => socket.drain(100 * 1_024), 700);
    // Probe just before a burst: the ping leaves the queue a few milliseconds
    // later, behind a full browser buffer, and the upload stays backlogged.
    await vi.advanceTimersByTimeAsync(699);
    session.probe();
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.frames().filter((frame) => frame.type === "ping")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(onFailure).not.toHaveBeenCalled();
    expect(socket.closed).toBe(0);
    // The path stalls while still backlogged: lost within one more probe wait.
    clearInterval(drains);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    expect(socket.closed).toBe(1);
    session.dispose();
  });
  it("sends a probe ping ahead of queued stream data", async () => {
    const { session, sockets } = harness();
    const channel = session.createSocket();
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = 300 * 1_024;
    channel.send(new Uint8Array(1_024).fill(1));
    channel.send(new Uint8Array(1_024).fill(2));
    session.probe();
    sockets[0]!.receive({ type: "ping", nonce: new Uint8Array(8).fill(9) });
    sockets[0]!.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets[0]!.frames().map((frame) => frame.type)).toEqual([
      "open",
      "ping",
      "pong",
      "data",
      "data",
    ]);
    session.dispose();
  });
  it("counts the probe wait from when the ping leaves the queue", async () => {
    const { session, sockets, onFailure } = harness();
    const channel = session.createSocket();
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = 300 * 1_024;
    channel.send(new Uint8Array(1_024));
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    await vi.advanceTimersByTimeAsync(4_000);
    // The uplink catches up just before the deadline: the ping leaves now.
    sockets[0]!.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets[0]!.frames().at(1)?.type).toBe("ping");
    // Past the original deadline, but not yet the full bound since the ping left.
    await vi.advanceTimersByTimeAsync(4_990);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a probed connection while its uplink drains, and loses it once nothing moves", async () => {
    const { session, sockets, onFailure } = harness();
    const channel = session.createSocket();
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = 1_024 * 1_024;
    channel.send(new Uint8Array(1_024));
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    // A slow upload: bytes keep leaving the browser, no frame arrives.
    for (let second = 0; second < 12; second++) {
      sockets[0]!.bufferedAmount -= 50 * 1_024;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(onFailure).not.toHaveBeenCalled();
    expect(sockets[0]!.closed).toBe(0);
    // The path stalls: the next check without progress loses the connection.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    expect(sockets[0]!.closed).toBe(1);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("loses a congested connection whose uplink does not move within the probe bound", async () => {
    const { session, sockets, onFailure } = harness();
    const channel = session.createSocket();
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = 300 * 1_024;
    channel.send(new Uint8Array(1_024));
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    session.dispose();
  });
  it("never extends a probe past the liveness bound since the last frame", async () => {
    const { session, sockets, onFailure } = harness();
    const channel = session.createSocket();
    sockets[0]!.ready();
    sockets[0]!.bufferedAmount = 1_536 * 1_024;
    channel.send(new Uint8Array(1_024));
    await vi.advanceTimersByTimeAsync(30_000);
    session.probe();
    for (let second = 0; second < 14; second++) {
      sockets[0]!.bufferedAmount -= 10 * 1_024;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(onFailure).not.toHaveBeenCalled();
    sockets[0]!.bufferedAmount -= 10 * 1_024;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    session.dispose();
  });
  it("keeps a live connection that answers a probe and reuses a pending heartbeat ping", async () => {
    const { session, sockets, onFailure } = harness();
    session.start();
    sockets[0]!.ready();
    session.probe();
    const pings = () => sockets[0]!.frames().filter((frame) => frame.type === "ping");
    expect(pings()).toHaveLength(1);
    // A second signal while the probe is armed sends nothing more.
    session.probe();
    expect(pings()).toHaveLength(1);
    const ping = pings()[0]!;
    if (ping.type !== "ping") throw new Error("missing ping");
    sockets[0]!.receive({ type: "pong", nonce: ping.nonce });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFailure).not.toHaveBeenCalled();
    // The heartbeat's own ping is pending: a probe waits on it instead of
    // sending a second nonce its delayed pong would not match.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pings()).toHaveLength(2);
    session.probe();
    expect(pings()).toHaveLength(2);
    const heartbeat = pings()[1]!;
    if (heartbeat.type !== "ping") throw new Error("missing ping");
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[0]!.receive({ type: "pong", nonce: heartbeat.nonce });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFailure).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reconnects at once on a lifecycle signal while waiting out its backoff", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.ready();
    sockets[0]!.close(1006);
    expect(sockets).toHaveLength(1);
    session.resume();
    expect(sockets).toHaveLength(2);
    // Once per signal: a second signal while connecting does nothing more.
    session.resume();
    expect(sockets).toHaveLength(2);
    // Consecutive failures keep their backoff: 1,000 ms after a second failure.
    sockets[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("leaves an authentication failure closed on a lifecycle signal", () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.ready();
    sockets[0]!.close(4401);
    session.resume();
    expect(sockets).toHaveLength(1);
  });
  it("replaces a socket silent past the liveness bound without a probe wait", async () => {
    const { session, sockets, onFailure } = harness();
    session.start();
    sockets[0]!.ready();
    // A suspended timer clock: the heartbeat has not fired, the wall clock moved.
    vi.setSystemTime(Date.now() + 46_000);
    session.resume();
    expect(onFailure).toHaveBeenCalledWith({ kind: "network", retryable: true });
    expect(sockets[0]!.closed).toBe(1);
    expect(sockets).toHaveLength(2);
    // A stall probe does the same, then keeps the ordinary backoff.
    sockets[1]!.ready();
    vi.setSystemTime(Date.now() + 46_000);
    session.probe();
    expect(sockets[1]!.closed).toBe(1);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(3);
    session.dispose();
  });
  it("holds new streams off a suspect socket until a frame proves it alive", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.ready();
    session.probe();
    const channel = session.createSocket();
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.readyState).toBe(0);
    expect(sockets[0]!.frames().some((frame) => frame.type === "open")).toBe(false);
    sockets[0]!.receive({ type: "ping", nonce: new Uint8Array(8) });
    expect(channel.readyState).toBe(1);
    expect(sockets[0]!.frames().filter((frame) => frame.type === "open")).toEqual([
      { type: "open", streamId: 1 },
    ]);
    session.dispose();
  });
  it("carries a stream held off a dead socket to the replacement without closing it", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    const channel = session.createSocket();
    const closed = vi.fn();
    channel.onClose(closed);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets[0]!.closed).toBe(1);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.ready();
    expect(channel.readyState).toBe(1);
    expect(sockets[1]!.frames()).toEqual([{ type: "open", streamId: 1 }]);
    session.dispose();
  });
  it("closes a never-opened stream that waited past its bound", async () => {
    const { session, sockets } = harness();
    const channel = session.createSocket();
    const closed = vi.fn();
    channel.onClose(closed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.closed).toBe(1);
    expect(closed).toHaveBeenCalledOnce();
    session.dispose();
  });
  it("ignores a probe before READY", async () => {
    const { session, sockets, onFailure } = harness();
    session.start();
    session.probe();
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.ready();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFailure).not.toHaveBeenCalled();
    session.dispose();
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

describe("Hub session protocol version 2", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const serverMinted = { serverMinted: { nodeId: NODE_ID, protocolMinor: 3 as const } };
  const openNode = (streamId: number) => ({
    type: "openNode",
    streamId,
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    capability: "ryco.rpc",
    protocolMajor: 1,
    protocolMinor: 3,
  });

  it("advertises version 2 on every connection and offers no server-minted open on version 1", () => {
    const { session, sockets, offers } = harness();
    session.start();
    expect(offers).toEqual([["ryco.hub-session.v2"]]);
    expect(session.serverMintedOpenAvailable()).toBe(false);
    sockets[0]!.ready();
    expect(session.serverMintedOpenAvailable()).toBe(false);
    expect(session.readyIdentity()).toBeNull();
    session.dispose();
  });

  it("records version 2 and its ids, and opens server-minted streams with openNode", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.readyV2();
    expect(session.serverMintedOpenAvailable()).toBe(true);
    expect(session.readyIdentity()).toEqual({ accountId: ACCOUNT_ID, sessionId: SESSION_ID });
    const minted = session.createSocket(serverMinted);
    session.createSocket();
    const opened = vi.fn();
    minted.onOpen(opened);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toHaveBeenCalledOnce();
    // A ticket-holding stream still opens with `open` on a version 2 connection.
    expect(sockets[0]!.frames()).toEqual([openNode(1), { type: "open", streamId: 2 }]);
    session.dispose();
    expect(session.readyIdentity()).toBeNull();
  });

  it("offers no server-minted open while a suspicion probe is armed", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.readyV2();
    session.probe();
    expect(session.serverMintedOpenAvailable()).toBe(false);
    sockets[0]!.receive({ type: "ping", nonce: new Uint8Array(8) });
    expect(session.serverMintedOpenAvailable()).toBe(true);
    session.dispose();
  });

  it("closes a pending server-minted stream retryably when the replacement negotiates version 1", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.readyV2();
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    const minted = session.createSocket(serverMinted);
    const ticketed = session.createSocket();
    const closed = vi.fn();
    minted.onClose(closed);
    // The probe finds the socket dead; both never-opened streams wait for the replacement.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets[0]!.closed).toBe(1);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    // A rolled-back Hub: version 1, which has no openNode.
    sockets[1]!.ready();
    expect(session.readyIdentity()).toBeNull();
    expect(closed).toHaveBeenCalledWith(HUB_SESSION_SERVER_MINTED_UNAVAILABLE_REASON);
    expect(minted.readyState).toBe(3);
    // Nothing the version 1 Hub cannot decode was sent; the ticketed stream opened normally.
    expect(sockets[1]!.frames()).toEqual([{ type: "open", streamId: 2 }]);
    expect(ticketed.readyState).toBe(1);
    expect(sockets[1]!.closed).toBe(0);
    session.dispose();
  });

  it("carries a pending server-minted stream onto a version 2 replacement", async () => {
    const { session, sockets } = harness();
    session.start();
    sockets[0]!.readyV2();
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    const minted = session.createSocket(serverMinted);
    await vi.advanceTimersByTimeAsync(5_500);
    sockets[1]!.readyV2();
    expect(minted.readyState).toBe(1);
    expect(sockets[1]!.frames()).toEqual([openNode(1)]);
    session.dispose();
  });

  it("fails closed on a version 2 frame from a connection that negotiated version 1", () => {
    const { session, sockets, onFailure } = harness();
    session.start();
    sockets[0]!.ready();
    sockets[0]!.receive({
      type: "ready",
      protocolVersion: 2,
      maxChannels: 8,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
    });
    expect(onFailure).toHaveBeenCalledWith({ kind: "protocol", retryable: false });
  });

  const otherReady = (socket: Socket, accountId: string, sessionId: string) => {
    socket.readyState = 1;
    for (const cb of socket.openListeners) cb();
    socket.receive({ type: "ready", protocolVersion: 2, maxChannels: 8, accountId, sessionId });
  };

  it("offers no server-minted open without an expected identity to bind it to", () => {
    const { session, sockets } = harness(Socket, { withoutIdentity: true });
    session.start();
    sockets[0]!.readyV2();
    expect(session.serverMintedOpenAvailable()).toBe(false);
    session.dispose();
  });

  it("opens nothing server-minted on a version 2 connection authenticated as another session", async () => {
    const { session, sockets, onIdentityMismatch } = harness();
    session.start();
    // Same account, another browser session (say a sign-in in another tab replaced the cookie).
    otherReady(sockets[0]!, ACCOUNT_ID, `sess_${"o".repeat(22)}`);
    expect(onIdentityMismatch).toHaveBeenCalledOnce();
    expect(session.serverMintedOpenAvailable()).toBe(false);
    // A fresh attempt that raced the check is closed unsent; a ticketed stream still opens (its
    // ticket is bound to its own session, so the Hub fails it closed if it does not match).
    const minted = session.createSocket(serverMinted);
    const closed = vi.fn();
    minted.onClose(closed);
    const ticketed = session.createSocket();
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toHaveBeenCalledWith(HUB_SESSION_IDENTITY_MISMATCH_REASON);
    expect(ticketed.readyState).toBe(1);
    expect(sockets[0]!.frames()).toEqual([{ type: "open", streamId: 2 }]);
    session.dispose();
  });

  it("closes a pending server-minted stream when the replacement is another account", async () => {
    const { session, sockets, onIdentityMismatch } = harness();
    session.start();
    sockets[0]!.readyV2();
    await vi.advanceTimersByTimeAsync(1_000);
    session.probe();
    const minted = session.createSocket(serverMinted);
    const closed = vi.fn();
    minted.onClose(closed);
    await vi.advanceTimersByTimeAsync(5_500);
    otherReady(sockets[1]!, `acct_${"o".repeat(22)}`, `sess_${"o".repeat(22)}`);
    expect(onIdentityMismatch).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith(HUB_SESSION_IDENTITY_MISMATCH_REASON);
    expect(sockets[1]!.frames()).toEqual([]);
    expect(session.readyIdentity()).toEqual({
      accountId: `acct_${"o".repeat(22)}`,
      sessionId: `sess_${"o".repeat(22)}`,
    });
    session.dispose();
  });

  const identity = { accountId: ACCOUNT_ID, sessionId: SESSION_ID };
  const otherSession = { accountId: ACCOUNT_ID, sessionId: `sess_${"o".repeat(22)}` };

  it("binds an identity learned after the connection was authenticated", async () => {
    const { session, sockets, onIdentityMismatch } = harness(Socket, { withoutIdentity: true });
    session.start();
    sockets[0]!.readyV2();
    expect(session.serverMintedOpenAvailable()).toBe(false);
    expect(session.bindExpectedIdentity(identity)).toBe(true);
    expect(session.serverMintedOpenAvailable()).toBe(true);
    session.createSocket(serverMinted);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.frames()).toEqual([openNode(1)]);
    expect(onIdentityMismatch).not.toHaveBeenCalled();
    session.dispose();
  });

  it("checks a ready that arrives after the binding against the bound identity", () => {
    const { session, sockets, onIdentityMismatch } = harness(Socket, { withoutIdentity: true });
    session.start();
    expect(session.bindExpectedIdentity(identity)).toBe(true);
    otherReady(sockets[0]!, otherSession.accountId, otherSession.sessionId);
    expect(onIdentityMismatch).toHaveBeenCalledOnce();
    expect(session.serverMintedOpenAvailable()).toBe(false);
    session.dispose();
  });

  it("refuses an identity the connection was not authenticated as, or one already expected", () => {
    const { session, sockets } = harness(Socket, { withoutIdentity: true });
    session.start();
    otherReady(sockets[0]!, otherSession.accountId, otherSession.sessionId);
    expect(session.bindExpectedIdentity(identity)).toBe(false);
    expect(session.serverMintedOpenAvailable()).toBe(false);
    session.dispose();
    expect(session.bindExpectedIdentity(otherSession)).toBe(false);

    // An identity given at creation is never replaced; binding it again is a no-op.
    const bound = harness();
    expect(bound.session.bindExpectedIdentity(otherSession)).toBe(false);
    expect(bound.session.bindExpectedIdentity(identity)).toBe(true);
    bound.session.dispose();
  });
});

/** A socket the network (or a stripping proxy) fails before it ever opens. */
class DeadOnArrivalSocket extends Socket {
  fail() {
    for (const cb of this.errors) cb();
  }
}

describe("Hub session subprotocol fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const V2 = ["ryco.hub-session.v2"];
  /** Advance just until the backoff has created the next socket (never into its ready timeout). */
  const nextSocket = async (sockets: Socket[]) => {
    const count = sockets.length;
    for (let waited = 0; sockets.length === count && waited < 15_000; waited += 50)
      await vi.advanceTimersByTimeAsync(50);
    expect(sockets.length).toBe(count + 1);
  };
  /** Fail the latest socket before it opens, then let the backoff create the next one. */
  const failLatest = async (sockets: Socket[]) => {
    (sockets.at(-1) as DeadOnArrivalSocket).fail();
    await nextSocket(sockets);
  };
  /** Open the latest socket, then lose it after it was up (no handshake evidence either way). */
  const openThenLose = async (sockets: Socket[]) => {
    sockets.at(-1)!.ready();
    sockets.at(-1)!.close(1006, "lost");
    await nextSocket(sockets);
  };

  it("survives a deploy: one pre-open failure costs one version 1 connection, never a latch", async () => {
    const { session, sockets, offers } = harness(DeadOnArrivalSocket);
    session.start();
    // The Hub restarts: the handshake offering the subprotocol fails (a 503 looks like this).
    await failLatest(sockets);
    expect(offers.slice(0, 2)).toEqual([V2, []]);
    // The Hub is back by the retry, which offered nothing: version 1 for this connection only.
    await openThenLose(sockets);
    // The next reconnect offers again, and it works: the suspicion is dropped.
    expect(offers[2]).toEqual(V2);
    sockets[2]!.readyV2();
    expect(session.serverMintedOpenAvailable()).toBe(true);
    sockets[2]!.close(1006, "lost");
    await nextSocket(sockets);
    expect(offers[3]).toEqual(V2);
    session.dispose();
  });

  it("latches only when the pattern repeats, and only for a bounded time", async () => {
    const { session, sockets, offers } = harness(DeadOnArrivalSocket);
    session.start();
    await failLatest(sockets); // offered: fails
    await openThenLose(sockets); // none: opens -> suspected
    expect(offers[2]).toEqual(V2); // confirm with the offer again
    await failLatest(sockets); // offered: fails again
    expect(offers[3]).toEqual([]);
    sockets[3]!.ready(); // none: opens again -> confirmed, latched
    expect(session.serverMintedOpenAvailable()).toBe(false);
    sockets[3]!.close(1006, "lost");
    await nextSocket(sockets);
    expect(offers[4]).toEqual([]); // inside the latch: no offer, no failed handshake first
    await openThenLose(sockets);
    expect(offers[5]).toEqual([]);
    // Only the clock moves past the latch (no timers run, so no heartbeat loss interferes).
    vi.setSystemTime(Date.now() + HUB_SESSION_SUBPROTOCOL_FALLBACK_MS);
    await openThenLose(sockets);
    expect(offers[6]).toEqual(V2); // expired: offering again
    expect(offers).toHaveLength(7);
    session.dispose();
  });

  it("treats a failure without the subprotocol too as an outage and drops all evidence", async () => {
    const { session, sockets, offers } = harness(DeadOnArrivalSocket);
    session.start();
    await failLatest(sockets); // offered: fails
    await openThenLose(sockets); // none: opens -> suspected
    await failLatest(sockets); // offered: fails
    await failLatest(sockets); // none: fails too -> an outage, not stripping
    expect(offers.slice(0, 5)).toEqual([V2, [], V2, [], V2]);
    sockets[4]!.readyV2();
    expect(session.serverMintedOpenAvailable()).toBe(true);
    session.dispose();
  });

  it("does not downgrade after a failure once the socket had opened", async () => {
    const { session, sockets, offers } = harness();
    session.start();
    sockets[0]!.readyV2();
    sockets[0]!.close(1006, "lost");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(offers).toEqual([V2, V2]);
    session.dispose();
  });
});
