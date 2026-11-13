import { EnvironmentId, type StatisticsSnapshot } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { StatisticsSnapshotCache } from "./statisticsSnapshotCache.ts";

const nodeA = EnvironmentId.make("synthetic-node-a");
const nodeB = EnvironmentId.make("synthetic-node-b");

function snapshot(generatedAt: string): StatisticsSnapshot {
  return { generatedAt } as StatisticsSnapshot;
}

/** A fetch whose answer the test releases. */
function controllable(label: string) {
  const settle: Array<() => void> = [];
  const fetch = vi.fn(
    () =>
      new Promise<StatisticsSnapshot>((resolve) => {
        const call = settle.length + 1;
        settle.push(() => resolve(snapshot(`${label}-${call}`)));
      }),
  );
  return { fetch, settle };
}

describe("statistics snapshot cache", () => {
  it("keeps the last snapshot per environment and never hands one to another", async () => {
    const cache = new StatisticsSnapshotCache();
    const a = controllable("a");
    const b = controllable("b");
    const fromA = cache.load(nodeA, a.fetch);
    expect(cache.load(nodeA, a.fetch)).toBe(fromA);
    const fromB = cache.load(nodeB, b.fetch);
    expect(a.fetch).toHaveBeenCalledTimes(1);
    expect(b.fetch).toHaveBeenCalledTimes(1);
    a.settle[0]?.();
    await expect(fromA).resolves.toEqual(snapshot("a-1"));
    expect(cache.peek(nodeA)?.generatedAt).toBe("a-1");
    expect(cache.peek(nodeB)).toBeUndefined();
    b.settle[0]?.();
    await fromB;
    expect(cache.peek(nodeB)?.generatedAt).toBe("b-1");
  });

  it("keeps nothing for a request made before the environment was known", async () => {
    const cache = new StatisticsSnapshotCache();
    const unknown = controllable("unknown");
    const pending = cache.load(null, unknown.fetch);
    unknown.settle[0]?.();
    await expect(pending).resolves.toEqual(snapshot("unknown-1"));
    expect(cache.peek(null)).toBeUndefined();
  });

  it("does not let an answer in flight repopulate a forgotten environment", async () => {
    const cache = new StatisticsSnapshotCache();
    const a = controllable("a");
    await Promise.all([cache.load(nodeA, a.fetch), a.settle[0]?.()]);
    expect(cache.peek(nodeA)?.generatedAt).toBe("a-1");

    const late = cache.load(nodeA, a.fetch);
    cache.forget(nodeA);
    expect(cache.peek(nodeA)).toBeUndefined();
    a.settle[1]?.();
    await late;
    expect(cache.peek(nodeA)).toBeUndefined();

    // The forgotten flight is not shared with the next request.
    void cache.load(nodeA, a.fetch);
    expect(a.fetch).toHaveBeenCalledTimes(3);
  });

  it("clears every environment, including answers still in flight and prefetched", async () => {
    const cache = new StatisticsSnapshotCache();
    const a = controllable("a");
    const b = controllable("b");
    await Promise.all([cache.load(nodeA, a.fetch), a.settle[0]?.()]);
    cache.prefetch(nodeA, a.fetch);
    const pendingB = cache.load(nodeB, b.fetch);
    cache.clear();
    expect(cache.peek(nodeA)).toBeUndefined();
    a.settle[1]?.();
    b.settle[0]?.();
    await pendingB;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.peek(nodeA)).toBeUndefined();
    expect(cache.peek(nodeB)).toBeUndefined();
    // The prefetched answer is not handed to the next view either.
    void cache.load(nodeA, a.fetch);
    expect(a.fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps each scope apart and forgets or clears every scope of an environment", async () => {
    const cache = new StatisticsSnapshotCache();
    const ryco = controllable("ryco");
    const machine = controllable("machine");
    const fromRyco = cache.load(nodeA, ryco.fetch);
    const fromMachine = cache.load(nodeA, machine.fetch, { scope: "machine" });
    // Different scopes never share a flight.
    expect(fromMachine).not.toBe(fromRyco);
    expect(cache.load(nodeA, machine.fetch, { scope: "machine" })).toBe(fromMachine);
    ryco.settle[0]?.();
    await fromRyco;
    expect(cache.peek(nodeA)?.generatedAt).toBe("ryco-1");
    expect(cache.peek(nodeA, "ryco")?.generatedAt).toBe("ryco-1");
    expect(cache.peek(nodeA, "machine")).toBeUndefined();
    machine.settle[0]?.();
    await fromMachine;
    expect(cache.peek(nodeA, "machine")?.generatedAt).toBe("machine-1");
    expect(cache.peek(nodeA)?.generatedAt).toBe("ryco-1");

    // forget() drops every scope, and a machine answer in flight cannot repopulate it.
    const late = cache.load(nodeA, machine.fetch, { scope: "machine", fresh: true });
    cache.forget(nodeA);
    expect(cache.peek(nodeA)).toBeUndefined();
    expect(cache.peek(nodeA, "machine")).toBeUndefined();
    machine.settle[1]?.();
    await late;
    expect(cache.peek(nodeA, "machine")).toBeUndefined();

    // A prefetch for one scope is not handed to the other.
    cache.prefetch(nodeB, machine.fetch, "machine");
    const bRyco = controllable("b");
    void cache.load(nodeB, bRyco.fetch);
    expect(bRyco.fetch).toHaveBeenCalledTimes(1);
    machine.settle[2]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.peek(nodeB, "machine")?.generatedAt).toBe("machine-3");
    expect(cache.peek(nodeB)).toBeUndefined();
    cache.clear();
    expect(cache.peek(nodeB, "machine")).toBeUndefined();
  });
});
