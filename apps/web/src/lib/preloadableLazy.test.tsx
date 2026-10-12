import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { preloadableLazy } from "./preloadableLazy";

function Greeting({ name }: { readonly name: string }) {
  return <p>hello {name}</p>;
}

describe("preloadableLazy", () => {
  it("renders synchronously once preloaded, without suspending", async () => {
    const load = vi.fn(async () => Greeting);
    const LazyGreeting = preloadableLazy(load);

    expect(LazyGreeting.isLoaded()).toBe(false);
    await LazyGreeting.preload();

    expect(LazyGreeting.isLoaded()).toBe(true);
    // `renderToStaticMarkup` cannot wait for a suspension: rendering at all
    // proves the component did not throw a promise.
    expect(renderToStaticMarkup(<LazyGreeting name="ryco" />)).toBe("<p>hello ryco</p>");
    expect(load).toHaveBeenCalledOnce();
  });

  it("shares one load between concurrent preloads and resolves later preloads immediately", async () => {
    let resolveLoad: (component: typeof Greeting) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<typeof Greeting>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const LazyGreeting = preloadableLazy(load);

    const first = LazyGreeting.preload();
    const second = LazyGreeting.preload();
    expect(first).toBe(second);
    // The loader runs on a microtask, after the shared promise exists.
    await Promise.resolve();
    resolveLoad(Greeting);
    await first;

    await LazyGreeting.preload();
    expect(load).toHaveBeenCalledOnce();
  });

  it("never rejects from preload, surfaces the failure on render, and retries on the next preload", async () => {
    const failure = new Error("chunk failed");
    const load = vi
      .fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(Greeting);
    const LazyGreeting = preloadableLazy(load);

    await expect(LazyGreeting.preload()).resolves.toBeUndefined();
    expect(LazyGreeting.isLoaded()).toBe(false);
    expect(() => renderToStaticMarkup(<LazyGreeting name="ryco" />)).toThrow(failure);
    // A failed render does not start another load by itself.
    expect(load).toHaveBeenCalledOnce();

    await LazyGreeting.preload();
    expect(LazyGreeting.isLoaded()).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reports the settled failure until a retry starts", async () => {
    const failure = new Error("chunk failed");
    let resolveRetry: (component: typeof Greeting) => void = () => undefined;
    const load = vi
      .fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(
        () =>
          new Promise<typeof Greeting>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    const LazyGreeting = preloadableLazy(load);

    expect(LazyGreeting.loadFailure()).toBeNull();
    await LazyGreeting.preload();
    expect(LazyGreeting.loadFailure()?.error).toBe(failure);

    const retry = LazyGreeting.preload();
    // A retry in flight is not a failure.
    expect(LazyGreeting.loadFailure()).toBeNull();
    await Promise.resolve();
    resolveRetry(Greeting);
    await retry;
    expect(LazyGreeting.loadFailure()).toBeNull();
    expect(LazyGreeting.isLoaded()).toBe(true);
  });

  it("starts the load when rendered before any preload", () => {
    const load = vi.fn(() => new Promise<typeof Greeting>(() => undefined));
    const LazyGreeting = preloadableLazy(load);

    // The server renderer reports a suspension as an error; what matters is
    // that the render asked for the module.
    expect(() => renderToStaticMarkup(<LazyGreeting name="ryco" />)).toThrow();
    return Promise.resolve().then(() => {
      expect(load).toHaveBeenCalledOnce();
    });
  });
});
