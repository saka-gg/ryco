import { describe, expect, it, vi } from "vite-plus/test";

import { BackendReadinessAbortedError, BackendReadinessTimeoutError } from "./backendReadiness.ts";
import { waitForBackendStartupReady } from "./backendStartupReadiness.ts";

describe("waitForBackendStartupReady", () => {
  it("accepts a living backend that becomes ready after the HTTP timeout", async () => {
    const listening = Promise.withResolvers<void>();
    const ready = waitForBackendStartupReady({
      listeningPromise: listening.promise,
      waitForHttpReady: async () => {
        throw new BackendReadinessTimeoutError("http://localhost");
      },
      cancelHttpWait: vi.fn(),
    });
    await Promise.resolve();
    listening.resolve();
    await expect(ready).resolves.toBe("listening");
  });

  it("still reports a child exit after the HTTP probe times out", async () => {
    const listening = Promise.withResolvers<void>();
    const ready = waitForBackendStartupReady({
      listeningPromise: listening.promise,
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
        listeningPromise: Promise.resolve(),
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
        listeningPromise: Promise.reject(error),
        waitForHttpReady,
        cancelHttpWait,
      }),
    ).rejects.toBe(error);

    expect(cancelHttpWait).toHaveBeenCalledTimes(1);
  });
});
