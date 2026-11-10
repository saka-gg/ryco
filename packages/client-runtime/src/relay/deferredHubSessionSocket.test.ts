import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDeferredHubSessionSocket,
  type EventWebSocketLike,
} from "./deferredHubSessionSocket.ts";

function platformSocket() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const sent: ArrayBuffer[] = [];
  const socket = {
    binaryType: "blob",
    bufferedAmount: 7,
    readyState: 0,
    sent,
    send: (data: ArrayBuffer) => sent.push(data),
    close: vi.fn(),
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (event: unknown) => void]);
    },
    emit: (type: string, event: unknown = {}) =>
      listeners.get(type)?.forEach((listener) => listener(event)),
  };
  return socket;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the deferred account session socket", () => {
  it("is CONNECTING until the upgrade is authorized, then replays listeners on the real socket", async () => {
    const real = platformSocket();
    let authorize!: (socket: EventWebSocketLike) => void;
    const socket = createDeferredHubSessionSocket(
      () => new Promise<EventWebSocketLike>((resolve) => (authorize = resolve)),
    );
    const opened = vi.fn();
    const messages: Uint8Array[] = [];
    const closed = vi.fn();
    socket.onOpen(opened);
    socket.onBinaryMessage((bytes) => messages.push(bytes));
    socket.onClose(closed);
    expect(socket.readyState).toBe(0);
    expect(() => socket.send(new Uint8Array(1))).toThrow();
    await settle();
    authorize(real);
    await settle();
    expect(real.binaryType).toBe("arraybuffer");
    expect(socket.bufferedAmount).toBe(7);
    real.emit("open");
    expect(opened).toHaveBeenCalledOnce();
    real.emit("message", { data: Uint8Array.of(1, 2, 3).buffer });
    expect(messages).toEqual([Uint8Array.of(1, 2, 3)]);
    // The session zeroes its frame after send: the socket got a copy.
    const frame = Uint8Array.of(9, 9);
    socket.send(frame);
    frame.fill(0);
    expect(new Uint8Array(real.sent[0]!)).toEqual(Uint8Array.of(9, 9));
    // Text is not a session frame.
    real.emit("message", { data: "text" });
    expect(real.close).toHaveBeenCalledWith(1002, "protocol_invalid");
    real.emit("close", { code: 4411, reason: "revoked" });
    expect(closed).toHaveBeenCalledWith("revoked", 4411);
  });

  it("fails with error then close when the upgrade cannot be authorized", async () => {
    const socket = createDeferredHubSessionSocket(() => Promise.reject(new Error("no token")));
    const order: string[] = [];
    socket.onError(() => order.push("error"));
    socket.onClose((reason, code) => order.push(`close ${code} ${reason}`));
    await settle();
    expect(order).toEqual(["error", "close 1006 unauthorized"]);
  });

  it("closes a socket that arrives after it was closed", async () => {
    const real = platformSocket();
    let authorize!: (socket: EventWebSocketLike) => void;
    const socket = createDeferredHubSessionSocket(
      () => new Promise<EventWebSocketLike>((resolve) => (authorize = resolve)),
    );
    const closed = vi.fn();
    socket.onClose(closed);
    await settle();
    socket.close(1000, "closed");
    expect(closed).toHaveBeenCalledWith("closed", 1000);
    authorize(real);
    await settle();
    expect(real.close).toHaveBeenCalledWith(1000, "closed");
  });
});
