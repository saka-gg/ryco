import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeCachedTailscaleStatusReader } from "./endpoints.ts";
import type { TailscaleStatus } from "./tailscale.ts";

const status: TailscaleStatus = {
  magicDnsName: "box.tail.ts.net",
  tailnetIpv4Addresses: [],
  tailnetAddresses: [],
};

describe("makeCachedTailscaleStatusReader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks again after five seconds when there was no status", async () => {
    const read = vi.fn().mockResolvedValue(null);
    const cached = makeCachedTailscaleStatusReader(read);

    await cached();
    await cached();
    expect(read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);
    await cached();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a real status for a minute", async () => {
    const read = vi.fn().mockResolvedValue(status);
    const cached = makeCachedTailscaleStatusReader(read);

    await cached();
    vi.advanceTimersByTime(5_001);
    await cached();
    expect(read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(55_000);
    await cached();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("asks again after five seconds when the read failed", async () => {
    const read = vi.fn().mockRejectedValue(new Error("spawn failed"));
    const cached = makeCachedTailscaleStatusReader(read);

    await expect(cached()).rejects.toThrow("spawn failed");
    await expect(cached()).rejects.toThrow("spawn failed");
    expect(read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);
    await expect(cached()).rejects.toThrow("spawn failed");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
