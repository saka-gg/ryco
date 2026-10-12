import { describe, expect, it, vi } from "vite-plus/test";

import { BackendReadinessAbortedError, BackendReadinessTimeoutError } from "./backendReadiness.ts";
import { waitForBackendStartupReady } from "./backendStartupReadiness.ts";

describe("waitForBackendStartupReady", () => {
  it("accepts a living backend that becomes ready after the HTTP timeout", async () => {
    const listening = Promise.withResolvers<"listening">();
    const ready = waitForBackendStartupReady({
      readyPromise: listening.promise,
      waitForHttpReady: async () => {
        throw new BackendReadinessTimeoutError("http://localhost");
      },
      cancelHttpWait: vi.fn(),
    });
    await Promise.resolve();
    listening.resolve("listening");
    await expect(ready).resolves.toBe("listening");
  });

  it("still reports a child exit after the HTTP probe times out", async () => {
    const listening = Promise.withResolvers<"listening">();
    const ready = waitForBackendStartupReady({
      readyPromise: listening.promise,
      waitForHttpReady: async () => {
        throw new BackendReadinessTimeoutError("http://localhost");
      },
      cancelHttpWait: vi.fn(),
    });
    await Promise.resolve();
    listening.reject(new Error("backend exited"));
    await expect(ready).rejects.toThrow("backend exited");
  });

  it("falls back to the HTTP probe when no listening signal exists", async () => {
    const waitForHttpReady = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const cancelHttpWait = vi.fn();

    await expect(
      waitForBackendStartupReady({
        waitForHttpReady,
        cancelHttpWait,
      }),
    ).resolves.toBe("http");

    expect(waitForHttpReady).toHaveBeenCalledTimes(1);
    expect(cancelHttpWait).not.toHaveBeenCalled();
  });

  it("uses the listening signal and cancels the HTTP probe", async () => {
    let rejectHttpWait: ((error: unknown) => void) | null = null;
    const waitForHttpReady = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectHttpWait = reject;
        }),
    );
    const cancelHttpWait = vi.fn(() => {
      rejectHttpWait?.(new BackendReadinessAbortedError());
    });

    await expect(
      waitForBackendStartupReady({
        readyPromise: Promise.resolve("listening" as const),
        waitForHttpReady,
        cancelHttpWait,
      }),
    ).resolves.toBe("listening");

    expect(waitForHttpReady).toHaveBeenCalledTimes(1);
    expect(cancelHttpWait).toHaveBeenCalledTimes(1);
  });

  it("rejects when the listening signal fails before HTTP readiness", async () => {
    const error = new Error("backend exited");
    const waitForHttpReady = vi.fn(() => new Promise<void>(() => {}));
    const cancelHttpWait = vi.fn();

    await expect(
      waitForBackendStartupReady({
        readyPromise: Promise.reject(error),
        waitForHttpReady,
        cancelHttpWait,
      }),
    ).rejects.toBe(error);

    expect(cancelHttpWait).toHaveBeenCalledTimes(1);
  });

  it("starts the HTTP probe only as a delayed last resort", async () => {
    vi.useFakeTimers();
    try {
      const ready = Promise.withResolvers<"protocol">();
      const waitForHttpReady = vi.fn(() => new Promise<void>(() => {}));
      const cancelHttpWait = vi.fn();
      const result = waitForBackendStartupReady({
        readyPromise: ready.promise,
        waitForHttpReady,
        cancelHttpWait,
        httpFallbackDelayMs: 3_000,
      });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(waitForHttpReady).not.toHaveBeenCalled();
      ready.resolve("protocol");
      await expect(result).resolves.toBe("protocol");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(waitForHttpReady).not.toHaveBeenCalled();
      expect(cancelHttpWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the HTTP probe when no signal arrives within the fallback delay", async () => {
    vi.useFakeTimers();
    try {
      const waitForHttpReady = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const result = waitForBackendStartupReady({
        readyPromise: new Promise<"protocol">(() => {}),
        waitForHttpReady,
        cancelHttpWait: vi.fn(),
        httpFallbackDelayMs: 3_000,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toBe("http");
      expect(waitForHttpReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
