import { EnvironmentId, type DesktopWorkspaceTransportEvent } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import { DesktopWorkspaceIpcSocketFactory } from "./desktopWorkspaceSocket";

describe("DesktopWorkspaceIpcSocketFactory", () => {
  it("uses a fresh opaque handle and carries only authorized RPC bytes", async () => {
    let listener: ((event: DesktopWorkspaceTransportEvent) => void) | undefined;
    const activate = vi.fn(async () => undefined);
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
    activateDesktopWorkspaceTransport: vi.fn(async () => undefined),
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
