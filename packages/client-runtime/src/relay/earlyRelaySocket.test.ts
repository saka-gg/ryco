import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EARLY_RELAY_SOCKET_TICKET_WAIT_MS,
  EarlyRelaySocket,
  type EarlyRelaySocketPorts,
  type EarlyRelaySocketSink,
  type EarlySocketLike,
} from "./earlyRelaySocket.ts";

const RELAY_URL = "wss://hub.example.test/v1/relay/client";
const HEADERS = { Authorization: "DPoP token", DPoP: "proof" };

class FakeSocket implements EarlySocketLike {
  binaryType = "blob";
  readyState = 0;
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
  readonly #listeners = new Map<string, Array<(event: never) => void>>();

  addEventListener = (type: string, listener: (event: never) => void) => {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  };

  close = (code?: number, reason?: string) => {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) });
    this.readyState = 3;
  };

  emit(type: string, event: object = {}): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }
}

let sockets: FakeSocket[];

function open(ports: Partial<EarlyRelaySocketPorts<FakeSocket>> = {}) {
  const createSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const early = new EarlyRelaySocket<FakeSocket>({
    url: RELAY_URL,
    prepareUpgradeHeaders: async () => HEADERS,
    createSocket,
    ...ports,
  });
  return { early, createSocket };
}

function recordingSink() {
  const events: unknown[] = [];
  const sink: EarlyRelaySocketSink = {
    open: () => events.push("open"),
    message: (data) => events.push(["message", data]),
    close: (reason) => events.push(["close", reason]),
    error: () => events.push("error"),
  };
  return { sink, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EarlyRelaySocket", () => {
  it("starts the upgrade with its headers before the ticket exists", async () => {
    const ticket = Promise.withResolvers<string>();
    const { early, createSocket } = open();
    // Nothing that can fail runs inside the constructor.
    expect(createSocket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(createSocket).toHaveBeenCalledExactlyOnceWith(RELAY_URL, HEADERS);
    expect(sockets[0]?.binaryType).toBe("arraybuffer");
    // The attempt adopts it once its ticket arrives.
    ticket.resolve("ticket");
    await ticket.promise;
    sockets[0]!.emit("open");
    const adopted = await early.adopt();
    expect(adopted?.socket).toBe(sockets[0]);
    expect(createSocket).toHaveBeenCalledOnce();
  });

  it("lets go of a socket that waited too long for its ticket", async () => {
    const { early } = open();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.emit("open");
    await vi.advanceTimersByTimeAsync(EARLY_RELAY_SOCKET_TICKET_WAIT_MS - 1);
    expect(sockets[0]!.closes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.closes).toEqual([{ code: 1000, reason: "closed" }]);
    await expect(early.adopt()).resolves.toBeNull();
    expect(sockets[0]!.closes).toHaveLength(1);
  });

  it("waits the platform's own bound through its own timers", async () => {
    const setTimer = vi.fn((callback: () => void, delayMs: number) =>
      globalThis.setTimeout(callback, delayMs),
    );
    const clearTimer = vi.fn((timer: unknown) =>
      globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    );
    const { early } = open({ ticketWaitMs: 500, setTimeout: setTimer, clearTimeout: clearTimer });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.emit("open");
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 500);
    const adopted = await early.adopt();
    expect(adopted?.socket).toBe(sockets[0]);
    expect(clearTimer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0]!.closes).toHaveLength(0);
  });

  it.each(["error", "close"] as const)(
    "discards a socket that reports %s before adoption",
    async (type) => {
      const { early } = open();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.emit("open");
      sockets[0]!.emit("message", { data: "early" });
      sockets[0]!.emit(type, { reason: "gone" });
      // A closed socket is not closed again; an errored one is.
      expect(sockets[0]!.closes).toHaveLength(type === "error" ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(early.adopt()).resolves.toBeNull();
      expect(sockets).toHaveLength(1);
    },
  );

  it("opens nothing when the upgrade headers cannot be prepared", async () => {
    const { early, createSocket } = open({
      prepareUpgradeHeaders: async () => {
        throw new Error("no proof");
      },
    });
    await expect(early.adopt()).resolves.toBeNull();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("opens nothing when discarded while its headers are prepared", async () => {
    const headers = Promise.withResolvers<Readonly<Record<string, string>>>();
    const { early, createSocket } = open({ prepareUpgradeHeaders: () => headers.promise });
    await vi.advanceTimersByTimeAsync(0);
    early.discard();
    headers.resolve(HEADERS);
    await expect(early.adopt()).resolves.toBeNull();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("is adopted by one attempt only, and a discard after that keeps it", async () => {
    const { early } = open();
    const first = await early.adopt();
    expect(first?.socket).toBe(sockets[0]);
    await expect(early.adopt()).resolves.toBeNull();
    early.discard();
    expect(sockets[0]!.closes).toHaveLength(0);
  });

  it("replays what happened before adoption once attached, then forwards", async () => {
    const { early } = open();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", { data: "first" });
    const adopted = await early.adopt();
    // Events between adoption and attach are held too.
    socket.emit("message", { data: "second" });
    socket.emit("error");
    socket.emit("close", { reason: "bye" });
    const { sink, events } = recordingSink();
    adopted!.attach(sink);
    expect(events).toEqual([
      "open",
      ["message", "first"],
      ["message", "second"],
      "error",
      ["close", "bye"],
    ]);
    socket.emit("message", { data: "after" });
    expect(events.at(-1)).toEqual(["message", "after"]);
    expect(socket.closes).toHaveLength(0);
  });

  it("forwards an open that happens after attach", async () => {
    const { early } = open();
    const adopted = await early.adopt();
    const { sink, events } = recordingSink();
    adopted!.attach(sink);
    expect(events).toEqual([]);
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", { data: "frame" });
    expect(events).toEqual(["open", ["message", "frame"]]);
    // No ticket wait runs for an adopted socket.
    expect(vi.getTimerCount()).toBe(0);
  });
});
