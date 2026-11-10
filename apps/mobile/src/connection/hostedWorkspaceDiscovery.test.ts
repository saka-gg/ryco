import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";

import {
  createHostedWorkspaceDiscovery,
  type HostedWorkspaceDiscoveryCandidate,
} from "./hostedWorkspaceDiscovery";

const candidates = Array.from({ length: 5 }, (_, index) => ({
  environmentId: EnvironmentId.make(`env_${index}`),
  eligible: true,
  ready: false,
  failed: false,
}));

function fixture(limit = 1) {
  const retained = new Set<EnvironmentId>();
  const retain = vi.fn((environmentId: EnvironmentId) => {
    retained.add(environmentId);
    return () => retained.delete(environmentId);
  });
  const discovery = createHostedWorkspaceDiscovery(retain, limit);
  const update = (
    nodes: ReadonlyArray<HostedWorkspaceDiscoveryCandidate> = candidates,
    active = true,
    authority: string | null = "account-a",
  ) => discovery.update({ authority, active, candidates: nodes });
  return { discovery, update, retained, retain };
}

describe("hosted Home workspace discovery", () => {
  it("visits every machine without selection and never cycles after earlier snapshots are evicted", () => {
    const f = fixture();
    f.update();
    for (const candidate of candidates) {
      expect([...f.retained]).toEqual([candidate.environmentId]);
      // Only the latest machine is live; earlier snapshots have become cached.
      f.update(candidates.map((node) => ({ ...node, ready: node === candidate })));
    }
    f.update();
    expect(f.retained.size).toBe(0);
    expect(f.retain.mock.calls.map(([id]) => id)).toEqual(
      candidates.map((node) => node.environmentId),
    );
  });

  it("ignores ineligible machines, skips already-current snapshots and moves past a failure", () => {
    const f = fixture();
    const nodes = candidates.map((node, index) => ({
      ...node,
      eligible: index !== 0,
      ready: index === 1,
    }));
    f.update(nodes);
    expect([...f.retained]).toEqual([candidates[2]!.environmentId]);
    f.update(nodes.map((node, index) => ({ ...node, failed: index === 2 })));
    expect([...f.retained]).toEqual([candidates[3]!.environmentId]);
    f.update(nodes);
    expect([...f.retained]).toEqual([candidates[3]!.environmentId]);
  });

  it("releases discovery when covered or backgrounded and refreshes on the next Home visit", () => {
    const f = fixture();
    f.update();
    f.update(candidates, false);
    expect(f.retained.size).toBe(0);
    f.update();
    expect([...f.retained]).toEqual([candidates[0]!.environmentId]);
    expect(f.retain).toHaveBeenCalledTimes(2);
  });

  it("drops a revoked or offline current machine and does not connect without account authority", () => {
    const f = fixture();
    f.update();
    f.update(candidates.map((node, index) => ({ ...node, eligible: index !== 0 })));
    expect([...f.retained]).toEqual([candidates[1]!.environmentId]);
    f.update(candidates, true, null);
    expect(f.retained.size).toBe(0);
    f.update(candidates, true, "account-b");
    expect([...f.retained]).toEqual([candidates[0]!.environmentId]);
    f.discovery.reset();
    expect(f.retained.size).toBe(0);
  });

  it("refreshes a completed machine when it returns online or is listed again", () => {
    const f = fixture();
    const node = candidates[0]!;
    // Two more machines that already answered keep the account above the bound of one.
    const others = [candidates[1]!, candidates[2]!].map((other) => ({ ...other, ready: true }));
    f.update([node, ...others]);
    f.update([{ ...node, ready: true }, ...others]);
    expect(f.retained.size).toBe(0);
    f.update([{ ...node, eligible: false }, ...others]);
    f.update([node, ...others]);
    expect([...f.retained]).toEqual([node.environmentId]);
    f.update([{ ...node, ready: true }, ...others]);
    f.update(others);
    f.update([node, ...others]);
    expect(f.retain.mock.calls.map(([id]) => id)).toEqual([
      node.environmentId,
      node.environmentId,
      node.environmentId,
    ]);
  });

  it("asks for as many machines at once as the bound allows and moves on as each completes", () => {
    const f = fixture(3);
    f.update();
    expect([...f.retained]).toEqual(candidates.slice(0, 3).map((node) => node.environmentId));
    // The second machine answers first: its slot goes to the next one owed a read.
    f.update(candidates.map((node, index) => ({ ...node, ready: index === 1 })));
    expect([...f.retained].toSorted()).toEqual(
      [candidates[0]!, candidates[2]!, candidates[3]!].map((node) => node.environmentId),
    );
    f.update(candidates.map((node, index) => ({ ...node, ready: index <= 3 })));
    expect([...f.retained]).toEqual([candidates[4]!.environmentId]);
    // Evicted machines read as not ready again; none is asked for twice.
    f.update(candidates.map((node, index) => ({ ...node, ready: index === 4 })));
    expect(f.retained.size).toBe(0);
    expect(f.retain).toHaveBeenCalledTimes(candidates.length);
  });

  it("keeps every machine held while they all fit the bound, so a dropped one reconnects", () => {
    const f = fixture(3);
    const nodes = candidates.slice(0, 3);
    f.update(nodes);
    f.update(nodes.map((node) => ({ ...node, ready: true })));
    expect([...f.retained]).toEqual(nodes.map((node) => node.environmentId));
    // A relay drop reads as not ready; the hold, and with it the demand, stays.
    f.update(nodes.map((node, index) => ({ ...node, ready: index !== 1 })));
    expect([...f.retained]).toEqual(nodes.map((node) => node.environmentId));
    expect(f.retain).toHaveBeenCalledTimes(3);
    // A machine that failed for good gives its hold up; one going offline too.
    f.update(nodes.map((node, index) => ({ ...node, failed: index === 0, eligible: index !== 2 })));
    expect([...f.retained]).toEqual([nodes[1]!.environmentId]);
    f.update(nodes, false);
    expect(f.retained.size).toBe(0);
  });

  it("holds a fourth machine only for its read once the account outgrows the bound", () => {
    const f = fixture(3);
    const three = candidates.slice(0, 3).map((node) => ({ ...node, ready: true }));
    f.update(three);
    expect(f.retained.size).toBe(3);
    f.update([...three, candidates[3]!]);
    expect([...f.retained]).toEqual([candidates[3]!.environmentId]);
  });
});
