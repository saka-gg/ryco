import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspaceConnectionDemandState,
  isWorkspaceEnvironmentDemanded,
  isWorkspaceEnvironmentWarmOnly,
  noteRecentWorkspaceEnvironment,
  planWorkspaceConnectionDemand,
  pruneExpiredWorkspaceConnectionScopes,
  releaseWorkspaceConnectionScope,
  renewWorkspaceConnectionScope,
  retainWorkspaceConnectionScope,
  setWorkspaceConnectionBackgrounded,
  setWorkspaceEnvironmentConnected,
  UNIFIED_WORKSPACE_MAX_CONNECTIONS,
  UNIFIED_WORKSPACE_WARM_LEASE_TTL_MS,
  type WorkspaceConnectionDemandPlan,
  type WorkspaceConnectionDemandState,
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

function retainWarm(
  state: ReturnType<typeof createWorkspaceConnectionDemandState>,
  index: number,
  now = index,
) {
  return retainWorkspaceConnectionScope(state, {
    leaseId: `warm-${index}`,
    environmentId: environments[index - 1]!,
    scope: { type: "interactive" },
    now,
    ttlMs: UNIFIED_WORKSPACE_WARM_LEASE_TTL_MS,
    warm: true,
  });
}

function connect(state: WorkspaceConnectionDemandState, ...indexes: ReadonlyArray<number>) {
  let next = state;
  for (const index of indexes) {
    next = setWorkspaceEnvironmentConnected(next, environments[index - 1]!, true, index);
  }
  return next;
}

/**
 * The planner as it was before warm leases existed, kept verbatim in behavior
 * so plans without a warm lease can be compared against it.
 */
function plannerWithoutWarmLeases(
  source: WorkspaceConnectionDemandState,
  input: {
    readonly now: number;
    readonly wakeStaggerMs?: number;
    readonly foregroundEnvironmentId?: EnvironmentId | null;
  },
): WorkspaceConnectionDemandPlan {
  const state = pruneExpiredWorkspaceConnectionScopes(source, input.now);
  const retainedAt = new Map<EnvironmentId, number>();
  const preemptible = new Map<EnvironmentId, boolean>();
  for (const lease of state.leases) {
    retainedAt.set(
      lease.environmentId,
      Math.max(retainedAt.get(lease.environmentId) ?? 0, lease.retainedAt),
    );
    preemptible.set(
      lease.environmentId,
      (preemptible.get(lease.environmentId) ?? true) && lease.preemptible === true,
    );
  }
  const retained = Array.from(retainedAt.keys());
  const retainedSet = new Set(retained);
  const connected = state.connections.filter((entry) => entry.connected);
  const connectedSet = new Set(connected.map((entry) => entry.environmentId));
  const nonRetained = connected
    .filter((entry) => !retainedSet.has(entry.environmentId))
    .toSorted(
      (left, right) =>
        left.lastAccessedAt - right.lastAccessedAt ||
        String(left.environmentId).localeCompare(String(right.environmentId)),
    );
  const foreground = input.foregroundEnvironmentId ?? null;
  const missingByRecency = retained
    .filter((environmentId) => !connectedSet.has(environmentId))
    .toSorted(
      (left, right) =>
        (retainedAt.get(right) ?? 0) - (retainedAt.get(left) ?? 0) ||
        String(left).localeCompare(String(right)),
    );
  const missing =
    foreground !== null && missingByRecency.includes(foreground)
      ? [foreground, ...missingByRecency.filter((environmentId) => environmentId !== foreground)]
      : missingByRecency;
  const release: EnvironmentId[] = [];
  if (state.backgrounded) {
    release.push(...nonRetained.map((entry) => entry.environmentId));
    return {
      state,
      retain: retained.filter((environmentId) => connectedSet.has(environmentId)),
      release,
      connect: [],
      queued: missing,
    };
  }
  const max = state.platformMaxConnections;
  let projected = connected.length;
  const victims = [...nonRetained];
  while (victims.length > 0 && (projected > max || projected + missing.length > max)) {
    release.push(victims.shift()!.environmentId);
    projected -= 1;
  }
  const preempted: EnvironmentId[] = [];
  const slotsNeeded = projected - max + 1;
  if (foreground !== null && missing[0] === foreground && slotsNeeded > 0) {
    const candidates = connected
      .map((entry) => entry.environmentId)
      .filter(
        (environmentId) =>
          environmentId !== foreground &&
          retainedSet.has(environmentId) &&
          preemptible.get(environmentId) === true,
      )
      .toSorted(
        (left, right) =>
          (retainedAt.get(left) ?? 0) - (retainedAt.get(right) ?? 0) ||
          String(left).localeCompare(String(right)),
      );
    if (candidates.length >= slotsNeeded) {
      preempted.push(...candidates.slice(0, slotsNeeded));
      release.push(...preempted);
      projected -= preempted.length;
    }
  }
  const connectNow = missing.slice(0, Math.max(0, max - projected));
  const wakeStaggerMs = Math.max(0, input.wakeStaggerMs ?? 0);
  return {
    state,
    retain: retained.filter(
      (environmentId) => connectedSet.has(environmentId) && !preempted.includes(environmentId),
    ),
    release,
    connect: connectNow.map((environmentId, index) => ({
      environmentId,
      delayMs: index * wakeStaggerMs,
    })),
    queued: [...missing.slice(connectNow.length), ...preempted],
  };
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

describe("warm leases", () => {
  it("connects warm environments after the foreground and other demand, in stagger steps", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retain(state, 1, 1);
    // Retained later than the view, yet they still follow it.
    state = retainWarm(state, 2, 10);
    state = retainWarm(state, 3, 9);

    const plan = planWorkspaceConnectionDemand(state, {
      now: 11,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[0]!,
    });
    expect(plan.connect).toEqual([
      { environmentId: environments[0], delayMs: 0 },
      { environmentId: environments[1], delayMs: 750 },
      { environmentId: environments[2], delayMs: 1500 },
    ]);

    state = retain(state, 4, 2);
    const crowded = planWorkspaceConnectionDemand(state, {
      now: 11,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[0]!,
    });
    expect(crowded.connect).toEqual([
      { environmentId: environments[0], delayMs: 0 },
      { environmentId: environments[3], delayMs: 750 },
      { environmentId: environments[1], delayMs: 1500 },
    ]);
    expect(crowded.queued).toEqual([environments[2]]);
  });

  it("lets a missing view or foreground displace warm-only environments, least recent first", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retainWarm(state, 1, 1);
    state = retainWarm(state, 2, 2);
    state = retain(state, 3, 3);
    state = connect(state, 1, 2, 3);
    state = retain(state, 4, 10);

    const view = planWorkspaceConnectionDemand(state, { now: 11, wakeStaggerMs: 750 });
    expect(view.release).toEqual([environments[0]]);
    expect(view.connect).toEqual([{ environmentId: environments[3], delayMs: 0 }]);
    expect(view.queued).toEqual([environments[0]]);
    expect(view.retain).toEqual([environments[1], environments[2]]);
    // The displaced environment keeps its warm lease.
    expect(view.state.leases.map((lease) => lease.leaseId)).toContain("warm-1");

    state = retain(state, 5, 11);
    const foreground = planWorkspaceConnectionDemand(state, {
      now: 12,
      wakeStaggerMs: 750,
      foregroundEnvironmentId: environments[4]!,
    });
    expect(foreground.release).toEqual([environments[0], environments[1]]);
    expect(foreground.connect).toEqual([
      { environmentId: environments[4], delayMs: 0 },
      { environmentId: environments[3], delayMs: 750 },
    ]);
    expect(foreground.queued).toEqual([environments[0], environments[1]]);
  });

  it("never lets a warm-only environment displace a view or an intent", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retainPreemptible(state, 1, 1);
    state = retain(state, 2, 2);
    state = retain(state, 3, 3);
    state = connect(state, 1, 2, 3);
    state = retainWarm(state, 4, 10);

    const plan = planWorkspaceConnectionDemand(state, { now: 11, wakeStaggerMs: 750 });
    expect(plan.release).toEqual([]);
    expect(plan.connect).toEqual([]);
    expect(plan.queued).toEqual([environments[3]]);
  });

  it("never displaces an unleased or in-flight connection", () => {
    // A view on 1; 2 is a connection nothing retains, and 3 a connect the user
    // started later that nothing retains any more (in-flight connects plan as
    // connected).
    let state = createWorkspaceConnectionDemandState(3);
    state = retain(state, 1, 1);
    state = connect(state, 1, 2);
    state = setWorkspaceEnvironmentConnected(state, environments[2]!, true, 5);
    state = retainWarm(state, 4, 10);
    state = retainWarm(state, 5, 9);

    const full = planWorkspaceConnectionDemand(state, { now: 11, wakeStaggerMs: 750 });
    expect(full.release).toEqual([]);
    expect(full.connect).toEqual([]);
    expect(full.queued).toEqual([environments[3], environments[4]]);

    // Other demand still makes room, but only the room it needs itself.
    state = retain(state, 4, 11);
    const crowded = planWorkspaceConnectionDemand(state, { now: 12, wakeStaggerMs: 750 });
    expect(crowded.release).toEqual([environments[1]]);
    expect(crowded.connect).toEqual([{ environmentId: environments[3], delayMs: 0 }]);
    expect(crowded.queued).toEqual([environments[4]]);

    // A slot that frees is the only kind a warm environment takes.
    state = setWorkspaceEnvironmentConnected(state, environments[1]!, false, 12);
    state = setWorkspaceEnvironmentConnected(state, environments[3]!, true, 12);
    state = setWorkspaceEnvironmentConnected(state, environments[2]!, false, 13);
    const free = planWorkspaceConnectionDemand(state, { now: 14, wakeStaggerMs: 750 });
    expect(free.release).toEqual([]);
    expect(free.connect).toEqual([{ environmentId: environments[4], delayMs: 0 }]);
    expect(free.queued).toEqual([]);
  });

  it("releases warm-only environments in the background and queues none", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retainWarm(state, 1, 1);
    state = retain(state, 2, 2);
    state = connect(state, 1, 2);
    state = retainWarm(state, 3, 3);
    state = retain(state, 4, 4);
    state = setWorkspaceConnectionBackgrounded(state, true);

    const plan = planWorkspaceConnectionDemand(state, { now: 5, wakeStaggerMs: 750 });
    expect(plan.release).toEqual([environments[0]]);
    expect(plan.retain).toEqual([environments[1]]);
    expect(plan.connect).toEqual([]);
    expect(plan.queued).toEqual([environments[3]]);
  });

  it("treats a warm lease as no demand, unless something else holds the environment", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retainWarm(state, 1, 0);
    const now = { now: 5 };
    expect(isWorkspaceEnvironmentDemanded(state, environments[0]!, now)).toBe(false);
    expect(isWorkspaceEnvironmentWarmOnly(state, environments[0]!, now)).toBe(true);
    expect(
      isWorkspaceEnvironmentDemanded(state, environments[0]!, {
        ...now,
        foregroundEnvironmentId: environments[0]!,
      }),
    ).toBe(true);
    expect(
      isWorkspaceEnvironmentWarmOnly(state, environments[0]!, {
        ...now,
        foregroundEnvironmentId: environments[0]!,
      }),
    ).toBe(false);
    expect(isWorkspaceEnvironmentWarmOnly(state, environments[1]!, now)).toBe(false);

    state = retain(state, 1, 1);
    expect(isWorkspaceEnvironmentDemanded(state, environments[0]!, now)).toBe(true);
    expect(isWorkspaceEnvironmentWarmOnly(state, environments[0]!, now)).toBe(false);
    expect(state.leases.find((lease) => lease.leaseId === "warm-1")).toMatchObject({
      warm: true,
      preemptible: true,
    });
  });

  it("lets a warm lease lapse after its TTL, leaving the environment as unleased LRU", () => {
    let state = createWorkspaceConnectionDemandState(3);
    state = retainWarm(state, 1, 0);
    state = connect(state, 1);
    const before = planWorkspaceConnectionDemand(state, {
      now: UNIFIED_WORKSPACE_WARM_LEASE_TTL_MS - 1,
    });
    expect(before.retain).toEqual([environments[0]]);

    const after = planWorkspaceConnectionDemand(state, {
      now: UNIFIED_WORKSPACE_WARM_LEASE_TTL_MS,
    });
    expect(after.state.leases).toEqual([]);
    expect(after.retain).toEqual([]);
    expect(after.release).toEqual([]);
  });

  it("plans exactly as before when no warm lease is held", () => {
    // A deterministic sweep of states built from views, intents and connections.
    let seed = 7;
    const random = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    for (let round = 0; round < 400; round += 1) {
      let state = createWorkspaceConnectionDemandState(1 + random(3));
      for (let index = 1; index <= 5; index += 1) {
        const choice = random(4);
        if (choice === 1) state = retain(state, index, 1 + random(20));
        if (choice === 2) state = retainPreemptible(state, index, 1 + random(20));
        if (choice === 3) {
          state = retain(state, index, 1 + random(20));
          state = retainPreemptible(state, index, 1 + random(20));
        }
        if (random(2) === 0) {
          state = setWorkspaceEnvironmentConnected(
            state,
            environments[index - 1]!,
            true,
            random(20),
          );
        }
      }
      state = setWorkspaceConnectionBackgrounded(state, random(4) === 0);
      const foregroundIndex = random(6);
      const input = {
        now: 25,
        wakeStaggerMs: random(2) * 750,
        foregroundEnvironmentId: foregroundIndex === 5 ? null : environments[foregroundIndex]!,
      };
      expect(planWorkspaceConnectionDemand(state, input)).toEqual(
        plannerWithoutWarmLeases(state, input),
      );
    }
  });

  it("keeps a bounded most-recently-used list and its identity when nothing changes", () => {
    const [first, second, third, fourth] = environments as [
      EnvironmentId,
      EnvironmentId,
      EnvironmentId,
      EnvironmentId,
    ];
    const empty: ReadonlyArray<EnvironmentId> = [];
    const one = noteRecentWorkspaceEnvironment(empty, first, 3);
    expect(one).toEqual([first]);
    expect(noteRecentWorkspaceEnvironment(one, first, 3)).toBe(one);

    const three = [second, third, first].reduce<ReadonlyArray<EnvironmentId>>(
      (recent, environmentId) => noteRecentWorkspaceEnvironment(recent, environmentId, 3),
      one,
    );
    expect(three).toEqual([first, third, second]);
    expect(noteRecentWorkspaceEnvironment(three, third, 3)).toEqual([third, first, second]);
    expect(noteRecentWorkspaceEnvironment(three, fourth, 3)).toEqual([fourth, first, third]);
    expect(noteRecentWorkspaceEnvironment(three, first, 2)).toEqual([first, third]);
  });
});
