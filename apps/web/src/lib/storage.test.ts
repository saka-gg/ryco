import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createDebouncedStorage, createMemoryStorage } from "./storage";

describe("createDebouncedStorage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes a burst of deferred writes once, with the latest value", () => {
    vi.useFakeTimers();
    const base = createMemoryStorage();
    const storage = createDebouncedStorage(base, 300);
    const serialize = vi.fn((value: string) => value);

    for (const value of ["a", "ab", "abc"]) {
      storage.setItemDeferred("key", () => serialize(value));
    }
    expect(serialize).not.toHaveBeenCalled();
    expect(base.getItem("key")).toBeNull();

    vi.advanceTimersByTime(300);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(base.getItem("key")).toBe("abc");
  });

  it("serializes pending deferred writes on flush", () => {
    vi.useFakeTimers();
    const base = createMemoryStorage();
    const storage = createDebouncedStorage(base, 300);
    storage.setItemDeferred("key", () => "flushed");
    storage.flush();
    expect(base.getItem("key")).toBe("flushed");
  });

  it("drops a pending deferred write when the item is removed", () => {
    vi.useFakeTimers();
    const base = createMemoryStorage();
    const storage = createDebouncedStorage(base, 300);
    const serialize = vi.fn(() => "stale");
    storage.setItemDeferred("key", serialize);
    storage.removeItem("key");
    vi.advanceTimersByTime(300);
    expect(serialize).not.toHaveBeenCalled();
    expect(base.getItem("key")).toBeNull();
  });
});
