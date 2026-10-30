import { EnvironmentId, type DesktopWorkspaceTransportEvent } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopWorkspaceIpcSocketFactory } from "./desktopWorkspaceSocket";

describe("DesktopWorkspaceIpcSocketFactory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a fresh opaque handle and carries only authorized RPC bytes", async () => {
    let listener: ((event: DesktopWorkspaceTransportEvent) => void) | undefined;
    const activate = vi.fn(async () => ({ ok: true }) as const);
    const send = vi.fn();
    const close = vi.fn();
    const bridge = {
      prepareDesktopWorkspaceTransport: vi.fn(async () => ({ transportId: "A".repeat(32) })),
      activateDesktopWorkspaceTransport: activate,
      sendDesktopWorkspaceTransport: send,
      closeDesktopWorkspaceTransport: close,
      onDesktopWorkspaceTransportEvent: vi.fn((next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
    };
    const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("env_remote"), bridge);
    const url = await factory.nextUrl();
    const socket = factory.createSocket(url);
    const opened = vi.fn();
    const message = vi.fn();
    socket.addEventListener("open", opened);
    socket.addEventListener("message", message);
    await Promise.resolve();
    expect(activate).toHaveBeenCalledWith("A".repeat(32));

    listener?.({ type: "open", transportId: "A".repeat(32) });
    socket.send(new Uint8Array([1, 2, 3]));
    listener?.({ type: "message", transportId: "A".repeat(32), data: new Uint8Array([4, 5]) });

    expect(opened).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("A".repeat(32), new Uint8Array([1, 2, 3]));
    expect(message.mock.calls[0]?.[0].data).toEqual(new Uint8Array([4, 5]));
    socket.close();
    expect(close).toHaveBeenCalledWith("A".repeat(32));
    expect(() => factory.createSocket(url)).toThrow("fresh opaque handle");
    expect(JSON.stringify(bridge)).not.toContain("ticket");
  });

  it("fails closed on a refusal reported as a value, backing off across refusals", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let sequence = 0;
    const bridge = {
      prepareDesktopWorkspaceTransport: vi.fn(async () => ({
        transportId: String(++sequence).padStart(32, "D"),
      })),
      activateDesktopWorkspaceTransport: vi.fn(
        async () => ({ ok: false, reason: "unavailable" }) as const,
      ),
      sendDesktopWorkspaceTransport: vi.fn(),
      closeDesktopWorkspaceTransport: vi.fn(),
      onDesktopWorkspaceTransportEvent: vi.fn(() => () => undefined),
    };
    const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("env_remote"), bridge);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const socket = factory.createSocket(await factory.nextUrl());
      const closes = vi.fn();
      socket.addEventListener("close", closes);
      await Promise.resolve();
      await Promise.resolve();
      expect(closes.mock.calls[0]?.[0]).toMatchObject({ code: 4401, reason: "Relay unavailable" });
      expect(socket.readyState).toBe(socket.CLOSED);
      factory.lifecycleHandlers.onClose!(
        { code: 4401, reason: "Relay unavailable" },
        { intentional: false },
      );
      delays.push(factory.lifecycleHandlers.getReconnectDelayMs!(attempt));
    }
    // Exponential: 1 s, 2 s, 4 s, 8 s (no jitter at random = 0.5).
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("fails closed when main refuses activation", async () => {
    const bridge = {
      prepareDesktopWorkspaceTransport: vi.fn(async () => ({ transportId: "B".repeat(32) })),
      activateDesktopWorkspaceTransport: vi.fn(async () => {
        throw new Error("sensitive internal detail");
      }),
      sendDesktopWorkspaceTransport: vi.fn(),
      closeDesktopWorkspaceTransport: vi.fn(),
      onDesktopWorkspaceTransportEvent: vi.fn(() => () => undefined),
    };
    const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("env_remote"), bridge);
    const socket = factory.createSocket(await factory.nextUrl());
    const errors = vi.fn();
    const closes = vi.fn();
    socket.addEventListener("error", errors);
    socket.addEventListener("close", closes);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveBeenCalledOnce();
    expect(closes.mock.calls[0]?.[0]).toMatchObject({ code: 4401, reason: "Relay unavailable" });
    expect(JSON.stringify(closes.mock.calls)).not.toContain("sensitive internal detail");
  });
});

function socketFixture() {
  let listener: ((event: DesktopWorkspaceTransportEvent) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const bridge = {
    prepareDesktopWorkspaceTransport: vi.fn(async () => ({ transportId: "C".repeat(32) })),
    activateDesktopWorkspaceTransport: vi.fn(async () => ({ ok: true }) as const),
    closeDesktopWorkspaceTransport: vi.fn(),
    onDesktopWorkspaceTransportEvent: vi.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
  };
  const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("remote"), bridge);
  return {
    factory,
    bridge,
    unsubscribe,
    emit: (event: DesktopWorkspaceTransportEvent) => listener?.(event),
  };
}

describe("desktop transport recovery", () => {
  it("closes locally before activation and detaches its IPC listener without an acknowledgement", async () => {
    const f = socketFixture();
    const socket = f.factory.createSocket(await f.factory.nextUrl());
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    socket.close();
    socket.close();
    await Promise.resolve();
    expect(socket.readyState).toBe(socket.CLOSED);
    expect(f.bridge.activateDesktopWorkspaceTransport).not.toHaveBeenCalled();
    expect(f.bridge.closeDesktopWorkspaceTransport).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("keeps a nonzero capped backoff well beyond seven failures and isolates primary status", () => {
    const { lifecycleHandlers: policy } = socketFixture().factory;
    expect(policy.persistentReconnect).toBe(true);
    expect(policy.recordGlobalConnectionState).toBe(false);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const delay = policy.getReconnectDelayMs!(attempt);
      expect(delay).toBeGreaterThanOrEqual(250);
      expect(delay).toBeLessThanOrEqual(60_000);
    }
  });

  it("honors server retry hints and stops terminal refusals until an explicit new session", async () => {
    const f = socketFixture();
    f.factory.createSocket(await f.factory.nextUrl());
    f.emit({
      type: "close",
      transportId: "C".repeat(32),
      code: 4429,
      reason: "Try later",
      retryable: true,
      retryAfterMs: 90_000,
    });
    expect(f.factory.lifecycleHandlers.getReconnectDelayMs!(0)).toBe(90_000);
    f.factory.createSocket(await f.factory.nextUrl());
    f.emit({
      type: "close",
      transportId: "C".repeat(32),
      code: 4406,
      reason: "Update required",
      retryable: false,
    });
    expect(f.factory.lifecycleHandlers.shouldReconnect!()).toBe(false);
    await expect(f.factory.nextUrl()).rejects.toThrow("requires attention");
    expect(f.bridge.prepareDesktopWorkspaceTransport).toHaveBeenCalledTimes(2);
    f.factory.lifecycleHandlers.onSessionStart!();
    expect(f.factory.lifecycleHandlers.shouldReconnect!()).toBe(true);
    await f.factory.nextUrl();
    expect(f.bridge.prepareDesktopWorkspaceTransport).toHaveBeenCalledTimes(3);
    f.factory.lifecycleHandlers.onDispose!();
  });

  it("releases a handle prepared after disposal without activating it", async () => {
    const f = socketFixture();
    let complete!: (value: { transportId: string }) => void;
    f.bridge.prepareDesktopWorkspaceTransport.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const pending = f.factory.nextUrl();
    f.factory.lifecycleHandlers.onDispose!();
    complete({ transportId: "late" });
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.bridge.closeDesktopWorkspaceTransport).toHaveBeenCalledExactlyOnceWith("late");
    expect(f.bridge.activateDesktopWorkspaceTransport).not.toHaveBeenCalled();
  });
});

describe("desktop transport frame buffers", () => {
  async function openSocket() {
    const transportId = "E".repeat(32);
    let listener: ((event: DesktopWorkspaceTransportEvent) => void) | undefined;
    const send = vi.fn();
    const bridge = {
      prepareDesktopWorkspaceTransport: vi.fn(async () => ({ transportId })),
      activateDesktopWorkspaceTransport: vi.fn(async () => ({ ok: true }) as const),
      sendDesktopWorkspaceTransport: send,
      closeDesktopWorkspaceTransport: vi.fn(),
      onDesktopWorkspaceTransportEvent: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    };
    const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("remote"), bridge);
    const socket = factory.createSocket(await factory.nextUrl());
    listener?.({ type: "open", transportId });
    return {
      socket,
      send,
      deliver: (data: Uint8Array) => listener?.({ type: "message", transportId, data }),
    };
  }

  it("sends bytes that span their buffer without copying them", async () => {
    const { socket, send } = await openSocket();
    const frame = Uint8Array.of(1, 2, 3);
    socket.send(frame);
    socket.send(frame.buffer);

    for (const [, sent] of send.mock.calls) {
      expect(sent).toEqual(frame);
      expect(sent.buffer).toBe(frame.buffer);
    }
  });

  it("copies a view onto part of a larger buffer so only its own bytes are sent", async () => {
    const { socket, send } = await openSocket();
    const backing = Uint8Array.of(9, 9, 1, 2, 3, 9, 9);
    socket.send(backing.subarray(2, 5));
    backing.fill(0);

    const sent = send.mock.calls[0]?.[1] as Uint8Array;
    expect(sent).toEqual(Uint8Array.of(1, 2, 3));
    expect(sent.buffer.byteLength).toBe(3);
    expect(sent.buffer).not.toBe(backing.buffer);
  });

  it("encodes text payloads into their own exact-size buffer", async () => {
    const { socket, send } = await openSocket();
    socket.send("abc");

    const sent = send.mock.calls[0]?.[1] as Uint8Array;
    expect(sent).toEqual(new TextEncoder().encode("abc"));
    expect(sent.buffer.byteLength).toBe(3);
  });

  it("hands received bytes to listeners as delivered", async () => {
    const { socket, deliver } = await openSocket();
    const message = vi.fn();
    socket.addEventListener("message", message);
    const frame = Uint8Array.of(4, 5, 6);
    deliver(frame);

    expect(message.mock.calls[0]?.[0].data).toBe(frame);
  });

  describe("routes", () => {
    function relayBridge() {
      return {
        prepareDesktopWorkspaceTransport: vi.fn(async () => ({ transportId: "R".repeat(32) })),
        activateDesktopWorkspaceTransport: vi.fn(async () => ({ ok: true }) as const),
        sendDesktopWorkspaceTransport: vi.fn(),
        closeDesktopWorkspaceTransport: vi.fn(),
        onDesktopWorkspaceTransportEvent: vi.fn(() => () => undefined),
      };
    }

    class FakeWebSocket {
      static created: FakeWebSocket[] = [];
      binaryType = "blob";
      constructor(readonly url: string) {
        FakeWebSocket.created.push(this);
      }
    }

    it("takes a linked direct route that answered, and never asks main for a relay handle", async () => {
      vi.stubGlobal("WebSocket", FakeWebSocket);
      FakeWebSocket.created = [];
      const bridge = relayBridge();
      const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("env_hub"), bridge, {
        resolve: async () => ({
          routeKey: "http://192.168.1.20:3773",
          url: "ws://192.168.1.20:3773/ws?wsToken=t",
        }),
      });

      const url = await factory.nextUrl();
      const socket = factory.createSocket(url) as unknown as FakeWebSocket;

      expect(url).toBe("ws://192.168.1.20:3773/ws?wsToken=t");
      expect(socket).toBe(FakeWebSocket.created[0]);
      expect(socket.binaryType).toBe("arraybuffer");
      expect(factory.activeRoute).toBe("http://192.168.1.20:3773");
      expect(bridge.prepareDesktopWorkspaceTransport).not.toHaveBeenCalled();
      expect(factory.lifecycleHandlers.isSocketCurrent?.(socket as never)).toBe(true);
      vi.unstubAllGlobals();
    });

    it("falls back to the relay when no direct route answers", async () => {
      const bridge = relayBridge();
      const resolve = vi.fn(async () => null);
      const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("env_hub"), bridge, {
        resolve,
      });

      const url = await factory.nextUrl();
      factory.createSocket(url);

      expect(resolve).toHaveBeenCalledOnce();
      expect(url).toBe(`ws://desktop-workspace.invalid/${"R".repeat(32)}`);
      expect(factory.activeRoute).toBe("relay");
    });

    it("abandons a route walk that a new session overtook", async () => {
      const bridge = relayBridge();
      let answer!: (value: { routeKey: string; url: string } | null) => void;
      let seen: AbortSignal | undefined;
      const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("env_hub"), bridge, {
        resolve: (signal) => {
          seen = signal;
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      });

      const pending = factory.nextUrl();
      factory.lifecycleHandlers.onSessionStart?.();
      expect(seen?.aborted).toBe(true);
      answer({ routeKey: "http://192.168.1.20:3773", url: "ws://192.168.1.20:3773/ws" });

      await expect(pending).rejects.toThrow("cancelled");
      expect(() => factory.createSocket("ws://192.168.1.20:3773/ws")).toThrow();
    });

    it("refuses a socket for any URL but the one its walk chose", async () => {
      const factory = new DesktopWorkspaceIpcSocketFactory(
        EnvironmentId.make("env_hub"),
        relayBridge(),
        { resolve: async () => ({ routeKey: "k", url: "ws://192.168.1.20:3773/ws?wsToken=t" }) },
      );
      await factory.nextUrl();
      expect(() => factory.createSocket("ws://evil.example/ws")).toThrow("route changed");
    });

    it("takes no direct route around the relay's refusal until the relay accepts the machine again", async () => {
      let listener: ((event: DesktopWorkspaceTransportEvent) => void) | undefined;
      let sequence = 0;
      const bridge = {
        ...relayBridge(),
        prepareDesktopWorkspaceTransport: vi.fn(async () => ({
          transportId: String(++sequence).padStart(32, "R"),
        })),
        onDesktopWorkspaceTransportEvent: vi.fn((next) => {
          listener = next;
          return () => undefined;
        }),
      };
      const resolve = vi.fn(async (): Promise<{ routeKey: string; url: string } | null> => ({
        routeKey: "http://100.64.1.20:3773",
        url: "ws://100.64.1.20:3773/ws?wsToken=t",
      }));
      const factory = new DesktopWorkspaceIpcSocketFactory(EnvironmentId.make("env_hub"), bridge, {
        resolve,
      });
      // The first attempt fell back to the relay, which then ended the machine for good.
      resolve.mockResolvedValueOnce(null);
      const relayUrl = await factory.nextUrl();
      factory.createSocket(relayUrl);
      await Promise.resolve();
      listener?.({
        type: "close",
        transportId: "1".padStart(32, "R"),
        code: 4403,
        reason: "authorization withdrawn",
        retryable: false,
      } as DesktopWorkspaceTransportEvent);
      expect(factory.mayUpgrade).toBe(false);

      // An explicit new session (the user's Reconnect) still goes to the relay first.
      factory.lifecycleHandlers.onSessionStart?.();
      expect(factory.mayUpgrade).toBe(false);
      const next = await factory.nextUrl();
      expect(next).toBe(`ws://desktop-workspace.invalid/${"2".padStart(32, "R")}`);
      expect(resolve).toHaveBeenCalledTimes(1);

      // Once the relay takes the machine again, direct routes are back.
      factory.createSocket(next);
      factory.lifecycleHandlers.onOpen?.();
      expect(factory.mayUpgrade).toBe(true);
      expect(await factory.nextUrl()).toBe("ws://100.64.1.20:3773/ws?wsToken=t");
    });
  });
});
