import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

import { appLocalStorage, useLocalStorage } from "../hooks/useLocalStorage";

const KEY = "ryco:test:use-local-storage";

afterEach(() => {
  vi.restoreAllMocks();
  appLocalStorage.removeItem(KEY);
});

describe("useLocalStorage", () => {
  it("applies several functional updates before a render and writes each once", async () => {
    const setItem = vi.spyOn(appLocalStorage, "setItem");
    const hook = await renderHook(() => useLocalStorage(KEY, 0, Schema.Number));

    await hook.act(() => {
      const [, setValue] = hook.result.current;
      setValue((value) => value + 1);
      setValue((value) => value + 1);
    });

    expect(hook.result.current[0]).toBe(2);
    expect(appLocalStorage.getItem(KEY)).toBe("2");
    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toEqual([
      [KEY, "1"],
      [KEY, "2"],
    ]);
  });

  it("keeps the value in memory and logs when storage refuses the write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(appLocalStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const hook = await renderHook(() => useLocalStorage(KEY, "a", Schema.String));

    await hook.act(() => hook.result.current[1]("b"));

    expect(hook.result.current[0]).toBe("b");
    expect(error).toHaveBeenCalledWith("[LOCALSTORAGE] Error:", expect.any(DOMException));
  });

  it("does not re-subscribe when a caller passes a fresh default each render", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const schema = Schema.Struct({ keys: Schema.Array(Schema.String) });
    const hook = await renderHook(() => useLocalStorage(KEY, { keys: [] }, schema));
    const subscriptions = () =>
      addEventListener.mock.calls.filter(([type]) => type === "storage").length;
    const afterMount = subscriptions();

    await hook.rerender();
    await hook.rerender();

    expect(subscriptions()).toBe(afterMount);
    expect(hook.result.current[0]).toEqual({ keys: [] });
  });

  it("re-reads storage, falling back to the latest default, when the key changes", async () => {
    appLocalStorage.setItem(KEY, JSON.stringify("stored"));
    let key = "ryco:test:use-local-storage:other";
    let fallback = "first";
    const hook = await renderHook(() => useLocalStorage(key, fallback, Schema.String));
    expect(hook.result.current[0]).toBe("first");

    key = KEY;
    fallback = "second";
    await hook.rerender();
    await expect.poll(() => hook.result.current[0]).toBe("stored");

    key = "ryco:test:use-local-storage:missing";
    await hook.rerender();
    await expect.poll(() => hook.result.current[0]).toBe("second");
  });
});
