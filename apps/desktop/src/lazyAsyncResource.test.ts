import { describe, expect, it, vi } from "vite-plus/test";
import { lazyAsyncResource } from "./lazyAsyncResource.ts";

describe("lazy native resources", () => {
  it("shares concurrent initialization without prompting before first use", async () => {
    const resource = {};
    const create = vi.fn(async () => resource);
    const get = lazyAsyncResource(create);
    expect(create).not.toHaveBeenCalled();
    const first = get();
    expect(get()).toBe(first);
    expect(await first).toBe(resource);
    expect(await get()).toBe(resource);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("allows one new attempt after an unavailable credential store recovers", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("locked")).mockResolvedValue({});
    const get = lazyAsyncResource(create);
    const first = get();
    expect(get()).toBe(first);
    await expect(first).rejects.toThrow("locked");
    const retry = get();
    expect(get()).toBe(retry);
    await retry;
    expect(create).toHaveBeenCalledTimes(2);
  });
});
