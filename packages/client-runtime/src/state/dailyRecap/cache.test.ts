import {
  EnvironmentId,
  WS_METHODS,
  type DailyRecapRequest,
  type DailyRecapSnapshot,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RpcRequestRefusedError } from "../../rpc/protocol.ts";
import {
  DAILY_RECAP_NODE_TIMEOUT_MS,
  DailyRecapCache,
  readDailyRecapNode,
  type DailyRecapTarget,
} from "./cache.ts";

const nodeA = EnvironmentId.make("synthetic-node-a");
const nodeB = EnvironmentId.make("synthetic-node-b");
const today = { date: "2026-10-23", timeZone: "Europe/Berlin" } as DailyRecapRequest;
const yesterday = { date: "2026-10-22", timeZone: "Europe/Berlin", limit: 1 } as DailyRecapRequest;
const emptySection = { totalThreads: 0, threads: [], truncated: false };

function snapshot(request: DailyRecapRequest, completedTurns: number): DailyRecapSnapshot {
  return {
    date: request.date,
    timeZone: request.timeZone,
    generatedAt: "2026-10-23T12:00:00.000Z",
    from: "2026-10-22T22:00:00.000Z",
    to: "2026-10-23T22:00:00.000Z",
    counts: { completedTurns, failedTurns: 0, interruptedTurns: 0 },
    completed: emptySection,
    failed: emptySection,
    needsAttention: emptySection,
  };
}

/** A node whose answers the test releases: answer `n` reports `n` finished turns. */
function controllable(environmentId: EnvironmentId) {
  const calls: Array<{
    readonly request: DailyRecapRequest;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (snapshot: DailyRecapSnapshot) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  const getDailyRecap = vi.fn(
    (request: DailyRecapRequest, options?: { readonly signal?: AbortSignal }) =>
      new Promise<DailyRecapSnapshot>((resolve, reject) => {
        calls.push({ request, signal: options?.signal, resolve, reject });
      }),
  );
  const target: DailyRecapTarget = { environmentId, label: "Synthetic node", getDailyRecap };
  return {
    target,
    getDailyRecap,
    calls,
    answer: (call: number) => {
      const pending = calls[call - 1];
      pending?.resolve(snapshot(pending.request, call));
    },
    fail: (call: number, cause: unknown) => calls[call - 1]?.reject(cause),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("reading one node's daily recap", () => {
  it("returns the recap with the time it was asked for", async () => {
    const node = controllable(nodeA);
    const result = readDailyRecapNode(node.target, today, { now: () => 1_000 });
    node.answer(1);
    await expect(result).resolves.toEqual({
      environmentId: nodeA,
      label: "Synthetic node",
      requestedAtMs: 1_000,
      status: "ready",
      snapshot: snapshot(today, 1),
    });
    expect(node.getDailyRecap).toHaveBeenCalledWith(today, { signal: expect.any(AbortSignal) });
  });

  it("reports a node that does not answer in time as offline and withdraws the request", async () => {
    vi.useFakeTimers();
    const node = controllable(nodeA);
    let settled = false;
    const result = readDailyRecapNode(node.target, today).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DAILY_RECAP_NODE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ environmentId: nodeA, status: "offline" });
    expect(node.calls[0]?.signal?.aborted).toBe(true);
  });

  it("stops waiting when the caller gives up, even if the transport ignores the signal", async () => {
    const node = controllable(nodeA);
    const controller = new AbortController();
    const result = readDailyRecapNode(node.target, today, { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: "failed" });
    expect(node.calls[0]?.signal?.aborted).toBe(true);
  });

  it.each([
    [
      "a node that predates the recap",
      new Error(`Unknown request tag: ${WS_METHODS.serverGetDailyRecap}`),
      { status: "unsupported" },
    ],
    [
      "a node that refuses this session",
      { _tag: "AuthRpcError", message: "Only the owner can read this.", status: 403 },
      { status: "forbidden" },
    ],
    [
      "a session that is not ready yet",
      new RpcRequestRefusedError("awaiting-session"),
      { status: "offline" },
    ],
    [
      "a hosted role without access",
      new RpcRequestRefusedError("forbidden"),
      { status: "forbidden" },
    ],
    [
      "the node's own read error",
      {
        _tag: "DailyRecapReadError",
        reason: "invalid-time-zone",
        detail: "Choose a recognized IANA time zone.",
      },
      { status: "failed", message: "Choose a recognized IANA time zone." },
    ],
    [
      "a transport failure, without its text",
      new Error("WebSocket closed: wss://synthetic.invalid/ws"),
      { status: "failed", message: "Couldn't read the recap." },
    ],
  ])("classifies %s", async (_label, cause, expected) => {
    const node = controllable(nodeA);
    const result = readDailyRecapNode(node.target, today);
    node.fail(1, cause);
    const settled = await result;
    expect(settled).toMatchObject(expected);
    expect(settled).not.toHaveProperty("snapshot");
  });
});

describe("daily recap cache", () => {
  it("shares identical in-flight requests and keeps the last recap per node and day", async () => {
    const cache = new DailyRecapCache();
    const a = controllable(nodeA);
    const b = controllable(nodeB);
    const first = cache.load(a.target, today);
    const second = cache.load(a.target, { ...today });
    const ofYesterday = cache.load(a.target, yesterday);
    const ofB = cache.load(b.target, today);
    expect(a.getDailyRecap).toHaveBeenCalledTimes(2);
    expect(b.getDailyRecap).toHaveBeenCalledTimes(1);

    a.answer(1);
    expect(await first).toEqual(await second);
    expect(cache.peek(nodeA, today)?.snapshot.counts.completedTurns).toBe(1);
    expect(cache.peek(nodeA, yesterday)).toBeUndefined();
    expect(cache.peek(nodeB, today)).toBeUndefined();

    a.answer(2);
    b.answer(1);
    await Promise.all([ofYesterday, ofB]);
    expect(cache.peek(nodeA, yesterday)?.snapshot.date).toBe("2026-10-22");
    expect(cache.peek(nodeB, today)?.environmentId).toBe(nodeB);

    // A settled request is not reused: the next load asks the node again.
    void cache.load(a.target, today);
    expect(a.getDailyRecap).toHaveBeenCalledTimes(3);
    a.answer(3);
  });

  it("hands a prefetched recap to the view within the handoff window", async () => {
    let now = 0;
    const cache = new DailyRecapCache({ now: () => now });
    const a = controllable(nodeA);
    cache.prefetch(a.target, today);
    a.answer(1);
    await settle();
    await expect(cache.load(a.target, today)).resolves.toMatchObject({ status: "ready" });
    expect(a.getDailyRecap).toHaveBeenCalledTimes(1);

    cache.prefetch(a.target, today);
    a.answer(2);
    await settle();
    now += 30_001;
    const late = cache.load(a.target, today);
    expect(a.getDailyRecap).toHaveBeenCalledTimes(3);
    a.answer(3);
    await late;
  });

  it("skips a prefetched recap for a fresh answer, but joins a request in flight", async () => {
    const cache = new DailyRecapCache();
    const a = controllable(nodeA);
    cache.prefetch(a.target, today);
    a.answer(1);
    await settle();
    const fresh = cache.load(a.target, today, { fresh: true });
    expect(a.getDailyRecap).toHaveBeenCalledTimes(2);
    const joined = cache.load(a.target, today, { fresh: true });
    expect(a.getDailyRecap).toHaveBeenCalledTimes(2);
    a.answer(2);
    await expect(fresh).resolves.toMatchObject({ snapshot: { counts: { completedTurns: 2 } } });
    await expect(joined).resolves.toMatchObject({ snapshot: { counts: { completedTurns: 2 } } });
  });

  it("asks again once a request that was out before `sinceMs` settles", async () => {
    let now = 100;
    const cache = new DailyRecapCache({ now: () => now });
    const a = controllable(nodeA);
    const early = cache.load(a.target, today);
    now = 200;
    const afterCompletion = cache.load(a.target, today, { sinceMs: 150 });
    // Sent after `sinceMs`: joining it is enough.
    const joined = cache.load(a.target, today, { sinceMs: 50 });
    expect(a.getDailyRecap).toHaveBeenCalledTimes(1);

    a.answer(1);
    await expect(early).resolves.toMatchObject({ requestedAtMs: 100 });
    await expect(joined).resolves.toMatchObject({ requestedAtMs: 100 });
    await settle();
    expect(a.getDailyRecap).toHaveBeenCalledTimes(2);
    a.answer(2);
    await expect(afterCompletion).resolves.toMatchObject({
      requestedAtMs: 200,
      snapshot: { counts: { completedTurns: 2 } },
    });
  });

  it("keeps recaps only, never failures", async () => {
    const cache = new DailyRecapCache();
    const a = controllable(nodeA);
    const failed = cache.load(a.target, today);
    a.fail(1, new Error("offline"));
    await expect(failed).resolves.toMatchObject({ status: "failed" });
    expect(cache.peek(nodeA, today)).toBeUndefined();

    // A failed prefetch is not handed to the view either.
    cache.prefetch(a.target, today);
    a.fail(2, new Error("offline"));
    await settle();
    void cache.load(a.target, today);
    expect(a.getDailyRecap).toHaveBeenCalledTimes(3);
    a.answer(3);
  });

  it("evicts the least recently stored recap", async () => {
    const cache = new DailyRecapCache({ limit: 1 });
    const a = controllable(nodeA);
    const ofToday = cache.load(a.target, today);
    a.answer(1);
    await ofToday;
    const ofYesterday = cache.load(a.target, yesterday);
    a.answer(2);
    await ofYesterday;
    expect(cache.peek(nodeA, today)).toBeUndefined();
    expect(cache.peek(nodeA, yesterday)).toBeDefined();
  });

  it("does not let an answer in flight repopulate a forgotten node", async () => {
    const cache = new DailyRecapCache();
    const a = controllable(nodeA);
    const b = controllable(nodeB);
    const answered = cache.load(a.target, yesterday);
    a.answer(1);
    await answered;

    const late = cache.load(a.target, today);
    const ofB = cache.load(b.target, today);
    cache.forget(nodeA);
    expect(cache.peek(nodeA, yesterday)).toBeUndefined();
    a.answer(2);
    b.answer(1);
    await Promise.all([late, ofB]);
    expect(cache.peek(nodeA, today)).toBeUndefined();
    expect(cache.peek(nodeB, today)).toBeDefined();

    // The forgotten flight is not shared with the next request.
    void cache.load(a.target, today);
    expect(a.getDailyRecap).toHaveBeenCalledTimes(3);
    a.answer(3);
  });

  it("clears every node, including answers still in flight and prefetched", async () => {
    const cache = new DailyRecapCache();
    const a = controllable(nodeA);
    const b = controllable(nodeB);
    const answered = cache.load(a.target, today);
    a.answer(1);
    await answered;
    cache.prefetch(a.target, today);
    const pendingB = cache.load(b.target, today);
    cache.clear();
    expect(cache.peek(nodeA, today)).toBeUndefined();
    a.answer(2);
    b.answer(1);
    await pendingB;
    await settle();
    expect(cache.peek(nodeA, today)).toBeUndefined();
    expect(cache.peek(nodeB, today)).toBeUndefined();

    // The prefetched answer is not handed to the next view either.
    void cache.load(a.target, today);
    expect(a.getDailyRecap).toHaveBeenCalledTimes(3);
    a.answer(3);
  });
});
