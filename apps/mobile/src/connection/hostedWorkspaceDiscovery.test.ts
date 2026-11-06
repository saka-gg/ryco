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

function fixture() {
  const retained = new Set<EnvironmentId>();
  const retain = vi.fn((environmentId: EnvironmentId) => {
    retained.add(environmentId);
    return () => retained.delete(environmentId);
  });
  const discovery = createHostedWorkspaceDiscovery(retain);
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
    f.update([node]);
    f.update([{ ...node, ready: true }]);
    expect(f.retained.size).toBe(0);
    f.update([{ ...node, eligible: false }]);
    f.update([node]);
    expect([...f.retained]).toEqual([node.environmentId]);
    f.update([{ ...node, ready: true }]);
    f.update([]);
    f.update([node]);
    expect(f.retain).toHaveBeenCalledTimes(3);
  });
});
