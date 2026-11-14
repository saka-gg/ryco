import { RpcRequestRefusedError } from "@ryco/client-runtime/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { currentReadGuard, runWithReadRetry } from "./readRetry";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runWithReadRetry", () => {
  it("tries again 1 s, then 2 s later, and gives up after the last retry", async () => {
    const run = vi.fn(() => Promise.reject(new Error("offline")));
    const result = runWithReadRetry(run, 2);
    const settled = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(3);
    await expect(settled).resolves.toEqual(new Error("offline"));
  });

  it("returns the first successful answer", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce("refs");
    const result = runWithReadRetry(run, 3);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("refs");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not wait to retry a read the hosted session has not admitted yet", async () => {
    const refused = new RpcRequestRefusedError("awaiting-session");
    const run = vi.fn(() => Promise.reject(refused));
    await expect(runWithReadRetry(run, 3)).rejects.toBe(refused);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once its read is no longer the entry's current one", async () => {
    const controllers = new Map([["key", { fetchToken: 1 }]]);
    const isCurrent = currentReadGuard(controllers, "key");
    const run = vi.fn(() => Promise.reject(new Error("offline")));
    const settled = runWithReadRetry(run, 3, isCurrent).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    // A reconnect fences the read while it waits to retry.
    controllers.set("key", { fetchToken: 2 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(settled).resolves.toEqual(new Error("offline"));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
