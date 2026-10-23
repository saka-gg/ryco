import { describe, expect, it, vi } from "vite-plus/test";

import { createQuitCleanupHandler } from "./quitCleanup.ts";
import { createSystemShutdownNotice } from "./quitConfirmation.ts";

describe("desktop quit cleanup", () => {
  it("holds repeated quit requests until backend shutdown finishes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(() => pending);
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({ cleanup, quit });
    const first = { preventDefault: vi.fn() };
    const repeated = { preventDefault: vi.fn() };
    handler(first);
    handler(repeated);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    finish();
    await pending;
    await Promise.resolve();
    expect(quit).toHaveBeenCalledOnce();
    const final = { preventDefault: vi.fn() };
    handler(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not intercept updater handoff after the backend has already stopped", () => {
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({ cleanup: () => undefined, quit });
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("allows the app to finish quitting if cleanup rejects", async () => {
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({
      cleanup: () => Promise.reject(new Error("backend already unavailable")),
      quit,
    });
    handler({ preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(quit).toHaveBeenCalledOnce();
  });
});

describe("desktop quit confirmation", () => {
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  it("asks before cleaning up and quits once confirmed", async () => {
    const answer = deferred<boolean>();
    const confirm = vi.fn((_signal: AbortSignal) => answer.promise);
    const cleanup = vi.fn(() => undefined);
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({ cleanup, quit, confirm });
    const first = { preventDefault: vi.fn() };
    handler(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(handler.confirming()).toBe(true);

    answer.resolve(true);
    await flush();
    expect(handler.confirming()).toBe(false);
    expect(quit).toHaveBeenCalledOnce();

    // The quit it starts cleans up without asking again.
    const confirmed = { preventDefault: vi.fn() };
    handler(confirmed);
    expect(confirm).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(confirmed.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps running when the person cancels, and asks again on the next quit", async () => {
    const confirm = vi.fn((_signal: AbortSignal) => Promise.resolve(false));
    const cleanup = vi.fn(() => undefined);
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({ cleanup, quit, confirm });
    handler({ preventDefault: vi.fn() });
    await flush();
    expect(quit).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(handler.confirming()).toBe(false);

    const again = { preventDefault: vi.fn() };
    handler(again);
    expect(again.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("absorbs repeated quits while asking and brings the dialog forward", () => {
    const confirm = vi.fn((_signal: AbortSignal) => new Promise<boolean>(() => undefined));
    const onAbsorbed = vi.fn();
    const handler = createQuitCleanupHandler({
      cleanup: vi.fn(() => undefined),
      quit: vi.fn(),
      confirm,
      onAbsorbed,
    });
    const first = { preventDefault: vi.fn() };
    const repeated = { preventDefault: vi.fn() };
    handler(first);
    handler(repeated);
    expect(confirm).toHaveBeenCalledOnce();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(onAbsorbed).toHaveBeenCalledOnce();
  });

  it("lets an urgent quit abort the open confirmation and clean up", async () => {
    const answer = deferred<boolean>();
    let signal: AbortSignal | null = null;
    const confirm = vi.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return answer.promise;
    });
    let urgent = false;
    const cleanup = vi.fn(() => undefined);
    const quit = vi.fn();
    const handler = createQuitCleanupHandler({
      cleanup,
      quit,
      confirm,
      mustQuitNow: () => urgent,
    });
    handler({ preventDefault: vi.fn() });
    expect(signal!.aborted).toBe(false);

    urgent = true;
    const urgentEvent = { preventDefault: vi.fn() };
    handler(urgentEvent);
    expect(signal!.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(urgentEvent.preventDefault).not.toHaveBeenCalled();
    expect(handler.confirming()).toBe(false);

    // The superseded answer changes nothing.
    answer.resolve(true);
    await flush();
    expect(quit).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("never asks on an urgent quit", () => {
    const confirm = vi.fn((_signal: AbortSignal) => Promise.resolve(false));
    const cleanup = vi.fn(() => undefined);
    const handler = createQuitCleanupHandler({
      cleanup,
      quit: vi.fn(),
      confirm,
      mustQuitNow: () => true,
    });
    handler({ preventDefault: vi.fn() });
    expect(confirm).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans up in the same event when there is nothing to ask", () => {
    const cleanup = vi.fn(() => undefined);
    const handler = createQuitCleanupHandler({
      cleanup,
      quit: vi.fn(),
      confirm: () => null,
    });
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(handler.confirming()).toBe(false);
  });

  it("quits when the confirmation rejects", async () => {
    const quit = vi.fn();
    const onConfirmError = vi.fn();
    const handler = createQuitCleanupHandler({
      cleanup: vi.fn(() => undefined),
      quit,
      confirm: () => Promise.reject(new Error("window destroyed")),
      onConfirmError,
    });
    handler({ preventDefault: vi.fn() });
    await flush();
    expect(quit).toHaveBeenCalledOnce();
    expect(onConfirmError).toHaveBeenCalledOnce();
  });

  it("cleans up in the same event when the confirmation throws synchronously", () => {
    const cleanup = vi.fn(() => undefined);
    const onConfirmError = vi.fn();
    const handler = createQuitCleanupHandler({
      cleanup,
      quit: vi.fn(),
      confirm: () => {
        throw new Error("webContents destroyed");
      },
      onConfirmError,
    });
    const event = { preventDefault: vi.fn() };
    expect(() => handler(event)).not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onConfirmError).toHaveBeenCalledOnce();
    expect(handler.confirming()).toBe(false);
  });

  it("asks again once a system shutdown notice has expired", () => {
    let nowMs = 0;
    const notice = createSystemShutdownNotice({ windowMs: 30_000, now: () => nowMs });
    const confirm = vi.fn((_signal: AbortSignal) => new Promise<boolean>(() => undefined));
    const cleanup = vi.fn(() => undefined);
    const handler = createQuitCleanupHandler({
      cleanup,
      quit: vi.fn(),
      confirm,
      mustQuitNow: notice.active,
    });
    notice.mark();
    nowMs = 30_001;
    handler({ preventDefault: vi.fn() });
    expect(confirm).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
