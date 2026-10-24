import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createStopRequestRegistry, type StopRequestReports } from "./agentStopRequests";

const TIMEOUT_MS = 20_000;

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function reports() {
  return {
    onUnconfirmed: vi.fn<StopRequestReports["onUnconfirmed"]>(),
    onFailed: vi.fn<StopRequestReports["onFailed"]>(),
  };
}

describe("createStopRequestRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one stop per agent until it is confirmed or times out", async () => {
    const registry = createStopRequestRegistry(TIMEOUT_MS);
    const listener = vi.fn();
    registry.subscribe(listener);
    const send = vi.fn(() => Promise.resolve());

    expect(registry.start("a", send, reports())).toBe(true);
    expect(registry.isPending("a")).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    // Another control for the same agent joins the pending stop.
    expect(registry.start("a", send, reports())).toBe(false);
    expect(registry.isPending("b")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    // The node taking the stop is not the agent stopping.
    expect(registry.isPending("a")).toBe(true);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(registry.isPending("a")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.start("a", send, reports())).toBe(true);
  });

  it("reports a stop that times out only while a control for it is shown", async () => {
    const registry = createStopRequestRegistry(TIMEOUT_MS);
    const shown = reports();
    const unwatch = registry.watch("a");
    registry.start("a", () => Promise.resolve(), shown);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(shown.onUnconfirmed).toHaveBeenCalledOnce();
    unwatch();
    // Unwatching twice must not hide another control's watch.
    const otherUnwatch = registry.watch("a");
    unwatch();

    // With every control gone, the agent has most likely settled.
    otherUnwatch();
    const gone = reports();
    registry.start("a", () => Promise.resolve(), gone);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(gone.onUnconfirmed).not.toHaveBeenCalled();
    expect(gone.onFailed).not.toHaveBeenCalled();
    expect(registry.isPending("a")).toBe(false);
  });

  it("reports a failure even once no control for it is shown", async () => {
    const registry = createStopRequestRegistry(TIMEOUT_MS);
    const failed = reports();
    const cause = new Error("refused");
    registry.start("a", () => Promise.reject(cause), failed);
    await vi.advanceTimersByTimeAsync(0);

    expect(failed.onFailed).toHaveBeenCalledExactlyOnceWith(cause);
    expect(registry.isPending("a")).toBe(false);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(failed.onUnconfirmed).not.toHaveBeenCalled();
  });

  it("reports a send that throws as a failure", async () => {
    const registry = createStopRequestRegistry(TIMEOUT_MS);
    const failed = reports();
    const cause = new Error("no api");
    registry.start(
      "a",
      () => {
        throw cause;
      },
      failed,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.onFailed).toHaveBeenCalledExactlyOnceWith(cause);
    expect(registry.isPending("a")).toBe(false);
  });

  it("still reports a failure that arrives after the timeout", async () => {
    const registry = createStopRequestRegistry(TIMEOUT_MS);
    const late = reports();
    const reply = deferred();
    registry.watch("a");
    registry.start("a", () => reply.promise, late);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(late.onUnconfirmed).toHaveBeenCalledOnce();

    const cause = new Error("stop-failed");
    reply.reject(cause);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.onFailed).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it("drops the late failure of a stop a retry replaced", async () => {
    const registry = createStopRequestRegistry(TIMEOUT_MS);
    const first = reports();
    const firstReply = deferred();
    registry.start("a", () => firstReply.promise, first);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const retry = reports();
    registry.start("a", () => new Promise<void>(() => {}), retry);

    firstReply.reject(new Error("old"));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.onFailed).not.toHaveBeenCalled();
    expect(retry.onFailed).not.toHaveBeenCalled();
    expect(registry.isPending("a")).toBe(true);
  });

  it("forgets every request when cleared", async () => {
    const registry = createStopRequestRegistry(TIMEOUT_MS);
    const cleared = reports();
    registry.watch("a");
    registry.start("a", () => Promise.resolve(), cleared);
    registry.clear();
    expect(registry.isPending("a")).toBe(false);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(cleared.onUnconfirmed).not.toHaveBeenCalled();
  });
});
