import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspaceConnectionDemandState,
  isWorkspaceEnvironmentDemanded,
  planWorkspaceConnectionDemand,
  releaseWorkspaceConnectionScope,
  renewWorkspaceConnectionScope,
  retainWorkspaceConnectionScope,
  setWorkspaceConnectionBackgrounded,
  setWorkspaceEnvironmentConnected,
  UNIFIED_WORKSPACE_MAX_CONNECTIONS,
} from "./connectionDemand.js";

const environments = Array.from({ length: 5 }, (_, index) =>
  EnvironmentId.make(`env-${index + 1}`),
);

function retain(
  state: ReturnType<typeof createWorkspaceConnectionDemandState>,
  index: number,
  now = index,
) {
  return retainWorkspaceConnectionScope(state, {
    leaseId: `lease-${index}`,
    environmentId: environments[index - 1]!,
    scope: { type: "thread-detail", threadId: ThreadId.make(`thread-${index}`) },
    now,
  });
}

function retainPreemptible(
  state: ReturnType<typeof createWorkspaceConnectionDemandState>,
  index: number,
  now = index,
) {
  return retainWorkspaceConnectionScope(state, {
    leaseId: `intent-${index}`,
    environmentId: environments[index - 1]!,
    scope: { type: "interactive" },
    now,
    preemptible: true,
  });
}

function connectedState(count: number, retainLease = retain) {
  let state = createWorkspaceConnectionDemandState(3);
  for (let index = 1; index <= count; index += 1) {
    state = retainLease(state, index, index);
    state = setWorkspaceEnvironmentConnected(state, environments[index - 1]!, true, index);
  }
  return state;
}

describe("unified workspace connection demand", () => {
  it("enforces the assessed absolute ceiling", () => {
    expect(UNIFIED_WORKSPACE_MAX_CONNECTIONS).toBe(3);
    expect(() => createWorkspaceConnectionDemandState(0)).toThrow(RangeError);
    expect(() => createWorkspaceConnectionDemandState(4)).toThrow(RangeError);
    expect(createWorkspaceConnectionDemandState(1).platformMaxConnections).toBe(1);
  });

  it("keeps duplicate scopes as independently renewable TTL leases", () => {
    let state = createWorkspaceConnectionDemandState(3);
    const scope = { type: "provider-status" as const, instanceId: "codex" };
    state = retainWorkspaceConnectionScope(state, {
      leaseId: "first",
      environmentId: environments[0]!,
      scope,
      now: 0,
      ttlMs: 10,
    });
    state = retainWorkspaceConnectionScope(state, {
      leaseId: "second",
      environmentId: environments[0]!,
      scope,
      now: 0,
      ttlMs: 10,
    });
    expect(planWorkspaceConnectionDemand(state, { now: 5 }).state.leases).toHaveLength(2);

    state = renewWorkspaceConnectionScope(state, "first", 8, 10);
    expect(planWorkspaceConnectionDemand(state, { now: 11 }).state.leases).toMatchObject([
      { leaseId: "first" },
    ]);
    expect(isWorkspaceEnvironmentDemanded(state, environments[0]!, { now: 17 })).toBe(true);
    expect(planWorkspaceConnectionDemand(state, { now: 19 }).retain).toHaveLength(0);
    expect(isWorkspaceEnvironmentDemanded(state, environments[0]!, { now: 19 })).toBe(false);
  });

  it("uses LRU only for non-retained connections in a five-node fixture", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = setWorkspaceEnvironmentConnected(state, environments[0]!, true, 10);
    state = setWorkspaceEnvironmentConnected(state, environments[1]!, true, 20);
    state = setWorkspaceEnvironmentConnected(state, environments[2]!, true, 1);
    state = retain(state, 1, 30);
    state = retain(state, 2, 31);
    state = retain(state, 4, 32);

    const plan = planWorkspaceConnectionDemand(state, { now: 33 });
    expect(plan.retain).toEqual([environments[0], environments[1]]);
    expect(plan.release).toEqual([environments[2]]);
    expect(plan.connect).toEqual([{ environmentId: environments[3], delayMs: 0 }]);
    expect(plan.queued).toEqual([]);
  });

  it("queues and cancels a fourth retained acquisition instead of evicting", () => {
    let state = createWorkspaceConnectionDemandState(3);
    for (let index = 1; index <= 3; index += 1) {
      state = retain(state, index, index);
      state = setWorkspaceEnvironmentConnected(state, environments[index - 1]!, true, index);
    }
    state = retain(state, 4, 10);
    const queued = planWorkspaceConnectionDemand(state, { now: 11 });
    expect(queued.release).toEqual([]);
    expect(queued.connect).toEqual([]);
    expect(queued.queued).toEqual([environments[3]]);

    state = releaseWorkspaceConnectionScope(state, "lease-4");
    expect(planWorkspaceConnectionDemand(state, { now: 12 }).queued).toEqual([]);
  });

  it("releases non-retained background work and staggers retained foreground reconnects", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retain(state, 1, 1);
    state = retain(state, 2, 2);
    state = setWorkspaceEnvironmentConnected(state, environments[2]!, true, 3);
    state = setWorkspaceConnectionBackgrounded(state, true);

    const background = planWorkspaceConnectionDemand(state, { now: 4 });
    expect(background.release).toEqual([environments[2]]);
    expect(background.connect).toEqual([]);
    expect(background.queued).toEqual([environments[1], environments[0]]);

    state = setWorkspaceEnvironmentConnected(state, environments[2]!, false, 4);
    state = setWorkspaceConnectionBackgrounded(state, false);
    const foreground = planWorkspaceConnectionDemand(state, { now: 5, wakeStaggerMs: 750 });
    expect(foreground.connect).toEqual([
      { environmentId: environments[1], delayMs: 0 },
      { environmentId: environments[0], delayMs: 750 },
    ]);
  });

  it("connects the foreground first at once and staggers the others after it", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retain(state, 1, 1);
    state = retain(state, 2, 2);
    state = retain(state, 3, 3);

    const plan = planWorkspaceConnectionDemand(state, {
      now: 4,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[0]!,
    });
    expect(plan.release).toEqual([]);
    expect(plan.connect).toEqual([
      { environmentId: environments[0], delayMs: 0 },
      { environmentId: environments[2], delayMs: 750 },
      { environmentId: environments[1], delayMs: 1500 },
    ]);
    expect(plan.queued).toEqual([]);
  });

  it("ignores a foreground that holds no lease or is already connected", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retain(state, 1, 1);
    state = retain(state, 2, 2);
    const unleased = planWorkspaceConnectionDemand(state, {
      now: 3,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[3]!,
    });
    expect(unleased.connect).toEqual([
      { environmentId: environments[1], delayMs: 0 },
      { environmentId: environments[0], delayMs: 750 },
    ]);

    state = setWorkspaceEnvironmentConnected(state, environments[0]!, true, 3);
    const connected = planWorkspaceConnectionDemand(state, {
      now: 4,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[0]!,
    });
    expect(connected.retain).toEqual([environments[0]]);
    expect(connected.connect).toEqual([{ environmentId: environments[1], delayMs: 0 }]);
  });

  it("queues a foreground behind three mounted views instead of releasing one", () => {
    let state = connectedState(3);
    state = retain(state, 4, 10);

    const plan = planWorkspaceConnectionDemand(state, {
      now: 11,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[3]!,
    });
    expect(plan.release).toEqual([]);
    expect(plan.connect).toEqual([]);
    expect(plan.queued).toEqual([environments[3]]);
    expect(plan.retain).toEqual([environments[0], environments[1], environments[2]]);
  });

  it("lets a foreground preempt the least recently retained preemptible environment", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retainPreemptible(state, 1, 1);
    state = retain(state, 2, 2);
    state = retainPreemptible(state, 3, 3);
    // A mounted view on the third environment keeps it from being preempted.
    state = retain(state, 3, 3);
    for (let index = 1; index <= 3; index += 1) {
      state = setWorkspaceEnvironmentConnected(state, environments[index - 1]!, true, index);
    }
    state = retainPreemptible(state, 5, 5);
    state = setWorkspaceEnvironmentConnected(state, environments[4]!, false, 5);
    state = retain(state, 4, 10);

    const plan = planWorkspaceConnectionDemand(state, {
      now: 11,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[3]!,
    });
    expect(plan.release).toEqual([environments[0]]);
    expect(plan.connect).toEqual([{ environmentId: environments[3], delayMs: 0 }]);
    expect(plan.queued).toEqual([environments[4], environments[0]]);
    expect(plan.retain).toEqual([environments[1], environments[2]]);
    expect(plan.state.leases.map((lease) => lease.leaseId)).toContain("intent-1");
  });

  it("preempts the preemptible environment among two mounted views", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retain(state, 1, 1);
    state = retain(state, 2, 2);
    state = retainPreemptible(state, 3, 3);
    for (let index = 1; index <= 3; index += 1) {
      state = setWorkspaceEnvironmentConnected(state, environments[index - 1]!, true, index);
    }
    state = retain(state, 4, 10);

    const plan = planWorkspaceConnectionDemand(state, {
      now: 11,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[3]!,
    });
    expect(plan.release).toEqual([environments[2]]);
    expect(plan.connect).toEqual([{ environmentId: environments[3], delayMs: 0 }]);
    expect(plan.queued).toEqual([environments[2]]);
    expect(plan.state.leases.some((lease) => lease.environmentId === environments[2])).toBe(true);
  });

  it("releases non-retained work before preempting anything", () => {
    let state = connectedState(2, retainPreemptible);
    state = setWorkspaceEnvironmentConnected(state, environments[2]!, true, 3);
    state = retain(state, 4, 10);

    const plan = planWorkspaceConnectionDemand(state, {
      now: 11,
      foregroundEnvironmentId: environments[3]!,
    });
    expect(plan.release).toEqual([environments[2]]);
    expect(plan.connect).toEqual([{ environmentId: environments[3], delayMs: 0 }]);
    expect(plan.retain).toEqual([environments[0], environments[1]]);
  });

  it("never preempts while backgrounded", () => {
    let state = connectedState(3, retainPreemptible);
    state = retain(state, 4, 10);
    state = setWorkspaceConnectionBackgrounded(state, true);

    const plan = planWorkspaceConnectionDemand(state, {
      now: 11,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[3]!,
    });
    expect(plan.release).toEqual([]);
    expect(plan.connect).toEqual([]);
    expect(plan.queued).toEqual([environments[3]]);
  });

  it("keeps five demanded nodes within three connections", () => {
    let state = createWorkspaceConnectionDemandState(3);
    for (let index = 1; index <= 5; index += 1) {
      state =
        index % 2 === 0 ? retainPreemptible(state, index, index) : retain(state, index, index);
    }
    for (let round = 0; round < 5; round += 1) {
      const plan = planWorkspaceConnectionDemand(state, {
        now: 10 + round,
        wakeStaggerMs: 750,
        foregroundEnvironmentId: environments[round]!,
      });
      for (const environmentId of plan.release) {
        state = setWorkspaceEnvironmentConnected(state, environmentId, false, 10 + round);
      }
      for (const command of plan.connect) {
        state = setWorkspaceEnvironmentConnected(state, command.environmentId, true, 10 + round);
      }
      const connected = state.connections.filter((entry) => entry.connected);
      expect(connected.length).toBeLessThanOrEqual(UNIFIED_WORKSPACE_MAX_CONNECTIONS);
      expect(plan.connect.length + plan.retain.length).toBeLessThanOrEqual(3);
    }
  });

  it("treats the foreground and unexpired leases as demand", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retainWorkspaceConnectionScope(state, {
      leaseId: "view",
      environmentId: environments[0]!,
      scope: { type: "vcs-status", cwd: "/repo" },
      now: 0,
      ttlMs: 10,
    });
    const cases = [
      { environment: 0, now: 5, foreground: null, demanded: true },
      { environment: 0, now: 10, foreground: null, demanded: false },
      { environment: 0, now: 10, foreground: 0, demanded: true },
      { environment: 1, now: 5, foreground: null, demanded: false },
      { environment: 1, now: 5, foreground: 1, demanded: true },
      { environment: 1, now: 5, foreground: 0, demanded: false },
    ] as const;
    for (const entry of cases) {
      expect(
        isWorkspaceEnvironmentDemanded(state, environments[entry.environment]!, {
          now: entry.now,
          foregroundEnvironmentId:
            entry.foreground === null ? null : environments[entry.foreground]!,
        }),
      ).toBe(entry.demanded);
    }
    expect(isWorkspaceEnvironmentDemanded(state, environments[0]!, { now: 5 })).toBe(true);
  });
});
