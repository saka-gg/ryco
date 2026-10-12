import { describe, expect, it, vi } from "vite-plus/test";

import { PREFETCH_HANDOFF_MS, SharedRequests } from "./sharedRequests.ts";

/** A request whose answer the test releases, recording the signal it ran with. */
function controllable() {
  const signals: AbortSignal[] = [];
  const settle: Array<(value: string) => void> = [];
  const fail: Array<(error: Error) => void> = [];
  const start = vi.fn(
    (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        signals.push(signal);
        settle.push(resolve);
        fail.push(reject);
      }),
  );
  return { start, signals, settle, fail };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("shared requests", () => {
  it("joins an identical in-flight request", async () => {
    const requests = new SharedRequests<string>();
    const request = controllable();
    const first = requests.request("key", request.start);
    const second = requests.request("key", request.start);
    expect(second).toBe(first);
    expect(request.start).toHaveBeenCalledTimes(1);
    request.settle[0]?.("answer");
    await expect(first).resolves.toBe("answer");
    // A settled request is not reused by a view's own request.
    void requests.request("key", request.start);
    expect(request.start).toHaveBeenCalledTimes(2);
  });

  it("hands a prefetched answer to one caller within the handoff window", async () => {
    let now = 0;
    const requests = new SharedRequests<string>({ now: () => now });
    const request = controllable();
    requests.prefetch("key", request.start);
    requests.prefetch("key", request.start);
    expect(request.start).toHaveBeenCalledTimes(1);
    request.settle[0]?.("prefetched");
    await flush();
    // Already answered: another prefetch asks nothing.
    requests.prefetch("key", request.start);
    expect(request.start).toHaveBeenCalledTimes(1);
    now = PREFETCH_HANDOFF_MS;
    await expect(requests.request("key", request.start)).resolves.toBe("prefetched");
    expect(request.start).toHaveBeenCalledTimes(1);
    void requests.request("key", request.start);
    expect(request.start).toHaveBeenCalledTimes(2);
  });

  it("does not hand off an expired, refused, failed, or refreshed answer", async () => {
    let now = 0;
    const requests = new SharedRequests<string>({ now: () => now, handoffMs: 100 });
    const request = controllable();

    requests.prefetch("expired", request.start);
    request.settle[0]?.("old");
    await flush();
    now = 101;
    void requests.request("expired", request.start);
    expect(request.start).toHaveBeenCalledTimes(2);

    requests.prefetch("refused", request.start, (value) => value !== "partial");
    request.settle[2]?.("partial");
    await flush();
    void requests.request("refused", request.start);
    expect(request.start).toHaveBeenCalledTimes(4);

    // A failed prefetch is retried by the view and never surfaces as unhandled.
    requests.prefetch("failed", request.start);
    request.fail[4]?.(new Error("offline"));
    await flush();
    void requests.request("failed", request.start);
    expect(request.start).toHaveBeenCalledTimes(6);

    requests.prefetch("refresh", request.start);
    request.settle[6]?.("prefetched");
    await flush();
    void requests.request("refresh", request.start, { fresh: true });
    expect(request.start).toHaveBeenCalledTimes(8);
  });

  it("aborts a request once every waiting caller abandoned it", () => {
    const requests = new SharedRequests<string>();
    const request = controllable();
    const first = new AbortController();
    const second = new AbortController();
    void requests.request("key", request.start, { signal: first.signal });
    void requests.request("key", request.start, { signal: second.signal });
    first.abort();
    expect(request.signals[0]?.aborted).toBe(false);
    second.abort();
    expect(request.signals[0]?.aborted).toBe(true);
    // The abandoned flight is not joined any more.
    void requests.request("key", request.start);
    expect(request.start).toHaveBeenCalledTimes(2);
  });

  it("keeps a request alive for a caller without a signal and for an unjoined prefetch", () => {
    const requests = new SharedRequests<string>();
    const request = controllable();
    const abandoned = new AbortController();
    void requests.request("pinned", request.start);
    void requests.request("pinned", request.start, { signal: abandoned.signal });
    abandoned.abort();
    expect(request.signals[0]?.aborted).toBe(false);

    requests.prefetch("prefetched", request.start);
    // An already-aborted caller neither joins nor cancels the prefetch.
    const late = new AbortController();
    late.abort();
    void requests.request("prefetched", request.start, { signal: late.signal });
    expect(request.signals[1]?.aborted).toBe(false);
  });

  it("lets a view that joined a prefetch withdraw it", () => {
    const requests = new SharedRequests<string>();
    const request = controllable();
    requests.prefetch("key", request.start);
    const view = new AbortController();
    void requests.request("key", request.start, { signal: view.signal });
    expect(request.start).toHaveBeenCalledTimes(1);
    view.abort();
    expect(request.signals[0]?.aborted).toBe(true);
  });

  it("drops a prefetch that was running when it was cleared", async () => {
    const requests = new SharedRequests<string>();
    const request = controllable();
    requests.prefetch("key", request.start);
    requests.clear();
    request.settle[0]?.("before clear");
    await flush();
    void requests.request("key", request.start);
    expect(request.start).toHaveBeenCalledTimes(2);
  });

  it("detaches from caller signals once the request settles", async () => {
    const requests = new SharedRequests<string>();
    const request = controllable();
    const view = new AbortController();
    const removeEventListener = vi.spyOn(view.signal, "removeEventListener");
    const pending = requests.request("key", request.start, { signal: view.signal });
    request.settle[0]?.("answer");
    await pending;
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    view.abort();
    expect(request.signals[0]?.aborted).toBe(false);
  });
});
