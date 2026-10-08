import { describe, expect, it, vi } from "vite-plus/test";

import { createSingleFlightReader } from "./singleFlightReader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlightReader", () => {
  it("runs one read at a time and coalesces refreshes into one trailing read", async () => {
    const first = deferred<number>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(2);
    const onValue = vi.fn();
    const reader = createSingleFlightReader({ read, onValue, onError: vi.fn() });

    const running = reader.refresh();
    void reader.refresh();
    void reader.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await running;

    expect(read).toHaveBeenCalledTimes(2);
    expect(onValue.mock.calls).toEqual([[1], [2]]);
  });

  it("hands the failure to onError and keeps serving later refreshes", async () => {
    const cause = new Error("offline");
    const read = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue("ok");
    const onValue = vi.fn();
    const onError = vi.fn();
    const reader = createSingleFlightReader({ read, onValue, onError });

    await reader.refresh();
    await reader.refresh();

    expect(onError).toHaveBeenCalledExactlyOnceWith(cause);
    expect(onValue).toHaveBeenCalledExactlyOnceWith("ok");
  });

  it("drops a read that was invalidated or finished after stop", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onValue = vi.fn();
    const reader = createSingleFlightReader({ read, onValue, onError: vi.fn() });

    const invalidated = reader.refresh();
    reader.invalidate();
    first.resolve("stale");
    await invalidated;
    expect(onValue).not.toHaveBeenCalled();

    const stopped = reader.refresh();
    reader.stop();
    second.resolve("late");
    await stopped;
    expect(onValue).not.toHaveBeenCalled();
    await reader.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
