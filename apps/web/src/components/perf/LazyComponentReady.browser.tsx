import { memo } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render, renderHook } from "vitest-browser-react";

import {
  preloadableLazy,
  useLazyComponentReady,
  usePreloadWhenIdle,
} from "../../lib/preloadableLazy";

/**
 * The Suspense-free mount path for on-demand surfaces (chat panels and
 * dialogs): a surface mounts only once its chunk has loaded, and a chunk that
 * fails to load is reported and retried on the next intent instead of leaving
 * the surface stuck.
 */
function Greeting() {
  return <p>hello</p>;
}

function failingOnceLoad(failure: Error) {
  return vi
    .fn<() => Promise<typeof Greeting>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(Greeting);
}

describe("useLazyComponentReady", () => {
  it("is ready in the first render once the component has loaded", async () => {
    const LazyGreeting = preloadableLazy(async () => Greeting);
    await LazyGreeting.preload();

    const renders: boolean[] = [];
    await renderHook(() => {
      const ready = useLazyComponentReady(LazyGreeting, true);
      renders.push(ready);
      return ready;
    });

    expect(renders[0]).toBe(true);
  });

  it("reports a handled failure instead of ready, and loads again through its retry", async () => {
    const failure = new Error("chunk failed");
    const load = failingOnceLoad(failure);
    const LazyGreeting = preloadableLazy(load);
    const onLoadError = vi.fn<(error: unknown, retry: () => void) => void>();

    const hook = await renderHook(() => useLazyComponentReady(LazyGreeting, true, { onLoadError }));

    await vi.waitFor(() => expect(onLoadError).toHaveBeenCalledOnce());
    expect(onLoadError.mock.calls[0]?.[0]).toBe(failure);
    expect(hook.result.current).toBe(false);
    expect(load).toHaveBeenCalledOnce();

    const retry = onLoadError.mock.calls[0]?.[1];
    await hook.act(() => retry?.());

    await vi.waitFor(() => expect(hook.result.current).toBe(true));
    expect(load).toHaveBeenCalledTimes(2);
    expect(onLoadError).toHaveBeenCalledOnce();
  });

  it("hands the failure to the caller's latest handler inside a memo component", async () => {
    // React 19.2 refreshes an effect event only in plain function components;
    // a memo caller's handler must still see its latest render.
    const LazyGreeting = preloadableLazy(failingOnceLoad(new Error("chunk failed")));
    const seen: Array<string | null> = [];
    const Surface = memo(function Surface({ target }: { readonly target: string | null }) {
      useLazyComponentReady(LazyGreeting, target !== null, {
        onLoadError: () => seen.push(target),
      });
      return null;
    });

    const screen = await render(<Surface target={null} />);
    await screen.rerender(<Surface target="item-202" />);

    await vi.waitFor(() => expect(seen).toEqual(["item-202"]));
  });

  it("loads again when the surface is wanted again after a handled failure", async () => {
    const LazyGreeting = preloadableLazy(failingOnceLoad(new Error("chunk failed")));
    const onLoadError = vi.fn<(error: unknown, retry: () => void) => void>();

    const hook = await renderHook(
      (props?: { readonly wanted: boolean }) =>
        useLazyComponentReady(LazyGreeting, props?.wanted ?? true, { onLoadError }),
      { initialProps: { wanted: true } },
    );
    await vi.waitFor(() => expect(onLoadError).toHaveBeenCalledOnce());

    await hook.rerender({ wanted: false });
    expect(hook.result.current).toBe(false);
    await hook.rerender({ wanted: true });

    await vi.waitFor(() => expect(hook.result.current).toBe(true));
    expect(LazyGreeting.isLoaded()).toBe(true);
  });

  it("without a handler reports ready after a failure so the mount throws to its error boundary", async () => {
    const failure = new Error("chunk failed");
    const LazyGreeting = preloadableLazy(failingOnceLoad(failure));

    const hook = await renderHook(() => useLazyComponentReady(LazyGreeting, true));

    await vi.waitFor(() => expect(hook.result.current).toBe(true));
    expect(LazyGreeting.isLoaded()).toBe(false);
    expect(LazyGreeting.loadFailure()?.error).toBe(failure);
  });

  it("does not carry one component's settled load over to the next one", async () => {
    const LazyFirst = preloadableLazy(async () => Greeting);
    const LazySecond = preloadableLazy(() => new Promise<typeof Greeting>(() => undefined));

    const hook = await renderHook(
      (props?: { readonly second: boolean }) =>
        useLazyComponentReady(props?.second ? LazySecond : LazyFirst, true),
      { initialProps: { second: false } },
    );
    await vi.waitFor(() => expect(hook.result.current).toBe(true));

    await hook.rerender({ second: true });

    expect(hook.result.current).toBe(false);
  });

  it("does not load while the surface is not wanted", async () => {
    const load = vi.fn(async () => Greeting);
    const LazyGreeting = preloadableLazy(load);

    const hook = await renderHook(() => useLazyComponentReady(LazyGreeting, false));

    expect(hook.result.current).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("usePreloadWhenIdle", () => {
  it("loads the component in an idle slot only while enabled", async () => {
    const load = vi.fn(async () => Greeting);
    const LazyGreeting = preloadableLazy(load);

    const hook = await renderHook(
      (props?: { readonly enabled: boolean }) =>
        usePreloadWhenIdle(LazyGreeting, props?.enabled ?? false),
      { initialProps: { enabled: false } },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(load).not.toHaveBeenCalled();

    await hook.rerender({ enabled: true });

    // An idle slot can take up to the idle task's 1 s deadline on a busy page.
    await vi.waitFor(() => expect(LazyGreeting.isLoaded()).toBe(true), { timeout: 3_000 });
    expect(load).toHaveBeenCalledOnce();
  });

  it("skips the speculative download on data saver", async () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true, effectiveType: "4g" },
    });
    try {
      const load = vi.fn(async () => Greeting);
      const LazyGreeting = preloadableLazy(load);

      await renderHook(() => usePreloadWhenIdle(LazyGreeting, true));
      // Longer than the idle task's 1 s deadline.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(load).not.toHaveBeenCalled();
    } finally {
      delete (navigator as { connection?: unknown }).connection;
    }
  });
});
