import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createTaskConnectionDemand, type TaskDemandInput } from "./taskConnectionDemandModel";

const ids = ["a", "b", "c", "d", "e"].map((id) => EnvironmentId.make(`env-${id}`));
const [A, B, C, D, E] = ids as [
  EnvironmentId,
  EnvironmentId,
  EnvironmentId,
  EnvironmentId,
  EnvironmentId,
];

function harness() {
  const held = new Set<EnvironmentId>();
  let peak = 0;
  const demand = createTaskConnectionDemand({
    liveSlots: 2,
    rotationTimeoutMs: 20_000,
    retain: (environmentId) => {
      expect(held.has(environmentId)).toBe(false);
      held.add(environmentId);
      peak = Math.max(peak, held.size);
      return () => held.delete(environmentId);
    },
  });
  const readAt = new Map<EnvironmentId, number>();
  let now = 1_000;
  const base: TaskDemandInput = {
    active: true,
    authority: "account",
    wanted: ids,
    priority: new Set(),
    eligible: new Set(ids),
    connected: new Set(),
    failed: new Set(),
    readAt: (id) => readAt.get(id) ?? null,
    now,
  };
  return {
    held,
    peak: () => peak,
    readAt,
    tick: (ms: number) => {
      now += ms;
    },
    update: (input: Partial<TaskDemandInput> = {}) => demand.update({ ...base, now, ...input }),
    reset: demand.reset,
  };
}

describe("createTaskConnectionDemand", () => {
  it("holds live leases within the bound and reads every other machine one at a time", () => {
    const h = harness();
    expect(h.update()).toMatchObject({ live: [A, B], rotating: C });
    expect([...h.held]).toEqual([A, B, C]);

    h.tick(500);
    h.readAt.set(C, 1_400);
    expect(h.update()).toMatchObject({ live: [A, B], rotating: D });
    expect(h.held.has(C)).toBe(false);

    h.tick(500);
    h.readAt.set(D, 1_900);
    expect(h.update()).toMatchObject({ rotating: E });
    h.tick(500);
    h.readAt.set(E, 2_300);
    // Every machine was read: only the live ones stay connected for the rest of the visit.
    expect(h.update()).toEqual({ live: [A, B], rotating: null, checkAt: null });
    expect(h.peak()).toBe(3);
  });

  it("never asks for an offline, untrusted or directly paired machine", () => {
    const h = harness();
    expect(h.update({ eligible: new Set([B, D]) })).toMatchObject({ live: [B, D], rotating: null });
    expect([...h.held]).toEqual([B, D]);
  });

  it("does not take the cached read as this visit's read", () => {
    const h = harness();
    // Read from the device's copy earlier: older than the lease.
    h.readAt.set(C, 10);
    expect(h.update()).toMatchObject({ rotating: C });
    h.tick(100);
    expect(h.update()).toMatchObject({ rotating: C });
  });

  it("gives up on a slow or failed machine and moves on", () => {
    const h = harness();
    expect(h.update()).toMatchObject({ rotating: C, checkAt: 21_000 });
    h.tick(20_000);
    expect(h.update()).toMatchObject({ rotating: D });
    expect(h.update({ failed: new Set([D]) })).toMatchObject({ rotating: E });
  });

  it("puts the machine a surface needs into the live set, promoting a rotating read", () => {
    const h = harness();
    h.update();
    // B gives its slot to C and, unread, keeps its lease as the one read in turn.
    expect(h.update({ priority: new Set([C]) })).toMatchObject({ live: [A, C], rotating: B });
    h.readAt.set(B, 5_000);
    h.tick(5_000);
    expect(h.update({ priority: new Set([C]) })).toMatchObject({ live: [A, C], rotating: D });
    expect(h.peak()).toBe(3);
  });

  it("counts a machine that is connected anyway as live first", () => {
    const h = harness();
    expect(h.update({ connected: new Set([E]) })).toMatchObject({ live: [E, A], rotating: B });
  });

  it("releases everything when no surface shows, and reads afresh on the next visit", () => {
    const h = harness();
    h.update();
    h.readAt.set(C, 1_000);
    h.update();
    expect(h.update({ active: false })).toEqual({ live: [], rotating: null, checkAt: null });
    expect(h.held.size).toBe(0);
    h.tick(1_000);
    expect(h.update()).toMatchObject({ rotating: C });
  });

  it("starts over for another account", () => {
    const h = harness();
    h.update();
    expect(h.update({ authority: null })).toEqual({ live: [], rotating: null, checkAt: null });
    expect(h.held.size).toBe(0);
  });
});
